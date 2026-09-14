# Changelog

## 1.0.0 — 2026-09-14

Multi-vendor support and a unified price list. **This is a breaking release — read the upgrade notes.**

### ⚠️ Upgrading from 0.8.x

1. **Remove the old extension before loading this one.** `chrome://extensions` → remove the 0.8.x card → **Load unpacked** → select the `extension` folder. Two copies would both crawl and double-count.
2. **Your usage history is kept.** opencode crawl data lives in OPFS on the `opencode.ai` origin, independent of the extension ID. After loading, open your opencode.ai Usage page and click **Crawl Now** to rebuild it.
3. **Your settings reset once.** This release pins a stable extension ID (`key`), which changes the storage namespace one time. Re-set: the peak-reminder toggle/model, workspace display names, enabled vendors, and default crawl vendor.
4. **Custom Rate Settings from 0.8.x are not carried over.** Costs fall back to the shipped price tables; edit them in **Settings → Pricing**. (The 0.8.x rates JSON is not importable by 1.0.0.)
5. **Local DB imports must be redone.** Records imported with `tools/import-local.mjs` are stored in extension storage (not opencode.ai) and do not survive the ID change — re-run the tool and **Import Usage** again.

### Added

- **Multi-vendor usage**: opencode, OpenRouter, DeepSeek, CommandCode, MiMo — separate pipelines, one dashboard. Enable per vendor in **Settings → Vendors**; each optional host is requested on first enable.
- **Unified pricing**: one user-authored price list for every vendor, keyed by `<source>:<model>`, with per-model rate groups and versioned rates. Recompute costs at any time.
- **Import Usage**: a single entry that accepts MiMo XLSX, opencode local JSON, vendor exports, and backups (multi-select a mix of types).
- **Settings → Database**: lists every usage store and where it lives (OPFS vs `chrome.storage.local`), with per-record and per-store deletion for extension-owned stores.
- **Export Backup**: one button, two disjoint files — `opencode-usage_settings_*.json` (settings + pricing) and `opencode-usage_records_*.csv` (every record, every source, with lossless `raw`). Import restores either.
- **Stable extension ID**: a `key` in the manifest pins the ID so the folder can be moved/re-cloned without losing data.
- Automatic per-vendor price presets and a price-watch workflow.

### Changed

- Cost source is per vendor: token-derived by default, or vendor-reported spend where trusted (OpenRouter, CommandCode).
- Records are canonical and immutable; costs are recomputed on render, so a corrected price retroactively fixes history.
- Dashboard settings are split into General / Vendors / Pricing / Database / How it works.
