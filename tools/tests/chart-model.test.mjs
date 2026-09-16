import { test } from "node:test";
import assert from "node:assert/strict";

import {
  heatOpacity,
  isoDate,
  yearlyGrid,
  hourlyBuckets,
  modelChartSeries,
} from "../../extension/dashboard/views/chart-model.js";

test("heatOpacity floors at min, peaks at 1, and marks missing data", () => {
  assert.equal(heatOpacity(null, 10, 0.1), 0.03);
  assert.equal(heatOpacity(0, 10, 0.1), 0.1, "zero cost keeps the floor");
  assert.equal(heatOpacity(10, 10, 0.1), 1);
  assert.equal(heatOpacity(2.5, 10, 0), Math.sqrt(0.25));
});

test("isoDate formats a local date with zero padding", () => {
  assert.equal(isoDate(new Date(2026, 8, 6)), "2026-09-06");
  assert.equal(isoDate(new Date(2026, 11, 25)), "2026-12-25");
});

test("yearlyGrid is null without data", () => {
  assert.equal(yearlyGrid([]), null);
  assert.equal(yearlyGrid(undefined), null);
});

test("yearlyGrid spans a 365-day window padded to whole Monday weeks", () => {
  const grid = yearlyGrid(["2026-09-16"]);
  const ymd = (d) => isoDate(d);
  assert.equal(ymd(grid.lastDate), "2026-09-16");
  // 2026-09-16 minus 364 days.
  const expectedFirst = new Date(2026, 8, 16);
  expectedFirst.setDate(expectedFirst.getDate() - 364);
  assert.equal(ymd(grid.firstDate), ymd(expectedFirst));

  assert.ok(grid.weeks.length > 50);
  for (const w of grid.weeks) assert.equal(w.getDay(), 1, "each column starts on a Monday");
  // Columns are contiguous 7-day steps.
  for (let i = 1; i < grid.weeks.length; i++) {
    const diff = (grid.weeks[i] - grid.weeks[i - 1]) / 86400000;
    assert.equal(diff, 7);
  }
  // Month labels tile every column exactly once.
  const spanned = grid.monthGroups.reduce((n, g) => n + g.count, 0);
  assert.equal(spanned, grid.weeks.length);
});

test("yearlyGrid groups a label per month across a year boundary", () => {
  const grid = yearlyGrid(["2026-01-05"]);
  const names = grid.monthGroups.map((g) => `${g.year}-${g.month}`);
  assert.equal(new Set(names).size, names.length, "no month group repeats");
  assert.ok(names.includes("2026-0"));
  assert.ok(names.includes("2025-0"), "the window reaches back into the prior year");
});

test("hourlyBuckets sums a day's minute entries into 24 points", () => {
  const dayData = { 0: { cost: 1, tokens: 10 }, 59: { cost: 2, tokens: 20 }, 60: { cost: 4, tokens: 40 }, 1439: { cost: 8, tokens: 80 } };
  const { labels, costs, tokens } = hourlyBuckets(dayData);
  assert.equal(labels.length, 24);
  assert.equal(labels[0], "00:00");
  assert.equal(labels[23], "23:00");
  assert.equal(costs[0], 3);
  assert.equal(tokens[0], 30);
  assert.equal(costs[1], 4);
  assert.equal(costs[23], 8);
  assert.equal(costs[5], 0);
});

test("hourlyBuckets tolerates a missing day", () => {
  const { costs, tokens } = hourlyBuckets(null);
  assert.deepEqual(costs, Array(24).fill(0));
  assert.deepEqual(tokens, Array(24).fill(0));
});

test("modelChartSeries disambiguates duplicate names and prices hit rate", () => {
  const series = modelChartSeries({
    "opencode:x": { model: "x", source: "opencode", cost: 1, input: 90, cacheRead: 10 },
    "openrouter:x": { model: "x", source: "openrouter", cost: 2, input: 1, cacheRead: 2 },
    "opencode:y": { model: "y", source: "opencode", cost: 3, input: 0, cacheRead: 0 },
  });
  assert.deepEqual(series.labels, ["x (opencode)", "x (openrouter)", "y"]);
  assert.deepEqual(series.costs, [1, 2, 3]);
  assert.deepEqual(series.inputs, [90, 1, 0]);
  assert.deepEqual(series.cacheReads, [10, 2, 0]);
  assert.deepEqual(series.hitRates, [10, 66.67, 0]);
  assert.deepEqual(modelChartSeries({}), { labels: [], costs: [], inputs: [], cacheReads: [], hitRates: [] });
});
