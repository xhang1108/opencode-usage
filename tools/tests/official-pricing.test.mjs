import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { VENDORS, ROOT } from "../price-watch-lib.mjs";
import { parseStandardTable as parseOpenAI, snapshotFromPage as snapOpenAI } from "../../extension/vendors/openai-official/pricing-page.js";
import { parsePricingModels as parseXai, snapshotFromPage as snapXai } from "../../extension/vendors/xai-official/pricing-page.js";
import { parsePricingModels as parseQwen, snapshotFromPage as snapQwen } from "../../extension/vendors/qwen-official/pricing-page.js";
import { parsePricingModels as parseTencent, snapshotFromPage as snapTencent } from "../../extension/vendors/tencent-official/pricing-page.js";

// ---------------------------------------------------------------------------
// VENDORS wiring
// ---------------------------------------------------------------------------

test("four official sources are wired with existing parser files", () => {
  for (const source of ["xai-official", "openai-official", "qwen-official", "tencent-official"]) {
    const cfg = VENDORS[source];
    assert.ok(cfg, `${source} missing from VENDORS`);
    assert.match(cfg.url, /^https:\/\//);
    assert.ok(existsSync(resolve(ROOT, cfg.parser)), `${source} parser not found: ${cfg.parser}`);
    assert.ok(existsSync(resolve(ROOT, cfg.dir)), `${source} vendor dir not found: ${cfg.dir}`);
    assert.ok(!existsSync(resolve(ROOT, cfg.dir, "vendor.json")), `${source} is price-only and must not ship vendor.json`);
  }
});

// ---------------------------------------------------------------------------
// OpenAI — markdown Standard-pricing section
// ---------------------------------------------------------------------------

const OPENAI_BASE_ROWS = `| Model | Short context input | Short cached input | Short cache writes | Short output | Long input | Long cached input | Long cache writes | Long output |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gpt-6-astra | $10.00 | $1.00 | $12.50 | $50.00 | $20.00 | $2.00 | $25.00 | $75.00 |
| gpt-6-luna | $0.10 | $0.01 | $0.125 | $0.50 | $0.20 | $0.02 | $0.25 | $0.75 |
| gpt-5.5 (<272K context length) | $5.00 | $0.50 | - | $20.00 | $10.00 | $1.00 | - | $45.00 |
| gpt-5.4-mini (<272K context length) | $0.75 | $0.075 | - | $4.50 | - | - | - | - |
| gpt-3.5-turbo | $1.50 | $0.50 | - | $2.00 | - | - | - | - |`;

// pad past MIN_MODELS (20) the way the real 39-row table does
const OPENAI_FILLERS = Array.from(
  { length: 16 },
  (_, i) => `| gpt-filler-${i} | $1.00 | $0.10 | - | $2.00 | - | - | - | - |`,
).join("\n");

const OPENAI_MD = `# Pricing

### Standard pricing data

${OPENAI_BASE_ROWS}
${OPENAI_FILLERS}

### Batch pricing data

| Model | Input | Cached input | Cache writes | Output |
| --- | --- | --- | --- | --- |
| gpt-6-luna | $0.05 | $0.005 | $0.0625 | $0.25 |
`;

test("openai parser reads only the Standard section into tier/flat entries", () => {
  const models = parseOpenAI(OPENAI_MD);
  assert.equal(Object.keys(models).length, 21);
  for (const id of ["gpt-6-astra", "gpt-6-luna", "gpt-5.5", "gpt-5.4-mini", "gpt-3.5-turbo"]) {
    assert.ok(models[id], `${id} missing`);
  }

  // tiered at 272K, short/long legs mapped low/high
  assert.deepEqual(models["gpt-6-luna"].entry.pricing.flat.tier, {
    limit: 272000,
    low: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
    high: { input: 0.2, output: 0.75, cacheRead: 0.02, cacheWrite: 0.25 },
  });

  // "-" cells -> 0 ; parenthetical stripped from the id
  assert.deepEqual(models["gpt-5.4-mini"].entry.pricing.flat, {
    input: 0.75,
    output: 4.5,
    cacheRead: 0.075,
    cacheWrite: 0,
  });

  // Batch section must not leak (it would overwrite standard with $0.05)
  assert.equal(models["gpt-6-luna"].entry.pricing.flat.tier.low.input, 0.1);
});

test("openai parser fails closed on missing anchor / missing section", () => {
  assert.throws(() => parseOpenAI(OPENAI_MD.replace("gpt-6-luna", "gpt-9-sunset")), /anchor model gpt-6-luna missing/);
  assert.throws(() => parseOpenAI("# no pricing here"), /Standard pricing data/);
  assert.throws(() => parseOpenAI("### Standard pricing data\n\nempty"), /no model rows/);
});

test("openai snapshot carries source and capturedAt", () => {
  const snap = snapOpenAI(OPENAI_MD, "2026-09-24T05:17:00.000Z");
  assert.equal(snap.source, "openai-official");
  assert.equal(snap.capturedAt, "2026-09-24T05:17:00.000Z");
  assert.ok(snap.models["gpt-6-luna"]);
});

// ---------------------------------------------------------------------------
// xAI — short/long context table (footnote encodes the tier threshold)
// ---------------------------------------------------------------------------

const XAI_HTML = `<table>
<tr><th>Model</th><th>Context</th><th>Short context</th><th>Long context</th></tr>
<tr><th>Input</th><th>Cached</th><th>Output</th><th>Input</th><th>Cached</th><th>Output</th></tr>
<tr><td>grok-4.7<br>Long context &ge; 200k tokens</td><td>500k</td><td>$2.00</td><td>$0.50</td><td>$6.00</td><td>$4.00</td><td>$1.00</td><td>$12.00</td></tr>
<tr><td>grok-4.6<br>Long context &ge; 200k tokens</td><td>256k</td><td>$2.00</td><td>$0.50</td><td>$6.00</td><td>$4.00</td><td>$1.00</td><td>$12.00</td></tr>
<tr><td>grok-4.3<br>Long context &ge; 200k tokens</td><td>256k</td><td>$1.25</td><td>$0.20</td><td>$2.50</td><td>$2.50</td><td>$0.40</td><td>$5.00</td></tr>
<tr><td>grok-build-0.1<br>Long context &ge; 200k tokens</td><td>256k</td><td>$1.00</td><td>$0.20</td><td>$2.00</td><td>$2.00</td><td>$0.40</td><td>$4.00</td></tr>
<tr><td>grok-4.5<br>Long context &ge; 200k tokens</td><td>256k</td><td>$2.00</td><td>$0.30</td><td>$6.00</td><td>$4.00</td><td>$0.60</td><td>$12.00</td></tr>
<tr><td>grok-4.20-multi-agent<br>Long context &ge; 200k tokens</td><td>1M</td><td>$1.00</td><td>$0.25</td><td>$5.00</td><td>$2.00</td><td>$0.50</td><td>$10.00</td></tr>
<tr><td>grok-4.20-reasoning<br>Long context &ge; 200k tokens</td><td>1M</td><td>$1.00</td><td>$0.25</td><td>$5.00</td><td>$2.00</td><td>$0.50</td><td>$10.00</td></tr>
<tr><td>grok-4.20-non-reasoning<br>Long context &ge; 200k tokens</td><td>1M</td><td>$1.00</td><td>$0.25</td><td>$5.00</td><td>$2.00</td><td>$0.50</td><td>$10.00</td></tr>
</table>`;

test("xai parser builds 200k-tier entries from the footnote threshold", () => {
  const models = parseXai(XAI_HTML);
  assert.equal(Object.keys(models).length, 8);
  assert.ok(models["grok-4.7"]);
  assert.deepEqual(models["grok-4.7"].entry.pricing.flat.tier, {
    limit: 200000,
    low: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
    high: { input: 4, output: 12, cacheRead: 1, cacheWrite: 0 },
  });
  assert.deepEqual(models["grok-4.3"].entry.pricing.flat.tier, {
    limit: 200000,
    low: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
    high: { input: 2.5, output: 5, cacheRead: 0.4, cacheWrite: 0 },
  });
});

test("xai parser: flat when short==long, fails closed on missing anchor/threshold", () => {
  // collapse grok-4.7's long column onto its short column -> flat entry
  const flatRow = XAI_HTML.replace(
    "<td>$4.00</td><td>$1.00</td><td>$12.00</td></tr>\n<tr><td>grok-4.6",
    "<td>$2.00</td><td>$0.50</td><td>$6.00</td></tr>\n<tr><td>grok-4.6",
  );
  const models = parseXai(flatRow);
  assert.deepEqual(models["grok-4.7"].entry.pricing.flat, { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 });

  assert.throws(() => parseXai(XAI_HTML.replace("grok-4.7", "grok-9")), /anchor model grok-4.7 missing/);
  const noThreshold = XAI_HTML.replace(/Long context &ge; 200k tokens/g, "");
  assert.throws(() => parseXai(noThreshold), /no long-context threshold/);
  assert.throws(() => parseXai("<html><body>moved</body></html>"), /table not found/);
});

test("xai snapshot carries source and capturedAt", () => {
  const snap = snapXai(XAI_HTML, "2026-09-24T05:17:00.000Z");
  assert.equal(snap.source, "xai-official");
  assert.equal(snap.capturedAt, "2026-09-24T05:17:00.000Z");
});

// ---------------------------------------------------------------------------
// Qwen — International chat tables (3 live layouts), output columns, derived cache
// ---------------------------------------------------------------------------

// exact cont row for qwen3.5-plus, reused by the >2-tier test
const QWEN_35_CONT = `<tr><td><p>256K&lt;Token&le;1M</p></td><td><p>$0.5</p></td><td><p>$3</p></td><td><p>$3</p></td></tr>`;

// Layout A: tier column + quota (the main chat table)
const QWEN_MAIN = `<table>
<tr>
  <th rowspan="2">Model ID</th><th rowspan="2">Deployment scope</th>
  <th rowspan="2">Input tokens per request</th><th rowspan="2">Input price (per 1 million tokens)</th>
  <th colspan="2">Output price (per 1 million tokens)</th><th rowspan="2">Free quota</th>
</tr>
<tr><th>Non-Thinking mode</th><th>Thinking mode (chain of thought + answer)</th></tr>
<tr>
  <td rowspan="2"><p>qwen3.5-plus</p><blockquote><p>Currently equivalent to qwen3.5-plus-2026-02-15</p></blockquote></td>
  <td rowspan="2"><p>International</p></td>
  <td><p>0&lt;Token&le;256K</p></td><td><p>$0.4</p></td><td><p>$2.4</p></td><td><p>$2.4</p></td>
  <td rowspan="2"><p>1 million tokens</p></td>
</tr>
${QWEN_35_CONT}
<tr>
  <td rowspan="2"><p>qwen3.7-plus</p></td><td rowspan="2"><p>International</p></td>
  <td><p>0&lt;Token&le;256K</p></td>
  <td><p>List price $0.4 (Limited-time 20% off)</p></td>
  <td><p>List price $1.6 (Limited-time 20% off)</p></td>
  <td><p>List price $1.6 (Limited-time 20% off)</p></td>
  <td rowspan="2"><p>1 million tokens</p></td>
</tr>
<tr><td><p>256K&lt;Token&le;1M</p></td><td><p>$1.2</p></td><td><p>$4.8</p></td><td><p>$4.8</p></td></tr>
<tr>
  <td><p>qwen-plus</p></td><td><p>International</p></td>
  <td><p>0&lt;Token&le;256K</p></td><td><p>$0.4</p></td><td><p>$1.2</p></td><td><p>$4</p></td><td><p>1 million tokens</p></td>
</tr>
<tr><td><p>qwen-plus</p></td><td><p>Global</p></td><td><p>0&lt;Token&le;256K</p></td><td><p>$0.5</p></td><td><p>$2</p></td><td><p>$5</p></td><td><p>1 million tokens</p></td></tr>
<tr><td><p>deepseek-v4-pro</p></td><td><p>International</p></td><td><p>0&lt;Token&le;256K</p></td><td><p>$1</p></td><td><p>$3</p></td><td><p>$3</p></td><td><p>1 million tokens</p></td></tr>
<tr>
  <td rowspan="2"><p>qwq-plus</p></td><td rowspan="2"><p>International</p></td>
  <td><p>0&lt;Token&le;256K</p></td><td><p>$0.6</p></td><td><p>$2.4</p></td><td><p>$2.4</p></td>
  <td rowspan="2"><p>1 million tokens</p></td>
</tr>
<tr><td><p>256K&lt;Token&le;1M</p></td><td><p>$0.9</p></td><td><p>$3.6</p></td><td><p>$3.6</p></td></tr>
<tr><td><p>qwen-max</p></td><td><p>International</p></td><td><p>0&lt;Token&le;1M</p></td><td><p>$1.4</p></td><td><p>$5.6</p></td><td><p>$5.6</p></td><td><p>1 million tokens</p></td></tr>
<tr><td><p>qwen-plus-2025-01-25</p></td><td><p>International</p></td><td><p>No tiered pricing</p></td><td><p>$0.4</p></td><td><p>$1.2</p></td><td><ul>
<li></li>
</ul></td><td><p>1 million tokens</p></td></tr>
</table>`;

// Layout C: Mode column, no tier — thinking-only rows carry "-" as non-thinking output
const QWEN_MODE = `<table>
<tr><th>Model ID</th><th>Deployment scope</th><th>Mode</th><th>Input price (per 1 million tokens)</th><th>Output price (per 1 million tokens)</th><th>Free quota</th></tr>
<tr><th>Non-Thinking mode</th><th>Thinking mode</th></tr>
<tr><td><p>qwen3-next-80b-a3b-thinking</p></td><td><p>International</p></td><td><p>Thinking mode only</p></td><td><p>$0.15</p></td><td><p>-</p></td><td><p>$1.2</p></td><td><p>1 million tokens</p></td></tr>
<tr><td><p>qwen3-next-80b-a3b-instruct</p></td><td><p>International</p></td><td><p>Non-Thinking mode only</p></td><td><p>$0.15</p></td><td><p>$1.2</p></td><td><p>-</p></td><td><p>1 million tokens</p></td></tr>
<tr><td><p>qwen3-235b-a22b-thinking-2507</p></td><td><p>International</p></td><td><p>Thinking mode only</p></td><td><p>$0.23</p></td><td><p>-</p></td><td><p>$2.3</p></td><td><p>1 million tokens</p></td></tr>
<tr><td><p>qwen3-235b-a22b-instruct-2507</p></td><td><p>International</p></td><td><p>Non-Thinking mode only</p></td><td><p>$0.23</p></td><td><p>$0.92</p></td><td><p>-</p></td><td><p>1 million tokens</p></td></tr>
</table>`;

// Layout B: no tier column (6 data cells) — input sits at index 2
const QWEN_FLAT = `<table>
<tr><th>Model ID</th><th>Deployment scope</th><th>Input price (per 1 million tokens)</th><th>Output price (per 1 million tokens)</th><th>Free quota</th></tr>
<tr><th>Non-Thinking mode</th><th>Thinking mode (chain of thought + answer)</th></tr>
<tr><td><p>qwen-turbo 50% batch inference discount</p></td><td><p>International</p></td><td><p>$0.05</p></td><td><p>$0.2</p></td><td><p>$0.5</p></td><td><p>1 million tokens</p></td></tr>
<tr><td><p>qwen-long</p></td><td><p>Global</p></td><td><p>$0.07</p></td><td><p>$0.28</p></td><td><p>$0.7</p></td><td><p>1 million tokens</p></td></tr>
<tr><td><p>qwen-vl-max</p></td><td><p>International</p></td><td><p>$0.8</p></td><td><p>$4</p></td><td><p>$4</p></td><td><p>1 million tokens</p></td></tr>
</table>`;

const QWEN_HTML = QWEN_MAIN + QWEN_MODE + QWEN_FLAT;

test("qwen parser: derives columns per layout, International-only, canonical output", () => {
  const models = parseQwen(QWEN_HTML);
  const ids = Object.keys(models);
  assert.equal(ids.length, 12);
  for (const id of [
    "qwen3.5-plus",
    "qwen3.7-plus",
    "qwen-plus",
    "qwen-max",
    "qwq-plus",
    "qwen3-next-80b-a3b-thinking",
    "qwen3-next-80b-a3b-instruct",
    "qwen3-235b-a22b-thinking-2507",
    "qwen3-235b-a22b-instruct-2507",
    "qwen-turbo",
    "qwen-vl-max",
    "qwen-plus-2025-01-25",
  ]) {
    assert.ok(models[id], `${id} missing`);
  }

  // EMPTY thinking-output cell (<ul><li></li></ul>) + "No tiered pricing" tier
  // cell — both live quirks — fall back to the Non-Thinking price, flat entry
  assert.deepEqual(models["qwen-plus-2025-01-25"].entry.pricing.flat, {
    input: 0.4,
    output: 1.2,
    cacheRead: 0.04,
    cacheWrite: 0.5,
  });

  // tier + cache ratios from the page note (10% read / 125% write)
  assert.deepEqual(models["qwen3.5-plus"].entry.pricing.flat.tier, {
    limit: 256000,
    low: { input: 0.4, output: 2.4, cacheRead: 0.04, cacheWrite: 0.5 },
    high: { input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0.625 },
  });

  // "List price $X (Limited-time …)" -> list price
  assert.deepEqual(models["qwen3.7-plus"].entry.pricing.flat.tier.low, {
    input: 0.4,
    output: 1.6,
    cacheRead: 0.04,
    cacheWrite: 0.5,
  });

  // single-tier model -> flat, canonical output = Non-Thinking column ($1.2, not $4)
  assert.deepEqual(models["qwen-plus"].entry.pricing.flat, {
    input: 0.4,
    output: 1.2,
    cacheRead: 0.04,
    cacheWrite: 0.5,
  });
  assert.deepEqual(models["qwen-max"].entry.pricing.flat, {
    input: 1.4,
    output: 5.6,
    cacheRead: 0.14,
    cacheWrite: 1.75,
  });

  // Mode-column table: thinking-only rows fall back to the Thinking column
  assert.deepEqual(models["qwen3-next-80b-a3b-thinking"].entry.pricing.flat, {
    input: 0.15,
    output: 1.2,
    cacheRead: 0.015,
    cacheWrite: 0.1875,
  });
  assert.deepEqual(models["qwen3-235b-a22b-instruct-2507"].entry.pricing.flat, {
    input: 0.23,
    output: 0.92,
    cacheRead: 0.023,
    cacheWrite: 0.2875,
  });

  // No-tier table: input sits at column 2 — $0.05, never the output price
  assert.deepEqual(models["qwen-turbo"].entry.pricing.flat, {
    input: 0.05,
    output: 0.2,
    cacheRead: 0.005,
    cacheWrite: 0.0625,
  });

  // Global-scope row and the third-party deepseek row on the same page are skipped
  assert.equal(models["qwen-plus"].entry.pricing.flat.input, 0.4);
  assert.ok(!Object.keys(models).some((k) => k.startsWith("deepseek")));
  assert.ok(!("qwen-long" in models), "Global-scope qwen-long must be skipped");
});

test("qwen parser fails closed: signature / anchor / min count / dashes / >2 tiers", () => {
  assert.throws(() => parseQwen("<table><tr><td>nothing here</td></tr></table>"), /signature not found/);
  assert.throws(() => parseQwen(QWEN_HTML.replace("qwen3.5-plus", "qwen4.0-plus")), /anchor model qwen3.5-plus missing/);

  // a single surviving table (6 ids) is below MIN_MODELS=10
  assert.throws(() => parseQwen(QWEN_MAIN), /only \d+ models/);

  // thinking-only row with BOTH output columns "-" -> output 0 -> sanity fires
  const bothDash = QWEN_HTML.replace(
    "Non-Thinking mode only</p></td><td><p>$0.15</p></td><td><p>$1.2</p>",
    "Non-Thinking mode only</p></td><td><p>$0.15</p></td><td><p>-</p>",
  );
  assert.notEqual(bothDash, QWEN_HTML, "fixture replacement must have matched");
  assert.throws(() => parseQwen(bothDash), /insane prices for qwen3-next-80b-a3b-instruct/);

  const thirdTier = `<tr><td><p>1M&lt;Token&le;4M</p></td><td><p>$1</p></td><td><p>$6</p></td><td><p>$6</p></td></tr>`;
  const threeTier = QWEN_HTML.replace(QWEN_35_CONT, `${QWEN_35_CONT}\n${thirdTier}`);
  assert.notEqual(threeTier, QWEN_HTML, "fixture replacement must have matched");
  assert.throws(() => parseQwen(threeTier), /3 tiers not expressible/);
});

test("qwen snapshot carries source and capturedAt", () => {
  const snap = snapQwen(QWEN_HTML, "2026-09-24T05:17:00.000Z");
  assert.equal(snap.source, "qwen-official");
  assert.equal(snap.capturedAt, "2026-09-24T05:17:00.000Z");
});

// ---------------------------------------------------------------------------
// Tencent — TokenHub Hunyuan rows (escaped-JSON payload + badge stripping)
// ---------------------------------------------------------------------------

const TENCENT_ROWS = `<table>
<tr><td data-label="Model">Tencent Hunyuan Hy3</td><td data-label="Type">General &middot; Coding</td><td data-label="Input">$0.132</td><td data-label="Output">$0.528</td><td data-label="Cache hit">$0.033</td><td data-label="Action"><a href="#">Activate</a></td></tr>
<tr><td data-label="Model">Tencent Hunyuan Hy4 Preview <span class="custom-models__promo">New</span></td><td data-label="Type">Agentic</td><td data-label="Input">$0.834</td><td data-label="Output">$2.501</td><td data-label="Cache hit">$0.042</td><td data-label="Action"><a href="#">Activate</a></td></tr>
<tr><td data-label="Model">DeepSeek-V4-Flash (0731)</td><td data-label="Type">General</td><td data-label="Input">$0.14</td><td data-label="Output">$0.28</td><td data-label="Cache hit">$0.014</td><td data-label="Action"><a href="#">Activate</a></td></tr>
</table>`;

const escapeJson = (html) => html.replace(/"/g, '\\"').replace(/\n/g, "\\n");

test("tencent parser: Hunyuan-only ids, badge stripped, escaped payload unescaped", () => {
  const page = `<script>const payload = "${escapeJson(TENCENT_ROWS)}";</script>`;
  const models = parseTencent(page);
  assert.deepEqual(Object.keys(models).sort(), ["hy3", "hy4-preview"]);
  assert.deepEqual(models["hy3"].entry.pricing.flat, {
    input: 0.132,
    output: 0.528,
    cacheRead: 0.033,
    cacheWrite: 0,
  });
  assert.deepEqual(models["hy4-preview"].entry.pricing.flat, {
    input: 0.834,
    output: 2.501,
    cacheRead: 0.042,
    cacheWrite: 0,
  });

  // raw (non-escaped) server-rendered table also parses
  const raw = parseTencent(TENCENT_ROWS);
  assert.deepEqual(Object.keys(raw).sort(), ["hy3", "hy4-preview"]);
});

test("tencent parser fails closed on missing rows / anchor", () => {
  assert.throws(() => parseTencent("<html><table><tr><td>nope</td></tr></table></html>"), /no Tencent Hunyuan rows/);
  assert.throws(() => parseTencent(TENCENT_ROWS.replace("Tencent Hunyuan Hy3", "Tencent Hunyuan HyX")), /anchor model hy3 missing/);
  assert.throws(() => parseTencent(TENCENT_ROWS.replace("$0.528", "$0.01")), /insane prices for hy3/);
});

test("tencent snapshot carries source and capturedAt", () => {
  const snap = snapTencent(TENCENT_ROWS, "2026-09-24T05:17:00.000Z");
  assert.equal(snap.source, "tencent-official");
  assert.equal(snap.capturedAt, "2026-09-24T05:17:00.000Z");
});

// ---------------------------------------------------------------------------
// Cross-source snapshot contract (price-history -> preset round trip)
// ---------------------------------------------------------------------------

test("all four parsers produce valid snapshot -> preset chains", async () => {
  const { versionsFromSnapshots, presetFromVersions } = await import("../../extension/shared/price-history.js");
  const cases = [
    ["openai-official", snapOpenAI(OPENAI_MD, "2026-09-24T05:17:00.000Z"), "gpt-6-luna"],
    ["xai-official", snapXai(XAI_HTML, "2026-09-24T05:17:00.000Z"), "grok-4.7"],
    ["qwen-official", snapQwen(QWEN_HTML, "2026-09-24T05:17:00.000Z"), "qwen3.5-plus"],
    ["tencent-official", snapTencent(TENCENT_ROWS, "2026-09-24T05:17:00.000Z"), "hy3"],
  ];
  for (const [source, snap, id] of cases) {
    const state = versionsFromSnapshots([snap]);
    const preset = presetFromVersions(state, { source });
    const key = preset.modelMap[`${source}:${id}`];
    assert.equal(key, `${source}:${id}`, `${source}: modelMap missing ${id}`);
    assert.ok(preset.targets[key].rates.length >= 1, `${source}: no rates for ${id}`);
  }
});
