import { test } from "node:test";
import assert from "node:assert/strict";

import { computePresetDrift, MIN_RECOVERABLE, MIN_REPRICED } from "../../extension/shared/preset-drift.js";

const flat = (input, output = input) => [{ from: null, pricing: { flat: { input, output, cacheRead: 0, cacheWrite: 0 } } }];
const rec = (model, source = "opencode") => ({ source, model, time: "2026-01-01T00:00:00Z", input: 1000, output: 1000 });

test("no lists or no records means no drift", () => {
  const empty = computePresetDrift({});
  assert.equal(empty.suggest, false);
  assert.equal(empty.recoverableCount, 0);
  assert.equal(computePresetDrift({ stored: { groups: [], assign: {} }, records: [rec("a")] }).suggest, false);
});

test("counts unpriced models the shipped list can price", () => {
  const stored = { groups: [{ id: "g1", rates: flat(1) }], assign: { "opencode:a": "g1" } };
  const shipped = {
    groups: [
      { id: "g1", rates: flat(1) },
      { id: "g2", rates: flat(2) },
    ],
    assign: { "opencode:a": "g1", "opencode:b": "g2", "opencode:c": "g2", "opencode:d": "g2" },
  };
  const records = [rec("a"), rec("b"), rec("c"), rec("d"), rec("zzz")];
  const drift = computePresetDrift({ stored, shipped, records });
  assert.equal(drift.recoverableCount, 3);
  assert.deepEqual(drift.recoverable, ["opencode:b", "opencode:c", "opencode:d"]);
  assert.equal(drift.addedGroups, 1);
  assert.equal(drift.suggest, drift.recoverableCount >= MIN_RECOVERABLE);
});

test("a small gap stays quiet", () => {
  const stored = { groups: [{ id: "g1", rates: flat(1) }], assign: {} };
  const shipped = {
    groups: [{ id: "g1", rates: flat(1) }],
    assign: { "opencode:b": "g1", "opencode:c": "g1" },
  };
  const drift = computePresetDrift({ stored, shipped, records: [rec("b"), rec("c")] });
  assert.equal(drift.recoverableCount, 2);
  assert.equal(drift.suggest, false);
});

test("rate changes count as repriced, not as unpriced", () => {
  const models = ["m1", "m2", "m3", "m4", "m5"];
  const stored = { groups: [{ id: "g1", rates: flat(1) }], assign: Object.fromEntries(models.map((m) => [`opencode:${m}`, "g1"])) };
  const shipped = { groups: [{ id: "g1", rates: flat(2) }], assign: stored.assign };
  const drift = computePresetDrift({ stored, shipped, records: models.map((m) => rec(m)) });
  assert.equal(drift.recoverableCount, 0);
  assert.equal(drift.repricedCount, 5);
  assert.equal(drift.suggest, drift.repricedCount >= MIN_REPRICED);
});

test("identical lists report a clean drift", () => {
  const lists = {
    groups: [{ id: "g1", rates: flat(1) }],
    assign: { "opencode:a": "g1", "opencode:b": "g1" },
  };
  const drift = computePresetDrift({ stored: lists, shipped: structuredClone(lists), records: [rec("a"), rec("b")] });
  assert.equal(drift.recoverableCount, 0);
  assert.equal(drift.repricedCount, 0);
  assert.equal(drift.addedGroups, 0);
  assert.equal(drift.suggest, false);
});

test("records from other sources keep their own key", () => {
  const stored = { groups: [], assign: {} };
  const shipped = { groups: [{ id: "g1", rates: flat(1) }], assign: { "openrouter:x/y": "g1" } };
  const drift = computePresetDrift({ stored, shipped, records: [rec("x/y", "openrouter")] });
  assert.deepEqual(drift.recoverable, ["openrouter:x/y"]);
});

test("reports models only the stored list prices, since a reset would unprice them", () => {
  const stored = {
    groups: [{ id: "mine", rates: flat(1) }],
    assign: { "opencode:custom": "mine" },
  };
  const shipped = {
    groups: [{ id: "g1", rates: flat(2) }],
    assign: { "opencode:b": "g1", "opencode:c": "g1", "opencode:d": "g1" },
  };
  const drift = computePresetDrift({
    stored,
    shipped,
    records: [rec("custom"), rec("b"), rec("c"), rec("d")],
  });
  assert.equal(drift.lostCount, 1);
  assert.equal(drift.recoverableCount, 3);
  assert.equal(drift.suggest, true);
});
