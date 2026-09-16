// extension/vendors/mimo/pricing-page.js
// Parse Xiaomi MiMo USD prices out of the platform web bundle. Pure (P9).
//
// The docs/pricing page is an SPA; the landing bundle embeds the current USD
// prices as marketing strings (also CNY):
//   "model_pro_desc":"Input (Cache Hit): $0.0036 | Input (Cache Miss): $0.435
//                      | Output: $0.87 (Per 1M tokens)"
//   "model_v25_desc":"Input (Cache Hit): $0.0028 | Input (Cache Miss): $0.14
//                      | Output: $0.28 (Per 1M tokens)"
// Mapping: input = cache miss, cacheRead = cache hit, output = output,
// cacheWrite = 0. Official USD - no FX needed.

export const MIMO_SOURCE = "mimo";

export function extractBundleUrl(shellHtml) {
  const m = /\/static\/main\.[a-f0-9]+\.chunk\.js/.exec(String(shellHtml));
  return m ? m[0] : null;
}

export function parseMimoPrices(bundleText) {
  const models = {};
  // The bundle carries a zh and an en copy; only the en one has "Input (Cache
  // Hit)". Anchor to the key so model_pro_desc/model_v25_desc don't cross-match.
  const re =
    /(model_pro_desc|model_v25_desc)[^]{0,120}?Input \(Cache Hit\):\s*\$([0-9.]+)\s*\|\s*Input \(Cache Miss\):\s*\$([0-9.]+)\s*\|\s*Output:\s*\$([0-9.]+)/g;
  let m;
  while ((m = re.exec(bundleText)) !== null) {
    const id = m[1] === "model_pro_desc" ? "mimo-v2.5-pro" : "mimo-v2.5";
    models[id] = {
      label: id,
      entry: { pricing: { flat: { input: Number(m[3]), output: Number(m[4]), cacheRead: Number(m[2]), cacheWrite: 0 } } },
    };
  }
  if (Object.keys(models).length === 0) throw new Error("MiMo pricing: no USD prices found in bundle");
  return models;
}

export function snapshotFromBundle(bundleText, capturedAt, { source = MIMO_SOURCE } = {}) {
  return { capturedAt: capturedAt || new Date().toISOString(), source, models: parseMimoPrices(bundleText) };
}
