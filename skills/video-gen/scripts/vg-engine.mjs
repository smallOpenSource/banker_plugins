// vg-engine.mjs: the bundled render engine. Skia CanvasKit (WASM) draws each frame on the CPU and the H.264 MP4
// encoder (WASM) writes the video: no Chrome, no ffmpeg, no native module, the same on every OS.
// Fonts are the bundled Noto Sans and Noto Sans KR; text asks for Noto Sans first, so Latin letters, digits and
// symbols use it and Hangul falls through to Noto Sans KR.
// The encoder's Emscripten glue registers process handlers for uncaught exceptions and unhandled rejections when it
// is required; the CLI handles its own rejections, so they never reach those handlers.
import { createRequire } from "node:module";
import { join } from "node:path";

import { VENDOR, vendorBytes } from "./vg-vendor.mjs";

const require = createRequire(import.meta.url);
export const FAMILIES = ["Noto Sans", "Noto Sans KR"];
const FONTS = [
  ["NotoSans-Regular.ttf", "Noto Sans"],
  ["NotoSans-Bold.ttf", "Noto Sans"],
  ["NotoSansKR-Regular.otf", "Noto Sans KR"],
  ["NotoSansKR-Bold.otf", "Noto Sans KR"],
];

let engine = null;

/** CanvasKit with the bundled fonts registered: { CK, fonts }. Loaded once per process, also when asked twice at once. */
export function loadEngine() {
  engine ??= startEngine();
  return engine;
}

async function startEngine() {
  const init = require(join(VENDOR, "canvaskit", "canvaskit.js"));
  const wasm = vendorBytes("canvaskit/canvaskit.wasm");
  const CK = await withWasm(wasm, () => init({ locateFile: (f) => join(VENDOR, "canvaskit", `${f}.br`) }));
  const fonts = CK.TypefaceFontProvider.Make();
  for (const [file, family] of FONTS) fonts.registerFont(vendorBytes(`fonts/${file}`), family);
  return { CK, fonts };
}

// CanvasKit's Emscripten glue takes no wasmBinary: it reads the file locateFile names and hands those bytes to
// WebAssembly.instantiate. It is pointed at the packed file (which it can read), and while it starts, and only then,
// WebAssembly.instantiate gets the unpacked bytes vendorBytes checked in place of what the glue read.
async function withWasm(wasm, start) {
  const real = WebAssembly.instantiate;
  WebAssembly.instantiate = (source, imports) => real.call(WebAssembly, source instanceof WebAssembly.Module ? source : wasm, imports);
  try {
    return await start();
  } finally {
    WebAssembly.instantiate = real;
  }
}

/**
 * An H.264 MP4 writer: add(rgba) per frame, then finish() returns the MP4 bytes. Width and height must be even.
 * quality is the quantizer (10 best .. 51 smallest); speed 0 (best) .. 10 (fastest).
 */
export async function mp4Writer({ width, height, fps, quality = 20, speed = 5 }) {
  const HME = require(join(VENDOR, "h264-mp4-encoder", "h264-mp4-encoder.node.js"));
  const enc = await HME.createH264MP4Encoder();
  enc.width = width;
  enc.height = height;
  enc.frameRate = fps;
  enc.quantizationParameter = quality;
  enc.speed = speed;
  enc.initialize();
  let count = 0;
  return {
    add(rgba) {
      enc.addFrameRgba(rgba);
      count++;
    },
    finish() {
      enc.finalize();
      const bytes = Buffer.from(enc.FS.readFile(enc.outputFilename));
      enc.FS.unlink(enc.outputFilename);
      enc.delete();
      return { bytes, frames: count };
    },
    // Deleting an unfinished encoder throws inside the WASM glue; finish it first and swallow what it throws, so
    // the caller's own error is the one reported.
    abort() {
      for (const step of [() => enc.finalize(), () => enc.FS.unlink(enc.outputFilename), () => enc.delete()]) {
        try {
          step();
        } catch {
          // already finished, or never started
        }
      }
    },
  };
}
