import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

// The opencode builder replays the GitHub price crawl, which lives in the
// gitignored tools/opencode/clean_diffs.txt. On a clean checkout (CI) that
// artifact is absent, so the sync check is skipped instead of failing on a
// missing input; run `npm run price-sync` locally to regenerate it.
const CRAWL = new URL("../opencode/clean_diffs.txt", import.meta.url);
const crawlSkip = existsSync(CRAWL) ? false : "needs tools/opencode/clean_diffs.txt (run npm run price-sync)";

function runCheck(script) {
  return execFileSync("node", [script, "--check"], { cwd: root, encoding: "utf8" });
}

// The shipped presets are generated artifacts. If a source table changes without
// re-running the builder, these checks fail loudly instead of drifting silently.
test("opencode preset is in sync with its builder", { skip: crawlSkip }, () => {
  const out = runCheck("tools/opencode/build-opencode-preset.mjs");
  assert.match(out, /in sync/);
});

test("unified preset is in sync with its builder", () => {
  const out = runCheck("tools/build-unified-preset.mjs");
  assert.match(out, /in sync/);
});

// The builder reports groups that fold different series/versions/variants so a
// risky merge is visible instead of silent. The only PRICED one left is the
// deepseek flash version fold — the glm stealth and muse contributor folds sit
// on families with no official price source, so those groups are never built
// (opencode is structure-only) and cannot surface as merges.
test("unified builder reports cross-boundary merges for review", () => {
  const out = runCheck("tools/build-unified-preset.mjs");
  assert.match(out, /merge across a structural boundary/);
  assert.match(out, /deepseek-4-flash {2}\[version\]/);
  assert.doesNotMatch(out, /glm-5\.3-flash/);
  assert.doesNotMatch(out, /muse-1\.2-spark-contributor/);
});

// `until` only retires a model from the peak/off-peak picker. A unified group
// merges vendors, so one vendor delisting must not retire a model another vendor
// (or the official table) still serves.
test("unified preset retires a group only when every source has ended", () => {
  const preset = JSON.parse(readFileSync(new URL("../../extension/shared/unified.preset.json", import.meta.url)));
  const ratesOf = (id) => (preset.groups.find((g) => g.id === id) || {}).rates || [];
  const hasUntil = (id) => JSON.stringify(ratesOf(id)).includes('"until"');

  // opencode delisted it 2026-08-13, but the Google list price is still live.
  assert.equal(hasUntil("gemini-3.7-flash"), false);
  // opencode delisted it, but the xAI official table still serves it
  // (now the rate source of record — tiered, no `until`).
  assert.equal(hasUntil("grok-4.5"), false);
  // deepseek-official discontinued chat/coder/reasoner -> stays retired.
  assert.equal(hasUntil("deepseek-chat"), true);
  // No official source of record: glm-5 has no group at all (unpriced),
  // so it can neither be picked nor resurrected by a stale `until`.
  assert.equal(hasUntil("glm-5"), false);
  assert.ok(!preset.groups.some((g) => g.id === "glm-5"));
});
