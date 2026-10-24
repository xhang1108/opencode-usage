import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  extractIds,
  extractModels,
  diffModels,
  loadSnapshot,
  snapshotContent,
  snapshotIds,
  summaryMarkdown,
  assertNotSuspiciousShrink,
  watchOne,
} from "../model-watch.mjs";

const list = (ids) => ({ object: "list", data: ids.map((id) => ({ id, object: "model" })) });

test("extractIds sorts, dedupes and drops blank ids", () => {
  const ids = extractIds(list(["b", "a", "b", "  ", "c"]));
  assert.deepEqual(ids, ["a", "b", "c"]);
});

test("extractModels keeps the display name next to a routing id", () => {
  const models = extractModels({
    object: "list",
    data: [
      { id: "nvidia/nemotron-3-ultra-550b-a55b", name: "Nemotron 3 Ultra" },
      { id: "MiniMaxAI/MiniMax-M3", name: "MiniMax M3" },
      { id: "bare-id" },
      { id: "nvidia/nemotron-3-ultra-550b-a55b", name: "duplicate ignored" },
    ],
  });
  assert.deepEqual(models, [
    { id: "MiniMaxAI/MiniMax-M3", name: "MiniMax M3" },
    { id: "bare-id", name: "" },
    { id: "nvidia/nemotron-3-ultra-550b-a55b", name: "Nemotron 3 Ultra" },
  ]);
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
      { label: "second Source", total: 81, baseline: true, changed: false, added: [], removed: [] },
    ],
    [{ source: "second", message: "HTTP 500" }]
  );
  assert.match(md, /## Model watch/);
  assert.match(md, /\| opencode Go \| 42 \| 1 \| 0 \| changed \|/);
  assert.match(md, /\| second Source \| 81 \| - \| - \| baseline \|/);
  assert.match(md, /`grok-4\.7`/);
  assert.match(md, /baseline established \(81 models\)/);
  assert.match(md, /second: FAILED.*HTTP 500/);
});

// A stubbed fetch that yields a parsed payload, so watchOne can be driven
// without the network.
const stubFetch = (ids) => async () => extractIds(list(ids));

test("assertNotSuspiciousShrink only rejects a count drop without the override", () => {
  assert.equal(assertNotSuspiciousShrink(null, ["a"], {}), null); // baseline
  assert.equal(assertNotSuspiciousShrink(["a"], ["a", "b"], {}), null); // growth
  assert.equal(assertNotSuspiciousShrink(["a", "b"], ["b", "a"], {}), null); // equal count
  assert.throws(
    () => assertNotSuspiciousShrink(["a", "b"], ["a"], { source: "opencode" }),
    /--source opencode --allow-shrink/
  );
  assert.deepEqual(assertNotSuspiciousShrink(["a", "b"], ["a"], { allowShrink: true }).removed, ["b"]);
});

test("assertNotSuspiciousShrink returns the verdict instead of throwing for a warn source", () => {
  const verdict = assertNotSuspiciousShrink(["a", "b", "c"], ["a"], { policy: "warn", source: "opencode" });
  assert.deepEqual(verdict.removed, ["b", "c"]);
  assert.match(verdict.message, /dropped 3 -> 1/);
  // A warn source still reports growth-free drops as null.
  assert.equal(assertNotSuspiciousShrink(["a"], ["a", "b"], { policy: "warn" }), null);
});

test("watchOne keeps names for a names source and diffs by id", async () => {
  const dir = mkdtempSync(join(tmpdir(), "model-watch-"));
  try {
    const path = join(dir, "models.snapshot.json");
    const fetchNames = async () => extractModels({
      object: "list",
      data: [
        { id: "lab/model-a", name: "Model A" },
        { id: "lab/model-b", name: "Model B" },
      ],
    });

    const first = await watchOne("commandcode", { path, fetchIds: fetchNames });
    assert.equal(first.wrote, true);
    assert.equal(first.baseline, true);
    assert.deepEqual(loadSnapshot(path).models, [
      { id: "lab/model-a", name: "Model A" },
      { id: "lab/model-b", name: "Model B" },
    ]);

    // Same ids, one renamed: the set did not change, so the snapshot is a no-op
    // (the name is a display label, not a priced fact).
    const before = readFileSync(path, "utf8");
    const renamed = async () => extractModels({
      object: "list",
      data: [
        { id: "lab/model-a", name: "Model A (new label)" },
        { id: "lab/model-b", name: "Model B" },
      ],
    });
    const second = await watchOne("commandcode", { path, fetchIds: renamed });
    assert.equal(second.changed, false);
    assert.equal(readFileSync(path, "utf8"), before);

    // snapshotIds reads both shapes.
    assert.deepEqual(snapshotIds(loadSnapshot(path)), ["lab/model-a", "lab/model-b"]);
    assert.deepEqual(snapshotIds({ models: ["x", "y"] }), ["x", "y"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("watchOne refuses a short payload and leaves the snapshot untouched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "model-watch-"));
  try {
    const path = join(dir, "models.snapshot.json");
    writeFileSync(path, snapshotContent(["a", "b", "c"], "2026-09-24T00:00:00.000Z"));
    const before = readFileSync(path, "utf8");

    await assert.rejects(
      watchOne("opencode", { path, fetchIds: stubFetch(["a", "b"]), shrink: "block" }),
      (e) => /refusing to write/.test(e.message) && /removed 1: c/.test(e.message) && /--source opencode --allow-shrink/.test(e.message)
    );
    assert.equal(readFileSync(path, "utf8"), before); // no overwrite
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("watchOne records a drop for a warn source instead of failing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "model-watch-"));
  try {
    const path = join(dir, "models.snapshot.json");
    writeFileSync(path, snapshotContent(["a", "b", "c"], "2026-09-24T00:00:00.000Z"));

    // opencode is the warn source: the drop is written and reported, not thrown.
    const r = await watchOne("opencode", { path, fetchIds: stubFetch(["a", "b"]) });
    assert.equal(r.wrote, true);
    assert.deepEqual(r.removed, ["c"]);
    assert.deepEqual(r.shrink.removed, ["c"]);
    assert.deepEqual(loadSnapshot(path).models, ["a", "b"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("watchOne is a byte-for-byte no-op when the set is unchanged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "model-watch-"));
  try {
    const path = join(dir, "models.snapshot.json");
    writeFileSync(path, snapshotContent(["a", "b"], "2026-09-24T00:00:00.000Z"));
    const before = readFileSync(path, "utf8");

    const r = await watchOne("opencode", { path, fetchIds: stubFetch(["b", "a"]) });
    assert.equal(r.wrote, false);
    assert.equal(r.changed, false);
    assert.equal(r.shrink, null);
    assert.equal(readFileSync(path, "utf8"), before); // capturedAt preserved
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("watchOne lets a legitimate drop through with allowShrink", async () => {
  const dir = mkdtempSync(join(tmpdir(), "model-watch-"));
  try {
    const path = join(dir, "models.snapshot.json");
    writeFileSync(path, snapshotContent(["a", "b", "c"], "2026-09-24T00:00:00.000Z"));

    const r = await watchOne("opencode", { path, fetchIds: stubFetch(["a", "b"]), shrink: "block", allowShrink: true });
    assert.equal(r.wrote, true);
    assert.equal(r.changed, true);
    assert.deepEqual(r.removed, ["c"]);
    assert.deepEqual(loadSnapshot(path).models, ["a", "b"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
