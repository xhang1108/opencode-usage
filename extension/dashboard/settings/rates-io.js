// extension/dashboard/settings/rates-io.js
// Rate-settings JSON import/export + structural validation. Pure (P9); the
// parsing rules are shared with shared/pricing.js (version chain, windows).

import { parseBound, toMinutes } from "../../shared/pricing.js";

export function stringifyRates(models, version) {
  return JSON.stringify({ version, timezone: "UTC", models }, null, 2);
}

export function parseRatesJson(text) {
  const raw = String(text || "").trim();
  if (!raw) throw new Error("JSON is empty");
  const parsed = JSON.parse(raw);
  const models = Array.isArray(parsed) ? parsed : parsed.models;
  if (!Array.isArray(models)) throw new Error('JSON must be an array or an object with a "models" array');
  return models;
}

// Structural validation: model required, at least one version, unique
// effective-from times, complete price tables, valid HH:MM windows.
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
    if (!rule.model) {
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
