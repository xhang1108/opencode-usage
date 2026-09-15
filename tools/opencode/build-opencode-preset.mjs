#!/usr/bin/env node
// tools/opencode/build-opencode-preset.mjs — rebuild extension/vendors/opencode/rates.preset.json
// from the GitHub crawl (tools/opencode/clean_diffs.txt). Implements the agreed rule:
//   * each price row is anchored to its commit/`from` date (date-filtered timeline)
//   * name normalization (approach A):
//       - drop `...limit` non-model rows
//       - fold `(Peak)`/`(Off-Peak)` into one model with a fixed window
//       - fold `(> N K tokens)`/`(<= N K tokens)` token tiers into a base + `-over-N` id
//       - strip multi-language promo suffixes, normalize display name -> canonical id
//   * peak/offpeak window times are FIXED (deepseek-official definition)
//
// Usage: node tools/opencode/build-opencode-preset.mjs [--write]

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const CLEAN = resolve(here, "clean_diffs.txt");
const PRESET = resolve(root, "extension/vendors/opencode/rates.preset.json");

// Fixed peak window (deepseek-official definition; times are UTC, all days).
const FIXED_PEAK = {
  peak: [
    { days: [], start: "01:00", end: "04:00" },
    { days: [], start: "06:00", end: "10:00" },
  ],
};

// Display name -> canonical id is derived automatically by `slug()` (verified
// byte-identical to the previous hand-maintained table for every known row), so
// there is no manual name map to keep in sync.

export function slug(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Returns { id, baseName, variant, tierK? } or null to drop.
export function normalize(rawName) {
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
      const baseId = slug(n);
      const k = parseFloat(tier[2]) * 1000;
      const isHigh = />|≥|>=/.test(tier[1]);
      return { id: baseId, baseName: n, variant: isHigh ? "tier-high" : "tier-low", tierK: k };
    } else if (/\(/.test(n)) {
      // multi-language promo, e.g. (2x usage till Jul 24) -> strip
      n = n.replace(/\s*\([^)]*\)\s*$/, "").trim();
    }
  }

  const baseId = slug(n);
  return { id: baseId, baseName: n, variant };
}

export function parsePrice(field) {
  if (field == null) return 0;
  const v = String(field).replace(/\$/g, "").trim();
  if (v === "" || v === "-") return 0;
  const num = parseFloat(v);
  return Number.isFinite(num) ? num : 0;
}

export function toISO(mmddyyyy, hhmmss) {
  const [mo, da, yr] = mmddyyyy.split("/");
  return `${yr}-${mo.padStart(2, "0")}-${da.padStart(2, "0")}T${hhmmss}.000Z`;
}

// Build a rates timeline per id.
export function buildRates(list, withdrawnDates = []) {
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
              low: { ...variants.tierLow.prices },
              high: { ...variants.tierHigh.prices },
            },
          },
        },
      });
    } else if (variants.peak && variants.offpeak) {
      rates.push({
        from,
        windows: FIXED_PEAK,
        pricing: { peak: { ...variants.peak }, offpeak: { ...variants.offpeak } },
      });
    } else {
      const p = variants.flat || variants.peak || variants.offpeak;
      rates.push({ from, pricing: { flat: { ...p } } });
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
  // Close the version in force when the listing was withdrawn, so a delisted
  // model stops being priced at the withdrawal date instead of forever.
  for (const R of withdrawnDates) {
    for (let i = 0; i < deduped.length; i++) {
      const start = deduped[i].from;
      const nextStart = i + 1 < deduped.length ? deduped[i + 1].from : null;
      if ((start == null || start <= R) && (nextStart == null || R < nextStart)) {
        if (!deduped[i].until) deduped[i].until = R;
        break;
      }
    }
  }
  return deduped;
}

