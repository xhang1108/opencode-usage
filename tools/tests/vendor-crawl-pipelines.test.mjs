import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createClock,
  createOpfs,
  createSandbox,
  loadScript,
  makeFetch,
  readExtensionFile,
  extensionModuleUrl,
  waitFor,
} from "./helpers/browser-harness.mjs";

// Boot a vendor content script in a sandbox and expose its message listener.
function bootContent(scriptRel, { route, sendMessage = () => ({}), extra = {} } = {}) {
  const clock = createClock();
  const opfs = createOpfs(clock);
  const sent = [];
  const requests = [];
  let runtimeListener = null;

  const fetch = makeFetch((req) => { requests.push(req); return route(req); });

  const chrome = {
    runtime: {
      sendMessage: (msg) => { sent.push(msg); return Promise.resolve(sendMessage(msg)); },
      onMessage: { addListener: (fn) => { runtimeListener = fn; }, removeListener() {} },
      getURL: (p) => extensionModuleUrl(p),
      getManifest: () => ({ version: "1.0.0" }),
    },
  };

  const { context, logs } = createSandbox({
    clock,
    opfs,
    fetch,
    extra: {
      window: { location: { pathname: "/" }, addEventListener() {}, postMessage() {} },
      document: { querySelector: () => null, querySelectorAll: () => [] },
      chrome,
      URLSearchParams,
      ...extra,
    },
  });
  loadScript(context, readExtensionFile(scriptRel), scriptRel, { dynamicImport: true });

  const emitRuntime = (msg) =>
    new Promise((resolve) => {
      let answered = false;
      const ret = runtimeListener(msg, {}, (r) => { answered = true; resolve(r); });
      if (ret !== true) queueMicrotask(() => { if (!answered) resolve(ret); });
    });

  return { clock, sent, requests, logs, emitRuntime };
}

// Trigger a vendor crawl and wait for its terminal notification.
async function startVendor(b, msg = {}) {
  const started = await b.emitRuntime({ type: "start-crawl", ...msg });
  const terminal = await waitFor(() => b.sent.find((m) => m.type === "vendor-crawl-done" || m.type === "error"));
  return { started, terminal };
}

// ================================================================= DeepSeek
const DS_SEC = Date.UTC(2026, 8, 14, 16, 0, 0) / 1000; // +08 midnight of 2026-09-15
const DS_DAY = 86400;

function deepseekRoute({ failScan429 = 0, hourlyStatus = 200 } = {}) {
  let scanCalls = 0;
  const series = (timeSec) => [{
    model: "deepseek-v4-flash",
    api_key: { tracking_id: "tr_1", name: "main" },
    buckets: [{ time: timeSec, usage: { PROMPT_CACHE_MISS_TOKEN: 100, PROMPT_CACHE_HIT_TOKEN: 20, RESPONSE_TOKEN: 30, REQUEST: 3 } }],
  }];
  const calls = { scan: 0, hourly: 0, cost: 0 };
  const route = (req) => {
    const start = Number(req.url.match(/start=(\d+)/)?.[1]);
    const end = Number(req.url.match(/end=(\d+)/)?.[1]);
    if (req.url.includes("/cost")) { calls.cost++; return { status: 200, text: JSON.stringify({ start, end, data: [] }) }; }
    if (req.url.includes("/amount")) {
      if (end - start === DS_DAY) {
        calls.hourly++;
        if (hourlyStatus !== 200) return { status: hourlyStatus, text: "busy" };
        return { status: 200, text: JSON.stringify({ start, end, bucket: 3600, series: series(start + 5 * 3600) }) };
      }
      calls.scan++; scanCalls++;
      if (scanCalls <= failScan429) return { status: 429, text: "rate limited" };
      return { status: 200, text: JSON.stringify({ start, end, bucket: 86400, series: series(DS_SEC) }) };
    }
    return undefined;
  };
  return { route, calls };
}

function bootDeepSeek(opts = {}, sendMessage) {
  const { route, calls } = deepseekRoute(opts);
  const b = bootContent("vendors/deepseek-official/content.js", {
    route,
    sendMessage: sendMessage || ((msg) => (msg.type === "vendor-crawl-data" ? { added: 1 } : {})),
    extra: { localStorage: { getItem: (k) => (k === "userToken" ? JSON.stringify({ value: "tok" }) : null) } },
  });
  return { b, calls };
}

test("deepseek: scans for usage days, then fetches hourly rows + cost", async () => {
  const { b, calls } = bootDeepSeek();
  const { terminal } = await startVendor(b, { vendor: "deepseek-official", days: 2 });

  assert.equal(terminal.type, "vendor-crawl-done");
  assert.equal(terminal.records, 1);
  assert.equal(terminal.newRecords, 1);
  assert.deepEqual(calls, { scan: 1, hourly: 1, cost: 1 });

  const data = b.sent.find((m) => m.type === "vendor-crawl-data");
  assert.equal(data.source, "deepseek-official");
  assert.equal(data.records.length, 1);
  assert.equal(data.records[0].input, 100);
  assert.equal(data.records[0].cacheRead, 20);
  assert.equal(data.records[0].output, 30);
  assert.equal(data.records[0].requests, 3);
});

test("deepseek: retries a 429 scan before succeeding", async () => {
  const { b, calls } = bootDeepSeek({ failScan429: 2 });
  const { terminal } = await startVendor(b, { vendor: "deepseek-official", days: 2 });
  assert.equal(terminal.type, "vendor-crawl-done");
  assert.equal(calls.scan, 3); // two 429s then the successful scan
  assert.equal(calls.hourly, 1);
});

