import { test } from "node:test";
import assert from "node:assert/strict";

import { parsePricingModels, parsePeakWindows, snapshotFromPage, canonicalModelName } from "../../extension/vendors/deepseek-official/pricing-page.js";
import { versionsFromSnapshots, presetFromVersions } from "../../extension/shared/price-history.js";

const PEAK_HTML = `
<div><b><table><tbody>
<tr><td colspan="3">MODEL</td><td>deepseek-flash(1)</td><td>deepseek-v4-pro(2)</td></tr>
<tr><td colspan="3">MAX OUTPUT</td><td>MAXIMUM: 384K</td><td>MAXIMUM: 384K</td></tr>
<tr><td rowspan="6">PRICING<sup>(3)</sup></td><td rowspan="2">1M INPUT TOKENS<br>(CACHE HIT)</td><td>OFF-PEAK</td><td>$0.003</td><td>$0.022</td></tr>
<tr><td>PEAK</td><td>$0.006</td><td>$0.044</td></tr>
<tr><td rowspan="2">1M INPUT TOKENS<br>(CACHE MISS)</td><td>OFF-PEAK</td><td>$0.15</td><td>$0.66</td></tr>
<tr><td>PEAK</td><td>$0.3</td><td>$1.32</td></tr>
<tr><td rowspan="2">1M OUTPUT TOKENS</td><td>OFF-PEAK</td><td>$0.6</td><td>$1.98</td></tr>
<tr><td>PEAK</td><td>$1.2</td><td>$3.96</td></tr>
</tbody></table></b></div>
<div><p>(3) Off-peak rates are half of the peak rates. Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday (all other hours are off-peak).</p></div>`;

const FLAT_HTML = `
<table><tbody>
<tr><td colspan="3">MODEL</td><td>deepseek-chat</td></tr>
<tr><td colspan="3">MAX OUTPUT</td><td>MAXIMUM: 8K</td></tr>
<tr><td>CACHE HIT</td><td>$0.0028</td></tr>
<tr><td>CACHE MISS</td><td>$0.14</td></tr>
<tr><td>OUTPUT</td><td>$0.28</td></tr>
</tbody></table>`;

const WIDE_HTML = `
<table><thead><tr><th>MODEL<sup>(1)</sup></th><th>CONTEXT LENGTH</th><th>MAX OUTPUT TOKENS<sup>(2)</sup></th><th>INPUT PRICE (CACHE HIT)<sup>(3)</sup></th><th>INPUT PRICE (CACHE MISS)</th><th>OUTPUT PRICE</th></tr></thead>
<tbody>
<tr><td>deepseek-chat</td><td>128K</td><td>4K</td><td>$0.014 / 1M tokens</td><td>$0.14 / 1M tokens</td><td>$0.28 / 1M tokens</td></tr>
<tr><td>deepseek-reasoner</td><td>128K</td><td>64K</td><td>$0.14 / 1M tokens</td><td>$0.55 / 1M tokens</td><td>$2.19 / 1M tokens</td></tr>
</tbody></table>`;

test("parsePricingModels reads peak/off-peak columns and windows", () => {
  const models = parsePricingModels(PEAK_HTML);
  assert.deepEqual(Object.keys(models), ["deepseek-v4-flash", "deepseek-v4-pro"]);
  const flash = models["deepseek-v4-flash"].entry;
  assert.deepEqual(flash.windows.peak, [
    { days: [1, 2, 3, 4, 5], start: "01:00", end: "04:00" },
    { days: [1, 2, 3, 4, 5], start: "06:00", end: "10:00" },
  ]);
  assert.deepEqual(flash.pricing.peak, { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 });
  assert.deepEqual(flash.pricing.offpeak, { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 });
  assert.deepEqual(models["deepseek-v4-pro"].entry.pricing.offpeak, { input: 0.66, output: 1.98, cacheRead: 0.022, cacheWrite: 0 });
});

test("canonicalModelName folds display names and thinking-mode labels", () => {
  assert.equal(canonicalModelName("DeepSeek-V4.1-Flash"), "deepseek-v4-flash");
  assert.equal(canonicalModelName("deepseek-flash"), "deepseek-v4-flash");
  assert.equal(canonicalModelName("DeepSeek-V4-Flash-0731"), "deepseek-v4-flash");
  assert.equal(canonicalModelName("DeepSeek-V4-Pro-0813"), "deepseek-v4-pro");
  assert.equal(canonicalModelName("DeepSeek-V3.1 (Non-thinking Mode)"), "deepseek-chat");
  assert.equal(canonicalModelName("DeepSeek-V3.2 (Thinking Mode)"), "deepseek-reasoner");
});

test("parsePricingModels handles flat pages (no peak/off-peak)", () => {
  const models = parsePricingModels(FLAT_HTML);
  assert.deepEqual(models["deepseek-chat"].entry, {
    pricing: { flat: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 } },
  });
  assert.equal(parsePricingModels(FLAT_HTML)["deepseek-chat"].entry.windows, undefined);
});

test("parsePricingModels handles the older wide table (one row per model)", () => {
  const models = parsePricingModels(WIDE_HTML);
  assert.deepEqual(Object.keys(models), ["deepseek-chat", "deepseek-reasoner"]);
  assert.deepEqual(models["deepseek-chat"].entry, {
    pricing: { flat: { input: 0.14, output: 0.28, cacheRead: 0.014, cacheWrite: 0 } },
  });
  assert.deepEqual(models["deepseek-reasoner"].entry.pricing.flat, { input: 0.55, output: 2.19, cacheRead: 0.14, cacheWrite: 0 });
});

test("parsePeakWindows extracts HH:MM ranges and weekdays", () => {
  assert.deepEqual(parsePeakWindows("Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday."), [
    { days: [1, 2, 3, 4, 5], start: "01:00", end: "04:00" },
    { days: [1, 2, 3, 4, 5], start: "06:00", end: "10:00" },
  ]);
});

test("snapshot + versions + preset produce a dated chain", () => {
  const s1 = snapshotFromPage(FLAT_HTML.replace("deepseek-chat", "deepseek-v4-flash"), "2026-08-01T00:00:00.000Z");
  const s2 = snapshotFromPage(PEAK_HTML, "2026-08-16T16:00:00.000Z");
  const state = versionsFromSnapshots([s1, s2]);
  const versions = state["deepseek-v4-flash"].versions;
  assert.equal(versions.length, 2);
  assert.equal(versions[0].from, null);
  assert.equal(versions[0].pricing.flat.input, 0.14);
  assert.equal(versions[1].from, "2026-08-16T16:00:00.000Z");
  assert.equal(versions[1].pricing.offpeak.input, 0.15);

  const preset = presetFromVersions(state, { source: "deepseek-official" });
  const id = preset.modelMap["deepseek-official:deepseek-v4-flash"];
  assert.equal(id, "deepseek-official:deepseek-v4-flash");
  assert.equal(preset.targets[id].rates.length, 2);
});

test("versionsFromSnapshots uses an explicit effectiveAt over capturedAt", () => {
  const s1 = snapshotFromPage(FLAT_HTML.replace("deepseek-chat", "deepseek-v4-flash"), "2026-08-01T00:00:00.000Z");
  const s2 = snapshotFromPage(PEAK_HTML, "2026-08-16T17:14:38.000Z");
  s2.models["deepseek-v4-flash"].effectiveAt = "2026-08-16T16:00:00.000Z";
  const versions = versionsFromSnapshots([s1, s2])["deepseek-v4-flash"].versions;
  assert.equal(versions[1].from, "2026-08-16T16:00:00.000Z");
});
