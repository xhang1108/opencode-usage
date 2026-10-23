// extension/vendors/openai-official/pricing-page.js
// Parse OpenAI's official Standard pricing tables from the markdown docs export
// (developers.openai.com/api/docs/pricing.md). Pure (P9).
//
// Only the "### Standard pricing data" section is used — Batch/Flex/Fast tables
// carry discounted rates and must not leak into the snapshot.
//
// The section holds two table shapes, and both are read by header name (never by
// column position, which OpenAI has already reordered once):
//   * a short+long context table with six price columns, where the long-context
//     leg becomes a tier at 272K (prompts above that are pricier);
//   * a plain Input/Output/Cached input table for models without long-context
//     pricing.
// OpenID publishes two cache-write columns (30m and 12h TTL). A preset entry has
// a single cacheWrite, so the 30m column (the default TTL) is used and the 12h
// column is ignored. USD per 1M tokens — no FX needed.

export const OPENAI_SOURCE = "openai-official";

const LONG_CONTEXT_LIMIT = 272000;
const MIN_MODELS = 20; // page listed 36 models at time of writing
const ANCHOR = "gpt-6-luna";

function price(cell) {
  const m = /\$\s*([0-9.]+)/.exec(String(cell || ""));
  return m ? Number(m[1]) : 0;
}

// "gpt-5.5 (<272K context length)" -> "gpt-5.5"
function modelId(raw) {
  return String(raw || "")
    .replace(/\s*\([^)]*\)\s*$/, "")
    .trim();
}

function headerLabel(cell) {
  return String(cell || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// One candidate per role; the first label a table actually has wins, so the same
// code reads both shapes. "30m write" is the TTL we keep (see the header note);
// "cache writes" is the older single-column spelling.
const COLUMNS = {
  input: ["short context input", "input"],
  output: ["short context output", "output"],
  cacheRead: ["short context cached input", "cached input"],
  cacheWrite: ["short context 30m write", "short context cache writes"],
  longInput: ["long context input"],
  longOutput: ["long context output"],
  longCacheRead: ["long context cached input"],
  longCacheWrite: ["long context 30m write", "long context cache writes"],
};

function columnsFor(cells) {
  const found = {};
  for (const [role, names] of Object.entries(COLUMNS)) {
    for (const name of names) {
      const i = cells.indexOf(name);
      if (i !== -1) {
        found[role] = i;
        break;
      }
    }
  }
  return found;
}

function splitRow(line) {
  return line
    .split("|")
    .slice(1, -1)
    .map((c) => c.trim());
}

const isTableRow = (line) => /^\|/.test(line);
const isSeparator = (line) => /^\|[\s:|-]+\|$/.test(line) && /-/.test(line);

// md -> { "<id>": { label, entry } }
export function parseStandardTable(md) {
  const text = String(md);
  const start = text.indexOf("Standard pricing data");
  if (start === -1) throw new Error("OpenAI pricing: 'Standard pricing data' section missing");
  const rest = text.slice(start);
  const endm = /\n### /.exec(rest);
  const section = endm ? rest.slice(0, endm.index) : rest;

  const out = {};
  let cols = null;
  for (const line of section.split("\n")) {
    if (!isTableRow(line)) {
      cols = null; // a new table always starts with its own header row
      continue;
    }
    const cells = splitRow(line);
    if (cells.length === 0) continue;
    if (!cols) {
      // The header is the row whose first cell is "Model"; anything before it in
      // the table is the separator line, which carries no cell to price.
      const head = cells.map(headerLabel);
      if (head[0] !== "model") continue;
      cols = columnsFor(head);
      continue;
    }
    if (isSeparator(line)) continue;

    const id = modelId(cells[0]);
    if (!/^(gpt-|o\d|davinci|babbage)/i.test(id)) continue; // header / separator rows

    const at = (role) => (cols[role] === undefined ? 0 : price(cells[cols[role]]));
    const entry = {
      pricing: {
        flat: {
          input: at("input"),
          output: at("output"),
          cacheRead: at("cacheRead"),
          cacheWrite: at("cacheWrite"),
        },
      },
    };
    const longIn = at("longInput");
    const longOut = at("longOutput");
    if (longIn > 0 || longOut > 0) {
      entry.pricing.flat = {
        tier: {
          limit: LONG_CONTEXT_LIMIT,
          low: entry.pricing.flat,
          high: {
            input: longIn,
            output: longOut,
            cacheRead: at("longCacheRead"),
            cacheWrite: at("longCacheWrite"),
          },
        },
      };
    }
    // Fail closed: one row per model id. A repeated id (e.g. two context
    // labels folding to the same id) must not silently keep the last row.
    if (out[id]) throw new Error(`OpenAI pricing: duplicate model id ${id}`);
    out[id] = { label: id, entry };
  }

  // Fail closed: empty parse / missing anchor / suspiciously few rows all mean
  // the page layout changed — never write a gutted snapshot.
  const count = Object.keys(out).length;
  if (count === 0) throw new Error("OpenAI pricing: no model rows parsed");
  if (!out[ANCHOR]) throw new Error(`OpenAI pricing: anchor model ${ANCHOR} missing`);
  if (count < MIN_MODELS) throw new Error(`OpenAI pricing: only ${count} models (<${MIN_MODELS}) — layout drift?`);
  for (const [id, m] of Object.entries(out)) {
    const f = m.entry.pricing.flat;
    const legs = f.tier ? [f.tier.low, f.tier.high] : [f];
    for (const leg of legs) {
      if (!(leg.input > 0 && leg.output > 0 && leg.output >= leg.input && leg.cacheRead <= leg.input)) {
        throw new Error(`OpenAI pricing: insane prices for ${id}`);
      }
    }
  }
  return out;
}

export function snapshotFromPage(md, capturedAt, { source = OPENAI_SOURCE } = {}) {
  return { capturedAt: capturedAt || new Date().toISOString(), source, models: parseStandardTable(md) };
}
