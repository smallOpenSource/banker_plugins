// End-to-end check of an assembled intro in a real browser, at no generation cost: stills are
// screenshots of dark gradient pages, the holds are stillToClip of them and each flight is a fade
// from one still to the next (its first and last frames are the stills, as a two-image flight's).
// The page is assembled with step navigation and the glass panel on top of a page body, served
// under a strict CSP, then measured by verify-intro.mjs.
// Needs Playwright with Chromium and ffmpeg (FFMPEG_PATH or PATH), so it runs only when asked:
//   INTRO_E2E=1 node --test skills/3d-intro-build/references/intro-e2e.test.mjs
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { assemble } from './assemble.mjs';
import { crossfade, resolveFfmpeg, stillToClip } from './azure-adapter.mjs';
import { STRICT_CSP } from './preview-lib.mjs';
import { startServe } from './serve.mjs';
import { loadPlaywright, seamProbe, verifyIntro } from './verify-intro.mjs';
import { runDiveLegs } from './dive-mode.mjs';
import { spawnSync } from 'node:child_process';

const RUN = process.env.INTRO_E2E === '1';
const SCENES = [['#0B1220', '#1E3A5F'], ['#132A13', '#31572C'], ['#2B0F3A', '#5A189A']];
const SIZE = { width: 640, height: 360 };

// A dark gradient page, its label on the right, away from the copy panel on the left.
const scenePage = ([a, b], label) => `<!doctype html><body style="margin:0;height:100vh;background:linear-gradient(135deg,${a},${b});
font:700 40px system-ui;color:#94A3B8;display:grid;place-items:center end;padding-right:5%;box-sizing:border-box">${label}</body>`;

async function makeMedia(dir) {
  const ffmpeg = await resolveFfmpeg();
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: SIZE });
    for (const [i, colors] of SCENES.entries()) {
      await page.setContent(scenePage(colors, `Scene ${i + 1}`));
      await page.screenshot({ path: path.join(dir, `s${i + 1}.png`) });
    }
  } finally {
    await browser.close();
  }
  const size = `${SIZE.width}x${SIZE.height}`;
  for (let i = 1; i <= SCENES.length; i++) {
    await stillToClip(path.join(dir, `s${i}.png`), path.join(dir, `hold-${i}.mp4`), { ffmpeg, size });
    await stillToClip(path.join(dir, `s${i}.png`), path.join(dir, `long-${i}.mp4`), { ffmpeg, size, seconds: 2 });
  }
  for (let i = 1; i < SCENES.length; i++) {
    await crossfade(path.join(dir, `long-${i}.mp4`), path.join(dir, `long-${i + 1}.mp4`), path.join(dir, `flight-${i}.mp4`), 1.5, { ffmpeg });
  }
}

const DARK = { bg: '#0B1220', ink: '#F1F5F9', inkSoft: '#CBD5E1', accent: '#38BDF8' };
const LIGHT = { bg: '#F5EDE0', ink: '#241d2b', inkSoft: '#6a6072', accent: '#9B7EBD' };

// A top-bar CTA, and the last scene's primary and secondary (ghost) buttons.
function manifest(theme = DARK) {
  const body = (i) => ['First point of the scene', 'Second point, short', 'Third point to close'].map((t) => `${t} ${i}`).join('\n');
  const cta = { primary: { label: 'Start', href: '#main' }, secondary: { label: 'Learn more', href: '#main' } };
  return {
    lang: 'en', brand: { name: 'Acme' }, cta: { label: 'Order now', href: '#main' }, panel: 'glass', stepNav: { end: '#main' },
    theme, diveScroll: 0.6, connScroll: 1.4,
    sections: SCENES.map((_, i) => ({ id: `s${i + 1}`, label: `Scene ${i + 1}`, still: `s${i + 1}.png`, clip: `hold-${i + 1}.mp4`,
      eyebrow: 'Label', title: `Title ${i + 1}`, body: body(i + 1), tags: ['One', 'Two'], ...(i === SCENES.length - 1 ? { cta } : {}) })),
    connectors: ['flight-1.mp4', 'flight-2.mp4'],
  };
}

// Builds the e2e page for `theme` in a fresh folder, served under a strict CSP that allows the
// engine style by its hash. Resolves to the server.
async function servedIntro(t, theme) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intro-e2e-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await makeMedia(dir);
  fs.writeFileSync(path.join(dir, 'intro.json'), JSON.stringify(manifest(theme)));
  const built = assemble({ projectDir: dir });
  addBody(built.outDir);
  const server = await startServe(built.outDir, { csp: STRICT_CSP.replace("style-src 'self'", `style-src 'self' ${built.styleHash}`) });
  t.after(() => server.close());
  return server;
}

