# 驗證（verification）：清單 + Runbook

> 入口：`ROADMAP.md`（M0）。規則：資料收齊才寫 adapter；收齊一家修 plan 一家。
> 去敏：key/secret 只留後 4 碼（例 `sk-or-...9f2a`）；只貼欄位名 + 3 行 sample。

## A. 通用攔截器（瀏覽器，四家共用）

登入廠商後台 → Usage 頁 → F12 Console 貼整段 → 見 `usage-api logger installed` → 重新整理 + 按 Export → 複製所有 `[usage-api]` 行。

```js
(() => {
  const seen = new Set();
  const show = (url, body) => {
    if (!/usage|activ|billing|export|amount|cost|report|meter/i.test(String(url))) return;
    if (seen.has(url)) return; seen.add(url);
    console.log("%c[usage-api]", "color:green;font-weight:bold", url);
    try {
      const j = typeof body === "string" ? JSON.parse(body) : body;
      const d = j && j.data !== undefined ? j.data : j;
      console.log("keys:", Array.isArray(d) ? `array[${d.length}] first=` + JSON.stringify(d[0]).slice(0, 300) : Object.keys(d || {}));
    } catch { console.log("(non-json or empty)"); }
  };
  const of = window.fetch;
  window.fetch = async (...a) => {
    const r = await of(...a);
    try { show(a[0] && a[0].url ? a[0].url : String(a[0]), await r.clone().text()); } catch {}
    return r;
  };
  const oo = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, u) { this._u = u; return oo.apply(this, arguments); };
  const os = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    this.addEventListener("load", function () { try { show(this._u, this.responseText); } catch {} });
    return os.apply(this, arguments);
  };
  console.log("usage-api logger installed — reload / click Export, then copy the [usage-api] lines");
})();
```

## B. OpenRouter（終端，5 分鐘）

注意：要 **management key**（一般 API key 打不了 analytics）。在 repo 根目錄開 PowerShell。

```powershell
# 先 cd 到 repo 根（例：D:\Antigravity\opencode-usage）
$env:OPENROUTER_API_KEY = "sk-or-你的management-key"
[bool]$env:OPENROUTER_API_KEY
node tools/probe-vendors.mjs
```

看：`metrics=` 有無 `cached_tokens`、analytics/query 7d 回傳 shape、`activity` 1 筆 shape、BYOK token 是否含在 `tokens_prompt`、`is_byok` dimension/filter 是否存在（B6：meta 可用維度列出來；不存在就當 BYOK token 含在 `tokens_prompt`，plan 不可寫「已排除」）。

**結果（2026-09-12，已收）**：要點見 `vendors.md` OpenRouter 段。
* 需 **management key**；一般 inference key 對 analytics/activity 回 `403 Only management keys`。
* `analytics/meta`：`metrics` 含 `cached_tokens`/`possible_cached_tokens`/`tokens_total`；dimensions **無** `is_byok`（model…session_id 共 17 個）；operators `eq/neq/in/not_in/gt/gte/lt/lte`；granularities `minute/hour/day/week/month`（sub-day 上限 31 天）。
* `analytics/query` row：`date__day`=日、`date__hour`=時（naive），值全字串；`tokens_total = tokens_prompt + tokens_completion`。`possible_cached_*` 不可與 `tokens_total`/`tokens_completion`/`reasoning_tokens` 併用。
* activity↔query 對帳一致（2026-08-24 `prompt 109 / completion 50 / reasoning 0 / requests 1`，provider `stealth`）。
* **B6**：無 `is_byok` dimension、無 BYOK token metric → 無法切出 BYOK token，只能當 `tokens_prompt/completion` 含 BYOK。
* 價格路 `GET /models`：pricing 有 `input_cache_read`/`input_cache_write`/`input_cache_write_1h`/`internal_reasoning`；69 筆 tiered `overrides`、172/445 缺 `input_cache_read`；`~`=alias、`:free`/`:batch`=變體。
* 未驗（此帳號唯一用量 `stealth/ox-alpha` 不在 /models、且 cached/reasoning=0）：`input = tokens_prompt − cached_tokens`、`reasoning ⊂ completion`、naive 時間是否 UTC。

## C. DeepSeek（瀏覽器 + 終端，10 分鐘）

