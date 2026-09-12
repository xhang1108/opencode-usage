# 盲點與風險（開工前必讀）

> 入口：`ROADMAP.md`。這一頁記「計畫沒講清楚、或不改會出事」的點。

## 高風險

### B1 Host permission 靜態，之後加廠商要重新授權
manifest 寫死 origin（現有 `opencode.ai` + `api.github.com`）；以後每加一家要多一個 host，Chrome 更新跳權限警告，用戶不按整包停用。
**解法**：每家 origin 用 `optional_host_permissions`，用戶在 Settings 開啟該廠才 `chrome.permissions.request()`；沒開的廠不要求權限。

### B2 MV3 不能優雅動態載入
`importScripts` 同步 top-level；`content_scripts` 靜態。「讀 registry 動態載入各家」太理想。
**解法**：定調為 shared 用固定 `importScripts`；vendor content script 由 build script 產生進 manifest；runtime 補註冊用 `chrome.scripting.registerContentScripts`。

### B3 date 從 local 改 UTC 會移動歷史
決策 P8 要 UTC，但現況三處不一致：stored `date` 是爬取當下本地日期（`content.js:823`）；render 層 `dashboard.js:139` `localDateOf` 用 local，且註明「always reflects the viewer's timezone」是有意設計；hourly 也混用——`dashboard.js:853` 已 `getUTCHours()`，`dashboard.js:1127/1332` 仍 local `getHours()`，與 UTC peak window 基準不一致。
**解法**：hourly 先統一成 UTC（`1127/1332`）；stored `date` 一律不信，只從 `time`（ISO）重算。render 改 UTC 屬 breaking——非 UTC 時區用戶的日/小時歸屬會整體平移、圖表跳動，需在 M1 明講並決定是否保留 local 開關（見 ROADMAP 待定）。

### B4 「token 正確」缺對帳測試
golden-file 只驗 mapper 穩定，不驗數字對不對；`input = prompt - cached`、reasoning 是否已含在 completion、cache 是否重複計，全是假設。
**解法**：每 adapter 收工前 reconciliation——dashboard 該 model token 總和 vs 廠商頁面總和，誤差可解釋。此為真正驗收門檻。

## 中風險

### B5 同廠雙軌 double count
同一筆用量 crawl 與 CSV 各一個 ID，不會互相覆蓋 → 翻倍。
**解法**：同廠跨來源 fingerprint（model+tokens+日期）去重；或 UI 明示「crawl 開著就別 import CSV」。

### B6 OpenRouter BYOK token 含在 tokens_prompt（已定案）
`analytics/meta` 無 `is_byok` dimension，也無 BYOK token metric（只有 `byok_usage`/`byok_fees`/`byok_request_count` 金額/次數）。
**定案**：BYOK token 切不出；`tokens_prompt/completion` 一律視為**含 BYOK**，不可寫「已排除」。

### B7 新用戶第一眼一片 $0
modelMap 沒覆蓋的 model 全 unmapped、成本 0，看起來像壞掉。
**解法**：preset 覆蓋各廠主力 model；inbox badge 顯眼。

## 低風險但需先講清楚

### B8 Key 存放
OpenRouter management key 權限大。
**定調**：key 永不進 extension；一律本地 script 跑、匯出 JSON import，extension 只吃檔案。
另：DeepSeek export `amount` CSV 含 `api_key` 欄（已遮罩但仍敏感）→ import 只留 `api_key_name` 當 `keyID`，原始 key 丟棄。

### B9 爬後台可能踩 ToS
用 session cookie 爬 DeepSeek/CommandCode console 可能違反條款，或被 Chrome Web Store 以 scraping 為由刁。
**做法**：開工前確認各廠 ToS 對自動存取的態度。DeepSeek 走 **Export import** 可避開此風險；crawl 路（opencode / CommandCode / DeepSeek-crawl 選配）仍需確認。

### B10 Scraper 靜默失效
廠商改版 → 回傳 0 筆 → 用戶誤以為沒用量。
**解法**：crawl 成功但 0 筆要告警，不能只在錯誤時報錯。

### B11 遷移丟失
breaking 遷移若中途失敗可能丟 rates/設定。
**解法**：遷移前自動備份 rates + 提示 `Export Full JSON`；`userPricing` 與舊 key 共存可降級回讀。

### B12 CommandCode cache token 只能靠 cost 反算
API 無 cache token 欄，只能用 `meta.*Cost` ÷ 官方價反推 `cacheRead`（D16）。若價表漂移、model 未映射、peak/offpeak 判錯 → guard 失敗 → 退回全進 `input`（成本高估）。
**解法**：guard 必過才算 `derived`；存 `vendorCost` + `cacheBasis` 以便日後重算；pricing 測試斷言不讀 `vendorCost`。

### B13 CommandCode 只有單路且保留期未知
無 Export、無 `~/.commandcode` 檔 → 只有 crawl 一路；`window.days:1` 疑只留近 1 天。漏抓一天可能永久遺失且無手動補救。
**解法**：D13 標「待驗（新帳號無法驗，隔幾日再測 `oldest`）」；提醒高頻手動 crawl；備份只靠 `Export Full JSON`。

### B14 MiMo 非 token 用量與 xlsx 解析
MiMo 匯出含非 token 項：`Total audio duration`（ASR/TTS 秒）、Plugin sheet（Search/Extension 次數）；且是 **xlsx**（需瀏覽器內解，比 CSV 重），另有 plan / payg 兩變體。
**解法**：P1 token-only 先略過非 token 項（或存 optional）；importer 支援 xlsx（`sharedStrings.xml` + `sheet*.xml`）；按檔名/sheet 名分辨 plan/payg。
