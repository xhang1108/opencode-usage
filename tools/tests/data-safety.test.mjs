// tools/tests/data-safety.test.mjs
// Data-safety invariants for the background record stores (plan §13).
//
// background.js is an MV3 service worker: it has no exports and registers its
// listeners on import. So this is deliberately NOT a pure-module test — we
// install a minimal chrome/fetch stub, load the real background.js AS IT SHIPS,
// and drive the registered onMessage listener exactly as the extension would.
// There is no other way to assert the import path never loses stored records.
//
// What is locked here (the §13.3 trap): the record stores must survive a
// snapshot refactor untouched. Only `cachedData` (a derived cache) may change or
// disappear; `cachedMeta` and `localImportMeta` are still expected to be written.
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { normalizeRecord } from "../../extension/shared/canonical.js";

const KEY_LOCAL = "localImportData";
const KEY_VENDOR = "opencodeImportData";
const KEY_LOCAL_META = "localImportMeta";
const KEY_CACHED = "cachedData";

// --- minimal chrome stub -----------------------------------------------------
// storage.local supports both the awaited and the callback form background.js
// uses; every other API is a tolerant no-op so the module's top-level wiring
// (alarms, update check, registry fetch) settles without touching the network.
function createChromeStub(registry) {
  const store = new Map();
  const writes = [];
  const listeners = { message: [], alarm: [], installed: [], startup: [], changed: [] };

  const read = (keys) => {
    if (keys == null) return Object.fromEntries(store);
    const list = Array.isArray(keys) ? keys : [keys];
    const out = {};
    for (const k of list) if (store.has(k)) out[k] = store.get(k);
    return out;
  };

  const local = {
    get(keys, cb) {
      const result = read(keys);
      if (typeof cb === "function") { cb(result); return undefined; }
      return Promise.resolve(result);
    },
    set(patch, cb) {
      writes.push(Object.keys(patch || {}));
      for (const [k, v] of Object.entries(patch || {})) {
        const oldValue = store.get(k);
        store.set(k, v);
        for (const fn of listeners.changed) fn({ [k]: { oldValue, newValue: v } }, "local");
      }
      if (typeof cb === "function") cb();
      return Promise.resolve();
    },
    remove(keys, cb) {
      for (const k of (Array.isArray(keys) ? keys : [keys])) store.delete(k);
      if (typeof cb === "function") cb();
      return Promise.resolve();
    },
  };

  const noop = () => {};
  const chrome = {
    runtime: {
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
      onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
      onStartup: { addListener: (fn) => listeners.startup.push(fn) },
      getURL: (p) => `chrome-extension://test/${p}`,
      getManifest: () => ({ version: "0.0.0-test" }),
    },
    storage: { local, onChanged: { addListener: (fn) => listeners.changed.push(fn) } },
    alarms: { clear: async () => true, create: noop, onAlarm: { addListener: (fn) => listeners.alarm.push(fn) } },
    action: { setBadgeText: noop, setBadgeBackgroundColor: noop },
    notifications: { create: noop },
    tabs: {
      query: async () => [],
      create: async () => ({ id: 1, url: "" }),
      get: async () => ({ id: 1, url: "" }),
      update: async () => {},
      remove: noop,
      sendMessage: async () => ({ ok: false }),
    },
    scripting: {
      executeScript: async () => {},
      getRegisteredContentScripts: async () => [],
      updateContentScripts: async () => {},
      registerContentScripts: async () => {},
      unregisterContentScripts: async () => {},
    },
    permissions: { contains: async () => true },
  };

  const fetchStub = async (url) => {
    const u = String(url);
    if (registry && u.includes("vendors.json")) {
      return { ok: true, status: 200, async json() { return registry; }, async text() { return JSON.stringify(registry); } };
    }
    return { ok: false, status: 404, async json() { return null; }, async text() { return ""; } };
  };

  return { chrome, fetch: fetchStub, store, listeners, writes };
}

const REGISTRY = {
  vendors: [
    {
      source: "opencode",
      label: "Opencode",
      crawl: true,
      crawlScript: "vendors/opencode/api.js",
      crawlHome: "https://opencode.ai/console",
      crawlDefaultDays: 0,
      defaultEnabled: true,
    },
  ],
};

let stub;
let send;

before(async () => {
  stub = createChromeStub(REGISTRY);
  globalThis.chrome = stub.chrome;
  globalThis.fetch = stub.fetch;
  await import("../../extension/background.js");
  // Let background.js's top-level async wiring (schema migration, registry
  // fetch) settle before the first message.
  await new Promise((r) => setTimeout(r, 0));
  const listener = stub.listeners.message[0];
  assert.equal(typeof listener, "function", "background.js must register an onMessage listener");
  send = (msg) =>
    new Promise((resolve, reject) => {
      try {
        listener(msg, {}, resolve);
      } catch (e) {
        reject(e);
      }
    });
});

beforeEach(() => {
  stub.store.clear();
  stub.writes.length = 0;
});

// --- helpers ----------------------------------------------------------------
const parse = (json) => JSON.parse(json);
const keysOf = (json) => Object.keys(parse(json)).sort();

function record(id, model, extra = {}) {
  return normalizeRecord({
    id,
    source: "opencode",
    model,
    time: "2026-06-01T10:00:00.000Z",
    workspaceID: "wrk_a",
    input: 100,
    ...extra,
  });
}

