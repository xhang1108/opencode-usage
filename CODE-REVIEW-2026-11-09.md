# CODE REVIEW — opencode-usage

- **日期**: 2026-11-09 (UTC `Mon Nov 09 2026`)
- **版本**: `extension/manifest.json` `1.8.1`（審查時 `1.8.0`）
- **HEAD**: `cc013ea chore(price-watch): update vendor price snapshots`
- **範圍**: `extension/` (manifest, background, lib, shared, popup, dashboard, vendors×6 + price sources), `tools/` (`.mjs`/`.ps1`, tests, bench), `.github/` CI, `package.json`, `README.md`, `docs/` (gitignored)
- **方法**: 唯讀審查，未改任何程式檔。3 路平行深查 (core / vendors+pricing / tools+CI) + 主路自跑 `npm test` 與 `manifest.json`/`vendors.json`/`git log` 核驗。
- **測試實況 (自跑, win32, Node `v24.19.0`)**: `npm test` → `tests 451, pass 450, fail 0, skipped 1, duration ~4034ms`。無 `eval`/`new Function`/`document.write`。`git status --short` 乾淨。

> **覆核更新 (2026-11-09, 修復後)**: 本報告已逐條對照 HEAD `cc013ea` 覆核並修復可確認的問題。`npm test` 現為 **461 tests / 460 pass / 0 fail / 1 skipped**，`node tools/build-manifest.mjs --check` 與 `node tools/build-unified-preset.mjs --check` 皆通過。C1 經查為文件化設計 (非 bug)；其餘誤判與未修項目見 §12。

## 總 verdict

功能面健康度尚可，自動化測試覆蓋高；風險集中在 **金額正確性 (unified 覆蓋 vendor 權威金額, $0/×1e8 錯)**、**安全邊界 (儲存型 XSS, onMessage 無 sender 驗證)**、以及 **工具鏈 fail-open**。`DeepSeek` 當天永遠漏爬、`CommandCode` 增量聲明與實作不符、`zip`/`xlsx` 無上限、`background.js` 1412 行過大為明確可修問題。優先修 P0 6 點即可處理大半風險。

## Severity 一覽

| Severity | 組件 | 筆數 | 代表問題 |
|----------|------|------|----------|
| Critical | vendors/pricing | 5 | unified 覆蓋 vendor 金額致 $0; `costScale=0` 除法; DeepSeek 漏今天; crawl/import 雙計; CommandCode 整批中斷 |
| Critical | extension 安全 | 2 | dashboard 儲存型 XSS; `background onMessage` 無 sender 驗證可刪改紀錄 |
| High | extension 核心 | 5 | Prototype pollution (`__proto__`); Zip/XLSX bomb 無大小上限; `tabs` 權限缺+update open-redirect; WAR 過寬+無 CSP; 備份含 `raw` |
| High | vendors crawl | 5 | opencode/OpenRouter/CommandCode/DeepSeek/Groq 重試/分頁/逾時缺口 |
| High | tools/CI | 3 | `extract-preset` path traversal; `price-watch` 無 timeout; `build-unified-preset` 先寫後驗 fail-open |

---

## 1. Critical — 金額 / 雙計 / 資料遺失 (vendors)

### C1. Unified 預設 ON 覆掉 vendor 權威金額, unmapped 直接 $0
- **證據**: `shared/unified.js:59` (`enabled: src.enabled !== false`, 預設 true); `dashboard/dashboard.js:87-91` (enabled 時走 `priceUnified`, passthrough 才走 `priceVendorCost`); `shared/unified.js:176` (找不到 group 回 `{cost:0, unpriced:true}`); `dashboard/core/pricing-config.js` 計價分流。
- **影響**: OpenRouter `vendorCost=total_usage` (USD)、opencode `vendorCost/costScale=1e8`、CommandCode `totalCost` 在 unified 開時全被 `token×rate` 估計取代; `priceUnified` unpriced 回 $0, 明明 vendor 有金額卻顯示 0。
- **Fix**: vendor-cost 優先 fallback — `priceUnified` unpriced 時回退 `priceVendorCost`; 或只在 `vendorCost==null` 時用 rate 表。Groq 已用 `unifiedPassthrough` (`shared/vendors.json:47-48`), 建議 opencode/OpenRouter/CommandCode 同理改「有 vendorCost 優先」。

### C2. `costScale=0` 除法災難 + opencode 單位未定
- **證據**: `dashboard/core/pricing-config.js:46` (`cost = vendorCost / (costScale||1)`); `vendors/opencode/mapper.js:74-75` (`costScale:1e8`, 註解自承 unit to be pinned); `shared/backup.js` `RECORD_COLUMNS` 含 `costScale`。
- **影響**: CSV/手動紀錄若 `costScale=0` → `||1` 變 USD 全額計 (差 8 個數量級); opencode 若實際單位非 `1e8`, 全歷史金額系統性乘錯。
- **Fix**: `costScale<=0` 當 unpriced 而非 `/1`; 用一筆付費樣本實測重定 `1e8` 並寫進 `vendor.json` notes。

### C3. DeepSeek 當天永遠漏爬
- **證據**: `vendors/deepseek-official/content.js:114-115` (`endSec = dayStart(nowSec)`, 今天 +08 午夜 exclusive)。
- **影響**: 使用者今天用量永遠不入庫; 若有 ~1 天延遲, UI 也無標示。
- **Fix**: `endSec = dayStart(nowSec)+DAY` (含今天) 或 `nowSec`; UI 標延遲。

