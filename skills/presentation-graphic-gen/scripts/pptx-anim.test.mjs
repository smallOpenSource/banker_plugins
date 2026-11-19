// pptx-anim.test.mjs: the editable deck's animation pieces that need no browser: the plan from measured series,
// the timing XML and the structure checker (negative cases too), the independent simulator and the anim gates.
// Run: node --test scripts/pptx-anim.test.mjs
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { COLS, sampleTimes, stepWindows } from './pptx-anim-extract.mjs';
import { easeAD, fitEase, fitProgress, monoRuns, planSection, reduceKeys } from './pptx-anim-plan.mjs';
import { formula, timingXml, transitionXml, glowXml } from './pptx-anim-xml.mjs';
import { checkSlide, parseXml } from './pptx-xmlcheck.mjs';
import { sectionNotes, sectionTitle, shapeRect } from './pptx-common.mjs';
import { evalFormula, itemsAt, readSlide, smilProgress, stateAt, wipeVisible } from './pptx-anim-sim.mjs';
import { animGates, continuity } from './pptx-anim-gates.mjs';
import { slideHtml } from './pptx-anim-render.mjs';

// ---------- a synthetic section: items with a state function of time ----------
const out = (u) => 1 - (1 - u) * (1 - u) * (1 - u);
const ramp = (t, a, b) => Math.max(0, Math.min(1, (t - a) / (b - a)));
const BOX = (n, extra = {}) => ({ kind: 'box', n, x: 400, y: 300, w: 200, h: 100, rad: 0, what: `div.b${n}`, fill: { hex: 'FF0000', a: 1 }, line: null, glow: null, e: n - 1, ...extra });
// steps: [[id, start, end]]; fns[k](t) -> partial state { cx, cy, sx, sy, rot, op, cl, ct, cr, cb } of item k
function section(items, steps, fns, segTimes = []) {
  const windows = steps.map(([id, start, end], k) => ({ id, k, start, t0: start, end }));
  const times = sampleTimes(windows, segTimes);
  const rest = (it) => ({ cx: it.x + it.w / 2, cy: it.y + it.h / 2, sx: 1, sy: 1, rot: 0, op: 1, cl: 0, ct: 0, cr: 1, cb: 1 });
  const states = times.map((t) => items.map((it, k) => { const s = Object.assign(rest(it), fns[k](t)); return COLS.map((c) => s[c]); }));
  return { n: 1, name: 'x', ids: steps.map((s) => s[0]), windows, bg: '000000', items, times, states, pics: {} };
}
const fxOf = (plan) => plan.steps.flatMap((st) => st.effects.map((f) => ({ step: st.id, name: plan.shapes[f.shape].name, ...f })));

test('monoRuns: one run per direction; a short flat stretch (slow tail, a sample just before a segment end) does not split it', () => {
  const T = [0, 0.1, 0.1001, 0.2, 0.3, 0.32, 0.4, 0.5, 0.6];
  const v = [0, 0.3, 0.3, 0.6, 0.9, 0.9, 1, 1, 0.5];
  assert.deepEqual(monoRuns(T, v, 1e-6).map((r) => [r.a, r.b, r.s]), [[0, 6, 1], [7, 8, -1]]);
  assert.deepEqual(monoRuns([0, 1, 2, 3], [0, 1, 1, 2], 1e-6).map((r) => [r.a, r.b]), [[0, 1], [2, 3]], 'a 1 s hold ends a run');
});

test('easeAD and fitEase: linear is accel 0 decel 0; a quadratic ease-out is decel 100%; an ease-out that settles early fits a shorter fade', () => {
  assert.equal(easeAD(0.5, 0, 0), 0.5);
  assert.ok(Math.abs(easeAD(0.5, 0, 1) - 0.75) < 1e-12 && Math.abs(easeAD(0.5, 1, 0) - 0.25) < 1e-12);
  const us = Array.from({ length: 41 }, (_, i) => i / 40);
  const lin = fitEase(us, us);
  assert.ok(lin.err < 1e-9 && lin.a === 0 && lin.d === 0 && lin.s === 0 && lin.e === 1, JSON.stringify(lin));
  const q = fitEase(us, us.map((u) => 1 - (1 - u) * (1 - u)));
  assert.ok(q.err < 1e-9 && q.d === 1 && q.a === 0, JSON.stringify(q));
  const c = fitEase(us, us.map(out));
  assert.ok(c.err < 0.05 && c.e < 1, `cubic ease-out: ${JSON.stringify(c)}`);
  assert.ok(us.every((u, i) => Math.abs(fitProgress(u, c) - out(us[i])) <= c.err + 1e-12));
});

test('reduceKeys keeps both ends and every point the line through the kept ones misses by more than the tolerance', () => {
  const T = Array.from({ length: 61 }, (_, i) => i / 60), v = T.map((t) => 240 * out(t));
  const keep = reduceKeys(T, v, 0, 60, 0.3);
  assert.equal(keep[0], 0); assert.equal(keep[keep.length - 1], 60);
  assert.ok(keep.length < 30, String(keep.length));
  for (let i = 0; i <= 60; i++) {
    const j = keep.findIndex((k) => k >= i), a = keep[Math.max(0, j - 1)], b = keep[j];
    const lin = a === b ? v[a] : v[a] + ((v[b] - v[a]) * (T[i] - T[a])) / (T[b] - T[a]);
    assert.ok(Math.abs(lin - v[i]) <= 0.3 + 1e-9, `sample ${i}`);
  }
});

