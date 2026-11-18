#!/usr/bin/env node
/*
 * The cases skills/append_wiki/wiki.mjs --profile=omx is held to OMX 0.20.2 with, shared by the golden generator
 * (scripts/gen-omx-wiki-golden.mjs, which runs them through OMX's dist and its `omx wiki` CLI) and the test
 * (skills/append_wiki/wiki-omx.test.mjs, which runs them through wiki.mjs and compares with omx-wiki-0.20.2/).
 *
 * Run as a child process, so a frozen clock, a changed cwd or environment touch nothing else:
 *   node omx-wiki-cases.mjs scenario <impl> <name>   cwd: a project; prints {"steps":[..],"final":{..}}
 * <impl> is `banker` or `omx=<OMX package folder>`. The CLI cases (CLI_STEPS) run as real commands (runCli).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { digest, freezeClock } from './omc-wiki-cases.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const WIKI_MJS = path.join(HERE, '..', '..', 'skills', 'append_wiki', 'wiki.mjs');
export const FIXTURE_DIR = path.join(HERE, 'omx-wiki-0.20.2');

/** The OMX package to compare with live: BANKER_OMX_DIR, else the global npm install beside this node; or null. */
export function findOmxDir() {
  const prefix = path.dirname(path.dirname(process.execPath));
  const global = process.platform === 'win32'
    ? path.join(path.dirname(process.execPath), 'node_modules', 'oh-my-codex')
    : path.join(prefix, 'lib', 'node_modules', 'oh-my-codex');
  const dir = process.env.BANKER_OMX_DIR || global;
  return fs.existsSync(path.join(dir, 'dist', 'wiki', 'ingest.js')) ? dir : null;
}

const RealDate = globalThis.Date;
const hours = (n) => new RealDate(RealDate.UTC(2026, 0, 1) + n * 3600000).toISOString();
const DAY = 24;

// ============================================================================
// Scenarios. A step is a tool call, a seeded file (a path under the project), a folder made, a cwd change or an
// environment variable set (<PROJ> stands for the project folder). `deliberate` marks where wiki.mjs stops on purpose
// while OMX goes on: there it must answer an error starting with that text and change no file.
// ============================================================================

const call = (at, tool, input = {}) => ({ at: hours(at), tool, input });
const seed = (at, file, content) => ({ at: hours(at), seed: file, content });
const ingest = (at, title, extra = {}) => call(at, 'wiki_ingest', { title, content: `${title} body.`, tags: [], category: 'reference', ...extra });

const page = (fm, body) => ['---', ...fm, '---', '', body, ''].join('\n');
const CRLF_PAGE = page(['title: "Legacy CRLF"', 'tags: [old, "two, parts"]', 'created: 2025-12-01T00:00:00.000Z',
  'updated: 2025-12-01T00:00:00.000Z', 'sources: []', 'links: []', 'category: reference', 'confidence: low', 'schemaVersion: 1'],
'# Legacy CRLF\n\nOld body.').replace(/\n/g, '\r\n');
const QUOTED_ITEMS = page(["title: 'Quoted ''Items'''", "tags: [x, 'y z']", 'sources: ["a, b", \'it\'\'s\', "c\\"d"]', 'links: []',
  'category: pattern', 'confidence: high'], '# Quoted\n\nSeeded without created, updated or schemaVersion.');
const BOM_PAGE = `\uFEFF${page(['title: "Bom Page"', 'tags: []', 'created: 2026-01-01T00:00:00.000Z', 'updated: 2026-01-01T00:00:00.000Z',
  'sources: []', 'links: []', 'category: reference', 'confidence: medium', 'schemaVersion: 1'], '# Bom Page\n\nA BOM in front.')}`;
const FUTURE = page(['title: "Future"', 'tags: []', 'created: 2026-01-01T00:00:00.000Z', 'updated: 2026-01-01T00:00:00.000Z',
  'sources: []', 'links: []', 'category: reference', 'confidence: medium', 'schemaVersion: 2'], '# Future\n\nv2 body.');
