#!/usr/bin/env node
// consensus.mjs: one round of the consensus loop (humanizer references/consensus-loop.md, presentation-graphic-gen
// references/polish-loop.md). Seats propose edits on their own, other seats vote, and only edits a majority accepts
// are kept. The source of truth is skills/humanizer/scripts; the copy in presentation-graphic-gen is kept byte for
// byte by scripts/sync-adapter.js.
//
//   node consensus.mjs init [--from <file>] [--dir <folder>]
//   node consensus.mjs merge <round folder> --root <dir> [--decided <file>]
//   node consensus.mjs tally <round folder> --root <dir> [--decided <file>] [--apply] [--dry-run]
//
// A round folder is named round-NN. It holds seats.json (or the work folder does), one reply file per seat
// (<seat>.md, the seat's answer as given: a JSON array and a last line MODEL: <model id>), and what this writes:
// candidates.json (merge), accepted.json and round.json (tally). The decided list (default <round folder>/../decided.json)
// keeps every accepted and rejected edit, so later rounds do not propose them again.
// merge drops, with the reason, an edit whose `from` is not found exactly once, was decided before, undoes an earlier
// decision, or touches protected text: a code fence, inline code, a URL, a path, a --flag, a number, or (outside code
// files) quoted text, which has to come through unchanged.
// A round with no candidate is decided without voters. tally accepts a candidate when more than half of the counted voters, and at least two, vote accept. Of accepted
// edits that overlap in one file, the one with more accept votes (then the lower id) stays and the other is deferred
// (not decided, so it may come back). --apply applies the accepted edits (apply-fix.mjs); --dry-run writes nothing.
// A seat whose reply has no JSON array, or whose MODEL line names another model family than seats.json, is not
// counted. Fewer than three counted proposers or voters stops the round: run those seats again.
// Exit codes: 0 done, 1 too few counted seats, 2 usage or file error.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyFixes, readText } from './apply-fix.mjs';

const fail = (msg, exit) => Object.assign(new Error(msg), { exit });
export const EFFORTS = ['none', 'low', 'medium'];
const FAMILIES = ['opus', 'sonnet', 'haiku', 'fable', 'luna', 'sol', 'terra', 'astra'];
const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx', '.json']);
const show = (s) => JSON.stringify(String(s).length > 40 ? String(s).slice(0, 40) + '..' : String(s));

// ---------- seat replies ----------

