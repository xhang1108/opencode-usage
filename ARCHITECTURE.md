# Architecture: storage, provenance, and upgrades

This is the contract the data layer depends on. Read it before changing where
records or settings are stored, or before shipping a breaking change.

## Storage layers

| Layer | Location | Scoped to | Survives extension-ID change | Owner |
|---|---|---|---|---|
| opencode crawl | OPFS on the `opencode.ai` origin (`opencode_token_cache_<workspace>.json`) | the site origin | **yes** | opencode content script |
| crawl snapshot | `chrome.storage.local` `cachedData` / `cachedMeta` | extension ID | no (rebuilt from OPFS) | background |
| opencode local DB import | `chrome.storage.local` `localImportData` / `localImportMeta` | extension ID | no (re-import) | background |
| vendor records | `chrome.storage.local` `<source>ImportData` | extension ID | no (re-import / re-crawl) | background |
| settings | `chrome.storage.local` (`vendorSettings`, `unifiedPricing`, …) | extension ID | no | dashboard |

Key consequences:

- **opencode crawl history is the only ID-independent store.** It survives a
  folder move / re-clone; everything else lives in `chrome.storage.local` and
  does not.
- The extension ID is pinned by `key` in `extension/manifest.json`. Removing it
  changes the ID and silently resets `chrome.storage.local` on the next load —
  never remove `key` (the manifest test guards this).

## Record provenance

A record's provenance is the **bucket it is stored in**, not a guess from its id
or workspace:

- `crawl` — opencode snapshot / OPFS.
- `local` — `localImportData` (from `tools/import-local.mjs`).
- `vendor:<source>` — `<source>ImportData`.

`shared/stores.js` is the single source of truth for store keys and their clear
messages; the Database tab and `handleGetDatabase` both use it. Every record is
listed in exactly one store (classification is by id membership in the managed
buckets), and every managed store has exactly one clear handler.

Same-source dedupe: crawl vs local/vendor copies of the same usage are collapsed
by fingerprint (`shared/merge.js`), so a re-import never double-counts.

## Settings and backup

- `Export Backup` writes two disjoint files: `opencode-usage_settings_*.json`
  (settings + pricing) and `opencode-usage_records_*.csv` (every record, every
  source, with lossless `raw`).
- Restore is id-keyed and idempotent. **Only the `local` track of opencode is
  restorable into extension storage**; crawl-track records are rebuilt from OPFS
  by `Crawl Now`, so restoring them is skipped to avoid polluting the local
  bucket (see `importRecordsCSV`).

## Schema version and migrations

`chrome.storage.local.schemaVersion` (`shared/migrate.js`, `STORAGE_SCHEMA_VERSION`)
tracks the storage layout, separate from the record schema (`v`,
`shared/canonical.js`). Rules for any breaking layout change:

1. Add a migration step (`{ to, keys, apply }`) in `shared/migrate.js`.
2. Migrations are **additive**: write/rename keys, never delete user data. Leave
   legacy keys in place for read-through and downgrade.
3. Migrations are **idempotent**: re-running on a migrated store is a no-op.
4. The runner (`ensureStorageSchema` in `background.js`) reads only the keys a
   pending step declares and writes all patches plus the version in one `set`.

## Breaking-change checklist

1. Decide and document what users lose (CHANGELOG "Upgrading from …").
2. Prefer additive changes + read-through fallback; never delete legacy keys.
3. Bump the manifest version; tag `vX.Y.Z` to match (`release.yml` enforces this).
4. Update `CHANGELOG.md` — the release body is extracted from it.
5. Verify the ID / OPFS assumptions with a real load: crawl, change the folder,
   reload, confirm history rebuilds.
6. Run `node tools/build-manifest.mjs --check` and `npm test`.

## Guardrails (CI)

`.github/workflows/ci.yml` runs on every push/PR: the manifest/build check, the
test suite, and a version-regression check. Tests cover the manifest `key`, the
migration planner, store/clear invariants, and the backup round-trip.
