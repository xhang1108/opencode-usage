// extension/vendors/mimo/pricing-page.js
// Parse Xiaomi MiMo USD prices from the official public models API. Pure (P9).
//
// Source: GET https://platform.xiaomimimo.com/api/v1/models — an OpenRouter-style
// catalog (no auth) that the platform itself renders prices from. The docs/pricing
// page is an SPA and the landing bundle no longer embeds prices, so this API is
// the only official machine-readable source. Each entry carries per-token USD:
//   "pricing": { "prompt": "0.000000435", "completion": "0.00000087",
//                "input_cache_read": "0.0000000036" }
// A tiered model carries an ordered array whose second element pins the higher
// tier with "min_context" (mimo-v2-pro: 256000).
// Mapping: input = prompt, output = completion, cacheRead = input_cache_read,
// cacheWrite = input_cache_write (0 when absent). Official USD - no FX needed.
// Values are stored per 1M tokens; round6 kills the FP dust from x1e6.
//
// NB: unlike every HTML-page vendor, output CAN be below input here —
// mimo-v2-omni prices multimodal input above its text output — so this parser
// does not enforce output >= input, but bounds every leg instead (unit drift).

export const MIMO_SOURCE = "mimo";
export const MIN_MODELS = 5;
const ANCHOR_ID = "mimo-v2.5-pro";
const MAX_LEG = 1000; // per-1M USD; catches unit drift (per-token vs per-1K vs per-1M)

const round6 = (x) => Math.round(x * 1e6) / 1e6;
const perM = (v) => round6(Number(v) * 1e6);

function legsFromPricing(p) {
  return {
    input: perM(p.prompt),
    output: perM(p.completion),
    cacheRead: p.input_cache_read != null ? perM(p.input_cache_read) : 0,
    cacheWrite: p.input_cache_write != null ? perM(p.input_cache_write) : 0,
  };
}

function checkLeg(id, legs) {
  const { input, output, cacheRead } = legs;
  const ok =
    input > 0 &&
    output > 0 &&
    input <= MAX_LEG &&
    output <= MAX_LEG &&
    cacheRead >= 0 &&
    cacheRead <= input;
  if (!ok) throw new Error(`MiMo pricing: insane prices for ${id} ${JSON.stringify(legs)}`);
}

export function parseMimoPrices(apiText) {
  let doc;
  try {
    doc = JSON.parse(String(apiText));
  } catch (e) {
    throw new Error(`MiMo pricing: invalid JSON (${e.message})`);
  }
  if (!doc || !Array.isArray(doc.data)) throw new Error("MiMo pricing: payload has no data[]");

  const models = {};
  for (const m of doc.data) {
    const id = String(m && m.id ? m.id : "").replace(/^xiaomi\//, "");
    if (!/^mimo-/i.test(id)) continue; // endpoint is Xiaomi-only; skip anything else
    if (!m.pricing) throw new Error(`MiMo pricing: missing pricing for ${id}`);
    const tiers = Array.isArray(m.pricing) ? m.pricing : [m.pricing];
    if (tiers.length > 2) throw new Error(`MiMo pricing: ${tiers.length} tiers not expressible for ${id}`);

    const low = legsFromPricing(tiers[0]);
    checkLeg(id, low);
    if (tiers.length === 1) {
      models[id] = { label: id, entry: { pricing: { flat: low } } };
    } else {
      const highP = tiers[1];
      const high = legsFromPricing(highP);
      checkLeg(id, high);
      const limit = Number(highP.min_context);
      if (!Number.isFinite(limit) || limit <= 0) throw new Error(`MiMo pricing: tier without min_context for ${id}`);
      models[id] = { label: id, entry: { pricing: { flat: { tier: { limit, low, high } } } } };
    }
  }

  const count = Object.keys(models).length;
  if (count < MIN_MODELS) throw new Error(`MiMo pricing: only ${count} models (<${MIN_MODELS})`);
  if (!models[ANCHOR_ID]) throw new Error(`MiMo pricing: anchor model ${ANCHOR_ID} missing`);
  return models;
}

export function snapshotFromPage(apiText, capturedAt, { source = MIMO_SOURCE } = {}) {
  return { capturedAt: capturedAt || new Date().toISOString(), source, models: parseMimoPrices(apiText) };
}
