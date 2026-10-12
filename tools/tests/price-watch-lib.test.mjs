import { test } from "node:test";
import assert from "node:assert/strict";

import {
  snapshotFilename,
  isoFromWayback,
  modelsKey,
  assertNotSuspiciousShrink,
  isGeneratedSourceMirror,
  sourceMirrorDecision,
} from "../price-watch-lib.mjs";
import { parsePricingModels as parseDeepSeek } from "../../extension/vendors/deepseek-official/pricing-page.js";

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

// --- partial-scrape guard (price-watch.mjs) ----------------------------------

const snap = (ids) => ({ models: Object.fromEntries(ids.map((id) => [id, { label: id, entry: {} }])) });

test("assertNotSuspiciousShrink only rejects a count drop without the override", () => {
  assert.doesNotThrow(() => assertNotSuspiciousShrink(null, snap(["a"]), { source: "xai-official" })); // baseline
  assert.doesNotThrow(() => assertNotSuspiciousShrink(snap(["a"]), snap(["a", "b"]), { source: "xai-official" })); // growth
  assert.doesNotThrow(() => assertNotSuspiciousShrink(snap(["a", "b"]), snap(["b", "a"]), { source: "xai-official" })); // equal count
  assert.throws(() => assertNotSuspiciousShrink(snap(["a", "b"]), snap(["a"]), { source: "xai-official" }), /--allow-shrink/);
  assert.doesNotThrow(() => assertNotSuspiciousShrink(snap(["a", "b"]), snap(["a"]), { source: "xai-official", allowShrink: true })); // override
});

test("assertNotSuspiciousShrink names the dropped ids and the exact re-run command", () => {
  assert.throws(
    () => assertNotSuspiciousShrink(snap(["a", "b", "c"]), snap(["a"]), { source: "xai-official" }),
    (e) =>
      /refusing to write/.test(e.message) &&
      /dropped 2: b, c/.test(e.message) &&
      /node tools\/price-watch\.mjs --source xai-official --allow-shrink/.test(e.message),
  );
});

test("assertNotSuspiciousShrink treats an empty baseline object as no previous snapshot", () => {
  assert.doesNotThrow(() => assertNotSuspiciousShrink({ models: {} }, snap(["a"]), { source: "xai-official" }));
});

// --- deepseek min-model floor (live layout only) -----------------------------

// One-model copy of the live peak/off-peak layout: below the floor of 2.
const DS_ONE_MODEL_PEAK = `<table><tbody>
<tr><td colspan="3">MODEL</td><td>deepseek-v4-flash(1)</td></tr>
<tr><td rowspan="2">1M INPUT TOKENS<br>(CACHE HIT)</td><td>OFF-PEAK</td><td>$0.003</td></tr>
<tr><td>PEAK</td><td>$0.006</td></tr>
<tr><td rowspan="2">1M INPUT TOKENS<br>(CACHE MISS)</td><td>OFF-PEAK</td><td>$0.15</td></tr>
<tr><td>PEAK</td><td>$0.3</td></tr>
<tr><td rowspan="2">1M OUTPUT TOKENS</td><td>OFF-PEAK</td><td>$0.6</td></tr>
<tr><td>PEAK</td><td>$1.2</td></tr>
</tbody></table>`;

// Legacy single-model flat page: exempt from the floor (Wayback backfill).
const DS_ONE_MODEL_FLAT = `<table><tbody>
<tr><td colspan="3">MODEL</td><td>deepseek-chat</td></tr>
<tr><td>CACHE HIT</td><td>$0.0028</td></tr>
<tr><td>CACHE MISS</td><td>$0.14</td></tr>
<tr><td>OUTPUT</td><td>$0.28</td></tr>
</tbody></table>`;

test("deepseek parser rejects a live-layout parse below the min-model floor", () => {
  assert.throws(() => parseDeepSeek(DS_ONE_MODEL_PEAK), /only 1 models \(<2\)/);
});

test("deepseek parser still parses a legacy single-model flat archive page", () => {
  const models = parseDeepSeek(DS_ONE_MODEL_FLAT);
  assert.deepEqual(Object.keys(models), ["deepseek-chat"]);
});

// --- rates.source.json write policy ------------------------------------------

const mirrorText = (source, models) => JSON.stringify({ source, models }, null, 2) + "\n";
const generatedModel = (id) => ({ model: id, label: id, rates: [{ from: null, pricing: { flat: {} } }] });

test("sourceMirrorDecision writes an absent file, a no-op, or a generated mirror", () => {
  const next = mirrorText("xai-official", [generatedModel("grok-4.7")]);
  assert.deepEqual(sourceMirrorDecision(null, next, "xai-official"), { write: true, reason: "absent" });
  assert.deepEqual(sourceMirrorDecision(next, next, "xai-official"), { write: false, reason: "unchanged" });
  const older = mirrorText("xai-official", [generatedModel("grok-4.6")]);
  assert.deepEqual(sourceMirrorDecision(older, next, "xai-official"), { write: true, reason: "regenerate" });
});

test("sourceMirrorDecision refuses to clobber a hand-authored source file", () => {
  const next = mirrorText("xai-official", [generatedModel("grok-4.7")]);
  // opencode-style: no per-model `label` -> not a generated mirror.
  const foreign = mirrorText("xai-official", [{ model: "grok-4.7", rates: [{ from: null, pricing: {} }] }]);
  assert.deepEqual(sourceMirrorDecision(foreign, next, "xai-official"), { write: false, reason: "foreign" });
  assert.deepEqual(sourceMirrorDecision("not json", next, "xai-official"), { write: false, reason: "foreign" });
});

test("isGeneratedSourceMirror only accepts this generator's own shape", () => {
  assert.equal(isGeneratedSourceMirror("not json", "xai-official"), false);
  assert.equal(isGeneratedSourceMirror(mirrorText("opencode", [generatedModel("m")]), "xai-official"), false); // source mismatch
  assert.equal(isGeneratedSourceMirror(mirrorText("xai-official", [{ model: "m", rates: [] }]), "xai-official"), false); // no label, empty rates
  assert.equal(
    isGeneratedSourceMirror(mirrorText("xai-official", [generatedModel("m")]), "xai-official"),
    true,
  );
});
