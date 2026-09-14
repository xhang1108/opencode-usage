// popup.js - Shows sync status and triggers background actions.
import {
  TIME_MODEL_KEY,
  isPeakAt,
  buildTimeline,
  nextPeakBoundary,
  formatCountdownClock,
  loadTimeEnabled,
  saveTimeEnabled,
  loadTimeRates,
  loadTimeModel,
  collectPeakWindowsForModel,
} from "../shared/time-reminder.js";

const $ = (sel) => document.querySelector(sel);

const statusEl = $("#status");

// ===== Crawl button label =====
// The main crawl button mirrors the provider chosen as default in Settings ->
// General, so the label reads "Crawl <Provider>". Holding Shift flips it to
// "Full Scan <Provider>" so the user can see the click will re-crawl everything.
let defaultCrawlLabel = "OpenCode";
let shiftHeld = false;

function updateCrawlButtonLabel() {
  const btn = $("#btn-sync");
  if (!btn) return;
  btn.textContent = shiftHeld ? `Full Scan ${defaultCrawlLabel}` : `Crawl ${defaultCrawlLabel}`;
  btn.title = shiftHeld
    ? `Click to re-crawl ALL ${defaultCrawlLabel} data from scratch`
    : `Click to crawl ${defaultCrawlLabel} now · hold Shift for a full scan`;
}

async function loadDefaultCrawlLabel() {
  const stored = await chrome.storage.local.get(["defaultCrawl", "vendorRegistry"]);
  const src = stored.defaultCrawl || "opencode";
  const vendors = (stored.vendorRegistry && stored.vendorRegistry.vendors) || [];
  const v = vendors.find((x) => x.source === src);
  defaultCrawlLabel = v && v.label ? v.label : src.charAt(0).toUpperCase() + src.slice(1);
  updateCrawlButtonLabel();
}

function setStatus(text, ok, warn) {
  statusEl.textContent = text;
  statusEl.className = ok ? "ok" : warn ? "warn" : "err";
}

function setBusy(busy) {
  ["#btn-dashboard", "#btn-sync", "#btn-rescan", "#btn-sync-menu"].forEach((sel) => {
    const el = $(sel);
    if (el) el.disabled = busy;
  });
}

