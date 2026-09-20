// extension/dashboard/settings/how-it-works.js
// Static, user-facing reference: shared concepts first, then one section per
// vendor, generated from the vendor descriptors (vendors/<source>/vendor.json)
// so the copy can never drift from the adapters. Diagram-first on purpose
// (little prose) — each flow model is drawn as an inline SVG at load (see
// views/flow-diagram.js; no third-party renderer). Renders once.

// Each section: { id, title, diagrams?, caption?, head?, rows?, bullets?, notes?, extra? }.
//   diagrams    -> [{ label?, flow }] flow models, each rendered into .hw-diagram.
//   caption     -> optional line under the diagrams.
//   head given  -> rows are cell arrays rendered against that header row.
//   head absent -> rows are [label, value] key/value pairs.
//   bullets     -> plain-string list (HTML-escaped; `code` spans allowed).
//   notes       -> extra [label, value] rows rendered as a second table (with head).
//   extra       -> optional HTML appended after the tables (vendor-specific how-to).
import { flashButton } from "../../shared/dom-ui.js";
import { renderFlow } from "../views/flow-diagram.js";

// Extra how-to appended to the opencode vendor section.
const OPENCODE_EXTRA =
  `<div class="settings-section-title">Local usage import</div>
   <p>Export your local opencode database, then add the JSON via <strong>Import Usage</strong>. Serves models the server no longer reports (e.g. free models).</p>
   <div class="cmd-box">
     <code id="hwLocalCmd">node tools/import-local.mjs --out opencode_local_records.json</code>
     <button class="btn btn-secondary" id="hwLocalCopy">Copy</button>
   </div>`;

const BASE_SECTIONS = [
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
    id: "syncing",
    title: "Syncing",
    rows: [
      ["Trigger", "Manual by default — the popup's <strong>Sync</strong> button, or <strong>Settings → Vendors → Sync now</strong>. Hold <strong>Shift</strong> (or shift-click) for a <strong>Full Sync</strong> that re-fetches all history."],
      ["Incremental", "opencode rows arrive newest-first, so a sync stops once a page reaches the newest stored record. Other vendors resume from their newest stored date with a one-day overlap."],
      ["Auto-sync", "opencode only, every 6h (<strong>Settings → Vendors</strong>). It reuses an open Console tab, or opens one in the background and closes it afterwards."],
      ["Rate limits", "On HTTP 429/503 the opencode client honours <code>Retry-After</code> (or backs off 1s, 2s, 4s, 8s) before retrying."],
      ["Requirements", "opencode needs a signed-in Console tab; every other vendor needs its origin granted and, for DeepSeek, a logged-in session."],
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
            { id: "R", label: ["OpenRouter / DeepSeek /", "CommandCode"] },
            { id: "M", label: "MiMo XLSX import" },
            { id: "L", label: "opencode local DB import" },
            { id: "S", label: "settings + pricing" },
            { id: "D", label: "dashboard" },
          ],
          edges: [
            { from: "O", to: "E" },
            { from: "R", to: "E" },
            { from: "M", to: "E" },
            { from: "L", to: "E" },
            { from: "S", to: "E" },
            { from: "E", to: "D" },
          ],
        },
      },
    ],
    head: ["Data", "Key"],
    rows: [
      ["Every vendor's synced records", "<code>&lt;source&gt;ImportData</code> — one store per vendor (e.g. <code>opencodeImportData</code>)"],
      ["Local opencode DB import", "<code>localImportData</code>"],
      ["Merged snapshot", "<code>cachedData</code> / <code>cachedMeta</code>"],
      ["Settings + pricing", "<code>vendorSettings</code>, <code>unifiedPricing</code>, …"],
    ],
    notes: [
      ["Extension storage", "Every vendor's records plus settings. Tied to the extension ID — reinstalling with a different ID loses it (re-sync or re-import to restore)."],
      ["Backup", "Settings -> General -> Export Backup writes settings (JSON, includes your pricing) and every record (CSV). Import both to restore."],
      ["Data count", "opencode counts one per usage request; the other vendors count their own requests. Because the definitions differ, mixing vendors makes the total approximate."],
    ],
  },
];

// One section per vendor, in registry order with opencode first. The prose comes
// from each descriptor's `notes` (rendered as bullets), so adding or changing an
// adapter only means editing vendors/<source>/vendor.json.
async function loadVendorSections(registry) {
  const vendors = ((registry && registry.vendors) || []).slice();
  vendors.sort((a, b) => {
    if (a.source === "opencode") return -1;
    if (b.source === "opencode") return 1;
    return String(a.label || a.source).localeCompare(String(b.label || b.source));
  });
  const sections = [];
  for (const v of vendors) {
    let notes = [];
    try {
      const res = await fetch(chrome.runtime.getURL(`vendors/${v.source}/vendor.json`));
      if (res.ok) {
        const json = await res.json();
        if (Array.isArray(json.notes)) notes = json.notes;
      }
    } catch (e) {}
    sections.push({
      id: v.source,
      title: v.label || v.source,
      bullets: notes,
      extra: v.source === "opencode" ? OPENCODE_EXTRA : undefined,
    });
  }
  return sections;
}

function escHTML(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
// Escape a vendor note, then turn `code` spans into <code>.
function formatNote(s) {
  return escHTML(s).replace(/`([^`]+)`/g, "<code>$1</code>");
}

function renderDiagrams(pane, sections) {
  let i = 0;
  for (const s of sections) {
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

export async function renderHowItWorks(registry) {
  const pane = document.getElementById("settings-how");
  if (!pane || pane.dataset.rendered === "1") return;
  pane.dataset.rendered = "1";

  const sections = [...BASE_SECTIONS, ...(await loadVendorSections(registry))];

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

  const jump = sections.map((s) =>
    `<button type="button" class="hw-jump" data-hw="${s.id}">${s.title}</button>`
  ).join("");
  const sectionsHtml = sections.map((s) => `
    <section class="hw-sec" id="hw-${s.id}">
      <h4>${s.title}</h4>
      ${(s.diagrams || [])
        .map((d, j) => `${d.label ? `<div class="hw-diagram-label">${d.label}</div>` : ""}
      <div class="hw-diagram" data-idx="${j}"></div>`)
        .join("")}
      ${s.caption ? `<p class="hw-cap">${s.caption}</p>` : ""}
      ${s.rows ? table(s, s.rows) : ""}
      ${s.bullets && s.bullets.length
        ? `<ul class="hw-list">${s.bullets.map((b) => `<li>${formatNote(b)}</li>`).join("")}</ul>`
        : ""}
      ${s.notes ? kvTable(s.notes) : ""}
      ${s.extra || ""}
    </section>`).join("");

  pane.innerHTML =
    `<p class="modal-hint">How usage is collected, how tokens are split, and how each vendor's cost
      is calculated. Everything stays in your browser.</p>
     <div class="hw-vendors">${jump}</div>
     ${sectionsHtml}`;

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
  renderDiagrams(pane, sections);
}
