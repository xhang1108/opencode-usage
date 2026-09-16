import { test } from "node:test";
import assert from "node:assert/strict";

import { extractBundleUrl, parseMimoPrices, snapshotFromBundle } from "../../extension/vendors/mimo/pricing-page.js";
import { versionsFromSnapshots, presetFromVersions } from "../../extension/shared/price-history.js";

const BUNDLE = `prefix \\"model_pro_desc\\":\\"Input (Cache Hit): $0.0036 | Input (Cache Miss): $0.435 | Output: $0.87 (Per 1M tokens)\\",\\"model_v25_desc\\":\\"Input (Cache Hit): $0.0028 | Input (Cache Miss): $0.14 | Output: $0.28 (Per 1M tokens)\\" suffix`;

test("extractBundleUrl finds the main chunk", () => {
  const html = `<link rel="preload" href="/static/main.0f5fbb20f2600056.chunk.js" as="script">`;
  assert.equal(extractBundleUrl(html), "/static/main.0f5fbb20f2600056.chunk.js");
  assert.equal(extractBundleUrl("<html></html>"), null);
});

test("parseMimoPrices extracts official USD prices", () => {
  const models = parseMimoPrices(BUNDLE);
  assert.deepEqual(Object.keys(models).sort(), ["mimo-v2.5", "mimo-v2.5-pro"]);
  assert.deepEqual(models["mimo-v2.5-pro"].entry.pricing.flat, { input: 0.435, output: 0.87, cacheRead: 0.0036, cacheWrite: 0 });
  assert.deepEqual(models["mimo-v2.5"].entry.pricing.flat, { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 });
});

test("parseMimoPrices throws when no prices are present", () => {
  assert.throws(() => parseMimoPrices("nothing here"));
});

test("MiMo snapshots build a dated preset", () => {
  const s1 = snapshotFromBundle(BUNDLE, "2026-05-27T00:00:00.000Z");
  const state = versionsFromSnapshots([s1]);
  const preset = presetFromVersions(state, { source: "mimo" });
  const id = preset.modelMap["mimo:mimo-v2.5-pro"];
  assert.equal(id, "mimo:mimo-v2.5-pro");
  assert.equal(preset.targets[id].rates[0].from, null);
  assert.equal(preset.targets[id].rates[0].pricing.flat.output, 0.87);
});
