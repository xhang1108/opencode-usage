// extension/dashboard/core/pricing-config.js
// Pure helpers bridging canonical records + the author-maintained fallback
// pricing config (shared/preset.js buildPricing) to the dashboard and settings
// pages. Unified pricing is handled separately (shared/unified.js).
// Zero chrome / DOM dependencies (P9).

import { priceRecord, resolveTargetId, getRateEntry, getWindow, effectiveTimeMs } from "../../shared/pricing.js";

// D4: legacy records without a `source` are opencode. Never mutate the input.
export function withDefaultSource(record) {
  if (!record || record.source) return record || { source: "opencode" };
  return { ...record, source: "opencode" };
}

// Vendor-reported spend is authoritative, but the vendor row carries no
// peak/offpeak label. Derive the window from the record's timestamp and the
// model's rate windows so peak/offpeak totals stay meaningful WITHOUT touching
// the cost. Unknown/unwindowed models stay flat (as before).
function vendorWindow(rec, pricing) {
  try {
    const targetId = resolveTargetId(rec, (pricing && pricing.modelMap) || {});
    const target = targetId && pricing && pricing.targets ? pricing.targets[targetId] : null;
    if (!target || !Array.isArray(target.rates) || target.rates.length === 0) return "flat";
    const entry = getRateEntry({ rates: target.rates }, effectiveTimeMs(rec));
    if (!entry) return "flat";
    return getWindow(rec, entry);
  } catch (e) {
    return "flat";
  }
}

// Price one canonical record against the fallback config. Vendors may opt into
// using their own reported spend (`vendorCost`) as the primary cost instead of
// deriving from token rates: `costSource[source] === "vendor"`. All other
// sources derive cost from the rate tables ("derived", default).
export function priceWithConfig(record, pricing, costSource = {}) {
  const rec = withDefaultSource(record);
  const source = rec.source || "opencode";
  if ((costSource[source] || "derived") === "vendor" && rec.vendorCost != null) {
    // Records store the vendor amount RAW; `costScale` is the divisor that turns
    // it into USD (opencode console = 1e8, local import = 1, other vendors omit
    // it). The conversion happens here — never at ingest, so stored data is
    // exactly what the vendor returned.
    const cost = (Number(rec.vendorCost) || 0) / (Number(rec.costScale) || 1);
    return { cost, savings: 0, window: vendorWindow(rec, pricing), unpriced: false, targetId: null, priceBasis: "vendor-reported" };
  }
  // No vendor amount (server sent `cost: null`) or a non-vendor source:
  // estimate from the token rate table.
  return priceRecord(rec, pricing || {});
}

// The time-reminder consumes a flat [{ model, rates }] list (peak windows per
// model). Derive it from the fallback pricing config: one rule per price target,
// named by the target's label, so several raw model ids that share a rate table
// show up as a single picker entry (matching unifiedRateModels).
export function legacyModelsFromPricing(pricing = {}) {
  const rules = [];
  const seen = new Set();
  for (const targetId of Object.values(pricing.modelMap || {})) {
    const target = (pricing.targets || {})[targetId];
    if (!target || !Array.isArray(target.rates) || target.rates.length === 0) continue;
    const colon = targetId.indexOf(":");
    const model = target.label || (colon === -1 ? targetId : targetId.slice(colon + 1));
    if (seen.has(model)) continue; // one option per display name
    seen.add(model);
    rules.push({ model, rates: target.rates });
  }
  return rules;
}

// Derive a stable, readable target id from a label, avoiding collisions.
export function makeTargetId(label, existing = {}) {
  const base =
    String(label || "target")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9.+-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "target";
  let id = base;
  let n = 2;
  while (existing[id]) id = `${base}-${n++}`;
  return id;
}
