#!/usr/bin/env node
/*
 * Measures an assembled intro in a real browser, for the independent check of the 3d-intro-build
 * skill: run by a checker other than the one who built the page. Each screen size gets a fresh
 * browser context (a reused one serves old CSS from its cache after a rebuild).
 *
 * Per screen and scene: whether the copy panel is inside the screen and below the header, whether
 * it overlaps a hint, the skip link, the main button or the route dots, horizontal overflow, the
 * contrast of each text line (CTA button labels included) against the worst pixel behind it,
 * measured with the text hidden, and from the second scene on, whether a clip that is there shows.
 * Per screen: console errors (a CSP refusal shows here) and the top-bar CTA's text on its own
 * solid fill. With step navigation (step-nav.js):
 * a wheel notch plus an inertia tail from the scene before the last stops at the last scene, and
 * from the last scene each input kind reaches the body top and one up input returns.
 *
 * Usage:
 *   node verify-intro.mjs <url> [--out report.json] [--header <selector>] [--min-contrast 4.5]
 *        [--viewports 1280x800,390x844t] [--no-input] [--no-contrast] [--playwright-from-project]
 *        [--seams] [--slow-clips <ms>]
 *     --seams      also probe every seam between clips at the first screen size (seamProbe below)
 *     --slow-clips hold each clip request this many ms first (a slow network), to catch a poster flicker
 *     --seam-reload  load the page afresh before each seam, so that every seam meets its clip still on the way
 *     --viewports  a trailing t marks a touch screen, r reduced motion (default: the six below)
 *     --header     the site's fixed header (default: the engine's .sw-topbar)
 *     --playwright-from-project  also look in the current folder's node_modules, before the global npm root (your own project only)
 *   Exit 0 when nothing failed and everything was measured, 1 when something failed, 3 when nothing failed
 *   but --seams could not measure a poster at some seam (posterUnmeasured: no pass); the report (JSON)
 *   goes to --out or stdout.
 *
 * Needs Playwright with Chromium (setup-playwright skill: npx playwright install chromium), found
 * beside this script or in the global npm root, and in the project only when asked.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const VIEWPORTS = [
  { width: 1280, height: 800 }, { width: 1920, height: 1080 }, { width: 860, height: 900 },
  { width: 390, height: 844, touch: true }, { width: 375, height: 667, touch: true }, { width: 844, height: 390, touch: true },
];
// What a copy panel must not cover.
const COVERS = ['.isn-hint', '.sw-hint', '.isn-skip', '.isn-main', '.sw-route'];
// The text of a panel measured for contrast: its parts, and the label of each CTA button (against
// the button, or what shows behind a ghost one).
export const TEXT_PARTS = [['num', '.sw-copy__num'], ['eyebrow', '.sw-copy__eyebrow'], ['title', '.sw-copy__title'],
  ['body', '.sw-copy__body'], ['cta', '.sw-copy__cta .sw-btn']];

// ---- measuring logic (tested without a browser) ----------------------------

const channel = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
export const relLuminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
export const contrastRatio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
/**
 * [r, g, b] of a computed colour: rgb()/rgba() with commas or spaces, or color(srgb r g b), the form
 * a color-mix() result takes. null for any other form, so it is never taken for black.
 */
export function parseColor(s) {
  const t = String(s).trim();
  const rgb = /^rgba?\(([^)]+)\)$/.exec(t);
  if (rgb) return rgb[1].split(/[\s,/]+/).filter(Boolean).slice(0, 3).map(Number);
  const srgb = /^color\(srgb\s+([^)]+)\)$/.exec(t);
  if (srgb) return srgb[1].split(/[\s/]+/).filter(Boolean).slice(0, 3).map((v) => Math.round(Number(v) * 255));
  return null;
}

/** The alpha of a computed colour (1 when it has none): rgba(), rgb( / a), color(srgb / a), % or 0..1. */
export function colorAlpha(s) {
  const t = String(s).trim();
  const m = /\/\s*([\d.]+%?)\s*\)$/.exec(t) || (/^rgba\(/.test(t) ? /,\s*([\d.]+%?)\s*\)$/.exec(t) : null);
  if (!m) return 1;
  return m[1].endsWith('%') ? Number(m[1].slice(0, -1)) / 100 : Number(m[1]);
}

// The contrast of text (alpha over the pixel, as it is drawn) against one background pixel.
function pixelContrast(textRgb, alpha, bg) {
  const fg = alpha >= 1 ? textRgb : textRgb.map((c, k) => alpha * c + (1 - alpha) * bg[k]);
  return contrastRatio(relLuminance(fg), relLuminance(bg));
}

/**
 * The lowest contrast between the text colour (with its alpha) and any pixel of `rect` in an RGBA
 * image `width` wide. NaN when the rect holds no pixel, so it never passes as a contrast.
 */
export function worstContrast(textRgb, px, width, rect, alpha = 1) {
  return worstPixel(textRgb, px, width, rect, alpha).min;
}

/** worstContrast and the pixel that gives it: { min, bg } (bg null when the rect holds no pixel). */
export function worstPixel(textRgb, px, width, rect, alpha = 1) {
  const seen = new Map();
  let worst = { min: NaN, bg: null };
  for (let y = rect.y; y < rect.y + rect.height; y++) {
    for (let x = rect.x; x < rect.x + rect.width; x++) {
      const i = (y * width + x) * 4;
      const key = (px[i] << 16) | (px[i + 1] << 8) | px[i + 2];
      if (!seen.has(key)) seen.set(key, pixelContrast(textRgb, alpha, [px[i], px[i + 1], px[i + 2]]));
      if (Number.isNaN(worst.min) || seen.get(key) < worst.min) worst = { min: seen.get(key), bg: [px[i], px[i + 1], px[i + 2]] };
    }
  }
  return worst;
}

/**
 * The lowest panel alpha (0.01 steps) at which text keeps `min` contrast over one captured pixel: the
 * scene pixel under the panel is recovered from the capture (panel colour at `panelAlpha` over it), then
 * covered again at each alpha. null when no alpha reaches `min`.
 */
