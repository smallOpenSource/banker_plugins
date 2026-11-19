// pptx-anim-extract.mjs: what the editable deck is made from, read from the present page in a browser, one section
// (scene) at a time.
//   1. Rest layout: the scene alone with every translate, scale and rotate set to none and every opacity to 1
//      (author !important rules win over animations). Everything the scene can show is there at its rest place:
//      text lines (one item per line, block and animated owner), filled or bordered boxes, and picture fallbacks
//      (images, SVG, gradients, statically rotated elements). Each item has its motion element: the box or picture
//      element itself, for text the nearest animated element between the text and its block (else the block).
//   2. Time samples: the master timeline is seeked to each time (120 Hz across the section's steps, plus every
//      segment end and a time just before it, from __deck.segments()) and each item's state is measured: center,
//      scale, rotation (relative to rest), opacity (product of the chain up to the scene, the scene itself is the
//      slide transition) and the part left visible by overflow clipping ancestors.
//   3. Pictures: each fallback item alone on a transparent background, at rest.
// The page code is the function pageLib, sent as source (it may not use anything outside itself).
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { findBrowser, launch } from './cdp.mjs';

export const SAMPLE_HZ = 120;
// a sample this long before every segment end, so a jump (a zero-length segment) is seen as one
export const BEFORE = 1e-4;
// first step of a section after the first: the scene cross-fade starts the step, its own motion starts this much later
// (engine.js buildAll: t0 = base + 0.15 when there is a previous scene)
export const FIRST_STEP_DELAY = 0.15;
// columns of one measured state
export const COLS = ['cx', 'cy', 'sx', 'sy', 'rot', 'op', 'cl', 'ct', 'cr', 'cb'];