/** The JSON array of a seat's reply (a fenced block, else the text from the first [ to the last ]) or null. */
export function findArray(text) {
  const fences = [...String(text).matchAll(/```[a-z]*\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
  const at = text.indexOf('['), end = text.lastIndexOf(']');
  const tries = at >= 0 && end > at ? [...fences, text.slice(at, end + 1)] : fences;
  for (const t of tries) {
    try {
      const v = JSON.parse(t);
      if (Array.isArray(v)) return v;
    } catch { /* next */ }
  }
  return null;
}

/** { items, model } of a reply: items null when no array is found, model '' without a MODEL line. */
export function parseReply(text) {
  const models = [...String(text).matchAll(/^[ \t>*_`]*MODEL:\s*(.+?)[\s*_`]*$/gm)];
  return { items: findArray(String(text)), model: models.length ? models.at(-1)[1].trim() : '' };
}

const familyOf = (s) => FAMILIES.find((f) => new RegExp(`(^|[^a-z])${f}([^a-z]|$)`).test(String(s).toLowerCase())) || '';

/** True when the reported model names a known family other than the expected one (unknown or missing is no mismatch). */
export function modelMismatch(expected, reported) {
  const want = familyOf(expected), got = familyOf(reported);
  return Boolean(want && got && want !== got);
}

// ---------- seats ----------

function checkSeat(s, i, kind) {
  if (!s || typeof s.seat !== 'string' || !/^[A-Za-z0-9_-]{1,20}$/.test(s.seat)) throw fail(`seats.json: ${kind}[${i}] needs a seat name (letters, digits, _ or -)`, 2);
  if (typeof s.model !== 'string' || !s.model.trim()) throw fail(`seats.json: seat ${s.seat} needs a model`, 2);
  if (!EFFORTS.includes(s.effort)) throw fail(`seats.json: seat ${s.seat} effort must be one of ${EFFORTS.join(', ')}`, 2);
}

/** Reads and checks seats.json of the round folder (or of the work folder above it). */
export function readSeats(roundDir) {
  const file = [join(roundDir, 'seats.json'), join(dirname(roundDir), 'seats.json')].find((f) => existsSync(f));
  if (!file) throw fail(`no seats.json in ${roundDir} or the folder above it`, 2);
  let j;
  try { j = JSON.parse(readText(file)); } catch (e) { throw e.exit ? e : fail(`${file}: ${e.message}`, 2); }
  const seats = { scope: typeof j.scope === 'string' ? j.scope : 'full', proposers: j.proposers, voters: j.voters };
  for (const kind of ['proposers', 'voters']) {
    if (!Array.isArray(seats[kind]) || seats[kind].length < 3) throw fail(`seats.json: ${kind} needs three seats or more`, 2);
    seats[kind].forEach((s, i) => checkSeat(s, i, kind));
  }
  const names = [...seats.proposers, ...seats.voters].map((s) => s.seat);
  if (new Set(names).size !== names.length) throw fail('seats.json: every seat needs its own name; a voter is never a proposer', 2);
  return seats;
}

function roundOf(roundDir) {
  const m = /^round-(\d{1,3})$/.exec(basename(roundDir));
  if (!m) throw fail(`${roundDir}: a round folder is named round-NN`, 2);
  return Number(m[1]);
}

/** Each seat's reply: { seat, model, effort, reported, items, counted, note }. */
export function readReplies(roundDir, seats) {
  return seats.map((s) => {
    const file = join(roundDir, `${s.seat}.md`);
    const base = { seat: s.seat, model: s.model, effort: s.effort };
    if (!existsSync(file)) return { ...base, reported: '', items: null, counted: false, note: `no ${s.seat}.md` };
    const { items, model } = parseReply(readText(file));
    if (!items) return { ...base, reported: model, items: null, counted: false, note: 'no JSON array in the reply' };
    if (modelMismatch(s.model, model)) return { ...base, reported: model, items, counted: false, note: `reply names ${model}, not ${s.model}` };
    return { ...base, reported: model, items, counted: true, note: model ? '' : 'no MODEL line' };
  });
}

function needSeats(replies, kind) {
  const counted = replies.filter((r) => r.counted).length;
  if (counted >= 3) return;
  const lines = replies.filter((r) => !r.counted).map((r) => `  ${r.seat}: ${r.note}`);
  throw fail(`${counted} counted ${kind}, three needed; run these seats again:\n${lines.join('\n')}`, 1);
}

// ---------- protected text ----------

const FENCE_RE = /^[ \t]{0,3}(```|~~~)[^\n]*\n[\s\S]*?(?:^[ \t]{0,3}\1[^\n]*$|(?![\s\S]))/gm;
const TOKEN_RES = [
  /`[^`\n]+`/g,
  /\bhttps?:\/\/[^\s<>()"'`]+/g,
  /(?<![\w.~])(?:~|\.{1,2})?\/[\w.~-]+(?:\/[\w.~-]*)*/g,
  /\b[A-Za-z]:\\[^\s"'`<>|]+/g,
  /(?<![\w-])--[A-Za-z][\w-]*/g,
  /\d+(?:[.,:]\d+)*/g,
];
const QUOTE_RE = /"([^"\n]{1,300})"|“([^”\n]{1,300})”|„([^“”\n]{1,300})[“”]|«([^»\n]{1,300})»|「([^」\n]{1,300})」|『([^』\n]{1,300})』/g;

function spansOf(re, text, mapper = (m) => m[0]) {
  return [...text.matchAll(re)].map((m) => ({ at: m.index, end: m.index + m[0].length, token: mapper(m) }));
}

/** Protected spans of a text: { at, end, token, fence? }. Quoted text counts only outside code files. */
export function protectedSpans(text, { code = false } = {}) {
  const out = spansOf(FENCE_RE, text).map((s) => ({ ...s, fence: true }));
  for (const re of TOKEN_RES) out.push(...spansOf(re, text));
  if (!code) out.push(...spansOf(QUOTE_RE, text, (m) => `"${m.slice(1).find((g) => g !== undefined)}"`));
  return out;
}

const tokens = (s, code) => protectedSpans(s, { code }).filter((p) => !p.fence).map((p) => p.token).sort();

/** Why an edit of text[at, at + from.length) to `to` would touch protected text, or ''. */
export function protectedChange(text, at, from, to, { code = false } = {}) {
  const end = at + from.length;
  for (const p of protectedSpans(text, { code })) {
    if (p.end <= at || p.at >= end) continue;
    if (p.fence) return 'inside a code fence';
    if (p.at < at || p.end > end) return `cuts through protected text ${show(p.token)}`;
  }
  const a = tokens(from, code), b = tokens(to, code);
  return a.join('\0') === b.join('\0') ? '' : 'changes protected text (code, URL, path, flag, number or quote)';
}

