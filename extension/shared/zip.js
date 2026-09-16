// extension/shared/zip.js
// Minimal ZIP reader (central directory + DEFLATE) so exports (DeepSeek ZIP,
// MiMo XLSX) are decompressed inside the extension (D17) without a library.
// Reads stored (method 0) and deflate-raw (method 8) entries. No Zip64, no
// encryption, CRC is not verified (not needed for our own exports).

export async function unzip(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const bytes = new Uint8Array(arrayBuffer);
  const eocd = findEOCD(view);
  if (eocd < 0) throw new Error("Not a ZIP file (no end-of-central-directory)");

  const total = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const files = {};

  for (let i = 0; i < total; i++) {
    if (offset + 46 > view.byteLength || view.getUint32(offset, true) !== 0x02014b50) break;
    const method = view.getUint16(offset + 10, true);
    const compSize = view.getUint32(offset + 20, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLen));
    offset += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith("/")) continue;
    if (localOffset + 30 > view.byteLength || view.getUint32(localOffset, true) !== 0x04034b50) continue;
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const compressed = bytes.subarray(dataStart, dataStart + compSize);

    if (method === 0) files[name] = compressed.slice();
    else if (method === 8) files[name] = await inflateRaw(compressed);
    else throw new Error(`Unsupported ZIP compression method: ${method}`);
  }
  return files;
}

function findEOCD(view) {
  const min = Math.max(0, view.byteLength - 22 - 0xffff);
  for (let i = view.byteLength - 22; i >= min; i--) {
    if (view.getUint32(i, true) === 0x06054b50) return i;
  }
  return -1;
}

async function inflateRaw(u8) {
  const stream = new Response(u8).body.pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function decodeText(u8) {
  return new TextDecoder("utf-8").decode(u8);
}

// Convenience for text entries (e.g. amount-*.csv).
export async function unzipText(arrayBuffer) {
  const files = await unzip(arrayBuffer);
  const out = {};
  for (const [name, bytes] of Object.entries(files)) out[name] = decodeText(bytes);
  return out;
}
