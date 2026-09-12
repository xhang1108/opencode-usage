import { test } from "node:test";
import assert from "node:assert/strict";

import {
  getRateEntry,
  getWindow,
  computeCost,
  resolveTable,
  resolveTargetId,
  priceRecord,
} from "../../extension/shared/pricing.js";

const FLASH_TARGET = {
  label: "deepseek-v4.1-flash",
  rates: [
    {
      from: "2026-09-10T03:05:41Z",
      windows: { peak: [{ days: [1, 2, 3, 4, 5], start: "01:00", end: "04:00" }] },
      pricing: {
        peak: { input: 0.30, output: 1.20, cacheRead: 0.006, cacheWrite: 0 },
        offpeak: { input: 0.15, output: 0.60, cacheRead: 0.003, cacheWrite: 0 },
      },
    },
  ],
};

test("getRateEntry picks the version effective at record time", () => {
  const rule = {
    rates: [{ from: null, pricing: { flat: { input: 1 } } }, { from: "2026-09-10T03:05:41Z", pricing: { flat: { input: 2 } } }],
  };
  assert.equal(getRateEntry(rule, "2026-09-01T00:00:00Z").pricing.flat.input, 1);
  assert.equal(getRateEntry(rule, "2026-09-12T00:00:00Z").pricing.flat.input, 2);
});

test("getWindow is UTC and handles windows (P8)", () => {
  const entry = { windows: { peak: [{ start: "01:00", end: "04:00" }] } };
  assert.equal(getWindow({ time: "2026-09-12T02:00:00Z" }, entry), "peak");
  assert.equal(getWindow({ time: "2026-09-12T11:00:00Z" }, entry), "offpeak");
  assert.equal(getWindow({ time: "2026-09-12T11:00:00Z" }, {}), "flat");
});

test("computeCost matches the official CommandCode sample", () => {
  const { cost } = computeCost(
    { input: 184, cacheRead: 107264, output: 291 },
    { input: 0.15, output: 0.60, cacheRead: 0.003, cacheWrite: 0 }
  );
  assert.equal(Number(cost.toFixed(9)), 0.000523992);
});

test("computeCost bills reasoning at the output rate (D7)", () => {
  const table = { input: 1, output: 10, cacheRead: 0.1, cacheWrite: 0 };
  const withReasoning = computeCost({ output: 100, reasoning: 50 }, table);
  assert.equal(withReasoning.cost, ((100 + 50) * 10) / 1000000);
});

test("resolveTable applies tier by input + cacheRead context", () => {
  const entry = {
    pricing: {
      flat: {
        tier: { limit: 1000, low: { input: 1 }, high: { input: 2 } },
      },
    },
  };
  assert.equal(resolveTable(entry, "flat", 400, 400).input, 1);
  assert.equal(resolveTable(entry, "flat", 400, 700).input, 2);
});

test("resolveTargetId prefers provider-qualified keys (D5)", () => {
  const modelMap = {
    "commandcode:deepseek/deepseek-v4.1-flash": "t1",
    "commandcode:zhipu:deepseek/deepseek-v4.1-flash": "t2",
  };
  assert.equal(resolveTargetId({ source: "commandcode", model: "deepseek/deepseek-v4.1-flash" }, modelMap), "t1");
  assert.equal(
    resolveTargetId({ source: "commandcode", provider: "zhipu", model: "deepseek/deepseek-v4.1-flash" }, modelMap),
    "t2"
  );
  assert.equal(resolveTargetId({ source: "mimo", model: "x" }, modelMap), null);
});

test("priceRecord: offpeak sample, priceBasis=vendor when no curated", () => {
  const record = {
    source: "commandcode",
    time: "2026-09-12T11:55:00Z",
    model: "deepseek/deepseek-v4.1-flash",
    input: 184,
    cacheRead: 107264,
    output: 291,
  };
  const res = priceRecord(record, {
    modelMap: { "commandcode:deepseek/deepseek-v4.1-flash": "deepseek-v4.1-flash" },
    targets: { "deepseek-v4.1-flash": FLASH_TARGET },
  });
  assert.equal(res.unpriced, false);
  assert.equal(res.priceBasis, "vendor");
  assert.equal(res.window, "offpeak");
  assert.equal(Number(res.cost.toFixed(9)), 0.000523992);
});

test("priceRecord: curated wins by default, vendor on priceChoice", () => {
  const record = {
    source: "commandcode",
    time: "2026-09-12T11:55:00Z",
    model: "deepseek/deepseek-v4.1-flash",
    input: 1000,
    output: 0,
    cacheRead: 0,
  };
  const targets = {
    "deepseek-v4.1-flash": {
      ...FLASH_TARGET,
      curatedRates: [{ from: null, pricing: { flat: { input: 1 } } }],
    },
  };
  const modelMap = { "commandcode:deepseek/deepseek-v4.1-flash": "deepseek-v4.1-flash" };
  assert.equal(priceRecord(record, { modelMap, targets }).priceBasis, "curated");
  assert.equal(priceRecord(record, { modelMap, targets, priceChoice: { commandcode: "vendor" } }).priceBasis, "vendor");
});

test("priceRecord marks unmapped models unpriced (P5, in box)", () => {
  const res = priceRecord(
    { source: "mimo", time: "2026-09-12T00:00:00Z", model: "mimo-v2.5", input: 10 },
    { modelMap: {}, targets: {} }
  );
  assert.equal(res.unpriced, true);
  assert.equal(res.priceBasis, "unmapped");
  assert.equal(res.cost, 0);
});
