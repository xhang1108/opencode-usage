// tools/price-watch-lib.mjs — shared helpers for price-watch + backfill.
//
// rates.source.json provenance (parser-backed official vendors ONLY):
//   Every vendor wired in VENDORS below is parser-backed, and for those
//   rebuildPreset() GENERATES rates.source.json as a mirror of the committed
//   price-snapshots — the same state that produces rates.preset.json. It is
//   never hand-edited. Hand-maintained vendors (e.g. opencode) use the authored
//   flow instead: tools/extract-preset.mjs reads a human-curated rates.source.json
//   and emits rates.preset.json. rebuildPreset() therefore refuses to clobber a
//   rates.source.json whose shape it would not itself have produced; see
//   sourceMirrorDecision().
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

import { validatePreset } from "../extension/shared/preset.js";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const VENDORS = {
  "deepseek-official": {
    url: "https://api-docs.deepseek.com/quick_start/pricing",
    dir: "extension/vendors/deepseek-official",
    parser: "extension/vendors/deepseek-official/pricing-page.js",
    // legacy / alias API model ids folded into the canonical target.
    aliasTo: {
      "deepseek-v4-flash": ["deepseek-flash", "deepseek-v4.1-flash", "deepseek-v4-flash-free", "deepseek-v4.1-flash-free", "deepseek-v4-flash-vision-exp", "deepseek-v4-flash-0731", "deepseek-v4.1-flash-expires-on-0910"],
      "deepseek-v4-pro": ["deepseek-v4-pro-free"],
      // Usage-page display label for the merged chat+reasoner model (V3.1+).
      "deepseek-chat": ["deepseek-chat & deepseek-reasoner"],
    },
  },
  mimo: {
    // Official public catalog (OpenRouter-style, per-token USD); the SPA shell
    // and bundle no longer embed prices since the 2026-09 platform revamp.
    url: "https://platform.xiaomimimo.com/api/v1/models",
    dir: "extension/vendors/mimo",
    parser: "extension/vendors/mimo/pricing-page.js",
    aliasTo: {
      "mimo-v2.5-pro": ["MiMo-V2.5-Pro", "MiMo-V2.5 Pro"],
      "mimo-v2.5": ["MiMo-V2.5"],
    },
  },
  // Official (non-resale) USD price sources. Price-only vendors: no vendor.json,
  // so build-manifest skips them — snapshots feed the daily price history only.
  "xai-official": {
    url: "https://docs.x.ai/docs/pricing",
    dir: "extension/vendors/xai-official",
    parser: "extension/vendors/xai-official/pricing-page.js",
  },
  "openai-official": {
    url: "https://developers.openai.com/api/docs/pricing.md",
    dir: "extension/vendors/openai-official",
    parser: "extension/vendors/openai-official/pricing-page.js",
  },
  "qwen-official": {
    url: "https://www.alibabacloud.com/help/en/model-studio/model-pricing",
    dir: "extension/vendors/qwen-official",
    parser: "extension/vendors/qwen-official/pricing-page.js",
    // Dated snapshots of one model. Their fingerprint is identical (the date
    // normalizes away) while the page can price two rows differently — that is
    // an ambiguous group price, so declare them one model here.
    aliasTo: {
      "qwen-plus": [
        "qwen-plus-latest",
        "qwen-plus-2025-12-01",
        "qwen-plus-2025-09-11",
        "qwen-plus-2025-07-28",
        "qwen-plus-2025-07-14",
        "qwen-plus-2025-04-28",
        "qwen-plus-2025-01-25",
      ],
    },
  },
  "tencent-official": {
    url: "https://www.tencentcloud.com/act/pro/tokenhub",
    dir: "extension/vendors/tencent-official",
    parser: "extension/vendors/tencent-official/pricing-page.js",
  },
  "typesafe-official": {
    url: "https://docs.typesafe.ai/models.md",
    dir: "extension/vendors/typesafe-official",
    parser: "extension/vendors/typesafe-official/pricing-page.js",
  },
};

export function snapshotFilename(capturedAt) {
  return `${String(capturedAt).replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}.json`;
}

