// extension/vendors/xai-official/pricing-page.js
// Parse xAI's official pricing table (docs.x.ai/docs/pricing). Pure (P9).
//
// Layout: one table with header "Model | Context | Short context | Long
// context" over Input/Cached/Output pairs (8 data cells). Each model cell
// carries the long-context footnote "Long context ≥ 200k tokens" — that
// threshold becomes the tier limit. USD per 1M tokens — no FX needed.
// xAI prices cached reads only (no cache-write price) -> cacheWrite: 0.

export const XAI_SOURCE = "xai-official";

const MIN_MODELS = 5; // page listed 8 grok text models at time of writing
const ANCHOR = "grok-4.7";

function textOf(cell) {
  return String(cell)
    .replace(/<[^>]*>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&ge(?:q)?;/g, "≥") // raw page may entity-encode the footnote
    .replace(/&#8805;/g, "≥")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function money(cell) {
  const m = /\$\s*([0-9.]+)/.exec(String(cell || ""));
  return m ? Number(m[1]) : 0;
}

function rowsOf(table) {
  return String(table)
    .split(/<tr[^>]*>/i)
    .slice(1)
    .map((chunk) => {
      const end = chunk.search(/<\/tr>/i);
      const body = end === -1 ? chunk : chunk.slice(0, end);
      return [...body.matchAll(/<(t[dh])[^>]*>([\s\S]*?)<\/\1>/gi)].map((m) => m[2]);
    });
}

// "grok-4.7 Long context ≥ 200k tokens" -> "grok-4.7"
function modelId(raw) {
  return String(raw)
    .replace(/\s*Long context\s+[≥>].*$/i, "")
    .trim();
}

// "… ≥ 200k tokens" -> 200000 ; returns null when no threshold is stated.
function tierLimit(raw) {
  const m = /[≥>]\s*([0-9.]+)\s*([km])/i.exec(String(raw));
  if (!m) return null;
  return Number(m[1]) * (/m/i.test(m[2]) ? 1e6 : 1e3);
}

// html -> { "<id>": { label, entry } }
export function parsePricingModels(html) {
  const tables = [...String(html).matchAll(/<table[\s\S]*?<\/table>/gi)].map((m) => m[0]);
  const table = tables.find((t) => /Short context/i.test(t) && /Long context/i.test(t) && /grok-/i.test(t));
  if (!table) throw new Error("xAI pricing: short/long context table not found");

  const out = {};
  for (const rawCells of rowsOf(table)) {
    const cells = rawCells.map(textOf);
    if (cells.length < 5) continue;
    const joined = cells.join(" ");
    if (!/\$/.test(joined)) continue; // header rows carry no prices

    const id = modelId(cells[0]);
    if (!/^grok-/i.test(id)) {
      // Priced row that is not a grok text model, or an unrecognised layout.
      // Guessing column positions here risks silently wrong prices.
      throw new Error(`xAI pricing: unexpected priced row ${JSON.stringify(cells.slice(0, 2))}`);
    }

    let entry;
    if (cells.length >= 8) {
      const low = { input: money(cells[2]), output: money(cells[4]), cacheRead: money(cells[3]), cacheWrite: 0 };
      const high = { input: money(cells[5]), output: money(cells[7]), cacheRead: money(cells[6]), cacheWrite: 0 };
      const same = low.input === high.input && low.output === high.output && low.cacheRead === high.cacheRead;
      if (same) {
        entry = { pricing: { flat: low } };
      } else {
        const limit = tierLimit(cells[0]);
        if (!limit) throw new Error(`xAI pricing: no long-context threshold on ${id}`);
        entry = { pricing: { flat: { tier: { limit, low, high } } } };
      }
    } else if (cells.length === 5) {
      entry = { pricing: { flat: { input: money(cells[2]), output: money(cells[4]), cacheRead: money(cells[3]), cacheWrite: 0 } } };
    } else {
      throw new Error(`xAI pricing: unexpected cell count ${cells.length} for ${id}`);
    }
    out[id] = { label: id, entry };
  }

  // Fail closed: empty parse / missing anchor / few rows => layout drift.
  const count = Object.keys(out).length;
  if (count === 0) throw new Error("xAI pricing: no model rows parsed");
  if (!out[ANCHOR]) throw new Error(`xAI pricing: anchor model ${ANCHOR} missing`);
  if (count < MIN_MODELS) throw new Error(`xAI pricing: only ${count} models (<${MIN_MODELS}) — layout drift?`);
  for (const [id, m] of Object.entries(out)) {
    const f = m.entry.pricing.flat;
    const legs = f.tier ? [f.tier.low, f.tier.high] : [f];
    for (const leg of legs) {
      if (!(leg.input > 0 && leg.output > 0 && leg.output >= leg.input && leg.cacheRead <= leg.input)) {
        throw new Error(`xAI pricing: insane prices for ${id}`);
      }
    }
  }
  return out;
}

export function snapshotFromPage(html, capturedAt, { source = XAI_SOURCE } = {}) {
  return { capturedAt: capturedAt || new Date().toISOString(), source, models: parsePricingModels(html) };
}
