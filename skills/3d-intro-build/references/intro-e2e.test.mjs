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
import { configFromIntroJs, decodePng, loadPlaywright, meanAbsDiff, seamProbe, verifyIntro } from './verify-intro.mjs';
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
  await runDiveLegs({ projectDir: dir, manifest, size, promptFor: (leg) => leg.kind, exit: true, generate: fakeClips(ffmpeg, dir), ffmpeg });   // the exits (choice c) are what these tests look at
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

// One instant jump, watched: every rAF scroll position and every composited frame from the input on.
async function instantJump({ page, cdp, release }, name, act, want, loading) {
  const from = await page.evaluate(() => window.scrollY);
  await page.evaluate(() => { window.__ys = []; window.__ld = []; (function f() { window.__ys.push(window.scrollY); window.__ld.push(document.querySelector('.isn-loading').classList.contains('is-on')); requestAnimationFrame(f); })(); });
  const frames = [];
  const onFrame = (f) => { frames.push({ t: Date.now(), buf: Buffer.from(f.data, 'base64') }); cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {}); };
  cdp.on('Page.screencastFrame', onFrame);
  await cdp.send('Page.startScreencast', { format: 'png', maxWidth: 640, maxHeight: 400 });
  const tAct = Date.now();
  release(tAct);
  await act();
  await page.waitForTimeout(2200);
  await cdp.send('Page.stopScreencast');
  cdp.off('Page.screencastFrame', onFrame);
  const [ys, ld] = await page.evaluate(() => [window.__ys, window.__ld]);
  // a wait for a late poster shows the loading mark and hides it as the page moves; a quick one never shows it
  assert.equal(ld.some(Boolean), loading, `${name}: the loading mark ${loading ? 'shows' : 'stays hidden'}`);
  assert.equal(ld.at(-1), false, `${name}: no loading mark once arrived`);
  if (loading) assert.ok(ys.slice(0, ld.indexOf(true) + 1).every((y) => Math.abs(y - want) > 2) && Math.abs(ys[ld.lastIndexOf(true) + 1] - want) <= 2, `${name}: the mark shows while waiting and goes as the page moves`);
  assert.ok(Math.abs(ys.at(-1) - want) <= 2, `${name}: at ${ys.at(-1)}, want ${want}`);
  assert.ok(ys.every((y) => Math.abs(y - from) <= 2 || Math.abs(y - want) <= 2), `${name}: no place in between (${[...new Set(ys.map(Math.round))].join(', ')})`);
  // every frame is the screen before or the scene arrived at: an empty or half-drawn scene is neither
  const px = frames.map((f) => decodePng(f.buf).data);
  const strayAt = frames.filter((f, k) => Math.min(meanAbsDiff(px[k], px[0]), meanAbsDiff(px[k], px.at(-1))) > 12).map((f) => f.t - tAct);
  assert.ok(frames.length > 1 && !strayAt.length, `${name}: no blank frame in ${frames.length} (a frame neither before nor after at ms after the input: ${strayAt.join(',')})`);
  const copy = await page.evaluate(() => [...document.querySelectorAll('.sw-copy')].map((c) => Number(getComputedStyle(c).opacity)));
  assert.ok(Math.max(...copy) > 0.99, `${name}: the copy shows (${copy})`);
}

test('Home, End and a route dot jump at once, after their late posters have decoded: no place in between, the right stop, no blank frame, the copy shown at once', { skip: !RUN && 'set INTRO_E2E=1 (needs Playwright)', timeout: 300_000 }, async (t) => {
  const server = await servedIntro(t, DARK);
  const config = configFromIntroJs(await (await fetch(new URL('intro.js', server.url))).text());
  const first = config.sections[0].still;
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  // every poster but the first is held until 900 ms after the input: longer than a move's 300 ms wait, shorter
  // than an instant move's 1500 ms. A jump that does not wait for the target poster to decode paints that scene empty.
  let releaseAt = Infinity;
  await context.route(/\/assets\/[^/]+\.(png|jpe?g|webp)(\?|$)/, async (route) => {
    if (!route.request().url().endsWith(`/${first}`)) while (Date.now() < releaseAt) await new Promise((r) => setTimeout(r, 20));
    await route.continue();
  });
  // the clips come later still, so the scene a jump lands on shows its poster, not its clip
  await context.route(/\.mp4(\?|$)/, async (route) => { await new Promise((r) => setTimeout(r, 4000)); await route.continue(); });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const open = async () => {
    releaseAt = Infinity;
    await page.goto(server.url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.IntroStepNav && window.IntroStepNav.current);
    // the copy, bars and dots hidden (visibility only: their opacity is still read) so an empty scene reads as one
    await page.evaluate(() => { for (const e of document.querySelectorAll('.sw-copylayer, .sw-topbar, .sw-hint, .sw-route, .sw-scrollbar, .isn-hint, .isn-skip, .isn-main')) e.style.visibility = 'hidden'; });
    // start from a painted first scene (only its poster): a page still decoding it is loading, not jumping
    await page.evaluate(() => document.querySelector('.sw-scene__still').decode().catch(() => {}).then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))));
    return page.evaluate(() => ({ stops: window.IntroStepNav.current.stops(), lastStop: window.IntroStepNav.current.lastStop }));
  };
  const jump = (name, act, want, loading) => instantJump({ page, cdp, release: (t) => { releaseAt = Math.min(releaseAt, t + 900); } }, name, act, want, loading);
  let { stops, lastStop } = await open();
  await jump('End (late poster)', () => page.keyboard.press('End'), stops[lastStop], true);
  await jump('Home', () => page.keyboard.press('Home'), 0, false);
  ({ stops, lastStop } = await open());
  await jump('dot 2 (late poster)', () => page.evaluate(() => document.querySelector('.sw-route__dot:nth-child(2)').click()), stops[1], true);
});

