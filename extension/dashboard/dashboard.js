// dashboard.js — thin entry for the multi-vendor dashboard.
// Data loading, the pricing engine, settings storage and all DOM rendering live
// in ./core, ./settings and ./views; this file only wires them together.

import { inclusiveDayDiff, localDateOf } from "./core/time.js";
import { aggregate } from "./core/aggregate.js";
import { priceWithConfig, legacyModelsFromPricing } from "./core/pricing-config.js";
import { createFilters } from "./views/filters.js";
import { createCharts } from "./views/charts.js";
import { wireTableSort, renderWorkspaceTable, renderModelTable } from "./views/tables.js";
import { createTimeReminder } from "./views/time-reminder.js";
import { initDecorBg } from "./views/decor.js";
import { fmtMoney, escHTML, workspaceName } from "./views/format.js";
import { readSettings, loadPricing, loadUnifiedPreset, isSourceEnabled, saveVendorSettings, saveUnifiedPricing, saveDefaultCrawl, saveWorkspaceLabels, saveUnmappedFirstSeen } from "./settings/store.js";
import { normalizeUnifiedPricing, buildUnifiedIndex, priceUnified, unifiedRateModels } from "../shared/unified.js";
import { createSettingsModal } from "./settings/tabs.js";
import { renderGeneral } from "./settings/general.js";
import { renderVendors } from "./settings/vendors.js";
import { renderUnified } from "./settings/unified.js";
import { renderDatabase } from "./settings/database.js";
import { renderHowItWorks } from "./settings/how-it-works.js";
import { parseXlsx } from "../shared/xlsx.js";
import { parseMimoSheets } from "../vendors/mimo/import-usage.js";
import { SETTINGS_FORMAT, csvToRecords, groupBySource, parseSettingsPayload } from "../shared/backup.js";

const globalCache = {};
let settings = null;
let pricing = { modelMap: {}, targets: {} };
let unifiedPricing = normalizeUnifiedPricing(null);
let unifiedIndex = new Map();
// Per-source cost basis: "vendor" uses the vendor-reported spend, "derived"
// computes from token rates. Populated from the vendor registry.
let costSource = {};

// Table sort state. dir: 1 = ascending, -1 = descending.
const sortState = {
  ws: { col: "cost", dir: -1 },
  model: { col: "cost", dir: -1 },
};

const isEnabled = (source) => isSourceEnabled(source, settings ? settings.vendorSettings : {});
const enabledRecords = () =>
  Object.values(globalCache).filter((rec) => isEnabled(rec.source || "opencode"));
// Per-record price memo. A record's cost depends only on the record and the
// live pricing config, so it is safe to cache by id until the config reloads.
// Keeps filter/table re-renders from re-pricing the whole set (in-memory only;
// nothing is written back to storage).
let priceCache = new Map();
const price = (rec) => {
  const key = rec.id || rec.recId || null;
  if (key != null) {
    const hit = priceCache.get(key);
    if (hit) return hit;
  }
  const out = unifiedPricing.enabled ? priceUnified(rec, unifiedIndex) : priceWithConfig(rec, pricing, costSource);
  if (key != null) priceCache.set(key, out);
  return out;
};
const getRateModels = () => (unifiedPricing.enabled ? unifiedRateModels(unifiedPricing) : legacyModelsFromPricing(pricing));
const wsLabel = (wsID) => workspaceName(wsID, settings ? settings.workspaceLabels : {});

// B7: every model with at least one unpriced record among the enabled sources.
function globalUnpricedModels() {
  const set = new Set();
  for (const rec of enabledRecords()) {
    if (price(rec).unpriced) set.add(rec.model);
  }
  return set;
}

// Record first-seen timestamps for the current unpriced set (pruning the ones
// that got priced), returning the map used to show age. Persisted async.
function syncUnmappedFirstSeen(models) {
  const prev = (settings && settings.unmappedFirstSeen) || {};
  const now = Date.now();
  const next = {};
  let changed = false;
  for (const m of models) {
    next[m] = prev[m] != null ? prev[m] : now;
    if (prev[m] == null) changed = true;
  }
  for (const k of Object.keys(prev)) if (!(k in next)) changed = true;
  if (changed && settings) {
    settings.unmappedFirstSeen = next;
    saveUnmappedFirstSeen(next).catch(() => {});
  }
  return next;
}

