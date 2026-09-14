// extension/shared/xlsx.js
// Minimal XLSX reader built on shared/zip.js (D17: decompress in-extension).
// Reads xl/workbook.xml + xl/_rels/workbook.xml.rels + xl/sharedStrings.xml +
// xl/worksheets/sheet*.xml into row arrays. No formulas, styles, or dates
// formatting - raw cell values (strings/numbers) only, which is all we import.

import { unzip } from "./zip.js";

const decoder = new TextDecoder("utf-8");

function unescapeXml(s) {
  return String(s)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export function colToIndex(letters) {
  let n = 0;
  for (const ch of String(letters).toUpperCase()) {
    if (ch < "A" || ch > "Z") continue;
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n - 1;
}

// <si> can hold plain <t> or rich runs <r><t>...</t></r>; concatenate all <t>.
export function parseSharedStrings(xml) {
  const out = [];
  for (const m of String(xml).matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    let s = "";
    for (const t of m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) s += unescapeXml(t[1]);
    out.push(s);
  }
  return out;
}

export function parseSheetRows(xml, sharedStrings = []) {
  const rows = [];
  for (const rm of String(xml).matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const cm of rm[1].matchAll(/<c\b([^>]*?)\/>|<c\b([^>]*?)>([\s\S]*?)<\/c>/g)) {
      const attrs = cm[1] || cm[2] || "";
      const inner = cm[3] || "";
      const ref = /r="([A-Z]+)\d+"/.exec(attrs);
      if (!ref) continue;
      const type = /t="([^"]+)"/.exec(attrs)?.[1] || "n";
      let value = "";
      if (type === "s") {
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
        value = sharedStrings[Number(v && v[1])] ?? "";
      } else if (type === "inlineStr") {
        let s = "";
        for (const t of inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) s += unescapeXml(t[1]);
        value = s;
      } else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
        const raw = v ? v[1] : "";
        if (type === "str") value = unescapeXml(raw);
        else if (type === "b") value = raw === "1";
        else value = raw !== "" && !isNaN(Number(raw)) ? Number(raw) : unescapeXml(raw);
      }
      cells[colToIndex(ref[1])] = value;
    }
    rows.push(Array.from(cells, (x) => (x === undefined ? "" : x)));
  }
  return rows;
}

// xlsx ArrayBuffer -> { sheets: [{ name, rows }] }
export async function parseXlsx(arrayBuffer) {
  const files = await unzip(arrayBuffer);
  const text = (name) => (files[name] ? decoder.decode(files[name]) : null);

  const sharedXml = text("xl/sharedStrings.xml");
  const shared = sharedXml ? parseSharedStrings(sharedXml) : [];

  const rels = {};
  const relsXml = text("xl/_rels/workbook.xml.rels");
  if (relsXml) {
    for (const m of relsXml.matchAll(/<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)) rels[m[1]] = m[2];
  }

  const sheets = [];
  const wb = text("xl/workbook.xml");
  if (wb) {
    for (const m of wb.matchAll(/<sheet\b[^>]*\/>/g)) {
      const tag = m[0];
      const name = /name="([^"]*)"/.exec(tag)?.[1] || "";
      const rid = /r:id="([^"]+)"/.exec(tag)?.[1];
      const target = rid && rels[rid];
      if (!target) continue;
      const path = `xl/${String(target).replace(/^\/?xl\//, "").replace(/^\//, "")}`;
      const xml = text(path);
      if (xml) sheets.push({ name, rows: parseSheetRows(xml, shared) });
    }
  }
  if (sheets.length === 0) {
    const names = Object.keys(files)
      .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
      .sort();
    for (const n of names) sheets.push({ name: n, rows: parseSheetRows(decoder.decode(files[n]), shared) });
  }
  return { sheets };
}
