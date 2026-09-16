import { test } from "node:test";
import assert from "node:assert/strict";

import {
  fingerprintOf,
  buildFingerprintBuckets,
  mergeRecords,
  hideDayAnchoredImportCopies,
  isDayAnchoredRecord,
  isLocalLooking,
} from "../../extension/shared/merge.js";

function rec(over) {
  return {
    source: "opencode",
    time: "2026-09-12T12:00:00Z",
    model: "deepseek-v4.1-flash",
    input: 1000,
    output: 200,
    ...over,
  };
}

test("fingerprintOf is stable and null without a time", () => {
  const a = fingerprintOf(rec({ id: "a" }));
  assert.equal(a, fingerprintOf(rec({ id: "b" })));
  assert.equal(fingerprintOf({ model: "m" }), null);
});

test("mergeRecords is N-way by id and idempotent", () => {
  const base = { a: rec({ id: "a" }) };
  const extra = { b: rec({ id: "b" }) };
  const once = mergeRecords(base, extra);
  assert.equal(Object.keys(once.merged).length, 2);
  const twice = mergeRecords(once.merged, base, extra);
  assert.equal(Object.keys(twice.merged).length, 2);
  const override = mergeRecords({ a: rec({ id: "a" }) }, { a: rec({ id: "a", input: 9999 }) });
  assert.equal(Object.keys(override.merged).length, 1);
  assert.equal(override.merged.a.input, 9999);
});

test("buildFingerprintBuckets ignores records without a parseable time", () => {
  const buckets = buildFingerprintBuckets([{ model: "m", input: 1 }]);
  assert.equal(buckets.size, 0);
});

test("isDayAnchoredRecord detects D22 day-anchored times only", () => {
  assert.equal(isDayAnchoredRecord({ time: "2026-09-12T00:00:00.000Z" }), true);
  assert.equal(isDayAnchoredRecord({ time: "2026-09-12T03:00:00Z" }), false);
});

test("hideDayAnchoredImportCopies hides a day-anchored import copy of a crawl record (B5)", () => {
  const records = {
    "deepseek-official:crawl1": rec({ source: "deepseek-official", time: "2026-09-12T03:00:00Z", input: 500 }),
    "deepseek-official:import1": rec({ source: "deepseek-official", time: "2026-09-12T00:00:00.000Z", input: 500 }),
  };
  const { map, dropped } = hideDayAnchoredImportCopies(records);
  assert.equal(dropped, 1);
  assert.deepEqual(Object.keys(map), ["deepseek-official:crawl1"]);
});

test("hideDayAnchoredImportCopies keeps records when tokens or source differ", () => {
  const otherSource = {
    "opencode:c": rec({ source: "opencode", time: "2026-09-12T03:00:00Z", input: 500 }),
    "mimo:i": rec({ source: "mimo", time: "2026-09-12T00:00:00.000Z", input: 500 }),
  };
  assert.equal(hideDayAnchoredImportCopies(otherSource).dropped, 0);
  const otherTokens = {
    "mimo:c": rec({ source: "mimo", time: "2026-09-12T03:00:00Z", input: 500 }),
    "mimo:i": rec({ source: "mimo", time: "2026-09-12T00:00:00.000Z", input: 501 }),
  };
  assert.equal(hideDayAnchoredImportCopies(otherTokens).dropped, 0);
});

test("hideDayAnchoredImportCopies keeps imports when no instant crawl record exists", () => {
  const onlyImport = { "mimo:i": rec({ source: "mimo", time: "2026-09-12T00:00:00.000Z" }) };
  const { map, dropped } = hideDayAnchoredImportCopies(onlyImport);
  assert.equal(dropped, 0);
  assert.deepEqual(Object.keys(map), ["mimo:i"]);
});

test("isLocalLooking separates the local-DB track from crawl and vendor records", () => {
  // Local-DB import (import-local.mjs): msg_ id, synthetic "Local" workspace.
  assert.equal(isLocalLooking("msg_abc", rec({ id: "msg_abc", workspaceID: "Local" })), true);
  assert.equal(isLocalLooking("opencode:msg_abc", rec({ id: "opencode:msg_abc", workspaceID: "Local" })), true);
  assert.equal(isLocalLooking("x", rec({ workspaceID: "local:proj" })), true);
  // opencode crawl: real workspace id, server-side id.
  assert.equal(isLocalLooking("opencode:abc", rec({ id: "opencode:abc", workspaceID: "wrk_123" })), false);
  // Any non-opencode vendor record counts as "local" (never hidden by opencode dedupe).
  assert.equal(isLocalLooking("deepseek-official:a", rec({ source: "deepseek-official" })), true);
});