function formatDateTime(rec) {
  if (rec.time) {
    const d = new Date(rec.time);
    if (!isNaN(d.getTime())) {
      const pad = (n) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
  }
  return rec.date || "-";
}

function renderLastRecord(lr) {
  const el = $("#last-record");
  if (!lr) {
    el.textContent = "-";
    el.title = "";
    return;
  }
  // Show date+time; details (model/tokens) go into the hover tooltip.
  el.textContent = formatDateTime(lr);
  el.title = lr.model ? `${lr.model} · I${(lr.input || 0).toLocaleString()} O${(lr.output || 0).toLocaleString()}` : "";
}

function renderUsageLink(workspaceID) {
  const link = $("#usage-link");
  const empty = $("#usage-link-empty");
  if (!link || !empty) return;
  if (workspaceID && /^wrk_/.test(workspaceID)) {
    const url = `https://opencode.ai/workspace/${workspaceID}/usage`;
    link.href = url;
    link.textContent = "Open Usage ↗";
    link.title = url;
    link.style.display = "";
    empty.style.display = "none";
    link.onclick = (e) => {
      e.preventDefault();
      chrome.tabs.create({ url });
    };
  } else {
    link.style.display = "none";
    link.removeAttribute("href");
    empty.style.display = "";
  }
}

// Show the update banner when the background found a newer GitHub release.
async function renderUpdateBanner() {
  const { updateInfo } = await chrome.storage.local.get("updateInfo");
  const banner = $("#update-banner");
  if (!banner || !updateInfo || !updateInfo.updateAvailable) return;
  $("#update-version").textContent = updateInfo.latestVersion;
  $("#update-link").href = updateInfo.releaseUrl;
  banner.style.display = "block";
}

async function loadStatus() {
  const stored = await chrome.storage.local.get([
    "lastSyncAt",
    "lastSyncCount",
    "lastSyncWorkspace",
    "lastVisitedWorkspace",
    "totalRecords",
    "cachedMeta",
    "crawlState",
  ]);

  // Show a minimal status line only while a crawl is running or errored.
  // Once finished, the Last Sync / New Records rows already show the result.
  const cs = stored.crawlState;
  const progressRow = $("#crawl-progress-row");
  const progressEl = $("#crawl-progress");
  if (cs && cs.running) {
    progressRow.style.display = "flex";
    const msg = cs.message ? cs.message : "Syncing...";
    progressEl.textContent = msg.length > 90 ? msg.slice(0, 90) + "…" : msg;
  } else if (cs && cs.error) {
    progressRow.style.display = "flex";
    progressEl.textContent = `Error: ${cs.error}`;
  } else if (cs && cs.done && (cs.warning || cs.serverEmpty)) {
    // B10: crawl completed but produced nothing - don't fail silently.
    // D21: the server had no records for this workspace; the rows below still
    // show the last synced data, so say that instead of looking broken.
    progressRow.style.display = "flex";
    progressEl.textContent = cs.message || (cs.serverEmpty
      ? "Server has no records for this workspace — showing last synced data"
      : "Crawler returned no records");
  } else {
    progressRow.style.display = "none";
  }

  if (stored.lastSyncAt) $("#last-sync").textContent = new Date(stored.lastSyncAt).toLocaleString();
  if (stored.lastSyncCount !== undefined) $("#last-sync-count").textContent = stored.lastSyncCount;
  if (stored.totalRecords !== undefined) $("#total-records").textContent = stored.totalRecords;
  renderLastRecord(stored.cachedMeta && stored.cachedMeta.lastRecord);
  // Usage link: auto-build https://opencode.ai/workspace/<wrk_...>/usage
  // Priority: last visited (user's most recent workspace) > last sync
  const wsFromStored =
    (stored.lastVisitedWorkspace && /^wrk_/.test(stored.lastVisitedWorkspace) && stored.lastVisitedWorkspace) ||
    (stored.lastSyncWorkspace && /^wrk_/.test(stored.lastSyncWorkspace) && stored.lastSyncWorkspace) ||
    (stored.cachedMeta && stored.cachedMeta.lastRecord && stored.cachedMeta.lastRecord.workspaceID) ||
    (stored.crawlState && stored.crawlState.workspace) ||
    "";
  renderUsageLink(wsFromStored);

  // While a crawl is running the progress ticks already arrive via storage;
  // skip the live query because it re-parses the whole OPFS cache on every tick.
  if (cs && cs.running) return;

  // Live status from the content script; falls back to the cached overview.
  try {
    const res = await chrome.runtime.sendMessage({ type: "get-status" });
    if (res && res.ok) {
      $("#total-records").textContent = res.totalRecords;
      if (res.lastRecord) {
        renderLastRecord(res.lastRecord);
        if (res.lastRecord.workspaceID) renderUsageLink(res.lastRecord.workspaceID);
      }
    }
  } catch (e) {
    // "Receiving end does not exist" = background SW not yet ready — fallback to cached data already rendered
  }

  renderUpdateBanner();
}

async function send(msg) {
  setBusy(true);
  setStatus("Processing...", true);
  try {
    const res = await chrome.runtime.sendMessage(msg);
    if (res && res.ok) {
      if (msg.type === "start-crawl") {
        if (res.openedUsage) {
          setStatus(res.started ? "Opened Usage page & sync started" : "Opened Usage page - syncing...", true);
        } else {
          const label = msg.rescan ? "Rescan" : "Sync";
          if (res.started) setStatus(`${label} started - watch the icon badge`, true);
          else if (res.reason === "busy") setStatus("Sync already in progress", true);
          else setStatus("Sync requested (waiting for server ID)", true);
        }
      } else if (msg.type === "open-dashboard") {
        setStatus(
          `Dashboard opened (${res.fromCache ? "cached" : "latest"} data, ${res.count} records)`,
          true
        );
      }
    } else {
      setStatus(`Error: ${(res && res.error) || "unknown error"}`, false);
    }
  } catch (e) {
    setStatus(`Error: ${e.message}`, false);
  } finally {
    setBusy(false);
  }
  loadStatus();
}

$("#btn-dashboard").addEventListener("click", () => send({ type: "open-dashboard" }));
// Flip the button label while Shift is held so the user knows the click will
// perform a full scan instead of a normal crawl.
function setShiftHeld(held) {
  if (shiftHeld === held) return;
  shiftHeld = held;
  updateCrawlButtonLabel();
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Shift") setShiftHeld(true);
});
document.addEventListener("keyup", (e) => {
  if (e.key === "Shift") setShiftHeld(false);
});
// Reset if focus leaves the popup while Shift is down.
window.addEventListener("blur", () => setShiftHeld(false));

$("#btn-sync").addEventListener("click", async (e) => {
  // D10: crawl the vendor selected as default in Settings -> General.
  let vendor = "opencode";
  let note = "";
  try {
    const stored = await chrome.storage.local.get(["defaultCrawl", "totalRecords", "cachedMeta"]);
    if (stored.defaultCrawl) vendor = stored.defaultCrawl;
    const n = stored.totalRecords != null ? stored.totalRecords : stored.cachedMeta && stored.cachedMeta.count;
    if (n) note = `\n\nCurrently stored: ${Number(n).toLocaleString()} records.`;
  } catch (err) {}
  const full = e.shiftKey;
  if (full && !confirm(`Re-crawl ALL ${vendor} data from scratch?${note}\n\nThis re-fetches the full history (more server requests, can take several minutes) and overwrites existing records.`)) return;
  send({ type: "start-crawl", vendor, full, rescan: full });
});

// Vendor picker: list enabled vendors; crawl-capable ones are clickable, the
// rest are shown disabled (D10).
function isVendorEnabled(src, vendorSettings) {
  const v = (vendorSettings || {})[src];
  if (v === false) return false;
  if (v === true) return true;
  return src === "opencode";
}

