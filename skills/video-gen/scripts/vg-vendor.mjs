// vg-vendor.mjs: the vendored files video-gen reads. The large ones (the CanvasKit WASM and the four fonts) are kept
// brotli-packed as <file>.br: Codex hashes a plugin's whole folder before each of its hooks, inside that hook's time
// limit, and these files were 19 MB of the banker plugin. They are unpacked here, in memory, and must match the original
// files' sha256 (vendor/README.md records the same values; scripts/pack-video-vendor.mjs in the repository packs them).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync } from "node:zlib";

export const VENDOR = join(dirname(fileURLToPath(import.meta.url)), "..", "vendor");

/** The original files' sha256, by path under vendor/. */
export const ORIGINALS = Object.freeze({
  "canvaskit/canvaskit.js": "894815b2d39b24de2eacdb01453778d83e0b6c418b034e3b728e80956ac2a9d5",
  "canvaskit/canvaskit.wasm": "aca7fa6019f95d3de98d4a49ae60a3d66a09e9d5ca74091fbc369b9be959f959",
  "h264-mp4-encoder/h264-mp4-encoder.node.js": "f8df9c1791b249f75e5cef77f8e32a135b4cdb2c918a0c4593669e8571085c0c",
  "fonts/NotoSans-Regular.ttf": "478c558ea716033cd60c03438f628dfa75694dcf6b5f6d505a2f05fd2b4f3823",
  "fonts/NotoSans-Bold.ttf": "1df075a380fc7cb898acf64c1f7b3b4dd780de3caa860178bf929de35817a913",
  "fonts/NotoSansKR-Regular.otf": "69975a0ac8472717870aefeab0a4d52739308d90856b9955313b2ad5e0148d68",
  "fonts/NotoSansKR-Bold.otf": "5a6ceb287ed2fc6cfc6213144ebea68cbd94b20fc9eb873d8486493bf02d9bda",
});

/** The files kept as <file>.br. The two JavaScript files are loaded by require, so they stay as they are. */
export const PACKED = Object.freeze([
  "canvaskit/canvaskit.wasm",
  "fonts/NotoSans-Regular.ttf",
  "fonts/NotoSans-Bold.ttf",
  "fonts/NotoSansKR-Regular.otf",
  "fonts/NotoSansKR-Bold.otf",
]);

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** The original bytes of a packed vendor file, unpacked and checked. Throws when the file is missing or damaged. */
export function vendorBytes(rel) {
  if (!PACKED.includes(rel)) throw new Error(`vendor/${rel}: 묶어 둔 파일이 아님`);
  let bytes;
  try {
    bytes = brotliDecompressSync(readFileSync(join(VENDOR, `${rel}.br`)));
  } catch (e) {
    throw new Error(`vendor/${rel}.br 를 풀지 못함(${e.code || e.message}). banker 를 다시 설치하십시오`);
  }
  if (sha256(bytes) !== ORIGINALS[rel]) throw new Error(`vendor/${rel}.br 가 원본과 다름. banker 를 다시 설치하십시오`);
  return bytes;
}