const opTrack = (f) => f.bh.find((b) => b.b === 'anim' && b.attr === 'style.opacity');
test('plan: a fade-in is a Fade entrance whose opacity is style.opacity keyframes (visible from the change start, exact); the first step is the automatic group', () => {
  const S = section([BOX(1)], [['s1-1', 0, 0.8], ['s1-2', 0.8, 1.2]], [(t) => ({ op: out(ramp(t, 0.1, 0.5)) })], [0.1, 0.5]);
  const plan = planSection(S);
  assert.equal(plan.shapes.length, 1);
  const fx = fxOf(plan);
  assert.equal(fx[0].cls, 'entr'); assert.equal(fx[0].preset, 10);
  assert.ok(!fx[0].bh.some((b) => b.b === 'fade'), 'no Fade filter');
  const op = opTrack(fx[0]), set = fx[0].bh.find((b) => b.b === 'set');
  assert.ok(Math.abs(op.t0 - 0.1) < 1e-6 && Math.abs(op.t1 - 0.5) < 0.02 && op.keys[0].v === 0 && Math.abs(op.keys[op.keys.length - 1].v - 1) < 1e-4, JSON.stringify(op).slice(0, 200));
  for (const t of S.times.filter((x) => x > 0.1 && x < 0.5)) {
    const j = op.keys.findIndex((k) => k.t >= t), a = op.keys[j - 1], c = op.keys[j];
    const v = j < 0 ? op.keys[op.keys.length - 1].v : a.v + ((c.v - a.v) * (t - a.t)) / (c.t - a.t);
    assert.ok(Math.abs(v - out(ramp(t, 0.1, 0.5))) <= 0.0041, `t ${t}`);
  }
  assert.equal(set.t, op.t0);
  assert.ok(plan.steps[1].effects[0].marker, 'the empty step still has its click (a no-op marker)');
  assert.deepEqual([plan.counts.exact, plan.counts.approx, plan.counts.impossible], [1, 1, 0], 'the one approx is the first step after the transition');
});

test('plan: partial opacity 1 to 0.35 is one shape (no copies): a style.opacity track in its own effect, exact', () => {
  const S = section([BOX(1)], [['s1-1', 0, 0.6], ['s1-2', 0.6, 1.2]], [(t) => ({ op: t < 0.6 ? ramp(t, 0.1, 0.4) : 1 - 0.65 * ramp(t, 0.7, 1.0) })], [0.1, 0.4, 0.7, 1.0]);
  const plan = planSection(S);
  assert.deepEqual(plan.shapes.map((c) => c.name), ['shape div.b1 #1']);
  const two = plan.steps[1].effects;
  assert.deepEqual(two.map((f) => [f.cls, f.preset]), [['emph', 0]]);
  const op = opTrack(two[0]);
  assert.deepEqual([op.keys[0].v, op.keys[op.keys.length - 1].v].map((v) => Math.round(v * 100) / 100), [1, 0.35]);
  assert.ok(!plan.notes.some((n) => /crossfade|opacity/.test(n.text)), JSON.stringify(plan.notes));
});

test('plan: an item never fully opaque is drawn at its highest opacity (#n@40) and its keyframes count from there', () => {
  const S = section([BOX(1)], [['s1-1', 0, 0.6]], [(t) => ({ op: 0.4 * ramp(t, 0.1, 0.4) })], [0.1, 0.4]);
  const plan = planSection(S), op = opTrack(fxOf(plan)[0]);
  assert.deepEqual(plan.shapes.map((c) => [c.name, c.level]), [['shape div.b1 #1@40', 0.4]]);
  assert.ok(Math.abs(op.keys[op.keys.length - 1].v - 1) < 1e-9);
});

test('plan: a move with an ease-out inside the fade is sampled keyframes on ppt_x (exact to 0.3 px); values are relative to the rest place', () => {
  const S = section([BOX(1)], [['s1-1', 0, 1.2]], [(t) => ({ op: ramp(t, 0.1, 0.5), cx: 500 + 240 * (1 - out(ramp(t, 0.1, 1.1))) })], [0.1, 0.5, 1.1]);
  const fx = fxOf(planSection(S));
  assert.equal(fx.length, 1);
  const tr = fx[0].bh.find((b) => b.b === 'anim' && b.attr === 'ppt_x');
  assert.ok(tr && !fx[0].bh.some((b) => b.attr === 'ppt_y'), 'only x moves');
  assert.ok(Math.abs(tr.keys[0].v * 1920 - 240) < 0.01 && Math.abs(tr.keys[tr.keys.length - 1].v) < 1e-6, JSON.stringify(tr.keys.slice(0, 2)));
  for (const t of S.times.filter((x) => x > 0.1 && x < 1.1)) {
    const j = tr.keys.findIndex((k) => k.t >= t), a = tr.keys[j - 1], b = tr.keys[j];
    const v = (j < 0 ? tr.keys[tr.keys.length - 1].v : a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t)) * 1920;
    assert.ok(Math.abs(v - 240 * (1 - out(ramp(t, 0.1, 1.1)))) < 0.31, `t ${t}`);
  }
});

test('plan: a bar that draws from its left end (opacity 1, width 0 before) enters with Appear when it starts and grows by ppt_w with its center moving', () => {
  const ul = BOX(1, { what: 'i.ul', h: 8 });
  const S = section([ul], [['s1-1', 0, 0.5], ['s1-2', 0.5, 1.2]], [(t) => { const k = ramp(t, 0.6, 1.0); return { sx: k, cx: 400 + 100 * k }; }], [0.6, 1.0]);
  const plan = planSection(S);
  assert.equal(plan.shapes[0].vis0, false, 'not shown during the transition');
  const fx = fxOf(plan).filter((f) => !f.marker);
  assert.equal(fx.length, 1);
  assert.deepEqual([fx[0].step, fx[0].cls, fx[0].preset], ['s1-2', 'entr', 1]);
  assert.ok(Math.abs(fx[0].bh[0].t - 0.6) < 0.01, `appears at the draw start, ${fx[0].bh[0].t}`);
  const w = fx[0].bh.find((b) => b.attr === 'ppt_w'), x = fx[0].bh.find((b) => b.attr === 'ppt_x');
  assert.ok(w.keys[0].v < 0.01 && Math.abs(w.keys[w.keys.length - 1].v - 1) < 1e-6);
  assert.ok(Math.abs(x.keys[0].v * 1920 + 100) < 0.5, 'starts at the left end (center 100 px left of rest)');
});

test('plan: a parent fade over a child fade (product, not a standard curve) is one entrance with its error, not two', () => {
  const S = section([BOX(1)], [['s1-1', 0, 1.2]], [(t) => ({ op: ramp(t, 0.1, 0.7) * out(ramp(t, 0.3, 1.0)) })], [0.1, 0.3, 0.7, 1.0]);
  const plan = planSection(S);
  const fx = fxOf(plan);
  assert.equal(fx.length, 1, JSON.stringify(fx.map((f) => f.cls)));
  assert.equal(plan.shapes.length, 1);
  assert.ok(!plan.notes.some((n) => /opacity/.test(n.text)), 'keyframes follow the product exactly');
});

