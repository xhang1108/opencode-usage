import { test } from "node:test";
import assert from "node:assert/strict";

import { stringifyRates, parseRatesJson, validateRates } from "../../extension/dashboard/settings/rates-io.js";

const FLAT = { model: "m", rates: [{ from: null, pricing: { flat: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 } } }] };
const PEAK = {
  model: "p",
  rates: [
    {
      from: null,
      windows: { peak: [{ days: [1, 2, 3, 4, 5], start: "01:00", end: "04:00" }] },
      pricing: { peak: { input: 1 }, offpeak: { input: 2 } },
    },
  ],
};

test("stringifyRates produces a wrapped object incl. timezone", () => {
  const json = JSON.parse(stringifyRates([FLAT], 12));
  assert.equal(json.version, 12);
  assert.equal(json.timezone, "UTC");
  assert.equal(json.models.length, 1);
});

test("parseRatesJson accepts a bare array or {models}", () => {
  assert.equal(parseRatesJson(JSON.stringify([FLAT])).length, 1);
  assert.equal(parseRatesJson(JSON.stringify({ models: [FLAT] })).length, 1);
  assert.throws(() => parseRatesJson(""));
  assert.throws(() => parseRatesJson("{}"));
});

test("validateRates accepts flat and peak/offpeak configs", () => {
  assert.deepEqual(validateRates([FLAT, PEAK]), []);
});

test("validateRates flags duplicates, missing tables and bad windows", () => {
  const dup = { model: "m", rates: [{ from: null, pricing: { flat: { input: 1 } } }, { from: null, pricing: { flat: { input: 2 } } }] };
  assert.ok(validateRates([dup]).some((e) => /same effective-from/.test(e)));
  const missing = { model: "m", rates: [{ from: null, pricing: {} }] };
  assert.ok(validateRates([missing]).some((e) => /missing the flat price table/.test(e)));
  const badWindow = { model: "m", rates: [{ from: null, windows: { peak: [{ start: "25:00", end: "4:00" }] }, pricing: { peak: { input: 1 }, offpeak: { input: 2 } } }] };
  assert.ok(validateRates([badWindow]).some((e) => /not HH:MM|out of range/.test(e)));
  assert.ok(validateRates([{ rates: [] }]).some((e) => /missing a model name/.test(e)));
});
