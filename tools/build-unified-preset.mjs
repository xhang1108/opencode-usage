#!/usr/bin/env node
// tools/build-unified-preset.mjs — seed the shipped unified pricelist
// (extension/shared/unified.preset.json) from the author-maintained fallback
// presets.
//
// Grouping is fully automatic. Every model id is reduced to a structural
// fingerprint (extension/shared/model-fingerprint.js); each preset mapping
// fp(raw id) ~ fp(canonical target) is a declared equivalence, and the
// connected components become the groups. This inherits every fold the vendored
// data already records ("deepseek-flash" -> "deepseek-v4-flash",
// "deepseek-v4-flash-vision-exp" -> "deepseek-v4-flash") with NO hand-written
// alias table, and still unifies across vendors because the fingerprint is
// vendor-independent. A model the parser cannot map to any known price stays
// unpriced (Fail-Closed), never misfiled.
//
// Usage: node tools/build-unified-preset.mjs
//
// Rate sources: official vendor tables only. opencode (go.mdx) is read for
// STRUCTURE — id equivalences, group unions, assign keys — but never as a price
// authority (go.mdx resale prices are not a source anymore). OVERRIDE_RATES win
// over any vendor table; they are official list prices transcribed by hand for
// models no daily parser covers (Gemini, legacy GPT, …).

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parse } from "../extension/shared/model-fingerprint.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const SOURCES = [
  "opencode", // structure only — its rates never become candidates
  "deepseek-official",
  "mimo",
  "xai-official",
  "openai-official",
  "qwen-official",
  "tencent-official",
];
const FINGERPRINT_PREFIX = "fp:";

const PRESETS = {};
for (const source of SOURCES) {
  PRESETS[source] = JSON.parse(readFileSync(resolve(root, `extension/vendors/${source}/rates.preset.json`), "utf8"));
}

const allZero = (o) => {
  if (o == null) return true;
  if (typeof o === "number") return o === 0;
  if (typeof o !== "object") return true;
  return Object.values(o).every(allZero);
};
const isZeroRates = (rates) => !Array.isArray(rates) || rates.length === 0 || rates.every((r) => allZero(r && r.pricing));

// Does any rate row carry a non-zero cacheWrite? Used to drop a duplicate
// no-cache row when the same model is listed twice.
const hasCacheWrite = (rates) => {
  const scan = (o) => {
    if (!o || typeof o !== "object") return false;
    if (typeof o.cacheWrite === "number") return o.cacheWrite > 0;
    return Object.values(o).some(scan);
  };
  return Array.isArray(rates) && rates.some((r) => scan(r && r.pricing));
};

// Semantic equality for two rate tables: ISO timestamps are normalized so
// "…:46.000Z" and "…:46Z" compare equal (same instant, different spelling).
const rateSignature = (rates) => JSON.stringify(rates).replace(/(\d{2}:\d{2}:\d{2})\.000Z/g, "$1Z");

// A readable group id derived from a fingerprint; collisions get a numeric
// suffix so two genuinely different fingerprints never share an id.
const usedIds = new Set();
const groupIdByFp = new Map();
function groupIdFor(fp) {
  if (groupIdByFp.has(fp)) return groupIdByFp.get(fp);
  const [series, version, variant, model] = String(fp).split(":");
  const parts = [series || "unknown"];
  if (version && version !== "0") parts.push(version);
  if (variant && variant !== "base") parts.push(variant);
  if (model) parts.push(model);
  const base = parts.join("-");
  let id = base || "group";
  let n = 2;
  while (usedIds.has(id)) id = `${base}-${n++}`;
  usedIds.add(id);
  groupIdByFp.set(fp, id);
  return id;
}