// ---------- merge ----------

function count(hay, needle) {
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) n++;
  return n;
}

function fileText(root, file, cache) {
  if (cache.has(file)) return cache.get(file);
  const abs = resolve(root, file), rel = relative(resolve(root), abs);
  let v = null;
  if (rel && !rel.startsWith('..') && !isAbsolute(rel) && existsSync(abs)) v = readText(abs);
  cache.set(file, v);
  return v;
}

function decidedReason(item, decided) {
  for (const d of decided) {
    if (d.file !== item.file) continue;
    if (d.from === item.from) return `decided in round ${d.round} (${d.decision})`;
    if (d.decision === 'accepted' && d.to === item.from && d.from === item.to) return `undoes an edit accepted in round ${d.round}`;
  }
  return '';
}

/** Why a proposed item cannot be a candidate, or ''. */
export function dropReason(item, root, decided, cache) {
  if (!item || typeof item.file !== 'string' || typeof item.from !== 'string' || typeof item.to !== 'string') return 'needs file, from and to as text';
  if (!item.from || item.from === item.to) return item.from ? 'from and to are the same' : 'empty from';
  const text = fileText(root, item.file, cache);
  if (text === null) return 'file not found or outside the root';
  const n = count(text, item.from);
  if (n !== 1) return n ? `from found ${n} times` : 'from not found';
  return decidedReason(item, decided) || protectedChange(text, text.indexOf(item.from), item.from, item.to, { code: CODE_EXT.has(extname(item.file).toLowerCase()) });
}

/** Groups the counted proposers' items into candidates (same file and from), dropping the ones that cannot be. */
export function mergeProposals(replies, { root, decided = [] }) {
  const cache = new Map(), byKey = new Map(), candidates = [], dropped = [];
  for (const r of replies.filter((x) => x.counted)) {
    for (const item of r.items) {
      const why = dropReason(item, root, decided, cache);
      if (why) { dropped.push({ file: item?.file ?? '', from: item?.from ?? '', to: item?.to ?? '', by: r.seat, reason: why }); continue; }
      const key = `${item.file}\0${item.from}`;
      if (!byKey.has(key)) {
        byKey.set(key, { id: candidates.length + 1, file: item.file, from: item.from, to: [], kind: [], reason: [], by: [] });
        candidates.push(byKey.get(key));
      }
      const c = byKey.get(key);
      if (!c.to.includes(item.to)) c.to.push(item.to);
      if (typeof item.kind === 'string' && item.kind && !c.kind.includes(item.kind)) c.kind.push(item.kind);
      if (typeof item.reason === 'string' && item.reason) c.reason.push(item.reason);
      if (!c.by.includes(r.seat)) c.by.push(r.seat);
    }
  }
  return { candidates, dropped };
}

// ---------- tally ----------

function ballotsFor(replies) {
  return replies.filter((r) => r.counted).map((r) => {
    const byId = new Map();
    for (const b of r.items) if (b && Number.isInteger(b.id) && !byId.has(b.id)) byId.set(b.id, b);
    return byId;
  });
}

/** Votes on one candidate: { accept, reject, abstain, to_final }. */
export function votesOn(c, ballots) {
  const v = { accept: 0, reject: 0, abstain: 0 };
  const pref = new Map(c.to.map((t) => [t, 0]));
  for (const byId of ballots) {
    const b = byId.get(c.id);
    const vote = b?.vote === 'accept' || b?.vote === 'reject' ? b.vote : 'abstain';
    v[vote]++;
    if (vote === 'accept' && pref.has(b.preferredTo)) pref.set(b.preferredTo, pref.get(b.preferredTo) + 1);
  }
  let best = c.to[0];
  for (const t of c.to) if (pref.get(t) > pref.get(best)) best = t;
  return { ...v, to_final: best };
}

/** Of accepted candidates that overlap in one file, keeps the one with more accept votes (then the lower id). */
export function resolveOverlaps(decided, root) {
  const cache = new Map(), kept = new Map();
  const order = decided.filter((d) => d.decision === 'accepted').sort((a, b) => b.votes.accept - a.votes.accept || a.id - b.id);
  for (const d of order) {
    const text = fileText(root, d.file, cache) ?? '';
    const at = text.indexOf(d.from), end = at + d.from.length;
    const spans = kept.get(d.file) ?? [];
    const clash = spans.find((s) => at < s.end && s.at < end);
    if (clash) { d.decision = 'deferred'; d.note = `overlaps candidate ${clash.id}, which has more accept votes or a lower id`; continue; }
    spans.push({ at, end, id: d.id });
    kept.set(d.file, spans);
  }
}

