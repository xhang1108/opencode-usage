// content.js - Runs in the isolated world: crawls usage data and talks to background/popup.
(() => {
  if (window.__opencodeExtContentLoaded) return;
  window.__opencodeExtContentLoaded = true;

  // Read live from the URL (opencode.ai is a SPA, the workspace can change after injection).
  const getWorkspaceID = () => {
    const m = window.location.pathname.match(/\/workspace\/(wrk_[^\/]+)/);
    return m ? m[1] : null;
  };
  // Checked live because opencode.ai is a SPA - the pathname can change after
  // injection (e.g. navigating to the usage tab later).
  const isUsagePage = () => !!getWorkspaceID() && /\/usage(?:\/|$|\?|#)/.test(window.location.pathname);

  let crawling = false;
  let lastServerID = null;
  let pendingCrawl = null; // Pending crawl awaiting a serverID { forceRescan }
  let exportCache = null;  // In-memory merged export cache (see readAllCache)

  const notify = (msg) => {
    try {
      const p = chrome.runtime.sendMessage({ ...msg, source: "content" });
      if (p && typeof p.catch === "function") p.catch(() => {}); // Silence when the context was invalidated
    } catch (e) {
      // Ignore when the background isn't ready or the extension was reloaded
    }
  };
  // Mirror of notify for the page console (DevTools): popup/badge text is
  // truncated and invisible when closed, so lifecycle events also go here.
  const clog = (...args) => { try { console.log("[opencode-usage]", ...args); } catch (e) {} };

  // Safe chrome.storage wrappers: return fallback values if the context was invalidated.
  const storageGet = async (keys, fallback = {}) => {
    try {
      return (await chrome.storage.local.get(keys)) || fallback;
    } catch (e) {
      return fallback;
    }
  };
  const storageSet = async (obj) => {
    try {
      await chrome.storage.local.set(obj);
    } catch (e) {}
  };
  const storageRemove = async (key) => {
    try {
      await chrome.storage.local.remove(key);
    } catch (e) {}
  };

  // Track last visited workspace so Crawl Now can jump to the most recent one
  let lastSeenWorkspace = null;
  function trackVisitedWorkspace() {
    const ws = getWorkspaceID();
    if (ws && ws !== lastSeenWorkspace) {
      lastSeenWorkspace = ws;
      storageSet({ lastVisitedWorkspace: ws, lastVisitedAt: Date.now() });
    }
  }
  trackVisitedWorkspace();
  setInterval(trackVisitedWorkspace, 1000);
  try {
    const _push = history.pushState;
    history.pushState = function (...a) { const r = _push.apply(this, a); trackVisitedWorkspace(); return r; };
    const _replace = history.replaceState;
    history.replaceState = function (...a) { const r = _replace.apply(this, a); trackVisitedWorkspace(); return r; };
  } catch (e) {}
  window.addEventListener("popstate", trackVisitedWorkspace);

  // Find pagination controls (button / li / a / role=button / aria-label / icon chars).
  function findPageControl(pattern) {
    try {
      const ariaSels = [
        'button[aria-label*="next"], button[aria-label*="Next"]',
        'button[title*="Next"], button[title*="next"]',
        'li[aria-label*="next"], li[title*="next"]',
        '[role="button"][aria-label*="next"]',
        'a[aria-label*="next"]',
      ];
      for (const sel of ariaSels) {
        const el = document.querySelector(sel);
        if (el && !el.disabled) return el;
      }
      const nodes = Array.from(document.querySelectorAll("button, [role=button], li, a, span[role=button]"));
      return (
        nodes.find((n) => {
          const txt = (n.textContent || "").trim();
          const aria = (n.getAttribute("aria-label") || "") + " " + (n.getAttribute("title") || "");
          return pattern.test(txt) || pattern.test(aria);
        }) || null
      );
    } catch (e) {
      return null;
    }
  }

  // Pagination controls can be icon-only buttons (chevron svg, no text/aria).
  // Detect them by the direction of their arrow path. To avoid confusing them
  // with other icon buttons (e.g. month pickers), only accept a button when a
  // left AND a right chevron share the same text-less container. The result is
  // cached so repeated kicks click the same buttons instead of re-scanning.
  let cachedPagination = null;
  let cachedPaginationAt = 0;

  function findIconPagination(force = false) {
    if (!force && cachedPagination && Date.now() - cachedPaginationAt < 60000) {
      if (cachedPagination.next && cachedPagination.next.isConnected) return cachedPagination;
    }
    const found = { next: null, prev: null };
    try {
      const lefts = [];
      const rights = [];
      for (const btn of document.querySelectorAll("button")) {
        if ((btn.textContent || "").trim()) continue; // Text buttons are handled elsewhere
        const path = btn.querySelector("svg path");
        if (!path) continue;
        const d = (path.getAttribute("d") || "").trim();
        if (!d.includes("L")) continue;
        const nums = (d.match(/-?\d+(\.\d+)?/g) || []).map(Number);
        if (nums.length < 4) continue; // Need at least M x0 y0 L x1 y1
        const x0 = nums[0], x1 = nums[2];
        if (x1 > x0) rights.push(btn);    // Arrow points right
        else if (x1 < x0) lefts.push(btn); // Arrow points left
      }
      // A real pagination area contains both directions with no label text
      // between them (month pickers usually wrap their label in the container).
      for (const nextBtn of rights) {
        let el = nextBtn.parentElement;
        let container = null;
        for (let i = 0; i < 5 && el; i++) {
          if (lefts.some((l) => el.contains(l))) {
            container = el;
            break;
          }
          el = el.parentElement;
        }
        if (!container) continue;
        const text = (container.textContent || "").trim();
        if (text) continue; // Labeled container (month/period picker) - skip
        const prevBtn = lefts.find((l) => container.contains(l));
        if (!found.next && !nextBtn.disabled) found.next = nextBtn;
        if (!found.prev && prevBtn && !prevBtn.disabled) found.prev = prevBtn;
        if (found.next) break;
      }
    } catch (e) {}
    cachedPagination = found;
    cachedPaginationAt = Date.now();
    return found;
  }

  // Force the page to fire a /_server request to obtain a serverID
  // (click a pagination button; scroll the table as a lazy-load fallback).
  let kickLock = false; // Prevent overlapping clicks
  function kickPageRequest() {
    if (kickLock) return;
    kickLock = true;
    try {
      let next = findPageControl(/Next|next|›|»|❯|⟩/);
      let prev = findPageControl(/Prev|Previous|‹|«|❮|⟨/);
      if (!next && !prev) {
        // Icon-only pagination (chevron svg buttons with no text).
        const icons = findIconPagination();
        next = icons.next;
        prev = icons.prev;
      }
      const btn = next || prev;
      if (btn) {
        const dir = next ? "next" : "prev";
        // React pagination usually listens on the inner button/a, not the outer
        // li wrapper - drill down to the deepest clickable element.
        const clickable =
          btn.closest("button,a") ||
          btn.querySelector("button,a") ||
          (btn.tagName === "BUTTON" || btn.tagName === "A" ? btn : null);
        const target = clickable || btn;
        // Dispatch a full mouse sequence so React handlers fire.
        const opts = { bubbles: true, cancelable: true, view: window };
        target.dispatchEvent(new MouseEvent("mousedown", opts));
        target.dispatchEvent(new MouseEvent("mouseup", opts));
        target.dispatchEvent(new MouseEvent("click", opts));
        // After clicking "next", click back after 1.5s to restore the page position.
        if (dir === "next") {
          setTimeout(() => {
            try {
              let back = findPageControl(/Prev|Previous|‹|«|❮|⟨/);
              if (!back) back = findIconPagination(true).prev; // Force fresh scan (cached one may be stale)
              if (back) {
                const b = back.closest("button,a") || back.querySelector("button,a") || back;
                b.dispatchEvent(new MouseEvent("mousedown", opts));
                b.dispatchEvent(new MouseEvent("mouseup", opts));
                b.dispatchEvent(new MouseEvent("click", opts));
              }
            } catch (e) {}
          }, 1500);
        }
      } else {
        // No pagination button: scroll the table to the bottom and back to trigger lazy loading.
        const scroller = document.querySelector('[class*="overflow"], [class*="scroll"], [class*="table"]');
        if (scroller) {
          scroller.scrollTop = scroller.scrollHeight;
          setTimeout(() => { scroller.scrollTop = 0; }, 800);
        }
      }
    } catch (e) {
    } finally {
      setTimeout(() => { kickLock = false; }, 1600); // Allow the next attempt
    }
  }

  // Wait for a serverID: if the page isn't firing requests, periodically trigger one
  // until captured or the timeout elapses.
  function waitForServerID(timeoutMs) {
    if (lastServerID) return Promise.resolve(lastServerID);
    return new Promise((resolve) => {
      const onMessage = (event) => {
        const d = event.data;
        if (d && d.source === "opencode-master" && d.type === "server-id" && d.serverID) {
          cleanup();
          resolve(d.serverID);
        }
      };
      const onExtMsg = (msg) => {
        if (msg && msg.type === "server-id" && msg.serverID) {
          cleanup();
          resolve(msg.serverID);
        }
      };
      const timeout = setTimeout(() => {
        cleanup();
        resolve(null);
      }, timeoutMs);
      const kickTimer = setInterval(kickPageRequest, 1500);
      const cleanup = () => {
        clearTimeout(timeout);
        clearInterval(kickTimer);
        window.removeEventListener("message", onMessage);
        try {
          chrome.runtime.onMessage.removeListener(onExtMsg);
        } catch (e) {
          // Ignore if the extension context was invalidated
        }
      };
      window.addEventListener("message", onMessage);
      chrome.runtime.onMessage.addListener(onExtMsg);
      kickPageRequest(); // Try once immediately
    });
  }

  // Force the page to fire a fresh /_server request (by clicking a pagination
  // control) and wait for a NEW serverID. The stored one goes stale over time
  // (opencode rotates its server), so a fresh capture is required for crawling.
  function refreshServerID(timeoutMs) {
    const baseline = lastServerID;
    return new Promise((resolve) => {
      const onMessage = (event) => {
        const d = event.data;
        if (
          d && d.source === "opencode-master" && d.type === "server-id" && d.serverID &&
          d.serverID !== baseline
        ) {
          cleanup();
          resolve(d.serverID);
        }
      };
      const onExtMsg = (msg) => {
        if (msg && msg.type === "server-id" && msg.serverID && msg.serverID !== baseline) {
          cleanup();
          resolve(msg.serverID);
        }
      };
      const timeout = setTimeout(() => {
        cleanup();
        resolve(null); // No fresh ID captured in time
      }, timeoutMs);
      const kickTimer = setInterval(kickPageRequest, 1500);
      const cleanup = () => {
        clearTimeout(timeout);
        clearInterval(kickTimer);
        window.removeEventListener("message", onMessage);
        try {
          chrome.runtime.onMessage.removeListener(onExtMsg);
        } catch (e) {
          // Ignore if the extension context was invalidated
        }
      };
      window.addEventListener("message", onMessage);
      chrome.runtime.onMessage.addListener(onExtMsg);
      kickPageRequest(); // Try once immediately
    });
  }

  // Passive serverID wait: listens for a naturally-captured ID (page load,
  // background webRequest relay) WITHOUT clicking anything on the page.
  // Returns null on timeout so the caller can fall back to refreshServerID.
  function passiveServerID(timeoutMs) {
    if (lastServerID) return Promise.resolve(lastServerID);
    return new Promise((resolve) => {
      const onMessage = (event) => {
        const d = event.data;
        if (d && d.source === "opencode-master" && d.type === "server-id" && d.serverID) {
          cleanup();
          resolve(d.serverID);
        }
      };
      const onExtMsg = (msg) => {
        if (msg && msg.type === "server-id" && msg.serverID) {
          cleanup();
          resolve(msg.serverID);
        }
      };
      const timeout = setTimeout(() => {
        cleanup();
        resolve(null);
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timeout);
        window.removeEventListener("message", onMessage);
        try {
          chrome.runtime.onMessage.removeListener(onExtMsg);
        } catch (e) {
          // Ignore if the extension context was invalidated
        }
      };
      window.addEventListener("message", onMessage);
      chrome.runtime.onMessage.addListener(onExtMsg);
    });
  }

  // ---------- ServerID capture (MAIN world, injected by background to bypass page CSP) ----------
  const injectInterceptor = () => {
    try {
      const p = chrome.runtime.sendMessage({ type: "inject-interceptor" });
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch (e) {
      // Ignore when the background isn't ready
    }
  };

  // Record a captured serverID for manual crawls.
  async function recordServerID(serverID) {
    if (serverID === lastServerID) return;
    lastServerID = serverID;
    await storageSet({ lastServerID: serverID });
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (
      data &&
      data.source === "opencode-master" &&
      data.type === "server-id" &&
      data.serverID
    ) {
      recordServerID(data.serverID);
    }
  });

  // ---------- Init: inject the interceptor only (no auto crawling) ----------
  if (isUsagePage()) {
    injectInterceptor();
  }

  // ---------- Message handling (from background / popup) ----------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;

    // ServerID captured by background webRequest (for manual crawls).
    if (msg.type === "server-id" && msg.serverID) {
      recordServerID(msg.serverID);
      return;
    }

    if (msg.type === "start-crawl") {
      if (!isUsagePage()) {
        sendResponse({ ok: false, error: "This page is not a usage page - cannot sync" });
        return;
      }
      if (crawling) {
        sendResponse({ ok: true, started: false, reason: "busy" });
        return;
      }
      triggerCrawl(!!msg.rescan).catch(() => {}); // Fire-and-forget; crawl continues in the background
      sendResponse({ ok: true, started: true });
      return;
    }

    if (msg.type === "export-json") {
      exportMergedJSON()
        .then((res) => sendResponse(res))
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true; // async
    }

    if (msg.type === "get-status") {
      getStatus()
        .then((res) => sendResponse(res))
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true; // async
    }
  });

  // ---------- Crawl control ----------
  async function triggerCrawl(forceRescan) {
    if (!isUsagePage()) return { ok: false, error: "Not a usage page" };
    if (crawling) return { ok: true, started: false, reason: "busy" };
    // Claim the lock BEFORE the 6s serverID wait below: a second click during
    // the wait would otherwise start a concurrent crawl (double request rate
    // toward the server, interleaved OPFS writes, scrambled progress).
    crawling = true;
    notify({ type: "crawl-start", workspace: getWorkspaceID(), rescan: !!forceRescan });
    try { // Released in the outer finally on every exit path (body not reindented)

    // The stored serverID goes stale (opencode rotates its server). Always try
    // to capture a FRESH one by kicking the page; fall back to the stored value
    // only if a fresh capture times out.
    if (!lastServerID) {
      const { lastServerID: sid } = await storageGet("lastServerID");
      if (sid) lastServerID = sid;
    }
    const oldSID = lastServerID ? lastServerID.slice(0, 12) : "(none)";
    let sidNote = `${oldSID} (stored)`;
    pendingCrawl = { forceRescan: !!forceRescan };
    // Passive first: force-kicking pagination makes the page itself fire
    // _server traffic on top of the crawl burst; the session then gets
    // throttled (fast first pages, one slow page, then a stall - no 429).
    // Prefer the stored serverID without touching the page; staleness
    // surfaces as 401/403 and is handled by the retry path below.
    // Kick-clicking is the last resort when we have no ID at all.
    let freshSID = null;
    if (!lastServerID) {
      freshSID = await passiveServerID(3000);
      if (!freshSID) freshSID = await refreshServerID(6000);
    }
    pendingCrawl = null;
    if (freshSID) {
      lastServerID = freshSID;
      await storageSet({ lastServerID: freshSID });
      sidNote = `${oldSID} -> ${freshSID.slice(0, 12)} (fresh)`;
    } else {
      sidNote = `${oldSID} (stored, page untouched)`;
    }
    if (!lastServerID) {
      const errMsg = "Could not obtain a server ID automatically - click a pagination control once on the page";
      notify({ type: "error", message: errMsg });
      clog("crawl aborted:", errMsg);
      return { ok: false, error: errMsg };
    }

    try {
      const result = await runCrawl(getWorkspaceID(), lastServerID, forceRescan);
      const final = { ...result, sidNote };
      notify({ type: "crawl-done", ...final });
      clog(`crawl-done: total=${final.total} new=${final.newRecords} lastPage=${final.lastPage} stop=${final.stopReason || "(end)"} ${sidNote}`);
      return { ok: true, started: true, ...final };
    } catch (e) {
      const raw = String(e.message || e);
      // Stale serverID (rotated server / not logged in): clear it, trigger a
      // fresh capture (kicking the page is justified here - we KNOW the ID is
      // bad), and retry once.
      const message = raw.replace(/^StaleServerID:\s*/, "Server session changed - ");
      if (/401|403|StaleServerID/.test(raw)) {
        lastServerID = null;
        await storageRemove("lastServerID");
        pendingCrawl = { forceRescan: !!forceRescan };
        clog("serverID stale, re-capturing (page will be clicked) and retrying crawl once…");
        const sid = await refreshServerID(8000);
        pendingCrawl = null;
        if (sid) {
          try {
            const result = await runCrawl(getWorkspaceID(), sid, forceRescan);
            notify({ type: "crawl-done", ...result, sidNote });
            clog(`crawl-done(retry): total=${result.total} new=${result.newRecords} lastPage=${result.lastPage}`);
            return { ok: true, started: true, ...result, sidNote };
          } catch (e2) {
            notify({ type: "error", message: String(e2.message || e2) });
            clog("crawl failed(retry):", String(e2.message || e2));
            return { ok: false, error: String(e2.message || e2) };
          }
        }
      }
      notify({ type: "error", message });
      clog("crawl failed:", message);
      return { ok: false, error: message };
    } finally {
      crawling = false;
    }
    } finally {
      crawling = false; // Release the early claim on every exit path
    }
  }

  // ---------- Worker-based crawl (primary path) ----------
  // content.js shares the page's main thread, so a wedged usage tab freezes
  // the crawl mid-fetch with no error and no retry. The fetch/parse loop
  // therefore runs in a dedicated Blob worker (page origin: same-origin
  // fetch with cookies + the same OPFS bucket). The worker owns OPFS writes
  // and posts progress; this side only relays to background/popup. If the
  // worker can't start (e.g. page CSP blocks blob workers), fall back to
  // the inline startCrawling below (same logic, main thread).
  async function runCrawlWorker(workspaceID, serverID, forceRescan) {
    const src = await (await fetch(chrome.runtime.getURL("content/crawl-worker.js"))).text();
    const blobUrl = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
    const worker = new Worker(blobUrl);
    try {
      return await new Promise((resolve, reject) => {
        worker.onmessage = (ev) => {
          const m = (ev && ev.data) || {};
          if (m.type === "notify" && m.msg) notify(m.msg);
          else if (m.type === "log" && m.text !== undefined) clog(String(m.text));
          else if (m.type === "done") resolve({ ok: true, result: m.result });
          else if (m.type === "error") resolve({ ok: false, error: String(m.message || "worker error") });
        };
        worker.onerror = (ev) => reject(new Error(`worker failed: ${(ev && ev.message) || "failed to start"}`));
        worker.postMessage({ workspaceID, serverID, forceRescan, filename: `opencode_token_cache_${workspaceID}.json` });
      });
    } finally {
      try { worker.terminate(); } catch (e) {}
      try { URL.revokeObjectURL(blobUrl); } catch (e) {}
    }
  }

  // Primary runner: worker first, inline loop as fallback. A worker that
  // STARTED but failed is thrown (same handling as inline failures, stale /
  // 401 recapture included); only worker STARTUP failure falls back, so a
  // broken run is never silently executed twice.
  async function runCrawl(workspaceID, serverID, forceRescan) {
    let started = false;
    try {
      const w = await runCrawlWorker(workspaceID, serverID, forceRescan);
      started = true;
      if (w.ok) return w.result;
      throw new Error(w.error);
    } catch (e) {
      if (started) throw e;
      clog(`worker unavailable (${e.message}), running crawl on main thread…`);
      return await startCrawling(workspaceID, serverID, forceRescan);
    }
  }

  // ---------- Core crawl (ported from the original console script) ----------
  // forceRescan=true: full rescan that overwrites every record (including backfilling
  // `time`) without deleting any existing data.
  // NOTE: this inline loop is now the FALLBACK path (see runCrawl above);
  // the primary path is content/crawl-worker.js. Keep the two in sync.
  async function startCrawling(workspaceID, serverID, forceRescan) {
    const FILENAME = `opencode_token_cache_${workspaceID}.json`;
    let page = 0;
    let hasMoreData = true;
    let localCache = {};
    let newRecordCountTotal = 0;
    let fileHandle;
    let stopReason = "";
    // Persist incrementally every few pages so a mid-crawl stall/interruption
    // (closed tab, throttled session) keeps everything fetched so far.
    const WRITE_EVERY_PAGES = 5;
    let crawlError = null;

    try {
      const root = await navigator.storage.getDirectory();
      fileHandle = await root.getFileHandle(FILENAME, { create: true });
      const file = await fileHandle.getFile();
      const text = await file.text();
      if (text) localCache = JSON.parse(text);
    } catch (e) {
      throw new Error(`OPFS init failed: ${e.message}`);
    }

    // Incremental mode: stop at the first fully-synced page (reached the
    // sync point). Old records without the new schema fields are left as-is;
    // only new/changed records are written. No backfill sweep.

    const parseSafe = (val) => (val && val !== "null") ? parseInt(val, 10) : 0;

    const writeCache = async () => {
      const writable = await fileHandle.createWritable();
      await writable.write(JSON.stringify(localCache));
      await writable.close();
    };

    try {
      while (hasMoreData) {
        const bodyPayload =
          `{"t":{"t":9,"i":0,"l":2,"a":[{"t":1,"s":"${workspaceID}"},{"t":0,"s":${page}}],"o":0},"f":31,"m":[]}`;
        let response = null;
        let pageText = "";
        let retries = 0;
        const pageStartAt = Date.now();
        // Fetch-start marker: if the crawl stalls, the last message tells
        // whether it died fetching (no "done") or processing the page.
        // Same line is also mirrored to the page console (DevTools) because
        // popup/badge text is truncated and only visible while open.
        const pageLog = (...args) => { try { console.log("[opencode-usage]", ...args); } catch (e) {} };
        notify({ type: "progress", page, workspace: getWorkspaceID(), message: `Page ${page} fetching…` });
        pageLog(`page ${page} fetching…`);

        // 60s per-request timeout: fetch resolves on HEADERS, but a stalled
        // body in response.text() hangs just the same (this looked like
        // "stuck on page N" with no error and no finish). The abort window
        // therefore covers fetch + body read together; abort feeds into the
        // normal retry path below.
        while (retries <= 3) {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 60000);
          try {
            const resp = await fetch("https://opencode.ai/_server", {
              headers: {
                accept: "*/*",
                "content-type": "application/json",
                "x-server-id": serverID,
                "x-server-instance": "server-fn:1",
              },
              body: bodyPayload,
              method: "POST",
              credentials: "include",
              signal: ctrl.signal,
            });

            if (resp.status === 429) {
              clearTimeout(timer);
              notify({ type: "progress", message: `HTTP 429 rate limited, waiting 15s (${retries + 1}/3)` });
              pageLog(`page ${page}: 429 rate limited, waiting 15s (${retries + 1}/3)`);
              await new Promise((r) => setTimeout(r, 15000));
              retries++;
              continue;
            }
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            response = resp;
            pageText = await resp.text();
            clearTimeout(timer);
            break;
          } catch (e) {
            clearTimeout(timer);
            retries++;
            const reason = e && e.name === "AbortError" ? "timed out after 60s" : String(e.message || e);
            if (retries <= 3) {
              // Retries were previously silent (only 429s were reported), so a
              // slow server looked like a frozen crawl. Report them.
              notify({ type: "progress", page, workspace: getWorkspaceID(), message: `Page ${page} retry ${retries}/3 (${reason})` });
              pageLog(`page ${page} retry ${retries}/3 (${reason})`);
              await new Promise((r) => setTimeout(r, 8000));
            }
            else {
              hasMoreData = false;
              throw new Error(`Request failed: ${reason}`);
            }
          }
        }

        if (!hasMoreData || !response || !response.ok) {
          stopReason = `Request not OK (HTTP ${response ? response.status : "no response"}) on page ${page}`;
          notify({ type: "info", message: `Crawl stopped: ${stopReason}` });
          break;
        }

        const text = pageText;
        if (!text.includes("inputTokens:")) {
          // A stale x-server-id doesn't always come back as 401/403: the
          // server can answer 200 with a Flight error payload (e.g.
          // RangeError: Invalid time value). Treat that as staleness (the
          // caller re-captures + retries once, like 401/403) instead of
          // mistaking it for end-of-history.
          if (/\b(RangeError|TypeError|ReferenceError|SyntaxError)\b|Invalid time value/.test(text)) {
            clog(`page ${page}: server answered with an error payload - treating as stale serverID, will re-capture and retry once`);
            throw new Error(`StaleServerID: page ${page} answered with a server error, not usage data`);
          }
          // No data rows in the response. Show a hint so we can tell a stale server
          // ID / session expiry from a genuinely empty page.
          const snippet = text.slice(0, 160).replace(/\s+/g, " ");
          stopReason = `page ${page} response has no records. Server said: ${snippet}`;
          notify({ type: "info", message: `Crawl stopped: ${stopReason}` });
          clog(`crawl stopped: ${stopReason}`);
          break; // Last page reached / no usable data
        }

        // Record shape (server is authoritative; `cost` is intentionally NOT stored):
        // id, workspaceID, timeCreated, timeUpdated, timeDeleted, model,
        // provider, input/output/reasoning/cacheRead/cacheWrite5m/cacheWrite1h,
        // keyID, sessionID, enrichment{plan,costMultiplier} (may be null).
        // $R[n]= prefixes are React Flight reference assignments - tolerated.
        const regex =
          /id:\s*"([^"]+)",[\s\S]*?workspaceID:\s*"([^"]+)",[\s\S]*?timeCreated:[\s\S]*?new Date\("([^"]+)"\),[\s\S]*?timeUpdated:[\s\S]*?(?:new Date\("([^"]+)"\)|null),[\s\S]*?timeDeleted:\s*(?:new Date\("([^"]+)"\)|null),[\s\S]*?model:\s*"([^"]+)",[\s\S]*?provider:\s*"([^"]+)",[\s\S]*?inputTokens:\s*(\d+|null),[\s\S]*?outputTokens:\s*(\d+|null),[\s\S]*?reasoningTokens:\s*(\d+|null),[\s\S]*?cacheReadTokens:\s*(\d+|null),[\s\S]*?cacheWrite5mTokens:\s*(\d+|null),[\s\S]*?cacheWrite1hTokens:\s*(\d+|null),[\s\S]*?keyID:\s*"([^"]+)",[\s\S]*?sessionID:\s*"([^"]+)",[\s\S]*?enrichment:(?:null|[\s\S]*?\{plan:"([^"]+)",costMultiplier:([\d.]+)\})/g;

        // Legacy fallback (pre-sessionID server shape): keeps the crawler working
        // if the server ever omits the new fields. New fields backfill as null.
        const legacyRegex =
          /id:\s*"([^"]+)",[\s\S]*?timeCreated:[\s\S]*?new Date\("([^"]+)"\),[\s\S]*?model:\s*"([^"]+)",[\s\S]*?inputTokens:\s*(\d+|null),[\s\S]*?outputTokens:\s*(\d+|null),[\s\S]*?reasoningTokens:\s*(\d+|null),[\s\S]*?cacheReadTokens:\s*(\d+|null),[\s\S]*?cacheWrite5mTokens:\s*(\d+|null),[\s\S]*?cacheWrite1hTokens:\s*(\d+|null)/g;

        let match;
        let newRecordCount = 0; // Genuinely new (not previously cached)
        let pageWriteCount = 0; // Records written on this page (new + deletes)
        let pageDeleteCount = 0;
        let parseYield = 0;

        let matchedNewShape = false;
        while ((match = regex.exec(text)) !== null) {
          matchedNewShape = true;
          const id = match[1];

          // Soft-deleted on the server: drop from cache instead of storing.
          if (match[5]) {
            if (localCache[id]) {
              delete localCache[id];
              pageWriteCount++;
            }
            pageDeleteCount++;
            continue;
          }

          const prev = localCache[id];
          const existed = !!(prev && prev.date && prev.workspaceID);
          if (!forceRescan && existed && prev.time) {
            continue; // Fully synced already; always overwrite during rescan
          }

          const dateIso = match[3];
          const dateObj = new Date(dateIso);
          const dateStr = !isNaN(dateObj.getTime())
            ? `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, "0")}-${String(dateObj.getDate()).padStart(2, "0")}`
            : "Unknown";

          const record = {
            workspaceID: match[2] || workspaceID,
            time: dateIso,
            timeUpdated: match[4] || null,
            date: dateStr,
            model: match[6],
            provider: match[7] || null,
            input: parseSafe(match[8]),
            output: parseSafe(match[9]),
            reasoning: parseSafe(match[10]),
            cacheRead: parseSafe(match[11]),
            cacheWrite5m: parseSafe(match[12]),
            cacheWrite1h: parseSafe(match[13]),
            keyID: match[14] || null,
            sessionID: match[15] || null,
            plan: match[16] || null,
            costMultiplier: match[17] !== undefined ? parseFloat(match[17]) : null,
          };

          localCache[id] = record;
          pageWriteCount++;
          if (!existed) newRecordCount++; // Genuinely new
          // Content scripts share the page's main thread: yield every 200
          // records so a huge page can't freeze the usage tab while parsing.
          if (++parseYield % 200 === 0) await new Promise((r) => setTimeout(r, 0));
        }

        if (!matchedNewShape) {
          legacyRegex.lastIndex = 0;
          while ((match = legacyRegex.exec(text)) !== null) {
            const id = match[1];

            const prev = localCache[id];
            const existed = !!(prev && prev.date && prev.workspaceID);
            if (!forceRescan && existed && prev.time) {
              continue; // Fully synced already (has time); always overwrite during rescan
            }

            const dateIso = match[2];
            const dateObj = new Date(dateIso);
            const dateStr = !isNaN(dateObj.getTime())
              ? `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, "0")}-${String(dateObj.getDate()).padStart(2, "0")}`
              : "Unknown";

            const record = {
              workspaceID: workspaceID,
              time: dateIso,
              timeUpdated: null,
              date: dateStr,
              model: match[3],
              provider: null,
              input: parseSafe(match[4]),
              output: parseSafe(match[5]),
              reasoning: parseSafe(match[6]),
              cacheRead: parseSafe(match[7]),
              cacheWrite5m: parseSafe(match[8]),
              cacheWrite1h: parseSafe(match[9]),
              keyID: null,
              sessionID: null,
              plan: null,
              costMultiplier: null,
            };

            localCache[id] = record;
            pageWriteCount++;
            if (!existed) newRecordCount++; // Genuinely new
            if (++parseYield % 200 === 0) await new Promise((r) => setTimeout(r, 0));
          }
        }

        newRecordCountTotal += newRecordCount;
        // Report every page (no throttle) so long crawls don't look stuck.
        const pageMs = Date.now() - pageStartAt;
        const pageSecs = (pageMs / 1000).toFixed(1);
        const pageKb = (text.length / 1024).toFixed(0);
        pageLog(`page ${page} done: wrote ${pageWriteCount} (new ${newRecordCount}, del ${pageDeleteCount}, total new ${newRecordCountTotal}) (${pageSecs}s,${pageKb}KB)`);
        notify({
          type: "progress",
          page,
          workspace: getWorkspaceID(),
          message: `Page ${page} done: wrote ${pageWriteCount} (new ${newRecordCount}, del ${pageDeleteCount}, total new ${newRecordCountTotal}) (${pageSecs}s,${pageKb}KB)`,
        });

        if (!forceRescan && pageWriteCount === 0) {
          stopReason = `page ${page} fully synced (all records already have timestamps)`;
          notify({
            type: "info",
            message: `Crawl stopped: ${stopReason}`,
          });
          break; // Entire page synced - reached the sync point
        }

        // Best-effort incremental persist; failures are tolerated here because
        // the final write in `finally` still runs.
        if (page > 0 && page % WRITE_EVERY_PAGES === 0) {
          try {
            await writeCache();
          } catch (e) {}
        }

        // Original pacing: small random delay between pages.
        const paceMs = Math.floor(Math.random() * 100) + 100;
        // Background-tab canary: Chrome throttles hidden-tab timers (up to
        // 1/min), which freezes the crawl with no error and no retry. A big
        // overrun here means the usage tab is hidden - say so instead of
        // looking dead.
        const paceStart = Date.now();
        await new Promise((r) => setTimeout(r, paceMs));
        const paceDrift = Date.now() - paceStart - paceMs;
        if (paceDrift > 10000) {
          notify({ type: "progress", page, workspace: getWorkspaceID(), message: `Page ${page} stalled ${(paceDrift / 1000).toFixed(0)}s: timers throttled - keep the usage tab visible` });
        }
        page++;
      }
    } catch (e) {
      crawlError = e;
    } finally {
      // Always persist whatever was captured so far, even after an error.
      try {
        await writeCache();
      } catch (e) {
        if (!crawlError) crawlError = new Error(`Cache write failed: ${e.message}`);
      }
      // Invalidate the merged-export cache so the next fetch re-reads the
      // freshly written files (the fingerprint check would also catch it, but
      // this also covers the no-op-write edge case).
      exportCache = null;
    }

    if (crawlError) throw crawlError;

    return {
      workspaceID,
      total: Object.keys(localCache).length,
      newRecords: newRecordCountTotal,
      lastPage: page,
      stopReason,
    };
  }

  // ---------- Read and merge all workspace caches ----------
  // The dashboard re-fetches this on every refresh, so re-reading + re-parsing +
  // re-stringifying all OPFS files each time gets slow as the cache grows. We
  // fingerprint the cache files by (name, size, lastModified) - cheap, no content
  // read - and only rebuild the merged export when a file actually changed.
  // Invalidated by a completed crawl (see startCrawling) and whenever the
  // fingerprint changes.
  async function readAllCache() {
    const root = await navigator.storage.getDirectory();
    const entries = [];
    for await (const [name, handle] of root.entries()) {
      if (handle.kind !== "file") continue;
      if (!name.startsWith("opencode_token_cache_") || !name.endsWith(".json")) continue;
      entries.push([name, handle]);
    }

    // Cheap staleness check: only file metadata, no content read.
    const metas = [];
    for (const [name, handle] of entries) {
      const f = await handle.getFile();
      metas.push(`${name}:${f.size}:${f.lastModified}`);
    }
    const fp = metas.sort().join("|");
    if (exportCache && exportCache.fp === fp) return exportCache;

    const globalCache = {};
    const files = [];
    for (const [name, handle] of entries) {
      const inferredWS = name.replace("opencode_token_cache_", "").replace(".json", "");
      const file = await handle.getFile();
      const text = await file.text();
      if (!text) continue;

      const data = JSON.parse(text);
      for (const [id, rec] of Object.entries(data)) {
        if (!rec.workspaceID) rec.workspaceID = inferredWS;
        globalCache[id] = rec;
      }
      files.push({ name, count: Object.keys(data).length });
    }

    exportCache = {
      fp,
      data: JSON.stringify(globalCache),
      count: Object.keys(globalCache).length,
      fileCount: files.length,
      files,
      lastRecord: computeLastRecord(globalCache),
    };
    return exportCache;
  }

  // Find the latest record: max by `time` (fall back to `date` for legacy records).
  function computeLastRecord(globalCache) {
    let lastRecord = null;
    for (const rec of Object.values(globalCache)) {
      const key = rec.time || rec.date || "";
      if (!lastRecord || key > (lastRecord.time || lastRecord.date || "")) {
        lastRecord = rec;
      }
    }
    return lastRecord;
  }

  // ---------- Export (merged across all workspace caches) ----------
  async function exportMergedJSON() {
    const c = await readAllCache();
    return {
      ok: true,
      filename: "opencode_all_accounts_records.json",
      data: c.data,
      count: c.count,
      fileCount: c.fileCount,
      files: c.files,
      lastRecord: c.lastRecord,
    };
  }

  // ---------- Status (OPFS overview) ----------
  async function getStatus() {
    const c = await readAllCache();
    return {
      ok: true,
      totalRecords: c.count,
      files: c.files,
      lastRecord: c.lastRecord,
    };
  }
})();
