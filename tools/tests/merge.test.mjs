import { test } from "node:test";
import assert from "node:assert/strict";

import {
  fingerprintOf,
  buildFingerprintBuckets,
  mergeRecords,
  hideSameSourceDuplicates,
  DEDUP_BUCKET_MS,
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

test("hideSameSourceDuplicates hides crawl copies matching a file record", () => {
  const crawl = { "crawler:1": rec({ source: "opencode", input: 1000 }) };
  const file = { "msg_1": rec({ source: "opencode", input: 1000, time: "2026-09-12T12:01:00Z" }) };
  const { map, dropped } = hideSameSourceDuplicates(crawl, file, { source: "opencode" });
  assert.equal(dropped, 1);
  assert.deepEqual(Object.keys(map), []);
});

test("hideSameSourceDuplicates never hides across different sources", () => {
  const crawl = { "crawler:1": rec({ source: "opencode", input: 1000 }) };
  const other = { "x:1": rec({ source: "commandcode", input: 1000 }) };
  const { dropped } = hideSameSourceDuplicates(crawl, other, { source: "opencode" });
  assert.equal(dropped, 0);
});

test("hideSameSourceDuplicates absorbs clock skew within one bucket", () => {
  const crawl = { "crawler:1": rec({ time: "2026-09-12T12:00:00Z" }) };
  const file = { "msg_1": rec({ time: new Date(Date.parse("2026-09-12T12:00:00Z") + DEDUP_BUCKET_MS).toISOString() }) };
  const { dropped } = hideSameSourceDuplicates(crawl, file, { source: "opencode" });
  assert.equal(dropped, 1);
});

test("buildFingerprintBuckets ignores records without a parseable time", () => {
  const buckets = buildFingerprintBuckets([{ model: "m", input: 1 }]);
  assert.equal(buckets.size, 0);
});
