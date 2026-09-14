// vendors/commandcode/content.js
// CommandCode crawler (isolated world on commandcode.ai). Reads usage from the
// cookie-authenticated charts endpoint (no key):
//
//   GET https://api.commandcode.ai/internal/usage/charts?from=<ISO>&to=<ISO>
//       [&granularity=day]
//
// Charts aggregates per time bucket x model x provider and is not capped like
// /internal/usage (100 rows/window). Buckets are 5 minutes by default, `day`
// when requested. To avoid hammering the API we first probe with `day` to find
// the days that actually have usage, then fetch 5-minute buckets for those days
// one at a time with a delay. Incremental: resume from the newest stored day.

(() => {
  if (window.__commandcodeCrawlerLoaded) return;
  window.__commandcodeCrawlerLoaded = true;

  const SOURCE = "commandcode";
  const CHARTS = "https://api.commandcode.ai/internal/usage/charts";
  const CHUNK_DELAY_MS = 600; // pause between per-day requests
  const PROBE_FROM = Date.parse("2023-01-01T00:00:00Z"); // retention bounds the result
  const SAFETY_DAYS = 3660; // guard against a pathological response only

  let crawling = false;

  function notify(msg) {
    try {
      chrome.runtime.sendMessage(msg);
    } catch (e) {}
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function loadMapper() {
    return import(chrome.runtime.getURL("vendors/commandcode/mapper.js"));
  }

  async function fetchCharts(mapper, fromMs, toMs, granularity) {
    const qs = new URLSearchParams({ from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() });
    if (granularity) qs.set("granularity", granularity);
    const res = await fetch(`${CHARTS}?${qs.toString()}`, { credentials: "include", headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`usage/charts ${res.status}`);
    const json = await res.json();
    return mapper.mapChartBuckets(json.data || []);
  }

  async function crawl(opts) {
    const mapper = await loadMapper();
    const now = Date.now();
    const endMs = now + 86400000;
    // Incremental resumes at the last stored day; otherwise probe all retained
    // history (the server only returns what is inside the billing period).
    let startMs = PROBE_FROM;
    if (opts && opts.since) {
      const ms = Date.parse(`${opts.since}T00:00:00Z`);
      if (!isNaN(ms)) startMs = ms - 86400000;
    }

    // 1) day probe -> every day that has usage inside retention (1 request).
    let dayRecords;
    try {
      dayRecords = await fetchCharts(mapper, startMs, endMs, "day");
    } catch (e) {
      // Very wide ranges can be rejected; retry against a conservative window.
      dayRecords = await fetchCharts(mapper, now - 400 * 86400000, endMs, "day");
    }
    const days = [...new Set(dayRecords.map((r) => String(r.time).slice(0, 10)))].sort().slice(-SAFETY_DAYS);

    // 2) per-day 5-minute buckets, paced; stops when every discovered day is done.
    let records = 0;
    let added = 0; // records actually new in storage (not already stored)
    for (let i = 0; i < days.length; i++) {
      const day = days[i];
      const from = Date.parse(`${day}T00:00:00Z`);
      const recs = await fetchCharts(mapper, from, from + 86400000, null);
      if (recs.length > 0) {
        records += recs.length;
        try {
          const res = await chrome.runtime.sendMessage({ type: "vendor-crawl-data", source: SOURCE, records: recs });
          if (res && typeof res.added === "number") added += res.added;
          else notify({ type: "vendor-crawl-data", source: SOURCE, records: recs });
        } catch (e) {
          notify({ type: "vendor-crawl-data", source: SOURCE, records: recs });
        }
      }
      notify({ type: "progress", page: i + 1, message: `${day} (${i + 1}/${days.length}, ${recs.length} rows)` });
      if (i < days.length - 1) await sleep(CHUNK_DELAY_MS);
    }
    return { days: days.length, records, added };
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
    crawl({ since: msg.since })
      .then((res) => notify({ type: "vendor-crawl-done", source: SOURCE, records: res.records, newRecords: res.added }))
      .catch((e) => notify({ type: "error", message: String((e && e.message) || e) }))
      .finally(() => {
        crawling = false;
      });
    sendResponse({ ok: true, started: true });
  });
})();
