import { test } from "node:test";
import assert from "node:assert/strict";

import {
  STORAGE_SCHEMA_VERSION,
  MIGRATIONS,
  pendingMigrations,
  planMigrations,
} from "../../extension/shared/migrate.js";

test("an unversioned store runs every migration and stamps the current version", () => {
  const { version, applied, patch } = planMigrations({});
  assert.equal(version, STORAGE_SCHEMA_VERSION);
  assert.deepEqual(applied, pendingMigrations(0).map((m) => m.to));
  assert.deepEqual(patch, {});
});

test("planMigrations is idempotent once the store is current", () => {
  const { version, applied, patch } = planMigrations({ schemaVersion: STORAGE_SCHEMA_VERSION });
  assert.equal(version, STORAGE_SCHEMA_VERSION);
  assert.deepEqual(applied, []);
  assert.deepEqual(patch, {});
});

test("a newer store is never downgraded", () => {
  const future = STORAGE_SCHEMA_VERSION + 5;
  const { version, applied, patch } = planMigrations({ schemaVersion: future });
  assert.equal(version, future);
  assert.deepEqual(applied, []);
  assert.deepEqual(patch, {});
});

test("migrations are additive: patches merge in order and never remove keys", () => {
  const steps = [
    { to: 1, keys: ["a"], apply: (s) => ({ renamed: s.a }) },
    { to: 2, keys: ["b"], apply: () => ({ b: 2 }) },
  ];
  const { version, applied, patch } = planMigrations({ a: 1, keep: "x" }, steps);
  assert.equal(version, STORAGE_SCHEMA_VERSION);
  assert.deepEqual(applied, [1, 2]);
  assert.deepEqual(patch, { renamed: 1, b: 2 });
  assert.ok(!("keep" in patch), "migrations must not emit removals");
});

test("the shipped migration chain targets consecutive versions from 0", () => {
  const tos = MIGRATIONS.map((m) => m.to).sort((a, b) => a - b);
  assert.deepEqual(tos, tos.map((_, i) => i + 1));
  assert.equal(tos[tos.length - 1], STORAGE_SCHEMA_VERSION);
});

test("v2 backfills time from date on stored records without a usable time", () => {
  const legacy = JSON.stringify({
    "msg_1": { model: "deepseek-v4-flash", workspaceID: "w", date: "2026-07-14", input: 372, cacheRead: 217984 },
  });
  const { patch } = planMigrations({ schemaVersion: 1, localImportData: legacy });
  assert.ok(patch.localImportData, "expected the map to be rewritten");
  const rec = JSON.parse(patch.localImportData)["msg_1"];
  assert.equal(rec.time, "2026-07-14T00:00:00.000Z");
  assert.equal(rec.v, 1);
});

test("v2 is idempotent: an already-normalized store is left alone", () => {
  const fixed = JSON.stringify({
    "msg_1": { model: "m", time: "2026-07-14T00:00:00.000Z", date: "2026-07-14", input: 1, v: 1 },
  });
  const { patch } = planMigrations({ schemaVersion: 1, localImportData: fixed });
  assert.deepEqual(patch, {});
});
