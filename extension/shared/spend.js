// extension/shared/spend.js
// Vendor-neutral spend (cash out) ledger helpers. Zero chrome dependencies (P9).
// Records what the user actually paid, in USD, per platform and date; compared
// against the existing Value (Cost) computed from usage records.

import { stableHash } from "./canonical.js";

export const SPEND_SCHEMA_VERSION = 1;

const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const NOTE_MAX = 500;

export function isValidDate(s) {
  if (!DATE_RE.test(String(s || ""))) return false;
  const t = new Date(`${s}T00:00:00Z`);
  return !isNaN(t.getTime()) && t.toISOString().slice(0, 10) === s;
}

export function makeSpendId(entry, fallback = "") {
  const e = entry || {};
  const base = fallback || [e.platform, e.date, e.amountUSD, e.note, e.createdAt].join("|");
  return `spend:${stableHash(base)}`;
}

export function normalizeSpendEntry(raw, { now = () => new Date() } = {}) {
  if (!raw || typeof raw !== "object") return null;
  const rec = { ...raw };
  rec.platform = String(rec.platform == null ? "" : rec.platform).trim();
  rec.platformLabel = String(rec.platformLabel == null ? "" : rec.platformLabel).trim();
  rec.date = rec.date == null ? "" : String(rec.date).trim();
  rec.amountUSD = Number(rec.amountUSD);
  rec.note = String(rec.note == null ? "" : rec.note).trim();

  const t = now();
  const iso = t instanceof Date ? t.toISOString() : new Date(t).toISOString();
  if (!rec.createdAt) rec.createdAt = iso;
  if (!rec.updatedAt) rec.updatedAt = iso;

  if (!rec.id) rec.id = makeSpendId(rec);
  rec.v = rec.v || SPEND_SCHEMA_VERSION;
  return rec;
}

export function validateSpendEntry(entry) {
  if (!entry || typeof entry !== "object") return { ok: false, reason: "not-object" };
  if (!entry.platform) return { ok: false, reason: "missing:platform" };
  if (entry.platform === "other" && !entry.platformLabel) {
    return { ok: false, reason: "missing:platformLabel" };
  }
  if (!isValidDate(entry.date)) return { ok: false, reason: "bad-date" };
  const amt = Number(entry.amountUSD);
  if (!Number.isFinite(amt) || amt <= 0) return { ok: false, reason: "bad-amount" };
  if (String(entry.note || "").length > NOTE_MAX) return { ok: false, reason: "note-too-long" };
  return { ok: true };
}

export function aggregateSpend(entries, { startDate = "", endDate = "", platform = "" } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const filtered = [];
  for (const e of list) {
    if (!e || typeof e !== "object") continue;
    if (!isValidDate(e.date)) continue;
    if (platform && e.platform !== platform) continue;
    if (startDate && e.date < startDate) continue;
    if (endDate && e.date > endDate) continue;
    filtered.push(e);
  }

  const byDay = {};
  const byMonth = {};
  const byPlatform = {};
  let totalSpent = 0;

  for (const e of filtered) {
    const amt = Number(e.amountUSD) || 0;
    totalSpent += amt;
    byDay[e.date] = (byDay[e.date] || 0) + amt;
    const ym = String(e.date).slice(0, 7);
    byMonth[ym] = (byMonth[ym] || 0) + amt;

    const p = e.platform || "other";
    if (!byPlatform[p]) {
      byPlatform[p] = {
        platform: p,
        label: e.platformLabel || p,
        spent: 0,
        byDay: {},
        byMonth: {},
      };
    }
    byPlatform[p].spent += amt;
    byPlatform[p].byDay[e.date] = (byPlatform[p].byDay[e.date] || 0) + amt;
    byPlatform[p].byMonth[ym] = (byPlatform[p].byMonth[ym] || 0) + amt;
    if (e.platformLabel) byPlatform[p].label = e.platformLabel;
  }

  return {
    totalSpent,
    days: Object.keys(byDay).sort(),
    byDay,
    byMonth,
    byPlatform,
    entries: filtered,
  };
}

export function computeRoi(valueCost, spent) {
  const value = Number(valueCost) || 0;
  const s = Number(spent) || 0;
  const net = value - s;
  const ratio = s > 0 ? value / s : null;
  return { net, ratio, valuePerDollar: ratio };
}
