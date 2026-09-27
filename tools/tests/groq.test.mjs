import { test } from "node:test";
import assert from "node:assert/strict";

import { mapRow, mapRows, rowsFromResponse, orgsFromProfile } from "../../extension/vendors/groq-official/mapper.js";

// Real response shape (2026-09, console Usage page): { object: "list", data }.
// One row per day x model x API key; timestamp is a UTC-midnight unix second.
// Ids below are synthetic; the field semantics match the captured sample.
const ROW = {
  organization_id: "org_test",
  organization_name: "Personal",
  n_context_tokens_total: 759,
  n_non_cached_context_tokens_total: 759,
  n_generated_tokens_total: 6021,
  project_id: "project_test",
  api_key_id: "key_test",
  api_key_name: "open",
  api_key_redacted: "gsk_************************************************XXXX",
  model: "whisper-large-v3",
  timestamp: 1789171200, // 2026-09-12T00:00:00Z
  user_id: "",
  user: "",
  num_requests: 151,
  num_seconds: 1474,
  num_seconds_billed: 1837,
  plan_id: "",
  subscription_id: "",
  service_tier: "on_demand",
  cost: 0.0566408333332721,
};

test("mapRow maps the activity row to canonical", () => {
  const rec = mapRow(ROW);
  assert.equal(rec.source, "groq-official");
  assert.equal(rec.model, "whisper-large-v3");
  assert.equal(rec.time, "2026-09-12T00:00:00.000Z");
  assert.equal(rec.date, "2026-09-12");
  assert.equal(rec.input, 759);
  assert.equal(rec.cacheRead, 0); // context == non-cached in the sample
  assert.equal(rec.output, 6021);
  assert.equal(rec.reasoning, 0);
  assert.equal(rec.cacheWrite5m, 0);
  assert.equal(rec.cacheWrite1h, 0);
  assert.equal(rec.requests, 151);
  assert.ok(Math.abs(rec.vendorCost - 0.0566408333332721) < 1e-12);
  assert.equal(rec.keyID, "open");
  assert.equal(rec.workspaceID, "Personal");
  assert.match(rec.id, /^groq-official:[0-9a-f]{8}$/);
  assert.equal(rec.v, 1);
});

test("mapRow derives cacheRead from the context split and never goes negative", () => {
  const rec = mapRow({ ...ROW, n_context_tokens_total: 1000, n_non_cached_context_tokens_total: 700 });
  assert.equal(rec.input, 700);
  assert.equal(rec.cacheRead, 300);
  const neg = mapRow({ ...ROW, n_context_tokens_total: 100, n_non_cached_context_tokens_total: 700 });
  assert.equal(neg.input, 700);
  assert.equal(neg.cacheRead, 0);
});

test("mapRow keeps audit fields in raw and drops the masked credential", () => {
  const rec = mapRow(ROW);
  assert.deepEqual(rec.raw, {
    api_key_id: "key_test",
    api_key_name: "open",
    project_id: "project_test",
    service_tier: "on_demand",
    num_seconds: 1474,
    num_seconds_billed: 1837,
  });
  assert.equal(JSON.stringify(rec).includes("api_key_redacted"), false);
  assert.equal(JSON.stringify(rec).includes("gsk_"), false);
});

test("mapRow rejects rows without model/timestamp and empty days", () => {
  assert.equal(mapRow({ ...ROW, model: "" }), null);
  assert.equal(mapRow({ ...ROW, timestamp: 0 }), null);
  assert.equal(mapRow(null), null);
  assert.equal(
    mapRow({ ...ROW, n_context_tokens_total: 0, n_non_cached_context_tokens_total: 0, n_generated_tokens_total: 0, num_requests: 0 }),
    null
  );
});

test("mapRow ids are stable per (day, model, key) and differ across keys", () => {
  assert.equal(mapRow(ROW).id, mapRow(ROW).id);
  assert.notEqual(mapRow(ROW).id, mapRow({ ...ROW, api_key_id: "key_other", api_key_name: "second" }).id);
  assert.notEqual(mapRow(ROW).id, mapRow({ ...ROW, timestamp: 1789257600 }).id);
  assert.equal(mapRows([ROW, { model: "x" }]).length, 1); // invalid dropped (no dedupe here; the crawler dedupes by id)
});

test("rowsFromResponse unwraps the list envelope", () => {
  assert.equal(rowsFromResponse({ object: "list", data: [ROW] }).length, 1);
  assert.deepEqual(rowsFromResponse(null), []);
  assert.deepEqual(rowsFromResponse({ object: "list" }), []);
});

test("orgsFromProfile lists org ids for the crawler", () => {
  const profile = { user: { orgs: { object: "list", data: [{ id: "org_a" }, { id: "org_b" }, {}] } } };
  assert.deepEqual(orgsFromProfile(profile), ["org_a", "org_b"]);
  assert.deepEqual(orgsFromProfile(null), []);
  assert.deepEqual(orgsFromProfile({}), []);
});
