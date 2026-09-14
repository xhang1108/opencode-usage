import { test } from "node:test";
import assert from "node:assert/strict";

import { mapUsage, mapUsages, mapChartBucket, mapChartBuckets, bucketToISO } from "../../extension/vendors/commandcode/mapper.js";

// Off-peak deepseek-v4.1-flash rates (USD / 1M), from the verified sample.
const RATES = { input: 0.15, output: 0.6, cacheRead: 0.003 };

// 900 tokensIn = 600 input (0.00009) + 300 cacheRead (0.0000009); 500 out (0.0003).
const USAGE = {
  id: "u_1",
  createdAt: "2026-09-11T12:00:00.000Z",
  meta: {
    model: "deepseek/deepseek-v4.1-flash",
    tokensIn: "900",
    tokensOut: "500",
    inputCost: 0.00009,
    outputCost: 0.0003,
    cacheCost: 0.0000009,
  },
  status: "completed",
  type: "api",
  mode: "api",
};

test("mapUsage reverse-derives input/cacheRead when the guard passes (D16)", () => {
  const rec = mapUsage(USAGE, { ratesFor: () => RATES });
  assert.equal(rec.source, "commandcode");
  assert.equal(rec.model, "deepseek/deepseek-v4.1-flash");
  assert.equal(rec.time, "2026-09-11T12:00:00.000Z");
  assert.equal(rec.input, 600);
  assert.equal(rec.cacheRead, 300);
  assert.equal(rec.output, 500);
  assert.equal(rec.reasoning, 0);
  assert.equal(rec.cacheWrite5m, 0);
  assert.equal(rec.requests, 1);
  assert.equal(rec.cacheBasis, "derived");
  assert.equal(rec.id, "commandcode:u_1");
  assert.ok(Math.abs(rec.vendorCost - (0.00009 + 0.0003 + 0.0000009)) < 1e-12);
});

test("mapUsage falls back to input=tokensIn when no rates are available", () => {
  const rec = mapUsage(USAGE, { ratesFor: () => null });
  assert.equal(rec.input, 900);
  assert.equal(rec.cacheRead, 0);
  assert.equal(rec.cacheBasis, "unknown");
  assert.equal(rec.output, 500);
});

test("mapUsage falls back when the guard fails (mismatched output cost)", () => {
  const bad = { ...USAGE, meta: { ...USAGE.meta, outputCost: 9.99 } };
  const rec = mapUsage(bad, { ratesFor: () => RATES });
  assert.equal(rec.cacheBasis, "unknown");
  assert.equal(rec.input, 900);
  assert.equal(rec.cacheRead, 0);
});

test("mapUsage coerces string tokens and rejects rows without model/time", () => {
  assert.equal(mapUsage({ meta: { tokensIn: "5" } }), null);
  assert.equal(mapUsage({ createdAt: "2026-09-11T00:00:00Z" }), null);
  const rec = mapUsage({ ...USAGE, meta: { ...USAGE.meta, tokensIn: 0, tokensOut: 0 } });
  assert.equal(rec.input, 0);
});

test("mapUsages drops invalid rows and keeps stable ids", () => {
  const rows = [USAGE, { meta: {} }];
  const recs = mapUsages(rows, { ratesFor: () => RATES });
  assert.equal(recs.length, 1);
  assert.equal(mapUsages([USAGE]).length, 1);
});

// /internal/usage/charts sample (day x model x provider aggregate).
const BUCKET = {
  model: "deepseek/deepseek-v4.1-flash",
  provider: "vercel-ai-gateway",
  timeBucket: "2026-09-13 06:45:00",
  requests: 3,
  totalCost: 0.006867804,
  tokensIn: 1841526,
  tokensOut: 1269,
  cacheReadInputTokens: 1837568,
  cacheCreationInputTokens: 0,
};

test("bucketToISO converts naive buckets to UTC ISO", () => {
  assert.equal(bucketToISO("2026-09-13 06:45:00"), "2026-09-13T06:45:00Z");
  assert.equal(bucketToISO("2026-09-13 00:00"), "2026-09-13T00:00:00Z");
  assert.equal(bucketToISO("nope"), null);
});

test("mapChartBucket maps the aggregated charts row without reverse-deriving", () => {
  const rec = mapChartBucket(BUCKET);
  assert.equal(rec.source, "commandcode");
  assert.equal(rec.model, "deepseek/deepseek-v4.1-flash");
  assert.equal(rec.provider, "vercel-ai-gateway");
  assert.equal(rec.time, "2026-09-13T06:45:00.000Z");
  assert.equal(rec.input, 1841526 - 1837568);
  assert.equal(rec.cacheRead, 1837568);
  assert.equal(rec.cacheWrite5m, 0);
  assert.equal(rec.output, 1269);
  assert.equal(rec.requests, 3);
  assert.ok(Math.abs(rec.vendorCost - 0.006867804) < 1e-12);
  assert.equal(rec.cacheBasis, "vendor");
  assert.match(rec.id, /^commandcode:deepseek\/deepseek-v4\.1-flash:vercel-ai-gateway:2026-09-13T06:45:00$/);
});

test("mapChartBucket handles cache creation tokens and rejects bad rows", () => {
  const rec = mapChartBucket({ ...BUCKET, cacheCreationInputTokens: 500, cacheReadInputTokens: 0, tokensIn: 1000 });
  assert.equal(rec.cacheWrite5m, 500);
  assert.equal(rec.cacheRead, 0);
  assert.equal(rec.input, 1000);
  assert.equal(mapChartBucket({ model: "m" }), null);
  assert.equal(mapChartBuckets([BUCKET, null]).length, 1);
});
