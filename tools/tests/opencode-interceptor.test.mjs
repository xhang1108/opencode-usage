import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createClock,
  createOpfs,
  createSandbox,
  loadScript,
  readExtensionFile,
} from "./helpers/browser-harness.mjs";

const INTERCEPTOR = readExtensionFile("vendors/opencode/interceptor.js");

const USAGE_BODY = JSON.stringify({
  t: { t: 9, i: 0, l: 2, a: [{ t: 1, s: "wrk_abc" }, { t: 0, s: 0 }], o: 0 },
  f: 31,
  m: [],
});

// Install interceptor.js into a sandbox whose window.fetch it wraps.
function load() {
  const captures = [];
  const calls = [];
  const clock = createClock();
  const opfs = createOpfs(clock);
  const baseFetch = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200, async text() { return ""; }, async json() { return null; } };
  };
  const windowObj = {
    __opencodeMasterInterceptor: false,
    fetch: baseFetch,
    postMessage: (msg) => captures.push(msg),
  };
  const { context } = createSandbox({ clock, opfs, fetch: baseFetch, extra: { window: windowObj, Headers } });
  loadScript(context, INTERCEPTOR, "interceptor.js");
  return { window: windowObj, captures, calls, baseFetch };
}

const captureTypes = (captures) => captures.map((c) => c.type);

test("captures server-id and the request template from a usage list query", () => {
  const { window, captures, calls } = load();
  window.fetch("https://opencode.ai/_server", { body: USAGE_BODY, headers: { "x-server-id": "srv_123" } });

  assert.deepEqual(captureTypes(captures), ["server-id", "server-payload"]);
  assert.deepEqual({ ...captures[0] }, { source: "opencode-master", type: "server-id", serverID: "srv_123" });
  assert.equal(captures[1].serverID, "srv_123");
  assert.equal(captures[1].f, 31);
  assert.equal(captures[1].body, USAGE_BODY);
  assert.ok(typeof captures[1].at === "number");
  // The wrapped call still reaches the original fetch.
  assert.equal(calls.length, 1);
});

test("finds the server id case-insensitively through a Headers instance", () => {
  const { window, captures } = load();
  window.fetch("https://opencode.ai/_server", { body: USAGE_BODY, headers: new Headers({ "X-Server-Id": "srv_head" }) });
  assert.equal(captures[0].serverID, "srv_head");
});

test("still captures the template when no server id header is present", () => {
  const { window, captures } = load();
  window.fetch("https://opencode.ai/_server", { body: USAGE_BODY, headers: {} });
  assert.deepEqual(captureTypes(captures), ["server-payload"]);
  assert.equal(captures[0].serverID, null);
});

test("ignores bodies that are not usage list queries", () => {
  const { window, captures } = load();
  // Workspace arg but no numeric page arg.
  window.fetch("https://opencode.ai/_server", { body: JSON.stringify({ f: 31, t: { a: [{ t: 1, s: "wrk_abc" }] } }), headers: { "x-server-id": "s" } });
  // Page arg is a string, not a number.
  window.fetch("https://opencode.ai/_server", { body: JSON.stringify({ f: 31, t: { a: [{ t: 1, s: "wrk_abc" }, { t: 0, s: "2" }] } }), headers: { "x-server-id": "s" } });
  // No function index.
  window.fetch("https://opencode.ai/_server", { body: JSON.stringify({ t: { a: [{ t: 1, s: "wrk_abc" }, { t: 0, s: 0 }] } }), headers: { "x-server-id": "s" } });
  assert.deepEqual(captures, []);
});

test("ignores non-/_server URLs and non-string bodies", () => {
  const { window, captures } = load();
  window.fetch("https://opencode.ai/api/other", { body: USAGE_BODY, headers: { "x-server-id": "s" } });
  window.fetch("https://opencode.ai/_server", { body: new FormData(), headers: { "x-server-id": "s" } });
  assert.deepEqual(captures, []);
});

test("is idempotent across reinjection (one wrapper, one capture per call)", () => {
  const { window, captures, calls } = load();
  const wrapped = window.fetch;
  // Simulate a second injection into the same page world.
  const clock = createClock();
  const opfs = createOpfs(clock);
  const { context } = createSandbox({ clock, opfs, fetch: window.fetch, extra: { window, Headers } });
  loadScript(context, INTERCEPTOR, "interceptor.js");
  assert.equal(window.fetch, wrapped);

  window.fetch("https://opencode.ai/_server", { body: USAGE_BODY, headers: { "x-server-id": "srv_x" } });
  assert.deepEqual(captureTypes(captures), ["server-id", "server-payload"]);
  assert.equal(calls.length, 1);
});