### C4. Vendor crawl 只有 id 去重, 日聚合 vs 小時切片雙計
- **證據**: `background.js:336-359` `handleVendorCrawlData` 純 `map[id]=rec`; DeepSeek crawl id `model|timeSec` (`vendors/deepseek-official/mapper.js:92`) vs import id `user|day|model|key` (`vendors/deepseek-official/import-amount.js:74`); `shared/merge.js:120-142` `hideDayAnchoredImportCopies` 需 fingerprint 精確相等才隱藏 (日總和不會等於任一小時)。
- **影響**: 同一用量 crawl + import / 舊備份還原並存, 總量加倍。
- **Fix**: vendor store 匯入時加 fingerprint (`recordFingerprints`) 比對; 或還原時先 `clear-vendor-data` 再還原。

### C5. CommandCode 增量無效、單日失敗整批中斷
- **證據**: `vendors/commandcode/content.js:53-67` probe 忽略 `since`, 回傳所有 retention 天數; `:75` per-day `await fetchCharts` 無 try 直接 abort; `:67` `slice(-3660)` 無聲截斷。
- **影響**: 每日同步重抓全部; 任一日失敗整批丟失; 截斷無提示。
- **Fix**: per-day 包 try 記 `failures` 繼續; `days` 過濾 `>=sinceDay-1` 才逐日抓。

---

## 2. Critical — 擴充套件安全 (extension)

### S1. Stored XSS — dashboard privileged page
- **證據**: `dashboard/views/time-reminder.js:67` (`innerHTML = models.map(m => \` <option value="${m}">${m}</option>\`)` 未 `escHTML`, `m` 來自 `listPeakModels(getRateModels())` = unified pricing / backup 導入可控); `dashboard/settings/general.js:34-39` (`<option value="${v.source}">` 未逃逸); `dashboard/settings/how-it-works.js:215-231,245` (`s.title`/`h`/`c` 拼入 `pane.innerHTML` 未逃逸, `v.label` 來自 registry storage); `dashboard/settings/how-it-works.js:184` 自製 `escHTML` 僅逃 `&<>` (缺 `" '`), 與 `dashboard/views/format.js:9` 雙份不一致。
- **影響**: malicious backup / pricing 匯入 → dashboard 任意 JS → 可讀 `chrome.storage.local` 全部用量 + 偽造維護提示。MV3 預設 CSP 下 `innerHTML`  injection 仍有效 (非 `script-src`)。
- **Fix**: 全改 `textContent`/`createElement` 或共用同一 `escHTML()` (建議只留 `format.js` 版本); 屬性值一律 `"`/`'` 逃逸; 顯式 `content_security_policy: {extension_pages: "script-src 'self'; object-src 'self'"}`。

### S2. `background.js onMessage` 零 sender 驗證 → 資料投毒/刪除
- **證據**: `background.js:32` `onMessage` 直接 dispatch `vendor-crawl-data`/`clear-vendor-data`/`remove-records`/`import-local-data`/`get-database` (`:86/:118/:125/:147/:156`), 不驗 `sender.tab.url`/`sender.id`。
- **影響**: 任何 content-script (或被 WAR 洩漏的 `vendors/opencode/mapper.js`、`vendors/*` 被頁面 `import()` 後) 可偽造/清空紀錄。`remove/clear/import` 無復核。
- **Fix**: handlers 內驗 `sender.tab.url` 屬於對應 `origins` + `msg.source` allowlist; `remove/clear/import` 只接受 `sender.url` 為 extension page (`chrome.runtime.getURL` 前綴)。

---

## 3. High — 核心加固

### H1. Prototype pollution — `__proto__` id
- **證據**: `shared/migrate.js:63-64` (`out[id] = rec`, `healRecordMap`), `dashboard/dashboard.js:491-493` (`globalCache[id] = ...`), `shared/backup.js:148-165` 直接賦值; 對照 `background.js:749-757` `putRecord`/`592-621` 有 `defineProperty` 防護, 三處不一致。`JSON.parse` 的 `{"__proto__":…}` 可污染原型。
- **Fix**: 抽共用 `putRecord()` (`Object.defineProperty` for `__proto__`), migrate/dashboard/backup 全改用; 更佳: 全部 map 用 `Object.create(null)`。

### H2. Zip/XLSX bomb + 未限大小匯入 → OOM / UI 阻塞
- **證據**: `shared/zip.js:7-53` (`unzip`/`inflateRaw` 無大小上限, 無 CRC/Message Size 上限); `shared/xlsx.js:40-70` 正則 `matchAll` 解析整份 worksheet XML; `dashboard/dashboard.js:539,576,689,723` `file.text()`/`arrayBuffer()` 無大小檢查即 `parseXlsx`/`unzipText`, 主線程同步阻塞。
- **影響**: 惡意/誤選大檔 → tab 凍結/OOM。`Zip64` 不支援、CRC 不驗、method 僅 0/8 (`shared/zip.js:19-37`)。
- **Fix**: 匯入前查 `file.size` (e.g. 20MB 上限)、`compSize`/`inflated` 上限、entries 數量; XLSX sheet 解析分塊 + `scheduler.yield`; 失敗回滾。

### H3. 權限/來源未嚴格 + update open-redirect
- **證據**: `manifest.json:7-17` `unlimitedStorage` 未見必要性; `host_permissions` 僅 `api.github.com/*` + `opencode.ai/*`, 但 `background.js:236,296,1143,1306` 用 `tabs.query/get/create/update/remove` 而 `permissions` 缺 `tabs` → `tab.url` 不可見 (MV3 行為); `background.js:1243-1257` `release.html_url` 原存 storage, `popup/popup.js:97` 直接 `$("#update-link").href = updateInfo.releaseUrl` 未驗 `https://github.com/`; `popup/popup.html:92,104` `target="_blank"` 僅 `rel="noopener"` 缺 `noreferrer`。
- **Fix**: `href` 前驗 `new URL(...).protocol==='https:' && host==='github.com'`, 否則用固定 releases URL; `target=_blank` 加 `noreferrer`; 評估 `unlimitedStorage` 保留與否, 補 `tabs` 權限說明。

