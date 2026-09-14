// crawl-worker.js - Usage crawl loop running OFF the page main thread.
//
// Why: the page's own JS can wedge (frozen tab), and content.js shares that
// thread - a wedged page then freezes the crawl mid-fetch with no error, no
// retry and no finish. This worker runs on its own thread: page dead or
// alive, fetching/parsing/OPFS writes continue; the worst case is progress
// messages stop arriving (relayed through the content script).
//
// Instantiation: content.js fetches this file as text (web_accessible_resources),
// builds a Blob URL and spawns it, so it runs with the PAGE origin:
// same-origin fetch (cookies included) + the same OPFS bucket as the page.
// No chrome.* APIs are used in here - everything crosses via postMessage:
//   main -> worker: { workspaceID, serverID, forceRescan, filename }
//   worker -> main: { type: "notify", msg }   (relayed to background/popup)
//                   { type: "log", text }     (relayed to page console)
//                   { type: "done", result }  { workspaceID, total, newRecords, newTokens, lastPage, stopReason }
//                   { type: "error", message }
//
// Logic is a port of startCrawling() in content.js (same record shape, same
// retry/timeout semantics). `cost` is stored opaque as vendorCost (D16).
"use strict";

onmessage = async (e) => {
  const { workspaceID, serverID, forceRescan, filename, payloadTemplate } = (e && e.data) || {};
  const log = (text) => {
    try { postMessage({ type: "log", text: String(text) }); } catch (_) {}
  };
  const note = (msg) => {
    try { postMessage({ type: "notify", msg }); } catch (_) {}
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const parseSafe = (val) => (val && val !== "null") ? parseInt(val, 10) : 0;

  // Same template logic as content.js buildBodyPayload (duplicated: workers
  // can't import it). Reuses the observed f + t shape when available.
  const buildBodyPayload = (template, wsID, pg) => {
    if (template && typeof template.body === "string" && typeof template.f === "number") {
      try {
        const parsed = JSON.parse(template.body);
        let patched = false;
        const visit = (node) => {
          if (!node || typeof node !== "object") return;
          if (Array.isArray(node)) {
            for (const v of node) visit(v);
            return;
          }
          if (node.t === 1 && typeof node.s === "string" && /^wrk_/.test(node.s)) {
            node.s = wsID;
            patched = true;
          } else if (node.t === 0 && typeof node.s === "number") {
            node.s = pg;
            patched = true;
          }
          for (const v of Object.values(node)) visit(v);
        };
        visit(parsed);
        if (patched) return { body: JSON.stringify(parsed), f: parsed.f ?? template.f, observed: true };
      } catch (_) {}
    }
    return {
      body: `{"t":{"t":9,"i":0,"l":2,"a":[{"t":1,"s":"${wsID}"},{"t":0,"s":${pg}}],"o":0},"f":31,"m":[]}`,
      f: 31,
      observed: false,
    };
  };

  // One-shot page fetch used to probe the page index base (see below).
  const probePage = async (pg) => {
    try {
      const built = buildBodyPayload(payloadTemplate, workspaceID, pg);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20000);
      const resp = await fetch("https://opencode.ai/_server", {
        headers: {
          accept: "*/*",
          "content-type": "application/json",
          "x-server-id": serverID,
          "x-server-instance": "server-fn:1",
        },
        body: built.body,
        method: "POST",
        credentials: "include",
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!resp.ok) return null;
      return await resp.text();
    } catch (e) {
      return null;
    }
  };

  let page = 0;
  let hasMoreData = true;
  let localCache = {};
  let newRecordCountTotal = 0;
  let newTokensTotal = 0; // Sum of all token fields of genuinely new records
  let fileHandle = null;
  let leaseHandle = null;
  let leaseOwner = "";
  let beatLease = async () => {};
  let stopReason = "";
  // True when the server itself has no records for this workspace (valid but
  // empty usage envelope on the first page). The local cache is left intact so
  // the UI can keep showing the last synced data instead of dropping to zero.
  let serverEmpty = false;
  // Persist incrementally every few pages so a mid-crawl stall/interruption
  // keeps everything fetched so far (the worker is autonomous: even if the
  // page dies, completed pages are already in OPFS).
  const WRITE_EVERY_PAGES = 5;
  let crawlError = null;

  const writeCache = async () => {
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(localCache));
    await writable.close();
  };

  const LEASE_TTL = 45000;           // A lease this old is dead: safe to take over
  const LEASE_HEARTBEAT_MS = 15000;  // Keep the lease fresh while alive (not just per page)
  let beatTimer = null;

  try {
    if (!workspaceID || !serverID || !filename) throw new Error("worker missing workspaceID/serverID/filename");
    // Desync concurrent starts (double clicks / multiple tabs) a little.
    await sleep(Math.floor(Math.random() * 2000));
    const root = await navigator.storage.getDirectory();
    // Single-crawl lease (OPFS file: shared across tabs, reloads and workers,
    // no chrome APIs needed). A second concurrent crawl would double server
    // load and fight over the cache file. Liveness = heartbeat: a live crawl
    // refreshes `at` every LEASE_HEARTBEAT_MS, so a lease that hasn't beaten
    // for LEASE_TTL is dead and can be taken over.
    leaseOwner = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
    leaseHandle = await root.getFileHandle("opencode_crawl_lease.json", { create: true });
    beatLease = async () => {
      try {
        const w = await leaseHandle.createWritable();
        await w.write(JSON.stringify({ owner: leaseOwner, at: Date.now(), workspaceID }));
        await w.close();
      } catch (_) {}
    };
    // Conflicting lease: don't fail instantly. Poll until it goes stale (dead
    // worker => auto-resume here, user does nothing) or a hard cap passes
    // (a live crawler keeps beating => surface it with a force option).
    const leaseWaitDeadline = Date.now() + 90000;
    let blockedLease = null;
    while (Date.now() < leaseWaitDeadline) {
      let lease = null;
      try {
        const lt = await (await leaseHandle.getFile()).text();
        lease = lt ? JSON.parse(lt) : null;
      } catch (_) {}
      if (!lease || !lease.owner || lease.owner === leaseOwner || Date.now() - (lease.at || 0) >= LEASE_TTL) break;
      if (!blockedLease) {
        blockedLease = lease;
        note({ type: "progress", page: 0, workspace: workspaceID, message: `Another crawl is active - auto-resuming when it clears (up to ~${Math.ceil(LEASE_TTL / 1000)}s)` });
        log(`another crawl running (owner ${String(lease.owner).slice(-6)}); waiting for its lease to expire…`);
      }
      await sleep(1000);
    }
    if (Date.now() >= leaseWaitDeadline) {
      const l = blockedLease || {};
      throw new Error(`another crawl is still running (owner ${String(l.owner || "?").slice(-6)}, beat ${l.at ? new Date(l.at).toLocaleTimeString() : "?"}) - it is actively heartbeating; wait for it to finish or close other usage tabs`);
    }
    beatTimer = setInterval(beatLease, LEASE_HEARTBEAT_MS);
    await beatLease();
    log(`crawl worker started (owner ${leaseOwner.slice(-6)})`);
    fileHandle = await root.getFileHandle(filename, { create: true });
    const file = await fileHandle.getFile();
    const text = await file.text();
    if (text) localCache = JSON.parse(text);

    // Incremental mode: stop at the first fully-synced page (reached the
    // sync point). Old records without the new schema fields are left as-is;
    // only new/changed records are written. No backfill sweep.

    // Some accounts' usage starts at page 1: page 0 returns a valid but empty
    // usage result, which would stop a full rescan immediately. Probe once and
    // start where the data actually is.
    let startPage = 0;
    try {
      const first = await probePage(0);
      if (first && !first.includes("inputTokens:") && /usage:\s*\$R\[/.test(first)) {
        const second = await probePage(1);
        if (second && second.includes("inputTokens:")) {
          startPage = 1;
          log("page 0 empty but page 1 has data -> starting at page 1");
        } else {
          log("page 0 and page 1 both returned no usage -> server has no records for this workspace");
        }
      }
    } catch (e) {}
    page = startPage;

    while (hasMoreData) {
      const built = buildBodyPayload(payloadTemplate, workspaceID, page);
      const bodyPayload = built.body;
      let response = null;
      let pageText = "";
      let retries = 0;
      const pageStartAt = Date.now();
      note({ type: "progress", page, workspace: workspaceID, message: `Page ${page} fetching…` });
      log(`page ${page} fetching…`);

      // 60s per-request timeout covering fetch(headers)+body read together;
      // abort feeds into the normal retry path below.
      while (retries <= 3) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 60000);
        try {
          const resp = await fetch("https://opencode.ai/_server", {
            headers: {
              accept: "*/*",
              "content-type": "application/json",
              "x-server-id": serverID,
              // Echo-only label (the server reflects it back as the Flight row
              // key and dispatches on the body's `f`); no need to match the
              // instance the page currently uses.
              "x-server-instance": "server-fn:1",
            },
            body: bodyPayload,
            method: "POST",
            credentials: "include",
            signal: ctrl.signal,
          });

          if (resp.status === 429) {
            clearTimeout(timer);
            note({ type: "progress", page, workspace: workspaceID, message: `HTTP 429 rate limited, waiting 15s (${retries + 1}/3)` });
            log(`page ${page}: 429 rate limited, waiting 15s (${retries + 1}/3)`);
            await sleep(15000);
            retries++;
            continue;
          }
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          response = resp;
          pageText = await resp.text();
          clearTimeout(timer);
          break;
        } catch (err) {
          clearTimeout(timer);
          retries++;
          const reason = err && err.name === "AbortError" ? "timed out after 60s" : String((err && err.message) || err);
          if (retries <= 3) {
            note({ type: "progress", page, workspace: workspaceID, message: `Page ${page} retry ${retries}/3 (${reason})` });
            log(`page ${page} retry ${retries}/3 (${reason})`);
            await sleep(8000);
          } else {
            hasMoreData = false;
            throw new Error(`Request failed: ${reason}`);
          }
        }
      }

      if (!hasMoreData || !response || !response.ok) {
        stopReason = `Request not OK (HTTP ${response ? response.status : "no response"}) on page ${page}`;
        note({ type: "info", message: `Crawl stopped: ${stopReason}` });
        log(`crawl stopped: ${stopReason}`);
        break;
      }

        const text = pageText;
        if (!text.includes("inputTokens:")) {
        // A stale x-server-id doesn't always come back as 401/403: the
        // server can answer 200 with a Flight error payload (e.g.
        // RangeError: Invalid time value). The main thread re-captures +
        // retries once on this marker, like 401/403.
        if (/\b(RangeError|TypeError|ReferenceError|SyntaxError)\b|Invalid time value/.test(text)) {
          log(`page ${page}: server answered with an error payload - treating as stale serverID`);
          throw new Error(`StaleServerID: page ${page} answered with a server error, not usage data`);
        }
        // Stored SID stale doesn't always 401/403: the server can answer 200
        // with a DIFFERENT function payload (e.g. referral) when the SID
        // belongs to an older deploy. Page 0 must be usage data; a referral
        // payload here means stale SID (main thread re-captures + retries).
        if (page === startPage && /referralCode|hasReferral|rewardAmount/.test(text)) {
          log(`page 0: server answered with referral payload - treating as stale serverID`);
          throw new Error(`StaleServerID: page 0 answered with referral payload, not usage data`);
        }
        // Stale f index or stale SID after a redeploy: empty usage on page 0 is
        // only stale when we already have cached records AND the response is
        // not a valid usage envelope. When the server returns its `keys:` list
        // (a real, just-empty usage result, e.g. a workspace with no usage)
        // we must stop as end-of-data instead of re-capturing forever.
        if (page === startPage && Object.keys(localCache).length > 0 && /\["server-fn:\d+"\]\s*=\s*\[\]/.test(text) && !/usage:\s*\$R\[/.test(text)) {
          log(`page 0: server answered with empty server-fn payload (f=${built.f}${built.observed ? ",observed" : ",default"}) - treating as stale serverID`);
          throw new Error(`StaleServerID: page 0 answered with empty server-fn payload (f=${built.f}), not usage data`);
        }
        // A valid but empty usage envelope on the first page means the server
        // has no records for this workspace (aged out / not this account's
        // active workspace). Stop without touching the local cache and report
        // it distinctly so the UI shows the last synced data, not zero.
        if (page === startPage && /usage:\s*\$R\[/.test(text)) {
          serverEmpty = true;
          stopReason = `server has no usage records for this workspace`;
          note({ type: "info", message: `Server has no records for this workspace - showing last synced data` });
          log(`crawl stopped: ${stopReason}`);
          break;
        }
        const snippet = text.slice(0, 160).replace(/\s+/g, " ");
        stopReason = `page ${page} response has no records. Server said: ${snippet}`;
        note({ type: "info", message: `Crawl stopped: ${stopReason}` });
        log(`crawl stopped: ${stopReason}`);
        break; // Last page reached / no usable data
      }

      // Record shape (server is authoritative): id, workspaceID, timeCreated,
      // timeUpdated, timeDeleted, model, provider, input/output/reasoning/
      // cacheRead/cacheWrite5m/cacheWrite1h, cost (vendor USD*1e8 - the console
      // stores it as a Redis incrby integer; /1e8 -> USD, opaque vendorCost per
      // D16), keyID, sessionID, enrichment{plan,costMultiplier}.
      // $R[n]= prefixes are React Flight reference assignments - tolerated.
      const regex =
        /id:\s*"([^"]+)",[\s\S]*?workspaceID:\s*"([^"]+)",[\s\S]*?timeCreated:[\s\S]*?new Date\("([^"]+)"\),[\s\S]*?timeUpdated:[\s\S]*?(?:new Date\("([^"]+)"\)|null),[\s\S]*?timeDeleted:\s*(?:new Date\("([^"]+)"\)|null),[\s\S]*?model:\s*"([^"]+)",[\s\S]*?provider:\s*"([^"]+)",[\s\S]*?inputTokens:\s*(\d+|null),[\s\S]*?outputTokens:\s*(\d+|null),[\s\S]*?reasoningTokens:\s*(\d+|null),[\s\S]*?cacheReadTokens:\s*(\d+|null),[\s\S]*?cacheWrite5mTokens:\s*(\d+|null),[\s\S]*?cacheWrite1hTokens:\s*(\d+|null),[\s\S]*?cost:\s*(-?[\d.]+|null),[\s\S]*?keyID:\s*"([^"]+)",[\s\S]*?sessionID:\s*"([^"]+)",[\s\S]*?enrichment:(?:null|[\s\S]*?\{plan:"([^"]+)",costMultiplier:([\d.]+)\})/g;

      // Legacy fallback (pre-sessionID server shape): new fields backfill as null.
      const legacyRegex =
        /id:\s*"([^"]+)",[\s\S]*?timeCreated:[\s\S]*?new Date\("([^"]+)"\),[\s\S]*?model:\s*"([^"]+)",[\s\S]*?inputTokens:\s*(\d+|null),[\s\S]*?outputTokens:\s*(\d+|null),[\s\S]*?reasoningTokens:\s*(\d+|null),[\s\S]*?cacheReadTokens:\s*(\d+|null),[\s\S]*?cacheWrite5mTokens:\s*(\d+|null),[\s\S]*?cacheWrite1hTokens:\s*(\d+|null),[\s\S]*?cost:\s*(-?[\d.]+|null)/g;

      let match;
      let newRecordCount = 0; // Genuinely new (not previously cached)
      let pageWriteCount = 0; // Records written on this page (new + deletes)
      let pageDeleteCount = 0;

      let matchedNewShape = false;
      let matchedLegacy = false;
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

        // Console `outputTokens` is INCLUSIVE of `reasoningTokens`; canonical
        // `output` excludes reasoning (additive elsewhere) so totals/cost never
        // double count it.
        const outputTokens = parseSafe(match[9]);
        const reasoningTokens = parseSafe(match[10]);

        localCache[id] = {
          workspaceID: match[2] || workspaceID,
          time: dateIso,
          timeUpdated: match[4] || null,
          date: dateStr,
          model: match[6],
          provider: match[7] || null,
          input: parseSafe(match[8]),
          output: Math.max(0, outputTokens - reasoningTokens),
          reasoning: reasoningTokens,
          outputExcludesReasoning: true, // D23
          cacheRead: parseSafe(match[11]),
          cacheWrite5m: parseSafe(match[12]),
          cacheWrite1h: parseSafe(match[13]),
          vendorCost: match[14] !== "null" ? parseFloat(match[14]) : undefined,
          costScale: 1e8, // raw vendor cost is USD×1e8; divided at compute time, never stored scaled
          keyID: match[15] || null,
          sessionID: match[16] || null,
          plan: match[17] || null,
          costMultiplier: match[18] !== undefined ? parseFloat(match[18]) : null,
        };
        pageWriteCount++;
        if (!existed) {
          newRecordCount++; // Genuinely new
          newTokensTotal += parseSafe(match[8]) + outputTokens + parseSafe(match[11]) + parseSafe(match[12]) + parseSafe(match[13]);
        }
      }

      if (!matchedNewShape) {
        legacyRegex.lastIndex = 0;
        while ((match = legacyRegex.exec(text)) !== null) {
          matchedLegacy = true;
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

          // Legacy shape: output is also INCLUSIVE of reasoning.
          const outputTokens = parseSafe(match[5]);
          const reasoningTokens = parseSafe(match[6]);

          localCache[id] = {
            workspaceID: workspaceID,
            time: dateIso,
            timeUpdated: null,
            date: dateStr,
            model: match[3],
            provider: null,
            input: parseSafe(match[4]),
            output: Math.max(0, outputTokens - reasoningTokens),
            reasoning: reasoningTokens,
            outputExcludesReasoning: true, // D23
            cacheRead: parseSafe(match[7]),
            cacheWrite5m: parseSafe(match[8]),
            cacheWrite1h: parseSafe(match[9]),
            vendorCost: match[10] !== "null" ? parseFloat(match[10]) : undefined,
            costScale: 1e8, // raw vendor cost is USD×1e8; divided at compute time
            keyID: null,
            sessionID: null,
            plan: null,
            costMultiplier: null,
          };
          pageWriteCount++;
          if (!existed) {
            newRecordCount++; // Genuinely new
            newTokensTotal += parseSafe(match[4]) + outputTokens + parseSafe(match[7]) + parseSafe(match[8]) + parseSafe(match[9]);
          }
        }
      }

      newRecordCountTotal += newRecordCount;
      const pageMs = Date.now() - pageStartAt;
      const pageSecs = (pageMs / 1000).toFixed(1);
      const pageKb = (text.length / 1024).toFixed(0);
      log(`page ${page} done: wrote ${pageWriteCount} (new ${newRecordCount}, del ${pageDeleteCount}, total new ${newRecordCountTotal}) (${pageSecs}s,${pageKb}KB)`);
      note({
        type: "progress",
        page,
        workspace: workspaceID,
        message: `Page ${page} done: wrote ${pageWriteCount} (new ${newRecordCount}, del ${pageDeleteCount}, total new ${newRecordCountTotal}) (${pageSecs}s,${pageKb}KB)`,
      });

      if (!matchedNewShape && !matchedLegacy) {
        stopReason = `page ${page} schema changed (inputTokens present but 0 parsed) - needs regex update`;
        note({ type: "info", message: `Crawl stopped: ${stopReason}` });
        log(`crawl stopped: ${stopReason}`);
        break;
      }

      if (!forceRescan && pageWriteCount === 0) {
        stopReason = `page ${page} fully synced (all records already have timestamps)`;
        note({ type: "info", message: `Crawl stopped: ${stopReason}` });
        log(`crawl stopped: ${stopReason}`);
        break; // Entire page synced - reached the sync point
      }

      // Heartbeat the lease every page (proves this crawl is alive; a second
      // concurrent crawl refuses to start while this is fresh).
      await beatLease();

      // Best-effort incremental persist; failures are tolerated here because
      // the final write in `finally` still runs.
      if (page > 0 && page % WRITE_EVERY_PAGES === 0) {
        try {
          await writeCache();
        } catch (_) {}
      }

      // Original pacing: small random delay between pages. Worker timers
      // follow the tab's visibility policy, so overruns mean a hidden tab.
      const paceMs = Math.floor(Math.random() * 100) + 100;
      const paceStart = Date.now();
      await sleep(paceMs);
      const paceDrift = Date.now() - paceStart - paceMs;
      if (paceDrift > 10000) {
        note({ type: "progress", page, workspace: workspaceID, message: `Page ${page} stalled ${(paceDrift / 1000).toFixed(0)}s: timers throttled - keep the usage tab visible` });
        log(`page ${page} stalled ${(paceDrift / 1000).toFixed(0)}s: timers throttled - keep the usage tab visible`);
      }
      page++;
    }
  } catch (err) {
    crawlError = err;
  } finally {
    // Always persist whatever was captured so far, even after an error.
    try {
      if (fileHandle) await writeCache();
    } catch (_) {
      if (!crawlError) crawlError = new Error(`Cache write failed`);
    }
    // Release our lease so the next run isn't blocked (only if it's still
    // ours; a dead worker's lease expires by TTL instead).
    if (beatTimer) clearInterval(beatTimer);
    try {
      if (leaseHandle && leaseOwner) {
        const lt = await (await leaseHandle.getFile()).text();
        const l = lt ? JSON.parse(lt) : null;
        if (l && l.owner === leaseOwner) {
          const w = await leaseHandle.createWritable();
          await w.write("");
          await w.close();
        }
      }
    } catch (_) {}
  }

  if (crawlError) {
    const message = String((crawlError && crawlError.message) || crawlError);
    postMessage({ type: "error", message });
    // Direct console line (not relayed): if the page main thread is wedged,
    // relayed logs never arrive, but this one is emitted by the worker itself.
    try { console.log("[opencode-usage:w] crawl failed:", message); } catch (_) {}
    return;
  }

  const result = {
    workspaceID,
    total: Object.keys(localCache).length,
    newRecords: newRecordCountTotal,
    newTokens: newTokensTotal,
    lastPage: page,
    stopReason,
    serverEmpty,
  };
  // Terminal state goes through postMessage only; the main thread sends the
  // single crawl-done notification (this also covers the inline fallback,
  // which has no worker notes).
  postMessage({ type: "done", result });
  try { console.log(`[opencode-usage:w] crawl-done: total=${result.total} new=${result.newRecords} lastPage=${result.lastPage} stop=${result.stopReason || "(end)"}`); } catch (_) {}
};
