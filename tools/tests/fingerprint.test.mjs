import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { parse } from "../../extension/shared/model-fingerprint.js";
import { normalizeUnifiedPricing, validateUnifiedPricing, buildUnifiedIndex, priceUnified } from "../../extension/shared/unified.js";

// Golden fingerprints: fix the shape so a parser change that silently re-buckets
// a model is caught here before it can change a price.
const GOLDEN = {
  // CommandCode routing ids must land on the vendors' groups.
  "commandcode:tencent/hy3-paid": "hy:3:base:",
  "commandcode:deepseek/deepseek-v4.1-flash": "deepseek:4.1:flash:",
  // Variants never collapse into each other.
  "openrouter:google/gemini-3.5-flash": "gemini:3.5:flash:",
  "openrouter:google/gemini-3.5-pro": "gemini:3.5:pro:",
  "openrouter:openai/gpt-5": "gpt:5:base:",
  "openrouter:openai/gpt-5-pro": "gpt:5:pro:",
  // Date stamps and billing markers are stripped.
  "openrouter:openai/gpt-5-nano": "gpt:5:base:nano",
  "openrouter:openai/gpt-5-nano-2025-08-07": "gpt:5:base:nano",
  "deepseek-official:deepseek-v4-flash-free": "deepseek:4:flash:",
  "opencode:hy3-free": "hy:3:base:",
  // Spacing / hyphenation variants of the same id normalise together.
  "opencode:qwen3.6-plus": "qwen:3.6:plus:",
  "opencode:qwen-3.6-plus": "qwen:3.6:plus:",
  "mimo:MiMo-V2.5 Pro": "mimo:2.5:pro:",
  "mimo:MiMo-V2.5-Pro": "mimo:2.5:pro:",
};

test("parse produces the golden fingerprint for known ids", () => {
  for (const [id, expected] of Object.entries(GOLDEN)) {
    assert.equal(parse(id).fingerprint, expected, id);
  }
});

test("parse is idempotent under source / routing prefixes", () => {
  const bare = parse("gemini-3.5-flash").fingerprint;
  assert.equal(parse("opencode:gemini-3.5-flash").fingerprint, bare);
  assert.equal(parse("openrouter:google/gemini-3.5-flash").fingerprint, bare);
  assert.equal(parse("commandcode:google/gemini-3.5-flash").fingerprint, bare);
});

test("parse keeps distinct variants distinct", () => {
  assert.notEqual(parse("gemini-3.5-flash").fingerprint, parse("gemini-3.5-pro").fingerprint);
  assert.notEqual(parse("gpt-5").fingerprint, parse("gpt-5-pro").fingerprint);
  assert.notEqual(parse("deepseek-v4-flash").fingerprint, parse("deepseek-v4-pro").fingerprint);
});

test("parse never throws and always yields a non-empty fingerprint", () => {
  for (const id of ["", ":", "unknown-model-xyz", "v1", "weird//name", "x".repeat(200)]) {
    const f = parse(id);
    assert.equal(typeof f.fingerprint, "string");
    assert.ok(f.fingerprint.length > 0, id);
  }
});

test("shipped preset: valid, no dangling assign, every known id reachable", () => {
  const preset = JSON.parse(fs.readFileSync(new URL("../../extension/shared/unified.preset.json", import.meta.url)));
  assert.deepEqual(validateUnifiedPricing(preset), []);

  const index = buildUnifiedIndex(normalizeUnifiedPricing(preset));
  // Every fallback-preset model id is either priced or deliberately unpriced,
  // and none of them point at a missing group.
  for (const source of ["opencode", "deepseek-official", "mimo"]) {
    const p = JSON.parse(fs.readFileSync(new URL(`../../extension/vendors/${source}/rates.preset.json`, import.meta.url)));
    for (const key of Object.keys(p.modelMap || {})) {
      const groupId = preset.assign[key];
      if (groupId == null) continue; // unpriced on purpose
      assert.ok(preset.groups.some((g) => g.id === groupId), `${key} -> missing group ${groupId}`);
    }
  }
  assert.ok(index.size > 0);
});

test("priceUnified falls back to the fingerprint for unseen spellings", () => {
  const preset = JSON.parse(fs.readFileSync(new URL("../../extension/shared/unified.preset.json", import.meta.url)));
  const index = buildUnifiedIndex(normalizeUnifiedPricing(preset));
  const rec = { input: 1000000, output: 0, cacheRead: 0, cacheWrite: 0, time: "2026-09-15T12:00:00Z" };

  // Never enumerated in the preset, but structurally known.
  const hy = priceUnified({ ...rec, source: "commandcode", model: "tencent/hy3-paid" }, index);
  assert.equal(hy.unpriced, false);
  assert.equal(hy.priceBasis, "unified");
  assert.ok(hy.targetId.startsWith("fp:"));

  // A genuinely unknown model stays unpriced (Fail-Closed).
  const unknown = priceUnified({ ...rec, source: "someone", model: "mystery-9" }, index);
  assert.equal(unknown.unpriced, true);
  assert.equal(unknown.cost, 0);
});
