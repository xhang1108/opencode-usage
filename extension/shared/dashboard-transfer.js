// extension/shared/dashboard-transfer.js
// Chunked transfer for the merged dashboard snapshot.
//
// A dashboard load used to be one `chrome.runtime.sendMessage` response holding
// the whole snapshot as JSON. Chrome caps a single extension message at 64MiB,
// so a large local import + API store made every load fail. The snapshot is now
// sliced here and reassembled by the dashboard, one message at a time.

// 4 MiB UTF-16 code units. JSON records are mostly ASCII (1 byte/unit), so a
// chunk is ~4MiB on the wire — far below the 64MiB message cap. Worst case is
// 3 bytes per BMP unit (~12MiB), still safe; astral characters add one unit.
export const DASHBOARD_CHUNK_CHARS = 4 * 1024 * 1024;

// End index for the next slice. Never split a surrogate pair: a lone half
// would be replaced by U+FFFD when Chrome serialises the message.
export function chunkEnd(text, offset, size) {
  const length = typeof text === "string" ? text.length : 0;
  const start = Math.max(0, Math.min(Number(offset) || 0, length));
  const step = Math.max(1, Number(size) || DASHBOARD_CHUNK_CHARS);
  let end = Math.min(start + step, length);
  if (end < length && end > start) {
    const code = text.charCodeAt(end - 1);
    // The slice would end on a high surrogate; take its low half too. The
    // chunk grows by one code unit instead of losing a character.
    if (code >= 0xd800 && code <= 0xdbff) end += 1;
  }
  return Math.max(start, end);
}
