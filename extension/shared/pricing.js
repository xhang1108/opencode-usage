// extension/shared/pricing.js
// Vendor-neutral pricing primitives: price targets + rate tables, version
// chains, peak/offpeak windows, tiers. Ported from dashboard.js.
// Zero chrome deps (P9).

export function matchRule(modelName, rules) {
  for (const rule of rules || []) if (rule.model === modelName) return rule;
  return null;
}

export function parseBound(bound) {
  if (bound == null || bound === "") return null;
  const t = new Date(bound).getTime();
  return isNaN(t) ? NaN : t;
}

// Exclusive end of a version's validity. Versions are open-ended unless they
// carry `until`, which is how a delivered-but-since-withdrawn model (or a promo
// that is scheduled to stop) is modelled.
export function versionUntilMs(entry) {
  return parseBound(entry && entry.until);
}

// Peak windows of one rate version; [] means the version bills flat.
export function peakWindowsOf(entry) {
  const peak = entry && entry.windows && entry.windows.peak;
  return Array.isArray(peak) ? peak : [];
}

// A model counts as retired once its LAST rate version has an `until` in the
// past and no successor version follows it. `until` is lifecycle metadata only:
// historical records still price against the last version, so past cost figures
// never move when a model is retired.
export function isRetired(rule, at = Date.now()) {
  const versions = sortedVersions(rule && rule.rates);
  if (versions.length === 0) return false;
  const until = versionUntilMs(versions[versions.length - 1]);
  if (until === null || isNaN(until)) return false;
  return at >= until;
}

function compareVersions(a, b) {
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
}

// Sorting the version chain is pure but runs once per record; memoize it on the
// rates array identity so the hot path is a lookup (P9-safe: no mutation).
const sortedVersionsCache = new WeakMap();
function sortedVersions(rates) {
  if (!Array.isArray(rates)) return [];
  let cached = sortedVersionsCache.get(rates);
  if (!cached) {
    cached = rates.slice().sort(compareVersions);
    sortedVersionsCache.set(rates, cached);
  }
  return cached;
}

// Effective UTC instant (ms) used for pricing. Records normally carry an ISO
// `time`; day-granular sources may only carry `date`, so fall back to that
// day's UTC midnight — the same fallback the dashboard uses for display
// (core/time.localDateOf). Without this, a record missing `time` silently
// selected the OLDEST rate version, which priced usage at a years-old promo
// rate (e.g. DeepSeek flash cache-hit $0.028 instead of $0.0028).
export function effectiveTimeMs(record) {
  if (record && record.time != null) {
    const t = new Date(record.time).getTime();
    if (!isNaN(t)) return t;
  }
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String((record && record.date) || "").trim());
  if (m) {
    const d = new Date(`${m[1]}T00:00:00.000Z`).getTime();
    if (!isNaN(d)) return d;
  }
  return NaN;
}

// Pick the rate version by record time: last version whose `from` <= time wins.
// A record with no usable time is NOT priced against the oldest version (that
// silently applied stale promos) — callers report it as unpriced instead.
export function getRateEntryFromRates(rates, recordTime) {
  const versions = sortedVersions(rates);
  if (versions.length === 0) return null;
  const ts = new Date(recordTime).getTime();
  if (isNaN(ts)) return null;
  let selected = versions[0];
  for (const v of versions) {
    const fromTs = parseBound(v.from);
    if (fromTs !== null && ts < fromTs) break;
    selected = v;
  }
  return selected;
}

