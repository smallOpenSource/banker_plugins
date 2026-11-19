// pptx-anim-sim.mjs: an independent reading of a slide's <p:timing>, as ECMA-376 Part 1 (19.5) and MS-OE376 describe it,
// to say what each shape shows at click k, tau ms into that click's group: visible, opacity, the part a wipe has
// revealed, center, size and rotation (stage px). It reads only the slide XML; it shares no code with the plan or the
// XML writer (the gates compare its answer with the page). Covered: the main sequence (an automatic first group,
// click groups, inner "after previous" groups, effect and behavior delays), set (style.visibility, style.opacity),
// animEffect fade and wipe(dir) in and out, anim with tavLst (strVal formulas on #ppt_x, #ppt_y, #ppt_w, #ppt_h,
// fltVal) or from / to, accel / decel, fill hold. A shape whose first visibility change makes it visible starts hidden.
import { kid, kidsNamed, parseXml, walk } from './pptx-xmlcheck.mjs';

const EMU_PX = 6350; // 914400 EMU per inch, 1920 px per 13.333 in
const SLIDE = { w: 1920, h: 1080 };

// ---------- formulas ----------
/** Value of a PowerPoint animation formula ("#ppt_x+0.25", "#ppt_w*0.4", "0-#ppt_w/2", "12") with vars { ppt_x, ... }. */
export function evalFormula(src, vars) {
  const toks = String(src).match(/#\w+|\d*\.\d+(?:e[-+]?\d+)?|\d+(?:e[-+]?\d+)?|[-+*/()]/gi) || [];
  let i = 0;
  const factor = () => {
    const t = toks[i++];
    if (t === '-') return -factor();
    if (t === '+') return factor();
    if (t === '(') { const v = expr(); i++; return v; }
    if (t && t[0] === '#') { const k = t.slice(1); if (!(k in vars)) throw new Error(`unknown formula variable ${t}`); return vars[k]; }
    const v = Number(t);
    if (!Number.isFinite(v)) throw new Error(`bad formula ${src}`);
    return v;
  };
  const term = () => { let v = factor(); while (toks[i] === '*' || toks[i] === '/') v = toks[i++] === '*' ? v * factor() : v / factor(); return v; };
  const expr = () => { let v = term(); while (toks[i] === '+' || toks[i] === '-') v = toks[i++] === '+' ? v + term() : v - term(); return v; };
  return expr();
}

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
function shapesOf(root) {
  const out = new Map();
  for (const n of walk(root)) {
    if (n.name !== 'p:sp' && n.name !== 'p:pic') continue;
    const pr = walk(n).find((x) => x.name === 'p:cNvPr'), off = walk(n).find((x) => x.name === 'a:off'), ext = walk(n).find((x) => x.name === 'a:ext');
    if (!pr || !off || !ext) continue;
    const name = pr.attrs.name || '', m = /#(\d+)(?:@(\d+))?$/.exec(name);
    out.set(pr.attrs.id, { spid: pr.attrs.id, name, tag: n.name, hidden: pr.attrs.hidden === '1', key: m ? +m[1] : null, level: m && m[2] ? +m[2] / 100 : 1,
      x: +off.attrs.x / EMU_PX, y: +off.attrs.y / EMU_PX, w: +ext.attrs.cx / EMU_PX, h: +ext.attrs.cy / EMU_PX });
  }
  return out;
}
const ctnOf = (n) => kid(kid(n, 'p:cBhvr') || n, 'p:cTn');
const delayOf = (ctn) => { const c = ctn && kid(ctn, 'p:stCondLst'); const d = c && kidsNamed(c, 'p:cond').find((x) => x.attrs.delay != null && !x.attrs.evt); return int(d && d.attrs.delay); };
function behavior(n, t0) {
  const c = ctnOf(n), bh = kid(n, 'p:cBhvr'), tg = bh && walk(bh).find((x) => x.name === 'p:spTgt');
  const an = bh && walk(bh).find((x) => x.name === 'p:attrName');
  const b = { type: n.name.slice(2), spid: tg ? tg.attrs.spid : null, attr: an ? an.text.trim() : null, start: t0 + delayOf(c), dur: Math.max(1, int(c && c.attrs.dur, 1)),
    accel: int(c && c.attrs.accel) / 100000, decel: int(c && c.attrs.decel) / 100000, transition: n.attrs.transition, filter: n.attrs.filter, from: n.attrs.from, to: n.attrs.to };
  const to = kid(n, 'p:to'), sv = to && walk(to).find((x) => x.name === 'p:strVal');
  if (sv) b.to = sv.attrs.val;
  const tl = kid(n, 'p:tavLst');
  if (tl) b.tavs = kidsNamed(tl, 'p:tav').map((t) => { const v = walk(t).find((x) => x.name === 'p:strVal' || x.name === 'p:fltVal'); return { tm: +t.attrs.tm / 100000, v: v ? v.attrs.val : '0' }; });
  return b;
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

/** Reads a slide: { shapes: Map spid -> shape, groups: [{ auto, effects, end }] } (groups in click order). */
export function readSlide(xml) {
  const root = parseXml(xml), timing = kid(root, 'p:timing');
  const seq = timing && walk(timing).find((n) => n.name === 'p:cTn' && n.attrs.nodeType === 'mainSeq');
  const groups = seq ? kidsNamed(kid(seq, 'p:childTnLst') || seq, 'p:par').map(group) : [];
  return { shapes: shapesOf(root), groups };
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
  r: (s, v) => { s.rot = v; }, 'style.rotation': (s, v) => { s.rot = v; }, 'style.opacity': (s, v) => { s.opac = v; } };
function apply(s, b, t, sh) {
  if (t < b.start) return;
  if (b.type === 'set' && b.attr === 'style.visibility') s.vis = b.to === 'visible';
  else if (b.type === 'set' && b.attr === 'style.opacity') s.opac = +b.to;
  else if (b.type === 'animEffect' && b.filter === 'fade') s.fade = b.transition === 'out' ? 1 - progress(b, t) : progress(b, t);
  else if (b.type === 'animEffect' && /^wipe\((\w+)\)$/.test(b.filter || '')) s.clip = { dir: /^wipe\((\w+)\)$/.exec(b.filter)[1], out: b.transition === 'out', p: progress(b, t) };
  else if (b.type === 'anim' && b.tavs && ATTR[b.attr]) ATTR[b.attr](s, b.attr.startsWith('ppt_') ? tavValue(b, t, sh) : tavValue(b, t, sh));
  else if (b.type === 'anim' && b.from != null && ATTR[b.attr]) ATTR[b.attr](s, +b.from + (+b.to - +b.from) * progress(b, t));
}

/**
 * State of every shape at click k (0: the automatic group, or the first click when there is none), tau ms into that
 * group (Infinity: the group has ended): Map spid -> { vis, op, clip, cx, cy, w, h, rot, level, key }.
 */
export function stateAt(slide, k, tau) {
  const all = [];
  slide.groups.forEach((g, gi) => { if (gi <= k) for (const fx of g.effects) for (const b of fx.behaviors) all.push({ b, gi, t: gi < k ? Infinity : tau }); });
  all.sort((x, y) => x.gi - y.gi || x.b.start - y.b.start); // each group's times count from its own start
  const out = new Map();
  for (const [spid, sh] of slide.shapes) {
    const s = rest(sh);
    const mine = all.filter((x) => x.b.spid === spid);
    const firstVis = slide.groups.flatMap((g) => g.effects.flatMap((fx) => fx.behaviors)).find((b) => b.spid === spid && b.type === 'set' && b.attr === 'style.visibility');
    if (firstVis && firstVis.to === 'visible') s.vis = false;
    for (const x of mine) apply(s, x.b, x.t, sh);
    out.set(spid, { vis: s.vis && !sh.hidden, op: s.vis && !sh.hidden ? s.fade * s.opac : 0, clip: s.clip, cx: s.cx, cy: s.cy, w: s.w, h: s.h, rot: s.rot, level: sh.level, key: sh.key, shape: sh });
  }
  return out;
}

/** Fraction of a shape's area a wipe leaves visible (1 without a wipe). */
export const wipeVisible = (clip) => (!clip ? 1 : clip.out ? 1 - clip.p : clip.p);

/** The item a page element is drawn as (shapes with the same #n): composite opacity of its copies, the drawn geometry. */
export function itemsAt(states) {
  const by = new Map();
  for (const st of states.values()) {
    if (st.key == null) continue;
    const it = by.get(st.key) || { key: st.key, keep: 1, geo: null, frac: 0 };
    const a = st.op * st.level;
    it.keep *= 1 - a;
    if (!it.geo || (st.vis && a > 0)) it.geo = st;
    if (st.vis && a > 0) it.frac = Math.max(it.frac, wipeVisible(st.clip));
    by.set(st.key, it);
  }
  for (const it of by.values()) it.op = 1 - it.keep;
  return by;
}
