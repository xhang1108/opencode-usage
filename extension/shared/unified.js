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
import { parse } from "./model-fingerprint.js";

const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);

// Assign keys with this prefix are fingerprint fallbacks (see build-unified-
// preset.mjs): "<prefix><series>:<version>:<variant>:<model>" -> groupId. They
// let a model we never enumerated resolve to its group by structure. They are
// never shown as model chips.
export const FINGERPRINT_PREFIX = "fp:";
const isFingerprintKey = (key) => key.startsWith(FINGERPRINT_PREFIX);

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

// Referenced model keys for one group, sorted. Fingerprint fallback keys are
// internal and never listed as models.
export function modelsInGroup(unified, groupId) {
  return Object.entries((unified && unified.assign) || {})
    .filter(([key, g]) => g === groupId && !isFingerprintKey(key))
    .map(([key]) => key)
    .sort();
}

// The assign key a "<source>:<model>" resolves to: the exact key, else the
// fingerprint fallback. Returns null when neither is present. Shared by the
// pricing path and the dashboard board so both agree on what is assigned.
export function resolveAssignKey(assign, key) {
  if (!assign) return null;
  if (assign[key]) return key;
  const fp = FINGERPRINT_PREFIX + parse(key).fingerprint;
  return assign[fp] ? fp : null;
}

// The group id a "<source>:<model>" prices against, or null when unassigned.
export function groupIdForKey(assign, key) {
  const k = resolveAssignKey(assign, key);
  return k ? assign[k] : null;
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
// with no group is unpriced with zero cost (no fallback). Lookup is by exact
// "<source>:<model>" first, then by structural fingerprint so the same model
// reported under a new spelling or vendor still finds its group.
export function priceUnified(record, index) {
  const source = (record && record.source) || "opencode";
  const key = `${source}:${record && record.model}`;
  let targetId = key;
  let rates = index && index.get(key);
  if (!rates) {
    targetId = FINGERPRINT_PREFIX + parse(key).fingerprint;
    rates = index && index.get(targetId);
  }
  if (!rates) return { cost: 0, savings: 0, window: null, unpriced: true, targetId: null, priceBasis: "unmapped" };
  const out = priceFromRates(record, rates, "unified");
  return { ...out, targetId };
}

// [{ model, rates }] for the peak/off-peak reminder card: ONE rule per group, so
// the picker never repeats the same rate table under every alias that points at
// it (the DeepSeek flash group is reachable through eight spellings). Auto-named
// "group-N" ids fall back to the first assigned model name so the option stays
// readable.
const AUTO_GROUP_ID = /^group-\d+$/;

export function unifiedRateModels(unified) {
  const ratesByGroup = new Map(((unified && unified.groups) || []).map((g) => [g.id, g.rates || []]));
  const namesByGroup = new Map();
  const pointed = new Set();
  for (const [key, groupId] of Object.entries((unified && unified.assign) || {})) {
    pointed.add(groupId);
    if (isFingerprintKey(key)) continue; // internal, not a display name
    const colon = key.indexOf(":");
    const name = colon === -1 ? key : key.slice(colon + 1);
    const list = namesByGroup.get(groupId);
    if (list) list.push(name);
    else namesByGroup.set(groupId, [name]);
  }
  const rules = [];
  for (const [groupId, rates] of ratesByGroup) {
    if (rates.length === 0) continue;
    if (!pointed.has(groupId)) continue; // nothing points at this group
    const names = namesByGroup.get(groupId);
    if (AUTO_GROUP_ID.test(groupId)) {
      if (!names || names.length === 0) continue; // auto id with no readable name
      rules.push({ model: names.slice().sort()[0], rates });
    } else {
      rules.push({ model: groupId, rates });
    }
  }
  return rules;
}
