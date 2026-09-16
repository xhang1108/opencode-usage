import { test } from "node:test";
import assert from "node:assert/strict";

import { buildPricing, validatePreset } from "../../extension/shared/preset.js";

const OPENCODE = {
  source: "opencode",
  modelMap: { "opencode:deepseek-v4.1-flash": "opencode:deepseek-v4.1-flash" },
  targets: {
    "opencode:deepseek-v4.1-flash": {
      label: "deepseek-v4.1-flash",
      rates: [{ from: null, pricing: { flat: { input: 0.15 } } }],
    },
  },
};

test("buildPricing merges presets (later presets win per target)", () => {
  const other = {
    source: "opencode",
    modelMap: { "opencode:other": "opencode:other" },
    targets: { "opencode:other": { rates: [{ from: null, pricing: { flat: { input: 9 } } }] } },
  };
  const pricing = buildPricing({ presets: [OPENCODE, other] });
  assert.equal(pricing.modelMap["opencode:deepseek-v4.1-flash"], "opencode:deepseek-v4.1-flash");
  assert.equal(pricing.modelMap["opencode:other"], "opencode:other");
  assert.deepEqual(pricing.targets["opencode:deepseek-v4.1-flash"].rates[0].pricing.flat, { input: 0.15 });
});

test("buildPricing handles empty input", () => {
  const pricing = buildPricing();
  assert.deepEqual(pricing.modelMap, {});
  assert.deepEqual(pricing.targets, {});
});

test("validatePreset accepts a well-formed preset", () => {
  assert.equal(validatePreset(OPENCODE).ok, true);
});

test("validatePreset flags missing source, bad maps and rate-less targets", () => {
  assert.equal(validatePreset({ targets: {} }).errors.includes("missing:source"), true);
  assert.equal(validatePreset({ source: "x", modelMap: [] }).errors.includes("bad:modelMap"), true);
  const noRates = validatePreset({ source: "x", targets: { t: { label: "t" } } });
  assert.equal(noRates.ok, false);
  assert.equal(noRates.errors.includes("no-rates:t"), true);
});

test("validatePreset runs the rate-table rules (top-level tier is rejected)", () => {
  const bad = {
    source: "x",
    targets: { t: { rates: [{ from: null, pricing: { tier: { limit: 1000, low: {}, high: {} } } }] } },
  };
  const res = validatePreset(bad);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => /missing the flat price table/.test(e)));
});
