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

// A real UsageSelect row captured from /console/api/usage/rows (range=all).
const ROW = {
  id: 2057997744,
  orgId: "wrk_01KXPX7J0D7DGMQPRXWVK1QTZC",
  userId: null,
  principalType: "service-account",
  serviceUserId: "svcacct_01KXPX7J0D7DGMQPRXWVK1QTZC_01KXPX7J0DNV205SXW1TPK2B6B",
  serviceApiKeyId: "key_01KZX14YB34GH9ZSZ133HTQTJB",
  appReferrer: null,
  appTitle: null,
  provider: "opencode",
  model: "muse-spark-1.3-contributor-free",
  inputTokens: 292,
  outputTokens: 340,
  reasoningTokens: 30,
  cacheReadTokens: 97393,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
  reasoningMode: null,
  reasoningEffort: null,
  reasoningBudgetTokens: null,
  reasoningSource: null,
  billingSource: "credit",
  costMicroCents: "0",
  createdAt: "2026-09-12T10:58:14.000Z",
};

test("orgIdFromPath reads the org_/wrk_ segment of a /console route", () => {
  assert.equal(orgIdFromPath("/console/wrk_01KXPX7J0D7DGMQPRXWVK1QTZC/usage"), "wrk_01KXPX7J0D7DGMQPRXWVK1QTZC");
  assert.equal(orgIdFromPath("/console/org_abc/usage"), "org_abc");
  assert.equal(orgIdFromPath("/console"), null);
  assert.equal(orgIdFromPath("/workspace/wrk_x/usage"), null);
  assert.equal(orgIdFromPath(""), null);
  assert.equal(orgIdFromPath(null), null);
});

test("buildRowsUrl always uses range=all, clamps pageSize, encodes since/cursor", () => {
  const base = buildRowsUrl();
  assert.ok(base.startsWith(`${USAGE_ROWS_PATH}?`));
  assert.match(base, /range=all/);
  assert.match(base, new RegExp(`pageSize=${USAGE_ROWS_MAX_PAGE_SIZE}`));

  assert.match(buildRowsUrl({ pageSize: 999 }), /pageSize=100/);
  assert.match(buildRowsUrl({ pageSize: 0 }), /pageSize=1/);

  const q = buildRowsUrl({ since: "2026-09-12T00:00:00.000Z", cursor: "abc=" });
  assert.match(q, /since=2026-09-12T00%3A00%3A00\.000Z/);
  assert.match(q, /cursor=abc%3D/);
});

test("mapUsageRow maps a UsageSelect row to an exclusive-output canonical record", () => {
  const rec = mapUsageRow(ROW);
  assert.equal(rec.id, "opencode:2057997744");
  assert.equal(rec.source, "opencode");
  assert.equal(rec.model, "muse-spark-1.3-contributor-free");
  assert.equal(rec.provider, "opencode");
  assert.equal(rec.input, 292);
  // Console outputTokens is INCLUSIVE of reasoning; canonical output is exclusive.
  assert.equal(rec.output, 310);
  assert.equal(rec.reasoning, 30);
  assert.equal(rec.outputExcludesReasoning, true);
  assert.equal(rec.cacheRead, 97393);
  assert.equal(rec.cacheWrite5m, 0);
  assert.equal(rec.cacheWrite1h, 0);
  assert.equal(rec.vendorCost, 0);
  assert.equal(rec.costScale, 1e8);
  assert.equal(rec.workspaceID, "wrk_01KXPX7J0D7DGMQPRXWVK1QTZC");
  assert.equal(rec.keyID, "key_01KZX14YB34GH9ZSZ133HTQTJB");
  assert.equal(rec.billingSource, "credit");
  assert.equal(rec.principalType, "service-account");
  assert.equal(rec.time, "2026-09-12T10:58:14.000Z");
  assert.equal(rec.date, "2026-09-12");
  assert.equal(rec.v, 1);
});

test("mapUsageRow coerces string microcent cost and tolerates missing fields", () => {
  const rec = mapUsageRow({ ...ROW, id: 7, costMicroCents: "12345678" });
  assert.equal(rec.vendorCost, 12345678);
  assert.equal(mapUsageRow(null), null);
  assert.equal(mapUsageRow(undefined), null);
});

test("mapUsageRows filters non-objects and latestCreatedAt picks the newest", () => {
  const rows = [{ ...ROW }, null, { ...ROW, id: 2, createdAt: "2026-09-12T11:00:00.000Z" }];
  const recs = mapUsageRows(rows);
  assert.equal(recs.length, 2);
  assert.equal(recs.every((r) => r.source === "opencode"), true);
  assert.equal(latestCreatedAt(rows), "2026-09-12T11:00:00.000Z");
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
  assert.match(src, /range/);
  assert.match(src, /pageSize/);
});