const charts = createCharts({
  getRecords: enabledRecords,
  getPrice: price,
  getFilters: () => ({ selectedWorkspace: filters.selectedWorkspace(), selectedModel: filters.selectedModel() }),
});
const filters = createFilters({
  getRecords: enabledRecords,
  localDateOf,
  onChange: () => renderDashboard(),
  getWorkspaceLabel: wsLabel,
});
const timeReminder = createTimeReminder({ getRateModels });

const settingsCtx = {
  get settings() {
    return settings;
  },
  set settings(v) {
    settings = v;
  },
  get pricing() {
    return pricing;
  },
  get records() {
    return enabledRecords();
  },
  // D24: every stored record regardless of vendor enabled state, for backups.
  get allRecords() {
    return Object.values(globalCache);
  },
  get presetSources() {
    return presetSources;
  },
  isEnabled,
  isVendorCost: (source) => (costSource[source] || "derived") === "vendor",
  refreshData: async () => {
    await reloadAfterImportClear();
    renderSettingsPage(settingsModal.getActive());
  },
  reload: async () => {
    await reloadSettings();
    filters.updateDropdowns();
    filters.initDateRange();
    renderDashboard();
    renderSettingsPage(settingsModal.getActive());
  },
};
let presetSources = new Set();

const settingsModal = createSettingsModal({ renderPage: renderSettingsPage });

function renderSettingsPage(tab) {
  if (!settings) return;
  if (tab === "general") { renderGeneral(settingsCtx); refreshLocalImportStatus(); }
  else if (tab === "vendors") renderVendors(settingsCtx);
  else if (tab === "pricing") renderUnified(settingsCtx);
  else if (tab === "database") renderDatabase(settingsCtx);
  else if (tab === "how") renderHowItWorks();
}

async function reloadSettings() {
  settings = await readSettings();
  // No stored pricelist yet -> start from the shipped default preset.
  unifiedPricing = settings.unifiedStored ? settings.unifiedPricing : await loadUnifiedPreset();
  settings.unifiedPricing = unifiedPricing;
  unifiedIndex = buildUnifiedIndex(unifiedPricing);
  pricing = await loadPricing(settings);
  priceCache = new Map();
  costSource = {};
  for (const v of (settings.registry && settings.registry.vendors) || []) {
    if (v && v.source) costSource[v.source] = v.costSource || "derived";
  }
  presetSources = new Set(
    await Promise.all(
      ((settings.registry && settings.registry.vendors) || []).map(async (v) => {
        try {
          const res = await fetch(chrome.runtime.getURL(`vendors/${v.source}/rates.preset.json`));
          return res.ok ? v.source : null;
        } catch (e) {
          return null;
        }
      })
    ).then((list) => list.filter(Boolean))
  );
  timeReminder.mirrorRates();
  await timeReminder.reloadModels();
}

