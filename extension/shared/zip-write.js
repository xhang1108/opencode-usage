// extension/shared/zip-write.js
// Minimal ZIP writer (stored / method 0 only) so backups ship as ONE .zip
// containing split CSV parts. No library, no compression: `stored` entries are
// just the raw bytes plus headers, readable by every OS unzip.
//
// Pairs with shared/zip.js (reader supports method 0 + 8). Pure (P9).
// No Zip64: parts are capped at 4MiB and the whole zip stays far below 4GiB.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const enc = new TextEncoder();

// Pack [{ name, data: Uint8Array }] into a stored-only ZIP. Returns Uint8Array.
export function zipWrite(files) {
  const list = files || [];
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of list) {
    const name = enc.encode(f.name);
    const data = f.data instanceof Uint8Array ? f.data : new Uint8Array(f.data || []);
    const crc = crc32(data);

    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0x0800, true); // UTF-8 names
    lh.setUint16(8, 0, true); // stored
    lh.setUint16(10, 0, true);
    lh.setUint16(12, 0, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true);
    lh.setUint32(22, data.length, true);
    lh.setUint16(26, name.length, true);
    lh.setUint16(28, 0, true);
    chunks.push(new Uint8Array(lh.buffer), name, data);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, (3 << 8) | 20, true); // made by Unix, version needed 20
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, 0, true);
    cd.setUint16(14, 0, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, data.length, true);
    cd.setUint32(24, data.length, true);
    cd.setUint16(28, name.length, true);
    cd.setUint16(30, 0, true);
    cd.setUint16(32, 0, true);
    cd.setUint16(34, 0, true);
    cd.setUint16(36, 0, true);
    cd.setUint32(38, 0, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);

    offset += 30 + name.length + data.length;
  }
  const cdChunks = [];
  let cdSize = 0;
  for (const c of central) {
    cdChunks.push(c);
    cdSize += c.length;
  }
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(4, 0, true);
  eocd.setUint16(6, 0, true);
  eocd.setUint16(8, list.length, true);
  eocd.setUint16(10, list.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, offset, true);
  eocd.setUint16(20, 0, true);

  const out = new Uint8Array(offset + cdSize + 22);
  let pos = 0;
  for (const c of [...chunks, ...cdChunks, new Uint8Array(eocd.buffer)]) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}
