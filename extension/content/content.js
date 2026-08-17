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
    const freshSID = await refreshServerID(6000);
    pendingCrawl = null;
    if (freshSID) {
      lastServerID = freshSID;
      await storageSet({ lastServerID: freshSID });
      sidNote = `${oldSID} -> ${freshSID.slice(0, 12)} (fresh)`;
    } else {
      sidNote = `${oldSID} (no fresh capture, using stored)`;
    }
    if (!lastServerID) {
      const errMsg = "Could not obtain a server ID automatically - click a pagination control once on the page";
      notify({ type: "error", message: errMsg });
      return { ok: false, error: errMsg };
    }

    crawling = true;
    notify({ type: "crawl-start", workspace: getWorkspaceID(), rescan: !!forceRescan });
    try {
      const result = await startCrawling(getWorkspaceID(), lastServerID, forceRescan);
      const final = { ...result, sidNote };
      notify({ type: "crawl-done", ...final });
      return { ok: true, started: true, ...final };
    } catch (e) {
      const message = String(e.message || e);
      // Stale serverID (not logged in / server changed): clear it, trigger a fresh
      // capture, and retry once.
      if (/401|403/.test(message)) {
        lastServerID = null;
        await storageRemove("lastServerID");
        pendingCrawl = { forceRescan: !!forceRescan };
        const sid = await refreshServerID(8000);
        pendingCrawl = null;
        if (sid) {
          try {
            const result = await startCrawling(getWorkspaceID(), sid, forceRescan);
            notify({ type: "crawl-done", ...result, sidNote });
            return { ok: true, started: true, ...result, sidNote };
          } catch (e2) {
            notify({ type: "error", message: String(e2.message || e2) });
            return { ok: false, error: String(e2.message || e2) };
          }
        }
      }
      notify({ type: "error", message });
      return { ok: false, error: message };
    } finally {
      crawling = false;
    }
  }

  // ---------- Core crawl (ported from the original console script) ----------
  // forceRescan=true: full rescan that overwrites every record (including backfilling
  // `time`) without deleting any existing data.
  async function startCrawling(workspaceID, serverID, forceRescan) {
    const FILENAME = `opencode_token_cache_${workspaceID}.json`;
    let page = 0;
    let hasMoreData = true;
    let localCache = {};
    let newRecordCountTotal = 0;
    let fileHandle;
    let stopReason = "";
    // Persist incrementally every N pages so a mid-crawl interruption (closed
    // tab, network failure) doesn't lose the whole session's progress.
    const WRITE_EVERY_PAGES = 20;
    let lastProgressAt = 0;
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
        let retries = 0;

        while (retries <= 3) {
          try {
            response = await fetch("https://opencode.ai/_server", {
              headers: {
                accept: "*/*",
                "content-type": "application/json",
                "x-server-id": serverID,
                "x-server-instance": "server-fn:1",
              },
              body: bodyPayload,
              method: "POST",
              credentials: "include",
            });

            if (response.status === 429) {
              notify({ type: "progress", message: `HTTP 429 rate limited, waiting 8s (${retries + 1}/3)` });
              await new Promise((r) => setTimeout(r, 8000));
              retries++;
              continue;
            }
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            break;
          } catch (e) {
            retries++;
            if (retries <= 3) await new Promise((r) => setTimeout(r, 8000));
            else {
              hasMoreData = false;
              throw new Error(`Request failed: ${e.message}`);
            }
          }
        }

        if (!hasMoreData || !response || !response.ok) {
          stopReason = `Request not OK (HTTP ${response ? response.status : "no response"}) on page ${page}`;
          notify({ type: "info", message: `Crawl stopped: ${stopReason}` });
          break;
        }

        const text = await response.text();
        if (!text.includes("inputTokens:")) {
          // No data rows in the response. Show a hint so we can tell a stale server
          // ID / session expiry from a genuinely empty page.
          const snippet = text.slice(0, 160).replace(/\s+/g, " ");
          stopReason = `page ${page} response has no records. Server said: ${snippet}`;
          notify({ type: "info", message: `Crawl stopped: ${stopReason}` });
          break; // Last page reached / no usable data
        }

        const regex =
          /id:\s*"([^"]+)",[\s\S]*?timeCreated:[\s\S]*?new Date\("([^"]+)"\),[\s\S]*?model:\s*"([^"]+)",[\s\S]*?inputTokens:\s*(\d+|null),[\s\S]*?outputTokens:\s*(\d+|null),[\s\S]*?reasoningTokens:\s*(\d+|null),[\s\S]*?cacheReadTokens:\s*(\d+|null),[\s\S]*?cacheWrite5mTokens:\s*(\d+|null),[\s\S]*?cacheWrite1hTokens:\s*(\d+|null)/g;

        let match;
        let newRecordCount = 0; // Genuinely new (not previously cached)
        let pageWriteCount = 0; // Records written on this page (new + time backfill)

        while ((match = regex.exec(text)) !== null) {
          const id = match[1];

          const existed = !!(localCache[id] && localCache[id].date && localCache[id].workspaceID);
          if (!forceRescan && existed && localCache[id].time) {
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
            date: dateStr,
            model: match[3],
            input: parseSafe(match[4]),
            output: parseSafe(match[5]),
            reasoning: parseSafe(match[6]),
            cacheRead: parseSafe(match[7]),
            cacheWrite5m: parseSafe(match[8]),
            cacheWrite1h: parseSafe(match[9]),
          };

          localCache[id] = record;
          pageWriteCount++;
          if (!existed) newRecordCount++; // Existing records only get `time` backfilled, not counted as new
        }

        newRecordCountTotal += newRecordCount;
        // Throttled progress: at most one notification per second so long crawls
        // don't spam storage writes / badge updates on every page.
        const now = Date.now();
        if (page === 0 || now - lastProgressAt >= 1000) {
          lastProgressAt = now;
          notify({
            type: "progress",
            page,
            workspace: getWorkspaceID(),
            message: `Page ${page} done: wrote ${pageWriteCount} (new ${newRecordCount}, total new ${newRecordCountTotal})`,
          });
        }

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

        await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 100) + 100));
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
