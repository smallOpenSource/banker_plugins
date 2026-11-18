#!/usr/bin/env node
// check.mjs: gates for a built deck page, in a real headless browser at 1920x1080. One PASS / FAIL line per gate;
// exits 1 when a gate fails, 2 on a usage error or when no browser is found.
//
//   node scripts/check.mjs <deck.html> [--script <script.md>] [--out <dir>] [--force]
// A non-empty output folder (an earlier run, or any folder --out names) is refused with exit 2 before the browser
// starts; --force writes over it (only after the user agrees).
//
// Gates:
//   console-errors  no console error, uncaught exception or deck build error while loading and stepping
//   network         no request other than the file itself (data: URLs are not requests)
//   step-count      steps in the page = steps in the script (--script, else the script data embedded in the page)
//   layout          at every step's end state: text stays inside its box, nothing visible leaves the stage
//   safe-area       at every step's end state: everything visible inside x 160-1760, y 120-960
//   decorations     at every step's end state: underline, highlight, strike, focus outline (one closed shape on its target, in
//                   its shape), no stretched sliver, and any thin bar right under a text line fit what they mark (see decorExpr)
//   decorations-played  the same while playing each step by the Next key (middle: shape rules; end: all rules) at a
//                   second viewport, 1227x785 with device pixel ratio 1.5; frames in played/
//   text-size       text below 28px (stage px) fails; text below 40px is listed (report)
//   continuity      for every step: the state after a direct jump equals the state after playing it from the
//                   previous step with the Next key (pixel compare, small tolerance)
//   snapshots       first / mid / end PNG per step, an end-state still per step (count = steps) and a contact sheet
// Output (default <html dir>/check-<html name>/): snaps/, stills/, contact-sheet.png, report.json
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseScript } from './build.mjs';
import { findBrowser, launch } from './cdp.mjs';
import { diffPng } from './png.mjs';
import { exitOf } from './vendor.mjs';

export const SAFE = { l: 160, r: 1760, t: 120, b: 960 };
export const MIN_PX = 28, REPORT_PX = 40;
export const PIXEL_TOL = 16, SHARE_TOL = 0.0002;
export const PLAY_VIEW = { width: 1227, height: 785, dpr: 1.5 }; // the second viewport of decorations-played

