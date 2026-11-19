// pptx-anim-plan.mjs: the measured time series of one section (pptx-anim-extract.mjs) as a plan of PowerPoint effects,
// one slide per section and one click group per step (the first group starts by itself after the slide transition).
//   - Opacity: each monotone change of an item's opacity is an entrance (0 to a level), an exit (to 0) or a partial
//     change (level to level). A change in one sample interval is Appear / Disappear, otherwise Fade with the
//     accel / decel that fits the page's curve best (the largest error is kept).
//   - Partial opacity (PARTIAL, the one switch): 'crossfade' (default; only effects known to play) gives the item one
//     shape per opacity level (copies at 35% and so on, named #n@35) and crosses them with Fade out + Fade in.
//     'anim' (style.opacity p:anim from / to) and 'emph' (Transparency emphasis) keep one shape; which one PowerPoint
//     plays smoothly is the stage-0 question (pptx-anim-probe.mjs P05 to P07).
//   - Clipping: a part revealed from one edge to the whole (s.reveal) is a Wipe entrance from that edge.
//   - Geometry: center, size and rotation relative to rest, as sampled keyframes (reduced to 0.3 px) on ppt_x,
//     ppt_y, ppt_w, ppt_h and r inside the item's effect of that step, or in a motion effect of its own (MOTION).
//     Values are relative to the shape's rest place (#ppt_x + dx), so a shape moved by hand keeps its motion.
// The plan is checked by an independent simulator (pptx-anim-sim.mjs), never by this code.
import { COLS } from './pptx-anim-extract.mjs';
import { shapeRect } from './pptx-common.mjs';

export const PARTIAL = 'crossfade'; // 'crossfade' | 'anim' | 'emph'
export const PRESET = { fade: 10, appear: 1, wipe: 22, transp: 9 };
export const MOTION = { cls: 'emph', preset: 0 }; // a geometry-only effect (P12a: PowerPoint shows it as custom)
const OP_EPS = 2e-6, ZERO = 0.005, INSTANT = 0.002, MATCH = 0.01;
const GEO = [ // attribute, series, change eps, keyframe tolerance (null: px / size), value
  ['ppt_x', 'dx', 0.001, () => 0.3, (v) => v / 1920],
  ['ppt_y', 'dy', 0.001, () => 0.3, (v) => v / 1080],
  ['ppt_w', 'sx', 2e-6, (r) => 0.3 / Math.max(r.w, 1), (v) => v],
  ['ppt_h', 'sy', 2e-6, (r) => 0.3 / Math.max(r.h, 1), (v) => v],
  ['r', 'rot', 5e-4, () => 0.05, (v) => v],
];
export const lvl = (v) => (v < ZERO ? 0 : Math.round(v * 100) / 100);

/** SMIL accel / decel: progress at normalized time u (trapezoid speed, accel a and decel d as fractions). */
export function easeAD(u, a, d) {
  const r = 1 / (1 - a / 2 - d / 2);
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  if (u < a) return (r * u * u) / (2 * a);
  if (u <= 1 - d) return r * (u - a / 2);
  return 1 - (r * (1 - u) * (1 - u)) / (2 * d);
}

// progress of a fit p = { s, e, a, d } at normalized time u: the fade runs from s to e (fractions of the change) with
// accel a and decel d, so a curve that settles early (an ease-out) is matched by a shorter fade
export const fitProgress = (u, p) => easeAD((u - p.s) / (p.e - p.s), p.a, p.d);
function fitErr(us, qs, p, stop) {
  let err = 0;
  for (let i = 0; i < us.length && err < stop; i++) err = Math.max(err, Math.abs(qs[i] - fitProgress(us[i], p)));
  return err;
}
const fitOk = (p) => p.e - p.s >= 0.05 && p.a + p.d <= 1 + 1e-9 && Math.min(p.a, p.d, p.s) >= 0 && p.e <= 1;
function fitGrid(us, qs, best, ss, es, as) {
  const all = ss.flatMap((s) => es.flatMap((e) => as.flatMap((a) => as.map((d) => ({ s, e, a, d }))))).filter(fitOk);
  for (const p of all) {
    const err = fitErr(us, qs, p, best.err);
    if (err < best.err) best = Object.assign(p, { err });
  }
  return best;
}
const steps = (from, to, by) => { const out = []; for (let v = from; v <= to + 1e-9; v += by) out.push(Math.round(v * 1000) / 1000); return out; };

