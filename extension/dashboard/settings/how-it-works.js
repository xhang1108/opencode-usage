// extension/dashboard/settings/how-it-works.js
// Static, user-facing reference: shared concepts first, then one table per
// vendor. Table-first on purpose (little prose). Hand-written copy — keep it
// in sync with docs/vendors.md when an adapter changes. Renders once.

// Each section: { id, title, tag, head?, rows, extra? }.
//   head given  -> rows are cell arrays rendered against that header row.
//   head absent -> rows are [label, value] key/value pairs.
//   extra       -> optional HTML appended after the table (vendor-specific how-to).
import { flashButton } from "../../shared/dom-ui.js";

const SECTIONS = [
  {
    id: "tokens",
    title: "Tokens",
    tag: "shared",
    head: ["Field", "Meaning", "Reported by"],
    rows: [
      ["input", "Prompt tokens not served from cache (cache miss).", "all"],
      ["output", "Completion tokens returned by the model.", "all"],
      ["reasoning", "Model thinking tokens, stored separately and never double counted. Vendors that fold reasoning into their completion count (opencode console, OpenRouter) have it split out at import.", "opencode, OpenRouter"],
      ["cacheRead", "Prompt tokens served from cache (cheap / often free).", "opencode, OpenRouter, CommandCode, DeepSeek, MiMo"],
      ["cacheWrite5m", "Tokens written into the 5-minute cache.", "opencode, CommandCode"],
      ["cacheWrite1h", "Tokens written into the 1-hour cache.", "opencode"],
    ],
  },
  {
    id: "cost",
    title: "How cost is calculated",
    tag: "shared",
    rows: [
      ["Unified pricing", "When on, every vendor is billed from your own price list (Settings → Pricing): tokens × the rate table of the group the model is dragged into. Vendor-reported spend and fallback prices are paused."],
      ["Vendor-reported", "When unified is off, the amount the vendor itself reports is used directly (USD) for vendors that expose it."],
      ["Derived", "cost = tokens × price table, applying peak / off-peak windows where defined."],
      ["Formula", "input·rate_input + (output + reasoning)·rate_output + cacheRead·rate_cacheRead + cacheWrite·rate_cacheWrite (÷ 1e6; rates are USD per 1M). `output` excludes reasoning, so it is added once at the output rate."],
      ["Free models", "Priced like any other model — give the `-free` variant its own rate instead of forcing $0."],
      ["Unassigned models", "Under unified pricing, a model in no group is $0 until you drag it into one."],
    ],
  },
  {
    id: "time",
    title: "Time & dates",
    tag: "shared",
    rows: [
      ["Storage", "Canonical timestamps are UTC."],
      ["Display", "Charts, tables and filters render in your local timezone."],
      ["Peak / off-peak", "Judged in UTC against each vendor's window definition."],
      ["Imports", "Keep the vendor timestamp, converted to UTC (offset kept for audit)."],
    ],
  },
  {
    id: "sources",
    title: "Where the data comes from",
    tag: "shared",
    rows: [
      ["Crawl", "Reads the same private endpoint the vendor's own dashboard uses, with your session cookie. Stays in your browser."],
      ["File import", "Vendor exports (XLSX / JSON) and your own backup (settings JSON + records CSV), parsed in-browser."],
      ["Local DB", "opencode local database via tools/import-local.mjs."],
      ["Backup", "Settings -> General -> Export Backup writes two non-overlapping files: settings (JSON, includes your pricing) and every record from every source (CSV, incl. raw). Import both to restore."],
      ["Data count", "The Data column counts what each vendor reports: opencode = one per usage record (it has no request field); CommandCode / DeepSeek / OpenRouter / MiMo = the vendor's own request count (CommandCode aggregates into 5-minute buckets). Because the definitions differ, mixing vendors makes the total approximate."],
    ],
  },
  {
    id: "opencode",
    title: "opencode",
    tag: "crawl",
    head: ["Aspect", "Detail"],
    rows: [
      ["Source", "Crawl of opencode.ai (per workspace) + local opencode.db import."],
      ["Tokens", "Native input, output, reasoning, cacheRead, cacheWrite5m, cacheWrite1h. The console's output count already includes reasoning, so output is stored reasoning-excluded and reasoning kept separate."],
      ["Cost", "Vendor-reported when the console reports an amount (USD×1e8, divided to USD). When it reports no amount (null), the cost is estimated from the price table."],
      ["Limits", "Session id rotates each redeploy (auto re-captured). Full rescan stalls ~198 pages. Server may stop holding an old workspace (returns empty) — last synced data is kept. Crawl daily; keep the tab visible."],
    ],
    extra:
      `<div class="settings-section-title">Local usage import</div>
       <p>Export your local opencode database, then add the JSON via <strong>Import Usage</strong>. Serves models the server no longer reports (e.g. free models).</p>
       <div class="cmd-box">
         <code id="hwLocalCmd">node tools/import-local.mjs --out opencode_local_records.json</code>
         <button class="btn btn-secondary" id="hwLocalCopy">Copy</button>
       </div>`,
  },
  {
    id: "openrouter",
    title: "OpenRouter",
    tag: "vendor cost",
    head: ["Aspect", "Detail"],
    rows: [
      ["Source", "Cookie crawl of the private analytics endpoint (no API key)."],
      ["Tokens", "input = tokens_prompt − cached_tokens · cacheRead = cached_tokens · output = tokens_completion − reasoning_tokens · reasoning = reasoning_tokens (a subset of completion, split out so it is not counted twice) · cacheWrite = 0. BYOK cannot be split out."],
      ["Cost", "Vendor-reported account spend (total_usage, USD, 6 decimals). Provider differences included."],
      ["Limits", "365 days longest; 31 days when grouped by provider. Private endpoint can change."],
    ],
  },
  {
    id: "deepseek-official",
    title: "DeepSeek",
    tag: "crawl",
    head: ["Aspect", "Detail"],
    rows: [
      ["Source", "Cookie + Bearer-token crawl of the platform usage endpoint (hourly)."],
      ["Tokens", "input = PROMPT_CACHE_MISS_TOKEN · cacheRead = PROMPT_CACHE_HIT_TOKEN · output = RESPONSE_TOKEN · data = REQUEST · cacheWrite = 0. Merged across API keys into one row per model+hour (per-key detail kept in raw)."],
      ["Cost", "Derived from the official price table. The vendor's CNY cost is recorded in raw (not used). Hourly rows let peak / off-peak windows apply."],
      ["Limits", "Requires a logged-in DeepSeek session (token read from the page). One day per request for hourly buckets; history scanned backwards in bounded windows."],
    ],
  },
  {
    id: "commandcode",
    title: "CommandCode",
    tag: "crawl",
    head: ["Aspect", "Detail"],
    rows: [
      ["Source", "Crawl only (no export)."],
      ["Tokens", "input = tokensIn − cacheReadInputTokens · cacheRead = cacheReadInputTokens · cacheWrite5m = cacheCreationInputTokens · output = tokensOut."],
      ["Cost", "Vendor-reported (endpoint totalCost)."],
      ["Limits", "Aggregated into 5-minute buckets (no per-record rows); data = the vendor's request count per bucket. ~35 days back; crawl about every 3 days."],
    ],
  },
  {
    id: "mimo",
    title: "MiMo",
    tag: "import",
    head: ["Aspect", "Detail"],
    rows: [
      ["Source", "XLSX export import (Token Plan + Pay-as-you-go) + optional crawl (unverified)."],
      ["Tokens", "input = Input Miss Tokens · cacheRead = Input Hit Tokens · output = Output Tokens · cacheWrite = 0. Date is a UTC day."],
      ["Cost", "Derived from the official USD price table. Currency/amount columns ignored."],
      ["Limits", "Non-token usage (audio seconds, plugin counts) not counted. Finalised daily 07:00 UTC; export by month."],
    ],
  },
  {
    id: "manual",
    title: "Manual records",
    tag: "manual",
    head: ["Aspect", "Detail"],
    rows: [
      ["Source", "Added by hand in the dashboard."],
      ["Pricing", "Priced like any other record (unified list when on, fallback prices when off). Deletable individually or all at once."],
    ],
  },
];