// evaluated in the page: the visible scene's text and leaf elements at the current state
export const LAYOUT = `(() => {
  const stage = document.getElementById('stage'), S = stage.getBoundingClientRect(), k = S.width / 1920;
  const box = (r) => ({ l: (r.left - S.left) / k, t: (r.top - S.top) / k, r: (r.right - S.left) / k, b: (r.bottom - S.top) / k });
  const eff = (e) => { let o = 1; for (let n = e; n && n !== stage; n = n.parentElement) { const cs = getComputedStyle(n);
    if (cs.visibility === 'hidden' || cs.display === 'none') return 0; o *= parseFloat(cs.opacity); } return o; };
  const name = (e) => (e.dataset && e.dataset.r ? e.dataset.r : e.tagName.toLowerCase() + (typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\\s+/).join('.') : ''));
  const SAFE = ${JSON.stringify(SAFE)};
  const out = { overflow: [], safe: [], small: [], report: [], texts: 0 };
  const f = (v) => Math.round(v);
  for (const sc of stage.querySelectorAll(':scope > .scene')) {
    if (eff(sc) < 0.5) continue;
    const walker = document.createTreeWalker(sc, NodeFilter.SHOW_TEXT), rg = document.createRange();
    for (let n; (n = walker.nextNode());) {
      const p = n.parentElement, t = n.textContent.trim();
      if (!t || eff(p) < 0.05) continue;
      let blk = p;
      while (blk !== sc && getComputedStyle(blk).display === 'inline') blk = blk.parentElement;
      const B = box(blk.getBoundingClientRect());
      const scale = blk.offsetWidth ? blk.getBoundingClientRect().width / k / blk.offsetWidth : 1;
      const px = parseFloat(getComputedStyle(p).fontSize) * scale;
      out.texts++;
      const label = t.slice(0, 24);
      // 0.5px tolerance: layout widths are rounded, so the measured scale of an unscaled box can be 0.998
      if (px < ${MIN_PX} - 0.5) out.small.push(label + ' ' + px.toFixed(1) + 'px');
      else if (px < ${REPORT_PX} - 0.5) out.report.push(label + ' ' + px.toFixed(1) + 'px');
      rg.selectNodeContents(n);
      for (const c of rg.getClientRects()) {
        if (c.width < 0.5 || c.height < 0.5) continue;
        const r = box(c), cy = (r.t + r.b) / 2;
        if (r.l < B.l - 1 || r.r > B.r + 1 || cy < B.t || cy > B.b) out.overflow.push('text "' + label + '" outside its box ' + name(blk));
        if (r.l < SAFE.l - 0.5 || r.r > SAFE.r + 0.5 || r.t < SAFE.t - 0.5 || r.b > SAFE.b + 0.5) out.safe.push('text "' + label + '" at x ' + f(r.l) + '-' + f(r.r) + ', y ' + f(r.t) + '-' + f(r.b));
      }
    }
    for (const e of sc.querySelectorAll('*')) {
      // painted leaf elements only (bars, edges, images); empty structural containers are skipped
      if (e.children.length || e.closest('svg') && e.tagName.toLowerCase() !== 'svg' || eff(e) < 0.05) continue;
      const cs = getComputedStyle(e), tag = e.tagName.toLowerCase();
      const painted = /^(img|svg|canvas|video)$/.test(tag) || cs.backgroundImage !== 'none' || !['transparent', 'rgba(0, 0, 0, 0)'].includes(cs.backgroundColor)
        || ['Top', 'Right', 'Bottom', 'Left'].some((d) => parseFloat(cs['border' + d + 'Width']) > 0 && cs['border' + d + 'Style'] !== 'none');
      if (!painted) continue;
      const c = e.getBoundingClientRect();
      if (c.width < 0.5 || c.height < 0.5) continue;
      const r = box(c);
      if (r.l < -0.5 || r.t < -0.5 || r.r > 1920.5 || r.b > 1080.5) out.overflow.push(name(e) + ' leaves the stage');
      else if (r.l < SAFE.l - 0.5 || r.r > SAFE.r + 0.5 || r.t < SAFE.t - 0.5 || r.b > SAFE.b + 0.5) out.safe.push(name(e) + ' at x ' + f(r.l) + '-' + f(r.r) + ', y ' + f(r.t) + '-' + f(r.b));
    }
  }
  return out;
})()`;

