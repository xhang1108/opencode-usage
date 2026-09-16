import { test } from "node:test";
import assert from "node:assert/strict";

import {
  slug,
  normalize,
  parsePrice,
  toISO,
  buildRates,
  buildPreset,
} from "../opencode/build-opencode-preset.mjs";
import { validatePreset } from "../../extension/shared/preset.js";

const D1 = "2025-01-01T00:00:00.000Z";
const D2 = "2025-02-01T00:00:00.000Z";
const D3 = "2025-03-01T00:00:00.000Z";

const flat = (input, output, cacheRead = 0, cacheWrite = 0) => ({ input, output, cacheRead, cacheWrite });

const head = (ref, date, time = "00:00:00", msg = "update") => `=== ${ref} ${date} ${time} ${msg}\n`;
const row = (sign, name, i, o, cr = 0, cw = 0) => `${sign} | ${name} | ${i} | ${o} | ${cr} | ${cw}\n`;

test("slug lowercases, dashes non-alphanumerics and trims dashes", () => {
  assert.equal(slug("  DeepSeek V4 (Peak)!! "), "deepseek-v4-peak");
  assert.equal(slug("GPT-5.2"), "gpt-5.2");
  assert.equal(slug("--Foo__Bar--"), "foo-bar");
});

test("normalize drops limit rows and folds peak/offpeak variants", () => {
  assert.equal(normalize("GLM-5 5 Hour Limit"), null);
  assert.equal(normalize("Monthly limit"), null);

  assert.deepEqual(normalize("DeepSeek V4 (Peak)"), { id: "deepseek-v4", baseName: "DeepSeek V4", variant: "peak" });
  assert.deepEqual(normalize("DeepSeek V4 (Off-Peak)"), { id: "deepseek-v4", baseName: "DeepSeek V4", variant: "offpeak" });
});

test("normalize folds token tiers and strips promo suffixes", () => {
  assert.deepEqual(normalize("Model X (> 32 K tokens)"), {
    id: "model-x",
    baseName: "Model X",
    variant: "tier-high",
    tierK: 32000,
  });
  assert.deepEqual(normalize("Model X (<= 32 K tokens)"), {
    id: "model-x",
    baseName: "Model X",
    variant: "tier-low",
    tierK: 32000,
  });
  assert.deepEqual(normalize("Foo Bar (2x usage till Jul 24)"), {
    id: "foo-bar",
    baseName: "Foo Bar",
    variant: "flat",
  });
});

test("parsePrice and toISO handle crawl column formats", () => {
  assert.equal(parsePrice("$1.25"), 1.25);
  assert.equal(parsePrice(""), 0);
  assert.equal(parsePrice("-"), 0);
  assert.equal(parsePrice(null), 0);
  assert.equal(toISO("7/4/2025", "09:05:03"), "2025-07-04T09:05:03.000Z");
});

test("buildRates emits a version per price change", () => {
  const rates = buildRates([
    { date: D1, variant: "flat", prices: flat(1, 2) },
    { date: D2, variant: "flat", prices: flat(3, 4) },
  ]);
  assert.deepEqual(rates.map((r) => r.from), [null, D2]);
  assert.deepEqual(rates[1].pricing.flat, flat(3, 4));
});

test("buildRates folds peak/offpeak into one fixed-window rate", () => {
  const rates = buildRates([
    { date: D1, variant: "offpeak", prices: flat(1, 2) },
    { date: D1, variant: "peak", prices: flat(3, 4) },
  ]);
  assert.equal(rates.length, 1);
  assert.deepEqual(rates[0].windows, {
    peak: [
      { days: [], start: "01:00", end: "04:00" },
      { days: [], start: "06:00", end: "10:00" },
    ],
  });
  assert.deepEqual(rates[0].pricing.peak, flat(3, 4));
  assert.deepEqual(rates[0].pricing.offpeak, flat(1, 2));
});

