// vendors/openrouter/content.js
// OpenRouter crawler (isolated world, openrouter.ai). Reads the account's usage
// from the cookie-authenticated private analytics endpoint - no management key:
//
//   POST /api/frontend/v1/private/analytics-query  (credentials: "include")
//
// The endpoint caps time_range at 31 days when the provider dimension is
// requested, so the range is fetched as <=30-day windows. Mapped canonical
// records are streamed to the background per window. Pure mapping/window logic
// lives in ./mapper.js and ./analytics-query.js (unit-tested).

(() => {
  if (window.__openrouterCrawlerLoaded) return;
  window.__openrouterCrawlerLoaded = true;

  const SOURCE = "openrouter";
  let crawling = false;

  function notify(msg) {
    try {
      chrome.runtime.sendMessage(msg);
    } catch (e) {
      // Extension context invalidated (reload) - drop the event.
    }
  }

  async function loadModules() {
    const [mapper, query] = await Promise.all([
      import(chrome.runtime.getURL("vendors/openrouter/mapper.js")),
      import(chrome.runtime.getURL("vendors/openrouter/analytics-query.js")),
    ]);
    return { ...mapper, ...query };
  }

  async function fetchWindow(body) {
    const res = await fetch("/api/frontend/v1/private/analytics-query", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 200);
      } catch (e) {}
      throw new Error(`analytics-query ${res.status}${detail ? `: ${detail}` : ""}`);
    }
    return res.json();
  }

  async function crawl(opts) {
    const { buildQueryBody, sliceRange, mapRows, rowsFromResponse, metadataFromResponse, isTruncated } = await loadModules();
    const end = new Date();
    const endMs = end.getTime();
    const floorMs = endMs - 365 * 86400000;

    // Incremental by default (D12): start one day before the newest stored
    // date so the last day is re-scanned for late-arriving data. `full` forces
    // a full `days` rescan; no prior data also means full.
    let startMs = endMs - (opts.days || 365) * 86400000;
    if (opts.since && !opts.full) {
      const sinceMs = Date.parse(`${opts.since}T00:00:00Z`);
      if (!isNaN(sinceMs)) startMs = Math.max(floorMs, sinceMs - 86400000);
    }
    if (startMs >= endMs) startMs = endMs - 86400000;

    const queue = sliceRange(new Date(startMs).toISOString(), end.toISOString());

    const seen = new Set();
    let windows = 0;
    let records = 0;
    let newRecords = 0;

    while (queue.length) {
      const w = queue.shift();
      windows++;
      notify({ type: "progress", page: windows, message: `${w.start.slice(0, 10)} → ${w.end.slice(0, 10)}` });

      const json = await fetchWindow(buildQueryBody({ start: w.start, end: w.end }));
      const meta = metadataFromResponse(json);

      // If the server truncated a window, split it in half and requeue (keeps
      // the 31-day cap and any hidden row limit from silently dropping data).
      if (isTruncated(meta)) {
        const span = new Date(w.end) - new Date(w.start);
        if (span > 86400000) {
          const mid = new Date((new Date(w.start).getTime() + new Date(w.end).getTime()) / 2).toISOString();
          queue.unshift({ start: w.start, end: mid }, { start: mid, end: w.end });
          continue;
        }
      }

      const batch = mapRows(rowsFromResponse(json)).filter((rec) => !seen.has(rec.id));
      for (const rec of batch) seen.add(rec.id);
      if (batch.length > 0) {
        records += batch.length;
        // Background reports how many ids were actually new (idempotent store).
        try {
          const res = await chrome.runtime.sendMessage({ type: "vendor-crawl-data", source: SOURCE, records: batch });
          if (res && typeof res.added === "number") newRecords += res.added;
        } catch (e) {
          notify({ type: "vendor-crawl-data", source: SOURCE, records: batch });
        }
      }
    }

    return { windows, records, newRecords };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== "start-crawl") return;
    if (msg.vendor && msg.vendor !== SOURCE) return;
    if (crawling) {
      sendResponse({ ok: true, started: false, reason: "busy" });
      return;
    }
    crawling = true;
    notify({ type: "crawl-start", workspace: "" });
    crawl({ days: msg.days, since: msg.since, full: !!msg.full })
      .then((res) => notify({ type: "vendor-crawl-done", source: SOURCE, windows: res.windows, records: res.records, newRecords: res.newRecords }))
      .catch((e) => notify({ type: "error", message: String((e && e.message) || e) }))
      .finally(() => {
        crawling = false;
      });
    sendResponse({ ok: true, started: true });
  });
})();
