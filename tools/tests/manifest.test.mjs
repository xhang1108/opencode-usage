import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ext = path.join(root, "extension");
const readJSON = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const exists = (rel) => fs.existsSync(path.join(ext, rel));

function loadVendors() {
  const dir = path.join(ext, "vendors");
  return fs
    .readdirSync(dir)
    .filter((d) => fs.existsSync(path.join(dir, d, "vendor.json")))
    .map((d) => readJSON(path.join(dir, d, "vendor.json")));
}

test("manifest permissions and content scripts match vendor.json (B1/B2)", () => {
  const manifest = readJSON(path.join(ext, "manifest.json"));
  const registry = readJSON(path.join(ext, "shared/vendors.json"));
  const staticScripts = manifest.content_scripts.map((c) => c.js[0]);

  for (const v of loadVendors()) {
    for (const origin of v.origins || []) {
      const required = manifest.host_permissions.includes(origin);
      const optional = manifest.optional_host_permissions.includes(origin);
      if (v.defaultEnabled === true) {
        assert.ok(required, `${v.source} default origin must be required: ${origin}`);
        assert.ok(!optional, `${v.source} default origin must not be optional: ${origin}`);
      } else {
        assert.ok(optional, `${v.source} non-default origin must be optional: ${origin}`);
        assert.ok(!required, `${v.source} non-default origin must not be required: ${origin}`);
      }
    }

    const script = v.crawl && v.crawl.contentScript;
    if (script) {
      assert.ok(exists(script), `${v.source} content script missing on disk: ${script}`);
      if (v.defaultEnabled === true) {
        assert.ok(staticScripts.includes(script), `${v.source} default content script must be static`);
      } else {
        assert.ok(!staticScripts.includes(script), `${v.source} non-default content script must be runtime-registered`);
      }
    }

    const reg = registry.vendors.find((x) => x.source === v.source);
    assert.ok(reg, `registry missing vendor ${v.source}`);
    assert.equal(reg.defaultEnabled, v.defaultEnabled === true, `${v.source} defaultEnabled drift`);
    if (script) {
      assert.equal(reg.crawlScript, script, `${v.source} crawlScript drift`);
      assert.ok(reg.crawlRunAt, `${v.source} crawlRunAt missing`);
    }
  }
});

test("every web_accessible_resource file exists", () => {
  const manifest = readJSON(path.join(ext, "manifest.json"));
  for (const entry of manifest.web_accessible_resources || []) {
    for (const r of entry.resources || []) {
      assert.ok(exists(r), `missing web_accessible_resource: ${r}`);
    }
  }
});
