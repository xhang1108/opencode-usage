import { test } from "node:test";
import assert from "node:assert/strict";

import { shapeOf, namesOf, lastDays } from "../probe-vendors.mjs";
import { arg, NUMERIC, coerceRecord } from "../verify-cost-gap.mjs";

test("shapeOf describes primitives, objects, and arrays", () => {
  assert.equal(shapeOf(1), "number");
  assert.equal(shapeOf("s"), "string");
  assert.equal(shapeOf(true), "boolean");
  assert.equal(shapeOf(null), "object");
  assert.equal(shapeOf(undefined), "undefined");
  assert.deepEqual(shapeOf({ a: { b: 1 } }), { a: { b: "number" } });
  assert.deepEqual(shapeOf([]), []);
  assert.deepEqual(shapeOf([1, 2]), ["number"]);
  assert.deepEqual(shapeOf([{ id: "x" }]), [{ id: "string" }]);
});

test("shapeOf stops recursing past depth 3", () => {
  assert.equal(shapeOf(1, 4), "number");
  assert.equal(shapeOf({ a: 1 }, 4), "object");
  assert.equal(shapeOf([1], 4), "object");
  assert.deepEqual(shapeOf([1], 3), ["number"]);
  assert.deepEqual(shapeOf({ a: { b: { c: { d: 1 } } } }), { a: { b: { c: { d: "number" } } } });
});

test("namesOf joins names from strings, objects, and fallbacks", () => {
  assert.equal(namesOf(["a", "b"]), "a,b");
  assert.equal(namesOf([{ name: "x" }, { name: "y" }]), "x,y");
  assert.equal(namesOf([{ id: "foo" }]), "foo");
  assert.equal(namesOf(["a", "", null, { name: "" }]), "a");
  assert.equal(namesOf("nope"), null);
  assert.equal(namesOf(null), null);
  assert.equal(namesOf(undefined), null);
});

test("lastDays returns an ISO window of roughly n days", () => {
  const { start, end } = lastDays(7);
  const s = Date.parse(start);
  const e = Date.parse(end);
  assert.ok(!Number.isNaN(s) && !Number.isNaN(e));
  assert.ok(e >= s);
  const days = (e - s) / 86400000;
  assert.ok(days >= 6.9 && days <= 7.1, `span was ${days} days`);
  assert.equal(new Date(start).toISOString(), start);
});

const withArgv = (argv, fn) => {
  const original = process.argv;
  process.argv = argv;
  try {
    return fn();
  } finally {
    process.argv = original;
  }
};

test("arg reads flags from process.argv with a fallback", () => {
  withArgv(["node", "tool", "--csv", "a.csv", "--start", "2026-01-01"], () => {
    assert.equal(arg("csv"), "a.csv");
    assert.equal(arg("start"), "2026-01-01");
    assert.equal(arg("missing"), null);
    assert.equal(arg("missing", "d"), "d");
  });
  withArgv(["node", "tool", "--csv"], () => {
    assert.equal(arg("csv"), null);
    assert.equal(arg("csv", "fallback"), "fallback");
  });
});

test("NUMERIC lists the numeric CSV columns", () => {
  assert.ok(NUMERIC instanceof Set);
  for (const k of ["input", "output", "reasoning", "cacheRead", "cacheWrite5m", "cacheWrite1h", "requests", "tzOffset", "vendorCost", "costScale", "costMultiplier"]) {
    assert.ok(NUMERIC.has(k), `missing ${k}`);
  }
  assert.ok(!NUMERIC.has("model"));
});

test("coerceRecord coerces numeric fields and drops empty strings", () => {
  const rec = coerceRecord({
    model: "deepseek-v4",
    input: "10",
    output: "0",
    requests: "3",
    cacheRead: "",
    cacheWrite5m: "abc",
    outputExcludesReasoning: "true",
    workspaceID: "",
    source: "opencode",
  });
  assert.deepEqual(rec, {
    model: "deepseek-v4",
    input: 10,
    output: 0,
    requests: 3,
    outputExcludesReasoning: true,
    source: "opencode",
  });
  assert.equal(typeof rec.input, "number");
  assert.equal(typeof rec.outputExcludesReasoning, "boolean");
  assert.deepEqual(coerceRecord({ outputExcludesReasoning: "false" }), { outputExcludesReasoning: false });
  assert.deepEqual(coerceRecord({ outputExcludesReasoning: "" }), {});
  assert.deepEqual(coerceRecord({ input: "" }), {});
  assert.deepEqual(coerceRecord({ input: "not-a-number" }), {});
  assert.deepEqual(coerceRecord({ vendorCost: "1.25" }), { vendorCost: 1.25 });
});
