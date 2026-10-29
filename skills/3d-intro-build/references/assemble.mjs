#!/usr/bin/env node
/*
 * First-party assembler for the 3d-intro-build skill.
 *
 * Takes a project directory that already holds the generated stills + clips (+ an intro.json
 * manifest describing them) and produces the intro page:
 *   <outDir>/
 *     index.html            (head of index-template.html; no inline script or style; preloads the first posters)
 *     scrub-engine.js       (copied verbatim from references/)
 *     scrub-engine.css      (the CSS the engine injects, taken from scrub-engine.js unchanged)
 *     scrub-engine.LICENSE.md (scroll-world's MIT notice, which ships with the engine files)
 *     theme.css             (the template's --sw-* tokens, set from the manifest theme)
 *     intro-fixes.css       (layout, button text and overflow fixes for the engine, every page)
 *     intro.js              (the mountScrollWorld config and call)
 *     panel-glass.css       (only with "panel": "glass")
 *     step-nav.js/.css      (only with "stepNav": scene-by-scene navigation)
 *     assets/<id>.<ext>     (scene posters/stills)
 *     assets/vid/<id>.mp4   (per-scene clips: dives, or the short holds of the hold-and-flight mode)
 *     assets/vid/connN.mp4  (optional connectors: the flights between scenes, or dive mode's exits)
 *     assets/connN-poster.<ext> (optional connectorStills: a connector's own first frame as its poster)
 * Nothing inline, so the page runs under a strict Content-Security-Policy (no 'unsafe-inline';
 * media-src needs blob:). The engine still tries to inject its <style>: a site with a CSP adds the
 * reported `styleHash` to style-src to keep that refusal out of the console (scrub-engine.css
 * carries the same rules either way). Serve <outDir> with serve.mjs (--csp to check under a policy).
 *
 * Runtime: Node >=18 builtins ONLY (node:fs / node:path / node:url / node:crypto). No external
 * deps, no shell; cross-platform (path.join / path.sep; asset URLs are always posix '/').
 *
 * The manifest (intro.json) mirrors the mountScrollWorld config, but its `still` / `clip` /
 * `connectors` values are paths to SOURCE files relative to projectDir; this assembler copies
 * them into assets/ and rewrites the config to the copied relative URLs. Shape:
 *
 *   {
 *     "pageTitle": "BRAND - the world of SUBJECT",    // optional (else derived)
 *     "pageDescription": "Scroll to fly through ...", // optional (else derived)
 *     "lang": "ko",                                     // optional <html lang> (template: en)
 *     "brand": { "name": "BRAND", "href": "#top" },   // optional
 *     "cta":   { "label": "Order now", "href": "#finale" }, // optional top-bar CTA
 *     "hint":  "scroll to fly in",                     // optional
 *     "theme": { "bg":"#F5EDE0","ink":"#241d2b","inkSoft":"#6a6072","accent":"#9B7EBD" }, // optional
 *     "diveScroll": 1.3, "connScroll": 0.9, "crossfade": 0.12, // optional
 *     "nav": true, "atmosphere": true,                 // optional (only false is emitted)
 *     "panel": "glass",                                 // optional frosted-glass copy panel
 *     "panelAlpha": 0.7,                                // optional glass alpha; default: panelAlpha() below
 *     "stepNav": { "end": "#main", ... },              // optional, see step-nav.js for the options
 *     "sections": [                                     // required, >= 1, in order
 *       { "id":"sceneA", "label":"Scene A",
 *         "still":"still-1.png",  "clip":"dive-1.mp4",       // required (relative to projectDir)
 *         "stillMobile":"still-1-m.png", "clipMobile":"dive-1-m.mp4", // optional
 *         "accent":"#8FB98A",
 *         "eyebrow":"...", "title":"...", "body":"...", "tags":["...","..."],
 *         "scroll":1.6, "linger":0.45,                        // optional pacing
 *         "cta": { "primary":{"label":"","href":""}, "secondary":{"label":"","href":""} } } // last only
 *     ],
 *     "connectors": ["conn-1.mp4", null, ...],          // optional, len = sections.length-1
 *     "connectorsMobile": ["conn-1-m.mp4", ...],        // optional, same length
 *     "connectorStills": ["conn-1-first.png", ...]      // optional, same length: each connector's poster,
 *                                                       // its clip's actual first frame (dive mode's exits).
 *                                                       // Without it the engine shows the next scene's still.
 *   }
 *
 * Usage:
 *   node assemble.mjs <projectDir> [outDir] [--manifest path]
 *     projectDir   holds intro.json + the source stills/clips it references
 *     outDir       output site dir (default: <projectDir>/site)
 *     --manifest   manifest path (default: <projectDir>/intro.json)
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---- small helpers ----------------------------------------------------------

// Convert a posix-style relative URL ("assets/vid/x.mp4") to an OS filesystem path.
const osPath = (base, posixRel) => path.join(base, ...posixRel.split('/'));

// Copy one source asset (path relative to projectDir) to a posix dest URL under outDir.
function copyAsset(projectDir, outDir, srcRel, destPosix) {
  const src = path.join(projectDir, ...String(srcRel).split(/[\\/]/));
  if (!fs.existsSync(src)) throw new Error(`assemble: asset not found: ${srcRel} (looked at ${src})`);
  const dest = osPath(outDir, destPosix);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  return destPosix;
}

// Extension of a source path, lowercased, with the dot ('.png'); '' if none.
const extOf = (p) => path.extname(String(p)).toLowerCase();

// ---- config build -----------------------------------------------------------

// The copy and pacing fields a section carries over to the engine as they are.
const SECTION_FIELDS = ['accent', 'eyebrow', 'title', 'body', 'scroll', 'linger', 'cta'];
// Where each media field of a section is copied (the source extension is kept).
const MEDIA = [
  ['still', (id, src) => `assets/${id}${extOf(src)}`],
  ['stillMobile', (id, src) => `assets/${id}-m${extOf(src)}`],
  ['clip', (id, src) => `assets/vid/${id}${extOf(src) || '.mp4'}`],
  ['clipMobile', (id, src) => `assets/vid/${id}-m${extOf(src) || '.mp4'}`],
];

function requireFields(s, i) {
  if (!s || !s.id) throw new Error(`assemble: section[${i}] missing "id"`);
  for (const k of ['still', 'clip']) if (!s[k]) throw new Error(`assemble: section[${i}] (${s.id}) missing "${k}"`);
}

// One section of the engine config, its still and clips copied into assets/.
function sectionOut(s, i, copy) {
  requireFields(s, i);
  const out = { id: s.id, label: s.label || s.id };
  for (const [k, dest] of MEDIA) if (s[k]) out[k] = copy(s[k], dest(s.id, s[k]));
  for (const k of SECTION_FIELDS) if (s[k] != null && s[k] !== '') out[k] = s[k];
  if (Array.isArray(s.tags) && s.tags.length) out.tags = s.tags;
  return out;
}

// Connectors: one per gap between sections, in order; a null entry means "crossfade directly".
function connectorsOut(list, n, suffix, copy) {
  return gapsOut(list, n, copy, (i, src) => `assets/vid/conn${i + 1}${suffix}${extOf(src) || '.mp4'}`);
}

// One copied file (or null) per gap between sections.
function gapsOut(list, n, copy, dest) {
  const src = Array.isArray(list) ? list : [];
  return Array.from({ length: Math.max(0, n - 1) }, (_, i) => (src[i] ? copy(src[i], dest(i, src[i])) : null));
}

// The config in the shape mountScrollWorld reads (see scrub-engine.js).
function engineConfig(m, sections, { connectors, connectorsMobile, connectorStills }) {
  const config = {};
  for (const k of ['brand', 'cta']) if (m[k]) config[k] = m[k];
  config.hint = m.hint || 'scroll to fly in';
  config.diveScroll = m.diveScroll ?? 1.3;
  config.connScroll = m.connScroll ?? 0.9;
  if (m.crossfade != null) config.crossfade = m.crossfade;
  for (const k of ['nav', 'atmosphere']) if (m[k] === false) config[k] = false;
  config.sections = sections;
  config.connectors = connectors;
  return Object.assign(config, setLists({ connectorsMobile, connectorStills }));
}

// The per-gap lists that hold at least one file. connectorStills is the engine's opt-in connector
// poster (see the banker line in scrub-engine.js and NOTICE.md).
const setLists = (lists) => Object.fromEntries(Object.entries(lists).filter(([, list]) => list.some(Boolean)));

/**
 * Build the exact mountScrollWorld config object from a manifest, copying every referenced
 * asset into outDir/assets. Returns { config, copied:[destPosix,...] }.
 */