test('plan: a reveal from the left (clipped to nothing, then the visible part grows from the left edge) is a Wipe entrance from the left', () => {
  const pic = { kind: 'pic', n: 1, id: 'f0', x: 100, y: 200, w: 524, h: 524, what: 'img', why: 'image', e: 0 };
  const S = section([pic], [['s1-1', 0, 1.2]], [(t) => ({ op: t >= 0.1 ? 1 : 0, cr: 0.0038 + (0.9924 - 0.0038) * out(ramp(t, 0.1, 0.9)), cl: 0.0038, ct: 0.0038, cb: 0.9962 })], [0.1, 0.9]);
  const plan = planSection(S);
  const fx = fxOf(plan);
  assert.deepEqual(fx.map((f) => [f.cls, f.preset, f.side]), [['entr', 22, 'left']]);
  assert.ok(plan.notes.some((n) => /wipe from left/.test(n.text)) || plan.counts.exact === 1);
  assert.equal(plan.counts.impossible, 0);
});

test('plan: a clip that only narrows part way cannot be shown and is listed as not possible', () => {
  const S = section([BOX(1)], [['s1-1', 0, 1.2]], [(t) => ({ cr: 1 - 0.4 * ramp(t, 0.2, 0.8) })], [0.2, 0.8]);
  const plan = planSection(S);
  assert.equal(plan.counts.impossible, 1);
  assert.match(plan.notes.find((n) => n.cat === 'impossible').text, /shape div\.b1 #1 clip change .* shown unclipped/);
});

test('plan: a shape shown from the start at another size than its rest gets that size at the start of the first step', () => {
  const S = section([BOX(1)], [['s1-1', 0, 1.0]], [(t) => ({ sx: 0.5 + 0.5 * ramp(t, 0.5, 0.9) })], [0.5, 0.9]);
  const fx = fxOf(planSection(S));
  const w = fx[0].bh.find((b) => b.attr === 'ppt_w');
  assert.equal(fx[0].cls, 'emph');
  assert.ok(w.t0 === 0 && Math.abs(w.keys[0].v - 0.5) < 1e-9, JSON.stringify(w).slice(0, 200));
});

test('stepWindows and sampleTimes: the first step of a later section starts its motion 0.15 s in; samples cover every segment end and the time just before it', () => {
  const steps = [{ id: 'a', start: 0, end: 1 }, { id: 'b', start: 1, end: 2 }];
  assert.deepEqual(stepWindows({ ids: ['a', 'b'] }, steps, true).map((w) => w.t0), [0, 1]);
  assert.deepEqual(stepWindows({ ids: ['a', 'b'] }, steps, false).map((w) => w.t0), [0.15, 1]);
  const T = sampleTimes([{ start: 0, t0: 0, end: 0.5 }], [0.2337]);
  assert.ok(T.includes(0.2337) && T.includes(0.2336) && T.includes(0.5) && T[0] === 0);
  assert.ok(T.every((t, i) => i === 0 || t > T[i - 1]));
});

test('section notes and titles; the shape rectangle of a box (inset by half its outline) and of a text line (widened on the free side)', () => {
  assert.equal(sectionNotes([{ key: '1-1', speech: '말.', directions: ['연출'] }, { key: '1-2', speech: '', directions: [] }]), '[1-1]\n말.\n\n[연출]\n\n[1-2]');
  assert.equal(sectionTitle({ n: 3, name: '순서' }), '3. 순서');
  assert.deepEqual(shapeRect({ kind: 'box', x: 10, y: 10, w: 100, h: 50, line: { w: 4 } }), { x: 12, y: 12, w: 96, h: 46 });
  const r = shapeRect({ kind: 'text', x: 100, y: 0, w: 100, h: 40, align: 'right' });
  assert.ok(Math.abs(r.x + r.w - 200) < 1e-9 && r.w > 100);
});

// ---------- XML ----------
const SLIDE = (inner, timing = '') => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${inner}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>${timing}</p:sld>`;
const SP = (id, text) => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="s${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/>${text ? `<p:txBody><a:bodyPr/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody>` : ''}</p:sp>`;
const PIC = (id) => `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="p${id}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill/><p:spPr/></p:pic>`;
const SHAPES = SP(2, '글') + SP(3) + PIC(4);

function miniPlan() {
  const S = section([BOX(1), BOX(2), BOX(3)], [['s1-1', 0, 0.8], ['s1-2', 0.8, 1.6], ['s1-3', 1.6, 2.2]], [
    (t) => ({ op: ramp(t, 0.1, 0.5), cy: 350 + 24 * (1 - out(ramp(t, 0.1, 0.5))) }),
    (t) => ({ op: ramp(t, 0.9, 1.2) }),
    (t) => ({ op: t < 1.7 ? 0 : 1 }),
  ], [0.1, 0.5, 0.9, 1.2, 1.7]);
  return planSection(S);
}

test('timingXml: well formed in a slide, ids unique, the first group starts on its own, one click group per later step, keyframes from tm 0 to 100000, no build list, opacity as fltVal keyframes', () => {
  const plan = miniPlan();
  const xml = SLIDE(SHAPES, transitionXml() + timingXml(plan, [2, 3, 4]));
  assert.deepEqual(checkSlide(xml), []);
  assert.equal((xml.match(/evt="onBegin"/g) || []).length, 1);
  assert.equal((xml.match(/nodeType="clickEffect"/g) || []).length, 2);
  assert.doesNotMatch(xml, /bldLst|bldP/, 'PowerPoint 2019 keeps only the first effect of a text shape with a build entry');
  assert.match(xml, /<p:cBhvr><p:cTn id="\d+" dur="\d+" fill="hold">[\s\S]*?<p:attrName>style\.opacity<\/p:attrName><\/p:attrNameLst><\/p:cBhvr><p:tavLst><p:tav tm="0"><p:val><p:fltVal val="0"\/>/);
  assert.doesNotMatch(xml, /<p:animEffect/, 'no Fade filter for opacity');
  const tms = [...xml.matchAll(/<p:tavLst>([\s\S]*?)<\/p:tavLst>/g)].map((m) => [...m[1].matchAll(/tm="(\d+)"/g)].map((x) => +x[1]));
  assert.ok(tms.length && tms.every((l) => l[0] === 0 && l[l.length - 1] === 100000));
  assert.match(xml, /<p:strVal val="#ppt_y\+0\.0222\d*"\/>/, 'starts 24 px low (24 / 1080)');
  assert.match(xml, /presetID="1" presetClass="entr"/, 'the jump is Appear');
  assert.match(xml, /<p:transition spd="fast" p14:dur="250"><p:fade\/><\/p:transition>/);
});

test('formula and glow: values relative to rest, signs, factors; glow radius in EMU (1 stage px = 6350)', () => {
  assert.equal(formula('ppt_x', 0.0125), '#ppt_x+0.0125');
  assert.equal(formula('ppt_y', -0.5), '#ppt_y-0.5');
  assert.equal(formula('ppt_x', 1e-9), '#ppt_x');
  assert.equal(formula('ppt_w', 0.4), '#ppt_w*0.4');
  assert.equal(formula('ppt_h', 1), '#ppt_h');
  assert.equal(formula('r', 15.5), '15.5');
  assert.equal(glowXml(9, 'E0263F', 0.45), '<a:effectLst><a:glow rad="57150"><a:srgbClr val="E0263F"><a:alpha val="45000"/></a:srgbClr></a:glow></a:effectLst>');
});

test('checkSlide catches what makes PowerPoint repair a file or drop its timing', () => {
  const plan = miniPlan();
  const good = SLIDE(SHAPES, transitionXml() + timingXml(plan, [2, 3, 4]).replace('</p:tnLst>', '</p:tnLst><p:bldLst><p:bldP spid="2" grpId="0" animBg="1"/></p:bldLst>'));
  const bad = (from, to, re) => { const x = good.replace(from, to); assert.notEqual(x, good, String(from)); const p = checkSlide(x); assert.ok(p.some((m) => re.test(m)), `${re}: ${p.join('; ')}`); };
  bad('<p:cTn id="5"', '<p:cTn id="3"', /cTn id 3 is used twice/);
  bad(/spid="3"/g, 'spid="9"', /target spid 9 is not a shape/);
  bad('<p:bldP spid="2"', '<p:bldP spid="4"', /bldP spid 4 is not a shape with text/);
  bad(/<\/p:clrMapOvr>(<mc:AlternateContent[\s\S]*?<\/mc:AlternateContent>)(<p:timing>[\s\S]*<\/p:timing>)/, '</p:clrMapOvr>$2$1', /out of order/);
  bad(/<p:tav tm="0">/, '<p:tav tm="200000">', /outside 0\.\.100000/);
  bad(/(<p:tavLst><p:tav tm=")0(")/, '$150$2', /not ascending from 0/);
  bad('presetID="10" presetClass="entr"', 'presetID="53" presetClass="entr"', /not an allowed pair/);
  bad(/<p:cond delay="0"\/>/, '<p:cond delay="-5"/>', /cond delay "-5"/);
  bad(' xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main"', '', /prefix p14 .* not declared/);
  bad('</p:sld>', '', /not well formed/);
  bad(/(<p:anim calcmode="lin" valueType="num"><p:cBhvr><p:cTn id="\d+" dur="\d+")/, '$1 accel="90000" decel="90000"', /accel 90000 decel 90000/);
});

test('parseXml: well-formed checks (mismatched end tag, a duplicate attribute, two roots) and the tree', () => {
  assert.throws(() => parseXml('<a><b></a></b>'), /does not close/);
  assert.throws(() => parseXml('<a x="1" x="2"/>'), /attribute x twice/);
  assert.throws(() => parseXml('<a/><b/>'), /exactly one root/);
  const t = parseXml('<?xml version="1.0"?><a k=\'v\'><b>hi</b><c/></a>');
  assert.deepEqual([t.name, t.attrs.k, t.kids.map((k) => k.name), t.kids[0].text], ['a', 'v', ['b', 'c'], 'hi']);
});

// ---------- the simulator (hand-written timing, known answers) ----------
const EMU = 6350;
// a shape; alpha: its fill's transparency as written (the simulator reads it from the XML)
const SH = (id, name, x, y, w, h, alpha = null) => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x * EMU}" y="${y * EMU}"/><a:ext cx="${w * EMU}" cy="${h * EMU}"/></a:xfrm>${alpha == null ? '' : `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="FFFFFF"><a:alpha val="${Math.round(alpha * 100000)}"/></a:srgbClr></a:solidFill>`}</p:spPr></p:sp>`;
const C = (id, extra, delay, body) => `<p:par><p:cTn id="${id}"${extra} fill="hold" grpId="0">${delay != null ? `<p:stCondLst><p:cond delay="${delay}"/></p:stCondLst>` : ''}<p:childTnLst>${body}</p:childTnLst></p:cTn></p:par>`;
const BT = (id, dur, delay, spid, extra = '') => `<p:cBhvr><p:cTn id="${id}" dur="${dur}"${extra} fill="hold"><p:stCondLst><p:cond delay="${delay}"/></p:stCondLst></p:cTn><p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl>`;
const VIS = (id, spid, v, delay) => `<p:set>${BT(id, 1, delay, spid)}<p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr><p:to><p:strVal val="${v}"/></p:to></p:set>`;
const FADE = (id, spid, dir, delay, dur, extra) => `<p:animEffect transition="${dir}" filter="fade">${BT(id, dur, delay, spid, extra).replace(' fill="hold"', '')}</p:cBhvr></p:animEffect>`;
const TAV = (id, spid, attr, delay, dur, keys) => `<p:anim calcmode="lin" valueType="num">${BT(id, dur, delay, spid)}<p:attrNameLst><p:attrName>${attr}</p:attrName></p:attrNameLst></p:cBhvr><p:tavLst>${keys.map(([tm, v]) => `<p:tav tm="${tm}"><p:val><p:strVal val="${v}"/></p:val></p:tav>`).join('')}</p:tavLst></p:anim>`;
const GROUP = (id, auto, inner) => `<p:par><p:cTn id="${id}" fill="hold"><p:stCondLst><p:cond delay="indefinite"/>${auto ? '<p:cond evt="onBegin" delay="0"><p:tn val="2"/></p:cond>' : ''}</p:stCondLst><p:childTnLst>${inner}</p:childTnLst></p:cTn></p:par>`;
const TIMING = (groups) => `<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" nodeType="tmRoot"><p:childTnLst><p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>${groups}</p:childTnLst></p:cTn></p:seq></p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>`;
// shape 2 (#1) fades in 100..500 ms with the auto group; click 1: it moves 192 px right over 1000 ms while shape 3
// (#1@35, a copy) fades in from 200 ms; click 2: an inner group after the first: shape 2 fades out (accel 100%)
const SIMXML = SLIDE(SH(2, 'shape div.a #1', 100, 100, 200, 100) + SH(3, 'shape div.a #1@35', 100, 100, 200, 100, 0.35), TIMING(
  GROUP(10, true, C(11, '', 0, C(12, ' presetID="10" presetClass="entr" nodeType="afterEffect"', 100, VIS(13, 2, 'visible', 0) + FADE(14, 2, 'in', 0, 400))))
  + GROUP(20, false, C(21, '', 0, C(22, ' presetID="0" presetClass="emph" nodeType="clickEffect"', 0, TAV(23, 2, 'ppt_x', 0, 1000, [[0, '#ppt_x'], [50000, '#ppt_x+0.075'], [100000, '#ppt_x+0.1']]))
    + C(24, ' presetID="10" presetClass="entr" nodeType="withEffect"', 200, VIS(25, 3, 'visible', 0) + FADE(26, 3, 'in', 0, 200))))
  + GROUP(30, false, C(31, '', 0, C(32, ' presetID="0" presetClass="emph" nodeType="clickEffect"', 0, TAV(33, 3, 'ppt_y', 0, 300, [[0, '#ppt_y'], [100000, '#ppt_y']]))) + C(34, '', 50, C(35, ' presetID="10" presetClass="exit" nodeType="afterEffect"', 0, FADE(36, 2, 'out', 0, 400, ' accel="100000"') + VIS(37, 2, 'hidden', 399))))));

