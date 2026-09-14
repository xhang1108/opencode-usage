#!/usr/bin/env node
// tools/price-watch-backfill.mjs — one-time backfill of vendor price history
// from the Internet Archive (Wayback Machine). Parses archived official price
// pages into the same snapshot format as price-watch, so the version chain has
// pre-existing history. Run once; daily price-watch keeps it current.
//
// Usage: node tools/price-watch-backfill.mjs [--source deepseek-official] [--limit N]

import { VENDORS, loadParser, loadSnapshots, modelsKey, writeSnapshot, isoFromWayback, rebuildPreset } from "./price-watch-lib.mjs";

const ARCHIVED = {
  "deepseek-official": [
    "api-docs.deepseek.com/quick_start/pricing",
    "platform.deepseek.com/api-docs/pricing",
  ],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(label, fn, attempts = 4) {
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i === attempts) throw e;
      console.error(`${label} attempt ${i} failed (${e.message}); retrying…`);
      await sleep(1500 * i);
    }
  }
  return null;
}

async function cdxTimestamps(url) {
  const api = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(url)}&output=json&fl=timestamp,digest&filter=statuscode:200&collapse=digest`;
  return withRetry(`CDX ${url}`, async () => {
    const res = await fetch(api, { headers: { "user-agent": "Mozilla/5.0" } });
    if (!res.ok) throw new Error(`CDX ${res.status}`);
    const rows = JSON.parse(await res.text());
    return rows.slice(1).map((r) => r[0]);
  });
}

async function fetchArchived(url, ts) {
  try {
    return await withRetry(`wayback ${ts}`, async () => {
      const res = await fetch(`https://web.archive.org/web/${ts}id_/https://${url}`, { headers: { "user-agent": "Mozilla/5.0" } });
      if (!res.ok) throw new Error(`wayback ${res.status}`);
      return res.text();
    }, 3);
  } catch (e) {
    return null;
  }
}

const srcIdx = process.argv.indexOf("--source");
const source = srcIdx !== -1 ? process.argv[srcIdx + 1] : "deepseek-official";
const limIdx = process.argv.indexOf("--limit");
const limit = limIdx !== -1 ? Number(process.argv[limIdx + 1]) : Infinity;

const cfg = VENDORS[source];
if (!cfg) {
  console.error(`Unknown source: ${source}`);
  process.exit(1);
}
const parser = await loadParser(cfg);

const candidates = [];
for (const url of ARCHIVED[source] || []) {
  try {
    for (const ts of await cdxTimestamps(url)) candidates.push({ url, ts });
  } catch (e) {
    console.error(`CDX failed for ${url}: ${e.message}`);
  }
}
candidates.sort((a, b) => a.ts.localeCompare(b.ts));
console.log(`Wayback change points: ${candidates.length}`);

const seen = new Set(loadSnapshots(cfg).map(modelsKey));
let lastKey = null;
let written = 0;
let checked = 0;

for (const c of candidates) {
  if (checked >= limit) break;
  checked++;
  const html = await fetchArchived(c.url, c.ts);
  if (!html) continue;
  let snap;
  try {
    snap = parser.snapshotFromPage(html, isoFromWayback(c.ts), { source });
  } catch (e) {
    continue; // page shape not parseable (older layout) - skip
  }
  const key = modelsKey(snap);
  if (key === lastKey || seen.has(key)) {
    lastKey = key;
    continue;
  }
  lastKey = key;
  seen.add(key);
  writeSnapshot(cfg, snap);
  written++;
  await sleep(250);
}

const out = await rebuildPreset(source, cfg);
console.log(`${source}: backfill checked=${checked} written=${written} snapshots=${out.snapshots} targets=${out.targets} modelMap=${out.modelMap}`);
