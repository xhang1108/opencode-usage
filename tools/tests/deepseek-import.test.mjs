import { test } from "node:test";
import assert from "node:assert/strict";

import { parseCSV, rowsToObjects, mapAmountObjects, importAmountCSVs } from "../../extension/vendors/deepseek-official/import-amount.js";

const HEADER = "user_id,start_time_iso,end_time_iso,model,api_key_name,api_key,type,price,amount";
const row = (model, type, amount, key = "key-a") =>
  `u1,2026-06-16T00:00:00+08:00,2026-06-17T00:00:00+08:00,${model},${key},sk-masked,${type},0.000001,${amount}`;

test("parseCSV handles quotes, commas and CRLF", () => {
  const rows = parseCSV('a,b,c\r\n1,"x,y",3\r\n"he said ""hi""",2,4\n');
  assert.deepEqual(rows, [
    ["a", "b", "c"],
    ["1", "x,y", "3"],
    ['he said "hi"', "2", "4"],
  ]);
});

test("rowsToObjects maps header to values", () => {
  const objs = rowsToObjects(parseCSV(`${HEADER}\n${row("deepseek-v4-pro", "output_tokens", 10)}`));
  assert.equal(objs.length, 1);
  assert.equal(objs[0].model, "deepseek-v4-pro");
  assert.equal(objs[0].amount, "10");
});

test("mapAmountObjects groups long rows by day/model/key and maps token types", () => {
  const records = importAmountCSVs([
    [
      HEADER,
      row("deepseek-v4-pro", "input_cache_miss_tokens", 100),
      row("deepseek-v4-pro", "input_cache_hit_tokens", 40),
      row("deepseek-v4-pro", "output_tokens", 25),
      row("deepseek-v4-pro", "request_count", 3),
    ].join("\n"),
  ]);
  assert.equal(records.length, 1);
  const r = records[0];
  assert.equal(r.source, "deepseek-official");
  assert.equal(r.input, 100);
  assert.equal(r.cacheRead, 40);
  assert.equal(r.output, 25);
  assert.equal(r.reasoning, 0);
  assert.equal(r.requests, 3);
  assert.equal(r.cacheWrite5m, 0);
  assert.equal(r.workspaceID, "u1");
  assert.equal(r.keyID, "key-a");
  assert.match(r.id, /^deepseek-official:[0-9a-f]{8}$/);
});

test("the day is stored as UTC midnight regardless of the source offset", () => {
  const r = importAmountCSVs([`${HEADER}\n${row("m", "output_tokens", 1)}`])[0];
  assert.equal(r.time, "2026-06-16T00:00:00.000Z");
  assert.equal(r.date, "2026-06-16");
});

test("UTC and local export variants map to the same record (idempotent)", () => {
  const local = `${HEADER}\n${row("m", "output_tokens", 1)}`; // start_time_iso +08:00
  const utcHeader = "user_id,utc_date,start_time_iso,end_time_iso,model,api_key_name,api_key,type,price,amount";
  const utc = `${utcHeader}\nu1,20260616,2026-06-16T00:00:00+00:00,2026-06-17T00:00:00+00:00,m,key-a,sk,output_tokens,0.000001,1`;
  const a = importAmountCSVs([local])[0];
  const b = importAmountCSVs([utc])[0];
  assert.equal(a.id, b.id);
  assert.equal(a.time, b.time);
  assert.equal(a.time, "2026-06-16T00:00:00.000Z");
});

test("api_key credential is dropped from raw", () => {
  const r = importAmountCSVs([`${HEADER}\n${row("m", "output_tokens", 1)}`])[0];
  assert.equal(r.raw[0].api_key, undefined);
  assert.equal(r.raw[0].api_key_name, "key-a");
});

test("separate api_key_name / model / day produce separate records (stable ids)", () => {
  const csv = [
    HEADER,
    row("m1", "output_tokens", 1, "k1"),
    row("m1", "output_tokens", 1, "k2"),
    row("m2", "output_tokens", 1, "k1"),
  ].join("\n");
  const a = importAmountCSVs([csv]);
  const b = importAmountCSVs([csv]);
  assert.equal(a.length, 3);
  assert.deepEqual(a.map((r) => r.id), b.map((r) => r.id));
});

test("reconciliation: grouped totals match the page (June sample)", () => {
  // pro: 88,917,597 tokens / 834 req; flash: 1,493,441 / 64.
  const pro = [HEADER];
  pro.push(row("deepseek-v4-pro", "input_cache_miss_tokens", 80000000));
  pro.push(row("deepseek-v4-pro", "input_cache_hit_tokens", 8000000));
  pro.push(row("deepseek-v4-pro", "output_tokens", 917597));
  pro.push(row("deepseek-v4-pro", "request_count", 834));
  const flash = [HEADER];
  flash.push(row("deepseek-chat", "input_cache_miss_tokens", 1400000));
  flash.push(row("deepseek-chat", "output_tokens", 93441));
  flash.push(row("deepseek-chat", "request_count", 64));
  const records = importAmountCSVs([pro.join("\n"), flash.join("\n")]);
  const totalTokens = (r) => r.input + r.output + r.reasoning + r.cacheRead + r.cacheWrite5m + r.cacheWrite1h;
  const proRec = records.find((r) => r.model === "deepseek-v4-pro");
  const flashRec = records.find((r) => r.model === "deepseek-chat");
  assert.equal(totalTokens(proRec), 88917597);
  assert.equal(proRec.requests, 834);
  assert.equal(totalTokens(flashRec), 1493441);
  assert.equal(flashRec.requests, 64);
});

test("mapAmountObjects ignores rows without model or start_time_iso", () => {
  const records = mapAmountObjects([{ model: "", start_time_iso: "2026-06-16T00:00:00+08:00" }, { model: "m" }]);
  assert.equal(records.length, 0);
});

test("missing user_id falls back to a DeepSeek workspace", () => {
  const csv = `start_time_iso,model,api_key_name,api_key,type,amount\n2026-06-16T00:00:00+08:00,m,key-a,sk,output_tokens,5`;
  const r = importAmountCSVs([csv])[0];
  assert.equal(r.workspaceID, "DeepSeek");
});