// Rate source preference: a zero-rate table (free trial) never wins over a real
// one; the owning official vendor wins; authored overrides beat everyone.
const PREFERRED_BY_SERIES = {
  deepseek: "deepseek-official",
  mimo: "mimo",
  grok: "xai-official",
  gpt: "openai-official",
  qwen: "qwen-official",
  hy: "tencent-official",
};
function preferredSource(fp) {
  return PREFERRED_BY_SERIES[String(fp).split(":")[0]] || null;
}
function rank(fp, source, rates) {
  // An override is authoritative even when it says "free": 0/0/0/0 is a
  // published PRICE, not an absent one, so it has to win before the all-zero
  // veto. Every other source still treats all-zero as "no price", which is what
  // keeps free-trial placeholder tables out of the groups.
  if (source === "override") return 3;
  if (isZeroRates(rates)) return -1;
  if (source === preferredSource(fp)) return 2;
  return 0;
}

// Official list prices for models the fallback tables ship as 0 (free-trial
// models) or don't carry at all. Single flat entry, USD per 1M tokens. These are
// PRICES, not classifications — the group id is still derived automatically.
const OVERRIDE_RATES = {
  // Poolside Laguna-S-2.1 — official list price from Poolside's own launch
  // post (https://poolside.ai/blog/introducing-laguna-s-2-1): $0.10 / $0.20 /
  // $0.01 per 1M. Deliberately NOT the OpenRouter 10%-off promo
  // ($0.09 / $0.18 / $0.009), which is a gateway discount, not a list price.
  "laguna-s-2.1": [{ from: null, pricing: { flat: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0 } } }],
  // PROVISIONAL — NVIDIA still publishes no per-token price (NIM FAQ: "There is
  // no per-token price": build.nvidia.com is free-tier prototyping, and
  // production needs NVIDIA AI Enterprise), so there is no first-party USD row
  // to transcribe yet. Until NVIDIA quotes one, this carries the best available
  // hosted rate: input/output from Venice AI ($0.63 / $3.13,
  // https://venice.ai/models/nvidia-nemotron-3-ultra-550b-a55b) and cacheRead
  // from OpenRouter ($0.10). REPLACE with the official row the moment NVIDIA
  // publishes a per-token price.
  // opencode:nemotron-3-ultra-free folds into this same group, so the free
  // listing is billed at exactly these rates instead of showing as unpriced.
  // (An earlier comment claimed "official API / OpenRouter is 0.50/2.20" — both
  // were wrong: NVIDIA has no per-token price, and 0.50/2.20 is DeepInfra.)
  "nemotron-3-ultra": [{ from: null, pricing: { flat: { input: 0.63, output: 3.13, cacheRead: 0.1, cacheWrite: 0 } } }],
  // opencode Zen's Big Pickle is officially FREE: models.dev carries
  // [cost] input = 0.0 / output = 0.0 for it and Zen's own table prints "Free"
  // under input, output and cache. opencode contributes structure only (see the
  // source !== "opencode" filter below), so without this entry the model has no
  // price at all and renders as unknown rather than free. This is the one place
  // a deliberately all-zero table is used as a price.
  "big-pickle": [{ from: null, pricing: { flat: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } }],
  // GPT-OSS 20B (user-supplied; no first-party OpenAI list price - gpt-oss
  // ships as open weights on Apache 2.0 and OpenAI never published a hosted
  // API rate for it; the 0.02/0.1 pair is a community/self-host estimate).
  "gpt-oss-20b": [{ from: null, pricing: { flat: { input: 0.02, output: 0.1, cacheRead: 0, cacheWrite: 0 } } }],
  // Retired OpenAI models that pricing.md no longer lists, but whose LIVE
  // first-party model pages still publish their price (verified 2026-09-24):
  //   gpt-4       $30.00 / $60.00  https://developers.openai.com/api/docs/models/gpt-4
  //   o1-preview  $15 / $7.5 cached / $60  https://developers.openai.com/api/docs/models/o1-preview
  //   o1-mini     $1.1 / $0.55 cached / $4.4  https://developers.openai.com/api/docs/models/o1-mini
  // o1-mini was previously transcribed 3/12/1.5 (its 2024-09 launch rate);
  // OpenAI has since repriced it to sit alongside o3-mini, and its own page
  // says o3-mini is "the same latency and price as o1-mini".
  // Everything else in the GPT and o-series has a first-party row in
  // developers.openai.com/api/docs/pricing.md and is deliberately NOT
  // overridden here: the daily parser owns those rows, so the price tracks the
  // vendor automatically instead of being frozen at a hand transcription.
  "gpt-4": [{ from: null, pricing: { flat: { input: 30, output: 60, cacheRead: 0, cacheWrite: 0 } } }],
  "o1-preview": [{ from: null, pricing: { flat: { input: 15, output: 60, cacheRead: 7.5, cacheWrite: 0 } } }],
  "o1-mini": [{ from: null, pricing: { flat: { input: 1.1, output: 4.4, cacheRead: 0.55, cacheWrite: 0 } } }],
  // gpt-4o keeps its two-window history (5/15 before the 2024-08-06 cut to
  // 2.50/10); the live window matches the parser exactly. The first window's
  // cacheRead 2.50 is the rate OpenAI charged then - pricing.md prints "-" for
  // that retired snapshot row rather than 0.
  "gpt-4o": [
    { from: null, pricing: { flat: { input: 5, output: 15, cacheRead: 2.5, cacheWrite: 0 } } },
    { from: "2024-08-06T00:00:00Z", pricing: { flat: { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 0 } } },
  ],
  // Google Gemini Developer API, Standard tier —
  // https://ai.google.dev/gemini-api/docs/pricing . Every row below was
  // verified against that page on 2026-09-24 (the Flash promo, the 2.5 Pro
  // 200k tier, the 3.1 Pro tier and all the Flash-Lite rates match).
  // Flash models carry the promo price through 2026-12-31, then the list
  // price. No gemini-* row is covered by a daily parser, so these stay
  // hand-transcribed until one is added.
  "gemini-3.8-flash": geminiFlash(0.75, 3.75),
  "gemini-3.7-flash": geminiFlash(0.75, 3.75),
  "gemini-3.6-flash": geminiFlash(0.75, 3.75),
  "gemini-3.5-flash": [{ from: null, pricing: { flat: { input: 1.5, output: 9, cacheRead: 0.15, cacheWrite: 0 } } }],
  "gemini-3.5-flash-lite": [{ from: null, pricing: { flat: { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0 } } }],
  "gemini-3.1-flash-lite": [{ from: null, pricing: { flat: { input: 0.25, output: 1.5, cacheRead: 0.025, cacheWrite: 0 } } }],
  "gemini-3.1-pro-preview": geminiPro(),
  "gemini-2.5-pro": [
    { from: null, pricing: { flat: { tier: { limit: 200000, low: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 }, high: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 } } } } },
  ],
  "gemini-2.5-flash": [{ from: null, pricing: { flat: { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0 } } }],
  "gemini-2.5-flash-lite": [{ from: null, pricing: { flat: { input: 0.1, output: 0.4, cacheRead: 0.01, cacheWrite: 0 } } }],
  // Gemini 2.0 was shut down (deprecation notices 2026-02-18 / 2026-03-31),
  // so ai.google.dev/gemini-api/docs/pricing no longer shows it. Rates below
  // come from the official page's own Wayback snapshot, captured 2025-08-30
  // (page footer "Last updated 2025-08-26 UTC"):
  //   https://web.archive.org/web/20250830180341/https://ai.google.dev/gemini-api/docs/pricing
  //     Gemini 2.0 Flash       Input $0.10 (text/image/video) / Output $0.40
  //                            Context caching $0.025 per 1M tokens
  //     Gemini 2.0 Flash-Lite  Input $0.075 / Output $0.30
  //                            Context caching: Not available (= no cache rate)
  // gemini-2.0-flash was previously transcribed as 0.15/0.6, which matches no
  // Google row; 0.10/0.40 is what the official page listed while it was live.
  // A "gemini-2.5-flash-8b" override used to sit here too. No such id has ever
  // appeared on the pricing page (checked current, 2025-08-30 and 2025-12-31
  // snapshots), it is absent from every vendor table we parse, and no model
  // fingerprint maps to it - its 0.075/0.3 pair was the >128k row belonging to
  // Gemini 1.5 Flash-8B, so it was deleted as a mis-transcription.
  "gemini-2.0-flash": [{ from: null, pricing: { flat: { input: 0.1, output: 0.4, cacheRead: 0.025, cacheWrite: 0 } } }],
  "gemini-2.0-flash-lite": [{ from: null, pricing: { flat: { input: 0.075, output: 0.3, cacheRead: 0, cacheWrite: 0 } } }],

  // --- The17 groups no daily parser covers: hand-transcribed OFFICIAL list ---
  // prices (USD per 1M tokens), one comment block per vendor with its URL.
  // GLM — z.ai official pricing (https://docs.z.ai/guides/overview/pricing).
  // Cache write stays 0 (official storage promo is free); glm-5 is still on
  // sale, so no `until` (the old go.mdx retirement stamp is not reused).
  "glm-5": [{ from: null, pricing: { flat: { input: 1, output: 3.2, cacheRead: 0.2, cacheWrite: 0 } } }],
  "glm-5.1": [{ from: null, pricing: { flat: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 } } }],
  "glm-5.2": [{ from: null, pricing: { flat: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 } } }],
  "glm-5.3": [{ from: null, pricing: { flat: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 } } }],
  "glm-5.3-flash": [{ from: null, pricing: { flat: { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 } } }],

  // Kimi — Moonshot official pricing (https://platform.kimi.ai/docs/pricing/chat).
  // k2.6/k2.7/k3 are current list prices (K2 series lists no cache-write
  // column; k3 cacheWrite is the default TTL-5min rate, the 1h rate is 6 but
  // the schema has a single cacheWrite column). kimi-k2.5 was retired across
  // all platforms in 2026-08 (official changelog, calls 404), so its LAST
  // official price comes from the archived official pricing page
  // (https://web.archive.org/web/20260330194820/https://platform.moonshot.ai/docs/pricing/chat)
  // and carries `until` at end of the retirement month.
  "kimi-2.5-k": [{ from: null, pricing: { flat: { input: 0.6, output: 3, cacheRead: 0.1, cacheWrite: 0 } }, until: "2026-08-31T23:59:59.999Z" }],
  "kimi-2.6-k": [{ from: null, pricing: { flat: { input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0 } } }],
  "kimi-2.7-k-code": [{ from: null, pricing: { flat: { input: 0.95, output: 4, cacheRead: 0.19, cacheWrite: 0 } } }],
  "kimi-3-k": [{ from: null, pricing: { flat: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 } } }],
  // No official kimi-k3-7-24-2x SKU exists (the K3 table lists only
  // kimi-k3); priced as the underlying k3 model per author decision.
  "kimi-3-k-7-24-2x": [{ from: null, pricing: { flat: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 } } }],

  // MiniMax — official pay-as-you-go pricing
  // (https://platform.minimax.io/docs/guides/pricing-paygo). m3 is tiered by
  // context length (<=512k permanently half price); cache write is not listed
  // for m3, so 0.
  "minimax-2.5-m": [{ from: null, pricing: { flat: { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0.375 } } }],
  "minimax-2.7-m": [{ from: null, pricing: { flat: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.375 } } }],
  "minimax-3-m": [{ from: null, pricing: { flat: { tier: { limit: 512000, low: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 }, high: { input: 0.6, output: 2.4, cacheRead: 0.12, cacheWrite: 0 } } } } }],

  // Muse Spark — Meta AI official rates (https://dev.meta.ai/docs/pricing-rate-limits).
  // Spark standard price (the group previously carried the contributor price);
  // contributor is a cheaper tier of the same table.
  "muse-1.2-spark": [{ from: null, pricing: { flat: { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 } } }],
  "muse-1.2-spark-contributor": [{ from: null, pricing: { flat: { input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: 0 } } }],

  // LongCat-2.0 — official limited-time discount (current pay price; the
  // standard list 0.75/2.95/0.015 is not used, no discount end date is
  // published — re-verify when the promo ends).
  // (https://longcat.ai/platform/docs/pricing/longcat-2.0)
  "longcat-2.0": [{ from: null, pricing: { flat: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 } } }],

  // Omen Alpha — deprecated; last official price from the anomalyco repo
  // (https://github.com/anomalyco/models.dev/blob/dev/providers/opencode-go/models/omen-alpha.toml).
  // No official retirement date was published, so `until` keeps the previous
  // table's retirement stamp (metadata, not a price).
  "omen-alpha": [{ from: null, pricing: { flat: { input: 0.2, output: 0.66, cacheRead: 0.04, cacheWrite: 0 } }, until: "2026-09-10T04:22:43.000Z" }],
};

