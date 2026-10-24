#!/usr/bin/env node
// tools/model-watch.mjs - daily model-catalog watcher.
// Fetches each vendor's public models endpoint, diffs the ids against the
// committed snapshot (vendors/<source>/models.snapshot.json) and rewrites the
// snapshot ONLY when the set changed. Pure fetch+diff - no pricing data.
//
// The extension runtime never reads these snapshots; git history is the dated
// model add/remove log, and tools/build-unified-preset.mjs reads the `name` of a
// `names: true` source (CommandCode) to fingerprint routing ids against the
// canonical model name.
//
// Safety: `extractIds` rejects malformed/empty payloads, but a truncated yet
// valid list is indistinguishable from a real mass retirement — so a count
// shrink is guarded per source (SOURCES[].shrink):
//   * "block" (default) — refuse to write and exit non-zero until a human
//     re-runs with --allow-shrink. For a stable catalog, where a short payload
//     means a broken crawl.
//   * "warn" — record the drop, log it in the step summary, keep the run green.
//     For a volatile catalog that legitimately adds and drops models.
// A failed source still leaves the run red.
//
// Usage: node tools/model-watch.mjs [--source opencode] [--allow-shrink]
//
// CI (.github/workflows/model-watch.yml): daily cron, tests first, then this
// script, then commit ONLY the snapshot path when the diff changed.

import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FETCH_TIMEOUT_MS = 30000;

export const SOURCES = {
  opencode: {
    label: "opencode Go",
    url: "https://opencode.ai/zen/go/v1/models",
    dir: "extension/vendors/opencode",
    // This endpoint generates its response per request (every model carries the
    // same `created` == fetch time) and its catalog genuinely rotates, so a
    // count drop is upstream truth rather than a broken crawl: record it and
    // warn instead of failing the daily run.
    shrink: "warn",
  },
  commandcode: {
    label: "CommandCode",
    // Public provider catalog (unauthenticated, the same one `cmd
    // --list-models` prints). Ids are routing ids - `MiniMaxAI/MiniMax-M3`,
    // `nvidia/nemotron-3-ultra-550b-a55b`, `stealth/glyph-cluster:free` - so the
    // display `name` is kept too: the unified builder fingerprints it when the
    // id alone carries deployment noise. Rotates openly, like opencode.
    url: "https://api.commandcode.ai/provider/v1/models",
    dir: "extension/vendors/commandcode",
    shrink: "warn",
    names: true,
  },
};

// OpenAI-style list response -> sorted unique ids. Fail-closed: a malformed or
// empty payload throws instead of returning [], so a broken endpoint can never
// wipe a snapshot clean. This only catches wholly bad payloads; a truncated
// but valid list is caught by the shrink guard in `watchOne`.
export function extractIds(json) {
  return extractModels(json).map((m) => m.id);
}

// Same payload -> [{ id, name }] sorted by id. `name` is the vendor's display
// label ("" when absent); it is the canonical identity when the id is a routing
// id, so sources with `names: true` keep it in the snapshot.
export function extractModels(json) {
  if (!json || !Array.isArray(json.data)) throw new Error("unexpected response (missing data[])");
  const byId = new Map();
  for (const m of json.data) {
    const id = m && typeof m.id === "string" ? m.id.trim() : "";
    if (!id) continue;
    const name = typeof m.name === "string" ? m.name.trim() : "";
    if (!byId.has(id)) byId.set(id, { id, name });
  }
  if (byId.size === 0) throw new Error("unexpected response (no model ids)");
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// prev null (no snapshot yet) -> baseline, not "everything is new".
export function diffModels(prevIds, nextIds) {
  if (prevIds == null) return { baseline: true, added: [], removed: [], changed: false };
  const prev = new Set(prevIds);
  const next = new Set(nextIds || []);
  const added = [...next].filter((id) => !prev.has(id)).sort();
  const removed = [...prev].filter((id) => !next.has(id)).sort();
  return { baseline: false, added, removed, changed: added.length > 0 || removed.length > 0 };
}

export function snapshotPath(source) {
  return resolve(ROOT, SOURCES[source].dir, "models.snapshot.json");
}

export function loadSnapshot(path) {
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || !Array.isArray(parsed.models)) throw new Error(`${path}: invalid snapshot (models[] missing)`);
  return parsed;
}

// Snapshot entries may be bare ids (opencode) or { id, name } (commandcode).
export function snapshotIds(snapshot) {
  return ((snapshot && snapshot.models) || [])
    .map((m) => (typeof m === "string" ? m : m && m.id))
    .filter((id) => typeof id === "string" && id);
}

export function snapshotContent(models, capturedAt = new Date().toISOString()) {
  return JSON.stringify({ capturedAt, models }, null, 2) + "\n";
}

async function fetchModels(cfg) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(cfg.url, { headers: { accept: "application/json" }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return cfg.names ? extractModels(json) : extractIds(json);
  } finally {
    clearTimeout(timer);
  }
}

// Describe a count drop, or null when there is nothing to report (baseline, or
// same/greater count). Pure so both the guard and the tests can use it.
export function shrinkVerdict(prevModels, nextIds) {
  if (prevModels == null || nextIds.length >= prevModels.length) return null;
  const next = new Set(nextIds);
  const removed = prevModels.filter((id) => !next.has(id)).sort();
  return {
    removed,
    message: `model count dropped ${prevModels.length} -> ${nextIds.length} (removed ${removed.length}: ${removed.join(", ")})`,
  };
}

