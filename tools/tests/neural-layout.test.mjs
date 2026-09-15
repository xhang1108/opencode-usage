import { test } from "node:test";
import assert from "node:assert/strict";

import { buildNeuralLayout, NEURAL_XS, NEURAL_COUNTS } from "../../extension/dashboard/views/neural-layout.js";

// Deterministic PRNG so the random layout can be pinned.
function lcg(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const W = 800;
const H = 600;

test("buildNeuralLayout makes 7 columns with the fixed node counts", () => {
  const { layers } = buildNeuralLayout(W, H, lcg());
  assert.equal(layers.length, 7);
  assert.deepEqual(layers.map((l) => l.length), NEURAL_COUNTS);
  const expectedNonSkip = NEURAL_COUNTS.slice(0, -1).reduce((n, c, i) => n + c * NEURAL_COUNTS[i + 1], 0);
  assert.ok(expectedNonSkip > 0);
});

test("nodes sit on their column x, stack down y, and size by layer", () => {
  const { layers } = buildNeuralLayout(W, H, lcg());
  for (let li = 0; li < layers.length; li++) {
    for (const n of layers[li]) {
      assert.equal(n.baseX, NEURAL_XS[li] * W);
      assert.equal(n.x, n.baseX);
      assert.equal(n.y, 0);
      assert.ok(n.baseY > 0 && n.baseY < H, "node y stays inside the canvas");
    }
    const r = li === 3 ? 2.6 : li === 0 || li === 6 ? 1.4 : 1.9;
    for (const n of layers[li]) assert.equal(n.r, r);
  }
});

test("edges reference valid nodes: forward edges span 1 column, skip edges 2", () => {
  const { layers, edges } = buildNeuralLayout(W, H, lcg());
  assert.ok(edges.length > 0);
  for (const e of edges) {
    if (e.skip) {
      assert.ok(e.li <= layers.length - 3, "a skip edge needs a column two ahead");
      assert.ok(e.a < layers[e.li].length);
      assert.ok(e.b < layers[e.li + 2].length);
    } else {
      assert.ok(e.li <= layers.length - 2);
      assert.ok(e.a < layers[e.li].length);
      assert.ok(e.b < layers[e.li + 1].length);
    }
  }
  // Exactly two skip edges per eligible column pair.
  assert.equal(edges.filter((e) => e.skip).length, 2 * (layers.length - 2));
});

test("the keep probability drops all forward edges when rand exceeds it", () => {
  const { edges } = buildNeuralLayout(W, H, () => 0.99);
  assert.equal(edges.filter((e) => !e.skip).length, 0);
  assert.equal(edges.filter((e) => e.skip).length, 10);
});

test("rand 0 keeps every forward edge", () => {
  const { layers, edges } = buildNeuralLayout(W, H, () => 0);
  const expected = NEURAL_COUNTS.slice(0, -1).reduce((n, c, i) => n + c * NEURAL_COUNTS[i + 1], 0);
  assert.equal(edges.filter((e) => !e.skip).length, expected);
  assert.equal(edges.length, expected + 10);
  assert.equal(layers[0][0].phase, 0);
});

test("the same seed produces an identical layout", () => {
  const a = buildNeuralLayout(W, H, lcg(42));
  const b = buildNeuralLayout(W, H, lcg(42));
  assert.deepEqual(a, b);
});
