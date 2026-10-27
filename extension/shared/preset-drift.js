// extension/shared/preset-drift.js
// Detects a stored unified price list that fell behind the shipped one.
//
// Why this exists: the Pricing board persists the WHOLE list into
// chrome.storage.local the first time the user touches it (even the master
// toggle), so an extension update that improves shared/unified.preset.json
// never reaches that user until they press "Reset to preset" — which they have
// no reason to know about. This module answers "is the shipped list
// materially better for the data this user actually has?", so the dashboard can
// offer a one-click refresh instead of waiting for the user to find Settings.
//
// Pure (no chrome, no DOM). Records are the same canonical records the
// dashboard aggregates, so pricing here matches what the UI shows.

import { buildUnifiedIndex, priceUnified } from "./unified.js";

// Below these counts the difference is not worth interrupting the user.
export const MIN_RECOVERABLE = 3; // unpriced models the shipped list can price
export const MIN_REPRICED = 5; // models whose bill the shipped list changes

const recordKey = (rec) => `${(rec && rec.source) || "opencode"}:${rec && rec.model}`;

// { stored, shipped } are normalized unified pricelists, `records` canonical.
// Returns:
//   recoverable      sorted "<source>:<model>" keys, unpriced now but priced by the shipped list
//   recoverableCount how many such models
//   repricedCount    how many models the shipped list prices differently (cost moved)
//   lostCount        models only the stored list prices (a reset would unprice them)
//   addedGroups      groups in the shipped list that the stored one does not have
//   suggest          true when the drift is big enough to prompt on its own
//   offer            true when the in-notice refresh is worth offering: either the
//                    drift is material, or the notice is already listing models
//                    the shipped list can price (one new model is enough there —
//                    the user is looking at the unpriced badge anyway, and
//                    leaving them without the button strands it forever)
export function computePresetDrift({ stored, shipped, records } = {}) {
  const out = { recoverable: [], recoverableCount: 0, repricedCount: 0, lostCount: 0, addedGroups: 0, suggest: false, offer: false };
  if (!stored || !shipped) return out;

  const storedIndex = buildUnifiedIndex(stored);
  const shippedIndex = buildUnifiedIndex(shipped);
  const storedGroups = new Set(((stored && stored.groups) || []).map((g) => g.id));
  out.addedGroups = ((shipped && shipped.groups) || []).filter((g) => !storedGroups.has(g.id)).length;

  const recoverable = new Set();
  const repriced = new Set();
  const lost = new Set();
  for (const rec of records || []) {
    const now = priceUnified(rec, storedIndex);
    if (now.unpriced) {
      // Pricing an unpriced record is cheap (no rate walk), so this cannot
      // dominate the pass even for a large store.
      if (!priceUnified(rec, shippedIndex).unpriced) recoverable.add(recordKey(rec));
      continue;
    }
    // Priced already: only the rate table pointed at can have changed. Comparing
    // the tables first keeps the expensive per-record price off the hot path.
    const targetId = now.targetId;
    const before = targetId ? storedIndex.get(targetId) : null;
    const after = targetId ? shippedIndex.get(targetId) : null;
    if (!after) {
      // The stored list prices this model from a group the shipped list does not
      // have (a custom assignment). Say so: a reset would leave it unpriced.
      lost.add(recordKey(rec));
      continue;
    }
    if (before && JSON.stringify(before) === JSON.stringify(after)) continue;
    const next = priceUnified(rec, shippedIndex);
    if (next.unpriced || Math.abs(next.cost - now.cost) > 1e-12) repriced.add(recordKey(rec));
  }

  out.recoverable = [...recoverable].sort();
  out.recoverableCount = recoverable.size;
  out.repricedCount = repriced.size;
  out.lostCount = lost.size;
  out.suggest = out.recoverableCount >= MIN_RECOVERABLE || out.repricedCount >= MIN_REPRICED;
  out.offer = out.suggest || out.recoverableCount > 0;
  return out;
}
