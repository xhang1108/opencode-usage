import { test } from "node:test";
import assert from "node:assert/strict";

import {
  payloadFromResponse,
  mapSeriesPayload,
  usedDaysFromPayload,
} from "../../extension/vendors/deepseek-official/mapper.js";

// Real response shape (2026-09): double-wrapped, payload under biz_data, with
// usage split per API key. Two keys share model + hour -> must aggregate.
const RESPONSE = {
  code: 0,
  msg: "",
  data: {
    biz_code: 0,
    biz_msg: "",
    biz_data: {
      start: 1783440000,
      end: 1783526400,
      bucket: 3600,
      models: ["deepseek-v4-flash"],
      series: [
        {
          api_key: { tracking_id: "58daa399-f4b1-46ec-a0ce-55890d86a469", name: "TRAE", sensitive_id: "sk-c9a8b***11c2", valid: true },
          model: "deepseek-v4-flash",
          buckets: [
            { time: 1783440000, usage: { RESPONSE_TOKEN: 0, REQUEST: 0, PROMPT_CACHE_HIT_TOKEN: 0, PROMPT_CACHE_MISS_TOKEN: 0 } },
            { time: 1783443600, usage: { RESPONSE_TOKEN: 100, REQUEST: 3, PROMPT_CACHE_HIT_TOKEN: 9000, PROMPT_CACHE_MISS_TOKEN: 500 } },
          ],
        },
        {
          api_key: { tracking_id: "11111111-2222-3333-4444-555555555555", name: "KeyB", sensitive_id: "sk-other***9f2a", valid: true },
          model: "deepseek-v4-flash",
          buckets: [
            { time: 1783443600, usage: { RESPONSE_TOKEN: 50, REQUEST: 1, PROMPT_CACHE_HIT_TOKEN: 1000, PROMPT_CACHE_MISS_TOKEN: 200 } },
          ],
        },
      ],
    },
  },
};

test("payloadFromResponse unwraps both wrapper shapes", () => {
  assert.equal(payloadFromResponse(RESPONSE).bucket, 3600);
  assert.equal(payloadFromResponse(RESPONSE.data).bucket, 3600);
  assert.equal(payloadFromResponse({ code: 40002, msg: "Missing Token", data: null }), null);
});

test("mapSeriesPayload aggregates across API keys into one record per (model, hour)", () => {
  const recs = mapSeriesPayload(RESPONSE);
  assert.equal(recs.length, 1); // both keys merged; empty hour skipped
  const r = recs[0];
  assert.equal(r.source, "deepseek-official");
  assert.equal(r.model, "deepseek-v4-flash");
  assert.equal(r.workspaceID, "Deepseek Official");
  assert.equal(r.keyID, undefined);
  assert.equal(r.time, "2026-07-07T17:00:00.000Z"); // 1783443600 = 2026-07-08 01:00 +08
  assert.equal(r.input, 700); // 500 + 200
  assert.equal(r.cacheRead, 10000); // 9000 + 1000
  assert.equal(r.output, 150); // 100 + 50
  assert.equal(r.requests, 4); // 3 + 1
  assert.equal(r.reasoning, 0);
  assert.equal(r.cacheWrite5m, 0);
  assert.match(r.id, /^deepseek-official:[0-9a-f]{8}$/);
});

test("mapSeriesPayload keeps only the per-key identity in raw.byApiKey", () => {
  const r = mapSeriesPayload(RESPONSE)[0];
  assert.equal(r.raw.byApiKey.length, 2);
  assert.deepEqual(r.raw.byApiKey[0], { tracking_id: "58daa399-f4b1-46ec-a0ce-55890d86a469", name: "TRAE" });
  assert.deepEqual(r.raw.byApiKey[1], { tracking_id: "11111111-2222-3333-4444-555555555555", name: "KeyB" });
  // no duplicated usage copy / bucket / valid is stored
  assert.equal(r.raw.bucket, undefined);
  assert.equal(r.raw.byApiKey[0].usage, undefined);
  assert.equal(r.raw.byApiKey[0].valid, undefined);
});

test("mapSeriesPayload drops the masked credential (B8)", () => {
  const r = mapSeriesPayload(RESPONSE)[0];
  assert.equal(JSON.stringify(r).includes("sensitive_id"), false);
  assert.equal(JSON.stringify(r).includes("sk-"), false);
});

// /cost endpoint (CNY) — stored verbatim for completeness (D18).
const COST_RESPONSE = {
  code: 0,
  msg: "",
  data: {
    biz_code: 0,
    biz_msg: "",
    biz_data: {
      start: 1783440000,
      end: 1783526400,
      bucket: 3600,
      models: ["deepseek-v4-flash"],
      data: [
        {
          currency: "CNY",
          series: [
            {
              api_key: { tracking_id: "58daa399-f4b1-46ec-a0ce-55890d86a469", name: "TRAE", sensitive_id: "sk-c9a8b***11c2", valid: true },
              model: "deepseek-v4-flash",
              buckets: [
                { time: 1783440000, cost: "0" },
                { time: 1783443600, cost: "0.12" },
              ],
            },
            {
              api_key: { tracking_id: "11111111-2222-3333-4444-555555555555", name: "KeyB", sensitive_id: "sk-other***9f2a", valid: true },
              model: "deepseek-v4-flash",
              buckets: [{ time: 1783443600, cost: "0.03" }],
            },
          ],
        },
      ],
    },
  },
};

test("mapSeriesPayload merges the /cost payload into raw.byApiKey", () => {
  const r = mapSeriesPayload(RESPONSE, { costJson: COST_RESPONSE })[0];
  assert.deepEqual(r.raw.byApiKey[0], {
    tracking_id: "58daa399-f4b1-46ec-a0ce-55890d86a469",
    name: "TRAE",
    cost: [{ currency: "CNY", cost: "0.12" }],
  });
  assert.deepEqual(r.raw.byApiKey[1].cost, [{ currency: "CNY", cost: "0.03" }]);
  // canonical cost is still derived (P1); the CNY value is only in raw
  assert.equal(r.cost, undefined);
  assert.equal(JSON.stringify(r).includes("sensitive_id"), false);
});

test("mapSeriesPayload without cost leaves raw.byApiKey cost absent", () => {
  const r = mapSeriesPayload(RESPONSE)[0];
  assert.equal(r.raw.byApiKey[0].cost, undefined);
});

test("mapSeriesPayload ids are stable across identical payloads", () => {
  assert.deepEqual(mapSeriesPayload(RESPONSE).map((r) => r.id), mapSeriesPayload(RESPONSE).map((r) => r.id));
});

test("usedDaysFromPayload returns +08 calendar days with usage", () => {
  assert.deepEqual(usedDaysFromPayload(RESPONSE), ["2026-07-08"]);
  const empty = JSON.parse(JSON.stringify(RESPONSE));
  empty.data.biz_data.series.forEach((s) =>
    s.buckets.forEach((b) => {
      b.usage = { RESPONSE_TOKEN: 0, REQUEST: 0, PROMPT_CACHE_HIT_TOKEN: 0, PROMPT_CACHE_MISS_TOKEN: 0 };
    })
  );
  assert.deepEqual(usedDaysFromPayload(empty), []);
});
