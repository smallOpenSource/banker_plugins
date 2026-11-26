#!/usr/bin/env node
// apply-fix.mjs: applies the accepted items of one consensus round to the files (humanizer references/consensus-loop.md,
// presentation-graphic-gen references/polish-loop.md). The source of truth is skills/humanizer/scripts; the copy in
// presentation-graphic-gen is kept byte for byte by scripts/sync-adapter.js.
//
//   node scripts/apply-fix.mjs <accepted.json> [--root <dir>] [--dry-run]
//
// accepted.json: an array, or { "items": [...] }, of { file, from, to, kind?, reason? }. file is relative to --root
// (default: the current folder) and may not leave it. Each item is checked against the file as it was before this
// run: `from` must occur exactly once, must differ from `to`, and must not overlap another item of the same file
// (merge such items into one before applying). An item that fails is SKIPPED with its reason; the others are
// applied. Line endings and everything outside the replaced spans stay byte for byte. --dry-run writes nothing.
// Output: one APPLY / SKIP line per item, then "applied N, skipped M" (dry run: "would apply N, skipped M").
// Exit codes: 0 done (skips are reported, not errors), 2 usage or file error.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const fail = (msg, exit) => Object.assign(new Error(msg), { exit });

/** A text input as text: UTF-8 (a BOM is dropped) or UTF-16 with its BOM; anything else is a file error (exit 2). */
export function readText(file) {
  const bytes = readFileSync(file);
  const utf16 = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : null;
  let text;
  try {
    text = new TextDecoder(utf16 || 'utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw fail(`${file} is not UTF-8 (or UTF-16 with a BOM); save it as UTF-8`, 2);
  }
  return text.startsWith('\uFEFF') ? text.slice(1) : text;
}

const show = (s) => JSON.stringify(String(s).length > 40 ? String(s).slice(0, 40) + '..' : String(s));

function count(hay, needle) {
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) n++;
  return n;
}

/** Applies items under root. Returns { applied: [...], skipped: [{ item, reason }], lines }. */
export function applyFixes(items, { root = process.cwd(), dryRun = false } = {}) {
  const lines = [], applied = [], skipped = [];
  const skip = (item, reason) => { skipped.push({ item, reason }); lines.push(`SKIP ${item.file || '?'}: ${show(item.from)} (${reason})`); };
  const byFile = new Map();
  items.forEach((item, k) => {
    if (!item || typeof item.file !== 'string' || typeof item.from !== 'string' || typeof item.to !== 'string') return skip(item || {}, 'needs file, from and to as text');
    if (!item.from) return skip(item, 'empty from');
    if (item.from === item.to) return skip(item, 'from and to are the same');
    const abs = resolve(root, item.file), rel = relative(resolve(root), abs);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return skip(item, 'file is outside the root');
    if (!existsSync(abs)) return skip(item, 'file not found');
    if (!byFile.has(abs)) byFile.set(abs, []);
    byFile.get(abs).push({ item, k });
  });
  for (const [abs, list] of byFile) {
    const text = readFileSync(abs, 'utf8');
    const spans = [];
    for (const { item, k } of list) {
      const n = count(text, item.from);
      if (n !== 1) { skip(item, n === 0 ? 'from not found' : `from found ${n} times`); continue; }
      const at = text.indexOf(item.from), end = at + item.from.length;
      const clash = spans.find((s) => at < s.end && s.at < end);
      if (clash) { skip(item, `overlaps item ${clash.k + 1} in the same file; merge them into one`); continue; }
      spans.push({ at, end, item, k });
    }
    if (!spans.length) continue;
    let out = text;
    for (const s of spans.slice().sort((a, b) => b.at - a.at)) out = out.slice(0, s.at) + s.item.to + out.slice(s.end);
    for (const s of spans.sort((a, b) => a.k - b.k)) { applied.push(s.item); lines.push(`${dryRun ? 'WOULD APPLY' : 'APPLY'} ${s.item.file}: ${show(s.item.from)} to ${show(s.item.to)}`); }
    if (!dryRun) {
      const tmp = `${abs}.${randomBytes(6).toString('hex')}.tmp`;
      writeFileSync(tmp, out, { flag: 'wx' });
      renameSync(tmp, abs);
    }
  }
  lines.push(`${dryRun ? 'would apply' : 'applied'} ${applied.length}, skipped ${skipped.length}`);
  return { applied, skipped, lines };
}

// real paths on both sides: node runs a script reached through a link (macOS /var is /private/var) by its real path.
// A name realpath cannot read (argv[1] of `node -e`, for one) is compared as given, so importing this file never throws.
const ranAs = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
if (process.argv[1] && ranAs(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  let list = null, root = process.cwd(), dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') root = resolve(argv[++i] || '');
    else if (argv[i] === '--dry-run') dryRun = true;
    else if (!argv[i].startsWith('--') && !list) list = resolve(argv[i]);
    else { process.stderr.write(`apply-fix: unknown argument ${argv[i]}\n`); process.exit(2); }
  }
  if (!list) { process.stderr.write('usage: node scripts/apply-fix.mjs <accepted.json> [--root <dir>] [--dry-run]\n'); process.exit(2); }
  let items;
  try {
    const j = JSON.parse(readText(list));
    items = Array.isArray(j) ? j : j.items;
    if (!Array.isArray(items)) throw new Error('expected an array or { "items": [...] }');
  } catch (e) {
    process.stderr.write(`apply-fix: ${e.exit ? e.message : `${join(list)}: ${e.message}`}\n`);
    process.exit(2);
  }
  const r = applyFixes(items, { root, dryRun });
  process.stdout.write(r.lines.join('\n') + '\n');
}