export function alphaNeeded(textRgb, textAlpha, captured, panelRgb, panelAlpha, min) {
  const a = Math.min(0.99, Math.max(0, panelAlpha));
  const scene = captured.map((c, k) => Math.min(255, Math.max(0, (c - a * panelRgb[k]) / (1 - a))));
  for (let n = 0; n <= 100; n++) {
    const bg = scene.map((c, k) => (n / 100) * panelRgb[k] + (1 - n / 100) * c);
    if (pixelContrast(textRgb, textAlpha, bg) >= min) return n / 100;
  }
  return null;
}

/**
 * The contrast of a button's text on its own fill: { ratio }. { ratio: null, why } for a colour it
 * cannot read, or a fill that is not solid (the page shows through): not measured, never passed.
 */
export function fillContrast(color, background) {
  const fg = parseColor(color);
  const bg = parseColor(background);
  if (!fg || !bg) return { ratio: null, why: `colour ${fg ? background : color}` };
  if (colorAlpha(background) < 1) return { ratio: null, why: `fill not solid: ${background}` };
  return { ratio: Number(pixelContrast(fg, colorAlpha(color), bg).toFixed(2)) };
}

export const intersects = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
// Layout positions are fractional (81.3 against 81): one pixel of slack.
export const insideViewport = (r, vw, vh, slack = 1) => r.x >= -slack && r.y >= -slack && r.x + r.width <= vw + slack && r.y + r.height <= vh + slack;

// What a failed panel line needs: the lowest --intro-panel-alpha that lifts its worst pixel to the floor.
const needs = (c) => (c.needAlpha === undefined ? '' : c.needAlpha === null ? ' (no panel alpha reaches it)' : ` (needs --intro-panel-alpha >= ${c.needAlpha})`);

/** The failures of one measured scene, in a fixed order. */
export function judge(s, { minContrast }) {
  const out = [];
  if (!s.inViewport) out.push('panel outside the screen');
  if (!s.belowHeader) out.push('panel under the header');
  for (const sel of s.overlaps) out.push(`overlaps ${sel}`);
  if (s.hOverflow) out.push('horizontal overflow');
  for (const c of s.contrast) {
    if (c.min === null) out.push(`contrast ${c.el} line ${c.line}: not measured (${c.why})`);
    else if (!(c.min >= minContrast)) out.push(`contrast ${c.el} line ${c.line}: ${c.min}${needs(c)}`);
  }
  if (s.clip === 'not shown') out.push('clip not shown');
  return out;
}

// ---- browser side ------------------------------------------------------------

// The playwright package resolved from `base` (a folder), or null.
function resolveFrom(base) {
  try { return createRequire(path.join(base, 'noop.js')).resolve('playwright'); } catch { return null; }
}

// npm's global root. npm runs from the home folder: run from the project, cmd.exe on Windows would
// take an npm.cmd from that folder first, and a relative PATH entry would do the same anywhere.
function globalRoot() {
  const win = process.platform === 'win32';
  const r = spawnSync(win ? 'npm.cmd' : 'npm', ['root', '-g'], { encoding: 'utf8', shell: win, cwd: os.homedir() });
  return String(r.stdout || '').trim();
}

// The playwright entry outside this script's folder: the project's when asked, else the global root's.
function outsideEntry(fromProject) {
  const fromHere = fromProject ? resolveFrom(process.cwd()) : null;
  if (fromHere) return fromHere;
  const root = globalRoot();
  return root ? resolveFrom(root) : null;
}

/**
 * The playwright package: beside this script (or in a folder above it), else in the global npm root.
 * The project's own node_modules (the current folder) is read only with `fromProject`
 * (--playwright-from-project), and then before the global root: a repository can ship a node_modules
 * of its own, and loading it runs its code. `importBeside` replaces the first import (tests).
 * `npx playwright install chromium` alone fetches the browser, not this package.
 */
export async function loadPlaywright({ fromProject = false, importBeside = () => import('playwright') } = {}) {
  try { return await importBeside(); } catch { /* not beside this script */ }
  const entry = outsideEntry(fromProject);
  if (entry) {
    const mod = await import(pathToFileURL(entry).href);
    return mod.chromium ? mod : mod.default;
  }
  throw new Error('verify-intro: the playwright package was not found. Install it and its browser: '
    + '`npm i -g playwright && npx playwright install chromium`, or for your own project `npm i -D playwright` and --playwright-from-project.');
}

const navInfo = (page) => page.evaluate(() => {
  const c = window.IntroStepNav && window.IntroStepNav.current;
  return c ? { last: c.lastScene, lastStop: c.lastStop ?? c.lastScene, stops: c.stops(), state: c.state(), end: c.end } : null;
});

// Waits until no move runs and the scroll position has held still for 250 ms.
async function settle(page) {
  for (let k = 0; k < 60; k++) {
    const still = await page.evaluate(() => new Promise((resolve) => {
      const nav = window.IntroStepNav && window.IntroStepNav.current;
      const y = window.scrollY;
      setTimeout(() => resolve(window.scrollY === y && !(nav && nav.state().moving)), 250);
    }));
    if (still) return;
  }
}

/**
 * Whether the scene in view shows its clip. 'shown': the engine marks a scene has-clip once a real
 * frame of it painted. From the second scene on (5 s): 'not shown' when a video is there but painted
 * nothing (a codec the browser cannot decode, a broken file), a failure; 'none' when there is no
 * video (a scene without a clip; one that failed to load shows in the console). Not judged (3 s, as
 * a settle): the first scene keeps its still until the first move ('poster'), and under reduced
 * motion the engine loads no clips ('off').
 */