// --- tests ------------------------------------------------------------------
test("import-local-data preserves existing local and vendor records", async () => {
  stub.store.set(KEY_LOCAL, JSON.stringify({ msg_existing: record("msg_existing", "m-a", { input: 111 }) }));
  stub.store.set(KEY_VENDOR, JSON.stringify({ "opencode:vendor-1": record("opencode:vendor-1", "m-b", { input: 222 }) }));
  stub.store.set(KEY_LOCAL_META, { count: 1, updatedAt: 1 });

  const res = await send({
    type: "import-local-data",
    data: JSON.stringify({ msg_new: record("msg_new", "m-c", { input: 333 }) }),
  });

  assert.equal(res.ok, true, JSON.stringify(res));

  const local = parse(stub.store.get(KEY_LOCAL));
  assert.deepEqual(Object.keys(local).sort(), ["msg_existing", "msg_new"]);
  assert.equal(local.msg_existing.input, 111, "pre-existing local record must survive");
  assert.equal(local.msg_new.input, 333);

  const vendor = parse(stub.store.get(KEY_VENDOR));
  assert.deepEqual(Object.keys(vendor), ["opencode:vendor-1"], "vendor store must be untouched by a local import");
  assert.equal(vendor["opencode:vendor-1"].input, 222);

  const meta = stub.store.get(KEY_LOCAL_META);
  assert.equal(meta.count, Object.keys(local).length, "localImportMeta.count must match the store");
});

test("re-importing the same payload is idempotent (byte-stable records)", async () => {
  const payload = JSON.stringify({ msg_new: record("msg_new", "m-c", { input: 333 }) });

  const first = await send({ type: "import-local-data", data: payload });
  assert.equal(first.ok, true, JSON.stringify(first));
  const afterFirst = stub.store.get(KEY_LOCAL);

  const second = await send({ type: "import-local-data", data: payload });
  assert.equal(second.ok, true, JSON.stringify(second));

  assert.equal(stub.store.get(KEY_LOCAL), afterFirst, "a repeat import must not rewrite the record store");
  assert.equal(second.newRecords, 0, "no new records on the second import");
});

test("cachedData is a derived cache: its absence after import must not lose records", async () => {
  const res = await send({
    type: "import-local-data",
    data: JSON.stringify({ msg_new: record("msg_new", "m-c", { input: 333 }) }),
  });
  assert.equal(res.ok, true, JSON.stringify(res));

  // The record store is the source of truth and must exist.
  assert.ok(stub.store.has(KEY_LOCAL), "localImportData must be written");
  assert.deepEqual(keysOf(stub.store.get(KEY_LOCAL)), ["msg_new"]);

  // `cachedData` is optional by design — assert only that its presence/absence
  // does not remove any record store. (Before §5.2 it is written; after §5.2 it
  // may be absent. The test must pass in both worlds.)
  if (stub.store.has(KEY_CACHED)) {
    assert.equal(typeof stub.store.get(KEY_CACHED), "string", "cachedData is a JSON string when present");
  }
  assert.ok(stub.store.has(KEY_LOCAL_META), "localImportMeta must still be written");
});

test("vendor-crawl-data preserves existing vendor records (union, not replace)", async () => {
  stub.store.set(KEY_VENDOR, JSON.stringify({ "opencode:vendor-1": record("opencode:vendor-1", "m-b", { input: 222 }) }));

  const res = await send({
    type: "vendor-crawl-data",
    source: "opencode",
    records: [record("opencode:vendor-2", "m-d", { input: 444 })],
  });

  assert.equal(res.ok, true, JSON.stringify(res));
  const vendor = parse(stub.store.get(KEY_VENDOR));
  assert.deepEqual(Object.keys(vendor).sort(), ["opencode:vendor-1", "opencode:vendor-2"]);
  assert.equal(vendor["opencode:vendor-1"].input, 222, "pre-existing vendor record must survive");
  assert.equal(vendor["opencode:vendor-2"].input, 444);
});

test("open-dashboard reports a count, has no fromCache, and writes no cachedData", async () => {
  stub.store.set("cachedMeta", { count: 7, lastRecord: null, updatedAt: 1 });

  const res = await send({ type: "open-dashboard" });

  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(Object.prototype.hasOwnProperty.call(res, "fromCache"), false, "fromCache is retired (§5.3.1)");
  assert.equal(res.count, 7, "count comes from cachedMeta");
  assert.equal(
    stub.writes.some((keys) => keys.includes(KEY_CACHED)),
    false,
    "opening the dashboard must not rewrite the merged snapshot"
  );
});

test("import writes cachedMeta but no longer persists cachedData", async () => {
  const res = await send({
    type: "import-local-data",
    data: JSON.stringify({ msg_new: record("msg_new", "m-c", { input: 333 }) }),
  });

  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(stub.writes.some((keys) => keys.includes("cachedMeta")), "cachedMeta must still be refreshed");
  assert.ok(stub.writes.some((keys) => keys.includes(KEY_LOCAL_META)), "localImportMeta must still be written");
  assert.equal(
    stub.writes.some((keys) => keys.includes(KEY_CACHED)),
    false,
    "the merged snapshot must no longer be persisted"
  );
});

// NOTE (open decision, §5.4): background.js does NOT canonically normalize on
// read or write — only the vendor mappers / backup parser upstream do. The
// page-side normalize loop (§5.4 / Step 3) is therefore the ONLY reader-side
// guarantee, not redundant. Whether to move that guarantee to this boundary is
// pending confirmation; see the TDD plan Step 3.

