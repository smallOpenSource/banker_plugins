// Tests for codex-hooks.mjs. Run from the repo root: node --test bin/lib/codex-hooks.test.mjs
import { strict as assert } from 'node:assert';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, posix as P } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { codexPaths, disableHooks, enableHooks, formatCommand, homeInWorkspace, HOOKS, hookStatus, PAYLOAD, removeAll, safeNode } from './codex-hooks.mjs';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const root = mkdtempSync(join(tmpdir(), 'codex-hooks-test-'));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const home = () => {
  const d = join(root, `h${n++}`);
  mkdirSync(d);
  return codexPaths({ CODEX_HOME: d });
};
const omx = { type: 'command', command: 'omx-hook' };
const seed = (p, extra = {}) => writeFileSync(p.hooks, JSON.stringify({ hooks: { SessionStart: [{ hooks: [omx] }], ...extra } }));
const read = (p) => JSON.parse(readFileSync(p.hooks, 'utf8')).hooks;
const posix = { skip: process.platform === 'win32' && 'POSIX modes' };

test('enable copies the payload and appends after the existing groups; a second run changes nothing', () => {
  const p = home();
  seed(p);
  const r = enableHooks(p, ['update', 'count'], PKG);
  assert.deepEqual([r.code, r.changed], [0, ['update', 'count']]);
  const h = read(p);
  assert.deepEqual(h.SessionStart[0].hooks[0], omx, 'OMX keeps index 0');
  assert.equal(h.SessionStart[1].hooks[0].command, formatCommand(process.execPath, join(p.dir, 'hooks', 'update-notify.mjs'), ['--codex']));
  assert.equal(h.Stop.length, 1);
  assert.ok(existsSync(join(p.dir, 'bin', 'lib', 'telemetry-config.mjs')) && existsSync(join(p.dir, '.claude-plugin', 'plugin.json')));
  assert.deepEqual(enableHooks(p, ['update', 'count'], PKG).changed, []);
  assert.deepEqual(hookStatus(p, ['update', 'count', 'obsidize'], PKG).status, { update: 'on', count: 'on', obsidize: 'off' });
});

test('a stale command is fixed in place and status says stale until then', () => {
  const p = home();
  enableHooks(p, ['update'], PKG);
  const doc = JSON.parse(readFileSync(p.hooks, 'utf8'));
  doc.hooks.SessionStart[0].hooks[0].command = `"/old/node" "${join(p.dir, 'hooks', 'update-notify.mjs')}" --codex`;
  writeFileSync(p.hooks, JSON.stringify(doc));
  assert.equal(hookStatus(p, ['update'], PKG).status.update, 'stale');
  assert.deepEqual(enableHooks(p, ['update'], PKG).changed, ['update']);
  assert.equal(read(p).SessionStart.length, 1);
  assert.equal(hookStatus(p, ['update'], PKG).status.update, 'on');
});

test('disable removes only our handler, keeps a shared group, backs up, and reports shifted events', () => {
  const p = home();
  seed(p);
  enableHooks(p, ['update'], PKG);
  const doc = JSON.parse(readFileSync(p.hooks, 'utf8'));
  doc.hooks.SessionStart[1].hooks.push({ type: 'command', command: 'other' });
  doc.hooks.Stop = [{ hooks: [{ type: 'command', command: `x /hooks-custom/banker/hooks/telemetry-count-codex.mjs` }] }, { hooks: [{ type: 'command', command: 'later' }] }];
  writeFileSync(p.hooks, JSON.stringify(doc));
  const before = readFileSync(p.hooks, 'utf8');
  const r = disableHooks(p, ['update', 'count']);
  assert.deepEqual([r.changed, r.shifted], [['update', 'count'], ['Stop']]);
  const h = read(p);
  assert.deepEqual(h.SessionStart, [{ hooks: [omx] }, { hooks: [{ type: 'command', command: 'other' }] }]);
  assert.deepEqual(h.Stop, [{ hooks: [{ type: 'command', command: 'later' }] }]);
  assert.equal(readFileSync(p.backup, 'utf8'), before);
});

test('removeAll takes every banker hook and the copy folder away', () => {
  const p = home();
  seed(p);
  enableHooks(p, ['update', 'count'], PKG);
  assert.equal(removeAll(p).code, 0);
  assert.deepEqual(read(p), { SessionStart: [{ hooks: [omx] }] });
  assert.ok(!existsSync(p.dir));
});

test('hooks files of the wrong shape, links, and unreadable ones change nothing', (t) => {
  const p = home();
  for (const body of ['[]', '{"hooks":[]}', '{"hooks":{"Stop":{}}}']) {
    writeFileSync(p.hooks, body);
    assert.equal(enableHooks(p, ['count'], PKG).code, 1, body);
    assert.equal(readFileSync(p.hooks, 'utf8'), body);
  }
  const q = home();
  const real = join(root, `real${n++}`);
  writeFileSync(real, '{"hooks":{}}');
  try {
    symlinkSync(real, q.hooks);
  } catch {
    return t.skip('no file links');
  }
  assert.equal(enableHooks(q, ['count'], PKG).code, 1);
  assert.equal(readFileSync(real, 'utf8'), '{"hooks":{}}');
});

