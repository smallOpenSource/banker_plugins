#!/usr/bin/env node
// record.mjs: one H.264 MP4 per step of a built deck page, rendered deterministically (not in real time).
//
//   node scripts/record.mjs <present.html> [--out <dir>] [--fps 30] [--hold 0.5] [--quality 20] [--speed 5] [--force]
//
// For step i the page jumps to the end of step i-1, then for every frame k the master timeline is set with
// __deck.seek(start + k / fps) (the last animated frame is exactly the step's end time) and the stage is captured
// with Page.captureScreenshot. The last frame is held for --hold seconds. Frames are encoded with the vendored
// h264-mp4-encoder (WASM; no ffmpeg). Step i's first frame and step i-1's last frame show the same master time.
// Output (--out, default <html dir>/<html name>-media/): NN-<id>.mp4, NN-<id>-first.png, NN-<id>-last.png,
// manifest.json. An existing non-empty output folder is refused unless --force.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findBrowser, launch } from './cdp.mjs';
import { decodePng } from './png.mjs';
import { exitOf, h264Encoder } from './vendor.mjs';

const pad2 = (n) => String(n).padStart(2, '0');

/** An H.264 MP4 writer: add(rgba) per frame, finish() returns the MP4 bytes. Width and height must be even. */
export async function mp4Writer({ width, height, fps, quality = 20, speed = 5 }) {
  const enc = await h264Encoder().createH264MP4Encoder();
  enc.width = width;
  enc.height = height;
  enc.frameRate = fps;
  enc.quantizationParameter = quality;
  enc.speed = speed;
  enc.initialize();
  let count = 0, done = false;
  return {
    add(rgba) { enc.addFrameRgba(rgba); count++; },
    finish() {
      done = true;
      enc.finalize();
      const bytes = Buffer.from(enc.FS.readFile(enc.outputFilename));
      enc.FS.unlink(enc.outputFilename);
      enc.delete();
      return { bytes, frames: count };
    },
    // deleting an unfinished encoder throws inside the glue; finish it first and keep the caller's error
    abort() {
      if (done) return;
      done = true;
      for (const step of [() => enc.finalize(), () => enc.FS.unlink(enc.outputFilename), () => enc.delete()]) {
        try { step(); } catch { /* keep the error that stopped the recording */ }
      }
    },
  };
}

export async function record(file, { out = null, fps = 30, hold = 0.5, quality = 20, speed = 5, force = false, log = (l) => process.stdout.write(l + '\n'), browser = findBrowser() } = {}) {
  file = resolve(file);
  out = out || join(dirname(file), `${basename(file, extname(file))}-media`);
  if (existsSync(out) && readdirSync(out).length && !force) throw Object.assign(new Error(`${out} is not empty; not overwriting (use --force)`), { exit: 2 });
  mkdirSync(out, { recursive: true });
  const b = await launch({ browser });
  const manifest = { source: basename(file), fps, hold, width: 1920, height: 1080, steps: [] };
  try {
    const page = await b.open(pathToFileURL(file).href + '#0');
    const info = await page.eval(`({ steps: __deck.steps, error: __deck.error,
      stage: (() => { const r = document.getElementById('stage').getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; })() })`);
    if (info.error) throw new Error(`deck error: ${info.error}`);
    const clip = info.stage;
    if (Math.round(clip.width) !== 1920 || Math.round(clip.height) !== 1080) throw new Error(`the stage is ${clip.width}x${clip.height}; record the present page at 1920x1080`);
    const holdFrames = Math.round(hold * fps);
    for (let i = 0; i < info.steps.length; i++) {
      const s = info.steps[i], tag = `${pad2(i + 1)}-${s.id}`;
      await page.eval(i === 0 ? '__deck.seek(0)' : `__deck.jump(${i - 1})`);
      const K = Math.ceil((s.end - s.start) * fps - 1e-9);
      const w = await mp4Writer({ width: 1920, height: 1080, fps, quality, speed });
      let first = null, last = null;
      try {
        for (let k = 0; k <= K; k++) {
          const t = k === K ? s.end : s.start + k / fps;
          await page.eval(`__deck.seek(${t})`);
          const png = await page.shot(null, clip);
          if (k === 0) first = png;
          last = png;
          w.add(decodePng(png).data);
        }
        const rgba = decodePng(last).data;
        for (let h = 0; h < holdFrames; h++) w.add(rgba);
        const { bytes, frames } = w.finish();
        writeFileSync(join(out, `${tag}.mp4`), bytes);
        writeFileSync(join(out, `${tag}-first.png`), first);
        writeFileSync(join(out, `${tag}-last.png`), last);
        manifest.steps.push({ i, id: s.id, start: s.start, end: s.end, frames, animFrames: K + 1, holdFrames, sec: frames / fps, mp4: `${tag}.mp4`, first: `${tag}-first.png`, last: `${tag}-last.png`, bytes: bytes.length });
        log(`recorded ${tag}: ${frames} frames (${(frames / fps).toFixed(2)} s), ${(bytes.length / 1024).toFixed(0)} KB`);
      } catch (e) { w.abort(); throw e; }
    }
  } finally {
    b.close();
  }
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return { out, manifest };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const o = {};
  let file = null;
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--out') o.out = resolve(argv[++i] || '');
    else if (['--fps', '--hold', '--quality', '--speed'].includes(k)) o[k.slice(2)] = Number(argv[++i]);
    else if (k === '--force') o.force = true;
    else if (!k.startsWith('--') && !file) file = k;
    else { process.stderr.write(`record: unknown argument ${k}\n`); process.exit(2); }
  }
  if (!file) { process.stderr.write('usage: node scripts/record.mjs <present.html> [--out dir] [--fps 30] [--hold 0.5] [--quality 20] [--speed 5] [--force]\n'); process.exit(2); }
  if (!findBrowser()) { process.stderr.write('record: no Chrome, Edge or Chromium found; set CHROME to the browser executable\n'); process.exit(2); }
  try {
    const r = await record(file, o);
    process.stdout.write(`recorded ${r.manifest.steps.length} steps into ${r.out}\n`);
  } catch (e) {
    process.stderr.write(`record: ${e.message}\n`);
    process.exit(exitOf(e, 1));
  }
}