function buildConfig(manifest, projectDir, outDir) {
  const sections = Array.isArray(manifest.sections) ? manifest.sections : [];
  if (sections.length === 0) throw new Error('assemble: manifest.sections must have at least one section');
  const copied = [];
  const copy = (src, dest) => { copied.push(copyAsset(projectDir, outDir, src, dest)); return dest; };
  const sectionsOut = sections.map((s, i) => sectionOut(s, i, copy));
  const gaps = {
    connectors: connectorsOut(manifest.connectors, sectionsOut.length, '', copy),
    connectorsMobile: connectorsOut(manifest.connectorsMobile, sectionsOut.length, '-m', copy),
    connectorStills: gapsOut(manifest.connectorStills, sectionsOut.length, copy, (i, src) => `assets/conn${i + 1}-poster${extOf(src)}`),
  };
  return { config: engineConfig(manifest, sectionsOut, gaps), copied };
}

// ---- page generation -------------------------------------------------------

const PANELS = { glass: 'panel-glass.css' };

// ---- glass panel alpha ---------------------------------------------------------

const lin = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
const hexRgb = (h) => { const m = /^#?([\da-f]{6})$/i.exec(String(h || '').trim()); return m ? [0, 2, 4].map((k) => parseInt(m[1].slice(k, k + 2), 16)) : null; };
// The glass panel's colours (panel-glass.css): its shade, and its text (title, body, number); the
// label line mixes 30% of the accent into white.
export const GLASS = { panel: [11, 18, 32], text: ['#ffffff', '#F1F5F9', '#E2E8F0'].map(hexRgb), alpha: 0.36 };

/**
 * The lowest glass alpha (0.01 steps) at which every panel text colour keeps `min` contrast even over a
 * white pixel (the worst a scene can put behind the panel), the label colour from each accent included.
 */
export function panelAlpha(accents = [], { min = 4.5, panel = GLASS.panel } = {}) {
  const labels = accents.map(hexRgb).filter(Boolean).map((a) => a.map((c) => 0.3 * c + 0.7 * 255));
  const texts = [...GLASS.text, ...labels];
  for (let k = 0; k <= 100; k++) {
    const bg = panel.map((c) => (k / 100) * c + (1 - k / 100) * 255);
    if (texts.every((t) => ratio(t, bg) >= min)) return k / 100;
  }
  return 1;
}

// The alpha the page gets: the manifest's panelAlpha (a person's choice) wins, else panelAlpha().
function glassAlpha(manifest) {
  const given = Number(manifest.panelAlpha);
  if (manifest.panelAlpha != null && given >= 0 && given <= 1) return { alpha: given, from: 'manifest' };
  const accents = [manifest.theme?.accent, ...(manifest.sections || []).map((s) => s.accent)];
  return { alpha: panelAlpha(accents), from: 'computed' };
}

/**
 * The CSS the engine injects into <head>, exactly: the `css` template literal wrapped in @layer sw.
 * A template literal turns CRLF and CR into LF, so a checkout with CRLF line ends (git on Windows)
 * is read the same way and gives the same hash.
 */
export function engineCss(rawSource) {
  const engineSource = String(rawSource).replace(/\r\n?/g, '\n');
  const open = engineSource.indexOf('const css = `');
  const close = open === -1 ? -1 : engineSource.indexOf('`;', open + 13);
  if (close === -1) throw new Error('assemble: scrub-engine.js no longer holds `const css = `...``');
  const css = engineSource.slice(open + 13, close);
  if (/\\|\$\{/.test(css)) throw new Error('assemble: the engine CSS has escapes or substitutions; copy it by hand');
  return '@layer sw {\n' + css + '\n}';
}

// Replace the value of a --sw-* custom property, keeping comments.
function setToken(css, name, value) {
  if (!value) return css;
  const re = new RegExp(`(--${name}\\s*:\\s*)[^;]+;`);
  return css.replace(re, `$1${value};`);
}

// The template's inline theme block, with the manifest's colours, as a stylesheet.
function themeCss(styleInner, theme = {}) {
  let css = setToken(styleInner, 'sw-bg', theme.bg);
  css = setToken(css, 'sw-ink', theme.ink);
  css = setToken(css, 'sw-ink-soft', theme.inkSoft);
  css = setToken(css, 'sw-accent', theme.accent);
  return css.replace(/^\n+/, '').replace(/\s*$/, '\n');
}

function stylesheets(manifest) {
  return ['scrub-engine.css', 'theme.css', 'intro-fixes.css', manifest.panel ? PANELS[manifest.panel] : null,
    manifest.stepNav ? 'step-nav.css' : null].filter(Boolean);
}

/**
 * The posters of the first `n` segments in scroll order (scene still, then the connector's own poster
 * when it has one): the engine makes its posters loading=lazy, so on a fast first scroll the first
 * seams could show a poster not yet loaded. A preload link fetches them with the page.
 */
export function firstPosters(config, n = 3) {
  const out = [];
  (config.sections || []).forEach((s, i) => {
    out.push(s.still);
    if (config.connectors?.[i] && config.connectorStills?.[i]) out.push(config.connectorStills[i]);
  });
  return [...new Set(out.filter(Boolean))].slice(0, n);
}

/** index.html from the template's head: title, description and lang set, its inline style replaced by links. */
function renderIndexHtml(template, manifest, config = {}) {
  const brandName = manifest.brand?.name || 'BRAND';
  const subject = manifest.subject || 'SUBJECT';
  const title = manifest.pageTitle || `${brandName} - the world of ${subject}`;
  const desc = manifest.pageDescription || `Scroll to fly through the world of ${brandName.replace(/\.+$/, '')}.`;
  const marker = '<script src="scrub-engine.js">';
  const idx = template.indexOf(marker);
  if (idx === -1) throw new Error('assemble: index-template.html missing the scrub-engine.js script tag');
  let head = template.slice(0, idx).replace(/\s*$/, '\n');
  head = head.replace(/<title>[^<]*<\/title>/, `<title>${escHtml(title)}</title>`);
  head = head.replace(/(<meta name="description" content=")[^"]*(")/, `$1${escAttr(desc)}$2`);
  if (manifest.lang) head = head.replace(/<html lang="[^"]*">/, `<html lang="${escAttr(manifest.lang)}">`);
  const links = [...stylesheets(manifest).map((f) => `  <link rel="stylesheet" href="${f}" />`),
    ...firstPosters(config).map((f) => `  <link rel="preload" as="image" href="${escAttr(f)}" />`)].join('\n');
  head = head.replace(/[ \t]*<style>[\s\S]*?<\/style>\n?/, `${links}\n`);
  const scripts = ['scrub-engine.js', manifest.stepNav ? 'step-nav.js' : null, 'intro.js'].filter(Boolean)
    .map((f) => `  <script src="${f}"></script>`).join('\n');
  return `${head}${scripts}\n</body>\n</html>\n`;
}

// The config and the mount, out of the page so no inline script is needed.
function introJs(config, nav) {
  const json = (v) => JSON.stringify(v, null, 2).replace(/\n/g, '\n  ');
  const lines = nav
    ? [`var nav = ${json(nav === true ? {} : nav)};`, 'if (window.IntroStepNav) window.IntroStepNav.prefetch(config, nav);',
      'mountScrollWorld(world, config);', 'if (window.IntroStepNav) window.IntroStepNav.attach(world, config, nav);']
    : ['mountScrollWorld(world, config);'];
  return `// Generated by assemble.mjs from intro.json. Kept out of index.html so the page runs under a
// Content-Security-Policy without 'unsafe-inline'.
(function () {
  var world = document.getElementById('world');
  var config = ${json(config)};
${lines.map((l) => `  ${l}`).join('\n')}
})();
`;
}

const escHtml = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const escAttr = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Heads the copied engine rules: they are scroll-world's (MIT), whose notice ships beside them.
const ENGINE_NOTICE = '/* scroll-world (https://github.com/oso95/scroll-world), MIT License, (c) 2026 cyw.\n'
  + '   The rules scrub-engine.js injects, copied unchanged. Notice: scrub-engine.LICENSE.md */\n';

function writeStatic(out, manifest, template) {
  const engineSource = fs.readFileSync(path.join(HERE, 'scrub-engine.js'), 'utf8');
  fs.copyFileSync(path.join(HERE, 'scrub-engine.js'), path.join(out, 'scrub-engine.js'));
  fs.copyFileSync(path.join(HERE, 'LICENSE'), path.join(out, 'scrub-engine.LICENSE.md'));
  const css = engineCss(engineSource);
  fs.writeFileSync(path.join(out, 'scrub-engine.css'), ENGINE_NOTICE + css);
  const style = /<style>([\s\S]*?)<\/style>/.exec(template);
  fs.writeFileSync(path.join(out, 'theme.css'), themeCss(style ? style[1] : '', manifest.theme));
  const copies = ['intro-fixes.css', manifest.panel ? PANELS[manifest.panel] : null,
    manifest.stepNav ? 'step-nav.css' : null, manifest.stepNav ? 'step-nav.js' : null].filter(Boolean);
  for (const f of copies) fs.copyFileSync(path.join(HERE, f), path.join(out, f));
  if (manifest.panel === 'glass') {
    const css = path.join(out, PANELS.glass);
    fs.writeFileSync(css, fs.readFileSync(css, 'utf8').replace(/(--intro-panel-alpha:\s*)[\d.]+;/, `$1${glassAlpha(manifest).alpha};`));
  }
  return `'sha256-${crypto.createHash('sha256').update(css).digest('base64')}'`;
}

// ---- public API -------------------------------------------------------------

/**
 * Assemble the intro page. Copies the engine, its fixes and all referenced assets into outDir and
 * writes index.html, intro.js and the stylesheets (see the header).
 * @returns {{ outDir:string, index:string, engine:string, assets:string[], styleHash:string, panelAlpha?:{alpha,from} }}
 */
export function assemble({ projectDir, outDir, manifestPath } = {}) {
  if (!projectDir) throw new Error('assemble: projectDir is required');
  const proj = path.resolve(projectDir);
  const out = path.resolve(outDir || path.join(proj, 'site'));
  const mPath = manifestPath ? path.resolve(manifestPath) : path.join(proj, 'intro.json');
  if (!fs.existsSync(mPath)) {
    throw new Error(`assemble: manifest not found: ${mPath}\n` +
      'Write an intro.json in the project dir (see the header of assemble.mjs for its shape).');
  }
  const manifest = JSON.parse(fs.readFileSync(mPath, 'utf8'));
  if (manifest.panel && !PANELS[manifest.panel]) throw new Error(`assemble: unknown panel "${manifest.panel}" (known: ${Object.keys(PANELS).join(', ')})`);

  fs.mkdirSync(out, { recursive: true });
  const { config, copied } = buildConfig(manifest, proj, out);
  const template = fs.readFileSync(path.join(HERE, 'index-template.html'), 'utf8');
  const styleHash = writeStatic(out, manifest, template);
  fs.writeFileSync(path.join(out, 'intro.js'), introJs(config, manifest.stepNav));
  const indexPath = path.join(out, 'index.html');
  fs.writeFileSync(indexPath, renderIndexHtml(template, manifest, config));

  return { outDir: out, index: indexPath, engine: path.join(out, 'scrub-engine.js'), assets: copied, styleHash, ...(manifest.panel === 'glass' ? { panelAlpha: glassAlpha(manifest) } : {}) };
}

// ---- CLI --------------------------------------------------------------------

// Run only when invoked directly (not when imported by a test/other module).
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
  const argv = process.argv.slice(2);
  let projectDir = null, outDir = null, manifestPath = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--manifest') manifestPath = argv[++i];
    else if (a.startsWith('--manifest=')) manifestPath = a.slice('--manifest='.length);
    else if (!a.startsWith('--')) { if (!projectDir) projectDir = a; else if (!outDir) outDir = a; }
  }
  if (!projectDir) {
    console.error('usage: node assemble.mjs <projectDir> [outDir] [--manifest path]');
    process.exit(1);
  }
  try {
    const r = assemble({ projectDir, outDir, manifestPath });
    console.log(`assembled ${r.assets.length} asset(s) -> ${r.outDir}`);
    console.log(`index:  ${r.index}`);
    console.log(`engine: ${r.engine}`);
    if (r.panelAlpha) console.log(`glass panel alpha: ${r.panelAlpha.alpha} (${r.panelAlpha.from === 'manifest' ? 'the manifest\'s panelAlpha' : 'computed: contrast 4.5 even over white'})`);
    console.log(`CSP: the engine injects one <style>; to allow it add ${r.styleHash} to style-src (scrub-engine.css carries the same rules)`);
    console.log(`\npreview:  node ${path.join(HERE, 'serve.mjs')} ${r.outDir} [--csp strict]`);
  } catch (e) {
    console.error(String(e.message || e));
    process.exit(1);
  }
}