function renderDashboard(skipCharts) {
  skipCharts = skipCharts === true;
  const tableScrolls = Array.from(document.querySelectorAll(".table-container")).map((el) => ({ el, top: el.scrollTop }));

  const selectedWS = filters.selectedWorkspace();
  const selectedModel = filters.selectedModel();
  const startDate = filters.startDate();
  let endDate = filters.endDate();
  if (startDate && !endDate) endDate = startDate;

  const records = enabledRecords();
  const agg = aggregate(records, { price, startDate, endDate, selectedWS, selectedModel });
  const { dailyMap, dailyTokenMap, hourlyMap, modelMap, wsMap, singleModelDailyMap } = agg;
  // B7: unpriced set is global (not filter-scoped) so the Settings badge and the
  // notice stay meaningful regardless of the current filter.
  const unpricedModels = globalUnpricedModels();
  const firstSeen = syncUnmappedFirstSeen(unpricedModels);
  const oldestDays = unpricedModels.size > 0
    ? Math.max(0, Math.floor((Date.now() - Math.min(...Object.values(firstSeen))) / 86400000))
    : 0;
  const pricingBadge = document.getElementById("pricingUnmappedBadge");
  if (pricingBadge) {
    pricingBadge.hidden = unpricedModels.size === 0;
    pricingBadge.textContent = String(unpricedModels.size);
  }
  const totalReq = agg.totals.req;
  const totalCost = agg.totals.cost;
  const totalSavings = agg.totals.savings;
  const totalTokens = agg.totals.tokens;
  const totalPrompt = agg.totals.prompt;
  const totalCacheRead = agg.totals.cacheRead;

  document.getElementById("statRequests").innerText = totalReq.toLocaleString();
  document.getElementById("statCost").innerText = `$${fmtMoney(totalCost)}`;
  document.getElementById("statSavings").innerText = `Cache savings: $${fmtMoney(totalSavings)}`;
  document.getElementById("statTokens").innerText = totalTokens.toLocaleString();
  document.getElementById("statHitRate").innerText = totalPrompt > 0 ? `${((totalCacheRead / totalPrompt) * 100).toFixed(2)}%` : "0.00%";
  document.getElementById("statHitRateMax").innerText = agg.maxHitRate !== null ? `Max: ${agg.maxHitRate.toFixed(2)}%` : "Max: -";
  document.getElementById("statHitRateMin").innerText = agg.minHitRate !== null ? `Min: ${agg.minHitRate.toFixed(2)}%` : "Min: -";
  document.getElementById("statAvgCostPerReq").innerText = `Avg per data: $${totalReq > 0 ? fmtMoney(totalCost / totalReq, 5) : "0.00000"}`;
  document.getElementById("statAvgTokens").innerText = `Avg tokens/data: ${totalReq > 0 ? Math.round(totalTokens / totalReq).toLocaleString() : 0}`;

  let avgTokensPerDay = 0;
  if (startDate && endDate) {
    const days = inclusiveDayDiff(startDate, endDate);
    avgTokensPerDay = days > 0 ? totalTokens / days : 0;
  } else if (agg.minDate && agg.maxDate) {
    const days = inclusiveDayDiff(agg.minDate, agg.maxDate);
    avgTokensPerDay = days > 0 ? totalTokens / days : 0;
  }
  document.getElementById("statAvgTokensPerDay").innerText = `Avg tokens/day: ${Math.round(avgTokensPerDay).toLocaleString()}`;
  const statSplit = document.getElementById("statSplit");
  if (statSplit) {
    statSplit.innerHTML =
      `<span>Peak</span><span>$${fmtMoney(agg.totals.peakCost)}</span>` +
      `<span>Off-peak</span><span>$${fmtMoney(agg.totals.offpeakCost)}</span>` +
      `<span>Flat</span><span>$${fmtMoney(agg.totals.flatCost)}</span>`;
  }

  const unpricedEl = document.getElementById("unpricedList");
  if (unpricedEl) {
    if (unpricedModels.size > 0) {
      unpricedEl.hidden = false;
      unpricedEl.innerHTML =
        `<strong>Unpriced models (${unpricedModels.size})</strong>` +
        `<span class="notice-badges">` +
        Array.from(unpricedModels)
          .sort()
          .map((m) => `<span class="badge">${escHTML(m)}</span>`)
          .join("") +
        `</span>` +
        `<span class="notice-hint">— Assign them to a group in Settings → Pricing to price them${oldestDays > 0 ? ` (oldest ${oldestDays}d)` : ""}.</span>`;
    } else {
      unpricedEl.hidden = true;
    }
  }

  document.getElementById("statTopModel").innerText = agg.topModel;
  document.getElementById("statTopModelCost").innerText = `Cost: $${fmtMoney(agg.topModelCost)}`;

  renderWorkspaceTable(wsMap, sortState.ws, wsLabel);
  renderModelTable({ modelMap, singleModelDailyMap, selectedModel, sortState: sortState.model });

  // The yearly heatmap ignores the date range; keep it outside skipCharts.
  charts.renderYearlyHeatmap();

  if (!skipCharts) {
    charts.renderDashboardCharts({ dailyMap, dailyTokenMap, hourlyMap, modelMap, endDate });
  }

  for (const { el, top } of tableScrolls) el.scrollTop = top;
}

function showEmptyStateIfNeeded() {
  if (Object.keys(globalCache).length > 0) return;
  const container = document.querySelector(".container");
  if (!container || container.querySelector(".empty-state")) return;
  const notice = document.createElement("div");
  notice.className = "notice empty-state";
  notice.innerHTML =
    `No usage data yet. Open the <strong>opencode.ai</strong> usage page and click ` +
    `<strong>Crawl Now</strong> in the extension popup to sync records, or run ` +
    `<strong>tools/import-local.mjs</strong> and add the JSON via <strong>Import Usage</strong>.`;
  container.prepend(notice);
}