/** Decides each candidate from the counted voters' ballots. */
export function decide(candidates, voterReplies, root) {
  const ballots = ballotsFor(voterReplies);
  const need = Math.max(2, Math.floor(ballots.length / 2) + 1);
  const out = candidates.map((c) => {
    const { to_final, ...votes } = votesOn(c, ballots);
    const accepted = votes.accept >= need;
    return { id: c.id, file: c.file, from: c.from, to: c.to, kind: c.kind, votes, decision: accepted ? 'accepted' : 'rejected', to_final: accepted ? to_final : '', note: '' };
  });
  resolveOverlaps(out, root);
  return { decisions: out, need };
}

// ---------- files ----------

function readJson(file, fallback) {
  if (!existsSync(file)) {
    if (fallback !== undefined) return fallback;
    throw fail(`${file} not found`, 2);
  }
  try { return JSON.parse(readText(file)); } catch (e) { throw e.exit ? e : fail(`${file}: ${e.message}`, 2); }
}

function writeJson(file, value) {
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  renameSync(tmp, file);
}

const decidedFileOf = (roundDir, given) => given || join(dirname(roundDir), 'decided.json');

function readDecided(file) {
  const j = readJson(file, []);
  if (!Array.isArray(j)) throw fail(`${file}: expected an array`, 2);
  return j;
}

// ---------- commands ----------

/** merge: reads the proposers' replies and writes candidates.json. Returns the output lines. */
export function runMerge(roundDir, { root, decidedFile }) {
  const round = roundOf(roundDir), seats = readSeats(roundDir);
  const replies = readReplies(roundDir, seats.proposers);
  needSeats(replies, 'proposers');
  const { candidates, dropped } = mergeProposals(replies, { root, decided: readDecided(decidedFileOf(roundDir, decidedFile)) });
  const proposers = replies.map(({ items, ...r }) => ({ ...r, items: items ? items.length : 0 }));
  writeJson(join(roundDir, 'candidates.json'), { round, scope: seats.scope, proposers, candidates, dropped });
  const lines = proposers.map((p) => `proposer ${p.seat} (${p.model}, ${p.effort}${p.reported ? `, reported ${p.reported}` : ''}): ${p.items} items${p.counted ? '' : `, not counted: ${p.note}`}`);
  for (const d of dropped) lines.push(`DROP ${d.by} ${d.file}: ${show(d.from)} (${d.reason})`);
  lines.push(`round ${round}: ${candidates.length} candidates, ${dropped.length} dropped`);
  return lines;
}

function applyStep(decisions, root, dryRun) {
  const accepted = decisions.filter((d) => d.decision === 'accepted')
    .map((d) => ({ file: d.file, from: d.from, to: d.to_final, kind: d.kind.join('|'), reason: `round decision ${d.id}` }));
  const r = applyFixes(accepted, { root, dryRun });
  return { accepted, applied: r.applied.length, skipped: r.skipped.map((s) => ({ from: s.item.from, reason: s.reason })), lines: r.lines };
}

function nextDecided(decided, decisions, round, skipped) {
  const skippedFrom = new Set(skipped.map((s) => s.from));
  const fresh = decisions.filter((d) => (d.decision === 'accepted' && !skippedFrom.has(d.from)) || d.decision === 'rejected')
    .map((d) => ({ round, file: d.file, from: d.from, to: d.decision === 'accepted' ? d.to_final : d.to[0], decision: d.decision }));
  return [...decided, ...fresh];
}

