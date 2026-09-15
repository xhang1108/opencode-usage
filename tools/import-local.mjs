#!/usr/bin/env node
// tools/import-local.mjs — Export per-request token usage from the local
// opencode SQLite database into a JSON file the dashboard can import.
//
// Why: opencode.ai no longer shows free-model usage, so the _server crawl
// misses it. The local DB (~/.local/share/opencode/opencode.db) still has
// per-message tokens for every model, including free ones (cost = 0).
//
// Output shape matches the dashboard's merged export:
//   { "<message-id>": { workspaceID, project, directory, time, date, model,
//                       input, output, reasoning, cacheRead, cacheWrite5m,
//                       cacheWrite1h }, ... }
// All local records go into a single workspace (default "Local"); the
// per-project label is preserved in `project` for future use.
// Importing the same file twice is idempotent (keyed by message id).
//
// Requires Node >= 22.5 (built-in node:sqlite). Reads the DB read-only,
// so it is safe to run while opencode is running.
//
// Usage:
//   node tools/import-local.mjs [--db <path>] [--out <file>] [--workspace <name>]
//   node tools/import-local.mjs --out opencode_local_records.json
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, writeFileSync } from "node:fs";

export function argValue(name, argv = process.argv) {
  const i = argv.indexOf(name);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : null;
}

export function defaultDbPath() {
  if (process.platform === "win32") {
    const home = process.env.USERPROFILE || homedir();
    return join(home, ".local", "share", "opencode", "opencode.db");
  }
  return join(homedir(), ".local", "share", "opencode", "opencode.db");
}

// Last path segment, tolerant of both separators (DB stores e.g. "D:/a/b").
export function baseName(p) {
  const clean = String(p || "").replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = clean.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

export function toLocalDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Pure transform: turn DB rows (mid/mdata/dir/pid) into the import map plus
// the summary stats main() prints. Kept side-effect free so it is unit-testable.
export function collectRecords(rows, { workspace, prefix } = {}) {
  const out = {};
  let skipped = 0;
  const sessions = new Set();
  const models = new Set();

  for (const row of rows) {
    let msg;
    try {
      msg = JSON.parse(row.mdata);
    } catch {
      skipped++;
      continue;
    }
    if (!msg || msg.role !== "assistant") continue;
    const t = msg.tokens;
    const total = t ? (t.input || 0) + (t.output || 0) + (t.reasoning || 0) + (t.cache?.read || 0) + (t.cache?.write || 0) : 0;
    if (!t || total <= 0) continue; // user messages, errors, empty rows
    if (!msg.modelID) {
      skipped++;
      continue;
    }
    const created = msg.time?.created;
    const d = new Date(created);
    if (isNaN(d.getTime())) {
      skipped++;
      continue;
    }
    const base = baseName(row.dir) || String(row.pid || "unknown").slice(0, 8);
    out[row.mid] = {
      workspaceID: workspace,
      project: `${prefix}:${base}`,
      directory: row.dir || "",
      time: d.toISOString(),
      date: toLocalDate(d),
      model: msg.modelID,
      input: t.input || 0,
      output: t.output || 0,
      reasoning: t.reasoning || 0,
      cacheRead: t.cache?.read || 0,
      cacheWrite5m: t.cache?.write || 0, // local DB has no 5m/1h split; all goes to 5m
      cacheWrite1h: 0,
      vendorCost: typeof msg.cost === "number" ? msg.cost : undefined, // opaque (D16)
      costScale: 1, // local DB cost is already USD
    };
    sessions.add(row.pid);
    models.add(msg.modelID);
  }

  return { out, skipped, sessions, models };
}

function main() {
  const dbPath = argValue("--db") || defaultDbPath();
  const outPath = argValue("--out") || null;
  const workspace = argValue("--workspace") || "Local";
  const prefix = argValue("--prefix") || "local"; // project label prefix, kept for provenance

  if (!existsSync(dbPath)) {
    console.error(`Database not found: ${dbPath}`);
    console.error("Pass the path explicitly with --db <path>.");
    process.exit(1);
  }

  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (e) {
    console.error(`Cannot open database read-only: ${e.message}`);
    process.exit(1);
  }

  const rows = db
    .prepare(
      `SELECT m.id AS mid, m.data AS mdata, s.directory AS dir, s.project_id AS pid
       FROM message m JOIN session s ON s.id = m.session_id`
    )
    .all();

  const { out, skipped, sessions, models } = collectRecords(rows, { workspace, prefix });
  db.close();

  const json = JSON.stringify(out);
  if (outPath) {
    writeFileSync(outPath, json);
    console.error(`Wrote ${Object.keys(out).length} records -> ${outPath}`);
  } else {
    process.stdout.write(json);
  }
  console.error(
    `sessions=${sessions.size} models=${models.size} skipped=${skipped} ` +
      `models: ${Array.from(models).sort().join(", ")}`
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
