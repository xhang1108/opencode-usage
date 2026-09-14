// background.js - Manages the icon badge and popup message routing (export / manual sync / status).
importScripts("time-reminder.js");

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

    case "crawl-done": {
      const tabId = sender.tab && sender.tab.id;
      const count = msg.total || 0;
      // Clear the badge on completion; it only indicates active crawling.
      try { chrome.action.setBadgeText({ text: "" }); } catch (e) {}
      if (tabId !== undefined && tabId !== null) {
        chrome.action.setBadgeText({ tabId, text: "" });
      }
      const newCount = msg.newRecords || 0;
      const newTokens = msg.newTokens || 0;
      const serverEmpty = !!msg.serverEmpty;
      notifyCrawl(
        "Sync complete",
        serverEmpty
          ? `Server has no records for this workspace — showing last synced data.`
          : `${count} records total — ${newCount} new (${newTokens.toLocaleString()} tokens).`
      );
      chrome.storage.local.set({
        lastSyncAt: Date.now(),
        lastSyncCount: newCount,
        lastSyncTokens: newTokens,
        lastSyncWorkspace: msg.workspaceID || "",
        totalRecords: count,
        crawlState: {
          running: false,
          done: true,
          page: msg.lastPage || 0,
          workspace: msg.workspaceID || "",
          warning: count === 0, // B10: completed but nothing returned
          serverEmpty, // D21: server has no records for this workspace
          message: count === 0
            ? "Crawl finished but returned no records"
            : serverEmpty
              ? "Server has no records for this workspace — showing last synced data"
              : msg.stopReason ? `Crawl stopped: ${msg.stopReason}` : "",
        },
      });
      // After a sync, cache the merged data so it's usable without an open page.
      if (tabId !== undefined && tabId !== null) {
        stashMergedData(tabId).catch(() => {});
      }
      sendResponse({ ok: true });
      break;
    }

    case "error":
    case "info": {
      setBadge(sender, msg.type === "error" ? "ERR" : "", msg.type === "error" ? "#cc6f66" : "#a1a1a6");
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

    case "inject-interceptor": {
      const tabId = sender.tab && sender.tab.id;
      if (tabId === undefined || tabId === null) {
        sendResponse({ ok: false, error: "Cannot get tab" });
        break;
      }
      chrome.scripting
        .executeScript({
          target: { tabId },
          files: ["content/interceptor.js"],
          world: "MAIN",
        })
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true; // Keep the message channel open
    }

    case "start-crawl":
      (msg.vendor && msg.vendor !== "opencode"
        ? sendStartVendorCrawl(msg.vendor, msg.days, !!(msg.full || msg.rescan))
        : sendStartCrawl(!!msg.rescan)
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
      // Drop the local import and rebuild the snapshot from crawler data only.
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
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content/content.js"] });
    await new Promise((r) => setTimeout(r, 300)); // Give the injected content script time to initialize
    return await chrome.tabs.sendMessage(tabId, msg);
  }
}

async function findUsageTab() {
  const tabs = await chrome.tabs.query({ url: ["https://opencode.ai/*"] });
  return tabs.find((t) => t.url && /\/workspace\/wrk_[^/]+\/usage/.test(t.url)) || null;
}

async function findAnyOpencodeTab() {
  const tabs = await chrome.tabs.query({ url: ["https://opencode.ai/*"] });
  return (
    tabs.find((t) => t.url && /\/workspace\/wrk_[^/]+\/usage/.test(t.url)) ||
    tabs[0] ||
    null
  );
}

