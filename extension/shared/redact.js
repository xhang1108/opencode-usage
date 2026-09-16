// extension/shared/redact.js
// D18: adapters keep the vendor's full per-record payload under `raw`, but must
// strip credentials first. Token *counts* (tokensIn, input, ...) are data, not
// secrets, so matching is by exact known key names, not a broad "token" regex.

export const DEFAULT_SECRET_KEYS = [
  "api_key",
  "apikey",
  "apiKey",
  "x-api-key",
  "authorization",
  "cookie",
  "set-cookie",
  "access_token",
  "refresh_token",
  "id_token",
  "client_secret",
  "secret",
  "password",
  "passwd",
  "credential",
  "credentials",
];

// Recursively clone `value`, dropping any object key in `secretKeys`
// (case-insensitive) or matching one of `patterns` (RegExp). Never mutates input.
export function redactSecrets(value, { secretKeys = DEFAULT_SECRET_KEYS, patterns = [] } = {}) {
  const deny = new Set(secretKeys.map((k) => String(k).toLowerCase()));
  const shouldDrop = (key) => deny.has(String(key).toLowerCase()) || patterns.some((re) => re.test(key));
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out = {};
      for (const [k, val] of Object.entries(v)) {
        if (shouldDrop(k)) continue;
        out[k] = walk(val);
      }
      return out;
    }
    return v;
  };
  return walk(value);
}
