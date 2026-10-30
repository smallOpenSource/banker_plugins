// Tests for assemble.mjs, which turns intro.json and the generated media into the intro page.
// Run from the repo root: node --test skills/3d-intro-build/references/assemble.test.mjs
import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assemble, engineCss, firstPosters, panelAlpha } from './assemble.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const made = [];
process.on('exit', () => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

function project(manifest = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assemble-'));
  made.push(dir);
  for (const f of ['s1.png', 's2.png', 'hold-1.mp4', 'hold-2.mp4', 'flight-1.mp4']) fs.writeFileSync(path.join(dir, f), f);
  const base = {
    brand: { name: 'Acme' }, theme: { bg: '#0B1220', ink: '#F1F5F9', accent: '#38BDF8' },
    sections: [
      { id: 'a', label: 'A', still: 's1.png', clip: 'hold-1.mp4', title: 'One', body: 'Line 1\nLine 2' },
      { id: 'b', label: 'B', still: 's2.png', clip: 'hold-2.mp4', title: 'Two', cta: { primary: { label: 'Go', href: '#' } } },
    ],
    connectors: ['flight-1.mp4'],
  };
  fs.writeFileSync(path.join(dir, 'intro.json'), JSON.stringify({ ...base, ...manifest }));
  return dir;
}

const read = (dir, f) => fs.readFileSync(path.join(dir, 'site', f), 'utf8');

test('the page carries no inline script or style, so a strict CSP runs it', () => {
  const dir = project();
  assemble({ projectDir: dir });
  const html = read(dir, 'index.html');
  assert.doesNotMatch(html, /<style/i);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, 'every script has a src');
  assert.doesNotMatch(html, /\son[a-z]+=/i, 'no inline event handlers');
  for (const f of ['scrub-engine.css', 'theme.css', 'intro-fixes.css']) assert.match(html, new RegExp(`<link rel="stylesheet" href="${f}"`));
  assert.match(html, /<script src="scrub-engine\.js"><\/script>\s*<script src="step-nav\.js"><\/script>\s*<script src="intro\.js"><\/script>/);
  const intro = read(dir, 'intro.js');
  assert.match(intro, /var world = document\.getElementById\('world'\);[\s\S]*mountScrollWorld\(world, config\);/);
  assert.match(intro, /"connectors": \[\s*"assets\/vid\/conn1\.mp4"\s*\]/);
  assert.match(read(dir, 'theme.css'), /--sw-bg:\s*#0B1220;/);
});

test('the engine CSS file carries what the engine injects, and the CSP hash is of that injection', () => {
  const dir = project();
  const r = assemble({ projectDir: dir });
  const injected = engineCss(fs.readFileSync(path.join(HERE, 'scrub-engine.js'), 'utf8'));
  const css = read(dir, 'scrub-engine.css');
  assert.ok(injected.startsWith('@layer sw {\n') && injected.endsWith('\n}') && injected.includes('.sw-copy{'));
  assert.ok(css.endsWith(injected), 'the rules are the injected text, unchanged');
  assert.match(css, /^\/\* scroll-world[^]*MIT[^]*scrub-engine\.LICENSE\.md[^]*\*\/\n/, 'a notice heads the copied rules');
  assert.equal(r.styleHash, `'sha256-${crypto.createHash('sha256').update(injected).digest('base64')}'`);
  assert.equal(read(dir, 'scrub-engine.LICENSE.md'), fs.readFileSync(path.join(HERE, 'LICENSE'), 'utf8'), 'the MIT notice ships with the engine');
});

test('an engine checked out with CRLF line ends gives the same injected text and hash', () => {
  const source = fs.readFileSync(path.join(HERE, 'scrub-engine.js'), 'utf8');
  assert.equal(engineCss(source.replace(/\n/g, '\r\n')), engineCss(source), 'a template literal turns CRLF into LF');
});

test('the engine and the template stay as shipped', () => {
  const dir = project();
  const before = fs.readFileSync(path.join(HERE, 'index-template.html'));
  assemble({ projectDir: dir });
  assert.ok(fs.readFileSync(path.join(dir, 'site', 'scrub-engine.js')).equals(fs.readFileSync(path.join(HERE, 'scrub-engine.js'))));
  assert.ok(fs.readFileSync(path.join(HERE, 'index-template.html')).equals(before));
});

test('the engine fixes always ship; the glass panel only when asked; scene steps by default, off with stepNav false', () => {
  const plain = project({ stepNav: false });
  assemble({ projectDir: plain });
  assert.match(read(plain, 'intro-fixes.css'), /translate:\s*0 -50%/);
  assert.match(read(plain, 'intro-fixes.css'), /overflow-x:\s*clip/);
  assert.match(read(plain, 'intro-fixes.css'), /max-width: 860px\)\s*\{\s*\.sw-copy \{[^}]*bottom: calc\(96px \+ 2vh/, 'clear of the hint on a phone');
  assert.match(read(plain, 'intro-fixes.css'), /\(max-height: 500px\) and \(orientation: landscape\)[\s\S]*grid-template-areas/, 'two columns on a short landscape screen');
  assert.match(read(plain, 'intro-fixes.css'), /\.sw-btn--primary, \.sw-topcta \{ color: var\(--sw-bg\); \}/, 'button text readable in a dark theme');
  assert.ok(!fs.existsSync(path.join(plain, 'site', 'panel-glass.css')));
  assert.ok(!fs.existsSync(path.join(plain, 'site', 'step-nav.js')));
  assert.doesNotMatch(read(plain, 'intro.js'), /IntroStepNav/);
  const byDefault = project();
  assemble({ projectDir: byDefault });
  assert.ok(fs.existsSync(path.join(byDefault, 'site', 'step-nav.js')), 'on without a stepNav entry');
  assert.match(read(byDefault, 'intro.js'), /var nav = \{\};[\s\S]*IntroStepNav\.attach\(world, config, nav\)/);
  assert.match(read(byDefault, 'step-nav.css'), /\.isn-on \.sw-copy\.isn-copy \{ opacity: 1 !important;/);
  assert.match(read(byDefault, 'step-nav.css'), /prefers-reduced-motion: reduce\)\s*\{\s*\.isn-on \.sw-copy \{ transition: none; \}/);

  const full = project({ panel: 'glass', stepNav: { end: '#main' }, lang: 'ko' });
  assemble({ projectDir: full });
  const html = read(full, 'index.html');
  assert.match(html, /<html lang="ko">/);
  assert.match(html, /href="panel-glass\.css"[\s\S]*href="step-nav\.css"/);
  assert.match(read(full, 'panel-glass.css'), /\.sw-copy \.sw-btn--ghost \{ color: var\(--intro-title\)/, 'a ghost button reads on the glass');
  assert.match(read(full, 'panel-glass.css'), /@media \(max-width: 860px\), \(max-height: 500px\) and \(orientation: landscape\)/);
  assert.match(html, /<script src="scrub-engine\.js"><\/script>\s*<script src="step-nav\.js"><\/script>\s*<script src="intro\.js"><\/script>/);
  const intro = read(full, 'intro.js');
  assert.match(intro, /IntroStepNav\.prefetch\(config, nav\)/);
  assert.match(intro, /IntroStepNav\.attach\(world, config, nav\)/);
  assert.match(intro, /"end": "#main"/);
  assert.ok(fs.existsSync(path.join(full, 'site', 'step-nav.css')));
});

test('an unknown panel style or a missing asset stops the build with the reason', () => {
  assert.throws(() => assemble({ projectDir: project({ panel: 'neon' }) }), /panel/);
  const dir = project();
  fs.rmSync(path.join(dir, 'hold-2.mp4'));
  assert.throws(() => assemble({ projectDir: dir }), /asset not found: hold-2\.mp4/);
});

test('the first posters are preloaded (the engine loads posters lazily), and every poster drops the engine\'s zoom', () => {
  const dir = project();
  assemble({ projectDir: dir });
  const html = read(dir, 'index.html');
  assert.match(html, /<link rel="preload" as="image" href="assets\/a\.png" \/>\s*<link rel="preload" as="image" href="assets\/b\.png" \/>/);
  assert.equal((html.match(/rel="preload"/g) || []).length, 2, 'two sections: two posters');
  assert.deepEqual(firstPosters({ sections: [{ still: 'a' }, { still: 'b' }, { still: 'c' }], connectors: ['x', null], connectorStills: ['cs1', null] }), ['a', 'cs1', 'b']);
  assert.deepEqual(firstPosters({ sections: [{ still: 'a' }, { still: 'b' }], connectors: [null], connectorStills: ['cs1'] }), ['a', 'b'], 'a connector poster counts only with its connector');
  assert.match(read(dir, 'intro-fixes.css'), /\.sw-scene__still \{ transform: none !important; \}/);
  assert.match(read(dir, 'intro-fixes.css'), /\.sw-scene\.has-clip \.sw-scene__still \{ transition: opacity 0s linear \.15s; \}/, 'the poster is hidden 0.15 s after the clip shows');
});

test('glass panel alpha: the lowest that keeps 4.5 over a white pixel for every panel text and accent label; a person\'s panelAlpha wins', () => {
  assert.equal(panelAlpha([]), 0.64);
  assert.ok(panelAlpha(['#C68B59']) >= panelAlpha([]), 'an accent label counts');
  const alphaIn = (dir) => Number(/--intro-panel-alpha:\s*([\d.]+);/.exec(read(dir, 'panel-glass.css'))[1]);
  const auto = project({ panel: 'glass', theme: { bg: '#F3E9DC', ink: '#3B2A20', accent: '#C68B59' } });
  const r = assemble({ projectDir: auto });
  assert.deepEqual(r.panelAlpha, { alpha: panelAlpha(['#C68B59', undefined, undefined]), from: 'computed' });
  assert.equal(alphaIn(auto), r.panelAlpha.alpha);
  const mine = project({ panel: 'glass', panelAlpha: 0.5 });
  assert.deepEqual(assemble({ projectDir: mine }).panelAlpha, { alpha: 0.5, from: 'manifest' });
  assert.equal(alphaIn(mine), 0.5);
  assert.equal(assemble({ projectDir: project() }).panelAlpha, undefined, 'no glass panel: nothing to set');
});

test('an asset outside the project folder (../ or a link out) is refused with a named error, connector posters included', () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'assemble-outside-'));
  made.push(outside);
  fs.writeFileSync(path.join(outside, 'secret.png'), 'not for the page');
  const up = project({ connectorStills: [`../${path.basename(outside)}/secret.png`] });
  assert.throws(() => assemble({ projectDir: up }), (e) => e.code === 'EOUTSIDE' && /outside the project folder/.test(e.message));
  const linked = project();
  fs.rmSync(path.join(linked, 's1.png'));
  fs.symlinkSync(path.join(outside, 'secret.png'), path.join(linked, 's1.png'));
  assert.throws(() => assemble({ projectDir: linked }), (e) => e.code === 'EOUTSIDE');
  assert.ok(!fs.existsSync(path.join(linked, 'site', 'assets', 'a.png')), 'nothing copied from outside');
});

test('a section id that would leave assets/ (../, a separator, a dot name) is refused before anything is written', () => {
  for (const id of ['../../pwned', 'a/b', 'a\\b', '..', '.hidden', 'x'.repeat(65)]) {
    const dir = project({ sections: [{ id, still: 's1.png', clip: 'hold-1.mp4' }, { id: 'b', still: 's2.png', clip: 'hold-2.mp4' }] });
    assert.throws(() => assemble({ projectDir: dir }), /id .* must be letters, digits, '-' or '_'/, id);
    assert.ok(!fs.existsSync(path.join(dir, 'pwned')) && !fs.existsSync(path.join(path.dirname(dir), 'pwned')), `${id}: nothing written outside`);
  }
  assert.doesNotThrow(() => assemble({ projectDir: project({ sections: [{ id: 'dive-s1_push-in', still: 's1.png', clip: 'hold-1.mp4' }, { id: 'B2', still: 's2.png', clip: 'hold-2.mp4' }] }) }));
});

test('intro.js decodes every poster at load and after scrolling stops (a jump would otherwise paint an empty scene), with and without step navigation', () => {
  for (const extra of [{}, { stepNav: {} }]) {
    const dir = project(extra);
    assemble({ projectDir: dir });
    const intro = read(dir, 'intro.js');
    assert.match(intro, /mountScrollWorld\(world, config\);[\s\S]*var warm = function \(\) \{ \[\]\.forEach\.call\(world\.querySelectorAll\('\.sw-scene__still'\)[\s\S]*i\.decode\(\)/);
    assert.match(intro, /warm\(\); window\.addEventListener\('load', warm\);/);
    assert.match(intro, /addEventListener\('scroll', [\s\S]*setTimeout\(warm, 400\)/);
  }
});
