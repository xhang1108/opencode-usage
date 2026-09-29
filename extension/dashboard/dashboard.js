// dashboard.js — thin entry for the multi-vendor dashboard.
// Data loading, the pricing engine, settings storage and all DOM rendering live
// in ./core, ./settings and ./views; this file only wires them together.

import { inclusiveDayDiff, localDateOf } from "./core/time.js";
import { aggregate, createAggregator, computeUnpricedSet } from "./core/aggregate.js";
import { priceWithConfig, legacyModelsFromPricing, shouldPassthroughVendorCost, priceVendorCost } from "./core/pricing-config.js";
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
import { csvToRecords, parseSettingsPayload } from "../shared/backup.js";
import { normalizeRecord } from "../shared/canonical.js";
import {
  classifyImport,
  isSettingsPayload,
  planRecordsImport,
  describeSettingsRestore,
  mergeFirstSeen,
} from "./core/import-plan.js";

const globalCache = {};
let settings = null;
let pricing = { modelMap: {}, targets: {} };
let unifiedPricing = normalizeUnifiedPricing(null);
let unifiedIndex = new Map();
// Per-source cost basis: "vendor" uses the vendor-reported spend, "derived"
// computes from token rates. Populated from the vendor registry.
// `passthroughSources` (registry `unifiedPassthrough`) keeps a source's vendor
// spend even when unified pricing is on (no token-rate expression exists).
let costSource = {};
let passthroughSources = {};

// Set once the first load has finished. Until then, interactive handlers are
// ignored so they cannot render against an empty cache or call chart code with
// a null map (the pre-load TypeError this gate exists to prevent).
let dataReady = false;

// Bumped whenever settings/pricing/records are reloaded, so caches that depend
// on them (the unpriced-model set) recompute only then — not on every filter.
let dataVersion = 0;
let unpricedCache = { version: -1, set: new Set() };

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
  const out = unifiedPricing.enabled && !shouldPassthroughVendorCost(rec, passthroughSources)
    ? priceUnified(rec, unifiedIndex)
    : shouldPassthroughVendorCost(rec, passthroughSources)
      ? priceVendorCost(rec, pricing)
      : priceWithConfig(rec, pricing, costSource);
  if (key != null) priceCache.set(key, out);
  return out;
};
const getRateModels = () => (unifiedPricing.enabled ? unifiedRateModels(unifiedPricing) : legacyModelsFromPricing(pricing));
const wsLabel = (wsID) => workspaceName(wsID, settings ? settings.workspaceLabels : {});

// B7: every model with at least one unpriced record among the enabled sources.
// Memoized by dataVersion: filter/date changes cannot alter the result.
function globalUnpricedModels() {
  if (unpricedCache.version === dataVersion) return unpricedCache.set;
  const set = computeUnpricedSet(enabledRecords(), price);
  unpricedCache = { version: dataVersion, set };
  return set;
}

// Record first-seen timestamps for the current unpriced set (pruning the ones
// that got priced), returning the map used to show age. Persisted async.
function syncUnmappedFirstSeen(models) {
  const { next, changed } = mergeFirstSeen(settings && settings.unmappedFirstSeen, models);
  if (changed && settings) {
    settings.unmappedFirstSeen = next;
    saveUnmappedFirstSeen(next).catch(() => {});
  }
  return next;
}

