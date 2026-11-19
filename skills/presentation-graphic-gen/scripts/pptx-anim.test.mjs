// pptx-anim.test.mjs: the editable deck's animation pieces that need no browser: the plan from measured series.
// Run: node --test scripts/pptx-anim.test.mjs
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { COLS, sampleTimes, stepWindows } from './pptx-anim-extract.mjs';
import { PARTIAL, easeAD, fitEase, fitProgress, monoRuns, planSection, reduceKeys } from './pptx-anim-plan.mjs';
import { sectionNotes, sectionTitle, shapeRect } from './pptx-common.mjs';

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

test('plan: a linear fade-in is one exact Fade entrance (visible from the fade start); the first step is the automatic group', () => {
  const S = section([BOX(1)], [['s1-1', 0, 0.8], ['s1-2', 0.8, 1.2]], [(t) => ({ op: ramp(t, 0.1, 0.5) })], [0.1, 0.5]);
  const plan = planSection(S);
  assert.equal(plan.shapes.length, 1);
  const fx = fxOf(plan);
  assert.equal(fx[0].cls, 'entr'); assert.equal(fx[0].preset, 10);
  const fade = fx[0].bh.find((b) => b.b === 'fade'), set = fx[0].bh.find((b) => b.b === 'set');
  assert.ok(Math.abs(fade.t0 - 0.1) < 1e-6 && Math.abs(fade.t1 - 0.5) < 1e-6 && fade.ease.a === 0 && fade.ease.d === 0, JSON.stringify(fade));
  assert.equal(set.t, fade.t0);
  assert.ok(!fx[0].bh.some((b) => b.b === 'anim'), 'no geometry');
  assert.ok(plan.steps[1].effects[0].marker, 'the empty step still has its click (a no-op marker)');
  assert.deepEqual([plan.counts.exact, plan.counts.impossible], [1, 0]);
});

test('plan: partial opacity 1 to 0.35 (crossfade) is a copy at 35%: the full shape fades out while the copy fades in, an approximation with its error', () => {
  assert.equal(PARTIAL, 'crossfade', 'the default before the stage-0 measurement');
  const S = section([BOX(1)], [['s1-1', 0, 0.6], ['s1-2', 0.6, 1.2]], [(t) => ({ op: t < 0.6 ? ramp(t, 0.1, 0.4) : 1 - 0.65 * ramp(t, 0.7, 1.0) })], [0.1, 0.4, 0.7, 1.0]);
  const plan = planSection(S);
  assert.deepEqual(plan.shapes.map((c) => c.name), ['shape div.b1 #1', 'shape div.b1 #1@35']);
  const two = plan.steps[1].effects;
  assert.deepEqual(two.map((f) => [plan.shapes[f.shape].name, f.cls]), [['shape div.b1 #1', 'exit'], ['shape div.b1 #1@35', 'entr']]);
  const [a, b] = two.map((f) => f.bh.find((x) => x.b === 'fade'));
  assert.ok(a.t0 === b.t0 && a.t1 === b.t1);
  const note = plan.notes.find((n) => /crossfade copy/.test(n.text));
  assert.ok(note && note.cat === 'approx' && note.step === 's1-2', JSON.stringify(plan.notes));
  const err = +/max ([\d.]+)/.exec(note.text)[1];
  assert.ok(err > 0.05 && err < 0.12, note.text);
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
  const note = plan.notes.find((n) => /opacity 0 to 1/.test(n.text));
  assert.ok(!note || +/max ([\d.]+)/.exec(note.text)[1] < 0.2, note && note.text);
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

