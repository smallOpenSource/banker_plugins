#!/usr/bin/env node
/*
 * The cases skills/append_wiki/wiki.mjs is held to OMC 5.8.4 with, shared by the golden generator
 * (scripts/gen-omc-wiki-golden.mjs, which runs them through OMC's dist) and the test (skills/append_wiki/wiki.test.mjs,
 * which runs them through wiki.mjs and compares with the fixtures in omc-wiki-5.8.4/).
 *
 * Run as a child process, so OMC's in-process caches and a frozen clock touch nothing else:
 *   node omc-wiki-cases.mjs scenario <impl> <name>   cwd: a git project; prints {"steps":[..],"final":{..}}
 *   node omc-wiki-cases.mjs where <impl> <wd JSON>   prints {"dir":".."} or {"error":".."}
 *   node omc-wiki-cases.mjs validate <impl>          prints [true|false, ..] for VALIDATION (omc: zod, banker: wiki.mjs)
 * <impl> is `banker` or `omc=<OMC plugin folder>`.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const WIKI_MJS = path.join(HERE, '..', '..', 'skills', 'append_wiki', 'wiki.mjs');
export const FIXTURE_DIR = path.join(HERE, 'omc-wiki-5.8.4');

// ============================================================================
// A clock frozen per step: `new Date()` and Date.now() give the step's time, as both implementations read the clock
// only through them.
// ============================================================================

const RealDate = globalThis.Date;
let frozenAt = null;
class FrozenDate extends RealDate {
  constructor(...args) {
    if (args.length === 0 && frozenAt !== null) super(frozenAt);
    else super(...args);
  }

  static now() {
    return frozenAt !== null ? frozenAt : RealDate.now();
  }
}

export function freezeClock(iso) {
  globalThis.Date = FrozenDate;
  frozenAt = RealDate.parse(iso);
}

const hours = (n) => new RealDate(RealDate.UTC(2026, 0, 1) + n * 3600000).toISOString();
const DAY = 24;

// ============================================================================
// Scenarios. A step is a tool call, a seeded file (written straight into .omc/wiki) or a folder made in the project.
// `deliberate` marks where wiki.mjs stops on purpose while OMC goes on: there it must answer isError with that text
// at the start and change no file.
// ============================================================================

const call = (at, tool, input = {}) => ({ at: hours(at), tool, input });
const seed = (at, file, content) => ({ at: hours(at), seed: file, content });

const LEGACY_CRLF = '\u{FEFF}' + [
  '---', 'title: "Legacy CRLF"', 'tags: [old, "two, parts"]', 'aliases: [kept-only-by-omc-read]',
  'created: 2025-12-01T00:00:00.000Z', 'updated: 2025-12-01T00:00:00.000Z', 'sources: []', 'links: []',
  'category: reference', 'confidence: low', 'schemaVersion: 1', '---', '', '# Legacy CRLF', '', 'Old body.', '',
].join('\r\n');
const QUOTED_ITEMS = [
  '---', "title: 'Quoted ''Items'''", "tags: [x, 'y z']", 'sources: ["a, b", \'it\'\'s\', "c\\"d"]', 'links: []',
  'category: pattern', 'confidence: high', '---', '', '# Quoted', '', 'Seeded without created, updated or schemaVersion.', '',
].join('\n');
const FUTURE = [
  '---', 'title: "Future"', 'tags: []', 'created: 2026-01-01T00:00:00.000Z', 'updated: 2026-01-01T00:00:00.000Z',
  'sources: []', 'links: []', 'category: reference', 'confidence: medium', 'schemaVersion: 2', '---', '', '# Future', '', 'v2 body.', '',
].join('\n');
const LONELY = [
  '---', 'title: "Lonely"', 'tags: [solo]', 'created: 2026-01-01T00:00:00.000Z', 'updated: 2026-01-01T00:00:00.000Z',
  'sources: []', 'links: []', 'category: reference', 'confidence: medium', 'schemaVersion: 1', '---', '', '# Lonely', '', 'No index yet.', '',
].join('\n');
const LONG_FIRST_LINE = 'This first line is deliberately longer than eighty characters so the index summary gets cut short.';

const ingest = (at, title, extra = {}) => call(at, 'wiki_ingest', { title, content: `${title} body.`, tags: [], category: 'reference', ...extra });

const MAIN = [
  call(0, 'wiki_list'),
  call(1, 'wiki_query', { query: 'anything' }),
  call(2, 'wiki_lint'),
  ingest(3, 'Auth Architecture', {
    content: `${LONG_FIRST_LINE}\n\nTokens live in [[Session Store]], see [[Session Store|the store]] and [[Token#Refresh]].\n- step one\n- step two`,
    tags: ['auth', 'Auth', 'login', 'auth'], category: 'architecture', sources: ['src/auth.ts', 'notes, "quoted"'], confidence: 'high',
  }),
  ingest(4, 'Auth Architecture', {
    content: 'Second pass: refresh rotates. See [[Login Flow]].', tags: ['login', 'jwt'], category: 'debugging',
    sources: ['src/auth.ts', 'docs/auth.md'], confidence: 'low',
  }),
  ingest(5, 'Session Store', { content: 'Backed by redis. Links back to [[Auth Architecture]].', tags: ['auth', 'cache'], category: 'pattern' }),
  { at: hours(6), mkdir: 'sub' },
  ingest(7, 'Login Flow', { content: 'Login goes through the flow.', tags: ['flow'], category: 'decision', confidence: 'medium', workingDirectory: 'sub' }),
  ingest(8, '한글 제목', { content: '한글 본문입니다. 검색 테스트.', tags: ['한글', '위키'], category: 'convention' }),
  ingest(9, 'Claude Code Context Usage Signals And Compaction Automation Ceiling Extra Words'),
  ingest(10, 'Quote "and" back\\slash\nline two', { tags: ['odd "tag"'] }),
  seed(11, 'legacy-crlf.md', LEGACY_CRLF),
  ingest(12, 'Legacy CRLF', { content: 'New body after CRLF.', tags: ['new'] }),
  seed(13, 'quoted-items.md', QUOTED_ITEMS),
  ingest(14, 'Quoted Items', { content: 'Merged into the quoted page.', tags: ['y z', 'w'], sources: ['c"d', 'e'], confidence: 'medium' }),
  ingest(15, 'Conf Medium'),
  ingest(16, 'Conf Medium', { confidence: 'high' }),
  ingest(17, 'Conf Medium'),
  ingest(18, 'Conf Low', { confidence: 'low' }),
  ingest(19, 'Conf Low', { confidence: 'medium' }),
  call(20, 'wiki_add', { title: 'Quick Note', content: 'Quick body.' }),
  call(21, 'wiki_add', { title: 'Quick Note', content: 'Again.' }),
  call(22, 'wiki_add', { title: 'Typed Note', content: 'Typed body.', tags: ['t1'], category: 'environment' }),
  ingest(23, 'Index'),
  ingest(24, 'environment'),
  call(25, 'wiki_read', { page: 'auth-architecture' }),
  call(25, 'wiki_read', { page: 'auth-architecture.md' }),
  call(25, 'wiki_read', { page: 'nope' }),
  call(25, 'wiki_read', { page: '../secret' }),
  call(25, 'wiki_read', { page: 'legacy-crlf' }),
  call(25, 'wiki_read', { page: 'quoted-items' }),
  call(25, 'wiki_read', { page: 'index' }),
  call(26, 'wiki_query', { query: 'auth' }),
  call(27, 'wiki_query', { query: 'session store' }),
  call(28, 'wiki_query', { query: '' }),
  call(29, 'wiki_query', { query: 'flow', tags: ['JWT', 'flow'] }),
  call(30, 'wiki_query', { query: '한글' }),
  call(31, 'wiki_query', { query: '검색' }),
  call(32, 'wiki_query', { query: 'auth', category: 'pattern' }),
  call(33, 'wiki_query', { query: 'auth', limit: 1 }),
  call(34, 'wiki_query', { query: 'zzzz' }),
  call(35, 'wiki_query', { query: 'Привет мир' }),
  call(36, 'wiki_list'),
  ingest(37, 'Big Page', { content: 'x'.repeat(10300) }),
  ingest(38, 'Edge Page', { content: 'y'.repeat(10240 - '\n# Edge Page\n\n\n'.length) }),
  ingest(39, 'A'.repeat(200), {
    content: 'm'.repeat(50000), tags: Array.from({ length: 20 }, (_, i) => `tag${i}`.padEnd(50, 'z')),
    sources: Array.from({ length: 10 }, (_, i) => `src${i}`.padEnd(100, 's')), category: 'decision',
  }),
  ingest(40, 'Cache Layer Alpha', { tags: ['shared'], category: 'architecture', confidence: 'high' }),
  ingest(41, 'Cache Layer Beta', { tags: ['shared'], category: 'pattern', confidence: 'low' }),
  call(42, 'wiki_delete', { page: 'quick-note' }),
  call(43, 'wiki_delete', { page: 'quick-note.md' }),
  call(44, 'wiki_delete', { page: '../outside' }),
  ingest(74 * DAY, 'Fresh Page', { content: 'Updated a day before the lint. [[Auth Architecture]]' }),
  call(75 * DAY, 'wiki_lint'),
  call(75 * DAY + 1, 'wiki_list'),
];

export const SCENARIOS = {
  main: MAIN,
  'no-index': [
    seed(0, 'lonely.md', LONELY),
    call(1, 'wiki_list'),
    call(2, 'wiki_read', { page: 'lonely' }),
    call(3, 'wiki_query', { query: 'lonely' }),
  ],
  'unparsable-ingest': [
    seed(0, 'broken-page.md', 'Just text, no frontmatter.\n'),
    { ...ingest(1, 'Broken Page'), deliberate: 'Error ingesting into wiki: Existing wiki page broken-page.md has no readable frontmatter' },
  ],
  'unparsable-add': [
    seed(0, 'broken-page.md', 'Just text, no frontmatter.\n'),
    { ...call(1, 'wiki_add', { title: 'Broken Page', content: 'New.' }), deliberate: 'Error adding wiki page: Existing wiki page broken-page.md has no readable frontmatter' },
  ],
  'reserved-delete': [
    ingest(0, 'Some Page'),
    { ...call(1, 'wiki_delete', { page: 'index' }), deliberate: 'Error deleting wiki page: Cannot delete reserved wiki file: index.md' },
  ],
  'schema-v2': [
    seed(0, 'future.md', FUTURE),
    { ...ingest(1, 'Future'), deliberate: 'Error ingesting into wiki: Wiki page future.md has schemaVersion 2' },
    { ...ingest(2, 'Other'), deliberate: 'Error ingesting into wiki: Wiki page future.md has schemaVersion 2' },
    { ...call(3, 'wiki_delete', { page: 'future' }), deliberate: 'Error deleting wiki page: Wiki page future.md has schemaVersion 2' },
  ],
};

// ============================================================================
// Input validation cases: each input against the tool's declared zod schema.
// ============================================================================

const rep = (n, ch = 'a') => ch.repeat(n);
const okIngest = { title: 'T', content: 'c', tags: [], category: 'pattern' };
export const VALIDATION = [
  ['wiki_ingest', okIngest],
  ['wiki_ingest', { title: rep(200), content: rep(50000), tags: Array(20).fill(rep(50)), category: 'decision',
    sources: Array(10).fill(rep(100)), confidence: 'low', workingDirectory: '.' }],
  ['wiki_ingest', { ...okIngest, title: rep(201) }],
  ['wiki_ingest', { ...okIngest, content: rep(50001) }],
  ['wiki_ingest', { ...okIngest, tags: Array(21).fill('t') }],
  ['wiki_ingest', { ...okIngest, tags: [rep(51)] }],
  ['wiki_ingest', { ...okIngest, sources: Array(11).fill('s') }],
  ['wiki_ingest', { ...okIngest, sources: [rep(101)] }],
  ['wiki_ingest', { title: 'T', content: 'c', tags: [] }],
  ['wiki_ingest', { ...okIngest, category: 'other' }],
  ['wiki_ingest', { ...okIngest, confidence: 'certain' }],
  ['wiki_ingest', { title: 'T', content: 'c', category: 'pattern' }],
  ['wiki_ingest', { content: 'c', tags: [], category: 'pattern' }],
  ['wiki_ingest', { title: 'T', tags: [], category: 'pattern' }],
  ['wiki_ingest', { ...okIngest, title: 5 }],
  ['wiki_ingest', { ...okIngest, tags: 'a' }],
  ['wiki_ingest', { ...okIngest, tags: [1] }],
  ['wiki_ingest', { ...okIngest, sources: null }],
  ['wiki_ingest', { ...okIngest, workingDirectory: null }],
  ['wiki_ingest', { ...okIngest, workingDirectory: 5 }],
  ['wiki_ingest', { ...okIngest, extra: 'ignored' }],
  ['wiki_ingest', { ...okIngest, title: rep(200, '한') }],
  ['wiki_ingest', { ...okIngest, title: rep(100, '\u{1F600}') }],
  ['wiki_ingest', { ...okIngest, title: rep(101, '\u{1F600}') }],
  ['wiki_add', { title: 'T', content: 'c' }],
  ['wiki_add', { title: 'T', content: 'c', category: 'x' }],
  ['wiki_add', { title: 'T', content: 'c', tags: Array(21).fill('t') }],
  ['wiki_add', { title: 'T' }],
  ['wiki_query', { query: 'x' }],
  ['wiki_query', { query: '' }],
  ['wiki_query', { query: 'x', limit: 1 }],
  ['wiki_query', { query: 'x', limit: 50 }],
  ['wiki_query', { query: 'x', limit: 0 }],
  ['wiki_query', { query: 'x', limit: 51 }],
  ['wiki_query', { query: 'x', limit: 1.5 }],
  ['wiki_query', { query: 'x', limit: '5' }],
  ['wiki_query', { query: 'x', tags: ['a'] }],
  ['wiki_query', { query: 'x', tags: 'a' }],
  ['wiki_query', { query: 'x', category: 'nope' }],
  ['wiki_query', {}],
  ['wiki_lint', {}],
  ['wiki_lint', { workingDirectory: 1 }],
  ['wiki_list', {}],
  ['wiki_read', { page: 'x' }],
  ['wiki_read', {}],
  ['wiki_read', { page: 3 }],
  ['wiki_delete', { page: 'x' }],
  ['wiki_delete', {}],
];

// ============================================================================
// Storage-location cases: one layout of repositories, worktrees, a submodule and workspace markers under a base
// folder, and per case the session cwd, the workingDirectory and the environment.
// ============================================================================

// A base folder for one run. Its real path, so no link sits between what a case passes and what git reports. On
// POSIX under /tmp, not os.tmpdir(): macOS puts that under /var, a folder OMC never anchors state in, which would make
// the workspace-marker cases answer differently there. The cases point TMPDIR at base/faketmp instead.
export function makeBase(prefix) {
  const parent = process.platform !== 'win32' && fs.existsSync('/tmp') ? '/tmp' : os.tmpdir();
  return fs.realpathSync(fs.mkdtempSync(path.join(parent, prefix)));
}

// A clean environment: nothing from the caller's git or OMC settings, a home and a temp folder of the case's own.
export function caseEnv(base, extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GIT_|OMC_)/.test(k)));
  const tmp = path.join(base, 'faketmp');
  const home = path.join(base, 'home');
  return { ...env, HOME: home, USERPROFILE: home, TMPDIR: tmp, TEMP: tmp, TMP: tmp, GIT_CONFIG_NOSYSTEM: '1', ...extra };
}

export function gitRun(args, cwd, base) {
  return execFileSync('git', ['-c', 'user.name=wiki test', '-c', 'user.email=wiki@example.invalid', '-c', 'init.defaultBranch=main',
    '-c', 'protocol.file.allow=always', ...args], { cwd, env: caseEnv(base), stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
}

function repo(base, rel, { commit = true, remote = '' } = {}) {
  const dir = native(base, rel);
  fs.mkdirSync(dir, { recursive: true });
  gitRun(['init', '-q'], dir, base);
  if (remote) gitRun(['remote', 'add', 'origin', remote], dir, base);
  if (commit) gitRun(['commit', '-q', '--allow-empty', '-m', 'init'], dir, base);
  return dir;
}

export const REMOTE_URL = 'https://example.invalid/acme/widget.git';

export function buildLocationLayout(base) {
  for (const d of ['home', 'faketmp', 'plain', 'plain2', 'ws', 'wsid', 'ws2/plain']) fs.mkdirSync(native(base, d), { recursive: true });
  const main = repo(base, 'repo');
  fs.mkdirSync(path.join(main, 'sub'));
  gitRun(['worktree', 'add', '-q', '-b', 'wt', path.join(base, 'wt')], main, base);
  repo(base, 'remote-repo', { remote: REMOTE_URL });
  repo(base, 'modsrc');
  const sup = repo(base, 'super');
  gitRun(['submodule', 'add', '-q', path.join(base, 'modsrc'), 'mod'], sup, base);
  gitRun(['commit', '-q', '-m', 'add mod'], sup, base);
  repo(base, 'other');
  fs.writeFileSync(path.join(base, 'ws', '.omc-workspace'), '');
  repo(base, 'ws/child');
  fs.writeFileSync(path.join(base, 'wsid', '.omc-workspace'), JSON.stringify({ id: 'my team/ws' }));
  repo(base, 'wsid/child');
  fs.writeFileSync(path.join(base, 'ws2', '.omc-workspace'), '');
}

// [name, cwd (relative to base), workingDirectory (relative to base, or as given when it starts with ./), env extra]
const STATE = (base) => ({ OMC_STATE_DIR: path.join(base, 'state') });
export const LOCATION_CASES = [
  ['git-root', 'repo'],
  ['git-subdir-cwd', 'repo/sub'],
  ['git-wd-subdir', 'repo', 'repo/sub'],
  ['git-wd-relative', 'repo', './sub'],
  ['worktree-wd', 'repo', 'wt'],
  ['worktree-cwd', 'wt'],
  ['submodule-cwd', 'super/mod'],
  ['marker', 'ws/child'],
  ['marker-sensitive', 'ws/child', null, (base) => ({ TMPDIR: base, TEMP: base, TMP: base })],
  ['marker-disabled', 'ws/child', null, () => ({ OMC_DISABLE_MULTIREPO: '1' })],
  ['marker-non-git', 'ws2/plain'],
  ['non-git', 'plain'],
  ['state-remote', 'remote-repo', null, STATE],
  ['state-no-remote', 'repo', null, STATE],
  ['state-worktree', 'wt', null, STATE],
  ['state-submodule', 'super/mod', null, STATE],
  ['state-marker-id', 'wsid/child', null, STATE],
  ['state-marker-noid', 'ws/child', null, STATE],
  ['state-non-git', 'plain', null, STATE],
  ['foreign', 'repo', 'other'],
  ['outside-non-git', 'plain', 'plain2'],
  ['missing-wd', 'repo', 'repo/nope'],
];
// The folders whose absolute path OMC may hash into a project identifier.
// A submodule's origin is the absolute path it was added from (modsrc), which OMC hashes as a remote.
const HASHED = ['repo', 'super/mod', 'modsrc', 'ws', 'wt', 'remote-repo'];

const native = (base, rel) => path.join(base, ...rel.split('/'));
const sha16 = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
export const caseCwd = (base, c) => native(base, c[1]);
export const caseWd = (base, c) => (c[2] == null ? undefined : c[2].startsWith('./') ? c[2].slice(2) : native(base, c[2]));
export const caseExtraEnv = (base, c) => (c[3] ? c[3](base) : {});

/** An answer of `where` with the base folder and the path hashes put back as placeholders, separators as /. */
export function normalizeWhere(base, answer) {
  let text = JSON.stringify(answer);
  for (const rel of HASHED) text = text.split(sha16(native(base, rel))).join(`<sha16:${rel}>`);
  const json = (s) => JSON.stringify(s).slice(1, -1);
  text = text.split(json(base)).join('<BASE>');
  const out = JSON.parse(text);
  const slash = (s) => (process.platform === 'win32' ? s.replace(/\\/g, '/') : s);
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, slash(v)]));
}

