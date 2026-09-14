#!/usr/bin/env node
// tools/price-watch.mjs — fetch vendor prices, snapshot on change, rebuild presets.
// Long-term history lives in committed price-snapshots/ (git); run daily via
// .github/workflows/price-watch.yml.
//
// Usage: node tools/price-watch.mjs [--source deepseek-official]

import { VENDORS, loadParser, listSnapshots, modelsKey, loadSnapshots, writeSnapshot, rebuildPreset } from "./price-watch-lib.mjs";

async function watchOne(source, cfg) {
  const parser = await loadParser(cfg);
  let snapshot;
  if (cfg.bundleSource) {
    const shell = await (await fetch(cfg.page)).text();
    const rel = parser.extractBundleUrl(shell);
    if (!rel) throw new Error(`${source}: bundle URL not found`);
    const bundle = await (await fetch(new URL(rel, cfg.page).toString())).text();
    snapshot = parser.snapshotFromBundle(bundle, new Date().toISOString(), { source });
  } else {
    const res = await fetch(cfg.url);
    if (!res.ok) throw new Error(`${source}: fetch failed ${res.status}`);
    snapshot = parser.snapshotFromPage(await res.text(), new Date().toISOString(), { source });
  }

  const files = listSnapshots(cfg);
  let wrote = false;
  if (files.length === 0) {
    writeSnapshot(cfg, snapshot);
    wrote = true;
  } else {
    const latest = loadSnapshots(cfg).slice(-1)[0];
    if (modelsKey(latest) !== modelsKey(snapshot)) {
      writeSnapshot(cfg, snapshot);
      wrote = true;
    }
  }
  const out = await rebuildPreset(source, cfg);
  return { ...out, wrote };
}

const i = process.argv.indexOf("--source");
const sources = i !== -1 ? [process.argv[i + 1]] : Object.keys(VENDORS);
for (const source of sources) {
  const cfg = VENDORS[source];
  if (!cfg) {
    console.error(`Unknown source: ${source}`);
    process.exit(1);
  }
  const out = await watchOne(source, cfg);
  console.log(`${out.source}: ${out.wrote ? "wrote new snapshot" : "no change"} | snapshots=${out.snapshots} targets=${out.targets} modelMap=${out.modelMap}`);
}
