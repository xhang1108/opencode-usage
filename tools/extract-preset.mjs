#!/usr/bin/env node
// tools/extract-preset.mjs — D15 migration helper.
// Reads the legacy DEFAULT_MODEL_RATES array from dashboard.js and emits the
// initial per-vendor preset (modelMap + targets) as ESM JSON. Model ids are
// kept exactly as the vendor/code has them (D18: never rewrite raw names);
// modelMap just categorizes "<source>:<raw>" -> targetId.
//
// Usage: node tools/extract-preset.mjs

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { validatePreset } from "../extension/shared/preset.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const dashboardPath = resolve(root, "extension/dashboard/dashboard.js");
const outPath = resolve(root, "extension/vendors/opencode/rates.preset.json");

const src = readFileSync(dashboardPath, "utf8");
const match = src.match(/const DEFAULT_MODEL_RATES = (\[[\s\S]*?\n\]);/);
if (!match) throw new Error("DEFAULT_MODEL_RATES not found in dashboard.js");

const rules = new Function(`return ${match[1]}`)();

const modelMap = {};
const targets = {};
for (const rule of rules) {
  if (!rule || !rule.model || !Array.isArray(rule.rates) || rule.rates.length === 0) continue;
  const targetId = rule.id || rule.model;
  modelMap[`opencode:${rule.model}`] = targetId;
  targets[targetId] = {
    label: rule.model,
    scope: "opencode",
    rates: rule.rates,
  };
}

const preset = { presetVersion: 1, source: "opencode", modelMap, targets };

const check = validatePreset(preset);
if (!check.ok) {
  console.error("preset validation failed:", check.errors.join(", "));
  process.exit(1);
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(preset, null, 2) + "\n");
console.log(`wrote ${outPath}`);
console.log(`targets=${Object.keys(targets).length} modelMap=${Object.keys(modelMap).length}`);