test('simulator: formulas, SMIL accel / decel, and the wipe fraction', () => {
  const v = { ppt_x: 0.5, ppt_y: 0.25, ppt_w: 0.1, ppt_h: 0.2 };
  assert.equal(evalFormula('#ppt_x+0.1', v), 0.6);
  assert.ok(Math.abs(evalFormula('0-#ppt_w/2', v) + 0.05) < 1e-12);
  assert.ok(Math.abs(evalFormula('(#ppt_y+0.25)*2', v) - 1) < 1e-12);
  assert.equal(evalFormula('-1.5e-1', v), -0.15);
  assert.throws(() => evalFormula('#ppt_q', v), /unknown formula variable/);
  assert.equal(smilProgress(0.5, 0, 0), 0.5);
  assert.ok(Math.abs(smilProgress(0.5, 0, 1) - 0.75) < 1e-12 && Math.abs(smilProgress(0.5, 1, 0) - 0.25) < 1e-12);
  assert.ok(Math.abs(smilProgress(0.25, 0.5, 0.5) - 0.125) < 1e-12);
  assert.equal(wipeVisible(null), 1);
  assert.equal(wipeVisible({ out: false, p: 0.3 }), 0.3);
  assert.equal(wipeVisible({ out: true, p: 0.3 }), 0.7);
});

