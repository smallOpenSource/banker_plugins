// Tests for the logic of step-nav.js (scene-by-scene navigation for the scroll-world intro).
// The browser wiring is checked in a real browser by verify-intro.mjs.
// Run from the repo root: node --test skills/3d-intro-build/references/step-nav.test.mjs
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { DEFAULTS, belongsToIntro, createNavigator, createWheelGesture, dirOf, gridOf, keyInput, moveDuration, postersReady, sceneAt, settleTarget, stepFrom, stopPositions, totalWeight, wheelIgnored, wheelNotches } = require('./step-nav.js');

const CONFIG = { diveScroll: 1.3, connScroll: 0.9, sections: [{}, {}, {}], connectors: ['c1.mp4', null] };

test('a move takes 2.6 s plus 0.76 s per screen height, at most 5.6 s, and none with reduced motion', () => {
  assert.equal(moveDuration(1000, 1000, DEFAULTS, false), 3360);
  assert.equal(moveDuration(5000, 1000, DEFAULTS, false), 5600);
  assert.equal(moveDuration(3000, 1000, DEFAULTS, true), 0);
});

test('one wheel gesture is one step: a fresh flick during the inertia tail starts the next', () => {
  const g = createWheelGesture(DEFAULTS);
  const feed = (dy, t) => g.feed({ deltaY: dy, deltaX: 0 }, t);
  assert.deepEqual([feed(10, 0), feed(40, 16), feed(80, 32), feed(30, 48), feed(10, 64), feed(4, 80)],
    ['new', 'same', 'same', 'same', 'same', 'same']);
  assert.equal(feed(14, 96), 'new', 'above max(min*2, min+8) = 12 after falling under half the peak');
  const tail = createWheelGesture(DEFAULTS);
  assert.deepEqual([80, 60, 40, 20, 10, 5, 3].map((dy, i) => tail.feed({ deltaY: dy }, i * 16)),
    ['new', 'same', 'same', 'same', 'same', 'same', 'same'], 'a decaying tail stays one gesture');
});

test('a pause over 220 ms or a turn of direction starts a new gesture; tiny, zoom and sideways wheels are ignored', () => {
  const g = createWheelGesture(DEFAULTS);
  assert.equal(g.feed({ deltaY: 10 }, 0), 'new');
  assert.equal(g.feed({ deltaY: 10 }, 300), 'new');
  assert.equal(g.feed({ deltaY: -10 }, 310), 'new');
  assert.equal(g.feed({ deltaY: 1 }, 320), 'ignore');
  assert.equal(g.feed({ deltaY: 30, ctrlKey: true }, 330), 'ignore');
  assert.equal(g.feed({ deltaY: 5, deltaX: 40 }, 340), 'ignore');
});

// A navigator over 4 stops (3 scenes and the body) with a fake clock and a move driver the test ends.
function nav(stops = [0, 1000, 2000, 2500], lastStop = 2) {
  const moves = [];
  let where = 0;
  const n = createNavigator({ stops: () => stops, lastStop, where: () => where, move: (from, to, done, instant) => moves.push({ from, to, done, instant }) });
  return { n, moves, at: (y) => { where = y; }, arrive: () => moves.at(-1).done() };
}

test('the intro takes an input only above the body top, or an up input at it; without a body it never traps', () => {
  assert.equal(belongsToIntro(4000, 'down', 4800, 5200), true);
  assert.equal(belongsToIntro(4800, 'down', 4800, 5200), true, 'from the last scene down goes to the body');
  assert.equal(belongsToIntro(5200, 'down', 4800, 5200), false, 'the body scrolls as usual');
  assert.equal(belongsToIntro(5200, 'up', 4800, 5200), true, 'one up input returns to the last scene');
  assert.equal(belongsToIntro(6000, 'up', 4800, 5200), false);
  assert.equal(belongsToIntro(4800, 'down', 4800, null), false, 'no body element: past the last scene the page scrolls on');
  assert.equal(belongsToIntro(4800, 'up', 4800, null), true);
  assert.equal(belongsToIntro(100, 'down', 4800, null), true);
});

test('zoom and sideways wheels stay with the browser; a tiny wheel is held but moves nothing', () => {
  assert.equal(wheelIgnored({ deltaY: 40, ctrlKey: true }), true);
  assert.equal(wheelIgnored({ deltaY: 5, deltaX: 40 }), true);
  assert.equal(wheelIgnored({ deltaY: 1 }), false, 'held, or an inertia tail nudges the page off its stop');
  assert.equal(createWheelGesture(DEFAULTS).feed({ deltaY: 1 }, 0), 'ignore', 'and it starts no gesture');
  assert.equal(wheelIgnored({ deltaY: 40 }), false);
});