// evaluated in the page: every decoration at the current state must fit the text (or box) it marks.
//   underline  bar [data-ul] under text [data-ul-text]: covers the text's ink, overhangs it by at most OVER per
//              side, top within UL_GAP px of the ink bottom (same line, right under it)
//   highlight  .mk > .mk-box behind its .mk text: covers the ink, overhangs at most OVER, overlaps the line
//   strike     .strike > .strike-line through its text: covers the ink, overhangs at most OVER, mid line inside it
//   focus      the outline of each focus group (__deck.focusTargets()) is ONE element with a border on all four
//              sides (a closed shape), lies on its target box plus the pad within TOL, and has the target's corner
//              radius plus the pad (it follows the target's shape). An emphasis drawn from separate pieces fails.
//   sliver     no painted element smaller than 2px in a direction may be stretched to more than 4 times that by a
//              transform: the browser rasterizes the tiny box at a rounded device-pixel size and the stretch
//              multiplies the error (pieces stop short or overshoot on GPU browsers with a pixel ratio other than 1)
//   free bar   any other thin painted bar right under a line of text is read as that line's underline and must
//              fit it the same way (a bar sized by hand drifts off its text)
// motion = true (a state while a step plays): only the shape rules (focus is one closed shape, no sliver); fits are
// checked at end states.
export const DECOR_TOL = 2, DECOR_OVER = 16, UL_GAP = 24;
export const decorExpr = (motion = false) => String.raw`(() => {
  const MOTION = ${motion ? 'true' : 'false'};
  const stage = document.getElementById('stage'), S = stage.getBoundingClientRect(), k = S.width / 1920;
  const TOL = ${DECOR_TOL}, OVER = ${DECOR_OVER}, GAP = ${UL_GAP};
  const box = (r) => ({ l: (r.left - S.left) / k, t: (r.top - S.top) / k, r: (r.right - S.left) / k, b: (r.bottom - S.top) / k });
  const eff = (e) => { let o = 1; for (let n = e; n && n !== stage; n = n.parentElement) { const cs = getComputedStyle(n);
    if (cs.visibility === 'hidden' || cs.display === 'none') return 0; o *= parseFloat(cs.opacity); } return o; };
  const rg = document.createRange();
  const lines = (e) => { const out = []; const w = document.createTreeWalker(e, NodeFilter.SHOW_TEXT);
    for (let n; (n = w.nextNode());) { if (!n.textContent.trim() || n.parentElement.closest('.acc-ink')) continue; rg.selectNodeContents(n);
      for (const c of rg.getClientRects()) if (c.width >= 0.5 && c.height >= 0.5) out.push(box(c)); } return out; };
  const ink = (e) => { const L = lines(e); if (!L.length) return null;
    return { l: Math.min(...L.map((x) => x.l)), t: Math.min(...L.map((x) => x.t)), r: Math.max(...L.map((x) => x.r)), b: Math.max(...L.map((x) => x.b)) }; };
  const f = (v) => Math.round(v);
  const span = (B, I) => 'bar x ' + f(B.l) + '-' + f(B.r) + ', text x ' + f(I.l) + '-' + f(I.r);
  const fitsX = (B, I) => B.l <= I.l + TOL && B.r >= I.r - TOL && B.l >= I.l - OVER - TOL && B.r <= I.r + OVER + TOL;
  const label = (e) => (e.textContent || '').trim().slice(0, 20);
  const name = (e) => (e.dataset && e.dataset.r ? e.dataset.r : e.tagName.toLowerCase() + (typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\s+/).join('.') : ''));
  const painted = (cs) => !['transparent', 'rgba(0, 0, 0, 0)'].includes(cs.backgroundColor) || cs.backgroundImage !== 'none'
    || ['Top', 'Right', 'Bottom', 'Left'].some((d) => parseFloat(cs['border' + d + 'Width']) > 0 && cs['border' + d + 'Style'] !== 'none');
  const out = [];
  const seen = new Set();
  const targets = window.__deck && __deck.focusTargets ? __deck.focusTargets() : [];
  for (const sc of stage.querySelectorAll(':scope > .scene')) {
    if (eff(sc) < 0.5) continue;
    const shown = (e) => { if (eff(e) < 0.05) return null; const B = box(e.getBoundingClientRect()); return B.r - B.l >= 0.5 && B.b - B.t >= 0.5 ? B : null; };
    // slivers: tiny painted boxes stretched by a transform
    for (const e of sc.querySelectorAll('*')) {
      if (!(e instanceof HTMLElement) || eff(e) < 0.05 || !painted(getComputedStyle(e))) continue;
      const B = box(e.getBoundingClientRect()), ow = e.offsetWidth, oh = e.offsetHeight;
      if ((ow < 2 && B.r - B.l > 4 * Math.max(ow, 0.5)) || (oh < 2 && B.b - B.t > 4 * Math.max(oh, 0.5))) {
        out.push(name(e) + ' is a ' + ow + 'x' + oh + 'px box stretched to ' + f(B.r - B.l) + 'x' + f(B.b - B.t) + ' (a stretched sliver renders at the wrong length on GPU browsers)');
      }
    }
    // focus: one closed outline per group, on its target, in the target's shape
    for (const ring of sc.querySelectorAll('.ring')) {
      ring.querySelectorAll('*').forEach((e) => seen.add(e));
      if (eff(ring) >= 0.05 && ring.children.length) {
        const ft = targets.find((x) => x.ring === ring);
        out.push('focus emphasis' + (ft ? ' around "' + label(ft.target) + '"' : '') + ' is drawn from ' + ring.children.length + ' separate pieces, not one closed shape');
      }
    }
    for (const ft of targets) {
      if (!ft.fx || !sc.contains(ft.target)) continue;
      seen.add(ft.fx);
      const cs = getComputedStyle(ft.fx);
      if (eff(ft.fx) < 0.05) { if (!MOTION) out.push('focus outline of "' + label(ft.target) + '" is not visible'); continue; }
      const closed = ['Top', 'Right', 'Bottom', 'Left'].every((d) => parseFloat(cs['border' + d + 'Width']) > 0 && cs['border' + d + 'Style'] !== 'none');
      if (!closed || ft.fx.children.length) out.push('focus outline of "' + label(ft.target) + '" is not one closed shape');
      if (MOTION) continue;
      const R = box(ft.fx.getBoundingClientRect()), T = box(ft.target.getBoundingClientRect()), p = ft.pad;
      const d = Math.max(Math.abs(R.l - (T.l - p)), Math.abs(R.t - (T.t - p)), Math.abs(R.r - (T.r + p)), Math.abs(R.b - (T.b + p)));
      if (d > TOL) out.push('focus outline around "' + label(ft.target) + '" is off its target by ' + d.toFixed(1) + 'px');
      const tr = parseFloat(getComputedStyle(ft.target).borderTopLeftRadius) || 0, fr = parseFloat(cs.borderTopLeftRadius) || 0;
      if (Math.abs(fr - (tr + p)) > 1) out.push('focus outline around "' + label(ft.target) + '" does not follow its shape: corner radius ' + f(fr) + ', target ' + f(tr) + ' + pad ' + p);
    }
    if (MOTION) continue;
    for (const bar of sc.querySelectorAll('[data-ul]')) {
      seen.add(bar);
      const B = shown(bar); if (!B) continue;
      const tx = sc.querySelector('[data-ul-text="' + bar.dataset.ul + '"]'), I = tx && ink(tx);
      if (!I) { out.push('underline ' + bar.dataset.ul + ': no target text'); continue; }
      if (!fitsX(B, I)) out.push('underline under "' + label(tx) + '" does not match its text: ' + span(B, I));
      if (B.t < I.b - TOL - 4 || B.t > I.b + GAP) out.push('underline under "' + label(tx) + '" is not right under it: bar top ' + f(B.t) + ', text bottom ' + f(I.b));
    }
    for (const mb of sc.querySelectorAll('.mk > .mk-box')) {
      seen.add(mb);
      const B = shown(mb); if (!B) continue;
      const I = ink(mb.parentElement); if (!I) continue;
      const ov = Math.min(B.b, I.b) - Math.max(B.t, I.t);
      if (!fitsX(B, I) || ov < 0.5 * (I.b - I.t)) out.push('highlight behind "' + label(mb.parentElement) + '" does not match its text: ' + span(B, I) + ', y ' + f(B.t) + '-' + f(B.b) + ' vs ' + f(I.t) + '-' + f(I.b));
    }
    for (const sl of sc.querySelectorAll('.strike > .strike-line')) {
      seen.add(sl);
      const B = shown(sl); if (!B) continue;
      const I = ink(sl.parentElement); if (!I) continue;
      const cy = (B.t + B.b) / 2;
      if (!fitsX(B, I) || cy < I.t || cy > I.b) out.push('strike through "' + label(sl.parentElement) + '" does not match its text: ' + span(B, I));
    }
    // free thin bars right under a line of text; the runs of one visual line (same block, same bottom) are merged
    const rows = [];
    const w = document.createTreeWalker(sc, NodeFilter.SHOW_TEXT);
    for (let n; (n = w.nextNode());) {
      if (!n.textContent.trim() || eff(n.parentElement) < 0.05 || n.parentElement.closest('.acc-ink')) continue;
      let blk = n.parentElement; while (blk !== sc && getComputedStyle(blk).display === 'inline') blk = blk.parentElement;
      rg.selectNodeContents(n);
      for (const c of rg.getClientRects()) {
        if (c.width < 0.5 || c.height < 0.5) continue;
        const B = box(c), row = rows.find((r) => r.blk === blk && Math.abs(r.B.b - B.b) < 4);
        if (row) { row.B.l = Math.min(row.B.l, B.l); row.B.r = Math.max(row.B.r, B.r); row.B.t = Math.min(row.B.t, B.t); }
        else rows.push({ blk, B });
      }
    }
    for (const e of sc.querySelectorAll('*')) {
      if (seen.has(e) || e.children.length || e.closest('.ring, .links') || e.classList.contains('dbox-e')) continue;
      const cs = getComputedStyle(e);
      if (['transparent', 'rgba(0, 0, 0, 0)'].includes(cs.backgroundColor) && cs.backgroundImage === 'none') continue;
      const B = shown(e); if (!B) continue;
      const bw = B.r - B.l, bh = B.b - B.t;
      if (bh > 20 || bw < 24 || bw < 3 * bh) continue;
      const above = rows.filter((r) => r.B.r > B.l && r.B.l < B.r && B.t >= r.B.b - 6 && B.t <= r.B.b + 60)
        .sort((a, b) => (B.t - a.B.b) - (B.t - b.B.b))[0];
      if (above && !fitsX(B, above.B)) out.push('bar under "' + label(above.blk) + '" does not match its text: ' + span(B, above.B));
    }
  }
  return out;
})()`;
export const DECOR = decorExpr(false);

