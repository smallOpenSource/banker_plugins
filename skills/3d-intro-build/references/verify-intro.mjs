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
 *     --viewports  a trailing t marks a touch screen, r reduced motion (default: the six below)
 *     --header     the site's fixed header (default: the engine's .sw-topbar)
 *     --playwright-from-project  also look in the current folder's node_modules, first (your own project only)
 *   Exit 0 when nothing failed, 1 otherwise; the report (JSON) goes to --out or stdout.
 *
 * Needs Playwright with Chromium (setup-playwright skill: npx playwright install chromium), found
 * beside this script or in the global npm root, and in the project only when asked.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
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
  const seen = new Map();
  let worst = NaN;
  for (let y = rect.y; y < rect.y + rect.height; y++) {
    for (let x = rect.x; x < rect.x + rect.width; x++) {
      const i = (y * width + x) * 4;
      const key = (px[i] << 16) | (px[i + 1] << 8) | px[i + 2];
      if (!seen.has(key)) seen.set(key, pixelContrast(textRgb, alpha, [px[i], px[i + 1], px[i + 2]]));
      worst = Number.isNaN(worst) ? seen.get(key) : Math.min(worst, seen.get(key));
    }
  }
  return worst;
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

/** The failures of one measured scene, in a fixed order. */
export function judge(s, { minContrast }) {
  const out = [];
  if (!s.inViewport) out.push('panel outside the screen');
  if (!s.belowHeader) out.push('panel under the header');
  for (const sel of s.overlaps) out.push(`overlaps ${sel}`);
  if (s.hOverflow) out.push('horizontal overflow');
  for (const c of s.contrast) {
    if (c.min === null) out.push(`contrast ${c.el} line ${c.line}: not measured (${c.why})`);
    else if (!(c.min >= minContrast)) out.push(`contrast ${c.el} line ${c.line}: ${c.min}`);
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

/**
 * The playwright package: beside this script, else in the global npm root. The project's own
 * node_modules (the current folder) is read only with `fromProject` (--playwright-from-project), and
 * then first: a repository can ship a node_modules of its own, and loading it runs its code.
 * `npx playwright install chromium` alone fetches the browser, not this package.
 */
export async function loadPlaywright({ fromProject = false } = {}) {
  try { return await import('playwright'); } catch { /* not beside this script */ }
  const fromHere = fromProject ? resolveFrom(process.cwd()) : null;
  const root = fromHere ? null : globalRoot();
  const entry = fromHere || (root && resolveFrom(root));
  if (entry) {
    const mod = await import(pathToFileURL(entry).href);
    return mod.chromium ? mod : mod.default;
  }
  throw new Error('verify-intro: the playwright package was not found. Install it and its browser: '
    + '`npm i -g playwright && npx playwright install chromium`, or for your own project `npm i -D playwright` and --playwright-from-project.');
}

const navInfo = (page) => page.evaluate(() => {
  const c = window.IntroStepNav && window.IntroStepNav.current;
  return c ? { last: c.lastScene, stops: c.stops(), state: c.state(), end: c.end } : null;
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

async function lineContrast(page, i, panel) {
  const clip = { x: Math.max(0, Math.floor(panel.x)), y: Math.max(0, Math.floor(panel.y)), width: Math.ceil(panel.width), height: Math.ceil(panel.height) };
  const lines = await page.evaluate(hideTextLines, { i, parts: TEXT_PARTS });
  await page.waitForTimeout(80);
  const png = await page.screenshot({ type: 'png', clip });
  await page.evaluate(showText, { i, parts: TEXT_PARTS });
  const img = await pixels(page.context(), png);
  return lines.map((l) => {
    const x = Math.max(0, Math.floor(l.rect.x - clip.x));
    const y = Math.max(0, Math.floor(l.rect.y - clip.y));
    const rect = { x, y, width: Math.min(img.width - x, Math.ceil(l.rect.width)), height: Math.min(img.height - y, Math.ceil(l.rect.height)) };
    const rgb = parseColor(l.color);
    if (!rgb) return { el: l.el, line: l.line, min: null, why: `colour ${l.color}` };
    if (rect.width < 1 || rect.height < 1) return { el: l.el, line: l.line, min: null, why: 'line outside the panel' };
    return { el: l.el, line: l.line, min: Number(worstContrast(rgb, img.data, img.width, rect, colorAlpha(l.color)).toFixed(2)) };
  });
}

async function measureScene(page, i, o) {
  await goToScene(page, i);
  const clip = await clipState(page, i, o.reduce);
  const g = geometry(await page.evaluate(rawGeometry, { i, header: o.header, covers: COVERS }));
  const contrast = o.contrast && g.opacity > 0.5 ? await lineContrast(page, i, g.panel) : [];
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

async function bodyRoundTrip(page, vp, how, last) {
  await goToScene(page, last);
  await page.waitForTimeout(400);
  await send(page, vp, how, 'down');
  await settle(page);
  const reachesBody = (await navInfo(page)).state.atBody;
  await send(page, vp, how, 'up');
  await settle(page);
  return { reachesBody, upReturns: (await navInfo(page)).state.index === last };
}

const ready = (page) => page.evaluate(() => {
  const b = document.querySelector('.isn-main');
  return document.documentElement.classList.contains('isn-ready') && Boolean(b) && getComputedStyle(b).display !== 'none';
});
const bodyFocused = (page, end) => page.evaluate((sel) => document.activeElement === document.querySelector(sel), end);

// The main button: hidden before the last scene, shown once its clip has played to the end (at
// once under reduced motion), and a press goes to the body with the focus. The skip link likewise.
async function checkButtons(page, info) {
  await goToScene(page, info.last - 1);
  const hiddenBefore = !(await ready(page));
  await goToScene(page, info.last);
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
  if (info.stops.length - 1 > info.last) {
    for (const how of vp.touch ? ['swipe'] : ['wheel', 'ArrowDown', 'PageDown', 'Space']) out[how] = await bodyRoundTrip(page, vp, how, info.last);
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
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForSelector('.sw-copy');
  const scenes = [];
  for (let i = 0, n = await page.locator('.sw-copy').count(); i < n; i++) scenes.push(await measureScene(page, i, { ...o, reduce: Boolean(vp.reduce) }));
  const input = o.input ? await checkInput(page, vp) : null;
  const buttons = o.contrast ? await topCtaContrast(page) : [];
  await context.close();
  const buttonMisses = buttonFailures(buttons, o.minContrast);
  const failures = scenes.reduce((a, s) => a + s.failures.length, 0) + consoleErrors.length + inputFailures(input).length + buttonMisses.length;
  return { viewport: `${vp.width}x${vp.height}${vp.touch ? ' touch' : ''}${vp.reduce ? ' reduced-motion' : ''}`, scenes, input, inputFailures: inputFailures(input),
    buttons, buttonFailures: buttonMisses, consoleErrors, failures };
}

/** Measures `url` at every viewport. Resolves to { url, viewports: [...], failures }. */
export async function verifyIntro(url, { viewports = VIEWPORTS, header = '.sw-topbar', minContrast = 4.5, input = true, contrast = true, playwrightFromProject = false } = {}) {
  const { chromium } = await loadPlaywright({ fromProject: playwrightFromProject });
  const browser = await chromium.launch();
  try {
    const results = [];
    for (const vp of viewports) results.push(await measureViewport(browser, url, vp, { header, minContrast, input, contrast }));
    return { url, viewports: results, failures: results.reduce((a, r) => a + r.failures, 0) };
  } finally {
    await browser.close();
  }
}

// '390x844t' is a touch screen, '1280x800r' reduced motion; the flags may combine ('390x844tr').
export function parseViewport(v) {
  const m = /^(\d+)x(\d+)([tr]*)$/.exec(v.trim());
  if (!m) throw new Error(`verify-intro: not a screen size: ${v}`);
  return { width: Number(m[1]), height: Number(m[2]), touch: m[3].includes('t'), reduce: m[3].includes('r') };
}

const FLAGS = { '--out': 'out', '--header': 'header', '--min-contrast': 'minContrast', '--viewports': 'viewports' };
const SWITCHES = { '--no-input': ['input', false], '--no-contrast': ['contrast', false], '--playwright-from-project': ['playwrightFromProject', true] };

/** The command line: a URL, --flag value or --flag=value, and the switches. */
export function parseArgs(argv) {
  const o = { url: null, out: null, header: '.sw-topbar', minContrast: 4.5, viewports: VIEWPORTS, input: true, contrast: true, playwrightFromProject: false };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].includes('=') ? [argv[i].slice(0, argv[i].indexOf('=')), argv[i].slice(argv[i].indexOf('=') + 1)] : [argv[i], null];
    if (SWITCHES[flag]) o[SWITCHES[flag][0]] = SWITCHES[flag][1];
    else if (FLAGS[flag]) o[FLAGS[flag]] = inline !== null ? inline : argv[++i];
    else if (flag.startsWith('--')) throw new Error(`verify-intro: unknown option ${flag}`);
    else o.url = argv[i];
  }
  o.minContrast = Number(o.minContrast);
  if (typeof o.viewports === 'string') o.viewports = o.viewports.split(',').map(parseViewport);
  return o;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  if (!o.url) {
    console.error('usage: node verify-intro.mjs <url> [--out report.json] [--header <selector>] [--min-contrast 4.5] [--viewports 1280x800,390x844t] [--no-input] [--no-contrast] [--playwright-from-project]');
    process.exit(2);
  }
  verifyIntro(o.url, o).then((r) => {
    const text = JSON.stringify(r, null, 2);
    if (o.out) fs.writeFileSync(o.out, text + '\n');
    else console.log(text);
    console.error(`verify-intro: ${r.failures} failure(s) across ${r.viewports.length} screen size(s)`);
    process.exit(r.failures ? 1 : 0);
  }).catch((e) => { console.error(String(e?.message || e)); process.exit(1); });
}
