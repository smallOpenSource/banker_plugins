// vendor.mjs: the vendored files this skill reads (fonts, the HarfBuzz subsetter, the H.264 encoder and PptxGenJS).
// Every file is checked against the sha256 of its original before use; a mismatch stops the run. They are all kept
// brotli-packed as <file>.br (node zlib brotli, quality 11, window 24) and unpacked here, in memory, never on disk:
// Codex hashes a plugin's whole folder before each of its hooks, inside that hook's time limit. vendor/README.md lists
// the same sha256 values with each file's source, version and license.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliDecompressSync } from 'node:zlib';

export const VENDOR = join(dirname(fileURLToPath(import.meta.url)), '..', 'vendor');

/** sha256 of each original file, by path under vendor/. */
export const ORIGINALS = Object.freeze({
  'fonts/NotoSans-Regular.ttf': 'f5f552c8c5edb61fe6efb824baf4d4de47b1a8689ab4925ff43f7bd6a4ebece5',
  'fonts/NotoSans-Bold.ttf': '3a08a47daa00cade516425c15c57615aef2fd418ec9811a7b9f465088f92cc05',
  'fonts/NotoSansKRStatic-Regular.ttf': 'b0b19d3bed7b0868c3ecd310d7c5f39b79b5d2204f095288a28f6f502a3e4782',
  'fonts/NotoSansKRStatic-Bold.ttf': '7d83d47d1a26d91431963003ae048db2ee7cb38ceb8ad1237054bdc11acb3287',
  'harfbuzz/harfbuzz-subset.wasm': '62415fe6bad92ef16f3e5d2dbed6c66a4adec7f5a59c6d27084811c92cce1ba5',
  'h264-mp4-encoder/h264-mp4-encoder.node.js': 'f8df9c1791b249f75e5cef77f8e32a135b4cdb2c918a0c4593669e8571085c0c',
  'pptxgenjs/pptxgen.bundle.js': '4fb9eac5cfefb213e2d8743c2b7151025f31bfb3f834c73c12062916daa0f3f8',
});

/** Files stored as <file>.br (scripts/pack-video-vendor.mjs in the repository packs them). */
export const PACKED = Object.freeze([
  'fonts/NotoSans-Regular.ttf',
  'fonts/NotoSans-Bold.ttf',
  'fonts/NotoSansKRStatic-Regular.ttf',
  'fonts/NotoSansKRStatic-Bold.ttf',
  'harfbuzz/harfbuzz-subset.wasm',
  'h264-mp4-encoder/h264-mp4-encoder.node.js',
  'pptxgenjs/pptxgen.bundle.js',
]);

export class VendorError extends Error {}

/** The exit code of a helper that stopped on e: 3 for a vendor check, else e.exit, else fallback. */
export const exitOf = (e, fallback) => (e instanceof VendorError ? 3 : e.exit || fallback);

/** Throws when any vendored file differs from its original: helpers call it before any work (exit 3). */
export function requireVendor(root = VENDOR) {
  const bad = verifyVendor(root);
  if (bad.length) throw new VendorError(bad.join('; '));
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** The original bytes of a vendored file, unpacked when packed, sha256-checked. Throws VendorError otherwise. */
export function vendorBytes(rel, root = VENDOR) {
  if (!Object.hasOwn(ORIGINALS, rel)) throw new VendorError(`vendor/${rel}: not a vendored file`);
  const packed = PACKED.includes(rel);
  const file = join(root, packed ? `${rel}.br` : rel);
  let bytes;
  try {
    bytes = readFileSync(file);
    if (packed) bytes = brotliDecompressSync(bytes);
  } catch (e) {
    throw new VendorError(`vendor/${rel}${packed ? '.br' : ''}: cannot read (${e.code || e.message}); reinstall the skill`);
  }
  if (sha256(bytes) !== ORIGINALS[rel]) throw new VendorError(`vendor/${rel}${packed ? '.br' : ''}: sha256 differs from the original; refusing to run, reinstall the skill`);
  return bytes;
}

/** Checks every vendored file; returns the list of problems (empty when all match). */
export function verifyVendor(root = VENDOR) {
  const bad = [];
  for (const rel of Object.keys(ORIGINALS)) {
    try { vendorBytes(rel, root); } catch (e) { bad.push(e.message); }
  }
  return bad;
}

/**
 * The H.264 MP4 encoder (Emscripten build of minih264 + libmp4v2), compiled as a CommonJS module from its unpacked,
 * sha256-checked bytes (only the .br is on disk; the module takes the original's path as its name, and a package.json
 * with "type": "module" above does not apply). Note: the glue registers process handlers for uncaught exceptions
 * and unhandled rejections when it loads; callers handle their own rejections.
 */
let h264Loaded = null;
export function h264Encoder(root = VENDOR) {
  if (h264Loaded && root === VENDOR) return h264Loaded;
  const src = vendorBytes('h264-mp4-encoder/h264-mp4-encoder.node.js', root).toString('utf8');
  const file = join(root, 'h264-mp4-encoder', 'h264-mp4-encoder.node.js');
  const Module = createRequire(import.meta.url)('node:module');
  const m = new Module(file);
  m.filename = file;
  m.paths = Module._nodeModulePaths(dirname(file));
  m._compile(src, file);
  if (typeof m.exports.createH264MP4Encoder !== 'function') throw new VendorError('h264-mp4-encoder did not load');
  if (root === VENDOR) h264Loaded = m.exports;
  return m.exports;
}

let pptxLoaded = null;
/**
 * PptxGenJS (browser UMD bundle, JSZip inside) run in a vm context of its own from the sha256-checked bytes: as
 * CommonJS it would export JSZip alone. A loading context, not a security boundary (the bundle is pinned code).
 */
export function pptxgen(root = VENDOR) {
  if (pptxLoaded && root === VENDOR) return pptxLoaded;
  const src = vendorBytes('pptxgenjs/pptxgen.bundle.js', root).toString('utf8');
  const sandbox = { console, setTimeout, clearTimeout, setImmediate, clearImmediate, queueMicrotask, Buffer, TextEncoder, TextDecoder, process: { versions: {}, release: {} } };
  sandbox.window = sandbox.self = sandbox.global = sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'pptxgen.bundle.js' });
  if (typeof sandbox.PptxGenJS !== 'function' || typeof sandbox.JSZip !== 'function') throw new VendorError('pptxgen.bundle.js did not load');
  const out = { PptxGenJS: sandbox.PptxGenJS, JSZip: sandbox.JSZip };
  if (root === VENDOR) pptxLoaded = out;
  return out;
}
