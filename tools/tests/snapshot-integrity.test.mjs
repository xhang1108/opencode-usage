// tools/tests/snapshot-integrity.test.mjs
// The rest of the suite never reads these committed, generated crawl artifacts,
// so a corrupt, stale, or partially-scraped file could pass CI unnoticed. This
// test reads every one of them:
//   extension/vendors/*/price-snapshots/*.json        per-change price crawl
//   extension/vendors/*/models.snapshot.json          per-change model list
//   extension/vendors/*/rates.preset.json / .source.json   rebuilt from snapshots
//
// It is read-only. rebuildPreset() writes rates.preset.json + rates.source.json,
// so the preset check mirrors its does-not-write steps in memory and diffs the
// result against what is committed instead of calling it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { VENDORS, loadSnapshots, snapshotFilename } from "../price-watch-lib.mjs";
import { versionsFromSnapshots, presetFromVersions } from "../../extension/shared/price-history.js";
import { validatePreset } from "../../extension/shared/preset.js";
import { validateRates } from "../../extension/shared/pricing.js";
import { makeTargetId } from "../../extension/dashboard/core/pricing-config.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const vendorsDir = resolve(root, "extension/vendors");

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const isIso = (s) => typeof s === "string" && !Number.isNaN(Date.parse(s));

// Discover snapshot dirs on disk (not just the VENDORS registry) so a newly
// added crawl source cannot silently escape the structural checks below.
function listSnapshotVendors() {
  return readdirSync(vendorsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(resolve(vendorsDir, e.name, "price-snapshots")))
    .map((e) => e.name)
    .sort();
}

function loadVendorSnapshots(vendor) {
  const dir = resolve(vendorsDir, vendor, "price-snapshots");
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  return files.map((file) => ({ file, snapshot: readJson(resolve(dir, file)) }));
}

test("committed price snapshots parse and are structurally complete", () => {
  const vendors = listSnapshotVendors();
  assert.ok(vendors.length > 0, "no price-snapshots directories found");

  let checked = 0;
  for (const vendor of vendors) {
    const snapshots = loadVendorSnapshots(vendor);
    assert.ok(snapshots.length > 0, `${vendor}: no snapshots committed`);
    for (const { file, snapshot } of snapshots) {
      const at = `${vendor}/${file}`;
      assert.ok(isIso(snapshot.capturedAt), `${at}: capturedAt is not an ISO timestamp`);
      // The filename is derived from capturedAt, so a mismatch means the file was
      // truncated or hand-edited.
      assert.equal(snapshotFilename(snapshot.capturedAt), file, `${at}: filename no longer matches capturedAt`);
      assert.equal(snapshot.source, vendor, `${at}: source field disagrees with its vendor directory`);
      assert.ok(
        snapshot.models && typeof snapshot.models === "object" && !Array.isArray(snapshot.models),
        `${at}: models must be an object keyed by id`,
      );
      const ids = Object.keys(snapshot.models);
      assert.ok(ids.length > 0, `${at}: empty model map (partial scrape)`);

      for (const id of ids) {
        assert.ok(id.length > 0, `${at}: empty model id`);
        const model = snapshot.models[id];
        assert.ok(model && typeof model === "object", `${at}: model ${id} is not an object`);
        assert.ok(typeof model.label === "string" && model.label.length > 0, `${at}: model ${id} missing label`);
        assert.ok(model.entry && typeof model.entry === "object", `${at}: model ${id} missing entry`);
        // Entries are stored without `from`; versionsFromSnapshots adds it. A
        // committed `from` would override the replay order and corrupt history.
        assert.ok(!("from" in model.entry), `${at}: model ${id} entry must not carry a from`);
        assert.deepEqual(
          validateRates([{ model: id, rates: [{ from: null, ...model.entry }] }]),
          [],
          `${at}: model ${id} has invalid rates`,
        );
      }
      checked++;
    }
  }
  assert.ok(checked > 0, "no price snapshots validated");
});

test("committed model snapshots list unique, non-empty ids", () => {
  const vendors = readdirSync(vendorsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(resolve(vendorsDir, e.name, "models.snapshot.json")))
    .map((e) => e.name)
    .sort();
  assert.ok(vendors.length > 0, "no models.snapshot.json files found");

  for (const vendor of vendors) {
    const snapshot = readJson(resolve(vendorsDir, vendor, "models.snapshot.json"));
    assert.ok(isIso(snapshot.capturedAt), `${vendor}: models.snapshot.json capturedAt is not ISO`);
    assert.ok(Array.isArray(snapshot.models), `${vendor}: models.snapshot.json models must be an array`);
    assert.ok(snapshot.models.length > 0, `${vendor}: empty model list (partial scrape)`);
    // Entries are bare ids (opencode) or { id, name } (commandcode).
    const ids = snapshot.models.map((m) => (typeof m === "string" ? m : m && m.id));
    for (const id of ids) {
      assert.ok(typeof id === "string" && id.length > 0, `${vendor}: invalid model id ${JSON.stringify(id)}`);
    }
    for (const [i, m] of snapshot.models.entries()) {
      if (typeof m === "string") continue;
      assert.ok(m && typeof m === "object", `${vendor}: invalid model entry ${JSON.stringify(m)}`);
      assert.equal(typeof m.name, "string", `${vendor}: ${ids[i]} name must be a string`);
    }
    // An array can carry duplicates, unlike a JSON object's keys.
    assert.equal(new Set(ids).size, ids.length, `${vendor}: duplicate model ids`);
  }
});

