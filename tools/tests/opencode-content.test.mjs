import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createClock,
  createOpfs,
  createSandbox,
  loadScript,
  makeFetch,
  pageOf,
  readExtensionFile,
  flightRecord,
  usagePage,
  emptyUsagePage,
  waitFor,
} from "./helpers/browser-harness.mjs";

const CONTENT = readExtensionFile("vendors/opencode/content.js");
const WORKER = readExtensionFile("vendors/opencode/crawl-worker.js");
const WS = "wrk_demo";
const PATH = `/workspace/${WS}/usage`;

// Boot content.js in a sandbox with the page/extension globals it touches.
function loadContent({ pages = {}, workerThrows = true } = {}) {
  const clock = createClock();
  const opfs = createOpfs(clock);
  const store = {};
  const sent = [];
  const requests = [];
  const windowEvents = {};
  let runtimeListener = null;

  const fetch = makeFetch((req) => {
    requests.push(req);
    if (req.url.includes("crawl-worker.js")) return { status: 200, text: WORKER };
    if (req.url.includes("/_server")) {
      const page = pageOf(req.body);
      return { status: 200, text: pages[page] ?? emptyUsagePage() };
    }
    return undefined;
  });

  const chrome = {
    runtime: {
      sendMessage: (msg) => { sent.push(msg); return Promise.resolve({ ok: true }); },
      onMessage: { addListener: (fn) => { runtimeListener = fn; }, removeListener: () => {} },
      getURL: (p) => `chrome-extension://test/${p}`,
      getManifest: () => ({ version: "1.0.0" }),
    },
    storage: {
      local: {
        get: async (keys) => {
          if (keys == null) return { ...store };
          const arr = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const k of arr) if (k in store) out[k] = store[k];
          return out;
        },
        set: async (obj) => { Object.assign(store, obj); },
        remove: async (key) => { for (const k of [].concat(key)) delete store[k]; },
      },
    },
  };

  const windowObj = {
    __opencodeExtContentLoaded: false,
    location: { pathname: PATH },
    addEventListener: (type, fn) => { (windowEvents[type] ||= []).push(fn); },
    removeEventListener: () => {},
    postMessage: () => {},
  };

  const { context, logs } = createSandbox({
    clock,
    opfs,
    fetch,
    extra: {
      window: windowObj,
      document: { querySelector: () => null, querySelectorAll: () => [] },
      history: { pushState() {}, replaceState() {} },
      chrome,
      Worker: workerThrows
        ? class { constructor() { throw new Error("Worker blocked by CSP"); } }
        : class { constructor() { throw new Error("not stubbed"); } },
      URL: { createObjectURL: () => "blob:fake", revokeObjectURL() {} },
      Blob,
      Headers,
    },
  });
  loadScript(context, CONTENT, "content.js");

  const emitRuntime = (msg) =>
    new Promise((resolve) => {
      let answered = false;
      const ret = runtimeListener(msg, {}, (r) => { answered = true; resolve(r); });
      if (ret !== true) queueMicrotask(() => { if (!answered) resolve(ret); });
    });

  const emitWindow = (data) => {
    for (const fn of windowEvents.message || []) fn({ source: windowObj, data });
  };

  return { clock, opfs, store, sent, requests, logs, windowObj, emitRuntime, emitWindow };
}

test("content.js exports a merged, workspace-tagged JSON across cache files", async () => {
  const h = loadContent();
  h.opfs.seed("opencode_token_cache_wrk_a.json", { r1: { model: "m", time: "2026-09-01T00:00:00.000Z", date: "2026-09-01", input: 1 } });
  h.opfs.seed("opencode_token_cache_wrk_b.json", { r2: { model: "m", time: "2026-09-05T00:00:00.000Z", date: "2026-09-05", input: 2 } });
  h.opfs.seed("notes.txt", { not: "a cache" });

  const res = await h.emitRuntime({ type: "export-json" });
  assert.equal(res.ok, true);
  assert.equal(res.count, 2);
  assert.equal(res.fileCount, 2);
  const data = JSON.parse(res.data);
  assert.equal(data.r1.workspaceID, "wrk_a"); // inferred from the filename
  assert.equal(data.r2.workspaceID, "wrk_b");
  assert.equal(res.lastRecord.time, "2026-09-05T00:00:00.000Z"); // newest by time
});

