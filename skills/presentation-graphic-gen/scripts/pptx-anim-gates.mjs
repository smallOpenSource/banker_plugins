// pptx-anim-gates.mjs: the editable deck's animation gates of `pptx.mjs verify` (references/gates.md).
//   anim-xml        every slide's XML has the structure PowerPoint opens without repairing (pptx-xmlcheck.mjs)
//   anim-steps      one key press is one step: per section slide one automatic group, then steps - 1 click groups
//   anim-targets    every effect targets a shape on its slide named <kind> <element> #n[@level], not the hidden
//                   title; with the page, each name is that section's extracted element n
//   anim-match      (page and browser) the independent simulator (pptx-anim-sim.mjs) against the page at every
//                   step's 0, 15, 50, 85% and end, and between keyframes: end states exact (1 px, 0.5%, opacity
//                   0.02), in between positions 1 px, opacity 0.05, wipes 0.2 (the largest is reported);
//                   the slide start (the transition, before the automatic group) shows what the section start shows;
//                   each click starts where the previous one ended, as seen
//   anim-render     (page and browser) each step's end: the slide's shapes drawn by the browser at the simulated
//                   state against the page at that time, pixel by pixel
//   text-fit        (page and browser) every text box's runs, measured in the page's fonts, are as wide as the box
//                   was made for (a line whose gap was closed into one box is much narrower)
//   anim-powerpoint always SKIP here: no PowerPoint on the test PCs (pptx.mjs com --anim on a PC that has it)
import { measure, openDeck, stepWindows } from './pptx-anim-extract.mjs';
import { renderCompare, textFit } from './pptx-anim-render.mjs';
import { itemsAt, readSlide, stateAt, wipeVisible } from './pptx-anim-sim.mjs';
import { checkSlide } from './pptx-xmlcheck.mjs';

export const TOL = { endPos: 1, endSize: 0.005, endOp: 0.02, midPos: 1, midSize: 0.01, midOp: 0.05, midClip: 0.2, rot: 0.5 };
const NAME = /^(text|shape|picture) (.+) #(\d+)(?:@\d+)?$/;
const KIND = { text: 'text', shape: 'box', picture: 'pic' };

function xmlGate(slides, gate) {
  const bad = slides.flatMap((s) => checkSlide(s.xml).map((p) => `slide ${s.k + 1}: ${p}`));
  gate('anim-xml', !bad.length, `${slides.length - new Set(bad.map((b) => b.split(':')[0])).size}/${slides.length} slides: well formed, parts in order, cTn ids unique, targets on the slide, build list on text shapes, keyframes ascending, allowed presets, whole-ms delays, namespaces`, bad);
}

function stepsGate(read, data, gate) {
  const bad = [];
  let total = 0;
  data.sections.forEach((sec, k) => {
    const g = read[k] ? read[k].groups : [], n = sec.ids.length;
    const auto = g.filter((x) => x.auto).length, clicks = g.filter((x) => !x.auto).length;
    total += auto + clicks;
    if (auto !== 1 || !(g[0] && g[0].auto) || clicks !== n - 1) bad.push(`slide ${k + 1}: ${auto} automatic and ${clicks} click groups, want 1 and ${n - 1} (${n} steps)`);
  });
  gate('anim-steps', !bad.length && total === data.steps.length, `${total} groups (one automatic per slide, one click per later step) for ${data.steps.length} steps`, bad);
}

