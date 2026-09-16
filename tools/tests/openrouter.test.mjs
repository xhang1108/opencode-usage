import { test } from "node:test";
import assert from "node:assert/strict";

import {
  granularityToISO,
  dateFieldOf,
  mapRow,
  mapRows,
  rowsFromResponse,
  metadataFromResponse,
  isTruncated,
} from "../../extension/vendors/openrouter/mapper.js";
import {
  buildQueryBody,
  sliceRange,
  OPENROUTER_METRICS,
  MAX_WINDOW_DAYS,
} from "../../extension/vendors/openrouter/analytics-query.js";

// Real captured rows (values are strings, as returned by the endpoint).
const ROW_DIM = {
  created_at__day: "2026-08-24",
  model: "stealth/ox-alpha",
  provider: "Stealth",
  total_usage: 0,
  request_count: "1",
  cache_hit_rate: 0,
  tokens_prompt: "109",
  tokens_completion: "50",
  reasoning_tokens: 0,
  cached_tokens: "0",
  byok_usage: 0,
  byok_request_count: "0",
};
const ROW_NODIM = { ...ROW_DIM, date__day: "2026-08-24", created_at__day: undefined };
delete ROW_NODIM.provider;
const ROW_HOUR = { ...ROW_DIM, created_at__hour: "2026-08-24 15:00:00", created_at__day: undefined };

test("granularityToISO handles day/hour/month naive values as UTC", () => {
  assert.equal(granularityToISO("2026-08-24"), "2026-08-24T00:00:00.000Z");
  assert.equal(granularityToISO("2026-08-24 15:00:00"), "2026-08-24T15:00:00Z");
  assert.equal(granularityToISO("2026-08-24T15:00:00"), "2026-08-24T15:00:00Z");
  assert.equal(granularityToISO("2026-08"), "2026-08-01T00:00:00.000Z");
  assert.equal(granularityToISO("nope"), null);
  assert.equal(granularityToISO(null), null);
});

test("dateFieldOf detects dimension vs no-dimension field names", () => {
  assert.equal(dateFieldOf(ROW_DIM), "created_at__day");
  assert.equal(dateFieldOf(ROW_NODIM), "date__day");
  assert.equal(dateFieldOf({ model: "m" }), null);
});

test("mapRow maps the endpoint row to canonical (P7/P8)", () => {
  const rec = mapRow(ROW_DIM);
  assert.equal(rec.source, "openrouter");
  assert.equal(rec.model, "stealth/ox-alpha");
  assert.equal(rec.provider, "Stealth");
  assert.equal(rec.input, 109);
  assert.equal(rec.output, 50);
  assert.equal(rec.reasoning, 0);
  assert.equal(rec.cacheRead, 0);
  assert.equal(rec.cacheWrite5m, 0);
  assert.equal(rec.cacheWrite1h, 0);
  assert.equal(rec.requests, 1);
  assert.equal(rec.time, "2026-08-24T00:00:00.000Z");
  assert.equal(rec.date, "2026-08-24");
  assert.equal(rec.v, 1);
  assert.match(rec.id, /^openrouter:[0-9a-f]{8}$/);
  assert.equal(rec.raw, ROW_DIM);
  // vendor money fields must not leak to the top level (P1/D16)
  assert.equal(rec.total_usage, undefined);
  assert.equal(rec.byok_usage, undefined);
});

test("mapRow carries vendor-reported spend as vendorCost", () => {
  assert.equal(mapRow(ROW_DIM).vendorCost, 0); // total_usage 0
  const paid = mapRow({ ...ROW_DIM, total_usage: "0.035588" });
  assert.equal(paid.vendorCost, 0.035588);
});

test("mapRow handles the no-dimension date__day variant", () => {
  const rec = mapRow(ROW_NODIM);
  assert.equal(rec.provider, undefined);
  assert.equal(rec.time, "2026-08-24T00:00:00.000Z");
  assert.equal(rec.input, 109);
});

test("mapRow handles hour granularity", () => {
  const rec = mapRow(ROW_HOUR);
  assert.equal(rec.time, "2026-08-24T15:00:00.000Z");
  assert.equal(rec.date, "2026-08-24");
});

test("mapRow subtracts cached tokens and never goes negative", () => {
  const rec = mapRow({ ...ROW_DIM, tokens_prompt: "100", cached_tokens: "150" });
  assert.equal(rec.input, 0);
  assert.equal(rec.cacheRead, 150);
});

