# ROADMAP（唯一入口）

多廠商 token 聚合。opencode-only 用戶 = 全能版只開 opencode，零差別。

## 文件索引

| 檔 | 內容 |
|---|---|
| `ROADMAP.md` | 本檔：目標、原則、決策、里程碑、廠商矩陣、待定 |
| `architecture.md` | schema、計費/modelMap、儲存、dashboard、新增廠商 SOP |
| `vendors.md` | 各廠用量/價格來源、保留窗口、手動輸入 |
| `verification.md` | 開工前驗證清單 + runbook |
| `blindspots.md` | B1–B14 盲點與風險 |

## 目標

從 opencode-only 變多廠商：分開收（各廠獨立管線）、統一看（一個 dashboard）。

## 原則（P）

* P1 token-only：adapter 只收 token，錢 dashboard 重算。無匯率問題。
* P2 token + 時間為準：記錄 immutable，成本渲染現算，價格錯了隨時重算救回。
* P3 MANUAL：crawl 全手動按，不自動打（避 429）。
* P4 零搜名字：查價 = 查 modelMap 確定表；找不到進 inbox 不猜。
* P5 找不到不猜：unmapped 成本 0 + 常駐 badge（數 + 最久天數）+ notice。
* P6 早轉換：raw→canonical 在 adapter 邊界一次轉完。
* P7 Cache 必留：canonical 永遠有 cache 欄；沒拆分全進 `input` 並註明，不估。
* P8 UTC：`date` 由 `time` 重算 UTC，不信 stored `date`；時間存 ISO。
* P9 隔離：新廠 = 新夾；vendor 夾只能 import shared；shared 零 chrome 依賴可單測。

## 決策（D）

* D1 儲存兩層：OPFS per-origin 各留各（免前綴）；`chrome.storage.local` 統一（ID `<source>:` 前綴）。
* D2 合併：N-way 疊加；dedupe 只跑**同廠內部**（同 `source` 的雙軌 crawl vs 檔案；opencode = crawler vs local、deepseek = crawl vs CSV）；跨廠不自動去重（BYOK）；>5MB 再拆（預案）。
* D3 全量備份 `Export Full JSON`；還原走各源 import。
* D4 Schema：canonical 最小必填 `id/source/time/model` + 至少一 token > 0 + optional + `v:1`；ID `<source>:<orig>`（無 orig-id 時 adapter 生成穩定 hash）；舊無 source 視 opencode。
* D5 查價：`modelMap["<source>:<raw>"] → target`；target 雙價 `rates`/`curatedRates`；`priceChoice` 按廠商（預設 curated，保底原廠）；每筆標 `priceBasis`；版本只加不減；改價作者制。
* D6 free 變體獨立 target，可顯示 0 或併主群；合併規則以後定。
* D7 reasoning 併 output 顯示；CSV 加 `Source`/`priceBasis`/`requests`。
* D8 Settings（dashboard 內嵌）：General / Vendors / Models / Rates。
* D9 廠商開關 `vendorSettings` 按人存；新廠預設 off；新用戶 seed `{opencode:true}` + onboarding；舊用戶一次性提醒。
* D10 Popup split-button，下拉只列 enabled；無 crawler 顯示 disabled。
* D11 手動輸入過 modelMap 才計價；列入 registry；單筆刪/全清。
* D12 雙軌：crawl/API + 手動檔案；進口冪等同 key 覆蓋；天粒度重掃最後一天。按廠取捨：**有 Export 者可以檔案為主、crawl 選配**（DeepSeek、MiMo）；**無 Export 者只能 crawl**（CommandCode、opencode）。
* D13 保留窗口提醒（見 `vendors.md`）。
* D14 測試三類全綠當門檻：shared 單測 + adapter golden-file + UI smoke。
* D15 遷移：舊 rates 原樣轉初始 map（free 只建議）；遷移前自動備份 + 提示匯出。
* D16 廠商回傳金額可存為 `vendorCost`（opaque），**僅**供 cache token 反算/稽核，pricing/charts/tables/CSV/加總一律不得讀、永不顯示；反算須過 reconciliation guard，失敗則 fallback（全量進 `input` + `cacheBasis:"unknown"`）。首用：CommandCode。
* D17 統一檔案匯入：dashboard 一個拖放/選檔入口，可一次多檔、自動分派各家 parser（JSON / ZIP / CSV / **XLSX**）；**壓縮檔在 extension 內解壓**（ZIP 讀 central directory + `DecompressionStream('deflate-raw')`；XLSX 讀 `sharedStrings.xml` + `sheet*.xml`；或 vendored fflate），不要求使用者手動解壓；parser 置 `vendors/<source>/import-*`。

