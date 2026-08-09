#!/usr/bin/env node
/*
 * First-party assembler for the 3d-intro-build skill.
 *
 * Takes a project directory that already holds the generated stills + forward-chained clips
 * (+ an intro.json manifest describing them) and produces a self-contained preview site:
 *   <outDir>/
 *     index.html            (written from index-template.html, wired to the manifest)
 *     scrub-engine.js       (copied verbatim from references/)
 *     assets/<id>.<ext>     (scene posters/stills)
 *     assets/vid/<id>.mp4   (per-scene dive clips)
 *     assets/vid/connN.mp4  (optional connectors)
 * Serve <outDir> with serve.mjs to preview.
 *
 * Runtime: Node >=18 builtins ONLY (node:fs / node:path / node:url). No external deps,
 * no shell — cross-platform (path.join / path.sep; asset URLs are always posix '/').
 *
 * The manifest (intro.json) mirrors the mountScrollWorld config, but its `still` / `clip` /
 * `connectors` values are paths to SOURCE files relative to projectDir; this assembler copies
 * them into assets/ and rewrites the config to the copied relative URLs. Shape:
 *
 *   {
 *     "pageTitle": "BRAND — the world of SUBJECT",   // optional (else derived)
 *     "pageDescription": "Scroll to fly through ...", // optional (else derived)
 *     "brand": { "name": "BRAND", "href": "#top" },   // optional
 *     "cta":   { "label": "Order now", "href": "#finale" }, // optional top-bar CTA
 *     "hint":  "scroll to fly in",                     // optional
 *     "theme": { "bg":"#F5EDE0","ink":"#241d2b","inkSoft":"#6a6072","accent":"#9B7EBD" }, // optional
 *     "diveScroll": 1.3, "connScroll": 0.9, "crossfade": 0.12, // optional
 *     "nav": true, "atmosphere": true,                 // optional (only false is emitted)
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
 *     "connectorsMobile": ["conn-1-m.mp4", ...]         // optional, same length
 *   }
 *
 * Usage:
 *   node assemble.mjs <projectDir> [outDir] [--manifest path]
 *     projectDir   holds intro.json + the source stills/clips it references
 *     outDir       output site dir (default: <projectDir>/site)
 *     --manifest   manifest path (default: <projectDir>/intro.json)
 */
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

/**
 * Build the exact mountScrollWorld config object from a manifest, copying every referenced
 * asset into outDir/assets. Returns { config, copied:[destPosix,...] }.
 */
function buildConfig(manifest, projectDir, outDir) {
  const sections = Array.isArray(manifest.sections) ? manifest.sections : [];
  if (sections.length === 0) throw new Error('assemble: manifest.sections must have at least one section');

  const copied = [];
  const track = (destPosix) => { copied.push(destPosix); return destPosix; };

  const sectionsOut = sections.map((s, i) => {
    if (!s || !s.id) throw new Error(`assemble: section[${i}] missing "id"`);
    if (!s.still) throw new Error(`assemble: section[${i}] (${s.id}) missing "still"`);
    if (!s.clip) throw new Error(`assemble: section[${i}] (${s.id}) missing "clip"`);

    const out = { id: s.id, label: s.label || s.id };

    // poster still (keep source extension so png/webp/jpg all work)
    out.still = track(copyAsset(projectDir, outDir, s.still, `assets/${s.id}${extOf(s.still)}`));
    if (s.stillMobile) {
      out.stillMobile = track(copyAsset(projectDir, outDir, s.stillMobile, `assets/${s.id}-m${extOf(s.stillMobile)}`));
    }

    // dive clip
    out.clip = track(copyAsset(projectDir, outDir, s.clip, `assets/vid/${s.id}${extOf(s.clip) || '.mp4'}`));
    if (s.clipMobile) {
      out.clipMobile = track(copyAsset(projectDir, outDir, s.clipMobile, `assets/vid/${s.id}-m${extOf(s.clipMobile) || '.mp4'}`));
    }

    if (s.accent) out.accent = s.accent;
    if (s.eyebrow) out.eyebrow = s.eyebrow;
    if (s.title) out.title = s.title;
    if (s.body) out.body = s.body;
    if (Array.isArray(s.tags) && s.tags.length) out.tags = s.tags;
    if (s.scroll != null) out.scroll = s.scroll;
    if (s.linger != null) out.linger = s.linger;
    if (s.cta) out.cta = s.cta; // last section only (engine renders it wherever present)
    return out;
  });

  // connectors: length === sections.length - 1; null entries mean "crossfade directly".
  const srcConn = Array.isArray(manifest.connectors) ? manifest.connectors : [];
  const srcConnM = Array.isArray(manifest.connectorsMobile) ? manifest.connectorsMobile : [];
  const connectorsOut = [];
  const connectorsMobileOut = [];
  for (let i = 0; i < sectionsOut.length - 1; i++) {
    const c = srcConn[i];
    connectorsOut.push(c ? track(copyAsset(projectDir, outDir, c, `assets/vid/conn${i + 1}${extOf(c) || '.mp4'}`)) : null);
    const cm = srcConnM[i];
    connectorsMobileOut.push(cm ? track(copyAsset(projectDir, outDir, cm, `assets/vid/conn${i + 1}-m${extOf(cm) || '.mp4'}`)) : null);
  }

  // Assemble in the shape mountScrollWorld reads (see scrub-engine.js).
  const config = {};
  if (manifest.brand) config.brand = manifest.brand;
  if (manifest.cta) config.cta = manifest.cta;
  config.hint = manifest.hint || 'scroll to fly in';
  config.diveScroll = manifest.diveScroll != null ? manifest.diveScroll : 1.3;
  config.connScroll = manifest.connScroll != null ? manifest.connScroll : 0.9;
  if (manifest.crossfade != null) config.crossfade = manifest.crossfade;
  if (manifest.nav === false) config.nav = false;
  if (manifest.atmosphere === false) config.atmosphere = false;
  config.sections = sectionsOut;
  config.connectors = connectorsOut;
  if (connectorsMobileOut.some(Boolean)) config.connectorsMobile = connectorsMobileOut;

  return { config, copied };
}