export function renderHowItWorks() {
  const pane = document.getElementById("settings-how");
  if (!pane || pane.dataset.rendered === "1") return;

  const table = (s) => {
    if (s.head) {
      const head = s.head.map((h) => `<th>${h}</th>`).join("");
      const body = s.rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("");
      return `<table class="hw-table"><tr>${head}</tr>${body}</table>`;
    }
    const body = s.rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join("");
    return `<table class="hw-table hw-kv-table">${body}</table>`;
  };

  const jump = SECTIONS.map((s) =>
    `<button type="button" class="hw-jump" data-hw="${s.id}">${s.title}</button>`
  ).join("");
  const sections = SECTIONS.map((s) => `
    <section class="hw-sec" id="hw-${s.id}">
      <h4>${s.title}${s.tag ? `<span class="hw-tag">${s.tag}</span>` : ""}</h4>
      ${table(s)}
      ${s.extra || ""}
    </section>`).join("");

  pane.innerHTML =
    `<p class="modal-hint">How usage is collected, how tokens are split, and how each vendor's cost
      is calculated. Everything stays in your browser.</p>
     <div class="hw-vendors">${jump}</div>
     ${sections}`;

  pane.querySelectorAll(".hw-jump").forEach((btn) =>
    btn.addEventListener("click", () => {
      const el = document.getElementById(`hw-${btn.dataset.hw}`);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    })
  );

  const copyBtn = document.getElementById("hwLocalCopy");
  if (copyBtn) {
    copyBtn.addEventListener("click", async () => {
      const cmd = document.getElementById("hwLocalCmd").textContent;
      try {
        await navigator.clipboard.writeText(cmd);
        flashButton(copyBtn, "Copied!");
      } catch (e) {
        flashButton(copyBtn, "Copy failed");
      }
    });
  }
  pane.dataset.rendered = "1";
}
