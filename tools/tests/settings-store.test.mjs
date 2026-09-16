import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeSettings, STORAGE_KEYS } from "../../extension/dashboard/settings/store.js";

test("normalizeSettings fills safe defaults for an empty store", () => {
  const s = normalizeSettings({});
  assert.deepEqual(s.registry, { vendors: [] });
  assert.deepEqual(s.vendorSettings, {});
  assert.deepEqual(s.unifiedPricing, { enabled: false, groups: [], assign: {} });
  assert.equal(s.unifiedStored, false);
  assert.equal(s.defaultCrawl, "");
  assert.deepEqual(s.workspaceLabels, {});
  assert.deepEqual(s.unmappedFirstSeen, {});
});

test("normalizeSettings coerces malformed values instead of throwing", () => {
  const s = normalizeSettings({
    [STORAGE_KEYS.registry]: ["not", "an", "object"],
    [STORAGE_KEYS.vendors]: [1, 2],
    [STORAGE_KEYS.defaultCrawl]: 42,
    [STORAGE_KEYS.workspaceLabels]: "nope",
    [STORAGE_KEYS.unmappedFirstSeen]: null,
  });
  assert.deepEqual(s.registry, { vendors: [] });
  assert.deepEqual(s.vendorSettings, {});
  assert.equal(s.defaultCrawl, "");
  assert.deepEqual(s.workspaceLabels, {});
  assert.deepEqual(s.unmappedFirstSeen, {});
});

test("normalizeSettings keeps good values and flags a stored pricelist", () => {
  const s = normalizeSettings({
    [STORAGE_KEYS.registry]: { vendors: [{ source: "opencode", crawl: true }] },
    [STORAGE_KEYS.vendors]: { opencode: true, mimo: false },
    [STORAGE_KEYS.unified]: { enabled: true, groups: [{ id: "g1", rates: [] }], assign: { "opencode:a": "g1" } },
    [STORAGE_KEYS.defaultCrawl]: "opencode",
    [STORAGE_KEYS.workspaceLabels]: { "opencode:wrk_a": "Work" },
  });
  assert.equal(s.registry.vendors.length, 1);
  assert.deepEqual(s.vendorSettings, { opencode: true, mimo: false });
  assert.equal(s.unifiedStored, true, "a stored pricelist is remembered even when empty");
  assert.equal(s.unifiedPricing.enabled, true);
  assert.equal(s.defaultCrawl, "opencode");
  assert.equal(s.workspaceLabels["opencode:wrk_a"], "Work");
});

test("an empty-object pricelist still counts as authored", () => {
  const s = normalizeSettings({ [STORAGE_KEYS.unified]: {} });
  assert.equal(s.unifiedStored, true);
  assert.deepEqual(s.unifiedPricing.groups, []);
});
