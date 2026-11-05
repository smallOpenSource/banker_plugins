// Tests for the Codex Stop hook that keeps a banker ralph run going: it blocks the stop only for the session that
// started an active run in this repo, prints nothing otherwise, honours BANKER_NO_RALPH_CONTINUE and never fails.
// Run: node --test hooks/ralph-continue-codex.test.mjs
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const HOOK = fileURLToPath(new URL('./ralph-continue-codex.mjs', import.meta.url));
const RUN = fileURLToPath(new URL('./run.cjs', import.meta.url));
const RS = fileURLToPath(new URL('../codex/skills/ralph/scripts/ralph-state.mjs', import.meta.url));
const GATE = fileURLToPath(new URL('../codex/skills/ralph/scripts/gate-evidence.mjs', import.meta.url));
const WIN = process.platform === 'win32';
const SESSION = '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0001';

function world(t) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'br-rc-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const base = WIN ? join(home, 'AppData', 'Local', 'Temp') : join(dir, 'run');
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_THREAD_ID: SESSION,
    ...(WIN ? { TEMP: base, TMP: base } : process.platform === 'darwin' ? { TMPDIR: base } : { XDG_RUNTIME_DIR: base }),
    GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  delete env.BANKER_NO_RALPH_CONTINUE;
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  for (const a of [['-c', 'init.defaultBranch=main', 'init', '-q'], ['add', 'a.txt'], ['commit', '-q', '-m', 'base']]) spawnSync('git', ['-C', repo, ...a], { env });
  const g = JSON.parse(spawnSync(process.execPath, [GATE, 'init', '--cwd', repo], { env, encoding: 'utf8' }).stdout).dir;
  return { env, repo, g };
}

const hook = (w, input, env = w.env) => spawnSync(process.execPath, [RUN, HOOK], { input: typeof input === 'string' ? input : JSON.stringify(input), env, encoding: 'utf8', timeout: 30000 });
const startRun = (w) => spawnSync(process.execPath, [RS, 'start', '--dir', w.g, '--cwd', w.repo, '--task', 't', '--gates', 'tests'], { env: w.env, encoding: 'utf8' });

test('an active run of this session blocks the stop with a reason; another session, no run, opt-out and bad input print nothing', (t) => {
  const w = world(t);
  const input = { session_id: SESSION, turn_id: 'turn-1', cwd: w.repo, hook_event_name: 'Stop' };
  let r = hook(w, input);
  assert.deepEqual([r.status, r.stdout], [0, ''], 'no run yet');
  assert.equal(startRun(w).status, 0);
  r = hook(w, input);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /banker ralph 실행이 아직 active 다/);
  assert.equal(hook(w, { ...input, session_id: '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0002' }).stdout, '');
  assert.equal(hook(w, input, { ...w.env, BANKER_NO_RALPH_CONTINUE: '1' }).stdout, '');
  for (const bad of ['', 'not json', '[]', JSON.stringify({ session_id: SESSION })]) {
    const b = hook(w, bad);
    assert.deepEqual([b.status, b.stdout], [0, ''], bad);
  }
});

// The command the plugin's codex/hooks.json gives Codex for this hook (the second Stop group), run as Codex runs it:
// sh with PLUGIN_ROOT on POSIX, PowerShell on Windows, from the session folder. A plugin folder under a temp folder is
// one the command refuses on purpose (it says why and does nothing), so there the test checks that refusal instead.
test('the plugin hook command in codex/hooks.json blocks the stop of an active run', (t) => {
  const w = world(t);
  assert.equal(startRun(w).status, 0);
  const root = realpathSync.native(fileURLToPath(new URL('..', import.meta.url)));
  const hooks = JSON.parse(readFileSync(join(root, 'codex', 'hooks.json'), 'utf8')).hooks.Stop;
  const entry = hooks.map((g) => g.hooks[0]).find((h) => /ralph-continue-codex\.mjs/.test(h.command));
  assert.ok(entry, 'a Stop group runs ralph-continue-codex.mjs');
  const input = JSON.stringify({ session_id: SESSION, turn_id: 'turn-cmd', cwd: w.repo, hook_event_name: 'Stop' });
  const env = { ...w.env, PLUGIN_ROOT: root };
  const r = WIN
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', entry.commandWindows], { cwd: w.repo, env, input, encoding: 'utf8', timeout: 60000 })
    : spawnSync('/bin/sh', ['-c', entry.command], { cwd: w.repo, env, input, encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  const temps = [tmpdir(), '/tmp', process.env.TEMP].filter(Boolean).map((p) => { try { return realpathSync.native(p); } catch { return p; } });
  if (temps.some((p) => root.toLowerCase().startsWith(`${p.toLowerCase()}${WIN ? '\\' : '/'}`))) {
    assert.match(r.stderr, /banker hooks skipped: the plugin folder is in a temp folder/);
    return;
  }
  assert.equal(JSON.parse(r.stdout).decision, 'block', r.stdout + r.stderr);
});
