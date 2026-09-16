// browser-harness.mjs - Loads the extension's browser-bound scripts (content
// scripts / crawl worker) inside a `node:vm` sandbox with fakes for the APIs
// they touch: OPFS (navigator.storage), fetch, timers, AbortController and
// postMessage. The scripts are run AS THEY SHIP (no extraction / re-implementation),
// so these tests exercise the real crawl pipeline, not a copy of it.
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

// ---------------------------------------------------------------- virtual clock
// Timers fire immediately but advance a virtual "now", so the code's own pacing
// and lease-TTL arithmetic still sees time pass (and never really waits).
export function createClock(startMs = Date.UTC(2026, 8, 16, 12, 0, 0)) {
  let now = startMs;
  let seq = 0;
  return {
    now: () => now,
    advance(ms) { now += ms; },
    setTimeout(fn, ms = 0) {
      const id = ++seq;
      const delay = Math.max(0, Number(ms) || 0);
      queueMicrotask(() => {
        now += delay;
        fn();
      });
      return id;
    },
    clearTimeout() {},
    setInterval() { return ++seq; },
    clearInterval() {},
  };
}

function makeFakeDate(clock) {
  return class FakeDate extends Date {
    constructor(...args) {
      if (args.length === 0) super(clock.now());
      else super(...args);
    }
    static now() { return clock.now(); }
  };
}

// ------------------------------------------------------------------- fake OPFS
export function createOpfs(clock) {
  const files = new Map(); // name -> { text, lastModified }

  const handleFor = (name) => ({
    kind: "file",
    name,
    async getFile() {
      const f = files.get(name) || { text: "", lastModified: 0 };
      return {
        name,
        size: f.text.length,
        lastModified: f.lastModified,
        async text() { return f.text; },
      };
    },
    async createWritable() {
      let buf = "";
      return {
        async write(chunk) { buf += typeof chunk === "string" ? chunk : String(chunk); },
        async close() { files.set(name, { text: buf, lastModified: clock.now() }); },
      };
    },
  });

  const root = {
    async getFileHandle(name, opts = {}) {
      if (!files.has(name)) {
        if (!opts.create) throw new Error(`NotFoundError: ${name}`);
        files.set(name, { text: "", lastModified: clock.now() });
      }
      return handleFor(name);
    },
    async *entries() {
      for (const name of [...files.keys()]) yield [name, handleFor(name)];
    },
  };

  return {
    root,
    has: (name) => files.has(name),
    raw: (name) => files.get(name)?.text ?? null,
    read(name) {
      const f = files.get(name);
      return f && f.text ? JSON.parse(f.text) : null;
    },
    seed(name, obj) { files.set(name, { text: JSON.stringify(obj), lastModified: clock.now() }); },
  };
}

// --------------------------------------------------------------------- fetch
// routes: fn(req) -> { status, text } | string (body) | undefined (unrouted).
export function makeFetch(routes) {
  const handler = typeof routes === "function" ? routes : (req) => routes[req.url];
  return async function fetch(url, opts = {}) {
    const req = {
      url: String(url),
      method: opts.method || "GET",
      body: opts.body,
      headers: opts.headers,
      credentials: opts.credentials,
    };
    const out = await handler(req);
    if (out === undefined || out === null) throw new Error(`harness: unrouted fetch ${req.url}`);
    const res = typeof out === "string" ? { status: 200, text: out } : { status: 200, ...out };
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      async text() { return res.text ?? ""; },
      async json() { return JSON.parse(res.text ?? "null"); },
    };
  };
}

// Page number embedded in a crawl POST body ({t:0,s:<page>}).
export function pageOf(body) {
  try {
    const parsed = JSON.parse(body);
    let found = null;
    const visit = (node) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) { node.forEach(visit); return; }
      if (node.t === 0 && typeof node.s === "number") found = node.s;
      Object.values(node).forEach(visit);
    };
    visit(parsed);
    return found;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------- sandbox