const OLD_PAGE = page(['title: "Old Wiki Page"', 'tags: [legacy]', 'created: 2025-06-01T00:00:00.000Z', 'updated: 2025-06-01T00:00:00.000Z',
  'sources: []', 'links: ["missing.md"]', 'category: pattern', 'confidence: low', 'schemaVersion: 1'], '# Old Wiki Page\n\nKept in the legacy folder.');
const OLD_INDEX = '# Wiki Index\n\n> 1 pages | Last updated: 2025-06-01T00:00:00.000Z\n\n## pattern\n\n- [Old Wiki Page](old-wiki-page.md) \u2014 # Old Wiki Page\n';
const LONG_FIRST_LINE = 'This first line is deliberately longer than eighty characters so the index summary gets cut short.';

const MAIN = [
  call(0, 'wiki_list'),
  call(1, 'wiki_query', { query: 'anything' }),
  call(2, 'wiki_lint'),
  ingest(3, 'Auth Architecture', {
    content: `${LONG_FIRST_LINE}\n\nTokens live in [[Session Store]], see [[Session Store|the store]] and [[Token#Refresh]].\n- step one`,
    tags: ['auth', 'Auth', 'login', 'auth'], category: 'architecture', sources: ['src/auth.ts', 'notes, "quoted"'], confidence: 'high',
  }),
  ingest(4, 'Auth Architecture', {
    content: 'Second pass: refresh rotates. See [[Login Flow]].', tags: ['login', 'jwt'], category: 'debugging',
    sources: ['src/auth.ts', 'docs/auth.md'], confidence: 'low',
  }),
  ingest(5, 'Session Store', { content: 'Backed by redis. Links back to [[Auth Architecture]].', tags: ['auth', 'cache'], category: 'pattern' }),
  { at: hours(6), mkdir: 'sub' },
  ingest(7, 'Login Flow', { content: 'Login goes through the flow.', tags: ['flow'], category: 'decision', workingDirectory: 'sub' }),
  call(7, 'wiki_read', { page: 'login-flow', workingDirectory: '  sub  ' }),
  call(7, 'wiki_read', { page: 'login-flow' }),
  { at: hours(7), mkdir: 'deep/er' },
  { at: hours(7), chdir: 'deep/er' },
  ingest(7, 'From Deep Folder'),
  { at: hours(7), chdir: '.' },
  call(7, 'wiki_list', { workingDirectory: 'bad\u0000dir' }),
  ingest(8, '한글 제목', { content: '한글 본문입니다. [[한글 링크 페이지]] 검색 테스트.', tags: ['한글', '위키'], category: 'convention' }),
  ingest(9, '한글 링크 페이지', { content: '링크 대상. [[한글 제목]] 과 [[Auth Architecture]].', tags: ['한글'] }),
  ingest(10, 'Mixed 한글 Title: 2026년 계획!'),
  ingest(11, 'Cafe\u0301 \u00DCBER Stra\u00DFe \u0663\u0664'),
  ingest(12, '\u{1F600}\u{1F680}'),
  ingest(13, '---'),
  ingest(14, '\uAC00'.repeat(70)),
  ingest(15, 'Claude Code Context Usage Signals And Compaction Automation Ceiling Extra Words'),
  ingest(16, 'Quote "and" back\\slash\nline two', { tags: ['odd "tag"', 'comma, tag'] }),
  ingest(17, 'Quote "and" back\\slash\nline two', { content: 'Merged: the comma tag splits on reading.', tags: ['new'] }),
  seed(18, 'omx_wiki/legacy-crlf.md', CRLF_PAGE),
  ingest(19, 'Legacy CRLF', { content: 'New body after CRLF.', tags: ['new'] }),
  seed(20, 'omx_wiki/quoted-items.md', QUOTED_ITEMS),
  call(20, 'wiki_read', { page: 'quoted-items' }),
  ingest(21, 'Quoted Items', { content: 'Merged into the quoted page.', tags: ['y z', 'w'], sources: ['c"d', 'e'], confidence: 'medium' }),
  seed(22, 'omx_wiki/bom-page.md', BOM_PAGE),
  call(22, 'wiki_read', { page: 'bom-page' }),
  ingest(23, 'Conf Medium'),
  ingest(24, 'Conf Medium', { confidence: 'high' }),
  ingest(25, 'Conf Medium'),
  ingest(26, 'Conf Low', { confidence: 'low' }),
  ingest(27, 'Conf Low', { confidence: 'medium' }),
  call(28, 'wiki_add', { title: 'Quick Note', content: 'Quick body.' }),
  call(29, 'wiki_add', { title: 'Quick Note', content: 'Again.' }),
  call(30, 'wiki_add', { title: '빠른 메모', content: '한글 메모.', tags: ['t1'], category: 'environment' }),
  ingest(31, 'Index'),
  ingest(32, 'environment'),
  call(33, 'wiki_read', { page: 'auth-architecture' }),
  call(33, 'wiki_read', { page: '한글-제목.md' }),
  call(33, 'wiki_read', { page: 'nope' }),
  call(33, 'wiki_read', { page: '../secret' }),
  call(33, 'wiki_read', { page: 'legacy-crlf' }),
  call(33, 'wiki_read', { page: 'index' }),
  call(34, 'wiki_query', { query: 'auth' }),
  call(35, 'wiki_query', { query: 'session store' }),
  call(36, 'wiki_query', { query: '' }),
  call(37, 'wiki_query', { query: 'flow', tags: ['JWT', 'flow'] }),
  call(38, 'wiki_query', { query: '한글' }),
  call(39, 'wiki_query', { query: '검색' }),
  call(40, 'wiki_query', { query: 'auth', category: 'pattern' }),
  call(41, 'wiki_query', { query: 'auth', limit: 1 }),
  call(42, 'wiki_query', { query: 'zzzz' }),
  call(43, 'wiki_query', { query: 'Привет мир' }),
  call(44, 'wiki_list'),
  ingest(45, 'Big Page', { content: 'x'.repeat(10300) }),
  ingest(46, 'Edge Page', { content: 'y'.repeat(10240 - '\n# Edge Page\n\n\n'.length) }),
  ingest(47, '\uD55C'.repeat(200), {
    content: 'm'.repeat(50000), tags: Array.from({ length: 20 }, (_, i) => `tag${i}`.padEnd(50, 'z')),
    sources: Array.from({ length: 10 }, (_, i) => `src${i}`.padEnd(100, 's')), category: 'decision',
  }),
  ingest(48, 'Cache Layer Alpha', { tags: ['shared'], category: 'architecture', confidence: 'high' }),
  ingest(49, 'Cache Layer Beta', { tags: ['shared'], category: 'pattern', confidence: 'low' }),
  call(50, 'wiki_delete', { page: 'quick-note' }),
  call(51, 'wiki_delete', { page: 'quick-note.md' }),
  call(52, 'wiki_delete', { page: '../outside' }),
  call(53, 'wiki_delete', { page: 'index' }),
  call(54, 'wiki_delete', { page: 'log.md' }),
  ingest(74 * DAY, 'Fresh Page', { content: 'Updated a day before the lint. [[Auth Architecture]]' }),
  call(75 * DAY, 'wiki_lint'),
  call(75 * DAY + 1, 'wiki_list'),
];

