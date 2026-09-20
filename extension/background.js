// background.js - Manages the icon badge and popup message routing (export / manual sync / status).
// Module service worker (manifest "type": "module"): it imports the shared pure
// modules directly, so there are no inlined copies to drift out of sync.
import {
  TIME_RATES_KEY,
  TIME_ENABLED_KEY,
  TIME_MODEL_KEY,
  loadTimeRates,
  loadTimeModel,
  loadTimeEnabled,
  saveTimeModel,
  listPeakModels,
  collectPeakWindowsForModel,
  nextPeakBoundary,
  formatLocalTime,
  formatUtcTime,
  isPeakAt,
} from "./shared/time-reminder.js";
import {
  DEDUP_BUCKET_MS,
  fingerprintOf,
  buildFingerprintBuckets,
  hideDayAnchoredImportCopies,
  isLocalLooking,
  recordFingerprints,
} from "./shared/merge.js";
import { STORAGE_SCHEMA_VERSION, pendingMigrations, planMigrations } from "./shared/migrate.js";
import { LOCAL_STORE_KEY, VENDOR_STORE_PREFIX } from "./shared/stores.js";

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  switch (msg.type) {
    case "crawl-start": {
      setBadge(sender, "...", "#d69b3c");
      chrome.storage.local.set({
        crawlState: { running: true, page: 0, workspace: msg.workspace || "", rescan: !!msg.rescan },
      });
      sendResponse({ ok: true });
      break;
    }

    case "progress": {
      const page = msg.page || 0;
      const label = page >= 1000 ? `${(page / 1000).toFixed(1)}k` : String(page);
      setBadge(sender, label, "#d69b3c");
      chrome.storage.local.get("crawlState", ({ crawlState }) => {
        chrome.storage.local.set({
          crawlState: { ...(crawlState || {}), running: true, page, message: msg.message || "" },
        });
      });
      sendResponse({ ok: true });
      break;
    }

    case "error":
    case "info": {
      setBadge(sender, msg.type === "error" ? "ERR" : "", msg.type === "error" ? "#cc6f66" : "#a1a1a6");
      if (msg.type === "error") closeAutoSyncTab();
      if (msg.type === "error") try { chrome.action.setBadgeText({ text: "ERR" }); } catch (e) {}
      if (msg.type === "error") notifyCrawl("Sync failed", msg.message || "Unknown error — reopen the popup for details.");
      chrome.storage.local.get("crawlState", ({ crawlState }) => {
        if (msg.type === "error") {
          chrome.storage.local.set({ crawlState: { running: false, error: msg.message || "" } });
        } else {
          chrome.storage.local.set({
            crawlState: { ...(crawlState || {}), running: false, message: msg.message || "" },
          });
        }
      });
      sendResponse({ ok: true });
      break;
    }

    case "start-crawl":
      (msg.vendor && msg.vendor !== "opencode"
        ? sendStartVendorCrawl(msg.vendor, msg.days, !!(msg.full || msg.rescan))
        : sendStartOpencodeCrawl(!!(msg.full || msg.rescan))
      )
        .then(sendResponse)
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;

    case "vendor-crawl-data":
      handleVendorCrawlData(msg)
        .then(sendResponse)
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;

    case "vendor-crawl-done":
      handleVendorCrawlDone(msg)
        .then(sendResponse)
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;

    case "get-status":
      sendGetStatus()
        .then(sendResponse)
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;

    case "open-dashboard":
      handleOpenDashboard()
        .then(sendResponse)
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;

    case "get-dashboard-data":
      // Dashboard page always fetches from here (on every load/refresh), so it
      // never depends on a one-shot payload that can be consumed once.
      sendDashboardData()
        .then(sendResponse)
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;

    case "import-local-data":
      // Records exported by tools/import-local.mjs from the local opencode.db.
      handleLocalImport(msg)
        .then(sendResponse)
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;

    case "clear-local-data":
      // Drop the local import and rebuild the snapshot from synced data only.
      handleClearLocal()
        .then(sendResponse)
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;

    case "clear-vendor-data":
      // Drop one vendor's stored records (<source>ImportData) and rebuild.
      handleClearVendorData(msg)
        .then(sendResponse)
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;

    case "sync-vendor-scripts":
      // Re-register runtime content scripts after the user grants a vendor's
      // optional origin (B1/B2).
      syncVendorContentScripts()
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
      return true;

    case "remove-records":
      // D11: delete specific records from the stores background owns — the
      // opencode API sync, the local DB import, and every vendor map — then
      // rebuild the snapshot.
      handleRemoveRecords(msg)
        .then(sendResponse)
        .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
      return true;

    case "get-database":
      // Settings → Database tab: every usage store + where it lives.
      handleGetDatabase()
        .then(sendResponse)
        .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
      return true;

    case "get-local-status":
      sendLocalStatus()
        .then(sendResponse)
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;
  }
});

function setBadge(sender, text, color) {
  // Global badge so it's visible even when the sync tab isn't active / popup just closed
  try { chrome.action.setBadgeText({ text }); } catch (e) {}
  try { chrome.action.setBadgeBackgroundColor({ color }); } catch (e) {}
  const tabId = sender && sender.tab && sender.tab.id;
  if (tabId === undefined || tabId === null) return;
  chrome.action.setBadgeText({ tabId, text });
  chrome.action.setBadgeBackgroundColor({ tabId, color });
}

function notifyCrawl(title, message) {
  try {
    chrome.notifications.create({
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title,
      message,
    });
  } catch (e) {}
}

// Send a message to the tab's content script; if it isn't injected yet (the tab was
// opened before the extension loaded), inject it first and retry.
async function sendMessageToTab(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch (e) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["vendors/opencode/api.js"] });
    await new Promise((r) => setTimeout(r, 300)); // Give the injected content script time to initialize
    return await chrome.tabs.sendMessage(tabId, msg);
  }
}

