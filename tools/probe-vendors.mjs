#!/usr/bin/env node
// tools/probe-vendors.mjs — Recon probe for multi-vendor roadmap.
// Read-only: hits public endpoints + Bearer endpoints ONLY when the
// corresponding env key is present. Never prints secrets, only shape keys.
//
// Usage:
//   node tools/probe-vendors.mjs
//   OPENROUTER_API_KEY=... DEEPSEEK_API_KEY=... node tools/probe-vendors.mjs
//
// Env keys (all optional):
//   OPENROUTER_API_KEY, DEEPSEEK_API_KEY, MIMO_API_KEY, CMD_API_KEY

const REDACTED = "<redacted>";

function shapeOf(value, depth = 0) {
  if (depth > 3) return typeof value;
  if (Array.isArray(value)) {
    return value.length ? [shapeOf(value[0], depth + 1)] : [];
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).slice(0, 30)) out[k] = shapeOf(value[k], depth + 1);
    return out;
  }
  return typeof value;
}

async function getJson(url, { bearer = null, headers = {} } = {}) {
  const h = { accept: "application/json", ...headers };
  if (bearer) h.Authorization = `Bearer ${bearer}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, { headers: h, signal: ctrl.signal });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* non-JSON */
    }
    return { status: res.status, json, snippet: text.slice(0, 200).replace(/\s+/g, " ") };
  } catch (e) {
    return { status: null, json: null, snippet: `FETCH_ERROR: ${e.message}` };
  } finally {
    clearTimeout(timer);
  }
}

async function postJson(url, payload, { bearer = null } = {}) {
  const h = { accept: "application/json", "content-type": "application/json" };
  if (bearer) h.Authorization = `Bearer ${bearer}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, { method: "POST", headers: h, body: JSON.stringify(payload), signal: ctrl.signal });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* non-JSON */
    }
    return { status: res.status, json, snippet: text.slice(0, 200).replace(/\s+/g, " ") };
  } catch (e) {
    return { status: null, json: null, snippet: `FETCH_ERROR: ${e.message}` };
  } finally {
    clearTimeout(timer);
  }
}