test('rewriting keeps the mode, and an unreadable hooks.json is not taken for a missing one', posix, (t) => {
  const p = home();
  seed(p);
  chmodSync(p.hooks, 0o600);
  enableHooks(p, ['update'], PKG);
  assert.equal(statSync(p.hooks).mode & 0o777, 0o600);
  if (process.getuid && process.getuid() === 0) return t.skip('root reads past mode bits');
  chmodSync(p.home, 0o000);
  try {
    assert.match(enableHooks(p, ['count'], PKG).msg, /확인하지 못함\(EACCES\)/);
  } finally {
    chmodSync(p.home, 0o755);
  }
});

test('command text per platform and node location rules', () => {
  assert.equal(formatCommand('/n/node', '/h/x.mjs', ['--codex'], false), '"/n/node" "/h/x.mjs" --codex');
  assert.equal(formatCommand('/n/node', '/h/$x.mjs', [], false), null);
  assert.equal(formatCommand('C:\\n\\node.exe', "C:\\o'k\\x.mjs", ['--codex'], true), "& 'C:\\n\\node.exe' 'C:\\o''k\\x.mjs' --codex");
  assert.equal(safeNode(join(tmpdir(), 'node'), { win: process.platform === 'win32', cwd: '/w', codex: false }), false);
  assert.equal(safeNode('/home/u/.nvm/node', { win: false, cwd: '/home/u', codex: true }), false);
  assert.equal(safeNode('/home/u/.nvm/node', { win: false, cwd: '/home/u', codex: false }), true);
});

test('obsidize goes after shell calls only and brings its canonicalizer along', () => {
  const p = home();
  assert.deepEqual(enableHooks(p, ['obsidize'], PKG).changed, ['obsidize']);
  const g = read(p).PostToolUse;
  assert.deepEqual([g.length, g[0].matcher], [1, 'Bash']);
  assert.match(g[0].hooks[0].command, /obsidize-hook\.mjs["'] --codex$/);
  assert.ok(existsSync(join(p.dir, 'skills', 'obsidizer', 'obsidize.mjs')));
  assert.deepEqual(disableHooks(p, ['obsidize']).changed, ['obsidize']);
  assert.equal(read(p).PostToolUse, undefined);
});

test('every hook copy loads from the copy folder alone (no import left behind in the package)', () => {
  const p = home();
  enableHooks(p, ['update', 'count', 'obsidize'], PKG);
  const cfg = join(root, `cfg${n++}`);
  for (const id of ['update', 'count', 'obsidize']) {
    const script = join(p.dir, ...HOOKS[id].script.split('/'));
    const env = { ...process.env, XDG_CONFIG_HOME: cfg, APPDATA: cfg, BANKER_NO_UPDATE_CHECK: '1', BANKER_NO_TELEMETRY: '1', CODEX_HOME: p.home };
    const r = spawnSync(process.execPath, [script, ...HOOKS[id].args], { input: '{}', encoding: 'utf8', env, cwd: root, timeout: 15000 });
    assert.equal(r.status, 0, `${id}: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /ERR_MODULE_NOT_FOUND|Cannot find/, id);
  }
});

test('a Codex home inside the working folder or its repository gets no hooks; the home folder itself is no workspace', () => {
  const repo = join(root, `repo${n++}`);
  mkdirSync(join(repo, 'sub'), { recursive: true });
  spawnSync('git', ['init', '-q', repo]);
  const p = codexPaths({ CODEX_HOME: join(repo, '.codex') });
  mkdirSync(p.home);
  const r = enableHooks(p, ['count'], PKG, process.execPath, join(repo, 'sub'));
  assert.equal(r.code, 1);
  assert.match(r.msg, /작업 폴더 안/);
  assert.ok(!existsSync(p.hooks) && !existsSync(p.dir), 'nothing written');
  assert.equal(homeInWorkspace(join(repo, '.codex'), repo), true);
  assert.equal(homeInWorkspace(join(homedir(), '.codex'), homedir()), false);
  assert.equal(homeInWorkspace(join(root, 'elsewhere'), join(repo, 'sub')), false);
  assert.equal(codexPaths({ CODEX_HOME: 'rel' }).home, join(process.cwd(), 'rel'), 'a relative CODEX_HOME is read from here, as Codex reads it');
});

test('the copy carries everything the hooks import or start: relative imports and the scripts they name resolve inside it', () => {
  const inCopy = new Set(PAYLOAD);
  const names = new Set(PAYLOAD.map((f) => basename(f)));
  for (const rel of PAYLOAD.filter((f) => f.endsWith('.mjs'))) {
    const src = readFileSync(join(PKG, ...rel.split('/')), 'utf8');
    for (const m of src.matchAll(/(?:from\s+|import\(\s*)'(\.{1,2}\/[^']+)'/g)) {
      const target = P.normalize(P.join(P.dirname(rel), m[1]));
      assert.ok(inCopy.has(target), `${rel} imports ${target}, which the copy lacks`);
    }
    for (const m of src.matchAll(/'([\w.-]+\.mjs)'/g)) assert.ok(names.has(m[1]), `${rel} names ${m[1]}, which the copy lacks`);
  }
});
