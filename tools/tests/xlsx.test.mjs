import { test } from "node:test";
import assert from "node:assert/strict";

import { parseXlsx, parseSharedStrings, parseSheetRows, colToIndex } from "../../extension/shared/xlsx.js";

// Minimal ZIP writer (stored, no CRC) for the fixture.
function makeZip(files) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const n = Buffer.from(name);
    const raw = Buffer.from(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt32LE(raw.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(n.length, 26);
    local.push(lh, n, raw);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt32LE(raw.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(n.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, n);
    offset += lh.length + n.length + raw.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cdBuf, eocd]);
}

const SHARED = `<sst>${["Date", "Model", "Input Miss Tokens", "Input Hit Tokens", "Output Tokens", "Request Count", "2026-07-01", "deepseek-v4-flash"]
  .map((t) => `<si><t>${t}</t></si>`)
  .join("")}</sst>`;

const SHEET = `<worksheet><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c><c r="E1" t="s"><v>4</v></c><c r="F1" t="s"><v>5</v></c></row>
<row r="2"><c r="A2" t="s"><v>6</v></c><c r="B2" t="s"><v>7</v></c><c r="C2"><v>100</v></c><c r="D2"><v>40</v></c><c r="E2"><v>25</v></c><c r="F2"><v>3</v></c></row>
</sheetData></worksheet>`;

test("colToIndex maps column letters", () => {
  assert.equal(colToIndex("A"), 0);
  assert.equal(colToIndex("Z"), 25);
  assert.equal(colToIndex("AA"), 26);
});

test("parseSharedStrings handles plain and rich text", () => {
  assert.deepEqual(parseSharedStrings("<sst><si><t>a</t></si><si><r><t>b</t></r><r><t>c</t></r></si></sst>"), ["a", "bc"]);
});

test("parseSheetRows resolves shared strings and numeric cells", () => {
  const rows = parseSheetRows(SHEET, parseSharedStrings(SHARED));
  assert.deepEqual(rows[1], ["2026-07-01", "deepseek-v4-flash", 100, 40, 25, 3]);
});

test("parseXlsx reads workbook sheets via rels", async () => {
  const buf = makeZip({
    "xl/workbook.xml": `<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Token plan usage detail" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    "xl/sharedStrings.xml": SHARED,
    "xl/worksheets/sheet1.xml": SHEET,
  });
  const { sheets } = await parseXlsx(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  assert.equal(sheets.length, 1);
  assert.equal(sheets[0].name, "Token plan usage detail");
  assert.deepEqual(sheets[0].rows[0].slice(0, 6), ["Date", "Model", "Input Miss Tokens", "Input Hit Tokens", "Output Tokens", "Request Count"]);
  assert.deepEqual(sheets[0].rows[1], ["2026-07-01", "deepseek-v4-flash", 100, 40, 25, 3]);
});
