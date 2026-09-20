import { test } from "node:test";
import assert from "node:assert/strict";

import { createSelectState } from "../../extension/dashboard/views/select-state.js";
import { presetRange, pickRangeDay, dateBounds, rangeLabel } from "../../extension/dashboard/core/date-range.js";

// --------------------------------------------------------------- select state
const state = (values, opts = {}) => createSelectState({ optionValues: values, ...opts });

test("a fresh selection is 'all' (empty == no filter)", () => {
  const s = state(["a", "b", "c"]);
  assert.equal(s.isAll(), true);
  assert.deepEqual(s.getSelected(), []);
  assert.equal(s.isChecked("a"), true);
  assert.equal(s.multiLabel(), "All");
});

test("setSelected([]) means all; a list means that explicit set", () => {
  const s = state(["a", "b", "c"]);
  s.setSelected([]);
  assert.deepEqual(s.getSelected(), []);
  s.setSelected(["a", "c"]);
  assert.equal(s.isAll(), false);
  assert.deepEqual(s.getSelected(), ["a", "c"]);
  assert.equal(s.isChecked("b"), false);
});

test("toggling one value off an 'all' set keeps the rest selected", () => {
  const s = state(["a", "b", "c"]);
  s.toggle("b");
  assert.equal(s.isAll(), false);
  assert.deepEqual(s.getSelected(), ["a", "c"]);
  assert.equal(s.isChecked("b"), false);
  assert.equal(s.isChecked("a"), true);
});

test("checking every value back collapses to 'all'", () => {
  const s = state(["a", "b", "c"]);
  s.setSelected(["a", "c"]);
  s.toggle("b");
  assert.equal(s.isAll(), true);
  assert.deepEqual(s.getSelected(), []);
});

test("multi label: one pick shows its labelFor, several show a count", () => {
  const s = state(["a", "b", "c"], { labelFor: (v) => v.toUpperCase(), allLabel: "Everything" });
  assert.equal(s.multiLabel(), "Everything");
  s.setSelected(["a"]);
  assert.equal(s.multiLabel(), "A");
  s.setSelected(["a", "b"]);
  assert.equal(s.multiLabel(), "2 selected");
});

test("selectAll checks every box; clear unchecks every box", () => {
  const s = state(["a", "b"]);
  s.setSelected(["a"]);
  s.selectAll();
  assert.equal(s.isAll(), true);
  assert.equal(s.isChecked("a"), true);
  assert.equal(s.isChecked("b"), true);
  assert.deepEqual(s.getSelected(), []);
  s.setSelected(["a"]);
  s.clear();
  // Clear unchecks everything; still "no filter", but the boxes render clear.
  assert.equal(s.isAll(), false);
  assert.equal(s.isChecked("a"), false);
  assert.equal(s.isChecked("b"), false);
  assert.deepEqual(s.getSelected(), []);
  assert.equal(s.multiLabel(), "All");
});

test("unchecking the last selected value leaves every box clear", () => {
  const s = state(["a", "b"]);
  s.setSelected(["a"]);
  s.toggle("a");
  assert.equal(s.isAll(), false);
  assert.equal(s.isChecked("a"), false);
  assert.equal(s.isChecked("b"), false);
  assert.deepEqual(s.getSelected(), []);
});

test("invariant: getSelected() is empty whenever every box is checked or none is", () => {
  const options = ["a", "b", "c"];
  const s = state(options);
  const ops = [
    () => s.setSelected(["a"]),
    () => s.toggle("a"), // -> nothing selected
    () => s.clear(),
    () => s.toggle("b"), // -> {b}
    () => s.setSelected([]), // -> all
    () => s.selectAll(),
  ];
  for (const op of ops) {
    op();
    const checked = options.filter((v) => s.isChecked(v)).length;
    assert.equal(
      s.getSelected().length === 0,
      checked === 0 || checked === options.length,
      "empty getSelected() iff every box is checked or none is"
    );
  }
});

test("option values are read live, so a rebuilt <select> is respected", () => {
  let values = ["a", "b"];
  const s = createSelectState({ optionValues: () => values });
  s.toggle("a"); // deselect a -> selected {b}
  assert.deepEqual(s.getSelected(), ["b"]);
  values = ["a", "b", "c"];
  s.toggle("c"); // adds c -> {b,c}, not all
  assert.equal(s.isAll(), false);
  assert.deepEqual(s.getSelected().sort(), ["b", "c"]);
});

// ---------------------------------------------------------------- date range
// Constructed from local parts so the assertions hold in any timezone.
const NOW = new Date(2026, 8, 16, 12, 0); // 2026-09-16

test("presetRange computes each preset from the local calendar", () => {
  assert.deepEqual(presetRange("today", NOW), { start: "2026-09-16", end: "2026-09-16" });
  assert.deepEqual(presetRange("7d", NOW), { start: "2026-09-10", end: "2026-09-16" });
  assert.deepEqual(presetRange("30d", NOW), { start: "2026-08-18", end: "2026-09-16" });
  assert.deepEqual(presetRange("month", NOW), { start: "2026-09-01", end: "2026-09-16" });
  assert.deepEqual(presetRange("all", NOW), { start: "", end: "" });
  assert.deepEqual(presetRange("nonsense", NOW), { start: "", end: "" });
});

test("presetRange month starts the year correctly in January", () => {
  assert.deepEqual(presetRange("month", new Date(2026, 0, 9, 12, 0)), { start: "2026-01-01", end: "2026-01-09" });
});

test("pickRangeDay starts a range, closes it, swaps reversed clicks", () => {
  assert.deepEqual(pickRangeDay({ start: "", end: "" }, "2026-09-10"), { start: "2026-09-10", end: "" });
  assert.deepEqual(pickRangeDay({ start: "2026-09-10", end: "" }, "2026-09-14"), { start: "2026-09-10", end: "2026-09-14" });
  assert.deepEqual(pickRangeDay({ start: "2026-09-10", end: "" }, "2026-09-02"), { start: "2026-09-02", end: "2026-09-10" });
  // A complete range restarts on the next click.
  assert.deepEqual(pickRangeDay({ start: "2026-09-02", end: "2026-09-10" }, "2026-09-20"), { start: "2026-09-20", end: "" });
});

test("dateBounds finds the local min/max and ignores blank/'Unknown' days", () => {
  const rec = (time) => ({ time });
  const localDateOf = (r) => {
    const d = new Date(r.time);
    return isNaN(d.getTime()) ? r.time : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const bounds = dateBounds(
    [rec(new Date(2026, 8, 14).toISOString()), rec("Unknown"), rec(""), rec(new Date(2026, 8, 2).toISOString()), rec(new Date(2026, 8, 20).toISOString())],
    localDateOf
  );
  assert.deepEqual(bounds, { min: "2026-09-02", max: "2026-09-20" });
  assert.deepEqual(dateBounds([], localDateOf), { min: null, max: null });
});

test("rangeLabel describes each range shape", () => {
  assert.equal(rangeLabel({ start: "2026-09-01", end: "2026-09-16" }), "2026-09-01 → 2026-09-16");
  assert.equal(rangeLabel({ start: "2026-09-01", end: "" }), "2026-09-01");
  assert.equal(rangeLabel({ start: "", end: "2026-09-16" }), "Until 2026-09-16");
  assert.equal(rangeLabel({ start: "", end: "" }), "All Time");
});
