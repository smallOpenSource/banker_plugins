/*
 * dive mode for 3d-intro-build (CLIP_MODE = dive). Optional, and not yet confirmed by a paid smoke.
 *
 * Every scene but the last gets a dive that starts from that scene's approved still (so each scene
 * is entered from outside, with a MOVE: push-in, arc or crane). An optional exit clip leaves the
 * scene from the dive's last frame. The last scene is the finale: a clip that pulls back from the
 * closing still, played reversed, so it ends on that still. The seam to the next scene does not
 * rely on the model: when the next scene's still has a one-colour border (its band's channel
 * standard deviations all at or under `bgThreshold`), the seam side (the exit, or the dive without
 * one) lands on a plate of the next clip's actual first-frame border colour (clip-post landOnStill).
 *
 *   planDiveLegs   the legs in order (pure)
 *   runDiveLegs    makes them with generateClip (injectable), post-processes, writes intro.json;
 *                  { only: 'first' } makes scene 1's dive and exit and stops at the first pair gate
 *                  with two versions to compare: without the exit and with it
 *
 * A generated clip is kept as <name>.raw.mp4 and reused when it is there, so a run after the gate
 * (or after a stop) does not pay for a leg twice. Events go to onEvent; none carries a key.
 * Runtime: Node >=18 builtins and ffmpeg.
 */
import fs from 'node:fs';
import path from 'node:path';
import { extractFirstFrame, extractLastFrame, probeDims, resolveFfmpeg } from './azure-adapter.mjs';
import { generateClip } from './video-pool.mjs';
import { cameraMotion, frameStats, postClip, resizePng, seamSsim, solidPlate } from './clip-post.mjs';

