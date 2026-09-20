// extension/dashboard/core/import-plan.js
// Pure logic for the one Import Usage entry: which parser a file goes to, how a
// records CSV splits across stores, and the settings-restore summary. Pure: no
// chrome, no DOM (the caller does the actual storage writes).
import { groupBySource, SETTINGS_FORMAT } from "../../shared/backup.js";

// Dispatch a file to its parser by extension.
export function classifyImport(name) {
  const n = name || "";
  if (/\.xlsx$/i.test(n)) return "xlsx";
  if (/\.csv$/i.test(n)) return "csv";
  if (/\.json$/i.test(n)) return "json";
  return "unsupported";
}

// A .json is our own settings backup (vs an opencode local-DB export).
export function isSettingsPayload(parsed) {
  return !!parsed && parsed.format === SETTINGS_FORMAT;
}

// Split a records CSV into its destinations.
//   localMap      - opencode records (id-keyed; re-import is idempotent). Every
//                   opencode record is kept, old crawl history included: the
//                   local store is fingerprint-deduped against the live API rows
//                   in background, so restoring a backup never double-counts the
//                   overlap with the Console's retention window.
//   vendors       - [{ source, records }] for known non-opencode sources
//   unknownCount  - records whose source is not in the registry
export function planRecordsImport(records, vendorSources) {
  const localMap = {};
  const vendors = [];
  let unknownCount = 0;
  const known = new Set(vendorSources || []);
  for (const [source, recs] of groupBySource(records)) {
    if (source === "opencode") {
      for (const rec of recs) localMap[rec.id] = rec;
    } else if (known.has(source)) {
      vendors.push({ source, records: recs });
    } else {
      unknownCount += recs.length;
    }
  }
  return { localMap, vendors, unknownCount };
}

// Summary for a restored settings backup (records live in the CSV).
export function describeSettingsRestore(patch) {
  const n = Object.keys(patch || {}).length;
  return `settings restored (${n} section${n === 1 ? "" : "s"})`;
}

// B7: record the first time each currently-unpriced model was seen, pruning the
// ones that got priced. Returns the next map and whether it differs.
export function mergeFirstSeen(prev, models, now) {
  prev = prev || {};
  const at = now == null ? Date.now() : now;
  const next = {};
  let changed = false;
  for (const m of models) {
    next[m] = prev[m] != null ? prev[m] : at;
    if (prev[m] == null) changed = true;
  }
  for (const k of Object.keys(prev)) if (!(k in next)) changed = true;
  return { next, changed };
}
