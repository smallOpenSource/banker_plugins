// retired-notify 훅 시험(Claude Code SessionStart). 설정 폴더는 모두 임시 폴더(XDG_CONFIG_HOME, CLAUDE_CONFIG_DIR,
// APPDATA)라 개발자의 ~/.claude 와 ~/.config/banker 를 읽거나 쓰지 않는다. 네트워크 0.
// Run: node --test hooks/retired-notify.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, 'retired-notify.mjs');
const tmps = [];
after(() => { for (const t of tmps) rmSync(t, { recursive: true, force: true }); });

function mkTmp() {
  const t = mkdtempSync(join(tmpdir(), 'banker-retired-'));
  tmps.push(t);
  return t;
}
function run(tmp, input = '{}') {
  const env = { ...process.env, XDG_CONFIG_HOME: tmp, APPDATA: tmp, CLAUDE_CONFIG_DIR: join(tmp, 'claude-config'), HOME: tmp, USERPROFILE: tmp };
  return spawnSync(process.execPath, [HOOK], { input, encoding: 'utf8', env, timeout: 20000 });
}
function install(tmp, entries) {
  mkdirSync(join(tmp, 'claude-config', 'plugins'), { recursive: true });
  writeFileSync(join(tmp, 'claude-config', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'humanize-korean@im-not-ai': entries } }));
}

test('told once with the uninstall command; the next session says nothing', () => {
  const tmp = mkTmp();
  install(tmp, [{ scope: 'user', installPath: '/x', version: '2.3.2' }]);
  const first = run(tmp);
  assert.equal(first.status, 0, first.stderr);
  const msg = JSON.parse(first.stdout).systemMessage;
  assert.match(msg, /humanize-korean@im-not-ai 의 humanize, humanize-redo, humanize-scan 은 효과가 없어/);
  assert.match(msg, /claude plugin uninstall humanize-korean@im-not-ai --scope user/);
  assert.deepEqual(JSON.parse(readFileSync(join(tmp, 'banker', 'retired-notified.json'), 'utf8')), ['humanize-korean@im-not-ai']);
  const second = run(tmp);
  assert.equal(second.status, 0);
  assert.equal(second.stdout, '');
});

test('nothing installed, no plugins file, a broken payload: no output, exit 0, nothing written', () => {
  const tmp = mkTmp();
  for (const input of ['{}', '', 'not json']) {
    const r = run(tmp, input);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  }
  install(tmp, []);
  assert.equal(run(tmp).stdout, '');
  assert.equal(existsSync(join(tmp, 'banker', 'retired-notified.json')), false);
});

test('Claude Code only: hooks/hooks.json runs it, the Codex hooks never do (their banker-hooks-rev does not see it)', () => {
  const claude = JSON.stringify(JSON.parse(readFileSync(join(HERE, 'hooks.json'), 'utf8')).hooks.SessionStart);
  assert.match(claude, /hooks\/retired-notify\.mjs/);
  assert.doesNotMatch(readFileSync(join(HERE, '..', 'codex', 'hooks.json'), 'utf8'), /retired/);
  for (const f of ['update-notify.mjs', 'run.cjs', 'codex-hook.cjs']) assert.doesNotMatch(readFileSync(join(HERE, f), 'utf8'), /retired/, f);
});