export function createSandbox({ clock, opfs, fetch, onPost = () => {}, extra = {} }) {
  const logs = [];
  const sandbox = {
    console: {
      log: (...a) => logs.push(a.map(String).join(" ")),
      warn: (...a) => logs.push(a.map(String).join(" ")),
      error: (...a) => logs.push(a.map(String).join(" ")),
    },
    Date: makeFakeDate(clock),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    fetch,
    navigator: { storage: { getDirectory: async () => opfs.root } },
    AbortController: class {
      constructor() { this.signal = { aborted: false }; }
      abort() { this.signal.aborted = true; }
    },
    postMessage: (m) => onPost(m),
    onmessage: null,
    logs,
    ...extra,
  };
  sandbox.self = sandbox;
  return { sandbox, context: vm.createContext(sandbox), logs };
}

export function loadScript(context, source, filename = "inline.js", { dynamicImport = false } = {}) {
  const options = { filename };
  // importModuleDynamically lets a sandboxed content script resolve its
  // `import(chrome.runtime.getURL(...))` of a real extension module. Opt-in
  // because the loader is still marked experimental by Node.
  if (dynamicImport) options.importModuleDynamically = vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER;
  vm.runInContext(source, context, options);
}

export function readExtensionFile(rel) {
  return readFileSync(new URL(`../../../extension/${rel}`, import.meta.url), "utf8");
}

// Real file:// URL for an extension-relative path, so dynamic import() inside a
// sandbox loads the shipped mapper module rather than a stub.
export function extensionModuleUrl(rel) {
  return pathToFileURL(`${fileURLToPath(new URL("../../../extension/", import.meta.url))}${rel}`).href;
}

// --------------------------------------------------- opencode Flight payloads
// Mirrors the server's React Flight text the crawl regexes match on.
export function flightRecord({
  id,
  workspaceID = "wrk_demo",
  timeCreated,
  timeUpdated = null,
  timeDeleted = null,
  model = "deepseek/deepseek-v4.1-flash",
  provider = "opencode",
  input = 0,
  output = 0,
  reasoning = 0,
  cacheRead = 0,
  cacheWrite5m = 0,
  cacheWrite1h = 0,
  cost = null,
  keyID = "key_1",
  sessionID = "ses_1",
  plan = null,
  costMultiplier = 1,
}) {
  const enr = plan === null ? "null" : `{plan:"${plan}",costMultiplier:${costMultiplier}}`;
  return (
    `$R[1]={id:"${id}",workspaceID:"${workspaceID}",` +
    `timeCreated:new Date("${timeCreated}"),` +
    `timeUpdated:${timeUpdated ? `new Date("${timeUpdated}")` : "null"},` +
    `timeDeleted:${timeDeleted ? `new Date("${timeDeleted}")` : "null"},` +
    `model:"${model}",provider:"${provider}",` +
    `inputTokens:${input},outputTokens:${output},reasoningTokens:${reasoning},` +
    `cacheReadTokens:${cacheRead},cacheWrite5mTokens:${cacheWrite5m},cacheWrite1hTokens:${cacheWrite1h},` +
    `cost:${cost === null ? "null" : cost},keyID:"${keyID}",sessionID:"${sessionID}",` +
    `enrichment:${enr}}`
  );
}

// Server response body that looks like a valid (possibly record-bearing) page.
export function usagePage(records = []) {
  return `usage: $R[0],\n${records.join(",\n")}`;
}

// Empty-but-valid usage envelope (server has no records for this workspace).
export function emptyUsagePage() {
  return `usage: $R[0],\n["server-fn:1"]=[]`;
}

// Legacy (pre-sessionID) record shape: no provider/cost-enrichment fields.
export function legacyRecord({
  id,
  timeCreated,
  model = "deepseek-chat",
  input = 0,
  output = 0,
  reasoning = 0,
  cacheRead = 0,
  cacheWrite5m = 0,
  cacheWrite1h = 0,
  cost = null,
}) {
  return (
    `$R[1]={id:"${id}",timeCreated:new Date("${timeCreated}"),` +
    `model:"${model}",inputTokens:${input},outputTokens:${output},reasoningTokens:${reasoning},` +
    `cacheReadTokens:${cacheRead},cacheWrite5mTokens:${cacheWrite5m},cacheWrite1hTokens:${cacheWrite1h},` +
    `cost:${cost === null ? "null" : cost}}`
  );
}

// Wait until `check()` is true (or fail after `tries` macrotasks).
export async function waitFor(check, tries = 2000) {
  for (let i = 0; i < tries; i++) {
    const v = await check();
    if (v) return v;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error("harness: waitFor timed out");
}
