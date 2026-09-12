import { test } from "node:test";
import assert from "node:assert/strict";

import {
  localDateOf,
  localHourOf,
  toISODate,
  todayISO,
  inclusiveDayDiff,
  localDateRange,
} from "../../extension/dashboard/core/time.js";

test("localDateOf groups by viewer local time, not UTC (D19)", () => {
  // Build an instant from local components; its local date must round-trip.
  const local = new Date(2026, 0, 15, 23, 30);
  const rec = { time: local.toISOString(), date: "1999-01-01" };
  assert.equal(localDateOf(rec), toISODate(local));
  // stored date is ignored
  assert.notEqual(localDateOf(rec), rec.date);
});

test("localDateOf falls back to stored date for unparseable time", () => {
  assert.equal(localDateOf({ time: "nope", date: "2026-06-15" }), "2026-06-15");
  assert.equal(localDateOf({}), "");
});

test("localHourOf returns local hour", () => {
  const local = new Date(2026, 5, 1, 9, 45);
  assert.equal(localHourOf({ time: local.toISOString() }), 9);
  assert.equal(localHourOf({ time: "nope" }), null);
});

test("todayISO formats a local date", () => {
  assert.equal(todayISO(new Date(2026, 8, 12, 1, 0)), "2026-09-12");
});

test("inclusiveDayDiff counts inclusive days and guards bad input", () => {
  assert.equal(inclusiveDayDiff("2026-09-01", "2026-09-30"), 30);
  assert.equal(inclusiveDayDiff("2026-09-10", "2026-09-10"), 1);
  assert.equal(inclusiveDayDiff("bad", "2026-09-10"), 0);
});

test("localDateRange finds min/max local dates", () => {
  const local = (y, m, d) => new Date(y, m - 1, d, 12, 0).toISOString();
  const range = localDateRange([
    { time: local(2026, 9, 10) },
    { time: local(2026, 9, 12) },
    { time: local(2026, 9, 8) },
  ]);
  assert.equal(range.min, "2026-09-08");
  assert.equal(range.max, "2026-09-12");
});
