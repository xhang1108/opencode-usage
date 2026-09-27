// vendors/opencode/api.js
// opencode Console Request Log client (isolated world on opencode.ai).
//
// The old per-request endpoint GET /console/api/usage/rows was removed
// (404, empty body). The replacement is the Console request log:
//
//   GET /console/api/request-logs?category=inference&limit=100&since=<ms>&cursor=...&until=...
//   headers: x-org-id: <org_|wrk_...>   (the first /console/<org>/ path segment)
//   auth: the page's session cookie (credentials: include)
//
// Response: {items, nextCursor, until, retentionDays:30}. items are newest-first;
// iterate with cursor+until together (cursor alone 409s with
// RequestLogCursorRestartRequired). `since`/`until` are ms epochs.
// retentionDays is 30, so a full sync covers ~30d, not full history.
//
// Records are posted to background via the generic vendor protocol
// (vendor-crawl-data / vendor-crawl-done) like the other vendor crawlers.

(() => {
  if (window.__opencodeApiLoaded) return;
  window.__opencodeApiLoaded = true;

  const SOURCE = "opencode";
  const ROWS_PATH = "/console/api/request-logs";
  const CATEGORY = "inference";
  const PAGE_SIZE = 100; // server max (the query schema caps limit at 100)
  const MAX_PAGES = 10000; // guard against a bad cursor
  const MAX_RETRIES = 4; // on 429/503, honour Retry-After then retry
  const DELAY_MS = 0; // no fixed pacing; back off only when the server says so
  const RETENTION_MS = 30 * 864e5;
  const OVERLAP_MS = 864e5; // 1d overlap on incremental runs

  let crawling = false;

  const notify = (msg) => {
    try {
      const p = chrome.runtime.sendMessage(msg);
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch (e) {}
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Mirror lifecycle events to the page console so the chosen window / page
  // counts are visible in DevTools (the popup text is truncated).
  const clog = (...args) => { try { console.log("[opencode-usage]", ...args); } catch (e) {} };

  async function loadMapper() {
    return import(chrome.runtime.getURL("vendors/opencode/mapper.js"));
  }

  // Read live from the URL: opencode.ai is a SPA, so the org can appear after
  // injection (e.g. /console redirecting to the default workspace).
  function orgId() {
    const m = window.location.pathname.match(/^\/console\/((?:org_|wrk_)[^/]+)/);
    return m ? m[1] : null;
  }

  // Track the last visited org so the popup "Open Usage" link can point at it.
  function trackVisited() {
    const org = orgId();
    if (org) {
      try { chrome.storage.local.set({ lastVisitedWorkspace: org, lastVisitedAt: Date.now() }); } catch (e) {}
    }
  }
  trackVisited();
  setInterval(trackVisited, 1000);
  try {
    const _push = history.pushState;
    history.pushState = function (...a) { const r = _push.apply(this, a); trackVisited(); return r; };
    const _replace = history.replaceState;
    history.replaceState = function (...a) { const r = _replace.apply(this, a); trackVisited(); return r; };
  } catch (e) {}
  window.addEventListener("popstate", trackVisited);

  // 429/503 backoff: prefer the server's Retry-After (seconds or HTTP-date),
  // else exponential (1s, 2s, 4s, 8s), capped so a long ban can't hang the run.
  function retryDelayMs(res, attempt) {
    const h = res && res.headers && res.headers.get("retry-after");
    if (h) {
      const secs = Number(h);
      if (Number.isFinite(secs)) return Math.min(60000, Math.max(0, secs * 1000));
      const when = Date.parse(h);
      if (!Number.isNaN(when)) return Math.min(60000, Math.max(0, when - Date.now()));
    }
    return 1000 * Math.pow(2, attempt);
  }

  async function fetchPage({ org, since, cursor, until }) {
    const p = new URLSearchParams({ category: CATEGORY, limit: String(PAGE_SIZE) });
    if (since != null) p.set("since", String(since));
    if (cursor) p.set("cursor", cursor);
    if (until != null) p.set("until", String(until));
    const url = `${ROWS_PATH}?${p.toString()}`;
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, {
        headers: { "x-org-id": org, accept: "application/json" },
        credentials: "include",
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch (e) {}
      if ((res.status === 429 || res.status === 503) && attempt < MAX_RETRIES) {
        const wait = retryDelayMs(res, attempt);
        notify({ type: "progress", message: `Rate limited (HTTP ${res.status}) — waiting ${Math.round(wait / 1000)}s` });
        await sleep(wait);
        continue;
      }
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          throw new Error("opencode: not signed in — open the Console and sign in");
        }
        const tag = json && json._tag
          ? `${json._tag}${json.message ? `: ${json.message}` : ""}`
          : `HTTP ${res.status}`;
        throw new Error(`opencode: usage request failed (${tag})`);
      }
      if (!json || !Array.isArray(json.items)) {
        const tag = json && json._tag
          ? `${json._tag}${json.message ? `: ${json.message}` : ""}`
          : "unexpected response";
        throw new Error(`opencode: ${tag}`);
      }
      return json;
    }
  }

  async function crawl({ knownNewest, full }) {
    const mapper = await loadMapper();
    const org = orgId();
    if (!org) {
      throw new Error("Open the opencode.ai Console page first (no workspace in the URL)");
    }
    // Rows are newest-first. For an incremental run, stop once a page reaches the
    // newest timestamp already stored (everything older is known), so one page is
    // usually enough. `full` ignores the marker and walks the ~30d retention.
    // `since`/`until` are ms epochs; overlap by a day so boundary rows aren't lost.
    const stopAt = full ? null : (knownNewest || null);
    const stopAtMs = stopAt ? Date.parse(stopAt) : null;
    const sinceMs = full
      ? Date.now() - RETENTION_MS
      : (stopAtMs != null && !isNaN(stopAtMs) ? stopAtMs - OVERLAP_MS : Date.now() - RETENTION_MS);
    clog(`sync start: org=${org} stopAt=${stopAt || "(none, full scan)"} since=${new Date(sinceMs).toISOString()}`);
    let cursor = null;
    let until = null;
    let page = 0;
    let fetched = 0;
    let added = 0;
    while (page < MAX_PAGES) {
      const json = await fetchPage({ org, since: sinceMs, cursor, until });
      const rows = json.items || [];
      const recs = mapper.mapUsageRows(rows);
      if (recs.length > 0) {
        fetched += recs.length;
        try {
          const res = await chrome.runtime.sendMessage({ type: "vendor-crawl-data", source: SOURCE, records: recs });
          if (res && typeof res.added === "number") added += res.added;
          if (res && res.ok === false) throw new Error(res.error || "background rejected the batch");
        } catch (e) {
          throw new Error(String((e && e.message) || e));
        }
      }
      page++;
      notify({ type: "progress", page, workspace: org, message: `page ${page}: ${fetched} rows (${added} new)` });
      clog(`page ${page}: fetched=${fetched} added=${added} cursor=${json.nextCursor ? "yes" : "end"}`);
      const last = rows.length ? rows[rows.length - 1] : null;
      const oldestMs = last ? Number(last.startedAt) : null;
      if (!json.nextCursor) break;
      if (stopAtMs != null && !isNaN(stopAtMs) && oldestMs != null && oldestMs < stopAtMs) {
        clog(`page ${page}: reached known data (${new Date(oldestMs).toISOString()} < ${stopAt}) — stopping`);
        break;
      }
      cursor = json.nextCursor || null;
      until = json.until != null ? json.until : null;
      await sleep(DELAY_MS);
    }
    return { records: fetched, added };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== "start-crawl") return;
    if (msg.vendor && msg.vendor !== SOURCE) return;
    if (crawling) {
      sendResponse({ ok: true, started: false, reason: "busy" });
      return;
    }
    crawling = true;
    notify({ type: "crawl-start", workspace: orgId() || "" });
    crawl({ knownNewest: msg.knownNewest, full: !!(msg.full || msg.rescan) })
      .then((res) => notify({ type: "vendor-crawl-done", source: SOURCE, records: res.records, newRecords: res.added }))
      .catch((e) => notify({ type: "error", message: String((e && e.message) || e) }))
      .finally(() => { crawling = false; });
    sendResponse({ ok: true, started: true });
  });
})();
