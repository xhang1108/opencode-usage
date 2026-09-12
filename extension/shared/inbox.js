// extension/shared/inbox.js
// Unmapped-model tracking (P5): models with no modelMap entry cost 0 and are
// surfaced so the user can classify them. Zero chrome dependencies (P9).

import { resolveTargetId } from "./pricing.js";

export function isPriced(record, pricing) {
  const targetId = resolveTargetId(record, pricing.modelMap);
  return !!(targetId && pricing.targets[targetId]);
}

// Returns { items, firstSeen, oldest, count }. `firstSeen` is the persisted
// map (key "<source>:<model>" -> first ISO time); items are the currently
// unmapped keys, oldest first. Keys that become mapped are dropped.
export function computeInbox(records, pricing, firstSeen = {}, { now = new Date() } = {}) {
  const previous = firstSeen && typeof firstSeen === "object" ? firstSeen : {};
  const present = new Set();
  const next = {};
  for (const rec of records || []) {
    if (!rec || !rec.model) continue;
    if (isPriced(rec, pricing)) continue;
    const key = `${rec.source || "opencode"}:${rec.model}`;
    present.add(key);
    next[key] = previous[key] || rec.time || now.toISOString();
  }
  const items = [...present]
    .map((key) => ({ key, firstSeen: next[key] }))
    .sort((a, b) => String(a.firstSeen).localeCompare(String(b.firstSeen)));
  return { items, firstSeen: next, oldest: items[0] ? items[0].firstSeen : null, count: items.length };
}