## 目標目錄

```
extension/shared/            canonical.js merge.js pricing.js vendors.json
extension/vendors/<source>/  vendor.json content/ background.js rates.preset.json
                             price-snapshots/ import-*.mjs
extension/background.js      薄路由（registry 動態載入）
extension/dashboard/         filters/charts/tables/settings/rates 拆檔
extension/popup/             split-button
tools/probe-vendors.mjs tools/price-watch/ tools/tests/ tools/build-manifest.mjs
```

## 里程碑（M，單主線 breaking branch）

* M0 驗證收齊（用戶，`verification.md`；一家齊修 plan 一家）— ✅ opencode / openrouter / deepseek / commandcode / mimo；AI Studio 不納入
* M1 骨架：目錄 + shared + registry + manifest 生成 + storage keys + seed/遷移 + background 載入（含 B1/B2）
* M2 計費：modelMap + 雙價 + priceChoice + 版本鏈 + validate + inbox
* M3 Dashboard：Settings 四分頁 + filter/圖表/表格/CSV + 保留窗口提醒
* M4 Popup：split-button + enabled 選單 + B10 0 筆告警
* M5 Adapter：openrouter + deepseek(B5) + manual + presets
* M6 Adapter：commandcode + mimo（驗證後）
* M7 價格：全廠 preset(B7) + price-watch（快照 `vendors/<source>/price-snapshots/`）
* M8 放行：測試全綠 + B4 token 對帳 + 遷移 dry-run + breaking 發佈（舊版留 maintenance tag）

## 廠商矩陣

| 廠商 | 用量路 | 價格路 | 驗證 | 窗口 |
|---|---|---|---|---|
| opencode | crawl + local DB | GitHub go.mdx | ✅ | 增量無窗口 |
| openrouter | analytics/query（365d，management key）+ JSON import；B6 已定（無法排除 BYOK） | `/models` 快照 | ✅ | analytics 365d；activity 30d |
| deepseek | export ZIP（主）+ crawl（選配） | 鏡像 repo + 註腳 | ✅ export / ⏳ crawl | 依 Time 篩選（實測回溯至 6 月） |
| commandcode | crawl（`api /internal/usage`，cookie） | cc-price-tracker | ✅ | 疑近 1 天（D13 待驗） |
| mimo | export XLSX（plan/payg）；crawl 未驗 | 頁快照 | ✅ export / ⏳ crawl | 依月份 |

（各家細節見 `vendors.md`）

## 待定（以後）

* free 合併規則、price-watch 跑法（Actions vs 手動）、`cachedData` 拆分（>5MB 觸發）、時區顯示（B3：UTC only vs 保留 local 開關）。

## 未決追蹤（M0 已收，後續解；不擋 M1）

* **CommandCode**：① 保留期（疑近 1 天，待幾日後重測 `oldest`）；② `status` 非 `completed` 是否計 token、要否濾；③ `type`/`mode` 其他值；④ D16 反算 peak 未驗。收在 **M6**。
* **DeepSeek**：crawl 路（選配）未驗。收在 **M5**。
* **MiMo**：crawl 路（選配）未驗。收在 **M6**。
* **價格來源未實測**：DeepSeek 鏡像 repo、MiMo docs 快照、CommandCode cc-price-tracker。收在 **M7**。
