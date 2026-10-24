import { test } from "node:test";
import assert from "node:assert/strict";

// store.js talks to chrome.storage.local; a tiny in-memory stand-in keeps the
// backup/undo contract testable without a browser.
const mem = {};
globalThis.chrome = {
  runtime: { getURL: (p) => p },
  storage: {
    local: {
      async set(obj) {
        Object.assign(mem, obj);
      },
      async get(keys) {
        if (typeof keys === "string") return { [keys]: mem[keys] };
        const out = {};
        for (const k of keys || []) out[k] = mem[k];
        return out;
      },
    },
  },
};

const { saveUnifiedPricing, saveUnifiedPricingBackup, loadUnifiedPricingBackup, STORAGE_KEYS } = await import(
  "../../extension/dashboard/settings/store.js"
);

test("the replaced price list round-trips through the undo slot", async () => {
  const stored = { enabled: true, groups: [{ id: "mine", rates: [] }], assign: { "opencode:a": "mine" } };
  await saveUnifiedPricing(stored);
  await saveUnifiedPricingBackup(stored);
  assert.deepEqual(await loadUnifiedPricingBackup(), stored);
});

test("no backup yet reads as null instead of an empty list", async () => {
  delete mem[STORAGE_KEYS.unifiedPrev];
  assert.equal(await loadUnifiedPricingBackup(), null);
});

test("the backup is normalized like the live list (dangling assignments dropped)", async () => {
  mem[STORAGE_KEYS.unifiedPrev] = { enabled: false, groups: [{ id: "g1", rates: [] }], assign: { "opencode:a": "gone" } };
  const backup = await loadUnifiedPricingBackup();
  assert.equal(backup.enabled, false);
  assert.deepEqual(backup.assign, {});
});
