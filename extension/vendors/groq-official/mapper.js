// extension/vendors/groq-official/mapper.js
// Groq platform /activity row -> canonical record. Pure (P9): no chrome, no DOM.
//
// Endpoint (from the Usage page console, 2026-09):
//   GET https://api.groq.com/platform/v1/organizations/{org}/activity
//       ?start_date=<unix-sec>&end_date=<unix-sec>
//   headers: authorization: Bearer <stytch_session_jwt cookie>,
//            groq-organization: <org_id>
//
// Response: { object: "list", data: [
//   { organization_id, organization_name, n_context_tokens_total,
//     n_non_cached_context_tokens_total, n_generated_tokens_total,
//     project_id, api_key_id, api_key_name,
//     api_key_redacted (masked credential, dropped),
//     model, timestamp (unix sec, UTC midnight -> day granularity),
//     user_id, user, num_requests, num_seconds, num_seconds_billed,
//     plan_id, subscription_id, service_tier, cost (USD) } ] }
//
// Mapping:
//   input     = n_non_cached_context_tokens_total
//   cacheRead = n_context_tokens_total - n_non_cached (never negative)
//   output    = n_generated_tokens_total (no separate reasoning field)
//   requests  = num_requests, reasoning = 0, cacheWrite = 0.
//   vendorCost = cost (USD; costSource "vendor", no costScale).
// `raw` keeps api_key_id/name, project_id, service_tier and num_seconds* for
// audit; it is never read/summed by core (D18).

import { normalizeRecord, makeId } from "../../shared/canonical.js";

export const GROQ_SOURCE = "groq-official";

const num = (v) => {
  const n = Number(v);
  return isFinite(n) ? n : 0;
};

// One row per (day x model x API key). Rows aggregate the same day across keys,
// so re-crawling the same row never duplicates (D4/D19).
function rowKey(row) {
  return [row.timestamp, row.model, row.api_key_id || "", row.project_id || ""].join("|");
}

export function mapRow(row, { source = GROQ_SOURCE } = {}) {
  if (!row || !row.model) return null;
  const ts = num(row.timestamp);
  if (!ts) return null;
  // timestamp is a UTC-midnight unix second; the stored time keeps the exact
  // instant (the canonical date is derived from it, P8).
  const time = new Date(ts * 1000).toISOString();

  const context = num(row.n_context_tokens_total);
  const nonCached = num(row.n_non_cached_context_tokens_total);
  const output = num(row.n_generated_tokens_total);
  const requests = num(row.num_requests);
  const cacheRead = Math.max(0, context - nonCached);
  if (nonCached + cacheRead + output + requests === 0) return null; // empty day

  const raw = {};
  for (const k of ["api_key_id", "api_key_name", "project_id", "service_tier", "num_seconds", "num_seconds_billed"]) {
    if (row[k] != null && row[k] !== "") raw[k] = row[k];
  }

  return normalizeRecord(
    {
      id: makeId(source, null, rowKey(row)),
      source,
      time,
      model: row.model,
      workspaceID: row.organization_name || undefined,
      keyID: row.api_key_name || undefined,
      input: nonCached,
      output,
      reasoning: 0,
      cacheRead,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      requests,
      vendorCost: num(row.cost),
      raw,
    },
    { source }
  );
}

export function mapRows(rows, opts) {
  const out = [];
  for (const row of rows || []) {
    const rec = mapRow(row, opts);
    if (rec) out.push(rec);
  }
  return out;
}

// Extract the rows array from the { object: "list", data: [...] } envelope.
export function rowsFromResponse(json) {
  const rows = json && json.data;
  return Array.isArray(rows) ? rows : [];
}

// Org ids from GET /platform/v1/user/profile -> { user: { orgs: { data: [{ id }] } } }.
export function orgsFromProfile(json) {
  const data = json && json.user && json.user.orgs && json.user.orgs.data;
  if (!Array.isArray(data)) return [];
  return data.map((o) => o && o.id).filter((id) => typeof id === "string" && id !== "");
}
