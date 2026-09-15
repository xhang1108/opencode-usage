import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyImport,
  isSettingsPayload,
  planRecordsImport,
  describeSettingsRestore,
  mergeFirstSeen,
} from "../../extension/dashboard/core/import-plan.js";
import { SETTINGS_FORMAT } from "../../extension/shared/backup.js";

test("classifyImport dispatches by extension", () => {
  assert.equal(classifyImport("mimo-usage.xlsx"), "xlsx");
  assert.equal(classifyImport("opencode-usage_records_2026-09-16.CSV"), "csv");
  assert.equal(classifyImport("local.json"), "json");
  assert.equal(classifyImport("notes.txt"), "unsupported");
  assert.equal(classifyImport("archive.csv.gz"), "unsupported");
  assert.equal(classifyImport(""), "unsupported");
  assert.equal(classifyImport(undefined), "unsupported");
});

test("isSettingsPayload recognizes our settings backup", () => {
  assert.equal(isSettingsPayload({ format: SETTINGS_FORMAT, settings: {} }), true);
  assert.equal(isSettingsPayload({ format: "something-else" }), false);
  assert.equal(isSettingsPayload(null), false);
  assert.equal(isSettingsPayload([]), false);
});

test("planRecordsImport routes opencode local vs vendor vs unknown and skips crawl", () => {
  const plan = planRecordsImport(
    [
      { id: "msg_1", source: "opencode", workspaceID: "wrk_a", model: "a" }, // local (msg_)
      { id: "crawl_9", source: "opencode", workspaceID: "wrk_a", model: "a" }, // crawl-track -> skipped
      { id: "x", source: "opencode", workspaceID: "Local", model: "b" }, // local (Local workspace)
      { id: "y", source: "opencode", workspaceID: "local:proj", model: "c" }, // local (local: prefix)
      { id: "m1", source: "mimo", model: "d" }, // known vendor
      { id: "w1", source: "mystery", model: "e" }, // unknown vendor
      { id: "w2", source: "mystery", model: "f" },
      { id: "n1", model: "g" }, // no source -> opencode, crawl-track
    ],
    new Set(["mimo"])
  );
  assert.deepEqual(Object.keys(plan.localMap).sort(), ["msg_1", "x", "y"]);
  assert.equal(plan.vendors.length, 1);
  assert.equal(plan.vendors[0].source, "mimo");
  assert.deepEqual(plan.vendors[0].records.map((r) => r.id), ["m1"]);
  assert.equal(plan.skippedCrawl, 2, "crawl_9 and the no-source record are crawl-track");
  assert.equal(plan.unknownCount, 2);
});

test("planRecordsImport is id-keyed so re-import collapses duplicates", () => {
  const plan = planRecordsImport([
    { id: "msg_1", source: "opencode", model: "a" },
    { id: "msg_1", source: "opencode", model: "a" },
  ]);
  assert.equal(Object.keys(plan.localMap).length, 1);
});

test("planRecordsImport with no records is empty", () => {
  assert.deepEqual(planRecordsImport([], new Set()), { localMap: {}, vendors: [], skippedCrawl: 0, unknownCount: 0 });
});

test("describeSettingsRestore pluralizes the section count", () => {
  assert.equal(describeSettingsRestore({ defaultCrawl: "opencode" }), "settings restored (1 section)");
  assert.equal(describeSettingsRestore({ a: 1, b: 2 }), "settings restored (2 sections)");
  assert.equal(describeSettingsRestore({}), "settings restored (0 sections)");
});

test("mergeFirstSeen stamps new models, keeps old, prunes gone ones", () => {
  const prev = { a: 100, b: 200 };
  const { next, changed } = mergeFirstSeen(prev, ["a", "c"], 999);
  assert.deepEqual(next, { a: 100, c: 999 });
  assert.equal(changed, true);
});

test("mergeFirstSeen reports no change when the set is identical", () => {
  const { next, changed } = mergeFirstSeen({ a: 100 }, ["a"], 999);
  assert.deepEqual(next, { a: 100 });
  assert.equal(changed, false);
});

test("mergeFirstSeen defaults an empty/absent map", () => {
  const { next, changed } = mergeFirstSeen(undefined, ["a"], 7);
  assert.deepEqual(next, { a: 7 });
  assert.equal(changed, true);
});
