import { test } from "node:test";
import assert from "node:assert/strict";

import { isSourceEnabled, enabledSources } from "../../extension/shared/sources.js";

test("isSourceEnabled: an explicit boolean wins over the default", () => {
  assert.equal(isSourceEnabled("openrouter", { openrouter: true }), true);
  assert.equal(isSourceEnabled("openrouter", { openrouter: false }), false);
  assert.equal(isSourceEnabled("opencode", { opencode: false }), false);
});

test("isSourceEnabled: unseeded installs keep only opencode on", () => {
  assert.equal(isSourceEnabled("opencode", {}), true);
  assert.equal(isSourceEnabled("", {}), true, "empty source is treated as opencode");
  assert.equal(isSourceEnabled(undefined, undefined), true);
  assert.equal(isSourceEnabled("mimo", {}), false);
});

test("enabledSources lists enabled registry vendors in registry order", () => {
  const registry = { vendors: [{ source: "opencode" }, { source: "openrouter" }, { source: "mimo" }] };
  assert.deepEqual(enabledSources({}, registry), ["opencode"]);
  assert.deepEqual(enabledSources({ openrouter: true }, registry), ["opencode", "openrouter"]);
  assert.deepEqual(enabledSources({ opencode: false, mimo: true }, registry), ["mimo"]);
  assert.deepEqual(enabledSources({}, null), []);
  assert.deepEqual(enabledSources({}, { vendors: [null, { source: "" }] }), []);
});

test("the store re-export resolves to the same rule", async () => {
  const store = await import("../../extension/dashboard/settings/store.js");
  assert.equal(store.isSourceEnabled, isSourceEnabled);
  assert.equal(store.enabledSources, enabledSources);
});
