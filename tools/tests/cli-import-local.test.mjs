import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { argValue, defaultDbPath, baseName, toLocalDate, collectRecords } from "../import-local.mjs";

test("baseName returns the last path segment for posix and windows paths", () => {
  assert.equal(baseName("/a/b/c"), "c");
  assert.equal(baseName("D:\\a\\b"), "b");
  assert.equal(baseName("D:/a/b"), "b");
  assert.equal(baseName("/a/b/"), "b");
  assert.equal(baseName("D:\\a\\b\\"), "b");
  assert.equal(baseName("no-slash"), "no-slash");
  assert.equal(baseName(""), "");
  assert.equal(baseName(null), "");
  assert.equal(baseName(undefined), "");
  assert.equal(baseName("/"), "");
});

test("toLocalDate formats a Date by its local components", () => {
  assert.equal(toLocalDate(new Date(2026, 8, 13, 7, 30, 2)), "2026-09-13");
  assert.equal(toLocalDate(new Date(2026, 0, 5)), "2026-01-05");
});

test("argValue reads a flag value and tolerates missing values", () => {
  assert.equal(argValue("--db", ["node", "tool", "--db", "C:/db.sqlite"]), "C:/db.sqlite");
  assert.equal(argValue("--out", ["node", "tool", "--db", "x"]), null);
  assert.equal(argValue("--db", ["node", "tool", "--db"]), null);
});

test("defaultDbPath points at the opencode local database", () => {
  assert.ok(defaultDbPath().replace(/\\/g, "/").endsWith(".local/share/opencode/opencode.db"));
});

function buildFixture() {
  const dir = mkdtempSync(join(tmpdir(), "import-local-test-"));
  const db = new DatabaseSync(join(dir, "opencode.db"));
  db.exec("CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, directory TEXT)");
  db.exec("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT)");

  const insertSession = db.prepare("INSERT INTO session (id, project_id, directory) VALUES (?, ?, ?)");
  const insertMessage = db.prepare("INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)");

  insertSession.run("s1", "proj1abcdefghi", "D:/work/alpha");
  insertSession.run("s2", "proj2", "D:/work/beta/");
  insertSession.run("s3", "", "");

  const time = new Date(2026, 8, 13, 10, 0, 0).getTime();
  const at = { created: time };
  insertMessage.run("m1", "s1", JSON.stringify({ role: "assistant", modelID: "deepseek-v4", cost: 0.123, tokens: { input: 10, output: 20, reasoning: 3, cache: { read: 5, write: 7 } }, time: at }));
  insertMessage.run("m2", "s1", JSON.stringify({ role: "user", modelID: "ignored", tokens: { input: 1 }, time: at }));
  insertMessage.run("m3", "s1", JSON.stringify({ role: "assistant", modelID: "deepseek-v4", tokens: { input: 0, output: 0 }, time: at }));
  insertMessage.run("m4", "s1", "{not json");
  insertMessage.run("m5", "s1", JSON.stringify({ role: "assistant", tokens: { input: 4, output: 0 }, time: at }));
  insertMessage.run("m6", "s1", JSON.stringify({ role: "assistant", modelID: "deepseek-v4", tokens: { input: 4, output: 0 }, time: { created: "not-a-date" } }));
  insertMessage.run("m7", "s2", JSON.stringify({ role: "assistant", modelID: "mimo", cost: "1.5", tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 11, write: 22 } }, time: at }));
  insertMessage.run("m8", "s3", JSON.stringify({ role: "assistant", modelID: "mimo", tokens: { input: 2 }, time: at }));
  insertMessage.run("m9", "s1", JSON.stringify({ role: "assistant", modelID: "deepseek-v4", tokens: { input: 2 }, time: {} }));

  const rows = db
    .prepare(
      `SELECT m.id AS mid, m.data AS mdata, s.directory AS dir, s.project_id AS pid
       FROM message m JOIN session s ON s.id = m.session_id`
    )
    .all();
  db.close();
  return { dir, rows, time };
}

test("collectRecords maps DB rows into the dashboard import map", (t) => {
  const { dir, rows, time } = buildFixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { out, skipped, sessions, models } = collectRecords(rows, { workspace: "Local", prefix: "local" });

  assert.deepEqual(Object.keys(out).sort(), ["m1", "m7", "m8"]);

  const r = out.m1;
  assert.equal(r.workspaceID, "Local");
  assert.equal(r.project, "local:alpha");
  assert.equal(r.directory, "D:/work/alpha");
  assert.equal(r.time, new Date(time).toISOString());
  assert.equal(r.date, "2026-09-13");
  assert.equal(r.model, "deepseek-v4");
  assert.equal(r.input, 10);
  assert.equal(r.output, 20);
  assert.equal(r.reasoning, 3);
  assert.equal(r.cacheRead, 5);
  assert.equal(r.cacheWrite5m, 7);
  assert.equal(r.cacheWrite1h, 0);
  assert.equal(r.vendorCost, 0.123);
  assert.equal(r.costScale, 1);

  assert.equal(out.m7.project, "local:beta");
  assert.equal(out.m7.directory, "D:/work/beta/");
  assert.equal(out.m7.cacheRead, 11);
  assert.equal(out.m7.cacheWrite5m, 22);
  assert.equal(out.m7.cacheWrite1h, 0);
  assert.equal(out.m7.vendorCost, undefined);

  assert.equal(out.m8.project, "local:unknown");
  assert.equal(out.m8.directory, "");

  // m4/m5/m6/m9 are the counted skips; m2 (user) and m3 (zero tokens) are
  // dropped silently by the original loop, so they are NOT part of `skipped`.
  assert.equal(skipped, 4);
  assert.deepEqual([...sessions].sort(), ["", "proj1abcdefghi", "proj2"]);
  assert.deepEqual([...models].sort(), ["deepseek-v4", "mimo"]);
});

test("collectRecords honours workspace and prefix options", (t) => {
  const { dir, rows } = buildFixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { out } = collectRecords(rows, { workspace: "W", prefix: "px" });
  assert.equal(out.m1.workspaceID, "W");
  assert.equal(out.m1.project, "px:alpha");
});

test("collectRecords is idempotent over the same rows", (t) => {
  const { dir, rows } = buildFixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const first = collectRecords(rows, { workspace: "Local", prefix: "local" });
  const second = collectRecords(rows, { workspace: "Local", prefix: "local" });
  assert.deepEqual(second, first);
});
