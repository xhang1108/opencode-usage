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

export const STORAGE_SCHEMA_VERSION = 1;

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
