import { test } from "node:test";
import assert from "node:assert/strict";

import { buildPricing, validatePreset } from "../../extension/shared/preset.js";

const OPENCODE = {
  source: "opencode",
  modelMap: { "opencode:deepseek-v4.1-flash": "deepseek-v4.1-flash" },
  targets: {
    "deepseek-v4.1-flash": { label: "deepseek-v4.1-flash", rates: [{ from: null, pricing: { flat: { input: 0.15 } } }] },
  },
};

test("buildPricing merges presets and lets userPricing win", () => {
  const pricing = buildPricing({
    presets: [OPENCODE],
    userPricing: { targets: { "deepseek-v4.1-flash": { curatedRates: [{ from: null, pricing: { flat: { input: 1 } } }] } } },
    priceChoice: { opencode: "curated" },
  });
  assert.equal(pricing.modelMap["opencode:deepseek-v4.1-flash"], "deepseek-v4.1-flash");
  assert.deepEqual(pricing.targets["deepseek-v4.1-flash"].curatedRates[0].pricing.flat, { input: 1 });
  // vendor rates survive the merge
  assert.deepEqual(pricing.targets["deepseek-v4.1-flash"].rates[0].pricing.flat, { input: 0.15 });
  assert.equal(pricing.priceChoice.opencode, "curated");
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
