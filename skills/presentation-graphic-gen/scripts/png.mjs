// png.mjs: decodes the PNG files Chrome writes (8-bit RGB / RGBA / gray, not interlaced) and compares two images.
// Node built-ins only (zlib).
import { inflateSync } from 'node:zlib';

/** { width, height, data: RGBA Uint8Array } */
export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let off = 8, w = 0, h = 0, depth = 0, type = 0, inter = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off), kind = buf.toString('latin1', off + 4, off + 8), body = buf.subarray(off + 8, off + 8 + len);
    if (kind === 'IHDR') { w = body.readUInt32BE(0); h = body.readUInt32BE(4); depth = body[8]; type = body[9]; inter = body[12]; }
    else if (kind === 'IDAT') idat.push(body);
    else if (kind === 'IEND') break;
    off += 12 + len;
  }
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[type];
  if (depth !== 8 || !ch || inter) throw new Error(`unsupported PNG (depth ${depth}, color type ${type}, interlace ${inter})`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * ch, px = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? px[dst + x - ch] : 0, b = y ? px[dst - stride + x] : 0, c = x >= ch && y ? px[dst - stride + x - ch] : 0;
      let v = raw[src + x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[dst + x] = v & 255;
    }
  }
  const data = new Uint8Array(w * h * 4);
  for (let i = 0, j = 0; i < w * h; i++, j += ch) {
    const g = ch <= 2;
    data[i * 4] = px[j]; data[i * 4 + 1] = g ? px[j] : px[j + 1]; data[i * 4 + 2] = g ? px[j] : px[j + 2];
    data[i * 4 + 3] = ch === 4 ? px[j + 3] : ch === 2 ? px[j + 1] : 255;
  }
  return { width: w, height: h, data };
}

/** Pixel difference: { max (largest channel difference), count (pixels whose difference exceeds tol), share }. */
export function diffPng(a, b, tol = 16) {
  const A = decodePng(a), B = decodePng(b);
  if (A.width !== B.width || A.height !== B.height) return { max: 255, count: A.width * A.height, share: 1, size: false };
  let max = 0, count = 0;
  for (let i = 0; i < A.data.length; i += 4) {
    const d = Math.max(Math.abs(A.data[i] - B.data[i]), Math.abs(A.data[i + 1] - B.data[i + 1]), Math.abs(A.data[i + 2] - B.data[i + 2]));
    if (d > max) max = d;
    if (d > tol) count++;
  }
  return { max, count, share: count / (A.width * A.height), size: true };
}
