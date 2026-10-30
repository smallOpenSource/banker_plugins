/*
 * dive mode for 3d-intro-build (CLIP_MODE = dive): the default on every provider, without exits. Measured on
 * sora-2 (2025-12-08, one scene set): each scene shows, arc turns little, the finale lands only through
 * landOnStill. dive on WAN is not measured.
 *
 * Every scene but the last gets a dive that starts from that scene's approved still (so each scene
 * is entered from outside, with a MOVE: push-in, arc or crane). An optional exit clip leaves the
 * scene from the dive's last frame. The last scene is the finale: a clip that pulls back from the
 * closing still, played reversed, so it ends on that still. The seam to the next scene does not
 * rely on the model: when the next clip's actual first frame has a background border (at least
 * `bgShare` of its border band within `bgTolerance` of the band's most common colour, so a roof or a
 * plume touching the edge does not count), the seam side (the exit, or the dive without one) lands on
 * a plate of that background colour (clip-post landOnStill). One frame decides and gives the colour.
 *
 *   planDiveLegs   the legs in order (pure)
 *   runDiveLegs    makes them with generateClip (injectable), post-processes, writes intro.json;
 *                  { only: 'first' } makes scene 1's dive (and its exit only with exit: true, choice c) and
 *                  stops at the first pair gate: the dive landed, and with an exit both versions to compare
 *
 * A generated clip is kept as <name>.raw.mp4 beside <name>.raw.json, the fingerprint of what made it
 * (prompt, seed frame, seconds, size, MOVE, provider order). A run after the gate (or after a stop) reuses
 * it only when that fingerprint is the same, so it does not pay for a leg twice; a changed leg (a new MOVE,
 * length or seed) is made again ('stale' event). A raw clip with no record stops with kind 'reuse_unknown'.
 * The clip is written to a temporary name and renamed, so a cut-off write leaves no raw clip.
 * Events go to onEvent; none carries a key.
 * Runtime: Node >=18 builtins and ffmpeg.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { estimateCost, extractFirstFrame, extractLastFrame, probeDims, resolveFfmpeg } from './azure-adapter.mjs';
import { generateClip, parseProviderOrder } from './video-pool.mjs';
import { borderColour, cameraMotion, postClip, resizePng, seamSsim, solidPlate } from './clip-post.mjs';

export const DIVE_DEFAULTS = { diveSeconds: 8, exitSeconds: 4, finaleSeconds: 8, border: 0.04, bgShare: 0.85, bgTolerance: 12, landSec: 0.6, finaleLandSec: 0.4 };
export const MOVES = ['push-in', 'arc', 'crane'];

function moveOf(scene, i) {
  const m = scene?.move || 'push-in';
  if (!MOVES.includes(m)) throw new Error(`planDiveLegs: scene ${i + 1} MOVE "${m}" is not one of ${MOVES.join(', ')}`);
  return m;
}

/**
 * The legs of a dive-mode intro, in the order they are made. `scenes` are the manifest sections
 * (with an optional `move`); `exit` adds one exit after each dive. Seeds: a dive and the finale start
 * from their scene's still, an exit from its dive's last frame.
 */
export function planDiveLegs({ scenes, exit = false, diveSeconds = DIVE_DEFAULTS.diveSeconds, exitSeconds = DIVE_DEFAULTS.exitSeconds, finaleSeconds = DIVE_DEFAULTS.finaleSeconds } = {}) {
  const n = Array.isArray(scenes) ? scenes.length : 0;
  if (n < 2) throw new Error('planDiveLegs: dive mode needs two scenes or more (dives, then the finale)');
  const legs = [];
  for (let i = 0; i < n - 1; i++) {
    legs.push({ kind: 'dive', scene: i, name: `dive-${i + 1}`, seed: { from: 'still', scene: i }, move: moveOf(scenes[i], i), seconds: diveSeconds });
    if (exit) legs.push({ kind: 'exit', scene: i, name: `exit-${i + 1}`, seed: { from: 'last-frame', leg: `dive-${i + 1}` }, seconds: exitSeconds });
  }
  legs.push({ kind: 'finale', scene: n - 1, name: 'finale', seed: { from: 'still', scene: n - 1 }, seconds: finaleSeconds, reverse: true });
  return legs;
}

