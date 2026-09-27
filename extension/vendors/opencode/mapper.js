// vendors/opencode/mapper.js
// Pure mappers for the opencode Console request log. Loaded by
// vendors/opencode/api.js (content script) via chrome.runtime.getURL, so it
// must stay free of chrome/DOM dependencies (P9) and unit-testable.
//
// The Console exposes per-request log entries as JSON:
//   GET /console/api/request-logs?category=inference&limit=100&since=<ms>&cursor=...&until=...
//   headers: x-org-id: <org>
// Each item is one request (schema `je` in the Console bundle). Only
// category=inference rows carry token/cost fields. `cursor` must be sent
// together with the previous page's `until`, else the server 409s
// (RequestLogCursorRestartRequired). Retention is ~30d.
//
// Replaces the removed GET /console/api/usage/rows (UsageSelect) endpoint.

import { exclusiveOutput, normalizeRecord } from "../../shared/canonical.js";

// The Console route is /console/<orgId>/<tab>; orgId matches ^(org_|wrk_).
export function orgIdFromPath(pathname) {
  const m = /^\/console\/((?:org_|wrk_)[^/]+)/.exec(String(pathname || ""));
  return m ? m[1] : null;
}

export const USAGE_ROWS_PATH = "/console/api/request-logs";
export const USAGE_ROWS_MAX_PAGE_SIZE = 100;
export const USAGE_ROWS_CATEGORY = "inference";

// Build a request-log list URL. `since`/`until` are ms epochs (numbers or
// numeric strings); `cursor` is the opaque previous-page cursor.
export function buildRowsUrl({ since = null, cursor = null, until = null, limit = USAGE_ROWS_MAX_PAGE_SIZE } = {}) {
  const size = Math.min(Math.max(1, Number(limit) || USAGE_ROWS_MAX_PAGE_SIZE), USAGE_ROWS_MAX_PAGE_SIZE);
  const p = new URLSearchParams();
  p.set("category", USAGE_ROWS_CATEGORY);
  p.set("limit", String(size));
  if (since != null) p.set("since", String(since));
  if (until != null) p.set("until", String(until));
  if (cursor) p.set("cursor", cursor);
  return `${USAGE_ROWS_PATH}?${p.toString()}`;
}

// One request-log item -> canonical record.
//
// Differences from the old UsageSelect rows:
// - timestamps are ms epochs (`startedAt`); normalizeRecord coerces to ISO.
// - `outputTokens` is INCLUSIVE of `reasoningTokens` (same as the old rows),
//   so `output` is stored exclusive and flagged outputExcludesReasoning.
// - `cost` is a number in microcents-or-USD-to-be-determined; it maps to
//   `vendorCost` with costScale until a paid sample pins the unit down.
// - `cacheWriteTokens` is the only write bucket (no 5m/1h split); it lands in
//   `cacheWrite5m` and `cacheWrite1h` stays 0.
// - non-inference categories and non-succeeded outcomes have no tokens and are
//   skipped (they would fail validateRecord's no-tokens check downstream).
// - `billingSource` no longer exists; free rows are `cost: 0`, rejected rows
//   have no `cost` key at all.
export function mapUsageRow(row, { source = "opencode" } = {}) {
  if (!row || typeof row !== "object") return null;
  if (row.category !== "inference") return null;
  if (row.outcome !== "succeeded") return null;
  const reasoning = Number(row.reasoningTokens) || 0;
  const outputInclusive = Number(row.outputTokens) || 0;
  const rec = {
    id: `${source}:${row.id}`,
    source,
    time: row.startedAt != null ? Number(row.startedAt) : null,
    model: row.model || row.requestedModel || null,
    provider: row.provider || null,
    input: Number(row.inputTokens) || 0,
    output: exclusiveOutput(outputInclusive, reasoning),
    reasoning,
    outputExcludesReasoning: true,
    cacheRead: Number(row.cacheReadTokens) || 0,
    cacheWrite5m: Number(row.cacheWriteTokens) || 0,
    cacheWrite1h: 0,
    vendorCost: row.cost == null ? undefined : Number(row.cost) || 0,
    costScale: 1e8,
    workspaceID: row.workspaceID || null,
    keyID: row.serviceAPIKeyID || null,
    billingSource: null,
    principalType: row.serviceAccountID ? "service-account" : (row.userID ? "user" : null),
    userID: row.userID || row.serviceAccountID || null,
    app: row.app || null,
    sessionID: row.sessionID || null,
  };
  return normalizeRecord(rec, { source });
}

export function mapUsageRows(rows, opts) {
  return (rows || []).map((r) => mapUsageRow(r, opts)).filter(Boolean);
}

// Latest startedAt across rows (rows arrive newest-first, but be defensive).
export function latestCreatedAt(rows) {
  let max = null;
  for (const row of rows || []) {
    const t = row && row.startedAt != null ? Number(row.startedAt) : NaN;
    if (!isNaN(t) && (max == null || t > max)) max = t;
  }
  return max == null ? null : new Date(max).toISOString();
}