test("deepseek: reports failure when an hourly fetch exhausts its retries", async () => {
  const { b, calls } = bootDeepSeek({ hourlyStatus: 500 });
  const { terminal } = await startVendor(b, { vendor: "deepseek-official", days: 2 });
  assert.equal(terminal.type, "error");
  assert.match(terminal.message, /failed after retries/);
  assert.equal(calls.hourly, 5); // 1 attempt + 4 retries
});

// ================================================================ CommandCode
const CC_DAY_BUCKET = {
  model: "deepseek/deepseek-v4.1-flash",
  provider: "vercel-ai-gateway",
  timeBucket: "2026-09-13 06:45:00",
  requests: 3,
  totalCost: 0.006867804,
  tokensIn: 1000,
  tokensOut: 50,
  cacheReadInputTokens: 900,
  cacheCreationInputTokens: 0,
};

function commandcodeRoute({ failFirstProbe = false } = {}) {
  let probes = 0;
  const requests = [];
  const route = (req) => {
    requests.push(req.url);
    const u = new URL(req.url);
    if (u.searchParams.get("granularity") === "day") {
      probes++;
      if (failFirstProbe && probes === 1) return { status: 422, text: "range too wide" };
      return { status: 200, text: JSON.stringify({ data: [CC_DAY_BUCKET] }) };
    }
    return { status: 200, text: JSON.stringify({ data: [{ ...CC_DAY_BUCKET, timeBucket: "2026-09-13 00:05:00" }] }) };
  };
  return { route, requests };
}

test("commandcode: probes days then fetches per-day buckets, reporting added", async () => {
  const { route, requests } = commandcodeRoute();
  const b = bootContent("vendors/commandcode/content.js", {
    route,
    sendMessage: (msg) => (msg.type === "vendor-crawl-data" ? { added: 1 } : {}),
  });
  const { terminal } = await startVendor(b, { vendor: "commandcode" });

  assert.equal(terminal.type, "vendor-crawl-done");
  assert.equal(terminal.records, 1);
  assert.equal(terminal.newRecords, 1);
  assert.equal(requests.length, 2); // one day probe + one per-day window
  assert.match(requests[0], /granularity=day/);
  assert.doesNotMatch(requests[1], /granularity=day/);
});

test("commandcode: falls back to a conservative window when the wide probe is rejected", async () => {
  const { route, requests } = commandcodeRoute({ failFirstProbe: true });
  const b = bootContent("vendors/commandcode/content.js", { route, sendMessage: () => ({ added: 1 }) });
  const { terminal } = await startVendor(b, { vendor: "commandcode" });

  assert.equal(terminal.type, "vendor-crawl-done");
  assert.equal(requests.length, 3); // rejected probe + fallback probe + per-day
  const firstFrom = new URL(requests[0]).searchParams.get("from");
  const secondFrom = new URL(requests[1]).searchParams.get("from");
  assert.notEqual(firstFrom, secondFrom);
});

// ================================================================= OpenRouter
const OR_ROW = {
  created_at__day: "2026-09-10",
  model: "deepseek/deepseek-chat",
  provider: "deepseek",
  tokens_prompt: 100,
  tokens_completion: 50,
  reasoning_tokens: 10,
  cached_tokens: 20,
  request_count: 2,
  total_usage: 0.5,
};

function openrouterRoute({ truncateFirst = false } = {}) {
  let truncate = truncateFirst;
  const requests = [];
  const route = (req) => {
    const body = JSON.parse(req.body);
    requests.push(body);
    const span = new Date(body.time_range.end) - new Date(body.time_range.start);
    const metadata = { truncated: false };
    if (truncate && span > 86400000) { metadata.truncated = true; truncate = false; }
    return { status: 200, text: JSON.stringify({ data: { data: [OR_ROW], metadata } }) };
  };
  return { route, requests };
}

test("openrouter: slices the range and streams mapped rows, reporting added", async () => {
  const { route, requests } = openrouterRoute();
  const b = bootContent("vendors/openrouter/content.js", {
    route,
    sendMessage: (msg) => (msg.type === "vendor-crawl-data" ? { added: 1 } : {}),
  });
  const { terminal } = await startVendor(b, { vendor: "openrouter", days: 1 });

  assert.equal(terminal.type, "vendor-crawl-done");
  assert.equal(terminal.windows, 1);
  assert.equal(terminal.records, 1);
  assert.equal(terminal.newRecords, 1);
  assert.deepEqual(requests[0].dimensions, ["model", "provider"]);

  const data = b.sent.find((m) => m.type === "vendor-crawl-data");
  assert.equal(data.records[0].input, 80); // 100 prompt - 20 cached
  assert.equal(data.records[0].cacheRead, 20);
  assert.equal(data.records[0].output, 40); // 50 completion - 10 reasoning
  assert.equal(data.records[0].reasoning, 10);
});

test("openrouter: dedupes ids that appear in more than one window", async () => {
  const { route } = openrouterRoute();
  const b = bootContent("vendors/openrouter/content.js", { route, sendMessage: () => ({ added: 1 }) });
  const { terminal } = await startVendor(b, { vendor: "openrouter", days: 60 });

  assert.equal(terminal.windows, 2); // 60 days -> two 30-day windows
  assert.equal(terminal.records, 1); // the duplicate row is dropped by the seen set
  assert.equal(b.sent.filter((m) => m.type === "vendor-crawl-data").length, 1);
});

test("openrouter: splits a window the server reports as truncated", async () => {
  const { route } = openrouterRoute({ truncateFirst: true });
  const b = bootContent("vendors/openrouter/content.js", { route, sendMessage: () => ({ added: 1 }) });
  const { terminal } = await startVendor(b, { vendor: "openrouter", days: 60 });

  assert.equal(terminal.windows, 4); // 2 windows, first split into 2 halves
  assert.equal(terminal.records, 1);
});