/** tally: reads candidates.json and the voters' replies, decides, and (unless dryRun) writes the round's files. */
export function runTally(roundDir, { root, decidedFile, apply = false, dryRun = false }) {
  const round = roundOf(roundDir), seats = readSeats(roundDir);
  const merged = readJson(join(roundDir, 'candidates.json'));
  // A round without candidates needs no vote: it is the zero round that ends the loop.
  const replies = merged.candidates.length ? readReplies(roundDir, seats.voters) : [];
  if (merged.candidates.length) needSeats(replies, 'voters');
  const { decisions, need } = decide(merged.candidates, replies, root);
  const step = apply ? applyStep(decisions, root, dryRun) : { accepted: null, applied: null, skipped: [], lines: [] };
  const voters = replies.map(({ items, ...r }) => r);
  const newConsensus = decisions.filter((d) => d.decision === 'accepted').length;
  const record = { round, scope: merged.scope, need, proposers: merged.proposers, voters, candidates: decisions, dropped: merged.dropped, applied: step.applied, skipped: step.skipped, newConsensus };
  const lines = voters.filter((v) => !v.counted).map((v) => `voter ${v.seat} not counted: ${v.note}`);
  for (const d of decisions) lines.push(`${d.decision.toUpperCase()} ${d.id} ${d.file}: ${show(d.from)} (${d.votes.accept} accept, ${d.votes.reject} reject${d.note ? `; ${d.note}` : ''})`);
  const how = decisions.length ? `need ${need} of ${voters.filter((v) => v.counted).length} votes` : 'no candidate, no vote';
  lines.push(...step.lines, `round ${round}: ${newConsensus} new consensus (${how})${dryRun ? ', dry run: nothing written' : ''}`);
  if (dryRun) return lines;
  const decidedPath = decidedFileOf(roundDir, decidedFile);
  writeJson(join(roundDir, 'accepted.json'), decisions.filter((d) => d.decision === 'accepted').map((d) => ({ file: d.file, from: d.from, to: d.to_final, kind: d.kind.join('|'), reason: `round ${round} decision ${d.id}` })));
  writeJson(join(roundDir, 'round.json'), record);
  writeJson(decidedPath, nextDecided(readDecided(decidedPath), decisions, round, step.skipped));
  return lines;
}

/** init: makes the work folder (a new one under the system temp folder unless --dir) and copies --from into it
 * as text<ext> (text.md for a plain-text name). */
export function runInit({ from, dir }) {
  let work;
  if (dir) {
    work = resolve(dir);
    if (existsSync(work) && readdirSync(work).length) throw fail(`${work} is not empty; give a new or empty folder`, 2);
    mkdirSync(work, { recursive: true });
  } else {
    work = mkdtempSync(join(tmpdir(), 'humanizer-'));
  }
  const lines = [`work ${work}`];
  if (from) {
    if (!existsSync(from)) throw fail(`${from} not found`, 2);
    readText(from); // UTF-8 or UTF-16 with a BOM, before anything is copied
    // a plain-text name becomes .md: a DRM may encrypt the copy otherwise (banker keeps its work files off those names)
    const ext = extname(from);
    const text = join(work, `text${!ext || /^\.(?:txt|csv)$/i.test(ext) ? '.md' : ext}`);
    copyFileSync(from, text);
    lines.push(`text ${text}`);
  }
  return lines;
}

// ---------- CLI ----------

const USAGE = 'usage: node consensus.mjs init [--from <file>] [--dir <folder>]\n'
  + '       node consensus.mjs merge <round folder> --root <dir> [--decided <file>]\n'
  + '       node consensus.mjs tally <round folder> --root <dir> [--decided <file>] [--apply] [--dry-run]';
const VALUE_FLAGS = new Set(['--root', '--decided', '--from', '--dir']);

export function parseArgs(argv) {
  const a = { cmd: argv[0], pos: [], apply: false, dryRun: false };
  for (let i = 1; i < argv.length; i++) {
    const t = argv[i];
    if (VALUE_FLAGS.has(t)) {
      if (i + 1 >= argv.length) throw fail(`${t} needs a value`, 2);
      a[t.slice(2)] = argv[++i];
    } else if (t === '--apply') a.apply = true;
    else if (t === '--dry-run') a.dryRun = true;
    else if (!t.startsWith('--')) a.pos.push(t);
    else throw fail(`unknown argument ${t}`, 2);
  }
  return a;
}

export function run(argv) {
  const a = parseArgs(argv);
  if (a.cmd === 'init' && !a.pos.length) return runInit({ from: a.from && resolve(a.from), dir: a.dir });
  if ((a.cmd === 'merge' || a.cmd === 'tally') && a.pos.length === 1) {
    if (!a.root) throw fail(`${a.cmd} needs --root <dir>`, 2);
    const opts = { root: resolve(a.root), decidedFile: a.decided && resolve(a.decided), apply: a.apply, dryRun: a.dryRun };
    const roundDir = resolve(a.pos[0]);
    if (!existsSync(roundDir)) throw fail(`${roundDir} not found`, 2);
    return a.cmd === 'merge' ? runMerge(roundDir, opts) : runTally(roundDir, opts);
  }
  throw fail(USAGE, 2);
}

// real paths on both sides: node runs a script reached through a link (macOS /var is /private/var) by its real path.
// A name realpath cannot read (argv[1] of `node -e`, for one) is compared as given, so importing this file never throws.
const ranAs = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
if (process.argv[1] && ranAs(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(run(process.argv.slice(2)).join('\n') + '\n');
  } catch (e) {
    process.stderr.write(`consensus: ${e.exit ? e.message : e.stack || e}\n`);
    process.exit(e.exit || 2);
  }
}
