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
import { loadPlaywright, verifyIntro } from './verify-intro.mjs';

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

function manifest() {
  const body = (i) => ['First point of the scene', 'Second point, short', 'Third point to close'].map((t) => `${t} ${i}`).join('\n');
  return {
    lang: 'en', brand: { name: 'Acme' }, panel: 'glass', stepNav: { end: '#main' },
    theme: { bg: '#0B1220', ink: '#F1F5F9', inkSoft: '#CBD5E1', accent: '#38BDF8' },
    diveScroll: 0.6, connScroll: 1.4,
    sections: SCENES.map((_, i) => ({ id: `s${i + 1}`, label: `Scene ${i + 1}`, still: `s${i + 1}.png`, clip: `hold-${i + 1}.mp4`,
      eyebrow: 'Label', title: `Title ${i + 1}`, body: body(i + 1), tags: ['One', 'Two'],
      ...(i === SCENES.length - 1 ? { cta: { primary: { label: 'Start', href: '#main' } } } : {}) })),
    connectors: ['flight-1.mp4', 'flight-2.mp4'],
  };
}

// The intro on top of a page body, as a site would place it.
function addBody(siteDir) {
  const index = path.join(siteDir, 'index.html');
  const paras = Array.from({ length: 40 }, (_, i) => `<p>Body paragraph ${i + 1}.</p>`).join('\n');
  fs.writeFileSync(index, fs.readFileSync(index, 'utf8').replace('<div id="world"></div>', `<div id="world"></div>\n<main id="main"><h1>Main content</h1>\n${paras}\n</main>`));
}

test('the assembled intro passes every measure under a strict CSP that allows the engine style by hash', { skip: !RUN && 'set INTRO_E2E=1 (needs Playwright)', timeout: 600_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intro-e2e-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await makeMedia(dir);
  fs.writeFileSync(path.join(dir, 'intro.json'), JSON.stringify(manifest()));
  const built = assemble({ projectDir: dir });
  addBody(built.outDir);
  const policy = STRICT_CSP.replace("style-src 'self'", `style-src 'self' ${built.styleHash}`);
  const server = await startServe(built.outDir, { csp: policy });
  t.after(() => server.close());
  const report = await verifyIntro(server.url, { viewports: [{ width: 1280, height: 800 }, { width: 390, height: 844, touch: true }, { width: 1280, height: 800, reduce: true }] });
  fs.writeFileSync(path.join(os.tmpdir(), 'intro-e2e-report.json'), JSON.stringify(report, null, 2));
  for (const v of report.viewports) {
    assert.deepEqual(v.consoleErrors, [], `${v.viewport}: console`);
    for (const s of v.scenes) assert.deepEqual(s.failures, [], `${v.viewport} scene ${s.scene}`);
    assert.deepEqual(v.inputFailures, [], `${v.viewport}: input`);
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
