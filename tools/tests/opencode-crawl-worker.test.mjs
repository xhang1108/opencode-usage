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
  legacyRecord,
  usagePage,
  emptyUsagePage,
} from "./helpers/browser-harness.mjs";

const WORKER = readExtensionFile("vendors/opencode/crawl-worker.js");
const WS = "wrk_demo";
const FILE = `opencode_token_cache_${WS}.json`;

// Drive the shipped crawl worker through a full onmessage cycle in a sandbox.
async function runWorker({ pages, route, opfs: seeded, forceRescan = false, workspaceID = WS, payloadTemplate = null } = {}) {
  const clock = createClock();
  const opfs = createOpfs(clock);
  for (const [name, obj] of Object.entries(seeded || {})) opfs.seed(name, obj);

  const routes = route || ((req) => {
    if (!req.url.includes("/_server")) return undefined;
    const page = pageOf(req.body);
    return { status: 200, text: pages[page] ?? emptyUsagePage() };
  });
  const fetch = makeFetch(routes);

  const posts = [];
  const { context, logs } = createSandbox({ clock, opfs, fetch, onPost: (m) => posts.push(m) });
  loadScript(context, WORKER, "crawl-worker.js");

  await context.onmessage({
    data: {
      workspaceID,
      serverID: "srv_test",
      forceRescan,
      filename: `opencode_token_cache_${workspaceID}.json`,
      payloadTemplate,
    },
  });

  return {
    opfs,
    logs,
    posts,
    file: `opencode_token_cache_${workspaceID}.json`,
    done: posts.find((p) => p.type === "done")?.result || null,
    error: posts.find((p) => p.type === "error")?.message || null,
  };
}

const SEED_REC = {
  workspaceID: WS,
  time: "2026-09-01T00:00:00.000Z",
  date: "2026-09-01",
  model: "deepseek-chat",
  input: 1,
  output: 1,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
};