/**
 * Whether a frame has a background border to land a seam on: at least `bgShare` of the band along its
 * edges (`border` of each side) within `bgTolerance` of the band's most common colour. `rgb` is that
 * background colour (the plate's). Returns the measured share either way.
 */
export async function judgeBackground(png, { border = DIVE_DEFAULTS.border, bgShare = DIVE_DEFAULTS.bgShare, bgTolerance = DIVE_DEFAULTS.bgTolerance, ffmpeg } = {}) {
  const m = await borderColour(png, { border, tolerance: bgTolerance, ffmpeg });
  const share = Math.round(m.share * 1000) / 1000;
  return { on: m.share >= bgShare, share, rgb: m.rgb.map((x) => Math.round(x * 10) / 10), threshold: bgShare, tolerance: bgTolerance };
}

// ---------------------------------------------------------------------------
// runDiveLegs
// ---------------------------------------------------------------------------

/**
 * Make the dive-mode clips and write intro.json.
 *   projectDir   the project folder (stills are paths relative to it, as in intro.json)
 *   manifest     the intro.json to fill: sections (still, copy, optional move and zoom) and the rest
 *   size         ORIENTATION ('720x1280'); a still of another size is scaled before it seeds a clip
 *   promptFor(leg, section)   the prompt of each leg (prompts.md: dive, exit, finale)
 *   exit         make exit clips (connectors); default false (dive without exits is the default mode)
 *   only         'first': scene 1's dive, and its exit only when exit is true (no exit is paid for in choice b), then stop
 *   generate     the clip maker (default generateClip); creds and clipOptions are passed on
 *   bgShare, bgTolerance, border, landSec, finaleLandSec, diveSeconds, exitSeconds, finaleSeconds, reuse (default true), ffmpeg, onEvent
 * Returns { stage: 'first-pair', ... } at the gate, else { stage: 'done', manifest, file, seams } (seams: each gap's judgeBackground).
 */
export async function runDiveLegs(opts = {}) {
  const o = { ...DIVE_DEFAULTS, exit: false, reuse: true, generate: generateClip, clipsDir: 'clips', ...opts };
  if (!o.projectDir || !o.manifest || !o.size || typeof o.promptFor !== 'function') throw new Error('runDiveLegs: projectDir, manifest, size and promptFor are required');
  const ctx = await prepare(o);
  const first = o.only === 'first';
  const legs = planDiveLegs({ scenes: o.manifest.sections, exit: o.exit, diveSeconds: o.diveSeconds, exitSeconds: o.exitSeconds, finaleSeconds: o.finaleSeconds });
  for (const leg of first ? legs.filter((l) => l.scene === 0 && l.kind !== 'finale') : legs) await makeLeg(ctx, leg);
  if (first) return firstPair(ctx);
  await finish(ctx);
  return writeManifest(ctx);
}

async function prepare(o) {
  const emit = (e) => { if (typeof o.onEvent === 'function') o.onEvent(e); };
  const dir = path.join(o.projectDir, o.clipsDir);
  fs.mkdirSync(dir, { recursive: true });
  const bin = o.ffmpeg || await resolveFfmpeg();
  const ctx = { o, emit, dir, bin, n: o.manifest.sections.length, seeds: [], seams: [], raw: {}, shown: {} };
  for (let i = 0; i < ctx.n; i++) ctx.seeds.push(await sizedStill(ctx, i));
  return ctx;
}

const abs = (ctx, rel) => path.join(ctx.o.projectDir, ...String(rel).split(/[\\/]/));
const relOf = (ctx, file) => path.relative(ctx.o.projectDir, file).split(path.sep).join('/');
const sizeOf = (size) => String(size).split('x').map(Number);

