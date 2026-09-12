# 廠商（vendors）

> 入口：`ROADMAP.md`。架構：`architecture.md`。驗證：`verification.md`。
> 雙軌：crawl/API 路 + 手動檔案 import 路（crawl 抄 opencode 同一招：同源 + cookie + 獨立 OPFS）；import 冪等（同 key 覆蓋）；天粒度重掃最後一天。
> 例外：OpenRouter 依 B8（key 永不進 extension）只有 JSON import 一路，無 crawl 路；CommandCode 無 Export 檔、只有 crawl 一路。兩者都不適用 B5 的雙軌翻倍風險。

## 保留窗口（提醒用戶手動按）

| 廠商 | 窗口 | 過期後果 |
|---|---|---|
| opencode crawl | 增量 sync point，無窗口 | 停舊進度，不消失 |
| OpenRouter activity | 30 天 | 超過則最舊天消失（analytics 365d 可補） |
| OpenRouter analytics | 365 天（token 類） | 安全網 |
| DeepSeek Export | 依 Time 篩選（實測可回溯至 6 月） | 更舊未知，建議定期匯出存檔 |
| DeepSeek crawl | 選配、未驗證 | 待定 |
| CommandCode crawl | 疑近 1 天（`window.days:1`，待驗證） | 可能永久消失，且無檔案備份 |
| MiMo Export | 依月份（方案到期後仍可匯出歷史月） | 待驗證 |

## 各家

### opencode（現有）
* crawl `_server` + cookie + OPFS `opencode_token_cache_*.json`；local `opencode.db` 走 `import-local.mjs`。
* 官價：`anomalyco/opencode` 的 `go.mdx` commit（現有 `script/fetch_diffs.ps1`）；`gh api` 查 path commits，SHA + author date。

### OpenRouter
* 用量（2026-09-12 實測）：`POST /api/v1/analytics/query`（**management key**；一般 inference key 回 403）。最長 365 天；sub-day（minute/hour）上限 31 天，更長須 `granularity >= day`。
  * req：`{metrics[], dimensions[]（≤2）, granularity, limit, group_limit?, order_by?, filters[], time_range{start,end}}`；`time_range` 必填、UTC 帶秒（`YYYY-MM-DDTHH:MM:SSZ`，純分鐘被拒）。
  * resp：`data.data[]` + `data.metadata{query_time_ms,row_count,truncated}` + `cachedAt`（可含 `warnings`）；**無 cursor** → 補齊靠 `limit`（預設 1000）+ `truncated` + 按時間切段。
  * row：`date__<granularity>`（day `"YYYY-MM-DD"`、hour `"YYYY-MM-DD HH:MM:SS"`，naive） + dimension keys + metric keys；**值全是字串**要 `Number()`。
  * metrics：`tokens_prompt` / `tokens_completion` / `reasoning_tokens` / `cached_tokens` / `possible_cached_tokens` / `tokens_total`（實測 `= tokens_prompt + tokens_completion`）/ `request_count`；另有成本、延遲、`byok_usage`/`byok_fees`/`byok_request_count`。`possible_cached_*` 不可與 `tokens_total`/`tokens_completion`/`reasoning_tokens` 併用。
  * dimensions：model（permaslug）、variant、api_key_id、provider、origin、country、data_region、skin、streamed、finish_reason、workspace、app、user、external_user、context_length_bucket、generation_id、session_id；operators：eq/neq/in/not_in/gt/gte/lt/lte。