const pad2 = (n) => String(n).padStart(2, '0');
const uniq = (a) => [...new Set(a)];

export async function check(file, { script = null, out = null, force = false, browser = findBrowser(), log = (l) => process.stdout.write(l + '\n') } = {}) {
  file = resolve(file);
  out = resolve(out || join(dirname(file), `check-${basename(file, extname(file))}`));
  // the output folder holds an earlier run (or the user's files): refused before the browser starts, unless force
  if (!force && existsSync(out) && readdirSync(out).length) throw Object.assign(new Error(`${out} is not empty; not overwriting (use --force or another --out)`), { exit: 2 });
  const url = pathToFileURL(file).href;
  const results = [];
  const gate = (name, ok, detail, lines = []) => {
    results.push({ gate: name, ok, detail, lines });
    log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${detail}`);
    for (const l of lines.slice(0, 12)) log(`  ${l}`);
    if (lines.length > 12) log(`  ... ${lines.length - 12} more`);
  };
  const errors = [], requests = [];
  const b = await launch({
    browser,
    onEvent: (m, p) => {
      if (m === 'Runtime.exceptionThrown') errors.push('exception: ' + ((p.exceptionDetails.exception && p.exceptionDetails.exception.description) || p.exceptionDetails.text));
      else if (m === 'Runtime.consoleAPICalled' && (p.type === 'error' || p.type === 'assert')) errors.push('console.' + p.type + ': ' + p.args.map((a) => a.value != null ? a.value : a.description || '').join(' '));
      else if (m === 'Log.entryAdded' && p.entry.level === 'error') errors.push('log: ' + p.entry.text + (p.entry.url ? ' ' + p.entry.url : ''));
      else if (m === 'Network.requestWillBeSent') requests.push(p.request.url);
    },
  });
  try {
    const page = await b.open(null, { network: true });
    await page.goto(url);
    await page.settle();
    const info = await page.eval(`({ N: __deck.N, steps: __deck.steps, error: __deck.error, data: JSON.parse(document.getElementById('deck-data').textContent),
      stage: (() => { const r = document.getElementById('stage').getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; })() })`);
    if (info.error) errors.push('deck: ' + info.error);
    const clip = info.stage;
    const steps = info.steps;

    // step count
    let want = info.data.steps.length, from = 'the embedded script data';
    if (script) {
      const parsed = parseScript(readFileSync(script, 'utf8'));
      want = parsed.sections.reduce((a, s) => a + s.steps.length, 0);
      from = script;
    }
    gate('step-count', steps.length === want && steps.length > 0, `${steps.length} steps in the page, ${want} in ${from}`);

    // end states: layout, safe area, text size, stills and snapshots
    const lay = [], safe = [], small = [], report = [], decor = [];
    const stills = [], snaps = [];
    mkdirSync(join(out, 'stills'), { recursive: true });
    mkdirSync(join(out, 'snaps'), { recursive: true });
    const jumpShots = [];
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i], tag = `${pad2(i + 1)}-${s.id}`;
      await page.eval(`__deck.jump(${i})`);
      const L = await page.eval(LAYOUT);
      lay.push(...L.overflow.map((x) => `${s.id}: ${x}`));
      safe.push(...L.safe.map((x) => `${s.id}: ${x}`));
      small.push(...L.small.map((x) => `${s.id}: ${x}`));
      report.push(...L.report.map((x) => `${s.id}: ${x}`));
      decor.push(...(await page.eval(DECOR)).map((x) => `${s.id}: ${x}`));
      const still = join(out, 'stills', `${tag}.png`);
      jumpShots.push(await page.shot(still, clip));
      stills.push(still);
      const row = [];
      for (const [k, f] of [['a-first', 0.15], ['b-mid', 0.5], ['c-end', 1]]) {
        await page.eval(`__deck.seek(${s.start + (s.end - s.start) * f})`);
        const p = join(out, 'snaps', `${tag}-${k}.png`);
        await page.shot(p, clip);
        row.push(p);
      }
      snaps.push({ id: s.id, key: info.data.steps[i] ? info.data.steps[i].key : s.id, label: info.data.steps[i] ? info.data.steps[i].lines[0] || '' : '', files: row });
    }
    gate('layout', lay.length === 0, lay.length ? `${uniq(lay).length} problem(s)` : `text inside its box and nothing off the stage at ${steps.length} end states`, uniq(lay));
    gate('safe-area', safe.length === 0, safe.length ? `${uniq(safe).length} element(s) outside x ${SAFE.l}-${SAFE.r}, y ${SAFE.t}-${SAFE.b}` : `everything inside x ${SAFE.l}-${SAFE.r}, y ${SAFE.t}-${SAFE.b}`, uniq(safe));
    gate('decorations', decor.length === 0, decor.length ? `${uniq(decor).length} decoration(s) off their text or shape` : `underlines, highlights, strikes, focus outlines and bars under text fit their targets at ${steps.length} end states`, uniq(decor));
    gate('text-size', small.length === 0, `${uniq(small).length} text run(s) below ${MIN_PX}px, ${uniq(report).length} below ${REPORT_PX}px (report)`, uniq(small).concat(uniq(report).map((x) => `report: ${x}`)));

    // continuity: jump(i) == play(i) from step i-1 by the Next key
    const diffs = [];
    for (let i = 0; i < steps.length; i++) {
      if (i === 0) await page.eval('__deck.play(0)');
      else { await page.eval(`__deck.jump(${i - 1})`); await page.press('ArrowRight'); }
      const settled = await page.settle();
      const st = await page.eval('({ i: __deck.index, t: __deck.time })');
      const shot = await page.shot(null, clip);
      const d = diffPng(jumpShots[i], shot, PIXEL_TOL);
      diffs.push({ id: steps[i].id, settled, index: st.i, time: st.t, end: steps[i].end, max: d.max, count: d.count, share: d.share });
    }
    const badC = diffs.filter((d) => !d.settled || d.index !== diffs.indexOf(d) || Math.abs(d.time - d.end) > 1e-6 || d.share > SHARE_TOL);
    const maxDiff = Math.max(0, ...diffs.map((d) => d.max)), maxCount = Math.max(0, ...diffs.map((d) => d.count));
    gate('continuity', badC.length === 0, `jump == play for ${diffs.length - badC.length}/${diffs.length} steps (max channel diff ${maxDiff}, max pixels over ${PIXEL_TOL}: ${maxCount})`,
      diffs.map((d) => `${d.id}: max ${d.max}, pixels over ${PIXEL_TOL} ${d.count}${d.settled ? '' : ', did not settle'}${Math.abs(d.time - d.end) > 1e-6 ? `, time ${d.time} != end ${d.end}` : ''}`));

    // decorations in the played state: a second, non-16:9 viewport at a device pixel ratio other than 1; each step
    // is played by the Next key from the previous step's end, checked in the middle (shape rules) and at its end
    // (all rules). Frames go to played/NN-<id>-mid.png and -end.png.
    const pv = PLAY_VIEW, played = [];
    mkdirSync(join(out, 'played'), { recursive: true });
    const pp = await b.open(null, { width: pv.width, height: pv.height, dpr: pv.dpr });
    await b.send('Page.bringToFront', {}, pp.sessionId);
    await pp.goto(url + '#0');
    const pclip = await pp.eval(`(() => { const r = document.getElementById('stage').getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; })()`);
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i], tag = `${pad2(i + 1)}-${s.id}`, mid = (s.start + s.end) / 2;
      if (i === 0) await pp.eval('(__deck.seek(0), __deck.play(0))');
      else { await pp.eval(`__deck.jump(${i - 1})`); await pp.press('ArrowRight'); }
      for (let k = 0; k < 400 && (await pp.eval(`__deck.animating && __deck.time < ${mid}`)); k++) await new Promise((r) => setTimeout(r, 15));
      played.push(...(await pp.eval(decorExpr(true))).map((x) => `${s.id} (playing): ${x}`));
      await pp.shot(join(out, 'played', `${tag}-mid.png`), pclip);
      await pp.settle();
      played.push(...(await pp.eval(DECOR)).map((x) => `${s.id} (played end): ${x}`));
      await pp.shot(join(out, 'played', `${tag}-end.png`), pclip);
    }
    await pp.close();
    gate('decorations-played', played.length === 0, played.length ? `${uniq(played).length} problem(s) while playing at ${pv.width}x${pv.height}, pixel ratio ${pv.dpr}`
      : `focus outlines are one closed shape on their targets and no stretched sliver, mid and end of ${steps.length} played steps at ${pv.width}x${pv.height}, pixel ratio ${pv.dpr}`, uniq(played));

    // contact sheet: an HTML grid of the snapshots, screenshotted
    const rows = snaps.map((r) => `<div class="row"><div class="lab"><b>${r.key}</b><br>${String(r.label).replace(/[&<>]/g, '')}</div>${r.files.map((f) => `<img src="snaps/${basename(f)}">`).join('')}</div>`).join('\n');
    const sheet = join(out, 'contact-sheet.html');
    writeFileSync(sheet, `<!doctype html><meta charset="utf-8"><style>body{margin:0;padding:16px;background:#222;color:#ddd;font:16px sans-serif}
.head{display:grid;grid-template-columns:180px repeat(3,384px);gap:12px;margin-bottom:8px}.row{display:grid;grid-template-columns:180px repeat(3,384px);gap:12px;margin-bottom:12px}
img{width:384px;height:216px;display:block;outline:1px solid #444}.lab{overflow:hidden}</style>
<div class="head"><div>step</div><div>first (15%)</div><div>mid (50%)</div><div>end</div></div>${rows}`);
    const H = 16 * 2 + 30 + snaps.length * (216 + 12);
    const sp = await b.open(null, { width: 180 + 3 * 384 + 3 * 12 + 32, height: H });
    await b.send('Page.navigate', { url: pathToFileURL(sheet).href }, sp.sessionId);
    for (let k = 0; k < 100; k++) {
      if (await sp.eval(`document.readyState === 'complete' && [...document.images].every((i) => i.complete && i.naturalWidth > 0)`).catch(() => false)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const sheetPng = join(out, 'contact-sheet.png');
    await sp.shot(sheetPng);
    const nSnaps = snaps.reduce((a, r) => a + r.files.length, 0);
    gate('snapshots', stills.length === steps.length && nSnaps === 3 * steps.length, `${nSnaps} snapshots (first / mid / end), ${stills.length} stills for ${steps.length} steps, contact sheet ${sheetPng}`);

    // network and console last: everything above ran in the page
    const foreign = uniq(requests.filter((u) => u.split('#')[0] !== url.split('#')[0] && !/^(data|blob|about):/i.test(u)));
    gate('network', foreign.length === 0, `${foreign.length} request(s) other than the file itself`, foreign);
    gate('console-errors', errors.length === 0, `${errors.length} error(s)`, uniq(errors));
    const ok = results.every((r) => r.ok);
    writeFileSync(join(out, 'report.json'), JSON.stringify({ file, ok, results, continuity: diffs, stills, contactSheet: sheetPng }, null, 2));
    return { ok, results, out, continuity: diffs, contactSheet: sheetPng, stills };
  } finally {
    b.close();
  }
}

// real paths on both sides: node runs a script reached through a link (macOS /var is /private/var) by its real path
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  let file = null, script = null, out = null, force = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--script') script = resolve(argv[++i] || '');
    else if (argv[i] === '--out') out = resolve(argv[++i] || '');
    else if (argv[i] === '--force') force = true;
    else if (!argv[i].startsWith('--') && !file) file = argv[i];
    else { process.stderr.write(`check: unknown argument ${argv[i]}\n`); process.exit(2); }
  }
  if (!file) { process.stderr.write('usage: node scripts/check.mjs <deck.html> [--script <script.md>] [--out <dir>] [--force]\n'); process.exit(2); }
  if (!findBrowser()) { process.stderr.write('check: no Chrome, Edge or Chromium found; set CHROME to the browser executable\n'); process.exit(2); }
  try {
    const r = await check(file, { script, out, force });
    process.stdout.write(`${r.ok ? 'ALL PASS' : 'FAILED'} (${r.results.filter((x) => x.ok).length}/${r.results.length} gates) ${r.out}\n`);
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    process.stderr.write(`check: ${e.exit ? e.message : e.stack || e.message}\n`);
    process.exit(exitOf(e, 2));
  }
}
