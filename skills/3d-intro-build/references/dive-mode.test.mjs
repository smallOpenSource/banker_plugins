// Tests for dive-mode.mjs. planDiveLegs needs nothing; the rest run real ffmpeg with a fake clip
// maker (it encodes the seed frame as a short push-in, no network, no cost). Without ffmpeg those are
// skipped with the reason, except under INTRO_E2E=1, where a missing ffmpeg fails them:
//   INTRO_E2E=1 FFMPEG_PATH=<ffmpeg> node --test skills/3d-intro-build/references/dive-mode.test.mjs
import { strict as assert } from 'node:assert';
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import * as D from './dive-mode.mjs';
import { extractLastFrame, probeDims, resolveFfmpeg } from './azure-adapter.mjs';
import { ssimFrames } from './clip-post.mjs';
import { assemble } from './assemble.mjs';

const RUN = process.env.INTRO_E2E === '1';
const FF = await resolveFfmpeg().catch(() => null);
const needFf = !FF && !RUN && 'ffmpeg not found (set FFMPEG_PATH, or INTRO_E2E=1 to make this a failure)';
const SIZE = '180x320';
const FAKE_KEY = ('placeholder' + '-dive-key-0000');

function mk(args) {
  assert.ok(FF, 'ffmpeg is required under INTRO_E2E=1');
  const r = cp.spawnSync(FF, ['-hide_banner', '-y', ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr.slice(-400));
  return args.at(-1);
}

// An island on a one-colour background, or a patterned picture (testsrc2), as a scene still.
const island = (out, bg, size = SIZE) => mk(['-f', 'lavfi', '-i', `color=c=${bg}:s=${size},drawbox=x=40:y=90:w=100:h=140:color=0xC08040:t=fill`, '-frames:v', '1', out]);
const pattern = (out) => mk(['-f', 'lavfi', '-i', `testsrc2=s=${SIZE}`, '-frames:v', '1', out]);

// The fake clip maker: the seed frame pushed in a little over 2 s, at the seed's size. Records each call.
function fakeGenerate(dir, calls) {
  return async (o) => {
    const n = calls.length + 1;
    const seed = path.join(dir, `fake-seed-${n}.png`);
    fs.writeFileSync(seed, o.firstFramePng);
    calls.push({ prompt: o.prompt, seconds: o.seconds, size: o.size, dims: probeDims(seed), creds: o.creds });
    const m = '(1-1/(1+0.05*in/12))/2';
    const vf = `perspective=x0='W*${m}':y0='H*${m}':x1='W*(1-${m})':y1='H*${m}':x2='W*${m}':y2='H*(1-${m})':x3='W*(1-${m})':y3='H*(1-${m})':eval=frame,format=yuv420p`;
    const out = mk(['-loop', '1', '-t', '2', '-framerate', '12', '-i', seed, '-vf', vf, '-c:v', 'libx264', path.join(dir, `fake-${n}.mp4`)]);
    return { mp4: fs.readFileSync(out), provider: 'sora', label: 'AZURE_SORA', seconds: o.seconds };
  };
}

// A project of three scenes: 1 and 2 on one-colour backgrounds (scene 2's still at another size), 3 patterned.
function project(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dive mode 다이브-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  island(path.join(dir, 's1.png'), '0x223355');
  island(path.join(dir, 's2.png'), '0x335522', '240x320');
  pattern(path.join(dir, 's3.png'));
  const sections = [1, 2, 3].map((i) => ({ id: `s${i}`, label: `Scene ${i}`, still: `s${i}.png`, title: `Title ${i}` }));
  return { dir, manifest: { theme: { bg: '#223355' }, sections } };
}

const promptFor = (leg) => `${leg.kind} ${leg.move || ''}`.trim();

test('planDiveLegs: six scenes make five dives, five exits and the finale, seeded in order; without exits none', () => {
  const scenes = Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, move: i === 2 ? 'arc' : i === 3 ? 'crane' : undefined }));
  const legs = D.planDiveLegs({ scenes });
  assert.deepEqual(legs.map((l) => l.kind).filter((k) => k === 'dive').length, 5);
  assert.deepEqual(legs.map((l) => l.kind).filter((k) => k === 'exit').length, 5);
  assert.deepEqual(legs.at(-1), { kind: 'finale', scene: 5, name: 'finale', seed: { from: 'still', scene: 5 }, seconds: 8, reverse: true });
  assert.deepEqual(legs.slice(0, 2).map((l) => [l.name, l.seed, l.seconds]), [['dive-1', { from: 'still', scene: 0 }, 8], ['exit-1', { from: 'last-frame', leg: 'dive-1' }, 4]]);
  assert.deepEqual(legs.filter((l) => l.kind === 'dive').map((l) => l.move), ['push-in', 'push-in', 'arc', 'crane', 'push-in']);
  assert.equal(D.planDiveLegs({ scenes, exit: false }).filter((l) => l.kind === 'exit').length, 0);
  assert.throws(() => D.planDiveLegs({ scenes: [{ move: 'orbit' }, {}] }), /MOVE "orbit" is not one of push-in, arc, crane/);
  assert.throws(() => D.planDiveLegs({ scenes: [{}] }), /two scenes or more/);
});

