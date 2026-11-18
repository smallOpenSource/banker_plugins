#!/usr/bin/env node
// pptx-edit.mjs: an editable PowerPoint deck: one slide per step, its end state rebuilt from the page's DOM as native
// text boxes (one per rendered line, runs keep size, weight, color and opacity) and shapes (fills, borders, rounded
// corners). What cannot be native (images, SVG, gradients and hatches, rotated elements) becomes a picture cropped
// from a screenshot of that element alone on a transparent background; every fallback is listed. Notes = the step's
// spoken lines, then its [stage directions] apart; each slide has a unique hidden title. Theme fonts: Latin Noto Sans,
// East Asian Noto Sans KR (the fonts are not embedded: the viewing PC needs them installed).
//
//   node scripts/pptx-edit.mjs <present.html> <script.md> --out <file.pptx> [--force]
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deckData, parseScript, readText } from './build.mjs';
import { findBrowser, launch } from './cdp.mjs';
import { MASTER, PX, defineMaster, notesText, patchNotes, patchSlide, patchTheme, slideTitle, writeNew } from './pptx-common.mjs';
import { exitOf, pptxgen } from './vendor.mjs';

// evaluated in the page at a step's end state: { bg, items, fallbacks } in stage px, items in paint order
const EXTRACT = String.raw`(() => {
  const stage = document.getElementById('stage'), S = stage.getBoundingClientRect(), K = S.width / 1920;
  const box = (r) => ({ x: (r.left - S.left) / K, y: (r.top - S.top) / K, w: r.width / K, h: r.height / K });
  const cs = (e) => getComputedStyle(e);
  const eff = (e) => { let o = 1; for (let n = e; n && n !== stage; n = n.parentElement) { const s = cs(n);
    if (s.visibility === 'hidden' || s.display === 'none') return 0; o *= parseFloat(s.opacity); } return o; };
  const scene = [...stage.querySelectorAll(':scope > .scene')].find((s) => eff(s) > 0.5);
  if (!scene) return { error: 'no visible scene' };
  const cv = document.createElement('canvas'); cv.width = cv.height = 1;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  const rgba = (c) => {
    if (!c || c === 'transparent') return null;
    cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#000'; cx.fillStyle = c; cx.fillRect(0, 0, 1, 1);
    const d = cx.getImageData(0, 0, 1, 1).data;
    return d[3] === 0 ? null : { hex: [d[0], d[1], d[2]].map((n) => n.toString(16).padStart(2, '0')).join('').toUpperCase(), a: d[3] / 255 };
  };
  const rotated = (e) => { for (let n = e; n && n !== scene; n = n.parentElement) { const s = cs(n);
    if (s.rotate && s.rotate !== 'none' && parseFloat(s.rotate) !== 0) return true;
    const m = /matrix\(([^)]+)\)/.exec(s.transform); if (m) { const v = m[1].split(',').map(parseFloat); if (Math.abs(v[1]) > 1e-6 || Math.abs(v[2]) > 1e-6) return true; } } return false; };
  const what = (e) => e.tagName.toLowerCase() + (typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\s+/).join('.') : '') + (e.dataset && e.dataset.r ? '[' + e.dataset.r + ']' : '');
  const items = [], fallbacks = [], consumed = new Set();
  const inConsumed = (e) => { for (let n = e; n && n !== scene; n = n.parentElement) if (consumed.has(n)) return true; return false; };
  let fb = 0;
  const fallback = (e, why) => {
    const b = box(e.getBoundingClientRect());
    const x0 = Math.max(0, b.x - 2), y0 = Math.max(0, b.y - 2), x1 = Math.min(1920, b.x + b.w + 2), y1 = Math.min(1080, b.y + b.h + 2);
    consumed.add(e);
    if (x1 - x0 < 1 || y1 - y0 < 1) return;
    const id = 'f' + (fb++);
    e.setAttribute('data-pgg-fb', id);
    fallbacks.push({ id, what: what(e), why });
    items.push({ kind: 'pic', id, x: x0, y: y0, w: x1 - x0, h: y1 - y0, what: what(e), why });
  };
  // text: line fragments of each text node, merged per block and line below
  const lines = [];
  const textNode = (n) => {
    const p = n.parentElement, op = eff(p);
    if (op < 0.02 || inConsumed(p)) return;
    const accHost = p.querySelector(':scope > .acc-ink');
    if (accHost && eff(accHost) > 0.5) return; // the accent copy covers this text and is drawn instead
    const s = cs(p), col = rgba(s.color);
    if (!col) return;
    let blk = p; while (blk !== scene && cs(blk).display === 'inline') blk = blk.parentElement;
    const scale = blk.offsetWidth ? blk.getBoundingClientRect().width / K / blk.offsetWidth : 1;
    const rg = document.createRange(), str = n.data;
    let cur = null;
    for (let i = 0; i < str.length;) {
      const cp = str.codePointAt(i), w = cp > 0xffff ? 2 : 1;
      rg.setStart(n, i); rg.setEnd(n, i + w);
      const ch = str.slice(i, i + w); i += w;
      const r = rg.getClientRects()[0];
      if (!r || (r.width === 0 && r.height === 0)) { if (cur && /\s/.test(ch)) cur.t += ' '; continue; }
      const b = box(r);
      if (!cur || b.y > cur.y + cur.h * 0.5) { cur = { t: '', x: b.x, y: b.y, r: b.x + b.w, b: b.y + b.h, h: b.h, blk, ord: items.length }; lines.push(Object.assign(cur, { run: null })); }
      cur.t += ch; cur.x = Math.min(cur.x, b.x); cur.r = Math.max(cur.r, b.x + b.w); cur.b = Math.max(cur.b, b.y + b.h);
      cur.run = { size: parseFloat(s.fontSize) * scale, bold: parseInt(s.fontWeight, 10) >= 600, hex: col.hex, a: col.a * op };
    }
  };
  const walker = document.createTreeWalker(scene, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === 3) { if (n.data.trim() && !(n.parentElement instanceof SVGElement)) textNode(n); continue; }
    const e = n;
    if (inConsumed(e) || e instanceof SVGElement && !(e instanceof SVGSVGElement)) continue;
    const op = eff(e);
    if (op < 0.02) continue;
    const r = e.getBoundingClientRect();
    if (r.width < 0.5 || r.height < 0.5) continue;
    const s = cs(e);
    if (e.tagName === 'IMG' || e instanceof SVGSVGElement) { fallback(e, e.tagName === 'IMG' ? 'image' : 'svg'); continue; }
    if (s.backgroundImage !== 'none') { fallback(e, 'background image or gradient'); continue; }
    if (rotated(e)) { fallback(e, 'rotated'); continue; }
    if (e.classList.contains('acc-ink')) continue; // its text is drawn by textNode
    const bg = rgba(s.backgroundColor);
    const sides = ['Top', 'Right', 'Bottom', 'Left'].map((k) => ({ w: parseFloat(s['border' + k + 'Width']) || 0, st: s['border' + k + 'Style'], c: rgba(s['border' + k + 'Color']) }));
    const bw = sides.every((d) => d.w === sides[0].w && d.st === sides[0].st && d.st !== 'none' && d.c) ? sides[0] : null;
    const someBorder = sides.some((d) => d.w > 0 && d.st !== 'none' && d.c);
    if (!bg && !someBorder) continue;
    const b = box(r), scale = e.offsetWidth ? b.w / e.offsetWidth : 1;
    const it = { kind: 'box', x: b.x, y: b.y, w: b.w, h: b.h, rad: (parseFloat(s.borderTopLeftRadius) || 0) * scale, what: what(e),
      fill: bg ? { hex: bg.hex, a: bg.a * op } : null, line: bw ? { w: bw.w * scale, hex: bw.c.hex, a: bw.c.a * op } : null };
    items.push(it);
    if (someBorder && !bw) {
      // sides drawn as bars (no radius)
      const [t, rr, bb, l] = sides;
      for (const [d, x, y, w, h] of [[t, b.x, b.y, b.w, t.w * scale], [bb, b.x, b.y + b.h - bb.w * scale, b.w, bb.w * scale], [l, b.x, b.y, l.w * scale, b.h], [rr, b.x + b.w - rr.w * scale, b.y, rr.w * scale, b.h]]) {
        if (d.w > 0 && d.st !== 'none' && d.c) items.push({ kind: 'box', x, y, w, h, rad: 0, what: what(e) + ' border', fill: { hex: d.c.hex, a: d.c.a * op }, line: null });
      }
    }
  }
  // merge line fragments of one block and one line into text items (runs left to right), placed by first fragment order
  const groups = [];
  for (const L of lines) {
    if (!L.t.trim()) continue;
    const g = groups.find((x) => x.blk === L.blk && Math.abs(x.b - L.b) < 3);
    if (g) { g.parts.push(L); g.x = Math.min(g.x, L.x); g.r = Math.max(g.r, L.r); g.y = Math.min(g.y, L.y); g.b = Math.max(g.b, L.b); }
    else groups.push({ blk: L.blk, x: L.x, r: L.r, y: L.y, b: L.b, ord: L.ord, parts: [L] });
  }
  // insert from the last position back, so each text lands right after the items painted before it
  groups.forEach((g, k) => { g.k = k; });
  groups.sort((a, b) => b.ord - a.ord || b.k - a.k);
  for (const g of groups) {
    g.parts.sort((a, b) => a.x - b.x);
    const ta = cs(g.blk).textAlign;
    const runs = g.parts.map((p) => Object.assign({ t: p.t.replace(/\s+/g, ' ') }, p.run));
    runs[0].t = runs[0].t.replace(/^\s+/, ''); runs[runs.length - 1].t = runs[runs.length - 1].t.replace(/\s+$/, '');
    items.splice(g.ord, 0, { kind: 'text', x: g.x, y: g.y, w: g.r - g.x, h: g.b - g.y, runs, align: ta === 'center' ? 'center' : ta === 'right' || ta === 'end' ? 'right' : 'left', what: what(g.blk) });
  }
  const bgc = rgba(cs(scene).backgroundColor);
  return { bg: bgc ? bgc.hex : '000000', items, fallbacks };
})()`;

