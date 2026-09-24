import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extractIds, diffModels, loadSnapshot, snapshotContent, summaryMarkdown } from "../model-watch.mjs";

const list = (ids) => ({ object: "list", data: ids.map((id) => ({ id, object: "model" })) });

test("extractIds sorts, dedupes and drops blank ids", () => {
  const ids = extractIds(list(["b", "a", "b", "  ", "c"]));
  assert.deepEqual(ids, ["a", "b", "c"]);
});

test("extractIds keeps provider-prefixed ids verbatim", () => {
  assert.deepEqual(extractIds(list(["deepseek/deepseek-v4-flash"])), ["deepseek/deepseek-v4-flash"]);
});

test("extractIds fail-closes on malformed or empty payloads", () => {
  assert.throws(() => extractIds(null), /data\[\]/);
  assert.throws(() => extractIds({}), /data\[\]/);
  assert.throws(() => extractIds({ data: [] }), /no model ids/);
  assert.throws(() => extractIds({ data: [{ name: "no id" }] }), /no model ids/);
});

test("diffModels reports added and removed regardless of order", () => {
  const d = diffModels(["a", "b", "c"], ["c", "a", "d"]);
  assert.equal(d.changed, true);
  assert.deepEqual(d.added, ["d"]);
  assert.deepEqual(d.removed, ["b"]);
  assert.equal(d.baseline, false);
});

test("diffModels reports no change for an identical set", () => {
  const d = diffModels(["a", "b"], ["b", "a"]);
  assert.equal(d.changed, false);
  assert.deepEqual(d.added, []);
  assert.deepEqual(d.removed, []);
});

test("diffModels treats a missing snapshot as baseline, not mass-add", () => {
  const d = diffModels(null, ["a", "b"]);
  assert.equal(d.baseline, true);
  assert.equal(d.changed, false);
  assert.deepEqual(d.added, []);
  assert.deepEqual(d.removed, []);
});

test("loadSnapshot returns null when absent and validates shape", () => {
  const dir = mkdtempSync(join(tmpdir(), "model-watch-"));
  try {
    const missing = join(dir, "models.snapshot.json");
    assert.equal(loadSnapshot(missing), null);

    const path = join(dir, "models.snapshot.json");
    writeFileSync(path, snapshotContent(["m1", "m2"], "2026-09-24T00:00:00.000Z"));
    const snap = loadSnapshot(path);
    assert.deepEqual(snap.models, ["m1", "m2"]);
    assert.equal(snap.capturedAt, "2026-09-24T00:00:00.000Z");

    writeFileSync(path, JSON.stringify({ capturedAt: "x" }));
    assert.throws(() => loadSnapshot(path), /models\[\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("summaryMarkdown lists changes and failures, skips quiet results", () => {
  const md = summaryMarkdown(
    [
      { label: "opencode Go", total: 42, baseline: false, changed: true, added: ["grok-4.7"], removed: [] },
      { label: "CommandCode", total: 81, baseline: true, changed: false, added: [], removed: [] },
    ],
    [{ source: "commandcode", message: "HTTP 500" }]
  );
  assert.match(md, /## Model watch/);
  assert.match(md, /\| opencode Go \| 42 \| 1 \| 0 \| changed \|/);
  assert.match(md, /\| CommandCode \| 81 \| - \| - \| baseline \|/);
  assert.match(md, /`grok-4\.7`/);
  assert.match(md, /baseline established \(81 models\)/);
  assert.match(md, /commandcode: FAILED.*HTTP 500/);
});
