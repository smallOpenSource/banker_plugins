// pptx-anim-xml.mjs: a section plan (pptx-anim-plan.mjs) as slide XML: <p:transition> (Fade 0.25 s) and <p:timing>
// (main sequence: the first step's group starts by itself after the transition, every other step is one click
// group; each effect is "with previous" at its delay from the step's start) with the build list. Times: behaviors
// start and end on whole ms; a keyframed anim starts on the ms before its first key and ends on the ms after its
// last, its keys placed at their exact times inside (tm 0..100000), so rounding does not move the motion.
const P14 = 'http://schemas.microsoft.com/office/powerpoint/2010/main';
const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
export const TRANSITION_MS = 250;
// Wipe: the page's edge -> PowerPoint subtype and filter (stage 0 P08 confirms the direction words)
export const WIPE = { left: [8, 'wipe(left)'], right: [2, 'wipe(right)'], top: [1, 'wipe(up)'], bottom: [4, 'wipe(down)'] };

const num = (v) => { const s = (Math.round(v * 1e6) / 1e6).toFixed(6).replace(/\.?0+$/, ''); return s === '-0' ? '0' : s; };
const cond = (ms) => `<p:stCondLst><p:cond delay="${ms}"/></p:stCondLst>`;
const tgt = (spid) => `<p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl>`;
const attr = (name) => `<p:attrNameLst><p:attrName>${name}</p:attrName></p:attrNameLst>`;
const ad = (e) => `${e && e.a ? ` accel="${Math.round(e.a * 100000)}"` : ''}${e && e.d ? ` decel="${Math.round(e.d * 100000)}"` : ''}`;

/** Formula of one keyframe value relative to the shape's rest value. */
export function formula(name, v) {
  if (name === 'ppt_x' || name === 'ppt_y') return Math.abs(v) < 5e-7 ? `#${name}` : `#${name}${v < 0 ? '-' : '+'}${num(Math.abs(v))}`;
  if (name === 'ppt_w' || name === 'ppt_h') return Math.abs(v - 1) < 5e-7 ? `#${name}` : `#${name}*${num(Math.max(0, v))}`;
  return num(v);
}

// whole-ms window of a behavior relative to the group start z (seconds): { start, dur }
function win(b, z) {
  if (b.b === 'set' || b.b === 'setop') return { start: Math.max(0, Math.round((b.t - z) * 1000)), dur: 1 };
  if (b.b === 'anim') { const s = Math.max(0, Math.floor((b.t0 - z) * 1000 + 1e-6)); return { start: s, dur: Math.max(1, Math.ceil((b.t1 - z) * 1000 - 1e-6) - s) }; }
  const s = Math.max(0, Math.round((b.t0 - z) * 1000));
  return { start: s, dur: Math.max(1, Math.round((b.t1 - z) * 1000) - s) };
}

function tavXml(b, w, z) {
  const tms = b.keys.map((k, i) => (i === 0 ? 0 : i === b.keys.length - 1 ? 100000 : Math.min(100000, Math.max(0, Math.round((((k.t - z) * 1000 - w.start) / w.dur) * 100000)))));
  const out = [];
  b.keys.forEach((k, i) => {
    if (out.length && tms[i] <= out[out.length - 1].tm) { if (i === b.keys.length - 1) out[out.length - 1] = { tm: tms[i], v: k.v }; return; }
    out.push({ tm: tms[i], v: k.v });
  });
  if (out.length === 1) out.push({ tm: 100000, v: out[0].v });
  const val = (v) => (b.attr === 'r' ? `<p:fltVal val="${num(v)}"/>` : `<p:strVal val="${formula(b.attr, v)}"/>`);
  return `<p:tavLst>${out.map((k) => `<p:tav tm="${k.tm}"><p:val>${val(k.v)}</p:val></p:tav>`).join('')}</p:tavLst>`;
}

