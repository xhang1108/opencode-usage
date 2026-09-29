import { test } from "node:test";
import assert from "node:assert/strict";

import { aggregate, createAggregator, computeUnpricedSet, listWorkspaces, listModels } from "../../extension/dashboard/core/aggregate.js";
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
  assert.equal(a.modelMap["opencode:m1"].req, 2);
  assert.equal(a.topModel, "m1");
  assert.equal(a.minDate, DAY1);
  assert.equal(a.maxDate, DAY2);
});

test("aggregate does not expose a filtered array", () => {
  const a = aggregate(records, { price });
  assert.equal(Object.prototype.hasOwnProperty.call(a, "filtered"), false);
});

test("aggregate pre-aggregates workspaces before model/ws filters", () => {
  const a = aggregate(records, { price, selectedModel: "m1" });
  assert.equal(a.totals.req, 2);
  assert.equal(a.wsMap["opencode:w1"].req, 2);
  assert.equal(a.wsMap["opencode:w2"].req, 1); // still counted in the workspace rollup
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
  assert.equal(a.modelMap["opencode:m2"].req, 1); // only record c (m2, DAY2) survived
  assert.equal(a.modelMap["opencode:m1"], undefined); // a, b are DAY1 and were filtered out
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

test("aggregate sums the requests field, defaulting to 1 per record", () => {
  const recs = [
    { id: "a", time: at(2026, 9, 12, 10, 0), model: "m1", workspaceID: "w1", input: 10, requests: 5 },
    { id: "b", time: at(2026, 9, 12, 11, 0), model: "m1", workspaceID: "w1", input: 10 },
    { id: "c", time: at(2026, 9, 12, 12, 0), model: "m2", workspaceID: "w1", input: 10, requests: 0 },
  ];
  const a = aggregate(recs, { price });
  assert.equal(a.totals.req, 7); // 5 + 1 + (0 -> 1)
  assert.equal(a.modelMap["opencode:m1"].req, 6);
  assert.equal(a.modelMap["opencode:m2"].req, 1);
});

test("aggregate totals add reasoning on top of an exclusive output", () => {
  const recs = [
    { id: "r", time: at(2026, 9, 12, 10, 0), model: "m1", workspaceID: "w1", input: 100, output: 300, reasoning: 200, cacheRead: 50 },
  ];
  const a = aggregate(recs, { price });
  assert.equal(a.totals.tokens, 650); // 100 + 300 + 200 + 50
  assert.equal(a.modelMap["opencode:m1"].output, 300); // reasoning kept separate
});

test("aggregate keys workspaces per source and filters by the composite key", () => {
  const recs = [
    { id: "a", time: at(2026, 9, 12, 10, 0), model: "m", source: "opencode", workspaceID: "x", input: 10 },
    { id: "b", time: at(2026, 9, 12, 11, 0), model: "m", source: "deepseek-official", workspaceID: "x", input: 20 },
  ];
  const all = aggregate(recs, { price });
  assert.deepEqual(Object.keys(all.wsMap).sort(), ["deepseek-official:x", "opencode:x"]);
  const only = aggregate(recs, { price, selectedWS: "deepseek-official:x" });
  assert.equal(only.totals.req, 1);
  assert.equal(only.modelMap["deepseek-official:m"].req, 1); // only record b survived
  assert.equal(only.modelMap["opencode:m"], undefined);
});

test("aggregate keeps same-named models from different sources separate", () => {
  const recs = [
    { id: "a", time: at(2026, 9, 12, 10, 0), model: "deepseek-v4-flash", source: "opencode", workspaceID: "x", input: 10 },
    { id: "b", time: at(2026, 9, 12, 11, 0), model: "deepseek-v4-flash", source: "deepseek-official", workspaceID: "x", input: 20 },
  ];
  const a = aggregate(recs, { price });
  assert.deepEqual(Object.keys(a.modelMap).sort(), ["deepseek-official:deepseek-v4-flash", "opencode:deepseek-v4-flash"]);
  assert.equal(a.modelMap["opencode:deepseek-v4-flash"].req, 1);
  assert.equal(a.modelMap["opencode:deepseek-v4-flash"].model, "deepseek-v4-flash");
  assert.equal(a.modelMap["opencode:deepseek-v4-flash"].source, "opencode");
  assert.equal(a.modelMap["deepseek-official:deepseek-v4-flash"].source, "deepseek-official");
});

test("createAggregator pushed in chunks equals aggregate", () => {
  const expected = aggregate(records, { price });
  const acc = createAggregator({ price });
  acc.push(records.slice(0, 1));
  acc.push(records.slice(1, 2));
  acc.push(records.slice(2));
  assert.deepEqual(acc.finish(), expected);
});

test("createAggregator matches aggregate across filters and edge inputs", () => {
  const cases = [
    ["empty", [], { price }],
    ["single", [records[0]], { price }],
    ["date range", records, { price, startDate: DAY2, endDate: DAY2 }],
    ["model filter", records, { price, selectedModel: "m1" }],
    ["workspace filter", records, { price, selectedWS: "opencode:w1" }],
  ];
  for (const [name, recs, opts] of cases) {
    const expected = aggregate(recs, opts);
    const acc = createAggregator(opts);
    const mid = Math.ceil(recs.length / 2);
    acc.push(recs.slice(0, mid));
    acc.push(recs.slice(mid));
    assert.deepEqual(acc.finish(), expected, name);
  }
});

test("createAggregator survives awaits between chunks (interruptible caller)", async () => {
  const expected = aggregate(records, { price });
  const acc = createAggregator({ price });
  const chunks = [records.slice(0, 1), records.slice(1, 3), records.slice(3)];
  let yields = 0;
  for (const chunk of chunks) {
    acc.push(chunk);
    await Promise.resolve().then(() => { yields++; });
  }
  assert.ok(yields >= 2, "the caller yielded between chunks");
  assert.deepEqual(acc.finish(), expected);
});

test("aggregate exposes date-range-free dailyAll/hourlyAll for the yearly heatmap", () => {
  const a = aggregate(records, { price, startDate: DAY2, endDate: DAY2 });
  // The dated outputs stay scoped to DAY2...
  assert.equal(a.totals.req, 1);
  assert.deepEqual(Object.keys(a.dailyMap), [DAY2]);
  // ...while dailyAll ignores the date range (still ws/model filtered).
  assert.deepEqual(Object.keys(a.dailyAll).sort(), [DAY1, DAY2].sort());
  assert.equal(a.dailyAll[DAY1].tokens, 3000);
  assert.equal(a.dailyAll[DAY2].tokens, 600);
  assert.equal(a.hourlyAll[DAY1][10 * 60 + 30].tokens, 1000);
  assert.equal(a.hourlyAll[DAY2][9 * 60].tokens, 600);
});

test("dailyAll is scoped by ws/model filters but not the date range", () => {
  const onlyM1 = aggregate(records, { price, selectedModel: "m1", startDate: DAY2, endDate: DAY2 });
  assert.equal(onlyM1.totals.req, 0, "m1 records are DAY1, out of the dated range");
  assert.deepEqual(Object.keys(onlyM1.dailyAll), [DAY1]);
  assert.equal(onlyM1.dailyAll[DAY1].tokens, 3000);
});

test("computeUnpricedSet collects the models that have an unpriced record", () => {
  const recs = records.concat([{ id: "u", time: at(2026, 9, 12, 12, 0), model: "unmapped", workspaceID: "w1", input: 10 }]);
  assert.deepEqual([...computeUnpricedSet(recs, price)], ["unmapped"]);
  assert.deepEqual([...computeUnpricedSet(records, price)], []);
  assert.deepEqual([...computeUnpricedSet([], price)], []);
});
