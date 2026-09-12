// extension/shared/preset.js
// Assemble the final pricing tables from shipped presets + user overrides.
// Zero chrome dependencies (P9).
//
// Preset shape (vendors/<source>/rates.preset.json):
//   { source, modelMap: { "<source>:<raw>": targetId }, targets: { id: {...} } }
// userPricing shape (chrome.storage.local, user-authored):
//   { modelMap?: {...}, targets?: { id: { rates?/curatedRates?/label? } } }

export function buildPricing({ presets = [], userPricing = {}, priceChoice = {} } = {}) {
  const modelMap = {};
  const targets = {};
  for (const preset of presets) {
    if (!preset) continue;
    Object.assign(modelMap, preset.modelMap || {});
    for (const [id, target] of Object.entries(preset.targets || {})) {
      targets[id] = { ...(targets[id] || {}), ...target };
    }
  }
  const user = userPricing || {};
  for (const [id, target] of Object.entries(user.targets || {})) {
    targets[id] = { ...(targets[id] || {}), ...target };
  }
  Object.assign(modelMap, user.modelMap || {});
  return { modelMap, targets, priceChoice };
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
    const hasRates =
      (Array.isArray(target.rates) && target.rates.length > 0) ||
      (Array.isArray(target.curatedRates) && target.curatedRates.length > 0);
    if (!hasRates) errors.push(`no-rates:${id}`);
  }
  return { ok: errors.length === 0, errors };
}
