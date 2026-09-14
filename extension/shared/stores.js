// extension/shared/stores.js
// Record stores and their clear semantics, shared by background
// (handleGetDatabase) and the dashboard (Settings -> Database) so that store
// classification and clearing never drift. Zero chrome dependencies (P9).
//
// Provenance is decided by WHICH BUCKET a record is stored in, not by guessing
// from its id/workspace. The Database tab therefore lists every stored record
// in exactly one store, and each managed store maps to exactly one clear
// message. Adding a store means adding it here (see the invariant test).

export const OPFS_STORE_KEY = "opfs";
export const LOCAL_STORE_KEY = "local";
export const VENDOR_STORE_PREFIX = "vendor:";

// The message that clears a managed store, or null for a read-only store
// (OPFS crawl data is owned by the page crawler and cannot be deleted here).
export function clearMessageFor(storeKey) {
  if (storeKey === LOCAL_STORE_KEY) return { type: "clear-local-data" };
  if (typeof storeKey === "string" && storeKey.startsWith(VENDOR_STORE_PREFIX)) {
    const source = storeKey.slice(VENDOR_STORE_PREFIX.length);
    return source ? { type: "clear-vendor-data", source } : null;
  }
  return null;
}
