#!/usr/bin/env node
// build.mjs: builds a key-step motion-graphic presentation (single self-contained HTML files, no network at run time)
// from a script markdown and a folder of scene files. Node >= 22, built-in modules only.
//
//   node scripts/build.mjs <script.md> [--scenes <dir>] [--media <dir>] [--name <name>] [--dir <out dir>]
//                          [--stamp <yymmdd+HHMM>] [--force]
//
// Outputs (in --dir, default ./presentation-out/<name>/; name defaults to the script's file name):
//   <name>-review-<yymmdd+HHMM>.html   the stage plus a script panel (every step's spoken note, current step
//                                      highlighted, click to jump) and a timer from 00:00 on each load
//   <name>-present-<yymmdd+HHMM>.html  the stage only (its data carries no spoken notes)
// An existing output file is never overwritten: the build fails unless --force.
// It also prints a per-section time budget (about 290 Korean syllables per minute) and warns when a step's
// on-screen text largely repeats its spoken note.
//
// Script format (UTF-8 markdown):
//   # <title>
//   ## <n>. <section name> [(목표 m:ss)]       one section = one slide (scene file NN.js, NN = n zero padded)
//   ### <n>-<k>                               one step = one key press (step id "s<n>-<k>")
//   화면: <text>                              on-screen text; more lines may follow as "- <text>"
//   [<stage direction>]                       a whole line in brackets: kept apart, never on screen or spoken
//   말:                                       the spoken note: the following lines (or text after "말:");
//                                             [bracketed] parts inside it are stage directions too
//   ## 메모 ... (any "## " heading without a number) ends the script
//
// Scene files: <scenes>/NN.js, each calling Deck.scene({ section, css, html, steps }) (see runtime/engine.js).
// A section without a scene file gets a placeholder scene showing its 화면 lines.
// Exit codes: 0 ok, 1 script or scene error, 2 usage or file error (including an existing output), 3 vendor check.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { embedFonts } from './fonts.mjs';
import { VendorError } from './vendor.mjs';

export const SKILL = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const RUNTIME = join(SKILL, 'scripts', 'runtime');
export const SAMPLE = join(SKILL, 'assets', 'sample', 'coffee.md');
export const SYLLABLES_PER_MIN = 290;

const fail = (msg, exit) => Object.assign(new Error(msg), { exit });

// ---------- script ----------
const SEC_RE = /^## (\d+)\.\s+(.+?)(?:\s+\(목표 (\d+):(\d\d)\))?\s*$/;
const STEP_RE = /^### (\d+)-(\d+)\s*$/;
const DIRECTION_RE = /\[([^\[\]]*)\]/g;

