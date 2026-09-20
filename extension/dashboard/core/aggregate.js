// extension/dashboard/core/aggregate.js
// Pure aggregation of canonical records for the dashboard. Mirrors the current
// dashboard.js behavior (workspace/model pre-aggregation, date + minute buckets
// in viewer-local time per D19). No DOM, no chrome (P9).

import { localDateOf } from "./time.js";

// Request count for one record. Aggregated sources (DeepSeek/MiMo export days,
// OpenRouter day rows, CommandCode 5-min buckets) carry many requests in a
// single record; opencode API/local records are one request each and have no
// `requests` field. Never count a record as 0 requests.
export function requestCount(rec) {
  const n = Number(rec && rec.requests);
  return isFinite(n) && n > 0 ? n : 1;
}

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
// selectedWS / selectedModel may be: "ALL"/""/undefined (no filter), a single
// string value, or an array (empty == all; non-empty == matches that set).
function asFilter(v) {
  if (Array.isArray(v)) return v;
  if (!v || v === "ALL") return [];
  return [v];
}

export function aggregate(records, { price, startDate = "", endDate = "", selectedWS = "ALL", selectedModel = "ALL" } = {}) {
  const wsFilter = asFilter(selectedWS);
  const modelFilter = asFilter(selectedModel);
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
    const source = rec.source || "opencode";
    const wsID = rec.workspaceID || "wrk_unknown";
    // Workspaces are per-source: "<source>:<workspaceID>" so the same id from
    // different vendors never merges (D2).
    const wsKey = `${source}:${wsID}`;
    const modelName = rec.model || "Unknown";
    const recDate = localDateOf(rec);

    if (startDate && recDate && recDate < startDate) continue;
    if (endDate && recDate && recDate > endDate) continue;

    const { cost, savings, window, unpriced, priceBasis } = price(rec);
    const cacheWrite = (rec.cacheWrite5m || 0) + (rec.cacheWrite1h || 0);
    const tokens = (rec.input || 0) + (rec.output || 0) + (rec.reasoning || 0) + (rec.cacheRead || 0) + cacheWrite;
    const promptTokens = (rec.input || 0) + (rec.cacheRead || 0);

    if (!wsMap[wsKey]) wsMap[wsKey] = { req: 0, tokens: 0, prompt: 0, cacheRead: 0, cost: 0 };
    wsMap[wsKey].req += requestCount(rec);
    wsMap[wsKey].tokens += tokens;
    wsMap[wsKey].prompt += promptTokens;
    wsMap[wsKey].cacheRead += rec.cacheRead || 0;
    wsMap[wsKey].cost += cost;

    if (wsFilter.length && !wsFilter.includes(wsKey)) continue;
    if (modelFilter.length && !modelFilter.includes(modelName)) continue;

    if (unpriced) unpricedSet.add(modelName);
    filtered.push({ id: rec.id, ...rec, cost, savings, tokens, window, unpriced, priceBasis });

    totals.req += requestCount(rec);
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
    singleModelDailyMap[date].req += requestCount(rec);
    singleModelDailyMap[date].input += rec.input || 0;
    singleModelDailyMap[date].output += rec.output || 0;
    singleModelDailyMap[date].cacheRead += rec.cacheRead || 0;
    singleModelDailyMap[date].cost += cost;

    // Models are per-source too (D2): the same model name from different
    // vendors must not merge into one row. Key is "<source>:<model>".
    const modelKey = `${source}:${modelName}`;
    if (!modelMap[modelKey]) {
      modelMap[modelKey] = { model: modelName, source, req: 0, input: 0, output: 0, cacheRead: 0, cost: 0, peakCost: 0, offpeakCost: 0, flatCost: 0 };
    }
    modelMap[modelKey].req += requestCount(rec);
    modelMap[modelKey].input += rec.input || 0;
    modelMap[modelKey].output += rec.output || 0;
    modelMap[modelKey].cacheRead += rec.cacheRead || 0;
    modelMap[modelKey].cost += cost;
    if (window === "peak") modelMap[modelKey].peakCost += cost;
    else if (window === "offpeak") modelMap[modelKey].offpeakCost += cost;
    else if (window === "flat") modelMap[modelKey].flatCost += cost;
  }

  let topModel = "-";
  let topModelCost = 0;
  for (const stats of Object.values(modelMap)) {
    if (stats.cost > topModelCost) {
      topModelCost = stats.cost;
      topModel = stats.model;
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
