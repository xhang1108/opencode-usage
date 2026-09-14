#!/usr/bin/env node
// tools/build-unified-preset.mjs — seed the shipped unified pricelist
// (extension/shared/unified.preset.json) from the author-maintained fallback
// presets. Merges the same underlying model across vendors into one group so it
// shares a single rate table (free variants fold into their paid sibling).
//
// This is a starting point authors can hand-edit; re-running overwrites it.
// Usage: node tools/build-unified-preset.mjs
//
// Rate source per canonical model: the vendor that owns it
// (deepseek-* -> deepseek-official, mimo-* -> mimo, otherwise opencode).

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const SOURCES = ["opencode", "deepseek-official", "mimo"];
const PRESETS = {};
for (const source of SOURCES) {
  PRESETS[source] = JSON.parse(readFileSync(resolve(root, `extension/vendors/${source}/rates.preset.json`), "utf8"));
}

const slug = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9.+-]+/g, "-")
    .replace(/^-+|-+$/g, "");

// Explicit cross-vendor folds (vendor-specific resale / display names).
const ALIAS = {
  "opencode:deepseek-v4-flash": "deepseek-v4-flash",
  "opencode:deepseek-v4-flash-free": "deepseek-v4-flash",
  "opencode:deepseek-v4-flash-vision-exp": "deepseek-v4-flash",
  "opencode:deepseek-v4.1-flash": "deepseek-v4-flash",
  "opencode:deepseek-v4.1-flash-free": "deepseek-v4-flash",
  "opencode:deepseek-v4-pro": "deepseek-v4-pro",
  "opencode:mimo-v2.5": "mimo-v2.5",
  "opencode:mimo-v2.5-free": "mimo-v2.5",
  "opencode:mimo-v2.5-pro": "mimo-v2.5-pro",
  "mimo:MiMo-V2.5": "mimo-v2.5",
  "mimo:MiMo-V2.5-Pro": "mimo-v2.5-pro",
  "mimo:MiMo-V2.5 Pro": "mimo-v2.5-pro",
  "deepseek-official:deepseek-flash": "deepseek-v4-flash",
  "deepseek-official:deepseek-v4.1-flash": "deepseek-v4-flash",
  "deepseek-official:deepseek-v4-flash-free": "deepseek-v4-flash",
  "deepseek-official:deepseek-v4.1-flash-free": "deepseek-v4-flash",
  "deepseek-official:deepseek-v4-flash-vision-exp": "deepseek-v4-flash",
  "deepseek-official:deepseek-v4-flash-0731": "deepseek-v4-flash",
  "deepseek-official:deepseek-v4.1-flash-expires-on-0910": "deepseek-v4-flash",
  "deepseek-official:deepseek-v4-pro-free": "deepseek-v4-pro",
  "deepseek-official:deepseek-chat & deepseek-reasoner": "deepseek-chat",
  // Deprecated id; folds into chat so the id can disappear from the list.
  "deepseek-official:deepseek-coder": "deepseek-chat",
  "opencode:muse-spark-1.2-contributor": "muse-spark-contributor",
  "opencode:muse-spark-1.2-contributor-free": "muse-spark-contributor",
  "opencode:muse-spark-1.3-contributor": "muse-spark-contributor",
  "opencode:muse-spark-1.3-contributor-free": "muse-spark-contributor",
};

// Unannounced / not-yet-published models: leave unpriced (no group) instead of
// shipping a fallback number that isn't real. Zero-rate models are dropped too.
const UNPRICED = new Set(["omen-alpha"]);

const allZero = (o) => {
  if (o == null) return true;
  if (typeof o === "number") return o === 0;
  if (typeof o !== "object") return true;
  return Object.values(o).every(allZero);
};
const isZeroRates = (rates) => !Array.isArray(rates) || rates.length === 0 || rates.every((r) => allZero(r && r.pricing));

const opencodeKeys = new Set(Object.keys(PRESETS.opencode.modelMap || {}));

