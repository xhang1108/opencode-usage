// extension/dashboard/settings/spend-model.js
// Pure helpers for Settings → Spend. No chrome, no DOM.

import { toISODate } from "../core/time.js";
import { isValidDate } from "../../shared/spend.js";

export function platformOptions(vendors) {
  const seen = new Set();
  const opts = [];
  for (const v of vendors || []) {
    if (!v || !v.source || seen.has(v.source)) continue;
    seen.add(v.source);
    opts.push({ value: v.source, label: v.label || v.source });
  }
  if (!seen.has("other")) opts.push({ value: "other", label: "Other" });
  return opts;
}

export function spendTableRows(entries, { sortBy = "date", sortDir = -1 } = {}) {
  const dir = sortDir >= 0 ? 1 : -1;
  const rows = (entries || []).slice();
  rows.sort((a, b) => {
    const va = a && a[sortBy] != null ? a[sortBy] : "";
    const vb = b && b[sortBy] != null ? b[sortBy] : "";
    if (va < vb) return -dir;
    if (va > vb) return dir;
    return 0;
  });
  return rows;
}

export function spendSummary(entries, { now = () => new Date() } = {}) {
  const list = (entries || []).filter((e) => e && isValidDate(e.date));
  const total = list.reduce((s, e) => s + (Number(e.amountUSD) || 0), 0);
  const cutoff = new Date(now());
  cutoff.setMonth(cutoff.getMonth() - 12);
  const cutoffStr = toISODate(cutoff);
  const last12 = list
    .filter((e) => e.date >= cutoffStr)
    .reduce((s, e) => s + (Number(e.amountUSD) || 0), 0);
  return { total, last12, count: list.length };
}