// The intro on top of a page body, as a site would place it. The body comes after the scripts, so
// it does not exist yet when step-nav attaches (a body a framework draws later is the same case).
function addBody(siteDir) {
  const index = path.join(siteDir, 'index.html');
  const paras = Array.from({ length: 40 }, (_, i) => `<p>Body paragraph ${i + 1}.</p>`).join('\n');
  fs.writeFileSync(index, fs.readFileSync(index, 'utf8').replace('</body>', `<main id="main"><h1>Main content</h1>\n${paras}\n</main>\n</body>`));
}

test('the assembled intro passes every measure under a strict CSP that allows the engine style by hash', { skip: !RUN && 'set INTRO_E2E=1 (needs Playwright)', timeout: 600_000 }, async (t) => {
  const server = await servedIntro(t, DARK);
  const report = await verifyIntro(server.url, { viewports: [
    { width: 1280, height: 800 }, { width: 390, height: 844, touch: true }, { width: 375, height: 667, touch: true },
    { width: 844, height: 390, touch: true }, { width: 1280, height: 800, reduce: true }] });
  fs.writeFileSync(path.join(os.tmpdir(), 'intro-e2e-report.json'), JSON.stringify(report, null, 2));
  for (const v of report.viewports) {
    assert.deepEqual(v.consoleErrors, [], `${v.viewport}: console`);
    for (const s of v.scenes) assert.deepEqual(s.failures, [], `${v.viewport} scene ${s.scene}`);
    assert.deepEqual(v.inputFailures, [], `${v.viewport}: input`);
    assert.equal(v.scenes.at(-1).contrast.filter((c) => c.el === 'cta').length, 2, `${v.viewport}: both CTA labels are measured`);
    assert.deepEqual(v.buttons.map((b) => b.sel), ['.sw-topcta'], `${v.viewport}: the top-bar CTA is measured`);
    const clips = v.scenes.slice(1).map((s) => s.clip);
    assert.ok(clips.every((c) => c === (/reduced/.test(v.viewport) ? 'off' : 'shown')), `${v.viewport}: clips ${clips}`);
  }
  assert.equal(report.failures, 0);
});

test('a light theme reads too: the CTA buttons on the glass panel and the top-bar CTA', { skip: !RUN && 'set INTRO_E2E=1 (needs Playwright)', timeout: 300_000 }, async (t) => {
  const server = await servedIntro(t, LIGHT);
  const report = await verifyIntro(server.url, { viewports: [{ width: 1280, height: 800 }, { width: 844, height: 390, touch: true }], input: false });
  for (const v of report.viewports) {
    assert.deepEqual(v.consoleErrors, [], `${v.viewport}: console`);
    for (const s of v.scenes) assert.deepEqual(s.failures, [], `${v.viewport} scene ${s.scene}`);
    assert.equal(v.scenes.at(-1).contrast.filter((c) => c.el === 'cta').length, 2, `${v.viewport}: both CTA labels are measured`);
    assert.deepEqual([v.buttons.length, v.buttonFailures], [1, []], `${v.viewport}: the top-bar CTA`);
  }
  assert.equal(report.failures, 0);
});

test('without the hash the CSP refuses only the engine style, and the page still works from scrub-engine.css', { skip: !RUN && 'set INTRO_E2E=1 (needs Playwright)', timeout: 300_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intro-e2e-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await makeMedia(dir);
  fs.writeFileSync(path.join(dir, 'intro.json'), JSON.stringify(manifest()));
  const built = assemble({ projectDir: dir });
  addBody(built.outDir);
  const server = await startServe(built.outDir, { csp: 'strict' });
  t.after(() => server.close());
  const report = await verifyIntro(server.url, { viewports: [{ width: 1280, height: 800 }], input: false });
  const v = report.viewports[0];
  assert.ok(v.consoleErrors.length >= 1 && v.consoleErrors.every((e) => /inline style/i.test(e)), JSON.stringify(v.consoleErrors));
  for (const s of v.scenes) assert.deepEqual(s.failures, [], `scene ${s.scene}`);
});

// ---- dive mode: a synthetic dive site (no generation cost) and the seam probe ----

const DIVE_BG = ['0x1E3A5F', '0x5A189A', '0x132A13'];

function ffRun(ffmpeg, args) {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-y', ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr.slice(-400));
  return args.at(-1);
}

