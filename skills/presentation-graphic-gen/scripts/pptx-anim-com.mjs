// pptx-anim-com.mjs: `pptx.mjs com --anim` and `pptx-anim-probe.mjs --com`. PowerPoint (Windows, through
// pptx-com.ps1 -Anim) opens an animated deck; its report (anim.json) is compared with what the file's own timing XML
// says: per slide the effects in order (target shape, trigger, delay), the clicks, the automatic first group, the same
// after PowerPoint saves a copy (resaved.pptx), and, in a desktop session, the slide show's GetClickCount and
// FirstAnimationIsAutomatic. Captures after each click and the video are written for a person (or a later
// comparison) to look at. Not part of verify: PowerPoint is not on the test PCs.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pptxgen } from './vendor.mjs';

const TRIGGER = { clickEffect: 1, withEffect: 2, afterEffect: 3 };
const xmlEntities = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** The effects of one slide's timing XML in document order: [{ shape (spid), trigger, delay (ms) }]. */
export function xmlEffects(xml) {
  const out = [];
  const re = /<p:cTn id="\d+"([^>]*)nodeType="(clickEffect|withEffect|afterEffect)"[^>]*>\s*<p:stCondLst><p:cond delay="(\d+)"\/>/g;
  for (let m; (m = re.exec(xml));) {
    const tg = /<p:spTgt spid="(\d+)"/.exec(xml.slice(m.index));
    out.push({ spid: tg ? +tg[1] : 0, trigger: TRIGGER[m[2]], delay: +m[3] });
  }
  return out;
}

/** Per slide of a deck: { names: spid -> shape name, effects, clicks, auto }. */
export async function deckEffects(file) {
  const { JSZip } = pptxgen();
  const zip = await JSZip.loadAsync(readFileSync(file));
  const names = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => +a.match(/\d+/)[0] - +b.match(/\d+/)[0]);
  const out = [];
  for (const n of names) {
    const xml = await zip.file(n).async('string');
    const ids = Object.fromEntries([...xml.matchAll(/<p:cNvPr id="(\d+)" name="([^"]*)"/g)].map((m) => [m[1], xmlEntities(m[2])]));
    const effects = xmlEffects(xml).map((e) => ({ shape: ids[e.spid] || `#${e.spid}`, trigger: e.trigger, delay: e.delay }));
    out.push({ effects, clicks: effects.filter((e) => e.trigger === 1).length, auto: /evt="onBegin"/.test(xml) });
  }
  return out;
}

// the differences between the effects the file says and the effects PowerPoint reports, one line each
function effectDiff(k, want, got) {
  const bad = [];
  if (want.length !== got.length) bad.push(`slide ${k}: ${want.length} effects in the file, PowerPoint reports ${got.length}`);
  for (let i = 0; i < Math.min(want.length, got.length); i++) {
    const w = want[i], g = got[i];
    if (w.shape !== g.shape) bad.push(`slide ${k} effect ${i + 1}: shape ${JSON.stringify(w.shape)}, PowerPoint ${JSON.stringify(g.shape)}`);
    if (w.trigger !== g.trigger) bad.push(`slide ${k} effect ${i + 1}: trigger ${w.trigger}, PowerPoint ${g.trigger}`);
    if (Math.abs(w.delay / 1000 - g.delay) > 0.0015) bad.push(`slide ${k} effect ${i + 1}: delay ${w.delay} ms, PowerPoint ${Math.round(g.delay * 1000)} ms`);
  }
  return bad;
}

