import { test } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";

import { unzip, unzipText, decodeText } from "../../extension/shared/zip.js";

// Build a minimal ZIP in-memory (CRC left 0; the reader does not verify it).
function makeZip(files) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name);
    const raw = Buffer.from(f.data);
    const method = f.store ? 0 : 8;
    const comp = f.store ? raw : zlib.deflateRawSync(raw);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(name.length, 26);
    local.push(lh, name, comp);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);

    offset += lh.length + name.length + comp.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cdBuf, eocd]);
}

test("unzip reads stored (method 0) and deflated (method 8) entries", async () => {
  const buf = makeZip([
    { name: "stored.txt", data: "hello", store: true },
    { name: "amount-1.csv", data: "a,b\n1,2\n" },
  ]);
  const files = await unzip(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  assert.equal(decodeText(files["stored.txt"]), "hello");
  assert.equal(decodeText(files["amount-1.csv"]), "a,b\n1,2\n");
});

test("unzipText returns decoded text entries and skips directories", async () => {
  const buf = makeZip([
    { name: "dir/", data: "", store: true },
    { name: "dir/x.csv", data: "ok", store: true },
  ]);
  const files = await unzipText(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  assert.deepEqual(Object.keys(files), ["dir/x.csv"]);
  assert.equal(files["dir/x.csv"], "ok");
});

test("unzip rejects non-ZIP input", async () => {
  await assert.rejects(() => unzip(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer));
});
