// extension/dashboard/settings/store.js
// chrome.storage.local IO for the dashboard settings pages. Values are
// normalized on read so callers never deal with malformed blobs. Fallback
// presets ship as static JSON under vendors/<source>/rates.preset.json and the
// unified pricelist default ships at shared/unified.preset.json; both are
// fetched on demand (extension pages can read their own resources directly).

import { buildPricing } from "../../shared/preset.js";
import { normalizeUnifiedPricing } from "../../shared/unified.js";

export const STORAGE_KEYS = {
  registry: "vendorRegistry",
  vendors: "vendorSettings",
  unified: "unifiedPricing",
  defaultCrawl: "defaultCrawl",
  workspaceLabels: "workspaceLabels",
  unmappedFirstSeen: "unmappedFirstSeen",
};

const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const asObject = (v) => (isPlainObject(v) ? { ...v } : {});

export async function readSettings() {
  const stored = await chrome.storage.local.get(Object.values(STORAGE_KEYS));
  const rawUnified = stored[STORAGE_KEYS.unified];
  return {
    registry: isPlainObject(stored[STORAGE_KEYS.registry]) ? stored[STORAGE_KEYS.registry] : { vendors: [] },
    vendorSettings: asObject(stored[STORAGE_KEYS.vendors]),
    unifiedPricing: normalizeUnifiedPricing(rawUnified),
    // True when the user has a pricelist of their own; false means "use the
    // shipped default". Distinguishes "empty pricelist" from "never authored".
    unifiedStored: rawUnified != null,
    defaultCrawl: typeof stored[STORAGE_KEYS.defaultCrawl] === "string" ? stored[STORAGE_KEYS.defaultCrawl] : "",
    workspaceLabels: asObject(stored[STORAGE_KEYS.workspaceLabels]),
    unmappedFirstSeen: asObject(stored[STORAGE_KEYS.unmappedFirstSeen]),
  };
}

export async function saveVendorSettings(vendorSettings) {
  await chrome.storage.local.set({ [STORAGE_KEYS.vendors]: asObject(vendorSettings) });
}

export async function saveUnifiedPricing(unifiedPricing) {
  await chrome.storage.local.set({ [STORAGE_KEYS.unified]: normalizeUnifiedPricing(unifiedPricing) });
}

export async function saveDefaultCrawl(source) {
  await chrome.storage.local.set({ [STORAGE_KEYS.defaultCrawl]: String(source || "") });
}

export async function saveWorkspaceLabels(map) {
  await chrome.storage.local.set({ [STORAGE_KEYS.workspaceLabels]: asObject(map) });
}

// B7: first time each unmapped `model` was seen, so the badge can show age.
export async function saveUnmappedFirstSeen(map) {
  await chrome.storage.local.set({ [STORAGE_KEYS.unmappedFirstSeen]: asObject(map) });
}

// D9: vendors default off unless the registry seeds otherwise; unseeded legacy
// installs keep opencode visible.
export function isSourceEnabled(source, vendorSettings) {
  const src = source || "opencode";
  const explicit = (vendorSettings || {})[src];
  if (explicit === false) return false;
  if (explicit === true) return true;
  return src === "opencode";
}

export function enabledSources(vendorSettings, registry) {
  const list = (registry && registry.vendors) || [];
  return list.filter((v) => v && v.source && isSourceEnabled(v.source, vendorSettings)).map((v) => v.source);
}

async function fetchJSON(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

// Fetch every available fallback preset (missing ones are skipped, not fatal).
export async function loadPresets(sources) {
  const presets = [];
  await Promise.all(
    (sources || []).map(async (source) => {
      const preset = await fetchJSON(chrome.runtime.getURL(`vendors/${source}/rates.preset.json`));
      if (preset && preset.source) presets.push(preset);
    })
  );
  return presets;
}

// The shipped default unified pricelist (authors maintain it in the repo).
export async function loadUnifiedPreset() {
  return normalizeUnifiedPricing(await fetchJSON(chrome.runtime.getURL("shared/unified.preset.json")));
}

// Assemble the live fallback pricing config from shipped presets.
export async function loadPricing(settings) {
  const registrySources = ((settings && settings.registry && settings.registry.vendors) || [])
    .map((v) => v && v.source)
    .filter(Boolean);
  const presets = await loadPresets(registrySources.length ? registrySources : ["opencode"]);
  return buildPricing({ presets });
}