/** The fade window and accel / decel whose progress is closest to qs at us: { s, e, a, d, err } (err: largest |q - p|). */
export function fitEase(us, qs) {
  let best = fitGrid(us, qs, { s: 0, e: 1, a: 0, d: 0, err: fitErr(us, qs, { s: 0, e: 1, a: 0, d: 0 }, Infinity) }, steps(0, 0.5, 0.1), steps(0.5, 1, 0.1), steps(0, 1, 0.1));
  const near = (v, by, lo, hi) => steps(Math.max(lo, v - 2 * by), Math.min(hi, v + 2 * by), by);
  best = fitGrid(us, qs, best, near(best.s, 0.025, 0, 0.5), near(best.e, 0.025, 0.5, 1), near(best.a, 0.05, 0, 1).filter((v) => v <= 1));
  return fitGrid(us, qs, best, [best.s], [best.e], steps(0, 1, 0.05));
}

/** Monotone runs of change (more than eps between two samples): [{ a, b }] sample indexes. A flat stretch of at most
 * gap seconds inside one direction (a slow tail, a sample just before a segment end) does not end a run. */
export function monoRuns(T, v, eps, gap = 0.05) {
  const out = [];
  let run = null;
  for (let i = 0; i + 1 < v.length; i++) {
    const d = v[i + 1] - v[i];
    if (Math.abs(d) <= eps) continue;
    const s = Math.sign(d);
    if (run && s === run.s && T[i] - T[run.b] <= gap) run.b = i + 1;
    else { run = { a: i, b: i + 1, s }; out.push(run); }
  }
  return out;
}

