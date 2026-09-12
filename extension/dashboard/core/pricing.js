// extension/dashboard/core/pricing.js
// Dashboard-side pricing wrapper: assemble pricing tables from shipped presets
// + user overrides, and price records via shared/pricing.js. Pure (P9).

import { buildPricing } from "../../shared/preset.js";
import { priceRecord } from "../../shared/pricing.js";

export function createPricer({ presets = [], userPricing = {}, priceChoice = {} } = {}) {
  const pricing = buildPricing({ presets, userPricing, priceChoice });
  return {
    pricing,
    price(record) {
      return priceRecord(record, pricing);
    },
  };
}