async function loadFromExtension() {
  try {
    if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) {
      showEmptyStateIfNeeded();
      return;
    }
    await reloadSettings();

    const res = await chrome.runtime.sendMessage({ type: "get-dashboard-data" });
    if (!res || !res.ok || !res.data) {
      showEmptyStateIfNeeded();
      return;
    }
    const data = JSON.parse(res.data);
    for (const [id, rec] of Object.entries(data)) {
      globalCache[id] = rec.source ? rec : { ...rec, source: "opencode" };
    }
    filters.initDateRange();
    filters.updateDropdowns();
    renderDashboard();
    showEmptyStateIfNeeded();

  } catch (e) {
    console.error("Failed to load data", e);
    showEmptyStateIfNeeded();
  }
}

// ===== Local records (Settings -> General) =====
// The JSON itself is imported through the one Import Usage entry; this only
// reports how many local records are stored and lets the user clear them.
async function refreshLocalImportStatus() {
  const el = document.getElementById("generalLocalStatus");
  if (!el) return;
  try {
    const res = await chrome.runtime.sendMessage({ type: "get-local-status" });
    if (res && res.ok && res.totalLocal > 0) {
      const when = res.updatedAt ? new Date(res.updatedAt).toLocaleString() : "unknown time";
      el.innerHTML = `Local records: <strong>${res.totalLocal.toLocaleString()}</strong> (imported ${when}). Re-import the latest export to update.`;
    } else {
      el.textContent = "No local records imported yet.";
    }
  } catch (e) {
    el.textContent = "No local records imported yet.";
  }
}
async function reloadAfterImportClear() {
  for (const k of Object.keys(globalCache)) delete globalCache[k];
  charts.resetSelectedDate();
  await loadFromExtension();
}

// ===== Event wiring =====
document.getElementById("btnSettings").addEventListener("click", () => settingsModal.open("general"));
document.getElementById("btnImportExport").addEventListener("click", () => document.getElementById("importExportFile").click());
document.getElementById("importExportFile").addEventListener("change", async (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = "";
  if (files.length) await importVendorExports(files);
});

// D17: one import entry. Each selected file is dispatched by type, so a single
// pick may mix types (e.g. a MiMo .xlsx + an opencode .json). Per-file failures
// don't abort the batch; one combined summary is shown at the end.
async function importVendorExports(files) {
  const lines = [];
  let okCount = 0;
  for (const file of files) {
    try {
      lines.push(`✓ ${await importVendorExport(file)}`);
      okCount++;
    } catch (err) {
      lines.push(`✗ ${file.name}: ${(err && err.message) || err}`);
    }
  }
  if (okCount > 0) {
    lines.push("Tip: enable each vendor in Settings -> Vendors to see it.");
    await reloadAfterImportClear();
  }
  alert(lines.join("\n"));
}

// Dispatch one file to its parser by extension. A .csv or an
// opencode-usage-settings .json is our own backup (D24) and is restored;
// any other .json is an opencode local DB export; .xlsx is a MiMo export.
async function importVendorExport(file) {
  const name = file && file.name ? file.name : "";
  if (/\.xlsx$/i.test(name)) return await importMimoXlsx(file);
  if (/\.csv$/i.test(name)) return await importRecordsCSV(file);
  if (/\.json$/i.test(name)) return await importJSONFile(file);
  throw new Error("unsupported type (expected .csv, .json or .xlsx)");
}

async function importJSONFile(file) {
  const text = await file.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error("invalid JSON");
  }
  if (parsed && parsed.format === SETTINGS_FORMAT) return await restoreSettings(parsed);
  return await importOpencodeJSON(text);
}

// Restore the settings half of a backup (records live in the CSV).
async function restoreSettings(payload) {
  const patch = parseSettingsPayload(payload);
  if (patch.vendorSettings) await saveVendorSettings(patch.vendorSettings);
  if (patch.unifiedPricing) await saveUnifiedPricing(patch.unifiedPricing);
  if (patch.defaultCrawl != null) await saveDefaultCrawl(patch.defaultCrawl);
  if (patch.workspaceLabels) await saveWorkspaceLabels(patch.workspaceLabels);
  if (patch.unmappedFirstSeen) await saveUnmappedFirstSeen(patch.unmappedFirstSeen);
  // A restored vendorSettings may enable optional vendors; re-sync their runtime
  // content scripts so crawl works without a manual toggle (B1/B2).
  if (patch.vendorSettings) {
    await chrome.runtime.sendMessage({ type: "sync-vendor-scripts" }).catch(() => {});
  }
  return `settings restored (${Object.keys(patch).length} section${Object.keys(patch).length === 1 ? "" : "s"})`;
}