/* eslint-disable no-var */
export function pageLib() {
  var stage = document.getElementById('stage');
  var K = function () { return stage.getBoundingClientRect().width / 1920; };
  var cs = function (e) { return getComputedStyle(e); };
  var box = function (r) { var S = stage.getBoundingClientRect(), k = K(); return { x: (r.left - S.left) / k, y: (r.top - S.top) / k, w: r.width / k, h: r.height / k }; };
  var cur = null; // { scene, items, els }
  var cv = document.createElement('canvas'); cv.width = cv.height = 1;
  var cx = cv.getContext('2d', { willReadFrequently: true });
  function rgba(c) {
    if (!c || c === 'transparent') return null;
    cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#000'; cx.fillStyle = c; cx.fillRect(0, 0, 1, 1);
    var d = cx.getImageData(0, 0, 1, 1).data;
    return d[3] === 0 ? null : { hex: [d[0], d[1], d[2]].map(function (n) { return n.toString(16).padStart(2, '0'); }).join('').toUpperCase(), a: d[3] / 255 };
  }
  function what(e) {
    var c = typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\s+/).join('.') : '';
    return e.tagName.toLowerCase() + c + (e.dataset && e.dataset.r ? '[' + e.dataset.r + ']' : '');
  }
  function layoutStyle() {
    var st = document.getElementById('pgg-layout-style');
    if (st) return;
    st = document.createElement('style'); st.id = 'pgg-layout-style';
    st.textContent = 'html.pgg-layout #stage .scene.pgg-cur, html.pgg-layout #stage .scene.pgg-cur * { translate: none !important; scale: none !important; rotate: none !important; opacity: 1 !important; }'
      + ' html.pgg-layout #stage .scene:not(.pgg-cur) { visibility: hidden !important; }'
      + ' html.pgg-iso, html.pgg-iso body, html.pgg-iso #app, html.pgg-iso #viewport, html.pgg-iso .scene { background: transparent !important; }'
      + ' html.pgg-iso #stage * { visibility: hidden !important; } html.pgg-iso #stage [data-pgg-iso], html.pgg-iso #stage [data-pgg-iso] * { visibility: visible !important; }';
    document.head.appendChild(st);
  }
  function setLayout(on) {
    layoutStyle();
    document.querySelectorAll('.pgg-cur').forEach(function (s) { s.classList.remove('pgg-cur'); });
    if (on) cur.scene.classList.add('pgg-cur');
    document.documentElement.classList.toggle('pgg-layout', !!on);
  }
  function rotatedStatic(e) {
    for (var n = e; n && n !== cur.scene; n = n.parentElement) {
      var m = /matrix\(([^)]+)\)/.exec(cs(n).transform);
      if (m) { var v = m[1].split(',').map(parseFloat); if (Math.abs(v[1]) > 1e-6 || Math.abs(v[2]) > 1e-6) return true; }
    }
    return false;
  }
  function hiddenAt(e) {
    for (var n = e; n && n !== cur.scene; n = n.parentElement) { var s = cs(n); if (s.visibility === 'hidden' || s.display === 'none') return true; }
    return false;
  }
  function elIndex(e) {
    if (e.hasAttribute('data-pgg-e')) return +e.getAttribute('data-pgg-e');
    var i = cur.els.length;
    e.setAttribute('data-pgg-e', String(i));
    cur.els.push({ el: e, rect: box(e.getBoundingClientRect()) });
    return i;
  }
  function inConsumed(e) { for (var n = e; n && n !== cur.scene; n = n.parentElement) if (cur.consumed.has(n)) return true; return false; }
  function fallback(e, why) {
    var b = box(e.getBoundingClientRect());
    var x0 = Math.max(0, b.x - 2), y0 = Math.max(0, b.y - 2), x1 = Math.min(1920, b.x + b.w + 2), y1 = Math.min(1080, b.y + b.h + 2);
    cur.consumed.add(e);
    if (x1 - x0 < 1 || y1 - y0 < 1) return;
    var id = 'f' + cur.items.filter(function (x) { return x.kind === 'pic'; }).length;
    e.setAttribute('data-pgg-fb', id);
    cur.items.push({ kind: 'pic', id: id, x: x0, y: y0, w: x1 - x0, h: y1 - y0, what: what(e), why: why, e: elIndex(e) });
  }
  function glowOf(s) {
    var m = /^(.+?)\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+([\d.]+)px(?:\s+(-?[\d.]+)px)?$/.exec(s.boxShadow || '');
    if (!m || +m[2] !== 0 || +m[3] !== 0 || !(+m[4] > 0)) return null;
    var c = rgba(m[1]);
    return c ? { blur: +m[4], hex: c.hex, a: c.a } : null;
  }
  function sidesOf(s) {
    return ['Top', 'Right', 'Bottom', 'Left'].map(function (k) { return { w: parseFloat(s['border' + k + 'Width']) || 0, st: s['border' + k + 'Style'], c: rgba(s['border' + k + 'Color']) }; });
  }
  function borderBars(e, b, sides, scale) {
    var t = sides[0], rr = sides[1], bb = sides[2], l = sides[3];
    [[t, b.x, b.y, b.w, t.w * scale], [bb, b.x, b.y + b.h - bb.w * scale, b.w, bb.w * scale], [l, b.x, b.y, l.w * scale, b.h], [rr, b.x + b.w - rr.w * scale, b.y, rr.w * scale, b.h]].forEach(function (q) {
      var d = q[0];
      if (d.w > 0 && d.st !== 'none' && d.c) cur.items.push({ kind: 'box', x: q[1], y: q[2], w: q[3], h: q[4], rad: 0, what: what(e) + ' border', fill: { hex: d.c.hex, a: d.c.a }, line: null, glow: null, e: elIndex(e) });
    });
  }
  function boxItem(e, s, r) {
    var bg = rgba(s.backgroundColor), sides = sidesOf(s);
    var bw = sides.every(function (d) { return d.w === sides[0].w && d.st === sides[0].st && d.st !== 'none' && d.c; }) ? sides[0] : null;
    var some = sides.some(function (d) { return d.w > 0 && d.st !== 'none' && d.c; });
    if (!bg && !some) return;
    var b = box(r), scale = e.offsetWidth ? b.w / e.offsetWidth : 1;
    cur.items.push({ kind: 'box', x: b.x, y: b.y, w: b.w, h: b.h, rad: (parseFloat(s.borderTopLeftRadius) || 0) * scale, what: what(e),
      fill: bg ? { hex: bg.hex, a: bg.a } : null, line: bw ? { w: bw.w * scale, hex: bw.c.hex, a: bw.c.a } : null, glow: glowOf(s), e: elIndex(e) });
    if (some && !bw) borderBars(e, b, sides, scale);
  }
  function element(e) {
    if (inConsumed(e) || (e instanceof SVGElement && !(e instanceof SVGSVGElement)) || hiddenAt(e)) return;
    var r = e.getBoundingClientRect();
    if (r.width < 0.5 || r.height < 0.5) return;
    var s = cs(e);
    if (e.tagName === 'IMG' || e instanceof SVGSVGElement) return fallback(e, e.tagName === 'IMG' ? 'image' : 'svg');
    if (s.backgroundImage !== 'none') return fallback(e, 'background image or gradient');
    if (rotatedStatic(e)) return fallback(e, 'rotated');
    boxItem(e, s, r);
  }
  // the element whose motion a text node follows: the nearest animated one from its parent up to (not) the block
  function owner(p, blk) {
    for (var n = p; n && n !== blk; n = n.parentElement) if (cur.animated.has(n)) return n;
    return blk;
  }
  function blockOf(p) { var b = p; while (b !== cur.scene && cs(b).display === 'inline') b = b.parentElement; return b; }
  function charRuns(n, own, blk) {
    var s = cs(n.parentElement), col = rgba(s.color);
    if (!col) return;
    var scale = blk.offsetWidth ? blk.getBoundingClientRect().width / K() / blk.offsetWidth : 1;
    var rg = document.createRange(), str = n.data, line = null;
    for (var i = 0; i < str.length;) {
      var w = str.codePointAt(i) > 0xffff ? 2 : 1;
      rg.setStart(n, i); rg.setEnd(n, i + w);
      var ch = str.slice(i, i + w); i += w;
      var r = rg.getClientRects()[0];
      if (!r || (r.width === 0 && r.height === 0)) { if (line && /\s/.test(ch)) line.t += ' '; continue; }
      var b = box(r);
      if (!line || b.y > line.y + line.h * 0.5) { line = { t: '', x: b.x, y: b.y, r: b.x + b.w, b: b.y + b.h, h: b.h, blk: blk, own: own, ord: cur.items.length }; cur.lines.push(line); }
      line.t += ch; line.x = Math.min(line.x, b.x); line.r = Math.max(line.r, b.x + b.w); line.b = Math.max(line.b, b.y + b.h);
      line.run = { size: parseFloat(s.fontSize) * scale, bold: parseInt(s.fontWeight, 10) >= 600, hex: col.hex, a: col.a, ls: (parseFloat(s.letterSpacing) || 0) * scale };
    }
  }
  function textNode(n) {
    var p = n.parentElement;
    if (inConsumed(p) || hiddenAt(p)) return;
    var blk = blockOf(p);
    charRuns(n, owner(p, blk), blk);
  }
  function groupLines() {
    var groups = [];
    cur.lines.forEach(function (L) {
      if (!L.t.trim()) return;
      var g = groups.find(function (x) { return x.blk === L.blk && x.own === L.own && Math.abs(x.b - L.b) < 3; });
      if (g) { g.parts.push(L); g.x = Math.min(g.x, L.x); g.r = Math.max(g.r, L.r); g.y = Math.min(g.y, L.y); g.b = Math.max(g.b, L.b); }
      else groups.push({ blk: L.blk, own: L.own, x: L.x, r: L.r, y: L.y, b: L.b, ord: L.ord, parts: [L] });
    });
    return groups;
  }
  // text items go in right after the items painted before their first fragment (from the last position back)
  function placeText(groups) {
    groups.forEach(function (g, k) { g.k = k; });
    groups.sort(function (a, b) { return b.ord - a.ord || b.k - a.k; });
    groups.forEach(function (g) {
      g.parts.sort(function (a, b) { return a.x - b.x; });
      var ta = cs(g.blk).textAlign;
      var runs = g.parts.map(function (p) { return Object.assign({ t: p.t.replace(/\s+/g, ' ') }, p.run); });
      runs[0].t = runs[0].t.replace(/^\s+/, ''); runs[runs.length - 1].t = runs[runs.length - 1].t.replace(/\s+$/, '');
      cur.items.splice(g.ord, 0, { kind: 'text', x: g.x, y: g.y, w: g.r - g.x, h: g.b - g.y, runs: runs,
        align: ta === 'center' ? 'center' : ta === 'right' || ta === 'end' ? 'right' : 'left', what: what(g.blk), e: elIndex(g.own) });
    });
  }
  function segTimes(scene) {
    var out = [];
    __deck.segments().forEach(function (s) { if (s.el !== scene && scene.contains(s.el)) out.push(s.t0, s.t1); });
    return out;
  }
  /** The rest layout of section n: { bg, items, segTimes }. */
  function layout(n) {
    document.querySelectorAll('[data-pgg-e], [data-pgg-fb]').forEach(function (e) { e.removeAttribute('data-pgg-e'); e.removeAttribute('data-pgg-fb'); });
    var scene = stage.querySelector(':scope > .scene[data-section="' + n + '"]');
    var animated = new Set(__deck.segments().map(function (s) { return s.el; }));
    cur = { scene: scene, items: [], els: [], lines: [], consumed: new Set(), animated: animated };
    setLayout(true);
    var walker = document.createTreeWalker(scene, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    for (var nd = walker.nextNode(); nd; nd = walker.nextNode()) {
      if (nd.nodeType === 3) { if (nd.data.trim() && !(nd.parentElement instanceof SVGElement)) textNode(nd); } else element(nd);
    }
    placeText(groupLines());
    var bg = rgba(cs(scene).backgroundColor);
    setLayout(false);
    cur.items.forEach(function (it, k) { it.n = k + 1; });
    return { bg: bg ? bg.hex : '000000', items: cur.items, segTimes: segTimes(scene) };
  }
  function clipRect(e) {
    var c = null;
    for (var n = e.parentElement; n && n !== cur.scene; n = n.parentElement) {
      var s = cs(n);
      if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
      var b = box(n.getBoundingClientRect()), r = { l: b.x, t: b.y, r: b.x + b.w, b: b.y + b.h };
      c = c ? { l: Math.max(c.l, r.l), t: Math.max(c.t, r.t), r: Math.min(c.r, r.r), b: Math.min(c.b, r.b) } : r;
    }
    return c;
  }
  function chain(e) {
    var op = 1, rot = 0, sx = 1, sy = 1;
    for (var n = e; n && n !== cur.scene; n = n.parentElement) {
      var s = cs(n);
      if (s.visibility === 'hidden' || s.display === 'none') op = 0;
      op *= parseFloat(s.opacity);
      rot += parseFloat(s.rotate) || 0;
      var sc = s.scale === 'none' ? [1, 1] : s.scale.split(/\s+/).map(parseFloat);
      sx *= sc[0]; sy *= sc.length > 1 ? sc[1] : sc[0];
    }
    return { op: op, rot: rot, sx: sx, sy: sy };
  }
  function elState(i) {
    var E = cur.els[i], R = box(E.el.getBoundingClientRect()), B = E.rect, c = chain(E.el);
    var flat = Math.abs(c.rot) < 0.01;
    return { R: R, B: B, op: c.op, rot: c.rot, sx: flat && B.w > 0.5 ? R.w / B.w : c.sx, sy: flat && B.h > 0.5 ? R.h / B.h : c.sy, clip: clipRect(E.el) };
  }
  function visibleFrac(x0, y0, w, h, c) {
    if (!c || w < 1e-6 || h < 1e-6) return [0, 0, 1, 1];
    var f = function (v, a, len) { return Math.max(0, Math.min(1, (v - a) / len)); };
    var l = f(c.l, x0, w), t = f(c.t, y0, h), r = f(c.r, x0, w), b = f(c.b, y0, h);
    return r <= l || b <= t ? [0, 0, 0, 0] : [l, t, r, b];
  }
  function itemState(it, E) {
    var dx = it.x + it.w / 2 - (E.B.x + E.B.w / 2), dy = it.y + it.h / 2 - (E.B.y + E.B.h / 2);
    var a = E.rot * Math.PI / 180, ux = dx * E.sx, uy = dy * E.sy;
    var cx0 = E.R.x + E.R.w / 2 + ux * Math.cos(a) - uy * Math.sin(a), cy0 = E.R.y + E.R.h / 2 + ux * Math.sin(a) + uy * Math.cos(a);
    var w = it.w * E.sx, h = it.h * E.sy, v = visibleFrac(cx0 - w / 2, cy0 - h / 2, w, h, E.clip);
    var r = function (x, k) { return Math.round(x * k) / k; };
    return [r(cx0, 100), r(cy0, 100), r(E.sx, 1e6), r(E.sy, 1e6), r(E.rot, 1e3), r(E.op, 1e6), r(v[0], 1e5), r(v[1], 1e5), r(v[2], 1e5), r(v[3], 1e5)];
  }
  /** Seeks to each time and measures every item of the current layout: [[state per item] per time]. */
  function sample(times, keep) {
    var keepIdx = keep || cur.items.map(function (x, k) { return k; });
    return times.map(function (t) {
      __deck.seek(t);
      var es = cur.els.map(function (x, i) { return elState(i); });
      return keepIdx.map(function (k) { var it = cur.items[k]; return itemState(it, es[it.e]); });
    });
  }
  /** Shows only fallback picture id (or nothing: null) at rest on a transparent background. */
  function isolate(id) {
    document.querySelectorAll('[data-pgg-iso]').forEach(function (e) { e.removeAttribute('data-pgg-iso'); });
    setLayout(!!id);
    if (id) { document.querySelector('[data-pgg-fb="' + id + '"]').setAttribute('data-pgg-iso', '1'); document.documentElement.classList.add('pgg-iso'); }
    else document.documentElement.classList.remove('pgg-iso');
    return true;
  }
  function sections() { return JSON.parse(document.getElementById('deck-data').textContent).sections.map(function (s) { return { n: s.n, name: s.name, ids: s.ids }; }); }
  return { layout: layout, sample: sample, isolate: isolate, sections: sections };
}
/* eslint-enable no-var */