async function clipState(page, i, reduce) {
  const judged = i > 0 && !reduce;
  try {
    await page.waitForFunction(() => [...document.querySelectorAll('.sw-scene.has-clip')]
      .some((e) => Number(getComputedStyle(e).opacity) > 0.5), null, { timeout: judged ? 5000 : 3000 });
    return 'shown';
  } catch {
    if (!judged) return reduce ? 'off' : 'poster';
    return page.evaluate(() => ([...document.querySelectorAll('.sw-scene')]
      .some((e) => Number(getComputedStyle(e).opacity) > 0.5 && e.querySelector('video')) ? 'not shown' : 'none'));
  }
}

async function goToScene(page, i) {
  const viaNav = await page.evaluate((k) => {
    const nav = window.IntroStepNav && window.IntroStepNav.current;
    if (nav) nav.goTo(k);
    else if (k === 0) window.scrollTo(0, 0);
    else document.querySelectorAll('.sw-route__dot')[k].click();
    return Boolean(nav);
  }, i);
  await settle(page);
  if (!viaNav) await page.waitForTimeout(300);
}

function rawGeometry({ i, header, covers }) {
  const box = (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
  const shown = (e) => {
    const s = getComputedStyle(e);
    return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0.05 && e.getClientRects().length > 0;
  };
  const panel = document.querySelectorAll('.sw-copy')[i];
  const head = header ? document.querySelector(header) : null;
  return {
    opacity: Number(getComputedStyle(panel).opacity), panel: box(panel), vw: innerWidth, vh: innerHeight,
    header: head && shown(head) ? box(head) : null, scrollWidth: document.documentElement.scrollWidth,
    others: covers.flatMap((sel) => [...document.querySelectorAll(sel)].filter(shown).map((e) => ({ sel, r: box(e) }))),
  };
}

function geometry(raw) {
  return {
    opacity: Number(raw.opacity.toFixed(2)), panel: raw.panel, inViewport: insideViewport(raw.panel, raw.vw, raw.vh),
    belowHeader: !raw.header || raw.panel.y >= raw.header.y + raw.header.height - 1,
    overlaps: raw.others.filter((o) => intersects(raw.panel, o.r)).map((o) => o.sel),
    hOverflow: raw.scrollWidth > raw.vw + 1,
  };
}

// In the page: the line boxes of each text part of panel `i` (lines numbered per part, across the
// buttons of the CTA), then the text hidden (CSSOM, which a CSP allows). Returns
// [{ el, line, color, rect }] in viewport pixels.
function hideTextLines({ i, parts }) {
  const lineBoxes = (node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const lines = new Map();
    for (const r of range.getClientRects()) {
      if (r.width < 1 || r.height < 1) continue;
      const k = Math.round(r.top);
      const u = lines.get(k);
      lines.set(k, u ? { left: Math.min(u.left, r.left), right: Math.max(u.right, r.right), top: u.top, bottom: Math.max(u.bottom, r.bottom) } : { left: r.left, right: r.right, top: r.top, bottom: r.bottom });
    }
    return [...lines.values()].map((r) => ({ x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top }));
  };
  const panel = document.querySelectorAll('.sw-copy')[i];
  const out = [];
  for (const [el, sel] of parts) {
    let n = 0;
    for (const node of panel.querySelectorAll(sel)) {
      for (const rect of lineBoxes(node)) out.push({ el, line: ++n, color: getComputedStyle(node).color, rect });
      // No transition: a site's `a { transition: color }` would leave the label half drawn.
      node.style.setProperty('transition', 'none', 'important');
      node.style.setProperty('color', 'transparent', 'important');
      node.style.setProperty('text-shadow', 'none', 'important');
    }
  }
  return out;
}

function showText({ i, parts }) {
  for (const node of document.querySelectorAll('.sw-copy')[i].querySelectorAll(parts.map(([, sel]) => sel).join(', '))) {
    for (const prop of ['color', 'text-shadow', 'transition']) node.style.removeProperty(prop);
  }
}

// The top-bar CTA (manifest `cta`) when shown: its text on its own fill, [{ sel, ratio, why? }].
async function topCtaContrast(page) {
  const found = await page.evaluate(() => [...document.querySelectorAll('.sw-topcta')].filter((e) => e.getClientRects().length > 0)
    .map((e) => ({ color: getComputedStyle(e).color, background: getComputedStyle(e).backgroundColor })));
  return found.map((c) => ({ sel: '.sw-topcta', ...fillContrast(c.color, c.background) }));
}

// Every top-bar CTA below the contrast floor or not measured, as `contrast <sel>: <what>`.
const buttonFailures = (buttons, minContrast) => buttons.filter((b) => !(b.ratio >= minContrast))
  .map((b) => `contrast ${b.sel}: ${b.ratio === null ? `not measured (${b.why})` : b.ratio}`);

// Decodes a PNG in a blank page of the same context (no CSP there) into RGBA pixels.
async function pixels(context, png) {
  const page = await context.newPage();
  const img = await page.evaluate(async (b64) => {
    const im = new Image();
    im.src = `data:image/png;base64,${b64}`;
    await im.decode();
    const c = document.createElement('canvas');
    c.width = im.width;
    c.height = im.height;
    const g = c.getContext('2d');
    g.drawImage(im, 0, 0);
    return { width: c.width, height: c.height, data: Array.from(g.getImageData(0, 0, c.width, c.height).data) };
  }, png.toString('base64'));
  await page.close();
  return { width: img.width, height: img.height, data: Uint8ClampedArray.from(img.data) };
}

// Chromium now and then answers a screenshot with "Unable to capture screenshot" while it is busy (seen once in three
// full runs on a loaded Linux box). That error alone is tried again, up to three times with a short wait; any other
// error is the page's and is thrown at once.
export async function screenshot(page, opts, { tries = 3, waitMs = 150 } = {}) {
  for (let n = 1; ; n++) {
    try {
      return await page.screenshot(opts);
    } catch (e) {
      if (n >= tries || !/Unable to capture screenshot/i.test(String(e?.message))) throw e;
      await new Promise((r) => setTimeout(r, waitMs * n));
    }
  }
}

async function lineContrast(page, i, panel, minContrast = 4.5, captureMs = 10_000) {
  const clip = { x: Math.max(0, Math.floor(panel.x)), y: Math.max(0, Math.floor(panel.y)), width: Math.ceil(panel.width), height: Math.ceil(panel.height) };
  const lines = await page.evaluate(hideTextLines, { i, parts: TEXT_PARTS });
  const panelBg = await page.evaluate((k) => getComputedStyle(document.querySelectorAll('.sw-copy')[k]).backgroundColor, i);
  await page.waitForTimeout(80);
  const png = await screenshot(page, { type: 'png', clip, timeout: captureMs });
  await page.evaluate(showText, { i, parts: TEXT_PARTS });
  const img = await pixels(page.context(), png);
  return lines.map((l) => {
    const x = Math.max(0, Math.floor(l.rect.x - clip.x));
    const y = Math.max(0, Math.floor(l.rect.y - clip.y));
    const rect = { x, y, width: Math.min(img.width - x, Math.ceil(l.rect.width)), height: Math.min(img.height - y, Math.ceil(l.rect.height)) };
    const rgb = parseColor(l.color);
    if (!rgb) return { el: l.el, line: l.line, min: null, why: `colour ${l.color}` };
    if (rect.width < 1 || rect.height < 1) return { el: l.el, line: l.line, min: null, why: 'line outside the panel' };
    const w = worstPixel(rgb, img.data, img.width, rect, colorAlpha(l.color));
    return { el: l.el, line: l.line, min: Number(w.min.toFixed(2)), ...panelNeed(l, rgb, w, panelBg, minContrast) };
  });
}

// For a panel line (not a CTA button with its own fill) on a see-through panel: the alpha it needs.
function panelNeed(l, rgb, w, panelBg, minContrast) {
  const panel = parseColor(panelBg);
  const a = colorAlpha(panelBg);
  if (l.el === 'cta' || !panel || !w.bg || a <= 0 || a >= 1) return {};
  return { needAlpha: alphaNeeded(rgb, colorAlpha(l.color), w.bg, panel, a, minContrast) };
}

async function measureScene(page, i, o) {
  await goToScene(page, i);
  // with step navigation the copy of the scene at its stop fades in (step-nav.css, 0.35 s)
  if (await page.evaluate(() => document.documentElement.classList.contains('isn-on'))) await page.waitForTimeout(450);
  const clip = await clipState(page, i, o.reduce);
  const g = geometry(await page.evaluate(rawGeometry, { i, header: o.header, covers: COVERS }));
  const contrast = o.contrast && g.opacity > 0.5 ? await lineContrast(page, i, g.panel, o.minContrast, o.captureMs).catch((e) => {
    if (!isTimeout(e)) throw e;
    return [{ el: 'panel', line: 0, min: null, why: `screen capture timed out after ${o.captureMs} ms` }];   // not measured: never a pass
  }) : [];
  const scene = { scene: i + 1, clip, ...g, contrast };
  return { ...scene, failures: g.opacity > 0.5 ? judge(scene, o) : ['panel not visible at its stop'] };
}

// ---- input checks (step navigation only) ---------------------------------------------

async function swipe(page, vp, dir) {
  const cdp = await page.context().newCDPSession(page);
  const x = Math.round(vp.width / 2);
  const [from, to] = dir === 'down' ? [vp.height * 0.7, vp.height * 0.3] : [vp.height * 0.3, vp.height * 0.7];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: Math.round(from) }] });
  for (let k = 1; k <= 6; k++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: Math.round(from + ((to - from) * k) / 6) }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

