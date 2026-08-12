// background.js - Manages the icon badge and popup message routing (export / manual sync / status).
// Captures x-server-id from opencode.ai/_server requests at the browser level.
// (webRequest events wake the SW, so there is no cold-start race; even the first
// request of a page load is intercepted.)
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
      setBadge(sender, "...", "#f59e0b");
      chrome.storage.local.set({
        crawlState: { running: true, page: 0, workspace: msg.workspace || "", rescan: !!msg.rescan },
      });
      sendResponse({ ok: true });
      break;
    }

    case "progress": {
      const page = msg.page || 0;
      const label = page >= 1000 ? `${(page / 1000).toFixed(1)}k` : String(page);
      setBadge(sender, label, "#f59e0b");
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
      setBadge(sender, msg.type === "error" ? "ERR" : "", msg.type === "error" ? "#ef4444" : "#94a3b8");
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

async function handleOpenDashboard() {
  let data = null;
  let count = 0;
  let fileCount = 0;
  let fromCache = false;

  // When an opencode.ai tab is open, fetch fresh data and refresh the cache.
  const tab = await findAnyOpencodeTab();
  if (tab) {
    try {
      const res = await sendMessageToTab(tab.id, { type: "export-json" });
      if (res && res.ok) {
        data = res.data;
        count = res.count;
        fileCount = res.fileCount;
        await chrome.storage.local.set({
          cachedData: data,
          cachedMeta: {
            count,
            fileCount,
            files: res.files || [],
            lastRecord: res.lastRecord || null,
            updatedAt: Date.now(),
          },
        });
      }
    } catch (e) {
      // Content script unavailable - fall back to cache
    }
  }

  // No page open - use the last cached data.
  if (!data) {
    const { cachedData, cachedMeta } = await chrome.storage.local.get(["cachedData", "cachedMeta"]);
    if (cachedData) {
      data = cachedData;
      count = (cachedMeta && cachedMeta.count) || 0;
      fileCount = (cachedMeta && cachedMeta.fileCount) || 0;
      fromCache = true;
    }
  }

  if (data) {
    await chrome.storage.local.set({ dashboardData: data });
  } else {
    await chrome.storage.local.remove("dashboardData");
  }
  await chrome.tabs.create({ url: chrome.runtime.getURL("dashboard/dashboard.html") });
  return { ok: true, count, fileCount, fromCache };
}
