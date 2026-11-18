#!/usr/bin/env node
/*
 * Tests for wiki.mjs, the OMC-free wiki fallback. Run: `node --test skills/append_wiki/wiki.test.mjs`
 * Zero deps: node:test + node:assert only. Every case runs in a temp folder with its own git project, HOME and temp,
 * never in the real ~/.claude, ~/.omc or this repo's .omc/wiki.
 *
 * Parity with OMC 5.8.4 is checked against the fixtures in scripts/test-fixtures/omc-wiki-5.8.4/, which
 * scripts/gen-omc-wiki-golden.mjs wrote from OMC's own dist, so these tests need no OMC installed.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  FIXTURE_DIR, LOCATION_CASES, SCENARIOS, VALIDATION, buildLocationLayout, caseCwd, caseEnv, caseExtraEnv, caseWd,
  digest, makeBase, makeProject, normalizeWhere, runChild,
} from '../../scripts/test-fixtures/omc-wiki-cases.mjs';
import { parseFrontmatter, refuseDeviceName, serializePage, titleToSlug, tokenize, validateInput } from './wiki.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WIKI = path.join(HERE, 'wiki.mjs');
const REPO = path.join(HERE, '..', '..');
const HOOK = path.join(REPO, 'hooks', 'obsidize-hook.mjs');
const OBSIDIZE = path.join(REPO, 'skills', 'obsidizer', 'obsidize.mjs');
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8'));

const bases = [];
after(() => { for (const b of bases) fs.rmSync(b, { recursive: true, force: true }); });
function freshBase() {
  const base = makeBase('banker-wikitest-');
  bases.push(base);
  return base;
}

// A git project with the wiki CLI bound to it.
function project(name = 'p') {
  const base = freshBase();
  const cwd = makeProject(base, name);
  const env = caseEnv(base);
  const cli = (args, opts = {}) => spawnSync(process.execPath, [WIKI, ...args], { cwd, env, encoding: 'utf8', ...opts });
  const wikiDir = path.join(cwd, '.omc', 'wiki');
  return { base, cwd, env, cli, wikiDir, page: (f) => fs.readFileSync(path.join(wikiDir, f), 'utf8') };
}

const ingestArgs = (input) => ['wiki_ingest', '--input', JSON.stringify({ tags: [], category: 'reference', ...input })];

// ============================================================================
// Golden parity with OMC 5.8.4
// ============================================================================

const golden = fixture('golden.json');

for (const [name, steps] of Object.entries(SCENARIOS)) {
  test(`golden ${name}: every answer and every file byte matches OMC 5.8.4 (deliberate stops excepted)`, () => {
    const gold = golden.scenarios[name];
    assert.equal(gold.digest, digest(steps), 'the scenario changed since the fixture was written: rerun scripts/gen-omc-wiki-golden.mjs');
    const base = freshBase();
    const ours = runChild('scenario', 'banker', name, { cwd: makeProject(base, name), env: caseEnv(base) });
    steps.forEach((step, i) => {
      const where = `${name} step ${i} (${step.tool || (step.seed ? `seed ${step.seed}` : 'mkdir')})`;
      if (!step.deliberate) {
        assert.deepEqual(ours.steps[i].result, gold.steps[i].result, `${where}: answer`);
        assert.deepEqual(ours.steps[i].files, gold.steps[i].files, `${where}: files`);
        return;
      }
      assert.equal(gold.steps[i].result.isError, false, `${where}: OMC went on here (the difference is real)`);
      assert.equal(ours.steps[i].result.isError, true, `${where}: wiki.mjs stops`);
      assert.ok(ours.steps[i].result.text.startsWith(step.deliberate), `${where}: ${ours.steps[i].result.text}`);
      assert.deepEqual(ours.steps[i].files, ours.steps[i - 1].files, `${where}: no file changed`);
    });
    if (!steps.some((s) => s.deliberate)) assert.deepEqual(ours.final, gold.final, `${name}: final wiki bytes`);
  });
}

test('golden fixture covers what it claims: reserved names, slugs, merge rules, CRLF and BOM, lint kinds', () => {
  const texts = golden.scenarios.main.steps.map((s) => s.result?.text || '').join('\n');
  const final = golden.scenarios.main.final;
  for (const want of ['Cannot write to reserved wiki file: index.md', 'already exists. Use wiki_ingest', 'no issues found',
    '[WARNING] stale', '[WARNING] oversized', '[ERROR] broken-ref', '[INFO] orphan', '[INFO] low-confidence',
    '[WARNING] structural-contradiction', '[INFO] structural-contradiction', 'No wiki pages match']) {
    assert.ok(texts.includes(want), `golden has ${want}`);
  }
  for (const f of ['wiki/page-0dd0c789.md', 'wiki/claude-code-context-usage-signals-and-compaction-automation-ceil.md',
    'wiki/legacy-crlf.md', 'wiki/quoted-items.md', 'wiki/index.md', 'wiki/log.md', '.gitignore']) assert.ok(f in final, f);
  assert.ok(!texts.includes('Big Page" is 10.0KB') && texts.includes('"Big Page" is 10.1KB'), 'oversized boundary');
  assert.ok(!/Edge Page" is/.test(texts), 'a page of exactly 10,240 bytes is not oversized');
  assert.ok(!final['wiki/legacy-crlf.md'].includes('\r') && !final['wiki/legacy-crlf.md'].startsWith('\uFEFF'), 'merged CRLF page is LF');
});

test('helpers agree with OMC on slugs, tokens and a frontmatter round trip', () => {
  assert.equal(titleToSlug('한글 제목'), 'page-0dd0c789.md');
  assert.equal(titleToSlug('ThreadPool Deadlock: Acquire-Before-Pool!'), 'threadpool-deadlock-acquire-before-pool.md');
  assert.deepEqual(tokenize('Auth 한글'), ['auth', '한', '글', '한글']);
  const page = { filename: 'x.md', frontmatter: { title: 'a "q" \\ b\nc', tags: ['t, u'], created: 'C', updated: 'U', sources: [],
    links: ['y.md'], category: 'pattern', confidence: 'low', schemaVersion: 1 }, content: '\n# x\n' };
  assert.deepEqual(parseFrontmatter(serializePage(page)), { frontmatter: page.frontmatter, content: page.content });
});

// ============================================================================
// Storage location
// ============================================================================

test('storage location: each layout resolves to the folder OMC 5.8.4 picks, and the same refusals', () => {
  const want = fixture('locations.json').cases;
  const base = path.join(freshBase(), 'loc');
  fs.mkdirSync(base);
  buildLocationLayout(base);
  assert.equal(want.length, LOCATION_CASES.length, 'fixture and cases agree');
  for (const c of LOCATION_CASES) {
    const wd = caseWd(base, c);
    const answer = runChild('where', 'banker', wd === undefined ? undefined : JSON.stringify(wd),
      { cwd: caseCwd(base, c), env: caseEnv(base, caseExtraEnv(base, c)) });
    const { name, ...expected } = want.find((x) => x.name === c[0]);
    assert.deepEqual(normalizeWhere(base, answer), expected, name);
  }
});

test('a folder outside git writes to $HOME/.omc/wiki, never to a .omc in that folder', () => {
  const base = freshBase();
  const plain = path.join(base, 'plain');
  fs.mkdirSync(plain);
  const env = caseEnv(base);
  fs.mkdirSync(env.HOME, { recursive: true });
  const run = spawnSync(process.execPath, [WIKI, ...ingestArgs({ title: 'Loose', content: 'x' })], { cwd: plain, env, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(fs.existsSync(path.join(env.HOME, '.omc', 'wiki', 'loose.md')));
  assert.ok(!fs.existsSync(path.join(plain, '.omc')));
});

// ============================================================================
// Input validation
// ============================================================================

test('input validation accepts and rejects exactly what the tools\' zod schemas do', () => {
  const want = fixture('validation.json');
  assert.equal(want.digest, digest(VALIDATION), 'validation cases changed since the fixture was written');
  VALIDATION.forEach(([tool, input], i) => {
    const why = validateInput(tool, input);
    assert.equal(why === null, want.ok[i], `case ${i} ${tool}: ${why}`);
  });
});

// remains 0.29.0 #9: a slug that is a Windows device name (con.md, nul.md, com1.md) is refused before anything is
// read or written; the slug's shape stays OMC's.
test('a title or page whose file name would be a Windows device name is refused, and nothing is written', () => {
  assert.equal(titleToSlug('Con'), 'con.md', 'the slug keeps the OMC shape');
  assert.throws(() => refuseDeviceName('con.md.md'), /would be a Windows device name/, 'a device name before any extension is one');
  assert.equal(refuseDeviceName('console.md'), 'console.md');
  const p = project();
  for (const title of ['Con', 'NUL', 'com1', 'Lpt9', 'aux', 'PRN']) {
    for (const tool of ['wiki_ingest', 'wiki_add']) {
      const run = p.cli([tool, '--input', JSON.stringify({ tags: [], category: 'reference', title, content: 'c' })]);
      assert.equal(run.status, 1, `${tool} ${title}: ${run.stdout}${run.stderr}`);
      assert.match(run.stdout, /would be a Windows device name/, `${tool} ${title}`);
    }
  }
  assert.ok(!fs.existsSync(path.join(p.cwd, '.omc')), 'nothing written, not even the wiki folder');
  for (const tool of ['wiki_read', 'wiki_delete']) {
    const run = p.cli([tool, '--input', JSON.stringify({ page: 'com1.md' })]);
    assert.equal(run.status, 1, `${tool}: ${run.stdout}${run.stderr}`);
    assert.match(run.stdout, /com1\.md would be a Windows device name/, tool);
  }
  for (const title of ['Console', 'Null Pointer', 'COM10', 'Auxiliary']) assert.equal(p.cli(ingestArgs({ title, content: 'c' })).status, 0, title);
});

test('a rejected input exits 1, says why, and creates nothing', () => {
  const p = project();
  const run = p.cli(ingestArgs({ title: 'x'.repeat(201), content: 'c' }));
  assert.equal(run.status, 1);
  assert.equal(run.stdout, 'Error ingesting into wiki: invalid input: title must be at most 200 characters\n');
  assert.ok(!fs.existsSync(path.join(p.cwd, '.omc')));
  const json = p.cli(['wiki_query', '--input', '{"query":"x","limit":0}', '--json']);
  assert.equal(json.status, 1);
  assert.deepEqual(JSON.parse(json.stdout), { error: 'Error querying wiki: invalid input: limit must be an integer from 1 to 50' });
});

// ============================================================================
// CLI
// ============================================================================

test('CLI: --input-file with a BOM and Korean round-trips; --json gives the OMX shapes; the wiki_ prefix is optional', () => {
  const p = project();
  const file = path.join(p.base, 'in.json');
  fs.writeFileSync(file, `\uFEFF${JSON.stringify({ title: 'Korean Body', content: '한글 "따옴표" \\ 역슬래시\n줄바꿈 %TEMP% & !', tags: ['한글'], category: 'pattern' })}`);
  const ing = p.cli(['ingest', '--input-file', file, '--json']);
  assert.equal(ing.status, 0, ing.stderr);
  assert.deepEqual(JSON.parse(ing.stdout), { created: ['korean-body.md'], updated: [], totalAffected: 1 });
  assert.ok(p.page('korean-body.md').includes('한글 "따옴표" \\ 역슬래시\n줄바꿈 %TEMP% & !'));
  const read = JSON.parse(p.cli(['wiki_read', '--input', '{"page":"korean-body"}', '--json']).stdout);
  assert.equal(read.filename, 'korean-body.md');
  assert.deepEqual(read.frontmatter.tags, ['한글']);
  const list = JSON.parse(p.cli(['list', '--json']).stdout);
  assert.deepEqual(list.pages, ['korean-body.md']);
  assert.ok(list.index.startsWith('# Wiki Index'));
  const lint = JSON.parse(p.cli(['lint', '--json']).stdout);
  assert.equal(lint.stats.totalPages, 1);
  const del = p.cli(['delete', '--input', '{"page":"korean-body"}', '--json']);
  assert.deepEqual(JSON.parse(del.stdout), { deleted: true, page: 'korean-body.md' });
  const miss = p.cli(['wiki_read', '--input', '{"page":"korean-body"}', '--json']);
  assert.equal(miss.status, 1);
  assert.deepEqual(JSON.parse(miss.stdout), { error: 'Wiki page not found: korean-body.md' });
});

test('CLI: usage errors exit 2 and touch nothing; --help exits 0', () => {
  const p = project();
  const bad = [[], ['wiki_nope'], ['wiki_list', '--bogus'], ['wiki_list', 'extra'], ['wiki_ingest', '--input', '{oops'],
    ['wiki_ingest', '--input', '[]'], ['wiki_list', '--input', '{}', '--input', '{}'], ['wiki_list', '--input'],
    ['wiki_list', '--profile=bogus'], ['wiki_list', '--input-file', path.join(p.base, 'missing.json')]];
  for (const args of bad) {
    const run = p.cli(args);
    assert.equal(run.status, 2, `${args.join(' ')}: ${run.stdout}${run.stderr}`);
    assert.ok(run.stderr.length > 0, args.join(' '));
  }
  assert.ok(!fs.existsSync(path.join(p.cwd, '.omc')));
  const help = p.cli(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /usage: node wiki\.mjs <tool>/);
});

test('CLI: a workingDirectory in another repository is refused with OMC\'s words and exit 1', () => {
  const p = project();
  const other = makeProject(p.base, 'other');
  const run = p.cli(['wiki_lint', '--input', JSON.stringify({ workingDirectory: other })]);
  assert.equal(run.status, 1);
  assert.match(run.stdout, /^Error linting wiki: workingDirectory '.*' belongs to a different repository than 'proj' and was not used\./);
  assert.ok(!fs.existsSync(path.join(other, '.omc')) && !fs.existsSync(path.join(p.cwd, '.omc')));
});

// ============================================================================
// The lock: two writers, OMC's lock protocol, stale and live locks
// ============================================================================

const WORKER = `
const w = await import(process.argv[1]);
const [id, n] = [process.argv[2], Number(process.argv[3])];
for (let i = 0; i < n; i++) {
  const r = w.runTool('wiki_ingest', { title: 'Shared Page', content: 'marker-' + id + '-' + i, tags: [id], category: 'pattern' });
  if (r.isError) { console.error(r.text); process.exit(1); }
}`;

// A writer that keeps OMC's lock protocol (src/lib/file-lock.ts) and appends to log.md under it, as OMC's query does.
const OMC_STYLE_WRITER = `
const fs = await import('node:fs');
const path = await import('node:path');
const [wiki, n] = [process.argv[1], Number(process.argv[2])];
const lock = path.join(wiki, '.wiki-lock.lock');
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
for (let i = 0; i < n; i++) {
  let fd;
  for (;;) {
    try { fd = fs.openSync(lock, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600); break; }
    catch (e) { if (e.code !== 'EEXIST') throw e; sleep(5); }
  }
  fs.writeSync(fd, JSON.stringify({ pid: process.pid, timestamp: Date.now() }));
  const log = path.join(wiki, 'log.md');
  const old = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '# Wiki Log\\n\\n';
  sleep(4);
  const tmp = path.join(wiki, '.log.md.tmp.omc-' + i);
  fs.writeFileSync(tmp, old + '## [x] omc-style-' + i + '\\n\\n', { mode: 0o600 });
  fs.renameSync(tmp, log);
  fs.closeSync(fd);
  fs.unlinkSync(lock);
  sleep(1);
}`;

function startNode(code, args, opts) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, ...args], { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', (status) => resolve({ status, err }));
  });
}

function leftovers(wikiDir) {
  return fs.readdirSync(wikiDir).filter((f) => f === '.wiki-lock.lock' || /\.tmp\./.test(f) || /\.rollback\./.test(f));
}

test('two writers at once lose no update: every Update section and log entry is there, no lock or temp file left', async () => {
  const p = project();
  const n = 12;
  const url = pathToFileURL(WIKI).href;
  const runs = await Promise.all(['a', 'b'].map((id) => startNode(WORKER, [url, id, String(n)], { cwd: p.cwd, env: p.env })));
  for (const r of runs) assert.equal(r.status, 0, r.err);
  const page = p.page('shared-page.md');
  for (const id of ['a', 'b']) for (let i = 0; i < n; i++) assert.ok(page.includes(`marker-${id}-${i}\n`), `marker-${id}-${i}`);
  assert.equal((page.match(/^## Update \(/gm) || []).length, 2 * n - 1);
  assert.equal((p.page('log.md').match(/\] ingest\n/g) || []).length, 2 * n);
  assert.deepEqual(parseFrontmatter(page).frontmatter.tags, page.indexOf('marker-a-0') < page.indexOf('marker-b-0') ? ['a', 'b'] : ['b', 'a']);
  assert.deepEqual(leftovers(p.wikiDir), []);
});

test('wiki.mjs and a writer keeping OMC\'s lock interleave on one wiki without losing a log entry', async () => {
  const p = project();
  assert.equal(p.cli(ingestArgs({ title: 'Seed', content: 'seed' })).status, 0);
  const n = 25;
  const [ours, theirs] = await Promise.all([
    startNode(WORKER, [pathToFileURL(WIKI).href, 'w', String(n)], { cwd: p.cwd, env: p.env }),
    startNode(OMC_STYLE_WRITER, [p.wikiDir, String(4 * n)], { cwd: p.cwd, env: p.env }),
  ]);
  assert.equal(ours.status, 0, ours.err);
  assert.equal(theirs.status, 0, theirs.err);
  const log = p.page('log.md');
  for (let i = 0; i < 4 * n; i++) assert.ok(log.includes(`omc-style-${i}\n`), `omc-style-${i}`);
  assert.equal((log.match(/\] ingest\n/g) || []).length, n + 1);
  assert.deepEqual(leftovers(p.wikiDir), []);
});

function holdLock(wikiDir, ms) {
  const code = `
const fs = await import('node:fs');
const lock = process.argv[1];
const fd = fs.openSync(lock, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
fs.writeSync(fd, JSON.stringify({ pid: process.pid, timestamp: Date.now() }));
process.stdout.write('held\\n');
setTimeout(() => { fs.closeSync(fd); fs.unlinkSync(lock); process.stdout.write('released ' + Date.now() + '\\n'); }, Number(process.argv[2]));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, path.join(wikiDir, '.wiki-lock.lock'), String(ms)]);
  let out = '';
  const held = new Promise((resolve) => child.stdout.on('data', (d) => { out += d; if (out.includes('held')) resolve(); }));
  const done = new Promise((resolve) => child.on('exit', () => resolve(Number((/released (\d+)/.exec(out) || [])[1]))));
  return { held, done };
}

test('a held lock makes a write wait, then go on once it is released', async () => {
  const p = project();
  assert.equal(p.cli(ingestArgs({ title: 'Seed', content: 'seed' })).status, 0);
  const holder = holdLock(p.wikiDir, 700);
  await holder.held;
  const run = await new Promise((resolve) => {
    const child = spawn(process.execPath, [WIKI, ...ingestArgs({ title: 'After Wait', content: 'x' })], { cwd: p.cwd, env: p.env });
    child.on('exit', (status) => resolve({ status, at: Date.now() }));
  });
  const releasedAt = await holder.done;
  assert.equal(run.status, 0);
  assert.ok(run.at >= releasedAt, 'the write finished after the release');
  assert.ok(p.page('after-wait.md').includes('# After Wait'));
});

function plantLock(wikiDir, pid, ageMs) {
  const lock = path.join(wikiDir, '.wiki-lock.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid, timestamp: Date.now() - ageMs }));
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(lock, t, t);
  return lock;
}

test('a lock over 30 s old whose pid is dead is reaped; one held by a live pid stops the write after 5 s', () => {
  const p = project();
  assert.equal(p.cli(ingestArgs({ title: 'Seed', content: 'seed' })).status, 0);
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  plantLock(p.wikiDir, Number(dead.stdout), 60000);
  const reaped = p.cli(ingestArgs({ title: 'Reaped', content: 'x' }));
  assert.equal(reaped.status, 0, reaped.stdout);
  assert.deepEqual(leftovers(p.wikiDir), []);
  const lock = plantLock(p.wikiDir, process.pid, 60000);
  const t0 = Date.now();
  const held = p.cli(ingestArgs({ title: 'Blocked', content: 'x' }));
  assert.equal(held.status, 1);
  assert.equal(held.stdout, `Error ingesting into wiki: Failed to acquire file lock: ${lock}\n`);
  assert.ok(Date.now() - t0 >= 4900, 'waited the 5 s OMC waits');
  assert.ok(fs.existsSync(lock) && !fs.existsSync(path.join(p.wikiDir, 'blocked.md')));
});

// ============================================================================
// obsidizer
// ============================================================================

const ISO = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g;
const sansTime = (text) => text.replace(ISO, '<time>');
const twoPages = (p) => {
  assert.equal(p.cli(ingestArgs({ title: 'Target Page', content: 'The target.', category: 'pattern' })).status, 0);
  const run = p.cli(ingestArgs({ title: 'Source Page', content: 'Mentions [[Target Page]] and Target Page again.', category: 'pattern' }));
  assert.equal(run.status, 0, run.stderr);
  return run;
};

test('obsidizer: with <wiki>/.obsidizer the written page is what the hook makes of it; without, it stays as written', () => {
  const armed = project();
  fs.mkdirSync(armed.wikiDir, { recursive: true });
  fs.writeFileSync(path.join(armed.wikiDir, '.obsidizer'), '{"enabled":true}');
  const armedRun = twoPages(armed);
  assert.equal(armedRun.stderr, '');

  const plain = project();
  const plainRun = twoPages(plain);
  const raw = plain.page('source-page.md');
  fs.writeFileSync(path.join(plain.wikiDir, '.obsidizer'), '{"enabled":true}');
  const payload = { tool_name: 'mcp__plugin_oh-my-claudecode_t__wiki_ingest', tool_input: {}, tool_response: plainRun.stdout, cwd: plain.cwd };
  const hook = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(payload), env: plain.env, encoding: 'utf8' });
  assert.equal(hook.status, 0, hook.stderr);
  const hooked = plain.page('source-page.md');

  assert.notEqual(sansTime(hooked), sansTime(raw), 'the canonicalizer changes this page (else the test proves nothing)');
  assert.equal(sansTime(armed.page('source-page.md')), sansTime(hooked));
  const again = spawnSync(process.execPath, [OBSIDIZE, path.join(armed.wikiDir, 'source-page.md'), '--profile=omc', '--json', '--dry-run'], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(again.stdout).changed, [], 'armed page is already canonical');
});

test('obsidizer: a flag with no canonicalizer beside the skill warns on stderr and still writes', () => {
  const p = project();
  const lone = path.join(p.base, 'lone', 'append_wiki');
  fs.mkdirSync(lone, { recursive: true });
  fs.copyFileSync(WIKI, path.join(lone, 'wiki.mjs'));
  fs.mkdirSync(p.wikiDir, { recursive: true });
  fs.writeFileSync(path.join(p.wikiDir, '.obsidizer'), '{}');
  const run = spawnSync(process.execPath, [path.join(lone, 'wiki.mjs'), ...ingestArgs({ title: 'Alone', content: 'x' })], { cwd: p.cwd, env: p.env, encoding: 'utf8' });
  assert.equal(run.status, 0);
  assert.match(run.stderr, /obsidize\.mjs is not beside this skill/);
  assert.ok(fs.existsSync(path.join(p.wikiDir, 'alone.md')));
});

test('CLI: an --input-file that is not UTF-8 stops with exit 2 and writes nothing; UTF-16 with a BOM is read', () => {
  const p = project();
  const input = { title: 'Code Page', content: '한글 본문', tags: ['한글'], category: 'pattern' };
  // "한글" in cp949 (EUC-KR), as Windows PowerShell 5.1's Set-Content writes on Korean Windows.
  const cp949 = Buffer.from(JSON.stringify(input).replace(/한글/g, '@@'), 'utf8');
  const bytes = Buffer.concat(cp949.toString('latin1').split('@@').flatMap((part, i, all) =>
    (i < all.length - 1 ? [Buffer.from(part, 'latin1'), Buffer.from([0xc7, 0xd1, 0xb1, 0xdb])] : [Buffer.from(part, 'latin1')])));
  const bad = path.join(p.base, 'cp949.json');
  fs.writeFileSync(bad, bytes);
  const r = p.cli(['ingest', '--input-file', bad]);
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stderr, /is not UTF-8 \(or UTF-16 with a BOM\); write it as UTF-8/);
  assert.ok(!fs.existsSync(p.wikiDir) || !fs.readdirSync(p.wikiDir).some((f) => f.startsWith('code-page')));
  const le = path.join(p.base, 'utf16.json');
  fs.writeFileSync(le, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(JSON.stringify(input), 'utf16le')]));
  const ok = p.cli(['ingest', '--input-file', le, '--json']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(p.page('code-page.md').includes('한글 본문'));
});

test('git runs from the home folder: a git.exe in the project folder is never started (Windows looks there first)', { skip: process.platform !== 'win32' && 'only Windows looks up a bare program name in the current folder' }, () => {
  const p = project();
  // A stand-in git.exe: node itself, which rejects git's arguments, so any answer from it would be a refusal.
  fs.copyFileSync(process.execPath, path.join(p.cwd, 'git.exe'));
  const r = p.cli(['ingest', '--input', JSON.stringify({ title: 'Real Git', content: 'x', tags: [], category: 'reference' }), '--json']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(fs.existsSync(path.join(p.wikiDir, 'real-git.md')));
});
