// vendors/deepseek-official/content.js
// DeepSeek platform crawler (isolated world on *.deepseek.com). Reads the
// account's usage from the same cookie+token endpoint the Usage page uses:
//
//   GET /api/v0/usage/by_api_key/amount?start=<unix-sec>&end=<unix-sec>&tz=28800
//   GET /api/v0/usage/by_api_key/cost?start=<unix-sec>&end=<unix-sec>&tz=28800
//   authorization: Bearer <localStorage.userToken.value>
//
// Server-chosen bucket: exactly a 1-day range -> hourly (3600), wider -> daily
// (86400); ranges beyond ~31 days return empty. So the crawl:
//   1) scans backwards in <=31-day windows (daily buckets) to find which days
//      have usage (bounded by MAX_SCAN_DAYS),
//   2) fetches each of those days as a 1-day range to get hourly rows.
// Incremental resumes one day before the newest stored record.

(() => {
  if (window.__deepseekCrawlerLoaded) return;
  window.__deepseekCrawlerLoaded = true;

  const SOURCE = "deepseek-official";
  const API = "/api/v0/usage/by_api_key/amount";
  const API_COST = "/api/v0/usage/by_api_key/cost";
  const TZ = 28800; // +08:00 — the API requires +08-aligned day boundaries
  const DAY = 86400;
  const MAX_SCAN_DAYS = 365; // first-run backfill cap
  const PROBE_SPAN_DAYS = 31; // server returns daily buckets up to ~31 days
  const DELAY_MS = 900; // pace requests (server rate-limits bursts)

  let crawling = false;

  function notify(msg) {
    try {
      chrome.runtime.sendMessage(msg);
    } catch (e) {}
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // localStorage.userToken = {"value":"<64-char bearer>","__version":0}
  function readToken() {
    try {
      const raw = localStorage.getItem("userToken");
      if (!raw) return null;
      const o = JSON.parse(raw);
      return o && typeof o.value === "string" ? o.value : null;
    } catch (e) {
      return null;
    }
  }

  async function loadMapper() {
    return import(chrome.runtime.getURL("vendors/deepseek-official/mapper.js"));
  }

  // Reads the body as text first: rate-limit / WAF responses are HTML or empty,
  // so `res.json()` throws an opaque "Unexpected end of JSON input". Uses
  // backoff for 429/403/5xx and non-JSON bodies.
  async function fetchEndpoint(path, startSec, endSec, { retries = 4 } = {}) {
    const token = readToken();
    if (!token) throw new Error("DeepSeek: not logged in (no userToken)");
    const url = `${path}?start=${startSec}&end=${endSec}&tz=${TZ}`;
    const headers = {
      authorization: "Bearer " + token,
      "x-client-bundle-id": "com.deepseek.chat",
      "x-client-platform": "web",
      "x-client-version": "1.0.0",
      "x-client-locale": "en_US",
      "x-client-timezone-offset": String(TZ),
      accept: "*/*",
    };
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await sleep(1200 * attempt); // 1.2s, 2.4s, 3.6s, 4.8s
      let res;
      try {
        res = await fetch(url, { credentials: "include", headers });
      } catch (e) {
        lastErr = e;
        continue; // network error
      }
      const text = await res.text();
      if (res.status === 429 || res.status === 403 || res.status >= 500) {
        lastErr = new Error(`DeepSeek ${res.status} (rate limited / blocked)`);
        continue;
      }
      if (!res.ok) throw new Error(`DeepSeek usage ${res.status}: ${text.slice(0, 120)}`);
      let json;
      try {
        json = JSON.parse(text);
      } catch (e) {
        lastErr = new Error(`DeepSeek non-JSON (${res.status}): ${text.slice(0, 120)}`);
        continue;
      }
      if (json && json.code && json.code !== 0) {
        throw new Error(`DeepSeek API ${json.code}: ${json.msg || ""}`); // auth/session, not transient
      }
      return json;
    }
    throw lastErr || new Error("DeepSeek request failed");
  }

  // +08 midnight (unix sec) of the day containing `unixSec`.
  const dayStart = (unixSec) => Math.floor((unixSec + TZ) / DAY) * DAY - TZ;

  // +08 midnight (unix sec) for a YYYY-MM-DD (+08) date string.
  function dateToDayStart(dateStr) {
    const [Y, M, D] = String(dateStr).split("-").map(Number);
    if (!Y || !M || !D) return null;
    return Date.UTC(Y, M - 1, D) / 1000 - TZ;
  }

  async function crawl(opts) {
    const mapper = await loadMapper();
    const nowSec = Math.floor(Date.now() / 1000);
    const endSec = dayStart(nowSec); // today's +08 midnight (exclusive)

    const scanDays = opts && opts.days ? Math.min(opts.days, MAX_SCAN_DAYS) : MAX_SCAN_DAYS;
    let fromSec;
    if (opts && opts.since) {
      const s = dateToDayStart(String(opts.since).slice(0, 10));
      fromSec = s != null ? s - DAY : endSec - scanDays * DAY; // one-day overlap
    } else {
      fromSec = endSec - scanDays * DAY;
    }
    if (fromSec >= endSec) fromSec = endSec - DAY;

    // 1) daily-bucket scan -> which days have usage.
    const sinceDays = new Set();
    const failures = [];
    let windows = 0;
    for (let start = fromSec; start < endSec; start += PROBE_SPAN_DAYS * DAY) {
      const end = Math.min(start + PROBE_SPAN_DAYS * DAY, endSec);
      windows++;
      try {
        const json = await fetchEndpoint(API, start, end);
        for (const day of mapper.usedDaysFromPayload(json, { tzOffsetSec: TZ })) sinceDays.add(day);
      } catch (e) {
        failures.push(`scan: ${(e && e.message) || e}`);
      }
      notify({
        type: "progress",
        page: windows,
        message: `scan ${new Date(start * 1000 + TZ * 1000).toISOString().slice(0, 10)} → ${new Date(
          end * 1000 + TZ * 1000
        )
          .toISOString()
          .slice(0, 10)} (${sinceDays.size} days)`,
      });
      await sleep(DELAY_MS);
    }

    // 2) hourly fetch for each day with usage (exactly 1 day -> bucket 3600).
    const days = [...sinceDays].sort();
    let records = 0;
    let added = 0;
    for (let i = 0; i < days.length; i++) {
      const start = dateToDayStart(days[i]);
      if (start == null) continue;
      let recs = [];
      try {
        const json = await fetchEndpoint(API, start, start + DAY);
        // `/cost` (CNY) is stored in raw for audit; a failure here must not lose
        // the token rows.
        let costJson = null;
        try {
          costJson = await fetchEndpoint(API_COST, start, start + DAY);
        } catch (e) {}
        recs = mapper.mapSeriesPayload(json, { costJson });
      } catch (e) {
        failures.push(`${days[i]}: ${(e && e.message) || e}`);
        notify({ type: "progress", page: i + 1, message: `${days[i]} FAILED (${i + 1}/${days.length})` });
        if (i < days.length - 1) await sleep(DELAY_MS);
        continue;
      }
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
      notify({ type: "progress", page: i + 1, message: `${days[i]} (${i + 1}/${days.length}, ${recs.length} rows)` });
      if (i < days.length - 1) await sleep(DELAY_MS);
    }
    if (failures.length > 0) {
      throw new Error(`DeepSeek: ${failures.length} request(s) failed after retries — ${failures.slice(0, 3).join("; ")}${failures.length > 3 ? " …" : ""}`);
    }
    return { windows, days: days.length, records, added };
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
    crawl({ days: msg.days, since: msg.since })
      .then((res) =>
        notify({ type: "vendor-crawl-done", source: SOURCE, records: res.records, newRecords: res.added, windows: res.windows, days: res.days })
      )
      .catch((e) => notify({ type: "error", message: String((e && e.message) || e) }))
      .finally(() => {
        crawling = false;
      });
    sendResponse({ ok: true, started: true });
  });
})();