export const DIVE_DEFAULTS = { diveSeconds: 8, exitSeconds: 4, finaleSeconds: 8, border: 0.04, bgThreshold: 6, landSec: 0.6, finaleLandSec: 0.4 };
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
export function planDiveLegs({ scenes, exit = true, diveSeconds = DIVE_DEFAULTS.diveSeconds, exitSeconds = DIVE_DEFAULTS.exitSeconds, finaleSeconds = DIVE_DEFAULTS.finaleSeconds } = {}) {
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
 * Whether a gap's seam lands on a background plate: the band along the next still's edges
 * (`border` of each side) must be one colour, every channel's standard deviation at or under
 * `bgThreshold`. Returns the measured values either way.
 */
export async function judgeBackground(stillPng, { border = DIVE_DEFAULTS.border, bgThreshold = DIVE_DEFAULTS.bgThreshold, ffmpeg } = {}) {
  const s = await frameStats(stillPng, { border, ffmpeg });
  const r1 = (a) => a.map((x) => Math.round(x * 10) / 10);
  return { on: s.std.every((x) => x <= bgThreshold), std: r1(s.std), mean: r1(s.mean), threshold: bgThreshold };
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
 *   exit         make exit clips (connectors); default true
 *   only         'first': scene 1's dive and exit, the two gate versions, then stop
 *   generate     the clip maker (default generateClip); creds and clipOptions are passed on
 *   bgThreshold, border, landSec, finaleLandSec, diveSeconds, exitSeconds, finaleSeconds, reuse (default true), ffmpeg, onEvent
 * Returns { stage: 'first-pair', ... } at the gate, else { stage: 'done', manifest, file, seams }.
 */
export async function runDiveLegs(opts = {}) {
  const o = { ...DIVE_DEFAULTS, exit: true, reuse: true, generate: generateClip, clipsDir: 'clips', ...opts };
  if (!o.projectDir || !o.manifest || !o.size || typeof o.promptFor !== 'function') throw new Error('runDiveLegs: projectDir, manifest, size and promptFor are required');
  const ctx = await prepare(o);
  const first = o.only === 'first';
  const legs = planDiveLegs({ scenes: o.manifest.sections, exit: o.exit || first, diveSeconds: o.diveSeconds, exitSeconds: o.exitSeconds, finaleSeconds: o.finaleSeconds });
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
  const ctx = { o, emit, dir, bin, n: o.manifest.sections.length, seeds: [], seams: [], raw: {}, shown: {}, exitSeed: {} };
  for (let i = 0; i < ctx.n; i++) ctx.seeds.push(await sizedStill(ctx, i));
  for (let i = 0; i < ctx.n - 1; i++) ctx.seams.push(await seamPlan(ctx, i));
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

async function seamPlan(ctx, gap) {
  const j = await judgeBackground(ctx.seeds[gap + 1], { border: ctx.o.border, bgThreshold: ctx.o.bgThreshold, ffmpeg: ctx.bin });
  ctx.emit({ type: 'seam', gap: gap + 1, background: j.on, std: j.std, threshold: j.threshold });
  if (!j.on) {
    ctx.emit({ type: 'note', gap: gap + 1, message: `scene ${gap + 2}'s still has no one-colour border (band std ${j.std.join('/')} > ${j.threshold}): this seam is the engine's dissolve, no background plate` });
  }
  return { gap: gap + 1, ...j };
}

// Generate one leg unless its raw clip is already there (reuse), then keep the version the next leg sees.
async function makeLeg(ctx, leg) {
  const raw = path.join(ctx.dir, `${leg.name}.raw.mp4`);
  ctx.raw[leg.name] = raw;
  if (!(ctx.o.reuse && fs.existsSync(raw))) {
    const section = ctx.o.manifest.sections[leg.scene];
    const seed = await seedFor(ctx, leg);
    const r = await ctx.o.generate({ creds: ctx.o.creds, prompt: ctx.o.promptFor(leg, section), size: ctx.o.size, seconds: leg.seconds, firstFramePng: fs.readFileSync(seed), onEvent: ctx.emit, ...ctx.o.clipOptions });
    fs.writeFileSync(raw, r.mp4);
    ctx.emit({ type: 'leg', name: leg.name, kind: leg.kind, move: leg.move, provider: r.provider, label: r.label, seconds: r.seconds });
  } else {
    ctx.emit({ type: 'leg', name: leg.name, kind: leg.kind, reused: true });
    if (leg.kind === 'exit') await seedFor(ctx, leg);
  }
  if (leg.kind === 'dive') await keepShown(ctx, leg);
}

// A dive or the finale starts from its still; an exit from its dive's last frame, taken from what
// shows (the zoomed dive when zoomBoost is on, else the dive as generated), before any landing.
async function seedFor(ctx, leg) {
  if (leg.seed.from === 'still') return ctx.seeds[leg.scene];
  const png = path.join(ctx.dir, `seed-${leg.name}.png`);
  await extractLastFrame(ctx.shown[leg.seed.leg], png, { ffmpeg: ctx.bin });
  ctx.exitSeed[leg.name] = png;
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
  const land = ctx.seams[i].on ? await plateLanding(ctx, i, nextClip(ctx, i)) : null;
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

// A plate of the next clip's actual first-frame border colour, and the landing step onto it.
async function plateLanding(ctx, i, next) {
  const first = await extractFirstFrame(next, path.join(ctx.dir, `next-${i + 1}-first.png`), { ffmpeg: ctx.bin });
  return plateFrom(ctx, i, first);
}

async function plateFrom(ctx, i, png) {
  const { mean } = await frameStats(png, { border: ctx.o.border, ffmpeg: ctx.bin });
  const plate = await solidPlate(mean, ctx.o.size, path.join(ctx.dir, `plate-${i + 1}.png`), { ffmpeg: ctx.bin });
  ctx.emit({ type: 'plate', gap: i + 1, rgb: mean.map(Math.round) });
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
  // the next clip does not exist yet: the plate takes the next still's border colour (the next dive starts from that still)
  const land = ctx.seams[0].on ? await plateFrom(ctx, 0, ctx.seeds[1]) : null;
  const noExit = path.join(gate, 'dive-1.noexit.mp4');
  await placeOrPost(ctx, 'dive-1', ctx.shown['dive-1'], noExit, land ? { land } : {});
  const dive = path.join(gate, 'dive-1.mp4');
  fs.copyFileSync(ctx.shown['dive-1'], dive);
  const exit = path.join(gate, 'exit-1.mp4');
  await placeOrPost(ctx, 'exit-1', ctx.raw['exit-1'], exit, land ? { land } : {});
  const motion = await cameraMotion(ctx.shown['dive-1'], { ffmpeg: ctx.bin });
  return {
    stage: 'first-pair', seam: ctx.seams[0],
    withoutExit: [relOf(ctx, noExit)], withExit: [relOf(ctx, dive), relOf(ctx, exit)],
    diveExitSsim: await seamSsim(dive, exit, { ffmpeg: ctx.bin }),
    motion: { rollDeg: motion.rollDeg, zoom: motion.zoom, method: motion.method },
  };
}