test('simulator: an entrance hides the shape before it, fades linearly; click groups count from their own start; inner groups run after each other', () => {
  const sl = readSlide(SIMXML);
  assert.deepEqual(sl.groups.map((g) => [g.auto, g.effects.length]), [[true, 1], [false, 2], [false, 2]]);
  const at = (k, t, id) => stateAt(sl, k, t).get(id);
  assert.deepEqual([at(0, 0, '2').vis, at(0, 0, '2').op], [false, 0], 'hidden before its entrance');
  assert.ok(Math.abs(at(0, 300, '2').op - 0.5) < 1e-9);
  assert.equal(at(0, Infinity, '2').op, 1);
  assert.equal(at(1, 0, '2').cx, 200, 'click 1 starts at rest');
  assert.ok(Math.abs(at(1, 250, '2').cx - (200 + 0.0375 * 1920)) < 1e-6, 'halfway to the 50% key');
  assert.ok(Math.abs(at(1, Infinity, '2').cx - (200 + 192)) < 1e-6);
  assert.deepEqual([at(1, 100, '3').vis, at(1, 300, '3').op], [false, 0.5], 'the copy enters 200 ms into click 1');
  // click 2: the exit is in an inner group after a 300 ms one (+ 50 ms): it starts at 350 ms, accel 100%
  assert.equal(at(2, 349, '2').op, 1);
  assert.ok(Math.abs(at(2, 550, '2').op - 0.75) < 1e-9, String(at(2, 550, '2').op));
  assert.deepEqual([at(2, Infinity, '2').vis, at(2, Infinity, '2').op], [false, 0]);
  assert.ok(Math.abs(at(2, Infinity, '2').cx - 392) < 1e-6, 'the move holds (fill hold) through later clicks');
  // the item #1 is the two shapes over each other: 1 - (1 - 1)(1 - 0.35) at the end of click 1
  const it = itemsAt(stateAt(sl, 1, Infinity)).get(1);
  assert.ok(Math.abs(it.op - 1) < 1e-9);
  assert.ok(Math.abs(itemsAt(stateAt(sl, 2, Infinity)).get(1).op - 0.35) < 1e-9);
});

// ---------- gates without the page ----------
async function gatesOf(xmls, sections) {
  const lines = [];
  const data = { sections: sections.map((ids, k) => ({ n: k + 1, ids })), steps: sections.flatMap((ids) => ids.map((id) => ({ id }))) };
  const gate = (name, state, detail, rows = []) => lines.push([name, state, detail, rows]);
  await animGates(xmls.map((xml, k) => ({ k, xml, media: () => null })), data, { gate });
  return Object.fromEntries(lines.map((l) => [l[0], l]));
}