// Gemini Flash: promo in/out until 2027-01-01, then the regular list price
// (cached input is always 10% of input).
function geminiFlash(promoIn, promoOut) {
  return [
    { from: null, pricing: { flat: { input: promoIn, output: promoOut, cacheRead: promoIn / 10, cacheWrite: 0 } } },
    { from: "2027-01-01T00:00:00Z", pricing: { flat: { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 0 } } },
  ];
}

function geminiPro() {
  return [
    { from: null, pricing: { flat: { tier: { limit: 200000, low: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 }, high: { input: 4, output: 18, cacheRead: 0.4, cacheWrite: 0 } } } } },
  ];
}

// --- Authored exceptions (the ONLY manual table) -----------------------------
// Pure parsing cannot know these, so they are declared here, together, and
// audited in one place. Everything else is derived automatically.
//
// Stealth / anonymous deployments that are really a known model underneath:
const AUTHORED_FOLDS = {
  "openrouter:stealth/ox-alpha": "glm-5.3-flash",
  "opencode:ox-alpha-free": "glm-5.3-flash",
  "opencode:x-preview-f-free": "glm-5.3-flash",
  // Muse Spark contributor generations are one model (the 1.3 paid listing
  // supersedes 1.2; the parser would split them on the version). Carried over
  // from the pre-fingerprint ALIAS table.
  "opencode:muse-spark-1.2-contributor": "muse-spark-contributor",
  "opencode:muse-spark-1.2-contributor-free": "muse-spark-contributor",
  "opencode:muse-spark-1.3-contributor": "muse-spark-contributor",
  "opencode:muse-spark-1.3-contributor-free": "muse-spark-contributor",
};

