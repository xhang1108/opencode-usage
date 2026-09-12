#!/usr/bin/env node
// tools/build-manifest.mjs — generate extension/manifest.json host permissions
// from the vendor registry (shared/vendors.json).
//
// Default-enabled vendors' origins go into host_permissions (needed at startup);
// every other crawl vendor's origin goes into optional_host_permissions so the
// user is prompted only when they enable that vendor (B1/B2).
//
// Usage:
//   node tools/build-manifest.mjs           # write extension/manifest.json
//   node tools/build-manifest.mjs --check   # exit 1 if out of date (CI)

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const manifestPath = resolve(root, "extension/manifest.json");
const registryPath = resolve(root, "extension/shared/vendors.json");

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const registry = JSON.parse(readFileSync(registryPath, "utf8"));

const required = new Set(manifest.host_permissions || []);
const optional = new Set();
for (const vendor of registry.vendors || []) {
  for (const origin of vendor.origins || []) {
    if (required.has(origin)) continue;
    optional.add(origin);
  }
}

const optionalSorted = [...optional].sort();
const next = { ...manifest, optional_host_permissions: optionalSorted };

if (process.argv.includes("--check")) {
  const current = JSON.stringify(manifest.optional_host_permissions || []);
  const desired = JSON.stringify(optionalSorted);
  if (current !== desired) {
    console.error("manifest.json optional_host_permissions is out of date. Run: node tools/build-manifest.mjs");
    process.exit(1);
  }
  console.log("manifest.json is up to date");
} else {
  writeFileSync(manifestPath, JSON.stringify(next, null, 2) + "\n");
  console.log(`wrote ${manifestPath}`);
  console.log(`optional_host_permissions: ${optionalSorted.length ? optionalSorted.join(", ") : "(none)"}`);
}
