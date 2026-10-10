// Tests for the logic of step-nav.js (scene-by-scene navigation for the scroll-world intro).
// The browser wiring is checked in a real browser by verify-intro.mjs.
// Run from the repo root: node --test skills/3d-intro-build/references/step-nav.test.mjs
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { DEFAULTS, createNavigator, createWheelGesture, moveDuration, stopPositions } = require('./step-nav.js');

const CONFIG = { diveScroll: 1.3, connScroll: 0.9, sections: [{}, {}, {}], connectors: ['c1.mp4', null] };

test('stops follow the engine layout: first at 0, middle scenes mid-hold, the last at its end, then the body', () => {
  // dive0 0-1300, conn0 1300-2200, dive1 2200-3500 (no connector after it), dive2 3500-4800
  assert.deepEqual(stopPositions(CONFIG, 1000, null), [0, 2850, 4800]);
  assert.deepEqual(stopPositions(CONFIG, 1000, 5200), [0, 2850, 4800, 5200]);
  const paced = { ...CONFIG, sections: [{}, { scroll: 2 }, {}] };
  assert.deepEqual(stopPositions(paced, 1000, null), [0, 3200, 5500]);
  assert.deepEqual(stopPositions({ sections: [{}] }, 800, null), [0]);
});

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
function nav(stops = [0, 1000, 2000, 2500], lastScene = 2) {
  const moves = [];
  let t = 0;
  const n = createNavigator({ stops: () => stops, lastScene, guardMs: 250, now: () => t,
    move: (from, to, done) => moves.push({ from, to, done }) });
  return { n, moves, tick: (ms) => { t += ms; }, arrive: () => moves.at(-1).done() };
}

test('down and up move one stop; a dot goes straight to its scene', () => {
  const { n, moves, arrive } = nav();
  n.input('down');
  assert.deepEqual([moves[0].from, moves[0].to], [0, 1000]);
  arrive();
  n.input({ to: 0 });
  assert.equal(moves[1].to, 0);
  arrive();
  n.input('up');
  assert.equal(moves.length, 2, 'nothing above the first scene');
});

test('inputs during a move keep only the latest, run when the move ends', () => {
  const { n, moves, arrive } = nav();
  n.input('down');
  n.input('down');
  n.input('up');
  assert.equal(moves.length, 1);
  arrive();
  assert.deepEqual([moves[1].from, moves[1].to], [1000, 0], 'the queued up ran, the earlier down was replaced');
});

test('the last scene drops a down queued on the way in and ignores down for 250 ms after arriving', () => {
  const { n, moves, arrive, tick } = nav();
  n.sync(1000);
  n.input('down');
  n.input('down');
  arrive();
  assert.equal(moves.length, 1, 'the down queued while moving into the last scene was dropped');
  n.input('down');
  assert.equal(moves.length, 1, 'down right after arriving is ignored');
  n.input('up');
  assert.equal(moves[1].to, 1000, 'up still runs inside the guard');
  arrive();
  n.input('down');
  arrive();
  tick(300);
  n.input('down');
  assert.equal(moves.at(-1).to, 2500, 'after the guard a down goes on to the body');
  arrive();
  n.input('up');
  assert.equal(moves.at(-1).to, 2000, 'up from the body top returns to the last scene');
});

test('sync places the navigator at the nearest stop with a 1 px tolerance', () => {
  const { n } = nav();
  n.sync(1999.4);
  assert.equal(n.state().index, 2);
  n.sync(2499.2);
  assert.equal(n.state().index, 3);
  assert.equal(n.state().atBody, true);
});
