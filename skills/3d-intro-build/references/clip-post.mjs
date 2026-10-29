/*
 * Clip post-processing for 3d-intro-build (this skill only; no mirror). FREE: ffmpeg on this machine.
 *
 *   ENCODE        the one set of encoder arguments every output uses: H.264 yuv420p, a keyframe every
 *                 8 frames, faststart, no audio (what the scrub engine seeks well). Each output also
 *                 carries its source clip's colour tags (colourParams; bt709 when the source has none)
 *   postClip      one clip's steps (reverse, zoom, landing) as ONE filter graph: one re-encode
 *   reverseClip, zoomBoost, landOnStill   postClip with one step
 *   probeClip, frameStats, solidPlate, resizePng, ssimFrames, seamSsim, cameraMotion, seamReport   measures and plates
 *
 * There is no tone step: on the sora-2 clips measured, a new clip's first frame was within 2.6/255 of
 * its seed in every channel mean, and a correction only added a re-encode.
 * cameraMotion is a roll approximation: for each pair of frames `step` s apart it finds the rotation
 * about the centre and the zoom that best map one frame onto the next. Pan is not measured.
 *
 * ffmpeg always gets an argument array; file paths go only to -i and the output, never into a
 * filter graph. Frames for measures are read small, once per clip, and searched in Node.
 * Runtime: Node >=18 builtins; ffmpeg from resolveFfmpeg (azure-adapter.mjs) or opts.ffmpeg.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import { probeDims, resolveFfmpeg } from './azure-adapter.mjs';

export const ENCODE = ['-c:v', 'libx264', '-crf', '20', '-g', '8', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an'];
/** reverseClip holds every frame in memory, so it takes at most this long a clip and 1280x720 pixels. */
export const REVERSE_MAX_SEC = 12;
const REVERSE_MAX_PIXELS = 1280 * 720;
/** cameraMotion's search: degrees and zoom per frame pair, then a finer pass around the best. */
export const MOTION_SEARCH = { degrees: [-8, 8, 1], zooms: [0.9, 1.25, 0.01], fineDegrees: 0.25, fineZoom: 0.0025, shortSide: 128 };

const binOf = async (opts) => opts?.ffmpeg || resolveFfmpeg();
const tail = (s, n = 400) => { const str = String(s || ''); return str.length > n ? str.slice(-n) : str; };
const n4 = (x) => String(Math.round(x * 10_000) / 10_000);

// Run ffmpeg with an argument array. stdout is a Buffer when `raw`.
function ff(bin, args, raw = false) {
  const r = cp.spawnSync(bin, ['-hide_banner', '-nostdin', ...args], { encoding: raw ? 'buffer' : 'utf8', maxBuffer: 1 << 29, windowsHide: true });
  return { code: r.status, stdout: r.stdout, stderr: String(r.stderr || '') };
}

function must(r, what) {
  if (r.code !== 0) throw new Error(`${what} failed: ${tail(r.stderr)}`);
  return r;
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'clip-post-'));
}

// ---------------------------------------------------------------------------
// Probes and frames
// ---------------------------------------------------------------------------

/**
 * A clip's size, frame rate and length from ffmpeg's banner (no ffprobe). The length is the video
 * stream's (its frames counted by a stream copy): the banner's Duration is the container's, which a
 * longer audio track stretches (sora-2 clips: 4.1 s for 4.0 s of video), and a landing timed on it misses.
 */
export async function probeClip(mp4, opts = {}) {
  const bin = await binOf(opts);
  const info = parseBanner(ff(bin, ['-i', mp4]).stderr, path.basename(String(mp4)));   // no output named: exits 1 after the banner
  const frames = [...ff(bin, ['-i', mp4, '-map', '0:v:0', '-c', 'copy', '-f', 'null', '-']).stderr.matchAll(/frame=\s*(\d+)/g)].at(-1);
  return frames && +frames[1] > 0 ? { ...info, duration: Math.round((+frames[1] / info.fps) * 10_000) / 10_000, container: info.duration } : info;
}