async function sendStartCrawl(rescan) {
  let tab = await findUsageTab();
  if (!tab) {
    // No usage tab open — try to auto-open https://opencode.ai/workspace/<wrk_...>/usage from stored workspace
    // Priority: last visited (most recent browsing) > last sync
    const { lastVisitedWorkspace, lastSyncWorkspace, cachedMeta, crawlState } = await chrome.storage.local.get([
      "lastVisitedWorkspace",
      "lastSyncWorkspace",
      "cachedMeta",
      "crawlState",
    ]);
    let ws =
      (lastVisitedWorkspace && /^wrk_/.test(lastVisitedWorkspace) && lastVisitedWorkspace) ||
      (lastSyncWorkspace && /^wrk_/.test(lastSyncWorkspace) && lastSyncWorkspace) ||
      (cachedMeta && cachedMeta.lastRecord && cachedMeta.lastRecord.workspaceID) ||
      (crawlState && crawlState.workspace) ||
      "";
    // Also scan cachedData for any workspace as last resort
    if (!ws) {
      try {
        const { cachedData } = await chrome.storage.local.get("cachedData");
        if (cachedData) {
          const parsed = JSON.parse(cachedData);
          const first = Object.values(parsed)[0];
          if (first && first.workspaceID && /^wrk_/.test(first.workspaceID)) ws = first.workspaceID;
        }
      } catch (e) {}
    }
    if (ws) {
      const url = `https://opencode.ai/workspace/${ws}/usage`;
      tab = await chrome.tabs.create({ url });
      // Wait for content script to become ready, then auto-start crawl
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 500));
        try {
          const ready = await chrome.tabs.sendMessage(tab.id, { type: "get-status" }).catch(() => null);
          if (ready) break;
        } catch (e) {}
        try {
          await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content/content.js"] });
        } catch (e) {}
      }
      try {
const res = await sendMessageToTab(tab.id, { type: "start-crawl", rescan });
        if (res && res.ok) return { ...res, openedUsage: true };
      } catch (e) {}
      return { ok: true, openedUsage: true, started: false };
    }
    const tabs = await chrome.tabs.query({ url: ["https://opencode.ai/*"] });
    const urls = tabs.map((t) => t.url || "(no url)").join(" | ") || "(no opencode.ai tabs)";
    return { ok: false, error: `No usage tab found. Open https://opencode.ai workspace usage page first. Open tabs: ${urls}` };
  }

  // Focus existing usage tab and start crawl
  try { await chrome.tabs.update(tab.id, { active: true }); } catch (e) {}
  const res = await sendMessageToTab(tab.id, { type: "start-crawl", rescan });
  if (!res) return { ok: false, error: `Content script did not respond (tab url: ${tab.url})` };
  if (!res.ok) {
    return { ...res, error: `${res.error} (tab url: ${tab.url})` };
  }
  return res;
}

// ===== Generic vendor crawl routing (content-script vendors) =====
const VENDOR_CRAWL = {
  openrouter: {
    origins: ["https://openrouter.ai/*"],
    script: "vendors/openrouter/content.js",
    home: "https://openrouter.ai/activity",
    defaultDays: 365,
  },
  commandcode: {
    origins: ["https://commandcode.ai/*", "https://*.commandcode.ai/*"],
    script: "vendors/commandcode/content.js",
    home: "https://commandcode.ai/",
    defaultDays: 0,
  },
  "deepseek-official": {
    origins: ["https://*.deepseek.com/*"],
    script: "vendors/deepseek-official/content.js",
    home: "https://platform.deepseek.com/usage",
    defaultDays: 0, // crawler scans MAX_SCAN_DAYS on first run, incremental after
  },
};

