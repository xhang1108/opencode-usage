#!/usr/bin/env node
// tools/price-watch.mjs — fetch vendor prices, snapshot on change, rebuild presets.
// Long-term history lives in committed price-snapshots/ (git); run daily via
// .github/workflows/price-watch.yml.
//
// Safety:
//  * A parse whose model count drops below the committed snapshot is a suspected
//    partial scrape: it refuses to write until a human re-runs with
//    --allow-shrink (see assertNotSuspiciousShrink).
//  * Every source is attempted; a failing source leaves the run RED but never
//    blocks a healthy source's snapshot/preset from being written.
//
// rates.source.json is a GENERATED mirror of the snapshots for these
// parser-backed vendors (rebuildPreset writes it); the hand-authored
// tools/extract-preset.mjs flow is for hand-maintained vendors only.
//
// Usage: node tools/price-watch.mjs [--source deepseek-official] [--allow-shrink]

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  VENDORS,
  loadParser,
  listSnapshots,
  modelsKey,
  loadSnapshots,
  writeSnapshot,
  rebuildPreset,
  assertNotSuspiciousShrink,
} from "./price-watch-lib.mjs";

export async function watchOne(source, cfg, { allowShrink = false } = {}) {
  const parser = await loadParser(cfg);
  const res = await fetch(cfg.url);
  if (!res.ok) throw new Error(`${source}: fetch failed ${res.status}`);
  const snapshot = parser.snapshotFromPage(await res.text(), new Date().toISOString(), { source });

  const files = listSnapshots(cfg);
  let wrote = false;
  if (files.length === 0) {
    writeSnapshot(cfg, snapshot);
    wrote = true;
  } else {
    const latest = loadSnapshots(cfg).slice(-1)[0];
    assertNotSuspiciousShrink(latest, snapshot, { source, allowShrink });
    if (modelsKey(latest) !== modelsKey(snapshot)) {
      writeSnapshot(cfg, snapshot);
      wrote = true;
    }
  }
  const out = await rebuildPreset(source, cfg);
  return { ...out, wrote };
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const i = process.argv.indexOf("--source");
  const sources = i !== -1 ? [process.argv[i + 1]] : Object.keys(VENDORS);
  const allowShrink = process.argv.includes("--allow-shrink");
  const errors = [];
  for (const source of sources) {
    const cfg = VENDORS[source];
    if (!cfg) {
      console.error(`Unknown source: ${source}`);
      process.exit(1);
    }
    try {
      const out = await watchOne(source, cfg, { allowShrink });
      console.log(`${out.source}: ${out.wrote ? "wrote new snapshot" : "no change"} | snapshots=${out.snapshots} targets=${out.targets} modelMap=${out.modelMap}`);
    } catch (e) {
      const message = String((e && e.message) || e);
      errors.push({ source, message });
      console.error(`${source}: FAILED — ${message}`);
    }
  }
  if (errors.length) {
    console.error(`price-watch: ${errors.length} source(s) failed — see above`);
    process.exitCode = 1;
  }
}
