// extension/shared/migrate.js
// Storage-level schema version + additive, idempotent migrations. Zero chrome
// dependencies (P9) so it is unit-testable.
//
// The record schema has its own version (`v`, canonical.SCHEMA_VERSION); this is
// the version of the chrome.storage.DATA layout as a whole. Every breaking
// layout change adds a step here instead of ad-hoc on-load guessing.
//
// Rules:
//   - Additive only. A step may write or rename keys but must NEVER delete user
//     data; legacy keys are left in place for read-through and downgrade.
//   - Idempotent. Re-running on an already-migrated store is a no-op.
//   - Applied atomically-ish: the runner writes every patched key plus the new
//     version in one chrome.storage.local.set call.

import { normalizeRecord } from "./canonical.js";

export const STORAGE_SCHEMA_VERSION = 2;

// Storage keys that hold `{ id: record }` JSON maps and may contain records
// written before canonical normalization stamped `time`/`v`.
const RECORD_MAP_KEYS = [
  "localImportData",
  "cachedData",
  "commandcodeImportData",
  "deepseek-officialImportData",
  "mimoImportData",
  "opencodeImportData",
  "openrouterImportData",
];

// True when a stored record predates canonical normalization: no usable `time`
// (day-granular rows used to carry only `date`) or no record schema version.
function recordNeedsHeal(rec) {
  if (!rec || typeof rec !== "object" || !rec.model) return false;
  if (rec.time == null || rec.time === "") return true;
  if (isNaN(new Date(rec.time).getTime())) return true;
  if (rec.v == null) return true;
  return false;
}

// Re-normalize a stored JSON record map, backfilling `time` from `date` (UTC
// midnight). Returns the new JSON string, or null when nothing needed healing.
function healRecordMap(json) {
  if (typeof json !== "string" || json === "") return null;
  let map;
  try {
    map = JSON.parse(json);
  } catch (e) {
    return null;
  }
  if (!map || typeof map !== "object" || Array.isArray(map)) return null;
  let dirty = false;
  for (const rec of Object.values(map)) {
    if (recordNeedsHeal(rec)) {
      dirty = true;
      break;
    }
  }
  if (!dirty) return null;
  const out = {};
  for (const [id, rec] of Object.entries(map)) {
    out[id] = rec && typeof rec === "object" && rec.model ? normalizeRecord(rec) || rec : rec;
  }
  return JSON.stringify(out);
}

// Each step upgrades TO its `to` version. `keys` lists the storage keys the
// step needs to inspect (kept minimal so startup does not read the world).
// `apply(state)` returns a patch of storage keys to write - never a removal.
export const MIGRATIONS = [
  {
    to: 1,
    // v0 (pre-multi-vendor / unversioned) -> v1: adopt the versioned layout.
    // The multi-vendor keys are written by the app on demand; nothing to move.
    keys: [],
    apply() {
      return {};
    },
  },
  {
    to: 2,
    // Backfill `time`/`v` on stored records. Older crawl/import shapes stored
    // day-granular rows with only `date`; pricing then fell back to the OLDEST
    // rate version and billed years-old promo prices (DeepSeek flash cache-hit
    // $0.028 instead of $0.0028). Healing is idempotent and additive.
    keys: RECORD_MAP_KEYS,
    apply(state) {
      const patch = {};
      for (const key of RECORD_MAP_KEYS) {
        const fixed = healRecordMap(state[key]);
        if (fixed !== null) patch[key] = fixed;
      }
      return patch;
    },
  },
];

// Steps that still need to run for a store currently at `from`.
export function pendingMigrations(from, steps = MIGRATIONS) {
  const v = Number.isFinite(Number(from)) ? Number(from) : 0;
  return steps.filter((m) => m.to > v).sort((a, b) => a.to - b.to);
}

// Pure planner: given the raw stored state (including `schemaVersion`), return
// the writes needed to reach the current version.
//   { version, patch, applied }
// `version` is the resulting version to stamp (never a downgrade).
export function planMigrations(state, steps = MIGRATIONS) {
  const from = Number(state && state.schemaVersion) || 0;
  const pending = pendingMigrations(from, steps);
  if (pending.length === 0) return { version: from, patch: {}, applied: [] };

  const patch = {};
  const applied = [];
  let cur = { ...(state || {}) };
  for (const step of pending) {
    const stepPatch = step.apply(cur) || {};
    Object.assign(patch, stepPatch);
    cur = { ...cur, ...stepPatch };
    applied.push(step.to);
  }
  return { version: STORAGE_SCHEMA_VERSION, patch, applied };
}