// Per-source policy: "block" throws (no write) unless the human passes
// --allow-shrink; "warn" returns the verdict so the caller can record the drop
// and log it. Returns the verdict when the drop was accepted, throws when it
// was refused, null when there was no drop.
export function assertNotSuspiciousShrink(prevModels, nextIds, { allowShrink = false, policy = "block", source = "" } = {}) {
  const verdict = shrinkVerdict(prevModels, nextIds);
  if (!verdict) return null;
  if (policy === "warn" || allowShrink) return verdict;
  throw new Error(
    `refusing to write: ${verdict.message}. If this retirement is real, re-run ` +
      `node tools/model-watch.mjs --source ${source} --allow-shrink, or dispatch the ` +
      `"Model watch" workflow with allow_shrink = true.`
  );
}

// Fetch + guard + diff + (conditionally) rewrite the snapshot. Throws on
// fetch/parse errors or a suspected shrink; the caller keeps going with the
// remaining sources. `opts` exists for tests (path/fetchIds); production calls
// pass only allowShrink.
export async function watchOne(source, opts = {}) {
  const cfg = SOURCES[source] || {};
  const path = opts.path || snapshotPath(source);
  const fetched = await (opts.fetchIds || (() => fetchModels(cfg)))();
  const entries = fetched.map((m) => (typeof m === "string" ? { id: m } : m));
  const ids = entries.map((m) => m.id);
  const prev = loadSnapshot(path); // null -> first run: establish baseline
  const prevModels = prev ? snapshotIds(prev) : null;
  const shrink = assertNotSuspiciousShrink(prevModels, ids, {
    allowShrink: opts.allowShrink,
    policy: opts.shrink || cfg.shrink || "block",
    source,
  });
  const diff = diffModels(prevModels, ids);
  const wrote = diff.baseline || diff.changed;
  if (wrote) writeFileSync(path, snapshotContent(cfg.names ? entries : ids));
  return {
    source,
    label: SOURCES[source].label,
    total: ids.length,
    baseline: diff.baseline,
    added: diff.added,
    removed: diff.removed,
    changed: diff.changed,
    wrote,
    shrink,
  };
}

export function summaryMarkdown(results, errors) {
  const lines = ["## Model watch", ""];
  if (results.length) {
    lines.push("| source | models | added | removed | status |", "| --- | --- | --- | --- | --- |");
    for (const r of results) {
      const status = r.shrink ? "dropped (warn)" : r.baseline ? "baseline" : r.changed ? "changed" : "no change";
      lines.push(`| ${r.label} | ${r.total} | ${r.baseline ? "-" : r.added.length} | ${r.baseline ? "-" : r.removed.length} | ${status} |`);
    }
    lines.push("");
    for (const r of results) {
      // A warn-only source recorded a drop the guard would have refused on a
      // stable source: surface it so the log still shows what disappeared.
      if (r.shrink) lines.push(`> **${r.label}: accepted a model-count drop** — ${r.shrink.message}`, "");
      if (r.baseline) {
        lines.push(`### ${r.label}: baseline established (${r.total} models)`, "");
        continue;
      }
      if (r.added.length) lines.push(`### ${r.label}: added`, "", ...r.added.map((id) => `- \`${id}\``), "");
      if (r.removed.length) lines.push(`### ${r.label}: removed`, "", ...r.removed.map((id) => `- \`${id}\``), "");
    }
  }
  for (const e of errors) lines.push(`> **${e.source}: FAILED** — ${e.message}`, "");
  return lines.join("\n") + "\n";
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const argIndex = process.argv.indexOf("--source");
  const sources = argIndex !== -1 ? [process.argv[argIndex + 1]] : Object.keys(SOURCES);
  const allowShrink = process.argv.includes("--allow-shrink");
  const results = [];
  const errors = [];
  for (const source of sources) {
    if (!SOURCES[source]) {
      console.error(`Unknown source: ${source}`);
      process.exit(1);
    }
    try {
      const r = await watchOne(source, { allowShrink });
      results.push(r);
      if (r.shrink) {
        // The CHANGED block below already lists the removed ids one per line.
        console.warn(`${source}: WARNING (${SOURCES[source].shrink} policy) accepted a drop — ${r.shrink.message}`);
      }
      if (r.baseline) {
        console.log(`${source}: baseline written (${r.total} models)`);
      } else if (r.changed) {
        console.log(`${source}: CHANGED (+${r.added.length} -${r.removed.length}, total ${r.total})`);
        for (const id of r.added) console.log(`  + ${id}`);
        for (const id of r.removed) console.log(`  - ${id}`);
      } else {
        console.log(`${source}: no change (${r.total} models)`);
      }
    } catch (e) {
      const message = String((e && e.message) || e);
      errors.push({ source, message });
      console.error(`${source}: FAILED — ${message}`);
    }
  }
  const interesting = results.some((r) => r.wrote) || errors.length > 0;
  if (interesting && process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryMarkdown(results, errors));
  }
  if (errors.length) process.exitCode = 1;
}
