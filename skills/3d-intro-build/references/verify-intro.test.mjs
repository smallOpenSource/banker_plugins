// Tests for the measuring logic of verify-intro.mjs. The browser part needs Playwright and runs
// in intro-e2e.test.mjs (INTRO_E2E=1). Run from the repo root:
//   node --test skills/3d-intro-build/references/verify-intro.test.mjs
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  VIEWPORTS, contrastRatio, insideViewport, intersects, judge, parseColor, parseViewport, relLuminance, worstContrast,
} from './verify-intro.mjs';

test('the default screens are the ones the guide lists, touch where a phone is', () => {
  assert.deepEqual(VIEWPORTS.map((v) => `${v.width}x${v.height}${v.touch ? ' touch' : ''}`),
    ['1280x800', '1920x1080', '860x900', '390x844 touch', '375x667 touch']);
});

test('a screen size on the command line may mark touch and reduced motion', () => {
  assert.deepEqual(parseViewport('390x844t'), { width: 390, height: 844, touch: true, reduce: false });
  assert.deepEqual(parseViewport('1280x800r'), { width: 1280, height: 800, touch: false, reduce: true });
  assert.throws(() => parseViewport('big'), /not a screen size/);
});

test('contrast follows WCAG: white on black is 21, equal colours 1', () => {
  assert.equal(relLuminance([255, 255, 255]), 1);
  assert.equal(relLuminance([0, 0, 0]), 0);
  assert.equal(contrastRatio(1, 0), 21);
  assert.equal(contrastRatio(0.5, 0.5), 1);
  assert.equal(Number(contrastRatio(relLuminance([241, 245, 249]), relLuminance([11, 18, 32])).toFixed(2)), 17.09, '#F1F5F9 on #0B1220, worked by hand');
  assert.deepEqual(parseColor('rgb(241, 245, 249)'), [241, 245, 249]);
  assert.deepEqual(parseColor('rgba(255, 255, 255, 0.5)'), [255, 255, 255]);
});

test('a colour reads in the forms a browser reports, and an unknown form is not taken for black', () => {
  assert.deepEqual(parseColor('color(srgb 0.765882 0.922353 0.991765)'), [195, 235, 253], 'color-mix() in srgb');
  assert.deepEqual(parseColor('rgb(1 2 3 / 0.5)'), [1, 2, 3]);
  assert.equal(parseColor('oklch(0.7 0.1 200)'), null);
  const ok = { inViewport: true, belowHeader: true, overlaps: [], hOverflow: false };
  assert.deepEqual(judge({ ...ok, contrast: [{ el: 'eyebrow', line: 1, min: null, color: 'oklch(0.7 0.1 200)' }] }, { minContrast: 4.5 }),
    ['contrast eyebrow line 1: colour not measured (oklch(0.7 0.1 200))']);
});

test('a line is judged by its worst pixel behind it, light or dark text alike', () => {
  // 4 x 2 RGBA image: dark navy everywhere but one bright pixel at (3, 1).
  const w = 4;
  const px = new Uint8ClampedArray(4 * 2 * 4);
  for (let i = 0; i < px.length; i += 4) px.set([11, 18, 32, 255], i);
  px.set([200, 210, 220, 255], (1 * w + 3) * 4);
  const light = [241, 245, 249];
  const all = worstContrast(light, px, w, { x: 0, y: 0, width: 4, height: 2 });
  const left = worstContrast(light, px, w, { x: 0, y: 0, width: 3, height: 2 });
  assert.ok(all < 1.5, `the bright pixel decides: ${all}`);
  assert.ok(left > 16, `without it the navy decides: ${left}`);
  const dark = worstContrast([11, 18, 32], px, w, { x: 0, y: 0, width: 4, height: 2 });
  assert.ok(dark < 1.1, 'dark text is judged by the darkest pixel');
});

test('boxes overlap only when they share area, and a panel must sit inside the screen', () => {
  assert.equal(intersects({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 5, height: 5 }), false);
  assert.equal(intersects({ x: 0, y: 0, width: 10, height: 10 }, { x: 9, y: 9, width: 5, height: 5 }), true);
  assert.equal(insideViewport({ x: 0.4, y: 81.3, width: 300, height: 200 }, 1280, 800), true, '1 px of slack for fractional layout');
  assert.equal(insideViewport({ x: -3, y: 10, width: 300, height: 200 }, 1280, 800), false);
});

test('a scene fails on overflow, overlap, a panel off screen or under the header, low contrast or console errors', () => {
  const ok = { inViewport: true, belowHeader: true, overlaps: [], hOverflow: false, contrast: [{ el: 'body', line: 1, min: 5.1 }] };
  assert.deepEqual(judge(ok, { minContrast: 4.5 }), []);
  assert.deepEqual(judge({ ...ok, contrast: [{ el: 'body', line: 2, min: 4.2 }] }, { minContrast: 4.5 }), ['contrast body line 2: 4.2']);
  assert.deepEqual(judge({ ...ok, overlaps: ['.isn-hint'], hOverflow: true }, { minContrast: 4.5 }),
    ['overlaps .isn-hint', 'horizontal overflow']);
  assert.deepEqual(judge({ ...ok, inViewport: false, belowHeader: false }, { minContrast: 4.5 }), ['panel outside the screen', 'panel under the header']);
});
