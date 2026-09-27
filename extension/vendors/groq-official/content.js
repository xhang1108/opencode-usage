// vendors/groq-official/content.js
// Groq console crawler (isolated world on console.groq.com). Reads the
// account's usage from the same platform endpoint the Usage page uses:
//
//   GET https://api.groq.com/platform/v1/organizations/{org}/activity
//       ?start_date=<unix-sec>&end_date=<unix-sec>
//
// Auth is NOT the page cookie (api.groq.com rejects credentials:include with a
// wildcard CORS origin): the page sends
//   authorization: Bearer <stytch_session_jwt cookie value>
//   groq-organization: <org_id>
// Org ids are discovered via GET /platform/v1/user/profile
// (user.orgs.data[].id), so nothing is hardcoded.
//
// The /activity rows are day-granular (timestamp = UTC-midnight unix sec), one
// row per day x model x API key. The range limit is unprobed, so the crawl
// walks <=31-day windows; incremental resumes one day before the newest stored
// record (D12). No `credentials` on the cross-origin fetch: the short-lived
// (~5 min) JWT is re-read from the cookie on every request.

(() => {
  if (window.__groqCrawlerLoaded) return;
  window.__groqCrawlerLoaded = true;

  const SOURCE = "groq-official";
  const API = "https://api.groq.com/platform/v1";
  const DAY = 86400;
  const MAX_SCAN_DAYS = 365; // first-run backfill cap (range limit unprobed)
  const WINDOW_DAYS = 31; // conservative slice; the page itself fetches ~2 months
  const DELAY_MS = 600; // pace requests

  let crawling = false;

  function notify(msg) {
    try {
      chrome.runtime.sendMessage(msg);
    } catch (e) {}
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function loadMapper() {
    return import(chrome.runtime.getURL("vendors/groq-official/mapper.js"));
  }

  // The Stytch B2B session JWT lives in a readable cookie; it rotates every
  // ~5 minutes, so it is re-read for every request.
  function readJwt() {
    try {
      for (const c of String(document.cookie || "").split(";")) {
        const i = c.indexOf("=");
        if (c.slice(0, i).trim() !== "stytch_session_jwt") continue;
        let v = decodeURIComponent(c.slice(i + 1).trim()).replace(/^Bearer\s+/i, "").replace(/^"|"$/g, "");
        if (v.startsWith("{")) {
          try {
            const o = JSON.parse(v);
            v = o.value || o.jwt || o.token || "";
          } catch (e) {}
        }
        return v && v.length > 100 ? v : null;
      }
    } catch (e) {}
    return null;
  }

  async function fetchJson(url, org, { retries = 3 } = {}) {
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await sleep(1000 * attempt);
      const jwt = readJwt();
      if (!jwt) throw new Error("Groq: not logged in (no stytch_session_jwt cookie) — open console.groq.com and sign in");
      let res;
      try {
        res = await fetch(url, {
          headers: { authorization: "Bearer " + jwt, ...(org ? { "groq-organization": org } : {}), accept: "application/json" },
        });
      } catch (e) {
        lastErr = e;
        continue; // network error
      }
      const text = await res.text();
      if (res.status === 401 || res.status === 403) {
        throw new Error("Groq: session expired — reload the console tab and sync again");
      }
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`Groq ${res.status} (rate limited / blocked)`);
        continue;
      }
      if (!res.ok) throw new Error(`Groq usage ${res.status}: ${text.slice(0, 120)}`);
      try {
        return JSON.parse(text);
      } catch (e) {
        lastErr = new Error(`Groq non-JSON (${res.status}): ${text.slice(0, 120)}`);
      }
    }
    throw lastErr || new Error("Groq request failed");
  }

  // UTC midnight (unix sec) for a YYYY-MM-DD date string.
  function dateToDayStart(dateStr) {
    const [Y, M, D] = String(dateStr).split("-").map(Number);
    if (!Y || !M || !D) return null;
    return Date.UTC(Y, M - 1, D) / 1000;
  }

  async function crawl(opts) {
    const mapper = await loadMapper();
    const nowSec = Math.floor(Date.now() / 1000);
    const endSec = nowSec;

    const scanDays = opts && opts.days ? Math.min(opts.days, MAX_SCAN_DAYS) : MAX_SCAN_DAYS;
    let fromSec;
    if (opts && opts.since) {
      const s = dateToDayStart(String(opts.since).slice(0, 10));
      fromSec = s != null ? s - DAY : endSec - scanDays * DAY; // one-day overlap
    } else {
      fromSec = endSec - scanDays * DAY;
    }
    if (fromSec >= endSec) fromSec = endSec - DAY;

    // Discover orgs; the profile call needs no groq-organization header.
    const profile = await fetchJson(`${API}/user/profile`, null);
    const orgs = mapper.orgsFromProfile(profile);
    if (orgs.length === 0) throw new Error("Groq: no organizations on this account");

    const seen = new Set();
    let windows = 0;
    let records = 0;
    let added = 0;
    const failures = [];
    for (const org of orgs) {
      for (let start = fromSec; start < endSec; start += WINDOW_DAYS * DAY) {
        const end = Math.min(start + WINDOW_DAYS * DAY, endSec);
        windows++;
        notify({
          type: "progress",
          page: windows,
          message: `${org.slice(0, 12)}… ${new Date(start * 1000).toISOString().slice(0, 10)} → ${new Date(end * 1000).toISOString().slice(0, 10)}`,
        });
        let batch = [];
        try {
          const json = await fetchJson(`${API}/organizations/${org}/activity?start_date=${start}&end_date=${end}`, org);
          batch = mapper.mapRows(mapper.rowsFromResponse(json)).filter((rec) => !seen.has(rec.id));
        } catch (e) {
          failures.push(`${org.slice(0, 12)}…: ${(e && e.message) || e}`);
        }
        for (const rec of batch) seen.add(rec.id);
        if (batch.length > 0) {
          records += batch.length;
          try {
            const res = await chrome.runtime.sendMessage({ type: "vendor-crawl-data", source: SOURCE, records: batch });
            if (res && typeof res.added === "number") added += res.added;
            else notify({ type: "vendor-crawl-data", source: SOURCE, records: batch });
          } catch (e) {
            notify({ type: "vendor-crawl-data", source: SOURCE, records: batch });
          }
        }
        await sleep(DELAY_MS);
      }
    }
    if (failures.length > 0) {
      throw new Error(`Groq: ${failures.length} request(s) failed after retries — ${failures.slice(0, 3).join("; ")}${failures.length > 3 ? " …" : ""}`);
    }
    return { windows, orgs: orgs.length, records, added };
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
        notify({ type: "vendor-crawl-done", source: SOURCE, records: res.records, newRecords: res.added, windows: res.windows })
      )
      .catch((e) => notify({ type: "error", message: String((e && e.message) || e) }))
      .finally(() => {
        crawling = false;
      });
    sendResponse({ ok: true, started: true });
  });
})();