// opencode now syncs through the Console Usage API (vendors/opencode/api.js)
// instead of the old RSC /_server crawl. The API needs the org from a
// /console/<org>/ page (session cookie + x-org-id header), so ensure a Console
// tab is open and pass the incremental `since` from the newest stored record.
async function sendStartOpencodeCrawl(full) {
  const tabs = await chrome.tabs.query({ url: ["https://opencode.ai/*"] });
  let tab = tabs.find((t) => t.url && /^https:\/\/opencode\.ai\/console\/(?:org_|wrk_)/.test(t.url)) || null;
  if (!tab) {
    tab = await chrome.tabs.create({ url: "https://opencode.ai/console" });
    // /console redirects to the default workspace; wait until an org is in the URL.
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const t = await chrome.tabs.get(tab.id).catch(() => null);
      if (t && t.url && /\/console\/(?:org_|wrk_)/.test(t.url)) break;
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["vendors/opencode/api.js"] });
      } catch (e) {}
    }
  }
  const knownNewest = full ? null : await newestStoredTime("opencode");
  try { await chrome.tabs.update(tab.id, { active: true }); } catch (e) {}
  const res = await sendMessageToTab(tab.id, { type: "start-crawl", vendor: "opencode", knownNewest, full: !!full });
  return res && res.ok ? { ...res, openedUsage: !tabs.length } : res;
}

// ===== Generic vendor crawl routing (content-script vendors) =====
// Crawl config (origins / content script / home / default days) is read from the
// generated registry (shared/vendors.json ← vendors/<source>/vendor.json), so a
// new vendor needs no edit here.
function crawlConfigFromRegistry(registry, vendor) {
  const v = ((registry && registry.vendors) || []).find(
    (x) => x && x.source === vendor && x.crawl && x.crawlScript
  );
  if (!v) return null;
  return {
    origins: v.origins || [],
    script: v.crawlScript,
    home: v.crawlHome,
    defaultDays: v.crawlDefaultDays || 0,
  };
}

async function sendStartVendorCrawl(vendor, days, full) {
  const registry = await loadVendorRegistry();
  const cfg = crawlConfigFromRegistry(registry, vendor);
  if (!cfg) return { ok: false, error: `Unknown crawl vendor: ${vendor}` };
  // B1: a non-default vendor's origin is optional; crawling without it just
  // fails silently, so tell the user where to grant it.
  if (cfg.origins.length > 0) {
    let granted = true;
    try {
      granted = await chrome.permissions.contains({ origins: cfg.origins });
    } catch (e) {
      granted = true;
    }
    if (!granted) {
      return {
        ok: false,
        error: `Access to ${cfg.origins.join(", ")} is not granted. Open the dashboard → Settings → Vendors and click "Grant access" for ${vendor}.`,
      };
    }
  }
  // Incremental: newest stored date lets the content script resume from there
  // (D12, one-day overlap). No stored data -> full range.
  const since = full ? null : await newestStoredDate(vendor);
  let tab = (await chrome.tabs.query({ url: cfg.origins }))[0] || null;
  if (!tab) {
    tab = await chrome.tabs.create({ url: cfg.home });
    await new Promise((r) => setTimeout(r, 1500));
  }
  const message = { type: "start-crawl", vendor, days: days || cfg.defaultDays, since, full: !!full };
  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch (e) {
    // Content script not injected yet (tab opened before the extension loaded).
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [cfg.script] });
    await new Promise((r) => setTimeout(r, 300));
    return await chrome.tabs.sendMessage(tab.id, message);
  }
}

// Newest local date ("YYYY-MM-DD") already stored for a vendor, or null.
async function newestStoredDate(source) {
  const map = await getVendorImportMap(source);
  let max = null;
  for (const rec of Object.values(map)) {
    const d = (rec && rec.date) || (rec && rec.time ? String(rec.time).slice(0, 10) : null);
    if (d && (!max || d > max)) max = d;
  }
  return max;
}

// Newest stored `time` (ISO) for a vendor, or null. Used as the early-stop
// marker for the opencode API sync: rows come newest-first, so once a page
// reaches this timestamp everything older is already stored and the crawl stops.
async function newestStoredTime(source) {
  const map = await getVendorImportMap(source);
  let max = null;
  for (const rec of Object.values(map)) {
    const t = rec && rec.time;
    if (t && (!max || t > max)) max = t;
  }
  return max;
}

async function handleVendorCrawlData(msg) {
  const source = msg && msg.source;
  if (!(await getVendorImportSources()).includes(source)) return { ok: false, error: `Unknown source: ${source}` };
  const records = msg && msg.records;
  if (!Array.isArray(records) || records.length === 0) return { ok: true, stored: 0 };

  const map = await getVendorImportMap(source);
  let added = 0;
  for (const rec of records) {
    if (!rec || typeof rec !== "object" || !rec.id || !rec.model) continue;
    if (!map[rec.id]) added++;
    map[rec.id] = rec;
  }
  const count = Object.keys(map).length;
  try {
    await chrome.storage.local.set({
      [`${source}ImportData`]: JSON.stringify(map),
      [`${source}ImportMeta`]: { count, updatedAt: Date.now() },
    });
  } catch (e) {
    return { ok: false, error: `Storage quota exceeded - cannot keep ${count} ${source} records (${e.message || e})` };
  }
  return { ok: true, stored: records.length, added, count };
}

