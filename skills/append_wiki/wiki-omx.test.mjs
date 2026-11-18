#!/usr/bin/env node
/*
 * Tests for wiki.mjs --profile=omx, the fallback for Codex without the `omx` CLI. Run:
 * `node --test skills/append_wiki/wiki-omx.test.mjs`. Zero deps: node:test + node:assert only. Every case runs in a
 * temp folder with its own HOME and temp, never in the real ~/.codex, ~/.omx, this repo or a real omx_wiki/.
 *
 * Parity with OMX 0.20.2 is checked against scripts/test-fixtures/omx-wiki-0.20.2/, which
 * scripts/gen-omx-wiki-golden.mjs wrote from OMX's own dist and `omx wiki` command, so these tests need no OMX. Only
 * the concurrency test with a live OMX writer needs OMX's dist (found as gen-omx-wiki-golden.mjs finds it).
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { caseEnv, digest, makeBase, makeProject } from '../../scripts/test-fixtures/omc-wiki-cases.mjs';
import { CLI_STEPS, FIXTURE_DIR, SCENARIOS, findOmxDir, runCli, runScenarioChild } from '../../scripts/test-fixtures/omx-wiki-cases.mjs';
import { omxParseFrontmatter, omxRootOf, omxTitleToSlug, parseFrontmatter } from './wiki.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WIKI = path.join(HERE, 'wiki.mjs');
const REPO = path.join(HERE, '..', '..');
const HOOK = path.join(REPO, 'hooks', 'obsidize-hook.mjs');
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8'));

const bases = [];
after(() => { for (const b of bases) fs.rmSync(b, { recursive: true, force: true }); });
function freshBase() {
  const base = makeBase('banker-wikiomx-');
  bases.push(base);
  return base;
}

// A project folder (a git one: OMX ignores git) with the omx CLI of wiki.mjs bound to it.
function project(name = 'p') {
  const base = freshBase();
  const cwd = makeProject(base, name);
  const env = caseEnv(base);
  fs.mkdirSync(env.HOME, { recursive: true });
  const cli = (args, opts = {}) => spawnSync(process.execPath, [WIKI, ...args, '--profile=omx'], { cwd, env, encoding: 'utf8', ...opts });
  const wikiDir = path.join(cwd, 'omx_wiki');
  return { base, cwd, env, cli, wikiDir, page: (f) => fs.readFileSync(path.join(wikiDir, f), 'utf8') };
}

const ingestInput = (input) => JSON.stringify({ tags: [], category: 'reference', ...input });
const ingestArgs = (input) => ['wiki_ingest', '--input', ingestInput(input), '--json'];

// ============================================================================
// Golden parity with OMX 0.20.2
// ============================================================================

const golden = fixture('golden.json');

for (const [name, steps] of Object.entries(SCENARIOS)) {
  test(`golden ${name}: every answer and every file byte matches OMX 0.20.2 (deliberate stops excepted)`, () => {
    const gold = golden.scenarios[name];
    assert.equal(gold.digest, digest(steps), 'the scenario changed since the fixture was written: rerun scripts/gen-omx-wiki-golden.mjs');
    const base = freshBase();
    const ours = runScenarioChild('banker', name, { cwd: makeProject(base, name), env: caseEnv(base) });
    steps.forEach((step, i) => {
      const where = `${name} step ${i} (${step.tool || Object.keys(step).find((k) => k !== 'at')})`;
      if (!step.deliberate) {
        assert.deepEqual(ours.steps[i].result, gold.steps[i].result, `${where}: answer`);
        assert.deepEqual(ours.steps[i].files, gold.steps[i].files, `${where}: files`);
        return;
      }
      assert.equal(gold.steps[i].result.isError, false, `${where}: OMX went on here (the difference is real)`);
      assert.equal(ours.steps[i].result.isError, true, `${where}: wiki.mjs stops`);
      assert.ok(JSON.parse(ours.steps[i].result.json).error.startsWith(step.deliberate), `${where}: ${ours.steps[i].result.json}`);
      assert.deepEqual(ours.steps[i].files, i > 0 ? ours.steps[i - 1].files : {}, `${where}: no file changed`);
    });
    if (!steps.some((s) => s.deliberate)) assert.deepEqual(ours.final, gold.final, `${name}: final bytes`);
  });
}

test('golden fixture covers what it claims: Korean slugs, legacy reads, OMX array splitting, reserved files, lint kinds', () => {
  const main = golden.scenarios.main;
  const answers = main.steps.map((s) => s.result?.json || '').join('\n');
  for (const f of ['omx_wiki/한글-제목.md', 'omx_wiki/mixed-한글-title-2026년-계획.md', 'omx_wiki/café-über-straße-٣٤.md',
    `omx_wiki/${'\uAC00'.repeat(64)}.md`, 'omx_wiki/page-65a84e86.md', 'sub/omx_wiki/login-flow.md', 'deep/er/omx_wiki/from-deep-folder.md']) {
    assert.ok(f in main.final, f);
  }
  assert.ok(main.final['omx_wiki/한글-링크-페이지.md'].includes('links: ["한글-제목.md", "auth-architecture.md"]'), 'Korean wiki links');
  assert.ok(main.final['omx_wiki/legacy-crlf.md'].includes('tags: ["old", "two", "parts", "new"]'), 'a quoted comma splits as OMX reads it');
  assert.ok(main.final['omx_wiki/bom-page.md'].startsWith('\uFEFF'), 'a BOM page stays as seeded (OMX cannot read it)');
  for (const want of ['Wiki page not found or reserved: index.md', 'Cannot write to reserved wiki file: index.md',
    'already exists. Use wiki_ingest to merge into it.', 'workingDirectory contains a NUL byte']) assert.ok(answers.includes(want), want);
  assert.ok(!Object.keys(main.final).some((k) => k.startsWith('.omc') || k.endsWith('.gitignore')), 'no .omc, no .gitignore');
  const legacy = golden.scenarios.legacy;
  assert.ok(!('omx_wiki/' in legacy.steps[5].files), 'reads of the old .omx/wiki make no omx_wiki/');
  assert.ok('omx_wiki/' in golden.scenarios['reserved-ingest-first'].final, 'OMX makes omx_wiki/ before refusing a reserved name');
});

test('CLI: `node wiki.mjs <args> --profile=omx` prints what `omx wiki <args>` prints, with the same exit status', () => {
  const want = fixture('cli.json');
  assert.equal(want.digest, digest(CLI_STEPS), 'the CLI cases changed since the fixture was written');
  const p = project('cli');
  const ours = runCli([WIKI], ['--profile=omx'], { cwd: p.cwd, env: p.env });
  CLI_STEPS.forEach((args, i) => assert.deepEqual(ours[i], want.steps[i], args.join(' ')));
});

// ============================================================================
// Helpers and the folder a call works on
// ============================================================================

test('helpers agree with OMX: slugs keep any script (NFC), a BOM page does not parse, a flow array splits on every comma', () => {
  assert.equal(omxTitleToSlug('한글 제목'), '한글-제목.md');
  assert.equal(omxTitleToSlug('Cafe\u0301!'), 'café.md');
  assert.equal(omxTitleToSlug('ThreadPool Deadlock: Acquire-Before-Pool!'), 'threadpool-deadlock-acquire-before-pool.md');
  const raw = '---\ntitle: \'it\'\'s\'\ntags: [a, "b, c"]\n---\nbody';
  assert.deepEqual(omxParseFrontmatter(raw).frontmatter.tags, ['a', 'b', 'c']);
  assert.equal(omxParseFrontmatter(raw).frontmatter.title, "it''s");
  assert.deepEqual(parseFrontmatter(raw).frontmatter.tags, ['a', 'b, c'], 'the omc profile keeps reading as OMC does');
  assert.equal(omxParseFrontmatter(`\uFEFF${raw}`), null);
  assert.notEqual(parseFrontmatter(`\uFEFF${raw}`), null);
});

test('omxRootOf: the cwd or the trimmed workingDirectory as given, and the other system\'s drive spelling', () => {
  const base = freshBase();
  const prev = process.cwd();
  process.chdir(base);
  try {
    assert.equal(omxRootOf(undefined), base);
    assert.equal(omxRootOf('  sub/dir  '), path.join(base, 'sub', 'dir'));
    assert.throws(() => omxRootOf('a\u0000b'), /NUL byte/);
    if (process.platform === 'win32') {
      assert.equal(omxRootOf('/mnt/q/some/where'), 'Q:\\some\\where');
    } else if (fs.existsSync('/mnt/q')) {
      assert.equal(omxRootOf('Q:\\some\\where'), '/mnt/q/some/where');
    } else {
      assert.throws(() => omxRootOf('Q:\\some\\where'), /Windows path is not available on this host/);
    }
  } finally {
    process.chdir(prev);
  }
});

test('a folder outside git writes omx_wiki/ in that folder: no git, no HOME, no .omc, no .gitignore', () => {
  const base = freshBase();
  const plain = path.join(base, 'plain');
  fs.mkdirSync(plain);
  const env = caseEnv(base);
  fs.mkdirSync(env.HOME, { recursive: true });
  const noGit = { ...env, PATH: path.join(base, 'no-such-bin') };
  const run = spawnSync(process.execPath, [WIKI, ...ingestArgs({ title: 'Loose', content: 'x' }), '--profile=omx'], { cwd: plain, env: noGit, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { created: ['loose.md'], updated: [], totalAffected: 1 });
  assert.deepEqual(fs.readdirSync(plain), ['omx_wiki']);
  assert.deepEqual(fs.readdirSync(path.join(plain, 'omx_wiki')).sort(), ['index.md', 'log.md', 'loose.md']);
  assert.deepEqual(fs.readdirSync(env.HOME), []);
});

// ============================================================================
// CLI
// ============================================================================

test('CLI: --input-file (UTF-8 with a BOM) carries Korean and quotes; a rejected input exits 1 with {"error"} and writes nothing', () => {
  const p = project();
  const file = path.join(p.base, 'in.json');
  fs.writeFileSync(file, `\uFEFF${ingestInput({ title: '파일 입력', content: '한글 "따옴표" \\ 역슬래시\n%TEMP% & !' })}`);
  const ing = p.cli(['ingest', '--input-file', file, '--json']);
  assert.equal(ing.status, 0, ing.stderr);
  assert.deepEqual(JSON.parse(ing.stdout), { created: ['파일-입력.md'], updated: [], totalAffected: 1 });
  assert.ok(p.page('파일-입력.md').includes('한글 "따옴표" \\ 역슬래시\n%TEMP% & !'));
  const bad = p.cli(ingestArgs({ title: 'T', content: 'c', tags: Array(21).fill('t') }));
  assert.equal(bad.status, 1);
  assert.equal(bad.stdout, '{"error":"invalid input: tags must have at most 20 items"}\n');
  const pretty = p.cli(['wiki_read', '--input', '{"page":"nope"}']);
  assert.equal(pretty.status, 1);
  assert.equal(pretty.stdout, '{\n  "error": "Wiki page not found"\n}\n');
  assert.deepEqual(fs.readdirSync(p.wikiDir).sort(), ['index.md', 'log.md', '파일-입력.md']);
});

test('CLI: an unknown profile is a usage error (exit 2) that touches nothing', () => {
  const p = project();
  const run = spawnSync(process.execPath, [WIKI, 'wiki_list', '--profile=omx2'], { cwd: p.cwd, env: p.env, encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /unknown --profile=omx2/);
  assert.deepEqual(fs.readdirSync(p.cwd).filter((f) => f !== '.git'), []);
});

// ============================================================================
// The lock folder: writers at once, a live OMX, a held lock
// ============================================================================

const WORKER = `
const w = await import(process.argv[1]);
const [id, n] = [process.argv[2], Number(process.argv[3])];
for (let i = 0; i < n; i++) {
  const r = w.runTool('wiki_ingest', { title: 'Shared Page', content: 'marker-' + id + '-' + i, tags: [id], category: 'pattern' }, 'omx');
  if (r.isError) { console.error(r.text); process.exit(1); }
}`;

// A writer that keeps OMX's lock (dist/wiki/storage.js: mkdir <wiki>/.wiki-lock.lock) and appends to log.md under it.
const OMX_STYLE_WRITER = `
const fs = await import('node:fs');
const path = await import('node:path');
const [wiki, n] = [process.argv[1], Number(process.argv[2])];
const lock = path.join(wiki, '.wiki-lock.lock');
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
for (let i = 0; i < n; i++) {
  for (;;) {
    try { fs.mkdirSync(lock); break; } catch (e) { if (e.code !== 'EEXIST') throw e; sleep(5); }
  }
  const log = path.join(wiki, 'log.md');
  const old = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '# Wiki Log\\n\\n';
  sleep(4);
  const tmp = log + '.' + process.pid + '.' + Date.now() + '.tmp';
  fs.writeFileSync(tmp, old + '## [x] omx-style-' + i + '\\n\\n');
  fs.renameSync(tmp, log);
  fs.rmSync(lock, { recursive: true, force: true });
  sleep(1);
}`;

// A live OMX writer: OMX's own ingestKnowledge from its dist, n times into the cwd's omx_wiki/.
const OMX_WRITER = `
const { ingestKnowledge } = await import(process.argv[1]);
const n = Number(process.argv[2]);
for (let i = 0; i < n; i++) ingestKnowledge(process.cwd(), { title: 'Shared Page', content: 'marker-omx-' + i, tags: ['omx'], category: 'pattern' });`;

function startNode(code, args, opts) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, ...args], { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', (status) => resolve({ status, err }));
  });
}

const leftovers = (wikiDir) => fs.readdirSync(wikiDir).filter((f) => f === '.wiki-lock.lock' || f.endsWith('.tmp'));

function assertAllMarkers(p, ids, n) {
  const page = p.page('shared-page.md');
  for (const id of ids) for (let i = 0; i < n; i++) assert.ok(page.includes(`marker-${id}-${i}\n`), `marker-${id}-${i}`);
  assert.equal((page.match(/^## Update \(/gm) || []).length, ids.length * n - 1);
  assert.equal((p.page('log.md').match(/\] ingest\n/g) || []).length, ids.length * n);
  assert.deepEqual(leftovers(p.wikiDir), []);
}

test('two writers at once lose no update: every Update section and log entry is there, no lock folder or temp file left', async () => {
  const p = project();
  const n = 12;
  const runs = await Promise.all(['a', 'b'].map((id) => startNode(WORKER, [pathToFileURL(WIKI).href, id, String(n)], { cwd: p.cwd, env: p.env })));
  for (const r of runs) assert.equal(r.status, 0, r.err);
  assertAllMarkers(p, ['a', 'b'], n);
});

test('wiki.mjs and a writer keeping OMX\'s lock folder interleave on one wiki without losing a log entry', async () => {
  const p = project();
  assert.equal(p.cli(ingestArgs({ title: 'Seed', content: 'seed' })).status, 0);
  const n = 25;
  const [ours, theirs] = await Promise.all([
    startNode(WORKER, [pathToFileURL(WIKI).href, 'w', String(n)], { cwd: p.cwd, env: p.env }),
    startNode(OMX_STYLE_WRITER, [p.wikiDir, String(4 * n)], { cwd: p.cwd, env: p.env }),
  ]);
  assert.equal(ours.status, 0, ours.err);
  assert.equal(theirs.status, 0, theirs.err);
  const log = p.page('log.md');
  for (let i = 0; i < 4 * n; i++) assert.ok(log.includes(`omx-style-${i}\n`), `omx-style-${i}`);
  assert.equal((log.match(/\] ingest\n/g) || []).length, n + 1);
  assert.deepEqual(leftovers(p.wikiDir), []);
});

const omxDir = findOmxDir();
test('wiki.mjs and a live OMX 0.20.2 writer (its dist) on one omx_wiki/ lose no update', { skip: !omxDir && 'OMX is not installed here (set BANKER_OMX_DIR); the lock protocol is still tested against an OMX-style writer above' }, async () => {
  const p = project();
  const n = 20;
  const [ours, theirs] = await Promise.all([
    startNode(WORKER, [pathToFileURL(WIKI).href, 'w', String(n)], { cwd: p.cwd, env: p.env }),
    startNode(OMX_WRITER, [pathToFileURL(path.join(omxDir, 'dist', 'wiki', 'ingest.js')).href, String(n)], { cwd: p.cwd, env: p.env }),
  ]);
  assert.equal(ours.status, 0, ours.err);
  assert.equal(theirs.status, 0, theirs.err);
  assertAllMarkers(p, ['w', 'omx'], n);
});

function holdLockDir(wikiDir, ms) {
  const code = `
const fs = await import('node:fs');
const lock = process.argv[1];
fs.mkdirSync(lock);
process.stdout.write('held\\n');
setTimeout(() => { fs.rmSync(lock, { recursive: true, force: true }); process.stdout.write('released ' + Date.now() + '\\n'); }, Number(process.argv[2]));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, path.join(wikiDir, '.wiki-lock.lock'), String(ms)]);
  let out = '';
  const held = new Promise((resolve) => child.stdout.on('data', (d) => { out += d; if (out.includes('held')) resolve(); }));
  const done = new Promise((resolve) => child.on('exit', () => resolve(Number((/released (\d+)/.exec(out) || [])[1]))));
  return { held, done };
}

test('a held lock folder makes a write wait, then go on once it is removed', async () => {
  const p = project();
  assert.equal(p.cli(ingestArgs({ title: 'Seed', content: 'seed' })).status, 0);
  const holder = holdLockDir(p.wikiDir, 700);
  await holder.held;
  const run = await new Promise((resolve) => {
    const child = spawn(process.execPath, [WIKI, ...ingestArgs({ title: 'After Wait', content: 'x' }), '--profile=omx'], { cwd: p.cwd, env: p.env });
    child.on('exit', (status) => resolve({ status, at: Date.now() }));
  });
  const releasedAt = await holder.done;
  assert.equal(run.status, 0);
  assert.ok(run.at >= releasedAt, 'the write finished after the release');
  assert.ok(p.page('after-wait.md').includes('# After Wait'));
});

test('a lock folder nobody removes stops the write after 5 s with OMX\'s words, and stays (OMX reaps none)', () => {
  const p = project();
  assert.equal(p.cli(ingestArgs({ title: 'Seed', content: 'seed' })).status, 0);
  const lock = path.join(p.wikiDir, '.wiki-lock.lock');
  fs.mkdirSync(lock);
  const old = new Date(Date.now() - 3600000);
  fs.utimesSync(lock, old, old);
  const t0 = Date.now();
  const run = p.cli(ingestArgs({ title: 'Blocked', content: 'x' }));
  assert.equal(run.status, 1);
  assert.deepEqual(JSON.parse(run.stdout), { error: `Timed out acquiring wiki lock at ${lock}` });
  assert.ok(Date.now() - t0 >= 4900, 'waited the 5 s OMX waits');
  assert.ok(fs.statSync(lock).isDirectory() && !fs.existsSync(path.join(p.wikiDir, 'blocked.md')));
});

// ============================================================================
// obsidizer
// ============================================================================

const ISO = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g;
const sansTime = (text) => text.replace(ISO, '<time>');
function twoPages(p) {
  assert.equal(p.cli(ingestArgs({ title: 'Target Page', content: 'The target.', category: 'pattern' })).status, 0);
  const run = p.cli(ingestArgs({ title: 'Source Page', content: 'Mentions [[Target Page]] and Target Page again.', category: 'pattern' }));
  assert.equal(run.status, 0, run.stderr);
  return run;
}

test('obsidizer: with omx_wiki/.obsidizer the page is what the Codex hook makes of an `omx wiki` write; without, as written', () => {
  const armed = project();
  fs.mkdirSync(armed.wikiDir, { recursive: true });
  fs.writeFileSync(path.join(armed.wikiDir, '.obsidizer'), '{"enabled":true}');
  assert.equal(twoPages(armed).stderr, '');

  const plain = project();
  const plainRun = twoPages(plain);
  const raw = plain.page('source-page.md');
  fs.writeFileSync(path.join(plain.wikiDir, '.obsidizer'), '{"enabled":true}');
  const payload = { tool_name: 'Bash', tool_input: { command: 'omx wiki wiki_ingest --input x --json' }, tool_response: plainRun.stdout, cwd: plain.cwd };
  const hook = spawnSync(process.execPath, [HOOK, '--codex'], { input: JSON.stringify(payload), env: plain.env, encoding: 'utf8' });
  assert.equal(hook.status, 0, hook.stderr);
  const hooked = plain.page('source-page.md');
  assert.notEqual(sansTime(hooked), sansTime(raw), 'the canonicalizer changes this page (else the test proves nothing)');
  assert.equal(sansTime(armed.page('source-page.md')), sansTime(hooked));
});

test('obsidizer: a Korean page name is left alone, as the Codex hook leaves it', () => {
  const p = project();
  fs.mkdirSync(p.wikiDir, { recursive: true });
  fs.writeFileSync(path.join(p.wikiDir, '.obsidizer'), '{}');
  assert.equal(p.cli(ingestArgs({ title: 'Target Page', content: 'The target.' })).status, 0);
  const run = p.cli(ingestArgs({ title: '한글 페이지', content: 'Mentions [[Target Page]] and Target Page again.' }));
  assert.equal(run.status, 0, run.stderr);
  const page = p.page('한글-페이지.md');
  assert.ok(page.endsWith('\nMentions [[Target Page]] and Target Page again.\n'), page);
});