test('anim gates without a page: xml, steps and targets are checked; match and render SKIP; anim-powerpoint is always SKIP', async () => {
  const g = await gatesOf([SIMXML], [['s1-1', 's1-2', 's1-3']]);
  assert.deepEqual(Object.keys(g), ['anim-xml', 'anim-steps', 'anim-targets', 'anim-match', 'anim-render', 'text-fit', 'anim-powerpoint']);
  assert.equal(g['anim-steps'][1], true, g['anim-steps'][2]);
  assert.equal(g['anim-targets'][1], true, g['anim-targets'][3].join('; '));
  assert.match(g['anim-targets'][2], /no --html: names not compared with the page/);
  assert.deepEqual([g['anim-match'][1], g['anim-render'][1], g['text-fit'][1], g['anim-powerpoint'][1]], [null, null, null, null]);
  assert.match(g['anim-powerpoint'][2], /pptx\.mjs com --anim/);
});

test('anim gates fail a missing click group, a second automatic group, a target that is the hidden title or has no element name', async () => {
  const short = await gatesOf([SIMXML], [['s1-1', 's1-2', 's1-3', 's1-4']]);
  assert.equal(short['anim-steps'][1], false);
  assert.match(short['anim-steps'][3][0], /1 automatic and 2 click groups, want 1 and 3 \(4 steps\)/);
  const twoAuto = await gatesOf([SIMXML.replace('<p:cond delay="indefinite"/></p:stCondLst><p:childTnLst><p:par><p:cTn id="21"', '<p:cond delay="indefinite"/><p:cond evt="onBegin" delay="0"><p:tn val="2"/></p:cond></p:stCondLst><p:childTnLst><p:par><p:cTn id="21"')], [['s1-1', 's1-2', 's1-3']]);
  assert.equal(twoAuto['anim-steps'][1], false);
  const title = await gatesOf([SIMXML.replace('<p:cNvPr id="3" name="shape div.a #1@35"/>', '<p:cNvPr id="3" name="Title 1" hidden="1"/>')], [['s1-1', 's1-2', 's1-3']]);
  assert.equal(title['anim-targets'][1], false);
  assert.match(title['anim-targets'][3].join('\n'), /target 3 is the hidden title/);
  const noname = await gatesOf([SIMXML.replace('name="shape div.a #1"', 'name="Rectangle 2"')], [['s1-1', 's1-2', 's1-3']]);
  assert.match(noname['anim-targets'][3].join('\n'), /target 2 has no element name \(Rectangle 2\)/);
  const broken = await gatesOf([SIMXML.replace('<p:cTn id="14"', '<p:cTn id="13"')], [['s1-1', 's1-2', 's1-3']]);
  assert.equal(broken['anim-xml'][1], false);
});

// ---------- what PowerPoint 2019 was measured to do (stage 0 and 7) ----------
const FX = (id, cls, pid, node, body) => `<p:par><p:cTn id="${id}"${pid == null ? '' : ` presetID="${pid}"`} presetClass="${cls}" presetSubtype="0" fill="hold" grpId="0" nodeType="${node}"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>${body}</p:childTnLst></p:cTn></p:par>`;
const FADEH = (id, spid, dir, dur) => `<p:animEffect transition="${dir}" filter="fade"><p:cBhvr><p:cTn id="${id}" dur="${dur}" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst></p:cTn><p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl></p:cBhvr></p:animEffect>`;
const SETOP = (id, spid, v) => `<p:set><p:cBhvr><p:cTn id="${id}" dur="1" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst></p:cTn><p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl><p:attrNameLst><p:attrName>style.opacity</p:attrName></p:attrNameLst></p:cBhvr><p:to><p:strVal val="${v}"/></p:to></p:set>`;
// shape 2 (text) fades in (fill="hold" on the filter), then on a click fades out; shape 3 enters with a style.opacity
// set and a Fade; written the way the deck wrote them before the measurement
const OLDXML = SLIDE(SH(2, 'text p #1', 100, 100, 200, 100).replace('</p:spPr></p:sp>', '</p:spPr><p:txBody><a:bodyPr/><a:p><a:r><a:t>글</a:t></a:r></a:p></p:txBody></p:sp>') + SH(3, 'shape div.c #2', 100, 300, 200, 100), TIMING(
  GROUP(10, true, C(11, '', 0, FX(12, 'entr', 10, 'afterEffect', VIS(13, 2, 'visible', 0) + FADEH(14, 2, 'in', 400))))
  + GROUP(20, false, C(21, '', 0, FX(22, 'exit', 10, 'clickEffect', FADEH(23, 2, 'out', 400) + VIS(24, 2, 'hidden', 399))
    + FX(25, 'entr', 10, 'withEffect', VIS(26, 3, 'visible', 0) + SETOP(27, 3, '0.4') + FADEH(28, 3, 'in', 400)))))
  .replace('</p:tnLst>', '</p:tnLst><p:bldLst><p:bldP spid="2" grpId="0" animBg="1"/></p:bldLst>'));

test('anim-xml: a Fade with fill="hold", a style.opacity set before a Fade in, a build entry on a text shape with two effects, an emph effect without presetID all fail', () => {
  const p = checkSlide(OLDXML).join('\n');
  assert.match(p, /animEffect cTn 14: fill="hold" \(a later Fade out of the shape does not play\)/);
  assert.match(p, /cTn 25: style\.opacity set before a Fade in/);
  assert.match(p, /bldP spid 2 grpId 0 has 2 effects \(PowerPoint keeps only the first\)/);
  const nopreset = checkSlide(OLDXML.replace('presetID="10" presetClass="exit"', 'presetClass="emph"'));
  assert.ok(nopreset.some((m) => /presetClass "emph" presetID "undefined" is not an allowed pair/.test(m)), nopreset.join('; '));
});

