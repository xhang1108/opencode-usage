// extension/shared/unified.js
// Unified pricing: one user-authored price list for every vendor, keyed by
// "<source>:<model>". When enabled it replaces vendor-reported spend and the
// author-maintained fallback tables entirely (no fallback: a model that is not
// assigned to a group is unpriced). Pure (P9).
//
// Shape (stored in settings, shipped default at shared/unified.preset.json):
//   {
//     enabled: boolean,
//     groups: [ { id, rates: [ <rate version entry> ] } ],
//     assign: { "<source>:<model>": groupId }
//   }
// Rate version entries use the same schema as shared/pricing.js.

import { priceFromRates, validateRates } from "./pricing.js";

const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);

export function normalizeUnifiedPricing(value) {
  const src = isPlainObject(value) ? value : {};
  const groups = [];
  const usedIds = new Set();
  for (const g of Array.isArray(src.groups) ? src.groups : []) {
    if (!isPlainObject(g)) continue;
    let id = typeof g.id === "string" && g.id ? g.id : null;
    if (!id) id = makeGroupId(usedIds);
    if (usedIds.has(id)) id = makeGroupId(usedIds);
    usedIds.add(id);
    groups.push({ id, rates: Array.isArray(g.rates) ? g.rates : [] });
  }
  const assign = {};
  if (isPlainObject(src.assign)) {
    for (const [key, groupId] of Object.entries(src.assign)) {
      if (typeof key !== "string" || !key) continue;
      if (!usedIds.has(groupId)) continue; // drop dangling assignments
      assign[key] = groupId;
    }
  }
  return { enabled: src.enabled === true, groups, assign };
}

export function makeGroupId(existing = new Set()) {
  let n = existing.size + 1;
  let id = `group-${n}`;
  while (existing.has(id)) id = `group-${++n}`;
  return id;
}

// Referenced model keys for one group, sorted.
export function modelsInGroup(unified, groupId) {
  return Object.entries((unified && unified.assign) || {})
    .filter(([, g]) => g === groupId)
    .map(([key]) => key)
    .sort();
}

// Structural validation; rate lists share the rules with presets.
export function validateUnifiedPricing(value) {
  const errors = [];
  if (!isPlainObject(value)) return ["unified pricing must be an object"];
  const groups = value.groups;
  if (groups != null && !Array.isArray(groups)) {
    errors.push("groups must be an array");
    return errors;
  }
  const ids = new Set();
  for (const [i, g] of (groups || []).entries()) {
    if (!isPlainObject(g)) {
      errors.push(`group ${i + 1} is not an object`);
      continue;
    }
    if (typeof g.id !== "string" || !g.id) errors.push(`group ${i + 1} is missing an id`);
    else if (ids.has(g.id)) errors.push(`group id "${g.id}" is duplicated`);
    else ids.add(g.id);
    errors.push(...validateRates([{ model: g.id || `group ${i + 1}`, rates: isPlainObject(g) ? g.rates : [] }]));
  }
  if (value.assign != null) {
    if (!isPlainObject(value.assign)) {
      errors.push("assign must be an object of { \"<source>:<model>\": groupId }");
    } else {
      for (const [key, groupId] of Object.entries(value.assign)) {
        if (!ids.has(groupId)) errors.push(`assign "${key}" points at missing group "${groupId}"`);
      }
    }
  }
  return errors;
}

// Flatten to Map<"<source>:<model>", rates[]> for the hot pricing path.
export function buildUnifiedIndex(unified) {
  const map = new Map();
  const byId = new Map();
  for (const g of (unified && unified.groups) || []) byId.set(g.id, g.rates || []);
  for (const [key, groupId] of Object.entries((unified && unified.assign) || {})) {
    const rates = byId.get(groupId);
    if (rates && rates.length > 0) map.set(key, rates);
  }
  return map;
}

// Price one record against the unified index. `priceBasis` is "unified"; a model
// with no group is unpriced with zero cost (no fallback).
export function priceUnified(record, index) {
  const source = (record && record.source) || "opencode";
  const key = `${source}:${record && record.model}`;
  const rates = index && index.get(key);
  if (!rates) return { cost: 0, savings: 0, window: null, unpriced: true, targetId: null, priceBasis: "unmapped" };
  const out = priceFromRates(record, rates, "unified");
  return { ...out, targetId: key };
}

// [{ model, rates }] for the peak/off-peak reminder card. Deduped by model name
// (the reminder keys off the model only), matching legacyModelsFromPricing.
export function unifiedRateModels(unified) {
  const groups = new Map(((unified && unified.groups) || []).map((g) => [g.id, g.rates || []]));
  const rules = [];
  const seen = new Set();
  for (const [key, groupId] of Object.entries((unified && unified.assign) || {})) {
    const rates = groups.get(groupId);
    if (!rates || rates.length === 0) continue;
    const colon = key.indexOf(":");
    const model = colon === -1 ? key : key.slice(colon + 1);
    if (seen.has(model)) continue;
    seen.add(model);
    rules.push({ model, rates });
  }
  return rules;
}
