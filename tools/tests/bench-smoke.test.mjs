// tools/tests/bench-smoke.test.mjs
// Smoke test for the load benchmark: it must run on a tiny fixture and emit
// every row/field the plan's §2 report depends on. A tiny size + few reps keeps
// the suite fast; the real numbers come from running the script directly.
import { test } from "node:test";
import assert from "node:assert/strict";

import { runBench } from "../bench/dashboard-load.mjs";

const REQUIRED_ROWS = [
  "stringify",
  "parse",
  "normalize",
  "aggregateCold",
  "aggregateHot",
  "aggregateHotWindow",
  "aggregateNoop",
  "heatmapCells",
  "buildUnifiedIndex",
];

test("dashboard-load bench runs and emits every required row", () => {
  const out = runBench({ sizes: [250], reps: 3 });

  assert.equal(out.results.length, 1);
  const r = out.results[0];
  assert.equal(r.size, 250);
  assert.ok(r.bytes > 0, "fixture must serialise to something");
  assert.ok(r.weeks > 0, "the yearly grid must have week columns");

  for (const key of REQUIRED_ROWS) {
    assert.equal(typeof r.timings[key], "number", `${key} must be a number`);
    assert.ok(r.timings[key] >= 0, `${key} must be >= 0`);
  }
  assert.ok(r.pricingShare >= 0 && r.pricingShare <= 1, "pricing share must be a fraction");
  assert.ok(r.pureJsSubtotal > 0, "pure JS subtotal must be positive");
});