const KEY = { ArrowDown: ['ArrowDown', 'ArrowUp'], PageDown: ['PageDown', 'PageUp'], Space: ['Space', 'Shift+Space'] };

async function send(page, vp, how, dir) {
  if (how === 'swipe') return swipe(page, vp, dir);
  if (how === 'wheel') {
    await page.mouse.move(vp.width / 2, vp.height / 2);
    return page.mouse.wheel(0, dir === 'down' ? 120 : -120);
  }
  return page.keyboard.press(KEY[how][dir === 'down' ? 0 : 1]);
}

// One notch, then a decaying inertia tail within the gesture gap.
async function notchWithInertia(page, vp) {
  await page.mouse.move(vp.width / 2, vp.height / 2);
  for (const dy of [120, 90, 60, 40, 24, 12, 6, 3]) {
    await page.mouse.wheel(0, dy);
    await page.waitForTimeout(16);
  }
}

// A wheel notch and an arrow key go half way: two of them make the step from the last scene's end to the body.
const HALF = new Set(['wheel', 'ArrowDown']);
async function sendStep(page, vp, how, dir) {
  for (let k = HALF.has(how) ? 2 : 1; k > 0; k--) await send(page, vp, how, dir);
}

async function bodyRoundTrip(page, vp, how, lastStop) {
  await goToScene(page, lastStop);
  await page.waitForTimeout(400);
  await sendStep(page, vp, how, 'down');
  await settle(page);
  const reachesBody = (await navInfo(page)).state.atBody;
  await sendStep(page, vp, how, 'up');
  await settle(page);
  return { reachesBody, upReturns: (await navInfo(page)).state.index === lastStop };
}

const ready = (page) => page.evaluate(() => {
  const b = document.querySelector('.isn-main');
  return document.documentElement.classList.contains('isn-ready') && Boolean(b) && getComputedStyle(b).display !== 'none';
});
const bodyFocused = (page, end) => page.evaluate((sel) => document.activeElement === document.querySelector(sel), end);

// The main button: hidden before the last scene, shown once its clip has played to the end (at
// once under reduced motion), and a press goes to the body with the focus. The skip link likewise.
async function checkButtons(page, info) {
  await goToScene(page, info.lastStop - 1);
  const hiddenBefore = !(await ready(page));
  await goToScene(page, info.lastStop);
  const shownAtLast = await ready(page);
  await page.click('.isn-main');
  await settle(page);
  const main = { hiddenBefore, shownAtLast, reachesBody: (await navInfo(page)).state.atBody, focusesBody: await bodyFocused(page, info.end) };
  await goToScene(page, 0);
  await page.click('.isn-skip');
  await settle(page);
  return { main, skip: { reachesBody: (await navInfo(page)).state.atBody, focusesBody: await bodyFocused(page, info.end) } };
}

