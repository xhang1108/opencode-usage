import { test } from "node:test";
import assert from "node:assert/strict";

import { sortBy } from "../../extension/dashboard/core/sort.js";

test("sortBy sorts numbers and strings, ascending/descending", () => {
  const rows = [{ n: 2 }, { n: 10 }, { n: 1 }];
  assert.deepEqual(sortBy(rows, "n", 1).map((r) => r.n), [1, 2, 10]);
  assert.deepEqual(sortBy(rows, "n", -1).map((r) => r.n), [10, 2, 1]);
  const words = [{ s: "b" }, { s: "A" }, { s: "c" }];
  assert.deepEqual(sortBy(words, "s", 1).map((r) => r.s), ["A", "b", "c"]);
});

test("sortBy treats null/undefined as lowest and does not mutate input", () => {
  const rows = [{ n: 5 }, { n: null }, { n: 3 }];
  assert.deepEqual(sortBy(rows, "n", 1).map((r) => r.n), [null, 3, 5]);
  assert.deepEqual(rows.map((r) => r.n), [5, null, 3]);
});
