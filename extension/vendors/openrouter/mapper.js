// extension/vendors/openrouter/mapper.js
// OpenRouter analytics-query row -> canonical record. Pure (P9): no chrome,
// no DOM. Values come back as strings; missing cache split is filled per P7.
//
// Row schema observed 2026-09 (cookie auth, /api/frontend/v1/private/analytics-query):
//   with dimensions:    created_at__day | created_at__hour | created_at__month
//   without dimensions: date__day | date__hour | date__month
//   { <dateField>, model, provider?, total_usage, request_count, cache_hit_rate,
//     tokens_prompt, tokens_completion, reasoning_tokens, cached_tokens,
//     byok_usage, byok_request_count }
//
// Mapping (vendors.md OpenRouter):
//   input      = tokens_prompt - cached_tokens   (never negative)
//   cacheRead  = cached_tokens
//   output     = tokens_completion - reasoning_tokens   (canonical output
//                EXCLUDES reasoning; tokens_completion already includes it,
//                reasoning_tokens is a subset — see shared/canonical
//                exclusiveOutput, so reasoning is never double counted)
//   reasoning  = reasoning_tokens
//   cacheWrite = 0 (no metric; P7)
//   requests   = request_count
// Vendor money fields (total_usage, byok_usage) are NOT read (P1/D16); the whole
// row is kept in `raw` (D18).

import { normalizeRecord, makeId, dayToISO, exclusiveOutput } from "../../shared/canonical.js";

export const OPENROUTER_SOURCE = "openrouter";

const DATE_FIELDS = [
  "created_at__day",
  "created_at__hour",
  "created_at__month",
  "date__day",
  "date__hour",
  "date__month",
];

const num = (v) => {
  const n = Number(v);
  return isNaN(n) ? 0 : n;
};

// Naive date/hour/month values are treated as UTC (P8; the `timezone` request
// param had no effect on these fields in testing, B3 open question). Day
// granularity uses the D22 day anchor (UTC midnight).
export function granularityToISO(value) {
  const s = String(value == null ? "" : value).trim();
  let m = /^(\d{4}-\d{2}-\d{2})$/.exec(s);
  if (m) return dayToISO(s);
  m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/.exec(s);
  if (m) return `${m[1]}T${m[2]}Z`;
  m = /^(\d{4}-\d{2})$/.exec(s);
  if (m) return dayToISO(`${s}-01`);
  return null;
}

export function dateFieldOf(row) {
  for (const f of DATE_FIELDS) if (row && row[f] != null && row[f] !== "") return f;
  return null;
}

// Stable per-record id from vendor fields (D4/D19): the original date string,
// model and provider, so re-crawling the same row never duplicates.
function rowKey(row, field) {
  return [OPENROUTER_SOURCE, String(row[field]), row.model, row.provider || ""].join("|");
}

export function mapRow(row, { source = OPENROUTER_SOURCE } = {}) {
  if (!row || !row.model) return null;
  const field = dateFieldOf(row);
  if (!field) return null;
  const time = granularityToISO(row[field]);
  if (!time) return null;

  const prompt = num(row.tokens_prompt);
  const cached = num(row.cached_tokens);
  const reasoning = num(row.reasoning_tokens);
  const rec = normalizeRecord(
    {
      id: makeId(source, null, rowKey(row, field)),
      source,
      time,
      model: row.model,
      provider: row.provider || undefined,
      input: Math.max(0, prompt - cached),
      output: exclusiveOutput(row.tokens_completion, reasoning),
      reasoning,
      cacheRead: cached,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      requests: num(row.request_count),
      // Vendor-reported spend in USD (the Activity "Spend"), high precision.
      // OpenRouter's cost basis; see core/pricing-config priceWithConfig.
      vendorCost: num(row.total_usage),
      raw: row,
    },
    { source }
  );
  return rec;
}

export function mapRows(rows, opts) {
  const out = [];
  for (const row of rows || []) {
    const rec = mapRow(row, opts);
    if (rec) out.push(rec);
  }
  return out;
}

// Extract the rows array from the { data: { data, metadata } } envelope.
export function rowsFromResponse(json) {
  const d = json && json.data;
  const rows = d && d.data;
  return Array.isArray(rows) ? rows : [];
}

export function metadataFromResponse(json) {
  return (json && json.data && json.data.metadata) || null;
}

export function isTruncated(metadata) {
  return !!(metadata && metadata.truncated);
}