### H4. MV3 `web_accessible_resources` 過寬 + 缺 CSP
- **證據**: `manifest.json:22-71` 5 組 WAR 對 `https://*.deepseek.com/*`、`https://openrouter.ai/*` 暴露 `mapper.js` + `shared/canonical.js` (頁面可直接 `import()` 取得內部 mapping/去重邏輯); `manifest.json:105` 無 `content_security_policy` (靠預設, `dashboard/dashboard.html:8` `<script src="../lib/chart.umd.min.js">` + 大量 inline `<style>` 合法但未顯式收緊)。
- **Fix**: WAR 改 `use_dynamic_url: true` 或縮 `matches` 至僅需 `origins`; 顯式聲明 `content_security_policy`。

### H5. 計價備份含 `raw` 外洩面
- **證據**: `shared/backup.js:56-60,84` `RECORD_COLUMNS` 含 `raw` (vendor 原始 JSON) 並寫入 CSV/zip; `vendors/deepseek-official/content.js:40-49,62-70` 讀 `localStorage.userToken` Bearer 並附 header (不洩漏至 storage, 但提醒使用者匯出檔含 `raw`)。
- **Fix**: 匯出 UI 加提示「含 raw 原始主機資料, 不可公開上傳」; `raw` 匯出改預設關閉選項。

---

## 4. High — Vendor crawl 分頁/重試/總逾時

- **opencode (`vendors/opencode/api.js`)**: `:101` 只重試 429/503, network throw 直接冒泡 (`:94-97`); `409 RequestLogCursorRestartRequired` 無「清 cursor 重啟」分支; `MAX_PAGES=10000` (`:27,147`) 到頂直接 return 成功; `DELAY_MS=0` (`:29`)。*Fix*: network/5xx/409 皆重試; 到 `MAX_PAGES` 報 warning 非 done。
- **OpenRouter (`vendors/openrouter/content.js`)**: `:35-50` `fetchWindow` 一次失敗整批 abort; `:85-92` `span<=1d` 時 truncated 直接採用; `analytics-query.js:26` `limit=1000` 無 truncated 即遺失。*Fix*: 加 429/5xx 退避; span=1d 仍 truncated 按小時再切, 失敗報錯非靜默。
- **CommandCode probe (`vendors/commandcode/content.js:38-45`)**: `fetchCharts` 無退避, `res.json()` 在 WAF HTML 會 throw; `:63-66` 任何錯誤都降級成 400d 視窗 (401/403 認證失敗也走此路, 白耗一次請求才失敗)。*Fix*: 401/403 直接報「未登入」; 僅 range 錯誤才降級; fetch 加 429 退避。
- **DeepSeek (`vendors/deepseek-official/content.js`)**: `:27` `DELAY_MS=900`; `:131-149` scan + `:156-187` 每日 2 calls; `:188-190` 任一失敗即 throw (已存資料保留, 但使用者看見失敗誤以為全失), ~742 次請求無總逾時/取消。*Fix*: 回 `{partial:true, okCount, failures}` 而非 throw; 加總逾時/取消。
- **Groq (`vendors/groq-official/content.js:89-137`)**: `for(;;)` + `attempt++` 後置計數混雜; `:122-125` 429 同 5xx 無 `Retry-After`; `mapper.js:39-41` `rowKey=timestamp|model|api_key_id|project_id` 未含 org, `mapper.js:69` `workspaceID=organization_name` (改名即分裂)。*Fix*: `rowKey` 加 `organization_id`; `workspaceID` 用 org id、label 另存。

---

## 5. Medium — Pricing / Peak / 去重 / 認證

- **Peak 窗口一律 UTC, 無 tz 欄位** (`shared/pricing.js:116-137` `getWindow` 用 `getUTCDay/Hours`; `aggregate.js:66,98,133` 顯示用 `localDateOf`/local hour; `time-reminder.js:88-106` UTC vs `:128-137` timeline 本地取樣)。DeepSeek 官方窗為 UTC (`pricing-page.js:62` 註解 `01:00-04:00 ... UTC`) 讀取正確, 但 rate schema 無 tz, 未來任何 +08 窗整體錯 8h; 同一筆 DeepSeek 小時紀錄在 aggregator 本地日與 pricing UTC 窗交界跨日錯桶。*Fix*: rate version 加 `tz` (預設 UTC), aggregate 小時分布改 UTC 或標 DST 邊界。
- **Vendor-cost 的 peak 分桶永遠 flat** (`pricing-config.js:19-30` `vendorWindow` 需 `pricing.targets` 命中; OpenRouter/CommandCode/Groq 無 `rates.preset.json`, `loadPricing` `dashboard/settings/store.js:135-141` 僅載入 registry 6 家 → 永遠 flat, 與 unified 窗口不一致)。*Fix*: vendor-window 也查 `unified.preset.json` group 窗口。
- **Tier 只算 input+cacheRead, savings 可負** (`pricing.js:145-146` `context=input+cacheRead` 不含 output/reasoning; `:168` savings 未 clamp; 四家 adapter 一律 `cacheWrite5m=單桶,1h=0`: opencode `mapper.js:72-73`, openrouter `:89-90` 為 0)。*Fix*: tier context 與官方定義對齊 (通常含 output); `savings=max(0,…)`; 單桶標 `cacheWrite` generic 而非 5m。
- **Fingerprint/預設漸進污染 (Fail-Open)** (`model-fingerprint.js:9-14` variant 僅 8 詞、series 只取首字母段; `unified.js:99-105` fp→alias 階梯、alias substring 包含, token 越短越易誤命中; `tools/build-unified-preset.mjs:236-237` 無官方 SKU 照付費價、`:144` nemotron 用站外 $0.63/$3.13 自標 PROVISIONAL)。*Fix*: alias token 要求完整詞邊界; override 須附官方 URL 且經 `price-watch` 複查。

