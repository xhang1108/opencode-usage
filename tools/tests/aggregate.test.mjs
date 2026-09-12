import { test } from "node:test";
import assert from "node:assert/strict";

import { aggregate, listWorkspaces, listModels } from "../../extension/dashboard/core/aggregate.js";
import { toISODate } from "../../extension/dashboard/core/time.js";

// Stub pricer: $1 per 1M input tokens, flat window, "unmapped" model unpriced.
const price = (rec) => ({
  cost: (rec.input || 0) / 1000000,
  savings: 0,
  window: "flat",
  unpriced: rec.model === "unmapped",
});

function at(y, m, d, hh, mm) {
  return new Date(y, m - 1, d, hh, mm).toISOString();
}

const DAY1 = toISODate(new Date(2026, 8, 12, 12, 0));
const DAY2 = toISODate(new Date(2026, 8, 13, 12, 0));

const records = [
  { id: "a", time: at(2026, 9, 12, 10, 30), model: "m1", workspaceID: "w1", input: 1000 },
  { id: "b", time: at(2026, 9, 12, 22, 0), model: "m1", workspaceID: "w1", input: 2000 },
  { id: "c", time: at(2026, 9, 13, 9, 0), model: "m2", workspaceID: "w2", input: 500, output: 100 },
];

test("aggregate totals and local-day buckets", () => {
  const a = aggregate(records, { price });
  assert.equal(a.totals.req, 3);
  assert.equal(a.totals.tokens, 3600);
  assert.equal(a.dailyTokenMap[DAY1], 3000);
  assert.equal(a.dailyTokenMap[DAY2], 600);
  assert.equal(a.modelMap.m1.req, 2);
  assert.equal(a.topModel, "m1");
  assert.equal(a.minDate, DAY1);
  assert.equal(a.maxDate, DAY2);
});

test("aggregate pre-aggregates workspaces before model/ws filters", () => {
  const a = aggregate(records, { price, selectedModel: "m1" });
  assert.equal(a.filtered.length, 2);
  assert.equal(a.totals.req, 2);
  assert.equal(a.wsMap.w1.req, 2);
  assert.equal(a.wsMap.w2.req, 1); // still counted in the workspace rollup
});

test("aggregate buckets hourly minutes in local time", () => {
  const a = aggregate(records, { price });
  const mins = Object.keys(a.hourlyMap[DAY1] || {}).map(Number).sort((x, y) => x - y);
  assert.deepEqual(mins, [10 * 60 + 30, 22 * 60]);
  assert.equal(a.hourlyMap[DAY1][10 * 60 + 30].tokens, 1000);
});

test("aggregate date range filters by local date", () => {
  const a = aggregate(records, { price, startDate: DAY2, endDate: DAY2 });
  assert.equal(a.totals.req, 1);
  assert.equal(a.filtered[0].id, "c");
});

test("aggregate reports unpriced models only among filtered records", () => {
  const recs = records.concat([{ id: "u", time: at(2026, 9, 12, 12, 0), model: "unmapped", workspaceID: "w1", input: 10 }]);
  const all = aggregate(recs, { price });
  assert.deepEqual(all.unpricedModels, ["unmapped"]);
  const onlyM1 = aggregate(recs, { price, selectedModel: "m1" });
  assert.deepEqual(onlyM1.unpricedModels, []);
});

test("listWorkspaces and listModels are sorted and de-duplicated", () => {
  assert.deepEqual(listWorkspaces(records), ["w1", "w2"]);
  assert.deepEqual(listModels(records), ["m1", "m2"]);
});