export function parseScript(text) {
  const lines = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  const errors = [];
  let title = '';
  const sections = [];
  let sec = null, step = null, mode = null;
  const closeStep = () => {
    if (!step) return;
    const raw = step.speechLines.join('\n');
    for (const m of raw.matchAll(DIRECTION_RE)) if (m[1].trim()) step.directions.push(m[1].trim());
    step.speech = raw.replace(DIRECTION_RE, ' ').split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
    delete step.speechLines;
    if (!step.screen.length) errors.push(`${step.key} (line ${step.line}): no 화면 line`);
    step = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i], ln = i + 1, tr = line.trim();
    if (!title && line.startsWith('# ')) { title = line.slice(2).trim(); continue; }
    if (line.startsWith('## ')) {
      closeStep();
      const m = SEC_RE.exec(tr);
      if (!m) {
        if (!/^## \d/.test(tr)) break; // "## 메모" etc.: the script ends here
        errors.push(`line ${ln}: bad section heading "${tr}"`);
        sec = null;
        continue;
      }
      const n = +m[1];
      if (n !== sections.length + 1) errors.push(`line ${ln}: section ${n} out of order (expected ${sections.length + 1})`);
      sec = { n, name: m[2].trim(), target: m[3] != null ? +m[3] * 60 + +m[4] : 0, steps: [] };
      sections.push(sec);
      mode = null;
      continue;
    }
    if (line.startsWith('### ')) {
      closeStep();
      const m = STEP_RE.exec(tr);
      if (!m || !sec) { errors.push(`line ${ln}: bad step heading "${tr}"`); continue; }
      const key = `${m[1]}-${m[2]}`;
      if (+m[1] !== sec.n) errors.push(`line ${ln}: step ${key} under section ${sec.n}`);
      if (+m[2] !== sec.steps.length + 1) errors.push(`line ${ln}: step ${key} out of order`);
      step = { key, id: `s${key}`, screen: [], directions: [], speechLines: [], line: ln };
      sec.steps.push(step);
      mode = null;
      continue;
    }
    if (!step) continue; // text before the first step (notes) is ignored
    if (!tr) continue;
    if (/^\[[^\[\]]*\]$/.test(tr) && mode !== 'speech') { step.directions.push(tr.slice(1, -1).trim()); continue; }
    let m;
    if ((m = /^화면:\s*(.*)$/.exec(tr))) { mode = 'screen'; if (m[1]) step.screen.push(m[1]); continue; }
    if ((m = /^말:\s*(.*)$/.exec(tr))) { mode = 'speech'; if (m[1]) step.speechLines.push(m[1]); continue; }
    if (mode === 'screen') {
      if (tr.startsWith('- ')) step.screen.push(tr.slice(2).trim());
      else errors.push(`line ${ln}: a 화면 line after the first must start with "- "`);
    } else if (mode === 'speech') step.speechLines.push(tr);
    else errors.push(`line ${ln}: text outside 화면 / 말 in ${step.key}`);
  }
  closeStep();
  if (!title) errors.push('the script needs a "# <title>" line');
  if (!sections.length) errors.push('no sections');
  for (const s of sections) if (!s.steps.length) errors.push(`section ${s.n}: no steps`);
  return { title, sections, errors };
}

export function deckData(parsed, mode = 'review') {
  const sections = parsed.sections.map((s) => ({ n: s.n, name: s.name, target: s.target, ids: s.steps.map((st) => st.id) }));
  const steps = [];
  for (const s of parsed.sections) {
    for (const st of s.steps) {
      steps.push({ id: st.id, key: st.key, section: s.n, title: s.name, lines: st.screen.slice(), directions: mode === 'review' ? st.directions.slice() : [], speech: mode === 'review' ? st.speech : '' });
    }
  }
  return { title: parsed.title, sections, steps };
}

// spoken length: Hangul syllables, plus one per Latin letter or digit (read out roughly letter by letter)
export function syllables(text) {
  return (String(text).match(/[\uAC00-\uD7A3A-Za-z0-9]/g) || []).length;
}
const mmss = (sec) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;

export function timeBudget(parsed, spm = SYLLABLES_PER_MIN) {
  const rows = parsed.sections.map((s) => {
    const syl = s.steps.reduce((a, st) => a + syllables(st.speech), 0);
    const sec = (syl / spm) * 60;
    return { n: s.n, name: s.name, syllables: syl, sec, target: s.target, over: s.target > 0 && sec > s.target };
  });
  const syl = rows.reduce((a, r) => a + r.syllables, 0);
  return { spm, rows, total: { syllables: syl, sec: (syl / spm) * 60, target: rows.reduce((a, r) => a + r.target, 0) } };
}

// on-screen text that largely repeats the spoken note (character bigrams of the screen text found in the note)
export function repeatWarnings(parsed, { min = 10, share = 0.7 } = {}) {
  const norm = (s) => String(s).replace(/[^\uAC00-\uD7A3A-Za-z0-9]/g, '').toLowerCase();
  const grams = (s) => { const out = []; for (let i = 0; i + 1 < s.length; i++) out.push(s.slice(i, i + 2)); return out; };
  const out = [];
  for (const s of parsed.sections) {
    for (const st of s.steps) {
      const scr = norm(st.screen.join(''));
      if (scr.length < min) continue;
      const said = new Set(grams(norm(st.speech)));
      const g = grams(scr);
      const hit = g.filter((x) => said.has(x)).length / g.length;
      if (hit >= share) out.push({ id: st.id, key: st.key, share: hit, text: `${st.key}: 화면 글자의 ${Math.round(hit * 100)}% 가 말과 겹칩니다. 화면은 요점만 남기십시오` });
    }
  }
  return out;
}