test('the scroll length matches the engine: dives and the connectors that exist, plus one screen', () => {
  assert.equal(totalWeight(CONFIG), 1.3 + 0.9 + 1.3 + 1.3);
});

test('a move waits for every poster to decode (the engine paints a newly shown scene empty until then), at most decodeCapMs', async () => {
  assert.equal(DEFAULTS.decodeCapMs, 300);
  const world = (decode) => ({ querySelectorAll: () => [{ decode }, { decode }, {}] });
  let ran = 0;
  await new Promise((r) => postersReady(world(() => Promise.resolve()), 5000, () => { ran++; r(); }));
  assert.equal(ran, 1, 'decoded: goes at once');
  const t0 = Date.now();
  await new Promise((r) => postersReady(world(() => new Promise(() => {})), 120, () => { ran++; r(); }));
  assert.ok(Date.now() - t0 >= 110 && ran === 2, 'a decode that never ends waits only the cap');
  await new Promise((r) => postersReady(world(() => Promise.reject(new Error('broken'))), 5000, () => { ran++; r(); }));
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(ran, 3, 'a failed decode still goes, once');
});

test('stops are each scene\'s start (an exit belongs to the way to the next scene), the last scene\'s end, then the body', () => {
  // dive0 0-1300, conn0 1300-2200, dive1 2200-3500 (no connector after it), dive2 3500-4800
  assert.deepEqual(stopPositions(CONFIG, 1000, null), [0, 2201, 3501, 4800], 'scene starts one pixel inside the scene');
  assert.deepEqual(stopPositions(CONFIG, 1000, 5200), [0, 2201, 3501, 4800, 5200]);
  assert.deepEqual(stopPositions({ ...CONFIG, sections: [{}, { scroll: 2 }, {}] }, 1000, null), [0, 2201, 4201, 5500]);
  assert.deepEqual(stopPositions({ sections: [{}] }, 800, null), [0, 1040]);
  assert.deepEqual(gridOf([0, 2200, 3500]), [0, 1100, 2200, 2850, 3500]);
  assert.deepEqual(stopPositions(CONFIG, 800, null).slice(0, 3), [0, 1761, 2801], 'past the engine start 1760.0000000000002 (2.2 x 800 in floats)');
});

test('a notch or an arrow moves to the next grid point (a half point or a stop); off the grid the first goes to the next one that way', () => {
  const g = gridOf([0, 2200, 3500, 4800]);
  assert.equal(stepFrom(g, 0, 1), 1100);
  assert.equal(stepFrom(g, 0, 2), 2200, 'two notches: the next scene');
  assert.equal(stepFrom(g, 2200, -1), 1100);
  assert.equal(stepFrom(g, 1500, 1), 2200, 'from between points: the next point down');
  assert.equal(stepFrom(g, 1500, -1), 1100);
  assert.equal(stepFrom(g, 4800, 1), null, 'nothing below the last');
  assert.equal(stepFrom(g, 0, -1), null);
  assert.equal(stepFrom(g, 4000, 9), 4800, 'clamped to the last point');
  assert.equal(stepFrom([0, 2200, 3500], 1100, 1), 2200, 'a scene step from a half point is the next stop');
});

test('wheel deltas add up to notches: pixels, lines and pages, and a touchpad\'s small deltas over several events', () => {
  const o = DEFAULTS;
  assert.deepEqual(wheelNotches({ deltaY: 100, deltaMode: 0 }, 0, o), { n: 1, carry: 0 });
  assert.deepEqual(wheelNotches({ deltaY: 120, deltaMode: 0 }, 0, o), { n: 1, carry: 20 });
  assert.deepEqual(wheelNotches({ deltaY: 3, deltaMode: 1 }, 0, o), { n: 1, carry: 20 }, '3 lines of 40 px');
  assert.deepEqual(wheelNotches({ deltaY: 1, deltaMode: 2 }, 0, o), { n: 2, carry: 0 }, 'a page is a scene');
  assert.deepEqual(wheelNotches({ deltaY: -100, deltaMode: 0 }, 0, o), { n: -1, carry: 0 });
  let carry = 0;
  let total = 0;
  for (let k = 0; k < 12; k++) { const w = wheelNotches({ deltaY: 9, deltaMode: 0 }, carry, o); carry = w.carry; total += w.n; }
  assert.equal(total, 1, '12 touchpad deltas of 9 px: one notch');
  assert.equal(o.maxNotches, 2, 'a gesture moves at most a scene');
});

