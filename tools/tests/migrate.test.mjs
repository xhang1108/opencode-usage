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
