// extension/dashboard/views/table-model.js
// Row shaping for the workspace and model tables. Kept pure (no DOM) so the
// column math is testable; tables.js only renders these rows and sorts them.
//
// NOTE the two hit-rate definitions are intentional and differ:
//   - the workspace table uses `stats.prompt` (the aggregator's prompt total)
//   - the model/daily tables use `input + cacheRead`
// They are pinned by tests so a future "cleanup" can't silently change a column.

const pct = (part, whole) => (whole > 0 ? (part / whole) * 100 : 0);

export function workspaceRows(wsMap) {
  return Object.entries(wsMap || {}).map(([ws, stats]) => ({
    ws,
    req: stats.req,
    tokens: stats.tokens,
    hitRate: pct(stats.cacheRead, stats.prompt),
    cost: stats.cost,
  }));
}

export function modelRows(modelMap) {
  return Object.entries(modelMap || {}).map(([key, stats]) => ({
    model: stats.model || key,
    source: stats.source || "",
    req: stats.req,
    input: stats.input,
    output: stats.output,
    cacheRead: stats.cacheRead,
    hitRate: pct(stats.cacheRead, stats.input + stats.cacheRead),
    peakCost: stats.peakCost,
    offpeakCost: stats.offpeakCost,
    flatCost: stats.flatCost,
    cost: stats.cost,
  }));
}

export function dailyRows(singleModelDailyMap) {
  return Object.entries(singleModelDailyMap || {}).map(([date, stats]) => ({
    date,
    req: stats.req,
    input: stats.input,
    output: stats.output,
    cacheRead: stats.cacheRead,
    hitRate: pct(stats.cacheRead, stats.input + stats.cacheRead),
    cost: stats.cost,
  }));
}
