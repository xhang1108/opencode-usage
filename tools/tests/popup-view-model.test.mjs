import { test } from "node:test";
import assert from "node:assert/strict";

import {
  crawlButtonText,
  crawlStatusText,
  crawlableVendors,
  defaultCrawlLabel,
  formatDateTime,
  pickUsageWorkspace,
  usageUrl,
} from "../../extension/popup/view-model.js";

test("formatDateTime renders local date+time, falls back to date, then '-'", () => {
  // Build the instant from local parts so the expected string is timezone-free.
  const local = new Date(2026, 8, 16, 7, 5);
  assert.equal(formatDateTime({ time: local.toISOString() }), "2026-09-16 07:05");
  assert.equal(formatDateTime({ time: "not-a-date", date: "2026-07-14" }), "2026-07-14");
  assert.equal(formatDateTime({ date: "2026-07-14" }), "2026-07-14");
  assert.equal(formatDateTime({}), "-");
  assert.equal(formatDateTime(null), "-");
});

test("defaultCrawlLabel prefers the registry label then title-cases the source", () => {
  const stored = {
    defaultCrawl: "deepseek-official",
    vendorRegistry: { vendors: [{ source: "deepseek-official", label: "DeepSeek" }] },
  };
  assert.equal(defaultCrawlLabel(stored), "DeepSeek");
  assert.equal(defaultCrawlLabel({ defaultCrawl: "mimo", vendorRegistry: { vendors: [] } }), "Mimo");
  assert.equal(defaultCrawlLabel({}), "Opencode");
  assert.equal(defaultCrawlLabel(null), "Opencode");
});

test("crawlButtonText flips to a full scan while Shift is held", () => {
  const idle = crawlButtonText({ shiftHeld: false, label: "OpenCode" });
  assert.equal(idle.text, "Crawl OpenCode");
  assert.match(idle.title, /hold Shift for a full scan/);
  const held = crawlButtonText({ shiftHeld: true, label: "OpenCode" });
  assert.equal(held.text, "Full Scan OpenCode");
  assert.match(held.title, /re-crawl ALL OpenCode/);
});

test("pickUsageWorkspace ranks last-visited, last-sync, last record, in-flight crawl", () => {
  assert.equal(pickUsageWorkspace({ lastVisitedWorkspace: "wrk_a", lastSyncWorkspace: "wrk_b" }), "wrk_a");
  assert.equal(pickUsageWorkspace({ lastSyncWorkspace: "wrk_b" }), "wrk_b");
  assert.equal(pickUsageWorkspace({ cachedMeta: { lastRecord: { workspaceID: "wrk_c" } } }), "wrk_c");
  assert.equal(pickUsageWorkspace({ crawlState: { workspace: "wrk_d" } }), "wrk_d");
  assert.equal(pickUsageWorkspace({}), "");
  assert.equal(pickUsageWorkspace(null), "");
});

test("pickUsageWorkspace ignores a visited/synced id that is not a wrk_ id", () => {
  // The stored visited/sync ids are gated on the wrk_ shape; the cached record
  // and crawl state are accepted as-is (they were never gated).
  assert.equal(pickUsageWorkspace({ lastVisitedWorkspace: "abc", cachedMeta: { lastRecord: { workspaceID: "wrk_c" } } }), "wrk_c");
});

test("usageUrl builds the workspace usage link", () => {
  assert.equal(usageUrl("wrk_x"), "https://opencode.ai/workspace/wrk_x/usage");
});

test("crawlableVendors keeps only enabled vendors that can crawl", () => {
  const vendors = [
    { source: "opencode", crawl: true },
    { source: "openrouter", crawl: true },
    { source: "mimo", crawl: false },
  ];
  assert.deepEqual(crawlableVendors(vendors, {}).map((v) => v.source), ["opencode"]);
  assert.deepEqual(crawlableVendors(vendors, { openrouter: true }).map((v) => v.source), ["opencode", "openrouter"]);
  assert.deepEqual(crawlableVendors(vendors, { opencode: false }).map((v) => v.source), []);
  assert.deepEqual(crawlableVendors(null, {}), []);
});

test("crawlStatusText maps a start-crawl reply", () => {
  assert.deepEqual(crawlStatusText({ type: "start-crawl" }, { ok: true, started: true }), {
    text: "Sync started - watch the icon badge",
    ok: true,
  });
  assert.deepEqual(crawlStatusText({ type: "start-crawl", rescan: true }, { ok: true, started: true }), {
    text: "Rescan started - watch the icon badge",
    ok: true,
  });
  assert.deepEqual(crawlStatusText({ type: "start-crawl" }, { ok: true, reason: "busy" }), {
    text: "Sync already in progress",
    ok: true,
  });
  assert.equal(crawlStatusText({ type: "start-crawl" }, { ok: true }).text, "Sync requested (waiting for server ID)");
  assert.equal(crawlStatusText({ type: "start-crawl" }, { ok: true, openedUsage: true, started: true }).text, "Opened Usage page & sync started");
  assert.equal(crawlStatusText({ type: "start-crawl" }, { ok: true, openedUsage: true }).text, "Opened Usage page - syncing...");
});

test("crawlStatusText maps open-dashboard and errors", () => {
  assert.equal(crawlStatusText({ type: "open-dashboard" }, { ok: true, fromCache: true, count: 12 }).text, "Dashboard opened (cached data, 12 records)");
  assert.equal(crawlStatusText({ type: "open-dashboard" }, { ok: true, count: 3 }).text, "Dashboard opened (latest data, 3 records)");
  assert.deepEqual(crawlStatusText({ type: "start-crawl" }, { ok: false, error: "boom" }), { text: "Error: boom", ok: false });
  assert.deepEqual(crawlStatusText({ type: "start-crawl" }, null), { text: "Error: unknown error", ok: false });
});

test("crawlStatusText has nothing to say for an unrelated message", () => {
  assert.equal(crawlStatusText({ type: "get-status" }, { ok: true }), null);
});