// Restore the records half of a backup: group by source and stash each group
// where its live data lives (id-keyed merge, so re-importing is idempotent).
async function importRecordsCSV(file) {
  const records = csvToRecords(await file.text());
  if (records.length === 0) throw new Error("no valid records found in the CSV");
  const vendorSources = new Set(
    ((settings && settings.registry && settings.registry.vendors) || [])
      .map((v) => v && v.source)
      .filter((s) => s && s !== "opencode")
  );
  const parts = [];
  let unknown = 0;
  for (const [source, recs] of groupBySource(records)) {
    if (source === "opencode") {
      const map = {};
      for (const rec of recs) map[rec.id] = rec;
      const res = await chrome.runtime.sendMessage({ type: "import-local-data", data: JSON.stringify(map) });
      if (!res || !res.ok) throw new Error((res && res.error) || "opencode restore failed");
      parts.push(`opencode: ${res.imported}`);
    } else if (vendorSources.has(source)) {
      const res = await chrome.runtime.sendMessage({ type: "vendor-crawl-data", source, records: recs });
      if (!res || !res.ok) throw new Error((res && res.error) || `${source} restore failed`);
      parts.push(`${source}: ${res.added} new (${res.count} stored)`);
    } else {
      unknown += recs.length;
    }
  }
  if (unknown > 0) parts.push(`${unknown} skipped (unknown source)`);
  return `records restored — ${parts.join(", ")}`;
}

async function importMimoXlsx(file) {
  const { sheets } = await parseXlsx(await file.arrayBuffer());
  const records = parseMimoSheets(sheets);
  if (records.length === 0) throw new Error("no MiMo usage rows found in the XLSX");
  const res = await chrome.runtime.sendMessage({ type: "vendor-crawl-data", source: "mimo", records });
  if (!res || !res.ok) throw new Error((res && res.error) || "unknown error");
  await chrome.runtime.sendMessage({ type: "vendor-crawl-done", source: "mimo" });
  return `MiMo: ${res.added} new (${res.count} stored)`;
}

async function importOpencodeJSON(text) {
  const res = await chrome.runtime.sendMessage({ type: "import-local-data", data: text });
  if (!res || !res.ok) throw new Error((res && res.error) || "unknown error");
  return `opencode: ${res.imported} imported (${res.newRecords} new)`;
}
// Local records live in Settings -> General (status + clear); the JSON itself
// goes through the one Import Usage entry (see importOpencodeJSON above).
document.getElementById("generalLocalCopy").addEventListener("click", async () => {
  const cmd = document.getElementById("generalLocalCmd").textContent;
  const btn = document.getElementById("generalLocalCopy");
  const flash = (msg) => {
    if (!btn) return;
    const orig = btn.textContent;
    btn.textContent = msg;
    setTimeout(() => { btn.textContent = orig; }, 1500);
  };
  try {
    await navigator.clipboard.writeText(cmd);
    flash("Copied!");
  } catch (e) {
    flash("Copy failed");
  }
});
document.getElementById("generalLocalClear").addEventListener("click", async () => {
  if (!confirm("Remove all locally imported records? Crawled data is kept.")) return;
  try {
    const res = await chrome.runtime.sendMessage({ type: "clear-local-data" });
    if (res && res.ok) {
      alert(`Cleared ${res.cleared} local records (${res.total} records remain).`);
      await reloadAfterImportClear();
      refreshLocalImportStatus();
    } else {
      alert("Clear failed: " + ((res && res.error) || "unknown error"));
    }
  } catch (err) {
    alert("Clear failed: " + (err && err.message ? err.message : String(err)));
  }
});

wireTableSort({ sortState, onChange: () => renderDashboard(true) });
charts.wire();
filters.wire();

loadFromExtension();
if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
  timeReminder.init().catch((e) => console.error(e));
}
initDecorBg();