export const SCENARIOS = {
  main: MAIN,
  // The old project-local .omx/wiki: read while omx_wiki/ is missing, with no log entry for a query or lint; the
  // first write makes omx_wiki/, which every call reads from then on.
  legacy: [
    seed(0, '.omx/wiki/old-wiki-page.md', OLD_PAGE),
    seed(0, '.omx/wiki/index.md', OLD_INDEX),
    call(1, 'wiki_list'),
    call(2, 'wiki_read', { page: 'old-wiki-page' }),
    call(3, 'wiki_query', { query: 'legacy' }),
    call(4, 'wiki_lint'),
    call(5, 'wiki_delete', { page: 'old-wiki-page' }),
    ingest(6, 'Old Wiki Page', { content: 'Written to omx_wiki, not merged into the legacy page.' }),
    call(7, 'wiki_list'),
    call(8, 'wiki_query', { query: 'legacy' }),
  ],
  'empty-delete': [call(0, 'wiki_delete', { page: 'anything' }), call(1, 'wiki_read', { page: 'anything' })],
  'reserved-ingest-first': [ingest(0, 'Log'), call(1, 'wiki_list')],
  allowlist: [
    { at: hours(0), mkdir: 'allowed' },
    { at: hours(0), env: { OMX_MCP_WORKDIR_ROOTS: '<PROJ>/allowed' } },
    ingest(1, 'Allowed Page', { workingDirectory: 'allowed' }),
    ingest(2, 'Outside Page'),
    call(3, 'wiki_list', { workingDirectory: 'allowed/not-made-yet' }),
    call(4, 'wiki_list', { workingDirectory: 'elsewhere/deeper' }),
  ],
  'unparsable-ingest': [
    seed(0, 'omx_wiki/bom-page.md', BOM_PAGE),
    { ...ingest(1, 'Bom Page'), deliberate: 'Existing wiki page bom-page.md has no readable frontmatter' },
  ],
  'unparsable-add': [
    seed(0, 'omx_wiki/broken-page.md', 'Just text, no frontmatter.\n'),
    { ...call(1, 'wiki_add', { title: 'Broken Page', content: 'New.' }), deliberate: 'Existing wiki page broken-page.md has no readable frontmatter' },
  ],
  'schema-v2': [
    seed(0, 'omx_wiki/future.md', FUTURE),
    { ...ingest(1, 'Future'), deliberate: 'Wiki page future.md has schemaVersion 2' },
    { ...ingest(2, 'Other'), deliberate: 'Wiki page future.md has schemaVersion 2' },
    { ...call(3, 'wiki_delete', { page: 'future' }), deliberate: 'Wiki page future.md has schemaVersion 2' },
  ],
  'invalid-input': [
    { ...ingest(0, 'x'.repeat(201)), deliberate: 'invalid input: title must be at most 200 characters' },
    { ...call(1, 'wiki_query', { query: 'x', limit: 0 }), deliberate: 'invalid input: limit must be an integer from 1 to 50' },
  ],
};

