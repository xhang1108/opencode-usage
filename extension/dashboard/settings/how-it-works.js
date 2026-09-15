// extension/dashboard/settings/how-it-works.js
// Static, user-facing reference: shared concepts first, then one table per
// vendor. Diagram-first on purpose (little prose) — mermaid source is rendered
// at load. Hand-written copy — keep it in sync with docs/vendors.md when an
// adapter changes. Renders once.

// Each section: { id, title, diagrams?, caption?, head?, rows?, notes?, extra? }.
//   diagrams    -> [{ label?, src }] mermaid sources, each rendered into .hw-diagram.
//   caption     -> optional line under the diagrams.
//   head given  -> rows are cell arrays rendered against that header row.
//   head absent -> rows are [label, value] key/value pairs.
//   notes       -> extra [label, value] rows rendered as a second table (with head).
//   extra       -> optional HTML appended after the tables (vendor-specific how-to).
import { flashButton } from "../../shared/dom-ui.js";

const FONT = '"Berkeley Mono", "IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace';

const SECTIONS = [
  {
    id: "cost",
    title: "How cost is calculated",
    diagrams: [
      {
        label: "Unified ON — re-price everything on your list",
        src: `flowchart LR
    T["every vendor's tokens"] --> G["match its rate group<br/>source:model + model fingerprint"]
    G --> R["rate version effective at that time<br/>+ peak / off-peak window"]
    R --> C["final price"]`,
      },
      {
        label: "Unified OFF — the vendor's own price wins",
        src: `flowchart LR
    R["vendor record"] --> Q{"vendor reports<br/>an amount?"}
    Q -->|"yes"| A["use that USD amount"]
    Q -->|"no"| B["tokens x shipped rate table"]
    A --> C["final price"]
    B --> C`,
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
        src: `flowchart LR
    S["vendor timestamp"] --> U["stored as UTC"] --> L["shown in your timezone"]
    U --> P{"inside the vendor's peak window?<br/>window judged in UTC"}
    P -->|"yes"| H["peak rate"]
    P -->|"no"| O["off-peak rate"]`,
      },
    ],
  },
  {
    id: "sources",
    title: "Where the data comes from",
    caption: "Only opencode uses OPFS. Every other vendor — CommandCode included — is stored in <code>chrome.storage.local</code>.",
    diagrams: [
      {
        src: `flowchart LR
    O["opencode crawl"] --> F[("OPFS<br/>opencode.ai origin")]
    F --> E[("chrome.storage.local<br/>extension storage")]
    R["OpenRouter / DeepSeek /<br/>CommandCode / MiMo"] --> E
    L["opencode local DB import"] --> E
    S["settings + pricing"] --> E
    E --> D["dashboard"]`,
      },
    ],
    head: ["Data", "Stored in", "Key"],
    rows: [
      ["opencode crawl", "OPFS on the <code>opencode.ai</code> origin", "<code>opencode_token_cache_&lt;workspace&gt;.json</code>"],
      ["opencode crawl snapshot", "extension", "<code>cachedData</code> / <code>cachedMeta</code>"],
      ["opencode local DB import", "extension", "<code>localImportData</code>"],
      ["OpenRouter", "extension", "<code>openrouterImportData</code>"],
      ["DeepSeek", "extension", "<code>deepseek-officialImportData</code>"],
      ["CommandCode", "extension", "<code>commandcodeImportData</code>"],
      ["MiMo", "extension", "<code>mimoImportData</code>"],
      ["settings + pricing", "extension", "<code>vendorSettings</code>, <code>unifiedPricing</code>, …"],
    ],
    notes: [
      ["OPFS", "Only the opencode crawl raw cache. Owned by the page crawler and read-only for the dashboard. Survives an extension reinstall, a folder move and a settings reset."],
      ["Extension storage", "Everything else. Tied to the extension ID — reinstalling with a different ID loses it (re-crawl or re-import to restore)."],
      ["Backup", "Settings -> General -> Export Backup writes settings (JSON, includes your pricing) and every record (CSV). Import both to restore."],
      ["Data count", "opencode counts one per usage record; the other vendors count their own requests. Because the definitions differ, mixing vendors makes the total approximate."],
    ],
  },
  {
    id: "opencode",
    title: "opencode",
    head: ["Aspect", "Detail"],
    rows: [
      ["Storage", "OPFS on the <code>opencode.ai</code> origin (<code>opencode_token_cache_&lt;workspace&gt;.json</code>), plus a snapshot in <code>chrome.storage.local</code>. A local DB import lands in <code>localImportData</code>."],
      ["Granularity", "One record per usage record."],
      ["Provides", "input, output, reasoning, cacheRead, cacheWrite5m, cacheWrite1h; a USD amount when the console reports one."],
      ["Missing", "No request count. The console omits free-model usage — import the local DB for that. The reported amount is sometimes null."],
      ["Cost", "The reported amount when present, otherwise estimated from the price table."],
      ["Limits", "Session id rotates each redeploy (auto re-captured). Full rescan stalls ~198 pages. Crawl daily; keep the tab visible."],
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

async function renderDiagrams(pane) {
  const mermaid = window.mermaid;
  if (!mermaid) return; // extension page ships lib/mermaid.min.js; skip if absent.
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "base",
    fontFamily: FONT,
    flowchart: { curve: "basis", htmlLabels: true, padding: 10 },
    themeVariables: {
      background: "transparent",
      fontFamily: FONT,
      fontSize: "12px",
      primaryColor: "#1c1c1f",
      primaryTextColor: "#f2eded",
      primaryBorderColor: "#38383a",
      secondaryColor: "#161618",
      tertiaryColor: "#131010",
      lineColor: "#68686f",
      textColor: "#b8b2b2",
      edgeLabelBackground: "#131010",
    },
  });

  let i = 0;
  for (const s of SECTIONS) {
    for (let j = 0; j < (s.diagrams || []).length; j++) {
      const host = pane.querySelector(`#hw-${s.id} .hw-diagram[data-idx="${j}"]`);
      if (!host) continue;
      try {
        const { svg } = await mermaid.render(`hw-mmd-${i++}`, s.diagrams[j].src);
        host.innerHTML = svg;
      } catch (e) {
        host.classList.add("hw-diagram--error");
        host.textContent = s.diagrams[j].src;
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