test('simulator follows PowerPoint 2019: the build entry keeps only the first effect of the text shape; without it a held Fade in stops the later Fade out; a Fade in ends at full opacity after a style.opacity set', () => {
  const built = readSlide(OLDXML);
  assert.equal(built.groups[1].effects.length, 1, 'the text shape\'s exit is dropped');
  assert.equal(stateAt(built, 1, Infinity).get('2').op, 1, 'so the text stays');
  const sl = readSlide(OLDXML.replace(/<p:bldLst>[\s\S]*<\/p:bldLst>/, ''));
  const mid = stateAt(sl, 1, 200);
  assert.deepEqual([mid.get('2').vis, mid.get('2').op], [true, 1], 'the held Fade in: no Fade out on screen (X4)');
  assert.deepEqual([stateAt(sl, 1, Infinity).get('2').vis], [false], 'hidden at its end');
  assert.equal(stateAt(sl, 1, Infinity).get('3').op, 1, 'not 0.4 (X1)');
  const free = readSlide(OLDXML.replace(/<p:bldLst>[\s\S]*<\/p:bldLst>/, '').replace(/ fill="hold"><p:stCondLst><p:cond delay="0"\/><\/p:stCondLst><\/p:cTn><p:tgtEl><p:spTgt spid="2"\/><\/p:tgtEl><\/p:cBhvr><\/p:animEffect>/g, '><p:stCondLst><p:cond delay="0"/></p:stCondLst></p:cTn><p:tgtEl><p:spTgt spid="2"/></p:tgtEl></p:cBhvr></p:animEffect>'));
  assert.ok(Math.abs(stateAt(free, 1, 200).get('2').op - 0.5) < 1e-9, 'without fill="hold" the Fade out plays (X3)');
});

// ---------- review 1: step boundaries, clicks that start with an entrance, steps with no motion ----------
test('plan (B1): a zero-length opacity change at a click step start (s.reveal) is that step\'s first effect, not a delayed effect of the step before', () => {
  const pic = { kind: 'pic', n: 1, id: 'f0', x: 100, y: 200, w: 600, h: 80, what: 'div', why: 'image', e: 0 };
  const S = section([pic], [['s1-1', 0, 0.5], ['s1-2', 0.5, 1.2]], [(t) => ({ op: t >= 0.5 ? 1 : 0, cr: t < 0.5 ? 0 : 0.01 + 0.99 * out(ramp(t, 0.5, 1.1)), cl: 0, ct: 0, cb: 1 })], [0.5, 1.1]);
  const plan = planSection(S);
  assert.ok(plan.steps[0].effects.every((f) => f.marker), JSON.stringify(plan.steps[0].effects.map((f) => [f.cls, f.preset])));
  assert.deepEqual(plan.steps[1].effects.map((f) => [f.cls, f.preset, f.side]), [['entr', 22, 'left']]);
  assert.ok(plan.notes.every((n) => !/wipe/.test(n.text) || n.step === 's1-2'), JSON.stringify(plan.notes));
});

test('plan (B2): a dim that ends where the next step starts and a fade-out at that start are two effects, one per step', () => {
  const S = section([BOX(1)], [['s1-1', 0, 0.5], ['s1-2', 0.5, 0.9], ['s1-3', 0.9, 1.3]], [(t) => ({ op: t < 0.5 ? ramp(t, 0.1, 0.4) : t <= 0.9 ? 1 - 0.65 * ramp(t, 0.6, 0.9) : 0.35 * (1 - ramp(t, 0.9, 1.2)) })], [0.1, 0.4, 0.6, 0.9, 1.2]);
  const plan = planSection(S), ends = (k) => plan.steps[k].effects.map((f) => { const o = opTrack(f); return [f.cls, Math.round(o.keys[0].v * 100) / 100, Math.round(o.keys[o.keys.length - 1].v * 100) / 100]; });
  assert.deepEqual(ends(1), [['emph', 1, 0.35]]);
  assert.deepEqual(ends(2), [['exit', 0.35, 0]]);
});

// item 1 shown from the start (static), item 2 enters in step 2; step 1 has no motion
function stillStart() {
  return section([BOX(1), BOX(2, { y: 500 })], [['s1-1', 0, 0.5], ['s1-2', 0.5, 1.0]], [() => ({ op: 1 }), (t) => ({ op: ramp(t, 0.6, 0.9) })], [0.6, 0.9]);
}
test('plan (B4): the click of a step with no motion changes no visibility, so a shape shown from the start stays shown and one entering later stays hidden during the transition', () => {
  const plan = planSection(stillStart());
  const mark = plan.steps[0].effects[0];
  assert.ok(mark.marker && mark.bh.every((b) => b.b === 'anim' && b.keys.every((k) => k.v === b.keys[0].v)), JSON.stringify(mark));
  const xml = SLIDE(SH(2, 'shape div.b1 #1', 400, 300, 200, 100) + SH(3, 'shape div.b2 #2', 400, 500, 200, 100), transitionXml() + timingXml(plan, [2, 3]));
  assert.deepEqual(checkSlide(xml), []);
  const sl = readSlide(xml), before = stateAt(sl, 0, -Infinity), first = stateAt(sl, 0, Infinity);
  assert.deepEqual([before.get('2').vis, before.get('3').vis], [true, false], 'slide start: the static shape shown, the later one hidden');
  assert.ok(Math.abs(first.get('2').cx - 500) < 1e-9 && first.get('2').vis, 'the no-op leaves the shape where it is');
});

test('anim-match continuity (B3): a click that starts with an entrance not yet seen (an underline at zero width, a wipe at 0%) starts where the previous click ended; a shape that jumps does not', () => {
  const xml = (w0) => SLIDE(SH(2, 'shape div.a #1', 100, 100, 200, 100) + SH(3, 'shape i.ul #2', 100, 220, 200, 8), TIMING(
    GROUP(10, true, C(11, '', 0, C(12, ' presetID="10" presetClass="entr" nodeType="afterEffect"', 100, VIS(13, 2, 'visible', 0) + FADE(14, 2, 'in', 0, 400))))
    + GROUP(20, false, C(21, '', 0, C(22, ' presetID="1" presetClass="entr" nodeType="clickEffect"', 0, VIS(23, 3, 'visible', 0) + TAV(24, 3, 'ppt_w', 0, 400, [[0, w0], [100000, '#ppt_w']]) + TAV(25, 3, 'ppt_x', 0, 400, [[0, '#ppt_x-0.052083'], [100000, '#ppt_x']]))))));
  const bad = [];
  continuity(readSlide(xml('#ppt_w*0')), 1, bad, 's1-2');
  assert.deepEqual(bad, []);
  continuity(readSlide(xml('#ppt_w*0.5')), 1, bad, 's1-2');
  assert.deepEqual(bad, ['s1-2 start: shape i.ul #2 does not start where the previous click ended']);
});