async function handleVendorCrawlDone(msg) {
  const source = msg && msg.source;
  const newRecords = (msg && msg.newRecords) || 0;
  if (source === "opencode") closeAutoSyncTab();
  try {
    chrome.action.setBadgeText({ text: "" });
  } catch (e) {}
  const importSources = await getVendorImportSources();
  const count = importSources.includes(source) ? Object.keys(await getVendorImportMap(source)).length : 0;
  // Refresh the merged snapshot so popup/dashboard see the new records without
  // an opencode tab.
  let total = count;
  try {
    const res = await sendDashboardData();
    if (res && res.ok) total = res.count;
  } catch (e) {}
  await chrome.storage.local.set({
    lastSyncAt: Date.now(),
    lastSyncCount: newRecords,
    totalRecords: total,
    crawlState: {
      running: false,
      done: true,
      vendor: source,
      warning: count === 0, // B10: crawler returned nothing
      message: count === 0 ? `${source} crawl returned no records` : "",
    },
  });
  const label = (source || "vendor") === "openrouter" ? "OpenRouter" : source;
  notifyCrawl(
    "Sync complete",
    newRecords > 0
      ? `${label}: ${newRecords} new records (${count} stored, ${total} total).`
      : `${label}: already up to date (${count} stored, ${total} total).`
  );
  return { ok: true, source, count, total, newRecords };
}

// Drop one vendor's stored records and rebuild the merged snapshot. Used when a
// vendor's id scheme or mapping changes (e.g. CommandCode detail -> charts) so
// old and new records don't coexist and double-count.
async function handleClearVendorData(msg) {
  const source = msg && msg.source;
  if (!(await getVendorImportSources()).includes(source)) return { ok: false, error: `Unknown source: ${source}` };
  const removed = Object.keys(await getVendorImportMap(source)).length;
  await chrome.storage.local.remove([`${source}ImportData`, `${source}ImportMeta`]);
  let total = 0;
  try {
    const res = await sendDashboardData();
    if (res && res.ok) total = res.count;
  } catch (e) {}
  await chrome.storage.local.set({ totalRecords: total });
  return { ok: true, source, removed, total };
}

// D11: the Settings → Database tab lists every usage store, where it lives
// (always chrome.storage.local now), and which ones the extension can delete.
const DB_MAX_ROWS = 2000;
const DB_TOKEN_FIELDS = ["input", "output", "reasoning", "cacheRead", "cacheWrite5m", "cacheWrite1h"];

function databaseStoreFrom({ key, label, location, managed, source, map }) {
  const rows = Object.values(map || {})
    .filter((r) => r && typeof r === "object" && r.model)
    .map((r) => ({
      id: r.id || "",
      source: r.source || source || "opencode",
      model: r.model,
      time: r.time || r.date || "",
      input: Number(r.input) || 0,
      output: Number(r.output) || 0,
      cacheRead: Number(r.cacheRead) || 0,
    }))
    .sort((a, b) => String(b.time).localeCompare(String(a.time)));
  let tokens = 0;
  for (const r of Object.values(map || {})) {
    if (!r || typeof r !== "object") continue;
    for (const f of DB_TOKEN_FIELDS) tokens += Number(r[f]) || 0;
  }
  return {
    key,
    label,
    location,
    managed,
    source: source || null,
    count: rows.length,
    tokens,
    truncated: rows.length > DB_MAX_ROWS,
    rows: rows.slice(0, DB_MAX_ROWS),
  };
}

async function handleGetDatabase() {
  const stores = [];
  const registry = await loadVendorRegistry();

  // Records now live entirely in chrome.storage: opencode (API) in
  // opencodeImportData, the local SQLite import in localImportData, and every
  // other vendor in <source>ImportData. Each record is listed in exactly one store.
  const localMap = await getLocalImportMap();
  const vendorMaps = {};
  for (const source of await getVendorImportSources()) vendorMaps[source] = await getVendorImportMap(source);

  stores.push(
    databaseStoreFrom({
      key: LOCAL_STORE_KEY,
      label: "opencode local import",
      location: "chrome.storage.local · localImportData",
      managed: true,
      source: "opencode",
      map: localMap,
    })
  );

  for (const [source, map] of Object.entries(vendorMaps)) {
    const vendor = ((registry && registry.vendors) || []).find((v) => v && v.source === source);
    stores.push(
      databaseStoreFrom({
        key: `${VENDOR_STORE_PREFIX}${source}`,
        label: (vendor && vendor.label) || source,
        location: `chrome.storage.local · ${source}ImportData`,
        managed: true,
        source,
        map,
      })
    );
  }
  return { ok: true, stores };
}


// D11: delete specific records by id. Every store lives in chrome.storage.local
// and is removable here — opencode's API sync (<source>ImportData) and local DB
// import, plus each other vendor's `<source>ImportData` map. The caller reports
// how many ids were actually found and removed.
async function handleRemoveRecords(msg) {
  const source = (msg && msg.source) || "opencode";
  const ids = Array.isArray(msg && msg.ids) ? msg.ids.filter(Boolean) : [];
  if (ids.length === 0) return { ok: false, error: "No record ids given" };

  let removed = 0;
  // opencode has two stores: the local SQLite import and the API vendor store.
  if (source === "opencode") {
    const localMap = await getLocalImportMap();
    let changed = false;
    for (const id of ids) if (localMap[id]) { delete localMap[id]; removed++; changed = true; }
    if (changed) {
      await chrome.storage.local.set({
        localImportData: JSON.stringify(localMap),
        localImportMeta: { count: Object.keys(localMap).length, updatedAt: Date.now() },
      });
      fpCache = { key: null, buckets: null }; // fingerprint cache is now stale
    }
  }

  const sources = await getVendorImportSources();
  if (sources.includes(source)) {
    const map = await getVendorImportMap(source);
    let changed = false;
    for (const id of ids) if (map[id]) { delete map[id]; removed++; changed = true; }
    if (changed) {
      await chrome.storage.local.set({
        [`${source}ImportData`]: JSON.stringify(map),
        [`${source}ImportMeta`]: { count: Object.keys(map).length, updatedAt: Date.now() },
      });
    }
  } else if (source !== "opencode") {
    return { ok: false, error: `Unknown source: ${source}` };
  }

  let total = 0;
  try {
    const res = await sendDashboardData();
    if (res && res.ok) total = res.count;
  } catch (e) {}
  await chrome.storage.local.set({ totalRecords: total });
  return { ok: true, source, removed, total };
}

