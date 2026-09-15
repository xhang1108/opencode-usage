// extension/dashboard/settings/unified-model.js
// Pure model behind the unified-pricing board (Settings → Pricing). The board's
// drag/drop, rename, add and delete handlers all mutate the price list; keeping
// those mutations here makes them testable and keeps the DOM layer thin.
// No chrome, no DOM.

import { normalizeUnifiedPricing, makeGroupId, FINGERPRINT_PREFIX, groupIdForKey } from "../../shared/unified.js";

const ZERO_RATES = [{ from: null, pricing: { flat: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } }];

// Every key that should be pickable: every model that appears in the loaded
// records, plus every fallback-preset model (so authors can pre-assign).
export function collectKeys({ records, modelMap, assign } = {}) {
  const keys = new Set();
  for (const rec of records || []) keys.add(`${rec.source || "opencode"}:${rec.model}`);
  for (const key of Object.keys(modelMap || {})) keys.add(key);
  for (const key of Object.keys(assign || {})) keys.add(key);
  for (const key of [...keys]) if (key.startsWith(FINGERPRINT_PREFIX)) keys.delete(key);
  return [...keys].sort();
}

// The group a chip actually prices against: an exact assign key, or - like
// priceUnified - the fingerprint fallback (shared/unified.js). Without this the
// board would list a structurally-priced model
// (commandcode:poolside/laguna-s-2.1-free) as Unassigned while its records are
// already billed at the group rate.
export const effectiveGroup = (unified, key) => groupIdForKey(unified.assign, key);

// Partition the known keys for the board.
export function boardModel(unified, keys) {
  const groupOf = new Map(keys.map((k) => [k, effectiveGroup(unified, k)]));
  const known = new Set(unified.groups.map((g) => g.id));
  const unassigned = keys.filter((k) => !known.has(groupOf.get(k)));
  // Chips with no explicit assign key that still resolve by fingerprint; shown in
  // the group but marked so the pin is visible.
  const structural = new Set(keys.filter((k) => groupOf.get(k) && !unified.assign[k]));
  return { groupOf, unassigned, structural };
}

// Drag a chip onto a group (or the Unassigned zone). `target` is a group id or "none".
export function moveChip(unified, key, target) {
  const next = normalizeUnifiedPricing(unified);
  if (target === "none") delete next.assign[key];
  else next.assign[key] = target;
  return next;
}

export function setGroupRates(unified, id, rates) {
  const next = normalizeUnifiedPricing(unified);
  const group = next.groups.find((g) => g.id === id);
  if (group) group.rates = rates;
  return next;
}

export function deleteGroup(unified, id) {
  const next = normalizeUnifiedPricing(unified);
  next.groups = next.groups.filter((g) => g.id !== id);
  return next;
}

export function addGroup(unified) {
  const next = normalizeUnifiedPricing(unified);
  next.groups.push({ id: makeGroupId(new Set(next.groups.map((g) => g.id))), rates: ZERO_RATES });
  return next;
}

// Rename a group and re-point every assignment so nothing dangles. Returns
// { ok:false, reason } for a no-op rename or a name already in use (the caller
// keeps the old value in that case).
export function renameGroup(unified, oldId, newId) {
  if (!newId || newId === oldId) return { ok: false, reason: "noop" };
  const next = normalizeUnifiedPricing(unified);
  if (next.groups.some((g) => g.id === newId)) return { ok: false, reason: "duplicate" };
  next.groups = next.groups.map((g) => (g.id === oldId ? { ...g, id: newId } : g));
  const assign = {};
  for (const [key, groupId] of Object.entries(next.assign)) assign[key] = groupId === oldId ? newId : groupId;
  next.assign = assign;
  return { ok: true, unified: next };
}
