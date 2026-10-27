// Tests for codex-hooks.mjs. Run from the repo root: node --test bin/lib/codex-hooks.test.mjs
import { strict as assert } from 'node:assert';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { codexPaths, disableHooks, enableHooks, formatCommand, hookStatus, removeAll, safeNode } from './codex-hooks.mjs';

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
  assert.equal(safeNode(join(tmpdir(), 'node'), { win: false, cwd: '/w', codex: false }), false);
  assert.equal(safeNode('/home/u/.nvm/node', { win: false, cwd: '/home/u', codex: true }), false);
  assert.equal(safeNode('/home/u/.nvm/node', { win: false, cwd: '/home/u', codex: false }), true);
});