// Records now live in chrome.storage (opencodeImportData + localImportData), so
// status no longer needs an open opencode.ai tab.
async function sendGetStatus() {
  const localMap = await getLocalImportMap();
  const vendorRecords = await getAllVendorRecords();
  const { merged } = mergeRecords(vendorRecords, localMap);
  const ids = Object.keys(merged);
  if (ids.length > 0) {
    return { ok: true, totalRecords: ids.length, files: [], lastRecord: computeLastRecord(merged) };
  }
  const { cachedMeta } = await chrome.storage.local.get("cachedMeta");
  if (cachedMeta && cachedMeta.count) {
    return {
      ok: true,
      fromCache: true,
      totalRecords: cachedMeta.count,
      files: cachedMeta.files || [],
      lastRecord: cachedMeta.lastRecord || null,
    };
  }
  return { ok: false, error: "No cached data - open the opencode.ai Console and sync first" };
}

// ===== Local SQLite import (tools/import-local.mjs) =====
// Local records live in chrome.storage.local under "localImportData" (a JSON
// string of { id: record }) and are merged into every dashboard/status
// response. Merging is idempotent (keyed by record id), so re-importing the
// same file never duplicates.
async function getLocalImportMap() {
  try {
    const { localImportData } = await chrome.storage.local.get("localImportData");
    if (!localImportData) return {};
    const parsed = JSON.parse(localImportData);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch (e) {}
  return {};
}

// ===== Generic vendor import maps (crawl/API vendors) =====
// Records live under "<source>ImportData" ({ id: record } JSON) and are merged
// into every dashboard/status response like localImportData. Merging is keyed
// by record id so re-syncing is idempotent. Every vendor, opencode included,
// keeps its synced records this way.
async function getVendorImportSources() {
  const registry = await loadVendorRegistry();
  return ((registry && registry.vendors) || [])
    .map((v) => v && v.source)
    .filter((s) => !!s);
}

async function getVendorImportMap(source) {
  try {
    const key = `${source}ImportData`;
    const stored = await chrome.storage.local.get(key);
    const raw = stored[key];
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch (e) {}
  return {};
}

async function getAllVendorRecords() {
  const sources = await getVendorImportSources();
  const maps = await Promise.all(sources.map((s) => getVendorImportMap(s)));
  return Object.assign({}, ...maps);
}

function mergeRecords(base, extra) {
  const merged = { ...(base || {}) };
  let added = 0;
  for (const [id, rec] of Object.entries(extra || {})) {
    if (!rec || typeof rec !== "object" || !rec.model) continue;
    if (!merged[id]) added++;
    merged[id] = normalizeLocalRecord(rec);
  }
  // Previously imported local records used per-project workspace names
  // ("local:<project>"); remap them to the single "Local" workspace too.
  for (const [id, rec] of Object.entries(merged)) {
    if (rec && typeof rec === "object" && typeof rec.workspaceID === "string" && rec.workspaceID.startsWith("local:")) {
      merged[id] = normalizeLocalRecord(rec);
    }
  }
  return { merged, added };
}

// Local records share one workspace ("Local"); the per-project label lives
// in `project` (backfilled from legacy "local:<project>" workspace names).
function normalizeLocalRecord(rec) {
  if (!rec || typeof rec !== "object") return rec;
  if (typeof rec.workspaceID === "string" && rec.workspaceID.startsWith("local:")) {
    if (!rec.project) rec.project = rec.workspaceID;
    rec.workspaceID = "Local";
  }
  return rec;
}

// ===== Cross-source dedupe (opencode API sync vs local SQLite import) =====
// The two sources share no common id, so the same usage is recognized by
// fingerprint: same model, same token counts, timestamps within a small
// window (server vs client clock skew). On a match the LOCAL record wins
// (it carries project provenance); the server copy is hidden from totals.
// Only non-local-looking records are ever hidden; anything local-looking or
// without a parseable timestamp is always kept (conservative: hide only on
// positive match). fingerprintOf / DEDUP_BUCKET_MS are imported from shared/merge.

// isLocalLooking lives in shared/merge.js (imported above) so the dashboard's
// backup-restore routing and this dedupe agree on provenance.

// Day-anchored import copies are hidden by shared/merge.hideDayAnchoredImportCopies.

function hideCrawlerDuplicates(crawlerMap, localMap) {
  return getLocalBuckets(localMap).then((buckets) => hideWithBuckets(crawlerMap, buckets));
}

// Fingerprint-set cache (optimization A): rebuilding the bucket set is the
// expensive half of dedupe. The cache key is the localImportMeta version
// stamp (count + updatedAt). localImportData has exactly two writers —
// handleLocalImport (sets meta atomically) and handleClearLocal (removes
// meta) — so a matching stamp guarantees identical content; any skew falls
// back to recompute. SW eviction simply clears the cache (recompute once).
let fpCache = { key: null, buckets: null };

async function getLocalBuckets(localMap) {
  const recs = Object.values(localMap || {});
  if (recs.length === 0) return { buckets: new Set(), cached: false };
  let key = null;
  try {
    const { localImportMeta } = await chrome.storage.local.get("localImportMeta");
    if (
      localImportMeta &&
      localImportMeta.count === recs.length &&
      typeof localImportMeta.updatedAt === "number"
    ) {
      key = `${localImportMeta.count}:${localImportMeta.updatedAt}`;
    }
  } catch (e) {}
  if (key && fpCache.key === key && fpCache.buckets) {
    return { buckets: fpCache.buckets, cached: true };
  }
  const buckets = buildFingerprintBuckets(recs);
  if (key) fpCache = { key, buckets };
  return { buckets, cached: false };
}

function hideWithBuckets(crawlerMap, { buckets, cached }) {
  const out = { ...(crawlerMap || {}) };
  if (buckets.size === 0 || Object.keys(out).length === 0) return { map: out, dropped: 0, cached };
  let dropped = 0;
  for (const id of Object.keys(out)) {
    const rec = out[id];
    if (!rec || typeof rec !== "object" || isLocalLooking(id, rec)) continue;
    const fp = fingerprintOf(rec);
    if (!fp) continue;
    const b = Math.floor(new Date(rec.time).getTime() / DEDUP_BUCKET_MS);
    if (buckets.has(`${fp}@${b}`)) {
      delete out[id];
      dropped++;
    }
  }
  return { map: out, dropped, cached };
}

function pickLastRecord(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const ka = a.time || a.date || "";
  const kb = b.time || b.date || "";
  return kb > ka ? b : a;
}

function computeLastRecord(globalCache) {
  let lastRecord = null;
  for (const rec of Object.values(globalCache || {})) {
    lastRecord = pickLastRecord(lastRecord, rec);
  }
  return lastRecord;
}

// Accept the importer's bare { id: record } map, or a wrapped payload.
function normalizeImportPayload(data) {
  let parsed = typeof data === "string" ? JSON.parse(data) : data;
  if (parsed && typeof parsed.data === "string") parsed = JSON.parse(parsed.data);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JSON must be an object of { id: record }");
  }
  return parsed;
}

async function handleClearLocal() {
  const localMap = await getLocalImportMap();
  const cleared = Object.keys(localMap).length;
  await chrome.storage.local.remove(["localImportData", "localImportMeta"]);
  fpCache = { key: null, buckets: null }; // drop cached fingerprints with the data
  const res = await sendDashboardData();
  return { ok: true, cleared, total: res.count || 0 };
}

const IMPORT_IDENTITY_FIELDS = new Set(["id", "source", "time", "date"]);

// Fill only the fields `primary` is missing (null/undefined/"") from `other`;
// identity/time fields are never copied. `primary` keeps its own values.
function fillMissingFields(primary, other) {
  let changed = false;
  for (const [k, v] of Object.entries(other || {})) {
    if (IMPORT_IDENTITY_FIELDS.has(k) || v == null || v === "") continue;
    if (primary[k] == null || primary[k] === "") {
      primary[k] = v;
      changed = true;
    }
  }
  return changed;
}

// Upsert incoming opencode records against what is already stored (the API
// vendor store + the local store). Identity is the content fingerprint within
// +/- one time bucket; both output encodings (exclusive-of-reasoning and the
// legacy inclusive one) are tried, so no date cutoff and no encoding assumption
// is needed. A match is a duplicate: fill the STORED record's missing fields
// from the incoming copy and drop the incoming one. Stored records win on
// conflicts (the API store is authoritative). Returns the records to actually
// import plus counters.
function reconcileOpencodeImport(incoming, existingLocal, existingVendor) {
  const index = new Map();
  const indexMap = (map, kind) => {
    for (const rec of Object.values(map || {})) {
      if (!rec || typeof rec !== "object" || !rec.model) continue;
      const t = new Date(rec.time).getTime();
      if (isNaN(t)) continue;
      const b = Math.floor(t / DEDUP_BUCKET_MS);
      for (const fp of recordFingerprints(rec)) {
        for (const off of [-1, 0, 1]) index.set(`${fp}@${b + off}`, { kind, rec });
      }
    }
  };
  indexMap(existingLocal, "local");
  indexMap(existingVendor, "vendor"); // vendor wins a shared fingerprint

  const keep = {};
  let duplicates = 0;
  let filled = 0;
  let vendorChanged = false;
  for (const [id, rec] of Object.entries(incoming || {})) {
    if (!rec || typeof rec !== "object" || !rec.model) continue;
    const t = new Date(rec.time).getTime();
    let hit = null;
    if (!isNaN(t)) {
      const b = Math.floor(t / DEDUP_BUCKET_MS);
      for (const fp of recordFingerprints(rec)) {
        hit = index.get(`${fp}@${b}`);
        if (hit) break;
      }
    }
    if (hit) {
      duplicates++;
      if (fillMissingFields(hit.rec, rec)) {
        filled++;
        if (hit.kind === "vendor") vendorChanged = true;
      }
    } else {
      keep[id] = rec;
    }
  }
  return { keep, duplicates, filled, vendorChanged };
}

async function handleLocalImport(msg) {
  let incoming;
  try {
    incoming = normalizeImportPayload(msg && msg.data);
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${e.message}` };
  }
  const existing = await getLocalImportMap();
  const existingVendor = await getVendorImportMap("opencode");
  const validIncoming = Object.values(incoming).filter((rec) => rec && typeof rec === "object" && rec.model);
  if (validIncoming.length === 0) return { ok: false, error: "No valid records found in file" };
  // Upsert: duplicates merge into the stored record (filling schema gaps) and
  // are not imported again; only genuinely new records are kept.
  const { keep, duplicates, filled, vendorChanged } = reconcileOpencodeImport(incoming, existing, existingVendor);
  const { merged: nextLocal, added } = mergeRecords(existing, keep);
  const totalLocal = Object.keys(nextLocal).length;
  try {
    await chrome.storage.local.set({ localImportData: JSON.stringify(nextLocal) });
    if (vendorChanged) {
      await chrome.storage.local.set({
        opencodeImportData: JSON.stringify(existingVendor),
        opencodeImportMeta: { count: Object.keys(existingVendor).length, updatedAt: Date.now() },
      });
    }
  } catch (e) {
    return { ok: false, error: `Storage quota exceeded - cannot keep ${totalLocal} local records (${e.message || e})` };
  }
  // Refresh the merged snapshot so popup/dashboard pick it up immediately.
  let base = {};
  try {
    const { cachedData } = await chrome.storage.local.get("cachedData");
    if (cachedData) base = JSON.parse(cachedData) || {};
  } catch (e) {}
  const { merged } = mergeRecords(base, nextLocal);
  // Store the deduped snapshot so cachedMeta counts match the dashboard.
  const crawlerPart = {};
  const localPart = {};
  for (const [id, rec] of Object.entries(merged)) {
    ((rec && typeof rec === "object" && isLocalLooking(id, rec)) ? localPart : crawlerPart)[id] = rec;
  }
  const { map: dedupedSnap } = await hideCrawlerDuplicates(crawlerPart, { ...localPart, ...nextLocal });
  const snapshot = { ...dedupedSnap, ...localPart, ...nextLocal };
  const now = Date.now();
  await chrome.storage.local.set({
    cachedData: JSON.stringify(snapshot),
    cachedMeta: {
      count: Object.keys(snapshot).length,
      lastRecord: computeLastRecord(snapshot),
      updatedAt: now,
    },
    localImportMeta: { count: totalLocal, updatedAt: now },
  });
  // Feedback: how many crawler records does this import shadow?
  let overlap = 0;
  try {
    const crawlerPart = {};
    for (const [id, rec] of Object.entries(base)) {
      if (!isLocalLooking(id, rec)) crawlerPart[id] = rec;
    }
    overlap = (await hideCrawlerDuplicates(crawlerPart, keep)).dropped;
  } catch (e) {}
  return { ok: true, imported: Object.keys(keep).length, newRecords: added, duplicates, filled, totalLocal, total: Object.keys(snapshot).length, overlap };
}

async function sendLocalStatus() {
  try {
    const { localImportMeta } = await chrome.storage.local.get("localImportMeta");
    if (localImportMeta && typeof localImportMeta.count === "number") {
      return { ok: true, totalLocal: localImportMeta.count, updatedAt: localImportMeta.updatedAt || null };
    }
  } catch (e) {}
  const totalLocal = Object.keys(await getLocalImportMap()).length;
  return { ok: true, totalLocal, updatedAt: null };
}

// Merged snapshot for the dashboard/popup, rebuilt from chrome.storage only:
// vendor records (<source>ImportData, opencode included) + the local SQLite
// import. The old crawler snapshot is no longer a source of truth.
async function sendDashboardData() {
  const localMap = await getLocalImportMap();
  const vendorRecordsRaw = await getAllVendorRecords();
  const vendorRecords = hideDayAnchoredImportCopies(vendorRecordsRaw).map;
  // opencode API rows share usage with the local SQLite import, so dedupe them
  // against it. Other vendors are left as-is.
  const opencodePart = {};
  const otherPart = {};
  for (const [id, rec] of Object.entries(vendorRecords)) {
    const src = (rec && rec.source) || "opencode";
    (src === "opencode" ? opencodePart : otherPart)[id] = rec;
  }
  const { map: dedupedOpencode, dropped } = await hideCrawlerDuplicates(opencodePart, localMap);
  const { merged } = mergeRecords({ ...dedupedOpencode, ...otherPart }, localMap);
  const mergedStr = JSON.stringify(merged);
  await chrome.storage.local.set({
    cachedData: mergedStr,
    cachedMeta: {
      count: Object.keys(merged).length,
      lastRecord: computeLastRecord(merged),
      updatedAt: Date.now(),
    },
  });
  return { ok: true, data: mergedStr, count: Object.keys(merged).length, fileCount: 0, fromCache: false, deduped: dropped };
}

async function handleOpenDashboard() {
  // Refresh the merged snapshot now so the dashboard tab (and later refreshes)
  // have current data. The dashboard itself re-fetches on every load too.
  const res = await sendDashboardData();
  await chrome.tabs.create({ url: chrome.runtime.getURL("dashboard/dashboard.html") });
  return { ok: true, count: res.count || 0, fileCount: res.fileCount || 0, fromCache: !!res.fromCache };
}

// ===== Peak/off-peak notifications =====
// Schedules a one-shot alarm at the next peak boundary (peak start or end).
// When it fires, a system notification is shown and the following boundary is
// scheduled. The alarm is re-scheduled whenever the toggle, rate config, or
// selected model changes, and on every service-worker start.
const PEAK_ALARM = "peak-boundary";

async function getTimeReminderContext() {
  let [rates, model, enabled] = await Promise.all([
    loadTimeRates(),
    loadTimeModel(),
    loadTimeEnabled(),
  ]);
  // Heal a stale stored model that the picker no longer offers (retired, or its
  // current rate version bills flat) so notifications can't announce a window
  // the model stopped having.
  if (model && Array.isArray(rates) && !listPeakModels(rates).includes(model)) {
    const fallback = listPeakModels(rates)[0] || "";
    try { await saveTimeModel(fallback); } catch (e) {}
    model = fallback;
  }
  return { rates, model, enabled, windows: collectPeakWindowsForModel(rates, model) };
}

async function schedulePeakAlarm() {
  await chrome.alarms.clear(PEAK_ALARM);
  const { enabled, windows } = await getTimeReminderContext();
  if (!enabled || windows.length === 0) return;
  const boundary = nextPeakBoundary(new Date(), windows);
  if (!boundary) return;
  chrome.alarms.create(PEAK_ALARM, { when: boundary.time.getTime() });
}

function boundaryLabel(date) {
  return `${formatLocalTime(date)} local (${formatUtcTime(date)} UTC)`;
}

async function notifyBoundary() {
  const { enabled, model, windows } = await getTimeReminderContext();
  if (!enabled || windows.length === 0) return;
  const now = new Date();
  const entering = isPeakAt(now, windows);
  const next = nextPeakBoundary(now, windows);
  const suffix = model ? ` (${model})` : "";
  chrome.notifications.create({
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title: entering ? `Peak time started${suffix}` : `Off-peak started${suffix}`,
    message: entering
      ? `Higher rates apply until ${next ? boundaryLabel(next.time) : "the configured window ends"}.`
      : `Lower rates now.${next ? ` Next peak starts at ${boundaryLabel(next.time)}.` : ""}`,
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== PEAK_ALARM) return;
  notifyBoundary()
    .catch(() => {})
    .finally(() => schedulePeakAlarm().catch(() => {}));
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[TIME_ENABLED_KEY] || changes[TIME_RATES_KEY] || changes[TIME_MODEL_KEY]) {
    schedulePeakAlarm().catch(() => {});
  }
  if (changes.autoSyncEnabled) scheduleAutoSync().catch(() => {});
});

// Re-arm on service-worker start so the chain survives browser restarts and SW eviction.
schedulePeakAlarm().catch(() => {});

// ===== Update checker (GitHub Releases) =====
// Unpacked extensions can't auto-update, so this polls GitHub Releases and
// surfaces "update available" in the popup when a newer version exists.
const UPDATE_REPO = "xhang1108/opencode-usage";
const UPDATE_ALARM = "check-update";
const UPDATE_INTERVAL_MIN = 6 * 60; // every 6 hours

// Numeric semver compare: 1 if a > b, -1 if a < b, 0 if equal.
// String comparison would misorder e.g. "0.10.0" vs "0.9.0".
function compareVersions(a, b) {
  const pa = String(a).replace(/^v/i, "").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/i, "").split(".").map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

async function checkForUpdate() {
  try {
    const res = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`);
    if (!res.ok) return; // 404 (no releases) / 403 (rate limit) / offline - keep last result
    const release = await res.json();
    const latest = String(release.tag_name || "").replace(/^v/i, "");
    const current = chrome.runtime.getManifest().version;
    if (!latest) return;
    await chrome.storage.local.set({
      updateInfo: {
        latestVersion: latest,
        currentVersion: current,
        updateAvailable: compareVersions(latest, current) > 0,
        releaseUrl: release.html_url || `https://github.com/${UPDATE_REPO}/releases`,
        checkedAt: Date.now(),
      },
    });
  } catch (e) {
    // Network failure - ignore; the next scheduled check retries
  }
}