// The fake clip maker: the seed frame pushed in over 2 s at 12 fps (what a dive or an exit starts from).
const fakeClips = (ffmpeg, dir) => {
  let n = 0;
  return async (o) => {
    const seed = path.join(dir, `seed-in-${++n}.png`);
    fs.writeFileSync(seed, o.firstFramePng);
    const m = '(1-1/(1+0.08*in/12))/2';
    const vf = `perspective=x0='W*${m}':y0='H*${m}':x1='W*(1-${m})':y1='H*${m}':x2='W*${m}':y2='H*(1-${m})':x3='W*(1-${m})':y3='H*(1-${m})':eval=frame,format=yuv420p`;
    const out = ffRun(ffmpeg, ['-loop', '1', '-t', '2', '-framerate', '12', '-i', seed, '-vf', vf, '-c:v', 'libx264', '-g', '8', path.join(dir, `fake-${n}.mp4`)]);
    return { mp4: fs.readFileSync(out), provider: 'sora', label: 'AZURE_SORA', seconds: o.seconds };
  };
};

// Three scenes, each a dark island on its own one-colour background, made into a dive site with exits.
async function diveProject(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intro-dive-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ffmpeg = await resolveFfmpeg();
  const size = `${SIZE.width}x${SIZE.height}`;
  DIVE_BG.forEach((bg, i) => ffRun(ffmpeg, ['-f', 'lavfi', '-i', `color=c=${bg}:s=${size},drawbox=x=380:y=110:w=160:h=140:color=0x2B2B2B:t=fill`, '-frames:v', '1', path.join(dir, `s${i + 1}.png`)]));
  const manifest = { ...manifest0(), sections: manifest0().sections.map((s) => ({ ...s, clip: undefined })), connectors: undefined, diveScroll: 1.2, connScroll: 0.9 };
  await runDiveLegs({ projectDir: dir, manifest, size, promptFor: (leg) => leg.kind, generate: fakeClips(ffmpeg, dir), ffmpeg });
  return { dir, ffmpeg };
}

// The e2e manifest without step navigation, the glass panel or the CTA: the seams are the subject here.
const manifest0 = () => {
  const m = manifest();
  delete m.stepNav;
  delete m.panel;
  return m;
};

async function serveDive(t, dir, outName = 'site', drop = null) {
  const mPath = path.join(dir, 'intro.json');
  const m = JSON.parse(fs.readFileSync(mPath, 'utf8'));
  if (drop) delete m[drop];
  const alt = path.join(dir, `${outName}.json`);
  fs.writeFileSync(alt, JSON.stringify(m));
  const built = assemble({ projectDir: dir, outDir: path.join(dir, outName), manifestPath: alt });
  const server = await startServe(built.outDir, { csp: STRICT_CSP.replace("style-src 'self'", `style-src 'self' ${built.styleHash}`) });
  t.after(() => server.close());
  return { server, built };
}

async function probe(url, opts) {
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch();
  try { return await seamProbe(browser, url, { viewport: { width: 1280, height: 720 }, ...opts }); } finally { await browser.close(); }
}

test('a dive site passes the measures under a strict CSP, and its plate seams read as seams, not as blank screens', { skip: !RUN && 'set INTRO_E2E=1 (needs Playwright)', timeout: 600_000 }, async (t) => {
  const { dir } = await diveProject(t);
  const { server } = await serveDive(t, dir);
  const report = await verifyIntro(server.url, { viewports: [{ width: 1280, height: 720 }], input: false, contrast: false, seams: true });
  fs.writeFileSync(path.join(os.tmpdir(), 'intro-e2e-dive-report.json'), JSON.stringify(report, null, 2));
  const v = report.viewports[0];
  assert.deepEqual(v.consoleErrors, []);
  for (const s of v.scenes) assert.deepEqual(s.failures, [], `scene ${s.scene}`);
  assert.deepEqual(report.seams.boundaries.map((b) => `${b.from} -> ${b.to}`), ['dive 1 -> conn 1', 'conn 1 -> dive 2', 'dive 2 -> conn 2', 'conn 2 -> dive 3']);
  assert.ok(report.seams.boundaries.every((b) => typeof b.maxDiff === 'number' && b.blank.length === 0), JSON.stringify(report.seams.boundaries));
  assert.deepEqual(report.seams.failures, []);
  assert.equal(report.failures, 0);
});

