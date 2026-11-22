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

// Replay committed snapshots oldest-first into per-model version chains. A model
// present in an earlier snapshot but absent later is NOT dropped or retired: its
// state (and so its last rate version) is kept indefinitely, and that last
// version keeps pricing records for any time after it takes effect. There is no
// version `until`/retirement cutoff on this path — a withdrawn model still
// resolves to the last price the vendor published for it.
export function versionsFromSnapshots(snapshots) {
  const ordered = (snapshots || []).filter(Boolean).slice().sort((a, b) => String(a.capturedAt).localeCompare(String(b.capturedAt)));
  const state = {};
  for (const snap of ordered) {
    for (const [id, m] of Object.entries(snap.models || {})) {
      if (!m) continue;
      // A vendor that publishes a scheduled change inside one table (Google's
      // Gemini 4 intro/list rates) supplies the FULL dated chain here. Replay it
      // verbatim instead of treating the snapshot as a single diff step. `entry`
      // (the current leg) is still required for older readers and integrity
      // checks; `versions` is authoritative when present.
      if (Array.isArray(m.versions) && m.versions.length > 0) {
        if (!m.entry) throw new Error(`price-history: ${id} has versions but no entry`);
        const last = m.versions[m.versions.length - 1];
        const { from, ...lastEntry } = last;
        state[id] = {
          label: m.label || id,
          canonical: m.canonical || id,
          versions: m.versions.map((v) => ({ ...v })),
          lastKey: JSON.stringify(lastEntry),
        };
        continue;
      }
      if (!m.entry) continue;
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
