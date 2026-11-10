// wg-zip.mjs: a minimal ZIP writer (deflate, no ZIP64) for the XLSX package. Pure Node: zlib is built in, and the
// CRC-32 is computed here because zlib.crc32 only exists from Node 20.15 / 22.2.
import { deflateRawSync } from "node:zlib";

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// 1980-01-01 00:00 in DOS time: a fixed stamp so the same plan gives the same bytes.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

function header(sig, size) {
  const b = Buffer.alloc(size);
  b.writeUInt32LE(sig, 0);
  return b;
}

function localHeader(name, crc, comp, raw) {
  const h = header(0x04034b50, 30);
  h.writeUInt16LE(20, 4); // version needed
  h.writeUInt16LE(0x0800, 6); // UTF-8 names
  h.writeUInt16LE(8, 8); // deflate
  h.writeUInt16LE(DOS_TIME, 10);
  h.writeUInt16LE(DOS_DATE, 12);
  h.writeUInt32LE(crc, 14);
  h.writeUInt32LE(comp, 18);
  h.writeUInt32LE(raw, 22);
  h.writeUInt16LE(name.length, 26);
  return h;
}

function centralHeader(name, crc, comp, raw, offset) {
  const h = header(0x02014b50, 46);
  h.writeUInt16LE(20, 4); // version made by
  h.writeUInt16LE(20, 6);
  h.writeUInt16LE(0x0800, 8);
  h.writeUInt16LE(8, 10);
  h.writeUInt16LE(DOS_TIME, 12);
  h.writeUInt16LE(DOS_DATE, 14);
  h.writeUInt32LE(crc, 16);
  h.writeUInt32LE(comp, 20);
  h.writeUInt32LE(raw, 24);
  h.writeUInt16LE(name.length, 28);
  h.writeUInt32LE(offset, 42);
  return h;
}

/** entries: [{ name, data: Buffer|string }] in order. Returns the ZIP as one Buffer. */
export function zip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, "utf8");
    const comp = deflateRawSync(raw, { level: 9 });
    const crc = crc32(raw);
    const local = localHeader(name, crc, comp.length, raw.length);
    parts.push(local, name, comp);
    central.push(centralHeader(name, crc, comp.length, raw.length, offset), name);
    offset += local.length + name.length + comp.length;
  }
  const dir = Buffer.concat(central);
  const end = header(0x06054b50, 22);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}