async function sendStartVendorCrawl(vendor, days, full) {
  const cfg = VENDOR_CRAWL[vendor];
  if (!cfg) return { ok: false, error: `Unknown crawl vendor: ${vendor}` };
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

async function handleVendorCrawlData(msg) {
  const source = msg && msg.source;
  if (!VENDOR_IMPORT_SOURCES.includes(source)) return { ok: false, error: `Unknown source: ${source}` };
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
  try {
    chrome.action.setBadgeText({ text: "" });
  } catch (e) {}
  const count = VENDOR_IMPORT_SOURCES.includes(source) ? Object.keys(await getVendorImportMap(source)).length : 0;
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
  if (!VENDOR_IMPORT_SOURCES.includes(source)) return { ok: false, error: `Unknown source: ${source}` };
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

async function sendGetStatus() {
  const localMap = await getLocalImportMap();
  const localIds = Object.keys(localMap);
  const tab = await findUsageTab();
  if (tab) {
    try {
      if (localIds.length > 0) {
        // Local records present: need the full export to hide crawler
        // duplicates shadowed by the local import.
        const res = await sendMessageToTab(tab.id, { type: "export-json" });
        if (res && res.ok) {
          const { map: deduped } = await hideCrawlerDuplicates(JSON.parse(res.data || "{}"), localMap);
          const { merged } = mergeRecords(deduped, localMap);
          return {
            ok: true,
            totalRecords: Object.keys(merged).length,
            files: res.files || [],
            lastRecord: computeLastRecord(merged),
          };
        }
      } else {
        const res = await sendMessageToTab(tab.id, { type: "get-status" });
        if (res && res.ok) return res;
      }
    } catch (e) {
      // Injection still failed (e.g. restricted page) - fall back to cache
    }
  }
  // No usage tab open - return the last cached overview.
  const { cachedMeta } = await chrome.storage.local.get("cachedMeta");
  if (cachedMeta) {
    return {
      ok: true,
      fromCache: true,
      totalRecords: cachedMeta.count,
      files: cachedMeta.files || [],
      lastRecord: cachedMeta.lastRecord || null,
    };
  }
  if (localIds.length > 0) {
    return {
      ok: true,
      fromCache: true,
      totalRecords: localIds.length,
      files: [],
      lastRecord: computeLastRecord(localMap),
    };
  }
  return { ok: false, error: "No cached data - open the opencode.ai usage page and sync first" };
}

async function stashMergedData(tabId) {
  try {
    const res = await sendMessageToTab(tabId, { type: "export-json" });
    if (!res || !res.ok) return;
    const localMap = await getLocalImportMap();
    const { map: deduped } = await hideCrawlerDuplicates(JSON.parse(res.data || "{}"), localMap);
    const { merged } = mergeRecords(deduped, localMap);
    await chrome.storage.local.set({
      cachedData: JSON.stringify(merged),
      cachedMeta: {
        count: Object.keys(merged).length,
        fileCount: res.fileCount,
        files: res.files || [],
        lastRecord: computeLastRecord(merged),
        updatedAt: Date.now(),
      },
    });
  } catch (e) {
    // Content script unavailable - skip
  }
}

// ===== Local SQLite import (tools/import-local.mjs) =====
// Local records live in chrome.storage.local under "localImportData" (a JSON
// string of { id: record }), separate from the crawler's OPFS snapshot, and
// are merged into every dashboard/status response. Merging is idempotent
// (keyed by record id), so re-importing the same file never duplicates.
async function getLocalImportMap() {
  try {
    const { localImportData } = await chrome.storage.local.get("localImportData");
    if (!localImportData) return {};
    const parsed = JSON.parse(localImportData);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch (e) {}
  return {};
}

// ===== Generic vendor import maps (crawl/API vendors without OPFS) =====
// Records live under "<source>ImportData" ({ id: record } JSON) and are merged
// into every dashboard/status response like localImportData. Merging is keyed
// by record id so re-crawling is idempotent.
const VENDOR_IMPORT_SOURCES = ["openrouter", "deepseek-official", "commandcode", "mimo"];

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
  const maps = await Promise.all(VENDOR_IMPORT_SOURCES.map((s) => getVendorImportMap(s)));
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

// ===== Cross-source dedupe (crawler OPFS vs local SQLite import) =====
// The two sources share no common id, so the same usage is recognized by
// fingerprint: same model, same token counts, timestamps within a small
// window (server vs client clock skew). On a match the LOCAL record wins
// (it carries project provenance); the crawler copy is hidden from totals.
// Only crawler-looking records are ever hidden; anything local-looking or
// without a parseable timestamp is always kept (conservative: hide only on
// positive match).
const DEDUP_BUCKET_MS = 2 * 60 * 1000;

function fingerprintOf(rec) {
  if (!rec || typeof rec !== "object") return null;
  const t = new Date(rec.time).getTime();
  if (isNaN(t)) return null;
  const cacheWrite = (rec.cacheWrite5m || 0) + (rec.cacheWrite1h || 0);
  return [
    rec.model || "",
    rec.input || 0,
    rec.output || 0,
    rec.reasoning || 0,
    rec.cacheRead || 0,
    cacheWrite,
  ].join("|");
}

function isLocalLooking(id, rec) {
  // Vendor records (non-opencode) are handled by their own pipeline; never let
  // the opencode crawler/local dedupe hide them (D2: dedupe is same-source only).
  if (rec && rec.source && rec.source !== "opencode") return true;
  return (
    id.startsWith("msg_") ||
    rec.workspaceID === "Local" ||
    (typeof rec.workspaceID === "string" && rec.workspaceID.startsWith("local:"))
  );
}

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
  const buckets = buildLocalBuckets(recs);
  if (key) fpCache = { key, buckets };
  return { buckets, cached: false };
}

function buildLocalBuckets(localRecs) {
  const buckets = new Set();
  for (const rec of localRecs) {
    const fp = fingerprintOf(rec);
    if (!fp) continue;
    const b = Math.floor(new Date(rec.time).getTime() / DEDUP_BUCKET_MS);
    buckets.add(`${fp}@${b - 1}`);
    buckets.add(`${fp}@${b}`);
    buckets.add(`${fp}@${b + 1}`);
  }
  return buckets;
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
  const localIds = new Set(Object.keys(localMap));
  await chrome.storage.local.remove(["localImportData", "localImportMeta"]);
  fpCache = { key: null, buckets: null }; // drop cached fingerprints with the data
  // Rebuild the snapshot without local records: prefer a fresh OPFS export
  // (pure crawler data); otherwise strip the known local ids from the cache.
  const tab = await findAnyOpencodeTab();
  if (tab) {
    try {
      const res = await sendMessageToTab(tab.id, { type: "export-json" });
      if (res && res.ok) {
        await chrome.storage.local.set({
          cachedData: res.data,
          cachedMeta: {
            count: res.count,
            fileCount: res.fileCount,
            files: res.files || [],
            lastRecord: res.lastRecord || null,
            updatedAt: Date.now(),
          },
        });
        return { ok: true, cleared: localIds.size, total: res.count };
      }
    } catch (e) {
      // Fall through to cache stripping
    }
  }
  let base = {};
  try {
    const { cachedData } = await chrome.storage.local.get("cachedData");
    if (cachedData) base = JSON.parse(cachedData) || {};
  } catch (e) {}
  for (const id of localIds) delete base[id];
  await chrome.storage.local.set({
    cachedData: JSON.stringify(base),
    cachedMeta: {
      count: Object.keys(base).length,
      lastRecord: computeLastRecord(base),
      updatedAt: Date.now(),
    },
  });
  return { ok: true, cleared: localIds.size, total: Object.keys(base).length };
}

async function handleLocalImport(msg) {
  let incoming;
  try {
    incoming = normalizeImportPayload(msg && msg.data);
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${e.message}` };
  }
  const existing = await getLocalImportMap();
  const validIncoming = Object.values(incoming).filter((rec) => rec && typeof rec === "object" && rec.model);
  if (validIncoming.length === 0) return { ok: false, error: "No valid records found in file" };
  const { merged: nextLocal, added } = mergeRecords(existing, incoming);
  const totalLocal = Object.keys(nextLocal).length;
  try {
    await chrome.storage.local.set({ localImportData: JSON.stringify(nextLocal) });
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
    overlap = (await hideCrawlerDuplicates(crawlerPart, incoming)).dropped;
  } catch (e) {}
  return { ok: true, imported: Object.keys(incoming).length, newRecords: added, totalLocal, total: Object.keys(snapshot).length, overlap };
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

// D23 self-heal for crawl rows written before the parser stored an exclusive
// `output` (legacy rows kept console outputTokens, reasoning INCLUDED, and core
// adds reasoning again). Idempotent via the outputExcludesReasoning flag.
// Mirror of shared/canonical.healOpencodeCrawlOutput (keep in sync).
function healOpencodeCrawlOutput(rec) {
  if (!rec || typeof rec !== "object" || rec.outputExcludesReasoning) return rec;
  const reasoning = Number(rec.reasoning) || 0;
  if (reasoning > 0) rec.output = Math.max(0, (Number(rec.output) || 0) - reasoning);
  rec.outputExcludesReasoning = true;
  return rec;
}

function healCrawlMap(map) {
  for (const rec of Object.values(map || {})) healOpencodeCrawlOutput(rec);
  return map;
}

// Merged OPFS snapshot for the dashboard. Tries a live export from any open
// opencode.ai tab (which reads OPFS directly); falls back to the last cached
// snapshot so the dashboard survives refreshes even with no tab open.
async function sendDashboardData() {
  const localMap = await getLocalImportMap();
  const vendorRecords = await getAllVendorRecords();
  const tab = await findAnyOpencodeTab();
  if (tab) {
    try {
      const res = await sendMessageToTab(tab.id, { type: "export-json" });
      if (res && res.ok) {
        const base = JSON.parse(res.data || "{}");
        healCrawlMap(base); // D23 legacy repair
        const { map: deduped, dropped } = await hideCrawlerDuplicates(base, localMap);
        const { merged } = mergeRecords({ ...deduped, ...vendorRecords }, localMap);
        const mergedStr = JSON.stringify(merged);
        const lastRecord = computeLastRecord(merged);
        await chrome.storage.local.set({
          cachedData: mergedStr,
          cachedMeta: {
            count: Object.keys(merged).length,
            fileCount: res.fileCount,
            files: res.files || [],
            lastRecord,
            updatedAt: Date.now(),
          },
        });
        return { ok: true, data: mergedStr, count: Object.keys(merged).length, fileCount: res.fileCount, fromCache: false, deduped: dropped };
      }
    } catch (e) {
      // Content script unavailable - fall back to cache
    }
  }
  const { cachedData, cachedMeta } = await chrome.storage.local.get(["cachedData", "cachedMeta"]);
  if (cachedData) {
    // Split the snapshot so pre-dedupe caches also heal: crawler-looking
    // records are re-checked against the local import on every load.
    const parsed = JSON.parse(cachedData);
    const crawlerPart = {};
    const localPart = {};
    for (const [id, rec] of Object.entries(parsed || {})) {
      const src = rec && typeof rec === "object" ? rec.source : null;
      // Vendor records are authoritative in <source>ImportData; drop stale
      // copies from the cached snapshot so a Clear actually removes them.
      if (src && VENDOR_IMPORT_SOURCES.includes(src)) continue;
      ((rec && typeof rec === "object" && isLocalLooking(id, rec)) ? localPart : crawlerPart)[id] = rec;
    }
    const { map: deduped, dropped } = await hideCrawlerDuplicates(healCrawlMap(crawlerPart), localMap);
    const { merged } = mergeRecords(deduped, { ...localPart, ...localMap, ...vendorRecords });
    const mergedStr = JSON.stringify(merged);
    // Heal the cached snapshot so vendor clears/imports propagate even with no
    // opencode tab open (the cached branch used to return without writing).
    await chrome.storage.local.set({
      cachedData: mergedStr,
      cachedMeta: {
        ...(cachedMeta || {}),
        count: Object.keys(merged).length,
        lastRecord: computeLastRecord(merged),
        updatedAt: Date.now(),
      },
    });
    return {
      ok: true,
      data: mergedStr,
      count: Object.keys(merged).length,
      fileCount: (cachedMeta && cachedMeta.fileCount) || 0,
      fromCache: true,
      deduped: dropped,
    };
  }
  const fallback = { ...localMap, ...vendorRecords };
  const fallbackIds = Object.keys(fallback);
  if (fallbackIds.length > 0) {
    return {
      ok: true,
      data: JSON.stringify(fallback),
      count: fallbackIds.length,
      fileCount: 0,
      fromCache: true,
    };
  }
  return { ok: false, error: "No usage data yet - open the opencode.ai usage page and click Crawl Now in the popup" };
}

async function handleOpenDashboard() {
  // Refresh the OPFS snapshot now so the dashboard tab (and later refreshes)
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
  // Heal a stale stored model that no longer exists (e.g. removed from defaults).
  if (model && Array.isArray(rates) && !listPeakModels(rates).includes(model) && !rates.some((r) => r && r.model === model)) {
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

// ===== Multi-vendor registry + settings seed (M1) =====
// The vendor registry is a static JSON shipped with the extension; cache it in
// chrome.storage.local so the dashboard/popup can read it without fetching.
// vendorSettings decides which vendors are enabled; new vendors default to off
// (D9). New installs seed the registry defaults; existing users keep their
// state and only get a one-time "new vendors available" notice.
const VENDOR_REGISTRY_URL = "shared/vendors.json";

async function loadVendorRegistry() {
  try {
    const res = await fetch(chrome.runtime.getURL(VENDOR_REGISTRY_URL));
    if (!res.ok) return null;
    const registry = await res.json();
    await chrome.storage.local.set({ vendorRegistry: registry });
    return registry;
  } catch (e) {
    return null;
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

chrome.runtime.onInstalled.addListener((details) => {
  loadVendorRegistry().catch(() => {});
  seedVendorSettings((details && details.reason) || "install").catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  loadVendorRegistry().catch(() => {});
});

// Re-cache the registry on service-worker start (survives eviction).
loadVendorRegistry().catch(() => {});