const ISOLATE = (id) => `(() => {
  let st = document.getElementById('pgg-iso-style');
  if (!st) { st = document.createElement('style'); st.id = 'pgg-iso-style'; document.head.appendChild(st);
    st.textContent = 'html.pgg-iso, html.pgg-iso body, html.pgg-iso #app, html.pgg-iso #viewport, html.pgg-iso .scene { background: transparent !important; }'
      + ' html.pgg-iso #stage * { visibility: hidden !important; } html.pgg-iso #stage [data-pgg-iso], html.pgg-iso #stage [data-pgg-iso] * { visibility: visible !important; }'; }
  document.querySelectorAll('[data-pgg-iso]').forEach((e) => e.removeAttribute('data-pgg-iso'));
  ${id ? `document.querySelector('[data-pgg-fb="${id}"]').setAttribute('data-pgg-iso', '1'); document.documentElement.classList.add('pgg-iso');` : "document.documentElement.classList.remove('pgg-iso');"}
  return true;
})()`;

const IN = (px) => px * PX;
const PT = (px) => px / 2; // 1920 px = 13.333 in = 960 pt

/** Reads every step's end state from the present page: [{ bg, items, pics: { id: png } , fallbacks }]. */
export async function extract(html, { browser = findBrowser() } = {}) {
  const b = await launch({ browser });
  try {
    const page = await b.open(pathToFileURL(resolve(html)).href + '#0');
    const steps = await page.eval('__deck.steps');
    const out = [];
    for (let i = 0; i < steps.length; i++) {
      await page.eval(`(document.querySelectorAll('[data-pgg-fb]').forEach((e) => e.removeAttribute('data-pgg-fb')), __deck.jump(${i}))`);
      const r = await page.eval(EXTRACT);
      if (r.error) throw new Error(`step ${steps[i].id}: ${r.error}`);
      r.pics = {};
      if (r.fallbacks.length) {
        await b.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } }, page.sessionId);
        for (const it of r.items.filter((x) => x.kind === 'pic')) {
          await page.eval(ISOLATE(it.id));
          r.pics[it.id] = await page.shot(null, { x: it.x, y: it.y, width: it.w, height: it.h });
        }
        await page.eval(ISOLATE(null));
        await b.send('Emulation.setDefaultBackgroundColorOverride', {}, page.sessionId);
      }
      out.push(Object.assign(r, { id: steps[i].id }));
    }
    return out;
  } finally {
    b.close();
  }
}