/** Ramer-Douglas-Peucker on (t, v) between i0 and i1: the kept sample indexes (both ends always). */
export function reduceKeys(T, v, i0, i1, tol) {
  const keep = new Set([i0, i1]);
  const stack = [[i0, i1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let far = -1, dist = tol;
    for (let i = a + 1; i < b; i++) {
      const lin = v[a] + ((v[b] - v[a]) * (T[i] - T[a])) / (T[b] - T[a] || 1);
      if (Math.abs(v[i] - lin) > dist) { dist = Math.abs(v[i] - lin); far = i; }
    }
    if (far >= 0) { keep.add(far); stack.push([a, far], [far, b]); }
  }
  return [...keep].sort((x, y) => x - y);
}

function seriesOf(S, k) {
  const o = { T: S.times };
  COLS.forEach((c, j) => { o[c] = S.states.map((r) => r[k][j]); });
  o.frac = o.T.map((_, i) => Math.max(0, o.cr[i] - o.cl[i]) * Math.max(0, o.cb[i] - o.ct[i]));
  return o;
}
// drawn at all: some width, some height, some part not clipped away
const shows = (s, it, i) => s.sx[i] * it.w > 1e-3 && s.sy[i] * it.h > 1e-3 && s.frac[i] > 0;

// the shape's center offset from rest (px): the item center now, less the rotated, scaled offset of the item in its shape
function shapeSeries(s, it) {
  const R = shapeRect(it), ox = it.x + it.w / 2 - (R.x + R.w / 2), oy = it.y + it.h / 2 - (R.y + R.h / 2);
  const rx = R.x + R.w / 2, ry = R.y + R.h / 2;
  s.dx = s.T.map((_, i) => { const a = (s.rot[i] * Math.PI) / 180; return s.cx[i] - (ox * s.sx[i] * Math.cos(a) - oy * s.sy[i] * Math.sin(a)) - rx; });
  s.dy = s.T.map((_, i) => { const a = (s.rot[i] * Math.PI) / 180; return s.cy[i] - (ox * s.sx[i] * Math.sin(a) + oy * s.sy[i] * Math.cos(a)) - ry; });
  return R;
}

// ---------- opacity and clipping events ----------
function fadeFit(s, a, b, key, A, B) {
  const t0 = s.T[a], t1 = s.T[b], us = [], qs = [];
  for (let i = a; i <= b; i++) { us.push((s.T[i] - t0) / (t1 - t0 || 1)); qs.push((s[key][i] - A) / (B - A || 1)); }
  return fitEase(us, qs);
}
function opacityEvents(s) {
  return monoRuns(s.T, s.op, OP_EPS).map(({ a, b }) => ({ a, b, t0: s.T[a], t1: s.T[b], A: lvl(s.op[a]), B: lvl(s.op[b]) }))
    .filter((e) => e.A !== e.B)
    .map((e) => Object.assign(e, { kind: e.A === 0 ? 'in' : e.B === 0 ? 'out' : 'partial', instant: e.t1 - e.t0 < INSTANT,
      ease: e.t1 - e.t0 < INSTANT ? { s: 0, e: 1, a: 0, d: 0, err: 0 } : fadeFit(s, e.a, e.b, 'op', s.op[e.a], s.op[e.b]) }));
}
// a shape that is not drawn at the start although its opacity is above 0 (zero size, clipped away) enters when drawn
function gateEvent(s, it) {
  if (!(s.op[0] > ZERO) || shows(s, it, 0)) return null;
  const i = s.T.findIndex((_, j) => s.op[j] > ZERO && shows(s, it, j));
  return i < 1 ? null : { a: i - 1, b: i - 1, t0: s.T[i - 1], t1: s.T[i - 1], A: 0, B: lvl(s.op[i]), kind: 'in', instant: true, gate: true, ease: { s: 0, e: 1, a: 0, d: 0, err: 0 } };
}
// edge a reveal grows from: the visible part at sample i touches that edge only
function sideAt(s, i) {
  const at0 = (v) => v < 0.02, at1 = (v) => v > 0.98;
  if (at0(s.cl[i]) && !at1(s.cr[i])) return 'left';
  if (at1(s.cr[i]) && !at0(s.cl[i])) return 'right';
  if (at0(s.ct[i]) && !at1(s.cb[i])) return 'top';
  if (at1(s.cb[i]) && !at0(s.ct[i])) return 'bottom';
  return null;
}
const OPP = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' };
// a picture's crop is 2 px wider than its element, so fully shown is a little under 1
const clipKind = (A, B) => (A < 0.02 && B > 0.95 ? 'in' : A > 0.95 && B < 0.02 ? 'out' : 'clip');
function clipEvent(s, a, b) {
  const A = s.frac[a], B = s.frac[b], kind = clipKind(A, B);
  const side = kind === 'in' ? sideAt(s, a + 1) : kind === 'out' ? OPP[sideAt(s, b - 1)] || null : null;
  return { a, b, t0: s.T[a], t1: s.T[b], kind: side ? kind : 'clip', side, ease: fadeFit(s, a, b, 'frac', A, B) };
}
// changes of the visible part (under 0.005: noise)
function clipEvents(s) {
  return monoRuns(s.T, s.frac, 1e-4).filter(({ a, b }) => Math.abs(s.frac[b] - s.frac[a]) >= 0.005).map(({ a, b }) => clipEvent(s, a, b));
}
// a reveal from an edge joins the entrance (or exit) at its start (end); other clip changes cannot be shown
function mergeClips(evs, clips, notes) {
  for (const c of clips) {
    const e = c.kind === 'in' ? evs.find((x) => x.kind === 'in' && Math.abs(x.t1 - c.t0) <= MATCH)
      : c.kind === 'out' ? evs.find((x) => x.kind === 'out' && Math.abs(x.t0 - c.t1) <= MATCH) : null;
    if (e) { e.wipe = c; continue; }
    notes.push({ t: c.t0, cat: 'impossible', what: `clip ${c.kind === 'clip' ? 'change' : c.kind} ${(c.t1 - c.t0).toFixed(2)} s not from an edge to the whole: shown unclipped` });
  }
}

// ---------- shapes and their effects ----------
function levelsOf(evs, vis0, op0) {
  const set = new Set(vis0 ? [lvl(op0)] : []);
  for (const e of evs) { if (e.A) set.add(e.A); if (e.B) set.add(e.B); }
  return PARTIAL === 'crossfade' ? [...set].sort((x, y) => y - x) : set.size ? [1] : [];
}
const pct = (v) => `${Math.round(v * 100)}%`;
const how = (q) => `${q.s || q.e < 1 ? `${pct(q.s)}-${pct(q.e)} of the time, ` : ''}accel ${pct(q.a)} decel ${pct(q.d)}`;
// the fitted part of a change: { t0, t1 } in page seconds
const span = (c) => ({ t0: c.t0 + c.ease.s * (c.t1 - c.t0), t1: c.t0 + c.ease.e * (c.t1 - c.t0) });
const motion = (b, dir, c, extra = {}) => Object.assign({ b, dir }, span(c), { ease: { a: c.ease.a, d: c.ease.d } }, extra);
function entrance(e, copy) {
  if (e.wipe) { const w = span(e.wipe); return { cls: 'entr', preset: PRESET.wipe, side: e.wipe.side, bh: [{ b: 'set', to: 'visible', t: w.t0 }, motion('wipe', 'in', e.wipe, { side: e.wipe.side })] }; }
  const t = e.instant ? e.t0 : span(e).t0;
  const bh = [{ b: 'set', to: 'visible', t }];
  if (PARTIAL !== 'crossfade' && copy.level === 1 && e.B !== 1) bh.push({ b: 'setop', to: e.B, t });
  if (e.instant) return { cls: 'entr', preset: PRESET.appear, bh };
  return { cls: 'entr', preset: PRESET.fade, bh: bh.concat(motion('fade', 'in', e)) };
}
function exit(e) {
  if (e.wipe) { const w = span(e.wipe); return { cls: 'exit', preset: PRESET.wipe, side: e.wipe.side, bh: [motion('wipe', 'out', e.wipe, { side: e.wipe.side }), { b: 'set', to: 'hidden', t: Math.max(w.t0, w.t1 - 0.001) }] }; }
  if (e.instant) return { cls: 'exit', preset: PRESET.appear, bh: [{ b: 'set', to: 'hidden', t: e.t1 }] };
  const f = motion('fade', 'out', e);
  return { cls: 'exit', preset: PRESET.fade, bh: [f, { b: 'set', to: 'hidden', t: Math.max(f.t0, f.t1 - 0.001) }] };
}
function partialOne(e) {
  const f = span(e), t1 = Math.max(f.t1, f.t0 + 0.001);
  if (PARTIAL === 'emph') return { cls: 'emph', preset: PRESET.transp, bh: [{ b: 'transp', to: e.B, t0: f.t0, t1, ease: { a: e.ease.a, d: e.ease.d } }] };
  return { cls: MOTION.cls, preset: MOTION.preset, bh: [{ b: 'opacity', from: e.A, to: e.B, t0: f.t0, t1, ease: { a: e.ease.a, d: e.ease.d } }] };
}
// the effects one opacity event gives each shape of the item: [{ copy, fx }]
function eventEffects(e, copies) {
  const at = (L) => copies.find((c) => c.level === L);
  if (PARTIAL !== 'crossfade') return [{ copy: copies[0], fx: e.kind === 'in' ? entrance(e, copies[0]) : e.kind === 'out' ? exit(e) : partialOne(e) }];
  const out = [];
  if (e.A) out.push({ copy: at(e.A), fx: exit(Object.assign({}, e, { wipe: e.kind === 'out' ? e.wipe : null })) });
  if (e.B) out.push({ copy: at(e.B), fx: entrance(Object.assign({}, e, { wipe: e.kind === 'in' ? e.wipe : null }), at(e.B)) });
  return out;
}
// accuracy of an opacity event: { cat, err, text } (crossfade: the two copies over each other, 1 - (1 - a)(1 - b))
function accuracy(e, s) {
  if (e.wipe) return { cat: e.wipe.ease.err > 0.01 ? 'approx' : 'exact', err: e.wipe.ease.err, text: `wipe from ${e.wipe.side} (${how(e.wipe.ease)}, max ${e.wipe.ease.err.toFixed(2)})` };
  if (e.instant) return { cat: 'exact', err: 0, text: '' };
  let err = 0;
  for (let i = e.a; i <= e.b; i++) {
    const p = fitProgress((s.T[i] - e.t0) / (e.t1 - e.t0), e.ease);
    const shown = e.kind === 'partial' && PARTIAL === 'crossfade' ? 1 - (1 - e.A * (1 - p)) * (1 - e.B * p) : e.A + (e.B - e.A) * p;
    err = Math.max(err, Math.abs(shown - s.op[i]));
  }
  const kind = e.kind === 'partial' && PARTIAL === 'crossfade' ? 'crossfade copy, ' : 'fade ';
  return { cat: err > 0.01 ? 'approx' : 'exact', err, text: `opacity ${e.A} to ${e.B} (${kind}${how(e.ease)}, max ${err.toFixed(2)})` };
}

// ---------- geometry ----------
// [i0, i1]: from the last sample still at the step's first value to the first sample at its last value (null: no change)
function changeSpan(v, lo, hi, eps) {
  let i0 = -1, i1 = -1;
  for (let i = lo; i <= hi && i0 < 0; i++) if (Math.abs(v[i] - v[lo]) > eps) i0 = i - 1;
  if (i0 < 0) return null;
  for (let i = hi; i >= lo && i1 < 0; i--) if (Math.abs(v[i] - v[hi]) > eps) i1 = i + 1;
  return [i0, Math.max(i0 + 1, i1)];
}
function track(s, R, g, i0, i1) {
  const [attr, key, , tol, val] = g;
  const keep = i1 > i0 ? reduceKeys(s.T, s[key], i0, i1, tol(R)) : [i0];
  return { b: 'anim', attr, t0: s.T[i0], t1: i1 > i0 ? s.T[i1] : s.T[i0] + 0.001, keys: keep.map((i) => ({ t: s.T[i], v: val(s[key][i]) })) };
}
// tracks of one shape in one step [lo, hi]; enter: index where it becomes visible (or -1); held: its value per attribute
function geoTracks(s, R, lo, hi, enter, held) {
  const out = [];
  for (const g of GEO) {
    const [attr, key, eps, tol] = g;
    const span = changeSpan(s[key], lo, hi, eps);
    let i0 = span ? span[0] : -1;
    const i1 = span ? span[1] : -1;
    if (enter >= 0 && Math.abs(s[key][enter] - held[attr]) > tol(R) && (i0 < 0 || enter < i0)) i0 = enter;
    if (i0 < 0) continue;
    out.push(track(s, R, g, i0, Math.max(i0, i1)));
    held[attr] = s[key][Math.max(i0, i1)];
  }
  return out;
}

// ---------- the section ----------
const idxOf = (T, t) => { let lo = 0, hi = T.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (T[m] < t - 1e-9) lo = m + 1; else hi = m; } return lo; };
const stepOf = (W, t) => { let k = 0; for (let i = 0; i < W.length; i++) if (t >= W[i].start - 1e-9) k = i; return k; };

