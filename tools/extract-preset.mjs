#!/usr/bin/env node
// tools/extract-preset.mjs — build the shipped preset from the authored rates
// source. Reads vendors/<source>/rates.source.json (models + rate version
// chains) and emits vendors/<source>/rates.preset.json with readable,
// source-scoped target ids: "<source>:<slug>" (e.g.
// "opencode:deepseek-v4.1-flash").
//
// Usage: node tools/extract-preset.mjs [--source opencode]
//
// Hand-maintained vendors only. The parser-backed official vendors (those wired
// in tools/price-watch-lib.mjs VENDORS) have their rates.source.json GENERATED
// daily from their committed price snapshots, so editing one there is pointless
// - the next price-watch run overwrites it (and rebuildPreset() refuses to
// clobber a file it would not itself have produced).

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve, sep } from "node:path";

import { validatePreset } from "../extension/shared/preset.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const vendorsRoot = resolve(root, "extension/vendors");

// A source name is a directory under extension/vendors, never a path. Reject
// traversal (`../../x`) and separators before resolving anything.
export function safeSourceName(name) {
  const s = String(name || "");
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(s)) throw new Error(`invalid source name: ${s}`);
  const dir = resolve(vendorsRoot, s);
  if (dir !== vendorsRoot && !dir.startsWith(vendorsRoot + sep)) throw new Error(`source escapes vendors/: ${s}`);
  return s;
}

export async function extractPreset(sourceName) {
  const name = safeSourceName(sourceName || "opencode");
  const sourcePath = resolve(vendorsRoot, name, "rates.source.json");
  const outPath = resolve(vendorsRoot, name, "rates.preset.json");

  const { makeTargetId } = await import(pathToFileURL(resolve(root, "extension/dashboard/core/pricing-config.js")).href);

  const source = JSON.parse(readFileSync(sourcePath, "utf8"));
  const src = source.source || name;

  const modelMap = {};
  const targets = {};
  const used = {};
  // Free variants never cost anything; force a single zero rate so a mistaken
  // nonzero source entry can't price them (matches the vendor-reported 0).
  const zeroRate = () => ({ from: null, pricing: { flat: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } });
  for (const rule of source.models || []) {
    if (!rule || !rule.model || !Array.isArray(rule.rates) || rule.rates.length === 0) continue;
    const isFree = /-free$/.test(rule.model);
    const slug = makeTargetId(rule.label || rule.model, used);
    used[slug] = true;
    const targetId = `${src}:${slug}`;
    modelMap[`${src}:${rule.model}`] = targetId;
    targets[targetId] = {
      label: rule.label || rule.model,
      scope: src,
      rates: isFree ? [zeroRate()] : rule.rates,
    };
  }

  const preset = { presetVersion: 2, source: src, modelMap, targets };

  const check = validatePreset(preset);
  if (!check.ok) {
    throw new Error(`preset validation failed: ${check.errors.join(", ")}`);
  }

  writeFileSync(outPath, JSON.stringify(preset, null, 2) + "\n");
  return { outPath, targets: Object.keys(targets).length, modelMap: Object.keys(modelMap).length };
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const argIndex = process.argv.indexOf("--source");
  const sourceName = argIndex !== -1 ? process.argv[argIndex + 1] : "opencode";
  try {
    const out = await extractPreset(sourceName);
    console.log(`wrote ${out.outPath}`);
    console.log(`targets=${out.targets} modelMap=${out.modelMap}`);
  } catch (e) {
    console.error(String((e && e.message) || e));
    process.exit(1);
  }
}
