// extension/vendors/deepseek-official/mapper.js
// DeepSeek platform usage API (cookie + Bearer token) -> canonical. Pure (P9).
//
// Endpoint (from the Usage page console, 2026-09):
//   GET /api/v0/usage/by_api_key/amount?start=<unix-sec>&end=<unix-sec>&tz=28800
//   auth: header `authorization: Bearer <localStorage.userToken.value>`
//   (+ x-client-* headers; see content.js)
//
// Response is double-wrapped; the payload lives under `...biz_data`:
//   { start, end, bucket, models: [display labels], series: [
//       { api_key: { tracking_id, name, sensitive_id(masked), valid },
//         model: "deepseek-v4-flash",
//         buckets: [{ time: <unix-sec>, usage: {
//           PROMPT_CACHE_MISS_TOKEN, PROMPT_CACHE_HIT_TOKEN,
//           RESPONSE_TOKEN, REQUEST } }] } ] }
//
// `bucket` is server-chosen: exactly a 1-day range -> 3600 (hourly), anything
// wider -> 86400 (daily). The crawler therefore fetches one day at a time.
//
// Mapping (docs/vendors.md DeepSeek):
//   input = PROMPT_CACHE_MISS_TOKEN, cacheRead = PROMPT_CACHE_HIT_TOKEN,
//   output = RESPONSE_TOKEN, requests = REQUEST, reasoning = 0,
//   cacheWrite = 0. RESPONSE_TOKEN is the completion total (reasoning included)
//   and there is no separate reasoning field, so output stays as-is (no double
//   count). `sensitive_id` is a masked credential and is dropped (B8).

import { normalizeRecord, makeId } from "../../shared/canonical.js";

export const DEEPSEEK_SOURCE = "deepseek-official";

const num = (v) => {
  const n = Number(v);
  return isFinite(n) ? n : 0;
};

// Unwrap { code,msg,data:{ biz_code,biz_msg,biz_data:{...} } } or
// { biz_code,biz_msg,biz_data:{...} } down to the payload object.
export function payloadFromResponse(json) {
  let d = json;
  for (let i = 0; i < 4 && d && typeof d === "object"; i++) {
    if (d.biz_data && typeof d.biz_data === "object") d = d.biz_data;
    else if (d.data && typeof d.data === "object" && d.start === undefined) d = d.data;
    else break;
  }
  return d && typeof d === "object" && d.start !== undefined ? d : null;
}

// payload -> canonical records. Usage is aggregated ACROSS API keys: one record
// per (model, hour). `raw.byApiKey` keeps only the per-key spend (`/cost`, CNY)
// plus the key identity — it is never read/summed by core (D18).
export function mapSeriesPayload(json, { source = DEEPSEEK_SOURCE, costJson } = {}) {
  const payload = payloadFromResponse(json);
  if (!payload || !Array.isArray(payload.series)) return [];
  const costIdx = buildCostIndex(costJson);
  const groups = new Map();
  for (const entry of payload.series) {
    const model = entry && entry.model;
    if (!model) continue;
    const apiKey = (entry && entry.api_key) || {};
    const tracking = apiKey.tracking_id || "";
    const keyName = apiKey.name || "";
    for (const bucket of entry.buckets || []) {
      const u = (bucket && bucket.usage) || {};
      const input = num(u.PROMPT_CACHE_MISS_TOKEN);
      const cacheRead = num(u.PROMPT_CACHE_HIT_TOKEN);
      const output = num(u.RESPONSE_TOKEN);
      const requests = num(u.REQUEST);
      if (input + cacheRead + output + requests === 0) continue; // empty hour
      const timeSec = num(bucket.time);
      if (!timeSec) continue;
      const key = `${model}|${timeSec}`;
      let g = groups.get(key);
      if (!g) {
        g = { model, timeSec, input: 0, cacheRead: 0, output: 0, requests: 0, byApiKey: [] };
        groups.set(key, g);
      }
      g.input += input;
      g.cacheRead += cacheRead;
      g.output += output;
      g.requests += requests;
      // Per-key identity + verbatim spend (CNY) only; the token split is already
      // aggregated above, so the raw row is not duplicated here.
      const cost = costIdx.get(`${tracking}|${model}|${timeSec}`);
      g.byApiKey.push({ tracking_id: tracking, name: keyName, ...(cost ? { cost } : {}) });
    }
  }
  return [...groups.values()]
    .sort((a, b) => a.timeSec - b.timeSec || a.model.localeCompare(b.model))
    .map((g) =>
      normalizeRecord(
        {
          id: makeId(source, null, `${g.model}|${g.timeSec}`),
          source,
          time: new Date(g.timeSec * 1000).toISOString(),
          model: g.model,
          workspaceID: "Deepseek Official",
          input: g.input,
          output: g.output,
          reasoning: 0,
          cacheRead: g.cacheRead,
          cacheWrite5m: 0,
          cacheWrite1h: 0,
          requests: g.requests,
          raw: { model: g.model, time: g.timeSec, byApiKey: g.byApiKey },
        },
        { source }
      )
    );
}

// `/cost` payload -> Map<`<tracking_id>|<model>|<time>`, [{currency, cost}]>.
function buildCostIndex(json) {
  const idx = new Map();
  const payload = payloadFromResponse(json);
  if (!payload || !Array.isArray(payload.data)) return idx;
  for (const group of payload.data) {
    const currency = group && group.currency;
    for (const entry of (group && group.series) || []) {
      const model = entry && entry.model;
      if (!model) continue;
      const tracking = (entry.api_key && entry.api_key.tracking_id) || "";
      for (const bucket of entry.buckets || []) {
        const timeSec = num(bucket && bucket.time);
        if (!timeSec) continue;
        const key = `${tracking}|${model}|${timeSec}`;
        const arr = idx.get(key) || [];
        arr.push({ currency, cost: bucket.cost });
        idx.set(key, arr);
      }
    }
  }
  return idx;
}

// Distinct "+08 calendar day" (YYYY-MM-DD) values that have any usage, from a
// daily-bucket payload. Used to find which days to fetch hourly.
export function usedDaysFromPayload(json, { tzOffsetSec = 28800 } = {}) {
  const payload = payloadFromResponse(json);
  const days = new Set();
  if (!payload || !Array.isArray(payload.series)) return [];
  for (const entry of payload.series) {
    for (const bucket of entry.buckets || []) {
      const u = (bucket && bucket.usage) || {};
      if (num(u.PROMPT_CACHE_MISS_TOKEN) + num(u.PROMPT_CACHE_HIT_TOKEN) + num(u.RESPONSE_TOKEN) + num(u.REQUEST) === 0) continue;
      const d = new Date((num(bucket.time) + tzOffsetSec) * 1000);
      if (!isNaN(d.getTime())) days.add(d.toISOString().slice(0, 10));
    }
  }
  return [...days].sort();
}