---

## 6. Medium — 健壯性 (CSV/XLSX/備份/併發)

- **CSV** (`shared/csv.js:26-28` 欄位中 `"` 開關引號, 未閉引號吞檔尾; `rowsToObjects :50-62` 重複 header 後蓋前、超多格靜默丟、空白列僅擋單空字)。*Fix*: 未閉引號報錯並回報行號; 重複 header 去重加後綴; 對 `^[=+\-@]` 首字元列加 `'` 防 Excel 公式注入 (現行 `toCSV :66-70` 僅加引號, 仍可執行 `=cmd`)。
- **XLSX** (`xlsx.js:47-49` 要求 `r="A1"`, 缺 ref 即丟格; `:51-53` sharedStrings 越界回 `""`; 正則 XML 對命名空間/大寫 tag 脆弱; `zip.js:19-37` 無 Zip64、CRC 不驗、method 僅 0/8)。*Fix*: 驗 CRC、超大 xlsx 報錯非靜默空行。
- **MiMo 匯入靜默補零** (`vendors/mimo/import-usage.js:69-78` 找不到欄位回 -1, `num(row[-1])→0`; `:18-21` `NaN→0`; `:89` 多列同 `date|model|key|plan` 後蓋前; `:25` Excel serial 用 `Math.round` 小數時間進位到隔天; `mimoDateToISO :31-40` 不驗月/日範圍)。*Fix*: 缺欄即報錯、序列用 `floor`、id 含 sheet/行號、負數/非法數拒絕。
- **備份還原** (`backup.js:173-180` `csvToRecords` 壞列靜默跳過、無計數; `dashboard.js:618-626` 零筆才報錯; `:689-720` zip 內任意 `.csv` 都當備份吃; `spend.js:19-23` spend id hash 相同值碰撞還原合併暫蓋)。*Fix*: 回報 skipped 數; zip 只認 `opencode-usage_records_*.csv`; spend id 加隨機後綴。
- **內容整理**: DeepSeek `import-amount.js` 已被 `vendor.json` 註記「移除」但仍 shipping + 有測試 (`tools/tests/deepseek-import.test.mjs`), 易誤用致雙計; CommandCode `mapUsage/mapUsages` (`mapper.js:28-85`) 生產路徑未用 (僅測試); opencode `latestCreatedAt` 僅測試用。*Fix*: 標 deprecated 或下架, 避免 builder 誤接。
- **效能/競態**: `background.js:659-698` `writeBaseMap` read-modify-write 無鎖, 雙 tab 同步/還原 chunk 並發可遺失; `dashboard.js:636-654` 每 5000 筆 chunks 各做全量 `readBaseMap+writeBaseMap`, 大備份 O(n²)。*Fix*: background 加 per-source mutex; 還原改一次讀一次寫。
- **Dashboard 傳輸**: `background.js:1077-1131` transfer map 最多 4 份、SW 重啟即失效, dashboard 端有重起上限 2 次 (`dashboard.js:455-471`), 弱網下易超過。*Fix*: `count/total` 來自 snapshot 時也回 `generatedAt`, 逾時直接重建 snapshot。

---

## 7. Medium — 工具鏈 (`tools/` + CI)