async function checkInput(page, vp) {
  const info = await navInfo(page);
  if (!info || info.last < 1) return null;
  const out = {};
  if (!vp.touch) {
    await goToScene(page, info.last - 1);
    await notchWithInertia(page, vp);
    await settle(page);
    out.inertiaStopsAtLast = (await navInfo(page)).state.index === info.last;
  }
  if (info.stops.length - 1 > info.lastStop) {
    for (const how of vp.touch ? ['swipe'] : ['wheel', 'ArrowDown', 'PageDown', 'Space']) out[how] = await bodyRoundTrip(page, vp, how, info.lastStop);
    Object.assign(out, await checkButtons(page, info));
  }
  return out;
}

// Every false check of the input results, as `input <check>: <what>`.
const inputFailures = (input) => (input ? Object.entries(input).flatMap(([k, v]) => (typeof v === 'boolean'
  ? (v ? [] : [`input ${k}`]) : Object.entries(v).filter(([, ok]) => !ok).map(([what]) => `input ${k}: ${what}`))) : []);

async function measureViewport(browser, url, vp, o) {
  const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1,
    hasTouch: Boolean(vp.touch), isMobile: Boolean(vp.touch), reducedMotion: vp.reduce ? 'reduce' : 'no-preference' });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(String(e.message || e)));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  // a page whose load does not come within loadMs is measured as it stands, and that is a failure of this screen
  const loadFailures = await loadedWithin(page, o.loadMs) ? [] : [`page load did not finish within ${o.loadMs} ms (measured while still loading)`];
  await page.waitForSelector('.sw-copy');
  const scenes = [];
  for (let i = 0, n = await page.locator('.sw-copy').count(); i < n; i++) scenes.push(await measureScene(page, i, { ...o, reduce: Boolean(vp.reduce) }));
  const input = o.input ? await checkInput(page, vp) : null;
  const buttons = o.contrast ? await topCtaContrast(page) : [];
  await context.close();
  const buttonMisses = buttonFailures(buttons, o.minContrast);
  const failures = scenes.reduce((a, s) => a + s.failures.length, 0) + consoleErrors.length + inputFailures(input).length + buttonMisses.length + loadFailures.length;
  return { viewport: `${vp.width}x${vp.height}${vp.touch ? ' touch' : ''}${vp.reduce ? ' reduced-motion' : ''}`, scenes, input, inputFailures: inputFailures(input),
    buttons, buttonFailures: buttonMisses, consoleErrors, loadFailures, failures };
}

/**
 * Measures `url` at every viewport. Resolves to { url, viewports: [...], failures }; with `seams`,
 * also { seams } from seamProbe at the first viewport, its failures counted in.
 */
// captureMs, loadMs, fetchMs: the longest wait for one screen capture, the page's load and intro.js; past them that
// part is not measured (with the reason, never a pass) and the run goes on. A font or an image that never answers
// would otherwise hold a capture 30 s and throw away every result.
const VERIFY_DEFAULTS = { viewports: VIEWPORTS, header: '.sw-topbar', minContrast: 4.5, input: true, contrast: true, playwrightFromProject: false, seams: false, slowClipsMs: 0, seamReload: false,
  captureMs: 10_000, loadMs: 15_000, fetchMs: 15_000 };
const isTimeout = (e) => e?.name === 'TimeoutError';

export async function verifyIntro(url, opts = {}) {
  const o = { ...VERIFY_DEFAULTS, ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) };
  const { chromium } = await loadPlaywright({ fromProject: o.playwrightFromProject });
  const browser = await chromium.launch();
  try {
    const results = [];
    const limits = { captureMs: o.captureMs, loadMs: o.loadMs };
    for (const vp of o.viewports) results.push(await measureViewport(browser, url, vp, { header: o.header, minContrast: o.minContrast, input: o.input, contrast: o.contrast, ...limits }));
    const seam = o.seams ? await seamProbe(browser, url, { viewport: o.viewports[0], slowClipsMs: Number(o.slowClipsMs) || 0, reload: Boolean(o.seamReload), ...limits, fetchMs: o.fetchMs }) : null;
    const failures = results.reduce((a, r) => a + r.failures, 0) + (seam ? seam.failures.length : 0);
    return { url, viewports: results, ...(seam ? { seams: seam } : {}), failures };
  } finally {
    await browser.close();
  }
}

// ---- seam probe (--seams) ----------------------------------------------------------

/**
 * steps: captures per seam. windowVh: how far past the seam the probe looks (before it, at least the
 * blank limit plus 0.4 vh). blankVh + the plate share: the longest run of a near one-colour screen a
 * seam may show (a landing on a background plate is one colour for its last frames, so each seam's
 * limit adds plateSec of the clip before it, in vh). flickerDiff: the mean pixel difference (0-255)
 * between the poster a scene shows before its clip paints and the clip once it does, past which the
 * poster is a flicker. settleMs: the longest wait for clips to catch up with the scroll. posterDecodeMs: the
 * longest wait for the posters in view to decode on arrival; past it the seam is unmeasured (posterDiff null, posterWhy).
 * loadMs: the longest wait for the page's load event (a resource that never answers must not stop the probe).
 */
export const SEAM_DEFAULTS = { steps: 20, windowVh: 0.6, blankVh: 0.3, plateSec: 0.6, flickerDiff: 24, settleMs: 8000, posterDecodeMs: 5000, loadMs: 15000, captureMs: 10_000, fetchMs: 15_000 };
const OVERLAYS = ['.sw-copylayer', '.sw-topbar', '.sw-hint', '.sw-route', '.sw-scrollbar', '.isn-hint', '.isn-skip', '.isn-main'];

