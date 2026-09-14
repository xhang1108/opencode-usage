// extension/vendors/mimo/import-usage.js
// MiMo usage XLSX rows -> canonical. Pure (P9). Two export variants share the
// same wide shape:
//   Date | Model | Total Tokens | Input Hit Tokens | Input Miss Tokens |
//   Output Tokens | Total audio duration | Request Count
// (pay-as-you-go sheets add API Key / Currency / *Amount columns).
//
// Mapping (vendors.md MiMo):
//   input = Input Miss Tokens, cacheRead = Input Hit Tokens,
//   output = Output Tokens, requests = Request Count, cacheWrite = 0.
// `Date` is a UTC day. Non-token columns (audio duration, Plugin sheet,
// amounts/currency) are ignored (P1); the whole row is kept in `raw`.

import { normalizeRecord, dayToISO } from "../../shared/canonical.js";

export const MIMO_SOURCE = "mimo";

const num = (v) => {
  const n = Number(v);
  return isFinite(n) ? n : 0;
};

// Excel serial date (days since 1899-12-30) -> YYYY-MM-DD (UTC).
export function excelSerialToISODate(serial) {
  const ms = Date.UTC(1899, 11, 30) + Math.round(Number(serial)) * 86400000;
  const d = new Date(ms);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

// Accepts an Excel serial, "YYYY-MM-DD", or "YYYY-MM-DD HH:MM:SS".
export function mimoDateToISO(value) {
  if (typeof value === "number" && isFinite(value)) return excelSerialToISODate(value);
  const s = String(value == null ? "" : value).trim();
  if (!s) return null;
  let m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  if (m) return m[1];
  m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  return null;
}

const norm = (s) => String(s == null ? "" : s).trim().toLowerCase().replace(/\s+/g, " ");

function headerMap(rows) {
  for (let r = 0; r < Math.min(rows.length, 20); r++) {
    const map = {};
    rows[r].forEach((cell, i) => {
      map[norm(cell)] = i;
    });
    if (map["date"] !== undefined && map["model"] !== undefined) return { rowIndex: r, map };
  }
  return null;
}

function planFromSheetName(name) {
  const n = norm(name);
  return n.includes("token plan") ? "token-plan" : "";
}

// sheets: [{ name, rows }] -> canonical records.
export function parseMimoSheets(sheets) {
  const records = [];
  for (const sheet of sheets || []) {
    const header = headerMap(sheet.rows || []);
    if (!header) continue; // e.g. the Plugin sheet has no Date/Model columns
    const { rowIndex, map } = header;
    const payg = map["api key"] !== undefined || map["currency"] !== undefined || map["total amount"] !== undefined;
    const plan = planFromSheetName(sheet.name) || (payg ? "payg" : "");
    const col = (...names) => {
      for (const n of names) if (map[n] !== undefined) return map[n];
      return -1;
    };
    const cDate = col("date");
    const cModel = col("model");
    const cInMiss = col("input miss tokens");
    const cInHit = col("input hit tokens");
    const cOut = col("output tokens");
    const cReq = col("request count");
    const cKey = col("api key");

    for (let r = rowIndex + 1; r < sheet.rows.length; r++) {
      const row = sheet.rows[r] || [];
      const model = String(row[cModel] ?? "").trim();
      const date = mimoDateToISO(row[cDate]);
      if (!model || !date) continue;
      const keyID = cKey !== -1 ? String(row[cKey] ?? "").trim() : "";
      const rec = normalizeRecord(
        {
          id: `${MIMO_SOURCE}:${date}|${model}|${keyID || plan || "usage"}`,
          source: MIMO_SOURCE,
          time: dayToISO(date),
          model,
          workspaceID: "MiMo",
          keyID: keyID || undefined,
          plan: plan || undefined,
          input: num(row[cInMiss]),
          output: num(row[cOut]),
          reasoning: 0,
          cacheRead: num(row[cInHit]),
          cacheWrite5m: 0,
          cacheWrite1h: 0,
          requests: num(row[cReq]),
          raw: row,
        },
        { source: MIMO_SOURCE }
      );
      records.push(rec);
    }
  }
  return records;
}