// Raw models that no fallback preset ships but that we know belong to a group.
// These are added as assignments only when the canonical group has rates, so a
// miss leaves the model unassigned (editable in the UI) instead of dangling.
// Only ids we actually know: the CommandCode ones seen in the repo/user data and
// the OpenRouter "owner/slug" convention the user asked for. No invented ids.
const EXTRA_KEYS = [
  "openrouter:stealth/ox-alpha", // OpenRouter stealth deployment of GLM 5.3 Flash
  "commandcode:deepseek/deepseek-v4.1-flash", // CommandCode routing id
  "commandcode:tencent/hy3-paid", // CommandCode routing id for Tencent hy3
  "openrouter:openai/gpt-5-nano",
  "openrouter:openai/gpt-oss-20b",
  ...["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.1-pro-preview", "gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash", "gemini-2.0-flash-lite"].map((m) => `openrouter:google/${m}`),
];

// Stealth/anonymous deployments that are really a known model underneath.
function foldAlias(rawLower) {
  if (rawLower.includes("ox-alpha") || rawLower.includes("x-preview")) return "glm-5.3-flash";
  // CommandCode names the Tencent model "tencent hy3 paid"; fold on the model.
  if (rawLower.includes("hy3")) return "hy3";
  return null;
}

// Bare-slug folds (after dropping a provider prefix), so e.g. CommandCode's
// "deepseek/deepseek-v4.1-flash" lands on the same group as the vendors.
const SLUG_ALIAS = {
  "deepseek-v4.1-flash": "deepseek-v4-flash",
  "deepseek-v4-flash-vision-exp": "deepseek-v4-flash",
  "deepseek-flash": "deepseek-v4-flash",
  "deepseek-v4-flash-0731": "deepseek-v4-flash",
  "deepseek-v4.1-flash-expires-on-0910": "deepseek-v4-flash",
  "deepseek-v4-pro-free": "deepseek-v4-pro",
  "mimo-v2.5-free": "mimo-v2.5",
};

function canonical(key) {
  if (ALIAS[key]) return ALIAS[key];
  const colon = key.indexOf(":");
  const source = key.slice(0, colon);
  let raw = key.slice(colon + 1);
  const folded = foldAlias(raw.toLowerCase());
  if (folded) return folded;
  // Provider-prefixed models (e.g. "deepseek/deepseek-v4.1-flash"): keep the
  // model part, drop the routing prefix.
  if (raw.includes("/")) raw = raw.slice(raw.lastIndexOf("/") + 1);
  // A "-free" variant bills at its base model's price, so fold it always.
  if (/-free$/.test(raw)) raw = raw.replace(/-free$/, "");
  const s = slug(raw);
  return SLUG_ALIAS[s] || s;
}

// Official list prices for models the fallback tables ship as 0 (free-trial
// models) or don't carry at all. Single flat entry, USD per 1M tokens.
const OVERRIDE_RATES = {
  // Poolside Laguna-S-2.1 official API.
  "laguna-s-2.1": [{ from: null, pricing: { flat: { input: 0.09, output: 0.18, cacheRead: 0.009, cacheWrite: 0 } } }],
  // NVIDIA Nemotron-3-Ultra official API (OpenRouter is 0.50/2.20).
  "nemotron-3-ultra": [{ from: null, pricing: { flat: { input: 0.63, output: 3.13, cacheRead: 0.1, cacheWrite: 0 } } }],
  // OpenAI GPT-5 nano (platform.openai.com/docs/pricing).
  "gpt-5-nano": [{ from: null, pricing: { flat: { input: 0.05, output: 0.4, cacheRead: 0.005, cacheWrite: 0 } } }],
  // GPT-OSS 20B (user-supplied; no first-party OpenAI list price).
  "gpt-oss-20b": [{ from: null, pricing: { flat: { input: 0.02, output: 0.1, cacheRead: 0, cacheWrite: 0 } } }],
  // Google Gemini Standard tier (Vertex / Gemini API). Flash models carry the
  // promo price through 2026-12-31, then the list price.
  "gemini-3.8-flash": geminiFlash(0.75, 3.75),
  "gemini-3.7-flash": geminiFlash(0.75, 3.75),
  "gemini-3.6-flash": geminiFlash(0.75, 3.75),
  "gemini-3.5-flash": [{ from: null, pricing: { flat: { input: 1.5, output: 9, cacheRead: 0.15, cacheWrite: 0 } } }],
  "gemini-3.5-flash-lite": [{ from: null, pricing: { flat: { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0 } } }],
  "gemini-3.1-flash-lite": [{ from: null, pricing: { flat: { input: 0.25, output: 1.5, cacheRead: 0.025, cacheWrite: 0 } } }],
  "gemini-3.1-pro-preview": [
    { from: null, pricing: { flat: { tier: { limit: 200000, low: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 }, high: { input: 4, output: 18, cacheRead: 0.4, cacheWrite: 0 } } } } },
  ],
  "gemini-2.5-pro": [
    { from: null, pricing: { flat: { tier: { limit: 200000, low: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 }, high: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 } } } } },
  ],
  "gemini-2.5-flash": [{ from: null, pricing: { flat: { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0 } } }],
  "gemini-2.5-flash-lite": [{ from: null, pricing: { flat: { input: 0.1, output: 0.4, cacheRead: 0.01, cacheWrite: 0 } } }],
  "gemini-2.0-flash": [{ from: null, pricing: { flat: { input: 0.15, output: 0.6, cacheRead: 0, cacheWrite: 0 } } }],
  "gemini-2.0-flash-lite": [{ from: null, pricing: { flat: { input: 0.075, output: 0.3, cacheRead: 0, cacheWrite: 0 } } }],
};

