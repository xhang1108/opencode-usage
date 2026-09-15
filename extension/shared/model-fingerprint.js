// extension/shared/model-fingerprint.js
// Turn a vendor model id (e.g. "openrouter:google/gemini-3.5-flash") into a
// stable structural fingerprint. The same underlying model reported under
// different spellings or routing prefixes collapses to one fingerprint, while
// genuinely different variants stay apart (gemini-3.5-flash !== gemini-3.5-pro).
//
// Pure (no DOM / chrome). Shared by the preset builder and the pricing runtime.

// Billing markers are not model variants: a "-free" or "-paid" suffix bills as
// the base model, so it is dropped before fingerprinting.
const BILLING_SUFFIXES = ["free", "paid"];

// Real variants that change which model / price table applies.
const VARIANTS = ["flash", "lite", "mini", "pro", "plus", "max", "preview", "turbo"];

/**
 * @param {string} key a "<source>:<model>" key or a bare model id
 * @returns {{ fingerprint: string, series: string, version: string, variant: string, model: string, raw: string }}
 */
export function parse(key) {
  const raw0 = String(key);
  const colon = raw0.indexOf(":");
  let raw = colon === -1 ? raw0 : raw0.slice(colon + 1);

  // drop a routing prefix ("google/gemini-3.5-flash" -> "gemini-3.5-flash")
  if (raw.includes("/")) raw = raw.slice(raw.lastIndexOf("/") + 1);

  // strip date stamps so gpt-5-nano-2025-08-07 === gpt-5-nano
  raw = raw.replace(/\d{4}-\d{2}-\d{2}/g, "");

  raw = raw
    .toLowerCase()
    .replace(/[_ ]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  // normalise version markers: deepseekv4.1 -> deepseek-v4.1, deepseek-v4 -> deepseek-4
  raw = raw.replace(/([a-z])v(\d)/g, "$1-$2").replace(/-v(\d)/g, "-$1");

  // drop billing markers ("-free" / "-paid"), wherever they sit at the tail
  let changed = true;
  while (changed) {
    changed = false;
    for (const s of BILLING_SUFFIXES) {
      if (raw.endsWith("-" + s)) {
        raw = raw.slice(0, -(s.length + 1));
        changed = true;
      }
    }
  }

  // variant lives in the suffix
  let variant = "base";
  for (const v of VARIANTS) {
    if (raw.endsWith("-" + v)) {
      variant = v;
      raw = raw.slice(0, -(v.length + 1));
      break;
    }
  }

  const series = (raw.match(/^([a-z]+)/) || [, "unknown"])[1];
  const version = (raw.match(/(\d+(?:\.\d+)?)/) || [, "0"])[1];
  const model = raw
    .replace(/^([a-z]+)-?/, "")
    .replace(/[-_]?(\d+(?:\.\d+)?)/, "")
    .replace(/^-+|-+$/g, "");

  return {
    fingerprint: `${series}:${version}:${variant}:${model}`,
    series,
    version,
    variant,
    model,
    raw: key,
  };
}
