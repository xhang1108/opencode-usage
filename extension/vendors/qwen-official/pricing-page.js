// extension/vendors/qwen-official/pricing-page.js
// Parse Alibaba Cloud Model Studio's official pricing (EN page, USD). Pure (P9).
//
// The page holds SEVERAL chat tables that share one signature (h0 contains
// "Model ID" + "Deployment scope" + "Input price", h1 is "Non-Thinking mode |
// Thinking mode ..."). Live layouts (2026-09, ~33 International ids total):
//   A. tiered  7 cells: model, scope, tier("0<Token≤256K"), in, nt, th, quota
//            (h0 has "Input tokens per request"; 4-cell continuation rows
//                 add upper tiers)
//   B. flat      6 cells: model, scope, in, nt, th, quota (no tier column)
//   C. mode      7 cells: model, scope, Mode, in, nt, th, quota — thinking-only
//                 models carry "-" in the Non-Thinking output column
// Column indexes are DERIVED from h0 (never hard-coded) and a row is only
// accepted when the derived cells actually look like prices, so column drift
// lands on the count/anchor assertions instead of silently writing a
// snapshot with shifted numbers.
//
// Decisions baked in (from live-page probes):
//   * scope  — International rows only (USD). Global tables repeat the same
//              ids at different prices; never mix them.
//   * output — the Non-Thinking column is canonical; when it is "-" the model
//              is Thinking-only, so the Thinking column is the real price.
//   * list   — "List price $0.4 (Limited-time 20% off)" -> first dollar amount
//              (list price, never the promo).
//   * cache  — no cache columns; the page's own note bills cache creation at
//              125% of input and cache hits at 10% (matches existing go.mdx
//              groups), so cacheRead/cacheWrite are derived.
//   * >2 tiers throws: the snapshot schema only expresses limit/low/high.

export const QWEN_SOURCE = "qwen-official";

const MIN_MODELS = 10; // live page: ~33 International ids across 5 tables
const ANCHOR = "qwen3.5-plus"; // only the main tiered table has it
const CACHE_READ_RATIO = 0.1; // "cache hits at 10%" (page note)
const CACHE_WRITE_RATIO = 1.25; // "explicit cache creation ... 125%" (page note)

