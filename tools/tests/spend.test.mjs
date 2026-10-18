import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SPEND_SCHEMA_VERSION,
  makeSpendId,
  normalizeSpendEntry,
  validateSpendEntry,
  aggregateSpend,
  computeRoi,
} from "../../extension/shared/spend.js";

const NOW = new Date("2026-10-01T12:00:00.000Z");

test("normalizeSpendEntry fills defaults and derives nothing for month", () => {
  const e = normalizeSpendEntry(
    { platform: "opencode", date: "2026-08-15", amountUSD: "10.5" },
    { now: () => NOW }
  );
  assert.equal(e.platform, "opencode");
  assert.equal(e.date, "2026-08-15");
  assert.equal(e.amountUSD, 10.5);
  assert.equal(e.note, "");
  assert.equal(e.createdAt, NOW.toISOString());
  assert.equal(e.updatedAt, NOW.toISOString());
  assert.ok(String(e.id).startsWith("spend:"));
  assert.equal(e.v, SPEND_SCHEMA_VERSION);
});

test("normalizeSpendEntry trims note", () => {
  const long = "x".repeat(600);
  const e = normalizeSpendEntry(
    { platform: "  other  ", platformLabel: "  Cursor  ", date: "2026-08-15", amountUSD: 5, note: `  ${long}  ` },
    { now: () => NOW }
  );
  assert.equal(e.platform, "other");
  assert.equal(e.platformLabel, "Cursor");
  assert.equal(e.note.length, 600);
  assert.equal(validateSpendEntry(e).ok, false);
});

test("validateSpendEntry accepts valid entry", () => {
  const e = normalizeSpendEntry(
    { platform: "opencode", date: "2026-08-15", amountUSD: 10 },
    { now: () => NOW }
  );
  assert.deepEqual(validateSpendEntry(e), { ok: true });
});

test("validateSpendEntry rejects bad inputs", () => {
  const base = { platform: "opencode", date: "2026-08-15", amountUSD: 10 };
  const mk = (patch) => normalizeSpendEntry({ ...base, ...patch }, { now: () => NOW });
  assert.equal(validateSpendEntry(null).ok, false);
  assert.equal(validateSpendEntry(mk({ platform: "" })).ok, false);
  assert.equal(validateSpendEntry(mk({ platform: "other", platformLabel: "" })).ok, false);
  assert.equal(validateSpendEntry(mk({ date: "2026-02-30" })).ok, false);
  assert.equal(validateSpendEntry(mk({ date: "2026-08" })).ok, false);
  assert.equal(validateSpendEntry(mk({ amountUSD: 0 })).ok, false);
  assert.equal(validateSpendEntry(mk({ amountUSD: -1 })).ok, false);
  assert.equal(validateSpendEntry(mk({ amountUSD: "abc" })).ok, false);
  assert.equal(validateSpendEntry(mk({ note: "x".repeat(501) })).ok, false);
});

test("aggregateSpend filters by date and platform and aggregates", () => {
  const entries = [
    normalizeSpendEntry({ platform: "opencode", date: "2026-08-10", amountUSD: 10 }, { now: () => NOW }),
    normalizeSpendEntry({ platform: "opencode", date: "2026-09-05", amountUSD: 10 }, { now: () => NOW }),
    normalizeSpendEntry({ platform: "commandcode", platformLabel: "CommandCode", date: "2026-08-20", amountUSD: 5 }, { now: () => NOW }),
  ];
  const all = aggregateSpend(entries, { startDate: "2026-08-01", endDate: "2026-08-31" });
  assert.equal(all.totalSpent, 15);
  assert.deepEqual(all.days, ["2026-08-10", "2026-08-20"]);
  assert.equal(all.byMonth["2026-08"], 15);
  assert.equal(all.byPlatform.opencode.spent, 10);
  assert.equal(all.byPlatform.commandcode.label, "CommandCode");

  const one = aggregateSpend(entries, { platform: "opencode" });
  assert.equal(one.totalSpent, 20);
  assert.equal(one.entries.length, 2);
});

test("computeRoi handles zero spend", () => {
  assert.deepEqual(computeRoi(100, 10), { net: 90, ratio: 10, valuePerDollar: 10 });
  assert.deepEqual(computeRoi(100, 0), { net: 100, ratio: null, valuePerDollar: null });
});

test("makeSpendId is deterministic", () => {
  const e = { platform: "opencode", date: "2026-08-10", amountUSD: 10, note: "n", createdAt: "2026-10-01T12:00:00.000Z" };
  assert.equal(makeSpendId(e), makeSpendId(e));
});