1. Usage 頁貼 A → 複製 `[usage-api]` 行（query 參數 + 欄位名）。
2. Export 月 ZIP，解壓：

```powershell
Expand-Archive .\deepseek-usage-*.zip .\ds-export
Get-Content .\ds-export\amount-*.csv | Select-Object -First 4
Get-Content .\ds-export\cost-*.csv | Select-Object -First 3
```

看：`[usage-api]` + 兩表頭各 3 行 + 平台頁當天數字（驗 reasoning 是否併 output）。

**結果（2026-09-12，已收，export 路）**：要點見 `vendors.md` DeepSeek 段。
* Export → `usage_data_<start>_<end>.zip`（`amount-*.csv` + `cost-*.csv`）。
* `amount` 表頭：`user_id,start_time_iso,end_time_iso,model,api_key_name,api_key,type,price,amount`；long format，`type` = `input_cache_miss_tokens` / `input_cache_hit_tokens` / `output_tokens` / `request_count`。
* `start_time_iso` 日粒度、帶 `+08:00`（GMT+8）；`api_key` 需丟。
* 對帳：June CSV 加總 = 頁面（pro `88,917,597` tok / `834` req；flash `1,493,441` / `64`）。
* `cost` 為 CNY、不吃；crawl 路仍在 `[usage-api]` 未收（標選配）。

## D. CommandCode（瀏覽器 + 終端，10 分鐘）

1. Studio Usage 頁貼 A → 複製 `[usage-api]` 行。
2. 有無 Export（有就下載看格式）。
3. `Get-ChildItem $HOME\.commandcode`。
4. CLI 跑 `/usage`，複製輸出（數字保留）。

**結果（2026-09-12，已收）**：要點見 `vendors.md` CommandCode 段。
* 端點：`GET https://api.commandcode.ai/internal/usage?limit=100[&cursor=<base64url>]`。
* 認證：cookie（`include` 200 / `omit` 401）、無 Bearer、CORS 允 credentials。
* 分頁：keyset，跟 `nextCursor` 到 `null`；實測 66 筆無重複。
* `window:{days:1}`、`periodBasis:"plan-window"`；`type`/`mode` 皆 `api`；model `deepseek/deepseek-v4.1-flash`(+ `tencent/hy3-paid`)。
* **無 Export 按鈕**；`~/.commandcode` 未查。
* cache 無原生 token 欄 → 由 `meta.*Cost` ÷ 價表反算（D16）；實測兩筆精確吻合。

## E. MiMo（瀏覽器，10 分鐘）

1. Usage Information 貼 A → 複製 `[usage-api]` 行。
2. 匯出檔表頭 + 3 行（去敏）；記下有無時間範圍選項。

**結果（2026-09-12，已收，export 路）**：要點見 `vendors.md` MiMo 段。
* 平台需 Xiaomi 帳號登入；Usage 頁與 Token Plan 頁各有 Export。
* 匯出是 **xlsx**（非 CSV）：Token Plan → `token_plan_usage_<yymmdd>_<yymmdd>_<uid>.xlsx`（單 sheet，無 cost/key）；Pay-as-you-go → `usage_data_<yymmdd>_<yymmdd>_<uid>.xlsx`（多 API Key/Currency/Amount + Plugin sheet）。
* 欄位：`Date | Model | Total Tokens | Input Hit Tokens | Input Miss Tokens | Output Tokens | Total audio duration | Request Count`；`Date` UTC。
* 對帳：July Token Plan 加總 = 頁面（`169,207,493` tok / `2,048` req）。
* crawl 路未收（標選配）。

## G. 完成標準

* 一家全勾 → 寫該家 adapter → 修訂 `architecture.md`/`vendors.md` 對應欄位。
* 五家齊 + 三類測試全綠 + token 對帳通過 → breaking branch 放行（M8）。

## H. 回傳模板（複製填）

```
## <廠商>
有無 Export：
數字拆分到哪一層（input/output/cache hit/miss/reasoning）：
時間欄位 + 時區：

<!-- OpenRouter：probe 整段輸出貼這（key 已 redacted，不會外洩） -->

<!-- 瀏覽器廠商：貼 [usage-api] 行（含 URL + keys 行）+ 表頭 + 3 行 -->

備註：
```

