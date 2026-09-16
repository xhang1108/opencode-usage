import { test } from "node:test";
import assert from "node:assert/strict";

import { layoutFlow, renderFlow } from "../../extension/dashboard/views/flow-diagram.js";

const chain = {
  nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }],
  edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }],
};

test("layoutFlow ranks a chain left to right", () => {
  const { nodes, width, height } = layoutFlow(chain);
  const [a, b, c] = nodes;
  assert.ok(a.x < b.x && b.x < c.x, "columns advance left to right");
  assert.ok(c.x + c.w <= width, "width covers the last column");
  assert.ok(height > 0 && width > 0);
});

test("layoutFlow puts branch targets in one column", () => {
  const { nodes } = layoutFlow({
    nodes: [
      { id: "q", label: "reports an amount?", shape: "decision" },
      { id: "yes", label: "use it" },
      { id: "no", label: "derive it" },
      { id: "end", label: "price" },
    ],
    edges: [
      { from: "q", to: "yes", label: "yes" },
      { from: "q", to: "no", label: "no" },
      { from: "yes", to: "end" },
      { from: "no", to: "end" },
    ],
  });
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  assert.equal(byId.yes.x, byId.no.x, "siblings share a column");
  assert.notEqual(byId.yes.y, byId.no.y, "siblings stack vertically");
  assert.ok(byId.end.x > byId.yes.x);
});

test("layoutFlow grows a node box for extra label lines", () => {
  const one = layoutFlow({ nodes: [{ id: "a", label: "short" }], edges: [] }).nodes[0];
  const two = layoutFlow({ nodes: [{ id: "a", label: ["short", "also short"] }], edges: [] }).nodes[0];
  assert.ok(two.h > one.h);
  const wide = layoutFlow({ nodes: [{ id: "a", label: "a very long label that keeps going" }], edges: [] }).nodes[0];
  assert.ok(wide.w > one.w);
});

test("layoutFlow ignores edges with unknown endpoints", () => {
  const { width } = layoutFlow({
    nodes: [{ id: "a", label: "A" }],
    edges: [{ from: "a", to: "missing" }, { from: "ghost", to: "a" }],
  });
  assert.ok(width > 0);
});

test("renderFlow emits one shape per node and escapes labels", () => {
  const svg = renderFlow(
    { nodes: [{ id: "a", label: "<b>x</b>", shape: "store" }, { id: "b", label: "B" }], edges: [{ from: "a", to: "b" }] },
    "t1"
  );
  assert.match(svg, /^<svg /);
  assert.equal((svg.match(/class="hwd-node /g) || []).length, 2);
  assert.ok(svg.includes("&lt;b&gt;x&lt;/b&gt;"));
  assert.ok(svg.includes("hwd-arrow-t1"), "marker id is namespaced by uid");
  assert.match(svg, /<marker /);
});

test("renderFlow draws decision and store nodes with their own shapes", () => {
  const svg = renderFlow(
    { nodes: [{ id: "d", label: "?", shape: "decision" }, { id: "s", label: "store", shape: "store" }], edges: [] },
    "t2"
  );
  assert.ok(svg.includes("<polygon"));
  assert.ok(svg.includes("hwd-store-top"));
});
