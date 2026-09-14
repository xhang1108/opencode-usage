// extension/dashboard/views/format.js
// Shared display formatting helpers for tables, charts and KPI cards.

// USD with thousands separators and a fixed number of decimals.
export const fmtMoney = (v, digits = 4) =>
  (Number(v) || 0).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });

// Escape external data (model names, workspace IDs) before innerHTML injection.
export const escHTML = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);

// Compact axis tick: 1500 -> "1.5k", 2_000_000 -> "2m".
export function compactTick(n) {
  const abs = Math.abs(n);
  let v;
  let sfx = "";
  if (abs >= 1e9) {
    v = n / 1e9;
    sfx = "b";
  } else if (abs >= 1e6) {
    v = n / 1e6;
    sfx = "m";
  } else if (abs >= 1e3) {
    v = n / 1e3;
    sfx = "k";
  } else {
    return String(Math.round(n));
  }
  return `${Number(v.toFixed(1)).toString()}${sfx}`;
}

// Display name for a workspace id, using the user's label map when present.
export function workspaceName(wsID, labels) {
  const id = wsID || "wrk_unknown";
  return (labels && labels[id]) || id;
}

// Trigger a client-side download of a text payload.
export function downloadText(filename, text, type = "application/json") {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Briefly swap a button label to confirm a clipboard action.
export function flashButton(btn, msg) {
  if (!btn) return;
  const orig = btn.textContent;
  btn.textContent = msg;
  setTimeout(() => {
    btn.textContent = orig;
  }, 1500);
}