// ============================================================================
// CLI cases: whole commands, as a Codex session runs them (`omx wiki <args>` or `node wiki.mjs <args> --profile=omx`),
// compared by stdout and exit status with every ISO time put back as <time>.
// ============================================================================

const ING = JSON.stringify({ title: '한글 CLI Page', content: '본문 "따옴표" \\ 역슬래시\n줄 %TEMP% & !', tags: ['한글'], category: 'pattern' });
export const CLI_STEPS = [
  ['wiki_list', '--json'],
  ['list'],
  ['wiki_ingest', '--input', ING, '--json'],
  ['ingest', '--input', ING],
  ['wiki_read', '--input', '{"page":"한글-cli-page"}', '--json'],
  ['read', '--input', '{"page":"nope"}'],
  ['read', '--input', '{"page":"nope"}', '--json'],
  ['wiki_query', '--input', '{"query":"따옴표"}'],
  ['wiki_lint', '--input', '{}', '--json'],
  ['delete', '--input', '{"page":"index"}', '--json'],
  ['wiki_delete', '--input', '{"page":"한글-cli-page"}', '--json'],
];

const ISO = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g;

/** Run CLI_STEPS with `<node> <...prefix> <step args> <...suffix>` in cwd; [{ stdout, status }], times as <time>. */
export function runCli(prefix, suffix, { cwd, env }) {
  return CLI_STEPS.map((args) => {
    const run = spawnSync(process.execPath, [...prefix, ...args, ...suffix], { cwd, env, encoding: 'utf8' });
    return { stdout: run.stdout.replace(ISO, '<time>'), status: run.status };
  });
}

