// extension/dashboard/settings/how-it-works.js
// Static, user-facing reference: shared concepts first, then one table per
// vendor. Diagram-first on purpose (little prose) — each flow model is drawn as
// an inline SVG at load (see views/flow-diagram.js; no third-party renderer).
// Hand-written copy — keep it in sync with docs/vendors.md when an adapter
// changes. Renders once.

// Each section: { id, title, diagrams?, caption?, head?, rows?, notes?, extra? }.
//   diagrams    -> [{ label?, flow }] flow models, each rendered into .hw-diagram.
//   caption     -> optional line under the diagrams.
//   head given  -> rows are cell arrays rendered against that header row.
//   head absent -> rows are [label, value] key/value pairs.
//   notes       -> extra [label, value] rows rendered as a second table (with head).
//   extra       -> optional HTML appended after the tables (vendor-specific how-to).
import { flashButton } from "../../shared/dom-ui.js";
import { renderFlow } from "../views/flow-diagram.js";

const SECTIONS = [
  {
    id: "cost",
    title: "How cost is calculated",
    diagrams: [
      {
        label: "Unified ON — re-price everything on your list",
        flow: {
          nodes: [
            { id: "T", label: "every vendor's tokens" },
            { id: "G", label: "match its rate group", sub: "source:model + model fingerprint" },
            { id: "R", label: "rate version effective at that time", sub: "+ peak / off-peak window" },
            { id: "C", label: "final price" },
          ],
          edges: [
            { from: "T", to: "G" },
            { from: "G", to: "R" },
            { from: "R", to: "C" },
          ],
        },
      },
      {
        label: "Unified OFF — the vendor's own price wins",
        flow: {
          nodes: [
            { id: "R", label: "vendor record" },
            { id: "Q", label: "vendor reports an amount?", shape: "decision" },
            { id: "A", label: "use that USD amount" },
            { id: "B", label: "tokens x shipped rate table" },
            { id: "C", label: "final price" },
          ],
          edges: [
            { from: "R", to: "Q" },
            { from: "Q", to: "A", label: "yes" },
            { from: "Q", to: "B", label: "no" },
            { from: "A", to: "C" },
            { from: "B", to: "C" },
          ],
        },
      },
    ],
    rows: [
      ["Formula", "input·in + (output + reasoning)·out + cacheRead·read + cacheWrite·write, all divided by 1e6. Rates are USD per 1M."],
      ["Reported amount", "opencode, OpenRouter and CommandCode report a USD amount. DeepSeek and MiMo never do — they are always derived from their shipped table."],
      ["Free models", "Priced like any other model — give the `-free` variant its own rate instead of forcing $0."],
      ["Unassigned models", "Under unified pricing a model in no group is $0 until you drag it into a group."],
    ],
  },
  {
    id: "time",
    title: "Time & dates",
    diagrams: [
      {
        flow: {
          nodes: [
            { id: "S", label: "vendor timestamp" },
            { id: "U", label: "stored as UTC" },
            { id: "L", label: "shown in your timezone" },
            { id: "P", label: "inside the vendor's peak window?", sub: "window judged in UTC", shape: "decision" },
            { id: "H", label: "peak rate" },
            { id: "O", label: "off-peak rate" },
          ],
          edges: [
            { from: "S", to: "U" },
            { from: "U", to: "L" },
            { from: "U", to: "P" },
            { from: "P", to: "H", label: "yes" },
            { from: "P", to: "O", label: "no" },
          ],
        },
      },
    ],
  },
  {
    id: "sources",
    title: "Where the data comes from",
    caption: "Every vendor — opencode included — is stored in <code>chrome.storage.local</code>.",
    diagrams: [
      {
        flow: {
          nodes: [
            { id: "O", label: "opencode Usage API" },
            { id: "E", label: "chrome.storage.local", sub: "extension storage", shape: "store" },
            { id: "R", label: ["OpenRouter / DeepSeek /", "CommandCode / MiMo"] },
            { id: "L", label: "opencode local DB import" },
            { id: "S", label: "settings + pricing" },
            { id: "D", label: "dashboard" },
          ],
          edges: [
            { from: "O", to: "E" },
            { from: "R", to: "E" },
            { from: "L", to: "E" },
            { from: "S", to: "E" },
            { from: "E", to: "D" },
          ],
        },
      },
    ],
    head: ["Data", "Stored in", "Key"],
    rows: [
      ["opencode (Usage API)", "extension", "<code>opencodeImportData</code>"],
      ["opencode snapshot", "extension", "<code>cachedData</code> / <code>cachedMeta</code>"],
      ["opencode local DB import", "extension", "<code>localImportData</code>"],
      ["OpenRouter", "extension", "<code>openrouterImportData</code>"],
      ["DeepSeek", "extension", "<code>deepseek-officialImportData</code>"],
      ["CommandCode", "extension", "<code>commandcodeImportData</code>"],
      ["MiMo", "extension", "<code>mimoImportData</code>"],
      ["settings + pricing", "extension", "<code>vendorSettings</code>, <code>unifiedPricing</code>, …"],
    ],
    notes: [
      ["Extension storage", "Every vendor's records plus settings. Tied to the extension ID — reinstalling with a different ID loses it (re-sync or re-import to restore)."],
      ["Backup", "Settings -> General -> Export Backup writes settings (JSON, includes your pricing) and every record (CSV). Import both to restore."],
      ["Data count", "opencode counts one per usage request; the other vendors count their own requests. Because the definitions differ, mixing vendors makes the total approximate."],
    ],
  },
  {
    id: "opencode",
    title: "opencode",
    head: ["Aspect", "Detail"],
    rows: [
      ["Storage", "<code>chrome.storage.local</code> (<code>opencodeImportData</code>), synced from the Console Usage API (<code>/console/api/usage/rows</code>). A local DB import lands in <code>localImportData</code>."],
      ["Granularity", "One record per request (per inference call)."],
      ["Provides", "input, output, reasoning, cacheRead, cacheWrite5m, cacheWrite1h; billing source (free/byok/credit/…); the Console-charged USD amount."],
      ["Missing", "No session id; the org id replaces the workspace id. Free/BYOK usage is tagged via the billing source."],
      ["Cost", "The Console-charged amount (<code>cost_micro_cents / 1e8</code>), otherwise estimated from the price table."],
      ["Limits", "Needs a signed-in Console tab (session cookie + <code>x-org-id</code>). Full history comes from <code>range=all</code>."],
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
    head: ["Aspect", "Detail"],
    rows: [
      ["Storage", "extension · <code>openrouterImportData</code>"],
      ["Granularity", "One row per day × model × provider."],
      ["Provides", "tokens_prompt, cached_tokens, tokens_completion, reasoning_tokens, request_count; vendor-reported USD spend."],
      ["Missing", "No cacheWrite. BYOK spend cannot be split out. No public API — the private endpoint can change."],
      ["Cost", "Vendor-reported <code>total_usage</code> (USD, 6 decimals), provider differences included."],
      ["Limits", "365 days longest; 31 days when grouped by provider."],
    ],
  },
  {
    id: "deepseek-official",
    title: "DeepSeek",
    head: ["Aspect", "Detail"],
    rows: [
      ["Storage", "extension · <code>deepseek-officialImportData</code>"],
      ["Granularity", "Hourly buckets, merged across API keys into one row per model + hour."],
      ["Provides", "PROMPT_CACHE_MISS_TOKEN, PROMPT_CACHE_HIT_TOKEN, RESPONSE_TOKEN, REQUEST."],
      ["Missing", "Reasoning is not separated (already inside output). cacheWrite is always 0. Per-key detail is kept in raw only. No export import."],
      ["Cost", "Derived from the official price table. The vendor's CNY cost is kept in raw only."],
      ["Limits", "Requires a logged-in session. One day per request; history scanned backwards in bounded windows."],
    ],
  },
  {
    id: "commandcode",
    title: "CommandCode",
    head: ["Aspect", "Detail"],
    rows: [
      ["Storage", "extension · <code>commandcodeImportData</code> — it crawls, but it does not use OPFS."],
      ["Granularity", "One row per <strong>5-minute bucket</strong> × model × provider (the endpoint's default; <code>day</code> is used only to find which days have usage). <code>requests</code> is the vendor's count for that bucket."],
      ["Provides", "tokensIn, cacheReadInputTokens, cacheCreationInputTokens, tokensOut, requests, vendor-reported totalCost."],
      ["Missing", "No export button. No per-request rows. The <code>/internal/usage</code> detail list is capped at 100 rows/window and has no cache split, so the charts path is used instead."],
      ["Cost", "Vendor-reported <code>totalCost</code>."],
      ["Limits", "~35 days back; crawl about every 3 days."],
    ],
  },
  {
    id: "mimo",
    title: "MiMo",
    head: ["Aspect", "Detail"],
    rows: [
      ["Storage", "extension · <code>mimoImportData</code>"],
      ["Granularity", "One row per model per UTC day; export by month."],
      ["Provides", "Input Miss Tokens, Input Hit Tokens, Output Tokens, Request Count."],
      ["Missing", "No reasoning, no cacheWrite. Non-token usage (audio seconds, plugin counts) ignored. The XLSX amount / currency columns are ignored."],
      ["Cost", "Derived from the official USD price table."],
      ["Limits", "Finalised daily 07:00 UTC. Import only — the crawl path is unverified."],
    ],
  },
];

function renderDiagrams(pane) {
  let i = 0;
  for (const s of SECTIONS) {
    for (let j = 0; j < (s.diagrams || []).length; j++) {
      const host = pane.querySelector(`#hw-${s.id} .hw-diagram[data-idx="${j}"]`);
      if (!host) continue;
      try {
        host.innerHTML = renderFlow(s.diagrams[j].flow, i++);
      } catch (e) {
        host.classList.add("hw-diagram--error");
        host.textContent = "diagram unavailable";
      }
    }
  }
}

export function renderHowItWorks() {
  const pane = document.getElementById("settings-how");
  if (!pane || pane.dataset.rendered === "1") return;

  const headTable = (s) => {
    const head = s.head.map((h) => `<th>${h}</th>`).join("");
    const body = s.rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("");
    return `<table class="hw-table"><tr>${head}</tr>${body}</table>`;
  };
  const kvTable = (rows) =>
    `<table class="hw-table hw-kv-table">${rows
      .map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`)
      .join("")}</table>`;
  const table = (s, rows) => (s.head ? headTable({ ...s, rows }) : kvTable(rows));

  const jump = SECTIONS.map((s) =>
    `<button type="button" class="hw-jump" data-hw="${s.id}">${s.title}</button>`
  ).join("");
  const sections = SECTIONS.map((s) => `
    <section class="hw-sec" id="hw-${s.id}">
      <h4>${s.title}</h4>
      ${(s.diagrams || [])
        .map((d, j) => `${d.label ? `<div class="hw-diagram-label">${d.label}</div>` : ""}
      <div class="hw-diagram" data-idx="${j}"></div>`)
        .join("")}
      ${s.caption ? `<p class="hw-cap">${s.caption}</p>` : ""}
      ${s.rows ? table(s, s.rows) : ""}
      ${s.notes ? kvTable(s.notes) : ""}
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
  renderDiagrams(pane);
}