- **H: `extract-preset.mjs:25-28` path traversal + import 即寫檔** — `resolve(root, extension/vendors/${sourceName}/...)`, `--source ../../x` 可穿越; 頂層 `await import`+`writeFileSync` 使 import 有 side effect。*Fix*: `VENDORS`/目錄 allowlist 驗 `sourceName`, 函數化 + `invokedDirectly` 守衛。
- **H: `price-watch.mjs:41` `fetch(url)` 無 timeout/size 限制** — 對比 `model-watch.mjs:115-126` 30s、`probe-vendors.mjs:34-50` 20s, vendor hang 拖住 runner; 大頁面無上限。*Fix*: `AbortController`, 30s timeout, `content-length`/bytes 後擋。
- **H: `build-unified-preset.mjs:575-583` fail-open** — `writeFileSync` 在 `disagreements` 檢查前; 衝突仍寫 `unified.preset.json` 並 `exitCode=1`, 但 CI 照 commit。*Fix*: 先算 disagreement 再寫; 或有 disagreement 時不寫/刪檔。
- **M: `model-watch.yml:16` missing `allow_shrink` input** — `model-watch.mjs:150-151` 錯誤訊息叫 dispatch `allow_shrink=true`, 但 workflow 無 inputs, operator 無法在 UI override。*Fix*: 照 `price-watch.yml:10-14` 加 `workflow_dispatch.inputs.allow_shrink` 並透傳。
- **M: `model-watch.yml:36-40` snapshot 未驗即 commit** — 先 `npm test` 再 diff, 但新 snapshot 不重跑 test (`price-watch.yml:54-57` 有 rebuild+test)。*Fix*: watch 後加 `npm test` fail-closed。
- **M: `price-watch-backfill.mjs:33-52` fetch 無 timeout + Wayback 無 rate-limit** — `cdxTimestamps`/`fetchArchived` 裸 `fetch`, `withRetry` 4 次 hammer archive.org; `ts` 未驗格式。*Fix*: timeout, `ts` 正則 `^\d{14}$`, 429 backoff/jitter。
- **M: `tools/opencode/*.ps1` 0 測試且不在 CI** — `fetch_diffs.ps1:47,70` `gh api "...&since=$cursor..."`/`".../$s"` 未編碼插值; `$ErrorActionPreference` 未設, `LASTEXITCODE` 非全面; `postprocess.ps1:6-10` `parts[2..4]` 欄數不足靜默 null, `Set-Content` 編碼預設。*Fix*: 參數驗證, `$ErrorActionPreference='Stop'`, 明確 `UTF8`, Pester 或改 Node 重寫。
- **M: `build-opencode-preset.mjs:72-78` `parsePrice` 脏值回 0** — 非數字靜默變免費, 與 fail-closed 矛盾。*Fix*: 不可解析 throw。
- **M: `verify-cost-gap.mjs:28` `ROOT=process.cwd()`** — 非 repo 根執行即讀錯 `extension/...`。*Fix*: 仿其他工具用 `fileURLToPath(import.meta.url)`。
- **M: `package.json:6-12` `price-sync` 不可攜 + 無 engines** — `pwsh` `&&` 鏈在 `sh`/`cmd`/`pwsh` 語意分歧, `Bypass`; `import-local.mjs:17` 要 Node `>=22.5`, 但 CI `setup-node:22` 浮動、無 `engines`。*Fix*: 加 `engines:{node:">=22.5"}`, `price-sync` 改單一 `pwsh -File` orchestrator + `Stop`。
- **M: `price-watch-lib.mjs:201-205` `snapshotsDir` 讀取即 `mkdir`** — `list/load` 副作用建立目錄, 污染 git/快照比較。*Fix*: 僅 `writeSnapshot` 才 `mkdir`。
- **M: `price-watch-lib.mjs:115-117` snapshot 檔名秒級碰撞** — `toISOString()` 毫秒被 strip, 兩次同秒 run 覆寫。*Fix*: 保留 ms 或覆寫偵測。
- **M: `model-watch.mjs:160-161,93-94` 未知 source TypeError** / **`price-watch.mjs:66-67,238-240` `--source` 缺值/未知僅 crash** (三個 CLI 同病, 含 `price-watch-backfill:55-64`)。*Fix*: `watchOne` 開頭 `if(!SOURCES[source]) throw unknown source`; 缺值 usage + `exit 2`。
- **M: 脆弱測試** — `preset-sync.test.mjs:36-42` 斷言 exact merge-note 字串, 合法資料變更即紅 (*Fix*: 斷言行為: group 數量、flags 集合包含性); `time-reminder-view.test.mjs:95-102` `setTimeout 30ms` 高負載 flaky (*Fix*: fake clock/`tick`)。
- **Low**: `probe-vendors.mjs:45,67,101` snippet 日誌可洩漏敏感內容 (僅印 shape/status, 或過濾); `price-watch-lib.mjs:213-215` `loadParser` 動態 `import` 任意 vendor JS (PR 改 `pricing-page.js` 即在 CI 寫權限執行 — CODEOWNERS + 受控路徑 allowlist); `import-local.mjs:139`/`verify-cost-gap.mjs:75` 任意路徑讀寫 (README 警告 + 拒絕覆寫未核准目標); `package.json` 0 lint/type (無 `eslint`/`prettier`/`tsconfig`, CI 無 `node --check` *Fix*: `npm run lint` + CI `node --check tools/*.mjs` + `actionlint`); CI hardening (`ci.yml` 無 `timeout-minutes`/`permissions:`/concurrency, `actions/checkout@v4`/`softprops@v2` 用 mutable tag 非 SHA, `release.yml` 無 test/lint 前置、無校驗和/attestation、`zip` 未排 `.env*` — 最小 `permissions: contents:read`, SHA pin, `timeout-minutes:10`, release 前 `npm test`, 產 `sha256`); `docs/` gitignored 且空 (`.gitignore:16`, 若 private 應在 README 說明, 否則移除 ignore 並追蹤)。

---

## 8. Low — 可維護性 / 效能

