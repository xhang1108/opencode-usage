// extension/vendors/deepseek-official/import-amount.js
// DeepSeek Usage Export -> canonical. Pure (P9): no chrome, no DOM.
//
// The export ZIP contains amount-*.csv + cost-*.csv. Only `amount` is used
// (cost is CNY, ignored per P1). Long format: one row per
// (user_id, start_time_iso, model, api_key_name, type), where type is one of
// input_cache_miss_tokens / input_cache_hit_tokens / output_tokens /
// request_count. `api_key` is a (masked) credential and is dropped.
//
// Mapping (vendors.md DeepSeek):
// input = input_cache_miss_tokens, cacheRead = input_cache_hit_tokens,
// output = output_tokens, requests = request_count, cacheWrite = 0.
// The day (from `utc_date`, else the date part of start_time_iso) is stored as
// UTC midnight so both DeepSeek export variants map to the same record.

import { normalizeRecord, makeId, dayToISO } from "../../shared/canonical.js";
import { parseCSV, rowsToObjects } from "../../shared/csv.js";

export const DEEPSEEK_SOURCE = "deepseek-official";

// Re-exported for the legacy DeepSeek ZIP importer (and its tests).
export { parseCSV, rowsToObjects } from "../../shared/csv.js";

const TYPE_FIELD = {
  input_cache_miss_tokens: "input",
  input_cache_hit_tokens: "cacheRead",
  output_tokens: "output",
};

// DeepSeek exports the same daily buckets two ways: a UTC variant (extra
// `utc_date` column, `+00:00` offsets) and a local variant (`+08:00` offsets),
// both carrying identical numbers. The `+08:00` label is not a real window
// shift (the vendor's own UTC export uses the same wall clock), so we key by
// the DAY and store it as UTC midnight: `<day>T00:00:00Z`. This keeps the two
// variants idempotent and the calendar day stable.
export function dayOf(o) {
  const u = String((o && o.utc_date) || "").trim();
  if (/^\d{8}$/.test(u)) return `${u.slice(0, 4)}-${u.slice(4, 6)}-${u.slice(6, 8)}`;
  const s = String((o && o.start_time_iso) || "").trim();
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return m ? m[1] : null;
}

// Group long-format amount rows into one canonical record per
// (user_id, day, model, api_key_name).
export function mapAmountObjects(objects, { source = DEEPSEEK_SOURCE } = {}) {
  const groups = new Map();
  for (const o of objects || []) {
    if (!o || !o.model) continue;
    const day = dayOf(o);
    if (!day) continue;
    const key = [o.user_id || "", day, o.model, o.api_key_name || ""].join("|");
    let g = groups.get(key);
    if (!g) {
      g = { key, userID: o.user_id || "", day, model: o.model, keyID: o.api_key_name || "", input: 0, cacheRead: 0, output: 0, requests: 0, raw: [] };
      groups.set(key, g);
    }
    const amount = Number(o.amount);
    if (isFinite(amount)) {
      const field = TYPE_FIELD[String(o.type || "").trim()];
      if (field) g[field] += amount;
      else if (String(o.type || "").trim() === "request_count") g.requests += amount;
    }
    const clean = { ...o };
    delete clean.api_key; // credential - never store (vendors.md)
    g.raw.push(clean);
  }

  const records = [];
  for (const g of groups.values()) {
    records.push(
      normalizeRecord(
        {
          id: makeId(source, null, g.key),
          source,
          time: dayToISO(g.day),
          model: g.model,
          workspaceID: g.userID || "DeepSeek",
          keyID: g.keyID || undefined,
          input: g.input,
          output: g.output,
          reasoning: 0,
          cacheRead: g.cacheRead,
          cacheWrite5m: 0,
          cacheWrite1h: 0,
          requests: g.requests,
          raw: g.raw,
        },
        { source }
      )
    );
  }
  return records;
}

export function importAmountCSVs(texts, opts) {
  const objects = [];
  for (const text of texts || []) objects.push(...rowsToObjects(parseCSV(text)));
  return mapAmountObjects(objects, opts);
}