// Models whose shipped fallback price must be suppressed regardless of what the
// vendor table carries (e.g. a withdrawn listing). Empty for now: Omen Alpha's
// price is GitHub-fetched (added 2026-09-04) so it is kept.
const AUTHORED_UNPRICED = new Set();

// --- Union-find over fingerprints --------------------------------------------
const parent = new Map();
function find(x) {
  if (!parent.has(x)) parent.set(x, x);
  let r = x;
  while (parent.get(r) !== r) r = parent.get(r);
  while (parent.get(x) !== r) {
    const next = parent.get(x);
    parent.set(x, r);
    x = next;
  }
  return r;
}
function union(a, b) {
  const ra = find(a);
  const rb = find(b);
  if (ra !== rb) parent.set(ra, rb);
}

// --- Pass 1: fingerprint every id, link raw ~ target, collect rate tables ----
const keyFp = new Map(); // "<source>:<model>" -> raw fingerprint
const targetCount = new Map(); // fingerprint -> how often it is a canonical target
const candidates = []; // { key, fp, rates, source }
const modelName = (key) => String(key).split(":").pop();

for (const source of SOURCES) {
  const preset = PRESETS[source];
  for (const [key, targetId] of Object.entries(preset.modelMap || {})) {
    const kf = parse(key).fingerprint;
    const tf = parse(targetId).fingerprint;
    keyFp.set(key, kf);
    targetCount.set(tf, (targetCount.get(tf) || 0) + 1);
    find(kf);
    find(tf);
    union(kf, tf);
    const target = (preset.targets || {})[targetId];
    const rates = target && Array.isArray(target.rates) && target.rates.length ? target.rates : null;
    // opencode (go.mdx) contributes structure only — its rates are never
    // candidates, so a group that only an opencode table prices becomes unpriced.
    if (rates && source !== "opencode" && !AUTHORED_UNPRICED.has(modelName(key))) candidates.push({ key, fp: kf, rates, source });
  }
}