// Gemini Flash: promo in/out until 2027-01-01, then the regular list price
// (cached input is always 10% of input).
function geminiFlash(promoIn, promoOut) {
  return [
    { from: null, pricing: { flat: { input: promoIn, output: promoOut, cacheRead: promoIn / 10, cacheWrite: 0 } } },
    { from: "2027-01-01T00:00:00Z", pricing: { flat: { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 0 } } },
  ];
}

function preferredSource(canon) {
  if (canon.startsWith("deepseek")) return "deepseek-official";
  if (canon.startsWith("mimo")) return "mimo";
  return "opencode";
}

// Higher rank wins when two vendors provide the same canonical model.
function rank(canon, source) {
  if (source === preferredSource(canon)) return 2;
  return source === "opencode" ? 1 : 0;
}

const assign = {};
const ratesByCanon = {};
const sourceByCanon = {};

for (const source of SOURCES) {
  const preset = PRESETS[source];
  for (const [key, targetId] of Object.entries(preset.modelMap || {})) {
    const canon = canonical(key);
    assign[key] = canon;
    const target = preset.targets[targetId];
    if (!target || !Array.isArray(target.rates) || target.rates.length === 0) continue;
    if (ratesByCanon[canon] && rank(canon, source) <= rank(canon, sourceByCanon[canon])) continue;
    ratesByCanon[canon] = target.rates;
    sourceByCanon[canon] = source;
  }
}

// Official prices for models the fallback tables list as free trials.
for (const [canon, rates] of Object.entries(OVERRIDE_RATES)) ratesByCanon[canon] = rates;

// Known extras that no preset ships.
for (const key of EXTRA_KEYS) assign[key] = canonical(key);

// Only ship groups that carry a real price; zero/unannounced models stay
// unpriced (their keys are dropped from assign, so the UI shows them in
// Unassigned).
const priced = Object.keys(ratesByCanon).filter((id) => !UNPRICED.has(id) && !isZeroRates(ratesByCanon[id]));
const groups = priced.sort().map((id) => ({ id, rates: ratesByCanon[id] }));

// Never emit a dangling assignment (validateUnifiedPricing rejects those).
const finalAssign = {};
for (const [key, groupId] of Object.entries(assign)) {
  if (priced.includes(groupId)) finalAssign[key] = groupId;
}

const preset = { enabled: false, groups, assign: finalAssign };
writeFileSync(resolve(root, "extension/shared/unified.preset.json"), JSON.stringify(preset, null, 2) + "\n");
console.log(`wrote extension/shared/unified.preset.json`);
console.log(`groups=${groups.length} assign=${Object.keys(finalAssign).length}`);
