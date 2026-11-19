// pptx-anim-sim.mjs: an independent reading of a slide's <p:timing>, as ECMA-376 Part 1 (19.5) and MS-OE376 describe it,
// to say what each shape shows at click k, tau ms into that click's group: visible, opacity, the part a wipe has
// revealed, center, size and rotation (stage px). It reads only the slide XML; it shares no code with the plan or the
// XML writer (the gates compare its answer with the page). Covered: the main sequence (an automatic first group,
// click groups, inner "after previous" groups, effect and behavior delays), set (style.visibility, style.opacity),
// animEffect fade and wipe(dir) in and out, anim with tavLst (strVal formulas on #ppt_x, #ppt_y, #ppt_w, #ppt_h,
// fltVal) or from / to, accel / decel, fill hold. A shape whose first visibility change makes it visible starts hidden.
// What PowerPoint 2019 did in the stage-0 and stage-7 measurements is followed: a Fade in with fill="hold" keeps a
// later Fade out of the same shape from playing (X4), a Fade in ends at full opacity whatever style.opacity was set
// to (X1), and a text shape with a <p:bldP> keeps only its first effect (the edit deck of stage 7).
import { kid, kidsNamed, parseXml, walk } from './pptx-xmlcheck.mjs';

const EMU_PX = 6350; // 914400 EMU per inch, 1920 px per 13.333 in
const SLIDE = { w: 1920, h: 1080 };

// ---------- formulas ----------
// a small recursive-descent reader over the formula's tokens
function reader(src, vars) {
  const toks = String(src).match(/#\w+|\d*\.\d+(?:e[-+]?\d+)?|\d+(?:e[-+]?\d+)?|[-+*/()]/gi) || [];
  let i = 0;
  const r = { peek: () => toks[i], next: () => toks[i++], vars, src };
  return r;
}
function atom(r, t) {
  if (t && t[0] === '#') {
    const k = t.slice(1);
    if (!(k in r.vars)) throw new Error(`unknown formula variable ${t}`);
    return r.vars[k];
  }
  const v = Number(t);
  if (!Number.isFinite(v)) throw new Error(`bad formula ${r.src}`);
  return v;
}
function factor(r) {
  const t = r.next();
  if (t === '-') return -factor(r);
  if (t === '+') return factor(r);
  if (t !== '(') return atom(r, t);
  const v = sum(r);
  r.next();
  return v;
}
function product(r) {
  let v = factor(r);
  while (r.peek() === '*' || r.peek() === '/') v = r.next() === '*' ? v * factor(r) : v / factor(r);
  return v;
}
function sum(r) {
  let v = product(r);
  while (r.peek() === '+' || r.peek() === '-') v = r.next() === '+' ? v + product(r) : v - product(r);
  return v;
}
/** Value of a PowerPoint animation formula ("#ppt_x+0.25", "#ppt_w*0.4", "0-#ppt_w/2", "12") with vars { ppt_x, ... }. */
export const evalFormula = (src, vars) => sum(reader(src, vars));

/** SMIL simple-time progress with acceleration a and deceleration d (fractions) at linear progress x. */
export function smilProgress(x, a, d) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const peak = 2 / (2 - a - d);
  if (a > 0 && x < a) return (peak * x * x) / (2 * a);
  if (d > 0 && x > 1 - d) return 1 - (peak * (1 - x) * (1 - x)) / (2 * d);
  return peak * (x - a / 2);
}

