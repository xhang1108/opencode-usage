// extension/shared/price-history.js
// Vendor-neutral price history. Snapshots are committed to git (one file per
// change); replaying them in order yields dated rate versions. Pure (P9).
//
// Snapshot shape:
//   { capturedAt: ISO, source, models: { "<id>": { label, canonical?, entry, raw?, effectiveAt? } } }
// where `entry` is one rate-version entry WITHOUT `from`
//   { pricing: { flat | tier }, windows? , pricing: { peak, offpeak } }
// (same schema shared/pricing.js consumes).

import { makeTargetId } from "../dashboard/core/pricing-config.js";

export function versionsFromSnapshots(snapshots) {
  const ordered = (snapshots || []).filter(Boolean).slice().sort((a, b) => String(a.capturedAt).localeCompare(String(b.capturedAt)));
  const state = {};
  for (const snap of ordered) {
    for (const [id, m] of Object.entries(snap.models || {})) {
      if (!m || !m.entry) continue;
      const key = JSON.stringify(m.entry);
      const st = state[id] || (state[id] = { label: m.label || id, canonical: m.canonical || id, versions: [], lastKey: null });
      st.label = m.label || st.label;
      st.canonical = m.canonical || st.canonical;
      if (st.lastKey === key) continue;
      st.versions.push({ from: st.versions.length === 0 ? null : (m.effectiveAt || snap.capturedAt), ...m.entry });
      st.lastKey = key;
    }
  }
  return state;
}

export function presetFromVersions(state, { source } = {}) {
  const src = source || "unknown";
  const modelMap = {};
  const targets = {};
  const used = {};
  for (const id of Object.keys(state || {}).sort()) {
    const st = state[id];
    if (!st || !st.versions || st.versions.length === 0) continue;
    const slug = makeTargetId(st.label || id, used);
    used[slug] = true;
    const targetId = `${src}:${slug}`;
    targets[targetId] = { label: st.label || id, scope: src, rates: st.versions };
    modelMap[`${src}:${id}`] = targetId;
    const canonicalKey = `${src}:${st.canonical}`;
    if (st.canonical && st.canonical !== id && !modelMap[canonicalKey]) modelMap[canonicalKey] = targetId;
  }
  return { presetVersion: 2, source: src, modelMap, targets };
}

// Snapshot helper: build the snapshot entry wrapper from a rate entry.
export function snapModel(label, entry, extra = {}) {
  return { label, entry, ...extra };
}