- **Storage fire-and-forget** (`background.js:38-53,64-72` callback 無 await; `popup/popup.js:176` `loadStatus()` 不 await/catch; `:300` 無 `.catch`; `time-reminder.js:91` 同; `popup.js:267-279` `storage.onChanged` 高頻 `loadStatus()` 交錯渲染)。*Fix*: 統一 `await … .catch()` + `loadStatus` 單例 `inflight` 防重入。
- **固定 `sleep(300)` + 輪詢** (`background.js:226,308` 注入後 `sleep(300)`; `:241-248`, `1316-1321` `30×500ms` 輪詢 `tabs.get`; `vendors/opencode/api.js:65` `setInterval(trackVisited,1000)` 永不清除 + `:67-70` monkey-patch `pushState/replaceState` 不還原)。*Fix*: 改事件驅動 (`background.js:196-217` `waitForTabComplete` 重用); `trackVisited` 改 `visibilitychange` + 節流 5s 去重寫入。
- **大資料記憶體/重算** (`dashboard.js:445-482` `chunks.push` + `JSON.parse(chunks.join(""))` 3× 記憶體; `background.js:1080-1129` `snapshot.json.slice` 每 chunk 複製 O(n²); `:1056-1071` 每次 `get-dashboard-data` 都 `buildMergedSnapshot()+JSON.stringify()` 全量重算)。*Fix*: `TextEncoder` 流式解碼、共用 chunk 上限、快取 snapshot 以 `storage.onChanged` 失效。
- **Spread 大物件** (`dashboard.js:226` `Math.min(...Object.values(firstSeen))` 數萬 model 會 `Maximum call stack`; `background.js:331-333` 序列 `await` 雙 store)。*Fix*: loop 取 min/max; `Promise.all`。
- **刪改 UX + CSV 公式注入** (全域 `alert/confirm` `dashboard.js:569`, `popup.js:207`, `vendors.js:53,74`, `database.js:105,162`; `shared/csv.js:66-70` 前述)。
- **效能 tick 過勤** (`popup.js:319`, `time-reminder.js:111` 每秒 `renderTimeReminder` 重建 24 個 `.seg` `innerHTML`; `decor.js:110-233` 30fps 全屏 canvas + `shadowBlur`; `background.js:541-547` popup 每次開都 `get-status` 全合併)。*Fix*: 倒數只更新 text、timeline 每分鐘重建; decor `fps:15` / `prefers-reduced-motion` 關閉; popup 用 `cachedMeta` 快取。
- **重複 code / 大檔** (`background.js` 1412 行 badge/crawl/shard/migration/alarm/update/registry 混置; `dashboard/dashboard.html` 989 行 `<style>` ~650 行; `dashboard/dashboard.js` 785 行; `shared/unified.preset.json` 3928 行; `shared/pricing.js` 280 行; 重複 `escHTML` ×2, `mergeRecords` `background.js:759` vs `shared/merge.js:76`, `fpCache`/`priceCache` 分散)。*Fix*: 拆 `crawl/*.js, storage/shard.js, alarms.js`; `<style>` 抽 `theme.css`; `escHTML` 只留 `format.js`。
- **命名/常數漂移** (`shared/stores.js:11` `LOCAL_STORE_KEY="local"` vs 實際 key `localImportData` 字串分散於 `background.js`; `TIME_*` 魔法字串; `canonical.normalizeRecord` vs `background.normalizeLocalRecord` 易混)。*Fix*: centralize `STORAGE_KEYS` (`dashboard/settings/store.js:12-24` 已有, 全專案共用); 改名 `normalizeLocalRecord → applyLocalWorkspace`。
- **MV3 alarm/SW 啟動重複排程** (`background.js:1217,1272,1333,1519-1523` 頂層直接 `schedule*`, SW 冷啟動重複 `alarms.create` 含 `periodInMinutes:360`; `chrome.alarms.onAlarm` 註冊 3 次 `L1201/1268/1330`)。*Fix*: 只在 `onInstalled/onStartup` 排程, 頂層只註冊 listener; `scheduleUpdateCheck` 改 `when` 單次 + 完成後重排。
- **檔案/儲存未釋放** (`dashboard/views/format.js:45-63` `URL.createObjectURL` 後 `a.click()` 立即 `revokeObjectURL` 部分瀏覽器下載被中斷; `popup.js:190-194` keydown/keyup 不移除)。*Fix*: `revokeObjectURL` 延至 `setTimeout 1000`; popup 在 `pagehide` 清理。

---

## 9. 做得對的 (保留)

- `tools/import-local.mjs` `readOnly:true`; `probe` Bearer 僅 env 注入不印 key; `assertNotSuspiciousShrink`/`snapshot-integrity` shrink allowlist; `build-manifest --check`; `price-watch` fixed `git add` 路徑 + concurrency; `bench` 固定 seed。
- Crawl 時間窗口切片設計正確 (OpenRouter `sliceRange` 連續無重疊; DeepSeek 兩階段 probe→hourly; Groq JWT 輪替等待機制完整; opencode 游標+until 規格正確)。
- 無 `eval`/`new Function`/`document.write`; `content_scripts` 僅 opencode 靜態注入, 其餘 vendor 靠 `chrome.scripting.registerContentScripts` 動態註冊 (`background.js:1361-1408`), 符合最小權限。
- 測試 450/451 通過, vendor mapper/unified 計價/peak/時間分組 docs 細緻。

---

## 10. 修復路線 (P0 → P2) + Lane 所有權

> 大計劃以檔案所有權切 lane, 並行 subagent, 避免同檔競寫。優先序 = 風險/嚴重度, 非實作順序。

### P0 (Critical/High 金額+安全+fail-open)
1. **金額正確性 lane** (`shared/unified.js`, `dashboard/core/pricing-config.js`, `shared/vendors.json`) — C1+C2: vendor-cost 優先 fallback, `costScale<=0` unpriced, 實測 `1e8`。
2. **OWASP lane** (`dashboard/views/time-reminder.js`, `dashboard/settings/general.js`, `dashboard/settings/how-it-works.js`, `dashboard/views/format.js`, `background.js`, `manifest.json`) — S1+S2+H3+H4: 共用 `escHTML`, `onMessage` sender 驗證, CSP/WAR 收緊, `tabs` 權限, update URL 白名單。
3. **Crawl 正確性 lane** (`vendors/deepseek-official/content.js`, `vendors/commandcode/content.js`, `vendors/openrouter/content.js`, `vendors/opencode/api.js`, `vendors/groq-official/*`, `shared/merge.js`, `background.js`) — C3+C4+C5 + §4: 當天補齊, 增量過濾, per-day try+partial, fingerprint 去重, 重試/409/截斷聲明。
4. **匯入健壯性 lane** (`shared/zip.js`, `shared/xlsx.js`, `shared/csv.js`, `shared/migrate.js`, `shared/backup.js`, `dashboard/dashboard.js`) — H1+H2+§6: 共用 `putRecord`, 大小上限, 缺欄報錯, skipped 計數, 公式注入。
5. **工具 fail-open lane** (`tools/extract-preset.mjs`, `tools/price-watch.mjs`, `tools/build-unified-preset.mjs`, `tools/model-watch.mjs`, `tools/price-watch-backfill.mjs`, `tools/*.ps1`, `.github/workflows/*`) — §7: allowlist, timeout, 先驗後寫, `allow_shrink` input, CRC/CI hardening。