/** The mountScrollWorld config in an assembled intro.js; null when it is not one. */
export function configFromIntroJs(text) {
  const m = /var config = ([\s\S]*?);\n\s*(?:var nav|mountScrollWorld|if \()/.exec(String(text));
  try { return m ? JSON.parse(m[1]) : null; } catch { return null; }
}

/** The engine's segments in scroll order (as scrub-engine.js lays them out), start and end in vh. */
export function segmentsOf(config) {
  const out = [];
  let off = 0;
  const add = (label, w) => { out.push({ label, start: off, end: off + w }); off += w; };
  (config.sections || []).forEach((s, i, all) => {
    add(`dive ${i + 1}`, s.scroll || config.diveScroll || 1.3);
    if (i < all.length - 1 && (config.connectors || [])[i]) add(`conn ${i + 1}`, config.connScroll || 0.9);
  });
  return out;
}

/** Mean absolute difference of two RGBA pixel arrays over R, G and B (0-255). */
export function meanAbsDiff(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 4) sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
  return Math.round((sum / ((a.length / 4) * 3)) * 100) / 100;
}

/** A near one-colour screen, whatever the colour: `share` of the pixels within `tolerance` of the most common colour. */
export function isBlank(data, { tolerance = 10, share = 0.99 } = {}) {
  const ref = [0, 1, 2].map((c) => modeOf(data, c));
  let near = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (Math.abs(data[i] - ref[0]) <= tolerance && Math.abs(data[i + 1] - ref[1]) <= tolerance && Math.abs(data[i + 2] - ref[2]) <= tolerance) near++;
  }
  return near / (data.length / 4) >= share;
}

function modeOf(data, c) {
  const hist = new Uint32Array(256);
  for (let i = c; i < data.length; i += 4) hist[data[i]]++;
  return hist.indexOf(Math.max(...hist));
}

/** Runs of blank captures longer than limitVh: [{ fromVh, toVh, lengthVh }] (ys are the captures' scroll positions in vh). */
export function blankRuns(flags, ys, limitVh) {
  const step = ys.length > 1 ? ys[1] - ys[0] : 0;
  const runs = [];
  let from = -1;
  flags.concat(false).forEach((f, i) => {
    if (f && from < 0) from = i;
    if (!f && from >= 0) { runs.push({ fromVh: ys[from], toVh: ys[i - 1], lengthVh: ys[i - 1] - ys[from] + step }); from = -1; }
  });
  const r2 = (x) => Math.round(x * 100) / 100;
  return runs.filter((r) => r.lengthVh > limitVh).map((r) => ({ fromVh: r2(r.fromVh), toVh: r2(r.toVh), lengthVh: r2(r.lengthVh) }));
}

// Waits until the clips of the scenes in view are loaded and not seeking, and their frames hold for six
// animation frames: the engine eases each clip towards the scroll target over several frames. A scene
// with no video yet (its clip still on the way) or one that cannot show a frame yet is pending; a loaded
// clip the engine has not needed to seek (a scene at its very first frame) is not.
const settleClips = (page, limit) => page.evaluate(async (ms) => {
  const t0 = performance.now();
  let last = '';
  let same = 0;
  const waiting = (e) => { const v = e.querySelector('video'); return v ? v.seeking || v.readyState < 2 : !e.classList.contains('has-clip'); };
  while (performance.now() - t0 < ms) {
    await new Promise((r) => requestAnimationFrame(r));
    const seen = [...document.querySelectorAll('.sw-scene')].filter((e) => Number(getComputedStyle(e).opacity) > 0.5);
    const pending = seen.some(waiting);
    const sig = seen.map((e) => e.querySelector('video')?.currentTime.toFixed(3) ?? '-').join(',');
    same = !pending && sig === last ? same + 1 : 0;
    last = sig;
    if (same >= 6) return true;
  }
  return false;
}, limit);

// Whether a scene in view still shows its poster (no clip painted yet).
const posterShown = (page) => page.evaluate(() => [...document.querySelectorAll('.sw-scene')]
  .some((e) => Number(getComputedStyle(e).opacity) > 0.5 && !e.classList.contains('has-clip')));

const scrollToVh = (page, vh) => page.evaluate((y) => { window.scrollTo(0, y * window.innerHeight); return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); }, vh);
// A seam capture, decoded here: many captures per seam, so not through a browser tab as pixels() does.
const capture = async (page, ms = SEAM_DEFAULTS.captureMs) => decodePng(await screenshot(page, { type: 'png', timeout: ms })).data;

/**
 * RGBA pixels of an 8-bit, non-interlaced PNG (grey, grey+alpha, RGB or RGBA: what a browser
 * screenshot is), decoded with zlib. Throws on any other PNG.
 */
export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('decodePng: not a PNG');
  const { width, height, type, depth, interlace, idat } = pngChunks(buf);
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[type];
  if (depth !== 8 || interlace !== 0 || !ch) throw new Error(`decodePng: only 8-bit non-interlaced PNG (got depth ${depth}, type ${type}, interlace ${interlace})`);
  const raw = unfilter(zlib.inflateSync(idat), width, height, ch);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, j = 0; i < width * height; i++, j += ch) {
    const grey = ch < 3;
    data.set([raw[j], raw[grey ? j : j + 1], raw[grey ? j : j + 2], ch === 2 || ch === 4 ? raw[j + ch - 1] : 255], i * 4);
  }
  return { width, height, data };
}

function pngChunks(buf) {
  const out = { idat: [] };
  for (let at = 8; at < buf.length;) {
    const len = buf.readUInt32BE(at);
    const kind = buf.toString('latin1', at + 4, at + 8);
    const body = buf.subarray(at + 8, at + 8 + len);
    if (kind === 'IHDR') Object.assign(out, { width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8], type: body[9], interlace: body[12] });
    if (kind === 'IDAT') out.idat.push(body);
    at += 12 + len;
  }
  return { ...out, idat: Buffer.concat(out.idat) };
}

