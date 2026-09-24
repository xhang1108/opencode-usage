// extension/vendors/tencent-official/pricing-page.js
// Parse Tencent Cloud TokenHub's official Hunyuan pricing (USD). Pure (P9).
//
// Layout: model rows live in tables keyed by <td data-label="Model|Type|Input|
// Output|Cache hit|Action">. The full table is embedded both server-rendered
// and inside an escaped JSON payload (\" / \n / <), so the whole document is
// unescaped once before extraction; duplicate ids collapse first-wins.
//
// Only "Tencent Hunyuan …" rows are captured — the table also resells
// DeepSeek/GLM/Kimi models whose prices belong to their own vendors.
// Model ids are the page labels minus the vendor prefix, slugified:
//   "Tencent Hunyuan Hy3"        -> hy3
//   "Tencent Hunyuan Hy4 Preview" (badge span "New" stripped) -> hy4-preview
// Flat pricing only; cacheWrite is not listed -> 0.

export const TENCENT_SOURCE = "tencent-official";

const MIN_MODELS = 1;
const ANCHOR = "hy3";

function textOf(cell) {
  return String(cell)
    .replace(/<[^>]*>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function money(cell) {
  const m = /\$\s*([0-9.]+)/.exec(String(cell || ""));
  return m ? Number(m[1]) : 0;
}

// Unescape the JSON-embedded copy of the table. Raw HTML has no \" sequences,
// so the replacements only affect the escaped payload.
function normalize(html) {
  return String(html)
    .replace(/\\"/g, '"')
    .replace(/\\n/g, "\n")
    .replace(/\\u003c/gi, "<")
    .replace(/\\u003e/gi, ">");
}

function modelLabel(cell) {
  // drop promo badges (<span class="custom-models__promo">New</span>) before text
  return textOf(String(cell).replace(/<span[^>]*>[\s\S]*?<\/span>/g, ""));
}

function idFrom(label) {
  return label
    .replace(/^Tencent\s+Hunyuan\s+/i, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
}

// html -> { "<id>": { label, entry } }
export function parsePricingModels(html) {
  const doc = normalize(html);
  const tables = [...doc.matchAll(/<table[\s\S]*?<\/table>/gi)].map((m) => m[0]).filter((t) => /data-label/.test(t));
  const out = {};

  for (const table of tables) {
    const rows = table.split(/<tr[^>]*>/i).slice(1);
    for (const chunk of rows) {
      const end = chunk.search(/<\/tr>/i);
      const body = end === -1 ? chunk : chunk.slice(0, end);
      const cells = [...body.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
      if (cells.length < 5) continue;
      const label = modelLabel(cells[0]);
      if (!/^Tencent\s+Hunyuan/i.test(label)) continue;
      const id = idFrom(label);
      if (!id || out[id]) continue;
      const entry = {
        pricing: {
          flat: {
            input: money(cells[2]),
            output: money(cells[3]),
            cacheRead: money(cells[4]),
            cacheWrite: 0,
          },
        },
      };
      out[id] = { label: id, entry };
    }
  }

  // Fail closed: no Hunyuan rows / missing anchor / bad prices => layout drift.
  const count = Object.keys(out).length;
  if (count === 0) throw new Error("Tencent pricing: no Tencent Hunyuan rows parsed");
  if (!out[ANCHOR]) throw new Error(`Tencent pricing: anchor model ${ANCHOR} missing`);
  if (count < MIN_MODELS) throw new Error(`Tencent pricing: only ${count} models (<${MIN_MODELS}) — layout drift?`);
  for (const [id, m] of Object.entries(out)) {
    const leg = m.entry.pricing.flat;
    if (!(leg.input > 0 && leg.output > 0 && leg.output >= leg.input && leg.cacheRead < leg.input)) {
      throw new Error(`Tencent pricing: insane prices for ${id}`);
    }
  }
  return out;
}

export function snapshotFromPage(html, capturedAt, { source = TENCENT_SOURCE } = {}) {
  return { capturedAt: capturedAt || new Date().toISOString(), source, models: parsePricingModels(html) };
}