async function scheduleUpdateCheck() {
  await chrome.alarms.create(UPDATE_ALARM, { periodInMinutes: UPDATE_INTERVAL_MIN });
  checkForUpdate().catch(() => {});
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === UPDATE_ALARM) checkForUpdate().catch(() => {});
});

scheduleUpdateCheck().catch(() => {});

// ===== Auto-sync (opencode, every 6h) =====
// The Console Usage API authenticates with the page session cookie, which a
// background service-worker fetch cannot send cross-site, so the periodic sync
// runs through a content script on an opencode.ai Console tab. An existing tab
// is reused and left open; a tab we open ourselves is closed once the sync ends.
const AUTO_SYNC_ALARM = "auto-sync";
const AUTO_SYNC_MINUTES = 360; // 6h
let autoSyncTabId = null; // non-null only for a tab we opened

async function scheduleAutoSync() {
  try { await chrome.alarms.clear(AUTO_SYNC_ALARM); } catch (e) {}
  const { autoSyncEnabled } = await chrome.storage.local.get("autoSyncEnabled");
  if (autoSyncEnabled !== true) return;
  chrome.alarms.create(AUTO_SYNC_ALARM, { periodInMinutes: AUTO_SYNC_MINUTES });
}

function closeAutoSyncTab() {
  if (autoSyncTabId == null) return;
  try { chrome.tabs.remove(autoSyncTabId); } catch (e) {}
  autoSyncTabId = null;
}

