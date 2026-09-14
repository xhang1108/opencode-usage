// extension/shared/backup.js
// Backup export/restore helpers (pure, P9). Splits a backup into two
// non-overlapping files (D24):
//   - opencode-usage_settings_<date>.json : user settings + the unified pricelist
//   - opencode-usage_records_<date>.csv   : every record, every source (+ raw)
// Only user-authored settings are stored; the derived fallback `pricing` table
// is rebuilt from the shipped presets, so it is never backed up.

import { normalizeRecord, validateRecord } from "./canonical.js";
import { parseCSV, rowsToObjects, toCSV } from "./csv.js";

export const SETTINGS_FORMAT = "opencode-usage-settings";
export const SETTINGS_VERSION = 1;

// The slice of dashboard settings that is user-authored. `registry` is seeded
// from vendors.json, and `pricing` is derived, so neither is included.
export const SETTINGS_KEYS = [
  "vendorSettings",
  "unifiedPricing",
  "defaultCrawl",
  "workspaceLabels",
];

export function buildSettingsPayload(settings, { now = () => new Date() } = {}) {
  const s = settings || {};
  const picked = {};
  for (const k of SETTINGS_KEYS) if (s[k] !== undefined) picked[k] = s[k];
  return {
    format: SETTINGS_FORMAT,
    version: SETTINGS_VERSION,
    exportedAt: now().toISOString(),
    settings: picked,
  };
}

// Validate the wrapper and return the settings patch (only known keys).
export function parseSettingsPayload(payload) {
  const p = typeof payload === "string" ? JSON.parse(payload) : payload;
  if (!p || typeof p !== "object" || p.format !== SETTINGS_FORMAT) {
    throw new Error("Not an opencode-usage settings file");
  }
  const out = {};
  const s = p.settings && typeof p.settings === "object" ? p.settings : {};
  for (const k of SETTINGS_KEYS) if (s[k] !== undefined) out[k] = s[k];
  return out;
}

// Canonical columns, stable order. `raw` (per-source provenance) is JSON-encoded
// into a single cell so the CSV stays lossless; computed fields (cost, savings,
// window, priceBasis) are intentionally absent.
export const RECORD_COLUMNS = [
  "id", "source", "v", "time", "date", "model", "provider", "workspaceID", "keyID", "sessionID",
  "input", "output", "reasoning", "cacheRead", "cacheWrite5m", "cacheWrite1h",
  "requests", "tzOffset", "vendorCost", "costScale", "cacheBasis", "outputExcludesReasoning",
  "plan", "costMultiplier", "timeUpdated", "raw",
];

const NUMERIC_COLUMNS = new Set([
  "v", "input", "output", "reasoning", "cacheRead", "cacheWrite5m", "cacheWrite1h",
  "requests", "tzOffset", "vendorCost", "costScale", "costMultiplier",
]);

function recordRow(rec) {
  return RECORD_COLUMNS.map((col) => {
    const v = rec[col];
    if (col === "raw") return v == null ? "" : JSON.stringify(v);
    if (col === "outputExcludesReasoning") return v ? "true" : "";
    return v == null ? "" : v;
  });
}

export function recordsToCSV(records) {
  const rows = [RECORD_COLUMNS, ...(records || []).map(recordRow)];
  return toCSV(rows);
}

function rowToRecord(row) {
  const rec = {};
  for (const col of RECORD_COLUMNS) {
    const v = row[col];
    if (v === undefined || v === null || v === "") continue;
    if (NUMERIC_COLUMNS.has(col)) {
      const n = Number(v);
      if (Number.isFinite(n)) rec[col] = n;
    } else if (col === "outputExcludesReasoning") {
      rec[col] = String(v) === "true";
    } else if (col === "raw") {
      try {
        rec.raw = JSON.parse(v);
      } catch (e) {
        // damaged raw cell: keep the record, drop provenance
      }
    } else {
      rec[col] = v;
    }
  }
  if (!rec.model) return null;
  const norm = normalizeRecord(rec, { source: rec.source });
  return validateRecord(norm).ok ? norm : null;
}

// Restore records from a backup CSV; rows that don't validate are skipped.
export function csvToRecords(text) {
  const out = [];
  for (const row of rowsToObjects(parseCSV(text))) {
    const rec = rowToRecord(row);
    if (rec) out.push(rec);
  }
  return out;
}

// Group restored records by their storage source (opencode vs a vendor map).
export function groupBySource(records) {
  const map = new Map();
  for (const rec of records || []) {
    const src = rec.source || "opencode";
    if (!map.has(src)) map.set(src, []);
    map.get(src).push(rec);
  }
  return map;
}
