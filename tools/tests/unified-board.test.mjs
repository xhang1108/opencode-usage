import { test } from "node:test";
import assert from "node:assert/strict";

import {
  collectKeys,
  boardModel,
  moveChip,
  setGroupRates,
  deleteGroup,
  addGroup,
  renameGroup,
} from "../../extension/dashboard/settings/unified-model.js";
import { normalizeUnifiedPricing } from "../../extension/shared/unified.js";
import { parse } from "../../extension/shared/model-fingerprint.js";

const RATE = { from: null, pricing: { flat: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } };
const base = (assign = {}) =>
  normalizeUnifiedPricing({
    enabled: true,
    groups: [{ id: "g1", rates: [RATE] }, { id: "g2", rates: [] }],
    assign,
  });

test("collectKeys merges records, preset map and assigns, then drops fp: keys", () => {
  const keys = collectKeys({
    records: [{ source: "mimo", model: "x" }, { model: "plain" }],
    modelMap: { "openrouter:y": { rates: [] } },
    assign: { "opencode:a": "g1", "fp:deepseek:4:flash:z": "g1" },
  });
  assert.deepEqual(keys, ["mimo:x", "opencode:a", "opencode:plain", "openrouter:y"]);
  assert.ok(!keys.some((k) => k.startsWith("fp:")), "fingerprint keys are internal");
});

test("boardModel splits keys into unassigned vs (possibly structural) assigned", () => {
  const model = "opencode:deepseek-v4-flash";
  const fpKey = "fp:" + parse(model).fingerprint;
  const unified = base({ [fpKey]: "g1" });
  const { groupOf, unassigned, structural } = boardModel(unified, [model, "opencode:orphan"]);
  assert.equal(groupOf.get(model), "g1", "resolved by fingerprint fallback");
  assert.ok(structural.has(model), "structurally pinned chips are marked");
  assert.deepEqual(unassigned, ["opencode:orphan"]);
});

test("moveChip assigns and un-assigns a model", () => {
  const unified = base({});
  const moved = moveChip(unified, "opencode:a", "g1");
  assert.equal(moved.assign["opencode:a"], "g1");
  const back = moveChip(moved, "opencode:a", "none");
  assert.ok(!("opencode:a" in back.assign));
});

test("setGroupRates replaces a group's rates and ignores an unknown id", () => {
  const unified = base({});
  const next = setGroupRates(unified, "g2", [RATE]);
  assert.equal(next.groups.find((g) => g.id === "g2").rates.length, 1);
  const same = setGroupRates(unified, "missing", [RATE]);
  assert.deepEqual(same.groups, unified.groups);
});

test("deleteGroup removes the group; the dangling assign is dropped on persist", () => {
  const unified = base({ "opencode:a": "g1" });
  const dropped = deleteGroup(unified, "g1");
  assert.deepEqual(dropped.groups.map((g) => g.id), ["g2"]);
  // persist() normalizes before saving, which is what actually drops the dangling key.
  assert.deepEqual(normalizeUnifiedPricing(dropped).assign, {});
});

test("addGroup appends a fresh id with zero rates", () => {
  const unified = setGroupRates(base({}), "g2", [RATE]);
  const next = addGroup(unified);
  assert.equal(next.groups.length, 3);
  const added = next.groups[2];
  assert.ok(!["g1", "g2"].includes(added.id));
  assert.equal(added.rates[0].pricing.flat.input, 0);
});

test("renameGroup re-points every assignment to the new id", () => {
  const unified = base({ "opencode:a": "g1", "opencode:b": "g2" });
  const res = renameGroup(unified, "g1", "flash");
  assert.equal(res.ok, true);
  assert.deepEqual(res.unified.groups.map((g) => g.id), ["flash", "g2"]);
  assert.equal(res.unified.assign["opencode:a"], "flash");
  assert.equal(res.unified.assign["opencode:b"], "g2");
});

test("renameGroup refuses a no-op or a duplicate name", () => {
  const unified = base({ "opencode:a": "g1" });
  assert.equal(renameGroup(unified, "g1", "g1").ok, false);
  assert.equal(renameGroup(unified, "g1", "").ok, false);
  const dup = renameGroup(unified, "g1", "g2");
  assert.deepEqual(dup, { ok: false, reason: "duplicate" });
});