// The scene's still as a seed: as it is when its size is ORIENTATION, else scaled (the classic image path gives 1024x1536).
async function sizedStill(ctx, i) {
  const still = abs(ctx, ctx.o.manifest.sections[i].still);
  const { width, height } = probeDims(still);
  const [w, h] = sizeOf(ctx.o.size);
  if (width === w && height === h) return still;
  ctx.emit({ type: 'resize', scene: i + 1, from: `${width}x${height}`, to: ctx.o.size });
  return resizePng(still, ctx.o.size, path.join(ctx.dir, `still-${i + 1}.sized.png`), { ffmpeg: ctx.bin });
}

// Judge gap i on `png` (the frame the seam meets) and keep the result; `what` names that frame in the events.
async function seamPlan(ctx, i, png, what) {
  const j = await judgeBackground(png, { border: ctx.o.border, bgShare: ctx.o.bgShare, bgTolerance: ctx.o.bgTolerance, ffmpeg: ctx.bin });
  ctx.emit({ type: 'seam', gap: i + 1, background: j.on, share: j.share, threshold: j.threshold, frame: what });
  if (!j.on) {
    ctx.emit({ type: 'note', gap: i + 1, message: `${what} has no background border (${j.share} of the band near its most common colour, under ${j.threshold}): this seam is the engine's dissolve, no background plate` });
  }
  ctx.seams[i] = { gap: i + 1, frame: what, ...j };
  return ctx.seams[i];
}

// Generate one leg unless its raw clip is already there (reuse), then keep the version the next leg sees.
async function makeLeg(ctx, leg) {
  const raw = path.join(ctx.dir, `${leg.name}.raw.mp4`);
  ctx.raw[leg.name] = raw;
  const prompt = ctx.o.promptFor(leg, ctx.o.manifest.sections[leg.scene]);
  const seed = fs.readFileSync(await seedFor(ctx, leg));
  const fp = legPrint(ctx, leg, prompt, seed);
  if (ctx.o.reuse && reusable(ctx, leg, raw, fp)) ctx.emit({ type: 'leg', name: leg.name, kind: leg.kind, reused: true });
  else {
    const r = await ctx.o.generate({ creds: ctx.o.creds, prompt, size: ctx.o.size, seconds: leg.seconds, firstFramePng: seed, onEvent: ctx.emit, ...ctx.o.clipOptions });
    writeAtomic(raw, r.mp4);
    writeAtomic(`${raw.slice(0, -4)}.json`, `${JSON.stringify(fp, null, 2)}\n`);
    ctx.emit({ type: 'leg', name: leg.name, kind: leg.kind, move: leg.move, provider: r.provider, label: r.label, seconds: r.seconds });
  }
  if (leg.kind === 'dive') await keepShown(ctx, leg);
}

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// What makes a leg's clip: no key, the prompt and the seed as hashes.
function legPrint(ctx, leg, prompt, seed) {
  const order = ctx.o.clipOptions?.order || parseProviderOrder(ctx.o.creds?.VIDEO_PROVIDER_ORDER);
  return { prompt: sha(String(prompt)), seed: sha(seed), seconds: leg.seconds, size: ctx.o.size, move: leg.move || null, order };
}

// A raw clip is reused only when its record matches; a changed leg is made again, an unrecorded clip stops.
function reusable(ctx, leg, raw, fp) {
  if (!fs.existsSync(raw)) return false;
  const rec = `${raw.slice(0, -4)}.json`;
  if (!fs.existsSync(rec)) {
    throw Object.assign(new Error(`runDiveLegs: ${path.basename(raw)} has no record (${path.basename(rec)}) of what made it, so it is not known to fit this leg; delete it to make the leg again, or pass reuse: false`), { kind: 'reuse_unknown', leg: leg.name });
  }
  let was = null;
  try { was = JSON.parse(fs.readFileSync(rec, 'utf8')); } catch { /* unreadable: made again */ }
  const changed = Object.keys(fp).filter((k) => JSON.stringify(was?.[k]) !== JSON.stringify(fp[k]));
  if (changed.length) ctx.emit({ type: 'stale', name: leg.name, changed, message: `${leg.name}: ${changed.join(', ')} changed since the clip was made; making it again` });
  return !changed.length;
}