### P1 (Medium 功能/併發)
6. **Pricing 語意 lane** (`shared/pricing.js`, `shared/model-fingerprint.js`, `tools/build-unified-preset.mjs`, `tools/model-aliases.json`) — tz 欄, tier/savings clamp, alias 詞邊界, PROVISIONAL 複查。
7. **認證收緊 lane** (`vendors/deepseek-official/content.js` origins 收至 `platform.deepseek.com/*`, Groq JWT 截斷守衛)。
8. **背景併發 lane** (`background.js` `writeBaseMap` mutex, `dashboard.js` 還原一次讀寫, `dashboard-transfer.js`)。

### P2 (Low 維護)
9. **拆分 lane** (`background.js` → `crawl/*.js`, `storage/shard.js`, `alarms.js`; `dashboard.html` `<style>` → `theme.css`; `STORAGE_KEYS` centralize)。
10. **Perf lane** (每秒 tick → 分鐘級, decor fps, cachedMeta)。

---

## 11. 驗證 (可重跑)

```powershell
cd D:\Antigravity\opencode-usage
npm test                 # 修復後: 456 tests, 455 pass, 1 skipped
node tools/build-manifest.mjs --check
```

- 瀏覽器: `chrome://extensions` → Load unpacked `extension/` → Dashboard 導入惡意 backup 觀察 XSS 是否已填 `textContent`; `Sync` DeepSeek 確認當天有資料; Share CSV 檢查 `=cmd` 是否被加 `'`。
- CI: `gh run list --limit 20`; `price-watch`/`model-watch` workflow_dispatch 需 `allow_shrink` input 可點。

---

*報告產出: `D:/Antigravity/opencode-usage/CODE-REVIEW-2026-11-09.md`。原審查為唯讀；本次覆核已依 §12 修改程式碼。*

---

## 12. 覆核與修復記錄 (2026-11-09 執行)

> 本節由覆核者追加。原 §1–§11 保留為審查當時的快照；實際狀態以此節為準。

### 12.1 判定摘要

| 判定 | 筆數 | 說明 |
|------|------|------|
| 已修復 | 13 組 | 金額防護、XSS、sender 驗證、zip bomb、URL 白名單、CSP/WAR、工具 fail-open |
| 誤判 / 設計如此 | 4 | C1、`tabs` 權限、CommandCode `since`、snapshot 檔名 |
| 未修 (需設計決策/重構) | 8 類 | C4 去重、XLSX 串流、CSV 嚴格模式、MiMo 補零、background 拆分、alarms、perf、CI/PS1 |

### 12.2 已修復 (含檔案)

