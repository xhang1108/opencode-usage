// extension/dashboard/settings/database-model.js
// Pure helpers for Settings → Database: backup filenames and the record-page
// truncation. No chrome, no DOM.

const pad = (n) => String(n).padStart(2, "0");

// Local wall-clock stamp, minute granularity: `YYYY-MM-DD_HH-mm`. Local (not
// UTC) so the name reads as the moment the user pressed Export; `:` is illegal
// in Windows filenames, hence the dashes in the time half.
export function exportStamp(when = new Date()) {
  const d = when instanceof Date ? when : new Date(when);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `_${pad(d.getHours())}-${pad(d.getMinutes())}`
  );
}

// The two disjoint backup files (settings JSON + records CSV) for a moment.
export function exportFilenames(when = new Date()) {
  const stamp = exportStamp(when);
  return {
    settings: `opencode-usage_settings_${stamp}.json`,
    records: `opencode-usage_records_${stamp}.csv`,
  };
}

// The first `limit` rows plus whether the store actually holds more (the store's
// own count can exceed the rows it returned).
export function pagedRows(rows, count, limit) {
  const shown = (rows || []).slice(0, limit);
  const total = count == null ? (rows || []).length : count;
  return { shown, hasMore: total > shown.length, total };
}