test('a press ended without a pointerup (context menu, focus lost) lets the page settle; Home or End during a move swaps the copy at once', { skip: !RUN && 'set INTRO_E2E=1 (needs Playwright)', timeout: 300_000 }, async (t) => {
  const server = await servedIntro(t, DARK);
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await page.goto(server.url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.IntroStepNav && window.IntroStepNav.current);
  const y = () => page.evaluate(() => Math.round(window.scrollY));
  const stops = await page.evaluate(() => window.IntroStepNav.current.stops());
  for (const ending of ['contextmenu', 'blur']) {
    const off = Math.round(stops[1] + 0.3 * (stops[2] - stops[1]));
    await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
    await page.evaluate((v) => window.scrollTo(0, v), off);
    await page.evaluate((k) => window.dispatchEvent(new Event(k)), ending);
    await page.waitForTimeout(1200);
    await page.waitForFunction(() => !window.IntroStepNav.current.state().moving, null, { timeout: 20_000 });
    assert.ok(Math.abs((await y()) - stops[1]) <= 2, `after a ${ending} the page settles on the nearest stop (at ${await y()})`);
  }
  // End while a PageDown move runs: the copy at the end shows at once (isn-instant), not through the 0.35 s fade
  await page.keyboard.press('Home');
  await page.waitForTimeout(1500);
  // watched with a MutationObserver, not frame by frame: a page standing still may run no animation frame for a while
  await page.evaluate(() => { window.__inst = []; new MutationObserver(() => window.__inst.push(document.documentElement.classList.contains('isn-instant'))).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] }); });
  await page.keyboard.press('PageDown');
  await page.waitForTimeout(400);
  assert.equal(await page.evaluate(() => window.IntroStepNav.current.state().moving), true, 'End comes while the PageDown move runs');
  await page.keyboard.press('End');
  await page.waitForFunction(() => !window.IntroStepNav.current.state().moving, null, { timeout: 20_000 });
  assert.ok((await page.evaluate(() => window.__inst)).some(Boolean), 'the instant move swaps the copy at once');
});

