// extension/shared/preset.js
// Assemble the author-maintained fallback pricing tables shipped with the
// extension. Users do not edit these; unified pricing is the only user-authored
// price list (shared/unified.js). Zero chrome dependencies (P9).
//
// Preset shape (vendors/<source>/rates.preset.json):
//   { source, modelMap: { "<source>:<raw>": targetId }, targets: { id: {...} } }

import { validateRates } from "./pricing.js";

export function buildPricing({ presets = [] } = {}) {
  const modelMap = {};
  const targets = {};
  for (const preset of presets) {
    if (!preset) continue;
    Object.assign(modelMap, preset.modelMap || {});
    for (const [id, target] of Object.entries(preset.targets || {})) {
      targets[id] = { ...(targets[id] || {}), ...target };
    }
  }
  return { modelMap, targets };
}

export function validatePreset(preset) {
  const errors = [];
  if (!preset || typeof preset !== "object") return { ok: false, errors: ["not-object"] };
  if (!preset.source) errors.push("missing:source");
  if (preset.modelMap != null && (typeof preset.modelMap !== "object" || Array.isArray(preset.modelMap))) {
    errors.push("bad:modelMap");
  }
  if (preset.targets != null && (typeof preset.targets !== "object" || Array.isArray(preset.targets))) {
    errors.push("bad:targets");
  }
  for (const [id, target] of Object.entries(preset.targets || {})) {
    if (!target || typeof target !== "object") {
      errors.push(`bad:target:${id}`);
      continue;
    }
    const hasRates = Array.isArray(target.rates) && target.rates.length > 0;
    if (!hasRates) {
      errors.push(`no-rates:${id}`);
      continue;
    }
    errors.push(...validateRates([{ model: id, rates: target.rates }]));
  }
  return { ok: errors.length === 0, errors };
}