const effectsOf = (list, k) => (list && list[k] ? list[k].effects : []);
function showGate(gate, want, rep, exp) {
  if (!rep.show) return gate('com-show', null, rep.showSkipped || 'slide show not run');
  const sbad = rep.show.filter((s, k) => s.clicks !== exp[k] || s.firstAuto !== want[k].auto)
    .map((s) => `slide ${s.slide}: GetClickCount ${s.clicks} (expected ${exp[s.slide - 1]}), FirstAnimationIsAutomatic ${s.firstAuto} (expected ${want[s.slide - 1].auto})`);
  return gate('com-show', !sbad.length, `slide show: GetClickCount and FirstAnimationIsAutomatic on ${rep.show.length} slides; captures ${rep.show.reduce((a, s) => a + s.captures.length, 0)} PNG`, sbad);
}
/** Gate lines from a deck, PowerPoint's anim.json and the saved copy's effects; clicks[] is the expected click count per slide (or null). */
export function compareAnim(want, rep, resaved, clicks = null) {
  const lines = [], gate = (name, state, detail, rows = []) => { lines.push(`${state === null ? 'SKIP' : state ? 'PASS' : 'FAIL'} ${name}: ${detail}`); for (const r of rows.slice(0, 12)) lines.push(`  ${r}`); return state !== false; };
  const exp = clicks || want.map((w) => w.clicks), total = want.reduce((a, w) => a + w.effects.length, 0);
  const diff = want.flatMap((w, k) => effectDiff(k + 1, w.effects, effectsOf(rep.slides, k)));
  const cbad = want.map((w, k) => (w.clicks !== exp[k] ? `slide ${k + 1}: ${w.clicks} click effects, ${exp[k]} expected` : null)).filter(Boolean);
  const rdiff = resaved ? want.flatMap((w, k) => effectDiff(k + 1, w.effects, effectsOf(resaved, k).map((e) => ({ ...e, delay: e.delay / 1000 })))) : ['no resaved.pptx'];
  const oks = [
    gate('com-open', rep.slides.length === want.length, `PowerPoint ${rep.version}${rep.build ? ` build ${rep.build}` : ''} opened the file read-only with alerts off: ${rep.slides.length} slides (the file has ${want.length})`),
    gate('com-effects', !diff.length, `${total} effects: target, trigger and delay as written`, diff),
    gate('com-clicks', !cbad.length, `click effects per slide ${want.map((w) => w.clicks).join(', ')}`, cbad),
    gate('com-resaved', !rdiff.length, 'the copy PowerPoint saved keeps every effect, target, trigger and delay', rdiff),
    showGate(gate, want, rep, exp),
  ];
  if (rep.video) gate('com-video', true, `${rep.video.file} (clicks turned into "after previous" + ${rep.video.gapSec} s)`);
  if (rep.videoError) oks.push(gate('com-video', false, `CreateVideo did not make the video: ${rep.videoError}`));
  return { ok: oks.every(Boolean), lines };
}

/**
 * Runs pptx-com.ps1 -Anim on file into dir and compares. Returns { state: 'pass' | 'fail' | 'skip' | 'exists', lines, out }.
 * clicks: expected clicks per slide (from the script: steps - 1 per section), or null.
 */
// pptx-com.ps1 -Anim in Windows PowerShell: { status, out }
function runPs(file, dir, { force, video, timeoutSec }) {
  const ps = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = join(dirname(fileURLToPath(import.meta.url)), 'pptx-com.ps1');
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Src', resolve(file), '-PngDir', resolve(dir), '-Anim', '-TimeoutSec', String(timeoutSec)]
    .concat(force ? ['-Force'] : [], video ? ['-Video'] : []);
  const r = spawnSync(ps, args, { encoding: 'utf8', windowsHide: true, timeout: (timeoutSec + 120) * 1000 });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}
// the run's state before its report is read (null: the report is there to compare)
function runState(r, json) {
  if (r.status === 4) return { state: 'exists', lines: [], out: r.out };
  if (r.status === 2 || /Cannot create|80040154|class not registered/i.test(r.out)) return { state: 'skip', lines: ['SKIP com-open: PowerPoint is running already or not installed'], out: r.out };
  if (r.status !== 0 || !existsSync(json)) return { state: 'fail', lines: [`FAIL com-open: PowerPoint did not open the file or report its animation (exit ${r.status})`], out: r.out };
  return null;
}
export async function animCom(file, dir, { force = false, video = false, clicks = null, timeoutSec = 900 } = {}) {
  if (!force && existsSync(dir) && readdirSync(dir).length) return { state: 'exists', lines: [], out: `${resolve(dir)} is not empty; not overwriting (use --force or another folder)` };
  if (process.platform !== 'win32') return { state: 'skip', lines: ['SKIP com-open: not Windows (PowerPoint COM is Windows only)'], out: '' };
  const r = runPs(file, dir, { force, video, timeoutSec }), json = join(dir, 'anim.json');
  const early = runState(r, json);
  if (early) return early;
  const rep = JSON.parse(readFileSync(json, 'utf8').replace(/^\uFEFF/, ''));
  const resaved = existsSync(join(dir, 'resaved.pptx')) ? await deckEffects(join(dir, 'resaved.pptx')) : null;
  const c = compareAnim(await deckEffects(file), rep, resaved, clicks);
  return { state: c.ok ? 'pass' : 'fail', lines: c.lines, out: r.out };
}

/** The probe folder (pptx-anim-probe.mjs): every probe file into <dir>/com/<id>/; one summary per probe. */
export async function animComAll(dir, probes, { force = false } = {}) {
  const lines = [];
  let ok = true;
  for (const p of probes) {
    const r = await animCom(join(dir, p.file), join(dir, 'com', p.id), { force, clicks: [p.clicks] });
    lines.push(`== ${p.id} ${p.file}: ${r.state.toUpperCase()} (look at: ${p.check})`, ...r.lines);
    if (r.state === 'fail' || r.state === 'exists') { ok = false; lines.push(...r.out.split('\n').slice(-8).map((l) => `  ${l}`)); }
  }
  return { ok, lines };
}