test('keys: arrows (and left/right) as the wheel, page keys, Space and swipes a scene, Home and End the ends; fields keep every key', () => {
  const el = (tagName, role = null) => ({ tagName, getAttribute: (k) => (k === 'role' ? role : null) });
  const key = (k, target, extra = {}) => keyInput({ key: k, target, ...extra });
  assert.deepEqual(key('ArrowDown', el('BODY')), { steps: 1 });
  assert.deepEqual(key('ArrowRight', el('BODY')), { steps: 1 });
  assert.deepEqual(key('ArrowUp', el('BUTTON')), { steps: -1 });
  assert.deepEqual(key('ArrowLeft', el('BODY')), { steps: -1 });
  assert.deepEqual(key('PageDown', el('BODY')), { scenes: 1 });
  assert.deepEqual(key('PageUp', el('BODY')), { scenes: -1 });
  assert.deepEqual(key(' ', el('BODY')), { scenes: 1 });
  assert.deepEqual(key(' ', el('BODY'), { shiftKey: true }), { scenes: -1 });
  assert.deepEqual(key('Home', el('BODY')), { to: 0, instant: true }, 'Home goes at once');
  assert.deepEqual(key('End', el('BODY')), { to: 'last', instant: true }, 'End goes at once');
  assert.equal(key(' ', el('BUTTON')), null);
  assert.equal(key('ArrowDown', el('INPUT')), null);
  assert.equal(key('Home', el('DIV', 'textbox')), null);
  assert.equal(key('ArrowDown', el('DIV', 'listbox')), null);
  assert.equal(key('ArrowDown', el('BODY'), { ctrlKey: true }), null);
  assert.equal(dirOf([0, 2200, 3500], 0, { steps: -1 }), null, 'nothing above the first scene');
  assert.equal(dirOf([0, 2200, 3500], 2200, { to: 0 }), 'up');
});

test('the navigator moves to stops and half points; an input during a move retargets from where it was going; cancel drops the move', () => {
  const { n, moves, at, arrive } = nav([0, 2200, 3500, 4800]);
  n.input({ steps: 1 });
  assert.deepEqual([moves[0].from, moves[0].to], [0, 1100]);
  at(500);
  n.input({ steps: 1 });
  assert.deepEqual([moves[1].from, moves[1].to], [500, 2200], 'the second notch: from where the page is, to the next scene');
  moves[0].done();
  assert.equal(n.state().moving, true, 'the first move\'s end does nothing');
  arrive();
  assert.deepEqual([n.state().index, n.state().onStop, n.state().moving, n.state().arrivals], [1, true, false, 1], 'two inputs, one arrival');
  n.input({ scenes: 1 });
  n.cancel();
  moves.at(-1).done();
  assert.equal(n.state().moving, false);
  n.sync(3510);
  n.input({ to: 0 });
  assert.equal(moves.at(-1).to, 0);
});

test('the body is reached only from the last scene\'s end; a page at rest off the grid settles on the nearest stop', () => {
  const { n, arrive } = nav([0, 2200, 3500, 4800, 5600], 3);
  n.sync(4800);
  n.input({ scenes: 1 });
  arrive();
  assert.equal(n.state().atBody, true);
  assert.equal(settleTarget([0, 2200, 3500, 4800], 3, 1500), 1);
  assert.equal(settleTarget([0, 2200, 3500, 4800], 3, 1100), -1, 'a half point stays');
  assert.equal(settleTarget([0, 2200, 3500, 4800], 3, 2200.5), -1, 'a stop stays');
  assert.equal(settleTarget([0, 2200, 3500, 4800, 5600], 3, 5300), 3, 'never onto the body from above it');
});

test('the copy in view: the dive holding the place, across an exit the nearer scene', () => {
  // dive0 0-1300, conn0 1300-2200, dive1 2200-3500, dive2 3500-4800
  assert.deepEqual([0, 1100, 1700, 1800, 2200, 2850, 3500, 4800].map((y) => sceneAt(CONFIG, 1000, y)), [0, 0, 0, 1, 1, 1, 2, 2]);
});

test('Home, End and a route dot move at once: the navigator hands the move an instant flag; other inputs animate', () => {
  const { n, moves, arrive } = nav([0, 2200, 3500, 4800]);
  n.input({ to: 3, instant: true });
  assert.deepEqual([moves[0].to, moves[0].instant], [4800, true]);
  arrive();
  n.input({ scenes: -1 });
  assert.deepEqual([moves[1].to, moves[1].instant], [3500, false]);
  arrive();
  n.input({ to: 0, instant: true });
  assert.deepEqual([moves[2].to, moves[2].instant], [0, true]);
});