// ---------- scenes ----------
// Scene code must keep the screen a function of timeline time only: no clocks, no random numbers, no own
// animation loop, no callbacks. Checked on the source with comments removed.
const FORBIDDEN = [
  [/\bMath\.random\b/, 'Math.random (use s.rand(seed) or d.rand(seed))'],
  [/\bDate\.now\b|\bnew\s+Date\b/, 'the clock (Date)'],
  [/\bperformance\.now\b/, 'the clock (performance.now)'],
  [/\brequestAnimationFrame\b/, 'requestAnimationFrame (the engine owns the only clock)'],
  [/\bset(Timeout|Interval)\b/, 'timers (setTimeout / setInterval)'],
  [/\.animate\s*\(|\bnew\s+Animation\b|\bKeyframeEffect\b/, 'own Web Animations (use the s.* helpers)'],
  [/\bonfinish\b|\.finished\b|\.ready\s*\.then|addEventListener\s*\(/, 'callbacks that change state (finish / ready / events)'],
  [/\bgsap\b/i, 'GSAP (not used by this engine)'],
];
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\'"`])\/\/[^\n]*/g, '$1');
}
export function lintScene(src) {
  const code = stripComments(src);
  return FORBIDDEN.filter(([re]) => re.test(code)).map(([, what]) => what);
}

export function loadScenes(dir, data) {
  const errors = [];
  const scenes = [];
  if (!existsSync(dir)) return { scenes, errors };
  const files = readdirSync(dir).filter((f) => /^\d\d\.js$/.test(f)).sort();
  for (const f of files) {
    const n = +f.slice(0, 2);
    const src = readFileSync(join(dir, f), 'utf8');
    for (const what of lintScene(src)) errors.push(`scenes/${f}: uses ${what}`);
    const got = [];
    try {
      vm.runInNewContext(src, { Deck: { scene: (d) => got.push(d), rand: () => () => 0 } }, { filename: f, timeout: 2000 });
    } catch (e) { errors.push(`scenes/${f}: ${e.message}`); continue; }
    if (got.length !== 1) { errors.push(`scenes/${f}: must call Deck.scene() exactly once (called ${got.length})`); continue; }
    const def = got[0] || {};
    const sec = data.sections.find((s) => s.n === n);
    if (!sec) { errors.push(`scenes/${f}: the script has no section ${n}`); continue; }
    if (def.section !== n) errors.push(`scenes/${f}: section is ${def.section}, the file name says ${n}`);
    if (!def.steps || typeof def.steps !== 'object') { errors.push(`scenes/${f}: steps object missing`); continue; }
    const labels = Object.keys(def.steps);
    if (labels.join(',') !== sec.ids.join(',')) errors.push(`scenes/${f}: step labels [${labels.join(', ')}] do not match the script's section ${n} ids [${sec.ids.join(', ')}]`);
    for (const k of labels) if (typeof def.steps[k] !== 'function') errors.push(`scenes/${f}: step ${k} is not a function`);
    const assets = [...src.matchAll(/\basset\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    scenes.push({ n, file: f, src, assets });
  }
  return { scenes, errors };
}

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
function loadAssets(dir, names) {
  const out = {}, errors = [];
  for (const name of [...new Set(names)]) {
    const mime = MIME[extname(name).toLowerCase()];
    const p = join(dir, name);
    if (!mime) errors.push(`asset ${name}: unsupported type (png, jpg, webp, svg)`);
    else if (/[\\/]|\.\./.test(name) || !existsSync(p)) errors.push(`asset ${name}: not found in ${dir}`);
    else {
      const bytes = readFileSync(p);
      if (mime === 'image/svg+xml' && /(href|src)\s*=\s*["']?\s*(https?:)?\/\//i.test(bytes.toString('utf8'))) errors.push(`asset ${name}: an SVG that loads from the network`);
      else out[name] = `data:${mime};base64,${bytes.toString('base64')}`;
    }
  }
  return { assets: out, errors };
}

// ---------- page ----------
const FAVICON = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#14151C"/><rect x="13" y="18" width="38" height="8" rx="4" fill="#F2F2F6"/><rect x="13" y="32" width="26" height="8" rx="4" fill="#F2F2F6" opacity=".6"/><rect x="13" y="45" width="22" height="5" rx="2.5" fill="#E0263F"/></svg>').toString('base64')}`;
const jsonScript = (id, data) => `<script type="application/json" id="${id}">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const inlineJs = (s) => s.replace(/<\/script/gi, '<\\/script');

export function page({ mode, data, fonts, css, engine, scenes, assets }) {
  const faces = fonts.map((f) => `@font-face{font-family:"${f.family}";src:url(data:font/ttf;base64,${f.b64}) format("truetype");font-weight:${f.weight};font-style:normal;font-display:block}`).join('\n');
  const panel = mode === 'review'
    ? '<aside id="panel"><header id="p-head"><span id="p-sec"></span><span id="p-count"></span><span class="tm" id="tm-total"></span><span class="tm" id="tm-sec"></span></header><div id="p-list"></div></aside>'
    : '';
  return `<!doctype html>
<html lang="ko" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/svg+xml" href="${FAVICON}">
<title>${esc(data.title)} - ${mode === 'review' ? '검토용' : '발표용'}</title>
<style>
${faces}
${css}
</style>
</head>
<body class="mode-${mode}">
<div id="app"><div id="viewport"><div id="stage"></div><div id="blank"></div></div>${panel}</div>
${jsonScript('deck-data', data)}
${jsonScript('asset-data', assets)}
<script>window.__CFG=${JSON.stringify({ mode })};</script>
<script>
${inlineJs(engine)}
</script>
${scenes.map((s) => `<script data-scene="${s.file}">\n${inlineJs(s.src)}\n</script>`).join('\n')}
<script>Deck.boot();</script>
</body>
</html>
`;
}

// local time as yymmdd+HHMM
export function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getFullYear() % 100)}${p(d.getMonth() + 1)}${p(d.getDate())}+${p(d.getHours())}${p(d.getMinutes())}`;
}

// exclusive create (fails when the file exists); with force, a random temporary name renamed over the target
function writeOut(path, text, force) {
  if (!force) { writeFileSync(path, text, { flag: 'wx' }); return; }
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, text, { flag: 'wx' });
  renameSync(tmp, path);
}

export function parseArgs(argv, cwd = process.cwd()) {
  const a = { script: null, scenes: null, media: null, name: null, dir: null, stamp: null, force: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const val = () => { const v = argv[++i]; if (v == null || v.startsWith('--')) throw fail(`${k} needs a value`, 2); return v; };
    if (k === '--scenes') a.scenes = resolve(cwd, val());
    else if (k === '--media') a.media = resolve(cwd, val());
    else if (k === '--name') a.name = val();
    else if (k === '--dir') a.dir = resolve(cwd, val());
    else if (k === '--stamp') { a.stamp = val(); if (!/^\d{6}\+\d{4}$/.test(a.stamp)) throw fail(`--stamp needs yymmdd+HHMM, got "${a.stamp}"`, 2); }
    else if (k === '--force') a.force = true;
    else if (k === '--sample') a.script = SAMPLE;
    else if (k.startsWith('--')) throw fail(`unknown option ${k}`, 2);
    else if (!a.script) a.script = resolve(cwd, k);
    else throw fail(`unexpected argument ${k}`, 2);
  }
  if (!a.script) throw fail('usage: node scripts/build.mjs <script.md> [--scenes dir] [--media dir] [--name name] [--dir out] [--stamp yymmdd+HHMM] [--force]  (or --sample)', 2);
  const base = dirname(a.script);
  a.scenes = a.scenes || join(base, 'scenes');
  a.media = a.media || join(base, 'media');
  a.name = a.name || basename(a.script, extname(a.script));
  if (!/^[\w.-]+$/.test(a.name)) throw fail(`--name may hold letters, digits, ".", "_" and "-" only, got "${a.name}"`, 2);
  a.dir = a.dir || join(cwd, 'presentation-out', a.name);
  return a;
}

/** Builds the review / present pair. Returns { review, present, budget, warnings, fonts }. Throws with .exit set. */
export async function build(a) {
  if (!existsSync(a.script)) throw fail(`script not found: ${a.script}`, 2);
  const parsed = parseScript(readFileSync(a.script, 'utf8'));
  if (parsed.errors.length) throw fail(`script errors:\n  ${parsed.errors.join('\n  ')}`, 1);
  const review = deckData(parsed, 'review');
  const { scenes, errors } = loadScenes(a.scenes, review);
  const { assets, errors: aerr } = loadAssets(a.media, scenes.flatMap((s) => s.assets));
  if (errors.length || aerr.length) throw fail(`scene errors:\n  ${errors.concat(aerr).join('\n  ')}`, 1);
  const st = a.stamp || stamp();
  const out = {
    review: join(a.dir, `${a.name}-review-${st}.html`),
    present: join(a.dir, `${a.name}-present-${st}.html`),
  };
  if (!a.force) for (const p of Object.values(out)) if (existsSync(p)) throw fail(`${p} exists; not overwriting (use --force or another --stamp)`, 2);
  const warnings = [];
  const engine = readFileSync(join(RUNTIME, 'engine.js'), 'utf8');
  const css = readFileSync(join(RUNTIME, 'engine.css'), 'utf8');
  const text = [JSON.stringify(review), ...scenes.map((s) => s.src), engine].join('\n');
  let fonts;
  try {
    fonts = await embedFonts(text, { onWarn: (w) => warnings.push(`font: ${w}`) });
  } catch (e) {
    if (e instanceof VendorError) throw fail(e.message, 3);
    throw e;
  }
  mkdirSync(a.dir, { recursive: true });
  const files = {
    review: page({ mode: 'review', data: review, fonts, css, engine, scenes, assets }),
    present: page({ mode: 'present', data: deckData(parsed, 'present'), fonts, css, engine, scenes, assets }),
  };
  try {
    for (const k of Object.keys(out)) writeOut(out[k], files[k], a.force);
  } catch (e) {
    if (e.code === 'EEXIST') throw fail(`${e.path || 'output'} exists; not overwriting (use --force or another --stamp)`, 2);
    throw e;
  }
  const missing = review.sections.filter((s) => !scenes.some((x) => x.n === s.n)).map((s) => s.n);
  if (missing.length) warnings.push(`no scene file for section ${missing.join(', ')}: placeholder scenes`);
  return { ...out, steps: review.steps.length, budget: timeBudget(parsed), repeats: repeatWarnings(parsed), warnings, fonts: fonts.map((f) => ({ rel: f.rel, subset: f.subset, bytes: f.bytes.length })) };
}

export function report(r) {
  const lines = [`review  ${r.review}`, `present ${r.present}`, `steps   ${r.steps}`];
  for (const f of r.fonts) lines.push(`font    ${f.rel} ${f.subset ? 'subset' : 'FULL'} ${(f.bytes / 1024).toFixed(1)} KB`);
  lines.push(`시간 예산 (분당 ${r.budget.spm}음절)`);
  for (const s of r.budget.rows) {
    lines.push(`  ${s.n}. ${s.name}  ${s.syllables}음절  ${mmss(s.sec)}${s.target ? ` / 목표 ${mmss(s.target)}${s.over ? '  초과' : ''}` : ''}`);
  }
  const t = r.budget.total;
  lines.push(`  합계  ${t.syllables}음절  ${mmss(t.sec)}${t.target ? ` / 목표 ${mmss(t.target)}` : ''}`);
  for (const w of r.repeats) lines.push(`경고: ${w.text}`);
  for (const w of r.warnings) lines.push(`warning: ${w}`);
  return lines.join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const r = await build(parseArgs(process.argv.slice(2)));
    process.stdout.write(report(r) + '\n');
  } catch (e) {
    process.stderr.write(`build: ${e.message}\n`);
    process.exit(e.exit || 1);
  }
}
