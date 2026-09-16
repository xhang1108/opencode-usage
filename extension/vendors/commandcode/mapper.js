// extension/vendors/commandcode/mapper.js
// CommandCode /internal/usage row -> canonical. Pure (P9).
//
// Usage API (cookie auth, keyset paging via nextCursor):
//   { usages: [{ id, createdAt, meta: { model, tokensIn, tokensOut,
//     inputCost, outputCost, cacheCost }, status, type, mode }], nextCursor,
//     periodBasis, window: { days, entries } }
//
// CommandCode does not return a cache token split; only costs. Per D16 we
// reverse-derive input/cacheRead from the cost columns using the price table
// (derived by `ratesFor`), with a guard; on failure we fall back to
// input = tokensIn, cacheRead = 0, cacheBasis: "unknown". The cost columns are
// opaque: their sum is stored as vendorCost and never displayed/summed (D16).

import { normalizeRecord } from "../../shared/canonical.js";

export const COMMANDCODE_SOURCE = "commandcode";

const num = (v) => {
  const n = Number(v);
  return isFinite(n) ? n : 0;
};

const costFor = (tokens, ratePerM) => (tokens * ratePerM) / 1e6;
const tokensFor = (cost, ratePerM) => (ratePerM > 0 ? Math.round((cost * 1e6) / ratePerM) : null);

// `ratesFor(usage)` -> { input, output, cacheRead } USD per 1M, or null.
export function mapUsage(usage, { ratesFor } = {}) {
  if (!usage || typeof usage !== "object") return null;
  const meta = usage.meta || {};
  const model = meta.model || usage.model;
  const time = usage.createdAt || usage.time;
  if (!model || !time) return null;

  const tokensIn = num(meta.tokensIn);
  const tokensOut = num(meta.tokensOut);
  const inputCost = num(meta.inputCost);
  const outputCost = num(meta.outputCost);
  const cacheCost = num(meta.cacheCost);

  let input = tokensIn;
  let cacheRead = 0;
  let cacheBasis = "unknown";

  const rates = ratesFor ? ratesFor(usage) : null;
  if (rates && rates.input > 0 && rates.output > 0) {
    const derivedIn = tokensFor(inputCost, rates.input);
    const derivedCache = rates.cacheRead > 0 ? tokensFor(cacheCost, rates.cacheRead) : cacheCost === 0 ? 0 : null;
    const outputOk = Math.abs(costFor(tokensOut, rates.output) - outputCost) <= Math.max(1e-9, outputCost * 1e-6);
    if (derivedIn !== null && derivedCache !== null && derivedIn + derivedCache === tokensIn && outputOk) {
      input = derivedIn;
      cacheRead = derivedCache;
      cacheBasis = "derived";
    }
  }

  return normalizeRecord(
    {
      id: usage.id != null ? `${COMMANDCODE_SOURCE}:${usage.id}` : undefined,
      source: COMMANDCODE_SOURCE,
      time,
      model,
      input,
      output: tokensOut,
      reasoning: 0,
      cacheRead,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      requests: 1,
      vendorCost: inputCost + outputCost + cacheCost,
      cacheBasis,
      raw: usage,
    },
    { source: COMMANDCODE_SOURCE }
  );
}

export function mapUsages(usages, opts) {
  const out = [];
  for (const u of usages || []) {
    const rec = mapUsage(u, opts);
    if (rec) out.push(rec);
  }
  return out;
}

// ---------------------------------------------------------------------------
// /internal/usage/charts rows (aggregated per time bucket x model x provider).
// This endpoint is NOT capped at 100 and returns cache tokens + cost natively,
// so it is the primary CommandCode source (granularity=day, from/to windows).
// Row: { model, provider, timeBucket, requests, totalCost, tokensIn, tokensOut,
//        cacheReadInputTokens, cacheCreationInputTokens, ... }
// ---------------------------------------------------------------------------

export function bucketToISO(value) {
  const s = String(value == null ? "" : value).trim().replace(" ", "T");
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s)) return `${s}:00Z`;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(s)) return `${s}Z`;
  return null;
}

export function mapChartBucket(bucket, { source = COMMANDCODE_SOURCE } = {}) {
  if (!bucket || !bucket.model || !bucket.timeBucket) return null;
  const time = bucketToISO(bucket.timeBucket);
  if (!time) return null;
  const cacheRead = num(bucket.cacheReadInputTokens);
  const cacheWrite = num(bucket.cacheCreationInputTokens);
  const tokensIn = num(bucket.tokensIn);
  const provider = bucket.provider || "";
  return normalizeRecord(
    {
      id: `${source}:${bucket.model}:${provider}:${String(bucket.timeBucket).replace(/ /g, "T")}`,
      source,
      time,
      model: bucket.model,
      provider: provider || undefined,
      input: Math.max(0, tokensIn - cacheRead),
      output: num(bucket.tokensOut),
      reasoning: 0,
      cacheRead,
      cacheWrite5m: cacheWrite,
      cacheWrite1h: 0,
      requests: num(bucket.requests),
      vendorCost: num(bucket.totalCost),
      cacheBasis: "vendor",
      raw: bucket,
    },
    { source }
  );
}

export function mapChartBuckets(buckets, opts) {
  const out = [];
  for (const b of buckets || []) {
    const rec = mapChartBucket(b, opts);
    if (rec) out.push(rec);
  }
  return out;
}
