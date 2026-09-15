// extension/dashboard/settings/general.js
// General tab: default crawl vendor (D10), summary, workspaces.

import { saveDefaultCrawl, saveWorkspaceLabels } from "./store.js";
import { escHTML } from "../views/format.js";
import { initCustomSelect } from "../views/filters.js";
import { workspaceList, summaryModel } from "./general-model.js";

// Styled dropdown matching the filter bar; the hidden native <select> stays the
// source of truth, so only the presentation changes.
let crawlSelect = null;
function ensureCrawlSelect() {
  if (!crawlSelect) {
    crawlSelect = initCustomSelect(
      "generalDefaultCrawl",
      "generalDefaultCrawlTrigger",
      "generalDefaultCrawlLabel",
      "generalDefaultCrawlPanel",
      "generalDefaultCrawlOptions"
    );
  }
  return crawlSelect;
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
  ensureCrawlSelect().refresh();
  sel.onchange = async () => {
    ctx.settings.defaultCrawl = sel.value;
    await saveDefaultCrawl(sel.value);
  };

  const summary = summaryModel({ vendors, isEnabled: ctx.isEnabled, pricing: ctx.pricing, records: ctx.records });
  document.getElementById("generalSummary").innerHTML =
    `<div class="settings-kv"><span>Vendors enabled</span><b>${summary.enabledCount} / ${summary.vendorCount}</b></div>` +
    `<div class="settings-kv"><span>Priced models (mapped)</span><b>${summary.mappedCount}</b></div>` +
    `<div class="settings-kv"><span>Price targets</span><b>${summary.targetCount}</b></div>` +
    `<div class="settings-kv"><span>Records loaded</span><b>${summary.recordsCount.toLocaleString()}</b></div>`;

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

  renderWorkspaces(ctx);
}

// Rename workspaces (display-only labels; the raw id is untouched so ids stay
// stable and imports stay idempotent).
function renderWorkspaces(ctx) {
  const wrap = document.getElementById("generalWorkspaces");
  if (!wrap) return;
  const list = workspaceList(ctx.records);
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
