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
  resolveAssignKey,
  groupIdForKey,
} from "../../extension/shared/unified.js";
import { buildPricing } from "../../extension/shared/preset.js";
import { priceRecord } from "../../extension/shared/pricing.js";

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
  assert.deepEqual(normalizeUnifiedPricing(null), { enabled: true, groups: [], assign: {} });
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
  // The shipped default is ON: unified is the only price source (official
  // tables), so the vendorCost / go.mdx fallback path is never reached by
  // default and only an explicit toggle-off opts into it.
  assert.equal(preset.enabled, true);
  assert.equal(normalizeUnifiedPricing(preset).enabled, true);
  const index = buildUnifiedIndex(normalizeUnifiedPricing(preset));
  // Same underlying model from two vendors resolves to the same group rates.
  assert.deepEqual(index.get("opencode:deepseek-v4.1-flash"), index.get("deepseek-official:deepseek-v4-flash"));
  // A free variant is priced (not forced to $0): it shares its paid sibling's group.
  assert.deepEqual(index.get("opencode:hy3-free"), index.get("opencode:hy3"));
});

// An all-zero rate table is normally a free-trial PLACEHOLDER carrying no price,
// and the builder drops it (isZeroRates -> rank -1 -> skipped group). opencode
// Zen's Big Pickle is the opposite case: its official price genuinely IS $0, so
// the authored override has to win before that veto. Otherwise the model has no
// group at all and the dashboard shows "unknown" instead of "free".
test("an all-zero override prices as free, not as unknown", () => {
  const preset = JSON.parse(fs.readFileSync(new URL("../../extension/shared/unified.preset.json", import.meta.url)));
  const unified = normalizeUnifiedPricing(preset);
  const index = buildUnifiedIndex(unified);

  const group = preset.groups.find((g) => g.id === "big-pickle");
  assert.ok(group, "the free override keeps its group instead of being dropped");
  assert.deepEqual(group.rates, [
    { from: null, pricing: { flat: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } },
  ]);
  assert.equal(unified.assign["opencode:big-pickle"], "big-pickle");

  const priced = priceUnified(
    { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0, time: "2026-09-15T12:00:00Z", source: "opencode", model: "big-pickle" },
    index,
  );
  assert.equal(priced.unpriced, false, "free is a price, not an unmapped model");
  assert.equal(priced.cost, 0);

  // The veto still holds for every other source: vendor tables that ship a
  // free-trial 0 row must not turn into priced groups. big-pickle is the only
  // all-zero group in the shipped preset.
  const allZero = (rates) =>
    rates.every((r) => {
      const flat = r.pricing && r.pricing.flat;
      return flat && Object.values(flat).every((v) => v === 0);
    });
  assert.deepEqual(preset.groups.filter((g) => allZero(g.rates)).map((g) => g.id), ["big-pickle"]);
});

// A "-free" listing must share its paid sibling's group, so the free variant is
// billed at the same rate rather than falling out as unpriced. Nemotron-3-Ultra
// has no first-party price yet (NVIDIA quotes none per token), so this also
// pins the PROVISIONAL hosted rate — swap both assertions when the official row
// lands.
test("the free Nemotron listing shares its paid sibling's group and rate", () => {
  const preset = JSON.parse(fs.readFileSync(new URL("../../extension/shared/unified.preset.json", import.meta.url)));
  const unified = normalizeUnifiedPricing(preset);
  const index = buildUnifiedIndex(unified);

  const group = preset.groups.find((g) => g.id === "nemotron-3-ultra");
  assert.ok(group, "nemotron-3-ultra group exists");
  assert.deepEqual(group.rates, [
    { from: null, pricing: { flat: { input: 0.63, output: 3.13, cacheRead: 0.1, cacheWrite: 0 } } },
  ]);
  assert.equal(unified.assign["opencode:nemotron-3-ultra-free"], "nemotron-3-ultra");

  const rec = { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0, time: "2026-09-24T12:00:00Z" };
  const paid = priceUnified({ ...rec, source: "opencode", model: "nemotron-3-ultra" }, index);
  const free = priceUnified({ ...rec, source: "opencode", model: "nemotron-3-ultra-free" }, index);
  assert.equal(free.unpriced, false, "the free listing is priced, not unknown");
  assert.equal(free.cost, paid.cost, "free and paid bill at the same rate");
  assert.equal(free.cost, 0.63 + 3.13 + 0.1);
});

test("unifiedRateModels emits one rule per group, not per alias", () => {
  const unified = normalizeUnifiedPricing({
    groups: [{ id: "g", rates: [RATE_A] }, { id: "other", rates: [RATE_B] }],
    assign: {
      "opencode:m": "g",
      "deepseek-official:m": "g",
      "deepseek-official:m-flash-free": "g",
      "mimo:other": "other",
    },
  });
  assert.deepEqual(modelsInGroup(unified, "g"), ["deepseek-official:m", "deepseek-official:m-flash-free", "opencode:m"]);
  const rules = unifiedRateModels(unified);
  assert.equal(rules.length, 2); // the three aliases of "g" collapse into one
  const g = rules.find((r) => r.model === "g");
  assert.deepEqual(g.rates, [RATE_A]);
  assert.equal(rules.find((r) => r.model === "other").rates[0], RATE_B);
});

test("unifiedRateModels names an auto-generated group after its first model", () => {
  const unified = normalizeUnifiedPricing({
    groups: [{ id: "group-1", rates: [RATE_A] }],
    assign: { "opencode:zeta": "group-1", "opencode:alpha": "group-1" },
  });
  assert.deepEqual(unifiedRateModels(unified).map((r) => r.model), ["alpha"]);
});

