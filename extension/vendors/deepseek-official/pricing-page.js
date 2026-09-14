// extension/vendors/deepseek-official/pricing-page.js
// Parse the official DeepSeek "Models & Pricing" HTML into a normalized price
// snapshot. Pure (P9): input is the raw page HTML. The page is server-rendered
// and table-based; this reads the PRICING rows (cache hit / cache miss /
// output, off-peak & peak) and the peak-window note.
//
// Entry schema (shared/pricing.js):
//   peak/offpeak: { windows: { peak: [...] }, pricing: { peak, offpeak } }
//   flat (older pages): { pricing: { flat: {...} } }
// Mapping: cache miss -> input, cache hit -> cacheRead, output -> output,
// cacheWrite = 0 (not priced separately).

export const DEEPSEEK_SOURCE = "deepseek-official";

// The page shows display names (e.g. "DeepSeek-V4.1-Flash") and labels older
// generations by thinking mode; exports use API ids. Normalize both to a stable
// canonical id so one model = one version chain.
export function canonicalModelName(label) {
  const s = String(label).trim();
  if (/non[- ]?thinking/i.test(s)) return "deepseek-chat";
  if (/thinking/i.test(s)) return "deepseek-reasoner";
  if (/coder/i.test(s)) return "deepseek-coder";
  const slug = s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (/^deepseek-v4-?1-flash/.test(slug) || /^deepseek-flash/.test(slug) || /^deepseek-v4-flash/.test(slug)) return "deepseek-v4-flash";
  if (/^deepseek-v4-pro/.test(slug)) return "deepseek-v4-pro";
  return slug;
}