const charts = createCharts({ isReady: () => dataReady });
const filters = createFilters({
  getRecords: enabledRecords,
  localDateOf,
  onChange: () => {
    if (dataReady) renderDashboard();
  },
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
  if (tab === "general") renderGeneral(settingsCtx);
  else if (tab === "vendors") renderVendors(settingsCtx);
  else if (tab === "pricing") renderUnified(settingsCtx);
  else if (tab === "database") renderDatabase(settingsCtx);
  else if (tab === "how") renderHowItWorks(settings.registry);
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
  passthroughSources = {};
  for (const v of (settings.registry && settings.registry.vendors) || []) {
    if (v && v.source) costSource[v.source] = v.costSource || "derived";
    if (v && v.source && v.unifiedPassthrough) passthroughSources[v.source] = true;
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
  dataVersion++;
}

function renderDashboard(skipCharts, aggOverride) {
  skipCharts = skipCharts === true;
  const tableScrolls = Array.from(document.querySelectorAll(".table-container")).map((el) => ({ el, top: el.scrollTop }));

  const selectedWS = filters.selectedWorkspace();
  const selectedModel = filters.selectedModel();
  const startDate = filters.startDate();
  let endDate = filters.endDate();
  if (startDate && !endDate) endDate = startDate;

  // aggOverride lets the staged loader hand in an accumulator produced with
  // yields; filter-driven renders compute it synchronously here instead.
  const agg = aggOverride || aggregate(enabledRecords(), { price, startDate, endDate, selectedWS, selectedModel });
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

  // The yearly heatmap ignores the date range; keep it outside skipCharts. Its
  // per-day maps come from the aggregate pass (Step 9), so it never re-scans.
  charts.renderYearlyHeatmap(agg.dailyAll, agg.hourlyAll);

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

// Yield control back to the browser between chunks/slices of the load. Chrome
// 129+ has scheduler.yield(); older builds fall back to a macrotask. The gate
// stays honest either way because rendering is what we yield around, not a timer.
const LOAD_CHUNK = 5000;
function yieldToMain() {
  if (globalThis.scheduler && typeof globalThis.scheduler.yield === "function") {
    return globalThis.scheduler.yield();
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// Full-screen loading overlay shown until the first render is done. Reuses the
// page's existing `.modal-overlay` (same backdrop/z-index/centering as Settings)
// so it matches the app's flat theme; inner styling uses theme.css tokens only.
// Countable stages report a real n/N; single-shot stages are labelled only —
// never a fake percentage (see the plan §6.3). Held a minimum time so a fast
// load doesn't flash past unseen.
const LOAD_PROGRESS_MIN_MS = 600;
let loadProgress = null;
function startLoadProgress() {
  if (!document.getElementById("dashboardLoadStyle")) {
    const style = document.createElement("style");
    style.id = "dashboardLoadStyle";
    style.textContent =
      "@keyframes dashboardLoadSpin{to{transform:rotate(360deg)}}" +
      "#dashboardLoadOverlay .load-box{display:flex;flex-direction:column;align-items:center;gap:14px;}" +
      "#dashboardLoadOverlay .load-spinner{width:32px;height:32px;border-radius:50%;" +
      "border:2px solid var(--border);border-top-color:var(--primary);" +
      "animation:dashboardLoadSpin 0.8s linear infinite;}" +
      "#dashboardLoadOverlay .load-text{color:var(--text-muted);font-size:12.5px;" +
      "font-family:var(--font-mono);letter-spacing:0.02em;}" +
      "@media (prefers-reduced-motion: reduce){#dashboardLoadOverlay .load-spinner{animation:none;}}";
    document.head.appendChild(style);
  }

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.id = "dashboardLoadOverlay";
  overlay.setAttribute("role", "status");
  overlay.setAttribute("aria-live", "polite");

  const box = document.createElement("div");
  box.className = "load-box";
  const spinner = document.createElement("div");
  spinner.className = "load-spinner";
  const text = document.createElement("div");
  text.className = "load-text";
  text.textContent = "Loading…";
  box.appendChild(spinner);
  box.appendChild(text);
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  const startedAt = performance.now();
  const api = {
    stage(label, done, total) {
      text.textContent =
        typeof done === "number" && typeof total === "number" && total > 0
          ? `${label}… ${done.toLocaleString()} / ${total.toLocaleString()}`
          : `${label}…`;
    },
    done() {
      const hide = () => {
        overlay.remove();
        loadProgress = null;
      };
      const elapsed = performance.now() - startedAt;
      if (elapsed < LOAD_PROGRESS_MIN_MS) setTimeout(hide, LOAD_PROGRESS_MIN_MS - elapsed);
      else hide();
    },
  };
  loadProgress = api;
  return api;
}

async function loadFromExtension() {
  const progress = startLoadProgress();
  const report = (label, done, total) => {
    if (progress) progress.stage(label, done, total);
  };
  try {
    if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) {
      showEmptyStateIfNeeded();
      return;
    }
    report("Loading settings");
    await yieldToMain(); // let the progress line paint before the first real await
    await reloadSettings();
    await yieldToMain();

    report("Reading stored data");
    const res = await chrome.runtime.sendMessage({ type: "get-dashboard-data" });
    if (!res || !res.ok || !res.data) {
      showEmptyStateIfNeeded();
      return;
    }

    report("Parsing records");
    const data = JSON.parse(res.data);
    await yieldToMain();

    // Normalize on ingest (chunked so the main thread can breathe) so every
    // record carries `time`/numeric tokens before pricing/aggregation.
    const entries = Object.entries(data);
    for (let i = 0; i < entries.length; i += LOAD_CHUNK) {
      const end = Math.min(i + LOAD_CHUNK, entries.length);
      for (let j = i; j < end; j++) {
        const [id, rec] = entries[j];
        const src = rec.source ? rec : { ...rec, source: "opencode" };
        globalCache[id] = normalizeRecord(src) || src;
      }
      report("Preparing records", end, entries.length);
      if (end < entries.length) await yieldToMain();
    }

    filters.initDateRange();
    filters.updateDropdowns();

    // Aggregate in chunks with yields, then hand the finished result to the
    // synchronous renderer. This is the cold 444 ms block made interruptible.
    const selectedWS = filters.selectedWorkspace();
    const selectedModel = filters.selectedModel();
    const startDate = filters.startDate();
    let endDate = filters.endDate();
    if (startDate && !endDate) endDate = startDate;
    const records = enabledRecords();
    const acc = createAggregator({ price, startDate, endDate, selectedWS, selectedModel });
    for (let i = 0; i < records.length; i += LOAD_CHUNK) {
      const end = Math.min(i + LOAD_CHUNK, records.length);
      acc.push(records.slice(i, end));
      report("Aggregating", end, records.length);
      if (end < records.length) await yieldToMain();
    }

    report("Drawing charts");
    renderDashboard(false, acc.finish());
    showEmptyStateIfNeeded();
  } catch (e) {
    console.error("Failed to load data", e);
    showEmptyStateIfNeeded();
  } finally {
    if (loadProgress) loadProgress.done();
    dataReady = true;
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
  const kind = classifyImport(file && file.name);
  if (kind === "xlsx") return await importMimoXlsx(file);
  if (kind === "csv") return await importRecordsCSV(file);
  if (kind === "json") return await importJSONFile(file);
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
  if (isSettingsPayload(parsed)) return await restoreSettings(parsed);
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
  return describeSettingsRestore(patch);
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
  const plan = planRecordsImport(records, vendorSources);
  const parts = [];
  const localCount = Object.keys(plan.localMap).length;
  if (localCount > 0) {
    const res = await chrome.runtime.sendMessage({ type: "import-local-data", data: JSON.stringify(plan.localMap) });
    if (!res || !res.ok) throw new Error((res && res.error) || "opencode restore failed");
    const dup = res.duplicates ? `, ${res.duplicates} duplicates merged` : "";
    const enr = res.filled ? ` (${res.filled} enriched)` : "";
    parts.push(`opencode: ${res.newRecords} new${dup}${enr}`);
  } else {
    parts.push("opencode: nothing to restore");
  }
  for (const { source, records: recs } of plan.vendors) {
    const res = await chrome.runtime.sendMessage({ type: "vendor-crawl-data", source, records: recs });
    if (!res || !res.ok) throw new Error((res && res.error) || `${source} restore failed`);
    parts.push(`${source}: ${res.added} new (${res.count} stored)`);
  }
  if (plan.unknownCount > 0) parts.push(`${plan.unknownCount} skipped (unknown source)`);
  return `records restored — ${parts.join(", ")}`;
}

async function importMimoXlsx(file) {
  const { sheets } = await parseXlsx(await file.arrayBuffer());
  const records = parseMimoSheets(sheets);
  if (records.length === 0) throw new Error("no MiMo usage rows found in the XLSX; ensure the file contains daily data (YYYY-MM-DD), not monthly summaries (YYYY-MM)");
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
// Per-store deletion (incl. local records) lives in Settings -> Database; the
// local import how-to and export command live in Settings -> How it works
// (opencode); the JSON itself goes through the one Import Usage entry (see
// importOpencodeJSON above).

wireTableSort({ sortState, onChange: () => { if (dataReady) renderDashboard(true); } });
charts.wire();
filters.wire();

// Start the decorative canvas paused so it cannot compete with the load, then
// resume once the first render has settled (loadFromExtension never rejects).
const decor = initDecorBg({ paused: true });
loadFromExtension().finally(() => decor.setPaused(false));
if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
  timeReminder.init().catch((e) => console.error(e));
}
