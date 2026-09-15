// extension/dashboard/core/date-range.js
// Pure logic behind the custom date-range picker (presets, day clicks, the
// trigger label, and the initial bounds). Extracted from views/filters.js so the
// behavior is testable without a DOM. Uses the viewer's LOCAL calendar.
import { toISODate, todayISO } from "./time.js";

// "today" | "7d" | "30d" | "month" | "all" -> { start, end } (local ISO dates).
export function presetRange(name, now = new Date()) {
  switch (name) {
    case "today":
      return { start: todayISO(now), end: todayISO(now) };
    case "all":
      return { start: "", end: "" };
    case "7d": {
      const s = new Date(now);
      s.setDate(s.getDate() - 6);
      return { start: toISODate(s), end: toISODate(now) };
    }
    case "30d": {
      const s = new Date(now);
      s.setDate(s.getDate() - 29);
      return { start: toISODate(s), end: toISODate(now) };
    }
    case "month":
      return { start: toISODate(new Date(now.getFullYear(), now.getMonth(), 1)), end: toISODate(now) };
    default:
      return { start: "", end: "" };
  }
}

// One click on a calendar day. The first click starts a range; the second closes
// it (reversed clicks are swapped so start <= end); a click with a complete range
// already picked starts a new one.
export function pickRangeDay(range, iso) {
  const { start, end } = range || { start: "", end: "" };
  if (!start || (start && end)) return { start: iso, end: "" };
  return iso < start ? { start: iso, end: start } : { start, end: iso };
}

// The min/max local dates present in the records, ignoring blank/"Unknown" days.
export function dateBounds(records, localDateOf) {
  let min = null;
  let max = null;
  for (const rec of records || []) {
    const d = localDateOf(rec);
    if (!d || d === "Unknown") continue;
    if (min === null || d < min) min = d;
    if (max === null || d > max) max = d;
  }
  return { min, max };
}

// Trigger text for the current range.
export function rangeLabel({ start, end }) {
  if (start && end) return `${start} → ${end}`;
  if (start) return start;
  if (end) return `Until ${end}`;
  return "All Time";
}