// Undo the PNG row filters (None, Sub, Up, Average, Paeth).
function unfilter(src, width, height, bpp) {
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = src[y * (stride + 1)];
    const row = src.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0;
      out[y * stride + x] = (row[x] + predict(f, a, b, c)) & 0xff;
    }
  }
  return out;
}

function predict(f, a, b, c) {
  if (f === 1) return a;
  if (f === 2) return b;
  if (f === 3) return (a + b) >> 1;
  if (f !== 4) return 0;
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

// The clip length of the segment before a seam, from its video (8 s when it is not loaded).
const clipSeconds = (page, k) => page.evaluate((i) => document.querySelectorAll('.sw-scene')[i]?.querySelector('video')?.duration || 8, k);

/**
 * Scrolls across each seam between clips and measures it: the largest difference between successive
 * captures (maxDiff), runs of a near one-colour screen longer than the seam's limit (blank), and whether
 * a poster that showed on arrival differs from the clip once it paints (posterFlicker). Overlays (copy,
 * bars, dots) are hidden while measuring. Each capture waits for the clips to catch up with the scroll.
 */
export async function seamProbe(browser, url, { viewport = VIEWPORTS[0], slowClipsMs = 0, ...o } = {}) {
  const opts = { ...SEAM_DEFAULTS, ...o };
  const config = await fetch(new URL('intro.js', url), { signal: AbortSignal.timeout(opts.fetchMs) }).then((res) => res.text()).then(configFromIntroJs).catch(() => null);
  if (!config) return { viewport: `${viewport.width}x${viewport.height}`, boundaries: [], failures: ['seams: intro.js was not read (no answer within fetchMs, or no config in it)'] };
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  if (slowClipsMs) await page.route(/\.mp4(\?|$)/, async (route) => { await new Promise((r) => setTimeout(r, slowClipsMs)); await route.continue(); });
  const loadMisses = [];
  const note = (loaded, at) => { if (!loaded) loadMisses.push(`seams: page load did not finish within ${opts.loadMs} ms ${at} (measured while still loading)`); };
  note(await openIntro(page, url, opts.loadMs), 'at the start');
  const segs = segmentsOf(config);
  const boundaries = [];
  for (let k = 1; k < segs.length; k++) {
    if (opts.reload && k > 1) note(await openIntro(page, url, opts.loadMs), `before ${segs[k - 1].label} -> ${segs[k].label}`);
    boundaries.push(await probeSeam(page, segs, k, opts).catch((e) => {
      if (!isTimeout(e)) throw e;
      const why = `screen capture timed out after ${opts.captureMs} ms`;   // not measured: never a pass
      return { from: segs[k - 1].label, to: segs[k].label, atVh: segs[k].start, maxDiff: null, blank: [], posterDiff: null, posterWhy: why,
        failures: [`seam ${segs[k - 1].label} -> ${segs[k].label}: not measured (${why})`] };
    }));
  }
  await context.close();
  // a seam whose clip was there on arrival showed no poster: not measured, so not counted as a pass
  const posterUnmeasured = boundaries.filter((b) => b.posterDiff === null).length;
  return { viewport: `${viewport.width}x${viewport.height}`, slowClipsMs, reload: Boolean(opts.reload), posterMeasured: boundaries.length - posterUnmeasured, posterUnmeasured, boundaries, failures: [...loadMisses, ...boundaries.flatMap((b) => b.failures)] };
}

// Whether the page's load event came within ms (a resource whose answer never comes must not stop a measure).
const loadedWithin = (page, ms) => page.waitForLoadState('load', { timeout: ms }).then(() => true, () => false);

// Opens the intro for the seam probe; false when its load did not come within loadMs (the caller fails it).
// Routing (the slow clips) turns the browser's HTTP cache off, so a fresh load fetches every clip again.
async function openIntro(page, url, loadMs = SEAM_DEFAULTS.loadMs) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const loaded = await loadedWithin(page, loadMs);
  await page.waitForSelector('.sw-scene');
  // the probe parks the page between stops: step navigation must not settle it on one
  await page.evaluate(() => window.IntroStepNav?.current?.hold(true));
  await page.evaluate((sels) => { for (const el of document.querySelectorAll(sels.join(','))) el.style.visibility = 'hidden'; }, OVERLAYS);
  return loaded;
}

// The scenes in view: whether each shows its clip, its poster's load state and transform, its video's frame.
const sceneStates = (page) => page.evaluate(() => [...document.querySelectorAll('.sw-scene')].map((e, scene) => ({ e, scene }))
  .filter(({ e }) => Number(getComputedStyle(e).opacity) > 0.5).map(({ e, scene }) => {
    const img = e.querySelector('.sw-scene__still');
    const v = e.querySelector('video');
    return { scene, hasClip: e.classList.contains('has-clip'),
      poster: img ? { complete: img.complete, naturalWidth: img.naturalWidth, transform: getComputedStyle(img).transform } : null,
      video: v ? { readyState: v.readyState, currentTime: Number(v.currentTime.toFixed(3)) } : null };
  }));

async function probeSeam(page, segs, k, o) {
  const at = segs[k].start;
  const prev = segs[k - 1];
  const before = Math.max(o.windowVh, o.blankVh + 0.4 + (o.plateSec / 2) * (prev.end - prev.start));
  const arrival = await arrive(page, at + 0.02, o);
  const limit = o.blankVh + (o.plateSec / (await clipSeconds(page, k - 1))) * (prev.end - prev.start);
  const ys = Array.from({ length: o.steps + 1 }, (_, i) => at - before + ((before + o.windowVh) * i) / o.steps);
  const flags = [];
  let maxDiff = 0;
  let last = null;
  for (const y of ys) {
    await scrollToVh(page, y);
    await settleClips(page, o.settleMs);
    const px = await capture(page, o.captureMs);
    if (last) maxDiff = Math.max(maxDiff, meanAbsDiff(last, px));
    flags.push(isBlank(px));
    last = px;
  }
  const blank = blankRuns(flags, ys, limit);
  const failures = [
    ...blank.map((b) => `seam ${prev.label} -> ${segs[k].label}: a near one-colour screen for ${b.lengthVh} vh (limit ${Math.round(limit * 100) / 100} vh)`),
    ...(arrival.flicker ? [`seam ${prev.label} -> ${segs[k].label}: the poster differs from the clip by ${arrival.diff} (limit ${o.flickerDiff})`] : []),
  ];
  return { from: prev.label, to: segs[k].label, atVh: at, maxDiff, blank, blankLimitVh: Math.round(limit * 100) / 100, posterDiff: arrival.diff,
    ...(arrival.why ? { posterWhy: arrival.why } : {}), arrival: arrival.states, failures };
}