test("content.js caches the merged export until a cache file changes", async () => {
  const h = loadContent();
  h.opfs.seed("opencode_token_cache_wrk_a.json", { r1: { model: "m", time: "2026-09-01T00:00:00.000Z", date: "2026-09-01" } });

  const first = await h.emitRuntime({ type: "export-json" });
  const second = await h.emitRuntime({ type: "export-json" });
  assert.equal(second.data, first.data); // served from the fingerprint cache

  h.opfs.seed("opencode_token_cache_wrk_a.json", {
    r1: { model: "m", time: "2026-09-01T00:00:00.000Z", date: "2026-09-01" },
    r3: { model: "m", time: "2026-09-02T00:00:00.000Z", date: "2026-09-02" },
  });
  const third = await h.emitRuntime({ type: "export-json" });
  assert.equal(third.count, 2);
  assert.ok(JSON.parse(third.data).r3);
});

test("content.js get-status reports the overview", async () => {
  const h = loadContent();
  h.opfs.seed("opencode_token_cache_wrk_a.json", { r1: { model: "m", time: "2026-09-01T00:00:00.000Z", date: "2026-09-01" } });
  const res = await h.emitRuntime({ type: "get-status" });
  assert.equal(res.ok, true);
  assert.equal(res.totalRecords, 1);
  assert.equal(res.files.length, 1);
});

test("content.js records a captured server id into storage", async () => {
  const h = loadContent();
  await h.emitRuntime({ type: "server-id", serverID: "srv_1" });
  await waitFor(() => h.store.lastServerID === "srv_1");
  assert.equal(h.store.lastServerIDWorkspace, WS);
});

test("content.js falls back to the main-thread crawl when the worker cannot start", async () => {
  const h = loadContent({
    pages: { 0: usagePage([flightRecord({ id: "rec_1", timeCreated: "2026-09-10T12:00:00.000Z", input: 100, output: 60, reasoning: 10, cacheRead: 5 })]) },
  });
  await h.emitRuntime({ type: "server-id", serverID: "srv_x" });
  const started = await h.emitRuntime({ type: "start-crawl" });
  assert.equal(started.ok, true);

  const file = `opencode_token_cache_${WS}.json`;
  await waitFor(() => h.opfs.read(file)?.rec_1);
  const rec = h.opfs.read(file).rec_1;
  assert.equal(rec.input, 100);
  assert.equal(rec.output, 50); // inclusive console output minus reasoning
  assert.equal(rec.reasoning, 10);
  assert.equal(rec.cacheRead, 5);
  assert.equal(rec.workspaceID, WS);
  assert.ok(h.logs.some((l) => /worker unavailable/.test(l)));
  assert.ok(h.sent.some((m) => m.type === "crawl-done"));
});

test("content.js builds crawl bodies from the observed request template", async () => {
  const template = JSON.stringify({ t: { t: 9, i: 0, l: 2, a: [{ t: 1, s: "wrk_old" }, { t: 0, s: 5 }], o: 0 }, f: 77, m: [] });
  const h = loadContent({
    pages: { 0: usagePage([flightRecord({ id: "rec_1", timeCreated: "2026-09-10T12:00:00.000Z" })]) },
  });
  h.emitWindow({ source: "opencode-master", type: "server-payload", serverID: "srv_t", f: 77, body: template, at: Date.now() });
  await waitFor(() => h.store.lastServerPayload?.f === 77);

  await h.emitRuntime({ type: "start-crawl" });
  const file = `opencode_token_cache_${WS}.json`;
  await waitFor(() => h.opfs.read(file)?.rec_1);

  const serverPosts = h.requests.filter((r) => r.url.includes("/_server"));
  assert.ok(serverPosts.length > 0);
  const parsed = serverPosts.map((r) => JSON.parse(r.body));
  assert.ok(parsed.every((b) => b.f === 77));
  assert.ok(parsed.some((b) => b.t.a.some((a) => a.t === 1 && a.s === WS)));
  assert.ok(!JSON.stringify(parsed).includes("wrk_old"));
  assert.ok(parsed.some((b) => b.t.a.some((a) => a.t === 0 && a.s === 0)));
});

test("content.js falls back to the built-in body shape without a template", async () => {
  const h = loadContent({
    pages: { 0: usagePage([flightRecord({ id: "rec_1", timeCreated: "2026-09-10T12:00:00.000Z" })]) },
  });
  await h.emitRuntime({ type: "server-id", serverID: "srv_x" });
  await h.emitRuntime({ type: "start-crawl" });
  const file = `opencode_token_cache_${WS}.json`;
  await waitFor(() => h.opfs.read(file)?.rec_1);

  const body = JSON.parse(h.requests.find((r) => r.url.includes("/_server")).body);
  assert.equal(body.f, 31);
  assert.ok(body.t.a.some((a) => a.t === 1 && a.s === WS));
});
