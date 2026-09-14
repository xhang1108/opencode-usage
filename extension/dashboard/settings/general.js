// extension/dashboard/settings/general.js
// General tab: default crawl vendor (D10), backup export (D24), summary.

import { saveDefaultCrawl, saveWorkspaceLabels } from "./store.js";
import { downloadText, escHTML } from "../views/format.js";
import { buildSettingsPayload, recordsToCSV } from "../../shared/backup.js";

// D24: split the backup into two non-overlapping files. Settings (JSON) carry
// the user's configuration + userPricing; records (CSV) carry every stored
// record from EVERY source (not just enabled ones) with lossless `raw`.
function exportBackup(ctx) {
  const date = new Date().toISOString().slice(0, 10);
  downloadText(`opencode-usage_settings_${date}.json`, JSON.stringify(buildSettingsPayload(ctx.settings), null, 2));
  downloadText(`opencode-usage_records_${date}.csv`, "\uFEFF" + recordsToCSV(ctx.allRecords), "text/csv;charset=utf-8");
}

export function renderGeneral(ctx) {
  const vendors = (ctx.settings.registry && ctx.settings.registry.vendors) || [];
  const crawlVendors = vendors.filter((v) => v.crawl);

  const sel = document.getElementById("generalDefaultCrawl");
  const enabledCrawl = crawlVendors.filter((v) => ctx.isEnabled(v.source));
  if (!enabledCrawl.some((v) => v.source === ctx.settings.defaultCrawl)) {
    ctx.settings.defaultCrawl = enabledCrawl.length ? enabledCrawl[0].source : "";
  }
  sel.innerHTML = crawlVendors
    .map((v) => {
      const on = ctx.isEnabled(v.source);
      return `<option value="${v.source}"${on ? "" : " disabled"}>${v.label}${on ? "" : " (disabled)"}</option>`;
    })
    .join("");
  sel.value = ctx.settings.defaultCrawl || "";
  sel.onchange = async () => {
    ctx.settings.defaultCrawl = sel.value;
    await saveDefaultCrawl(sel.value);
  };

  const enabledCount = vendors.filter((v) => ctx.isEnabled(v.source)).length;
  const targetCount = Object.keys(ctx.pricing.targets || {}).length;
  const mappedCount = Object.keys(ctx.pricing.modelMap || {}).length;
  document.getElementById("generalSummary").innerHTML =
    `<div class="settings-kv"><span>Vendors enabled</span><b>${enabledCount} / ${vendors.length}</b></div>` +
    `<div class="settings-kv"><span>Priced models (mapped)</span><b>${mappedCount}</b></div>` +
    `<div class="settings-kv"><span>Price targets</span><b>${targetCount}</b></div>` +
    `<div class="settings-kv"><span>Records loaded</span><b>${ctx.records.length.toLocaleString()}</b></div>`;

  // Storage footprint: a full re-crawl can move a lot of data, so surface it.
  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local.getBytesInUse) {
    chrome.storage.local
      .getBytesInUse(null)
      .then((bytes) => {
        const el = document.getElementById("generalSummary");
        if (el) el.insertAdjacentHTML("beforeend", `<div class="settings-kv"><span>Storage used</span><b>${(bytes / 1048576).toFixed(1)} MB</b></div>`);
      })
      .catch(() => {});
  }

  document.getElementById("generalExportFull").onclick = () => exportBackup(ctx);
  renderWorkspaces(ctx);
}

// Rename workspaces (display-only labels; the raw id is untouched so ids stay
// stable and imports stay idempotent).
function renderWorkspaces(ctx) {
  const wrap = document.getElementById("generalWorkspaces");
  if (!wrap) return;
  const byWs = new Map();
  for (const rec of ctx.records || []) {
    const source = rec.source || "opencode";
    const id = `${source}:${rec.workspaceID || "wrk_unknown"}`;
    const entry = byWs.get(id) || { id, source, count: 0 };
    entry.count++;
    byWs.set(id, entry);
  }
  const list = [...byWs.values()].sort((a, b) => String(a.source).localeCompare(String(b.source)) || String(a.id).localeCompare(String(b.id)));
  if (list.length === 0) {
    wrap.innerHTML = '<div class="notice">No workspaces yet.</div>';
    return;
  }
  wrap.innerHTML = "";
  for (const ws of list) {
    const row = document.createElement("div");
    row.className = "settings-inbox-row";
    row.innerHTML =
      `<div class="settings-inbox-key"><code>${escHTML(ws.id)}</code>` +
      `<span class="settings-inbox-age">${escHTML(ws.source)} · ${ws.count} records</span></div>` +
      `<input type="text" class="input" data-ws="${escHTML(ws.id)}" placeholder="Name this workspace" value="${escHTML(ctx.settings.workspaceLabels[ws.id] || "")}">`;
    const input = row.querySelector("input");
    input.addEventListener("change", async () => {
      const next = { ...ctx.settings.workspaceLabels };
      const value = input.value.trim();
      if (value) next[ws.id] = value;
      else delete next[ws.id];
      ctx.settings.workspaceLabels = next;
      await saveWorkspaceLabels(next);
      await ctx.reload();
    });
    wrap.appendChild(row);
  }
}
