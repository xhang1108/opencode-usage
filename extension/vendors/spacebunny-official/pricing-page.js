// extension/vendors/spacebunny-official/pricing-page.js
// Parse Space Bunny's official pricing page. Pure (P9).
//
// Source: GET https://spacebunnymodel.com/pricing — a Next.js SSR page, so the
// price is embedded in the HTML (no JS rendering / auth needed).
//
// Billing model: a single "$X.XX / 1M total tokens" rate (prompt + completion
// counted together). Our schema prices input/output legs separately per 1M, so
// the total-token rate maps to input = output = X (1M in + 1M out costs 2X
// under either accounting, matching "deducts $X per 1M total tokens").
// Records split prompt tokens into cache-miss (input) and cache-hit
// (cacheRead), mutually exclusive, so cacheRead = X too — otherwise a cached
// read would bill 0 (free) instead of its share of the total. Cache write is
// not listed anywhere -> 0 (repo-wide default for unlisted legs).
//
// The page also advertises bulk-credit bonus packs ($50 -> $2.50/M effective,
// $100 -> $1.79/M effective). Those are top-up bonuses, not the list rate, so
// the parser deliberately ignores .buy-rate cells and anchors on the two
// list-rate statements instead:
//   1. hero stat: "$3.00/M" + "Per 1M total tokens"
//   2. billing rule: "Each call deducts `$3.00 / 1M total tokens`"
// Both must be present and agree, or the parse fails closed (layout drift).

export const SPACEBUNNY_SOURCE = "spacebunny-official";

export const SPACEBUNNY_URL = "https://spacebunnymodel.com/pricing";
// Canonical id matches the opencode listing ("space-bunny") so both spellings
// share one fingerprint; the API serves it as "space-bunny-alpha".
export const MODEL_ID = "space-bunny";

const MAX_LEG = 1000; // per-1M USD; catches unit drift (per-token vs per-1K vs per-1M)

// Strip tags/comments/entities so "$3.00<!-- --> / 1M" and "$3.00<span>/M</span>"
// both read as plain text.
function textOf(html) {
  return String(html)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function money(s) {
  const m = /\$\s*([0-9]+(?:\.[0-9]+)?)/.exec(String(s || ""));
  return m ? Number(m[1]) : null;
}

// html -> { "space-bunny": { label, entry } }
export function parsePricingModels(html) {
  const text = textOf(html);

  // Anchor 1: hero stat "Per 1M total tokens" with its $ figure.
  const hero = /\$\s*([0-9]+(?:\.[0-9]+)?)\s*\/\s*M\s*Per 1M total tokens/i.exec(text);
  if (!hero) throw new Error("Space Bunny pricing: hero rate (Per 1M total tokens) not found");

  // Anchor 2: billing rule "deducts $X / 1M total tokens".
  const billing = /deducts?\s*\$\s*([0-9]+(?:\.[0-9]+)?)\s*\/\s*1M total tokens/i.exec(text);
  if (!billing) throw new Error("Space Bunny pricing: billing rule (/ 1M total tokens) not found");

  const heroRate = Number(hero[1]);
  const billingRate = Number(billing[1]);
  if (!Number.isFinite(heroRate) || !Number.isFinite(billingRate)) {
    throw new Error("Space Bunny pricing: unparseable rate");
  }
  if (heroRate !== billingRate) {
    throw new Error(`Space Bunny pricing: hero $${heroRate} disagrees with billing $${billingRate}`);
  }
  const rate = heroRate;
  if (!(rate > 0 && rate <= MAX_LEG)) throw new Error(`Space Bunny pricing: insane rate $${rate}`);

  const legs = { input: rate, output: rate, cacheRead: rate, cacheWrite: 0 };
  return { [MODEL_ID]: { label: MODEL_ID, entry: { pricing: { flat: legs } } } };
}

export function snapshotFromPage(html, capturedAt, { source = SPACEBUNNY_SOURCE } = {}) {
  return { capturedAt: capturedAt || new Date().toISOString(), source, models: parsePricingModels(html) };
}
