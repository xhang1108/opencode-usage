// tools/tests/dashboard-transfer.test.mjs
// The dashboard snapshot crosses the extension message boundary in chunks; a
// split must never corrupt a UTF-16 surrogate pair.
import { test } from "node:test";
import assert from "node:assert/strict";

import { DASHBOARD_CHUNK_CHARS, chunkEnd } from "../../extension/shared/dashboard-transfer.js";

test("chunkEnd advances by the requested size", () => {
  assert.equal(chunkEnd("abcdef", 0, 2), 2);
  assert.equal(chunkEnd("abcdef", 2, 2), 4);
  assert.equal(chunkEnd("abcdef", 4, 10), 6, "last chunk is clamped to the text length");
});

test("chunkEnd keeps a surrogate pair in one chunk", () => {
  const text = "A😀B"; // [A, high, low, B]
  assert.equal(chunkEnd(text, 0, 2), 3, "the chunk grows so the pair is not split");
  assert.equal(chunkEnd(text, 1, 1), 3, "a one-unit chunk still makes progress");
  assert.equal(text.slice(0, 3) + text.slice(3), text, "join of slices is lossless");
});

test("chunk size default stays well below Chrome's 64MiB message cap", () => {
  assert.ok(DASHBOARD_CHUNK_CHARS * 4 < 64 * 1024 * 1024, "worst-case UTF-8 bytes must fit");
});
