import { test } from "node:test";
import assert from "node:assert/strict";

import { mapChartBucket, mapChartBuckets, bucketToISO } from "../../extension/vendors/commandcode/mapper.js";

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
