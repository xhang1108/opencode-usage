// tools/bench/dashboard-load.mjs
// Pure-module benchmark for the dashboard load path (plan §2).
//
// Protocol (plan §2.1): a *deterministic* fixture (fixed seed, fixed record
// count / model mix / date span / unpriced count), median-of-N with a warmup,
// and a no-op pricer control row to isolate the pricing cost. Absolute numbers
// are machine-dependent; the ratios and the fixture are what regressions are
// compared against.
//
// Run:
//   node tools/bench/dashboard-load.mjs                       # 30k / 60k / 120k
//   node tools/bench/dashboard-load.mjs --sizes 60000 --reps 9
//   node tools/bench/dashboard-load.mjs --json                # machine-readable
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

import { normalizeRecord } from "../../extension/shared/canonical.js";
import { aggregate } from "../../extension/dashboard/core/aggregate.js";
import { yearlyGrid, heatmapCells } from "../../extension/dashboard/views/chart-model.js";
import { normalizeUnifiedPricing, buildUnifiedIndex, priceUnified } from "../../extension/shared/unified.js";

const PRESET_URL = new URL("../../extension/shared/unified.preset.json", import.meta.url);

// Deterministic PRNG (mulberry32) so the fixture is identical across runs.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Distinct model names: real ones (priced by the preset) + a fixed number of
// synthetic unpriced ones, so the unpriced path is exercised too.
function buildModelPool(unified, realCount, unpricedCount) {
  const keys = Object.keys(unified.assign || {}).filter((k) => !k.startsWith("fp:"));
  const real = [];
  for (const k of keys) {
    const name = k.slice(k.indexOf(":") + 1);
    if (!real.includes(name)) real.push(name);
    if (real.length >= realCount) break;
  }
  while (real.length < realCount) real.push(`synthetic-real-${real.length}`);
  const unpriced = Array.from({ length: unpricedCount }, (_, i) => `synthetic-unpriced-${i}`);
  return [...real, ...unpriced];
}

function buildFixture(size, { seed, days, modelPool }) {
  const rand = mulberry32(seed);
  const base = Date.UTC(2026, 0, 1);
  const records = new Array(size);
  const byId = {};
  for (let i = 0; i < size; i++) {
    const day = i % days;
    const minute = Math.floor(rand() * 24 * 60);
    const time = new Date(base + day * 86400000 + minute * 60000).toISOString();
    const model = modelPool[i % modelPool.length];
    const rec = normalizeRecord({
      id: `opencode:bench-${i}`,
      source: "opencode",
      time,
      model,
      workspaceID: `wrk_${i % 5}`,
      input: 500 + Math.floor(rand() * 8000),
      output: 100 + Math.floor(rand() * 900),
      reasoning: i % 7 === 0 ? 120 : 0,
      cacheRead: 1000 + Math.floor(rand() * 5000),
      cacheWrite5m: i % 4 === 0 ? 50 : 0,
      cacheWrite1h: 0,
      // The other fields the real mapper carries (plan §8.1): they are dead
      // weight for the dashboard but their size drives stringify/parse/normalize.
      provider: i % 3 === 0 ? null : "opencode",
      sessionID: `ses_${i % 5000}`,
      userID: `usr_${i % 20}`,
      app: "bench",
      keyID: `key_${i % 50}`,
      principalType: "user",
      billingSource: i % 3 === 0 ? null : "console",
      costScale: 1e8,
      vendorCost: i % 3 === 0 ? undefined : 0.001,
      outputExcludesReasoning: true,
    });
    records[i] = rec;
    byId[rec.id] = rec;
  }
  return { records, byId };
}

// median of `reps` runs, after one warmup run.
function measure(fn, reps) {
  fn();
  const times = [];
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)];
}