function lastDays(n) {
  const end = new Date();
  const start = new Date(Date.now() - n * 24 * 3600 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

function namesOf(arr) {
  if (!Array.isArray(arr)) return null;
  return arr
    .map((x) => (typeof x === "string" ? x : x?.name ?? (x ? Object.values(x)[0] : null)))
    .filter(Boolean)
    .join(",");
}

function report(name, result, { showShapePath = ["data", 0] } = {}) {
  let shape = null;
  if (result.json) {
    let node = result.json;
    for (const seg of showShapePath) {
      if (node == null) break;
      node = node[seg];
    }
    shape = node ? shapeOf(node) : shapeOf(result.json);
  }
  const rowCount = result.json?.data && Array.isArray(result.json.data) ? result.json.data.length : null;
  console.log(`\n## ${name}`);
  console.log(`status=${result.status} rows=${rowCount ?? "-"} snippet=${result.snippet.slice(0, 160)}`);
  if (shape) console.log(`shape=${JSON.stringify(shape)}`);
}

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || null;
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || null;
const MIMO_KEY = process.env.MIMO_API_KEY || null;
const CMD_KEY = process.env.COMMAND_CODE_API_KEY || process.env.CMD_API_KEY || null;

console.log(`keys present: openrouter=${!!OPENROUTER_KEY} deepseek=${!!DEEPSEEK_KEY} mimo=${!!MIMO_KEY} commandcode=${!!CMD_KEY} ${REDACTED}`);

// 1. OpenRouter — public models list (no key needed)
report(
  "openrouter GET /api/v1/models (public)",
  await getJson("https://openrouter.ai/api/v1/models"),
  { showShapePath: ["data", 0] }
);

// 2. OpenRouter — Bearer activity (management key required; 30d grouped by endpoint)
if (OPENROUTER_KEY) {
  report(
    "openrouter GET /api/v1/activity (Bearer)",
    await getJson("https://openrouter.ai/api/v1/activity", { bearer: OPENROUTER_KEY }),
    { showShapePath: ["data", 0] }
  );
  // 2b. Analytics meta (which metrics exist?) + 7d sample query.
  // This answers: does cached_tokens exist, and does input = prompt - cached hold?
  const meta = await getJson("https://openrouter.ai/api/v1/analytics/meta", { bearer: OPENROUTER_KEY });
  const m = meta.json?.data ?? {};
  console.log("\n## openrouter GET /api/v1/analytics/meta (Bearer)");
  console.log(`status=${meta.status} meta_keys=${meta.json?.data ? Object.keys(m).join(",") : "(unreadable) snippet=" + meta.snippet.slice(0, 120)}`);
  console.log(`metrics=${namesOf(m.metrics) ?? "(unreadable)"}`);
  console.log(`dimensions=${namesOf(m.dimensions) ?? "(none)"}`);
  console.log(`operators=${namesOf(m.operators) ?? "(none)"}`);
  console.log(`granularities=${namesOf(m.granularities) ?? "(none)"}`);
  const range = lastDays(90);
  const q = await postJson(
    "https://openrouter.ai/api/v1/analytics/query",
    {
      metrics: ["tokens_prompt", "tokens_completion", "reasoning_tokens", "cached_tokens", "request_count"],
      dimensions: ["model"],
      granularity: "day",
      limit: 20,
      time_range: range,
    },
    { bearer: OPENROUTER_KEY }
  );
  const rows = q.json?.data?.data ?? q.json?.data ?? null;
  const first = Array.isArray(rows) ? rows[0] : null;
  console.log("\n## openrouter POST /api/v1/analytics/query 90d sample (Bearer)");
  console.log(`status=${q.status} range=${range.start.slice(0, 10)}..${range.end.slice(0, 10)} rows=${Array.isArray(rows) ? rows.length : "-"}`);
  if (first) console.log(`shape=${JSON.stringify(shapeOf(first))}`);
  else console.log(`snippet=${q.snippet.slice(0, 160)}`);
} else {
  console.log("\n## openrouter GET /api/v1/activity + analytics/query (Bearer)\nskipped: OPENROUTER_API_KEY not set");
}

// 3. DeepSeek — Bearer balance (account readiness only, NOT usage)
if (DEEPSEEK_KEY) {
  report(
    "deepseek GET /user/balance (Bearer)",
    await getJson("https://api.deepseek.com/user/balance", { bearer: DEEPSEEK_KEY }),
    { showShapePath: [] }
  );
  report(
    "deepseek GET /v1/models (Bearer)",
    await getJson("https://api.deepseek.com/v1/models", { bearer: DEEPSEEK_KEY }),
    { showShapePath: ["data", 0] }
  );
} else {
  console.log("\n## deepseek /user/balance + /v1/models\nskipped: DEEPSEEK_API_KEY not set");
}

// 4. MiMo — models list with key (OpenAI-compatible)
if (MIMO_KEY) {
  report(
    "mimo GET /v1/models (api-key)",
    await getJson("https://api.xiaomimimo.com/v1/models", {
      headers: { "api-key": MIMO_KEY },
    }),
    { showShapePath: ["data", 0] }
  );
} else {
  console.log("\n## mimo GET /v1/models\nskipped: MIMO_API_KEY not set");
}

// 5. CommandCode — provider models list (probe auth requirement)
report(
  "commandcode GET /provider/v1/models (no key probe)",
  await getJson("https://api.commandcode.ai/provider/v1/models"),
  { showShapePath: ["data", 0] }
);
if (CMD_KEY) {
  report(
    "commandcode GET /provider/v1/models (Bearer)",
    await getJson("https://api.commandcode.ai/provider/v1/models", { bearer: CMD_KEY }),
    { showShapePath: ["data", 0] }
  );
}
