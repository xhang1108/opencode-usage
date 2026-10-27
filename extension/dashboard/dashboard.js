// dashboard.js — thin entry for the multi-vendor dashboard.
// Data loading, the pricing engine, settings storage and all DOM rendering live
// in ./core, ./settings and ./views; this file only wires them together.

import { inclusiveDayDiff, localDateOf } from "./core/time.js";
import { aggregate, createAggregator, computeUnpricedSet } from "./core/aggregate.js";
import { aggregateSpend, computeRoi } from "../shared/spend.js";
import { priceWithConfig, legacyModelsFromPricing, shouldPassthroughVendorCost, priceVendorCost } from "./core/pricing-config.js";
import { createFilters } from "./views/filters.js";
import { createCharts } from "./views/charts.js";
import { wireTableSort, renderWorkspaceTable, renderModelTable } from "./views/tables.js";
import { createTimeReminder } from "./views/time-reminder.js";
import { initDecorBg } from "./views/decor.js";
import { fmtMoney, escHTML, workspaceName } from "./views/format.js";
import { readSettings, loadPricing, loadUnifiedPreset, isSourceEnabled, saveVendorSettings, saveUnifiedPricing, saveUnifiedPricingBackup, loadUnifiedPricingBackup, saveDefaultCrawl, saveWorkspaceLabels, saveUnmappedFirstSeen, saveSpendEntries } from "./settings/store.js";
import { normalizeUnifiedPricing, buildUnifiedIndex, priceUnified, unifiedRateModels } from "../shared/unified.js";
import { computePresetDrift } from "../shared/preset-drift.js";
import { createSettingsModal } from "./settings/tabs.js";
import { renderGeneral } from "./settings/general.js";
import { renderVendors } from "./settings/vendors.js";
import { renderUnified } from "./settings/unified.js";
import { renderDatabase } from "./settings/database.js";
import { renderSpend } from "./settings/spend.js";
import { renderHowItWorks } from "./settings/how-it-works.js";
import { parseXlsx } from "../shared/xlsx.js";
import { parseMimoSheets } from "../vendors/mimo/import-usage.js";
import { csvToRecords, csvToSpendEntries, parseSettingsPayload } from "../shared/backup.js";
import { normalizeRecord } from "../shared/canonical.js";
import {
  chunkRecords,
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
// `passthroughSources` (registry `unifiedPassthrough`) keeps a source's vendor
// spend even when unified pricing is on (no token-rate expression exists).
let passthroughSources = {};

// Set once the first load has finished. Until then, interactive handlers are
// ignored so they cannot render against an empty cache or call chart code with
// a null map (the pre-load TypeError this gate exists to prevent).
let dataReady = false;

// Bumped whenever settings/pricing/records are reloaded, so caches that depend
// on them (the unpriced-model set) recompute only then — not on every filter.
let dataVersion = 0;
let unpricedCache = { version: -1, set: new Set() };

// The shipped pricelist, fetched once per page (an extension update means a new
// page, so this cannot go stale across versions) and compared against the
// stored one to spot users whose saved list missed an update.
let shippedPreset = null;
let driftCache = { version: -1, value: null };
// "idle" until the notice's one-click update runs, then "done" while Undo is
// still offered (reset back to "idle" by Undo).
let presetResetState = "idle";

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
      : priceWithConfig(rec, pricing);
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

// How far the stored pricelist has fallen behind the shipped one, for the
// dashboard notice. Memoized like the unpriced set: it only depends on the
// priced config, the stored list and the records.
function globalPresetDrift() {
  if (driftCache.version === dataVersion) return driftCache.value;
  const value =
    settings && settings.unifiedStored && unifiedPricing.enabled && shippedPreset
      ? computePresetDrift({ stored: unifiedPricing, shipped: shippedPreset, records: enabledRecords() })
      : null;
  driftCache = { version: dataVersion, value };
  return value;
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
  isEnabled,
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
const settingsModal = createSettingsModal({ renderPage: renderSettingsPage });

function renderSettingsPage(tab) {
  if (!settings) return;
  if (tab === "general") renderGeneral(settingsCtx);
  else if (tab === "vendors") renderVendors(settingsCtx);
  else if (tab === "pricing") renderUnified(settingsCtx);
  else if (tab === "database") renderDatabase(settingsCtx);
  else if (tab === "spend") renderSpend(settingsCtx);
  else if (tab === "how") renderHowItWorks(settings.registry);
}

async function reloadSettings() {
  settings = await readSettings();
  // Fetched once per page: it is both the fallback when nothing is stored and
  // the yardstick the stored list is compared against (globalPresetDrift). A
  // failed/empty read stays null so the update offer can never wipe the list.
  if (!shippedPreset) {
    const shipped = await loadUnifiedPreset();
    shippedPreset = shipped.groups.length > 0 ? shipped : null;
  }
  // No stored pricelist yet -> start from the shipped default preset.
  unifiedPricing = settings.unifiedStored ? settings.unifiedPricing : normalizeUnifiedPricing(shippedPreset);
  settings.unifiedPricing = unifiedPricing;
  unifiedIndex = buildUnifiedIndex(unifiedPricing);
  pricing = await loadPricing(settings);
  priceCache = new Map();
  passthroughSources = {};
  for (const v of (settings.registry && settings.registry.vendors) || []) {
    if (v && v.source && v.unifiedPassthrough) passthroughSources[v.source] = true;
  }
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

  const spendAgg = aggregateSpend(settings && settings.spendEntries ? settings.spendEntries : [], { startDate, endDate });
  const roi = computeRoi(totalCost, spendAgg.totalSpent);
  const spendEl = document.getElementById("statSpend");
  if (spendEl) spendEl.textContent = `$${fmtMoney(spendAgg.totalSpent, 2)}`;
  const ratioEl = document.getElementById("statValueRatio");
  if (ratioEl) {
    const ratioText = roi.ratio === null ? "-" : `${roi.ratio.toFixed(2)}x`;
    ratioEl.textContent = `Value: $${fmtMoney(totalCost)} · Ratio: ${ratioText}`;
  }

  document.getElementById("statRequests").innerText = totalReq.toLocaleString();
  document.getElementById("statCost").innerText = `$${fmtMoney(totalCost)}`;
  document.getElementById("statSavings").innerText = `Cache savings: $${fmtMoney(totalSavings)}`;
  document.getElementById("statTokens").innerText = totalTokens.toLocaleString();
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
    // A stored list saved before an extension update can leave models unpriced
    // (or mispriced) with no hint that a newer shipped list fixes it. Offer the
    // refresh right here so the user never has to find Settings -> Pricing.
    const drift = globalPresetDrift();
    const offerUpdate = !!(drift && drift.offer && presetResetState === "idle");
    const showUndo = presetResetState === "done";
    if (unpricedModels.size > 0 || offerUpdate || showUndo) {
      const head =
        unpricedModels.size > 0
          ? `<strong>Unpriced models (${unpricedModels.size})</strong>` +
            `<span class="notice-badges">` +
            Array.from(unpricedModels)
              .sort()
              .map((m) => `<span class="badge">${escHTML(m)}</span>`)
              .join("") +
            `</span>` +
            `<span class="notice-hint">— Assign them to a group in Settings → Pricing to price them${oldestDays > 0 ? ` (oldest ${oldestDays}d)` : ""}.</span>`
          : `<strong>Price list out of date</strong>`;
      let action = "";
      if (offerUpdate) {
        const detail =
          drift.recoverableCount > 0
            ? `The shipped price list prices <strong>${drift.recoverableCount}</strong> of these models.`
            : `The shipped price list bills <strong>${drift.repricedCount}</strong> of your models differently.`;
        // A custom assignment the shipped list does not have would be lost, so
        // say it up front instead of letting the reset quietly unprice it.
        const loss =
          drift.lostCount > 0
            ? ` It would leave ${drift.lostCount} model${drift.lostCount === 1 ? "" : "s"} you priced yourself unpriced.`
            : "";
        action =
          `<div class="notice-action"><span>${detail}${loss} Replaces your saved list with the shipped one; Undo restores it.</span>` +
          `<button type="button" class="btn btn-primary" id="presetRefresh">Update price list</button></div>`;
      } else if (showUndo) {
        action =
          `<div class="notice-action"><span>Price list updated to the shipped preset.</span>` +
          `<button type="button" class="btn btn-secondary" id="presetUndo">Undo</button></div>`;
      }
      unpricedEl.hidden = false;
      unpricedEl.innerHTML = head + action;
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
    // A refresh failure must never swallow the per-file summary: one bad file
    // silently looking like "nothing imported" is exactly what this reports.
    try {
      await reloadAfterImportClear();
    } catch (err) {
      lines.push(`Reload failed: ${(err && err.message) || err} — re-open the dashboard.`);
    }
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
  if (patch.spendEntries) await saveSpendEntries(patch.spendEntries);
  // A restored vendorSettings may enable optional vendors; re-sync their runtime
  // content scripts so crawl works without a manual toggle (B1/B2).
  if (patch.vendorSettings) {
    await chrome.runtime.sendMessage({ type: "sync-vendor-scripts" }).catch(() => {});
  }
  return describeSettingsRestore(patch);
}

// Restore the records half of a backup: group by source and stash each group
// where its live data lives (id-keyed merge, so re-importing is idempotent).
// The same CSV also carries spend-ledger rows (kind="spend"); those are merged
// by id into the stored ledger instead of being treated as usage.
async function importRecordsCSV(file) {
  const text = await file.text();
  const records = csvToRecords(text);
  const spendEntries = csvToSpendEntries(text);
  if (records.length === 0 && spendEntries.length === 0) {
    throw new Error("no valid records found in the CSV");
  }
  const parts = [];
  if (records.length > 0) {
    const vendorSources = new Set(
      ((settings && settings.registry && settings.registry.vendors) || [])
        .map((v) => v && v.source)
        .filter((s) => s && s !== "opencode")
    );
    const plan = planRecordsImport(records, vendorSources);
    const localRecords = Object.values(plan.localMap);
    if (localRecords.length > 0) {
      // Chunked: one oversized message can hit Chrome's payload/storage ceiling
      // and fail the whole file as a single ✗ with nothing restored.
      let newRecords = 0;
      let duplicates = 0;
      let filled = 0;
      for (const chunk of chunkRecords(localRecords)) {
        const map = {};
        for (const rec of chunk) map[rec.id] = rec;
        const res = await chrome.runtime.sendMessage({ type: "import-local-data", data: JSON.stringify(map) });
        if (!res || !res.ok) throw new Error((res && res.error) || "opencode restore failed");
        newRecords += res.newRecords || 0;
        duplicates += res.duplicates || 0;
        filled += res.filled || 0;
      }
      const dup = duplicates ? `, ${duplicates} duplicates merged` : "";
      const enr = filled ? ` (${filled} enriched)` : "";
      const none = newRecords === 0 ? " — no new records" : "";
      parts.push(`opencode: ${newRecords} new${dup}${enr}${none}`);
    } else {
      parts.push("opencode: nothing to restore");
    }
    for (const { source, records: recs } of plan.vendors) {
      let added = 0;
      let stored = 0;
      for (const chunk of chunkRecords(recs)) {
        const res = await chrome.runtime.sendMessage({ type: "vendor-crawl-data", source, records: chunk });
        if (!res || !res.ok) throw new Error((res && res.error) || `${source} restore failed`);
        added += res.added || 0;
        stored = res.count || stored;
      }
      parts.push(`${source}: ${added} new (${stored} stored)`);
    }
    if (plan.unknownCount > 0) parts.push(`${plan.unknownCount} skipped (unknown source)`);
  }
  if (spendEntries.length > 0) {
    const byId = new Map(((settings && settings.spendEntries) || []).map((e) => [e.id, e]));
    for (const e of spendEntries) byId.set(e.id, e);
    const merged = [...byId.values()];
    await saveSpendEntries(merged);
    if (settings) settings.spendEntries = merged;
    parts.push(`spend: ${spendEntries.length} entries`);
  }
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

// ===== One-click price list update (dashboard notice) =====
// The stored list was saved by an older version. Back it up first so the reset
// is reversible from the same notice, then write the shipped list with the
// user's on/off choice kept.
async function applyShippedPreset() {
  if (!shippedPreset) return;
  await saveUnifiedPricingBackup(unifiedPricing);
  const preset = normalizeUnifiedPricing(shippedPreset);
  preset.enabled = unifiedPricing.enabled;
  await saveUnifiedPricing(preset);
  presetResetState = "done";
  await settingsCtx.reload();
}

async function undoShippedPreset() {
  const prev = await loadUnifiedPricingBackup();
  if (!prev) return;
  await saveUnifiedPricing(prev);
  presetResetState = "idle";
  await settingsCtx.reload();
}

document.getElementById("unpricedList").addEventListener("click", (e) => {
  const btn = e.target && e.target.closest ? e.target.closest("button") : null;
  if (!btn || btn.disabled) return;
  // A second click before the reload would back up the freshly reset list and
  // lose the original, so the button is one-shot.
  if (btn.id === "presetRefresh") {
    btn.disabled = true;
    applyShippedPreset().catch((err) => {
      btn.disabled = false;
      console.error(err);
    });
  } else if (btn.id === "presetUndo") {
    btn.disabled = true;
    undoShippedPreset().catch((err) => {
      btn.disabled = false;
      console.error(err);
    });
  }
});

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