* 映射：`input = tokens_prompt - cached_tokens`、`cacheRead = cached_tokens`、`output = tokens_completion`、`reasoning = reasoning_tokens`（併 output 顯示，D7）、`requests = request_count`、`cacheWrite = 0`（無 metric）；`time`/`date` 由 `date__<granularity>` 補成 UTC ISO（P8，naive 值暫定 UTC 待驗）；金額欄位丟（P1）。
* **B6 定案**：無 `is_byok` dimension、也無 BYOK token metric → BYOK token 切不出；`tokens_prompt/completion` 只能當**含 BYOK**，不可寫「已排除」。
* 不用 `GET /activity`（30d、無 cache；僅 `byok_usage_inference`/`byok_requests`）。實測 activity↔query 對帳一致（2026-08-24 `109/50/0/1`）。
* 官價：公開 `GET /api/v1/models`（實測 445 筆、免 key）。pricing 為**每 token 字串**：`prompt`/`completion`/`input_cache_read`/`input_cache_write`/`input_cache_write_1h`/`internal_reasoning`/`audio`/`image`/`web_search`；69 筆有 `overrides`（依 `min_prompt_tokens` 分段 tiered）、172/445 無 `input_cache_read`。id 有 `~`（alias，另有 `alias_target.slug`）與 `:free`/`:batch` 變體，`canonical_slug` 為去變體 base；stealth 模型（如 `stealth/ox-alpha`）不在 /models → 進 inbox、成本 0（P5）。
* 手動路：JSON import（B8：key 永不進 extension）。

### DeepSeek（export 已驗證）
* 無 Bearer 聚合 API（`platform.../api/v0/usage/*` 只吃 session cookie，Bearer 回 `40003`）。
* 手動路（主）：Usage 頁 **Export** → `usage_data_<start>_<end>.zip`，內含 `amount-*.csv` + `cost-*.csv`；範圍依頁面 Time 篩選（Today / … / Custom）。**瀏覽器內解壓**（D17），只吃 `amount`。
  * 表頭：`user_id,start_time_iso,end_time_iso,model,api_key_name,api_key,type,price,amount`。
  * long format：一列 = 一天 × model × api_key × type：
    `input_cache_miss_tokens`→`input`、`input_cache_hit_tokens`→`cacheRead`、`output_tokens`→`output`、`request_count`→`requests`；`cacheWrite=0`。
  * `start_time_iso` **日粒度**且帶 offset `+08:00`（GMT+8）→ `time`/`date` 轉 UTC（P8；UTC 會落在前一天，見 B3）。
  * `api_key` 已遮罩但敏感 → **丟**；`keyID = api_key_name`、`workspaceID = user_id`。
  * `price`/`cost` 是 CNY、`cost` 不吃（P1）。
  * 對帳（June sample）：CSV 加總 = 頁面（pro `88,917,597` tok / `834` req；flash `1,493,441` / `64`）。
* crawl（選配、未驗證）：content-script 跑 `platform.deepseek.com` origin，同源 `fetch(credentials:"include")` 打 `/api/v0/usage/amount` + `/cost`。
* reasoning 併 output（sample 無 reasoning 欄，假設成立）。
* `source = "deepseek-official"`。
* 官價：非官方鏡像 `thevibeworks/deepseek-docs` 的 `pricing.md` commit history；官網 `updates` changelog + pricing 註腳（未來生效日用註腳日期）。

