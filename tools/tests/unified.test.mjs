import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  normalizeUnifiedPricing,
  validateUnifiedPricing,
  buildUnifiedIndex,
  priceUnified,
  unifiedRateModels,
  modelsInGroup,
} from "../../extension/shared/unified.js";

const RATE_A = { from: null, pricing: { flat: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } } };
const RATE_B = {
  from: "2026-09-10T03:05:41Z",
  windows: { peak: [{ days: [1, 2, 3, 4, 5], start: "01:00", end: "04:00" }] },
  pricing: {
    peak: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
    offpeak: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
  },
};

test("normalizeUnifiedPricing coerces the shape and drops dangling assignments", () => {
  const out = normalizeUnifiedPricing({
    enabled: true,
    groups: [{ id: "cheap", rates: [RATE_A] }, { id: "cheap", rates: [RATE_A] }, {}],
    assign: { "opencode:m": "cheap", "mimo:x": "ghost" },
  });
  assert.equal(out.enabled, true);
  assert.equal(out.groups.length, 3);
  assert.equal(new Set(out.groups.map((g) => g.id)).size, 3); // duplicate id made unique
  assert.deepEqual(out.assign, { "opencode:m": "cheap" });
});

test("normalizeUnifiedPricing handles null/empty", () => {
  assert.deepEqual(normalizeUnifiedPricing(null), { enabled: false, groups: [], assign: {} });
});

test("buildUnifiedIndex maps source:model to its group rates", () => {
  const unified = normalizeUnifiedPricing({
    groups: [{ id: "g1", rates: [RATE_A] }],
    assign: { "opencode:m": "g1", "deepseek-official:m": "g1" },
  });
  const index = buildUnifiedIndex(unified);
  assert.equal(index.size, 2);
  assert.deepEqual(index.get("deepseek-official:m"), [RATE_A]);
});

test("priceUnified bills tokens against the assigned group (no fallback)", () => {
  const unified = normalizeUnifiedPricing({
    enabled: true,
    groups: [{ id: "g1", rates: [RATE_A] }],
    assign: { "opencode:m": "g1" },
  });
  const index = buildUnifiedIndex(unified);
  const priced = priceUnified({ source: "opencode", model: "m", time: "2026-09-11T12:00:00Z", input: 1000000 }, index);
  assert.equal(priced.unpriced, false);
  assert.equal(priced.priceBasis, "unified");
  assert.equal(priced.cost, 1);
  assert.equal(priced.targetId, "opencode:m");

  const missing = priceUnified({ source: "opencode", model: "other", time: "2026-09-11T12:00:00Z", input: 1000000 }, index);
  assert.equal(missing.unpriced, true);
  assert.equal(missing.cost, 0);
  assert.equal(missing.priceBasis, "unmapped");
});

test("priceUnified applies the version chain and peak window", () => {
  const unified = normalizeUnifiedPricing({
    groups: [{ id: "g", rates: [RATE_A, RATE_B] }],
    assign: { "deepseek-official:deepseek-v4-flash": "g" },
  });
  const index = buildUnifiedIndex(unified);
  const rec = { source: "deepseek-official", model: "deepseek-v4-flash", input: 1000000 };
  assert.equal(priceUnified({ ...rec, time: "2026-09-11T02:00:00Z" }, index).cost, 0.3); // peak
  assert.equal(priceUnified({ ...rec, time: "2026-09-11T12:00:00Z" }, index).cost, 0.15); // offpeak
  assert.equal(priceUnified({ ...rec, time: "2026-09-01T12:00:00Z" }, index).cost, 1); // pre-version, flat
});

test("validateUnifiedPricing flags bad groups, duplicate ids, dangling assign and bad rates", () => {
  assert.deepEqual(validateUnifiedPricing({ groups: [{ id: "g", rates: [RATE_A] }], assign: { "s:m": "g" } }), []);
  assert.ok(validateUnifiedPricing("nope").length > 0);
  assert.ok(validateUnifiedPricing({ groups: [{ id: "g", rates: [RATE_A] }, { id: "g", rates: [RATE_A] }] }).some((e) => /duplicated/.test(e)));
  assert.ok(validateUnifiedPricing({ groups: [{ id: "g", rates: [] }] }).some((e) => /rate version/.test(e)));
  assert.ok(validateUnifiedPricing({ groups: [], assign: { "s:m": "ghost" } }).some((e) => /missing group/.test(e)));
});

test("shipped unified preset is valid and folds vendors together", () => {
  const preset = JSON.parse(fs.readFileSync(new URL("../../extension/shared/unified.preset.json", import.meta.url)));
  assert.deepEqual(validateUnifiedPricing(preset), []);
  const index = buildUnifiedIndex(normalizeUnifiedPricing(preset));
  // Same underlying model from two vendors resolves to the same group rates.
  assert.deepEqual(index.get("opencode:deepseek-v4.1-flash"), index.get("deepseek-official:deepseek-v4-flash"));
  // A free variant is priced (not forced to $0): it shares its paid sibling's group.
  assert.deepEqual(index.get("opencode:hy3-free"), index.get("opencode:hy3"));
});

test("unifiedRateModels and modelsInGroup expose assignments", () => {
  const unified = normalizeUnifiedPricing({
    groups: [{ id: "g", rates: [RATE_A] }],
    assign: { "opencode:m": "g", "deepseek-official:m": "g" },
  });
  assert.deepEqual(modelsInGroup(unified, "g"), ["deepseek-official:m", "opencode:m"]);
  const rules = unifiedRateModels(unified);
  assert.equal(rules.length, 1); // deduped by model name
  assert.equal(rules[0].model, "m");
  assert.deepEqual(rules[0].rates, [RATE_A]);
});
