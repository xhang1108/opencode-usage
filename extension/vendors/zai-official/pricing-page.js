// extension/vendors/zai-official/pricing-page.js
// Parse Z.ai's official GLM pricing page (HTML) into a normalized price
// snapshot. Pure (P9): input is the raw page HTML.
//
// Layout: several <table>s with columns
//   Model | Input | Cached Input | Cached Input Storage | Output
// (plus image/video/audio tables we ignore). USD per 1M tokens.
// Cached Input Storage is a "Limited-time Free" storage promo, not a per-token
// cacheWrite, so cacheWrite stays 0.

export const ZAI_SOURCE = "zai-official";

const MIN_MODELS = 10;
const ANCHOR = "glm-5.3";

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

function money(cell) {
  const s = String(cell || "").trim();
  if (/free/i.test(s)) return 0;
  const m = s.match(/\$\s*([0-9.]+)/);
  return m ? Number(m[1]) : 0;
}

function canonicalModelName(label) {
  return String(label || "")
    .replace(/`/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9.\-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function rowsOfTable(tableHtml) {
  const trs = [...String(tableHtml).matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
  return trs.map((m) => {
    const cells = [...m[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((c) => stripTags(c[1]));
    return cells;
  });
}

// html -> { "<model>": { label, entry } }
export function parsePricingModels(html) {
  const tables = [...String(html).matchAll(/<table[\s\S]*?<\/table>/gi)].map((m) => m[0]);
  const out = {};

  for (const table of tables) {
    const rows = rowsOfTable(table);
    if (rows.length === 0) continue;
    const header = rows[0];
    const isPricingTable =
      header.length >= 5 &&
      /^Model$/i.test(header[0]) &&
      header.some((c) => /^Input$/i.test(c)) &&
      header.some((c) => /^Cached Input$/i.test(c)) &&
      header.some((c) => /^Output$/i.test(c));
    if (!isPricingTable) continue;

    for (let r = 1; r < rows.length; r++) {
      const cells = rows[r];
      if (cells.length < 5) continue;

      const label = cells[0];
      if (!label || /^Model$/i.test(label)) continue;

      const input = money(cells[1]);
      const cacheRead = money(cells[2]);
      // cells[3] = Cached Input Storage (promo) - ignored
      const output = money(cells[4]);

      // All-"Free" rows carry no price of their own and are skipped: an
      // unpriced group is honest, while "free" has to be an authored 0/0/0/0
      // override (see OVERRIDE_RATES "big-pickle") because build-unified-preset
      // treats a source's all-zero table as "no price".
      if (input === 0 && cacheRead === 0 && output === 0) continue;

      const id = canonicalModelName(label);
      if (!id) continue;
      out[id] = {
        label,
        entry: {
          pricing: {
            flat: { input, output, cacheRead, cacheWrite: 0 },
          },
        },
      };
    }
  }

  const count = Object.keys(out).length;
  if (count === 0) throw new Error("Z.ai pricing: no model rows parsed");
  if (!out[ANCHOR]) throw new Error(`Z.ai pricing: anchor model ${ANCHOR} missing`);
  if (count < MIN_MODELS) throw new Error(`Z.ai pricing: only ${count} models (<${MIN_MODELS}) - layout drift?`);

  for (const [id, m] of Object.entries(out)) {
    const f = m.entry.pricing.flat;
    if (!(f.input >= 0 && f.output >= 0 && f.cacheRead >= 0)) {
      throw new Error(`Z.ai pricing: invalid prices for ${id}`);
    }
  }
  return out;
}

export function snapshotFromPage(html, capturedAt, { source = ZAI_SOURCE } = {}) {
  return { capturedAt: capturedAt || new Date().toISOString(), source, models: parsePricingModels(html) };
}