import { test } from "node:test";
import assert from "node:assert/strict";

import { computeInbox, isPriced } from "../../extension/shared/inbox.js";

const pricing = {
  modelMap: { "opencode:deepseek-v4.1-flash": "deepseek-v4.1-flash" },
  targets: { "deepseek-v4.1-flash": { rates: [{ from: null, pricing: { flat: { input: 1 } } }] } },
};

test("isPriced is true only when modelMap -> target exists", () => {
  assert.equal(isPriced({ source: "opencode", model: "deepseek-v4.1-flash" }, pricing), true);
  assert.equal(isPriced({ source: "mimo", model: "mimo-v2.5" }, pricing), false);
});

test("computeInbox lists unmapped models oldest first and ignores priced ones", () => {
  const records = [
    { source: "mimo", model: "mimo-v2.5-pro", time: "2026-09-10T00:00:00Z" },
    { source: "mimo", model: "mimo-v2.5", time: "2026-09-12T00:00:00Z" },
    { source: "opencode", model: "deepseek-v4.1-flash", time: "2026-09-12T00:00:00Z" },
  ];
  const inbox = computeInbox(records, pricing, {});
  assert.equal(inbox.count, 2);
  assert.deepEqual(
    inbox.items.map((i) => i.key),
    ["mimo:mimo-v2.5-pro", "mimo:mimo-v2.5"]
  );
  assert.equal(inbox.oldest, "2026-09-10T00:00:00Z");
});

test("computeInbox keeps firstSeen across runs and drops now-mapped keys", () => {
  const first = computeInbox([{ source: "mimo", model: "m" , time: "2026-09-01T00:00:00Z"}], pricing, {});
  assert.equal(first.firstSeen["mimo:m"], "2026-09-01T00:00:00Z");
  const second = computeInbox([{ source: "mimo", model: "m", time: "2026-09-05T00:00:00Z" }], pricing, first.firstSeen);
  assert.equal(second.firstSeen["mimo:m"], "2026-09-01T00:00:00Z");
  const mapped = computeInbox([{ source: "opencode", model: "deepseek-v4.1-flash" }], pricing, second.firstSeen);
  assert.equal(mapped.count, 0);
  assert.deepEqual(mapped.firstSeen, {});
});
