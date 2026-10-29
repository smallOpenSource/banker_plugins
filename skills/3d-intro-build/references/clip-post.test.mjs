// Tests for clip-post.mjs. The graph and banner tests need nothing; the rest run real ffmpeg on
// synthetic media (testsrc2, color), so they need ffmpeg (FFMPEG_PATH or PATH). Without ffmpeg they
// are skipped with that reason, except under INTRO_E2E=1, where a missing ffmpeg fails them:
//   INTRO_E2E=1 FFMPEG_PATH=<ffmpeg> node --test skills/3d-intro-build/references/clip-post.test.mjs
import { strict as assert } from 'node:assert';
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import * as C from './clip-post.mjs';
import { resolveFfmpeg } from './azure-adapter.mjs';

const RUN = process.env.INTRO_E2E === '1';
const FF = await resolveFfmpeg().catch(() => null);
const needFf = !FF && !RUN && 'ffmpeg not found (set FFMPEG_PATH, or INTRO_E2E=1 to make this a failure)';

function work(t) {
  // a folder name with a space and Korean letters: paths go to ffmpeg as arguments, never through a shell or a graph
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'clip post 후처리-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

function mk(args) {
  assert.ok(FF, 'ffmpeg is required under INTRO_E2E=1');
  const r = cp.spawnSync(FF, ['-hide_banner', '-y', ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr.slice(-400));
  return args.at(-1);
}

const enc = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p'];
const still = (d, name = 'still.png', src = 'testsrc2=s=320x568') => mk(['-f', 'lavfi', '-i', src, '-frames:v', '1', path.join(d, name)]);
const loop = (png, out, vf, { sec = 4, fps = 24 } = {}) => mk(['-loop', '1', '-t', String(sec), '-framerate', String(fps), '-i', png, ...(vf ? ['-vf', vf] : []), ...enc, out]);
const frameAt = (mp4, n, out) => mk(['-i', mp4, '-vf', `select='eq(n,${n})'`, '-frames:v', '1', out]);
const lastOf = (mp4, out) => mk(['-sseof', '-1', '-i', mp4, '-update', '1', out]);

// What the scrub engine needs of every output: keyframes at most 8 frames apart, yuv420p, no audio, moov first.
async function assertEngineReady(mp4) {
  const info = await C.probeClip(mp4, { ffmpeg: FF });
  const banner = cp.spawnSync(FF, ['-hide_banner', '-i', mp4], { encoding: 'utf8' }).stderr;
  assert.match(banner, /Video: h264[^\n]*yuv420p/, 'yuv420p');
  assert.doesNotMatch(banner, /Audio:/, 'no audio');
  const keys = [...cp.spawnSync(FF, ['-hide_banner', '-skip_frame', 'nokey', '-i', mp4, '-vf', 'showinfo', '-f', 'null', '-'], { encoding: 'utf8' }).stderr.matchAll(/pts_time:([\d.]+)/g)].map((m) => Number(m[1]));
  const ends = [...keys, info.duration];
  const gap = Math.max(...ends.slice(1).map((t, i) => Math.round((t - ends[i]) * info.fps)));
  assert.ok(gap <= 8, `keyframes at most 8 frames apart (largest gap ${gap})`);
  const bytes = fs.readFileSync(mp4);
  assert.ok(bytes.indexOf('moov') < bytes.indexOf('mdat'), 'faststart: moov before mdat');
  return info;
}

test('ENCODE is the one encoder setting: H.264 yuv420p, a keyframe every 8 frames, faststart, no audio', () => {
  assert.deepEqual(C.ENCODE, ['-c:v', 'libx264', '-crf', '20', '-g', '8', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an']);
});

test('filterGraph: one graph for every step, in order, with no file path in it', () => {
  const info = { width: 720, height: 1280, fps: 24, duration: 8 };
  const g = C.filterGraph(info, { reverse: true, zoom: { to: 1.2 }, land: { png: '/x y/plate.png', sec: 0.6 } });
  assert.ok(g.indexOf('reverse') < g.indexOf('perspective') && g.indexOf('perspective') < g.indexOf('xfade'));
  assert.ok(!g.includes('plate.png'), 'the plate goes in as an -i input');
  assert.ok(!/lutrgb|gbrp/.test(g), 'no RGB round trip: the clip stays in YUV');
  assert.match(g, /format=yuv420p,setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709\[out\]$/, 'an untagged clip comes out tagged bt709');
  assert.match(g, /xfade=transition=fade:duration=0\.5167:offset=7\.4/);
  assert.match(g, /\[out\]$/);
  assert.equal(C.filterGraph(info, {}), `[0:v]setsar=1,fps=24[s0];[s0]format=yuv420p,${C.colourParams()}[out]`);
});

test('parseBanner: size, rate and length from the banner; no video stream throws', () => {
  const text = 'Duration: 00:00:08.04, start: 0.000000\n  Stream #0:0[0x1](und): Video: h264 (High), yuv420p(progressive), 720x1280 [SAR 1:1 DAR 9:16], 30 fps, 30 tbr';
  assert.deepEqual(C.parseBanner(text), { width: 720, height: 1280, fps: 30, duration: 8.04, color: C.COLOUR_DEFAULT });
  assert.deepEqual(C.colourOf('Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709, progressive), 1280x720'), { range: 'tv', space: 'bt709', primaries: 'bt709', trc: 'bt709' });
  assert.deepEqual(C.colourOf('Video: h264 (High), yuvj420p(pc, bt470bg/unknown/iec61966-2-1), 720x1280'), { range: 'pc', space: 'bt470bg', primaries: 'bt709', trc: 'iec61966-2-1' });
  assert.equal(C.colourParams(), 'setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709');
  assert.throws(() => C.parseBanner('Duration: 00:00:01.00\n Stream #0:0: Audio: aac'), /not a video/);
});

test('reverseClip: output frame k is input frame N-1-k; a 13 s clip is refused', { skip: needFf, timeout: 120_000 }, async (t) => {
  const d = work(t);
  // tagged bt709 like the output, so that the test's own frame grabs decode both alike
  const src = mk(['-f', 'lavfi', '-i', 'testsrc2=s=320x568:r=24:d=2', '-vf', C.colourParams(), ...enc, path.join(d, 'moving.mp4')]);
  const out = path.join(d, 'rev.mp4');
  await C.reverseClip(src, out, { ffmpeg: FF });
  const info = await assertEngineReady(out);
  const n = Math.round(info.duration * info.fps);
  for (const k of [0, Math.floor(n / 2), n - 1]) {
    const s = await C.ssimFrames(frameAt(out, k, path.join(d, `o${k}.png`)), frameAt(src, n - 1 - k, path.join(d, `i${k}.png`)), { ffmpeg: FF });
    assert.ok(s >= 0.98, `frame ${k}: SSIM ${s}`);
  }
  const long = loop(still(d), path.join(d, 'long.mp4'), null, { sec: 13 });
  await assert.rejects(() => C.reverseClip(long, path.join(d, 'no.mp4'), { ffmpeg: FF }), /past the limit \(12 s/);
});

test('landOnStill: 24 and 30 fps clips keep their length and end on the plate', { skip: needFf, timeout: 120_000 }, async (t) => {
  const d = work(t);
  const plate = await C.solidPlate([30, 60, 120], '320x568', path.join(d, 'plate.png'), { ffmpeg: FF });
  for (const fps of [24, 30]) {
    const src = mk(['-f', 'lavfi', '-i', `testsrc2=s=320x568:r=${fps}:d=3`, ...enc, path.join(d, `in${fps}.mp4`)]);
    const out = path.join(d, `land${fps}.mp4`);
    await C.landOnStill(src, plate, out, { ffmpeg: FF });
    const info = await assertEngineReady(out);
    assert.ok(Math.abs(info.duration - 3) <= 0.05, `${fps} fps: ${info.duration} s`);
    assert.equal(info.fps, fps);
    const s = await C.ssimFrames(lastOf(out, path.join(d, `last${fps}.png`)), plate, { ffmpeg: FF });
    assert.ok(s >= 0.99, `${fps} fps: last frame against the plate SSIM ${s}`);
  }
});

test('frameStats: a one-colour border reads as uniform, a patterned one does not', { skip: needFf, timeout: 60_000 }, async (t) => {
  const d = work(t);
  const island = still(d, 'island.png', 'color=c=0x336699:s=320x568,drawbox=x=60:y=120:w=200:h=300:color=0xC08040:t=fill');
  const pattern = still(d, 'pattern.png');
  const a = await C.frameStats(island, { border: 0.04, ffmpeg: FF });
  const b = await C.frameStats(pattern, { border: 0.04, ffmpeg: FF });
  assert.ok(a.std.every((s) => s <= 6), `island border std ${a.std}`);
  assert.ok(a.mean.map(Math.round).every((m, c) => Math.abs(m - [0x33, 0x66, 0x99][c]) <= 3), `border mean ${a.mean}`);
  assert.ok(b.std.some((s) => s > 6), `patterned border std ${b.std}`);
  assert.ok(a.pixels < 320 * 568 / 4, 'only the band is read');
});

test('borderMode: an island touching the top edge on one colour is a background; a checker, grass noise and a full-bleed picture are not', { skip: needFf, timeout: 60_000 }, async (t) => {
  const d = work(t);
  const touching = still(d, 'touch.png', 'color=c=0xF3E9DC:s=320x568,drawbox=x=120:y=0:w=60:h=200:color=0x704020:t=fill');
  const checker = still(d, 'checker.png', "color=c=white:s=320x568,geq=lum='if(mod(floor(X/16)+floor(Y/16),2),40,220)':cb=128:cr=128");
  const grass = still(d, 'grass.png', 'color=c=0x4A7A30:s=320x568,noise=alls=60:allf=u');
  const photo = still(d, 'photo.png', 'testsrc2=s=320x568');
  const m = await C.borderColour(touching, { ffmpeg: FF });
  assert.ok(m.share >= 0.85, `touching: ${m.share}`);
  assert.ok(m.rgb.every((v, c) => Math.abs(v - [0xF3, 0xE9, 0xDC][c]) <= 3), `the colour is the background, not the roof: ${m.rgb}`);
  for (const [name, png] of [['checker', checker], ['grass', grass], ['photo', photo]]) {
    const r = await C.borderColour(png, { ffmpeg: FF });
    assert.ok(r.share < 0.85, `${name}: ${r.share}`);
  }
});

test('cameraMotion: 3 degrees a second of roll, 1.03 a second of zoom, and a still clip read as such', { skip: needFf, timeout: 120_000 }, async (t) => {
  const d = work(t);
  const png = still(d, 'still.png', 'testsrc2=s=360x640');
  const rot = await C.cameraMotion(loop(png, path.join(d, 'rot.mp4'), "rotate=a='t*PI/180*3'"), { ffmpeg: FF });
  const m = '(1-1/pow(1.03\\,in/24))/2';
  const zoomVf = `perspective=x0='W*${m}':y0='H*${m}':x1='W*(1-${m})':y1='H*${m}':x2='W*${m}':y2='H*(1-${m})':x3='W*(1-${m})':y3='H*(1-${m})':eval=frame`;
  const zoom = await C.cameraMotion(loop(png, path.join(d, 'zoom.mp4'), zoomVf), { ffmpeg: FF });
  const calm = await C.cameraMotion(loop(png, path.join(d, 'calm.mp4'), null), { ffmpeg: FF });
  assert.ok(rot.pairs.length >= 3);
  assert.ok(Math.abs(rot.rollDeg - 3 * rot.pairs.length) <= 1, `roll ${rot.rollDeg} over ${rot.pairs.length} s (clockwise is positive)`);
  assert.ok(Math.abs(zoom.zoom - 1.03 ** zoom.pairs.length) <= 0.02, `zoom ${zoom.zoom} over ${zoom.pairs.length} s`);
  assert.ok(Math.abs(calm.rollDeg) <= 0.5 && Math.abs(calm.zoom - 1) <= 0.01, `still ${calm.rollDeg} ${calm.zoom}`);
  assert.match(rot.method, /roll approximation/);
});

test('zoomBoost: a centred push-in at the clip size that cameraMotion reads back', { skip: needFf, timeout: 120_000 }, async (t) => {
  const d = work(t);
  const src = loop(still(d, 'z.png', 'testsrc2=s=360x640'), path.join(d, 'z.mp4'), null);
  const out = path.join(d, 'boost.mp4');
  await C.zoomBoost(src, out, { to: 1.2, ffmpeg: FF });
  const info = await assertEngineReady(out);
  assert.deepEqual([info.width, info.height], [360, 640]);
  const m = await C.cameraMotion(out, { ffmpeg: FF });
  assert.ok(m.zoom > 1.1 && Math.abs(m.rollDeg) <= 0.5, `zoom ${m.zoom}, roll ${m.rollDeg}`);
});

test('postClip: zoom and landing run as one graph, one encode, tagged with the source colours; seamReport gives seams and motion in playing order', { skip: needFf, timeout: 180_000 }, async (t) => {
  const d = work(t);
  const seed = still(d, 's1.png');
  const plate = await C.solidPlate([20, 20, 20], '320x568', path.join(d, 'plate.png'), { ffmpeg: FF });
  const drift = loop(seed, path.join(d, 'a.mp4'), null, { sec: 3 });
  const r = await C.postClip(drift, path.join(d, 'a-post.mp4'), { zoom: { to: 1.1 }, land: { png: plate } }, { ffmpeg: FF });
  assert.deepEqual([r.encoded, r.steps], [true, ['zoom', 'land']]);
  await assertEngineReady(r.out);
  assert.deepEqual((await C.probeClip(r.out, { ffmpeg: FF })).color, C.COLOUR_DEFAULT, 'an untagged source comes out tagged bt709');
  const pc = mk(['-f', 'lavfi', '-i', 'testsrc2=s=320x568:r=24:d=1', ...enc, '-vf', 'setparams=range=pc:color_primaries=bt470bg:color_trc=smpte170m:colorspace=bt470bg', path.join(d, 'pc.mp4')]);
  const rp = await C.reverseClip(pc, path.join(d, 'pc-rev.mp4'), { ffmpeg: FF });
  assert.deepEqual((await C.probeClip(rp.out, { ffmpeg: FF })).color, { range: 'pc', space: 'bt470bg', primaries: 'bt470bg', trc: 'smpte170m' }, 'a tagged source keeps its tags');
  loop(plate, path.join(d, 'b.mp4'), null, { sec: 2 });
  fs.writeFileSync(path.join(d, 'intro.json'), JSON.stringify({ sections: [{ clip: 'a-post.mp4' }, { clip: 'b.mp4' }], connectors: [null] }));
  const rep = await C.seamReport(d, { ffmpeg: FF });
  assert.deepEqual(rep.clips.map((c) => [c.role, c.file]), [['section', 'a-post.mp4'], ['section', 'b.mp4']]);
  assert.equal(rep.seams.length, 1);
  assert.ok(rep.seams[0].ssim >= 0.99, `a landed clip meets the plate clip: ${rep.seams[0].ssim}`);
  assert.ok(rep.clips.every((c) => typeof c.rollDeg === 'number' && typeof c.zoom === 'number'));
});

test('postClip: a false step is no step (copied, nothing reported); a landing is timed on the video, not on a longer audio track', { skip: needFf, timeout: 120_000 }, async (t) => {
  const d = work(t);
  const src = mk(['-f', 'lavfi', '-i', 'testsrc2=s=320x568:r=30:d=2', ...enc, path.join(d, 'v.mp4')]);
  const r = await C.postClip(src, path.join(d, 'same.mp4'), { reverse: false, zoom: null }, { ffmpeg: FF });
  assert.deepEqual([r.encoded, r.steps], [false, []]);
  // sora-2 clips carry audio a little longer than the video (4.1 s for 4.0 s): the container Duration is the audio's
  const av = mk(['-f', 'lavfi', '-i', 'testsrc2=s=320x568:r=30:d=3', '-f', 'lavfi', '-i', 'sine=d=3.6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path.join(d, 'av.mp4')]);
  const info = await C.probeClip(av, { ffmpeg: FF });
  assert.deepEqual([info.duration, info.container], [3, 3.6]);
  const plate = await C.solidPlate([30, 60, 120], '320x568', path.join(d, 'plate.png'), { ffmpeg: FF });
  await C.landOnStill(av, plate, path.join(d, 'land.mp4'), { ffmpeg: FF });
  const s = await C.ssimFrames(lastOf(path.join(d, 'land.mp4'), path.join(d, 'last.png')), plate, { ffmpeg: FF });
  assert.ok(s >= 0.99, `the last frame is the plate: SSIM ${s}`);
});