const alpha = (a) => Math.round((1 - Math.max(0, Math.min(1, a))) * 100);

/** Builds the editable deck. Returns { out, bytes, slides, fallbacks: [{ step, what, why }] }. */
export async function buildEditPptx({ html, parsed, out, force = false, browser }) {
  const data = deckData(parsed, 'review');
  const states = await extract(html, { browser });
  if (states.length !== data.steps.length) throw new Error(`${states.length} step states in the page, ${data.steps.length} steps in the script`);
  const { PptxGenJS, JSZip } = pptxgen();
  const p = new PptxGenJS();
  p.layout = 'LAYOUT_WIDE';
  p.title = data.title;
  p.author = 'presentation-graphic-gen';
  p.company = '';
  p.theme = { headFontFace: 'Noto Sans', bodyFontFace: 'Noto Sans' };
  defineMaster(p);
  const fallbacks = [];
  data.steps.forEach((st, i) => {
    const S = states[i];
    if (S.id !== st.id) throw new Error(`slide ${i + 1}: page step ${S.id}, script step ${st.id}`);
    const s = p.addSlide({ masterName: MASTER });
    s.background = { color: S.bg };
    s.addText(slideTitle(st), { placeholder: 'title' });
    for (const it of S.items) {
      const pos = { x: IN(it.x), y: IN(it.y), w: IN(Math.max(it.w, 0.5)), h: IN(Math.max(it.h, 0.5)) };
      if (it.kind === 'box') {
        // a CSS border lies inside the box, a PowerPoint outline is centered on the shape edge: inset by half the line
        const h = it.line ? it.line.w / 2 : 0;
        const o = { x: IN(it.x + h), y: IN(it.y + h), w: IN(Math.max(it.w - 2 * h, 0.5)), h: IN(Math.max(it.h - 2 * h, 0.5)), objectName: `shape ${it.what}`,
          fill: it.fill ? { color: it.fill.hex, transparency: alpha(it.fill.a) } : undefined, // undefined: PptxGenJS writes <a:noFill/>
          line: it.line ? { color: it.line.hex, width: PT(it.line.w), transparency: alpha(it.line.a) } : undefined };
        const rad = it.rad - h;
        if (rad > 0.5) { o.rectRadius = IN(Math.min(rad, Math.min(it.w, it.h) / 2)); s.addShape(p.ShapeType.roundRect, o); }
        else s.addShape(p.ShapeType.rect, o);
      } else if (it.kind === 'text') {
        // the box is the rendered line, a little wider so PowerPoint's metrics never wrap or clip it
        const pad = it.w * 0.04 + 4;
        const x = it.align === 'center' ? it.x - pad / 2 : it.align === 'right' ? it.x - pad : it.x;
        s.addText(it.runs.map((r) => ({ text: r.t, options: { fontSize: PT(r.size), bold: r.bold, color: r.hex, transparency: alpha(r.a), lang: 'ko-KR' } })),
          { x: IN(x), y: IN(it.y), w: IN(it.w + pad), h: IN(it.h), margin: 0, valign: 'middle', align: it.align, wrap: false, fit: 'none', objectName: `text ${it.what}` });
      } else if (it.kind === 'pic') {
        s.addImage({ data: `image/png;base64,${S.pics[it.id].toString('base64')}`, ...pos, altText: `${it.what} (${it.why})`, objectName: `picture ${it.what}` });
        fallbacks.push({ step: st.id, what: it.what, why: it.why });
      }
    }
    s.addNotes(notesText(st));
  });
  const raw = await p.write({ outputType: 'nodebuffer', compression: false });
  const zip = await JSZip.loadAsync(raw);
  for (const name of Object.keys(zip.files)) {
    if (/^ppt\/slides\/slide\d+\.xml$/.test(name)) zip.file(name, patchSlide(await zip.file(name).async('string')).xml);
    else if (/^ppt\/theme\/theme\d+\.xml$/.test(name)) zip.file(name, patchTheme(await zip.file(name).async('string')));
    else if (/^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name)) zip.file(name, patchNotes(await zip.file(name).async('string')));
  }
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  writeNew(out, bytes, force);
  return { out, bytes: bytes.length, slides: data.steps.length, fallbacks };
}

