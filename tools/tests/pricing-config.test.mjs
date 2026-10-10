import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  withDefaultSource,
  priceWithConfig,
  legacyModelsFromPricing,
  makeTargetId,
  shouldPassthroughVendorCost,
  priceVendorCost,
} from "../../extension/dashboard/core/pricing-config.js";
import { buildPricing } from "../../extension/shared/preset.js";
import { resolveTargetId, priceFromRates } from "../../extension/shared/pricing.js";

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

test("priceWithConfig prices a legacy (source-less) record from its vendor cost", () => {
  const priced = priceWithConfig({ model: "m1", time: "2026-09-01T00:00:00Z", input: 1000000, vendorCost: 0.1, costScale: 1 }, PRICING);
  assert.equal(priced.unpriced, false);
  assert.equal(priced.cost, 0.1);
  assert.equal(priced.priceBasis, "vendor-reported");
});

test("priceWithConfig bills the vendor-reported spend, never an estimate", () => {
  const rec = { source: "openrouter", model: "stealth/ox-alpha", time: "2026-08-24T00:00:00Z", input: 109, vendorCost: 0.035588 };
  const out = priceWithConfig(rec, PRICING);
  assert.equal(out.cost, 0.035588);
  assert.equal(out.priceBasis, "vendor-reported");
  assert.equal(out.unpriced, false);
  // No vendor amount -> 0, not a token-rate estimate.
  const noCost = { ...rec, vendorCost: undefined };
  const zero = priceWithConfig(noCost, PRICING);
  assert.equal(zero.cost, 0);
  assert.equal(zero.priceBasis, "no-cost");
  assert.equal(zero.unpriced, true);
});

test("priceWithConfig bills 0 for a record with no vendor cost", () => {
  const priced = priceWithConfig({ model: "nope", time: "2026-09-01T00:00:00Z", input: 10 }, PRICING);
  assert.equal(priced.unpriced, true);
  assert.equal(priced.cost, 0);
  assert.equal(priced.priceBasis, "no-cost");
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
  // The preset still carries rates (the unified builder reads it), even though
  // the runtime no longer prices records from it — resolve the target, price its rates.
  const pricing = buildPricing({ presets: [preset] });
  const targetId = resolveTargetId({ source: "opencode", model: "deepseek-v4.1-flash" }, pricing.modelMap);
  assert.equal(targetId, "opencode:deepseek-v4.1-flash");
  const priced = priceFromRates({ time: "2026-09-11T02:00:00Z", input: 1000000 }, pricing.targets[targetId].rates, "vendor");
  assert.equal(priced.unpriced, false);
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

test("priceWithConfig bills 0 when vendorCost is missing (no rate-table estimate)", () => {
  const pricing = { modelMap: { "opencode:m1": "t1" }, targets: { t1: { rates: [VENDOR_RATE] } } };
  // opencode server sends `cost: null` on many records; there is nothing to
  // price with, and we no longer estimate from the rate table -> 0.
  const rec = { source: "opencode", model: "m1", time: "2026-09-01T00:00:00Z", input: 1000000 };
  const out = priceWithConfig(rec, pricing);
  assert.equal(out.cost, 0);
  assert.equal(out.priceBasis, "no-cost");
  assert.equal(out.unpriced, true);
});

const PEAK_RATE = {
  from: null,
  windows: { peak: [{ days: [], start: "01:00", end: "04:00" }] },
  pricing: { peak: { input: 1, output: 2 }, offpeak: { input: 0.5, output: 1 } },
};
const PRICING_PEAK = {
  modelMap: { "opencode:peakm": "opencode:peakm" },
  targets: { "opencode:peakm": { label: "PeakM", rates: [PEAK_RATE] } },
};

test("priceWithConfig labels a vendor-cost record's window by its timestamp without changing cost", () => {
  const base = { source: "opencode", model: "peakm", input: 1, vendorCost: 12345678, costScale: 1e8 };
  const peak = priceWithConfig({ ...base, time: "2026-09-01T02:00:00Z" }, PRICING_PEAK, { opencode: "vendor" });
  const off = priceWithConfig({ ...base, time: "2026-09-01T12:00:00Z" }, PRICING_PEAK, { opencode: "vendor" });
  assert.equal(peak.window, "peak");
  assert.equal(off.window, "offpeak");
  assert.equal(peak.cost, 12345678 / 1e8);
  assert.equal(off.cost, peak.cost); // the window never changes the vendor price
  assert.equal(peak.priceBasis, "vendor-reported");
  // A model with no peak windows stays flat.
  const flat = priceWithConfig({ source: "opencode", model: "m1", time: "2026-09-01T02:00:00Z", input: 1, vendorCost: 5, costScale: 1 }, PRICING, { opencode: "vendor" });
  assert.equal(flat.window, "flat");
  // A model absent from the price map stays flat too.
  const unknown = priceWithConfig({ source: "opencode", model: "nope", time: "2026-09-01T02:00:00Z", input: 1, vendorCost: 5, costScale: 1 }, PRICING_PEAK, { opencode: "vendor" });
  assert.equal(unknown.window, "flat");
});

test("shouldPassthroughVendorCost flags unifiedPassthrough sources with a vendor amount", () => {
  const groq = { source: "groq-official", model: "whisper-large-v3", time: "2026-09-12T00:00:00Z", vendorCost: 0.05 };
  assert.equal(shouldPassthroughVendorCost(groq, { "groq-official": true }), true);
  assert.equal(shouldPassthroughVendorCost(groq, {}), false);
  assert.equal(shouldPassthroughVendorCost({ ...groq, vendorCost: undefined }, { "groq-official": true }), false);
  assert.equal(shouldPassthroughVendorCost({ source: "opencode", model: "m", vendorCost: 1 }, { "groq-official": true }), false);
  // priceVendorCost is the unified-off vendor path, reused verbatim.
  const out = priceVendorCost(groq, PRICING);
  assert.equal(out.cost, 0.05);
  assert.equal(out.priceBasis, "vendor-reported");
  assert.equal(out.unpriced, false);
});