test("worker parses a usage page into the canonical OPFS cache", async () => {
  const pages = {
    0: usagePage([
      flightRecord({ id: "rec_1", timeCreated: "2026-09-10T12:00:00.000Z", input: 100, output: 60, reasoning: 10, cacheRead: 5, cacheWrite5m: 2, cacheWrite1h: 1, keyID: "key_9", sessionID: "ses_9", plan: "pro" }),
      flightRecord({ id: "rec_2", timeCreated: "2026-09-11T12:00:00.000Z", input: 10, output: 5 }),
    ]),
  };
  const { opfs, file, done, error } = await runWorker({ pages });

  assert.equal(error, null);
  assert.equal(done.total, 2);
  assert.equal(done.newRecords, 2);
  // newTokens sums input + inclusive output + cache fields of new records only.
  assert.equal(done.newTokens, 100 + 60 + 5 + 2 + 1 + (10 + 5));
  assert.equal(done.serverEmpty, false);

  const cache = opfs.read(file);
  const r1 = cache.rec_1;
  assert.equal(r1.workspaceID, WS);
  assert.equal(r1.time, "2026-09-10T12:00:00.000Z");
  assert.match(r1.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(r1.model, "deepseek/deepseek-v4.1-flash");
  assert.equal(r1.provider, "opencode");
  assert.equal(r1.input, 100);
  // Console outputTokens (60) is inclusive of reasoning (10): stored output excludes it.
  assert.equal(r1.output, 50);
  assert.equal(r1.reasoning, 10);
  assert.equal(r1.outputExcludesReasoning, true);
  assert.equal(r1.cacheRead, 5);
  assert.equal(r1.cacheWrite5m, 2);
  assert.equal(r1.cacheWrite1h, 1);
  assert.equal(r1.keyID, "key_9");
  assert.equal(r1.sessionID, "ses_9");
  assert.equal(r1.plan, "pro");
  assert.equal(r1.costMultiplier, 1);
  assert.equal(r1.costScale, 1e8);
  assert.equal(cache.rec_2.output, 5);
});

test("worker stops at a fully-synced page without rewriting cached records", async () => {
  const cached = { ...SEED_REC, time: "2026-09-10T12:00:00.000Z", model: "deepseek/deepseek-v4.1-flash" };
  const pages = {
    0: usagePage([flightRecord({ id: "rec_1", timeCreated: "2026-09-10T12:00:00.000Z", input: 999, output: 999 })]),
  };
  const { opfs, file, done, error } = await runWorker({ pages, opfs: { [FILE]: { rec_1: cached } } });

  assert.equal(error, null);
  assert.equal(done.newRecords, 0);
  assert.match(done.stopReason, /fully synced/);
  // The already-synced record was not overwritten (still the cached tokens).
  assert.equal(opfs.read(file).rec_1.input, 1);
});

test("forceRescan rewrites records that are already fully synced", async () => {
  const cached = { ...SEED_REC, time: "2026-09-10T12:00:00.000Z" };
  const pages = {
    0: usagePage([flightRecord({ id: "rec_1", timeCreated: "2026-09-10T12:00:00.000Z", input: 999, sessionID: "ses_new" })]),
  };
  const { opfs, file, done, error } = await runWorker({ pages, opfs: { [FILE]: { rec_1: cached } }, forceRescan: true });

  assert.equal(error, null);
  assert.equal(done.newRecords, 0); // existed, so not "new" — but overwritten
  assert.doesNotMatch(done.stopReason, /fully synced/);
  assert.equal(opfs.read(file).rec_1.input, 999);
  assert.equal(opfs.read(file).rec_1.sessionID, "ses_new");
});

test("worker drops soft-deleted records from the cache", async () => {
  const pages = {
    0: usagePage([flightRecord({ id: "rec_1", timeCreated: "2026-09-10T12:00:00.000Z", timeDeleted: "2026-09-11T12:00:00.000Z" })]),
  };
  const { opfs, file, done, error } = await runWorker({ pages, opfs: { [FILE]: { rec_1: SEED_REC } } });

  assert.equal(error, null);
  assert.equal(done.total, 0);
  assert.equal(opfs.read(file).rec_1, undefined);
});

test("worker still parses the legacy record shape with null backfills", async () => {
  const pages = { 0: usagePage([legacyRecord({ id: "leg_1", timeCreated: "2026-08-01T00:00:00.000Z", input: 7, output: 9, reasoning: 4, cacheRead: 3 })]), };
  const { opfs, file, done, error } = await runWorker({ pages });

  assert.equal(error, null);
  assert.equal(done.total, 1);
  const rec = opfs.read(file).leg_1;
  assert.equal(rec.model, "deepseek-chat");
  assert.equal(rec.provider, null);
  assert.equal(rec.input, 7);
  assert.equal(rec.output, 5); // 9 inclusive - 4 reasoning
  assert.equal(rec.reasoning, 4);
  assert.equal(rec.cacheRead, 3);
  assert.equal(rec.keyID, null);
  assert.equal(rec.sessionID, null);
  assert.equal(rec.outputExcludesReasoning, true);
});

test("worker starts at page 1 when page 0 is an empty usage envelope", async () => {
  const pages = {
    0: emptyUsagePage(),
    1: usagePage([flightRecord({ id: "rec_1", timeCreated: "2026-09-10T12:00:00.000Z", input: 42 })]),
  };
  const { file, opfs, done, error } = await runWorker({ pages });

  assert.equal(error, null);
  assert.equal(done.total, 1);
  assert.equal(opfs.read(file).rec_1.input, 42);
});

test("a valid empty envelope marks serverEmpty and leaves the cache intact", async () => {
  const { opfs, file, done, error } = await runWorker({
    pages: { 0: emptyUsagePage() },
    opfs: { [FILE]: { rec_1: SEED_REC } },
  });

  assert.equal(error, null);
  assert.equal(done.serverEmpty, true);
  assert.match(done.stopReason, /no usage records/);
  assert.equal(opfs.read(file).rec_1.input, 1); // kept, not zeroed
});

test("worker retries HTTP 429 then completes the page", async () => {
  let calls = 0;
  const route = (req) => {
    if (!req.url.includes("/_server")) return undefined;
    calls++;
    if (calls <= 2) return { status: 429, text: "slow down" };
    const page = pageOf(req.body);
    return { status: 200, text: page === 0 ? usagePage([flightRecord({ id: "rec_1", timeCreated: "2026-09-10T12:00:00.000Z" })]) : emptyUsagePage() };
  };
  const { done, error, posts } = await runWorker({ route });

  assert.equal(error, null);
  assert.equal(done.total, 1);
  assert.ok(posts.some((p) => /429 rate limited/.test(p.text || p.message || "")));
});

test("worker retries a transient network error then completes", async () => {
  let calls = 0;
  const route = (req) => {
    if (!req.url.includes("/_server")) return undefined;
    calls++;
    if (calls === 1) throw new Error("network down"); // probe tolerates it
    if (calls === 2) throw new Error("flake");
    const page = pageOf(req.body);
    return { status: 200, text: page === 0 ? usagePage([flightRecord({ id: "rec_1", timeCreated: "2026-09-10T12:00:00.000Z" })]) : emptyUsagePage() };
  };
  const { done, error, file, opfs } = await runWorker({ route });

  assert.equal(error, null);
  assert.equal(done.total, 1);
  assert.equal(opfs.read(file).rec_1.model, "deepseek/deepseek-v4.1-flash");
});

test("worker gives up after exhausting retries and posts an error, keeping partial data", async () => {
  const route = (req) => {
    if (!req.url.includes("/_server")) return undefined;
    throw new Error("boom");
  };
  const { error, opfs, file } = await runWorker({ route, opfs: { [FILE]: { rec_1: SEED_REC } } });

  assert.match(error, /Request failed: boom/);
  // The finally block still persists the cache.
  assert.equal(opfs.read(file).rec_1.input, 1);
});

test("a stalled request is reported as a timeout", async () => {
  const route = () => {
    const e = new Error("aborted");
    e.name = "AbortError";
    throw e;
  };
  const { error } = await runWorker({ route });
  assert.match(error, /timed out after 60s/);
});

test("a 200 server-error payload is treated as a stale server ID", async () => {
  const { error } = await runWorker({ pages: { 0: "RangeError: Invalid time value" } });
  assert.match(error, /StaleServerID/);
});

test("a referral payload on the first page is treated as a stale server ID", async () => {
  const { error } = await runWorker({ pages: { 0: `{"referralCode":"ABC","hasReferral":true,"rewardAmount":1}` } });
  assert.match(error, /StaleServerID/);
});

test("an empty server-fn payload with cached records is treated as a stale server ID", async () => {
  const { error } = await runWorker({
    pages: { 0: `["server-fn:1"]=[]` },
    opfs: { [FILE]: { rec_1: SEED_REC } },
  });
  assert.match(error, /StaleServerID/);
});

test("worker takes over a stale crawl lease", async () => {
  const clock = createClock();
  const opfs = createOpfs(clock);
  opfs.seed("opencode_crawl_lease.json", { owner: "dead-worker", at: clock.now() - 60000, workspaceID: WS });

  const fetch = makeFetch((req) => {
    if (!req.url.includes("/_server")) return undefined;
    const page = pageOf(req.body);
    return { status: 200, text: page === 0 ? usagePage([flightRecord({ id: "rec_1", timeCreated: "2026-09-10T12:00:00.000Z" })]) : emptyUsagePage() };
  });
  const posts = [];
  const { context } = createSandbox({ clock, opfs, fetch, onPost: (m) => posts.push(m) });
  loadScript(context, WORKER, "crawl-worker.js");
  await context.onmessage({ data: { workspaceID: WS, serverID: "s", forceRescan: false, filename: FILE } });

  assert.equal(posts.find((p) => p.type === "done").result.total, 1);
  // Lease is released (cleared) in the finally block.
  assert.equal(opfs.raw("opencode_crawl_lease.json"), "");
});

test("worker waits out a live lease then auto-resumes when it expires", async () => {
  const clock = createClock();
  const opfs = createOpfs(clock);
  // Fresh lease: not stale until LEASE_TTL (45s) of virtual time passes.
  opfs.seed("opencode_crawl_lease.json", { owner: "other-worker", at: clock.now(), workspaceID: WS });

  const fetch = makeFetch((req) => {
    if (!req.url.includes("/_server")) return undefined;
    const page = pageOf(req.body);
    return { status: 200, text: page === 0 ? usagePage([flightRecord({ id: "rec_1", timeCreated: "2026-09-10T12:00:00.000Z" })]) : emptyUsagePage() };
  });
  const posts = [];
  const { context } = createSandbox({ clock, opfs, fetch, onPost: (m) => posts.push(m) });
  loadScript(context, WORKER, "crawl-worker.js");
  await context.onmessage({ data: { workspaceID: WS, serverID: "s", forceRescan: false, filename: FILE } });

  assert.ok(posts.some((p) => /another crawl running/.test(p.text || p.message || "")));
  assert.equal(posts.find((p) => p.type === "done").result.total, 1);
});

test("worker rejects a launch missing its identifiers", async () => {
  const clock = createClock();
  const opfs = createOpfs(clock);
  const posts = [];
  const { context } = createSandbox({ clock, opfs, fetch: makeFetch(() => ({ status: 200, text: "" })), onPost: (m) => posts.push(m) });
  loadScript(context, WORKER, "crawl-worker.js");
  await context.onmessage({ data: { filename: FILE } });
  assert.match(posts.find((p) => p.type === "error").message, /missing workspaceID/);
});
