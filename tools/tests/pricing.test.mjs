import { test } from "node:test";
import assert from "node:assert/strict";

import {
  getRateEntry,
  getWindow,
  computeCost,
  resolveTable,
  resolveTargetId,
  priceRecord,
  priceFromRates,
  effectiveTimeMs,
  isRetired,
  validateRates,
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

test("priceFromRates prices against an explicit rate list", () => {
  const record = { source: "commandcode", time: "2026-09-12T11:55:00Z", model: "m", input: 1000, output: 0, cacheRead: 0 };
  const res = priceFromRates(record, [{ from: null, pricing: { flat: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } } }], "unified");
  assert.equal(res.unpriced, false);
  assert.equal(res.priceBasis, "unified");
  assert.equal(res.cost, 0.001);
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

test("effectiveTimeMs falls back to the record date's UTC midnight", () => {
  assert.equal(effectiveTimeMs({ time: "2026-08-10T05:00:00Z" }), Date.parse("2026-08-10T05:00:00Z"));
  assert.equal(effectiveTimeMs({ date: "2026-07-14" }), Date.parse("2026-07-14T00:00:00.000Z"));
  assert.equal(effectiveTimeMs({ time: "", date: "2026-07-14" }), Date.parse("2026-07-14T00:00:00.000Z"));
  assert.ok(Number.isNaN(effectiveTimeMs({})));
});

// Regression: day-granular records without `time` used to fall back to the
// OLDEST rate version, pricing a years-old promo (DeepSeek flash cache-hit
// $0.028) instead of the current one ($0.0028) — a 10x overcharge.
test("a record with only `date` prices from that date's version, not the oldest", () => {
  const rates = [
    { from: null, pricing: { flat: { input: 0.14, output: 0.28, cacheRead: 0.028, cacheWrite: 0 } } },
    { from: "2026-04-26T00:00:00.000Z", pricing: { flat: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 } } },
  ];
  const record = { date: "2026-07-14", input: 0, output: 0, cacheRead: 1000000 };
  const res = priceFromRates(record, rates, "unified");
  assert.equal(res.unpriced, false);
  assert.equal(Number(res.cost.toFixed(6)), 0.0028);
});

test("a record with no usable time is unpriced, never billed at the oldest rate", () => {
  const rates = [{ from: null, pricing: { flat: { input: 0.14, output: 0.28, cacheRead: 0.028, cacheWrite: 0 } } }];
  const res = priceFromRates({ input: 1000 }, rates, "unified");
  assert.equal(res.unpriced, true);
  assert.equal(res.cost, 0);
});

// `until` is lifecycle metadata (a withdrawn model / a scheduled promo end). It
// must NOT change what historical records cost.
const RETIRED_RATES = [
  { from: null, pricing: { flat: { input: 0.14, output: 0.28, cacheRead: 0.014, cacheWrite: 0 } } },
  { from: "2025-09-29T00:00:00.000Z", until: "2026-04-24T00:00:00.000Z", pricing: { flat: { input: 0.28, output: 0.42, cacheRead: 0.028, cacheWrite: 0 } } },
];

test("isRetired is true only after the last version's until", () => {
  const rule = { model: "deepseek-chat", rates: RETIRED_RATES };
  assert.equal(isRetired(rule, Date.parse("2026-01-01T00:00:00Z")), false);
  assert.equal(isRetired(rule, Date.parse("2026-04-24T00:00:00Z")), true);
  assert.equal(isRetired(rule, Date.parse("2026-09-15T00:00:00Z")), true);
  // No `until` anywhere -> never retired (a flat model is not a retired model).
  assert.equal(isRetired({ model: "x", rates: [RETIRED_RATES[0]] }, Date.now()), false);
  assert.equal(isRetired({ model: "x", rates: [] }, Date.now()), false);
});

test("until does not move historical prices", () => {
  const rule = { rates: RETIRED_RATES };
  const rec = { date: "2026-02-01", output: 1000000 };
  const res = priceFromRates(rec, rule.rates, "unified");
  assert.equal(res.unpriced, false);
  assert.equal(res.cost, 0.42); // still the 2025-09-29 version, not unpriced
});

test("validateRates rejects a malformed or non-monotonic until", () => {
  assert.deepEqual(validateRates([{ model: "m", rates: RETIRED_RATES }]), []);
  assert.ok(
    validateRates([{ model: "m", rates: [{ from: null, until: "not-a-date", pricing: { flat: { input: 1, output: 1 } } }] }])
      .some((e) => /invalid until/.test(e))
  );
  assert.ok(
    validateRates([{ model: "m", rates: [{ from: "2026-01-01T00:00:00Z", until: "2025-01-01T00:00:00Z", pricing: { flat: { input: 1, output: 1 } } }] }])
      .some((e) => /must be after its from/.test(e))
  );
});

