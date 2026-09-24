#!/usr/bin/env node
// tools/model-watch.mjs — daily model-id watcher (opencode Go + CommandCode).
// Fetches each vendor's public models endpoint, diffs the ids against the
// committed snapshot (vendors/<source>/models.snapshot.json) and rewrites the
// snapshot ONLY when the set changed. Pure fetch+diff — no pricing data.
//
// The snapshot is this tool's state file (nothing in the extension runtime
// reads it); git history of the snapshots is the dated model add/remove log.
//
// Usage: node tools/model-watch.mjs [--source opencode|commandcode]
//
// CI (.github/workflows/model-watch.yml): daily cron, tests first, then this
// script, then commit ONLY the two snapshot paths when the diff changed.
// A failed source marks the run failed but never blocks the other source.

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
  },
  commandcode: {
    label: "CommandCode",
    url: "https://api.commandcode.ai/provider/v1/models",
    dir: "extension/vendors/commandcode",
  },
};

// OpenAI-style list response -> sorted unique ids. Fail-closed: a malformed or
// empty payload throws instead of returning [], so a broken endpoint can never
// wipe a snapshot clean.
export function extractIds(json) {
  if (!json || !Array.isArray(json.data)) throw new Error("unexpected response (missing data[])");
  const ids = [];
  for (const m of json.data) {
    const id = m && typeof m.id === "string" ? m.id.trim() : "";
    if (id) ids.push(id);
  }
  if (ids.length === 0) throw new Error("unexpected response (no model ids)");
  return [...new Set(ids)].sort();
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

export function snapshotContent(models, capturedAt = new Date().toISOString()) {
  return JSON.stringify({ capturedAt, models }, null, 2) + "\n";
}

async function fetchIds(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { accept: "application/json" }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return extractIds(await res.json());
  } finally {
    clearTimeout(timer);
  }
}

// Fetch + diff + (conditionally) rewrite the snapshot. Throws on fetch/parse
// errors; the caller keeps going with the remaining sources.
export async function watchOne(source) {
  const path = snapshotPath(source);
  const ids = await fetchIds(SOURCES[source].url);
  const prev = loadSnapshot(path); // null -> first run: establish baseline
  const diff = diffModels(prev ? prev.models : null, ids);
  const wrote = diff.baseline || diff.changed;
  if (wrote) writeFileSync(path, snapshotContent(ids));
  return {
    source,
    label: SOURCES[source].label,
    total: ids.length,
    baseline: diff.baseline,
    added: diff.added,
    removed: diff.removed,
    changed: diff.changed,
    wrote,
  };
}

export function summaryMarkdown(results, errors) {
  const lines = ["## Model watch", ""];
  if (results.length) {
    lines.push("| source | models | added | removed | status |", "| --- | --- | --- | --- | --- |");
    for (const r of results) {
      const status = r.baseline ? "baseline" : r.changed ? "changed" : "no change";
      lines.push(`| ${r.label} | ${r.total} | ${r.baseline ? "-" : r.added.length} | ${r.baseline ? "-" : r.removed.length} | ${status} |`);
    }
    lines.push("");
    for (const r of results) {
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
  const results = [];
  const errors = [];
  for (const source of sources) {
    if (!SOURCES[source]) {
      console.error(`Unknown source: ${source}`);
      process.exit(1);
    }
    try {
      const r = await watchOne(source);
      results.push(r);
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