test("buildRates folds token tiers into a flat tier table", () => {
  const rates = buildRates([
    { date: D1, variant: "tier-low", prices: flat(1, 2), k: 32000 },
    { date: D1, variant: "tier-high", prices: flat(3, 4), k: 200000 },
  ]);
  assert.equal(rates.length, 1);
  assert.equal(rates[0].pricing.flat.tier.limit, 200000);
  assert.deepEqual(rates[0].pricing.flat.tier.low, flat(1, 2));
  assert.deepEqual(rates[0].pricing.flat.tier.high, flat(3, 4));
});

test("buildRates de-duplicates consecutive identical structures", () => {
  const rates = buildRates([
    { date: D1, variant: "flat", prices: flat(1, 2) },
    { date: D2, variant: "flat", prices: flat(1, 2) },
  ]);
  assert.equal(rates.length, 1);
});

test("buildPreset records a withdrawal as until on the rate in force", () => {
  const crawl =
    head("aaa", "1/1/2025") +
    row("+", "Foo", 1, 2, 0.1, 0.2) +
    head("bbb", "2/1/2025") +
    row("+", "Foo", 3, 4, 0.3, 0.4) +
    head("ccc", "3/1/2025") +
    row("-", "Foo", 3, 4, 0.3, 0.4);

  const rates = buildPreset(crawl).targets["opencode:foo"].rates;
  assert.deepEqual(rates.map((r) => r.from), [null, D2]);
  assert.equal("until" in rates[0], false);
  assert.equal(rates[1].until, D3);
});

test("buildPreset treats a same-day - and + as a price change, not a withdrawal", () => {
  const crawl =
    head("aaa", "1/1/2025") +
    row("+", "Bar", 1, 2, 0.1, 0.2) +
    head("bbb", "2/1/2025") +
    row("-", "Bar", 1, 2, 0.1, 0.2) +
    row("+", "Bar", 3, 4, 0.3, 0.4) +
    head("ccc", "3/1/2025") +
    row("+", "Bar", 5, 6, 0.5, 0.6);

  const rates = buildPreset(crawl).targets["opencode:bar"].rates;
  assert.equal(rates.length, 3);
  for (const r of rates) assert.equal("until" in r, false);
});

test("buildPreset namespaces crawl ids and merges existing targets", () => {
  const crawl = head("aaa", "1/1/2025") + row("+", "Alpha", 1, 2);
  const existing = {
    targets: {
      "opencode:gamma": { label: "gamma", scope: "opencode", rates: [{ from: null, pricing: { flat: flat(1, 2) } }] },
      "opencode:delta-over-128": { label: "delta", scope: "opencode", rates: [] },
    },
    modelMap: { "opencode:gamma": "opencode:gamma", "opencode:delta-over-128": "opencode:delta-over-128" },
  };

  const preset = buildPreset(crawl, existing);
  assert.ok(preset.targets["opencode:alpha"]);
  assert.equal(preset.modelMap["opencode:alpha"], "opencode:alpha");
  assert.ok(preset.targets["opencode:gamma"], "keeps ids the crawl did not cover");
  assert.ok(preset.modelMap["opencode:gamma"]);
  assert.equal("opencode:delta-over-128" in preset.targets, false);
  assert.equal("opencode:delta-over-128" in preset.modelMap, false);
});

test("buildPreset output validates and uses deterministic ISO dates", () => {
  const crawl =
    head("aaa", "1/1/2025") +
    row("+", "Zebra", 1, 2, 0.1, 0.2) +
    row("+", "Apple", 3, 4, 0.3, 0.4) +
    head("bbb", "2/1/2025") +
    row("+", "Zebra", 5, 6, 0.5, 0.6);

  const preset = buildPreset(crawl, undefined);
  assert.equal(preset.presetVersion, 2);
  assert.equal(preset.source, "opencode");
  assert.deepEqual(Object.keys(preset.targets), ["opencode:zebra", "opencode:apple"]);
  assert.equal(preset.targets["opencode:zebra"].rates[1].from, D2);
  assert.match(preset.targets["opencode:zebra"].rates[1].from, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/);
  assert.equal(validatePreset(preset).ok, true);
});