/** The banner fields probeClip reads, the colour tags included. Throws when the text names no video stream. */
export function parseBanner(text, name = 'clip') {
  const d = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const v = text.match(/Stream #[^\n]*Video:[^\n]*/);
  const size = v && v[0].match(/,\s*(\d{2,5})x(\d{2,5})[\s,[]/);
  const fps = v && (v[0].match(/([\d.]+) fps/) || v[0].match(/([\d.]+) tbr/));
  if (!d || !size || !fps) throw new Error(`probeClip: ${name} is not a video ffmpeg can read`);
  return { width: +size[1], height: +size[2], fps: +fps[1], duration: +d[1] * 3600 + +d[2] * 60 + +d[3], color: colourOf(v[0]) };
}

/** What an untagged source is taken to be: HD video, limited range, bt709. */
export const COLOUR_DEFAULT = { range: 'tv', space: 'bt709', primaries: 'bt709', trc: 'bt709' };

/**
 * The colour tags of a banner's video line: `yuv420p(tv, bt709, progressive)` names all three at once,
 * `yuv420p(tv, bt470bg/bt709/iec61966-2-1)` space/primaries/transfer. A tag left out or `unknown` is COLOUR_DEFAULT's.
 */
export function colourOf(videoLine) {
  const m = /,\s*[a-z0-9]+\(([^)]*)\)/.exec(String(videoLine || ''));
  const c = { ...COLOUR_DEFAULT };
  for (const part of m ? m[1].split(/,\s*/) : []) {
    if (part === 'tv' || part === 'pc') c.range = part;
    else if (/\d/.test(part) && /^[\w.-]+(\/[\w.-]+){0,2}$/.test(part)) Object.assign(c, colourNames(part));
  }
  return c;
}

// `bt709` (all three) or `space/primaries/transfer`; an `unknown` name is left out.
function colourNames(part) {
  const [space, primaries = space, trc = space] = part.split('/');
  return Object.fromEntries(Object.entries({ space, primaries, trc }).filter(([, v]) => v !== 'unknown'));
}

/**
 * The filter that tags the output frames with the source's colours (the encoder takes the tags from the
 * frames; the -colorspace style output options alone leave primaries and transfer unknown in ffmpeg 8).
 */
export const colourParams = (c = COLOUR_DEFAULT) => `setparams=range=${c.range}:color_primaries=${c.primaries}:color_trc=${c.trc}:colorspace=${c.space}`;

// Frames as raw bytes (rgb24 or gray), read once.
function rawFrames(bin, inputArgs, vf, pixFmt) {
  const r = ff(bin, [...inputArgs, '-vf', vf, '-f', 'rawvideo', '-pix_fmt', pixFmt, '-'], true);
  if (r.code !== 0 || !r.stdout?.length) throw new Error(`reading frames failed: ${tail(r.stderr)}`);
  return r.stdout;
}

/**
 * A PNG's per-channel mean and standard deviation (0-255), over the whole picture or, with `border`
 * (a fraction such as 0.04), only over the band that wide along each edge.
 */
export async function frameStats(png, { border = 0, ffmpeg } = {}) {
  const { width, height } = probeDims(png);
  const buf = rawFrames(await binOf({ ffmpeg }), ['-i', png], 'format=rgb24', 'rgb24');
  return statsOf(buf, width, height, border);
}

/** Channel statistics of rgb24 bytes. */
export function statsOf(buf, width, height, border = 0) {
  const bx = border > 0 ? Math.max(1, Math.round(width * border)) : 0;
  const by = border > 0 ? Math.max(1, Math.round(height * border)) : 0;
  const acc = { sum: [0, 0, 0], sq: [0, 0, 0], n: 0 };
  for (let y = 0; y < height; y++) {
    const fullRow = !bx || y < by || y >= height - by;
    if (fullRow) addSpan(acc, buf, (y * width) * 3, width);
    else { addSpan(acc, buf, (y * width) * 3, bx); addSpan(acc, buf, (y * width + width - bx) * 3, bx); }
  }
  const mean = acc.sum.map((s) => s / acc.n);
  const std = acc.sq.map((s, c) => Math.sqrt(Math.max(0, s / acc.n - mean[c] ** 2)));
  return { mean, std, pixels: acc.n, width, height };
}

// Add `count` rgb24 pixels from byte `start` to the sums.
function addSpan(acc, buf, start, count) {
  for (let i = start, end = start + count * 3; i < end; i += 3) {
    for (let c = 0; c < 3; c++) { acc.sum[c] += buf[i + c]; acc.sq[c] += buf[i + c] ** 2; }
  }
  acc.n += count;
}

/**
 * The most common colour of a picture's border band (`border` of each side) and how much of the band is
 * near it: rgb24 pixels are grouped into colour bins `bin` wide, the fullest bin's mean is the reference,
 * and `share` is the part of the band within `tolerance` (every channel) of it. `rgb` is the mean of those
 * near pixels: the background colour, small objects on the edge left out.
 */
export function borderMode(buf, width, height, { border = 0.04, tolerance = 12, bin = 8 } = {}) {
  const px = bandPixels(buf, width, height, border);
  const counts = new Map();
  for (const i of px) { const k = binKey(buf, i, bin); counts.set(k, (counts.get(k) || 0) + 1); }
  const top = [...counts.entries()].reduce((a, b) => (b[1] > a[1] ? b : a))[0];
  const ref = meanOf(buf, px.filter((i) => binKey(buf, i, bin) === top));
  const near = px.filter((i) => [0, 1, 2].every((c) => Math.abs(buf[i + c] - ref[c]) <= tolerance));
  return { share: near.length / px.length, rgb: meanOf(buf, near), pixels: px.length };
}

// Byte offsets of the rgb24 pixels in the border band.
function bandPixels(buf, width, height, border) {
  const bx = Math.max(1, Math.round(width * border));
  const by = Math.max(1, Math.round(height * border));
  const out = [];
  for (let y = 0; y < height; y++) {
    const full = y < by || y >= height - by;
    for (let x = 0; x < width; x++) if (full || x < bx || x >= width - bx) out.push((y * width + x) * 3);
  }
  return out;
}

const binKey = (buf, i, bin) => ((buf[i] / bin) | 0) * 65536 + ((buf[i + 1] / bin) | 0) * 256 + ((buf[i + 2] / bin) | 0);
const meanOf = (buf, px) => [0, 1, 2].map((c) => px.reduce((s, i) => s + buf[i + c], 0) / Math.max(1, px.length));

/** borderMode of a PNG. */
export async function borderColour(png, { ffmpeg, ...o } = {}) {
  const { width, height } = probeDims(png);
  return borderMode(rawFrames(await binOf({ ffmpeg }), ['-i', png], 'format=rgb24', 'rgb24'), width, height, o);
}

const sizeOf = (size) => (typeof size === 'string' ? size.split('x').map(Number) : [size.width, size.height]);

/** A one-colour PNG of `size` ('720x1280' or {width, height}) from an [r, g, b] colour. Returns out. */
export async function solidPlate(rgb, size, out, opts = {}) {
  const [w, h] = sizeOf(size);
  const hex = rgb.map((c) => Math.min(255, Math.max(0, Math.round(c))).toString(16).padStart(2, '0')).join('');
  fs.rmSync(out, { force: true });
  must(ff(await binOf(opts), ['-y', '-f', 'lavfi', '-i', `color=c=0x${hex}:s=${w}x${h}`, '-frames:v', '1', out]), 'solidPlate');
  return out;
}

/** A PNG scaled to `size` ('720x1280' or {width, height}), e.g. a classic-path still before it seeds a clip. Returns out. */
export async function resizePng(png, size, out, opts = {}) {
  const [w, h] = sizeOf(size);
  fs.rmSync(out, { force: true });
  must(ff(await binOf(opts), ['-y', '-i', png, '-vf', `scale=${w}:${h}:flags=lanczos,setsar=1,format=rgb24`, '-frames:v', '1', out]), 'resizePng');
  return out;
}

// A clip frame as RGB the way a browser shows it: the clip's own tags, bt709 when it has none
// (Chromium reads an untagged clip as bt709; ffmpeg alone would take bt601).
const asShown = (bin, mp4) => ['-vf', colourParams(colourOf(ff(bin, ['-i', mp4]).stderr.match(/Stream #[^\n]*Video:[^\n]*/)?.[0]))];

function firstFramePng(bin, mp4, out) {
  must(ff(bin, ['-y', '-i', mp4, ...asShown(bin, mp4), '-frames:v', '1', out]), 'first frame');
  return out;
}

// The last frame: seek near the end and keep overwriting one picture.
function lastFramePng(bin, mp4, out) {
  must(ff(bin, ['-y', '-sseof', '-1', '-i', mp4, ...asShown(bin, mp4), '-update', '1', out]), 'last frame');
  return out;
}

function ssimPng(bin, aPng, bPng) {
  const { width, height } = probeDims(aPng);
  const graph = `[1:v]scale=${width}:${height},setsar=1,format=yuv420p[b];[0:v]setsar=1,format=yuv420p[a];[a][b]ssim`;
  const r = must(ff(bin, ['-i', aPng, '-i', bPng, '-filter_complex', graph, '-f', 'null', '-']), 'ssim');
  const m = r.stderr.match(/All:\s*([\d.]+)/);
  if (!m) throw new Error(`ssim: no score in ffmpeg's output: ${tail(r.stderr)}`);
  return Number(m[1]);
}

/** SSIM (ffmpeg `ssim`, All) of two PNGs; b is scaled to a's size. */
export async function ssimFrames(aPng, bPng, opts = {}) {
  return ssimPng(await binOf(opts), aPng, bPng);
}

/** SSIM of a seam: clip a's last frame against clip b's first frame. */
export async function seamSsim(aMp4, bMp4, opts = {}) {
  const bin = await binOf(opts);
  const dir = tmpDir();
  try {
    return ssimPng(bin, lastFramePng(bin, aMp4, path.join(dir, 'a.png')), firstFramePng(bin, bMp4, path.join(dir, 'b.png')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// One filter graph per clip
// ---------------------------------------------------------------------------

/**
 * Encode `clip` to `out` with the steps given, in this order, in one filter graph:
 *   reverse: true            play backwards (at most REVERSE_MAX_SEC and 1280x720)
 *   zoom: { to = 1.15 }      digital push-in from 1 to `to` over the clip, about the centre, at the clip's size
 *   land: { png, sec = 0.6 } the last `sec` fade onto the PNG (a plate or a still), the length kept;
 *                            the last frames are the PNG itself
 * The output carries the clip's colour tags. Returns { out, encoded, steps }; with no step, out is a
 * copy of the clip and `encoded` is false.
 */
export async function postClip(clip, out, given = {}, opts = {}) {
  const steps = Object.fromEntries(Object.entries(given).filter(([, v]) => v));   // { reverse: false } is no step
  const bin = await binOf(opts);
  const info = await probeClip(clip, { ffmpeg: bin });
  if (steps.reverse) refuseLongReverse(info);
  if (!Object.keys(steps).length) {
    fs.copyFileSync(clip, out);   // nothing to do: the clip as it was, not one more encode
    return { out, encoded: false, steps: [] };
  }
  encode(bin, clip, out, info, steps);
  return { out, encoded: true, steps: Object.keys(steps) };
}

function refuseLongReverse(info) {
  if (info.duration > REVERSE_MAX_SEC + 0.05 || info.width * info.height > REVERSE_MAX_PIXELS) {
    throw new Error(`reverseClip: ${info.duration} s at ${info.width}x${info.height} is past the limit (${REVERSE_MAX_SEC} s, 1280x720); reverse holds every frame in memory`);
  }
}

function encode(bin, clip, out, info, steps) {
  const inputs = ['-i', clip];
  if (steps.land) inputs.push('-loop', '1', '-t', n4(landSec(steps.land)), '-framerate', String(info.fps), '-i', steps.land.png);
  fs.rmSync(out, { force: true });
  must(ff(bin, ['-y', ...inputs, '-filter_complex', filterGraph(info, steps), '-map', '[out]', ...ENCODE, out]), 'postClip');
}

const landSec = (land) => Number(land.sec ?? 0.6);

/** The filter graph postClip runs (exported for tests). */
export function filterGraph(info, steps) {
  const segs = [`[0:v]setsar=1,fps=${info.fps}${steps.reverse ? ',reverse' : ''}[s0]`];
  let at = 's0';
  if (steps.zoom) { segs.push(`[${at}]${zoomFilter(info, Number(steps.zoom.to ?? 1.15))}[sz]`); at = 'sz'; }
  if (steps.land) { segs.push(...landSegs(at, info, landSec(steps.land))); at = 'sl'; }
  segs.push(`[${at}]format=yuv420p,${colourParams(info.color)}[out]`);
  return segs.join(';');
}

// A centred push-in at the clip's own size: each frame's centre 1/z of the picture is drawn to the
// corners (perspective, evaluated per frame). scale+crop would change the frame size mid-stream, and
// crop keeps its first offsets then, which pushes in towards the top-left corner instead.
function zoomFilter(info, to) {
  const k = n4((to - 1) / Math.max(0.04, info.duration));
  const m = `(1-1/(1+${k}*in/${info.fps}))/2`;
  const lo = (side) => `'${side}*${m}'`;
  const hi = (side) => `'${side}*(1-${m})'`;
  return `perspective=x0=${lo('W')}:y0=${lo('H')}:x1=${hi('W')}:y1=${lo('H')}:x2=${lo('W')}:y2=${hi('H')}:x3=${hi('W')}:y3=${hi('H')}:eval=frame`;
}

// The PNG as a short clip at the clip's size and rate, faded in so that its last two frames are the PNG alone.
function landSegs(at, info, sec) {
  const fade = Math.max(1 / info.fps, sec - 2 / info.fps);
  const offset = Math.max(0, info.duration - sec);
  return [
    `[1:v]scale=${info.width}:${info.height},setsar=1,fps=${info.fps},format=yuv420p,settb=AVTB[pl]`,
    `[${at}]format=yuv420p,settb=AVTB[pv]`,
    `[pv][pl]xfade=transition=fade:duration=${n4(fade)}:offset=${n4(offset)}[sl]`,
  ];
}

/** Play a clip backwards (at most REVERSE_MAX_SEC, 1280x720). */
export const reverseClip = (clip, out, opts = {}) => postClip(clip, out, { reverse: true }, opts);
/** Digital push-in from 1 to `to` (off unless asked for). */
export const zoomBoost = (clip, out, { to = 1.15, ...opts } = {}) => postClip(clip, out, { zoom: { to } }, opts);
/** Land the clip's last `sec` on a PNG (a background plate, or the closing still), the length kept. */
export const landOnStill = (clip, png, out, { sec = 0.6, ...opts } = {}) => postClip(clip, out, { land: { png, sec } }, opts);

// ---------------------------------------------------------------------------
// Camera motion (roll approximation and zoom)
// ---------------------------------------------------------------------------

const rangeOf = (lo, hi, stepBy) => Array.from({ length: Math.round((hi - lo) / stepBy) + 1 }, (_, i) => lo + i * stepBy);

/**
 * The camera's roll (degrees, clockwise positive) and zoom (>1 is moving in) over a clip, summed
 * and multiplied over frame pairs `step` seconds apart. Frames are read once, grey, MOTION_SEARCH.shortSide
 * pixels on the short side. Pan is not measured; a pan reads as a lower pair SSIM.
 */
export async function cameraMotion(mp4, { step = 1, ffmpeg } = {}) {
  const bin = await binOf({ ffmpeg });
  const info = await probeClip(mp4, { ffmpeg: bin });
  const k = MOTION_SEARCH.shortSide / Math.min(info.width, info.height);
  const w = 2 * Math.round((info.width * k) / 2);
  const h = 2 * Math.round((info.height * k) / 2);
  const buf = rawFrames(bin, ['-i', mp4], `fps=1/${step},scale=${w}:${h}:flags=area,format=gray`, 'gray');
  const frames = Array.from({ length: Math.floor(buf.length / (w * h)) }, (_, i) => buf.subarray(i * w * h, (i + 1) * w * h));
  const pairs = frames.slice(1).map((b, i) => ({ t: i * step, ...bestFit(frames[i], b, w, h) }));
  return {
    method: 'roll approximation: per frame pair, the rotation about the centre and the zoom that best map one frame onto the next; pan is not measured',
    rollDeg: pairs.reduce((s, p) => s + p.deg, 0), zoom: pairs.reduce((s, p) => s * p.zoom, 1),
    pairs, size: `${w}x${h}`, step,
  };
}

function bestFit(a, b, w, h) {
  const S = MOTION_SEARCH;
  const coarse = search(a, b, w, h, rangeOf(...S.degrees), rangeOf(...S.zooms));
  const degs = rangeOf(coarse.deg - S.degrees[2], coarse.deg + S.degrees[2], S.fineDegrees);
  const zooms = rangeOf(coarse.zoom - S.zooms[2], coarse.zoom + S.zooms[2], S.fineZoom);
  const fine = search(a, b, w, h, degs, zooms);
  return { deg: Math.round(fine.deg * 100) / 100, zoom: Math.round(fine.zoom * 10_000) / 10_000, ssim: Math.round(fine.ssim * 10_000) / 10_000 };
}

function search(a, b, w, h, degs, zooms) {
  let best = { deg: 0, zoom: 1, ssim: -Infinity };
  for (const deg of degs) {
    for (const zoom of zooms) {
      const s = fitSsim(a, b, w, h, deg, zoom);
      if (s > best.ssim) best = { deg, zoom, ssim: s };
    }
  }
  return best;
}

// SSIM (one window) of frame b's centre against frame a rotated by `deg` and zoomed by `zoom`.
function fitSsim(a, b, w, h, deg, zoom) {
  const half = Math.floor(0.3 * Math.min(w, h));
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const t = (-deg * Math.PI) / 180;
  const cos = Math.cos(t) / zoom;
  const sin = Math.sin(t) / zoom;
  const acc = { sa: 0, sb: 0, saa: 0, sbb: 0, sab: 0, n: 0 };
  for (let dy = -half; dy <= half; dy++) {
    for (let dx = -half; dx <= half; dx++) {
      const va = bilinear(a, w, h, cx + dx * cos - dy * sin, cy + dx * sin + dy * cos);
      const vb = b[Math.round(cy + dy) * w + Math.round(cx + dx)];
      acc.sa += va; acc.sb += vb; acc.saa += va * va; acc.sbb += vb * vb; acc.sab += va * vb; acc.n++;
    }
  }
  return ssimOf(acc);
}

function bilinear(img, w, h, x, y) {
  const x0 = Math.min(w - 2, Math.max(0, Math.floor(x)));
  const y0 = Math.min(h - 2, Math.max(0, Math.floor(y)));
  const fx = Math.min(1, Math.max(0, x - x0));
  const fy = Math.min(1, Math.max(0, y - y0));
  const i = y0 * w + x0;
  const top = img[i] * (1 - fx) + img[i + 1] * fx;
  const bottom = img[i + w] * (1 - fx) + img[i + w + 1] * fx;
  return top * (1 - fy) + bottom * fy;
}

function ssimOf({ sa, sb, saa, sbb, sab, n }) {
  const C1 = (0.01 * 255) ** 2;
  const C2 = (0.03 * 255) ** 2;
  const ma = sa / n;
  const mb = sb / n;
  const va = saa / n - ma * ma;
  const vb = sbb / n - mb * mb;
  const cov = sab / n - ma * mb;
  return ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
}

// ---------------------------------------------------------------------------
// Seam report
// ---------------------------------------------------------------------------

// The clips of intro.json in playing order: section 1, connector 1 (when set), section 2, ...
function clipOrder(manifest) {
  const order = [];
  (manifest.sections || []).forEach((s, i) => {
    if (i > 0 && manifest.connectors?.[i - 1]) order.push({ role: 'connector', index: i - 1, file: manifest.connectors[i - 1] });
    order.push({ role: 'section', index: i, file: s.clip });
  });
  return order;
}

/**
 * Seam SSIM between each clip and the next in intro.json's playing order, and each clip's
 * cameraMotion (rollDeg, zoom). Paths in the report are the manifest's (relative to projectDir).
 */
export async function seamReport(projectDir, opts = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(projectDir, opts.manifest || 'intro.json'), 'utf8'));
  const order = clipOrder(manifest);
  const at = (f) => path.join(projectDir, ...String(f).split(/[\\/]/));
  const clips = [];
  for (const c of order) {
    const m = await cameraMotion(at(c.file), opts);
    clips.push({ ...c, rollDeg: m.rollDeg, zoom: m.zoom });
  }
  const seams = [];
  for (let i = 1; i < order.length; i++) seams.push({ from: order[i - 1].file, to: order[i].file, ssim: await seamSsim(at(order[i - 1].file), at(order[i].file), opts) });
  return { seams, clips };
}
