#!/usr/bin/env node
// make.mjs: one command per output choice.
//
//   node scripts/make.mjs <script.md> [--format html|pptx|both] [--scenes <dir>] [--media <dir>] [--name <name>]
//                         [--dir <out dir>] [--stamp <yymmdd+HHMM>] [--force]      (or --sample instead of the script)
//
//   html  build.mjs (review + present HTML), then check.mjs on the present page
//   pptx  the same HTML first (the PowerPoint files are made from it), then record.mjs (one MP4 per step),
//         pptx-video.mjs, pptx-edit.mjs, and pptx.mjs verify on both decks
//   both  the same as pptx (HTML and both decks)
// Output folder (default ./presentation-out/<name>/): <name>-review-<stamp>.html, <name>-present-<stamp>.html,
// check-<name>-present-<stamp>/ (snapshots, stills, contact sheet), and for pptx: <name>-recording-<stamp>/ (MP4 per
// step), <name>-video-<stamp>.pptx, <name>-edit-<stamp>.pptx. Nothing is overwritten unless --force.
// Every output is checked before any work (an existing file or a non-empty folder: exit 2), and every vendored file
// is checked against its sha256 (exit 3). A gate SKIP is listed in the done block ("== done: PASS with SKIP").
// A failing step stops the run: exit 1 (gates), 2 (usage, files, no browser), 3 (vendor check).
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, parseArgs, parseScript, report, stamp } from './build.mjs';
import { findBrowser } from './cdp.mjs';
import { check } from './check.mjs';
import { verify } from './pptx.mjs';
import { buildEditPptx } from './pptx-edit.mjs';
import { buildVideoPptx } from './pptx-video.mjs';
import { record } from './record.mjs';
import { exitOf, requireVendor } from './vendor.mjs';

const fail = (msg, exit) => Object.assign(new Error(msg), { exit });
const notEmpty = (d) => existsSync(d) && readdirSync(d).length > 0;

/** Output paths of one run; refuses (exit 2) before any work when one exists, unless force. */
function outputs(a, pptx) {
  const out = {
    review: join(a.dir, `${a.name}-review-${a.stamp}.html`),
    present: join(a.dir, `${a.name}-present-${a.stamp}.html`),
    check: join(a.dir, `check-${a.name}-present-${a.stamp}`),
    video: join(a.dir, `${a.name}-video-${a.stamp}.pptx`),
    edit: join(a.dir, `${a.name}-edit-${a.stamp}.pptx`),
    recording: join(a.dir, `${a.name}-recording-${a.stamp}`),
  };
  if (a.force) return out;
  for (const p of [out.review, out.present].concat(pptx ? [out.video, out.edit] : [])) if (existsSync(p)) throw fail(`${p} exists; not overwriting (use --force or another --stamp)`, 2);
  for (const d of [out.check].concat(pptx ? [out.recording] : [])) if (notEmpty(d)) throw fail(`${d} is not empty; not overwriting (use --force or another --stamp)`, 2);
  return out;
}

const skippedOf = (r, deck) => r.results.filter((x) => x.skipped).map((x) => `${x.gate} (${deck})`);

export async function make(argv, { log = (l) => process.stdout.write(l + '\n'), cwd = process.cwd() } = {}) {
  let format = 'html';
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--format') { format = argv[++i]; if (!['html', 'pptx', 'both'].includes(format)) throw fail(`--format needs html, pptx or both, got "${format}"`, 2); }
    else rest.push(argv[i]);
  }
  const a = parseArgs(rest, cwd);
  a.stamp = a.stamp || stamp();
  const pptx = format !== 'html';
  requireVendor(); // every vendored file before any work: a mismatch ends the run with exit 3
  const out = outputs(a, pptx);
  if (!findBrowser()) throw fail('no Chrome, Edge or Chromium found (set CHROME to the browser executable); the gates need one', 2);

  log(`== build (${format})`);
  const r = await build(a);
  log(report(r));
  log('== check');
  const c = await check(r.present, { script: a.script, out: out.check, force: a.force, log });
  if (!c.ok) throw fail(`check failed: ${c.results.filter((x) => !x.ok).map((x) => x.gate).join(', ')} (${c.out})`, 1);
  const result = { review: r.review, present: r.present, check: c.out, contactSheet: c.contactSheet };
  if (!pptx) return result;

  const parsed = parseScript(readFileSync(a.script, 'utf8'));
  log('== record');
  await record(r.present, { out: out.recording, force: a.force, log });
  log('== pptx-video');
  const v = await buildVideoPptx({ parsed, media: out.recording, out: out.video, force: a.force });
  log(`pptx-video ${v.out} ${v.slides} slides ${(v.bytes / 1048576).toFixed(1)} MiB`);
  log('== pptx-edit');
  const e = await buildEditPptx({ html: r.present, parsed, out: out.edit, force: a.force });
  log(`pptx-edit ${e.out} ${e.slides} slides ${(e.bytes / 1048576).toFixed(1)} MiB, ${e.fallbacks.length} picture fallback(s)`);
  for (const f of e.fallbacks) log(`  fallback ${f.step}: ${f.what} (${f.why})`);
  log('== verify video deck');
  const vv = await verify(out.video, { script: a.script, media: out.recording, log });
  log('== verify editable deck');
  const ve = await verify(out.edit, { script: a.script, log });
  if (!vv.ok || !ve.ok) throw fail('pptx verify failed', 1);
  const skipped = skippedOf(vv, 'video deck').concat(skippedOf(ve, 'editable deck'));
  return Object.assign(result, { recording: out.recording, video: out.video, edit: out.edit, fallbacks: e.fallbacks, skipped: skipped.join(', ') });
}

/** The "== done" block: every output path, and the skipped gates on one line (a SKIP is not a pass). */
export function doneReport(r) {
  const head = r.skipped ? '== done: PASS with SKIP' : '== done';
  return [head, ...Object.entries(r).filter(([, v]) => typeof v === 'string' && v).map(([k, v]) => `${k.padEnd(13)}${v}`)].join('\n') + '\n';
}

// real paths on both sides: node runs a script reached through a link (macOS /var is /private/var) by its real path
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const r = await make(process.argv.slice(2));
    process.stdout.write(doneReport(r));
  } catch (e) {
    process.stderr.write(`make: ${e.message}\n`);
    process.exit(exitOf(e, 1));
  }
}
