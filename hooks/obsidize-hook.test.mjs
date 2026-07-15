#!/usr/bin/env node
/*
 * Tests for the obsidizer PostToolUse hook. Run: `node --test hooks/`.
 *
 * Each test builds a throwaway plugin tree (hook + a stub canonicalizer) and a throwaway
 * vault under the OS temp dir. The live .omc/wiki/ is never touched.
 *
 * Scope: this exercises the hook's own contract — gating, path resolution, dispatch,
 * fail-safe, observability. The canonicalizer is a stub implementing the documented CLI,
 * so real canonicalization is covered by the canonicalizer's own tests, not here.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REAL_HOOK = join(HERE, 'obsidize-hook.mjs');
const REAL_CANONICALIZER = join(HERE, '..', 'skills', 'obsidizer', 'obsidize.mjs');

const UPDATE_MARKER = '## Update (';

// Verbatim shape of what wiki_ingest returns (OMC src/tools/wiki-tools.ts).
const INGEST_RESPONSE = 'Wiki ingest complete.\n- Created: none\n- Updated: test-page.md\n- Total affected: 1';
const INGEST_RESPONSE_NO_PATH = 'Wiki ingest complete.\n- Created: none\n- Updated: none\n- Total affected: 0';

const PAGE_BEFORE = [
  '---',
  'title: Test Page',
  'tags: [alpha]',
  '---',
  '',
  '# Test Page',
  '',
  '',
  '',
  'Body text sitting under too many blank lines.',
  '',
  '---',
  '',
  `${UPDATE_MARKER}2026-07-15T10:00:00.000Z)`,
  '',
  '',
  '',
  'Merged content that must keep its exact spacing.',
  '',
].join('\n');

// Reserved, and rewritten by every ingest — so it is always the freshest file in the vault.
// Deliberately messy: if the hook ever hands it to the canonicalizer, these bytes change.
const INDEX_BEFORE = ['# Index', '', '', '', '- [[test-page]]', ''].join('\n');

const STUB_CANONICALIZER = `#!/usr/bin/env node
// Test double for skills/obsidizer/obsidize.mjs. Implements only the CLI contract the hook
// depends on: node obsidize.mjs <path> [--profile=auto|omc|generic] [--dry-run] [--json].
// Its transform is a miniature of the real ruleset: collapse blank-line runs, leave any
// '## Update (<ts>)' section byte-identical, and be a fixed point on a second run.
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
appendFileSync(process.env.STUB_ARGV_LOG, JSON.stringify(args) + '\\n');
if (process.env.STUB_FAIL === '1') {
  process.stderr.write('stub canonicalizer failure\\n');
  process.exit(1);
}
const target = args.find((a) => !a.startsWith('--'));
const before = readFileSync(target, 'utf8');
const [head, ...rest] = before.split(/(?=^## Update \\()/m);
const after = head.replace(/\\n{3,}/g, '\\n\\n') + rest.join('');
if (after !== before) writeFileSync(target, after);
if (args.includes('--json')) process.stdout.write(JSON.stringify({ path: target, changed: after !== before }));
`;

// A structurally valid OMC page: the 9-key frontmatter serializePage emits, plus an
// appended Update section. Used only by the real-canonicalizer integration test.
const OMC_PAGE = [
  '---',
  'title: "Test Page"',
  'tags: ["#Beta", "alpha", "alpha"]',
  'created: 2026-07-01T00:00:00.000Z',
  'updated: 2026-07-01T00:00:00.000Z',
  'sources: ["s1"]',
  'links: ["zeta-page", "alpha-page"]',
  'category: reference',
  'confidence: high',
  'schemaVersion: 1',
  '---',
  '',
  '# Test Page',
  '',
  '',
  '',
  'Body text sitting under too many blank lines.',
  '',
  '---',
  '',
  `${UPDATE_MARKER}2026-07-15T10:00:00.000Z)`,
  '',
  '',
  '',
  'Merged content that must keep its exact spacing.',
  '',
].join('\n');

const trees = [];
after(() => { for (const tree of trees) rmSync(tree.tmp, { recursive: true, force: true }); });

function makeTree({ realCanonicalizer = false } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'obsidize-hook-'));
  const pluginRoot = join(tmp, 'plugin');
  mkdirSync(join(pluginRoot, 'hooks'), { recursive: true });
  mkdirSync(join(pluginRoot, 'skills', 'obsidizer'), { recursive: true });
  copyFileSync(REAL_HOOK, join(pluginRoot, 'hooks', 'obsidize-hook.mjs'));
  const canonicalizer = join(pluginRoot, 'skills', 'obsidizer', 'obsidize.mjs');
  if (realCanonicalizer) copyFileSync(REAL_CANONICALIZER, canonicalizer);
  else writeFileSync(canonicalizer, STUB_CANONICALIZER);

  const project = join(tmp, 'project');
  const wikiDir = join(project, '.omc', 'wiki');
  mkdirSync(wikiDir, { recursive: true });
  writeFileSync(join(wikiDir, 'test-page.md'), realCanonicalizer ? OMC_PAGE : PAGE_BEFORE);
  writeFileSync(join(wikiDir, 'index.md'), INDEX_BEFORE);
  if (realCanonicalizer) writeFileSync(join(wikiDir, 'log.md'), '# Log\n');

  const argvLog = join(tmp, 'stub-argv.log');
  writeFileSync(argvLog, '');

  const tree = { tmp, pluginRoot, project, wikiDir, argvLog };
  trees.push(tree);
  return tree;
}

const arm = (tree) => writeFileSync(join(tree.wikiDir, '.obsidizer'), '');

function runHook(tree, payload, { stubFail = false } = {}) {
  const env = { ...process.env, STUB_ARGV_LOG: tree.argvLog, STUB_FAIL: stubFail ? '1' : '0' };
  delete env.OMC_STATE_DIR; // never let the real environment redirect the fixture vault
  return spawnSync(process.execPath, [join(tree.pluginRoot, 'hooks', 'obsidize-hook.mjs')], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    cwd: tree.project,
    env,
  });
}

const payloadFor = (tree, text) => ({
  session_id: 'test-session',
  cwd: tree.project,
  tool_name: 'mcp__plugin_oh-my-claudecode_t__wiki_ingest',
  tool_input: { title: 'Test Page' },
  tool_response: { content: [{ type: 'text', text }] },
  effort: 'medium',
});

const readArgv = (tree) => readFileSync(tree.argvLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const page = (tree) => readFileSync(join(tree.wikiDir, 'test-page.md'), 'utf8');
const updateSection = (text) => text.slice(text.indexOf(UPDATE_MARKER));

function logLines(tree) {
  const path = join(tree.wikiDir, '.obsidizer-hook.log');
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : [];
}

const snapshot = (dir) => Object.fromEntries(readdirSync(dir).sort().map((f) => [f, readFileSync(join(dir, f), 'utf8')]));

test('fires-when-armed: the touched page is canonicalized', () => {
  const tree = makeTree();
  arm(tree);

  const res = runHook(tree, payloadFor(tree, INGEST_RESPONSE));

  assert.equal(res.status, 0);
  assert.notEqual(page(tree), PAGE_BEFORE, 'page should have been rewritten');
  assert.ok(!/\n{3,}/.test(page(tree).split(UPDATE_MARKER)[0]), 'blank-line runs collapsed');
  assert.deepEqual(readArgv(tree), [[join(tree.wikiDir, 'test-page.md'), '--profile=omc', '--json']],
    'canonicalizer invoked once, on the touched page, under the OMC profile with a json report');
});

test('no-op-when-flag-absent: exit 0, zero bytes changed anywhere', () => {
  const tree = makeTree();
  const before = snapshot(tree.wikiDir);

  const res = runHook(tree, payloadFor(tree, INGEST_RESPONSE));

  assert.equal(res.status, 0);
  assert.deepEqual(snapshot(tree.wikiDir), before, 'vault is byte-identical');
  assert.equal(readArgv(tree).length, 0, 'canonicalizer never invoked');
  assert.ok(!existsSync(join(tree.wikiDir, '.obsidizer-hook.log')), 'a disarmed hook writes no log either');
});

test('idempotent: a second fire changes nothing further', () => {
  const tree = makeTree();
  arm(tree);

  runHook(tree, payloadFor(tree, INGEST_RESPONSE));
  const afterFirst = snapshot(tree.wikiDir);
  runHook(tree, payloadFor(tree, INGEST_RESPONSE));

  assert.deepEqual(snapshot(tree.wikiDir), afterFirst, 'second run is a byte-level no-op');
});

test('never-re-enters: the hook source names no MCP tool', () => {
  const src = readFileSync(REAL_HOOK, 'utf8');
  for (const token of ['mcp__', 'wiki_ingest', 'wiki_add', 'wiki_delete', 'wiki_read', 'wiki_list', 'wiki_query', 'wiki_lint']) {
    assert.ok(!src.includes(token), `hook must not reference ${token} — calling one would re-enter this hook`);
  }
});

test('no LLM injection, no coupling to OMC internals', () => {
  const src = readFileSync(REAL_HOOK, 'utf8');
  assert.ok(!src.includes('additionalContext'), 'the hook must not inject context into the LLM');
  assert.ok(!src.includes('.wiki-lock'), "the hook must not depend on OMC's internal lock file");
});

test('preserve-only: the ## Update section is not reformatted', () => {
  const tree = makeTree();
  arm(tree);

  runHook(tree, payloadFor(tree, INGEST_RESPONSE));

  assert.equal(updateSection(page(tree)), updateSection(PAGE_BEFORE),
    'the section mergePage just appended survives byte-for-byte');
});

test('fail-safe: a malformed payload exits 0 and logs one line', () => {
  const tree = makeTree();
  arm(tree);

  const res = runHook(tree, '{not json');

  assert.equal(res.status, 0);
  const lines = logLines(tree);
  assert.equal(lines.length, 1, 'exactly one log line');
  assert.match(lines[0], /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\tunknown\tunreadable hook payload/);
  assert.equal(page(tree), PAGE_BEFORE, 'page left untouched');
});

test('fail-safe: a failing canonicalizer exits 0 and logs one line', () => {
  const tree = makeTree();
  arm(tree);

  const res = runHook(tree, payloadFor(tree, INGEST_RESPONSE), { stubFail: true });

  assert.equal(res.status, 0);
  const lines = logLines(tree);
  assert.equal(lines.length, 1, 'exactly one log line');
  assert.match(lines[0], /test-page\.md: canonicalizer exited 1/);
  assert.equal(page(tree), PAGE_BEFORE, 'page left untouched');
});

test('run.cjs: the real hooks.json command path delivers stdin and canonicalizes', () => {
  const tree = makeTree();
  arm(tree);
  copyFileSync(join(HERE, 'run.cjs'), join(tree.pluginRoot, 'hooks', 'run.cjs'));

  // Exactly what hooks.json runs, with $CLAUDE_PLUGIN_ROOT expanded.
  const env = { ...process.env, STUB_ARGV_LOG: tree.argvLog, STUB_FAIL: '0' };
  delete env.OMC_STATE_DIR;
  const res = spawnSync(process.execPath, [
    join(tree.pluginRoot, 'hooks', 'run.cjs'),
    join(tree.pluginRoot, 'hooks', 'obsidize-hook.mjs'),
  ], { input: JSON.stringify(payloadFor(tree, INGEST_RESPONSE)), encoding: 'utf8', cwd: tree.project, env });

  assert.equal(res.status, 0);
  assert.notEqual(page(tree), PAGE_BEFORE, 'the payload survived the run.cjs hop and the page was canonicalized');
  assert.equal(logLines(tree).length, 0, 'no errors logged');
});

test('run.cjs: a missing target exits 0 rather than blocking the tool', () => {
  const res = spawnSync(process.execPath, [join(HERE, 'run.cjs'), join(HERE, 'no-such-hook.mjs')], {
    input: '{}', encoding: 'utf8',
  });
  assert.equal(res.status, 0);
});

test('hooks.json: shape, single PostToolUse entry, explicit short timeout', () => {
  const config = JSON.parse(readFileSync(join(HERE, 'hooks.json'), 'utf8'));

  assert.deepEqual(Object.keys(config).sort(), ['description', 'hooks'], 'top-level keys are exactly description + hooks');
  assert.deepEqual(Object.keys(config.hooks), ['PostToolUse'], 'declares only PostToolUse');
  assert.equal(config.hooks.PostToolUse.length, 1);

  const [command] = config.hooks.PostToolUse[0].hooks;
  assert.equal(command.type, 'command');
  assert.ok(command.command.includes('/hooks/run.cjs'), 'routes through the node-discovery wrapper');
  assert.ok(command.command.endsWith('/hooks/obsidize-hook.mjs'), 'dispatches to the hook script');
  assert.ok(command.command.includes('$CLAUDE_PLUGIN_ROOT'), 'command is plugin-root relative');
  assert.ok(command.timeout >= 3 && command.timeout <= 5, `explicit 3-5s timeout, never the 600s default (got ${command.timeout})`);
});

test('hooks.json matcher: fires on wiki writes, tolerates prefix variants, ignores deletes', () => {
  const config = JSON.parse(readFileSync(join(HERE, 'hooks.json'), 'utf8'));
  const matcher = new RegExp(config.hooks.PostToolUse[0].matcher);

  // Plugin-installed form and the plain-MCP-server form: the prefix differs by wiring, so
  // the matcher must not hard-code one.
  for (const tool of [
    'mcp__plugin_oh-my-claudecode_t__wiki_ingest',
    'mcp__plugin_oh-my-claudecode_t__wiki_add',
    'mcp__omc__wiki_ingest',
    'mcp__oh-my-claudecode__wiki_add',
  ]) {
    assert.ok(matcher.test(tool), `must fire for ${tool}`);
  }

  // wiki_delete writes nothing; the read-only tools write nothing either.
  for (const tool of [
    'mcp__plugin_oh-my-claudecode_t__wiki_delete',
    'mcp__plugin_oh-my-claudecode_t__wiki_read',
    'mcp__plugin_oh-my-claudecode_t__wiki_list',
    'mcp__plugin_oh-my-claudecode_t__wiki_query',
    'mcp__plugin_oh-my-claudecode_t__wiki_lint',
    'Write',
    'Bash',
  ]) {
    assert.ok(!matcher.test(tool), `must not fire for ${tool}`);
  }
});

test('path resolution: the dir-scan fallback runs when tool_response names no path', () => {
  const tree = makeTree();
  arm(tree);

  const res = runHook(tree, payloadFor(tree, INGEST_RESPONSE_NO_PATH));

  assert.equal(res.status, 0);
  assert.deepEqual(readArgv(tree).map((argv) => basename(argv[0])), ['test-page.md'],
    'scan targets the freshly written page, and never the reserved index.md');
  assert.equal(readFileSync(join(tree.wikiDir, 'index.md'), 'utf8'), INDEX_BEFORE, 'index.md untouched');
});

// The tests above stub the canonicalizer to isolate the hook's contract. This one wires up
// the real skills/obsidizer/obsidize.mjs, which is the pairing that actually ships.
test('integration: the hook drives the real canonicalizer and stays idempotent', {
  skip: existsSync(REAL_CANONICALIZER) ? false : 'skills/obsidizer/obsidize.mjs not present yet',
}, () => {
  const tree = makeTree({ realCanonicalizer: true });
  arm(tree);

  const first = runHook(tree, payloadFor(tree, INGEST_RESPONSE));
  assert.equal(first.status, 0);
  const afterFirst = page(tree);
  assert.notEqual(afterFirst, OMC_PAGE, 'the real canonicalizer rewrote the page');
  assert.equal(updateSection(afterFirst), updateSection(OMC_PAGE), 'Update section preserved byte-for-byte');
  assert.deepEqual(logLines(tree), [], 'no errors logged');

  const second = runHook(tree, payloadFor(tree, INGEST_RESPONSE));
  assert.equal(second.status, 0);
  assert.equal(page(tree), afterFirst, 'second fire is a byte-level no-op — `updated` is content-gated, not wall-clock');
  assert.equal(readFileSync(join(tree.wikiDir, 'index.md'), 'utf8'), INDEX_BEFORE, 'reserved index.md untouched');
});
