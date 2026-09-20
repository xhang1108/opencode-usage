// vendors/opencode/mapper.js
// Pure mappers for the opencode Console Usage API. Loaded by
// vendors/opencode/api.js (content script) via chrome.runtime.getURL, so it
// must stay free of chrome/DOM dependencies (P9) and unit-testable.
//
// The Console exposes per-request usage rows as JSON:
//   GET /console/api/usage/rows?range=all&pageSize=100&cursor=...&since=...
// Each row is one inference request (UsageSelect). See api.js for the client.

import { exclusiveOutput, normalizeRecord } from "../../shared/canonical.js";

// The Console route is /console/<orgId>/<tab>; orgId matches ^(org_|wrk_).
export function orgIdFromPath(pathname) {
  const m = /^\/console\/((?:org_|wrk_)[^/]+)/.exec(String(pathname || ""));
  return m ? m[1] : null;
}

export const USAGE_ROWS_PATH = "/console/api/usage/rows";
export const USAGE_ROWS_MAX_PAGE_SIZE = 100;

// range is one of 24h | 7d | 30d | all (the API's enum). We always use "all"
// and narrow with `since` — the 30d window would silently hide older history.
export function buildRowsUrl({ since = null, cursor = null, range = "all", pageSize = USAGE_ROWS_MAX_PAGE_SIZE } = {}) {
  const size = Math.min(Math.max(1, Number(pageSize) || USAGE_ROWS_MAX_PAGE_SIZE), USAGE_ROWS_MAX_PAGE_SIZE);
  const p = new URLSearchParams();
  p.set("range", range || "all");
  p.set("pageSize", String(size));
  if (since) p.set("since", since);
  if (cursor) p.set("cursor", cursor);
  return `${USAGE_ROWS_PATH}?${p.toString()}`;
}

// One UsageSelect row -> canonical record.
//
// `outputTokens` in the Console schema is INCLUSIVE of `reasoningTokens` (same
// as the old RSC crawl), so `output` is stored exclusive and flagged
// outputExcludesReasoning to skip the D23 heal. `costMicroCents` is a string in
// microcents (USD * 1e8) and maps to `vendorCost` with the same costScale the
// crawler used, so `costSource: "vendor"` keeps working.
export function mapUsageRow(row, { source = "opencode" } = {}) {
  if (!row || typeof row !== "object") return null;
  const reasoning = Number(row.reasoningTokens) || 0;
  const outputInclusive = Number(row.outputTokens) || 0;
  const rec = {
    id: `${source}:${row.id}`,
    source,
    time: row.createdAt || null,
    model: row.model || null,
    provider: row.provider || null,
    input: Number(row.inputTokens) || 0,
    output: exclusiveOutput(outputInclusive, reasoning),
    reasoning,
    outputExcludesReasoning: true,
    cacheRead: Number(row.cacheReadTokens) || 0,
    cacheWrite5m: Number(row.cacheWrite5mTokens) || 0,
    cacheWrite1h: Number(row.cacheWrite1hTokens) || 0,
    vendorCost: row.costMicroCents == null ? undefined : Number(row.costMicroCents) || 0,
    costScale: 1e8,
    workspaceID: row.orgId || null,
    keyID: row.serviceApiKeyId || null,
    billingSource: row.billingSource || null,
    principalType: row.principalType || null,
    userID: row.userId || row.serviceUserId || null,
    app: row.appTitle || row.appReferrer || null,
  };
  return normalizeRecord(rec, { source });
}

export function mapUsageRows(rows, opts) {
  return (rows || []).map((r) => mapUsageRow(r, opts)).filter(Boolean);
}

// Latest createdAt across rows (rows arrive newest-first, but be defensive).
export function latestCreatedAt(rows) {
  let max = null;
  for (const row of rows || []) {
    const t = row && row.createdAt;
    if (t && (!max || t > max)) max = t;
  }
  return max;
}
