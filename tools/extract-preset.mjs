#!/usr/bin/env node
// tools/extract-preset.mjs — build the shipped preset from the authored rates
// source. Reads vendors/<source>/rates.source.json (models + rate version
// chains) and emits vendors/<source>/rates.preset.json with readable,
// source-scoped target ids: "<source>:<slug>" (e.g.
// "opencode:deepseek-v4.1-flash").
//
// Usage: node tools/extract-preset.mjs [--source opencode]

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

import { validatePreset } from "../extension/shared/preset.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const argIndex = process.argv.indexOf("--source");
const sourceName = argIndex !== -1 ? process.argv[argIndex + 1] : "opencode";
const sourcePath = resolve(root, `extension/vendors/${sourceName}/rates.source.json`);
const outPath = resolve(root, `extension/vendors/${sourceName}/rates.preset.json`);

const { makeTargetId } = await import(pathToFileURL(resolve(root, "extension/dashboard/core/pricing-config.js")).href);

const source = JSON.parse(readFileSync(sourcePath, "utf8"));
const src = source.source || sourceName;

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
  console.error("preset validation failed:", check.errors.join(", "));
  process.exit(1);
}

writeFileSync(outPath, JSON.stringify(preset, null, 2) + "\n");
console.log(`wrote ${outPath}`);
console.log(`targets=${Object.keys(targets).length} modelMap=${Object.keys(modelMap).length}`);