// B4 token reconciliation: reasoning_tokens is a SUBSET of tokens_completion
// (OpenRouter docs + `tokens_total = tokens_prompt + tokens_completion`), so
// canonical output must exclude it or the additive dashboard total would count
// reasoning twice.
test("mapRow does not double count reasoning (total == tokens_total)", () => {
  const row = { ...ROW_DIM, tokens_prompt: "1000", cached_tokens: "400", tokens_completion: "500", reasoning_tokens: "200" };
  const rec = mapRow(row);
  assert.equal(rec.input, 600); // prompt - cached
  assert.equal(rec.cacheRead, 400);
  assert.equal(rec.output, 300); // completion - reasoning
  assert.equal(rec.reasoning, 200);
  const totalTokens = rec.input + rec.output + rec.reasoning + rec.cacheRead + rec.cacheWrite5m + rec.cacheWrite1h;
  assert.equal(totalTokens, Number(row.tokens_prompt) + Number(row.tokens_completion)); // tokens_total
});

test("mapRow clamps output when reasoning exceeds completion", () => {
  const rec = mapRow({ ...ROW_DIM, tokens_completion: "100", reasoning_tokens: "150" });
  assert.equal(rec.output, 0);
  assert.equal(rec.reasoning, 150);
});

test("mapRow is stable and rejects rows without model/date", () => {
  assert.equal(mapRow(ROW_DIM).id, mapRow(ROW_DIM).id);
  assert.notEqual(mapRow(ROW_DIM).id, mapRow({ ...ROW_DIM, model: "other" }).id);
  assert.equal(mapRow({ model: "m" }), null);
  assert.equal(mapRow({ created_at__day: "2026-08-24" }), null);
  assert.equal(mapRow(null), null);
});

test("mapRows drops unparseable rows", () => {
  const out = mapRows([ROW_DIM, { model: "x" }, ROW_NODIM]);
  assert.equal(out.length, 2);
  assert.ok(out.every((r) => r.source === "openrouter"));
});

test("response envelope helpers", () => {
  const json = { data: { data: [ROW_DIM], metadata: { row_count: 1, truncated: false } } };
  assert.equal(rowsFromResponse(json).length, 1);
  assert.deepEqual(metadataFromResponse(json), { row_count: 1, truncated: false });
  assert.equal(isTruncated(metadataFromResponse(json)), false);
  assert.equal(isTruncated({ truncated: true }), true);
  assert.equal(rowsFromResponse(null).length, 0);
  assert.equal(metadataFromResponse(null), null);
});

test("buildQueryBody carries the metrics and provider dimensions", () => {
  const body = buildQueryBody({ start: "2026-08-01T00:00:00.000Z", end: "2026-08-31T00:00:00.000Z" });
  assert.deepEqual(body.metrics, OPENROUTER_METRICS);
  assert.deepEqual(body.dimensions, ["model", "provider"]);
  assert.equal(body.granularity, "day");
  assert.equal(body.order_by.field, "date");
  assert.deepEqual(body.time_range, { start: "2026-08-01T00:00:00.000Z", end: "2026-08-31T00:00:00.000Z" });
  assert.notEqual(body.metrics, OPENROUTER_METRICS); // defensive copy
});

test("sliceRange covers a year in contiguous <=30-day windows", () => {
  const start = "2026-01-01T00:00:00.000Z";
  const end = "2026-04-01T00:00:00.000Z"; // 90 days
  const windows = sliceRange(start, end);
  assert.equal(windows.length, 3);
  assert.equal(windows[0].start, start);
  assert.equal(windows[windows.length - 1].end, end);
  for (let i = 0; i < windows.length; i++) {
    const days = (new Date(windows[i].end) - new Date(windows[i].start)) / 86400000;
    assert.ok(days <= MAX_WINDOW_DAYS, `window ${i} is ${days} days`);
    if (i > 0) assert.equal(windows[i].start, windows[i - 1].end); // contiguous, no gaps
  }
});

test("sliceRange handles partial last window and bad input", () => {
  const windows = sliceRange("2026-01-01T00:00:00.000Z", "2026-01-31T12:00:00.000Z");
  assert.equal(windows.length, 2);
  assert.equal(windows[1].end, "2026-01-31T12:00:00.000Z");
  assert.deepEqual(sliceRange("x", "y"), []);
  assert.deepEqual(sliceRange("2026-01-02T00:00:00.000Z", "2026-01-01T00:00:00.000Z"), []);
});
