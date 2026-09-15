// extension/dashboard/settings/vendors-model.js
// Pure model behind Settings → Vendors: the per-vendor meta line and the
// optional-origin predicate. No chrome, no DOM.

// The "crawl · import xlsx" modes line and the cost-basis line shown under a
// vendor. Under unified pricing the vendor's own basis is bypassed.
export function vendorMeta(v, { unifiedOn, hasPreset }) {
  const modes = [v.crawl ? "crawl" : null, v.import && v.import.length ? `import ${v.import.join("/")}` : null]
    .filter(Boolean)
    .join(" · ");
  const vendorCost = v.costSource === "vendor";
  const basis = unifiedOn
    ? "unified price"
    : `cost ${vendorCost ? "vendor-reported" : "estimated"}${!vendorCost && !hasPreset ? " · no preset" : ""}`;
  return { modes, basis, vendorCost };
}

// Vendors with optional host permissions that must be granted on enable.
export const hasOrigins = (v) => !!(v && v.origins && v.origins.length > 0);
