// extension/dashboard/views/flow-diagram.js
// Self-drawn left-to-right flowcharts for the How-it-works tab. No third-party
// renderer: models are ranked with a tiny longest-path pass and laid out into
// columns, so nothing extra has to load and nothing has to be licensed.
//
// model = {
//   nodes: [{ id, label: string|string[], sub?: string|string[],
//             shape?: "box" | "decision" | "store" }],
//   edges: [{ from, to, label? }],
// }

const CHAR_W = 7.3;
const SUB_CHAR_W = 6.4;
const LINE_H = 16;
const SUB_LINE_H = 13;
const PAD_X = 12;
const PAD_Y = 10;
const MIN_W = 112;
const MAX_W = 330;
const GAP_X = 56;
const GAP_Y = 18;
const DECISION_RESERVE = 28;

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ESCAPES[c]);

const toLines = (v) => (Array.isArray(v) ? v : [v]).flatMap((x) => String(x).split("\n"));

function measure(node) {
  const lines = toLines(node.label);
  const subs = node.sub ? toLines(node.sub) : [];
  const shape = node.shape || "box";
  const widest = Math.max(
    0,
    ...lines.map((l) => l.length * CHAR_W),
    ...subs.map((l) => l.length * SUB_CHAR_W)
  );
  const w = Math.min(MAX_W, Math.max(MIN_W, Math.ceil(widest) + (shape === "decision" ? DECISION_RESERVE : 0) + PAD_X * 2));
  const textH = lines.length * LINE_H + subs.length * SUB_LINE_H;
  const h = Math.max(shape === "decision" ? 46 : 38, textH + PAD_Y * 2);
  return { w, h, lines, subs, shape };
}

// Longest-path rank per node (sources at 0). Cycles are tolerated: the pass
// count is bounded, so a malformed model just stops ranking instead of hanging.
function rankNodes(nodes, edges) {
  const rank = new Map(nodes.map((n) => [n.id, 0]));
  for (let pass = 0; pass < nodes.length; pass++) {
    let changed = false;
    for (const e of edges) {
      if (!rank.has(e.from) || !rank.has(e.to)) continue;
      if (rank.get(e.to) < rank.get(e.from) + 1) {
        rank.set(e.to, rank.get(e.from) + 1);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return rank;
}

export function layoutFlow(model) {
  const nodes = (model.nodes || []).map((n) => ({ ...n, ...measure(n) }));
  const edges = (model.edges || []).filter(
    (e) => nodes.some((n) => n.id === e.from) && nodes.some((n) => n.id === e.to)
  );
  const rank = rankNodes(nodes, edges);

  const cols = [];
  for (const n of nodes) {
    const r = rank.get(n.id) || 0;
    (cols[r] = cols[r] || []).push(n);
  }

  let cursorX = 0;
  const colHeights = [];
  for (const col of cols) {
    if (!col) {
      colHeights.push(0);
      continue;
    }
    const colW = Math.max(...col.map((n) => n.w));
    let y = 0;
    for (const n of col) {
      n.x = cursorX;
      n.y = y;
      y += n.h + GAP_Y;
    }
    colHeights.push(Math.max(0, y - GAP_Y));
    cursorX += colW + GAP_X;
  }

  const height = Math.max(...colHeights, 0);
  for (const col of cols) {
    if (!col) continue;
    const colH = Math.max(...col.map((n) => n.y + n.h));
    const offset = (height - colH) / 2;
    for (const n of col) n.y += offset;
  }
  const width = Math.max(0, cursorX - GAP_X);

  return { width: Math.ceil(width), height: Math.ceil(height), nodes, edges };
}

function edgePath(a, b) {
  const x1 = a.x + a.w;
  const y1 = a.y + a.h / 2;
  const x2 = b.x;
  const y2 = b.y + b.h / 2;
  if (Math.abs(y2 - y1) < 0.5) return { d: `M${x1},${y1} H${x2}`, mx: (x1 + x2) / 2, my: y1 - 7 };
  const dx = Math.max(22, (x2 - x1) * 0.5);
  return {
    d: `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`,
    mx: (x1 + x2) / 2,
    my: (y1 + y2) / 2 - 2,
  };
}

function nodeText(n) {
  const cx = n.x + n.w / 2;
  const total = n.lines.length * LINE_H + n.subs.length * SUB_LINE_H;
  let baseline = n.y + (n.h - total) / 2 + LINE_H * 0.72;
  const tspans = [];
  for (const line of n.lines) {
    tspans.push(`<tspan x="${cx}" y="${baseline}">${esc(line)}</tspan>`);
    baseline += LINE_H;
  }
  for (const line of n.subs) {
    tspans.push(`<tspan class="hwd-sub" x="${cx}" y="${baseline}">${esc(line)}</tspan>`);
    baseline += SUB_LINE_H;
  }
  return `<text class="hwd-text" text-anchor="middle">${tspans.join("")}</text>`;
}

function nodeShape(n) {
  const { x, y, w, h } = n;
  if (n.shape === "decision") {
    const cut = Math.min(20, h * 0.35);
    return `<polygon points="${x},${y + h / 2} ${x + cut},${y} ${x + w - cut},${y} ${x + w},${y + h / 2} ${x + w - cut},${y + h} ${x + cut},${y + h}" />`;
  }
  if (n.shape === "store") {
    const ry = 7;
    return (
      `<path d="M${x},${y + ry} A${w / 2},${ry} 0 0 1 ${x + w},${y + ry}` +
      ` L${x + w},${y + h - ry} A${w / 2},${ry} 0 0 1 ${x},${y + h - ry} Z" />` +
      `<path class="hwd-store-top" d="M${x},${y + ry} A${w / 2},${ry} 0 0 0 ${x + w},${y + ry}" />`
    );
  }
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="7" />`;
}

export function renderFlow(model, uid) {
  const { width, height, nodes, edges } = layoutFlow(model);
  const marker = `hwd-arrow-${uid}`;
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const links = edges
    .map((e) => {
      const a = byId.get(e.from);
      const b = byId.get(e.to);
      const { d, mx, my } = edgePath(a, b);
      const line = `<path class="hwd-edge" d="${d}" marker-end="url(#${marker})" />`;
      if (!e.label) return line;
      const tw = String(e.label).length * 6.2 + 8;
      return (
        line +
        `<rect class="hwd-edge-label-bg" x="${mx - tw / 2}" y="${my - 8}" width="${tw}" height="14" rx="3" />` +
        `<text class="hwd-edge-label" text-anchor="middle" x="${mx}" y="${my + 3}">${esc(e.label)}</text>`
      );
    })
    .join("");

  const shapes = nodes
    .map((n) => `<g class="hwd-node hwd-node--${n.shape}">${nodeShape(n)}${nodeText(n)}</g>`)
    .join("");

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" ` +
    `width="100%" role="img">` +
    `<defs><marker id="${marker}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">` +
    `<path class="hwd-arrow" d="M0,0 L10,5 L0,10 z" /></marker></defs>` +
    `<g class="hwd-edges">${links}</g><g class="hwd-nodes">${shapes}</g></svg>`
  );
}