// ---------- reading ----------
const int = (v, dflt = 0) => (v == null || v === 'indefinite' ? dflt : +v);
const alphaVal = (c) => { const a = c && kid(c, 'a:alpha'); return a ? +a.attrs.val / 100000 : 1; };
const srgb = (node) => (node ? walk(node).find((x) => x.name === 'a:srgbClr') || null : null);
// the shape's own transparency as drawn: its fill's alpha, else its outline's, else its first text run's, else a
// picture's alphaModFix (PowerPoint multiplies style.opacity into it: X6). Read from the XML, not from the name.
function shapeAlpha(n) {
  const pr = kid(n, 'p:spPr'), fill = pr && kid(pr, 'a:solidFill'), ln = pr && kid(pr, 'a:ln');
  const run = walk(n).find((x) => x.name === 'a:rPr' && kid(x, 'a:solidFill'));
  const c = srgb(fill) || srgb(ln && kid(ln, 'a:solidFill')) || srgb(run && kid(run, 'a:solidFill'));
  if (c) return alphaVal(c);
  const mod = walk(n).find((x) => x.name === 'a:alphaModFix');
  return mod ? +mod.attrs.amt / 100000 : 1;
}
// a shape's name, place, size (stage px) and transparency; #n is the page element
function shapeOf(n) {
  const find = (name) => walk(n).find((x) => x.name === name);
  const pr = find('p:cNvPr'), off = find('a:off'), ext = find('a:ext');
  if (!pr || !off || !ext) return null;
  const name = pr.attrs.name || '', m = /#(\d+)(?:@(\d+))?$/.exec(name) || [];
  return { spid: pr.attrs.id, name, tag: n.name, hidden: pr.attrs.hidden === '1', key: m[1] ? +m[1] : null, alpha: shapeAlpha(n),
    x: +off.attrs.x / EMU_PX, y: +off.attrs.y / EMU_PX, w: +ext.attrs.cx / EMU_PX, h: +ext.attrs.cy / EMU_PX };
}
function shapesOf(root) {
  const out = new Map();
  for (const n of walk(root).filter((x) => x.name === 'p:sp' || x.name === 'p:pic')) {
    const sh = shapeOf(n);
    if (sh) out.set(sh.spid, sh);
  }
  return out;
}
const ctnOf = (n) => kid(kid(n, 'p:cBhvr') || n, 'p:cTn');
const delayOf = (ctn) => { const c = ctn && kid(ctn, 'p:stCondLst'); const d = c && kidsNamed(c, 'p:cond').find((x) => x.attrs.delay != null && !x.attrs.evt); return int(d && d.attrs.delay); };
const inBhvr = (n, name) => { const bh = kid(n, 'p:cBhvr'); return bh ? walk(bh).find((x) => x.name === name) || null : null; };
// the value a set or anim goes to (<p:to><p:strVal>) and its keyframes (<p:tavLst>)
function values(n, b) {
  const to = kid(n, 'p:to'), sv = to && walk(to).find((x) => x.name === 'p:strVal');
  if (sv) b.to = sv.attrs.val;
  const tl = kid(n, 'p:tavLst');
  if (tl) b.tavs = kidsNamed(tl, 'p:tav').map((t) => { const v = walk(t).find((x) => x.name === 'p:strVal' || x.name === 'p:fltVal'); return { tm: +t.attrs.tm / 100000, v: v ? v.attrs.val : '0' }; });
  return b;
}
function behavior(n, t0) {
  const c = ctnOf(n) || { attrs: {} }, tg = inBhvr(n, 'p:spTgt'), an = inBhvr(n, 'p:attrName');
  return values(n, { type: n.name.slice(2), spid: tg && tg.attrs.spid, attr: an && an.text.trim(), start: t0 + delayOf(c), dur: Math.max(1, int(c.attrs.dur, 1)),
    accel: int(c.attrs.accel) / 100000, decel: int(c.attrs.decel) / 100000, fill: c.attrs.fill, transition: n.attrs.transition, filter: n.attrs.filter, from: n.attrs.from, to: n.attrs.to });
}
const BEHAVIORS = ['p:set', 'p:animEffect', 'p:anim', 'p:animScale', 'p:animRot', 'p:animMotion', 'p:animClr', 'p:cmd'];
// an effect par: its behaviors (absolute ms from the group start)
function effect(par, base) {
  const c = kid(par, 'p:cTn'), t0 = base + delayOf(c), list = kid(c, 'p:childTnLst');
  const bh = list ? list.kids.filter((k) => BEHAVIORS.includes(k.name)).map((k) => behavior(k, t0)) : [];
  return { node: c.attrs.nodeType, cls: c.attrs.presetClass, preset: c.attrs.presetID, start: t0, behaviors: bh };
}
const endOf = (fx) => Math.max(fx.start, ...fx.behaviors.map((b) => b.start + b.dur));
// a click (or automatic) group: inner pars run one after another, effects inside start at their delays
function group(par) {
  const c = kid(par, 'p:cTn'), conds = walk(kid(c, 'p:stCondLst') || c).filter((x) => x.name === 'p:cond');
  const auto = conds.some((x) => x.attrs.evt === 'onBegin');
  const effects = [];
  let t = 0;
  for (const inner of kidsNamed(kid(c, 'p:childTnLst') || c, 'p:par')) {
    const ic = kid(inner, 'p:cTn'), start = t + delayOf(ic);
    const fxs = kidsNamed(kid(ic, 'p:childTnLst') || ic, 'p:par').map((p) => effect(p, start));
    effects.push(...fxs);
    t = Math.max(start, ...fxs.map(endOf));
  }
  return { auto, effects, end: Math.max(0, ...effects.map(endOf)) };
}

