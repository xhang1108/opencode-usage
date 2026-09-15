import { test } from "node:test";
import assert from "node:assert/strict";

import { snapshotFilename, isoFromWayback, modelsKey } from "../price-watch-lib.mjs";

test("snapshotFilename strips separators and millisecond precision", () => {
  assert.equal(snapshotFilename("2026-09-13T07:30:02.000Z"), "20260913T073002Z.json");
  assert.equal(snapshotFilename("2026-09-13T07:30:02Z"), "20260913T073002Z.json");
  assert.equal(snapshotFilename("2026-01-05T00:00:00.123Z"), "20260105T000000Z.json");
});

test("isoFromWayback expands 14-digit Wayback timestamps", () => {
  assert.equal(isoFromWayback("20260913073002"), "2026-09-13T07:30:02.000Z");
});

test("modelsKey ignores model key order", () => {
  const a = { models: { "m-b": { input: 1 }, "m-a": { input: 2 } } };
  const b = { models: { "m-a": { input: 2 }, "m-b": { input: 1 } } };
  assert.equal(modelsKey(a), modelsKey(b));
  assert.equal(modelsKey({}), "[]");
});