async function runAutoSync() {
  const { autoSyncEnabled, vendorSettings, crawlState } = await chrome.storage.local.get([
    "autoSyncEnabled",
    "vendorSettings",
    "crawlState",
  ]);
  if (autoSyncEnabled !== true) return;
  if (vendorSettings && vendorSettings.opencode === false) return;
  if (crawlState && crawlState.running) return; // don't pile onto a live sync

  const tabs = await chrome.tabs.query({ url: ["https://opencode.ai/*"] });
  const existing = tabs.find((t) => t.url && /^https:\/\/opencode\.ai\/console\/(?:org_|wrk_)/.test(t.url)) || null;
  let tab = existing;
  if (existing) {
    autoSyncTabId = null; // user's tab: never close it
  } else {
    tab = await chrome.tabs.create({ url: "https://opencode.ai/console", active: false });
    autoSyncTabId = tab.id;
  }
  // Wait for /console to redirect to an org before messaging the content script.
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const t = await chrome.tabs.get(tab.id).catch(() => null);
    if (t && /^https:\/\/opencode\.ai\/console\/(?:org_|wrk_)/.test(t.url || "")) break;
    try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["vendors/opencode/api.js"] }); } catch (e) {}
  }
  const knownNewest = await newestStoredTime("opencode");
  try {
    await sendMessageToTab(tab.id, { type: "start-crawl", vendor: "opencode", knownNewest, full: false });
  } catch (e) {
    closeAutoSyncTab();
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTO_SYNC_ALARM) runAutoSync().catch(() => closeAutoSyncTab());
});
scheduleAutoSync().catch(() => {});

