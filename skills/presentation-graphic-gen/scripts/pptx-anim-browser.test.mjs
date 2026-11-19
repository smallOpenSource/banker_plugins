// pptx-anim-browser.test.mjs: what the editable deck's animation is read from, in a real headless browser: the rest
// layout of a section and the measured time series (they must be what the page shows at that time). Skips with
// the reason when no browser is found.
// Run: node --test scripts/pptx-anim-browser.test.mjs
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { SKILL } from './build.mjs';
import { findBrowser } from './cdp.mjs';
import { COLS, extractSection, measure, openDeck } from './pptx-anim-extract.mjs';

const BROWSER = findBrowser();
const SKIP = BROWSER ? false : 'no Chrome, Edge or Chromium found (set CHROME to the browser executable); extraction tests not run';
if (SKIP) process.stdout.write(`# SKIP pptx-anim browser tests: ${SKIP}\n`);
const STAMP = '261119+0900';

describe('editable deck: reading the page', { skip: SKIP }, () => {
  let TMP, present, deck;
  before(async () => {
    TMP = mkdtempSync(join(tmpdir(), 'pgg-anim-browser-test-'));
    mkdirSync(join(TMP, 'scenes'));
    writeFileSync(join(TMP, 'mini.md'), '# 작은 덱\n\n## 1. 하나\n\n### 1-1\n화면: 첫 장면 제목\n말: 하나.\n\n### 1-2\n화면: 둘째\n말: 둘.\n\n## 2. 둘\n\n### 2-1\n화면: 셋째\n말: 셋.\n');
    writeFileSync(join(TMP, 'scenes', '01.js'), `Deck.scene({ section: 1, css: '.s01 .t { position: absolute; left: 200px; top: 300px; } .s01 .lay { position: absolute; left: 0; top: 0; width: 1920px; height: 1080px; } .s01 .p { position: absolute; left: 200px; top: 520px; }',
      html: (d) => '<h1 class="t t-display" data-r="t">' + d.esc(d.lines('s1-1')[0]) + '</h1><div class="lay" data-r="lay"><p class="p t-h2" data-r="p">' + d.esc(d.lines('s1-2')[0]) + '</p><i class="ul" data-r="ul"></i></div>',
      steps: { 's1-1'(s) { s.fadeUp('t', { at: 0.1 }); }, 's1-2'(s) { s.tween('lay', { opacity: 0, x: 200 }, { opacity: 1, x: 0 }, { dur: 0.8 }); s.underline('ul', 'p', { at: 0.2 }); s.dim('t', { at: 0.3 }); } } });`);
    const r = spawnSync(process.execPath, [join(SKILL, 'scripts', 'build.mjs'), join(TMP, 'mini.md'), '--scenes', join(TMP, 'scenes'), '--dir', TMP, '--stamp', STAMP], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    present = join(TMP, `mini-present-${STAMP}.html`);
    deck = await openDeck(present, { browser: BROWSER });
  });
  after(() => { if (deck) deck.b.close(); if (TMP) rmSync(TMP, { recursive: true, force: true }); });

  test('rest layout: every item the section can show, at its untransformed place, with the element its motion follows; the page is left as it was', async () => {
    const S = await extractSection(deck, 0);
    assert.deepEqual(S.windows.map((w) => [w.id, w.k]), [['s1-1', 0], ['s1-2', 1]]);
    const by = Object.fromEntries(S.items.map((it) => [it.kind === 'text' ? it.runs.map((r) => r.t).join('') : it.what, it]));
    assert.ok(by['첫 장면 제목'] && by['둘째'] && by['i.ul[ul]'], Object.keys(by).join(' | '));
    // the underline is placed by s.underline under its text at rest (the layer's translate is not in the layout)
    const ul = by['i.ul[ul]'], p = by['둘째'];
    assert.ok(ul.x <= p.x + 0.5 && ul.x + ul.w >= p.x + p.w - 0.5 && ul.y >= p.y + p.h - 10, JSON.stringify({ ul, p }));
    assert.deepEqual(S.items.map((it) => it.n), S.items.map((_, k) => k + 1));
    assert.equal(await deck.page.eval("document.documentElement.classList.contains('pgg-layout') || !!document.querySelector('.pgg-cur, [data-pgg-iso]')"), false);
    assert.equal(S.times.length, S.states.length);
  });

  test('time series: the opacity and center measured at a time are what the page shows then (scene root excluded, parent layer included)', async () => {
    const S = await extractSection(deck, 0);
    const steps = await deck.page.eval('__deck.steps');
    const k = S.items.findIndex((it) => it.kind === 'text' && it.runs[0].t === '둘째'), j = S.items.findIndex((it) => it.what === 'i.ul[ul]'), t0 = S.items.findIndex((it) => it.kind === 'text' && it.runs[0].t.startsWith('첫'));
    const at = (t) => S.times.reduce((b, x, i) => (Math.abs(x - t) < Math.abs(S.times[b] - t) ? i : b), 0);
    const col = (i, c) => S.states[i][S.items.indexOf(S.items[c.k])][COLS.indexOf(c.c)];
    const mid = steps[1].start + 0.4, i = at(mid);
    const page = await deck.page.eval(`(__deck.seek(${S.times[i]}), (() => { const e = document.querySelector('[data-r="p"]'), l = document.querySelector('[data-r="lay"]'), r = e.getBoundingClientRect();
      return { op: +getComputedStyle(e).opacity * +getComputedStyle(l).opacity, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; })())`);
    assert.ok(Math.abs(col(i, { k, c: 'op' }) - page.op) < 1e-4, `${col(i, { k, c: 'op' })} vs ${page.op}`);
    // the line's center moves with the layer: rest center + the layer's translate now
    const tx = await deck.page.eval(`(__deck.seek(${S.times[i]}), parseFloat(getComputedStyle(document.querySelector('[data-r="lay"]')).translate) || 0)`);
    assert.ok(Math.abs(col(i, { k, c: 'cx' }) - (S.items[k].x + S.items[k].w / 2 + tx)) < 0.05, `${col(i, { k, c: 'cx' })} vs rest + ${tx}`);
    // the underline: zero width before it draws, its center following the layer
    const pre = at(steps[1].start + 0.15);
    assert.ok(col(pre, { k: j, c: 'sx' }) < 1e-6 && col(at(steps[1].end), { k: j, c: 'sx' }) > 0.999);
    // dimmed title at the step end, not hidden; nothing measured before the first step's fade starts
    assert.ok(Math.abs(col(S.times.length - 1, { k: t0, c: 'op' }) - 0.35) < 1e-4);
    assert.equal(col(0, { k: t0, c: 'op' }), 0);
    const again = await measure(deck.page, [S.times[i]]);
    assert.deepEqual(again[0], S.states[i], 'the same time measures the same');
  });
});
