// Tests for the measuring logic of verify-intro.mjs. The browser part needs Playwright and runs
// in intro-e2e.test.mjs (INTRO_E2E=1). Run from the repo root:
//   node --test skills/3d-intro-build/references/verify-intro.test.mjs
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  TEXT_PARTS, VIEWPORTS, colorAlpha, contrastRatio, fillContrast, insideViewport, intersects, judge, loadPlaywright, parseArgs, parseColor,
  parseViewport, relLuminance, screenshot, worstContrast, blankRuns, configFromIntroJs, decodePng, isBlank, meanAbsDiff, segmentsOf,
} from './verify-intro.mjs';
import { assemble } from './assemble.mjs';

test('the default screens are the ones the guide lists and a phone on its side, touch where a phone is', () => {
  assert.deepEqual(VIEWPORTS.map((v) => `${v.width}x${v.height}${v.touch ? ' touch' : ''}`),
    ['1280x800', '1920x1080', '860x900', '390x844 touch', '375x667 touch', '844x390 touch']);
});

test('a screen size on the command line may mark touch and reduced motion', () => {
  assert.deepEqual(parseViewport('390x844t'), { width: 390, height: 844, touch: true, reduce: false });
  assert.deepEqual(parseViewport('1280x800r'), { width: 1280, height: 800, touch: false, reduce: true });
  assert.throws(() => parseViewport('big'), /not a screen size/);
});

test('contrast follows WCAG: white on black is 21, equal colours 1', () => {
  assert.equal(relLuminance([255, 255, 255]), 1);
  assert.equal(relLuminance([0, 0, 0]), 0);
  assert.equal(contrastRatio(1, 0), 21);
  assert.equal(contrastRatio(0.5, 0.5), 1);
  assert.equal(Number(contrastRatio(relLuminance([241, 245, 249]), relLuminance([11, 18, 32])).toFixed(2)), 17.09, '#F1F5F9 on #0B1220, worked by hand');
  assert.deepEqual(parseColor('rgb(241, 245, 249)'), [241, 245, 249]);
  assert.deepEqual(parseColor('rgba(255, 255, 255, 0.5)'), [255, 255, 255]);
});

test('a colour reads in the forms a browser reports, and an unknown form is not taken for black', () => {
  assert.deepEqual(parseColor('color(srgb 0.765882 0.922353 0.991765)'), [195, 235, 253], 'color-mix() in srgb');
  assert.deepEqual(parseColor('rgb(1 2 3 / 0.5)'), [1, 2, 3]);
  assert.equal(parseColor('oklch(0.7 0.1 200)'), null);
  const ok = { inViewport: true, belowHeader: true, overlaps: [], hOverflow: false };
  assert.deepEqual(judge({ ...ok, contrast: [{ el: 'eyebrow', line: 1, min: null, why: 'colour oklch(0.7 0.1 200)' }] }, { minContrast: 4.5 }),
    ['contrast eyebrow line 1: not measured (colour oklch(0.7 0.1 200))']);
  assert.deepEqual(judge({ ...ok, contrast: [{ el: 'body', line: 4, min: NaN }] }, { minContrast: 4.5 }),
    ['contrast body line 4: NaN'], 'a contrast that is not a number never passes');
});

test('a translucent text colour is measured blended over each pixel behind it', () => {
  assert.equal(colorAlpha('rgba(1, 2, 3, 0.5)'), 0.5);
  assert.equal(colorAlpha('rgb(1 2 3 / 50%)'), 0.5);
  assert.equal(colorAlpha('color(srgb 1 1 1 / 0.25)'), 0.25);
  assert.equal(colorAlpha('rgb(1, 2, 3)'), 1);
  const black = new Uint8ClampedArray([0, 0, 0, 255]);
  const rect = { x: 0, y: 0, width: 1, height: 1 };
  assert.equal(Math.round(worstContrast([255, 255, 255], black, 1, rect)), 21);
  const half = worstContrast([255, 255, 255], black, 1, rect, 0.5);
  assert.ok(half > 5 && half < 5.5, `white at half opacity on black reads as mid grey: ${half}`);
});