// a shape with a build entry keeps only its first effect (PowerPoint 2019 dropped the others on opening)
function firstOnly(groups, built) {
  const seen = new Set();
  return groups.map((g) => Object.assign({}, g, { effects: g.effects.filter((fx) => {
    const spids = [...new Set(fx.behaviors.map((b) => b.spid))].filter((x) => built.has(x));
    const drop = spids.some((x) => seen.has(x));
    spids.forEach((x) => seen.add(x));
    return !drop;
  }) }));
}
/** Reads a slide: { shapes: Map spid -> shape, groups: [{ auto, effects, end }] } (groups in click order). */
export function readSlide(xml) {
  const root = parseXml(xml), timing = kid(root, 'p:timing');
  const seq = timing && walk(timing).find((n) => n.name === 'p:cTn' && n.attrs.nodeType === 'mainSeq');
  const groups = seq ? kidsNamed(kid(seq, 'p:childTnLst') || seq, 'p:par').map(group) : [];
  const built = new Set(walk(timing || root).filter((n) => n.name === 'p:bldP').map((n) => n.attrs.spid));
  return { shapes: shapesOf(root), groups: built.size ? firstOnly(groups, built) : groups };
}

// ---------- state ----------
const progress = (b, t) => smilProgress((t - b.start) / b.dur, b.accel, b.decel);
function rest(sh) { return { vis: true, fade: 1, opac: 1, clip: null, cx: sh.x + sh.w / 2, cy: sh.y + sh.h / 2, w: sh.w, h: sh.h, rot: 0 }; }
function vars(sh) { return { ppt_x: (sh.x + sh.w / 2) / SLIDE.w, ppt_y: (sh.y + sh.h / 2) / SLIDE.h, ppt_w: sh.w / SLIDE.w, ppt_h: sh.h / SLIDE.h }; }
function tavValue(b, t, sh) {
  const x = progress(b, t), ks = b.tavs, val = (k) => evalFormula(k.v, vars(sh));
  if (x <= ks[0].tm) return val(ks[0]);
  for (let i = 1; i < ks.length; i++) {
    if (x <= ks[i].tm) { const a = val(ks[i - 1]), c = val(ks[i]); return a + ((c - a) * (x - ks[i - 1].tm)) / (ks[i].tm - ks[i - 1].tm || 1); }
  }
  return val(ks[ks.length - 1]);
}
const ATTR = { ppt_x: (s, v) => { s.cx = v * SLIDE.w; }, ppt_y: (s, v) => { s.cy = v * SLIDE.h; }, ppt_w: (s, v) => { s.w = v * SLIDE.w; }, ppt_h: (s, v) => { s.h = v * SLIDE.h; },
  r: (s, v) => { s.rot = v; }, 'style.rotation': (s, v) => { s.rot = v; }, 'style.opacity': (s, v) => { s.opac = Math.max(0, Math.min(1, v)); } }; // multiplies the shape's own transparency, clamped at 1 (X6)
