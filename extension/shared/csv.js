// extension/shared/csv.js
// Minimal RFC-4180 CSV reader/writer. Zero chrome dependencies (P9). Used by
// the backup export/restore and the DeepSeek legacy CSV importer.

// Strip a leading UTF-8 BOM (Excel writes one when we export with a BOM).
export function parseCSV(text) {
  let s = String(text == null ? "" : text);
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  const rows = [];
  let field = "";
  let row = [];
  let inQuotes = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c === "\r") {
      // ignore
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// First row is the header; each remaining row becomes an object keyed by it.
export function rowsToObjects(rows) {
  if (!rows || rows.length === 0) return [];
  const header = rows[0].map((h) => String(h).trim());
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || (r.length === 1 && r[0] === "")) continue;
    const o = {};
    for (let c = 0; c < header.length; c++) o[header[c]] = r[c] !== undefined ? r[c] : "";
    out.push(o);
  }
  return out;
}

// Rows (array of arrays, header included) -> CSV text. Every field is quoted
// and embedded quotes are doubled, so values with commas/newlines are safe.
export function toCSV(rows) {
  return (rows || [])
    .map((row) => (row || []).map((v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`).join(","))
    .join("\n");
}
