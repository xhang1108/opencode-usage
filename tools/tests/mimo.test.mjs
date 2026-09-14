import { test } from "node:test";
import assert from "node:assert/strict";

import { parseMimoSheets, mimoDateToISO, excelSerialToISODate } from "../../extension/vendors/mimo/import-usage.js";

const serialFor = (y, m, d) => Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);

test("excelSerialToISODate and mimoDateToISO", () => {
  assert.equal(excelSerialToISODate(0), "1899-12-30");
  assert.equal(excelSerialToISODate(serialFor(2026, 7, 1)), "2026-07-01");
  assert.equal(mimoDateToISO(serialFor(2026, 7, 1)), "2026-07-01");
  assert.equal(mimoDateToISO("2026-07-01"), "2026-07-01");
  assert.equal(mimoDateToISO("2026/7/1 00:00"), "2026-07-01");
  assert.equal(mimoDateToISO(""), null);
});

const TOKEN_PLAN_SHEET = {
  name: "Token plan usage detail",
  rows: [
    ["Date", "Model", "Total Tokens", "Input Hit Tokens", "Input Miss Tokens", "Output Tokens", "Total audio duration", "Request Count"],
    ["2026-07-01", "deepseek-v4-flash", 100000000, 90000000, 8000000, 2000000, 0, 1000],
    ["2026-07-02", "deepseek-v4-pro", 69207493, 60000000, 7000000, 2207493, 12.5, 1048],
  ],
};

test("parseMimoSheets maps wide token-plan rows and reconciles totals", () => {
  const records = parseMimoSheets([TOKEN_PLAN_SHEET]);
  assert.equal(records.length, 2);
  const r = records[0];
  assert.equal(r.source, "mimo");
  assert.equal(r.model, "deepseek-v4-flash");
  assert.equal(r.time, "2026-07-01T00:00:00.000Z");
  assert.equal(r.input, 8000000);
  assert.equal(r.cacheRead, 90000000);
  assert.equal(r.output, 2000000);
  assert.equal(r.requests, 1000);
  assert.equal(r.cacheWrite5m, 0);
  assert.equal(r.plan, "token-plan");
  assert.equal(r.workspaceID, "MiMo");
  const totalTok = (x) => x.input + x.cacheRead + x.output + x.reasoning + x.cacheWrite5m + x.cacheWrite1h;
  assert.equal(records.reduce((s, x) => s + totalTok(x), 0), 169207493);
  assert.equal(records.reduce((s, x) => s + x.requests, 0), 2048);
});

test("parseMimoSheets ignores sheets without Date/Model (Plugin sheet)", () => {
  const plugin = { name: "Plugin usage detail", rows: [["Plugin", "Count"], ["Search", 3]] };
  assert.equal(parseMimoSheets([plugin]).length, 0);
});

test("parseMimoSheets reads payg keys and ignores currency/amount columns", () => {
  const payg = {
    name: "Model usage detail",
    rows: [
      ["Date", "Model", "API Key", "Currency", "Total Amount", "Input Hit Tokens", "Input Miss Tokens", "Output Tokens", "Request Count"],
      ["2026-07-03", "deepseek-v4-flash", "sk-abc", "USD", 1.23, 10, 20, 30, 4],
    ],
  };
  const r = parseMimoSheets([payg])[0];
  assert.equal(r.plan, "payg");
  assert.equal(r.keyID, "sk-abc");
  assert.equal(r.input, 20);
  assert.equal(r.cacheRead, 10);
  assert.equal(r.output, 30);
  assert.equal(r.requests, 4);
  assert.equal(r.vendorCost, undefined);
  assert.equal(r.time, "2026-07-03T00:00:00.000Z");
});
