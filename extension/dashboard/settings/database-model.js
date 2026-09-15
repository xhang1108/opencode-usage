// extension/dashboard/settings/database-model.js
// Pure helpers for Settings → Database: backup filenames and the record-page
// truncation. No chrome, no DOM.

// The two disjoint backup files (settings JSON + records CSV) for a date.
export function exportFilenames(dateISO) {
  return {
    settings: `opencode-usage_settings_${dateISO}.json`,
    records: `opencode-usage_records_${dateISO}.csv`,
  };
}

// The first `limit` rows plus whether the store actually holds more (the store's
// own count can exceed the rows it returned).
export function pagedRows(rows, count, limit) {
  const shown = (rows || []).slice(0, limit);
  const total = count == null ? (rows || []).length : count;
  return { shown, hasMore: total > shown.length, total };
}
