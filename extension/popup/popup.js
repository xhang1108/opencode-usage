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

async function loadStatus() {
  const stored = await chrome.storage.local.get([
    "lastSyncAt",
    "lastSyncCount",
    "lastSyncWorkspace",
    "totalRecords",
    "cachedMeta",
    "crawlState",
  ]);

  // Live progress of an in-flight crawl (page number).
  const cs = stored.crawlState;
  const progressRow = $("#crawl-progress-row");
  const progressEl = $("#crawl-progress");
  if (cs && cs.running) {
    progressRow.style.display = "flex";
    progressEl.textContent = `Page ${cs.page}... (${cs.rescan ? "rescan" : "sync"} in progress)`;
  } else if (cs && cs.error) {
    progressRow.style.display = "flex";
    progressEl.textContent = `Error: ${cs.error}`;
  } else if (cs && cs.message) {
    progressRow.style.display = "flex";
    progressEl.textContent = cs.message;
  } else {
    progressRow.style.display = "none";
  }

  if (stored.lastSyncAt) $("#last-sync").textContent = new Date(stored.lastSyncAt).toLocaleString();
  if (stored.lastSyncCount !== undefined) $("#last-sync-count").textContent = stored.lastSyncCount;
  if (stored.lastSyncWorkspace) $("#workspace").textContent = stored.lastSyncWorkspace;
  if (stored.totalRecords !== undefined) $("#total-records").textContent = stored.totalRecords;
  renderLastRecord(stored.cachedMeta && stored.cachedMeta.lastRecord);

  // Ask the content script for live OPFS status; falls back to the cached
  // overview when no usage tab is open.
  const res = await chrome.runtime.sendMessage({ type: "get-status" });
  if (res && res.ok) {
    $("#total-records").textContent = res.totalRecords;
    $("#cache-list").textContent =
      res.files.map((f) => `${f.name}: ${f.count}`).join(" · ") || "(no OPFS cache)";
    if (res.lastRecord) renderLastRecord(res.lastRecord);
  } else {
    $("#cache-list").textContent = res && res.error ? `(${res.error})` : "(no usage tab open)";
  }
}

async function send(msg) {
  setBusy(true);
  setStatus("Processing...", true);
  try {
    const res = await chrome.runtime.sendMessage(msg);
    if (res && res.ok) {
      if (msg.type === "start-crawl") {
        const label = msg.rescan ? "Rescan" : "Sync";
        if (res.started) setStatus(`${label} started - watch the icon badge`, true);
        else if (res.reason === "busy") setStatus("Sync already in progress", true);
        else setStatus("Sync requested (waiting for server ID)", true);
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
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.crawlState || changes.lastSyncAt || changes.totalRecords) {
    loadStatus();
  }
});