const BEHAVE = {
  set: (s, b) => { if (b.attr === 'style.visibility') s.vis = b.to === 'visible'; else if (b.attr === 'style.opacity') s.opac = +b.to; },
  animEffect: (s, b, t) => {
    const wipe = /^wipe\((\w+)\)$/.exec(b.filter || ''), p = progress(b, t);
    if (b.filter === 'fade') fadeOn(s, b, p);
    else if (wipe) s.clip = { dir: wipe[1], out: b.transition === 'out', p };
  },
  anim: (s, b, t, sh) => {
    if (!ATTR[b.attr]) return;
    if (b.tavs) ATTR[b.attr](s, tavValue(b, t, sh));
    else if (b.from != null) ATTR[b.attr](s, +b.from + (+b.to - +b.from) * progress(b, t));
  },
};
function fadeOn(s, b, p) {
  if (b.transition === 'out') { if (!s.heldIn) s.fade = 1 - p; return; }
  s.fade = p;
  s.opac = 1;
  if (b.fill === 'hold') s.heldIn = true;
}
// a behavior that has begun by t changes the state (one that has ended holds its end: fill hold)
function apply(s, b, t, sh) { if (t >= b.start && BEHAVE[b.type]) BEHAVE[b.type](s, b, t, sh); }

/**
 * State of every shape at click k (0: the automatic group, or the first click when there is none), tau ms into that
 * group (Infinity: the group has ended): Map spid -> { vis, op, clip, cx, cy, w, h, rot, alpha, key }.
 */
// a shape whose first visibility change in the whole timeline makes it visible starts hidden
function startsHidden(slide, spid) {
  const first = slide.groups.flatMap((g) => g.effects.flatMap((fx) => fx.behaviors)).find((b) => b.spid === spid && b.type === 'set' && b.attr === 'style.visibility');
  return !!first && first.to === 'visible';
}
function shapeState(slide, sh, mine) {
  const s = rest(sh);
  if (startsHidden(slide, sh.spid)) s.vis = false;
  for (const x of mine) apply(s, x.b, x.t, sh);
  const vis = s.vis && !sh.hidden;
  return { vis, op: vis ? s.fade * s.opac : 0, clip: s.clip, cx: s.cx, cy: s.cy, w: s.w, h: s.h, rot: s.rot, alpha: sh.alpha, key: sh.key, shape: sh };
}
export function stateAt(slide, k, tau) {
  const all = [];
  slide.groups.slice(0, k + 1).forEach((g, gi) => g.effects.forEach((fx) => fx.behaviors.forEach((b) => all.push({ b, gi, t: gi < k ? Infinity : tau }))));
  all.sort((x, y) => x.gi - y.gi || x.b.start - y.b.start); // each group's times count from its own start
  const out = new Map();
  for (const [spid, sh] of slide.shapes) out.set(spid, shapeState(slide, sh, all.filter((x) => x.b.spid === spid)));
  return out;
}

/** Fraction of a shape's area a wipe leaves visible (1 without a wipe). */
export const wipeVisible = (clip) => (!clip ? 1 : clip.out ? 1 - clip.p : clip.p);

/** The item a page element is drawn as (shapes with the same #n): the composite alpha of its shapes as drawn (their own
 * transparency times what plays), the drawn geometry. */
export function itemsAt(states) {
  const by = new Map();
  for (const st of states.values()) {
    if (st.key == null) continue;
    const it = by.get(st.key) || { key: st.key, keep: 1, geo: null, frac: 0 };
    const a = st.op * st.alpha;
    it.keep *= 1 - a;
    if (!it.geo || (st.vis && a > 0)) it.geo = st;
    if (st.vis && a > 0) it.frac = Math.max(it.frac, wipeVisible(st.clip));
    by.set(st.key, it);
  }
  for (const it of by.values()) it.op = 1 - it.keep;
  return by;
}