test("unifiedRateModels skips groups no model points at", () => {
  const unified = normalizeUnifiedPricing({
    groups: [{ id: "g", rates: [RATE_A] }, { id: "orphan", rates: [RATE_A] }],
    assign: { "opencode:m": "g" },
  });
  assert.deepEqual(unifiedRateModels(unified).map((r) => r.model), ["g"]);
});

test("resolveAssignKey prefers the exact key, then the fingerprint fallback", () => {
  const assign = { "opencode:deepseek-v4-flash": "g", "fp:hy:3:base:": "h" };
  assert.equal(resolveAssignKey(assign, "opencode:deepseek-v4-flash"), "opencode:deepseek-v4-flash");
  assert.equal(resolveAssignKey(assign, "commandcode:tencent/hy3-paid"), "fp:hy:3:base:");
  assert.equal(resolveAssignKey(assign, "mystery:nope"), null);
  assert.equal(groupIdForKey(assign, "commandcode:tencent/hy3-paid"), "h");
  assert.equal(groupIdForKey(assign, "mystery:nope"), null);
});

test("the board agrees with pricing: structurally-priced vendor ids are assigned", () => {
  const preset = JSON.parse(fs.readFileSync(new URL("../../extension/shared/unified.preset.json", import.meta.url)));
  const unified = normalizeUnifiedPricing(preset);
  const index = buildUnifiedIndex(unified);
  const rec = { input: 1000000, output: 0, cacheRead: 0, cacheWrite: 0, time: "2026-09-15T12:00:00Z" };
  // Never enumerated in any preset table, yet structurally known.
  const ids = [
    ["commandcode", "poolside/laguna-s-2.1-free"],
    ["openrouter", "google/gemini-2.5-flash-lite"],
    ["openrouter", "openai/gpt-5-nano-2025-08-07"],
    ["commandcode", "tencent/hy3-paid"],
    ["commandcode", "deepseek/deepseek-v4.1-flash"],
  ];
  for (const [source, model] of ids) {
    const key = `${source}:${model}`;
    const groupId = groupIdForKey(unified.assign, key);
    assert.ok(groupId, `${key} should resolve to a group`);
    const priced = priceUnified({ ...rec, source, model }, index);
    assert.equal(priced.unpriced, false, `${key} should be priced`);
  }
  // Structurally known, has no daily parser, but is priced by the hand-
  // transcribed official LongCat limited-time-discount override.
  const longcat = groupIdForKey(unified.assign, "commandcode:meituan/LongCat-2.0:free");
  assert.equal(longcat, "longcat-2.0", "LongCat resolves via fingerprint fallback");
  assert.equal(
    priceUnified({ ...rec, source: "commandcode", model: "meituan/LongCat-2.0:free" }, index).unpriced,
    false,
  );
});

test("vendor alias folds cover display labels the parser cannot resolve", () => {
  // These DeepSeek labels were in the pre-fingerprint ALIAS table and cannot be
  // re-derived structurally, so they live in rates.preset.json modelMap (kept
  // reproducible by price-watch-lib aliasTo). They must stay priced in both the
  // unified and the legacy vendor table.
  const preset = JSON.parse(fs.readFileSync(new URL("../../extension/shared/unified.preset.json", import.meta.url)));
  const unified = normalizeUnifiedPricing(preset);
  const chat = groupIdForKey(unified.assign, "deepseek-official:deepseek-chat");
  // DeepSeek's merged chat+reasoner label lands on the chat group.
  assert.equal(groupIdForKey(unified.assign, "deepseek-official:deepseek-chat & deepseek-reasoner"), chat);
  const flash = groupIdForKey(unified.assign, "deepseek-official:deepseek-v4-flash");
  assert.equal(groupIdForKey(unified.assign, "deepseek-official:deepseek-v4.1-flash-expires-on-0910"), flash);

  // Muse Spark contributor generations (and their free variant) fold together;
  // both that fold and the standard Spark are priced by official Meta overrides,
  // so every key resolves to a group.
  const contributor = "muse-1.2-spark-contributor";
  for (const key of [
    "opencode:muse-spark-1.3-contributor",
    "opencode:muse-spark-1.2-contributor",
    "opencode:muse-spark-1.2-contributor-free",
    "opencode:muse-spark-1.3-contributor-free",
  ]) {
    assert.equal(groupIdForKey(unified.assign, key), contributor, `${key} folds into ${contributor}`);
  }
  assert.equal(groupIdForKey(unified.assign, "opencode:muse-spark-1.2"), "muse-1.2-spark");

  // The legacy (unified-off) vendor table maps them too.
  const vendor = JSON.parse(fs.readFileSync(new URL("../../extension/vendors/deepseek-official/rates.preset.json", import.meta.url)));
  const legacy = buildPricing({ presets: [vendor] });
  for (const [model, target] of [
    ["deepseek-chat & deepseek-reasoner", "deepseek-official:deepseek-chat"],
    ["deepseek-v4.1-flash-expires-on-0910", "deepseek-official:deepseek-v4-flash"],
  ]) {
    const r = priceRecord({ source: "deepseek-official", model, input: 1000000, time: "2026-09-15T12:00:00Z" }, legacy);
    assert.equal(r.unpriced, false, model);
    assert.equal(r.targetId, target, model);
  }
});
