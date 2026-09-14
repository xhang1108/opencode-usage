#!/usr/bin/env node
// tools/build-opencode-preset.mjs — rebuild extension/vendors/opencode/rates.preset.json
// from the GitHub crawl (script/clean_diffs.txt). Implements the agreed rule:
//   * each price row is anchored to its commit/`from` date (date-filtered timeline)
//   * name normalization (approach A):
//       - drop `...limit` non-model rows
//       - fold `(Peak)`/`(Off-Peak)` into one model with a fixed window
//       - fold `(> N K tokens)`/`(<= N K tokens)` token tiers into a base + `-over-N` id
//       - strip multi-language promo suffixes, normalize display name -> canonical id
//   * peak/offpeak window times are FIXED (deepseek-official definition)
//
// Usage: node tools/build-opencode-preset.mjs [--write]

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const CLEAN = resolve(root, "script/clean_diffs.txt");
const PRESET = resolve(root, "extension/vendors/opencode/rates.preset.json");

// Fixed peak window (deepseek-official definition; times are UTC, all days).
const FIXED_PEAK = {
  peak: [
    { days: [], start: "01:00", end: "04:00" },
    { days: [], start: "06:00", end: "10:00" },
  ],
};

const MANUAL = {
  "DeepSeek V4 Flash": "deepseek-v4-flash",
  "DeepSeek V4 Pro": "deepseek-v4-pro",
  "DeepSeek V4.1 Flash": "deepseek-v4.1-flash",
  "DeepSeek V4 Flash Vision Exp": "deepseek-v4-flash-vision-exp",
  "GLM 5": "glm-5",
  "GLM-5": "glm-5",
  "GLM-5.1": "glm-5.1",
  "GLM-5.2": "glm-5.2",
  "GLM-5.3": "glm-5.3",
  "GLM-5.3-Flash": "glm-5.3-flash",
  "Grok 4.5": "grok-4.5",
  "Grok 4.6": "grok-4.6",
  "Gemini 3.7 Flash": "gemini-3.7-flash",
  "Kimi K2.5": "kimi-k2.5",
  "Kimi K2.6": "kimi-k2.6",
  "Kimi K2.7 Code": "kimi-k2.7-code",
  "Kimi K3": "kimi-k3",
  "MiMo V2.5": "mimo-v2.5",
  "MiMo V2.5 Pro": "mimo-v2.5-pro",
  "MiniMax M2.5": "minimax-m2.5",
  "MiniMax M2.7": "minimax-m2.7",
  "MiniMax M3": "minimax-m3",
  "Muse Spark 1.2": "muse-spark-1.2",
  "Muse Spark 1.2 Contributor": "muse-spark-1.2-contributor",
  "Muse Spark 1.3 Contributor": "muse-spark-1.3-contributor",
  "Omen Alpha": "omen-alpha",
  "Qwen3.6 Plus": "qwen3.6-plus",
  "Qwen3.7 Plus": "qwen3.7-plus",
  "Qwen3.7 Max": "qwen3.7-max",
  "Qwen3.8 Max": "qwen3.8-max",
  "Qwen3.8 Flash": "qwen3.8-flash",
  "LongCat-2.0": "longcat-2.0",
  "Hy3": "hy3",
  "Hy4 preview": "hy4-preview",
  "GPT 5.6 Luna": "gpt-5.6-luna",
};

function slug(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Returns { id, baseName } or null to drop.
function normalize(rawName) {
  let n = rawName.trim();
  if (/limit/i.test(n)) return null; // 5 hour limit / Monthly limit / Weekly limit
  let variant = "flat";

  const po = n.match(/\s*\((Off-?Peak|Peak)\)\s*$/i);
  if (po) {
    variant = po[1].toLowerCase().includes("off") ? "offpeak" : "peak";
    n = n.replace(/\s*\([^)]*\)\s*$/, "").trim();
  } else {
    const tier = n.match(/\(\s*(>|≥|>=|≤|<=|=)\s*([\d.]+)\s*K?\s*tokens?\)\s*$/i);
    if (tier) {
      // Token-tier variant: fold into the base model as a `tier` pricing block
      // (single group), do NOT create a separate `-over-N` id.
      n = n.replace(/\s*\([^)]*\)\s*$/, "").trim();
      const baseId = MANUAL[n] || slug(n);
      const k = parseFloat(tier[2]) * 1000;
      const isHigh = />|≥|>=/.test(tier[1]);
      return { id: baseId, baseName: n, variant: isHigh ? "tier-high" : "tier-low", tierK: k };
    } else if (/\(/.test(n)) {
      // multi-language promo, e.g. (2x usage till Jul 24) -> strip
      n = n.replace(/\s*\([^)]*\)\s*$/, "").trim();
    }
  }

  const baseId = MANUAL[n] || slug(n);
  return { id: baseId, baseName: n, variant };
}

function parsePrice(field) {
  if (field == null) return 0;
  const v = String(field).replace(/\$/g, "").trim();
  if (v === "" || v === "-") return 0;
  const num = parseFloat(v);
  return Number.isFinite(num) ? num : 0;
}