// ---------- review 3: an item shown dim from the start that brightens later ----------
test('plan (R1): an item shown from the start at 0.35 that brightens to 1 is two shapes: one at 35% shown during the transition, one at 100% that comes in over it; the simulator multiplies the shape transparency by style.opacity, clamped at 1 (X6)', () => {
  const S = section([BOX(1)], [['s1-1', 0, 0.5], ['s1-2', 0.5, 1.2]], [(t) => ({ op: 0.35 + 0.65 * ramp(t, 0.6, 1.0) })], [0.6, 1.0]);
  const plan = planSection(S);
  assert.deepEqual(plan.shapes.map((c) => [c.name, c.level, c.vis0]), [['shape div.b1 #1@35', 0.35, true], ['shape div.b1 #1', 1, false]]);
  const [lo, hi] = plan.shapes;
  assert.ok(Math.abs(lo.alphaOf(1) - 0.35) < 1e-9 && Math.abs(hi.alphaOf(1) - 1) < 1e-9 && Math.abs(hi.alphaOf(0.5) - 0.5 * 0.65 / (1 - 0.175)) < 1e-9, 'a 50% color: 0.394 above so that 0.175 under it makes 0.5');
  const xml = SLIDE(SH(2, 'shape div.b1 #1@35', 400, 300, 200, 100, lo.alphaOf(1)) + SH(3, 'shape div.b1 #1', 400, 300, 200, 100, hi.alphaOf(1)), transitionXml() + timingXml(plan, [2, 3]));
  assert.deepEqual(checkSlide(xml), []);
  const sl = readSlide(xml), op = (k, t) => itemsAt(stateAt(sl, k, t)).get(1).op;
  assert.ok(Math.abs(op(0, -Infinity) - 0.35) < 1e-9, `slide start ${op(0, -Infinity)}`);
  assert.ok(Math.abs(op(1, 300) - (0.35 + 0.65 * 0.5)) < 0.005, `halfway ${op(1, 300)}`);
  assert.ok(Math.abs(op(1, Infinity) - 1) < 1e-9);
  const over = SLIDE(SH(2, 'shape a #1@35', 0, 0, 100, 100, 0.35), TIMING(GROUP(10, true, C(11, '', 0, C(12, ' presetID="0" presetClass="emph" nodeType="afterEffect"', 0, TAV(13, 2, 'style.opacity', 0, 100, [[0, '1'], [100000, '2']]))))));
  assert.equal(itemsAt(stateAt(readSlide(over), 0, Infinity)).get(1).op, 0.35, 'style.opacity above 1 does not brighten past the shape\'s own 35%');
});

test('plan and simulator (R2, R3): a start opacity off the 0.01 grid (0.334, 0.85 x 0.85) still gives the upper shape an entrance; a half-transparent color over each other is the page\'s 0.5, and the simulator reads the alphas from the XML', () => {
  for (const op0 of [0.334, 0.7225]) {
    const S = section([BOX(1)], [['s1-1', 0, 0.5], ['s1-2', 0.5, 1.2]], [(t) => ({ op: op0 + (1 - op0) * ramp(t, 0.6, 1.0) })], [0.6, 1.0]);
    const plan = planSection(S), hi = plan.shapes[1];
    assert.equal(hi.vis0, false);
    assert.ok(plan.steps[1].effects.some((f) => plan.shapes[f.shape] === hi && f.cls === 'entr'), `op0 ${op0}: the upper shape enters on the click`);
    assert.ok(!plan.steps[0].effects.some((f) => plan.shapes[f.shape] === hi), `op0 ${op0}: nothing of the upper shape before`);
  }
  const S = section([BOX(1, { fill: { hex: 'FFFFFF', a: 0.5 } })], [['s1-1', 0, 0.5], ['s1-2', 0.5, 1.2]], [(t) => ({ op: 0.35 + 0.65 * ramp(t, 0.6, 1.0) })], [0.6, 1.0]);
  const plan = planSection(S), [lo, hi] = plan.shapes;
  const xml = SLIDE(SH(2, 'shape div.b1 #1@35', 400, 300, 200, 100, lo.alphaOf(0.5)) + SH(3, 'shape div.b1 #1', 400, 300, 200, 100, hi.alphaOf(0.5)), transitionXml() + timingXml(plan, [2, 3]));
  const sl = readSlide(xml), op = (k, t) => itemsAt(stateAt(sl, k, t)).get(1).op;
  assert.ok(Math.abs(op(0, -Infinity) - 0.175) < 1e-6 && Math.abs(op(1, Infinity) - 0.5) < 1e-6, `${op(0, -Infinity)} ${op(1, Infinity)}`);
  const naive = SLIDE(SH(2, 'shape div.b1 #1@35', 400, 300, 200, 100, 0.175) + SH(3, 'shape div.b1 #1', 400, 300, 200, 100, 0.5), transitionXml() + timingXml(plan, [2, 3]));
  assert.ok(Math.abs(itemsAt(stateAt(readSlide(naive), 1, Infinity)).get(1).op - 0.5875) < 1e-6, 'the alphas as the old writer wrote them make 0.5875');
});

test('anim-render draws a text line with a line box as tall as its shape (not a flex-centered "normal" line box, which Windows font metrics put 5 px lower than the page)', () => {
  const sp = SH(2, 'text h1 #1', 100, 100, 600, 120).replace('</p:spPr></p:sp>', '</p:spPr><p:txBody><a:bodyPr anchor="ctr"/><a:p><a:pPr algn="l"/><a:r><a:rPr sz="5200"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:rPr><a:t>첫 장면</a:t></a:r></a:p></p:txBody></p:sp>');
  const xml = SLIDE(sp);
  const h = slideHtml(xml, stateAt(readSlide(xml), 0, Infinity), () => null);
  assert.match(h, /line-height:120px;text-align:left;white-space:pre"><span style="font-size:104px/);
  assert.doesNotMatch(h, /align-items:center/);
});
