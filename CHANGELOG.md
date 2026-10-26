# Changelog

## 1.6.0 — 2026-10-26

Backups are self-contained and restore sanely on another browser: the records CSV now carries the spend ledger, a two-file restore always reports both files, and opencode's first sync after a restore no longer re-scans its whole retention window. Export filenames are stamped to the minute.

### Added

- **The spend ledger rides in the records CSV.** `recordsToCSV` appends `kind="spend"` rows (`SPEND_COLUMNS`, after the unchanged 27 record columns), so a records-only restore still keeps what you paid; `csvToSpendEntries` reads them back and the dashboard merges by id into `spendEntries`. The settings JSON keeps carrying the ledger too, so either half restores the full picture and older CSVs (no spend rows) restore exactly as before.

### Changed

- **Backup filenames are stamped to the minute, in local time**: `opencode-usage_settings_2026-10-26_14-32.json` and `opencode-usage_records_2026-10-26_14-32.csv` (`exportStamp`). Two exports in one day no longer overwrite each other, and the name reads as the moment Export was clicked.

### Fixed

- **A restored backup now counts as known data for the next opencode sync.** The crawler's early-stop marker (`newestStoredTime`) read only the API store (`opencodeImportData`), while a restore routes every opencode row into the local store (`localImportData`) — so the first sync after moving to another browser logged `stopAt=(none, full scan)` and re-walked the whole ~30d retention window. The marker now spans both stores through `newestTime` (shared, tested), so an incremental sync stops at the newest restored record (minus the 1-day overlap). Records were never double-counted: the store is id-keyed. The export carries no fingerprint column by design — `fingerprintOf()` derives it from model + token counts + time bucket when deduping.
- **A two-file backup restore always reports both files, and a large records CSV no longer fails as one blob.** Records are sent to the background in 5,000-row batches (`chunkRecords`, pure + tested), so an oversized `import-local-data` payload can't take the whole restore down. The shared summary now survives a failed dashboard refresh, and a restore that adds nothing says "no new records" instead of looking like a no-op.

## 1.5.0 — 2026-10-24

This release keeps prices current after an update: the dashboard now detects a saved price list that fell behind the shipped one and refreshes it in one click. Price-watch adds MiniMax and resolves every stealth label it knows, and model-watch reads ids and names separately.

### Added

