#!/usr/bin/env node
// Packs a video-gen vendor file as <file>.br (node zlib brotli, quality 11, 16 MB window) and prints the original's
// sha256 for skills/video-gen/scripts/vg-vendor.mjs and vendor/README.md. Repo-only (scripts/ is not in the npm package).
// usage: node scripts/pack-video-vendor.mjs <original file>...   (the original stays; remove it once the .br is in place)
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib';

const files = process.argv.slice(2);
if (!files.length) {
  process.stderr.write('usage: node scripts/pack-video-vendor.mjs <original file>...\n');
  process.exit(2);
}
for (const file of files) {
  const data = readFileSync(file);
  const packed = brotliCompressSync(data, { params: {
    [constants.BROTLI_PARAM_QUALITY]: 11,
    [constants.BROTLI_PARAM_LGWIN]: 24,
    [constants.BROTLI_PARAM_SIZE_HINT]: data.length,
  } });
  if (!brotliDecompressSync(packed).equals(data)) throw new Error(`${file}: the packed file does not unpack to the original`);
  writeFileSync(`${file}.br`, packed);
  const sha = createHash('sha256').update(data).digest('hex');
  process.stdout.write(`${file}\t${data.length} -> ${packed.length}\tsha256 ${sha}\n`);
}
