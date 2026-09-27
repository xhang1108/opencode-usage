import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

import {
  orgIdFromPath,
  buildRowsUrl,
  mapUsageRow,
  mapUsageRows,
  latestCreatedAt,
  USAGE_ROWS_PATH,
  USAGE_ROWS_MAX_PAGE_SIZE,
} from "../../extension/vendors/opencode/mapper.js";

// A real request-log item captured from /console/api/request-logs
// (category=inference). Replaces the removed /console/api/usage/rows UsageSelect.
const ROW = {
  id: "386c0728-41ba-409f-835a-8a0a45c12536",
  requestID: "386c0728-41ba-409f-835a-8a0a45c12536",
  workspaceID: "wrk_01KXPX7J0D7DGMQPRXWVK1QTZC",
  startedAt: 1790333660494,
  finishedAt: 1790333663513,
  durationMs: 3019,
  outcome: "succeeded",
  category: "inference",
  protocol: "openai-chat",
  product: "standard",
  path: "/inference/openai/v1/chat/completions",
  method: "POST",
  stream: true,
  app: "cli",
  sessionID: "ses_f289296aaffeNTWFgGQ9ugBZCp",
  userID: undefined,
  serviceAccountID: "svcacct_01KXPX7J0D7DGMQPRXWVK1QTZC_01KXPX7J0DNV205SXW1TPK2B6B",
  serviceAPIKeyID: "key_01KZX14YB34GH9ZSZ133HTQTJB",
  requestedModel: "space-bunny-free",
  model: "space-bunny-free",
  provider: "opencode",
  connectionID: null,
  statusCode: 200,
  inputTokens: 507,
  outputTokens: 184,
  reasoningTokens: 50,
  cacheReadTokens: 199928,
  cacheWriteTokens: 0,
  cost: 0,
};

test("orgIdFromPath reads the org_/wrk_ segment of a /console route", () => {
  assert.equal(orgIdFromPath("/console/wrk_01KXPX7J0D7DGMQPRXWVK1QTZC/usage"), "wrk_01KXPX7J0D7DGMQPRXWVK1QTZC");
  assert.equal(orgIdFromPath("/console/org_abc/usage"), "org_abc");
  assert.equal(orgIdFromPath("/console"), null);
  assert.equal(orgIdFromPath("/workspace/wrk_x/usage"), null);
  assert.equal(orgIdFromPath(""), null);
  assert.equal(orgIdFromPath(null), null);
});

test("buildRowsUrl uses category=inference, clamps limit, encodes since/cursor/until", () => {
  const base = buildRowsUrl();
  assert.ok(base.startsWith(`${USAGE_ROWS_PATH}?`));
  assert.match(base, /category=inference/);
  assert.match(base, new RegExp(`limit=${USAGE_ROWS_MAX_PAGE_SIZE}`));

  assert.match(buildRowsUrl({ limit: 999 }), /limit=100/);
  assert.match(buildRowsUrl({ limit: 0 }), /limit=1/);

  const q = buildRowsUrl({ since: 1788220800000, until: 1790506236098, cursor: "abc=" });
  assert.match(q, /since=1788220800000/);
  assert.match(q, /until=1790506236098/);
  assert.match(q, /cursor=abc%3D/);
});

test("mapUsageRow maps a request-log item to an exclusive-output canonical record", () => {
  const rec = mapUsageRow(ROW);
  assert.equal(rec.id, "opencode:386c0728-41ba-409f-835a-8a0a45c12536");
  assert.equal(rec.source, "opencode");
  assert.equal(rec.model, "space-bunny-free");
  assert.equal(rec.provider, "opencode");
  assert.equal(rec.input, 507);
  // outputTokens is INCLUSIVE of reasoning; canonical output is exclusive.
  assert.equal(rec.output, 134);
  assert.equal(rec.reasoning, 50);
  assert.equal(rec.outputExcludesReasoning, true);
  assert.equal(rec.cacheRead, 199928);
  assert.equal(rec.cacheWrite5m, 0);
  assert.equal(rec.cacheWrite1h, 0);
  assert.equal(rec.vendorCost, 0);
  assert.equal(rec.costScale, 1e8);
  assert.equal(rec.workspaceID, "wrk_01KXPX7J0D7DGMQPRXWVK1QTZC");
  assert.equal(rec.keyID, "key_01KZX14YB34GH9ZSZ133HTQTJB");
  assert.equal(rec.billingSource, null);
  assert.equal(rec.principalType, "service-account");
  assert.equal(rec.sessionID, "ses_f289296aaffeNTWFgGQ9ugBZCp");
  assert.equal(rec.time, new Date(1790333660494).toISOString());
  assert.equal(rec.date, new Date(1790333660494).toISOString().slice(0, 10));
  assert.equal(rec.v, 1);
});

test("mapUsageRow coerces numeric cost and skips non-succeeded/non-inference rows", () => {
  const rec = mapUsageRow({ ...ROW, id: "paid-1", cost: 12345678 });
  assert.equal(rec.vendorCost, 12345678);
  assert.equal(mapUsageRow(null), null);
  assert.equal(mapUsageRow(undefined), null);
  assert.equal(mapUsageRow({ ...ROW, id: "x1", category: "api" }), null);
  assert.equal(mapUsageRow({ ...ROW, id: "x2", outcome: "rejected" }), null);
  assert.equal(mapUsageRow({ ...ROW, id: "x3", outcome: "failed" }), null);
});

test("mapUsageRows filters skipped rows and latestCreatedAt picks the newest", () => {
  const rows = [
    { ...ROW },
    null,
    { ...ROW, id: "newer", startedAt: 1790333723708 },
    { ...ROW, id: "rej", outcome: "rejected" },
  ];
  const recs = mapUsageRows(rows);
  assert.equal(recs.length, 2);
  assert.equal(recs.every((r) => r.source === "opencode"), true);
  assert.equal(latestCreatedAt(rows), new Date(1790333723708).toISOString());
  assert.equal(latestCreatedAt([]), null);
  assert.equal(mapUsageRows(null).length, 0);
});

test("api.js content script compiles and speaks the generic vendor protocol", () => {
  const src = readFileSync(new URL("../../extension/vendors/opencode/api.js", import.meta.url), "utf8");
  // Compile without executing (the IIFE touches window/chrome at runtime).
  assert.doesNotThrow(() => new vm.Script(src, { filename: "api.js" }));
  assert.match(src, /vendor-crawl-data/);
  assert.match(src, /vendor-crawl-done/);
  assert.match(src, /x-org-id/);
  assert.match(src, /category/);
  assert.match(src, /request-logs/);
});
