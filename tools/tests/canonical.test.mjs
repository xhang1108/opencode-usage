import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SCHEMA_VERSION,
  canonicalDate,
  stableHash,
  makeId,
  normalizeRecord,
  validateRecord,
} from "../../extension/shared/canonical.js";

test("canonicalDate derives UTC date from time (P8)", () => {
  assert.equal(canonicalDate("2026-09-12T23:30:00Z"), "2026-09-12");
  // DeepSeek export: PT/GMT+8 midnight shifts to the previous UTC day.
  assert.equal(canonicalDate("2026-06-16T00:00:00+08:00"), "2026-06-15");
  assert.equal(canonicalDate("not-a-date"), null);
});

test("stableHash is deterministic, 8 hex chars", () => {
  const a = stableHash("abc");
  assert.equal(a, stableHash("abc"));
  assert.match(a, /^[0-9a-f]{8}$/);
  assert.notEqual(a, stableHash("abd"));
});

test("makeId namespaces with source; hashes when no origin id", () => {
  assert.equal(makeId("opencode", "msg_1"), "opencode:msg_1");
  assert.match(makeId("mimo", null, "x"), /^mimo:[0-9a-f]{8}$/);
  assert.equal(makeId("opencode", null, "x"), makeId("opencode", null, "x"));
});

test("normalizeRecord coerces string tokens and derives date/id/version", () => {
  const rec = normalizeRecord({
    source: "commandcode",
    time: "2026-09-12T12:39:52.092Z",
    model: "deepseek/deepseek-v4.1-flash",
    input: "1462",
    output: "262",
  });
  assert.equal(rec.input, 1462);
  assert.equal(rec.output, 262);
  assert.equal(rec.reasoning, 0);
  assert.equal(rec.cacheRead, 0);
  assert.equal(rec.date, "2026-09-12");
  assert.equal(rec.time, "2026-09-12T12:39:52.092Z");
  assert.equal(rec.v, SCHEMA_VERSION);
  assert.match(rec.id, /^commandcode:[0-9a-f]{8}$/);
});

test("normalizeRecord fills a missing source with opencode (D4)", () => {
  const rec = normalizeRecord({ time: "2026-09-12T00:00:00Z", model: "m", input: 1 });
  assert.equal(rec.source, "opencode");
  assert.match(rec.id, /^opencode:/);
});

test("normalizeRecord drops non-numeric optional requests", () => {
  const rec = normalizeRecord({ source: "mimo", time: "2026-09-12T00:00:00Z", model: "m", input: 1, requests: "abc" });
  assert.equal(rec.requests, undefined);
});

test("validateRecord requires fields and at least one token > 0 (D4)", () => {
  const ok = normalizeRecord({ source: "opencode", time: "2026-09-12T00:00:00Z", model: "m", input: 5 });
  assert.equal(validateRecord(ok).ok, true);
  assert.equal(validateRecord({ ...ok, id: "" }).reason, "missing:id");
  assert.equal(validateRecord({ ...ok, time: "nope" }).reason, "bad-time");
  assert.equal(validateRecord({ ...ok, input: 0, output: 0, cacheRead: 0 }).reason, "no-tokens");
});