test('the command line takes --flag value and --flag=value, and refuses an unknown flag', () => {
  const o = parseArgs(['http://x/', '--out=r.json', '--header', '.site-header', '--min-contrast=4.5', '--viewports=1280x800,390x844t']);
  assert.deepEqual([o.url, o.out, o.header, o.minContrast, o.viewports.length], ['http://x/', 'r.json', '.site-header', 4.5, 2]);
  assert.throws(() => parseArgs(['http://x/', '--outt', 'r.json']), /unknown option --outt/);
});

test('a line is judged by its worst pixel behind it, light or dark text alike', () => {
  // 4 x 2 RGBA image: dark navy everywhere but one bright pixel at (3, 1).
  const w = 4;
  const px = new Uint8ClampedArray(4 * 2 * 4);
  for (let i = 0; i < px.length; i += 4) px.set([11, 18, 32, 255], i);
  px.set([200, 210, 220, 255], (1 * w + 3) * 4);
  const light = [241, 245, 249];
  const all = worstContrast(light, px, w, { x: 0, y: 0, width: 4, height: 2 });
  const left = worstContrast(light, px, w, { x: 0, y: 0, width: 3, height: 2 });
  assert.ok(all < 1.5, `the bright pixel decides: ${all}`);
  assert.ok(left > 16, `without it the navy decides: ${left}`);
  const dark = worstContrast([11, 18, 32], px, w, { x: 0, y: 0, width: 4, height: 2 });
  assert.ok(dark < 1.1, 'dark text is judged by the darkest pixel');
});

test('boxes overlap only when they share area, and a panel must sit inside the screen', () => {
  assert.equal(intersects({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 5, height: 5 }), false);
  assert.equal(intersects({ x: 0, y: 0, width: 10, height: 10 }, { x: 9, y: 9, width: 5, height: 5 }), true);
  assert.equal(insideViewport({ x: 0.4, y: 81.3, width: 300, height: 200 }, 1280, 800), true, '1 px of slack for fractional layout');
  assert.equal(insideViewport({ x: -3, y: 10, width: 300, height: 200 }, 1280, 800), false);
});

test('a scene fails on overflow, overlap, a panel off screen or under the header, low contrast or console errors', () => {
  const ok = { inViewport: true, belowHeader: true, overlaps: [], hOverflow: false, contrast: [{ el: 'body', line: 1, min: 5.1 }] };
  assert.deepEqual(judge(ok, { minContrast: 4.5 }), []);
  assert.deepEqual(judge({ ...ok, contrast: [{ el: 'body', line: 2, min: 4.2 }] }, { minContrast: 4.5 }), ['contrast body line 2: 4.2']);
  assert.deepEqual(judge({ ...ok, overlaps: ['.isn-hint'], hOverflow: true }, { minContrast: 4.5 }),
    ['overlaps .isn-hint', 'horizontal overflow']);
  assert.deepEqual(judge({ ...ok, inViewport: false, belowHeader: false }, { minContrast: 4.5 }), ['panel outside the screen', 'panel under the header']);
  assert.deepEqual(judge({ ...ok, contrast: [{ el: 'cta', line: 1, min: 1.1 }] }, { minContrast: 4.5 }), ['contrast cta line 1: 1.1']);
});

test('a panel is measured for every text part and each CTA button label', () => {
  assert.deepEqual(TEXT_PARTS.map(([el]) => el), ['num', 'eyebrow', 'title', 'body', 'cta']);
  assert.equal(Object.fromEntries(TEXT_PARTS).cta, '.sw-copy__cta .sw-btn');
});

