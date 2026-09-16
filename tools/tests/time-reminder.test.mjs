import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  collectPeakWindows,
  collectPeakWindowsForModel,
  listPeakModels,
  isPeakAt,
} from "../../extension/shared/time-reminder.js";
import { normalizeUnifiedPricing, unifiedRateModels } from "../../extension/shared/unified.js";

const FLAT = { from: null, pricing: { flat: { input: 0.14, output: 0.28, cacheRead: 0.028, cacheWrite: 0 } } };
const PROMO = {
  from: "2025-02-26T00:00:00.000Z",
  until: "2025-09-05T16:00:00.000Z",
  windows: { peak: [{ days: [], start: "00:30", end: "16:30" }] },
  pricing: {
    peak: { input: 0.27, output: 1.1, cacheRead: 0.07, cacheWrite: 0 },
    offpeak: { input: 0.135, output: 0.55, cacheRead: 0.035, cacheWrite: 0 },
  },
};
const AFTER = { from: "2025-09-05T16:00:00.000Z", pricing: { flat: { input: 0.56, output: 1.68, cacheRead: 0.07, cacheWrite: 0 } } };

const RETIRED = { model: "deepseek-chat", rates: [FLAT, PROMO, AFTER] };
const LIVE = {
  model: "deepseek-v4-flash",
  rates: [
    { from: null, pricing: { flat: { input: 0.14, output: 0.28, cacheRead: 0.028, cacheWrite: 0 } } },
    {
      from: "2026-09-10T04:00:00.000Z",
      windows: { peak: [{ days: [1, 2, 3, 4, 5], start: "01:00", end: "04:00" }] },
      pricing: {
        peak: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
        offpeak: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
      },
    },
  ],
};
const MODELS = [RETIRED, LIVE];

const DURING_PROMO = new Date("2025-06-01T00:00:00Z");
const NOW = new Date("2026-09-15T07:12:00Z");

test("listPeakModels lists only models that bill peak/off-peak at that moment", () => {
  assert.deepEqual(listPeakModels(MODELS, NOW), ["deepseek-v4-flash"]);
  assert.deepEqual(listPeakModels(MODELS, DURING_PROMO), ["deepseek-chat"]);
});

test("listPeakModels drops a model whose current version is flat (promo superseded)", () => {
  // Between the promo end and the (never published) next peak change there is no
  // peak pricing at all, even though the promo window is still in the history.
  assert.deepEqual(listPeakModels(MODELS, new Date("2026-01-01T00:00:00Z")), []);
});

test("collectPeakWindowsForModel uses the version in force, not the union of history", () => {
  assert.deepEqual(collectPeakWindowsForModel(MODELS, "deepseek-chat", NOW), []);
  assert.deepEqual(collectPeakWindowsForModel(MODELS, "deepseek-chat", DURING_PROMO), [{ days: [], start: "00:30", end: "16:30" }]);
  assert.deepEqual(collectPeakWindowsForModel(MODELS, "deepseek-v4-flash", NOW), [{ days: [1, 2, 3, 4, 5], start: "01:00", end: "04:00" }]);
  assert.deepEqual(collectPeakWindowsForModel(MODELS, "missing", NOW), []);
});

test("collectPeakWindows unions the windows in force across models", () => {
  assert.deepEqual(collectPeakWindows(MODELS, DURING_PROMO), [{ days: [], start: "00:30", end: "16:30" }]);
  assert.equal(collectPeakWindows(MODELS, NOW).length, 1);
});

test("isPeakAt agrees with the period-limited windows", () => {
  // 2025-06-01T00:45Z is inside the old promo window; the same clock time today
  // is not, because that window no longer applies.
  assert.equal(isPeakAt(new Date("2025-06-01T00:45:00Z"), collectPeakWindows(MODELS, DURING_PROMO)), true);
  assert.equal(isPeakAt(new Date("2026-09-15T00:45:00Z"), collectPeakWindows(MODELS, NOW)), false);
});

// The regression that started this: the picker listed 13 DeepSeek entries, of
// which chat/coder/reasoner were withdrawn (2026-04-24, when V4 shipped — their
// last snapshot appearance is 2025-09-29) and eight were aliases of two groups.
test("shipped preset: one picker entry per group, withdrawn models dropped", () => {
  const preset = JSON.parse(fs.readFileSync(new URL("../../extension/shared/unified.preset.json", import.meta.url)));
  const rules = unifiedRateModels(normalizeUnifiedPricing(preset));
  assert.deepEqual(listPeakModels(rules, NOW), ["deepseek-4-flash", "deepseek-4-pro"]);
  // Historically they did have a promo window, so the data is still there.
  assert.equal(collectPeakWindowsForModel(rules, "deepseek-chat", DURING_PROMO).length, 1);
  assert.equal(collectPeakWindowsForModel(rules, "deepseek-chat", NOW).length, 0);
});