// Jump just past the seam, where the entering clip is at its first frames; when a poster shows there,
// compare it with the clip once it paints. A poster that is the clip's own first frame barely differs.
async function arrive(page, vh, o) {
  await scrollToVh(page, vh);
  // a scene shown by the jump paints nothing until its poster is decoded (0.1-0.35 s seen): wait for that, so the
  // capture is the poster, not the empty frame a jump shows (the empty frame is another matter than the flicker)
  // at most posterDecodeMs: a poster whose answer never comes leaves this seam unmeasured, with the reason
  const decoded = await page.evaluate((ms) => Promise.race([
    Promise.all([...document.querySelectorAll('.sw-scene')].filter((e) => Number(getComputedStyle(e).opacity) > 0.5)
      .map((e) => e.querySelector('.sw-scene__still')?.decode().catch(() => {}))).then(() => true),
    new Promise((r) => setTimeout(() => r(false), ms)),
  ]).then((ok) => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(ok))))), o.posterDecodeMs);
  const before = await sceneStates(page);
  if (!decoded) return { diff: null, flicker: false, why: `a poster did not decode within ${o.posterDecodeMs} ms`, states: { before } };
  if (!(await posterShown(page))) { await settleClips(page, o.settleMs); return { diff: null, flicker: false, states: { before } }; }
  const early = await capture(page, o.captureMs);
  await page.waitForFunction(() => [...document.querySelectorAll('.sw-scene')]
    .every((e) => Number(getComputedStyle(e).opacity) <= 0.5 || e.classList.contains('has-clip')), null, { timeout: o.settleMs }).catch(() => {});
  await settleClips(page, o.settleMs);
  const diff = meanAbsDiff(early, await capture(page, o.captureMs));
  return { diff, flicker: diff > o.flickerDiff, states: { before, after: await sceneStates(page) } };
}

/** The CLI's exit code: 1 on a failure, 3 when none failed but a seam's poster went unmeasured, else 0. */
export const exitCode = (report) => (report.failures ? 1 : report.seams?.posterUnmeasured ? 3 : 0);

// '390x844t' is a touch screen, '1280x800r' reduced motion; the flags may combine ('390x844tr').
export function parseViewport(v) {
  const m = /^(\d+)x(\d+)([tr]*)$/.exec(v.trim());
  if (!m) throw new Error(`verify-intro: not a screen size: ${v}`);
  return { width: Number(m[1]), height: Number(m[2]), touch: m[3].includes('t'), reduce: m[3].includes('r') };
}

const FLAGS = { '--out': 'out', '--header': 'header', '--min-contrast': 'minContrast', '--viewports': 'viewports', '--slow-clips': 'slowClipsMs' };
const SWITCHES = { '--no-input': ['input', false], '--no-contrast': ['contrast', false], '--playwright-from-project': ['playwrightFromProject', true], '--seams': ['seams', true], '--seam-reload': ['seamReload', true] };

/** The command line: a URL, --flag value or --flag=value, and the switches. */
export function parseArgs(argv) {
  const o = { url: null, out: null, header: '.sw-topbar', minContrast: 4.5, viewports: VIEWPORTS, input: true, contrast: true, playwrightFromProject: false, seams: false, slowClipsMs: 0, seamReload: false };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].includes('=') ? [argv[i].slice(0, argv[i].indexOf('=')), argv[i].slice(argv[i].indexOf('=') + 1)] : [argv[i], null];
    if (SWITCHES[flag]) o[SWITCHES[flag][0]] = SWITCHES[flag][1];
    else if (FLAGS[flag]) o[FLAGS[flag]] = inline !== null ? inline : argv[++i];
    else if (flag.startsWith('--')) throw new Error(`verify-intro: unknown option ${flag}`);
    else o.url = argv[i];
  }
  o.minContrast = Number(o.minContrast);
  o.slowClipsMs = Number(o.slowClipsMs) || 0;
  if (typeof o.viewports === 'string') o.viewports = o.viewports.split(',').map(parseViewport);
  return o;
}

// Node resolves links for import.meta.url but not for process.argv[1], so both go through realpath:
// compared as given, a run through a linked folder would exit 0 without doing anything.
const invokedDirectly = () => {
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};
if (invokedDirectly()) {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  if (!o.url) {
    console.error('usage: node verify-intro.mjs <url> [--out report.json] [--header <selector>] [--min-contrast 4.5] [--viewports 1280x800,390x844t] [--no-input] [--no-contrast] [--playwright-from-project] [--seams] [--slow-clips <ms>] [--seam-reload]');
    process.exit(2);
  }
  verifyIntro(o.url, o).then((r) => {
    const text = JSON.stringify(r, null, 2);
    if (o.out) fs.writeFileSync(o.out, text + '\n');
    else console.log(text);
    const unmeasured = r.seams?.posterUnmeasured || 0;
    console.error(`verify-intro: ${r.failures} failure(s) across ${r.viewports.length} screen size(s)${unmeasured ? `; poster not measured at ${unmeasured} seam(s) (add --slow-clips and --seam-reload)` : ''}`);
    process.exit(exitCode(r));
  }).catch((e) => { console.error(String(e?.message || e)); process.exit(1); });
}