export const INSTALL = `(window.__pggX = (${pageLib.toString()})(), true)`;

/** Step windows of a section: [{ id, k, start, t0, end }] (t0: where the step's own motion starts). */
export function stepWindows(sec, steps, first) {
  return sec.ids.map((id, k) => {
    const s = steps.find((x) => x.id === id);
    return { id, k, start: s.start, t0: s.start + (k === 0 && !first ? FIRST_STEP_DELAY : 0), end: s.end };
  });
}

/** Sample times of a section: every 1/hz across its steps, each segment end and BEFORE it, sorted, unique (1e-7). */
export function sampleTimes(windows, segTimes, hz = SAMPLE_HZ) {
  const a = windows[0].start, b = windows[windows.length - 1].end, out = [];
  for (let t = a; t < b; t += 1 / hz) out.push(t);
  out.push(b);
  for (const w of windows) out.push(w.start, w.t0, w.end);
  for (const t of segTimes) if (t >= a - 1e-9 && t <= b + 1e-9) out.push(t, Math.max(a, t - BEFORE));
  out.sort((x, y) => x - y);
  return out.filter((t, i) => i === 0 || t - out[i - 1] > 1e-7).map((t) => Math.round(t * 1e7) / 1e7);
}

/** Opens the present page and installs the page code: { b, page, steps, sections }. */
export async function openDeck(html, { browser = findBrowser() } = {}) {
  const b = await launch({ browser });
  try {
    const page = await b.open(pathToFileURL(resolve(html)).href + '#0');
    await page.eval(INSTALL);
    return { b, page, steps: await page.eval('__deck.steps'), sections: await page.eval('__pggX.sections()') };
  } catch (e) {
    b.close();
    throw e;
  }
}