test('the seam probe gives up on a poster that does not arrive in time: that seam is unmeasured with the reason, and the probe ends', { skip: !RUN && 'set INTRO_E2E=1 (needs Playwright)', timeout: 300_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intro-e2e-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await makeMedia(dir);
  fs.writeFileSync(path.join(dir, 'intro.json'), JSON.stringify(manifest()));
  const built = assemble({ projectDir: dir });
  const http = await import('node:http');
  const held = [];
  // a server that holds scene 2's poster (the first connector's poster too) for 8 s: the probe arrives at the
  // first seam long before. (Held for ever, the page's load would never come and a screenshot waits for it.)
  const srv = http.createServer((q, s) => {
    const f = path.join(built.outDir, decodeURIComponent(q.url.split('?')[0]) === '/' ? 'index.html' : decodeURIComponent(q.url.split('?')[0]).slice(1));
    if (/\/assets\/s2\.png$/.test(q.url) && !held.length) { held.push(s); setTimeout(() => { s.writeHead(200, { 'content-type': 'image/png' }); s.end(fs.readFileSync(f)); }, 8000); return; }
    if (!fs.existsSync(f)) { s.writeHead(404); s.end(); return; }
    s.writeHead(200, { 'content-type': { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.mp4': 'video/mp4' }[path.extname(f)] || 'application/octet-stream' });
    s.end(fs.readFileSync(f));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const r = await seamProbe(browser, `http://127.0.0.1:${srv.address().port}/`, { viewport: { width: 1280, height: 800 }, posterDecodeMs: 1000, loadMs: 3000, slowClipsMs: 1500, settleMs: 3000, steps: 4 });
  const unmeasured = r.boundaries.filter((b) => b.posterDiff === null && /did not decode within 1000 ms/.test(b.posterWhy || ''));
  assert.ok(unmeasured.length >= 1, JSON.stringify(r.boundaries.map((b) => [b.to, b.posterDiff, b.posterWhy])));
  assert.equal(r.posterUnmeasured >= unmeasured.length, true, 'counted as unmeasured, not as a pass');
});

test('a font that never answers: each capture gives up after captureMs, the scenes and seams it could not capture are not measured (with the reason), and the rest of the report stays', { skip: !RUN && 'set INTRO_E2E=1 (needs Playwright)', timeout: 300_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intro-e2e-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await makeMedia(dir);
  fs.writeFileSync(path.join(dir, 'intro.json'), JSON.stringify(manifest()));
  const built = assemble({ projectDir: dir });
  const http = await import('node:http');
  const held = [];
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.mp4': 'video/mp4' };
  const srv = http.createServer((q, s) => {
    const u = decodeURIComponent(q.url.split('?')[0]);
    if (u === '/hang.woff2') { held.push(s); return; }   // never answered
    if (u === '/hang.css') { s.writeHead(200, { 'content-type': 'text/css' }); s.end('@font-face{font-family:Hang;src:url(/hang.woff2)}body,.sw-copy{font-family:Hang,sans-serif}'); return; }
    const f = path.join(built.outDir, u === '/' ? 'index.html' : u.slice(1));
    if (!fs.existsSync(f)) { s.writeHead(404); s.end(); return; }
    let body = fs.readFileSync(f);
    if (f.endsWith('index.html')) body = Buffer.from(String(body).replace('</head>', '<link rel="stylesheet" href="hang.css" /></head>'));
    s.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' });
    s.end(body);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => { for (const s of held) s.destroy(); srv.close(); });
  const report = await verifyIntro(`http://127.0.0.1:${srv.address().port}/`, { viewports: [{ width: 1280, height: 800 }], input: false, seams: true, captureMs: 1500, loadMs: 2000, fetchMs: 3000 });
  const v = report.viewports[0];
  assert.equal(v.scenes.length, 3, 'every scene is still reported (place, overlaps)');
  assert.ok(v.scenes.every((sc) => typeof sc.inViewport === 'boolean'), 'the geometry stays');
  assert.ok(v.scenes.some((sc) => sc.failures.some((f) => /not measured \(screen capture timed out after 1500 ms\)/.test(f))), JSON.stringify(v.scenes.map((sc) => sc.failures)));
  assert.ok(report.seams.boundaries.length >= 1 && report.seams.boundaries.every((b) => b.posterDiff === null), 'the seams it could not capture are unmeasured');
  assert.ok(report.seams.failures.some((f) => /not measured \(screen capture timed out after 1500 ms\)/.test(f)), JSON.stringify(report.seams.failures));
  assert.ok(report.failures > 0, 'not measured is never a pass');
});

test('a poster that never answers keeps the page loading: verify-intro does not pass a page measured before its load', { skip: !RUN && 'set INTRO_E2E=1 (needs Playwright)', timeout: 300_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intro-e2e-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await makeMedia(dir);
  fs.writeFileSync(path.join(dir, 'intro.json'), JSON.stringify(manifest()));
  const built = assemble({ projectDir: dir });
  const http = await import('node:http');
  const held = [];
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.mp4': 'video/mp4' };
  const srv = http.createServer((q, s) => {
    const u = decodeURIComponent(q.url.split('?')[0]);
    if (u === '/assets/s3.png') { held.push(s); return; }   // never answered
    const f = path.join(built.outDir, u === '/' ? 'index.html' : u.slice(1));
    if (!fs.existsSync(f)) { s.writeHead(404); s.end(); return; }
    s.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' });
    s.end(fs.readFileSync(f));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => { for (const s of held) s.destroy(); srv.close(); });
  // the measures that need no capture: only the load can tell this page is not ready
  const report = await verifyIntro(`http://127.0.0.1:${srv.address().port}/`, { viewports: [{ width: 1280, height: 800 }], input: false, contrast: false, loadMs: 2000 });
  assert.deepEqual(report.viewports[0].loadFailures, ['page load did not finish within 2000 ms (measured while still loading)']);
  assert.ok(report.failures > 0, 'not a pass');
});