function textOf(cell) {
  return decodeEntities(String(cell).replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function rowsOf(html) {
  return String(html)
    .split(/<tr[^>]*>/i)
    .slice(1)
    .map((chunk) => {
      const end = chunk.search(/<\/tr>/i);
      const body = end === -1 ? chunk : chunk.slice(0, end);
      return [...body.matchAll(/<(t[dh])[^>]*>([\s\S]*?)<\/\1>/gi)].map((m) => m[2]);
    });
}

function firstTable(html) {
  const m = /<table[\s\S]*?<\/table>/i.exec(String(html));
  return m ? m[0] : String(html);
}

export function parsePeakWindows(html) {
  // "Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday".
  const text = textOf(String(html).replace(/<[^>]*>/g, " "));
  const windows = [];
  const re = /(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const days = /monday\s*(?:through|to|-)\s*friday/i.test(text) ? [1, 2, 3, 4, 5] : [];
    windows.push({ days, start: m[1].padStart(5, "0"), end: m[2].padStart(5, "0") });
  }
  return windows;
}

// Two page layouts:
//  - wide (older): header columns INPUT PRICE (CACHE HIT) / (CACHE MISS) /
//    OUTPUT PRICE, one row per model -> flat entry.
//  - long (current): model columns + PRICING rows CACHE HIT/MISS/OUTPUT x
//    OFF-PEAK/PEAK -> peak/offpeak entry (flat if no peak rows).
// html -> { "<model>": { label, entry } }
export function parsePricingModels(html) {
  const rows = rowsOf(firstTable(html)).map((cells) => cells.map(textOf));
  const headerIdx = rows.findIndex((cells) => cells.some((c) => /^MODEL(\b|$)/i.test(c.trim())));
  const header = headerIdx !== -1 ? rows[headerIdx] : [];
  const wide = header.some((c) => /CACHE HIT/i.test(c)) && header.some((c) => /CACHE MISS/i.test(c));
  if (wide) return parseWide(rows, headerIdx, header);
  return parseLong(rows, html);
}

function val(cell) {
  const m = String(cell || "").match(/\$([0-9.]+)/);
  return m ? Number(m[1]) : 0;
}

// A parsed entry is unusable when every price is 0 (old layouts / parse drift).
function isZeroEntry(entry) {
  const t = (entry.pricing && entry.pricing.flat) || (entry.pricing && entry.pricing.offpeak) || {};
  return !(t.input || t.output || t.cacheRead);
}

function parseWide(rows, headerIdx, header) {
  const colModel = header.findIndex((c) => /^MODEL(\b|$)/i.test(c.trim()));
  const colHit = header.findIndex((c) => /CACHE HIT/i.test(c));
  const colMiss = header.findIndex((c) => /CACHE MISS/i.test(c));
  let colOut = header.findIndex((c) => /OUTPUT\s*PRICE/i.test(c));
  if (colOut === -1) colOut = header.length - 1; // fallback: last column
  const out = {};
  for (let r = headerIdx + 1; r < rows.length; r++) {
    const cells = rows[r];
    const raw = (cells[colModel] || "").trim();
    const label = canonicalModelName(raw);
    if (!label) continue;
    const entry = { pricing: { flat: { input: val(cells[colMiss]), output: val(cells[colOut]), cacheRead: val(cells[colHit]), cacheWrite: 0 } } };
    if (isZeroEntry(entry)) continue;
    out[label] = { label, entry };
  }
  if (Object.keys(out).length === 0) throw new Error("DeepSeek pricing page: no model rows found (wide layout)");
  return out;
}function parseLong(rows, html) {
  const table = { cacheHit: {}, cacheMiss: {}, output: {} };
  const flat = { cacheHit: null, cacheMiss: null, output: null };
  let models = [];
  let metric = null;
  let hasPeak = false;

  for (const texts of rows) {
    const joined = texts.join(" ");
    const modelIdx = texts.findIndex((t) => /^MODEL(\b|$)/i.test(t.trim()));
    if (modelIdx !== -1) {
      models = texts
        .slice(modelIdx + 1)
        .map((t) => t.replace(/\(\d+\)\s*$/, "").trim())
        .filter((t) => t && !/\$/.test(t) && !/LENGTH|OUTPUT|PRICE|TOKEN/i.test(t));
      continue;
    }

    if (/CACHE HIT/i.test(joined)) metric = "cacheHit";
    else if (/CACHE MISS/i.test(joined)) metric = "cacheMiss";
    else if (/\bOUTPUT\b/i.test(joined)) metric = "output";

    const dollars = texts.map((t) => { const mm = t.match(/\$([0-9.]+)/); return mm ? Number(mm[1]) : null; }).filter((v) => v !== null);
    if (!metric || dollars.length === 0) continue;

    const period = /OFF-PEAK/i.test(joined) ? "offpeak" : /PEAK/i.test(joined) ? "peak" : null;
    if (period) {
      hasPeak = true;
      if (!table[metric][period]) table[metric][period] = dollars;
    } else if (!flat[metric]) {
      flat[metric] = dollars;
    }
  }

  if (models.length === 0) throw new Error("DeepSeek pricing page: no model columns found (long layout)");

  const windows = hasPeak ? parsePeakWindows(html) : [];
  const out = {};
  for (let i = 0; i < models.length; i++) {
    const label = canonicalModelName(models[i]);
    const pick = (obj, key) => (obj && Array.isArray(obj[key]) ? obj[key][i] : 0) || 0;
    const entry = hasPeak
      ? {
          windows: { peak: windows.map((w) => ({ ...w })) },
          pricing: {
            peak: { input: pick(table.cacheMiss, "peak"), output: pick(table.output, "peak"), cacheRead: pick(table.cacheHit, "peak"), cacheWrite: 0 },
            offpeak: { input: pick(table.cacheMiss, "offpeak"), output: pick(table.output, "offpeak"), cacheRead: pick(table.cacheHit, "offpeak"), cacheWrite: 0 },
          },
        }
      : {
          pricing: {
            flat: { input: pick(flat, "cacheMiss"), output: pick(flat, "output"), cacheRead: pick(flat, "cacheHit"), cacheWrite: 0 },
          },
        };
    if (isZeroEntry(entry)) continue;
    out[label] = { label, entry };
  }
  if (Object.keys(out).length === 0) throw new Error("DeepSeek pricing page: no model columns found (long layout)");
  return out;
}

export function snapshotFromPage(html, capturedAt, { source = DEEPSEEK_SOURCE } = {}) {
  const models = parsePricingModels(html);
  return { capturedAt: capturedAt || new Date().toISOString(), source, models };
}
