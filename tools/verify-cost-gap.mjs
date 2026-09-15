#!/usr/bin/env node
// tools/verify-cost-gap.mjs — explain a vendor-reported vs unified cost gap.
//
// Reads a records CSV (the extension's Import/Export backup) and, for one
// source+model (+ optional date range), prints the token sums and the cost under
// three bases so the difference can be attributed exactly:
//   vendor-reported  priceWithConfig() with costSource[source] === "vendor"
//   derived          priceRecord() against the vendor fallback preset
//   unified          priceUnified() against shared/unified.preset.json
//
// It also groups the unified cost by rate version + window, which is what
// actually explains a large gap.
//
// Usage:
//   node tools/verify-cost-gap.mjs --csv records.csv --source opencode --model deepseek-v4-flash
//   node tools/verify-cost-gap.mjs --csv records.csv --source opencode --model deepseek-v4-flash --start 2026-07-01 --end 2026-10-01

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parseCSV, rowsToObjects } from "../extension/shared/csv.js";
import { priceRecord, getRateEntryFromRates, getWindow, resolveTable, computeCost, effectiveTimeMs } from "../extension/shared/pricing.js";
import { priceWithConfig } from "../extension/dashboard/core/pricing-config.js";
import { normalizeUnifiedPricing, buildUnifiedIndex, priceUnified } from "../extension/shared/unified.js";
import { buildPricing } from "../extension/shared/preset.js";
import { localDateOf } from "../extension/dashboard/core/time.js";

const ROOT = process.cwd();
const readJSON = (p) => JSON.parse(readFileSync(resolve(ROOT, p), "utf8"));

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const csvPath = arg("csv");
if (!csvPath) {
  console.error("usage: node tools/verify-cost-gap.mjs --csv <records.csv> [--source opencode] [--model deepseek-v4-flash] [--start YYYY-MM-DD] [--end YYYY-MM-DD]");
  process.exit(1);
}

const registry = readJSON("extension/shared/vendors.json");
const costSource = {};
for (const v of registry.vendors || []) if (v && v.source) costSource[v.source] = v.costSource || "derived";

const presets = [];
for (const src of ["opencode", "deepseek-official", "mimo"]) {
  try { presets.push(readJSON(`extension/vendors/${src}/rates.preset.json`)); } catch (e) { /* optional */ }
}
const pricing = buildPricing({ presets });
const unified = normalizeUnifiedPricing(readJSON("extension/shared/unified.preset.json"));
const unifiedIndex = buildUnifiedIndex(unified);

// Parse the CSV WITHOUT canonical normalization so the tool sees exactly what
// the dashboard stores — including day-granular records that carry only `date`
// and no `time` (the shape that used to mis-price at the oldest rate version).
const NUMERIC = new Set([
  "input", "output", "reasoning", "cacheRead", "cacheWrite5m", "cacheWrite1h",
  "requests", "tzOffset", "vendorCost", "costScale", "costMultiplier",
]);
const records = rowsToObjects(parseCSV(readFileSync(resolve(ROOT, csvPath), "utf8")))
  .map((row) => {
    const rec = {};
    for (const [k, v] of Object.entries(row)) {
      if (NUMERIC.has(k)) {
        const n = Number(v);
        if (v !== "" && Number.isFinite(n)) rec[k] = n;
      } else if (k === "outputExcludesReasoning") {
        if (v !== "") rec[k] = String(v) === "true";
      } else if (v !== "") {
        rec[k] = v;
      }
    }
    return rec;
  })
  .filter((rec) => rec.model);
const source = arg("source");
const model = arg("model");
const workspace = arg("workspace");
const start = arg("start", "");
const end = arg("end", "");

const picked = records.filter((rec) => {
  const src = rec.source || "opencode";
  if (source && src !== source) return false;
  if (model && rec.model !== model) return false;
  if (workspace && rec.workspaceID !== workspace) return false;
  const d = localDateOf(rec);
  if (start && (!d || d < start)) return false;
  if (end && (!d || d > end)) return false;
  return true;
});

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const sum = { n: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, requests: 0, vendorCostUsd: 0 };
let vendor = 0, derived = 0, unifiedTotal = 0, unpriced = 0;
const byVersion = new Map();

