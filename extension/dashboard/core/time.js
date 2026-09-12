// extension/dashboard/core/time.js
// D19: records store `time` in UTC; all display (charts, tables, hourly) groups
// by the viewer's LOCAL calendar. The stored `date` is never trusted.
// Pure module: no DOM, no chrome (testable with node --test).

export function localDateOf(record) {
  const t = record && record.time ? new Date(record.time) : null;
  if (!t || isNaN(t.getTime())) return (record && record.date) || "";
  const y = t.getFullYear();
  const m = String(t.getMonth() + 1).padStart(2, "0");
  const d = String(t.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function localHourOf(record) {
  const t = record && record.time ? new Date(record.time) : null;
  if (!t || isNaN(t.getTime())) return null;
  return t.getHours();
}

export function toISODate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function todayISO(now = new Date()) {
  return toISODate(now);
}

// Whole-day difference between two local "YYYY-MM-DD" strings.
export function inclusiveDayDiff(startISO, endISO) {
  const a = new Date(`${startISO}T00:00:00`);
  const b = new Date(`${endISO}T00:00:00`);
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return 0;
  return Math.round((b - a) / 86400000);
}

export function localDateRange(records) {
  let min = null;
  let max = null;
  for (const rec of records || []) {
    const d = localDateOf(rec);
    if (!d) continue;
    if (min === null || d < min) min = d;
    if (max === null || d > max) max = d;
  }
  return { min, max };
}
