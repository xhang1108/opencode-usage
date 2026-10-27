// extension/vendors/longcat-official/pricing-page.js
// Parse a LongCat (Meituan) official pricing page (HTML) into a normalized
// price snapshot. Pure (P9): input is the raw page HTML.
//
// Layout: VitePress docs page, ONE MODEL PER PAGE. The model is named in the
// <title> ("LongCat-2.5-Preview | LongCat API Docs"); the same page renders the
// price table twice, once per site edition:
//   <div data-edition-only="ai">        Item | Discounted Price $/1M Tokens
//   <div data-edition-only="chat com">  Item | Discounted Price ¥/1M Tokens
// Rows are Uncached Input / Cached Input / Output. The CNY table is the same
// product sold in another market, never a second price for the USD edition, so
// it is ignored (cells without "$" make a table non-USD). The published column
// is the discounted (limited-time) price, which IS the current pay price - the
// standard list price is not shown while the promo runs.

export const LONGCAT_SOURCE = "longcat-official";

const TITLE_RE = /^(.+?)\s*\|\s*LongCat API Docs$/i;

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function stripTags(s) {
  return decodeEntities(String(s).replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

// "$0.30" -> 0.3 ; "Free" -> 0 ; anything else (¥2, "-", "") -> null
function money(cell) {
  const s = String(cell || "").trim();
  if (/^free$/i.test(s)) return 0;
  const m = s.match(/\$\s*([0-9]+(?:\.[0-9]+)?)/);
  return m ? Number(m[1]) : null;
}

function canonicalModelId(label) {
  return String(label || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9.\-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function rowsOfTable(tableHtml) {
  return [...String(tableHtml).matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) =>
    [...m[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((c) => stripTags(c[1])),
  );
}

// The page names its single model in the title; that is the only identity the
// table itself does not carry, so it has to be there or nothing can be priced.
export function modelLabelFromPage(html) {
  const title = String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const m = title && stripTags(title[1]).match(TITLE_RE);
  return m ? m[1].trim() : null;
}

// html -> { "<model>": { label, entry } }
export function parsePricingModels(html) {
  const label = modelLabelFromPage(html);
  if (!label) throw new Error("LongCat pricing: page title does not name the model");
  const id = canonicalModelId(label);
  if (!id) throw new Error("LongCat pricing: page title has no usable model id");

  const tables = [...String(html).matchAll(/<table[\s\S]*?<\/table>/gi)].map((m) => m[0]);
  if (tables.length === 0) throw new Error("LongCat pricing: no price table found");

  for (const table of tables) {
    const rows = rowsOfTable(table);
    const cells = {};
    for (const row of rows) {
      if (row.length < 2) continue;
      cells[row[0].toLowerCase()] = row[1];
    }
    const input = money(cells["uncached input"]);
    const output = money(cells["output"]);
    // A table missing a row, or priced in another currency (¥), is not the USD
    // token table for this model - keep looking instead of inventing a price.
    if (input == null || output == null) continue;
    const cached = money(cells["cached input"]);
    const cacheRead = cached == null ? 0 : cached;

    if (!(input > 0 && output > 0)) throw new Error(`LongCat pricing: invalid prices for ${id}`);
    if (!(cacheRead >= 0 && cacheRead <= input)) throw new Error(`LongCat pricing: invalid cached input for ${id}`);

    return {
      [id]: {
        label,
        entry: { pricing: { flat: { input, output, cacheRead, cacheWrite: 0 } } },
      },
    };
  }

  throw new Error("LongCat pricing: no USD token table found");
}

export function snapshotFromPage(html, capturedAt, { source = LONGCAT_SOURCE } = {}) {
  return { capturedAt: capturedAt || new Date().toISOString(), source, models: parsePricingModels(html) };
}
