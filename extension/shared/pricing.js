// extension/shared/pricing.js
// Vendor-neutral pricing: modelMap -> target, dual price, version chain,
// peak/offpeak windows, tiers. Ported from dashboard.js. Zero chrome deps (P9).

export function matchRule(modelName, rules) {
  for (const rule of rules || []) if (rule.model === modelName) return rule;
  return null;
}

export function parseBound(bound) {
  if (bound == null || bound === "") return null;
  const t = new Date(bound).getTime();
  return isNaN(t) ? NaN : t;
}

// Pick the rate version by record time: last version whose `from` <= time wins;
// unparseable time falls back to the earliest/base version (never peak).
export function getRateEntry(rule, recordTime) {
  const ts = new Date(recordTime).getTime();
  const validTs = isNaN(ts) ? null : ts;
  const versions = ((rule && rule.rates) || []).slice().sort((a, b) => {
    const aFrom = parseBound(a.from);
    const bFrom = parseBound(b.from);
    const aNaN = typeof aFrom === "number" && isNaN(aFrom);
    const bNaN = typeof bFrom === "number" && isNaN(bFrom);
    if (aNaN && bNaN) return 0;
    if (aNaN) return 1;
    if (bNaN) return -1;
    if (aFrom === null && bFrom === null) return 0;
    if (aFrom === null) return -1;
    if (bFrom === null) return 1;
    return aFrom - bFrom;
  });
  if (versions.length === 0) return null;
  if (validTs === null) return versions[0];
  let selected = versions[0];
  for (const v of versions) {
    const fromTs = parseBound(v.from);
    if (fromTs !== null && validTs < fromTs) break;
    selected = v;
  }
  return selected;
}

export function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || "").trim());
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

// No windows -> flat; inside any peak window -> peak; otherwise offpeak. UTC (P8).
export function getWindow(record, entry) {
  const peakWindows = entry && entry.windows && entry.windows.peak;
  if (!peakWindows || peakWindows.length === 0) return "flat";
  const t = new Date(record.time);
  if (isNaN(t.getTime())) return "flat";
  const weekday = t.getUTCDay();
  const minutes = t.getUTCHours() * 60 + t.getUTCMinutes();
  for (const w of peakWindows) {
    const days = w.days || [];
    if (days.length > 0 && !days.includes(weekday)) continue;
    const start = toMinutes(w.start);
    const end = toMinutes(w.end);
    if (start == null || end == null) continue;
    if (start <= end) {
      if (minutes >= start && minutes < end) return "peak";
    } else if (minutes >= start || minutes < end) {
      return "peak";
    }
  }
  return "offpeak";
}

export function resolveTable(entry, window, inputTokens, cacheReadTokens) {
  const pricing = (entry && entry.pricing) || {};
  let table = pricing[window];
  if (!table && window !== "flat") table = window === "peak" ? pricing.offpeak : pricing.peak;
  if (!table) return null;
  if (table.tier) {
    const context = (inputTokens || 0) + (cacheReadTokens || 0);
    const tierTable = context <= table.tier.limit ? table.tier.low : table.tier.high;
    if (tierTable) return tierTable;
    if (table.input !== undefined || table.output !== undefined) return table;
    return null;
  }
  return table;
}

// USD per 1M tokens.
export function computeCost(record, table) {
  const inputRate = table.input || 0;
  const outputRate = table.output || 0;
  const cacheReadRate = table.cacheRead || 0;
  const cacheWriteRate = table.cacheWrite || 0;
  const cacheWrite = (record.cacheWrite5m || 0) + (record.cacheWrite1h || 0);
  const cost =
    ((record.input || 0) * inputRate +
      (record.cacheRead || 0) * cacheReadRate +
      cacheWrite * cacheWriteRate +
      (record.output || 0) * outputRate) /
    1000000;
  const savings = ((record.cacheRead || 0) * (inputRate - cacheReadRate)) / 1000000;
  return { cost, savings };
}

// "<source>:<provider>:<raw>" wins over "<source>:<raw>" (D5).
export function resolveTargetId(record, modelMap) {
  if (!record) return null;
  const map = modelMap || {};
  if (record.provider) {
    const withProvider = `${record.source}:${record.provider}:${record.model}`;
    if (map[withProvider]) return map[withProvider];
  }
  return map[`${record.source}:${record.model}`] || null;
}

// Price one record. priceChoice: { "<source>": "vendor" | "curated" } (D5).
export function priceRecord(record, { modelMap = {}, targets = {}, priceChoice = {} } = {}) {
  const targetId = resolveTargetId(record, modelMap);
  if (!targetId || !targets[targetId]) {
    return { cost: 0, savings: 0, window: null, unpriced: true, targetId: null, priceBasis: "unmapped" };
  }
  const target = targets[targetId];
  const choice = priceChoice[record.source] || "curated";
  const curated = target.curatedRates;
  const useCurated = choice === "curated" && Array.isArray(curated) && curated.length > 0;
  const entry = getRateEntry({ rates: useCurated ? curated : target.rates }, record.time);
  if (!entry) return { cost: 0, savings: 0, window: null, unpriced: true, targetId, priceBasis: "unpriced" };
  const window = getWindow(record, entry);
  const table = resolveTable(entry, window, record.input, record.cacheRead);
  if (!table) return { cost: 0, savings: 0, window, unpriced: true, targetId, priceBasis: "unpriced" };
  const { cost, savings } = computeCost(record, table);
  return { cost, savings, window, unpriced: false, targetId, priceBasis: useCurated ? "curated" : "vendor" };
}
