// extension/dashboard/settings/general-model.js
// Pure model behind Settings → General: the workspace list and the summary
// counts. No chrome, no DOM.

// One entry per `source:workspaceID`, with the record count, sorted by source
// then id. The workspace id is never rewritten (only its display label is).
export function workspaceList(records) {
  const byWs = new Map();
  for (const rec of records || []) {
    const source = rec.source || "opencode";
    const id = `${source}:${rec.workspaceID || "wrk_unknown"}`;
    const entry = byWs.get(id) || { id, source, count: 0 };
    entry.count++;
    byWs.set(id, entry);
  }
  return [...byWs.values()].sort(
    (a, b) => String(a.source).localeCompare(String(b.source)) || String(a.id).localeCompare(String(b.id))
  );
}

// The summary rows rendered under the crawl picker.
export function summaryModel({ vendors, isEnabled, pricing, records }) {
  const list = vendors || [];
  return {
    enabledCount: list.filter((v) => v && isEnabled(v.source)).length,
    vendorCount: list.length,
    mappedCount: Object.keys((pricing && pricing.modelMap) || {}).length,
    targetCount: Object.keys((pricing && pricing.targets) || {}).length,
    recordsCount: (records || []).length,
  };
}
