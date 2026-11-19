// pptx-anim-browser.test.mjs: what the editable deck's animation is read from, in a real headless browser: the rest
// layout of a section and the measured time series (they must be what the page shows at that time); and small decks
// whose steps start with an entrance, cross a dim and a fade-out, or have no motion, through the anim gates. Skips with
// the reason when no browser is found.
// Run: node --test scripts/pptx-anim-browser.test.mjs
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { SKILL, parseScript } from './build.mjs';
import { findBrowser } from './cdp.mjs';
import { COLS, extractSection, measure, openDeck } from './pptx-anim-extract.mjs';
import { buildEditPptx } from './pptx-edit.mjs';
import { verify } from './pptx.mjs';
import { pptxgen } from './vendor.mjs';

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

// review 1: clicks that start with s.reveal or s.underline, s.dim then s.fadeOut in the next step, a static line
// with a step of s.hold only, and a first step with nothing on screen yet
describe('editable deck: step boundaries and steps with no motion', { skip: SKIP }, () => {
  let TMP, present, script, out;
  before(async () => {
    TMP = mkdtempSync(join(tmpdir(), 'pgg-anim-review-test-'));
    mkdirSync(join(TMP, 'scenes'));
    script = join(TMP, 'mini.md');
    writeFileSync(script, '# 작은 덱\n\n## 1. 하나\n\n### 1-1\n화면: 제목\n말: 하나.\n\n### 1-2\n화면: 드러남\n말: 둘.\n\n### 1-3\n화면: 사라짐\n말: 셋.\n\n## 2. 둘\n\n### 2-1\n화면: 빈 화면\n말: 넷.\n\n### 2-2\n화면: 나중 글\n말: 다섯.\n\n### 2-3\n화면: 멈춤\n말: 여섯.\n');
    writeFileSync(join(TMP, 'scenes', '01.js'), `Deck.scene({ section: 1, css: '.s01 .t { position: absolute; left: 200px; top: 200px; } .s01 .p { position: absolute; left: 200px; top: 420px; } .s01 .w { position: absolute; left: 200px; top: 640px; width: 600px; height: 80px; overflow: hidden; } .s01 .w > div { width: 600px; height: 80px; background: #e0a030; }',
      html: (d) => '<h1 class="t t-display" data-r="t">' + d.esc(d.lines('s1-1')[0]) + '</h1><p class="p t-h2" data-r="p">' + d.esc(d.lines('s1-3')[0]) + '</p><i class="ul" data-r="ul"></i><div class="w" data-r="w"><div></div></div>',
      steps: { 's1-1'(s) { s.fadeUp('t', { at: 0.1 }); s.fadeUp('p', { at: 0.2 }); }, 's1-2'(s) { s.reveal('w', { dur: 0.6 }); s.dim('t'); }, 's1-3'(s) { s.fadeOut('t'); s.underline('ul', 'p'); } } });`);
    writeFileSync(join(TMP, 'scenes', '02.js'), `Deck.scene({ section: 2, css: '.s02 .a { position: absolute; left: 200px; top: 150px; } .s02 .t { position: absolute; left: 200px; top: 400px; }',
      html: (d) => '<p class="a t-h2" data-r="a">고정 글</p><h2 class="t t-h1" data-r="t2">' + d.esc(d.lines('s2-2')[0]) + '</h2>',
      steps: { 's2-1'(s) { s.hold(0.5); }, 's2-2'(s) { s.fadeUp('t2', { at: 0.1 }); }, 's2-3'(s) { s.hold(0.5); } } });`);
    const r = spawnSync(process.execPath, [join(SKILL, 'scripts', 'build.mjs'), script, '--scenes', join(TMP, 'scenes'), '--dir', TMP, '--stamp', STAMP], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    present = join(TMP, `mini-present-${STAMP}.html`);
    out = join(TMP, 'edit.pptx');
    await buildEditPptx({ html: present, parsed: parseScript(readFileSync(script, 'utf8')), out, browser: BROWSER });
  });
  after(() => { if (TMP) rmSync(TMP, { recursive: true, force: true }); });
  const gates = async (f) => Object.fromEntries((await verify(f, { script, html: present, browser: BROWSER, log: () => {} })).results.map((x) => [x.gate, x]));

  test('every anim gate passes: the reveal and the underline are the first effects of their click, the dim and the fade-out stay in their own steps, the static line is shown from the slide start', async () => {
    const g = await gates(out);
    for (const k of ['anim-xml', 'anim-steps', 'anim-targets', 'anim-match', 'anim-render', 'text-fit']) assert.equal(g[k].ok, true, `${k}: ${g[k].detail}\n${g[k].lines.join('\n')}`);
    const { JSZip } = pptxgen();
    const xml = await (await JSZip.loadAsync(readFileSync(out))).file('ppt/slides/slide1.xml').async('string');
    const auto = xml.slice(0, xml.indexOf('nodeType="clickEffect"'));
    assert.doesNotMatch(auto, /presetID="22"/, 'the wipe is not in the automatic group');
    assert.match(xml.slice(xml.indexOf('nodeType="clickEffect"')), /presetID="22" presetClass="entr" presetSubtype="8" fill="hold" grpId="0" nodeType="(click|with)Effect"/);
  });

  test('anim-match compares the slide start (during the transition): a first visibility change written as hidden (the old no-op click) shows the later line too early and fails', async () => {
    const { JSZip } = pptxgen();
    const zip = await JSZip.loadAsync(readFileSync(out));
    const xml = await zip.file('ppt/slides/slide2.xml').async('string');
    const spid = /<p:cNvPr id="(\d+)" name="text h2[^"]*\[t2\] #\d+"/.exec(xml)[1];
    const old = xml.replace(/<p:anim calcmode="lin" valueType="num"><p:cBhvr additive="base"><p:cTn id="(\d+)" dur="1" fill="hold">(<p:stCondLst>[\s\S]*?<\/p:stCondLst>)<\/p:cTn><p:tgtEl><p:spTgt spid="\d+"\/><\/p:tgtEl><p:attrNameLst><p:attrName>ppt_x<\/p:attrName><\/p:attrNameLst><\/p:cBhvr><p:tavLst>[\s\S]*?<\/p:tavLst><\/p:anim>/,
      (m, id, cond) => `<p:set><p:cBhvr><p:cTn id="${id}" dur="1" fill="hold">${cond}</p:cTn><p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl><p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr><p:to><p:strVal val="hidden"/></p:to></p:set>`);
    assert.notEqual(old, xml, 'the no-op of step 2-1 is there to replace');
    zip.file('ppt/slides/slide2.xml', old);
    const f = join(TMP, 'old-marker.pptx');
    writeFileSync(f, await zip.generateAsync({ type: 'nodebuffer' }));
    const g = await gates(f);
    assert.equal(g['anim-match'].ok, false);
    assert.match(g['anim-match'].lines.join('\n'), /s2-1 slide start: text h2\.t\.t-h1\[t2\] #\d+ opacity page 0\.00 PowerPoint 1\.00/);
  });
});

// a line with a blank slot between two text pieces (s.fill): each piece its own box where the page has it
describe('editable deck: a line with a gap', { skip: SKIP }, () => {
  let TMP, present, script, out;
  before(async () => {
    TMP = mkdtempSync(join(tmpdir(), 'pgg-anim-gap-test-'));
    mkdirSync(join(TMP, 'scenes'));
    script = join(TMP, 'mini.md');
    writeFileSync(script, '# 작은 덱\n\n## 1. 하나\n\n### 1-1\n화면: 원두 20 g 이면 물\n- 300\n- ml\n말: 하나.\n');
    writeFileSync(join(TMP, 'scenes', '01.js'), `Deck.scene({ section: 1, css: '.s01 .line { position: absolute; left: 160px; top: 420px; white-space: nowrap; } .s01 .line .blank { min-width: 200px; margin: 0 16px; }',
      html: (d) => { const [pre, word, unit] = d.lines('s1-1'); return '<p class="line t-h1" data-r="q">' + d.esc(pre) + '<span class="blank" data-r="blank"><i class="blank-hatch"></i><span class="blank-word" data-r="word">' + d.esc(word) + '</span></span>' + d.esc(unit) + '</p>'; },
      steps: { 's1-1'(s) { const t = s.fadeUp('q', { at: 0.1, y: 12 }); s.fill('blank', 'word', { at: t }); } } });`);
    const r = spawnSync(process.execPath, [join(SKILL, 'scripts', 'build.mjs'), script, '--scenes', join(TMP, 'scenes'), '--dir', TMP, '--stamp', STAMP], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    present = join(TMP, `mini-present-${STAMP}.html`);
    out = join(TMP, 'edit.pptx');
    await buildEditPptx({ html: present, parsed: parseScript(readFileSync(script, 'utf8')), out, browser: BROWSER });
  });
  after(() => { if (TMP) rmSync(TMP, { recursive: true, force: true }); });

  test('the pieces before and after the slot are two text boxes with the slot between them; text-fit passes, and a box widened over the slot (the old joined line) fails it', async () => {
    const { JSZip } = pptxgen();
    const zip = await JSZip.loadAsync(readFileSync(out));
    const xml = await zip.file('ppt/slides/slide1.xml').async('string');
    const boxes = [...xml.matchAll(/<p:cNvPr id="\d+" name="text p\.line\.t-h1\[q\] #\d+"[\s\S]*?<a:off x="(\d+)"[\s\S]*?<a:ext cx="(\d+)"[\s\S]*?<a:t>([^<]*)<\/a:t>/g)].map((m) => ({ x: +m[1] / 6350, w: +m[2] / 6350, t: m[3] }));
    assert.deepEqual(boxes.map((b) => b.t), ['원두 20 g 이면 물', 'ml']);
    assert.ok(boxes[1].x - (boxes[0].x + boxes[0].w) > 150, JSON.stringify(boxes));
    const v = await verify(out, { script, html: present, browser: BROWSER, log: () => {} });
    const g = Object.fromEntries(v.results.map((x) => [x.gate, x]));
    for (const k of ['anim-match', 'anim-render', 'text-fit']) assert.equal(g[k].ok, true, `${k}: ${g[k].detail} ${g[k].lines.join('; ')}`);
    const wide = xml.replace(/(name="text p\.line\.t-h1\[q\] #\d+"[\s\S]*?<a:ext cx=")(\d+)/, (m, a, cx) => `${a}${+cx + 260 * 6350}`);
    zip.file('ppt/slides/slide1.xml', wide);
    const f = join(TMP, 'joined.pptx');
    writeFileSync(f, await zip.generateAsync({ type: 'nodebuffer' }));
    const w = Object.fromEntries((await verify(f, { script, html: present, browser: BROWSER, log: () => {} })).results.map((x) => [x.gate, x]));
    assert.equal(w['text-fit'].ok, false);
    assert.match(w['text-fit'].lines.join('\n'), /text p\.line\.t-h1\[q\] #\d+: text [\d.]+ px in a box made for [\d.]+ px/);
  });
});

// review 3: a line dimmed from the section start (0.35) that brightens on the next click (deck9)
describe('editable deck: shown dim from the start', { skip: SKIP }, () => {
  let TMP, present, script, out;
  before(async () => {
    TMP = mkdtempSync(join(tmpdir(), 'pgg-anim-dim-test-'));
    mkdirSync(join(TMP, 'scenes'));
    script = join(TMP, 'mini.md');
    writeFileSync(script, '# 작은 덱\n\n## 1. 하나\n\n### 1-1\n화면: 첫 장면\n말: 하나.\n\n## 2. 둘\n\n### 2-1\n화면: 흐린 글\n말: 둘.\n\n### 2-2\n화면: 밝아짐\n말: 셋.\n');
    writeFileSync(join(TMP, 'scenes', '01.js'), `Deck.scene({ section: 1, css: '.s01 .a { position: absolute; left: 200px; top: 300px; }', html: () => '<p class="a t-h2" data-r="a">첫 장면</p>', steps: { 's1-1'(s) { s.fadeUp('a', { at: 0.1 }); } } });`);
    writeFileSync(join(TMP, 'scenes', '02.js'), `Deck.scene({ section: 2, css: '.s02 .a { position: absolute; left: 200px; top: 300px; } .s02 .b { position: absolute; left: 200px; top: 500px; }',
      html: () => '<p class="a t-h2" data-r="a">흐린 글</p><p class="b t-h2" data-r="b">다른 글</p>',
      steps: { 's2-1'(s) { s.tween('a', { opacity: 0.35 }, { opacity: 0.35 }, { at: 0, dur: 0.3 }); s.fadeUp('b', { at: 0.1 }); }, 's2-2'(s) { s.tween('a', null, { opacity: 1 }, { dur: 0.4 }); } } });`);
    const r = spawnSync(process.execPath, [join(SKILL, 'scripts', 'build.mjs'), script, '--scenes', join(TMP, 'scenes'), '--dir', TMP, '--stamp', STAMP], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    present = join(TMP, `mini-present-${STAMP}.html`);
    out = join(TMP, 'edit.pptx');
    await buildEditPptx({ html: present, parsed: parseScript(readFileSync(script, 'utf8')), out, browser: BROWSER });
  });
  after(() => { if (TMP) rmSync(TMP, { recursive: true, force: true }); });

  test('every anim gate passes: the dim line is 35% from the slide start (during the transition) and brightens on the click', async () => {
    const v = await verify(out, { script, html: present, browser: BROWSER, log: () => {} });
    const g = Object.fromEntries(v.results.map((x) => [x.gate, x]));
    for (const k of ['anim-xml', 'anim-steps', 'anim-targets', 'anim-match', 'anim-render', 'text-fit']) assert.equal(g[k].ok, true, `${k}: ${g[k].detail}\n${g[k].lines.join('\n')}`);
  });
});
