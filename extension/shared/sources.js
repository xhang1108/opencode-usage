// extension/shared/sources.js
// Which vendors are enabled, and the per-source enable rules. Shared by the
// dashboard settings store and the popup's crawl picker so one rule decides
// everywhere (a vendor defaults off unless the user enabled it; opencode is the
// one legacy default that stays on when unseeded). Pure: no chrome, no DOM.

// D9: vendors default off unless the registry seeds otherwise; unseeded legacy
// installs keep opencode visible.
export function isSourceEnabled(source, vendorSettings) {
  const src = source || "opencode";
  const explicit = (vendorSettings || {})[src];
  if (explicit === false) return false;
  if (explicit === true) return true;
  return src === "opencode";
}

// The enabled sources, in registry order (unknown registry -> []).
export function enabledSources(vendorSettings, registry) {
  const list = (registry && registry.vendors) || [];
  return list.filter((v) => v && v.source && isSourceEnabled(v.source, vendorSettings)).map((v) => v.source);
}