// ============================================================================
// Running a case through one implementation
// ============================================================================

export const digest = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

/** A git project named proj (its name shows in some answers) for one scenario, with the base's home and temp. */
export function makeProject(base, name) {
  for (const d of ['home', 'faketmp']) fs.mkdirSync(native(base, d), { recursive: true });
  const dir = native(base, `${name}/proj`);
  fs.mkdirSync(dir, { recursive: true });
  gitRun(['init', '-q'], dir, base);
  return dir;
}

/** Run this module as a child (scenario, where or validate) and return its JSON. */
export function runChild(mode, impl, arg, { cwd, env }) {
  const args = [fileURLToPath(import.meta.url), mode, impl, ...(arg === undefined ? [] : [arg])];
  const run = spawnSync(process.execPath, args, { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0) throw new Error(`${mode} ${impl} ${arg ?? ''} failed (${run.status}): ${run.stderr}`);
  return JSON.parse(run.stdout);
}

async function loadImpl(impl) {
  if (impl === 'banker') {
    const w = await import(pathToFileURL(WIKI_MJS).href);
    return { call: (name, input) => { const r = w.runTool(name, input); return { text: r.text, isError: r.isError }; }, wikiDir: w.resolveWikiDir };
  }
  const dir = impl.replace(/^omc=/, '');
  const url = (rel) => pathToFileURL(path.join(dir, 'dist', ...rel.split('/'))).href;
  const tools = (await import(url('tools/wiki-tools.js'))).wikiTools;
  const wp = await import(url('lib/worktree-paths.js'));
  const storage = await import(url('hooks/wiki/storage.js'));
  const call = async (name, input) => {
    const r = await tools.find((t) => t.name === name).handler(input);
    return { text: r.content.map((c) => c.text).join('\n'), isError: Boolean(r.isError) };
  };
  const wikiDir = (wd) => {
    const r = wp.resolveWorkingDirectoryOrLinkedWorktree(wd);
    if (r.status !== 'foreign_repository') return storage.getWikiDir(r.root);
    const roots = wp.getCanonicalWorkingDirectoryRoots(r);
    throw new wp.ForeignWorkingDirectoryError(roots.providedRoot, roots.trustedRoot, r.callerLabel);
  };
  return { call, wikiDir, tools, dir };
}

function treeOf(dir, rel = '') {
  if (!fs.existsSync(dir)) return {};
  const out = {};
  for (const name of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    const key = rel ? `${rel}/${name}` : name;
    if (fs.statSync(p).isDirectory()) Object.assign(out, treeOf(p, key));
    else out[key] = fs.readFileSync(p, 'utf8');
  }
  return out;
}
const hashes = (tree) => Object.fromEntries(Object.entries(tree).map(([k, v]) => [k, digest(v)]));

async function runScenario(impl, name) {
  const { call } = await loadImpl(impl);
  const omc = path.join(process.cwd(), '.omc');
  const steps = [];
  for (const step of SCENARIOS[name]) {
    freezeClock(step.at);
    let result = null;
    if (step.seed) {
      fs.mkdirSync(path.join(omc, 'wiki'), { recursive: true });
      fs.writeFileSync(path.join(omc, 'wiki', step.seed), step.content);
    } else if (step.mkdir) {
      fs.mkdirSync(step.mkdir, { recursive: true });
    } else {
      result = await call(step.tool, step.input);
    }
    steps.push({ result, files: hashes(treeOf(omc)) });
  }
  return { steps, final: treeOf(omc) };
}

async function runWhere(impl, wd) {
  const { wikiDir } = await loadImpl(impl);
  try {
    return { dir: wikiDir(wd) };
  } catch (err) {
    return { error: err.message };
  }
}

async function runValidate(impl) {
  if (impl === 'banker') {
    const w = await import(pathToFileURL(WIKI_MJS).href);
    return VALIDATION.map(([tool, input]) => w.validateInput(tool, input) === null);
  }
  const { tools, dir } = await loadImpl(impl);
  const { z } = await import(pathToFileURL(path.join(dir, 'node_modules', 'zod', 'index.js')).href);
  return VALIDATION.map(([tool, input]) => z.object(tools.find((t) => t.name === tool).schema).safeParse(input).success);
}

async function main([mode, impl, arg]) {
  const runs = { scenario: () => runScenario(impl, arg), where: () => runWhere(impl, arg === undefined ? undefined : JSON.parse(arg)), validate: () => runValidate(impl) };
  if (!runs[mode] || !impl) throw new Error('usage: omc-wiki-cases.mjs scenario|where|validate <impl> [arg]');
  process.stdout.write(JSON.stringify(await runs[mode]()));
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`${err.stack || err}\n`);
    process.exitCode = 1;
  });
}
