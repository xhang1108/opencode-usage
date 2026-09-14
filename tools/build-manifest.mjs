#!/usr/bin/env node
// tools/build-manifest.mjs — generate extension/manifest.json's vendor sections
// and extension/shared/vendors.json from the per-vendor descriptor files
// (extension/vendors/<source>/vendor.json). Those descriptors are the single
// source of truth; never hand-edit the generated arrays.
//
// Generated in manifest.json:
//   * host_permissions           — core hosts + every vendor origin (static
//                                  content_scripts need them at install)
//   * content_scripts            — each crawl vendor's contentScript (B2)
//   * web_accessible_resources   — each crawl vendor's dynamically imported files
// Generated: shared/vendors.json (the runtime registry).
//
// NOTE: optional_host_permissions stays empty until vendor content scripts are
// registered at runtime (B1/B2); with static content_scripts the origins are
// required at install, so listing them as optional would be misleading.
//
// Usage:
//   node tools/build-manifest.mjs           # write
//   node tools/build-manifest.mjs --check   # exit 1 if out of date (CI)

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const vendorsDir = resolve(root, "extension/vendors");
const manifestPath = resolve(root, "extension/manifest.json");
const registryPath = resolve(root, "extension/shared/vendors.json");

// Hosts the core (not a data vendor) talks to; always requested at install.
const CORE_HOSTS = ["https://api.github.com/*"];

function loadVendors() {
  return readdirSync(vendorsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(vendorsDir, d.name, "vendor.json")))
    .map((d) => JSON.parse(readFileSync(join(vendorsDir, d.name, "vendor.json"), "utf8")))
    .sort((a, b) => a.source.localeCompare(b.source));
}

function buildVendorSections(vendors) {
  const host = new Set(CORE_HOSTS);
  const contentScripts = [];
  const war = [];
  for (const v of vendors) {
    const origins = v.origins || [];
    if (origins.length === 0) continue;
    for (const o of origins) host.add(o);

    const crawl = v.crawl || {};
    if (crawl.contentScript) {
      contentScripts.push({
        matches: origins,
        js: [crawl.contentScript],
        run_at: crawl.runAt || "document_idle",
      });
    }
    const resources = [...(crawl.webAccessible || []), ...(crawl.worker ? [crawl.worker] : [])];
    if (resources.length > 0) war.push({ resources, matches: origins });
  }
  return {
    host_permissions: [...host].sort(),
    optional_host_permissions: [],
    content_scripts: contentScripts,
    web_accessible_resources: war,
  };
}

function buildRegistry(vendors) {
  return {
    registryVersion: 1,
    vendors: vendors.map((v) => ({
      source: v.source,
      label: v.label,
      mode: v.mode,
      defaultEnabled: v.defaultEnabled === true,
      crawl: !!v.crawl,
      ...(v.crawl && v.crawl.everyDays ? { crawlEveryDays: v.crawl.everyDays } : {}),
      ...(v.crawl ? { crawlScript: v.crawl.contentScript, crawlHome: v.crawl.home, crawlDefaultDays: v.crawl.defaultDays || 0 } : {}),
      ...(v.costSource ? { costSource: v.costSource } : {}),
      import: v.import || [],
      origins: v.origins || [],
    })),
  };
}

const vendors = loadVendors();
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const sections = buildVendorSections(vendors);
const nextManifest = { ...manifest, ...sections };
const nextRegistry = buildRegistry(vendors);

const manifestOut = JSON.stringify(nextManifest, null, 2) + "\n";
const registryOut = JSON.stringify(nextRegistry, null, 2) + "\n";

if (process.argv.includes("--check")) {
  const stale = [];
  if (manifestOut !== readFileSync(manifestPath, "utf8")) stale.push("extension/manifest.json");
  if (registryOut !== readFileSync(registryPath, "utf8")) stale.push("extension/shared/vendors.json");
  if (stale.length > 0) {
    console.error(`Out of date: ${stale.join(", ")}. Run: node tools/build-manifest.mjs`);
    process.exit(1);
  }
  console.log("manifest.json and vendors.json are up to date");
} else {
  writeFileSync(manifestPath, manifestOut);
  writeFileSync(registryPath, registryOut);
  console.log(`wrote ${manifestPath}`);
  console.log(`wrote ${registryPath}`);
  console.log(`vendors=${vendors.length} optional_host_permissions=${sections.optional_host_permissions.length}`);
}