function textOf(cell) {
  return String(cell)
    .replace(/<[^>]*>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&le(?:q)?;/g, "≤") // fixtures/entity-encoded variants of "0<Token≤256K"
    .replace(/&ge(?:q)?;/g, "≥")
    .replace(/&#8804;/g, "≤")
    .replace(/&#8805;/g, "≥")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function price(cell) {
  const m = /\$\s*([0-9.]+)/.exec(String(cell || ""));
  return m ? Number(m[1]) : 0;
}

// price cell shaped like "$0.4" or "List price $0.4 (Limited-time 20% off)".
// Live quirks: some rows render an EMPTY output cell (<ul><li></li></ul>)
// instead of "-", and the tier column may read "No tiered pricing" — both are
// legitimate "no value" shapes. A shifted column still fails validation
// because the quota text ("1 million tokens") is neither money, dash, nor empty.
const looksMoney = (cell) => /\$\s*\d/.test(textOf(cell));
const looksDash = (cell) => /^\s*-\s*$/.test(textOf(cell));
const looksLeg = (cell) => textOf(cell) === "" || looksDash(cell) || looksMoney(cell);

// non-thinking column is canonical; "-" means the model never runs it
const pickOutput = (nonThinking, thinking) => {
  const nt = price(nonThinking);
  return nt > 0 ? nt : price(thinking);
};

const round6 = (x) => Math.round(x * 1e6) / 1e6;

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

// "<p>qwen3.7-plus</p><blockquote>Currently equivalent to…</blockquote>" -> id;
// "qwen-turbo 50% batch inference discount" -> "qwen-turbo" (ids never contain
// a space; the note after the id is dropped).
function modelId(cell) {
  const p = /<p>([\s\S]*?)<\/p>/i.exec(String(cell).trim());
  const src = textOf(p ? p[1] : cell);
  const tok = /^[A-Za-z0-9][\w.+-]*/.exec(src);
  return tok ? tok[0] : "";
}

// "0<Token≤256K" -> 0 ; "256K<Token≤1M" -> 256000 (tier lower bound).
// Accepts raw cell HTML — text is stripped/decoded first.
function lowerBound(tierCell) {
  const m = /^([\d.]+)([KM]?)\s*</i.exec(textOf(tierCell));
  if (!m) return null;
  const unit = m[2].toUpperCase();
  return Number(m[1]) * (unit === "M" ? 1e6 : unit === "K" ? 1e3 : 1);
}

const isTierRow = (cells) => cells.length === 4 && /^[\d.]+[KM]?\s*<\s*Token\s*≤/i.test(textOf(cells[0] || ""));

function cacheLegs(input) {
  return {
    cacheRead: round6(input * CACHE_READ_RATIO),
    cacheWrite: round6(input * CACHE_WRITE_RATIO),
  };
}

function entryFor(tiers) {
  if (tiers.length === 1) {
    const t = tiers[0];
    return { pricing: { flat: { input: t.in, output: t.outNT, ...cacheLegs(t.in) } } };
  }
  if (tiers.length === 2) {
    const [lo, hi] = tiers;
    const limit = hi.bound;
    if (!limit) throw new Error("Qwen pricing: unparseable tier boundary");
    return {
      pricing: {
        flat: {
          tier: {
            limit,
            low: { input: lo.in, output: lo.outNT, ...cacheLegs(lo.in) },
            high: { input: hi.in, output: hi.outNT, ...cacheLegs(hi.in) },
          },
        },
      },
    };
  }
  throw new Error(`Qwen pricing: ${tiers.length} tiers not expressible in snapshot schema`);
}

// html -> { "<id>": { label, entry } }
export function parsePricingModels(html) {
  const tables = [...String(html).matchAll(/<table[\s\S]*?<\/table>/gi)].map((m) => m[0]);
  const out = {};
  let matched = 0;

  for (const table of tables) {
    const rows = rowsOf(table);
    if (rows.length < 3) continue;
    const h0cells = rows[0].map(textOf);
    const h0 = h0cells.join(" ");
    const h1 = (rows[1] || []).map(textOf).join(" ");
    if (!/Model ID/.test(h0) || !/Input price/.test(h0) || !/Deployment scope/.test(h0)) continue;
    if (!/Non-Thinking mode/i.test(h1) || !/Thinking mode/i.test(h1)) continue;
    matched++;

    // derive the input column: model, scope, [tier], [mode], input, nt, th, [quota]
    const hasTier = /Input token/i.test(h0);
    const hasMode = h0cells.some((c) => /^mode$/i.test(c));
    const col = 2 + (hasTier ? 1 : 0) + (hasMode ? 1 : 0);

    let cur = null;
    const flush = () => {
      if (!cur) return;
      const { id, scope, tiers } = cur;
      cur = null;
      if (scope !== "International") return;
      if (!/^(qwen|qwq)/i.test(id)) return; // page also lists third-party models
      out[id] = { label: id, entry: entryFor(tiers) };
    };

    for (let i = 2; i < rows.length; i++) {
      const cells = rows[i];
      if (hasTier && isTierRow(cells)) {
        if (!cur) continue; // orphan continuation row — ignore
        if (!looksLeg(cells[1]) || !looksLeg(cells[2]) || !looksLeg(cells[3])) {
          throw new Error("Qwen pricing: tier continuation row no longer looks like prices");
        }
        cur.tiers.push({
          in: price(cells[1]),
          outNT: pickOutput(cells[2], cells[3]),
          bound: lowerBound(cells[0]),
        });
        continue;
      }
      flush();
      const scope = textOf(cells[1] || "");
      if (
        cells.length >= col + 3 &&
        /^(International|Global)$/.test(scope) &&
        looksMoney(cells[col]) &&
        looksLeg(cells[col + 1]) &&
        looksLeg(cells[col + 2])
      ) {
        cur = {
          id: modelId(cells[0]),
          scope,
          tiers: [
            {
              in: price(cells[col]),
              outNT: pickOutput(cells[col + 1], cells[col + 2]),
              bound: hasTier ? lowerBound(cells[col - 1]) : null,
            },
          ],
        };
      }
      // anything else (footers, unmatched scopes, shifted columns) just closed
      // the current model above and is skipped — count/anchor catch real loss
    }
    flush();
  }

  // Fail closed: wrong table signature, missing anchor, or too few rows all
  // mean the page layout changed — never write a gutted snapshot.
  if (matched === 0) throw new Error("Qwen pricing: chat-pricing table signature not found");
  const count = Object.keys(out).length;
  if (count === 0) throw new Error("Qwen pricing: no International qwen rows parsed");
  if (!out[ANCHOR]) throw new Error(`Qwen pricing: anchor model ${ANCHOR} missing`);
  if (count < MIN_MODELS) throw new Error(`Qwen pricing: only ${count} models (<${MIN_MODELS}) — layout drift?`);
  for (const [id, m] of Object.entries(out)) {
    const f = m.entry.pricing.flat;
    const legs = f.tier ? [f.tier.low, f.tier.high] : [f];
    for (const leg of legs) {
      if (!(leg.input > 0 && leg.output > 0 && leg.output >= leg.input)) {
        throw new Error(`Qwen pricing: insane prices for ${id}`);
      }
    }
  }
  return out;
}

export function snapshotFromPage(html, capturedAt, { source = QWEN_SOURCE } = {}) {
  return { capturedAt: capturedAt || new Date().toISOString(), source, models: parsePricingModels(html) };
}