// Write to a fresh temporary name, then rename: a write cut off leaves no file under the final name.
function writeAtomic(file, data) {
  const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, data, { flag: 'wx' });
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

// A dive or the finale starts from its still; an exit from its dive's last frame, taken from what
// shows (the zoomed dive when zoomBoost is on, else the dive as generated), before any landing.
async function seedFor(ctx, leg) {
  if (leg.seed.from === 'still') return ctx.seeds[leg.scene];
  const png = path.join(ctx.dir, `seed-${leg.name}.png`);
  await extractLastFrame(ctx.shown[leg.seed.leg], png, { ffmpeg: ctx.bin });
  return png;
}

async function keepShown(ctx, leg) {
  const to = ctx.o.manifest.sections[leg.scene].zoom;
  if (!to) { ctx.shown[leg.name] = ctx.raw[leg.name]; return; }
  const out = path.join(ctx.dir, `${leg.name}.zoom.mp4`);
  report(ctx, leg.name, await postClip(ctx.raw[leg.name], out, { zoom: { to } }, { ffmpeg: ctx.bin }));
  ctx.shown[leg.name] = out;
}

function report(ctx, name, r) {
  ctx.emit({ type: 'post', clip: name, fn: r.steps, encoded: r.encoded });
  return r;
}

// ---------------------------------------------------------------------------
// After every leg: finale, seams, connector posters
// ---------------------------------------------------------------------------

async function finish(ctx) {
  const finale = path.join(ctx.dir, 'finale.mp4');
  report(ctx, 'finale', await postClip(ctx.raw.finale, finale, { reverse: true, land: { png: ctx.seeds[ctx.n - 1], sec: ctx.o.finaleLandSec } }, { ffmpeg: ctx.bin }));
  ctx.finale = finale;
  for (let i = 0; i < ctx.n - 1; i++) await finishGap(ctx, i);
}

// The clip after gap i, as it plays: the next dive, or the finale.
const nextClip = (ctx, i) => (i + 1 < ctx.n - 1 ? ctx.shown[`dive-${i + 2}`] : ctx.finale);

async function finishGap(ctx, i) {
  const land = await plateLanding(ctx, i, nextClip(ctx, i));
  const dive = path.join(ctx.dir, `dive-${i + 1}.mp4`);
  if (!ctx.o.exit) { await placeOrPost(ctx, `dive-${i + 1}`, ctx.shown[`dive-${i + 1}`], dive, land ? { land } : {}); return; }
  fs.copyFileSync(ctx.shown[`dive-${i + 1}`], dive);
  const exit = path.join(ctx.dir, `exit-${i + 1}.mp4`);
  await placeOrPost(ctx, `exit-${i + 1}`, ctx.raw[`exit-${i + 1}`], exit, land ? { land } : {});
  await extractFirstFrame(exit, path.join(ctx.dir, `exit-${i + 1}-first.png`), { ffmpeg: ctx.bin });
}

async function placeOrPost(ctx, name, src, out, steps) {
  if (!Object.keys(steps).length) { fs.copyFileSync(src, out); return; }
  report(ctx, name, await postClip(src, out, steps, { ffmpeg: ctx.bin }));
}

// The next clip's actual first frame decides the seam and gives the plate colour; null when it has no background border.
async function plateLanding(ctx, i, next) {
  const first = await extractFirstFrame(next, path.join(ctx.dir, `next-${i + 1}-first.png`), { ffmpeg: ctx.bin });
  return plateFrom(ctx, i, first, `the first frame of ${relOf(ctx, next)}`);
}

async function plateFrom(ctx, i, png, what) {
  const j = await seamPlan(ctx, i, png, what);
  if (!j.on) return null;
  const plate = await solidPlate(j.rgb, ctx.o.size, path.join(ctx.dir, `plate-${i + 1}.png`), { ffmpeg: ctx.bin });
  ctx.emit({ type: 'plate', gap: i + 1, rgb: j.rgb.map(Math.round) });
  return { png: plate, sec: ctx.o.landSec };
}