function toISO(mmddyyyy, hhmmss) {
  const [mo, da, yr] = mmddyyyy.split("/");
  return `${yr}-${mo.padStart(2, "0")}-${da.padStart(2, "0")}T${hhmmss}.000Z`;
}

const lines = readFileSync(CLEAN, "utf8").split("\n");
const obs = {}; // id -> [{ date, variant, flat:{input,output,cacheRead} }]
let curDate = null;

for (const l of lines) {
  const h = l.match(/^=== \S+\s+(\d{1,2}\/\d{1,2}\/\d{4})\s+(\d{1,2}:\d{2}:\d{2}) /);
  if (h) {
    curDate = toISO(h[1], h[2]);
    continue;
  }
  if (!/^[+-]/.test(l)) continue;
  if (!curDate) continue; // price line before any commit header
  const parts = l.split("|").map((s) => s.trim());
  if (parts.length < 5) continue;
  const name = parts[1];
  if (!name) continue;
  const norm = normalize(name);
  if (!norm) continue;
  const prices = {
    input: parsePrice(parts[2]),
    output: parsePrice(parts[3]),
    cacheRead: parsePrice(parts[4]),
  };
  (obs[norm.id] ||= []).push({ date: curDate, variant: norm.variant, prices, k: norm.tierK });
}

// Build a rates timeline per id.
function buildRates(list) {
  const sorted = [...list].sort((a, b) => a.date.localeCompare(b.date));
  const byDate = new Map();
  for (const o of sorted) {
    if (!byDate.has(o.date)) byDate.set(o.date, {});
    const slot = byDate.get(o.date);
    if (o.variant === "tier-low") slot.tierLow = { prices: o.prices, k: o.k };
    else if (o.variant === "tier-high") slot.tierHigh = { prices: o.prices, k: o.k };
    else slot[o.variant] = o.prices;
  }
  const rates = [];
  let first = true;
  for (const [date, variants] of [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const from = first ? null : date;
    first = false;
    if (variants.tierLow && variants.tierHigh) {
      const limit = Math.max(variants.tierLow.k, variants.tierHigh.k);
      rates.push({
        from,
        pricing: {
          flat: {
            tier: {
              limit,
              low: { ...variants.tierLow.prices, cacheWrite: 0 },
              high: { ...variants.tierHigh.prices, cacheWrite: 0 },
            },
          },
        },
      });
    } else if (variants.peak && variants.offpeak) {
      rates.push({
        from,
        windows: FIXED_PEAK,
        pricing: { peak: { ...variants.peak, cacheWrite: 0 }, offpeak: { ...variants.offpeak, cacheWrite: 0 } },
      });
    } else {
      const p = variants.flat || variants.peak || variants.offpeak;
      rates.push({ from, pricing: { flat: { ...p, cacheWrite: 0 } } });
    }
  }
  // Drop consecutive entries whose price structure is identical (a model
  // re-listed at the same price in a later commit -> redundant timeline row).
  const deduped = [];
  for (const r of rates) {
    const prev = deduped[deduped.length - 1];
    const sig = (x) => JSON.stringify({ w: x.windows || null, p: x.pricing });
    if (prev && sig(prev) === sig(r)) continue;
    deduped.push(r);
  }
  return deduped;
}

const targets = {};
const modelMap = {};
const labels = {};
for (const [id, list] of Object.entries(obs)) {
  const rates = buildRates(list);
  if (rates.length === 0) continue;
  const key = `opencode:${id}`;
  targets[key] = { label: id, scope: "opencode", rates };
  modelMap[key] = key;
}

// Merge: keep existing entries for ids the crawl did not cover (e.g. free variants).
if (existsSync(PRESET)) {
  const existing = JSON.parse(readFileSync(PRESET, "utf8"));
  for (const [k, t] of Object.entries(existing.targets || {})) {
    if (/-over-\d/.test(k)) continue; // superseded by the `tier` block in the crawl build
    if (!targets[k]) targets[k] = t;
  }
  for (const [k, v] of Object.entries(existing.modelMap || {})) {
    if (/-over-\d/.test(k)) continue;
    if (!modelMap[k]) modelMap[k] = v;
  }
}

const preset = { presetVersion: 2, source: "opencode", modelMap, targets };
const out = JSON.stringify(preset, null, 2) + "\n";

// Validate.
const { validatePreset } = await import(
  pathToFileURL(resolve(root, "extension/shared/preset.js")).href
);
const check = validatePreset(preset);
if (!check.ok) {
  console.error("INVALID PRESET:", check.errors.join(", "));
  process.exit(1);
}

console.log(`models=${Object.keys(targets).length} (crawl-derived=${Object.keys(obs).length}) valid=${check.ok}`);
const write = process.argv.includes("--write");
if (write) {
  writeFileSync(PRESET, out);
  console.log(`wrote ${PRESET}`);
} else {
  console.log("dry-run (pass --write to persist)");
}