for (const rec of picked) {
  sum.n += 1;
  sum.input += num(rec.input);
  sum.output += num(rec.output);
  sum.reasoning += num(rec.reasoning);
  sum.cacheRead += num(rec.cacheRead);
  sum.cacheWrite5m += num(rec.cacheWrite5m);
  sum.cacheWrite1h += num(rec.cacheWrite1h);
  sum.requests += num(rec.requests) || 1;
  if (rec.vendorCost != null) sum.vendorCostUsd += num(rec.vendorCost) / (num(rec.costScale) || 1);

  vendor += priceWithConfig(rec, pricing, costSource).cost;
  derived += priceRecord(rec, pricing).cost;
  const u = priceUnified(rec, unifiedIndex);
  unifiedTotal += u.cost;
  if (u.unpriced) unpriced += 1;

  const key = `${u.targetId || "-"}`;
  if (!byVersion.has(key)) byVersion.set(key, { cost: 0, n: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0 });
  const b = byVersion.get(key);
  b.cost += u.cost; b.n += 1;
  b.input += num(rec.input); b.output += num(rec.output); b.reasoning += num(rec.reasoning); b.cacheRead += num(rec.cacheRead);
}

const fmt = (x) => `$${x.toFixed(4)}`;
const rawNoTime = picked.filter((r) => r.time == null || r.time === "").length;
const unpriceable = picked.filter((r) => Number.isNaN(effectiveTimeMs(r))).length;
console.log(`csv=${csvPath}  records=${records.length}  matched=${sum.n}  raw-missing-time=${rawNoTime}  unpriceable=${unpriceable}`);
console.log(`filter: source=${source || "*"} model=${model || "*"} range=${start || "*"}..${end || "*"}`);
console.log("");
console.log("TOKENS");
console.log(`  input        ${sum.input.toLocaleString()}`);
console.log(`  output       ${sum.output.toLocaleString()}`);
console.log(`  reasoning    ${sum.reasoning.toLocaleString()}   <-- billed at output rate, NOT shown in the dashboard table`);
console.log(`  cacheRead    ${sum.cacheRead.toLocaleString()}`);
console.log(`  cacheWrite5m ${sum.cacheWrite5m.toLocaleString()}`);
console.log(`  cacheWrite1h ${sum.cacheWrite1h.toLocaleString()}`);
console.log(`  requests     ${sum.requests.toLocaleString()}`);
console.log("");
console.log("COST");
console.log(`  vendor-reported (vendorCost/costScale)  ${fmt(sum.vendorCostUsd)}`);
console.log(`  vendor-reported via priceWithConfig     ${fmt(vendor)}`);
console.log(`  derived (vendor preset, priceRecord)    ${fmt(derived)}`);
console.log(`  unified (unified.preset.json)           ${fmt(unifiedTotal)}   unpriced records=${unpriced}`);
console.log("");
console.log("UNIFIED BREAKDOWN by group <- (version/window detail)");
for (const [group, b] of [...byVersion.entries()].sort((a, b2) => b2[1].cost - a[1].cost)) {
  console.log(`  ${group}  n=${b.n}  cost=${fmt(b.cost)}  input=${b.input.toLocaleString()} output=${b.output.toLocaleString()} reasoning=${b.reasoning.toLocaleString()} cacheRead=${b.cacheRead.toLocaleString()}`);
  const g = unified.groups.find((x) => x.id === group);
  if (g) {
    const seen = new Map();
    for (const rate of g.rates) seen.set(String(rate.from), rate);
    for (const [from, rate] of seen) {
      const t = rate.pricing.flat || rate.pricing.offpeak;
      const label = rate.pricing.flat
        ? `flat ${t.input}/${t.output}/${t.cacheRead}`
        : `peak ${rate.pricing.peak.input}/${rate.pricing.peak.output}/${rate.pricing.peak.cacheRead} | offpeak ${rate.pricing.offpeak.input}/${rate.pricing.offpeak.output}/${rate.pricing.offpeak.cacheRead}`;
      console.log(`       version from=${from}  ${label}`);
    }
  }
}