// one behavior; base: the effect's start (ms from the group start)
function behaviorXml(b, spid, base, z, id) {
  const w = win(b, z), ctn = (extra = '') => `<p:cTn id="${id()}" dur="${w.dur}"${extra} fill="hold">${cond(w.start - base)}</p:cTn>`;
  if (b.b === 'set') return `<p:set><p:cBhvr>${ctn()}${tgt(spid)}${attr('style.visibility')}</p:cBhvr><p:to><p:strVal val="${b.to}"/></p:to></p:set>`;
  if (b.b === 'setop') return `<p:set><p:cBhvr>${ctn()}${tgt(spid)}${attr('style.opacity')}</p:cBhvr><p:to><p:strVal val="${num(b.to)}"/></p:to></p:set>`;
  if (b.b === 'fade' || b.b === 'wipe') return `<p:animEffect transition="${b.dir}" filter="${b.b === 'fade' ? 'fade' : WIPE[b.side][1]}"><p:cBhvr>${ctn(ad(b.ease))}${tgt(spid)}</p:cBhvr></p:animEffect>`;
  if (b.b === 'anim') return `<p:anim calcmode="lin" valueType="num"><p:cBhvr additive="base">${ctn()}${tgt(spid)}${attr(b.attr)}</p:cBhvr>${tavXml(b, w, z)}</p:anim>`;
  if (b.b === 'opacity') return `<p:anim calcmode="lin" valueType="num" from="${num(b.from)}" to="${num(b.to)}"><p:cBhvr>${ctn(ad(b.ease))}${tgt(spid)}${attr('style.opacity')}</p:cBhvr></p:anim>`;
  if (b.b === 'transp') return `<p:set><p:cBhvr>${ctn(ad(b.ease))}${tgt(spid)}${attr('style.opacity')}</p:cBhvr><p:to><p:strVal val="${num(b.to)}"/></p:to></p:set><p:animEffect filter="image" prLst="opacity: ${num(b.to)}"><p:cBhvr rctx="IE">${ctn(ad(b.ease))}${tgt(spid)}</p:cBhvr></p:animEffect>`;
  throw new Error(`unknown behavior ${b.b}`);
}

/** One effect at its delay from the step start z (seconds); node: clickEffect, withEffect or afterEffect. */
export function effectXml(fx, spid, node, z, id) {
  const base = Math.min(...fx.bh.map((b) => win(b, z).start));
  const sub = fx.preset === 22 ? WIPE[fx.side][0] : 0;
  const head = `<p:cTn id="${id()}" presetID="${fx.preset}" presetClass="${fx.cls}" presetSubtype="${sub}" fill="hold" grpId="0" nodeType="${node}">`;
  return `<p:par>${head}${cond(base)}<p:childTnLst>${fx.bh.map((b) => behaviorXml(b, spid, base, z, id)).join('')}</p:childTnLst></p:cTn></p:par>`;
}

function groupXml(step, auto, spids, id) {
  const start = auto ? '<p:stCondLst><p:cond delay="indefinite"/><p:cond evt="onBegin" delay="0"><p:tn val="2"/></p:cond></p:stCondLst>' : '<p:stCondLst><p:cond delay="indefinite"/></p:stCondLst>';
  const outer = id(), inner = id();
  const body = step.effects.map((fx, i) => effectXml(fx, spids[fx.shape], i === 0 ? (auto ? 'afterEffect' : 'clickEffect') : 'withEffect', step.t0, id)).join('');
  return `<p:par><p:cTn id="${outer}" fill="hold">${start}<p:childTnLst><p:par><p:cTn id="${inner}" fill="hold">${cond(0)}<p:childTnLst>${body}</p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par>`;
}

/**
 * <p:timing> of a section plan. spids[shape index] = the slide's shape id; texts: the spids of shapes with text
 * (they get a <p:bldP>, pictures and plain shapes do not).
 */
export function timingXml(plan, spids, texts = new Set()) {
  let n = 2;
  const id = () => ++n;
  const groups = plan.steps.filter((st) => st.effects.length).map((st) => groupXml(st, st.k === 0, spids, id)).join('');
  const used = [...new Set(plan.steps.flatMap((st) => st.effects.map((fx) => spids[fx.shape])))].filter((s) => texts.has(s)).sort((a, b) => a - b);
  const bld = used.length ? `<p:bldLst>${used.map((s) => `<p:bldP spid="${s}" grpId="0" animBg="1"/>`).join('')}</p:bldLst>` : '';
  return '<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst>'
    + `<p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>${groups}</p:childTnLst></p:cTn>`
    + '<p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst><p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst></p:seq>'
    + `</p:childTnLst></p:cTn></p:par></p:tnLst>${bld}</p:timing>`;
}

/** Fade slide transition of TRANSITION_MS (p14:dur, PowerPoint 2010 and later; "fast" for older readers). */
export function transitionXml(ms = TRANSITION_MS) {
  return `<mc:AlternateContent xmlns:mc="${MC}"><mc:Choice xmlns:p14="${P14}" Requires="p14"><p:transition spd="fast" p14:dur="${ms}"><p:fade/></p:transition></mc:Choice>`
    + '<mc:Fallback><p:transition spd="fast"><p:fade/></p:transition></mc:Fallback></mc:AlternateContent>';
}

/** Glow on a shape's properties (a:effectLst before </p:spPr>): radius px, color hex, alpha 0..1. */
export function glowXml(px, hex, a) {
  return `<a:effectLst><a:glow rad="${Math.round(px * 6350)}"><a:srgbClr val="${hex}"><a:alpha val="${Math.round(a * 100000)}"/></a:srgbClr></a:glow></a:effectLst>`;
}