function itemPlan(S, k) {
  const it = S.items[k], s = seriesOf(S, k), R = shapeSeries(s, it), notes = [];
  const evs = opacityEvents(s), gate = gateEvent(s, it);
  if (gate) evs.unshift(gate);
  mergeClips(evs, clipEvents(s), notes);
  const vis0 = s.op[0] > ZERO && shows(s, it, 0);
  const copies = levelsOf(evs, vis0, s.op[0]).map((level) => ({ item: k, level, vis0: vis0 && (PARTIAL !== 'crossfade' || level === lvl(s.op[0])) }));
  return { it, s, R, evs, copies, notes };
}

// one step of one shape: its effects with the geometry tracks of the step (when it is seen in it); vis at the step start
function stepEffects(P, copy, W, w, held, vis) {
  const T = P.s.T;
  const mine = P.evs.filter((e) => stepOf(W, e.t0) === w.k).flatMap((e) => eventEffects(e, P.copies).filter((x) => x.copy === copy).map((x) => x.fx));
  const ent = mine.find((f) => f.cls === 'entr');
  const enter = ent ? idxOf(T, ent.bh[0].t) : vis ? idxOf(T, w.t0) : -1;
  const tracks = enter >= 0 ? geoTracks(P.s, P.R, Math.max(idxOf(T, w.start), idxOf(T, w.t0)), idxOf(T, w.end), enter, held) : [];
  if (tracks.length && mine.length) mine[0].bh.push(...tracks);
  else if (tracks.length) mine.push({ cls: MOTION.cls, preset: MOTION.preset, bh: tracks, motion: true });
  return mine;
}
const visAfter = (vis, fxs) => fxs.reduce((v, f) => (f.cls === 'entr' ? true : f.cls === 'exit' ? false : v), vis);
// per copy: its effects step by step, with the geometry of the steps where it is visible
function copyEffects(P, copy, W) {
  const held = { ppt_x: 0, ppt_y: 0, ppt_w: 1, ppt_h: 1, r: 0 }, out = [];
  let vis = copy.vis0;
  for (const w of W) {
    const mine = stepEffects(P, copy, W, w, held, vis);
    vis = visAfter(vis, mine);
    for (const f of mine) out.push(Object.assign(f, { step: w.k, copy }));
  }
  return out;
}