// ===== Multi-vendor registry + settings seed (M1) =====
// The vendor registry is a static JSON shipped with the extension; cache it in
// chrome.storage.local so the dashboard/popup can read it without fetching.
// vendorSettings decides which vendors are enabled; new vendors default to off
// (D9). New installs seed the registry defaults; existing users keep their
// state and only get a one-time "new vendors available" notice.
const VENDOR_REGISTRY_URL = "shared/vendors.json";

let _vendorRegistryCache = null;
async function loadVendorRegistry() {
  if (_vendorRegistryCache) return _vendorRegistryCache;
  try {
    const res = await fetch(chrome.runtime.getURL(VENDOR_REGISTRY_URL));
    if (!res.ok) return null;
    const registry = await res.json();
    _vendorRegistryCache = registry;
    await chrome.storage.local.set({ vendorRegistry: registry });
    return registry;
  } catch (e) {
    return null;
  }
}

// Non-default crawl vendors are NOT declared in the static manifest; their
// content script is registered at runtime once the vendor is enabled and its
// optional origin granted, so a disabled vendor needs no permission (B1/B2).
async function registerVendorScript(v) {
  const spec = [
    {
      id: `vendor-${v.source}`,
      matches: v.origins,
      js: [v.crawlScript],
      runAt: v.crawlRunAt || "document_idle",
      persistAcrossSessions: true,
    },
  ];
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [spec[0].id] });
    if (existing && existing.length > 0) await chrome.scripting.updateContentScripts(spec);
    else await chrome.scripting.registerContentScripts(spec);
  } catch (e) {
    try {
      await chrome.scripting.registerContentScripts(spec);
    } catch (e2) {}
  }
}

