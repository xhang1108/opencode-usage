import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  withDefaultSource,
  priceWithConfig,
  legacyModelsFromPricing,
  makeTargetId,
} from "../../extension/dashboard/core/pricing-config.js";
import { buildPricing } from "../../extension/shared/preset.js";

const VENDOR_RATE = { from: null, pricing: { flat: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 } } };

const PRICING = {
  modelMap: { "opencode:m1": "t1", "opencode:m1-alias": "t1" },
  targets: { t1: { label: "M1", rates: [VENDOR_RATE] } },
};

test("withDefaultSource defaults legacy records to opencode without mutating", () => {
  const rec = { model: "m1" };
  assert.equal(withDefaultSource(rec).source, "opencode");
  assert.equal(rec.source, undefined);
  assert.equal(withDefaultSource({ source: "openrouter" }).source, "openrouter");
});

test("priceWithConfig prices a legacy (source-less) record", () => {
  const priced = priceWithConfig({ model: "m1", time: "2026-09-01T00:00:00Z", input: 1000000 }, PRICING);
  assert.equal(priced.unpriced, false);
  assert.equal(priced.cost, 0.1);
  assert.equal(priced.priceBasis, "vendor");
});

test("priceWithConfig uses vendor-reported spend when the source opts in", () => {
  const rec = { source: "openrouter", model: "stealth/ox-alpha", time: "2026-08-24T00:00:00Z", input: 109, vendorCost: 0.035588 };
  const out = priceWithConfig(rec, PRICING, { openrouter: "vendor" });
  assert.equal(out.cost, 0.035588);
  assert.equal(out.priceBasis, "vendor-reported");
  assert.equal(out.unpriced, false);
  // Without the opt-in it falls back to token pricing (unmapped here).
  assert.equal(priceWithConfig(rec, PRICING, {}).priceBasis, "unmapped");
  // Vendor opt-in but no vendorCost -> falls back to token pricing.
  const noCost = { ...rec, vendorCost: undefined };
  assert.equal(priceWithConfig(noCost, PRICING, { openrouter: "vendor" }).priceBasis, "unmapped");
});

test("priceWithConfig marks unmapped models unpriced with zero cost", () => {
  const priced = priceWithConfig({ model: "nope", time: "2026-09-01T00:00:00Z", input: 10 }, PRICING);
  assert.equal(priced.unpriced, true);
  assert.equal(priced.cost, 0);
  assert.equal(priced.priceBasis, "unmapped");
});

test("legacyModelsFromPricing emits one rule per price target, named by label", () => {
  const rules = legacyModelsFromPricing(PRICING);
  assert.equal(rules.length, 1); // m1 and m1-alias share target t1
  assert.equal(rules[0].model, "M1");
  assert.deepEqual(rules[0].rates, [VENDOR_RATE]);
});

test("legacyModelsFromPricing falls back to the target id when there is no label", () => {
  const rules = legacyModelsFromPricing({ modelMap: { "opencode:m": "opencode:m" }, targets: { "opencode:m": { rates: [VENDOR_RATE] } } });
  assert.deepEqual(rules.map((r) => r.model), ["m"]);
  // A target with no rates is not a picker entry.
  assert.deepEqual(legacyModelsFromPricing({ modelMap: { "opencode:m": "opencode:m" }, targets: { "opencode:m": { rates: [] } } }), []);
});

test("makeTargetId slugifies and avoids collisions", () => {
  assert.equal(makeTargetId("DeepSeek V4.1 Flash"), "deepseek-v4.1-flash");
  assert.equal(makeTargetId("dup", { dup: {} }), "dup-2");
  assert.equal(makeTargetId(""), "target");
});

test("shipped opencode preset v2 uses readable source-scoped target ids", () => {
  const preset = JSON.parse(fs.readFileSync(new URL("../../extension/vendors/opencode/rates.preset.json", import.meta.url)));
  assert.equal(preset.presetVersion, 2);
  assert.ok(Object.keys(preset.targets).length > 0);
  for (const [key, id] of Object.entries(preset.modelMap)) {
    assert.ok(key.startsWith("opencode:"), `modelMap key ${key} not source-scoped`);
    assert.ok(id.startsWith("opencode:"), `target id ${id} not source-scoped`);
    assert.ok(!/^opencode:r\d+$/.test(id), `target id ${id} still opaque`);
    assert.ok(preset.targets[id], `modelMap points at missing target ${id}`);
  }
  // End-to-end: a legacy (source-less) record prices against the preset.
  const pricing = buildPricing({ presets: [preset] });
  const priced = priceWithConfig({ model: "deepseek-v4.1-flash", time: "2026-09-11T02:00:00Z", input: 1000000 }, pricing);
  assert.equal(priced.unpriced, false);
  assert.equal(priced.targetId, "opencode:deepseek-v4.1-flash");
  assert.equal(priced.window, "peak");
  assert.equal(priced.cost, 0.3);
});

test("priceWithConfig divides the raw vendor cost by costScale at compute time", () => {
  const pricing = { modelMap: {}, targets: {} };
  // Crawler now stores the raw USD×1e8 integer plus costScale; nothing is
  // divided at ingest.
  const raw = { source: "opencode", model: "deepseek-v4.1-flash", time: "2026-09-01T00:00:00Z", input: 1, vendorCost: 242499948, costScale: 1e8 };
  assert.equal(priceWithConfig(raw, pricing, { opencode: "vendor" }).cost, 2.42499948);
  // Local-DB imports are already USD (costScale 1).
  const usd = { source: "opencode", model: "deepseek-v4.1-flash", time: "2026-09-01T00:00:00Z", input: 1, vendorCost: 0.05, costScale: 1 };
  assert.equal(priceWithConfig(usd, pricing, { opencode: "vendor" }).cost, 0.05);
});

test("priceWithConfig falls back to token pricing when vendorCost is missing", () => {
  const pricing = { modelMap: { "opencode:m1": "t1" }, targets: { t1: { rates: [VENDOR_RATE] } } };
  // opencode server sends `cost: null` on many records; there is no amount to
  // use, so estimate from the rate table (NOT $0).
  const rec = { source: "opencode", model: "m1", time: "2026-09-01T00:00:00Z", input: 1000000 };
  const out = priceWithConfig(rec, pricing, { opencode: "vendor" });
  assert.equal(out.cost, 0.1);
  assert.equal(out.priceBasis, "vendor");
});
