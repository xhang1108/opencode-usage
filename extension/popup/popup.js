// popup.js - Shows sync status and triggers background actions.
const $ = (sel) => document.querySelector(sel);

const statusEl = $("#status");

function setStatus(text, ok) {
  statusEl.textContent = text;
  statusEl.className = ok ? "ok" : "err";
}

function setBusy(busy) {
  ["#btn-dashboard", "#btn-sync", "#btn-rescan"].forEach((sel) => {
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
$("#btn-sync").addEventListener("click", () => send({ type: "start-crawl" }));
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
