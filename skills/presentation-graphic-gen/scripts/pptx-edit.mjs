#!/usr/bin/env node
// pptx-edit.mjs: an editable PowerPoint deck with PowerPoint's own animation: one slide per section, one click per
// step (the section's first step plays by itself after a 0.25 s Fade transition). Everything the section shows is a
// native shape at its rest place, read from the page (pptx-anim-extract.mjs): text boxes (one per rendered line,
// runs keep size, weight, color, letter spacing), filled or bordered shapes (rounded corners, the focus outline's glow as a:glow),
// and pictures where a shape cannot be native (images, SVG, gradients and hatches, rotated elements; listed).
// The motion is planned from the page's measured time series (pptx-anim-plan.mjs: Fade, Appear, Wipe, sampled
// keyframes for position, size and rotation, crossfaded copies for partial opacity) and written as slide timing
// (pptx-anim-xml.mjs). Every approximation and anything that cannot be shown is listed. Notes = each step's
// [key] head line, its spoken lines and [stage directions]; each slide has the hidden title `<n>. <section>`.
// Theme fonts: Latin Noto Sans, East Asian Noto Sans KR (not embedded: the viewing PC needs them installed).
//
//   node scripts/pptx-edit.mjs <present.html> <script.md> --out <file.pptx> [--force]
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deckData, parseScript, readText } from './build.mjs';
import { findBrowser } from './cdp.mjs';
import { extractDeck } from './pptx-anim-extract.mjs';
import { planSection } from './pptx-anim-plan.mjs';
import { glowXml, timingXml, transitionXml } from './pptx-anim-xml.mjs';
import { MASTER, PX, defineMaster, patchNotes, patchSlide, patchTheme, sectionNotes, sectionTitle, shapeRect, writeNew, xmlText } from './pptx-common.mjs';
import { exitOf, pptxgen } from './vendor.mjs';

const IN = (px) => px * PX;
const PT = (px) => px / 2; // 1920 px = 13.333 in = 960 pt
const alpha = (a) => Math.round((1 - Math.max(0, Math.min(1, a))) * 100);

function addBox(p, s, it, c, name) {
  const R = shapeRect(it);
  const o = { x: IN(R.x), y: IN(R.y), w: IN(R.w), h: IN(R.h), objectName: name,
    fill: it.fill ? { color: it.fill.hex, transparency: alpha(c.alphaOf(it.fill.a)) } : undefined, // undefined: PptxGenJS writes <a:noFill/>
    line: it.line ? { color: it.line.hex, width: PT(it.line.w), transparency: alpha(c.alphaOf(it.line.a)) } : undefined };
  const rad = it.rad - (it.line ? it.line.w / 2 : 0);
  if (rad > 0.5) { o.rectRadius = IN(Math.min(rad, Math.min(it.w, it.h) / 2)); s.addShape(p.ShapeType.roundRect, o); } else s.addShape(p.ShapeType.rect, o);
}

// c: the plan's shape (alphaOf: the alpha a color of the item gets in this shape)
function addItem(p, s, S, it, c, name) {
  const R = shapeRect(it);
  if (it.kind === 'box') return addBox(p, s, it, c, name);
  if (it.kind === 'text') {
    const runs = it.runs.map((r) => ({ text: r.t, options: { fontSize: PT(r.size), bold: r.bold, color: r.hex, transparency: alpha(c.alphaOf(r.a)), lang: 'ko-KR', charSpacing: r.ls ? PT(r.ls) : undefined } }));
    return s.addText(runs, { x: IN(R.x), y: IN(R.y), w: IN(R.w), h: IN(R.h), margin: 0, valign: 'middle', align: it.align, wrap: false, fit: 'none', objectName: name });
  }
  const o = { data: `image/png;base64,${S.pics[it.id].toString('base64')}`, x: IN(R.x), y: IN(R.y), w: IN(R.w), h: IN(R.h), altText: `${it.what} (${it.why})`, objectName: name };
  if (c.alphaOf(1) < 0.995) o.transparency = alpha(c.alphaOf(1));
  s.addImage(o);
}

// the step a shape is first seen in: shown from the slide start, or its first entrance
function firstStep(plan, k) {
  if (plan.shapes[k].vis0) return plan.steps[0].id;
  const st = plan.steps.find((x) => x.effects.some((f) => f.shape === k && f.cls === 'entr'));
  return (st || plan.steps[0]).id;
}

function addSection(p, S, plan, steps) {
  const s = p.addSlide({ masterName: MASTER });
  s.background = { color: S.bg };
  s.addText(sectionTitle(S), { placeholder: 'title' });
  const fallbacks = [];
  plan.shapes.forEach((c, k) => {
    const it = S.items[c.item];
    addItem(p, s, S, it, c, c.name);
    if (it.kind === 'pic' && c.level === Math.max(...plan.shapes.filter((x) => x.item === c.item).map((x) => x.level))) fallbacks.push({ step: firstStep(plan, k), what: it.what, why: it.why });
  });
  s.addNotes(sectionNotes(steps));
  return fallbacks;
}