1. **C2 `costScale<=0`** — `extension/dashboard/core/pricing-config.js`：`costScale` 存在但非正/非有限時回 `unpriced` + `priceBasis:"invalid-scale"`，不再 `/1` 把 1e8 原始值當 USD。新增測試。
2. **C3 DeepSeek 漏今天** — `vendors/deepseek-official/content.js`：`endSec = dayStart(nowSec) + DAY`，今日小時桶會被抓；失敗改回報 partial (`failures`)，不再讓使用者誤以為全失。`background.js` 的 `vendor-crawl-done` 會顯示 partial warning。
3. **C5 CommandCode** — `vendors/commandcode/content.js`：`fetchCharts` 加 429/5xx/network 退避重試、非 JSON 視為暫時錯誤；401/403 直接報未登入；per-day 包 try 收集 `failures` 後繼續；`since` 過濾與 `SAFETY_DAYS` 截斷改為顯式 warning。
4. **S1 Stored XSS** — `dashboard/views/time-reminder.js`、`dashboard/settings/general.js`、`dashboard/settings/how-it-works.js` 全部改用 `views/format.js` 的完整 `escHTML` (`& < > " '`)；移除 how-it-works 的弱版逃逸。
5. **S2 `onMessage` sender 驗證** — `background.js`：content script 只准送 `crawl-start/progress/error/info/vendor-crawl-data/vendor-crawl-done`；其餘 (clear/import/remove/get-database/get-dashboard-data…) 只接受 extension page (`sender.id` + `chrome-extension://` URL)。驗證**不再排除 `sender.tab`**：Chrome 對「開在 tab 的 extension page」(Dashboard) 會設 `sender.tab`，若排除會讓 get-status/get-database/import-local-data 全部回 `forbidden`。content script 仍受 `CONTENT_SCRIPT_TYPES` 限制，`vendor-crawl-data` 另驗 `source` 與 sender host (`opencode.ai`、`openrouter.ai`、`*.commandcode.ai`、`*.deepseek.com`、Groq console/api)。新增 3 個測試 (tab sender、合法 vendor、partial warning)。
6. **H1 Prototype pollution** — 新增 `shared/stores.js` `putRecord()`；`migrate.js`、`import-plan.js`、`dashboard.js`、`background.js` 共用，`__proto__` 不再被原型 setter 吞掉。
7. **H2 Zip/XLSX bomb** — `shared/zip.js`：entry/total 大小上限 (64MiB/256MiB)、entry 數上限、truncated entry 檢查，`inflateRaw` 邊解壓邊計量並可取消；`dashboard.js` 匯入前檢查 `file.size` (256MiB)。新增 zip 限額測試。
8. **H3 Update open-redirect** — `shared/update-url.js` 提供共用的 `safeReleaseUrl` / `RELEASES_URL`：只接受 `https://github.com/...` 或 `https://www.github.com/...`，其餘回固定 releases URL；`popup/popup.js` 與 `background.js` 都使用同一份 allowlist，不再各自實作；`popup.html` 兩個 `target="_blank"` 補 `noreferrer`。
9. **H4 WAR / CSP** — `tools/build-manifest.mjs` 產生 WAR 時**不加** `use_dynamic_url` (已回退：dynamic URL 會讓 content script 的 mapper import 失敗)；`extension/manifest.json` 保留顯式 `content_security_policy.extension_pages` (`script-src 'self'; object-src 'none'`)。`build-manifest --check` 通過。
10. **H5 備份 `raw` 提示** — `dashboard/settings/database.js` 在 Database 說明加「備份含 raw vendor payload，視為私有」。
11. **CSV 公式注入** — `shared/csv.js`：非數值的 `= + - @` 開頭欄位加 `'`；Excel/Sheets 可解析的數字 (`-12.5`, `-.5`, `+.5`, `1.`, `1e3`) 不受影響；`1_000` 這類非數字文字仍加 `'`。新增測試。
12. **下載競態** — `dashboard/views/format.js`：`revokeObjectURL` 延後 1s。
13. **工具鏈 fail-open** — `tools/extract-preset.mjs`：`sourceName` allowlist (`^[a-z0-9-]+$` + 路徑 containment)、改函數化 + `invokedDirectly`，import 不再寫檔；`tools/price-watch.mjs`：30s timeout + 8MiB 頁面上限；`tools/build-unified-preset.mjs`：有 disagreement 時**不寫** preset；`tools/price-watch-lib.mjs`：讀取不再 `mkdir`，只有 `writeSnapshot` 建目錄；`tools/price-watch-backfill.mjs`：timeout + `^\d{14}$` 驗證；`tools/verify-cost-gap.mjs`：ROOT 改 `import.meta.url`；`.github/workflows/model-watch.yml`：加 `allow_shrink` input 並在 diff 後跑 `npm test`；`package.json` 加 `engines.node >=22.5`。

### 12.3 誤判 / 設計如此 (不改)

- **C1「Unified 覆掉 vendor 金額」** — 不是 bug。README:90 與 `how-it-works` 明寫：Unified ON 就是用使用者價表重算所有 vendor，未分配模型 $0；vendor amount 只在 Unified OFF 使用。要改成 vendor fallback 是產品決策，不能當缺陷直接改。
- **H3「缺 `tabs` 權限」** — MV3 下 `tab.url` 在對該 origin 有 host permission 時可見；本擴充對 opencode 有 `host_permissions`，其餘 vendor 啟用時授予 optional origin，因此不需要 broad `tabs`。維持最小權限。
- **C5「probe 忽略 `since`」** — 與程式不符：`content.js` 的 `startMs` 已用 `opts.since`。真正的問題是 per-day 無 try 與 `slice(-3660)` 無提示，已修。
- **M「snapshot 檔名秒級碰撞」** — `snapshotFilename` 去毫秒是既有格式契約 (`price-watch-lib.test.mjs`、`snapshot-integrity.test.mjs` 都依賴檔名與 `capturedAt` 對應)。改格式需遷移全部歷史快照，收益低，暫不改。

### 12.4 未修 (需要設計決策或較大重構)

- **C4 crawl + import 雙計** — `deepseek-official/import-amount.js` 與其測試已移除 (`vendor.json` `import: []`)；舊備份還原的日錨紀錄仍靠 fingerprint 精確相等去重。要徹底解決需資料遷移 (還原前 clear 或加 vendor-level fingerprint)，不宜在本次直接改。
- **H2 XLSX 解析** — zip 限額已擋 zip bomb，但 `xlsx.js` 仍用 regex 同步解析整份 sheet；要串流/分塊需重寫 parser。
- **CSV 嚴格模式** — 未閉引號、重複 header、超量欄位仍採寬容策略；改成報錯會影響舊備份相容性，需先決定相容策略。
- **MiMo 缺欄補零** — `import-usage.js` 找不到欄位回 0；改成 throw 需先確認 Excel 變體與測試資料。
- **background.js 拆分 / alarms / mutex / perf tick** — 屬 P2 重構，與本次安全/正確性修復無關，留待專門 lane。
- **PS1、lint/type、CI SHA pinning、release attestation** — 工具鏈 hardening，未在本次變更。
- **`build-opencode-preset.mjs` `parsePrice` 脏值回 0** — 仍是 fail-open；因 `rates.source.json` 為人工/爬蟲輸入，改成 throw 可能中斷每日建置，需 owner 決定。
- **CSP `unsafe-inline` style** — 顯式 CSP 只收緊 script/object；dashboard 仍有大量 inline `<style>`，未改。

### 12.5 驗證指令 (修復後)

```powershell
cd D:\Antigravity\opencode-usage
npm test                          # 461 tests, 460 pass, 1 skipped
node tools/build-manifest.mjs --check
node tools/build-unified-preset.mjs --check
```

*本節為覆核者追加；§1–§11 的嚴重度與行號保留審查當時狀態，實際修復以 §12 為準。*
