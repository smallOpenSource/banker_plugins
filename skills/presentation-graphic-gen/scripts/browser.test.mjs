// browser.test.mjs: the engine and the gates in a real headless browser. Skips (with the reason) when no Chrome,
// Edge or Chromium is found; set CHROME to point at one.
// Run: node --test scripts/browser.test.mjs
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { SAMPLE, SKILL } from './build.mjs';
import { check } from './check.mjs';
import { findBrowser, launch, sleep } from './cdp.mjs';
import { decodePng, diffPng } from './png.mjs';

const BROWSER = findBrowser();
const SKIP = BROWSER ? false : 'no Chrome, Edge or Chromium found (set CHROME to the browser executable); browser tests not run';
if (SKIP) process.stdout.write(`# SKIP browser tests: ${SKIP}\n`);

const BUILD = join(SKILL, 'scripts', 'build.mjs'), CHECK = join(SKILL, 'scripts', 'check.mjs');
const STAMP = '261118+0900';
let TMP, PRESENT, REVIEW, b, page;

function buildDeck(script, dir, extra = []) {
  const r = spawnSync(process.execPath, [BUILD, script, '--dir', dir, '--stamp', STAMP, ...extra], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const name = script.replace(/^.*[\\/]/, '').replace(/\.md$/, '');
  return { review: join(dir, `${name}-review-${STAMP}.html`), present: join(dir, `${name}-present-${STAMP}.html`) };
}
// a one-section deck whose scene file is `scene` (steps s1-1, s1-2)
function miniDeck(dirName, scene) {
  const dir = join(TMP, dirName);
  mkdirSync(join(dir, 'scenes'), { recursive: true });
  writeFileSync(join(dir, 'mini.md'), '# 작은 덱\n\n## 1. 하나\n\n### 1-1\n화면: 첫째\n말: 하나.\n\n### 1-2\n화면: 둘째\n말: 둘.\n');
  writeFileSync(join(dir, 'scenes', '01.js'), scene);
  return buildDeck(join(dir, 'mini.md'), join(dir, 'out'));
}
const nums = (s) => (String(s).match(/-?\d+(\.\d+)?(e-?\d+)?/g) || []).map(Number);
const STATE = (sel) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}), cs = getComputedStyle(e);
  return { translate: cs.translate, scale: cs.scale, opacity: cs.opacity }; })()`;
function vec(st) {
  const t = nums(st.translate === 'none' ? '0 0' : st.translate), s = nums(st.scale === 'none' ? '1' : st.scale);
  return { x: t[0] || 0, y: t[1] || 0, s: s[0], o: +st.opacity };
}
const near = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;

describe('engine in a browser', { skip: SKIP }, () => {
  before(async () => {
    TMP = mkdtempSync(join(tmpdir(), 'pgg-browser-test-'));
    ({ review: REVIEW, present: PRESENT } = buildDeck(SAMPLE, join(TMP, 'sample')));
    b = await launch({ browser: BROWSER });
    page = await b.open(null, { media: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] }); // the keys test plays steps even under an OS Reduce Motion setting
  });
  after(() => { if (b) b.close(); if (TMP) rmSync(TMP, { recursive: true, force: true }); });

  const url = (f, hash = '') => pathToFileURL(f).href + hash;

  test('check.mjs passes every gate on the sample (present and review)', { timeout: 300000 }, () => {
    for (const f of [PRESENT, REVIEW]) {
      const r = spawnSync(process.execPath, [CHECK, f, '--script', SAMPLE], { encoding: 'utf8', timeout: 280000 });
      const lines = r.stdout.split('\n').filter((l) => /^(PASS|FAIL) /.test(l));
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.deepEqual(lines.map((l) => l.split(':')[0]).sort(), ['PASS console-errors', 'PASS continuity', 'PASS decorations', 'PASS decorations-played', 'PASS layout', 'PASS network', 'PASS safe-area',
        'PASS snapshots', 'PASS step-count', 'PASS text-size'].sort());
      assert.match(r.stdout, /PASS continuity: jump == play for 16\/16 steps/);
    }
  });

  test('check.mjs fails a deck with an error, small text and text outside the safe area', { timeout: 120000 }, async () => {
    const d = miniDeck('broken', `Deck.scene({ section: 1, css: '.s01 .a { position: absolute; left: 40px; top: 200px; font-size: 20px; }',
      html: (d) => { console.error('scene says no'); return '<p class="a" data-r="a">' + d.esc(d.lines('s1-1')[0]) + '</p><p data-r="b">' + d.esc(d.lines('s1-2')[0]) + '</p>'; },
      steps: { 's1-1'(s) { s.fadeIn('a'); }, 's1-2'(s) { s.fadeIn('b'); } } });`);
    const r = await check(d.present, { out: join(TMP, 'broken-check'), log: () => {} });
    const by = Object.fromEntries(r.results.map((x) => [x.gate, x.ok]));
    assert.equal(r.ok, false);
    assert.equal(by['console-errors'], false);
    assert.equal(by['safe-area'], false);
    assert.equal(by['text-size'], false);
    assert.equal(by.continuity, true);
    assert.equal(by.network, true);
  });

  test('decorations gate: a bar sized by hand under a text line fails; s.underline and s.mark pass', { timeout: 120000 }, async () => {
    const css = '.s01 .t { position: absolute; left: 300px; top: 400px; font-size: 56px; white-space: nowrap; } .s01 .bar { position: absolute; left: 300px; top: 480px; width: 640px; height: 12px; background: var(--accent-solid); }';
    const html = "'<p class=\"t\" data-r=\"t\">' + d.esc(d.lines('s1-1')[0]) + ' 문장 하나</p>'";
    const bad = miniDeck('decor-bad', `Deck.scene({ section: 1, css: '${css}', html: (d) => ${html} + '<i class="bar" data-r="bar"></i>',
      steps: { 's1-1'(s) { s.fadeIn('t'); }, 's1-2'(s) { s.draw('bar'); } } });`);
    const good = miniDeck('decor-good', `Deck.scene({ section: 1, css: '${css}', html: (d) => ${html} + '<i class="ul" data-r="ul"></i>',
      steps: { 's1-1'(s) { s.fadeIn('t'); }, 's1-2'(s) { s.underline('ul', 't'); s.mark('t', { at: 0.4 }); } } });`);
    const rb = await check(bad.present, { out: join(TMP, 'decor-bad-check'), log: () => {} });
    const rg = await check(good.present, { out: join(TMP, 'decor-good-check'), log: () => {} });
    const gb = rb.results.find((x) => x.gate === 'decorations'), gg = rg.results.find((x) => x.gate === 'decorations');
    assert.equal(gb.ok, false, 'the hand-sized bar must fail');
    assert.match(gb.lines.join(' '), /s1-2: bar under "첫째 문장 하나" does not match its text: bar x 300-940/);
    assert.equal(gg.ok, true, gg.lines.join(' | '));
    assert.equal(rg.ok, true, rg.results.filter((x) => !x.ok).map((x) => x.gate + ' ' + x.lines.join(' ')).join(' | '));
  });

  test('focus outline: one element inside its target, in its shape; moving focus fades the old one out', async () => {
    await page.goto(url(PRESENT, '#1'));
    const r = await page.eval(`(() => { const chips = [...document.querySelectorAll('.s01 [data-r="chip"]')];
      return chips.map((c) => { const fx = c.querySelector(':scope > .fx-focus'); if (!fx) return null; const cs = getComputedStyle(fx);
        return { op: +cs.opacity, kids: fx.children.length, r: parseFloat(cs.borderTopLeftRadius), target: parseFloat(getComputedStyle(c).borderTopLeftRadius),
          border: ['Top', 'Right', 'Bottom', 'Left'].map((d) => parseFloat(cs['border' + d + 'Width'])) }; }); })()`);
    assert.equal(r.length, 3);
    assert.deepEqual(r.map((x) => x && x.op), [0, 0, 1], 'only the newest chip is marked');
    for (const x of r) {
      assert.equal(x.kids, 0, 'one element, no pieces');
      assert.equal(x.r, x.target + 10, 'corner radius = the chip radius + the pad');
      assert.ok(x.border.every((w) => w > 0), 'a border on all four sides');
    }
    assert.equal(await page.eval("document.querySelectorAll('.s01 .ring-e').length"), 0, 'no stretched edge pieces');
  });

  test('decorations gate: a stretched sliver and an outline that is open or not in its target shape fail; the outline passes', { timeout: 180000 }, async () => {
    const chips = "'<div class=\"row\" style=\"position:absolute;left:300px;top:400px;display:flex;gap:40px\"><span class=\"chip\" data-r=\"c\">' + d.esc(d.lines('s1-1')[0]) + '</span><span class=\"chip\" data-r=\"c\">' + d.esc(d.lines('s1-2')[0]) + '</span></div>'";
    const steps = "steps: { 's1-1'(s) { s.chips('c', { ring: 'f' }); }, 's1-2'(s) { s.focus('f', s.$('c')[0]); } }";
    const ok = miniDeck('focus-ok', `Deck.scene({ section: 1, html: (d) => ${chips}, ${steps} });`);
    const sliver = miniDeck('focus-sliver', `Deck.scene({ section: 1, css: '.s01 .sl { position: absolute; left: 300px; top: 600px; width: 1px; height: 4px; background: var(--accent-solid); transform-origin: 0 0; }',
      html: (d) => ${chips} + '<i class="sl" data-r="sl"></i>', steps: { 's1-1'(s) { s.chips('c'); }, 's1-2'(s) { s.tween('sl', { scaleX: 0 }, { scaleX: 150 }); } } });`);
    const open = miniDeck('focus-open', `Deck.scene({ section: 1, css: '.s01 .fx-focus { border-right-width: 0 !important; }', html: (d) => ${chips}, ${steps} });`);
    const square = miniDeck('focus-square', `Deck.scene({ section: 1, css: '.s01 .fx-focus { border-radius: 0 !important; }', html: (d) => ${chips}, ${steps} });`);
    const run = async (d, name) => { const r = await check(d.present, { out: join(TMP, name), log: () => {} }); return Object.fromEntries(r.results.map((x) => [x.gate, x])); };
    const g0 = await run(ok, 'focus-ok-check');
    assert.equal(g0.decorations.ok, true, g0.decorations.lines.join(' | '));
    assert.equal(g0['decorations-played'].ok, true, g0['decorations-played'].lines.join(' | '));
    const g1 = await run(sliver, 'focus-sliver-check');
    assert.equal(g1.decorations.ok, false);
    assert.match(g1.decorations.lines.join(' '), /sl is a 1x4px box stretched to 150x4/);
    assert.equal(g1['decorations-played'].ok, false);
    const g2 = await run(open, 'focus-open-check');
    assert.equal(g2.decorations.ok, false);
    assert.match(g2.decorations.lines.join(' '), /focus outline of "첫째" is not one closed shape/);
    const g3 = await run(square, 'focus-square-check');
    assert.equal(g3.decorations.ok, false);
    assert.match(g3.decorations.lines.join(' '), /does not follow its shape: corner radius 0, target 16 \+ pad 10/);
  });

  test('the pixel comparator tells different states apart (the continuity gate can fail)', async () => {
    await page.goto(url(PRESENT, '#0'));
    const a = await page.shot(null);
    await page.eval('__deck.jump(1)');
    const c = await page.shot(null);
    const d = diffPng(a, c);
    assert.ok(d.count > 100 && d.max > 100, JSON.stringify(d));
    assert.equal(diffPng(a, a).max, 0);
  });

  test('trap 2: one element animated on the same channels in three steps has the right value at every boundary', async () => {
    await page.goto(url(PRESENT, '#0'));
    const steps = await page.eval('__deck.steps');
    const S = Object.fromEntries(steps.map((s) => [s.id, s]));
    const at = async (t) => { await page.eval(`__deck.seek(${t})`); return vec(await page.eval(STATE('.s04 [data-r="num"]'))); };
    const cases = [
      [S['s3-3'].end, { x: 0, y: 16, s: 1, o: 0 }, 'before its first step: the first segment start state'],
      [S['s4-1'].end, { x: 0, y: 0, s: 1, o: 1 }, 'end of 4-1 (a later move must not leak backwards)'],
      [S['s4-2'].start + 0.05, { x: 0, y: 0, s: 1, o: 1 }, 'in 4-2 before its move starts'],
      [S['s4-2'].end, { x: 0, y: -140, s: 0.4, o: 0.35 }, 'end of 4-2'],
      [S['s4-3'].start + 0.2, { x: 0, y: -140, s: 0.4, o: 0.35 }, 'in 4-3 before its move starts'],
      [S['s4-3'].end, { x: 1000, y: -100, s: 0.6, o: 1 }, 'end of 4-3'],
    ];
    for (const [t, want, why] of cases) {
      const got = await at(t);
      for (const k of Object.keys(want)) assert.ok(near(got[k], want[k]), `${why}: ${k} = ${got[k]}, want ${want[k]}`);
    }
    // in between: monotone on the way from 4-2's end value to 4-3's end value
    let last = -Infinity;
    for (let f = 0; f <= 1.0001; f += 0.1) {
      const g = await at(S['s4-3'].start + (S['s4-3'].end - S['s4-3'].start) * f);
      assert.ok(g.x >= last - 1e-6, `x goes one way during 4-3 (${g.x} after ${last})`);
      last = g.x;
    }
  });

  test('trap 2 negative control: naive separate animations with fill "both" get the boundary wrong', async () => {
    const naive = await page.eval(`(() => {
      const e = document.createElement('div'); document.body.appendChild(e);
      const segs = [[0, 1000, '0px 24px', '0px 0px'], [1500, 2000, '0px 0px', '0px -140px'], [2500, 3000, '0px -140px', '0px 340px']];
      const list = segs.map(([a, z, f, t]) => { const an = e.animate([{ translate: f }, { translate: t }], { delay: a, duration: z - a, fill: 'both' }); an.pause(); return an; });
      list.forEach((an) => { an.currentTime = 1200; });
      const v = getComputedStyle(e).translate; list.forEach((an) => an.cancel()); e.remove(); return v; })()`);
    assert.ok(!near(nums(naive)[1] || 0, 0), `naive composition shows ${naive} at 1.2 s, where the first segment's end (0px 0px) is right`);
  });

  test('seek at random times: the same time always gives the same state, from any direction', { timeout: 120000 }, async () => {
    await page.goto(url(PRESENT, '#0'));
    const { duration, N } = await page.eval('({ duration: __deck.duration, N: __deck.N })');
    const snap = `JSON.stringify(document.getAnimations().map((a) => { const e = a.effect.target, cs = getComputedStyle(e);
      return [cs.opacity, cs.translate, cs.scale, cs.rotate].join('|'); }))`;
    let seed = 12345;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    for (let k = 0; k < 10; k++) {
      const t = rnd() * duration, j = Math.floor(rnd() * N);
      await page.eval('__deck.seek(0)');
      await page.eval(`__deck.seek(${t})`);
      const s1 = await page.eval(snap), p1 = await page.shot(null);
      await page.eval(`__deck.seek(${duration})`);
      await page.eval(`__deck.seek(${t})`);
      const s2 = await page.eval(snap), p2 = await page.shot(null);
      await page.eval(`__deck.jump(${j})`);
      await page.eval(`__deck.seek(${t})`);
      const s3 = await page.eval(snap);
      assert.equal(s2, s1, `t=${t.toFixed(3)}: forward vs backward seek`);
      assert.equal(s3, s1, `t=${t.toFixed(3)}: after a jump to step ${j}`);
      // styles are equal exactly; pixels may differ by antialiasing only (a few levels), never by content
      const d = diffPng(p1, p2);
      assert.equal(d.count, 0, `t=${t.toFixed(3)}: ${d.count} pixels differ by more than 16 (max ${d.max})`);
    }
  });

  test('trap 1: only opacity / translate / scale / rotate are animated, with numeric keyframes', async () => {
    await page.goto(url(PRESENT, '#0'));
    const kf = await page.eval(`document.getAnimations().flatMap((a) => a.effect.getKeyframes())`);
    assert.ok(kf.length > 100);
    const allowed = new Set(['offset', 'computedOffset', 'easing', 'composite', 'opacity', 'translate', 'scale', 'rotate']);
    const NUM = '-?\\d+(\\.\\d+)?(e-?\\d+)?';
    const shape = { opacity: new RegExp(`^${NUM}$`), translate: new RegExp(`^${NUM}px( ${NUM}px)?$`), scale: new RegExp(`^${NUM}( ${NUM})?$`), rotate: new RegExp(`^${NUM}deg$`) };
    for (const k of kf) {
      for (const [p, v] of Object.entries(k)) {
        assert.ok(allowed.has(p), `animated property ${p}`);
        if (shape[p]) assert.match(String(v), shape[p], `${p}: ${v}`);
      }
    }
  });

  test('trap 1: the engine refuses a non-numeric or non-transform property; trap 2: overlapping segments are refused', async () => {
    const bad = miniDeck('badprop', `Deck.scene({ section: 1, html: '<p data-r="a">a</p><p data-r="b">b</p>',
      steps: { 's1-1'(s) { s.tween('a', null, { backgroundPosition: 10 }); }, 's1-2'(s) { s.fadeIn('b'); } } });`);
    await page.goto(url(bad.present));
    assert.match(await page.eval('__deck.error'), /"backgroundPosition" cannot be animated/);
    const lap = miniDeck('overlap', `Deck.scene({ section: 1, html: '<p data-r="a">a</p><p data-r="b">b</p>',
      steps: { 's1-1'(s) { s.move('a', { x: 10 }, { dur: 1 }); s.move('a', { y: 10 }, { at: 0.5 }); }, 's1-2'(s) { s.fadeIn('b'); } } });`);
    await page.goto(url(lap.present));
    assert.match(await page.eval('__deck.error'), /two translate animations overlap/);
  });

  test('trap 1: the underline moves with its text while the layer slides (one parent layer)', async () => {
    await page.goto(url(PRESENT, '#0'));
    const s = (await page.eval('__deck.steps')).find((x) => x.id === 's6-1');
    const rel = `(() => { const r = (q) => document.querySelector('.s06 [data-r="' + q + '"]').getBoundingClientRect();
      const bar = r('ul2'), line = r('line'); return { dx: bar.left - line.left, dy: bar.top - line.bottom, w: bar.width, lw: line.width, lx: line.left }; })()`;
    const seen = [];
    for (let f = 0.3; f <= 1.0001; f += 0.05) {
      await page.eval(`__deck.seek(${s.start + (s.end - s.start) * f})`);
      seen.push(await page.eval(rel));
    }
    assert.ok(seen[0].lx > seen[seen.length - 1].lx + 50, 'the layer really moves during the step');
    for (const v of seen) {
      assert.ok(near(v.dx, seen[0].dx, 0.5) && near(v.dy, seen[0].dy, 0.5), `bar offset from its text changed: ${JSON.stringify(v)} vs ${JSON.stringify(seen[0])}`);
    }
    const end = seen[seen.length - 1];
    assert.ok(end.w >= end.lw, `underline ${end.w} at least as wide as its text ${end.lw}`);
  });

  test('trap 5: nothing paints until fonts are ready; then the deck starts', async () => {
    const hold = `(() => { let open; const p = new Promise((r) => { open = r; }); window.__openFonts = () => open();
      Object.defineProperty(document.fonts, 'ready', { configurable: true, get: () => p }); })()`;
    const p2 = await b.open(null, { init: [hold] });
    await p2.goto(url(PRESENT, '#2'), { wait: false });
    await sleep(1500);
    assert.equal(await p2.eval('document.documentElement.dataset.ready || null'), null, 'not started while fonts.ready is pending');
    const img = decodePng(await p2.shot(null));
    const d = img.data;
    let same = true;
    for (let i = 4; i < d.length; i += 4) if (d[i] !== d[0] || d[i + 1] !== d[1] || d[i + 2] !== d[2]) { same = false; break; }
    assert.ok(same, 'the screen is one flat background color before the timeline exists');
    await p2.eval('window.__openFonts()');
    await p2.ready();
    assert.equal(await p2.eval('__deck.index'), 2);
    assert.ok(await p2.eval(`document.fonts.check('700 40px "Deck Sans KR"', '가')`));
    const shown = decodePng(await p2.shot(null));
    assert.ok(shown.data.some((v, i) => i % 4 !== 3 && v !== d[i % 4]), 'step 3 is visible after start');
    await p2.close();
  });

  test('keys: next / prev maps, rapid presses finish a step without skipping, hash jump, blank screen', async () => {
    await page.goto(url(PRESENT));
    await page.settle();
    const st = () => page.eval('({ i: __deck.index, a: __deck.animating, t: __deck.time, blank: __deck.blanked })');
    const steps = await page.eval('__deck.steps');
    assert.deepEqual(await page.eval('[__deck.index, __deck.time]'), [0, steps[0].end], 'no hash: step 1 plays once and stops');
    await page.press('ArrowRight');
    let s = await st();
    assert.equal(s.i, 1); assert.equal(s.a, true, 'step 2 plays');
    await page.press('ArrowRight');
    s = await st();
    assert.deepEqual([s.i, s.a, s.t], [1, false, steps[1].end], 'a press while playing finishes the step, does not skip');
    for (const [key, want] of [[' ', 2], ['Enter', 3], ['ArrowDown', 4], ['PageDown', 5]]) {
      await page.press(key);
      await page.settle();
      assert.equal((await st()).i, want, `${JSON.stringify(key)} goes to the next step`);
    }
    for (const [key, want] of [['ArrowLeft', 4], ['ArrowUp', 3], ['PageUp', 2], ['Backspace', 1]]) {
      await page.press(key);
      s = await st();
      assert.deepEqual([s.i, s.a, s.t], [want, false, steps[want].end], `${key} jumps back to the previous step's end state`);
    }
    await page.click(900, 500);
    await page.settle();
    assert.equal((await st()).i, 2, 'a click goes to the next step');
    await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 8 }, page.sessionId);
    await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 8 }, page.sessionId);
    assert.equal((await st()).i, 2, 'Shift+Enter (fullscreen) does not advance');
    await page.press('b');
    assert.equal((await st()).blank, true, 'B blanks the screen');
    await page.press('b');
    assert.equal((await st()).blank, false);
    assert.equal(await page.eval('location.hash'), '#2');
    await page.goto(url(PRESENT, '#9'));
    s = await st();
    assert.deepEqual([s.i, s.a, s.t], [9, false, steps[9].end], 'hash #9 opens step 10 at its end state');
  });

  test('prefers-reduced-motion: Next shows the step end state at once', async () => {
    const p2 = await b.open(null, { media: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await p2.goto(url(PRESENT, '#0'));
    assert.equal(await p2.eval('__deck.reduced'), true);
    await p2.press('ArrowRight');
    const s = await p2.eval('({ i: __deck.index, a: __deck.animating, t: __deck.time, end: __deck.steps[1].end })');
    assert.deepEqual([s.i, s.a, s.t], [1, false, s.end]);
    await p2.close();
  });

  test('review page: script panel, timer from 00:00, click to jump; present has neither', async () => {
    await page.goto(url(REVIEW, '#0'));
    const r = await page.eval(`({ items: document.querySelectorAll('.p-item').length, dirs: document.querySelectorAll('.p-dir').length,
      timer: document.getElementById('tm-total').textContent, cur: document.querySelector('.p-item.cur').dataset.i,
      speech: document.querySelector('.p-speech').textContent })`);
    assert.equal(r.items, 16);
    assert.ok(r.dirs >= 16, 'stage directions are shown apart from the spoken note');
    assert.match(r.timer, /^전체 00:0[0-2]$/);
    assert.equal(r.cur, '0');
    assert.doesNotMatch(r.speech, /\[/, 'no bracketed direction inside the spoken note');
    await page.eval(`document.querySelectorAll('.p-item')[7].click()`);
    assert.equal(await page.eval('__deck.index'), 7);
    await page.goto(url(PRESENT, '#0'));
    assert.deepEqual(await page.eval(`[!!document.getElementById('panel'), document.getElementById('deck-data').textContent.includes('카페에 가지')]`), [false, false]);
    assert.equal(await page.eval(`document.documentElement.dataset.theme`), 'dark', 'dark theme by default');
  });
});
