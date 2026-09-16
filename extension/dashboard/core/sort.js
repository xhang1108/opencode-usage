// extension/dashboard/core/sort.js
// Pure, stable-ish table sorting used by the dashboard tables (P9).

export function sortBy(arr, col, dir) {
  return arr.slice().sort((a, b) => {
    let va = a[col];
    let vb = b[col];
    if (typeof va === "string") va = va.toLowerCase();
    if (typeof vb === "string") vb = vb.toLowerCase();
    if (va == null) va = -Infinity;
    if (vb == null) vb = -Infinity;
    if (va === vb) return 0;
    return va > vb ? dir : -dir;
  });
}