export function isoFromWayback(ts) {
  const s = String(ts);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}.000Z`;
}

export function modelsKey(snapshot) {
  return JSON.stringify(Object.entries(snapshot.models || {}).sort());
}

// Refuse to write when the new model count drops below the committed snapshot's:
// a partial/truncated fetch or a vendor layout change would otherwise silently
// gut the history. Real retirements look identical, so the operator can override
// with --allow-shrink. Baseline (no previous snapshot) and same-or-greater counts
// always pass. The message names the dropped ids and the exact re-run command.
export function assertNotSuspiciousShrink(previous, next, { source, allowShrink = false } = {}) {
  const prevModels = (previous && previous.models) || null;
  if (allowShrink || !prevModels) return;
  const nextIds = Object.keys((next && next.models) || {});
  const prevIds = Object.keys(prevModels);
  if (nextIds.length >= prevIds.length) return;
  const nextSet = new Set(nextIds);
  const dropped = prevIds.filter((id) => !nextSet.has(id)).sort();
  throw new Error(
    `refusing to write: model count dropped ${prevIds.length} -> ${nextIds.length} ` +
      `(dropped ${dropped.length}: ${dropped.join(", ")}). If this change is real, re-run ` +
      `node tools/price-watch.mjs --source ${source} --allow-shrink, or dispatch the ` +
      `"Price watch" workflow with allow_shrink = true. A real retirement also has to be ` +
      `named in tools/snapshot-shrink-allowlist.json or CI rejects the new snapshot.`,
  );
}

// True when `text` has the shape rebuildPreset() emits for rates.source.json:
// { source, models: [ { model, label, rates: [ { from, pricing } ] } ] }. A
// hand-authored file (e.g. opencode's, which carries no per-model `label`) does
// not match, so the generator will not clobber it.
export function isGeneratedSourceMirror(text, source) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return false;
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return false;
  if (doc.source !== source || !Array.isArray(doc.models)) return false;
  return doc.models.every(
    (m) =>
      m &&
      typeof m === "object" &&
      typeof m.model === "string" &&
      typeof m.label === "string" &&
      Array.isArray(m.rates) &&
      m.rates.length > 0 &&
      m.rates.every((r) => r && typeof r === "object" && "from" in r && r.pricing),
  );
}

// Decide whether rebuildPreset() may (re)write rates.source.json. { write, reason }:
// absent -> create; unchanged -> byte-identical no-op; regenerate -> a recognisable
// generated mirror; foreign -> a file this generator would not have produced, so
// it is left untouched and the caller reports it.
export function sourceMirrorDecision(existingText, nextText, source) {
  if (existingText == null) return { write: true, reason: "absent" };
  if (existingText === nextText) return { write: false, reason: "unchanged" };
  if (isGeneratedSourceMirror(existingText, source)) return { write: true, reason: "regenerate" };
  return { write: false, reason: "foreign" };
}

export function snapshotsDir(cfg) {
  const dir = resolve(ROOT, cfg.dir, "price-snapshots");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function listSnapshots(cfg) {
  return readdirSync(snapshotsDir(cfg))
    .filter((f) => f.endsWith(".json"))
    .sort();
}

export function loadParser(cfg) {
  return import(pathToFileURL(resolve(ROOT, cfg.parser)).href);
}

export function loadSnapshots(cfg) {
  return listSnapshots(cfg).map((f) => JSON.parse(readFileSync(resolve(snapshotsDir(cfg), f), "utf8")));
}

export function writeSnapshot(cfg, snapshot) {
  const name = snapshotFilename(snapshot.capturedAt);
  writeFileSync(resolve(snapshotsDir(cfg), name), JSON.stringify(snapshot, null, 2) + "\n");
  return name;
}

// Rebuild rates.preset.json + rates.source.json from every committed snapshot.
export async function rebuildPreset(source, cfg) {
  const { versionsFromSnapshots, presetFromVersions } = await import(pathToFileURL(resolve(ROOT, "extension/shared/price-history.js")).href);
  const state = versionsFromSnapshots(loadSnapshots(cfg));
  const preset = presetFromVersions(state, { source });

  for (const [label, ids] of Object.entries(cfg.aliasTo || {})) {
    const target = preset.targets[`${source}:${label}`] ? `${source}:${label}` : null;
    if (!target) continue;
    for (const id of ids) {
      const key = `${source}:${id}`;
      // The authored equivalence wins even when the id is itself a live model
      // with its own row (qwen-plus-2025-12-01): they are one model, so they
      // must share one target/rate table, or the unified builder sees two
      // rate signatures in one fingerprint group and fails closed.
      preset.modelMap[key] = target;
    }
  }

  const check = validatePreset(preset);
  if (!check.ok) throw new Error(`${source}: preset invalid: ${check.errors.join(", ")}`);

  writeFileSync(resolve(ROOT, cfg.dir, "rates.preset.json"), JSON.stringify(preset, null, 2) + "\n");
  const sourceModels = Object.keys(state)
    .sort()
    .map((id) => ({ model: id, label: state[id].label, rates: state[id].versions }));
  // rates.source.json is a GENERATED mirror for parser-backed vendors; never
  // clobber a file this generator would not itself have produced (see header).
  const sourcePath = resolve(ROOT, cfg.dir, "rates.source.json");
  const nextSourceText = JSON.stringify({ source, models: sourceModels }, null, 2) + "\n";
  const existingSourceText = existsSync(sourcePath) ? readFileSync(sourcePath, "utf8") : null;
  const decision = sourceMirrorDecision(existingSourceText, nextSourceText, source);
  if (decision.write) {
    writeFileSync(sourcePath, nextSourceText);
  } else if (decision.reason === "foreign") {
    console.warn(
      `${source}: rates.source.json is not a generated snapshot mirror — left unchanged. ` +
        `Delete ${cfg.dir}/rates.source.json to regenerate it from the snapshots.`,
    );
  }

  return { source, snapshots: listSnapshots(cfg).length, targets: Object.keys(preset.targets).length, modelMap: Object.keys(preset.modelMap).length };
}