- **Stale price list detection with a one-click refresh.** The Pricing board saves the whole price list the first time it is touched (even the master toggle), so an update that improves `shared/unified.preset.json` never reached that user until they pressed "Reset to preset" — a step nothing told them about. `shared/preset-drift.js` (pure, tested) now compares the saved list with the shipped one against the user's own records: unpriced models the shipped list can price, plus models whose bill would change. When the gap is material (≥3 recoverable or ≥5 repriced models) the dashboard's unpriced notice offers **Update price list** directly — no Settings trip — naming what it fixes and how many self-priced models it would unprice, and keeps the replaced list in `unifiedPricingPrev` so the same notice can **Undo** it. The reset only swaps the price list; the unified-pricing on/off choice and every record are untouched.
- **Price-watch: MiniMax official (`minimax-official`)** — daily crawl of `platform.minimax.io/docs/pricing/overview.md` (the `/docs/guides/pricing-paygo` path 308-redirects there), committed to `extension/vendors/minimax-official/price-snapshots/`. Reads only the Standard tier (Priority is 1.5x `service_tier` and must not overwrite the list price), resolves `~~old~~ new` promos to the live price, and folds the `> 512k` row into MiniMax-M3's 512k tier. No cache-write column is published, so `cacheWrite` stays 0.
- **Every Space Bunny spelling prices as MiniMax M3.1 Flash.** MiniMax confirmed on 2026-10-19 that Space Bunny was M3.1 Flash under an anonymous label, and opencode renamed the listing to `minimax-m3.1-flash-free` (old id `space-bunny-free` deprecated). The reveal is declared once in `tools/model-aliases.json` as a vendor-neutral token, so `opencode:space-bunny`, `commandcode:stealth/space-bunny-alpha`, `openrouter:alpha-space-bunny-test` and any future spelling resolve to the official $0.15 / $0.60 / $0.015 group - never the third-party spacebunnymodel.com table removed in 7d73035.
- **Price-watch: TypeSafe Jev (`typesafe-official`)** — daily crawl of `docs.typesafe.ai/models.md` for Jev 1.13/1.14 pricing ($0.042/Mtok input, output free), committed to `extension/vendors/typesafe-official/price-snapshots/` and folded into the unified preset.
- **Price-watch: Z.ai official (`zai-official`)** — daily crawl of `docs.z.ai/guides/overview/pricing` (USD per 1M tokens), committed to `extension/vendors/zai-official/price-snapshots/`. It reads every 5-column `Model / Input / Cached Input / Cached Input Storage / Output` table and ignores the 2-column tool/image/agent ones, so one parser covers GLM-5.3, 4.x and the vision/OCR rows (19 priced models). "Cached Input Storage" is a storage promo, not a per-token write, so `cacheWrite` stays 0; `-`/`\` cells bill nothing and become 0; all-"Free" rows stay unpriced (a genuinely free model needs an authored 0/0/0/0 override, as with `big-pickle`). `PREFERRED_BY_SERIES.glm` now points here, so the hand-transcribed `OVERRIDE_RATES` block for GLM-5/5.1/5.2/5.3/5.3-Flash is gone — the parser reports the same numbers and adds the 14 models the overrides never covered.

### Changed

- **Stealth reveals are data, not per-vendor literals.** `tools/model-aliases.json` maps a lowercase token (`space-bunny`, `ox-alpha`, `x-preview-f`) to its real model; the builder unions that fingerprint with the canonical model's and emits an internal `alias:<token>` assign key, and `shared/unified.js` resolves an unassigned id whose text contains the token (longest match wins). The old `AUTHORED_FOLDS` stealth rows (opencode/OpenRouter ox-alpha and Space Bunny) are gone, so a new vendor reporting the same label needs no code change; alias keys are never shown as model chips or picker entries.
- **MiniMax-M3's hand-transcribed rate is gone**; the new parser owns it (identical numbers), so `PREFERRED_BY_SERIES.minimax` keeps the official table ahead of any resale row. M2.5/M2.7 stay hand-transcribed: the page has delisted them (they retire 2026-11-18), and dropping their price would leave historical usage unpriced.
- **CommandCode is watched again, now as a names-only catalog under the `warn` policy.** b8dd9c6 dropped it because a rotating catalog under the `block` policy left the daily run red with nothing to act on. It returns with `names: true`: `extension/vendors/commandcode/models.snapshot.json` keeps `{id, name}`, and `build-unified-preset.mjs` unions `fp(id)` with `fp(name)` **only when the name already has a price**. Routing ids that carry deployment noise therefore adopt the price of the model they name - `nvidia/nemotron-3-ultra-550b-a55b` ("Nemotron 3 Ultra", $0.63/M) now prices with no per-id entry - while an unpriced or delisted name can never invent one. A drop is reported, never blocked.

### Fixed

- **Price watch reads both OpenAI price tables again.** `pricing.md` split its Standard section into a short/long-context table (with 30m/12h cache-write columns) plus a plain Input/Output/Cached-input table, which the position-based parser read as 11 models and rejected as layout drift. Columns are now read by header name across both shapes; the 30m write column is the `cacheWrite` (12h is ignored — one cacheWrite per entry). Prices are unchanged; the 4 legacy rows OpenAI dropped (`babbage-002`, `davinci-002`, `gpt-3.5-turbo-1106`, `gpt-3.5-turbo-instruct`) are allowlisted in `tools/snapshot-shrink-allowlist.json`.

## 1.4.0 — 2026-10-18

Track what you actually paid alongside what the usage was worth. Settings → Spend is a manual USD ledger (platform + date + amount + note) with add/edit/delete, and the dashboard gains a Spend vs Value card (total spent vs usage Value with a value/spend ratio).

### Added

- **Settings → Spend ledger.** Manual USD entries per platform and date with add/edit/delete/clear-all, a month-by-month spend table, and a total / last-12-months / entries summary. Entries persist in `chrome.storage.local` (`spendEntries`), are normalized and validated on read, and ride along in the settings backup export/import.
- **Spend vs Value card.** Dashboard KPI showing total spent (date-filtered) against usage Value, with a `Nx` value-per-dollar ratio (`-` when nothing is spent).
- Pure ledger helpers in `shared/spend.js` (normalize/validate/aggregate/ROI, no chrome/DOM) covered by `tools/tests/spend.test.mjs`.

### Changed

- **Removed the Avg Cache Hit Rate KPI card.** Per-model hit rates still live in chart 5 (Cache Hit Rate by Model) and the workspace/model tables; only the summary card is gone. Its `maxHitRate`/`minHitRate` aggregate fields are removed with it.
- The Spend date picker reuses the filter bar's shared calendar grid instead of its own copy.

## 1.3.0 — 2026-10-14

Costs come from exactly two places now: the vendor-reported amount, or the unified price list. New vendor: Groq. We recommend leaving unified pricing on — vendor APIs keep changing or dropping fields, and one day a field we rely on may be gone.

### Added

- **`groq-official` crawl vendor** (opt-in under Settings → Vendors). Syncs the same `/platform/v1/organizations/{org}/activity` endpoint the Groq console Usage page uses (Stytch JWT + org header, orgs auto-discovered), one record per day × model × API key with vendor-reported USD cost. Keeps `unifiedPassthrough`: per-second audio billing (e.g. whisper `num_seconds_billed`) has no token-rate expression, so the vendor spend stays authoritative in both modes.
- **CI now reads the crawl artifacts.** A new test suite parses every committed price snapshot and model snapshot, recomputes each vendor's `rates.preset.json`/`rates.source.json` from its snapshots, and rejects any shrink that is not named in `tools/snapshot-shrink-allowlist.json` — these files previously passed CI without anything reading them.

### Changed

- **No more rate-table estimation.** A record bills its own `vendorCost` when the vendor reports one, and bills **0** when it does not. The author-maintained fallback tables no longer price anything at render time; they survive only as an input to the unified preset and as peak/off-peak window definitions.
- **Consequences:** with unified pricing off, `deepseek-official` and `mimo` (tokens only, no reported amount) and opencode records the Console sends `cost: null` for bill 0; their `savings` column is 0. With unified pricing on (the default) token vendors are unchanged — deepseek/mimo are priced from their official group.
- **Recommendation: keep unified pricing on.** Vendor-reported fields shift without notice (opencode already removed `usage/rows` and now sends `cost: null` for some rows); the unified list prices from the makers' published rates with daily watches, so history stays comparable even when a vendor stops sending a field.
- **Settings → Vendors** cost-basis line for a token-only vendor reads `cost 0 (no vendor cost)` instead of `cost estimated`.
- **A partial scrape is refused, not committed.** Both watchers now compare the freshly crawled model count against the committed one and abort the write when it drops, naming the ids that would disappear (`--allow-shrink`, or the workflow's `allow_shrink` input, accepts a real retirement). Previously only wholly empty payloads were rejected, so a truncated response could silently gut a snapshot.
- **The shrink policy is per source.** A count drop on a stable catalog (`commandcode`) still blocks the write, but `opencode`'s gateway catalog is regenerated per request and legitimately rotates, so a drop there is recorded and warned about instead of failing the daily run.
- **A failing source no longer blocks the healthy one.** `model-watch` and `price-watch` still fail red, but the sources that parsed are committed in the same run instead of being discarded with the failure.
- **The openai parser fails closed on a duplicate model id** instead of keeping whichever row it read last.
- **`rates.source.json` provenance is now enforced.** For parser-backed official vendors it is a generated mirror of the price snapshots; the daily job refuses to overwrite a file it would not itself have produced, so hand-editing one there no longer disappears silently.

## 1.2.0 — 2026-09-29

The dashboard no longer freezes on open, and a filter change no longer re-scans the whole history three times.

### Changed

- **Staged, observable load**: settings → storage read → parse → normalize → aggregate → charts, yielding between stages, behind a full-screen progress overlay. Countable stages show a real n/N; nothing fakes a percentage. Filter/table/chart interactions are gated until the first render lands.
- **One merge per open**: opening the dashboard no longer pre-builds and writes the merged snapshot (`handleOpenDashboard` stopped calling `sendDashboardData`), so the pipeline runs once instead of twice. `sendDashboardData` now only refreshes `cachedMeta`; the full `cachedData` snapshot is no longer written (the legacy key is kept, never deleted).
- **Charts update in place** (`chart.update("none")`) instead of destroy/recreate, and the yearly heatmap reuses its ~371 cells when the week layout is unchanged (measured 93% reuse), repainting only the cells whose shade moved. Chart animations on filter change are gone by design.
- **One full scan per render**: `aggregate()` now also emits the date-range-free `dailyAll`/`hourlyAll` maps the yearly heatmap consumes, and the unpriced-model set is memoized by a data version — the separate heatmap and unpriced scans are gone.
- **Decorative canvas pauses during load** and runs at ~30 fps steady state.
- **Popup status line** reads `Dashboard opened (N records)`; the always-false `cached`/`latest` qualifier is retired.

### Fixed

- Clicking the hourly view-toggle buttons before the first load no longer throws (the handler is gated behind the data-ready flag).

### Added

- `tools/tests/data-safety.test.mjs` — record stores survive imports (union preserved, repeat import idempotent, `cachedMeta`/`localImportMeta` kept, `cachedData` optional).
- `tools/bench/dashboard-load.mjs` + smoke test — deterministic load benchmark with median-of-N and a no-op pricer control.

## 1.1.2 — 2026-09-27

opencode removed `GET /console/api/usage/rows` (404), so the sync moves to the Console request log.

### Fixed

- **opencode data source**: `GET /console/api/request-logs?category=inference` (session cookie + `x-org-id`), `cursor` + `until` pagination, one record per succeeded inference request. Retention is ~30d, so a full sync covers the window instead of full history.
- **opencode mapper**: request-log schema (`startedAt` ms epoch, single `cacheWriteTokens` bucket, numeric `cost`, no `billingSource`); non-succeeded and non-inference rows are skipped. Rejected rows carry no tokens/cost and never reach the store.

## 1.1.1 — 2026-09-25

Official prices only: the unified list now takes every rate from the model maker's own published pricing, guarded by two daily watches.

### Added

- **model-watch**: a daily job diffs opencode and commandcode model-id snapshots and reports additions/removals in the job summary; the snapshot is committed only when it changes (tests run before the commit).
- **price-watch** covers six sources — DeepSeek, MiMo (official models API), xAI, OpenAI, Qwen and Tencent — each with its own fail-closed parser and committed price history.
- The unified price list ships **enabled by default**; the dashboard and Settings → Pricing toggles remain as opt-outs.

### Changed

- **Unified prices come only from official sources.** go.mdx resale prices drop out as a rate source; legacy go.mdx pricing survives only in the pre-unified path, reached when the unified list is switched off. 17 parser-less groups carry authored official overrides with citations.
- price-watch is fail-closed: any source failing fails the whole run (no commit). On an actual diff it rebuilds the unified preset, runs the test suite, and commits the regenerated preset together with the snapshot.

### Fixed

- Three wrong override rates corrected against first-party evidence: `o1-mini` ($1.1 / $4.4, the stale value was the 2024-09 launch price), `gemini-2.0-flash` ($0.1 / $0.4 / $0.025 — the old $0.15 / $0.6 never appeared on any Google page), and `laguna-s-2.1` (official $0.10 / $0.20 / $0.01 instead of an OpenRouter promo price).
- Removed the `gemini-2.5-flash-8b` override — that model id never existed; the rate was copied from Gemini 1.5 Flash-8B.
- `big-pickle` prices as free (all-zero) instead of unknown: an authored all-zero override now counts as a price.
- `nemotron-3-ultra` keeps a marked-provisional rate (NVIDIA publishes no per-token price yet), and its `-free` sibling is pinned to the same group and rate.

## 1.1.0 — 2026-09-20

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