function benchSize(size, { reps, days, seed, modelPool, index, unified }) {
  const { records, byId } = buildFixture(size, { seed, days, modelPool });

  const json = JSON.stringify(byId);
  const dates = records.map((r) => r.date).filter(Boolean).sort();
  const startDate = dates[dates.length - 8] || dates[0];
  const endDate = dates[dates.length - 1];

  const realPrice = (rec) => priceUnified(rec, index);
  const noopPrice = () => ({ cost: 0.001, savings: 0, window: "flat", unpriced: false, priceBasis: "flat" });
  const makeCached = () => {
    const cache = new Map();
    return (rec) => {
      let v = cache.get(rec.id);
      if (!v) {
        v = priceUnified(rec, index);
        cache.set(rec.id, v);
      }
      return v;
    };
  };
  // Persistent caches: measure() warms them once, so the reps are true cache hits
  // (a cache created inside the measured fn would only measure cold + Map cost).
  const hotPrice = makeCached();
  const hotPriceWindow = makeCached();

  const aggCold = aggregate(records, { price: realPrice });
  const allDates = Object.keys(aggCold.dailyAll).sort();
  const { weeks } = yearlyGrid(allDates);
  let maxCost = 0;
  for (const d of allDates) if (aggCold.dailyAll[d].cost > maxCost) maxCost = aggCold.dailyAll[d].cost;

  const timings = {
    stringify: measure(() => JSON.stringify(byId), reps),
    parse: measure(() => JSON.parse(json), reps),
    normalize: measure(() => {
      const out = {};
      for (const [id, rec] of Object.entries(byId)) out[id] = normalizeRecord(rec) || rec;
      return out;
    }, reps),
    aggregateCold: measure(() => aggregate(records, { price: realPrice }), reps),
    aggregateHot: measure(() => aggregate(records, { price: hotPrice }), reps),
    aggregateHotWindow: measure(() => aggregate(records, { price: hotPriceWindow, startDate, endDate }), reps),
    aggregateNoop: measure(() => aggregate(records, { price: noopPrice }), reps),
    heatmapCells: measure(() => heatmapCells(aggCold.dailyAll, weeks, maxCost, 0.08), reps),
    buildUnifiedIndex: measure(() => buildUnifiedIndex(unified), reps),
  };

  const pricingShare = timings.aggregateCold > 0 ? 1 - timings.aggregateNoop / timings.aggregateCold : 0;
  // First-load page JS after Step 9: parse + normalize + one cold aggregate +
  // the pure heatmap plan (the raw scan is now inside the aggregate pass).
  const pureJsSubtotal = timings.parse + timings.normalize + timings.aggregateCold + timings.heatmapCells;

  return { size, bytes: json.length, weeks: weeks.length, timings, pricingShare, pureJsSubtotal };
}

export function runBench(opts = {}) {
  const {
    sizes = [60000],
    reps = 7,
    days = 365,
    realModelCount = 20,
    unpricedModelCount = 3,
    seed = 20260929,
  } = opts;

  const preset = JSON.parse(readFileSync(PRESET_URL, "utf8"));
  const unified = normalizeUnifiedPricing(preset);
  const index = buildUnifiedIndex(unified);
  const modelPool = buildModelPool(unified, realModelCount, unpricedModelCount);

  const results = sizes.map((size) => benchSize(size, { reps, days, seed, modelPool, index, unified }));
  return { reps, days, models: modelPool.length, results };
}

const ROWS = [
  ["stringify", "JSON.stringify (SW, merged map)"],
  ["parse", "JSON.parse (page)"],
  ["normalize", "normalizeRecord loop (page)"],
  ["aggregateCold", "aggregate cold + real price"],
  ["aggregateHot", "aggregate hot (price cache)"],
  ["aggregateHotWindow", "aggregate hot + 7-day window"],
  ["aggregateNoop", "aggregate + no-op pricer (control)"],
  ["heatmapCells", "heatmapCells plan (yearly grid)"],
  ["buildUnifiedIndex", "buildUnifiedIndex"],
];

function printReport(out) {
  const { reps, models, results } = out;
  console.log(`\nDashboard load benchmark — fixture: days=365, models=${models}, reps=${reps} (median)\n`);
  const header = ["phase", ...results.map((r) => `${r.size.toLocaleString()} (${(r.bytes / 1048576).toFixed(2)} MB)`)];
  console.log("| " + header.join(" | ") + " |");
  console.log("|" + header.map(() => "---").join("|") + "|");
  for (const [key, label] of ROWS) {
    const cells = results.map((r) => `${r.timings[key].toFixed(1)} ms`);
    console.log("| " + [label, ...cells].join(" | ") + " |");
  }
  console.log("| **pricing share of aggregateCold** | " + results.map((r) => `${(r.pricingShare * 100).toFixed(0)}%`).join(" | ") + " |");
  console.log("| **pure JS subtotal (first load)** | " + results.map((r) => `${r.pureJsSubtotal.toFixed(0)} ms`).join(" | ") + " |");
  console.log(
    "\nnot counted: chrome.storage reads/writes, sendResponse serialisation, Chart.js, the decorative canvas." +
      "\nabsolute values are machine-dependent; compare like-for-like within one machine.\n"
  );
}

function main(argv) {
  const args = argv.slice(2);
  const getArg = (name) => {
    const i = args.indexOf(name);
    return i !== -1 ? args[i + 1] : null;
  };
  const sizesArg = getArg("--sizes");
  const sizes = sizesArg ? sizesArg.split(",").map((n) => parseInt(n, 10)).filter(Boolean) : [30000, 60000, 120000];
  const reps = parseInt(getArg("--reps"), 10) || 7;
  const out = runBench({ sizes, reps });
  if (args.includes("--json")) console.log(JSON.stringify(out, null, 2));
  else printReport(out);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv);
}
