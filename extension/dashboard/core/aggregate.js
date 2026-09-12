// extension/dashboard/core/aggregate.js
// Pure aggregation of canonical records for the dashboard. Mirrors the current
// dashboard.js behavior (workspace/model pre-aggregation, date + minute buckets
// in viewer-local time per D19). No DOM, no chrome (P9).

import { localDateOf } from "./time.js";

export function listWorkspaces(records) {
  const set = new Set();
  for (const rec of records || []) set.add(rec.workspaceID || "wrk_unknown");
  return [...set].sort();
}

export function listModels(records) {
  const set = new Set();
  for (const rec of records || []) set.add(rec.model || "Unknown");
  return [...set].sort();
}

// `price(rec)` -> { cost, savings, window, unpriced }.
// selectedWS / selectedModel use "ALL" as the no-filter sentinel.
export function aggregate(records, { price, startDate = "", endDate = "", selectedWS = "ALL", selectedModel = "ALL" } = {}) {
  const totals = { req: 0, cost: 0, savings: 0, tokens: 0, prompt: 0, cacheRead: 0, peakCost: 0, offpeakCost: 0, flatCost: 0 };
  const dailyMap = {};
  const dailyTokenMap = {};
  const hourlyMap = {};
  const modelMap = {};
  const wsMap = {};
  const singleModelDailyMap = {};
  const filtered = [];
  const unpricedSet = new Set();
  let minDate = null;
  let maxDate = null;

  for (const rec of records || []) {
    const wsID = rec.workspaceID || "wrk_unknown";
    const modelName = rec.model || "Unknown";
    const recDate = localDateOf(rec);

    if (startDate && recDate && recDate < startDate) continue;
    if (endDate && recDate && recDate > endDate) continue;

    const { cost, savings, window, unpriced } = price(rec);
    const cacheWrite = (rec.cacheWrite5m || 0) + (rec.cacheWrite1h || 0);
    const tokens = (rec.input || 0) + (rec.output || 0) + (rec.reasoning || 0) + (rec.cacheRead || 0) + cacheWrite;
    const promptTokens = (rec.input || 0) + (rec.cacheRead || 0);

    if (!wsMap[wsID]) wsMap[wsID] = { req: 0, tokens: 0, prompt: 0, cacheRead: 0, cost: 0 };
    wsMap[wsID].req++;
    wsMap[wsID].tokens += tokens;
    wsMap[wsID].prompt += promptTokens;
    wsMap[wsID].cacheRead += rec.cacheRead || 0;
    wsMap[wsID].cost += cost;

    if (selectedWS !== "ALL" && wsID !== selectedWS) continue;
    if (selectedModel !== "ALL" && modelName !== selectedModel) continue;

    if (unpriced) unpricedSet.add(modelName);
    filtered.push({ id: rec.id, ...rec, cost, savings, tokens, window, unpriced });

    totals.req++;
    totals.cost += cost;
    totals.savings += savings;
    totals.tokens += tokens;
    totals.prompt += promptTokens;
    totals.cacheRead += rec.cacheRead || 0;
    if (window === "peak") totals.peakCost += cost;
    else if (window === "offpeak") totals.offpeakCost += cost;
    else if (window === "flat") totals.flatCost += cost;

    const date = recDate;
    if (date) {
      if (minDate === null || date < minDate) minDate = date;
      if (maxDate === null || date > maxDate) maxDate = date;
    }
    dailyMap[date] = (dailyMap[date] || 0) + cost;
    dailyTokenMap[date] = (dailyTokenMap[date] || 0) + tokens;

    // Minute buckets in local time, matching how `date` is derived (D19).
    if (rec.time && date) {
      const t = new Date(rec.time);
      if (!isNaN(t.getTime())) {
        const min = t.getHours() * 60 + t.getMinutes();
        if (!hourlyMap[date]) hourlyMap[date] = {};
        const h = hourlyMap[date][min] || (hourlyMap[date][min] = { cost: 0, tokens: 0 });
        h.cost += cost;
        h.tokens += tokens;
      }
    }

    if (!singleModelDailyMap[date]) singleModelDailyMap[date] = { req: 0, input: 0, output: 0, cacheRead: 0, cost: 0 };
    singleModelDailyMap[date].req++;
    singleModelDailyMap[date].input += rec.input || 0;
    singleModelDailyMap[date].output += rec.output || 0;
    singleModelDailyMap[date].cacheRead += rec.cacheRead || 0;
    singleModelDailyMap[date].cost += cost;

    if (!modelMap[modelName]) {
      modelMap[modelName] = { req: 0, input: 0, output: 0, cacheRead: 0, cost: 0, peakCost: 0, offpeakCost: 0, flatCost: 0 };
    }
    modelMap[modelName].req++;
    modelMap[modelName].input += rec.input || 0;
    modelMap[modelName].output += rec.output || 0;
    modelMap[modelName].cacheRead += rec.cacheRead || 0;
    modelMap[modelName].cost += cost;
    if (window === "peak") modelMap[modelName].peakCost += cost;
    else if (window === "offpeak") modelMap[modelName].offpeakCost += cost;
    else if (window === "flat") modelMap[modelName].flatCost += cost;
  }

  let topModel = "-";
  let topModelCost = 0;
  for (const [m, stats] of Object.entries(modelMap)) {
    if (stats.cost > topModelCost) {
      topModelCost = stats.cost;
      topModel = m;
    }
  }

  const hitRates = Object.values(modelMap)
    .map((m) => {
      const prompt = m.input + m.cacheRead;
      return prompt > 0 ? (m.cacheRead / prompt) * 100 : 0;
    })
    .filter((r) => r > 0);

  return {
    totals,
    dailyMap,
    dailyTokenMap,
    hourlyMap,
    modelMap,
    wsMap,
    singleModelDailyMap,
    filtered,
    unpricedModels: [...unpricedSet].sort(),
    minDate,
    maxDate,
    topModel,
    topModelCost,
    maxHitRate: hitRates.length ? Math.max(...hitRates) : null,
    minHitRate: hitRates.length ? Math.min(...hitRates) : null,
  };
}