// Authored folds: link a stealth / unidentifiable id to its real model so it
// shares that model's group and price.
for (const [rawId, canonId] of Object.entries(AUTHORED_FOLDS)) {
  const a = parse(rawId).fingerprint;
  const b = parse(canonId).fingerprint;
  find(a);
  find(b);
  union(a, b);
  keyFp.set(rawId, a);
}

for (const [id, rates] of Object.entries(OVERRIDE_RATES)) {
  const fp = parse(id).fingerprint;
  find(fp);
  targetCount.set(fp, (targetCount.get(fp) || 0) + 1);
  candidates.push({ key: FINGERPRINT_PREFIX + fp, fp, rates, source: "override" });
}

// --- Pass 2: pick one rate table per component -------------------------------
const byRoot = new Map();
for (const c of candidates) {
  const root = find(c.fp);
  const list = byRoot.get(root);
  if (list) list.push(c);
  else byRoot.set(root, [c]);
}

const bestByRoot = new Map();
const disagreements = [];
for (const [root, list] of byRoot) {
  let best = null;
  let bestRank = -Infinity;
  for (const c of list) {
    const r = rank(c.fp, c.source, c.rates);
    if (r > bestRank) {
      bestRank = r;
      best = c;
    }
  }
  let top = list.filter((c) => rank(c.fp, c.source, c.rates) === bestRank);
  // Among ties, a table that carries cache pricing beats a duplicate that does
  // not: the no-cache entry is dropped. (Same model listed twice, one row
  // missing cacheWrite.)
  if (top.some((c) => hasCacheWrite(c.rates))) top = top.filter((c) => hasCacheWrite(c.rates));
  const tables = new Map();
  for (const c of top) tables.set(rateSignature(c.rates), c);
  if (tables.size > 1) {
    disagreements.push({ keys: [...tables.values()].map((c) => c.key), sources: [...new Set(list.map((c) => c.source))] });
  }
  bestByRoot.set(root, tables.values().next().value || best);
}