async function unregisterVendorScript(id) {
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [id] });
  } catch (e) {}
}

async function syncVendorContentScripts() {
  const registry = await loadVendorRegistry();
  const { vendorSettings } = await chrome.storage.local.get("vendorSettings");
  const enabled = vendorSettings && typeof vendorSettings === "object" ? vendorSettings : {};
  for (const v of (registry && registry.vendors) || []) {
    if (!v || !v.crawl || !v.crawlScript || v.defaultEnabled) continue;
    const id = `vendor-${v.source}`;
    if (enabled[v.source] !== true || !v.origins || v.origins.length === 0) {
      await unregisterVendorScript(id);
      continue;
    }
    let granted = false;
    try {
      granted = await chrome.permissions.contains({ origins: v.origins });
    } catch (e) {
      granted = false;
    }
    if (granted) await registerVendorScript(v);
    else await unregisterVendorScript(id);
  }
}

function defaultVendorSettings(registry) {
  const settings = {};
  for (const vendor of (registry && registry.vendors) || []) {
    if (vendor && vendor.source) settings[vendor.source] = vendor.defaultEnabled === true;
  }
  return settings;
}

async function seedVendorSettings(reason) {
  const { vendorSettings } = await chrome.storage.local.get("vendorSettings");
  if (vendorSettings && typeof vendorSettings === "object" && !Array.isArray(vendorSettings)) {
    return vendorSettings;
  }
  const registry = (await loadVendorRegistry()) || { vendors: [] };
  const seeded = defaultVendorSettings(registry);
  // Safety net: never leave a user with every vendor off.
  if (!Object.values(seeded).some(Boolean)) seeded.opencode = true;
  await chrome.storage.local.set({
    vendorSettings: seeded,
    vendorSettingsSeededAt: Date.now(),
    // Existing users get a one-time notice that new vendors are available (D9).
    multiVendorNoticePending: reason === "update",
  });
  return seeded;
}

// Storage-level schema migrations (additive + idempotent; see shared/migrate.js).
// Reads only the keys the pending steps declare, then writes every patched key
// plus the new version in a single set. Legacy keys are never deleted, and a
// failure leaves the store untouched so the next startup retries.
async function ensureStorageSchema() {
  try {
    const { schemaVersion } = await chrome.storage.local.get("schemaVersion");
    const pending = pendingMigrations(schemaVersion);
    if (pending.length === 0) return { version: Number(schemaVersion) || 0, applied: [] };
    const keys = [...new Set(pending.flatMap((s) => s.keys || []))];
    const state = keys.length ? await chrome.storage.local.get(keys) : {};
    const { version, patch, applied } = planMigrations({ ...state, schemaVersion });
    if (applied.length === 0) return { version, applied };
    await chrome.storage.local.set({ ...patch, schemaVersion: version });
    return { version, applied };
  } catch (e) {
    return { version: null, applied: [], error: String((e && e.message) || e) };
  }
}

chrome.runtime.onInstalled.addListener((details) => {
  ensureStorageSchema().catch(() => {});
  loadVendorRegistry().catch(() => {});
  scheduleAutoSync().catch(() => {});
  seedVendorSettings((details && details.reason) || "install")
    .then(() => syncVendorContentScripts())
    .catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  ensureStorageSchema().catch(() => {});
  scheduleAutoSync().catch(() => {});
  loadVendorRegistry()
    .then(() => syncVendorContentScripts())
    .catch(() => {});
});

// Re-cache the registry + re-sync runtime content scripts on service-worker
// start (survives eviction), and make sure the storage schema is current.
ensureStorageSchema().catch(() => {});
scheduleAutoSync().catch(() => {});
loadVendorRegistry()
  .then(() => syncVendorContentScripts())
  .catch(() => {});

