// background.js - Manages the icon badge and popup message routing (export / manual sync / status).
// Captures x-server-id from opencode.ai/_server requests at the browser level.
// (webRequest events wake the SW, so there is no cold-start race; even the first
// request of a page load is intercepted.)
importScripts("time-reminder.js");

let lastCapturedServerID = null;

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const headers = details.requestHeaders || [];
    const serverID = headers.find((h) => h.name.toLowerCase() === "x-server-id")?.value;
    if (!serverID || details.tabId === -1) return;
    if (serverID === lastCapturedServerID) return; // Dedupe so our own crawl requests don't loop
    lastCapturedServerID = serverID;
    chrome.storage.local.set({ lastServerID: serverID });
    chrome.tabs
      .sendMessage(details.tabId, { type: "server-id", serverID })
      .catch(() => {}); // Ignore if the content script isn't ready; later requests re-trigger
  },
  { urls: ["https://opencode.ai/_server*"] },
  ["requestHeaders"]
);

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
      if (tabId !== undefined && tabId !== null) {
        chrome.action.setBadgeText({ tabId, text: "" });
      }
      chrome.storage.local.set({
        lastSyncAt: Date.now(),
        lastSyncCount: msg.newRecords || 0,
        lastSyncWorkspace: msg.workspaceID || "",
        totalRecords: count,
        crawlState: {
          running: false,
          done: true,
          page: msg.lastPage || 0,
          workspace: msg.workspaceID || "",
          message: msg.stopReason ? `Crawl stopped: ${msg.stopReason}` : "",
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
      sendStartCrawl(!!msg.rescan)
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
  }
});

function setBadge(sender, text, color) {
  const tabId = sender && sender.tab && sender.tab.id;
  if (tabId === undefined || tabId === null) return;
  chrome.action.setBadgeText({ tabId, text });
  chrome.action.setBadgeBackgroundColor({ tabId, color });
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
  const tab = await findUsageTab();
  if (!tab) {
    const tabs = await chrome.tabs.query({ url: ["https://opencode.ai/*"] });
    const urls = tabs.map((t) => t.url || "(no url)").join(" | ") || "(no opencode.ai tabs)";
    return { ok: false, error: `No usage tab found. Open tabs: ${urls}` };
  }

  const res = await sendMessageToTab(tab.id, { type: "start-crawl", rescan });
  if (!res) return { ok: false, error: `Content script did not respond (tab url: ${tab.url})` };
  if (!res.ok) {
    return { ...res, error: `${res.error} (tab url: ${tab.url})` };
  }
  return res;
}

async function sendGetStatus() {
  const tab = await findUsageTab();
  if (tab) {
    try {
      const res = await sendMessageToTab(tab.id, { type: "get-status" });
      if (res && res.ok) return res;
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
  return { ok: false, error: "No cached data - open the opencode.ai usage page and sync first" };
}

async function stashMergedData(tabId) {
  try {
    const res = await sendMessageToTab(tabId, { type: "export-json" });
    if (!res || !res.ok) return;
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
  } catch (e) {
    // Content script unavailable - skip
  }
}

// Merged OPFS snapshot for the dashboard. Tries a live export from any open
// opencode.ai tab (which reads OPFS directly); falls back to the last cached
// snapshot so the dashboard survives refreshes even with no tab open.
async function sendDashboardData() {
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
        return { ok: true, data: res.data, count: res.count, fileCount: res.fileCount, fromCache: false };
      }
    } catch (e) {
      // Content script unavailable - fall back to cache
    }
  }
  const { cachedData, cachedMeta } = await chrome.storage.local.get(["cachedData", "cachedMeta"]);
  if (cachedData) {
    return {
      ok: true,
      data: cachedData,
      count: (cachedMeta && cachedMeta.count) || 0,
      fileCount: (cachedMeta && cachedMeta.fileCount) || 0,
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