export function getRateEntry(rule, recordTime) {
  return getRateEntryFromRates(rule && rule.rates, recordTime);
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
  const ms = effectiveTimeMs(record);
  if (isNaN(ms)) return "flat";
  const t = new Date(ms);
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

// USD per 1M tokens. reasoning is billed at the output rate (D7).
export function computeCost(record, table) {
  const inputRate = table.input || 0;
  const outputRate = table.output || 0;
  const cacheReadRate = table.cacheRead || 0;
  const cacheWriteRate = table.cacheWrite || 0;
  const cacheWrite = (record.cacheWrite5m || 0) + (record.cacheWrite1h || 0);
  const outputTokens = (record.output || 0) + (record.reasoning || 0);
  const cost =
    ((record.input || 0) * inputRate +
      (record.cacheRead || 0) * cacheReadRate +
      cacheWrite * cacheWriteRate +
      outputTokens * outputRate) /
    1000000;
  const savings = ((record.cacheRead || 0) * (inputRate - cacheReadRate)) / 1000000;
  return { cost, savings };
}

// Price one record against an explicit rate list. Returns the dashboard price
// shape; `basis` labels where the rates came from (e.g. "vendor" / "unified").
export function priceFromRates(record, rates, basis) {
  const entry = getRateEntryFromRates(rates, effectiveTimeMs(record));
  if (!entry) return { cost: 0, savings: 0, window: null, unpriced: true, targetId: null, priceBasis: "unpriced" };
  const window = getWindow(record, entry);
  const table = resolveTable(entry, window, record.input, record.cacheRead);
  if (!table) return { cost: 0, savings: 0, window, unpriced: true, targetId: null, priceBasis: "unpriced" };
  const { cost, savings } = computeCost(record, table);
  return { cost, savings, window, unpriced: false, targetId: null, priceBasis: basis };
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

// Price one record from the author-maintained vendor price tables.
export function priceRecord(record, { modelMap = {}, targets = {} } = {}) {
  const targetId = resolveTargetId(record, modelMap);
  if (!targetId || !targets[targetId]) {
    return { cost: 0, savings: 0, window: null, unpriced: true, targetId: null, priceBasis: "unmapped" };
  }
  const target = targets[targetId];
  const entry = getRateEntry({ rates: target.rates }, effectiveTimeMs(record));
  if (!entry) return { cost: 0, savings: 0, window: null, unpriced: true, targetId, priceBasis: "unpriced" };
  const window = getWindow(record, entry);
  const table = resolveTable(entry, window, record.input, record.cacheRead);
  if (!table) return { cost: 0, savings: 0, window, unpriced: true, targetId, priceBasis: "unpriced" };
  const { cost, savings } = computeCost(record, table);
  return { cost, savings, window, unpriced: false, targetId, priceBasis: "vendor" };
}

// Structural validation of a rate-version list (shared by presets + the unified
// pricelist): at least one version, unique effective-from times, complete price
// tables, valid HH:MM windows.
export function validateRates(models) {
  const errors = [];
  const isValidPrice = (v) => typeof v === "number" && isFinite(v) && v >= 0;
  const checkTable = (table, label) => {
    if (!table || typeof table !== "object") {
      errors.push(`${label} is not an object`);
      return;
    }
    if (table.tier) {
      const t = table.tier;
      if (typeof t.limit !== "number" || !isFinite(t.limit) || t.limit <= 0) errors.push(`${label}.tier.limit must be a positive number`);
      for (const side of ["low", "high"]) {
        const sub = t[side];
        if (!sub || typeof sub !== "object") {
          errors.push(`${label}.tier.${side} is missing`);
          continue;
        }
        for (const k of ["input", "output", "cacheRead", "cacheWrite"]) {
          if (k in sub && !isValidPrice(sub[k])) errors.push(`${label}.tier.${side}.${k} must be a non-negative number`);
        }
      }
    } else {
      for (const k of ["input", "output", "cacheRead", "cacheWrite"]) {
        if (k in table && !isValidPrice(table[k])) errors.push(`${label}.${k} must be a non-negative number`);
      }
    }
  };
  for (const rule of models || []) {
    if (!rule || !rule.model) {
      errors.push("A rule is missing a model name");
      continue;
    }
    if (!rule.rates || rule.rates.length === 0) {
      errors.push(`${rule.model} needs at least one rate version`);
      continue;
    }
    const seen = new Map();
    for (let i = 0; i < rule.rates.length; i++) {
      const raw = rule.rates[i].from;
      const parsed = parseBound(raw);
      if (typeof parsed === "number" && isNaN(parsed)) {
        errors.push(`${rule.model} version ${i + 1} has invalid effective-from "${raw}"`);
        continue;
      }
      const key = parsed === null ? "null" : String(parsed);
      if (seen.has(key)) {
        errors.push(`${rule.model} versions ${seen.get(key) + 1} and ${i + 1} have the same effective-from time`);
      } else {
        seen.set(key, i);
      }
    }
    for (let vi = 0; vi < rule.rates.length; vi++) {
      const entry = rule.rates[vi];
      const pricing = entry.pricing || {};
      if (entry.until !== undefined) {
        const untilTs = parseBound(entry.until);
        if (typeof untilTs === "number" && isNaN(untilTs)) {
          errors.push(`${rule.model} version ${vi + 1} has invalid until "${entry.until}"`);
        } else if (untilTs !== null) {
          const fromTs = parseBound(entry.from);
          if (typeof fromTs === "number" && !isNaN(fromTs) && untilTs <= fromTs) {
            errors.push(`${rule.model} version ${vi + 1} until "${entry.until}" must be after its from`);
          }
        }
      }
      const hasPeak = entry.windows && entry.windows.peak && entry.windows.peak.length > 0;
      if (!hasPeak) {
        if (!pricing.flat) errors.push(`${rule.model} version ${vi + 1} is missing the flat price table`);
        else checkTable(pricing.flat, `${rule.model} version ${vi + 1} flat`);
      } else {
        if (!pricing.peak || !pricing.offpeak) errors.push(`${rule.model} version ${vi + 1} is missing the peak/offpeak price tables`);
        else {
          checkTable(pricing.peak, `${rule.model} version ${vi + 1} peak`);
          checkTable(pricing.offpeak, `${rule.model} version ${vi + 1} offpeak`);
        }
      }
      if (entry.windows && entry.windows.peak) {
        if (!Array.isArray(entry.windows.peak)) {
          errors.push(`${rule.model} version ${vi + 1} windows.peak must be an array`);
        } else {
          entry.windows.peak.forEach((w, wi) => {
            const s = toMinutes(w.start);
            const e = toMinutes(w.end);
            if (s === null) errors.push(`${rule.model} version ${vi + 1} peak window ${wi + 1} start "${w.start}" is not HH:MM`);
            if (e === null) errors.push(`${rule.model} version ${vi + 1} peak window ${wi + 1} end "${w.end}" is not HH:MM`);
            if (s !== null && (s < 0 || s >= 24 * 60)) errors.push(`${rule.model} version ${vi + 1} peak window ${wi + 1} start out of range`);
            if (e !== null && (e < 0 || e >= 24 * 60)) errors.push(`${rule.model} version ${vi + 1} peak window ${wi + 1} end out of range`);
            if (w.days !== undefined) {
              if (!Array.isArray(w.days)) errors.push(`${rule.model} version ${vi + 1} peak window ${wi + 1} days must be an array`);
              else w.days.forEach((d) => {
                if (typeof d !== "number" || !Number.isInteger(d) || d < 0 || d > 6) errors.push(`${rule.model} version ${vi + 1} peak window ${wi + 1} has invalid day "${d}" (0-6)`);
              });
            }
          });
        }
      }
    }
  }
  return errors;
}
