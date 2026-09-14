import { test } from "node:test";
import assert from "node:assert/strict";

import { workspaceName, fmtMoney, escHTML, compactTick } from "../../extension/dashboard/views/format.js";

test("workspaceName prefers a user label and falls back to the id", () => {
  assert.equal(workspaceName("wrk_abc", { wrk_abc: "My Workspace" }), "My Workspace");
  assert.equal(workspaceName("wrk_abc", {}), "wrk_abc");
  assert.equal(workspaceName("", {}), "wrk_unknown");
});

test("fmtMoney / escHTML / compactTick behave", () => {
  assert.equal(fmtMoney(1.5, 2), "1.50");
  assert.equal(escHTML('<a&b>"'), "&lt;a&amp;b&gt;&quot;");
  assert.equal(compactTick(1500), "1.5k");
  assert.equal(compactTick(2000000), "2m");
});
