// extension/vendors/minimax-official/pricing-page.js
// Parse MiniMax's official pay-as-you-go LLM pricing.
// Pure (P9).
//
// Source: https://platform.minimax.io/docs/pricing/overview.md (the docs page
// /docs/guides/pricing-paygo 308-redirects here). Layout, in order:
//
//   ## LLM
//   | Model | Input $ / M tokens | Output $ / M tokens | Prompt caching Read $ / M tokens |
//   | **MiniMax-M3.1-Flash** | $0.15 | $0.60 | $0.015 |
//   **Standard**
//   | **MiniMax-M3** ≤ 512k input tokens ... | ~~$0.60~~ $0.30 | ~~$2.40~~ $1.20 | ~~$0.12~~ $0.06 |
//   | **MiniMax-M3** > 512k input tokens* ... | ~~$1.20~~ $0.60 | ~~$4.80~~ $2.40 | ~~$0.24~~ $0.12 |
//   **Priority** ...
//
// Rules this parser enforces:
//  * Only the Standard tier is read. The Priority table is the same models at
//    1.5x for `service_tier: priority` and must never overwrite the list price.
//  * A struck-through promo is the old price: `~~$0.60~~ $0.30` is $0.30.
//  * "> 512k input tokens" is the long-context leg, so the two M3 rows become
//    one tiered entry (limit 512000) instead of two rival models.
//  * The page publishes no cache-write column, so cacheWrite stays 0 rather
//    than borrowing a number from another catalogue.
//  * Models the page no longer lists (M2.5/M2.7) simply drop out here; the
//    unified builder keeps their hand-transcribed rate so historical usage
//    still prices.

export const MINIMAX_SOURCE = "minimax-official";
export const MINIMAX_URL = "https://platform.minimax.io/docs/pricing/overview.md";

const MIN_MODELS = 2;
const ANCHOR = "MiniMax-M3.1-Flash";
const MODEL_ID = /MiniMax-M[0-9]+(?:\.[0-9]+)?(?:-[A-Za-z]+)*/i;
const SEPARATOR = /^:?-{1,}:?$/;

// The live price in a cell: drop `~~struck~~` text (the old price), then take
// the one remaining "$x". A "-" cell means "not billed" -> 0.
function money(cell) {
  const text = String(cell || "").replace(/~~[^~]*~~/g, " ");
  const m = /\\?\$\s*([0-9]+(?:\.[0-9]+)?)/.exec(text);
  return m ? Number(m[1]) : 0;
}

// "**MiniMax-M3.1-Flash**" -> "MiniMax-M3.1-Flash"; "> 512k" -> long-context leg.
function rowModel(cell) {
  const text = String(cell || "").replace(/\*\*/g, "").replace(/\\/g, "");
  const m = MODEL_ID.exec(text);
  if (!m) return null;
  // Normalise the two comparison operators first so only a real ">" remains.
  const tierText = text.replace(/<=|≤/g, "LE").replace(/>=|≥/g, "GE");
  const tier = /(?:^|[^<>=])>\s*([0-9.]+)\s*k\b/i.exec(tierText);
  return { id: m[0], limit: tier ? Math.round(Number(tier[1]) * 1000) : null };
}

// md -> [{ label, header, rows }] ; label is the last standalone **Bold** line,
// "" for the lead table that sits directly under "## LLM".
function tables(section) {
  const out = [];
  let label = "";
  let table = null;
  for (const raw of section.split("\n")) {
    const line = raw.trim();
    // "**Standard**" / "**Priority**\*" (footnote marker) start a new block.
    const bold = /^\*\*([^*]+)\*\*(?:\\\*+)?\s*$/.exec(line);
    if (bold) {
      label = bold[1].trim();
      table = null;
      continue;
    }
    if (!line.startsWith("|")) {
      table = null;
      continue;
    }
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (!table) {
      table = { label, header: cells, rows: [] };
      out.push(table);
      continue;
    }
    if (cells.every((c) => c === "" || SEPARATOR.test(c))) continue;
    table.rows.push(cells);
  }
  return out;
}

// md -> { "<official id>": { label, entry } }
export function parsePricingModels(md) {
  const text = String(md || "");
  const start = text.indexOf("## LLM");
  if (start === -1) throw new Error("MiniMax pricing: '## LLM' section missing");
  const rest = text.slice(start);
  const end = /\n## /.exec(rest);
  const section = end ? rest.slice(0, end.index) : rest;

  const grouped = new Map(); // id -> [{ limit, pricing }]
  for (const t of tables(section)) {
    if (t.label !== "" && !/^standard$/i.test(t.label)) continue; // Priority etc.
    const col = {
      input: t.header.findIndex((c) => /input/i.test(c)),
      output: t.header.findIndex((c) => /output/i.test(c)),
      cache: t.header.findIndex((c) => /cach/i.test(c)),
    };
    if (col.input < 0 || col.output < 0) throw new Error("MiniMax pricing: Input/Output columns missing");
    for (const cells of t.rows) {
      if (cells.length <= Math.max(col.input, col.output)) continue;
      const row = rowModel(cells[0]);
      if (!row) continue;
      const pricing = {
        input: money(cells[col.input]),
        output: money(cells[col.output]),
        cacheRead: col.cache < 0 ? 0 : money(cells[col.cache]),
        cacheWrite: 0,
      };
      const list = grouped.get(row.id);
      const leg = { limit: row.limit, pricing };
      if (list) list.push(leg);
      else grouped.set(row.id, [leg]);
    }
  }

  const models = {};
  for (const [id, legs] of grouped) {
    const flat = legs.filter((l) => l.limit == null);
    const tiered = legs.filter((l) => l.limit != null);
    if (tiered.length === 0 && flat.length === 1) {
      models[id] = { label: id, entry: { pricing: { flat: flat[0].pricing } } };
    } else if (tiered.length === 1 && flat.length === 1) {
      models[id] = {
        label: id,
        entry: {
          pricing: {
            flat: { tier: { limit: tiered[0].limit, low: flat[0].pricing, high: tiered[0].pricing } },
          },
        },
      };
    }
    // Anything else (two long-context rows, or a tier with no base row) is
    // ambiguous: the model drops out instead of inventing a rule.
  }

  const count = Object.keys(models).length;
  if (count === 0) throw new Error("MiniMax pricing: no model rows parsed");
  if (!models[ANCHOR]) throw new Error(`MiniMax pricing: anchor model ${ANCHOR} missing`);
  if (count < MIN_MODELS) throw new Error(`MiniMax pricing: only ${count} models (<${MIN_MODELS}) - layout drift?`);

  for (const [id, m] of Object.entries(models)) {
    const flat = m.entry.pricing.flat;
    const legs = flat.tier ? [flat.tier.low, flat.tier.high] : [flat];
    if (flat.tier && !(flat.tier.limit > 0)) throw new Error(`MiniMax pricing: bad tier limit for ${id}`);
    for (const leg of legs) {
      // input/output must be positive; cached input is a fraction of input
      if (!(leg.input > 0 && leg.output > 0 && leg.cacheRead >= 0 && leg.cacheRead < leg.input)) {
        throw new Error(`MiniMax pricing: unexpected prices for ${id}`);
      }
    }
  }
  return models;
}

export function snapshotFromPage(md, capturedAt, { source = MINIMAX_SOURCE } = {}) {
  return { capturedAt: capturedAt || new Date().toISOString(), source, models: parsePricingModels(md) };
}
