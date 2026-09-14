// extension/vendors/openrouter/analytics-query.js
// Request body + time-window slicing for the private analytics-query endpoint.
// Pure (P9): no chrome, no DOM.
//
// Server constraint (observed 2026-09): with the `provider` dimension the
// time_range is capped at 31 days ("time_range exceeds maximum of 31 days for
// the requested metrics/dimensions"). We slice into <=30-day windows so a full
// 365-day history is fetched in a handful of requests.

export const OPENROUTER_METRICS = [
  "total_usage",
  "request_count",
  "cache_hit_rate",
  "tokens_prompt",
  "tokens_completion",
  "reasoning_tokens",
  "cached_tokens",
  "byok_usage",
  "byok_request_count",
];

export const MAX_WINDOW_DAYS = 30;

export const DAY_MS = 86400000;

export function buildQueryBody({ start, end, dimensions = ["model", "provider"], limit = 1000, granularity = "day" }) {
  return {
    metrics: OPENROUTER_METRICS.slice(),
    dimensions,
    granularity,
    order_by: { field: "date", direction: "asc" },
    limit,
    time_range: { start, end },
  };
}

// Split [startIso, endIso) into contiguous windows of at most `maxDays`.
export function sliceRange(startIso, endIso, maxDays = MAX_WINDOW_DAYS) {
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  if (!isFinite(start) || !isFinite(end) || start >= end || !(maxDays > 0)) return [];
  const step = maxDays * DAY_MS;
  const windows = [];
  let cursor = start;
  while (cursor < end) {
    const next = Math.min(cursor + step, end);
    windows.push({ start: new Date(cursor).toISOString(), end: new Date(next).toISOString() });
    cursor = next;
  }
  return windows;
}
