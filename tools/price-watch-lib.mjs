// tools/price-watch-lib.mjs — shared helpers for price-watch + backfill.
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

import { validatePreset } from "../extension/shared/preset.js";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const VENDORS = {
  "deepseek-official": {
    url: "https://api-docs.deepseek.com/quick_start/pricing",
    dir: "extension/vendors/deepseek-official",
    parser: "extension/vendors/deepseek-official/pricing-page.js",
    // legacy / alias API model ids folded into the canonical target.
    aliasTo: {
      "deepseek-v4-flash": ["deepseek-flash", "deepseek-v4.1-flash", "deepseek-v4-flash-free", "deepseek-v4.1-flash-free", "deepseek-v4-flash-vision-exp", "deepseek-v4-flash-0731"],
      "deepseek-v4-pro": ["deepseek-v4-pro-free"],
    },
  },
  mimo: {
    page: "https://platform.xiaomimimo.com",
    dir: "extension/vendors/mimo",
    parser: "extension/vendors/mimo/pricing-page.js",
    bundleSource: true, // shell -> main bundle -> USD prices
    aliasTo: {
      "mimo-v2.5-pro": ["MiMo-V2.5-Pro", "MiMo-V2.5 Pro"],
      "mimo-v2.5": ["MiMo-V2.5"],
    },
  },
};

export function snapshotFilename(capturedAt) {
  return `${String(capturedAt).replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}.json`;
}

export function isoFromWayback(ts) {
  const s = String(ts);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}.000Z`;
}

export function modelsKey(snapshot) {
  return JSON.stringify(Object.entries(snapshot.models || {}).sort());
}

export function snapshotsDir(cfg) {
  const dir = resolve(ROOT, cfg.dir, "price-snapshots");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function listSnapshots(cfg) {
  return readdirSync(snapshotsDir(cfg))
    .filter((f) => f.endsWith(".json"))
    .sort();
}

export function loadParser(cfg) {
  return import(pathToFileURL(resolve(ROOT, cfg.parser)).href);
}

export function loadSnapshots(cfg) {
  return listSnapshots(cfg).map((f) => JSON.parse(readFileSync(resolve(snapshotsDir(cfg), f), "utf8")));
}

export function writeSnapshot(cfg, snapshot) {
  const name = snapshotFilename(snapshot.capturedAt);
  writeFileSync(resolve(snapshotsDir(cfg), name), JSON.stringify(snapshot, null, 2) + "\n");
  return name;
}

// Rebuild rates.preset.json + rates.source.json from every committed snapshot.
export async function rebuildPreset(source, cfg) {
  const { versionsFromSnapshots, presetFromVersions } = await import(pathToFileURL(resolve(ROOT, "extension/shared/price-history.js")).href);
  const state = versionsFromSnapshots(loadSnapshots(cfg));
  const preset = presetFromVersions(state, { source });

  for (const [label, ids] of Object.entries(cfg.aliasTo || {})) {
    const target = preset.targets[`${source}:${label}`] ? `${source}:${label}` : null;
    if (!target) continue;
    for (const id of ids) {
      const key = `${source}:${id}`;
      if (!preset.modelMap[key]) preset.modelMap[key] = target;
    }
  }

  const check = validatePreset(preset);
  if (!check.ok) throw new Error(`${source}: preset invalid: ${check.errors.join(", ")}`);

  writeFileSync(resolve(ROOT, cfg.dir, "rates.preset.json"), JSON.stringify(preset, null, 2) + "\n");
  const sourceModels = Object.keys(state)
    .sort()
    .map((id) => ({ model: id, label: state[id].label, rates: state[id].versions }));
  writeFileSync(resolve(ROOT, cfg.dir, "rates.source.json"), JSON.stringify({ source, models: sourceModels }, null, 2) + "\n");

  return { source, snapshots: listSnapshots(cfg).length, targets: Object.keys(preset.targets).length, modelMap: Object.keys(preset.modelMap).length };
}
