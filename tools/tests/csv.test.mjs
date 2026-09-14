import { test } from "node:test";
import assert from "node:assert/strict";

import { parseCSV, rowsToObjects, toCSV } from "../../extension/shared/csv.js";

test("parseCSV handles quotes, commas and CRLF", () => {
  const rows = parseCSV('a,b,c\r\n1,"x,y",3\r\n"he said ""hi""",2,4\n');
  assert.deepEqual(rows, [
    ["a", "b", "c"],
    ["1", "x,y", "3"],
    ['he said "hi"', "2", "4"],
  ]);
});

test("parseCSV strips a leading UTF-8 BOM", () => {
  const rows = parseCSV("\uFEFFa,b\n1,2\n");
  assert.deepEqual(rows, [["a", "b"], ["1", "2"]]);
});

test("parseCSV keeps newlines inside quoted fields", () => {
  const rows = parseCSV('a,b\n"line1\nline2",2\n');
  assert.deepEqual(rows, [["a", "b"], ["line1\nline2", "2"]]);
});

test("toCSV quotes every field and doubles embedded quotes", () => {
  const text = toCSV([
    ["a", "b"],
    ['he said "hi"', "x,y"],
  ]);
  assert.equal(text, '"a","b"\n"he said ""hi""","x,y"');
});

test("toCSV -> parseCSV round-trips tricky values", () => {
  const rows = [
    ["a", "b", "c"],
    ["comma,value", 'quote"value', "line\nvalue"],
    ["", "plain", "1"],
  ];
  assert.deepEqual(parseCSV(toCSV(rows)), rows);
});

test("rowsToObjects maps header to values and skips blank lines", () => {
  const objs = rowsToObjects(parseCSV("model,amount\nm1,10\n\n"));
  assert.deepEqual(objs, [{ model: "m1", amount: "10" }]);
});
