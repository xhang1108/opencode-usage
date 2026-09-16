// extension/shared/merge.js
// N-way merge + same-source dedupe (D2/B5). Zero chrome dependencies (P9).

import { normalizeRecord } from "./canonical.js";

export const DEDUP_BUCKET_MS = 2 * 60 * 1000;

// Records from the same vendor share no origin id across tracks (crawl vs
// file/DB), so duplicates are recognized by content + time bucket. Time skew
// between server and client clocks is absorbed by checking +/- one bucket.
export function fingerprintOf(rec) {
  if (!rec || typeof rec !== "object") return null;
  const t = new Date(rec.time).getTime();
  if (isNaN(t)) return null;
  const cacheWrite = (rec.cacheWrite5m || 0) + (rec.cacheWrite1h || 0);
  return [rec.model || "", rec.input || 0, rec.output || 0, rec.reasoning || 0, rec.cacheRead || 0, cacheWrite].join("|");
}

export function buildFingerprintBuckets(recs) {
  const buckets = new Set();
  for (const rec of recs || []) {
    const fp = fingerprintOf(rec);
    if (!fp) continue;
    const b = Math.floor(new Date(rec.time).getTime() / DEDUP_BUCKET_MS);
    buckets.add(`${fp}@${b - 1}`);
    buckets.add(`${fp}@${b}`);
    buckets.add(`${fp}@${b + 1}`);
  }
  return buckets;
}

// N-way merge of id-keyed maps; later maps override by id. Idempotent (D2).
export function mergeRecords(...maps) {
  const merged = {};
  let added = 0;
  for (const map of maps) {
    for (const [id, rec] of Object.entries(map || {})) {
      if (!rec || typeof rec !== "object" || !rec.model) continue;
      const normalized = normalizeRecord(rec);
      if (!normalized) continue;
      if (!merged[id]) added++;
      merged[id] = normalized;
    }
  }
  return { merged, added };
}

// Hide `primary` records (e.g. crawl) that duplicate `secondary` (e.g. file/DB).
// Only within the same source (D2); cross-vendor duplicates are never hidden.
// Day-anchored records (D22, `<day>T00:00:00Z`) are import snapshots; an instant
// crawl record from the SAME source with an identical fingerprint is the same
// usage, so the import copy is hidden (B5). Exact token match is required, and
// the fingerprint is scoped by source, so cross-vendor records never collapse.
export function isDayAnchoredRecord(rec) {
  return !!rec && typeof rec.time === "string" && /T00:00:00(?:\.000)?Z$/.test(rec.time);
}

// Provenance classification for opencode records: a record belongs to the
// local-DB import track (not the crawl track) when its id is a message id or
// its workspace is the synthetic "Local" one. Vendor records are never hidden
// by the opencode dedupe, so they count as "local" here. Shared by background
// (dedupe) and the dashboard (routing a backup restore) so the two never drift.
export function isLocalLooking(id, rec) {
  if (rec && rec.source && rec.source !== "opencode") return true;
  const sid = String(id || "");
  return (
    sid.startsWith("msg_") ||
    rec?.workspaceID === "Local" ||
    (typeof rec?.workspaceID === "string" && rec.workspaceID.startsWith("local:"))
  );
}

export function hideDayAnchoredImportCopies(records) {
  const out = {};
  const crawlFps = new Set();
  for (const rec of Object.values(records || {})) {
    if (!rec || isDayAnchoredRecord(rec)) continue;
    const fp = fingerprintOf(rec);
    if (fp) crawlFps.add(`${rec.source || "opencode"}|${fp}`);
  }
  let dropped = 0;
  for (const [id, rec] of Object.entries(records || {})) {
    const fp = fingerprintOf(rec);
    if (rec && fp && isDayAnchoredRecord(rec) && crawlFps.has(`${rec.source || "opencode"}|${fp}`)) {
      dropped++;
      continue;
    }
    out[id] = rec;
  }
  return { map: out, dropped };
}