/** Measured states of the current layout at times (chunked); keep: item indexes (default all). */
export async function measure(page, times, keep = null) {
  const out = [];
  for (let i = 0; i < times.length; i += 240) out.push(...(await page.eval(`__pggX.sample(${JSON.stringify(times.slice(i, i + 240))}, ${JSON.stringify(keep)})`, 120000)));
  return out;
}

async function pictures(b, page, items) {
  const pics = {};
  if (!items.some((x) => x.kind === 'pic')) return pics;
  await b.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } }, page.sessionId);
  for (const it of items.filter((x) => x.kind === 'pic')) {
    await page.eval(`__pggX.isolate(${JSON.stringify(it.id)})`);
    pics[it.id] = await page.shot(null, { x: it.x, y: it.y, width: it.w, height: it.h });
  }
  await page.eval('__pggX.isolate(null)');
  await b.send('Emulation.setDefaultBackgroundColorOverride', {}, page.sessionId);
  return pics;
}

/** One section: { n, name, ids, windows, bg, items, times, states, pics }. */
export async function extractSection(deck, k) {
  const sec = deck.sections[k];
  const windows = stepWindows(sec, deck.steps, k === 0);
  const L = await deck.page.eval(`__pggX.layout(${sec.n})`);
  const times = sampleTimes(windows, L.segTimes);
  const states = await measure(deck.page, times);
  const pics = await pictures(deck.b, deck.page, L.items);
  return { n: sec.n, name: sec.name, ids: sec.ids, windows, bg: L.bg, items: L.items, times, states, pics };
}

/** Every section of the present page (see the top of this file). */
export async function extractDeck(html, { browser } = {}) {
  const deck = await openDeck(html, { browser });
  try {
    const out = [];
    for (let k = 0; k < deck.sections.length; k++) out.push(await extractSection(deck, k));
    return out;
  } finally {
    deck.b.close();
  }
}