test('judgeBackground: a one-colour border lands on a plate, a patterned one does not; the threshold is an argument', { skip: needFf }, async (t) => {
  const { dir } = project(t);
  const on = await D.judgeBackground(path.join(dir, 's1.png'), { ffmpeg: FF });
  const off = await D.judgeBackground(path.join(dir, 's3.png'), { ffmpeg: FF });
  assert.deepEqual([on.on, off.on, on.threshold], [true, false, 6]);
  assert.ok(off.std.some((s) => s > 6), JSON.stringify(off));
  assert.equal((await D.judgeBackground(path.join(dir, 's3.png'), { bgThreshold: 1000, ffmpeg: FF })).on, true);
});

test('runDiveLegs: dives, exits and the finale make an intro.json that assembles; seams land on the next clip\'s border colour', { skip: needFf, timeout: 180_000 }, async (t) => {
  const { dir, manifest } = project(t);
  const calls = [];
  const events = [];
  const r = await D.runDiveLegs({ projectDir: dir, manifest, size: SIZE, promptFor, creds: { AZURE_SORA_API_KEY: FAKE_KEY }, generate: fakeGenerate(dir, calls), ffmpeg: FF, onEvent: (e) => events.push(e) });
  assert.equal(r.stage, 'done');
  assert.deepEqual(calls.map((c) => c.prompt), ['dive push-in', 'exit', 'dive push-in', 'exit', 'finale']);
  assert.deepEqual(calls.map((c) => c.seconds), [8, 4, 8, 4, 8]);
  assert.ok(calls.every((c) => `${c.dims.width}x${c.dims.height}` === SIZE), 'scene 2\'s 240x320 still is scaled before it seeds a clip');
  assert.ok(events.some((e) => e.type === 'resize' && e.scene === 2));
  // exit seeds are the dives' own last frames, taken before any landing
  const ref = await extractLastFrame(path.join(dir, 'clips', 'dive-1.raw.mp4'), path.join(dir, 'ref.png'), { ffmpeg: FF });
  assert.ok(fs.readFileSync(path.join(dir, 'clips', 'seed-exit-1.png')).equals(fs.readFileSync(ref)));
  // gap 1 (scene 2 has a one-colour border): exit-1 ends on the plate; gap 2 (scene 3 patterned): no plate, a note
  assert.deepEqual(r.seams.map((s) => s.on), [true, false]);
  const end = await extractLastFrame(path.join(dir, 'clips', 'exit-1.mp4'), path.join(dir, 'end.png'), { ffmpeg: FF });
  assert.ok(await ssimFrames(end, path.join(dir, 'clips', 'plate-1.png'), { ffmpeg: FF }) >= 0.99);
  assert.ok(!fs.existsSync(path.join(dir, 'clips', 'plate-2.png')));
  assert.ok(events.some((e) => e.type === 'note' && e.gap === 2 && /no one-colour border/.test(e.message)));
  const plate = events.find((e) => e.type === 'plate' && e.gap === 1);
  assert.ok(Math.abs(plate.rgb[1] - 0x55) <= 6 && Math.abs(plate.rgb[2] - 0x22) <= 6, `plate ${plate.rgb} is scene 2's background`);
  assert.ok(events.some((e) => e.type === 'post' && e.clip === 'exit-1' && e.fn.join() === 'land'), 'exit-1: the landing only, no tone step');
  assert.ok(!events.some((e) => 'tone' in e), 'no tone step on any clip');
  assert.ok(!JSON.stringify(events).includes(FAKE_KEY), 'no key in any event');
  assert.deepEqual(r.manifest.connectors, ['clips/exit-1.mp4', 'clips/exit-2.mp4']);
  assert.deepEqual(r.manifest.connectorStills, ['clips/exit-1-first.png', 'clips/exit-2-first.png']);
  assert.equal(r.manifest.sections[2].still, 'clips/finale-first.png');
  const built = assemble({ projectDir: dir });
  const intro = fs.readFileSync(path.join(built.outDir, 'intro.js'), 'utf8');
  assert.match(intro, /"connectorStills":\s*\[\s*"assets\/conn1-poster\.png"/);
});

test('runDiveLegs: the finale is reversed and ends on the closing still', { skip: needFf, timeout: 120_000 }, async (t) => {
  const { dir, manifest } = project(t);
  manifest.sections[2].still = 's1.png';
  await D.runDiveLegs({ projectDir: dir, manifest, size: SIZE, promptFor, exit: false, generate: fakeGenerate(dir, []), ffmpeg: FF });
  const end = await extractLastFrame(path.join(dir, 'clips', 'finale.mp4'), path.join(dir, 'fend.png'), { ffmpeg: FF });
  assert.ok(await ssimFrames(end, path.join(dir, 's1.png'), { ffmpeg: FF }) >= 0.99);
});

test('runDiveLegs: first pair gate makes scene 1\'s dive and exit only, two versions to compare; the full run reuses them', { skip: needFf, timeout: 180_000 }, async (t) => {
  const { dir, manifest } = project(t);
  const calls = [];
  const gate = await D.runDiveLegs({ projectDir: dir, manifest, size: SIZE, promptFor, exit: false, only: 'first', generate: fakeGenerate(dir, calls), ffmpeg: FF });
  assert.equal(gate.stage, 'first-pair');
  assert.deepEqual(calls.map((c) => c.prompt), ['dive push-in', 'exit'], 'the gate shows the exit version even when exits are off');
  assert.deepEqual([gate.withoutExit, gate.withExit], [['clips/gate/dive-1.noexit.mp4'], ['clips/gate/dive-1.mp4', 'clips/gate/exit-1.mp4']]);
  assert.ok(typeof gate.diveExitSsim === 'number' && typeof gate.motion.zoom === 'number');
  assert.ok(!fs.existsSync(path.join(dir, 'intro.json')), 'nothing past the gate');
  const end = await extractLastFrame(path.join(dir, gate.withoutExit[0]), path.join(dir, 'g.png'), { ffmpeg: FF });
  assert.ok(await ssimFrames(end, path.join(dir, 'clips', 'plate-1.png'), { ffmpeg: FF }) >= 0.99, 'the version without the exit lands the dive on the plate');
  const full = await D.runDiveLegs({ projectDir: dir, manifest, size: SIZE, promptFor, exit: false, generate: fakeGenerate(dir, calls), ffmpeg: FF });
  assert.deepEqual(calls.slice(2).map((c) => c.prompt), ['dive push-in', 'finale'], 'dive 1 is not paid for again');
  assert.deepEqual(full.manifest.connectors, [null, null]);
  assert.equal(full.manifest.connectorStills, undefined);
  const dive = await extractLastFrame(path.join(dir, 'clips', 'dive-1.mp4'), path.join(dir, 'd.png'), { ffmpeg: FF });
  assert.ok(await ssimFrames(dive, path.join(dir, 'clips', 'plate-1.png'), { ffmpeg: FF }) >= 0.99, 'without exits the dive lands');
});

test('runDiveLegs: with zoomBoost the exit seed is the zoomed dive\'s last frame', { skip: needFf, timeout: 180_000 }, async (t) => {
  const { dir, manifest } = project(t);
  manifest.sections[0].zoom = 1.2;
  await D.runDiveLegs({ projectDir: dir, manifest, size: SIZE, promptFor, only: 'first', generate: fakeGenerate(dir, []), ffmpeg: FF });
  const ref = await extractLastFrame(path.join(dir, 'clips', 'dive-1.zoom.mp4'), path.join(dir, 'zref.png'), { ffmpeg: FF });
  assert.ok(fs.readFileSync(path.join(dir, 'clips', 'seed-exit-1.png')).equals(fs.readFileSync(ref)));
});