test('the seam probe catches a clip that goes black for its last seconds', { skip: !RUN && 'set INTRO_E2E=1 (needs Playwright)', timeout: 600_000 }, async (t) => {
  const { dir, ffmpeg } = await diveProject(t);
  const { server, built } = await serveDive(t, dir);
  const clip = path.join(built.outDir, 'assets', 'vid', 's1.mp4');
  ffRun(ffmpeg, ['-loop', '1', '-t', '4', '-framerate', '12', '-i', path.join(dir, 's1.png'), '-vf', "drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill:enable='gte(t,1)',format=yuv420p", '-c:v', 'libx264', '-g', '8', clip]);
  const r = await probe(server.url, {});
  const first = r.boundaries[0];
  assert.ok(first.blank.length >= 1, JSON.stringify(first));
  assert.ok(r.failures.some((f) => /dive 1 -> conn 1: a near one-colour screen/.test(f)), r.failures.join('\n'));
});

test('on a slow network the exit shows its own first frame as its poster; without connectorStills the next scene flickers in', { skip: !RUN && 'set INTRO_E2E=1 (needs Playwright)', timeout: 900_000 }, async (t) => {
  const { dir } = await diveProject(t);
  const own = await serveDive(t, dir);
  const upstream = await serveDive(t, dir, 'site-upstream', 'connectorStills');
  assert.match(fs.readFileSync(path.join(own.built.outDir, 'intro.js'), 'utf8'), /"connectorStills"/);
  assert.doesNotMatch(fs.readFileSync(path.join(upstream.built.outDir, 'intro.js'), 'utf8'), /"connectorStills"/);
  const good = await probe(own.server.url, { slowClipsMs: 4000 });
  assert.deepEqual(good.failures.filter((f) => /poster/.test(f)), [], JSON.stringify(good.boundaries.map((b) => [b.to, b.posterDiff])));
  assert.ok(good.boundaries.some((b) => b.posterDiff !== null), 'a poster was on screen on arrival, so the comparison ran');
  const bad = await probe(upstream.server.url, { slowClipsMs: 4000 });
  assert.ok(bad.failures.some((f) => /dive 1 -> conn 1: the poster differs from the clip/.test(f)), JSON.stringify(bad.boundaries.map((b) => [b.to, b.posterDiff])));
});

test('step navigation: off the stops the page settles on the nearest scene start, not while a pointer holds it; a retarget ends once and never runs back', { skip: !RUN && 'set INTRO_E2E=1 (needs Playwright)', timeout: 300_000 }, async (t) => {
  const server = await servedIntro(t, DARK);
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await page.goto(server.url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.IntroStepNav && window.IntroStepNav.current);
  const nav = () => page.evaluate(() => ({ y: Math.round(window.scrollY), stops: window.IntroStepNav.current.stops(), ...window.IntroStepNav.current.state() }));
  const rest = async () => { await page.waitForTimeout(700); await page.waitForFunction(() => !window.IntroStepNav.current.state().moving, null, { timeout: 20_000 }); await page.waitForTimeout(200); };
  const near = async (want, what) => { const { y } = await nav(); assert.ok(Math.abs(y - want) <= 2, `${what}: at ${y}, want ${want}`); };
  const { stops } = await nav();
  const gap = stops[2] - stops[1];
  // settle: 0.7 of the way from scene 2's start to scene 3's (not a half point) comes to scene 3's start
  await page.evaluate((y) => window.scrollTo(0, y), Math.round(stops[1] + 0.7 * gap));
  await rest();
  await near(stops[2], 'settles on the nearest scene start');
  // held: nothing settles while the pointer is down; after it lets go, the page settles
  const held = Math.round(stops[1] + 0.3 * gap);
  await page.mouse.move(640, 400);
  await page.mouse.down();
  await page.evaluate((y) => window.scrollTo(0, y), held);
  await page.waitForTimeout(1200);
  await near(held, 'stays while held');
  await page.mouse.up();
  await rest();
  await near(stops[1], 'settles once let go');
  // retarget: two arrows from scene 1's start end at scene 2's start, in one arrival, never running back
  await page.keyboard.press('Home');
  await rest();
  await page.evaluate(() => { window.__ys = []; (function f() { window.__ys.push(window.scrollY); requestAnimationFrame(f); })(); });
  const before = (await nav()).arrivals;
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(250);
  await page.keyboard.press('ArrowDown');
  await rest();
  await near(stops[1], 'two half steps make the scene');
  assert.equal((await nav()).arrivals, before + 1, 'the move ends once');
  const ys = await page.evaluate(() => window.__ys);
  assert.ok(ys.every((y, i) => i === 0 || y >= ys[i - 1] - 1), 'the page never runs back while retargeting');
});