// Representative fingerprint per component: the one most often used as a
// canonical target (falls back to the lexicographically smallest).
const fpsByRoot = new Map();
for (const fp of parent.keys()) {
  const root = find(fp);
  const list = fpsByRoot.get(root);
  if (list) list.push(fp);
  else fpsByRoot.set(root, [fp]);
}
function representativeFp(root) {
  const fps = (fpsByRoot.get(root) || []).slice().sort();
  let best = fps[0] || root;
  let bestCount = -1;
  for (const fp of fps) {
    const c = targetCount.get(fp) || 0;
    if (c > bestCount) {
      bestCount = c;
      best = fp;
    }
  }
  return best;
}

// --- Pass 3: emit groups + assignments ---------------------------------------
// `until` retires a model from the peak/off-peak picker. A unified group merges
// vendors, so one vendor dropping a model must not retire it for a vendor that
// still serves it: keep `until` only when EVERY source that provides the model
// has ended; otherwise strip it.
const lastUntil = (rates) => {
  if (!Array.isArray(rates) || rates.length === 0) return null;
  const u = rates[rates.length - 1].until;
  return typeof u === "string" && u ? u : null;
};
const stripUntil = (rates) => rates.map((r) => { if (!("until" in r)) return r; const { until, ...rest } = r; return rest; });
const setLastUntil = (rates, until) =>
  rates.map((r, i) => (i === rates.length - 1 ? { ...r, until } : r));