async function renderCrawlMenu() {
  const menu = $("#sync-menu");
  const caret = $("#btn-sync-menu");
  if (!menu || !caret) return;
  const stored = await chrome.storage.local.get(["vendorRegistry", "vendorSettings"]);
  const vendors = (stored.vendorRegistry && stored.vendorRegistry.vendors) || [];
  // Only vendors that are enabled AND have a crawler.
  const crawlable = vendors.filter((v) => v.crawl && isVendorEnabled(v.source, stored.vendorSettings));
  menu.innerHTML = "";
  if (crawlable.length <= 1) {
    // Nothing to choose (or only one) - hide the picker entirely.
    menu.hidden = true;
    caret.hidden = true;
    return;
  }
  caret.hidden = false;
  for (const v of crawlable) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "split-item";
    item.textContent = v.label || v.source;
    item.addEventListener("click", (e) => {
      menu.hidden = true;
      const full = e.shiftKey;
      if (full && !confirm(`Re-crawl ALL ${v.label || v.source} data from scratch?\n\nThis re-fetches the full history (more server requests, can take several minutes) and overwrites existing records.`)) return;
      send({ type: "start-crawl", vendor: v.source, full, rescan: full });
    });
    menu.appendChild(item);
  }
}

$("#btn-sync-menu").addEventListener("click", (e) => {
  e.stopPropagation();
  const menu = $("#sync-menu");
  menu.hidden = !menu.hidden;
});
document.addEventListener("click", (e) => {
  const menu = $("#sync-menu");
  if (menu && !menu.hidden && !e.target.closest("#crawl-split") && !e.target.closest("#sync-menu")) {
    menu.hidden = true;
  }
});
renderCrawlMenu();
loadDefaultCrawlLabel();
// Rescan button is hidden (commented in popup.html). Uncomment to re-enable:
// $("#btn-rescan").addEventListener("click", () => send({ type: "start-crawl", rescan: true }));

loadStatus();

// Live-refresh while a crawl is running: storage changes (progress, completion)
// immediately update the popup instead of requiring a reopen.
// Throttled: a long crawl updates crawlState on every page, so reload at most
// every 300ms. A running->done/error transition always reloads to show the result.
let lastStatusReload = 0;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.defaultCrawl) loadDefaultCrawlLabel();
  if (!(changes.crawlState || changes.lastSyncAt || changes.totalRecords || changes.cachedMeta || changes.lastSyncWorkspace || changes.lastVisitedWorkspace)) return;
  const cs = changes.crawlState;
  const wasRunning = !!(cs && cs.oldValue && cs.oldValue.running);
  const nowRunning = !!(cs && cs.newValue && cs.newValue.running);
  if (wasRunning && !nowRunning) lastStatusReload = 0; // Completion always renders
  const now = Date.now();
  if (now - lastStatusReload < 300) return;
  lastStatusReload = now;
  loadStatus();
});

// ===== Time reminder =====
const timeStatusEl = $("#time-status");
const timeCountdownEl = $("#time-countdown");
const timeTimelineEl = $("#time-timeline");
const timeToggleEl = $("#time-toggle");

let timePeakWindows = [];
let timeRates = null;

function renderTimeReminder() {
  const now = new Date();

  const peak = isPeakAt(now, timePeakWindows);
  const hasWindows = timePeakWindows.length > 0;

  // Status badge
  timeStatusEl.className = "time-status " + (hasWindows ? (peak ? "peak" : "offpeak") : "flat");
  timeStatusEl.textContent = hasWindows ? (peak ? "PEAK" : "OFF-PEAK") : "NO RATES";

  // 24h timeline (laid out in local time)
  const timeline = buildTimeline(timePeakWindows);
  const nowHour = now.getHours();
  timeTimelineEl.innerHTML = timeline
    .map((seg) => `<div class="seg ${seg.peak ? "peak" : ""} ${seg.hour === nowHour ? "now" : ""}" title="${String(seg.hour).padStart(2, "0")}:00"></div>`)
    .join("");

  // Countdown to the next peak boundary (start or end), ticking every second
  if (hasWindows) {
    timeCountdownEl.className = "time-countdown " + (peak ? "peak" : "offpeak");
    const boundary = nextPeakBoundary(now, timePeakWindows);
    timeCountdownEl.textContent = boundary ? formatCountdownClock(boundary.time - now) : "--:--:--";
  } else {
    timeCountdownEl.className = "time-countdown flat";
    timeCountdownEl.textContent = "NO RATES";
  }
}

async function initTimeReminder() {
  // Load toggle state
  timeToggleEl.checked = await loadTimeEnabled();
  timeToggleEl.addEventListener("change", () => saveTimeEnabled(timeToggleEl.checked));

  // Load the mirrored rate config.
  timeRates = await loadTimeRates();

  // Read the model selected in the dashboard (stored in chrome.storage).
  const selected = await loadTimeModel();
  timePeakWindows = collectPeakWindowsForModel(timeRates, selected);

  // When the dashboard changes the selected model, update the popup live.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[TIME_MODEL_KEY]) {
      timePeakWindows = collectPeakWindowsForModel(timeRates, changes[TIME_MODEL_KEY].newValue);
      renderTimeReminder();
    }
  });

  renderTimeReminder();
  setInterval(renderTimeReminder, 1000);
}

initTimeReminder();