function sectionNotes(S, W, plans) {
  const notes = [];
  const lag = W[0].start + 0.25 - W[0].t0;
  notes.push({ step: W[0].id, cat: 'approx', text: `the first step starts ${lag.toFixed(2)} s later than the page (it waits for the 0.25 s slide transition)` });
  for (const P of plans) {
    if (P.it.kind === 'box' && P.it.glow && P.copies.length) notes.push({ step: W[0].id, cat: 'approx', text: `${label(P.it)} glow ${(P.it.glow.blur / 2).toFixed(0)} px for box-shadow blur ${P.it.glow.blur} px` });
    for (const n of P.notes) notes.push({ step: W[stepOf(W, n.t)].id, cat: n.cat, text: `${label(P.it)} ${n.what}` });
  }
  return notes;
}
export const label = (it) => `${it.kind === 'pic' ? 'picture' : it.kind === 'box' ? 'shape' : 'text'} ${it.what} #${it.n}`;
// PptxGenJS escapes an object name twice, so the characters XML escapes are left out of shape names
export const shapeName = (it, level) => `${label(it).replace(/[&<>"']/g, '_')}${level === 1 ? '' : `@${Math.round(level * 100)}`}`;

// motions counted the page's way: each opacity change and each item's geometry in a step
function motions(plans, W) {
  const rows = [];
  for (const P of plans) {
    for (const e of P.evs) { const a = accuracy(e, P.s); rows.push({ step: W[stepOf(W, e.t0)].id, cat: a.cat, text: a.text ? `${label(P.it)} ${a.text}` : '' }); }
  }
  return rows;
}