const groups = [];
const rootToGroupId = new Map();
for (const [root, c] of bestByRoot) {
  // All-zero means "this table carries no price" — except when an override
  // authored it, where 0/0/0/0 is the vendor's stated free price and the group
  // must be emitted so the model reads "free" instead of "unknown".
  if (c.source !== "override" && isZeroRates(c.rates)) continue;
  const list = byRoot.get(root) || [];
  const untils = list.map((x) => lastUntil(x.rates));
  const allEnded = list.length > 0 && untils.every((u) => u != null);
  let rates = c.rates;
  if (allEnded) rates = setLastUntil(rates, untils.slice().sort().pop());
  else if (untils.some((u) => u != null)) rates = stripUntil(rates);
  const id = groupIdFor(representativeFp(root));
  rootToGroupId.set(root, id);
  groups.push({ id, rates });
}

const finalAssign = {};
for (const [key, kf] of keyFp) {
  const id = rootToGroupId.get(find(kf));
  if (id) finalAssign[key] = id;
}
// Runtime fallback: any fingerprint in a priced component resolves to it, so a
// model we never enumerated still finds its price by structure alone.
for (const fp of parent.keys()) {
  const id = rootToGroupId.get(find(fp));
  if (id) finalAssign[FINGERPRINT_PREFIX + fp] = id;
}

groups.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

// --- Guardrail: flag merges that cross a structural boundary -----------------
// A group that folds models of different series, major versions or real
// variants can be an intended author fold or a bad alias. Surface it for review
// rather than deciding silently. `base` is the "no variant" default, so folding
// a base-named model into a variant is not reported.
const mergeNotes = [];
for (const [root, id] of rootToGroupId) {
  const fps = fpsByRoot.get(root) || [];
  if (fps.length < 2) continue;
  const series = new Set();
  const versions = new Set();
  const variants = new Set();
  for (const fp of fps) {
    const [s, v, va] = fp.split(":");
    series.add(s);
    if (v !== "0") versions.add(v);
    if (va !== "base") variants.add(va);
  }
  const flags = [];
  if (series.size > 1) flags.push("series");
  if (versions.size > 1) flags.push("version");
  if (variants.size > 1) flags.push("variant");
  if (flags.length) mergeNotes.push({ id, flags, fps: fps.slice().sort() });
}

const preset = { enabled: true, groups, assign: finalAssign };
const serialized = JSON.stringify(preset, null, 2) + "\n";
const outPath = resolve(root, "extension/shared/unified.preset.json");
const stats = `groups=${groups.length} assign=${Object.keys(finalAssign).length} fingerprints=${parent.size}`;

if (process.argv.includes("--check")) {
  const current = existsSync(outPath) ? readFileSync(outPath, "utf8") : "";
  if (current !== serialized) {
    console.error("ERR: extension/shared/unified.preset.json is out of date — re-run the builder.");
    console.error(stats);
    process.exitCode = 1;
  } else {
    console.log(`unified preset in sync (${stats})`);
  }
} else {
  writeFileSync(outPath, serialized);
  console.log("wrote extension/shared/unified.preset.json");
  console.log(stats);
}
if (disagreements.length) {
  console.error(`\nERR: ${disagreements.length} model(s) resolve to the same group with conflicting rate tables.`);
  console.error("Fix the source preset, or the group price is ambiguous (Fail-Closed):");
  for (const d of disagreements) console.error(`  ${d.keys.join("  vs  ")}  <- ${d.sources.join(", ")}`);
  process.exitCode = 1;
}
if (mergeNotes.length) {
  console.log(`\nnote: ${mergeNotes.length} group(s) merge across a structural boundary — review:`);
  for (const m of mergeNotes) console.log(`  ${m.id}  [${m.flags.join("+")}]  ${m.fps.join(" | ")}`);
}
