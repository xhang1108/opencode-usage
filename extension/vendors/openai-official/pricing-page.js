// extension/vendors/openai-official/pricing-page.js
// Parse OpenAI's official Standard pricing table from the markdown docs export
// (developers.openai.com/api/docs/pricing.md). Pure (P9).
//
// Only the "### Standard pricing data" section is used — Batch/Flex/Fast tables
// carry discounted rates and must not leak into the snapshot. Models with
// long-context price columns become a tiered entry at 272K (OpenAI: prompts
// with >272K input tokens are pricier; rows are labelled "(<272K context
// length)" on the gpt-5.4/5.5 family). USD per 1M tokens — no FX needed.

export const OPENAI_SOURCE = "openai-official";

const LONG_CONTEXT_LIMIT = 272000;
const MIN_MODELS = 20; // page listed 39 models at time of writing
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

// md -> { "<id>": { label, entry } }
export function parseStandardTable(md) {
  const text = String(md);
  const start = text.indexOf("Standard pricing data");
  if (start === -1) throw new Error("OpenAI pricing: 'Standard pricing data' section missing");
  const rest = text.slice(start);
  const endm = /\n### /.exec(rest);
  const section = endm ? rest.slice(0, endm.index) : rest;

  const out = {};
  for (const line of section.split("\n")) {
    if (!/^\|/.test(line)) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length < 9) continue;
    const id = modelId(cells[0]);
    if (!/^(gpt-|o\d|davinci|babbage)/i.test(id)) continue; // header / separator rows

    const [sIn, sCached, sWrite, sOut, lIn, lCached, lWrite, lOut] = cells.slice(1, 9).map(price);

    const entry =
      lIn > 0 || lOut > 0
        ? {
            pricing: {
              flat: {
                tier: {
                  limit: LONG_CONTEXT_LIMIT,
                  low: { input: sIn, output: sOut, cacheRead: sCached, cacheWrite: sWrite },
                  high: { input: lIn, output: lOut, cacheRead: lCached, cacheWrite: lWrite },
                },
              },
            },
          }
        : { pricing: { flat: { input: sIn, output: sOut, cacheRead: sCached, cacheWrite: sWrite } } };
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