// Shrink mechanism: every model that disappears when a snapshot shrinks must be
// named in tools/snapshot-shrink-allowlist.json (vendor -> snapshot file ->
// dropped ids). Legit retirements are rare, so making each one an explicit,
// reviewed allowlist line is cheaper than a ratio bound: a bound is an arbitrary
// magic number that both flags real retirements and lets a large partial scrape
// (e.g. 40 models -> 30) through. Stale entries are rejected so the allowlist
// cannot rot into noise that masks a future scrape.
//
// Scope: price-snapshots only. Those are committed as one file per capture, so a
// shrink is comparable on disk. models.snapshot.json is a single overwritten
// state file with no history in a fresh checkout, so it cannot be compared here;
// its shrink guard lives at crawl time (tools/model-watch.mjs --allow-shrink),
// where the previous state is still readable.
const SHRINK_ALLOWLIST = readJson(resolve(root, "tools/snapshot-shrink-allowlist.json"));

test("price snapshots never shrink without an allowlisted retirement", () => {
  const used = new Set();
  for (const vendor of listSnapshotVendors()) {
    const ordered = loadVendorSnapshots(vendor).sort((a, b) =>
      String(a.snapshot.capturedAt).localeCompare(String(b.snapshot.capturedAt)),
    );
    let prev = null;
    for (const { file, snapshot } of ordered) {
      const ids = Object.keys(snapshot.models);
      if (prev && ids.length < prev.ids.length) {
        const dropped = prev.ids.filter((id) => !ids.includes(id)).sort();
        const allowed = (SHRINK_ALLOWLIST[vendor] || {})[file];
        const at = `${vendor}/${file}`;
        used.add(at);
        assert.ok(
          allowed,
          `${at}: model count dropped ${prev.ids.length} -> ${ids.length} but has no allowlist entry`,
        );
        assert.deepEqual(
          dropped,
          [...allowed].sort(),
          `${at}: dropped ids are not allowlisted (confirm the retirement in tools/snapshot-shrink-allowlist.json)`,
        );
      }
      prev = { file, ids };
    }
  }

  for (const [vendor, entries] of Object.entries(SHRINK_ALLOWLIST)) {
    for (const file of Object.keys(entries)) {
      assert.ok(used.has(`${vendor}/${file}`), `stale allowlist entry: ${vendor}/${file} no longer matches a shrink`);
    }
  }
});

// Recompute the preset/source pair from the committed snapshots without writing
// (rebuildPreset writes both files, so its steps are mirrored here).
function recomputeArtifacts(source, cfg) {
  const state = versionsFromSnapshots(loadSnapshots(cfg));
  const preset = presetFromVersions(state, { source });
  for (const [label, ids] of Object.entries(cfg.aliasTo || {})) {
    const target = preset.targets[`${source}:${label}`] ? `${source}:${label}` : null;
    if (!target) continue;
    for (const id of ids) preset.modelMap[`${source}:${id}`] = target;
  }
  const sourceDoc = {
    source,
    models: Object.keys(state)
      .sort()
      .map((id) => ({ model: id, label: state[id].label, rates: state[id].versions })),
  };
  return { preset, sourceDoc };
}

test("committed preset/source artifacts match the snapshots they were built from", () => {
  const vendors = listSnapshotVendors();
  assert.ok(vendors.length > 0, "no snapshot vendors found");
  for (const source of vendors) {
    const cfg = VENDORS[source];
    assert.ok(cfg, `${source} has price-snapshots but no VENDORS entry to rebuild from`);
    const { preset, sourceDoc } = recomputeArtifacts(source, cfg);
    assert.equal(validatePreset(preset).ok, true, `${source}: rebuilt preset is invalid`);
    assert.deepEqual(
      preset,
      readJson(resolve(vendorsDir, source, "rates.preset.json")),
      `${source}/rates.preset.json is stale relative to its snapshots`,
    );
    assert.deepEqual(
      sourceDoc,
      readJson(resolve(vendorsDir, source, "rates.source.json")),
      `${source}/rates.source.json is stale relative to its snapshots`,
    );
  }
});

// opencode's preset is built from tools/opencode/clean_diffs.txt, which is
// gitignored and absent in CI, so the direct builder check in preset-sync is
// skipped there. Close the gap read-only: validate the shipped preset and prove
// it still prices every model the committed builder input (rates.source.json)
// declares. tools/extract-preset.mjs writes on import, so its transform is
// mirrored rather than imported.
test("opencode preset is valid and keeps every committed source model priced", () => {
  const dir = resolve(vendorsDir, "opencode");
  const preset = readJson(resolve(dir, "rates.preset.json"));
  const check = validatePreset(preset);
  assert.equal(check.ok, true, `opencode/rates.preset.json invalid: ${check.errors.join(", ")}`);
  assert.equal(preset.source, "opencode");

  const source = readJson(resolve(dir, "rates.source.json"));
  const used = {};
  const expected = {}; // source model id -> target id it must resolve to
  for (const rule of source.models || []) {
    if (!rule || !rule.model || !Array.isArray(rule.rates) || rule.rates.length === 0) continue;
    const slug = makeTargetId(rule.label || rule.model, used);
    used[slug] = true;
    expected[rule.model] = `opencode:${slug}`;
  }
  assert.ok(Object.keys(expected).length > 0, "opencode/rates.source.json lists no models");

  for (const [model, targetId] of Object.entries(expected)) {
    assert.equal(
      preset.modelMap[`opencode:${model}`],
      targetId,
      `opencode:${model} maps to the wrong target`,
    );
    const target = preset.targets[targetId];
    assert.ok(target, `opencode:${model} resolves to missing target ${targetId}`);
    assert.ok(Array.isArray(target.rates) && target.rates.length > 0, `${targetId} has no rates`);
  }
});
