import { test } from "node:test";
import assert from "node:assert/strict";

import { parseStandardTable, snapshotFromPage } from "../../extension/vendors/google-official/pricing-page.js";
import { versionsFromSnapshots, presetFromVersions } from "../../extension/shared/price-history.js";
import { VENDORS } from "../price-watch-lib.mjs";

// Compact but structurally faithful slice of
// https://ai.google.dev/gemini-api/docs/pricing (Standard tab of each Gemini 4
// model), including a Batch tab whose discounted rates must never be picked up.
const PAGE = `
## Gemini 4 Carbon  {% id="gemini-4-carbon" %}
{% tabs %}
  {% tab title="Standard" %}
  {% table %}
  * Feature
  * Free Tier
  * Paid Tier, per 1M tokens in USD

  ---

  * Input price
  * Not available
  * $2.00 through November 30, 2026.   
  $4.00 starting December 1, 2026.

  ---

  * Output price (including thinking tokens)
  * Not available
  * $10.00 through November 30, 2026.   
  $20.00 starting December 1, 2026.

  ---

  * Context caching price
  * Not available
  * $0.10 through November 30, 2026.   
  $0.20 starting December 1, 2026.
  {% /table %}
  {% /tab %}
  {% tab title="Batch" %}
  {% table %}
  * Input price
  * $1.00
  * Output price (including thinking tokens)
  * $5.00
  * Context caching price
  * $0.05
  {% /table %}
  {% /tab %}
{% /tabs %}

## Gemini 4 Argon  {% id="gemini-4-argon" %}
{% tabs %}
  {% tab title="Standard" %}
  {% table %}
  * Feature
  * Free Tier
  * Paid Tier, per 1M tokens in USD

  ---

  * Input price
  * Not available
  * $2.00 through November 30, 2026.   
  $4.00 starting December 1, 2026.

  ---

  * Output price (including thinking tokens)
  * Not available
  * $10.00 through November 30, 2026.   
  $20.00 starting December 1, 2026.

  ---

  * Context caching price
  * Not available
  * $0.10 through November 30, 2026.   
  $0.20 starting December 1, 2026.
  {% /table %}
  {% /tab %}
{% /tabs %}

## Gemini 4 Neon  {% id="gemini-4-neon" %}
{% tabs %}
  {% tab title="Standard" %}
  {% table %}
  * Feature
  * Free Tier
  * Paid Tier, per 1M tokens in USD

  ---

  * Input price
  * Not available
  * $3.00

  ---

  * Output price (including thinking tokens)
  * Not available
  * $15.00

  ---

  * Context caching price
  * Not available
  * $0.15   
  Implicit caching only (explicit caching is not supported).
  {% /table %}
  {% /tab %}
{% /tabs %}

## Gemini 4 Hydrogen  {% id="gemini-4-hydrogen" %}
{% tabs %}
  {% tab title="Standard" %}
  {% table %}
  * Feature
  * Free Tier
  * Paid Tier, per 1M tokens in USD

  ---

  * Input price
  * Free of charge
  * $1.50

  ---

  * Output price (including thinking tokens)
  * Free of charge
  * $7.50

  ---

  * Context caching price
  * Free of charge
  * $0.075   
  Implicit caching only (explicit caching is not supported).
  {% /table %}
  {% /tab %}
{% /tabs %}

## Pricing for tools  {% id="pricing-for-tools" %}
not a pricing table
`;

test("google-official is wired as a price-only source", () => {
  const cfg = VENDORS["google-official"];
  assert.ok(cfg, "missing from VENDORS");
  assert.equal(cfg.url, "https://ai.google.dev/gemini-api/docs/pricing");
  assert.equal(cfg.parser, "extension/vendors/google-official/pricing-page.js");
});

test("parses all four Gemini 4 Standard rates, Standard only", () => {
  const models = parseStandardTable(PAGE);
  assert.deepEqual(Object.keys(models).sort(), [
    "gemini-4-argon", "gemini-4-carbon", "gemini-4-hydrogen", "gemini-4-neon",
  ]);

  for (const id of ["gemini-4-carbon", "gemini-4-argon"]) {
    const { entry, versions } = models[id];
    assert.deepEqual(entry, { pricing: { flat: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0 } } });
    assert.deepEqual(versions, [
      { from: null, pricing: { flat: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0 } } },
      { from: "2026-12-01T00:00:00Z", pricing: { flat: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 0 } } },
    ]);
  }
  assert.deepEqual(models["gemini-4-neon"].versions, [
    { from: null, pricing: { flat: { input: 3, output: 15, cacheRead: 0.15, cacheWrite: 0 } } },
  ]);
  assert.deepEqual(models["gemini-4-hydrogen"].versions, [
    { from: null, pricing: { flat: { input: 1.5, output: 7.5, cacheRead: 0.075, cacheWrite: 0 } } },
  ]);
});

test("snapshot replay keeps the scheduled rate without a second scrape", () => {
  const snap = snapshotFromPage(PAGE, "2026-11-22T05:17:00.000Z");
  assert.equal(snap.source, "google-official");
  const state = versionsFromSnapshots([snap]);
  const preset = presetFromVersions(state, { source: "google-official" });
  const target = preset.targets[preset.modelMap["google-official:gemini-4-argon"]];
  assert.deepEqual(target.rates, state["gemini-4-argon"].versions);
  assert.equal(target.rates.length, 2);
});

test("fails closed when the page loses a Gemini 4 model", () => {
  assert.throws(() => parseStandardTable(PAGE.replace(/## Gemini 4 Neon[\s\S]*?(?=## Gemini 4 Hydrogen)/, "")), /gemini-4-neon section missing/);
});