// ---- index.html generation --------------------------------------------------

// Replace the value of a --sw-* custom property in the template's :root block, keeping comments.
function setToken(html, name, value) {
  if (!value) return html;
  const re = new RegExp(`(--${name}\\s*:\\s*)[^;]+;`);
  return html.replace(re, `$1${value};`);
}

/** Render index.html from index-template.html for the given config + manifest metadata. */
function renderIndexHtml(template, config, manifest) {
  const brandName = manifest.brand?.name || 'BRAND';
  const subject = manifest.subject || 'SUBJECT';
  const title = manifest.pageTitle || `${brandName} — the world of ${subject}`;
  const desc = manifest.pageDescription || `Scroll to fly through the world of ${brandName.replace(/\.+$/, '')}.`;

  // Everything up to the engine <script> tag is the head+body-open; regenerate the tail.
  const marker = '<script src="scrub-engine.js">';
  const idx = template.indexOf(marker);
  if (idx === -1) throw new Error('assemble: index-template.html missing the scrub-engine.js script tag');
  let head = template.slice(0, idx).replace(/\s*$/, '\n');

  head = head.replace(/<title>[^<]*<\/title>/, `<title>${escHtml(title)}</title>`);
  head = head.replace(/(<meta name="description" content=")[^"]*(")/, `$1${escAttr(desc)}$2`);
  const t = manifest.theme || {};
  head = setToken(head, 'sw-bg', t.bg);
  head = setToken(head, 'sw-ink', t.ink);
  head = setToken(head, 'sw-ink-soft', t.inkSoft);
  head = setToken(head, 'sw-accent', t.accent);

  const configJson = JSON.stringify(config, null, 2).replace(/\n/g, '\n    ');
  const tail =
`  <script src="scrub-engine.js"></script>
  <script>
    mountScrollWorld(document.getElementById('world'), ${configJson});
  </script>
</body>
</html>
`;
  return head + tail;
}

const escHtml = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const escAttr = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---- public API -------------------------------------------------------------

/**
 * Assemble a preview site. Copies scrub-engine.js + all referenced assets into outDir and
 * writes index.html wired to the exact mountScrollWorld config.
 * @returns {{ outDir:string, index:string, engine:string, assets:string[] }}
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

  fs.mkdirSync(out, { recursive: true });
  const { config, copied } = buildConfig(manifest, proj, out);

  // Vendored engine sits next to this script; copy it beside index.html.
  const engineSrc = path.join(HERE, 'scrub-engine.js');
  if (!fs.existsSync(engineSrc)) throw new Error(`assemble: scrub-engine.js not found at ${engineSrc}`);
  fs.copyFileSync(engineSrc, path.join(out, 'scrub-engine.js'));

  const template = fs.readFileSync(path.join(HERE, 'index-template.html'), 'utf8');
  const html = renderIndexHtml(template, config, manifest);
  const indexPath = path.join(out, 'index.html');
  fs.writeFileSync(indexPath, html);

  return { outDir: out, index: indexPath, engine: path.join(out, 'scrub-engine.js'), assets: copied };
}

// ---- CLI --------------------------------------------------------------------

// Run only when invoked directly (not when imported by a test/other module).
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
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
    console.log(`\npreview:  node ${path.join(HERE, 'serve.mjs')} ${r.outDir}`);
  } catch (e) {
    console.error(String(e.message || e));
    process.exit(1);
  }
}
