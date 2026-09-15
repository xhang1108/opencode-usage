import { test } from "node:test";
import assert from "node:assert/strict";

import { workspaceList, summaryModel } from "../../extension/dashboard/settings/general-model.js";
import { vendorMeta, hasOrigins } from "../../extension/dashboard/settings/vendors-model.js";
import { exportFilenames, pagedRows } from "../../extension/dashboard/settings/database-model.js";

test("workspaceList groups by source:workspaceID and sorts", () => {
  const list = workspaceList([
    { source: "opencode", workspaceID: "wrk_b" },
    { source: "opencode", workspaceID: "wrk_b" },
    { source: "mimo", workspaceID: "wrk_a" },
    { workspaceID: "wrk_a" }, // default source opencode
    { source: "opencode" }, // unknown workspace id
  ]);
  assert.deepEqual(list, [
    { id: "mimo:wrk_a", source: "mimo", count: 1 },
    { id: "opencode:wrk_a", source: "opencode", count: 1 },
    { id: "opencode:wrk_b", source: "opencode", count: 2 },
    { id: "opencode:wrk_unknown", source: "opencode", count: 1 },
  ]);
  assert.deepEqual(workspaceList([]), []);
});

test("summaryModel counts enabled vendors, mapped models, targets and records", () => {
  const summary = summaryModel({
    vendors: [{ source: "opencode" }, { source: "mimo" }, null],
    isEnabled: (s) => s === "opencode",
    pricing: { modelMap: { "opencode:a": 1, "opencode:b": 2 }, targets: { t1: 1 } },
    records: [1, 2, 3],
  });
  assert.deepEqual(summary, { enabledCount: 1, vendorCount: 3, mappedCount: 2, targetCount: 1, recordsCount: 3 });
});

test("summaryModel tolerates missing pricing/records", () => {
  assert.deepEqual(summaryModel({ vendors: [], isEnabled: () => false, pricing: null, records: null }), {
    enabledCount: 0,
    vendorCount: 0,
    mappedCount: 0,
    targetCount: 0,
    recordsCount: 0,
  });
});

test("vendorMeta composes the modes and cost-basis lines", () => {
  const crawlImport = { source: "mimo", crawl: true, import: ["xlsx"] };
  assert.deepEqual(vendorMeta(crawlImport, { unifiedOn: false, hasPreset: true }), {
    modes: "crawl · import xlsx",
    basis: "cost estimated",
    vendorCost: false,
  });
  assert.equal(vendorMeta(crawlImport, { unifiedOn: false, hasPreset: false }).basis, "cost estimated · no preset");
  assert.equal(vendorMeta({ source: "openrouter", costSource: "vendor" }, { unifiedOn: false, hasPreset: true }).basis, "cost vendor-reported");
  assert.equal(vendorMeta(crawlImport, { unifiedOn: true, hasPreset: true }).basis, "unified price");
});

test("hasOrigins flags vendors with optional host permissions", () => {
  assert.equal(hasOrigins({ origins: ["https://a"] }), true);
  assert.equal(hasOrigins({ origins: [] }), false);
  assert.equal(hasOrigins({}), false);
  assert.equal(hasOrigins(null), false);
});

test("exportFilenames build the two disjoint backup names", () => {
  assert.deepEqual(exportFilenames("2026-09-16"), {
    settings: "opencode-usage_settings_2026-09-16.json",
    records: "opencode-usage_records_2026-09-16.csv",
  });
});

test("pagedRows slices and reports whether the store holds more", () => {
  const rows = [1, 2, 3, 4];
  assert.deepEqual(pagedRows(rows, 4, 2), { shown: [1, 2], hasMore: true, total: 4 });
  assert.deepEqual(pagedRows(rows, 4, 10), { shown: [1, 2, 3, 4], hasMore: false, total: 4 });
  // A store count larger than the rows it returned still truncates.
  assert.deepEqual(pagedRows(rows, 99, 2), { shown: [1, 2], hasMore: true, total: 99 });
  assert.deepEqual(pagedRows(null, null, 5), { shown: [], hasMore: false, total: 0 });
});
