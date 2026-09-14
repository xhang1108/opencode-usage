// extension/shared/canonical.js
// Vendor-neutral canonical record helpers. Zero chrome dependencies (P9).
// Adapters build records with these; core (merge/dashboard/pricing) only reads canonical.

export const SCHEMA_VERSION = 1;

// Token fields are always present in canonical records (P7). Numeric coercion
// happens in normalizeRecord so downstream math never deals with strings.
export const TOKEN_FIELDS = ["input", "output", "reasoning", "cacheRead", "cacheWrite5m", "cacheWrite1h"];
export const OPTIONAL_NUMERIC_FIELDS = ["requests", "tzOffset"];

// date is derived from time in UTC (P8); stored date is never trusted.
export function canonicalDate(timeIso) {
  const d = new Date(timeIso);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

// D22: day-granular sources store the calendar day anchored at UTC midnight
// (`<day>T00:00:00Z`). This keeps the day stable no matter what offset the
// vendor printed, and makes re-imports idempotent. Real-timestamp sources keep
// their exact UTC instant instead.
export function dayToISO(day) {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(day == null ? "" : day).trim());
  return m ? `${m[1]}T00:00:00.000Z` : null;
}

// Canonical `output` EXCLUDES reasoning; `reasoning` is a separate, additive
// count (matches opencode's stored session schema and its cost formula
// `(output + reasoning) * outputRate`). Some vendors report completion tokens
// INCLUSIVE of reasoning (opencode console `outputTokens`, OpenRouter
// `tokens_completion`) — adapters subtract at the boundary so dashboard token
// totals and cost never count reasoning twice.
export function exclusiveOutput(outputInclusive, reasoning) {
  const out = Number(outputInclusive) || 0;
  const r = Number(reasoning) || 0;
  return Math.max(0, out - r);
}

// D23 one-time self-heal for opencode crawl records written before the parser
// started storing an exclusive `output`. Legacy rows kept the console
// `outputTokens` (reasoning INCLUDED) while core adds `reasoning` again, so
// they must be repaired once. New rows carry `outputExcludesReasoning: true`
// and are skipped, which also makes this safe to call on every read.
// NOTE: background.js imports this module and heals every opencode export, so
// there is a single implementation (the opencode content script does not heal).
export function healOpencodeCrawlOutput(rec) {
  if (!rec || typeof rec !== "object" || rec.outputExcludesReasoning) return rec;
  const reasoning = Number(rec.reasoning) || 0;
  if (reasoning > 0) rec.output = Math.max(0, (Number(rec.output) || 0) - reasoning);
  rec.outputExcludesReasoning = true;
  return rec;
}

// FNV-1a 32-bit -> 8 hex chars. Stable across runs, used for ids without an
// origin id (D4).
export function stableHash(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// "<source>:<orig-id>" (D4). When no origin id exists, hash a stable fallback.
export function makeId(source, origId, fallback = "") {
  const src = source || "opencode";
  if (origId != null && origId !== "") return `${src}:${origId}`;
  return `${src}:${stableHash(fallback)}`;
}

// Coerce strings (vendor APIs return token counts as strings) and fill defaults.
export function normalizeRecord(raw, { source } = {}) {
  if (!raw || typeof raw !== "object") return null;
  const rec = { ...raw };
  if (!rec.source) rec.source = source || "opencode"; // D4: legacy = opencode

  let t = new Date(rec.time);
  if (isNaN(t.getTime()) && rec.date) {
    const d2 = new Date(`${rec.date}T00:00:00Z`);
    if (!isNaN(d2.getTime())) t = d2;
  }
  if (!isNaN(t.getTime())) rec.time = t.toISOString();
  rec.date = canonicalDate(rec.time) || rec.date || null;

  for (const f of TOKEN_FIELDS) {
    const n = Number(rec[f]);
    rec[f] = isNaN(n) ? 0 : n;
  }
  for (const f of OPTIONAL_NUMERIC_FIELDS) {
    if (rec[f] == null) {
      delete rec[f];
      continue;
    }
    const n = Number(rec[f]);
    if (isNaN(n)) delete rec[f];
    else rec[f] = n;
  }

  if (rec.id == null || rec.id === "") {
    rec.id = makeId(
      rec.source,
      null,
      [rec.source, rec.time, rec.model, rec.input, rec.output, rec.cacheRead].join("|")
    );
  }
  rec.v = rec.v || SCHEMA_VERSION;
  return rec;
}

// D4: required id/source/model/time + at least one token > 0.
export function validateRecord(rec) {
  if (!rec || typeof rec !== "object") return { ok: false, reason: "not-object" };
  for (const f of ["id", "source", "model", "time"]) {
    if (rec[f] == null || rec[f] === "") return { ok: false, reason: `missing:${f}` };
  }
  if (isNaN(new Date(rec.time).getTime())) return { ok: false, reason: "bad-time" };
  const tokens = TOKEN_FIELDS.reduce((s, f) => s + (Number(rec[f]) || 0), 0);
  if (tokens <= 0) return { ok: false, reason: "no-tokens" };
  return { ok: true };
}