function writeManifest(ctx) {
  const m = ctx.o.manifest;
  const last = ctx.n - 1;
  const finaleFirst = path.join(ctx.dir, 'finale-first.png');
  return extractFirstFrame(ctx.finale, finaleFirst, { ffmpeg: ctx.bin }).then(() => {
    const sections = m.sections.map((s, i) => ({ ...s, clip: relOf(ctx, path.join(ctx.dir, i === last ? 'finale.mp4' : `dive-${i + 1}.mp4`)), ...(i === last ? { still: relOf(ctx, finaleFirst) } : {}) }));
    const gaps = Array.from({ length: last }, (_, i) => i + 1);
    const manifest = { ...m, sections, connectors: gaps.map((g) => (ctx.o.exit ? relOf(ctx, path.join(ctx.dir, `exit-${g}.mp4`)) : null)) };
    if (ctx.o.exit) manifest.connectorStills = gaps.map((g) => relOf(ctx, path.join(ctx.dir, `exit-${g}-first.png`)));
    const file = path.join(ctx.o.projectDir, ctx.o.manifestOut || 'intro.json');
    fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
    return { stage: 'done', manifest, file, seams: ctx.seams };
  });
}

// ---------------------------------------------------------------------------
// First pair gate: scene 1 without the exit and with it, side by side
// ---------------------------------------------------------------------------

async function firstPair(ctx) {
  const gate = path.join(ctx.dir, 'gate');
  fs.mkdirSync(gate, { recursive: true });
  // the next clip does not exist yet: the next still decides and gives the colour (the next dive starts from that still)
  const land = await plateFrom(ctx, 0, ctx.seeds[1], 'the next scene\'s still');
  const noExit = path.join(gate, 'dive-1.noexit.mp4');
  await placeOrPost(ctx, 'dive-1', ctx.shown['dive-1'], noExit, land ? { land } : {});
  const motion = await cameraMotion(ctx.shown['dive-1'], { ffmpeg: ctx.bin });
  const base = { stage: 'first-pair', seam: ctx.seams[0], withoutExit: [relOf(ctx, noExit)], motion: { rollDeg: motion.rollDeg, zoom: motion.zoom, method: motion.method } };
  // choice b: no exit was made; what turning to c would add (exits between every pair of scenes), to approve first
  if (!ctx.o.exit) return { ...base, withExit: null, switchToExitUsd: switchCost(ctx) };
  const dive = path.join(gate, 'dive-1.mp4');
  fs.copyFileSync(ctx.shown['dive-1'], dive);
  const exit = path.join(gate, 'exit-1.mp4');
  await placeOrPost(ctx, 'exit-1', ctx.raw['exit-1'], exit, land ? { land } : {});
  return { ...base, exitEnd: await exitEnd(ctx), withExit: [relOf(ctx, dive), relOf(ctx, exit)], diveExitSsim: await seamSsim(dive, exit, { ffmpeg: ctx.bin }) };
}

// What exits between every pair of scenes add to the estimate (Sora rate, as Step 2 approved it).
function switchCost(ctx) {
  const at = (exit) => estimateCost({ nScenes: ctx.n, mode: 'dive', diveSeconds: ctx.o.diveSeconds, exitSeconds: ctx.o.exitSeconds, exit }).videos;
  return Math.round((at(true) - at(false)) * 100) / 100;
}

// Whether the exit as generated reached the background by its end (the same measure), for the gate to show.
async function exitEnd(ctx) {
  const end = await extractLastFrame(ctx.raw['exit-1'], path.join(ctx.dir, 'gate', 'exit-1-end.png'), { ffmpeg: ctx.bin });
  const j = await judgeBackground(end, { border: ctx.o.border, bgShare: ctx.o.bgShare, bgTolerance: ctx.o.bgTolerance, ffmpeg: ctx.bin });
  return { reached: j.on, share: j.share, threshold: j.threshold };
}
