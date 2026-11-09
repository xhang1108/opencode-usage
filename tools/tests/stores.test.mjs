import { test } from "node:test";
import assert from "node:assert/strict";

import {
  LOCAL_STORE_KEY,
  VENDOR_STORE_PREFIX,
  clearMessageFor,
  putRecord,
} from "../../extension/shared/stores.js";

// The Database tab lives or dies by this invariant: every managed store maps to
// exactly one clear message.
test("every managed store has a clear handler", () => {
  assert.deepEqual(clearMessageFor(LOCAL_STORE_KEY), { type: "clear-local-data" });
  assert.deepEqual(clearMessageFor(`${VENDOR_STORE_PREFIX}deepseek-official`), {
    type: "clear-vendor-data",
    source: "deepseek-official",
  });
});

test("clear handlers use message types the background implements", () => {
  const handled = new Set(["clear-local-data", "clear-vendor-data"]);
  for (const key of [LOCAL_STORE_KEY, `${VENDOR_STORE_PREFIX}mimo`]) {
    const msg = clearMessageFor(key);
    assert.ok(msg && handled.has(msg.type), `no background handler for ${key}`);
  }
});

test("unknown store keys have no clear handler", () => {
  assert.equal(clearMessageFor("vendor:"), null);
  assert.equal(clearMessageFor("nope"), null);
});

test("putRecord writes a __proto__ id as an own key (H1)", () => {
  const map = {};
  const rec = { id: "__proto__", model: "m", input: 1 };
  putRecord(map, "__proto__", rec);

  assert.equal(Object.prototype.hasOwnProperty.call(map, "__proto__"), true, "must be an own property");
  assert.ok(Object.keys(map).includes("__proto__"), "must be enumerable");
  assert.equal(map["__proto__"], rec);
});

test("putRecord keeps ordinary ids behaving normally", () => {
  const map = {};
  const rec = { id: "msg_1", model: "m" };
  putRecord(map, "msg_1", rec);
  assert.equal(map.msg_1, rec);
  assert.deepEqual(Object.keys(map), ["msg_1"]);
});