// a step with no effect still needs its click: a no-op on a shape (its visibility set to what it is then)
function markEmpty(steps, shapes) {
  const vis = shapes.map((c) => c.vis0);
  for (const st of steps) {
    if (!st.effects.length && shapes.length) {
      const k = Math.max(0, vis.indexOf(true));
      st.effects.push({ shape: k, cls: MOTION.cls, preset: MOTION.preset, bh: [{ b: 'set', to: vis[k] ? 'visible' : 'hidden', t: st.t0 }], start: st.t0, marker: true });
    }
    for (const f of st.effects) vis[f.shape] = f.cls === 'entr' ? true : f.cls === 'exit' ? false : vis[f.shape];
  }
}

/**
 * The plan of one extracted section: { shapes: [{ item, level, vis0, name }], steps: [{ id, k, start, t0, end, effects }],
 * notes: [{ step, cat: 'approx' | 'impossible', text }], counts: { exact, approx, impossible } }. Effects:
 * { shape (index), cls, preset, side?, bh: behaviors in page seconds }, in time order per step.
 */
export function planSection(S) {
  const W = S.windows, plans = S.items.map((_, k) => itemPlan(S, k));
  const shapes = plans.flatMap((P) => P.copies.map((c) => Object.assign(c, { name: shapeName(P.it, c.level) })));
  const fx = plans.flatMap((P) => P.copies.flatMap((c) => copyEffects(P, c, W)));
  const geo = new Set(fx.filter((f) => f.bh.some((b) => b.b === 'anim')).map((f) => `${f.copy.item}/${f.step}`));
  const steps = W.map((w) => ({ ...w, effects: fx.filter((f) => f.step === w.k).map((f) => ({ shape: shapes.indexOf(f.copy), cls: f.cls, preset: f.preset, side: f.side, bh: f.bh, start: Math.min(...f.bh.map((b) => (b.t0 != null ? b.t0 : b.t))) }))
    .sort((a, b) => a.start - b.start || a.shape - b.shape) }));
  markEmpty(steps, shapes);
  const rows = motions(plans, W), notes = sectionNotes(S, W, plans).concat(rows.filter((r) => r.cat !== 'exact').map((r) => ({ step: r.step, cat: r.cat, text: r.text })));
  const counts = { exact: rows.filter((r) => r.cat === 'exact').length + geo.size, approx: notes.filter((n) => n.cat === 'approx').length, impossible: notes.filter((n) => n.cat === 'impossible').length };
  return { shapes, steps, notes, counts };
}