### CommandCode（已驗證 crawl）
* 用量 API（純 cookie 認證、跨域）：`GET https://api.commandcode.ai/internal/usage?limit=100[&cursor=<base64url>]` → `{usages[], nextCursor, limit, periodBasis:"plan-window", window:{days,entries}}`；keyset 分頁跟 `nextCursor` 到 `null`。實測 `credentials:"include"` → `200 cors`、`omit` → `401`（無 Bearer）；extension 需 `host_permissions` `https://api.commandcode.ai/*` + `credentials:"include"`。
* 映射：`id=usages[].id`、`time=createdAt`(UTC)、`model=meta.model`（`provider/model` raw，如 `deepseek/deepseek-v4.1-flash`）、`input=tokensIn-cacheRead`、`output=tokensOut`、`cacheWrite=0`、`source="commandcode"`；`tokensIn/tokensOut` 是**字串**要 `Number()`。`type`/`mode` 實測皆 `api`。
* **cache 無原生 token 欄**（只有 `meta.inputCost/outputCost/cacheCost`）：用同價表反算（D16）——`cacheRead=round(cacheCost/cacheReadRate)`、`input=round(inputCost/inputRate)`；guard `input+cacheRead===tokensIn` 且 `round(tokensOut*outputRate)===outputCost`（peak/offpeak 依 `createdAt` UTC 選）。實測 `deepseek-v4.1-flash`（offpeak input 0.15 / output 0.60 / cacheRead 0.003 $/M）兩筆精確吻合。guard 失敗 → fallback：`tokensIn` 全進 `input`、`cacheRead=0`、`cacheBasis:"unknown"`。
* `meta.*Cost` 只作反算，**永不顯示**；原值存 record 的 `vendorCost`（見 `architecture.md` §3、D16）。
* **無 Export 按鈕 → 只有 crawl 單路**（不適用 D12 雙軌）；保留期疑近 1 天，新帳號無法驗（D13 待驗，隔幾日再測 `oldest`）。
* 官價：第三方 `all-the-rest/cc-price-tracker`（`cc-pricing.all-the.rest/data/latest.json`）data 檔 commit history；官方 `/changelog` + `pricing-limits` DEAL 交叉驗證。
* **未決（不擋 M1）**：① 保留期（疑近 1 天；待幾日後重測 `oldest`）；② `status` 非 `completed`（failed/processing）是否計 token、要否濾；③ 是否出現 `api` 以外的 `type`/`mode`；④ D16 反算只驗過 offpeak，**peak 未驗**。

### MiMo（export 已驗證）
* 平台 `platform.xiaomimimo.com`（Xiaomi 帳號登入），近即時（≤5 分）、每日 **07:00 UTC** 定稿。兩套用量、同 shape：
  * **Token Plan**（`tp-` key，訂閱）：`token_plan_usage_<yymmdd>_<yymmdd>_<uid>.xlsx`，單 sheet「Token plan usage detail」，**無 cost/currency/API key**。
  * **Pay-as-you-go**（`sk-` key）：`usage_data_<yymmdd>_<yymmdd>_<uid>.xlsx`，sheet1「Model usage detail」多 `API Key`/`Currency`/`*Amount`，另有 sheet2「Plugin usage detail」。
* **xlsx（非 CSV）**，wide format：`Date | Model | Total Tokens | Input Hit Tokens | Input Miss Tokens | Output Tokens | Total audio duration | Request Count`。
  * 映射：`input=Input Miss Tokens`、`cacheRead=Input Hit Tokens`、`output=Output Tokens`、`requests=Request Count`、`cacheWrite=0`；`Date` 為 **UTC 日**。
  * 建議單一 `source:"mimo"` + `plan:"token-plan"|"payg"`；`keyID` 只在 payg；`*Amount`/`Currency` 丟（P1）。
  * 非 token：`Total audio duration`（ASR/TTS 秒）與 Plugin sheet → 略（或存 optional，見 B14）。
  * 對帳（July Token Plan）：加總 = 頁面（`169,207,493` tok / `2,048` req）。
* crawl 未驗（CodexBar 只反工程到 balance/token-plan，非 per-model usage）；per-request `usage{prompt,completion,total}` 僅參考。
* `source = "mimo"`；官價：無公開 repo，定時快照 `mimo.mi.com/docs` pricing 頁。

## 手動輸入

* `chrome.storage.local: manualImportData`，跟 `localImportData` 同 merge 層（不寫 OPFS）。
* Record：`{ id: "manual:<ts>-<rand>", source: "manual", workspaceID 預設 "Manual", time, date, model, provider?, tokens... }`。
* 手動記錄也要過 modelMap 才計價：未映射進 inbox、成本 0。
* `manual` 列入 registry 當正常 source（可關）；記錄可單筆刪 + 全部清。
* UI：`Add Manual Record` modal（datetime、model、各 token、workspace、provider）+ 記錄列表（Delete / Clear）。