// slide XML: ids renumbered, the glows, then the transition and the timing after <p:clrMapOvr>
function slideXml(xml, S, plan) {
  const r = patchSlide(xml);
  const byName = new Map(r.ids.map((x) => [xmlText(x.name), x.id]));
  const spids = plan.shapes.map((c) => byName.get(c.name));
  if (spids.some((v) => v == null)) throw new Error(`section ${S.n}: a shape of the plan is missing on its slide`);
  let out = r.xml;
  plan.shapes.forEach((c, k) => {
    const it = S.items[c.item];
    if (it.kind !== 'box' || !it.glow) return;
    const at = out.indexOf(`<p:cNvPr id="${spids[k]}" `), end = out.indexOf('</p:spPr>', at);
    if (at >= 0 && end > at) out = out.slice(0, end) + glowXml(it.glow.blur / 2, it.glow.hex, c.alphaOf(it.glow.a)) + out.slice(end);
  });
  if (!out.includes('</p:clrMapOvr>')) throw new Error(`section ${S.n}: no p:clrMapOvr to put the timing after`);
  return out.replace('</p:clrMapOvr>', () => '</p:clrMapOvr>' + transitionXml() + timingXml(plan, spids));
}

function checkSections(secs, data) {
  if (secs.length !== data.sections.length) throw new Error(`${secs.length} sections in the page, ${data.sections.length} in the script`);
  secs.forEach((S, k) => { if (S.ids.join(',') !== data.sections[k].ids.join(',')) throw new Error(`section ${S.n}: page steps ${S.ids}, script steps ${data.sections[k].ids}`); });
}

/**
 * Builds the editable deck. Returns { out, bytes, slides, fallbacks: [{ step, what, why }], notes: [{ step, cat, text }],
 * counts: { exact, approx, impossible } } (notes: every approximation and what cannot be shown).
 */
export async function buildEditPptx({ html, parsed, out, force = false, browser }) {
  const data = deckData(parsed, 'review');
  const secs = await extractDeck(html, { browser });
  checkSections(secs, data);
  const plans = secs.map((S) => planSection(S));
  const { PptxGenJS, JSZip } = pptxgen();
  const p = new PptxGenJS();
  p.layout = 'LAYOUT_WIDE';
  p.title = data.title;
  p.author = 'presentation-graphic-gen';
  p.company = '';
  p.theme = { headFontFace: 'Noto Sans', bodyFontFace: 'Noto Sans' };
  defineMaster(p);
  const fallbacks = secs.flatMap((S, k) => addSection(p, S, plans[k], data.steps.filter((st) => st.section === S.n)));
  const zip = await JSZip.loadAsync(await p.write({ outputType: 'nodebuffer', compression: false }));
  for (const name of Object.keys(zip.files)) {
    const sm = /^ppt\/slides\/slide(\d+)\.xml$/.exec(name);
    if (sm) zip.file(name, slideXml(await zip.file(name).async('string'), secs[+sm[1] - 1], plans[+sm[1] - 1]));
    else if (/^ppt\/theme\/theme\d+\.xml$/.test(name)) zip.file(name, patchTheme(await zip.file(name).async('string')));
    else if (/^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name)) zip.file(name, patchNotes(await zip.file(name).async('string')));
  }
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  writeNew(out, bytes, force);
  const counts = plans.reduce((a, pl) => ({ exact: a.exact + pl.counts.exact, approx: a.approx + pl.counts.approx, impossible: a.impossible + pl.counts.impossible }), { exact: 0, approx: 0, impossible: 0 });
  return { out, bytes: bytes.length, slides: secs.length, steps: data.steps.length, fallbacks, notes: plans.flatMap((pl) => pl.notes), counts };
}

/** The report lines of a build: the summary, then each picture fallback, approximation and motion that cannot be shown. */
export function editReport(r) {
  const c = r.counts;
  return [`pptx-edit ${r.out} ${r.slides} slides (${r.steps} steps) ${(r.bytes / 1048576).toFixed(1)} MiB, ${r.fallbacks.length} picture fallback(s)`,
    `  motion: ${c.exact} exact, ${c.approx} approx, ${c.impossible} not possible`,
    ...r.fallbacks.map((f) => `  fallback ${f.step}: ${f.what} (${f.why})`),
    ...r.notes.map((n) => `  ${n.cat === 'approx' ? 'approx' : 'not possible'} ${n.step}: ${n.text}`)];
}

// real paths on both sides: node runs a script reached through a link (macOS /var is /private/var) by its real path.
// A name realpath cannot read (argv[1] of `node -e`, for one) is compared as given, so importing this file never throws.
const ranAs = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
if (process.argv[1] && ranAs(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  let html = null, script = null, out = null, force = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out = resolve(argv[++i] || '');
    else if (argv[i] === '--force') force = true;
    else if (!argv[i].startsWith('--') && !html) html = resolve(argv[i]);
    else if (!argv[i].startsWith('--') && !script) script = resolve(argv[i]);
    else { process.stderr.write(`pptx-edit: unknown argument ${argv[i]}\n`); process.exit(2); }
  }
  if (!html || !script || !out) { process.stderr.write('usage: node scripts/pptx-edit.mjs <present.html> <script.md> --out <file.pptx> [--force]\n'); process.exit(2); }
  if (!findBrowser()) { process.stderr.write('pptx-edit: no Chrome, Edge or Chromium found; set CHROME to the browser executable\n'); process.exit(2); }
  try {
    const parsed = parseScript(readText(script));
    if (parsed.errors.length) throw Object.assign(new Error(parsed.errors.join('; ')), { exit: 1 });
    const r = await buildEditPptx({ html, parsed, out, force });
    process.stdout.write(editReport(r).join('\n') + '\n');
  } catch (e) {
    process.stderr.write(`pptx-edit: ${e.message}\n`);
    process.exit(exitOf(e, 1));
  }
}