test('a button outside the panels is measured against its own solid fill; any other fill is not measured, never passed', () => {
  assert.deepEqual(fillContrast('rgb(255, 255, 255)', 'rgb(241, 245, 249)'), { ratio: 1.1 }, 'white on a light pill');
  assert.ok(fillContrast('rgb(11, 18, 32)', 'rgb(241, 245, 249)').ratio > 15);
  assert.deepEqual(fillContrast('rgb(255, 255, 255)', 'rgba(11, 18, 32, 0.6)'), { ratio: null, why: 'fill not solid: rgba(11, 18, 32, 0.6)' });
  assert.deepEqual(fillContrast('rgb(255, 255, 255)', 'rgba(0, 0, 0, 0)'), { ratio: null, why: 'fill not solid: rgba(0, 0, 0, 0)' });
  assert.deepEqual(fillContrast('oklch(0.98 0.01 250)', 'rgb(11, 18, 32)'), { ratio: null, why: 'colour oklch(0.98 0.01 250)' });
});

test('a scene fails when its clip is there but never shows; no clip, the first scene and reduced motion do not', () => {
  const ok = { inViewport: true, belowHeader: true, overlaps: [], hOverflow: false, contrast: [] };
  assert.deepEqual(judge({ ...ok, clip: 'not shown' }, { minContrast: 4.5 }), ['clip not shown']);
  for (const clip of ['shown', 'none', 'poster', 'off', undefined]) assert.deepEqual(judge({ ...ok, clip }, { minContrast: 4.5 }), [], String(clip));
});

test('--playwright-from-project is a switch, off unless given', () => {
  assert.equal(parseArgs(['http://x/']).playwrightFromProject, false);
  assert.equal(parseArgs(['http://x/', '--playwright-from-project']).playwrightFromProject, true);
});

// A project folder holding its own playwright package and an npm that leaves a mark when it runs.
function plantedProject() {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'vi-proj-'));
  const pw = path.join(proj, 'node_modules', 'playwright');
  fs.mkdirSync(pw, { recursive: true });
  fs.writeFileSync(path.join(pw, 'package.json'), '{"name":"playwright","main":"index.js"}');
  fs.writeFileSync(path.join(pw, 'index.js'), "module.exports = { chromium: 'from-project' };");
  fs.writeFileSync(path.join(proj, 'npm'), '#!/bin/sh\ntouch "$(dirname "$0")/planted-npm-ran"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(proj, 'npm.cmd'), '@echo off\r\necho x> "%~dp0planted-npm-ran"\r\n');
  return proj;
}

// npm settings for the `npm root -g` that loadPlaywright runs: its cache and log go to a temp folder, not the real
// ~/.npm/_logs, and it makes no update check. npm reads npm_config_* names whatever their case, so every spelling of
// these is set aside while the test runs.
const NPM_KEYS = ['npm_config_cache', 'npm_config_update_notifier'];
function npmToTemp(dir) {
  const saved = Object.entries(process.env).filter(([k]) => NPM_KEYS.includes(k.toLowerCase()));
  for (const [k] of saved) delete process.env[k];
  Object.assign(process.env, { npm_config_cache: path.join(dir, 'npm-cache'), npm_config_update_notifier: 'false' });
  return () => {
    for (const k of NPM_KEYS) delete process.env[k];
    Object.assign(process.env, Object.fromEntries(saved));
  };
}