// what is wrong with one target (null: nothing); items: the page's elements of that section, or null
function targetProblem(sh, spid, items) {
  if (!sh) return `target ${spid} is not a shape`;
  if (sh.hidden) return `target ${spid} is the hidden title`;
  const m = NAME.exec(sh.name);
  if (!m) return `target ${spid} has no element name (${sh.name})`;
  const it = items ? items[+m[3] - 1] : null;
  const same = it && it.kind === KIND[m[1]] && it.what.replace(/[&<>"']/g, '_') === m[2];
  return items && !same ? `${sh.name} is not element #${m[3]} of the page (${it ? `${it.kind} ${it.what}` : 'none'})` : null;
}
function targetsGate(read, pageItems, gate) {
  const bad = [];
  let n = 0;
  read.forEach((sl, k) => {
    const spids = new Set(sl.groups.flatMap((g) => g.effects.flatMap((fx) => fx.behaviors.map((b) => b.spid))));
    for (const spid of spids) {
      n++;
      const p = targetProblem(sl.shapes.get(spid), spid, pageItems ? pageItems[k] || [] : null);
      if (p) bad.push(`slide ${k + 1}: ${p}`);
    }
  });
  gate('anim-targets', !bad.length && n > 0, `${n} target shapes named by their page element${pageItems ? ', each the same element of the page' : ' (no --html: names not compared with the page)'}`, bad);
}

// ---------- anim-match ----------
// the item's own center from the shape's simulated center (the item's offset in its shape, scaled and rotated)
function simItem(it, sh, st) {
  const sx = st.w / sh.w, sy = st.h / sh.h, a = (st.rot * Math.PI) / 180;
  const ox = it.x + it.w / 2 - (sh.x + sh.w / 2), oy = it.y + it.h / 2 - (sh.y + sh.h / 2);
  return { cx: st.cx + ox * sx * Math.cos(a) - oy * sy * Math.sin(a), cy: st.cy + ox * sx * Math.sin(a) + oy * sy * Math.cos(a), sx, sy, rot: st.rot };
}
// opacity as seen: 0 when not drawn (no area, clipped away); a shape under 4 px2 on either side is too small to judge
// its opacity by (its size is still compared)
const DRAWN = 1, TINY = 4;
const shown = (op, w, h, frac) => (w * h >= DRAWN && frac > 0 ? op : 0);
// errors between the page state row and the simulated item: { op, pos, size, rot, clip } (geometry only when both are seen)
function itemErr(it, row, sim) {
  const [cx, cy, sx, sy, rot, op, cl, ct, cr, cb] = row;
  const pf = Math.max(0, cr - cl) * Math.max(0, cb - ct);
  const pOp = shown(op, it.w * sx, it.h * sy, pf);
  if (!sim || !sim.geo) return { op: pOp, pos: 0, size: 0, rot: 0, clip: 0, page: pOp, ppt: 0 };
  const g = simItem(it, sim.geo.shape, sim.geo);
  const sOp = shown(sim.op, it.w * g.sx, it.h * g.sy, sim.frac);
  const tiny = Math.min(it.w * sx * it.h * sy, it.w * g.sx * it.h * g.sy) < TINY;
  const both = pOp > 0.02 && sOp > 0.02;
  return { op: tiny ? 0 : Math.abs(pOp - sOp), page: pOp, ppt: sOp, pos: both ? Math.hypot(cx - g.cx, cy - g.cy) : 0, rot: both ? Math.abs(rot - g.rot) : 0,
    size: both ? Math.max(Math.abs(sx - g.sx) * it.w, Math.abs(sy - g.sy) * it.h) : 0, sizeRel: both ? Math.max(Math.abs(sx - g.sx), Math.abs(sy - g.sy)) : 0, clip: both ? Math.abs(pf - sim.frac) : 0 };
}
// the times (ms into the group) a step is compared at: 0, 15, 50, 85%, the end, and between the group's keyframes
function compareTimes(w, g) {
  const len = (w.end - w.t0) * 1000, out = [0, 0.15, 0.5, 0.85].map((f) => f * len);
  const keys = [];
  // a jump is written as a 1 ms anim (whole ms); its inside is below what PowerPoint can time, so it is not compared
  for (const fx of g ? g.effects : []) for (const b of fx.behaviors) if (b.tavs && b.dur > 2) b.tavs.forEach((t, i) => { if (i) keys.push(b.start + ((b.tavs[i - 1].tm + t.tm) / 2) * b.dur); });
  const step = Math.max(1, Math.ceil(keys.length / 40));
  return out.concat(keys.filter((_, i) => i % step === 0).filter((t) => t < len)).sort((a, b) => a - b);
}
function judge(e, end, it) {
  const sizeOk = end ? e.size <= Math.max(TOL.endSize * Math.max(it.w, it.h), 0.5) : e.size <= Math.max(TOL.midSize * Math.max(it.w, it.h), 1);
  return e.op <= (end ? TOL.endOp : TOL.midOp) && e.pos <= (end ? TOL.endPos : TOL.midPos) && sizeOk && e.rot <= TOL.rot && e.clip <= (end ? TOL.endOp : TOL.midClip);
}
// a simulated shape's opacity as seen: 0 when hidden, without area or wiped away (an entrance at its first frame)
export const seenOp = (st) => (st.vis && st.w * st.h >= DRAWN && wipeVisible(st.clip) > 0 ? st.op : 0);
const moved = (x, y) => Math.hypot(x.cx - y.cx, x.cy - y.cy) > 0.01 || Math.abs(x.w - y.w) > 0.01 || Math.abs(x.h - y.h) > 0.01 || Math.abs(x.rot - y.rot) > 0.01;
/** Click k starts where click k - 1 ended, as seen (geometry only of a shape seen on either side); problems go to bad. */
export function continuity(sl, k, bad, id) {
  if (k === 0) return;
  const a = stateAt(sl, k - 1, Infinity), b = stateAt(sl, k, 0);
  for (const [spid, x] of a) {
    const y = b.get(spid), ox = seenOp(x), oy = seenOp(y);
    if (Math.abs(ox - oy) > 1e-6 || ((ox > 1e-6 || oy > 1e-6) && moved(x, y))) bad.push(`${id} start: ${x.shape.name} does not start where the previous click ended`);
  }
}

// tau -Infinity: the slide before its automatic group (during the 0.25 s transition) against the page at the
// section start; only what is seen is compared there (a shape at another place than rest is listed as approx)
const pageTime = (p, tau) => (tau === Infinity ? p.w.end : tau === -Infinity ? p.w.start : p.w.t0 + tau / 1000);
const when = (tau) => (tau === Infinity ? 'end' : tau === -Infinity ? 'slide start' : `${Math.round(tau)} ms`);
function checkTime(p, tau, sl, items, row, acc) {
  const sims = itemsAt(stateAt(sl, p.gi, tau));
  items.forEach((it, j) => {
    const e = itemErr(it, row[j], sims.get(it.n));
    acc.n++;
    for (const key of ['pos', 'op', 'clip', 'size']) acc.worst[key] = Math.max(acc.worst[key], e[key]);
    const ok = tau === -Infinity ? e.op <= TOL.endOp : judge(e, tau === Infinity, it);
    if (!ok) acc.bad.push(`${p.w.id} ${when(tau)}: ${it.kind} ${it.what} #${it.n} opacity page ${e.page.toFixed(2)} PowerPoint ${e.ppt.toFixed(2)}, position ${e.pos.toFixed(2)} px, size ${e.size.toFixed(2)} px, clip ${e.clip.toFixed(2)}`);
  });
}
async function matchSection(deck, k, sl, acc) {
  const sec = deck.sections[k], W = stepWindows(sec, deck.steps, k === 0);
  const L = await deck.page.eval(`__pggX.layout(${sec.n})`);
  const plan = W.map((w, gi) => ({ w, gi, taus: (gi ? [] : [-Infinity]).concat(compareTimes(w, sl.groups[gi]), Infinity) }));
  const rows = await measure(deck.page, plan.flatMap((p) => p.taus.map((t) => pageTime(p, t))));
  let r = 0;
  for (const p of plan) {
    continuity(sl, p.gi, acc.bad, p.w.id);
    for (const tau of p.taus) checkTime(p, tau, sl, L.items, rows[r++], acc);
  }
}

/** Runs the anim-* gates on the editable deck's slides ([{ k, xml, media }]); html: the present page (for anim-match and anim-render). */
export async function animGates(slides, data, { gate, html = null, browser = null, log = () => {} }) {
  xmlGate(slides, gate);
  let read;
  try { read = slides.map((s) => readSlide(s.xml)); } catch (e) { gate('anim-steps', false, `the timing cannot be read: ${e.message}`); return; }
  stepsGate(read, data, gate);
  if (!html || !browser) {
    targetsGate(read, null, gate);
    for (const g of ['anim-match', 'anim-render', 'text-fit']) gate(g, null, html ? 'no browser to play the page (set CHROME)' : 'no present page given (--html <present.html>)');
  } else await pageGates(slides, read, html, browser, gate, log);
  gate('anim-powerpoint', null, 'PowerPoint is not run here; on a PC with PowerPoint: node scripts/pptx.mjs com --anim <file.pptx> <dir> --script <script.md>');
}

async function pageGates(slides, read, html, browser, gate, log) {
  const deck = await openDeck(html, { browser });
  try {
    const items = [];
    for (const sec of deck.sections) items.push((await deck.page.eval(`__pggX.layout(${sec.n})`)).items);
    targetsGate(read, items, gate);
    const acc = { worst: { pos: 0, op: 0, clip: 0, size: 0 }, bad: [], n: 0 }, { worst, bad } = acc;
    for (let k = 0; k < Math.min(read.length, deck.sections.length); k++) await matchSection(deck, k, read[k], acc);
    gate('anim-match', !bad.length && acc.n > 0, `${acc.n} item states (${deck.steps.length} steps): slide start (during the transition) as the section start, ends within ${TOL.endPos} px, ${TOL.endSize * 100}% and opacity ${TOL.endOp}; in between ${TOL.midPos} px, opacity ${TOL.midOp}, wipe ${TOL.midClip} (largest: position ${worst.pos.toFixed(2)} px, size ${worst.size.toFixed(2)} px, opacity ${worst.op.toFixed(3)}, wipe ${worst.clip.toFixed(3)}); each click starts where the previous ended`, bad);
    const rr = await renderCompare(deck, slides, read, log);
    gate('anim-render', rr.ok, rr.detail, rr.bad);
    const tf = await textFit(deck, slides);
    gate('text-fit', tf.ok, tf.detail, tf.bad);
  } finally {
    deck.b.close();
  }
}

