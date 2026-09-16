import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeRecord } from "../../extension/shared/canonical.js";
import {
  SETTINGS_FORMAT,
  buildSettingsPayload,
  parseSettingsPayload,
  recordsToCSV,
  csvToRecords,
  groupBySource,
} from "../../extension/shared/backup.js";

const SAMPLE = {
  id: "openrouter:abc",
  source: "openrouter",
  time: "2026-07-08T00:00:00.000Z",
  model: "gpt-4o",
  provider: "openai",
  workspaceID: "ws1",
  keyID: "k1",
  sessionID: "s1",
  input: 100,
  output: 50,
  reasoning: 20,
  cacheRead: 30,
  cacheWrite5m: 5,
  cacheWrite1h: 0,
  requests: 7,
  vendorCost: 1.25,
  costScale: 1,
  cacheBasis: "vendor",
  raw: { model: "gpt-4o", nested: { a: 1 }, list: [1, 2, 3] },
};

test("buildSettingsPayload keeps only user-authored keys", () => {
  const payload = buildSettingsPayload(
    {
      vendorSettings: { opencode: true },
      unifiedPricing: { groups: [] },
      unmappedFirstSeen: { "opencode:m": 1 },
      pricing: { junk: 1 },
      registry: { vendors: [] },
    },
    { now: () => new Date("2026-07-08T00:00:00.000Z") }
  );
  assert.equal(payload.format, SETTINGS_FORMAT);
  assert.equal(payload.version, 1);
  assert.equal(payload.exportedAt, "2026-07-08T00:00:00.000Z");
  assert.deepEqual(Object.keys(payload.settings).sort(), ["unifiedPricing", "unmappedFirstSeen", "vendorSettings"]);
});

test("parseSettingsPayload returns the settings patch and rejects other formats", () => {
  const patch = parseSettingsPayload({
    format: SETTINGS_FORMAT,
    settings: { defaultCrawl: "deepseek-official", ignored: 1 },
  });
  assert.deepEqual(patch, { defaultCrawl: "deepseek-official" });
  assert.throws(() => parseSettingsPayload({ format: "opencode-usage-full" }), /settings file/);
});

test("records CSV round-trips a record losslessly (numbers, flags, nested raw)", () => {
  const norm = normalizeRecord(SAMPLE, { source: "openrouter" });
  const back = csvToRecords(recordsToCSV([norm]));
  assert.equal(back.length, 1);
  assert.deepEqual(back[0], norm);
});

test("records CSV keeps the opencode reasoning flag and drops empty fields", () => {
  const norm = normalizeRecord(
    { id: "opencode:x", source: "opencode", time: "2026-07-08T01:00:00.000Z", model: "m", input: 10, output: 4, reasoning: 2, outputExcludesReasoning: true },
    { source: "opencode" }
  );
  const back = csvToRecords(recordsToCSV([norm]))[0];
  assert.equal(back.outputExcludesReasoning, true);
  assert.equal(back.provider, undefined);
});

test("csvToRecords skips rows without a model or without tokens", () => {
  const csv = [
    "id,source,model,time,input,output",
    '"opencode:a","opencode","","2026-07-08T00:00:00.000Z",1,1',
    '"opencode:b","opencode","m","2026-07-08T00:00:00.000Z",0,0',
  ].join("\n");
  assert.equal(csvToRecords(csv).length, 0);
});

test("a full export -> import -> export round-trip is stable and idempotent", () => {
  const recs = [
    normalizeRecord(SAMPLE, { source: "openrouter" }),
    normalizeRecord(
      { id: "opencode:crawl1", source: "opencode", time: "2026-07-08T00:00:00.000Z", model: "m", input: 10, output: 4, reasoning: 2, outputExcludesReasoning: true, workspaceID: "wrk_1" },
      { source: "opencode" }
    ),
    normalizeRecord(
      { id: "opencode:msg_1", source: "opencode", time: "2026-07-08T01:00:00.000Z", model: "m2", input: 5, output: 1, workspaceID: "Local" },
      { source: "opencode" }
    ),
  ];
  const csv = recordsToCSV(recs);
  const imported = csvToRecords(csv);
  assert.equal(imported.length, recs.length);
  // Re-exporting what we imported must reproduce the same file (no drift, no
  // duplication) - the property a backup/restore cycle relies on.
  assert.equal(recordsToCSV(imported), csv);
});

test("groupBySource separates opencode from vendors", () => {
  const a = normalizeRecord(SAMPLE, { source: "openrouter" });
  const b = normalizeRecord({ ...SAMPLE, id: "opencode:z", source: "opencode" }, { source: "opencode" });
  const groups = groupBySource([a, b]);
  assert.deepEqual([...groups.keys()].sort(), ["opencode", "openrouter"]);
  assert.equal(groups.get("opencode").length, 1);
  assert.equal(groups.get("openrouter").length, 1);
});
