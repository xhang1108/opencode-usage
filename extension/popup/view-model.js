// extension/popup/view-model.js
// Pure formatting / decision logic behind the popup. The popup is a thin DOM
// shell over these; keeping them here lets the status line, the crawl button
// label and the workspace link be tested without a DOM. No chrome, no DOM.

import { isSourceEnabled } from "../shared/sources.js";

// Date+time for a record, falling back to its stored date then "-".
export function formatDateTime(rec) {
  if (rec && rec.time) {
    const d = new Date(rec.time);
    if (!isNaN(d.getTime())) {
      const pad = (n) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
  }
  return (rec && rec.date) || "-";
}

// The provider label for the default crawl vendor: its registry label, else the
// source name capitalized ("opencode" -> "Opencode").
export function defaultCrawlLabel(stored) {
  const src = (stored && stored.defaultCrawl) || "opencode";
  const vendors = (stored && stored.vendorRegistry && stored.vendorRegistry.vendors) || [];
  const v = vendors.find((x) => x.source === src);
  return v && v.label ? v.label : src.charAt(0).toUpperCase() + src.slice(1);
}

// Main button label: holding Shift flips an incremental sync into a full one.
export function crawlButtonText({ shiftHeld, label }) {
  return {
    text: shiftHeld ? `Full Sync ${label}` : `Sync ${label}`,
    title: shiftHeld
      ? `Click to re-sync ALL ${label} history from scratch`
      : `Click to sync ${label} now · hold Shift for a full sync`,
  };
}

const isWorkspaceId = (id) => typeof id === "string" && /^(?:org_|wrk_)/.test(id);

// Which workspace the "Open Usage" link should point at: the last visited
// (most recent) workspace wins, then the last synced one, then the last record's,
// then the in-flight crawl's. Returns "" when none is known.
export function pickUsageWorkspace(stored) {
  stored = stored || {};
  const cached = stored.cachedMeta && stored.cachedMeta.lastRecord;
  return (
    (isWorkspaceId(stored.lastVisitedWorkspace) && stored.lastVisitedWorkspace) ||
    (isWorkspaceId(stored.lastSyncWorkspace) && stored.lastSyncWorkspace) ||
    (cached && cached.workspaceID) ||
    (stored.crawlState && stored.crawlState.workspace) ||
    ""
  );
}

export function usageUrl(workspaceID) {
  return `https://opencode.ai/console/${workspaceID}/usage`;
}

// Vendors that are enabled AND have a crawler — the choices in the crawl picker.
export function crawlableVendors(vendors, vendorSettings) {
  return (vendors || []).filter((v) => v && v.crawl && isSourceEnabled(v.source, vendorSettings));
}

// The popup status line text for a background reply. Returns null when the
// message has no user-facing effect (nothing to say).
export function crawlStatusText(msg, res) {
  if (!res || !res.ok) {
    return { text: `Error: ${(res && res.error) || "unknown error"}`, ok: false };
  }
  if (msg.type === "start-crawl") {
    if (res.openedUsage) {
      return { text: res.started ? "Opened Usage page & sync started" : "Opened Usage page - syncing...", ok: true };
    }
    const label = msg.rescan ? "Rescan" : "Sync";
    if (res.started) return { text: `${label} started - watch the icon badge`, ok: true };
    if (res.reason === "busy") return { text: "Sync already in progress", ok: true };
    return { text: "Sync requested", ok: true };
  }
  if (msg.type === "open-dashboard") {
    return { text: `Dashboard opened (${res.fromCache ? "cached" : "latest"} data, ${res.count} records)`, ok: true };
  }
  return null;
}