test('playwright comes from the project only when asked, and npm never runs from the project folder', async () => {
  const proj = plantedProject();
  const npmDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vi-npm-'));
  const restoreNpm = npmToTemp(npmDir);
  const cwd = process.cwd();
  const PATH = process.env.PATH;
  process.chdir(proj);
  process.env.PATH = ['.', PATH].join(path.delimiter);
  try {
    // Nothing beside the script: a playwright in a folder above this checkout would win the bare import.
    const importBeside = () => Promise.reject(new Error('not beside'));
    const unasked = await loadPlaywright({ importBeside }).then((m) => m.chromium, () => null);
    assert.notEqual(unasked, 'from-project', 'the project package is not loaded unless asked');
    assert.equal(fs.existsSync(path.join(proj, 'planted-npm-ran')), false, 'npm did not run from the project folder');
    assert.equal((await loadPlaywright({ fromProject: true, importBeside })).chromium, 'from-project');
  } finally {
    process.chdir(cwd);
    process.env.PATH = PATH;
    restoreNpm();
    fs.rmSync(npmDir, { recursive: true, force: true });
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('screenshot tries again only after Chromium\'s "Unable to capture screenshot", up to three times', async () => {
  const page = (errors) => ({ calls: 0, async screenshot() { this.calls++; const e = errors.shift(); if (e) throw new Error(e); return 'png'; } });
  let p = page(['Protocol error (Page.captureScreenshot): Unable to capture screenshot', 'Unable to capture screenshot']);
  assert.equal(await screenshot(p, {}, { waitMs: 1 }), 'png');
  assert.equal(p.calls, 3);
  p = page(['Unable to capture screenshot', 'Unable to capture screenshot', 'Unable to capture screenshot']);
  await assert.rejects(screenshot(p, {}, { waitMs: 1 }), /Unable to capture screenshot/);
  assert.equal(p.calls, 3, 'gives up after three');
  p = page(['Target page, context or browser has been closed']);
  await assert.rejects(screenshot(p, {}, { waitMs: 1 }), /has been closed/);
  assert.equal(p.calls, 1, 'any other error is thrown at once');
});

// ---- seam probe helpers (--seams; the browser part runs in intro-e2e.test.mjs) ----

const rgba = (n, [r, g, b]) => { const a = new Uint8ClampedArray(n * 4); for (let i = 0; i < a.length; i += 4) a.set([r, g, b, 255], i); return a; };

test('--seams and --slow-clips are read from the command line', () => {
  const o = parseArgs(['http://x/', '--seams', '--slow-clips', '1500']);
  assert.deepEqual([o.seams, o.slowClipsMs], [true, 1500]);
  assert.deepEqual([parseArgs(['http://x/']).seams, parseArgs(['http://x/']).slowClipsMs], [false, 0]);
});

test('segmentsOf: dives and connectors in scroll order, as the engine lays them out; the config comes from an assembled intro.js', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seams-unit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const f of ['a.png', 'b.png', 'c.png', 'a.mp4', 'b.mp4', 'c.mp4', 'x.mp4', 'p.png']) fs.writeFileSync(path.join(dir, f), 'x');
  fs.writeFileSync(path.join(dir, 'intro.json'), JSON.stringify({ diveScroll: 1, connScroll: 0.5, stepNav: {},
    sections: [{ id: 'a', still: 'a.png', clip: 'a.mp4', scroll: 2 }, { id: 'b', still: 'b.png', clip: 'b.mp4' }, { id: 'c', still: 'c.png', clip: 'c.mp4' }],
    connectors: ['x.mp4', null], connectorStills: ['p.png', null] }));
  const built = assemble({ projectDir: dir });
  const config = configFromIntroJs(fs.readFileSync(path.join(built.outDir, 'intro.js'), 'utf8'));
  assert.deepEqual(config.connectorStills, ['assets/conn1-poster.png', null]);
  assert.deepEqual(segmentsOf(config).map((s) => [s.label, s.start, s.end]), [['dive 1', 0, 2], ['conn 1', 2, 2.5], ['dive 2', 2.5, 3.5], ['dive 3', 3.5, 4.5]]);
  assert.equal(configFromIntroJs('nothing here'), null);
});

test('isBlank is a near one-colour screen of any colour; meanAbsDiff and blankRuns', () => {
  assert.equal(isBlank(rgba(100, [0, 0, 0])), true);
  assert.equal(isBlank(rgba(100, [240, 30, 90])), true, 'a one-colour screen of any colour');
  const mixed = rgba(100, [20, 20, 20]);
  for (let i = 0; i < 40; i += 4) mixed.set([200, 200, 200, 255], i * 4);
  assert.equal(isBlank(mixed), false);
  assert.equal(meanAbsDiff(rgba(4, [0, 0, 0]), rgba(4, [30, 60, 90])), 60);
  const ys = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6];
  assert.deepEqual(blankRuns([false, true, true, true, true, false, true], ys, 0.3), [{ fromVh: 0.1, toVh: 0.4, lengthVh: 0.4 }]);
  assert.deepEqual(blankRuns([true, true, false, false, false, false, false], ys, 0.3), [], 'a short run is a plate landing, not a blank');
});