export function buildPreset(crawlText, existingPreset) {
  const lines = String(crawlText).split("\n");
  const obs = {}; // id -> [{ date, variant, prices:{input,output,cacheRead,cacheWrite}, k }]
  const removals = {}; // id -> [date] the model was withdrawn (a "-" row with no "+" that day)
  let curDate = null;
  let curPlus = new Set();
  let curMinus = new Set();

  // A "-" row is the OLD value: when the same model also has a "+" row that day
  // it is a price change, not a withdrawal.
  function flushCommit() {
    if (curDate) {
      for (const id of curMinus) if (!curPlus.has(id)) (removals[id] ||= []).push(curDate);
    }
    curPlus = new Set();
    curMinus = new Set();
  }

  for (const l of lines) {
    const h = l.match(/^=== \S+\s+(\d{1,2}\/\d{1,2}\/\d{4})\s+(\d{1,2}:\d{2}:\d{2}) /);
    if (h) {
      flushCommit();
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
    const sign = l[0];
    if (sign === "-") {
      curMinus.add(norm.id);
      continue;
    }
    curPlus.add(norm.id);
    const prices = {
      input: parsePrice(parts[2]),
      output: parsePrice(parts[3]),
      cacheRead: parsePrice(parts[4]),
      cacheWrite: parsePrice(parts[5]), // published cache-write column
    };
    (obs[norm.id] ||= []).push({ date: curDate, variant: norm.variant, prices, k: norm.tierK });
  }
  flushCommit();

  const targets = {};
  const modelMap = {};
  for (const [id, list] of Object.entries(obs)) {
    // Only a withdrawal that follows the model's last listing is terminal (the
    // model was delisted for good). A "-" that precedes a later "+" is a
    // temporary gap / rename and must not truncate the live timeline.
    const lastSeen = list.reduce((m, o) => (o.date > m ? o.date : m), "");
    const terminal = (removals[id] || []).filter((R) => R > lastSeen);
    const rates = buildRates(list, terminal);
    if (rates.length === 0) continue;
    const key = `opencode:${id}`;
    targets[key] = { label: id, scope: "opencode", rates };
    modelMap[key] = key;
  }

  // Merge: keep existing entries for ids the crawl did not cover (e.g. free variants).
  if (existingPreset) {
    for (const [k, t] of Object.entries(existingPreset.targets || {})) {
      if (/-over-\d/.test(k)) continue; // superseded by the `tier` block in the crawl build
      if (!targets[k]) targets[k] = t;
    }
    for (const [k, v] of Object.entries(existingPreset.modelMap || {})) {
      if (/-over-\d/.test(k)) continue;
      if (!modelMap[k]) modelMap[k] = v;
    }
  }

  return { presetVersion: 2, source: "opencode", modelMap, targets };
}

// CLI entrypoint: only runs when invoked directly, so importing the module has
// no side effects. Reading the crawl and all process.exit paths live here.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const crawlText = readFileSync(CLEAN, "utf8");
  const existingPreset = existsSync(PRESET) ? JSON.parse(readFileSync(PRESET, "utf8")) : undefined;
  const preset = buildPreset(crawlText, existingPreset);
  // Crawl-only build (no merge) so the log reports how many models the crawl
  // itself produced, not including entries carried over from the preset file.
  const crawlDerived = Object.keys(buildPreset(crawlText).targets).length;
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

  console.log(`models=${Object.keys(preset.targets).length} (crawl-derived=${crawlDerived}) valid=${check.ok}`);
  if (process.argv.includes("--check")) {
    const current = existsSync(PRESET) ? readFileSync(PRESET, "utf8") : "";
    if (current !== out) {
      console.error("ERR: extension/vendors/opencode/rates.preset.json is out of date — re-run the builder.");
      process.exitCode = 1;
    } else {
      console.log("opencode preset in sync");
    }
  } else if (process.argv.includes("--write")) {
    writeFileSync(PRESET, out);
    console.log(`wrote ${PRESET}`);
  } else {
    console.log("dry-run (pass --write to persist)");
  }
}
