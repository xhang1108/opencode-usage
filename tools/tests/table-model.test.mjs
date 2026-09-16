import { test } from "node:test";
import assert from "node:assert/strict";

import { workspaceRows, modelRows, dailyRows } from "../../extension/dashboard/views/table-model.js";

test("workspaceRows shapes the workspace table and prices hit rate off prompt", () => {
  const rows = workspaceRows({
    "opencode:wrk_a": { req: 3, tokens: 1000, prompt: 200, cacheRead: 50, cost: 1.25 },
  });
  assert.deepEqual(rows, [{ ws: "opencode:wrk_a", req: 3, tokens: 1000, hitRate: 25, cost: 1.25 }]);
  assert.deepEqual(workspaceRows({}), []);
});

test("workspaceRows guards a zero/absent prompt (no NaN)", () => {
  assert.equal(workspaceRows({ w: { req: 1, tokens: 1, cacheRead: 5, cost: 0 } })[0].hitRate, 0);
});

test("modelRows shapes the model table, falling back to the map key and empty source", () => {
  const rows = modelRows({
    "mimo:foo": { req: 2, input: 100, output: 20, cacheRead: 100, peakCost: 1, offpeakCost: 2, flatCost: 3, cost: 6 },
    "bar": { model: "bar", source: "deepseek", req: 1, input: 0, output: 0, cacheRead: 0, cost: 0 },
  });
  assert.deepEqual(rows[0], {
    model: "mimo:foo",
    source: "",
    req: 2,
    input: 100,
    output: 20,
    cacheRead: 100,
    hitRate: 50,
    peakCost: 1,
    offpeakCost: 2,
    flatCost: 3,
    cost: 6,
  });
  assert.equal(rows[1].hitRate, 0);
  assert.equal(rows[1].source, "deepseek");
  assert.deepEqual(modelRows({}), []);
});

test("dailyRows shapes the single-model daily table", () => {
  const rows = dailyRows({ "2026-09-16": { req: 1, input: 90, output: 10, cacheRead: 10, cost: 0.5 } });
  assert.deepEqual(rows, [{ date: "2026-09-16", req: 1, input: 90, output: 10, cacheRead: 10, hitRate: 10, cost: 0.5 }]);
  assert.deepEqual(dailyRows({}), []);
});

test("pin: workspace hit rate divides by prompt, model/daily by input+cacheRead", () => {
  // Same cacheRead, but prompt and input+cacheRead disagree, so the two columns
  // must diverge (this is the intentional difference, not a bug).
  const ws = workspaceRows({ w: { req: 1, tokens: 1, prompt: 100, cacheRead: 50, cost: 0 } })[0];
  const model = modelRows({ m: { req: 1, input: 200, output: 0, cacheRead: 50, cost: 0 } })[0];
  assert.equal(ws.hitRate, 50);
  assert.equal(model.hitRate, 20);
});