// ============================================================================
// Running a scenario through one implementation
// ============================================================================

// Every file under dir (but .git) by its path, and every folder as `<path>/`, so an empty omx_wiki/ shows too.
function treeOf(dir, rel = '') {
  const out = {};
  for (const name of fs.readdirSync(dir).sort()) {
    if (!rel && name === '.git') continue;
    const p = path.join(dir, name);
    const key = rel ? `${rel}/${name}` : name;
    if (fs.statSync(p).isDirectory()) Object.assign(out, { [`${key}/`]: '' }, treeOf(p, key));
    else out[key] = fs.readFileSync(p, 'utf8');
  }
  return out;
}
const hashes = (tree) => Object.fromEntries(Object.entries(tree).map(([k, v]) => [k, digest(v)]));

// An answer with the project folder as <PROJ> (and / for \ on Windows); a long one as its digest.
function normalizeAnswer(json, proj) {
  let text = json.split(JSON.stringify(proj).slice(1, -1)).join('<PROJ>');
  if (process.platform === 'win32') text = text.replace(/<PROJ>((?:\\\\[^"\\]*)*)/g, (m) => m.replace(/\\\\/g, '/'));
  return text.length > 4000 ? `sha:${digest(text)}` : text;
}

async function loadImpl(impl) {
  if (impl === 'banker') {
    const w = await import(pathToFileURL(WIKI_MJS).href);
    return (name, input) => {
      const r = w.runTool(name, input, 'omx');
      return { json: JSON.stringify(r.data), isError: r.isError, pretty: r.text === JSON.stringify(r.data, null, 2) };
    };
  }
  const dir = impl.replace(/^omx=/, '');
  const { executeMcpParityCommand } = await import(pathToFileURL(path.join(dir, 'dist', 'cli', 'mcp-parity.js')).href);
  return async (name, input) => {
    const r = await executeMcpParityCommand('wiki', [name, '--input', JSON.stringify(input), '--json']);
    return { json: JSON.stringify('data' in r ? r.data : r.error), isError: !r.ok, pretty: true };
  };
}

function applyStep(step, proj) {
  if (step.seed) {
    const file = path.join(proj, ...step.seed.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, step.content);
  } else if (step.mkdir) {
    fs.mkdirSync(path.join(proj, ...step.mkdir.split('/')), { recursive: true });
  } else if (step.chdir) {
    process.chdir(path.join(proj, ...step.chdir.split('/')));
  } else if (step.env) {
    for (const [k, v] of Object.entries(step.env)) process.env[k] = path.normalize(v.split('<PROJ>').join(proj));
  }
}

async function runScenario(impl, name) {
  const call = await loadImpl(impl);
  const proj = process.cwd();
  const steps = [];
  for (const step of SCENARIOS[name]) {
    freezeClock(step.at);
    let result = null;
    if (step.tool) {
      const r = await call(step.tool, step.input);
      result = { json: normalizeAnswer(r.json, proj), isError: r.isError, pretty: r.pretty };
    } else {
      applyStep(step, proj);
    }
    steps.push({ result, files: hashes(treeOf(proj)) });
  }
  return { steps, final: treeOf(proj) };
}

/** Run one scenario in a child of this module and return its JSON. */
export function runScenarioChild(impl, name, { cwd, env }) {
  const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'scenario', impl, name], { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0) throw new Error(`scenario ${impl} ${name} failed (${run.status}): ${run.stderr}`);
  return JSON.parse(run.stdout);
}

async function main([mode, impl, arg]) {
  if (mode !== 'scenario' || !impl || !SCENARIOS[arg]) throw new Error('usage: omx-wiki-cases.mjs scenario <impl> <name>');
  process.stdout.write(JSON.stringify(await runScenario(impl, arg)));
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`${err.stack || err}\n`);
    process.exitCode = 1;
  });
}