// real paths on both sides: node runs a script reached through a link (macOS /var is /private/var) by its real path.
// A name realpath cannot read (argv[1] of `node -e`, for one) is compared as given, so importing this file never throws.
const ranAs = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
if (process.argv[1] && ranAs(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  let html = null, script = null, out = null, force = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out = resolve(argv[++i] || '');
    else if (argv[i] === '--force') force = true;
    else if (!argv[i].startsWith('--') && !html) html = resolve(argv[i]);
    else if (!argv[i].startsWith('--') && !script) script = resolve(argv[i]);
    else { process.stderr.write(`pptx-edit: unknown argument ${argv[i]}\n`); process.exit(2); }
  }
  if (!html || !script || !out) { process.stderr.write('usage: node scripts/pptx-edit.mjs <present.html> <script.md> --out <file.pptx> [--force]\n'); process.exit(2); }
  if (!findBrowser()) { process.stderr.write('pptx-edit: no Chrome, Edge or Chromium found; set CHROME to the browser executable\n'); process.exit(2); }
  try {
    const parsed = parseScript(readText(script));
    if (parsed.errors.length) throw Object.assign(new Error(parsed.errors.join('; ')), { exit: 1 });
    const r = await buildEditPptx({ html, parsed, out, force });
    process.stdout.write(`pptx-edit ${r.out} ${r.slides} slides ${(r.bytes / 1048576).toFixed(1)} MiB, ${r.fallbacks.length} picture fallback(s)\n`);
    for (const f of r.fallbacks) process.stdout.write(`  fallback ${f.step}: ${f.what} (${f.why})\n`);
  } catch (e) {
    process.stderr.write(`pptx-edit: ${e.message}\n`);
    process.exit(exitOf(e, 1));
  }
}