test('decodePng reads an 8-bit RGB PNG with every row filter, as zlib wrote it', async () => {
  const zlib = await import('node:zlib');
  const w = 3; const h = 5;
  const px = (x, y) => [x * 40 + y, 200 - y * 30, (x * y * 17) & 255];
  const rows = [];
  for (let y = 0; y < h; y++) {
    const line = Buffer.from(Array.from({ length: w }, (_, x) => px(x, y)).flat());
    const prev = y ? Buffer.from(Array.from({ length: w }, (_, x) => px(x, y - 1)).flat()) : Buffer.alloc(w * 3);
    const f = y % 5;   // None, Sub, Up, Average, Paeth
    const enc = Buffer.alloc(w * 3);
    for (let i = 0; i < w * 3; i++) {
      const a = i >= 3 ? line[i - 3] : 0; const b = prev[i]; const c = i >= 3 ? prev[i - 3] : 0;
      const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f];
      enc[i] = (line[i] - pred) & 0xff;
    }
    rows.push(Buffer.from([f]), enc);
  }
  const chunk = (kind, body) => { const len = Buffer.alloc(4); len.writeUInt32BE(body.length); return Buffer.concat([len, Buffer.from(kind, 'latin1'), body, Buffer.alloc(4)]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
  const out = decodePng(png);
  assert.deepEqual([out.width, out.height], [w, h]);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) assert.deepEqual([...out.data.subarray((y * w + x) * 4, (y * w + x) * 4 + 4)], [...px(x, y), 255], `${x},${y}`);
  assert.throws(() => decodePng(Buffer.from('not a png at all')), /not a PNG/);
});

test('alphaNeeded: the panel alpha a failed line needs, from its captured worst pixel; the failure line names it', async () => {
  const V = await import('./verify-intro.mjs');
  const panel = [11, 18, 32];
  const white = [255, 255, 255];
  const capturedOverWhite = panel.map((c) => 0.36 * c + 0.64 * 255);
  assert.equal(V.alphaNeeded([241, 245, 249], 1, capturedOverWhite, panel, 0.36, 4.5), 0.61, 'the body colour over white (assemble takes the darkest panel text, 0.64)');
  assert.equal(V.alphaNeeded([241, 245, 249], 1, panel.map((c) => 0.36 * c + 0.64 * 120), panel, 0.36, 4.5) < 0.36, true, 'over a mid grey: less than now');
  assert.equal(V.alphaNeeded([250, 250, 250], 1, white, [240, 240, 240], 0.5, 4.5), null, 'a light panel never gets there');
  const s = { inViewport: true, belowHeader: true, overlaps: [], hOverflow: false, clip: 'shown',
    contrast: [{ el: 'body', line: 1, min: 3.1, needAlpha: 0.64 }, { el: 'title', line: 1, min: 2, needAlpha: null }, { el: 'cta', line: 1, min: 3 }] };
  assert.deepEqual(V.judge(s, { minContrast: 4.5 }), ['contrast body line 1: 3.1 (needs --intro-panel-alpha >= 0.64)',
    'contrast title line 1: 2 (no panel alpha reaches it)', 'contrast cta line 1: 3']);
});
