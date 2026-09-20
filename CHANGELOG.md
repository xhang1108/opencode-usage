# Changelog

## Unreleased

opencode now syncs from the Console Usage API instead of crawling the RSC `/_server` protocol.

### Changed

- **opencode data source**: `GET /console/api/usage/rows?range=all` (session cookie + `x-org-id`), cursor-paginated, one record per request. Full history via `range=all`; incremental via `since`. Records land in `opencodeImportData`.
- **opencode cost**: always the Console-charged amount (`cost_micro_cents / 1e8`). Peak/offpeak is labelled from the record's timestamp and the model's rate windows, so the split stays meaningful without changing the price.
- **Usage link**: the popup's "Open Usage" link and the auto-opened tab now use `/console/<org>/usage` (was `/workspace/<workspace>/usage`).
- **Popup button**: "Crawl <vendor>" → "Sync <vendor>" (Shift = Full Sync).
- **Import Usage (opencode)**: records are now upserted by content fingerprint (`model|input|output|reasoning|cacheRead|cacheWrite`, ±2 min), checked under both output encodings (no date cutoff). A duplicate merges into the stored record (filling missing fields; the API store wins on conflicts) instead of being skipped or double-counted. Old crawl backups can therefore be restored alongside the live API history.

### Removed

- The opencode RSC crawler: `interceptor.js`, `crawl-worker.js`, the OPFS cache, the D23 output heal, and the `/workspace/.../usage` crawl path. Other vendors are unchanged.

## 1.0.0 — 2026-09-15

Multi-vendor support, a unified price list, and version-aware pricing. **This is a breaking release — read the upgrade notes.**

### ⚠️ Upgrading from 0.8.x

1. **Remove the old extension before loading this one.** `chrome://extensions` → remove the 0.8.x card → **Load unpacked** → select the `extension` folder. Two copies would both crawl and double-count.
2. **Your usage history is kept.** opencode crawl data lives in OPFS on the `opencode.ai` origin, independent of the extension ID. After loading, open your opencode.ai Usage page and click **Crawl Now** to rebuild it.
3. **Your settings reset once.** This release pins a stable extension ID (`key`), which changes the storage namespace one time. Re-set: the peak-reminder toggle/model, workspace display names, enabled vendors, and default crawl vendor.
4. **Custom Rate Settings from 0.8.x are not carried over.** Costs fall back to the shipped price tables; edit them in **Settings → Pricing**. (The 0.8.x rates JSON is not importable by 1.0.0.)
5. **Local DB imports must be redone.** Records imported with `tools/import-local.mjs` are stored in extension storage (not opencode.ai) and do not survive the ID change — re-run the tool and **Import Usage** again.

### Added

- **Multi-vendor usage**: opencode, OpenRouter, DeepSeek, CommandCode, MiMo — separate pipelines, one dashboard. Enable per vendor in **Settings → Vendors**; each optional host is requested on first enable.
- **Unified pricing**: one user-authored price list for every vendor, keyed by `<source>:<model>`, with per-model rate groups and versioned rates. Recompute costs at any time.
- **Fingerprint grouping**: rate groups are derived from a model fingerprint (series / version / variant), so spelling, routing-prefix and date-stamp variants collapse into one group. Unenumerated spellings still resolve through a fallback key.
- **Version-aware pricing**: each rate carries effective and retired versions; peak windows come from the version in force, so a superseded promo stops announcing. A retired version no longer prices history.
- **Import Usage**: a single entry that accepts MiMo XLSX, opencode local JSON, vendor exports, and backups (multi-select a mix of types).
- **Settings → Database**: lists every usage store and where it lives (OPFS vs `chrome.storage.local`), with per-record and per-store deletion for extension-owned stores. Records are grouped by bucket membership, so each one appears exactly once. Backup export lives here.
- **Export Backup**: one button, two disjoint files — `opencode-usage_settings_*.json` (settings + pricing) and `opencode-usage_records_*.csv` (every record, every source, with lossless `raw`). Import restores either.
- **Stable extension ID**: a `key` in the manifest pins the ID so the folder can be moved/re-cloned without losing data.
- **Storage migrations**: storage carries a `schemaVersion` and additive, idempotent migrations run at startup.
- **How it works diagrams**: each pipeline section renders a self-drawn SVG flowchart alongside its notes.
- Automatic per-vendor price presets and a price-watch workflow.

### Changed

- Cost source is per vendor: token-derived by default, or vendor-reported spend where trusted (OpenRouter, CommandCode).
- Records are canonical and immutable; costs are recomputed on render, so a corrected price retroactively fixes history.
- Dashboard settings are split into General / Vendors / Pricing / Database / How it works. The local-import how-to moves to **How it works**, Backup to **Database**, and General keeps only crawl and display options.
- The popup and dashboard share one copy of the switch, time-reminder card, heatmap and custom-select/resizable-editor widgets, with no visual change.
- Guardrails: CI verifies the generated manifest and registry, runs the test suite, and fails if the manifest version falls below the latest tag.

### Fixed

- Day-granular records billed the oldest rate version; the migration backfills each map's `time`/`v` (DeepSeek flash cache-hit $0.028 → $0.0028).
- The pricing board no longer lists a structurally-billed model as Unassigned — pricing and the board resolve a chip through one fingerprint rule, and structurally-pinned chips are marked.
- Restored the vendor alias folds lost in the fingerprint refactor (deepseek-chat/reasoner, the flash expiry label, and the muse-spark contributor lines).
- The peak-reminder picker drops retired and flat-version models and heals a stale selection.
