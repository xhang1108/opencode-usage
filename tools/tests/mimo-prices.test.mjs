import { test } from "node:test";
import assert from "node:assert/strict";

import { parseMimoPrices, snapshotFromPage } from "../../extension/vendors/mimo/pricing-page.js";
import { versionsFromSnapshots, presetFromVersions } from "../../extension/shared/price-history.js";

// Shape of GET /api/v1/models (trimmed). pricing is per-token USD; mimo-v2-pro
// is tiered via an ordered array with min_context on the higher tier; a
// non-mimo id must be skipped.
const API = JSON.stringify({
  data: [
    {
      id: "xiaomi/mimo-v2.5-pro",
      pricing: { prompt: "0.000000435", completion: "0.00000087", input_cache_read: "0.0000000036" },
    },
    {
      id: "xiaomi/mimo-v2.5",
      pricing: { prompt: "0.00000014", completion: "0.00000028", input_cache_read: "0.0000000028" },
    },
    {
      id: "xiaomi/mimo-v2.6-pro",
      pricing: { prompt: "0.000000435", completion: "0.00000087", input_cache_read: "0.0000000036" },
    },
    // no input_cache_read key -> cacheRead falls back to 0
    { id: "xiaomi/mimo-v2.6-flash", pricing: { prompt: "0.00000014", completion: "0.00000028" } },
    {
      id: "xiaomi/mimo-v2-pro",
      pricing: [
        { prompt: "0.000001", completion: "0.000003", input_cache_read: "0.0000002" },
        { prompt: "0.000002", completion: "0.000006", input_cache_read: "0.0000004", min_context: 256000 },
      ],
    },
    // live quirk: output BELOW input (multimodal input > text output) is legal
    {
      id: "xiaomi/mimo-v2-omni",
      pricing: { prompt: "0.0000004", completion: "0.0000002", input_cache_read: "0.00000008" },
    },
    { id: "someone-else/not-mimo", pricing: { prompt: "9", completion: "9" } },
  ],
});

test("parseMimoPrices strips the vendor prefix and converts per-token USD to per 1M", () => {
  const models = parseMimoPrices(API);
  assert.deepEqual(Object.keys(models).sort(), [
    "mimo-v2-omni",
    "mimo-v2-pro",
    "mimo-v2.5",
    "mimo-v2.5-pro",
    "mimo-v2.6-flash",
    "mimo-v2.6-pro",
  ]);
  assert.deepEqual(models["mimo-v2.5-pro"].entry.pricing.flat, {
    input: 0.435,
    output: 0.87,
    cacheRead: 0.0036,
    cacheWrite: 0,
  });
  assert.deepEqual(models["mimo-v2.5"].entry.pricing.flat, {
    input: 0.14,
    output: 0.28,
    cacheRead: 0.0028,
    cacheWrite: 0,
  });
  assert.deepEqual(models["mimo-v2.6-flash"].entry.pricing.flat, {
    input: 0.14,
    output: 0.28,
    cacheRead: 0,
    cacheWrite: 0,
  });
});

test("parseMimoPrices maps the tiered array (min_context) onto flat.tier", () => {
  const models = parseMimoPrices(API);
  assert.deepEqual(models["mimo-v2-pro"].entry.pricing.flat.tier, {
    limit: 256000,
    low: { input: 1, output: 3, cacheRead: 0.2, cacheWrite: 0 },
    high: { input: 2, output: 6, cacheRead: 0.4, cacheWrite: 0 },
  });
});

test("mimo allows output < input (omni) but fail-closes on drift", () => {
  const models = parseMimoPrices(API);
  assert.deepEqual(models["mimo-v2-omni"].entry.pricing.flat, {
    input: 0.4,
    output: 0.2,
    cacheRead: 0.08,
    cacheWrite: 0,
  });

  assert.throws(() => parseMimoPrices("not json"), /invalid JSON/);
  assert.throws(() => parseMimoPrices('{"models":[]}'), /no data\[\]/);
  assert.throws(() => parseMimoPrices('{"data":[]}'), /only 0 models \(<5\)/);
  assert.throws(
    () => parseMimoPrices(API.replace("mimo-v2.5-pro", "mimo-v9.9-pro")),
    /anchor model mimo-v2.5-pro missing/,
  );

  // drop three models -> below MIN_MODELS=5
  const few = JSON.parse(API);
  few.data = few.data.filter((m) =>
    ["xiaomi/mimo-v2.5-pro", "xiaomi/mimo-v2.5", "xiaomi/mimo-v2-pro"].includes(m.id),
  );
  assert.throws(() => parseMimoPrices(JSON.stringify(few)), /only 3 models \(<5\)/);

  // zero prompt -> insane
  assert.throws(() => parseMimoPrices(API.replace('"0.000000435"', '"0"')), /insane prices/);
  // unit drift (per-1M numbers where per-token expected) -> exceeds MAX_LEG
  assert.throws(() => parseMimoPrices(API.replace(/"0\.000000(\d{2,})"/g, '"0.435"')), /insane prices/);

  // tier array whose higher element lost min_context
  const noCtx = JSON.parse(API);
  delete noCtx.data.find((m) => m.id === "xiaomi/mimo-v2-pro").pricing[1].min_context;
  assert.throws(() => parseMimoPrices(JSON.stringify(noCtx)), /tier without min_context/);
});

test("MiMo snapshots build a dated preset", () => {
  const s1 = snapshotFromPage(API, "2026-05-27T00:00:00.000Z");
  assert.equal(s1.source, "mimo");
  assert.equal(s1.capturedAt, "2026-05-27T00:00:00.000Z");
  const state = versionsFromSnapshots([s1]);
  const preset = presetFromVersions(state, { source: "mimo" });
  const id = preset.modelMap["mimo:mimo-v2.5-pro"];
  assert.equal(id, "mimo:mimo-v2.5-pro");
  assert.equal(preset.targets[id].rates[0].from, null);
  assert.equal(preset.targets[id].rates[0].pricing.flat.output, 0.87);
});
