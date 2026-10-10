// Tests for assemble.mjs, which turns intro.json and the generated media into the intro page.
// Run from the repo root: node --test skills/3d-intro-build/references/assemble.test.mjs
import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assemble, engineCss } from './assemble.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function project(manifest = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assemble-'));
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
  assert.match(html, /<script src="scrub-engine\.js"><\/script>\s*<script src="intro\.js"><\/script>/);
  const intro = read(dir, 'intro.js');
  assert.match(intro, /var world = document\.getElementById\('world'\);[\s\S]*mountScrollWorld\(world, config\);/);
  assert.match(intro, /"connectors": \[\s*"assets\/vid\/conn1\.mp4"\s*\]/);
  assert.match(read(dir, 'theme.css'), /--sw-bg:\s*#0B1220;/);
});

test('the engine CSS file is what the engine injects, and the CSP hash for that injection is reported', () => {
  const dir = project();
  const r = assemble({ projectDir: dir });
  const css = read(dir, 'scrub-engine.css');
  assert.equal(css, engineCss(fs.readFileSync(path.join(HERE, 'scrub-engine.js'), 'utf8')));
  assert.ok(css.startsWith('@layer sw {\n') && css.endsWith('\n}') && css.includes('.sw-copy{'));
  assert.equal(r.styleHash, `'sha256-${crypto.createHash('sha256').update(css).digest('base64')}'`);
});

test('the engine and the template stay as shipped', () => {
  const dir = project();
  const before = fs.readFileSync(path.join(HERE, 'index-template.html'));
  assemble({ projectDir: dir });
  assert.ok(fs.readFileSync(path.join(dir, 'site', 'scrub-engine.js')).equals(fs.readFileSync(path.join(HERE, 'scrub-engine.js'))));
  assert.ok(fs.readFileSync(path.join(HERE, 'index-template.html')).equals(before));
});

test('the engine fixes always ship; the glass panel and scene steps only when asked', () => {
  const plain = project();
  assemble({ projectDir: plain });
  assert.match(read(plain, 'intro-fixes.css'), /translate:\s*0 -50%/);
  assert.match(read(plain, 'intro-fixes.css'), /overflow-x:\s*clip/);
  assert.ok(!fs.existsSync(path.join(plain, 'site', 'panel-glass.css')));
  assert.ok(!fs.existsSync(path.join(plain, 'site', 'step-nav.js')));
  assert.doesNotMatch(read(plain, 'intro.js'), /IntroStepNav/);

  const full = project({ panel: 'glass', stepNav: { end: '#main', lastGuardMs: 250 }, lang: 'ko' });
  assemble({ projectDir: full });
  const html = read(full, 'index.html');
  assert.match(html, /<html lang="ko">/);
  assert.match(html, /href="panel-glass\.css"[\s\S]*href="step-nav\.css"/);
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
