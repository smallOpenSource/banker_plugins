/*
 * telemetry-count-codex 훅 테스트 (node:test + node:assert). 파일명이 .test.mjs 라 배포에서 제외된다.
 * XDG_CONFIG_HOME(Windows 는 APPDATA)을 임시 폴더로 지정해 실제 홈을 건드리지 않는다. 네트워크 0.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { codexHomeOf, countOnce, namesIn, turnKey, turnSkills, withTurnsLock } from './telemetry-count-codex.mjs';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), 'telemetry-count-codex.mjs');
const tmps = [];
after(() => { for (const t of tmps) rmSync(t, { recursive: true, force: true }); });
function mkTmp() {
  const t = mkdtempSync(join(tmpdir(), 'banker-count-codex-'));
  tmps.push(t);
  return t;
}
const bankerDir = (tmp) => join(tmp, 'banker');
const usageLog = (tmp) => join(bankerDir(tmp), 'usage-log');
const turnsFile = (tmp) => join(bankerDir(tmp), 'codex-count-turns');
function enable(tmp) {
  mkdirSync(bankerDir(tmp), { recursive: true });
  writeFileSync(join(bankerDir(tmp), 'config.json'), JSON.stringify({ telemetry: true, endpoint: 'http://127.0.0.1:1/collect' }));
}
// The Codex home of the run, with the banker skills a count may name installed.
function codexHome(tmp) {
  const home = join(tmp, 'codex');
  for (const n of ['ralph-qa', 'lineage', 'a']) {
    mkdirSync(join(home, 'skills', `banker-${n}`), { recursive: true });
    writeFileSync(join(home, 'skills', `banker-${n}`, 'SKILL.md'), '');
  }
  return home;
}
function run(tmp, input, overrides = {}) {
  const env = { ...process.env, XDG_CONFIG_HOME: tmp, APPDATA: tmp, CODEX_HOME: codexHome(tmp) };
  delete env.BANKER_NO_TELEMETRY;
  delete env.BANKER_TELEMETRY_ENDPOINT;
  Object.assign(env, overrides);
  return spawnSync(process.execPath, [HOOK], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', env });
}
const read = (tmp) => (existsSync(usageLog(tmp)) ? readFileSync(usageLog(tmp), 'utf8').split('\n').filter(Boolean) : []);
// A rollout as Codex 0.144.5 writes it: task_started opens a turn, tool calls are response_item *_call records.
const started = (turn) => ({ type: 'event_msg', payload: { type: 'task_started', turn_id: turn } });
const call = (cmd) => ({ type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd }) } });
const said = (text) => ({ type: 'event_msg', payload: { type: 'user_message', message: text } });
let r = 0;
function rollout(tmp, recs) {
  const f = join(tmp, `r${r++}.jsonl`);
  writeFileSync(f, `${recs.map((x) => JSON.stringify(x)).join('\n')}\n`);
  return f;
}
const stop = (file, turn = 't1') => ({ session_id: 's1', turn_id: turn, hook_event_name: 'Stop', transcript_path: file });
const cat = (name) => call(`cat /home/u/.codex/skills/banker-${name}/SKILL.md`);
// What Codex 0.144.5 puts in the rollout when the user names a skill with $banker-<name>: no tool call, a user-role message.
const injected = (name, body = '') => ({
  type: 'response_item',
  payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `<skill>\n<name>banker-${name}</name>\n<path>/h/.codex/skills/banker-${name}/SKILL.md</path>\n---\n${body}` }] },
});

test('skill names come from SKILL.md paths of banker skills only', () => {
  assert.deepEqual([...namesIn('cat /h/.codex/skills/banker-ralph-qa/SKILL.md')], ['banker:ralph-qa']);
  assert.deepEqual([...namesIn('C:\\Users\\u\\.codex\\skills\\banker-lineage\\SKILL.md')], ['banker:lineage']);
  assert.deepEqual([...namesIn('sed -n 1,5p skills/banker-a/SKILL.md skills/banker-a/SKILL.md skills/banker-b/SKILL.md')], ['banker:a', 'banker:b']);
  for (const other of ['cat ~/.codex/skills/hud/SKILL.md', 'cat skills/banker-x/README.md', 'cat skills/banker-a\\tb/SKILL.md']) {
    assert.deepEqual([...namesIn(other)], [], other);
  }
  assert.equal(turnKey({ session_id: 's', turn_id: 't' }), 's:t');
  assert.equal(turnKey({ session_id: 's\tx', turn_id: 't' }), null);
});

test('only this turn\'s tool calls count: earlier turns and what the user typed do not', () => {
  const tmp = mkTmp();
  const f = rollout(tmp, [started('t0'), cat('old'), started('t1'), said('see skills/banker-typed/SKILL.md'), cat('ralph-qa'), cat('ralph-qa'), cat('lineage')]);
  assert.deepEqual(turnSkills(f, 't1').sort(), ['banker:lineage', 'banker:ralph-qa']);
  assert.deepEqual(turnSkills(f, 'nope'), [], 'other turns started: this one alone is no shape change');
  assert.deepEqual(turnSkills(f, 't1', 64).sort(), ['banker:lineage', 'banker:ralph-qa'], 'a turn start before the line window is found by bytes');
  assert.deepEqual([...turnSkills(f, 't1', 64, { cap: 64 })], [], 'a turn start past the read cap is not guessed');
});

test('a turn is counted once even when Stop comes twice, and a new turn counts again', () => {
  const tmp = mkTmp();
  enable(tmp);
  const f = rollout(tmp, [started('t1'), cat('ralph-qa'), cat('ralph-qa'), started('t2'), cat('ralph-qa')]);
  assert.equal(run(tmp, stop(f)).status, 0);
  run(tmp, stop(f));
  assert.equal(read(tmp).length, 1, 'two reads and two Stops in one turn count once');
  assert.match(read(tmp)[0], /^banker:ralph-qa\t\d{1,2}$/);
  run(tmp, stop(f, 't2'));
  assert.equal(read(tmp).length, 2);
  assert.ok(readFileSync(join(bankerDir(tmp), 'used-skills.json'), 'utf8').includes('banker:ralph-qa'));
});

test('opt-out, no endpoint state, odd input and other tools write nothing', () => {
  const tmp = mkTmp();
  enable(tmp);
  const f = rollout(tmp, [started('t1'), cat('ralph-qa')]);
  run(tmp, stop(f), { BANKER_NO_TELEMETRY: '1' });
  run(tmp, '{not json');
  run(tmp, { session_id: 's1', turn_id: 't1' });
  run(tmp, { transcript_path: f, turn_id: 't1' });
  run(tmp, stop(join(tmp, 'missing')));
  assert.equal(read(tmp).length, 0);
  const res = run(tmp, stop(f));
  assert.deepEqual([res.status, res.stdout], [0, ''], 'never blocks or prints');
});

test('a link in place of the turn file is not written through', (t) => {
  const tmp = mkTmp();
  enable(tmp);
  const victim = join(tmp, 'victim');
  writeFileSync(victim, 'keep');
  try {
    symlinkSync(victim, turnsFile(tmp));
  } catch {
    t.skip('this account cannot make file links');
    return;
  }
  run(tmp, stop(rollout(tmp, [started('t1'), cat('a')])));
  assert.equal(readFileSync(victim, 'utf8'), 'keep');
});

test('a skill the user named with $ counts from the injected head only, not from paths in its body', () => {
  const tmp = mkTmp();
  const typed = { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'read skills/banker-typed/SKILL.md' }] } };
  const f = rollout(tmp, [started('t1'), typed, injected('setup', 'see ~/.codex/skills/banker-lineage/SKILL.md')]);
  assert.deepEqual(turnSkills(f, 't1'), ['banker:setup']);
});

test('a name that is no installed banker skill is not counted, so a command cannot send text out through the count', () => {
  const tmp = mkTmp();
  enable(tmp);
  run(tmp, stop(rollout(tmp, [started('t1'), call('echo skills/banker-secret-data-here/SKILL.md'), cat('lineage')])));
  assert.deepEqual(read(tmp).map((l) => l.split('\t')[0]), ['banker:lineage']);
});

test('a pipe given as the transcript is not waited on', { skip: process.platform === 'win32' && 'POSIX pipes' }, () => {
  const tmp = mkTmp();
  enable(tmp);
  const fifo = join(tmp, 'p.jsonl');
  spawnSync('mkfifo', [fifo]);
  const res = run(tmp, stop(fifo));
  assert.deepEqual([res.status, res.signal], [0, null]);
  assert.equal(read(tmp).length, 0);
});

test('the Codex home comes from where the rollout sits, so a relative CODEX_HOME does not matter', () => {
  const tmp = mkTmp();
  enable(tmp);
  const home = codexHome(tmp);
  const day = join(home, 'sessions', '2026', '10', '28');
  mkdirSync(day, { recursive: true });
  const f = join(day, 'rollout-x.jsonl');
  writeFileSync(f, `${[started('t1'), cat('lineage')].map((x) => JSON.stringify(x)).join('\n')}\n`);
  assert.equal(codexHomeOf(f, {}), home);
  assert.equal(codexHomeOf('rel/x.jsonl', { CODEX_HOME: '/c' }), '/c');
  run(tmp, stop(f), { CODEX_HOME: 'not-here' });
  assert.deepEqual(read(tmp).map((l) => l.split('\t')[0]), ['banker:lineage']);
});

test('a turn that started far from the end is still found by widening the read', () => {
  const tmp = mkTmp();
  const pad = { type: 'event_msg', payload: { type: 'token_count', pad: 'x'.repeat(4000) } };
  const f = rollout(tmp, [started('t1'), cat('lineage'), ...Array(600).fill(pad)]);
  assert.deepEqual(turnSkills(f, 't1'), ['banker:lineage'], 'about 2.4 MB after the turn start, past the first 1 MB read');
});

test('a Codex version whose record has no turn start is noted once for the next session start', () => {
  const tmp = mkTmp();
  enable(tmp);
  const meta = { type: 'session_meta', payload: { id: 's1', cli_version: '9.9.9' } };
  const f = rollout(tmp, [meta, { type: 'event_msg', payload: { type: 'turn_begun_v2', id: 't1' } }, cat('lineage')]);
  run(tmp, stop(f));
  const miss = join(bankerDir(tmp), 'codex-shape-miss.json');
  assert.deepEqual(JSON.parse(readFileSync(miss, 'utf8')), { version: '9.9.9', notified: false });
  assert.equal(read(tmp).length, 0);
  const notify = join(dirname(HOOK), 'update-notify.mjs');
  const env = { ...process.env, XDG_CONFIG_HOME: tmp, APPDATA: tmp, BANKER_NO_UPDATE_CHECK: '1' };
  assert.equal(spawnSync(process.execPath, [notify], { input: '{}', encoding: 'utf8', env }).stdout, '', 'Claude Code never shows it');
  const first = spawnSync(process.execPath, [notify, '--codex'], { input: '{}', encoding: 'utf8', env });
  assert.match(JSON.parse(first.stdout).systemMessage, /Codex 9\.9\.9 의 기록 형식을 읽지 못함/);
  assert.equal(spawnSync(process.execPath, [notify, '--codex'], { input: '{}', encoding: 'utf8', env }).stdout, '', 'once');
  run(tmp, stop(rollout(tmp, [{ type: 'session_meta', payload: { id: 's1', cli_version: '9.9.9' } }, started('t1'), cat('lineage')])));
  assert.equal(JSON.parse(readFileSync(miss, 'utf8')).notified, true, 'a readable record leaves the note as it was');
});

test('a turn whose start alone is missing is no shape change, and nothing is noted', () => {
  const tmp = mkTmp();
  enable(tmp);
  const f = rollout(tmp, [{ type: 'session_meta', payload: { id: 's1', cli_version: '0.144.5' } }, started('t0'), cat('lineage')]);
  assert.deepEqual(turnSkills(f, 't1'), []);
  run(tmp, stop(f));
  assert.ok(!existsSync(join(bankerDir(tmp), 'codex-shape-miss.json')));
});

// Codex plugin install (codex plugin add banker@<marketplace>): the skills sit in the plugin cache under three folders.
function pluginSkill(home, folder, name, mkt = 'banker-plugins', ver = '0.22.0') {
  writeFileSync(join(home, 'config.toml'), '[plugins."banker@banker-plugins"]\nenabled = true\n');
  const dir = join(home, 'plugins', 'cache', mkt, 'banker', ver, ...folder.split('/'), name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), '');
  return join(dir, 'SKILL.md');
}
// What Codex puts in the rollout for $banker:<name>.
const injectedPlugin = (path, name) => ({
  type: 'response_item',
  payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `<skill>\n<name>banker:${name}</name>\n<path>${path}</path>\n---\n` }] },
});

test('plugin skill paths name the skill and the file that proves it is installed', () => {
  const p = '/h/.codex/plugins/cache/banker-plugins/banker/0.22.0';
  assert.deepEqual([...namesIn(`cat ${p}/skills/lfm/SKILL.md`)], ['banker:lfm\tplugins/cache/banker-plugins/banker/0.22.0/skills/lfm/SKILL.md']);
  assert.deepEqual([...namesIn(`cat ${p}/codex/skills/progress/SKILL.md`)], ['banker:progress\tplugins/cache/banker-plugins/banker/0.22.0/codex/skills/progress/SKILL.md']);
  assert.deepEqual([...namesIn('C:\\Users\\u\\.codex\\plugins\\cache\\m\\banker\\1.0\\codex\\command-skills\\setup\\SKILL.md')], ['banker:setup\tplugins/cache/m/banker/1.0/codex/command-skills/setup/SKILL.md']);
  for (const other of [`cat ${p}/hooks/x/SKILL.md`, `cat ${p}/skills/LFM/SKILL.md`, 'cat /h/.codex/plugins/cache/m/other/1/skills/lfm/SKILL.md', 'cat /h/.codex/plugins/cache/../banker/1/skills/lfm/SKILL.md', 'cat /h/.codex/plugins/cache/m/banker/../skills/lfm/SKILL.md', `cat ${p}/command-skills/setup/SKILL.md`]) {
    assert.deepEqual([...namesIn(other)], [], other);
  }
});

test('a plugin skill counts by its name when its SKILL.md is in this home\'s plugin cache, once per turn', () => {
  const tmp = mkTmp();
  enable(tmp);
  const home = codexHome(tmp);
  const lfm = pluginSkill(home, 'skills', 'lfm');
  const setup = pluginSkill(home, 'codex/command-skills', 'setup');
  const f = rollout(tmp, [started('t1'), injectedPlugin(lfm, 'lfm'), call(`cat ${lfm}`), call(`cat ${setup}`),
    call(`cat ${home}/plugins/cache/banker-plugins/banker/0.21.0/skills/lfm/SKILL.md`),
    call(`cat ${pluginSkill(home, 'skills', 'lineage', 'other-mkt')}`),
    call('cat /x/.codex/plugins/cache/banker-plugins/banker/0.22.0/skills/secret-here/SKILL.md')]);
  run(tmp, stop(f));
  assert.deepEqual(read(tmp).map((l) => l.split('\t')[0]).sort(), ['banker:lfm', 'banker:setup']);
});

// Codex names three skills apart (codex/manifest.json codexName). Their use counts by the Claude name on both routes,
// so the personalized notice (skill-changes.json, Claude names) matches what Codex users ran.
test('a skill Codex names apart counts by its Claude name, on the npm route and the plugin route (codex/renamed-skills)', () => {
  const tmp = mkTmp();
  enable(tmp);
  const home = codexHome(tmp);
  mkdirSync(join(home, 'skills', 'banker-setup-omx'), { recursive: true });
  writeFileSync(join(home, 'skills', 'banker-setup-omx', 'SKILL.md'), '');
  const hud = pluginSkill(home, 'codex/renamed-skills', 'setup-omx-hud');
  const wiki = pluginSkill(home, 'codex/renamed-skills', 'append_wiki');
  assert.deepEqual([...namesIn(`cat ${hud}`)], ['banker:setup-omx-hud\tplugins/cache/banker-plugins/banker/0.22.0/codex/renamed-skills/setup-omx-hud/SKILL.md']);
  const f = rollout(tmp, [started('t1'), injected('setup-omx'), call(`cat ${hud}`), injectedPlugin(wiki, 'append_wiki'),
    cat('setup-omc'), call(`cat ${home}/plugins/cache/banker-plugins/banker/0.22.0/codex/renamed-skills/omx-reference/SKILL.md`)]);
  run(tmp, stop(f));
  assert.deepEqual(read(tmp).map((l) => l.split('\t')[0]).sort(), ['banker:append_wiki', 'banker:setup-omc', 'banker:setup-omc-hud']);
});

test('the names map the hooks read is the one codex/manifest.json gives', async () => {
  const { CODEX_NAMES, CLAUDE_NAMES } = await import('../bin/lib/codex-names.mjs');
  const m = JSON.parse(readFileSync(join(dirname(HOOK), '..', 'codex', 'manifest.json'), 'utf8'));
  const want = Object.fromEntries(m.surfaces.filter((s) => s.codexName).map((s) => [s.name, s.codexName]));
  assert.deepEqual({ ...CODEX_NAMES }, want);
  assert.deepEqual(Object.keys(want).sort(), ['omc-reference', 'setup-omc', 'setup-omc-hud']);
  for (const [claude, codex] of Object.entries(want)) assert.equal(CLAUDE_NAMES[codex], claude);
});

test('a plugin hook finds the Codex home from PLUGIN_ROOT when the rollout is elsewhere', () => {
  const tmp = mkTmp();
  enable(tmp);
  const home = codexHome(tmp);
  const lfm = pluginSkill(home, 'skills', 'lfm');
  run(tmp, stop(rollout(tmp, [started('t1'), call(`cat ${lfm}`)])), { CODEX_HOME: 'not-here', PLUGIN_ROOT: join(home, 'plugins', 'cache', 'banker-plugins', 'banker', '0.22.0') });
  assert.deepEqual(read(tmp).map((l) => l.split('\t')[0]), ['banker:lfm']);
});

// The npm hook and the plugin hook both run at Stop when both routes are installed. They count one turn once.
test('Stop hooks that run at once for one turn count it once', async () => {
  const tmp = mkTmp();
  enable(tmp);
  const { spawn } = await import('node:child_process');
  const env = { ...process.env, XDG_CONFIG_HOME: tmp, APPDATA: tmp, CODEX_HOME: codexHome(tmp) };
  delete env.BANKER_NO_TELEMETRY;
  delete env.BANKER_TELEMETRY_ENDPOINT;
  for (let round = 0; round < 10; round++) {
    const input = JSON.stringify(stop(rollout(tmp, [started(`t${round}`), cat('ralph-qa')]), `t${round}`));
    await Promise.all([0, 1, 2].map(() => new Promise((res) => {
      const c = spawn(process.execPath, [HOOK], { env, stdio: ['pipe', 'ignore', 'ignore'] });
      c.on('close', res);
      c.stdin.end(input);
    })));
    assert.equal(read(tmp).length, round + 1, `round ${round}: ${read(tmp).join(' | ')}`);
  }
  assert.ok(!existsSync(`${turnsFile(tmp)}.lock`), 'the lock is let go');
});

test('the turn lock waits for a live holder, then leaves the turn to it; a dead holder\'s lock is taken over', () => {
  const tmp = mkTmp();
  const prev = process.env.XDG_CONFIG_HOME;
  const prevApp = process.env.APPDATA;
  process.env.XDG_CONFIG_HOME = tmp;
  process.env.APPDATA = tmp;
  try {
    const lock = `${turnsFile(tmp)}.lock`;
    mkdirSync(lock, { recursive: true });
    let ran = false;
    const t0 = Date.now();
    assert.deepEqual(withTurnsLock(() => { ran = true; return ['x']; }, { wait: 200 }), ['x']);
    assert.ok(ran && Date.now() - t0 >= 200, 'a held lock is waited on, then the turn marks decide without it');
    assert.ok(existsSync(lock), 'another hook\'s lock stays');
    const old = (Date.now() - 60_000) / 1000;
    utimesSync(lock, old, old);
    assert.deepEqual(withTurnsLock(() => ['counted'], { wait: 200 }), ['counted'], 'a lock older than a hook can live is taken over');
    assert.ok(!existsSync(lock));
    const seven = (Date.now() - 7000) / 1000;
    mkdirSync(lock);
    utimesSync(lock, seven, seven);
    assert.deepEqual(withTurnsLock(() => ['counted'], { wait: 200 }), ['counted'], 'a holder the 5 s hook limit killed does not cost the next turn');
    assert.deepEqual(readdirSync(join(tmp, 'banker')).filter((n) => n.includes('.lock')), [], 'nothing of the old lock is left');
    // A file where the config folder goes: counting goes on without the lock instead of waiting at every Stop.
    const other = mkTmp();
    writeFileSync(join(other, 'banker'), '');
    process.env.XDG_CONFIG_HOME = other;
    process.env.APPDATA = other;
    const t1 = Date.now();
    assert.deepEqual(withTurnsLock(() => ['ran'], { wait: 2000 }), ['ran']);
    assert.ok(Date.now() - t1 < 1000, 'no wait');
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prev;
    if (prevApp === undefined) delete process.env.APPDATA; else process.env.APPDATA = prevApp;
  }
});

// Two hooks take over one dead holder's lock: B looks (old), A moves it away and takes the lock anew, B then moves A's
// fresh lock. B must see that what it moved is fresh and leave the turn to A, without putting it back (a third hook
// may have taken the name meanwhile).
test('a hook that moved away a lock another hook had just taken backs off and does not count', async () => {
  const tmp = mkTmp();
  const fs = (await import('node:fs')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const prev = process.env.XDG_CONFIG_HOME;
  const prevApp = process.env.APPDATA;
  process.env.XDG_CONFIG_HOME = tmp;
  process.env.APPDATA = tmp;
  const lock = `${turnsFile(tmp)}.lock`;
  mkdirSync(lock, { recursive: true });
  const old = (Date.now() - 60_000) / 1000;
  utimesSync(lock, old, old);
  const real = fs.renameSync;
  let raced = false;
  fs.renameSync = (from, to) => {
    if (!raced && String(from) === lock) { raced = true; fs.rmdirSync(lock); fs.mkdirSync(lock); }
    return real(from, to);
  };
  syncBuiltinESMExports();
  try {
    assert.deepEqual(withTurnsLock(() => ['counted'], { wait: 200 }), [], 'the turn is left to the hook that holds the lock');
  } finally {
    fs.renameSync = real;
    syncBuiltinESMExports();
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prev;
    if (prevApp === undefined) delete process.env.APPDATA; else process.env.APPDATA = prevApp;
  }
  assert.ok(raced);
  const moved = readdirSync(join(tmp, 'banker')).filter((n) => n.includes('.lock.stale-'));
  assert.equal(moved.length, 1, 'the fresh lock it moved stays aside, not put back over the name');
  // The next hook that takes the lock clears what was moved aside once it is old.
  const aged = (Date.now() - 60_000) / 1000;
  utimesSync(join(tmp, 'banker', moved[0]), aged, aged);
  process.env.XDG_CONFIG_HOME = tmp;
  process.env.APPDATA = tmp;
  try {
    assert.deepEqual(withTurnsLock(() => ['counted'], { wait: 200 }), ['counted']);
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prev;
    if (prevApp === undefined) delete process.env.APPDATA; else process.env.APPDATA = prevApp;
  }
  assert.deepEqual(readdirSync(join(tmp, 'banker')).filter((n) => n.includes('.lock')), [], 'nothing of the locks is left');
});

// A hook lets go only of its own lock: if its lock was moved away and another hook took the name meanwhile, that lock stays.
test('a hook lets go only of a lock that holds its own owner mark', () => {
  const tmp = mkTmp();
  const prev = process.env.XDG_CONFIG_HOME;
  const prevApp = process.env.APPDATA;
  process.env.XDG_CONFIG_HOME = tmp;
  process.env.APPDATA = tmp;
  const lock = `${turnsFile(tmp)}.lock`;
  try {
    assert.deepEqual(withTurnsLock(() => {
      assert.ok(existsSync(join(lock, 'owner')), 'the lock carries an owner mark while held');
      rmSync(lock, { recursive: true });
      mkdirSync(lock);
      writeFileSync(join(lock, 'owner'), 'another hook');
      return ['counted'];
    }), ['counted']);
    assert.equal(readFileSync(join(lock, 'owner'), 'utf8'), 'another hook', "the other hook's lock is not let go");
    rmSync(lock, { recursive: true });
    withTurnsLock(() => []);
    assert.ok(!existsSync(lock), 'its own lock is let go');
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prev;
    if (prevApp === undefined) delete process.env.APPDATA; else process.env.APPDATA = prevApp;
  }
});

// A turn that wrote more than 32 MB after it started: the start is found by bytes before the 32 MB window.
function bigRollout(tmp, mb) {
  const f = join(tmp, `big${r++}.jsonl`);
  const fd = openSync(f, 'w');
  try {
    writeSync(fd, `${JSON.stringify(started('t1'))}\n${JSON.stringify(injected('lineage'))}\n`);
    const pad = `${JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: '한글 기록 채움 '.repeat(4000) } })}\n`;
    const line = Buffer.from(pad);
    for (let n = 0; n < (mb << 20); n += line.length) writeSync(fd, line);
    writeSync(fd, `${JSON.stringify(cat('ralph-qa'))}\n`);
  } finally {
    closeSync(fd);
  }
  return f;
}

test('a turn start more than 32 MB from the end is found by bytes, and a start past the cap is noted, not guessed', () => {
  const tmp = mkTmp();
  const f = bigRollout(tmp, 40);
  assert.deepEqual(turnSkills(f, 't1').sort(), ['banker:lineage', 'banker:ralph-qa'], '40 MB of Korean text after the start');
  const miss = turnSkills(f, 't1', 1 << 20, { cap: 8 << 20 });
  assert.deepEqual([...miss], []);
  assert.equal(miss.far, true);
  enable(tmp);
  const res = run(tmp, stop(f));
  assert.equal(res.status, 0);
  assert.deepEqual(read(tmp).map((l) => l.split('\t')[0]).sort(), ['banker:lineage', 'banker:ralph-qa']);
});

test('a turn start past the read cap leaves a one-line note and counts nothing', () => {
  const tmp = mkTmp();
  const f = bigRollout(tmp, 3);
  const prev = [process.env.XDG_CONFIG_HOME, process.env.APPDATA];
  process.env.XDG_CONFIG_HOME = tmp;
  process.env.APPDATA = tmp;
  try {
    enable(tmp);
    assert.equal(turnSkills(f, 't1', 1 << 20, { cap: 2 << 20 }).far, true);
    assert.deepEqual(countOnce(stop(f), { max: 1 << 20, cap: 2 << 20 }), []);
  } finally {
    [process.env.XDG_CONFIG_HOME, process.env.APPDATA] = prev;
    if (prev[0] === undefined) delete process.env.XDG_CONFIG_HOME;
    if (prev[1] === undefined) delete process.env.APPDATA;
  }
  const note = readFileSync(join(bankerDir(tmp), 'codex-count-note'), 'utf8');
  assert.match(note, /^\S+\ts1:t1\t턴 시작이 기록 끝 256 MB 밖, 이 턴은 세지 않음\n$/);
  assert.equal(read(tmp).length, 0);
});

test('the byte search finds a turn id that straddles a chunk border', () => {
  const tmp = mkTmp();
  const f = bigRollout(tmp, 1);
  const size = readFileSync(f).length;
  const off = readFileSync(f).indexOf('"t1"');
  const max = 64 << 10;
  for (const into of [1, 2, 3]) {
    const chunk = size - max - off - into; // the first chunk starts inside "t1"
    assert.deepEqual(turnSkills(f, 't1', max, { chunk }).sort(), ['banker:lineage', 'banker:ralph-qa'], `border ${into} bytes into the id`);
  }
});

const markOf = (key) => createHash('sha256').update(key).digest('hex').slice(0, 32);
const marksDir = (tmp) => join(bankerDir(tmp), 'codex-count-turns.d');
function hookEnv(tmp) {
  const env = { ...process.env, XDG_CONFIG_HOME: tmp, APPDATA: tmp, CODEX_HOME: codexHome(tmp) };
  delete env.BANKER_NO_TELEMETRY;
  delete env.BANKER_TELEMETRY_ENDPOINT;
  return env;
}
const OLD_HOOK = join(dirname(HOOK), '..', 'scripts', 'test-fixtures', 'count-codex-0.22.0', 'telemetry-count-codex.mjs');
const runAsync = (hook, env, input) => new Promise((res) => {
  const c = spawn(process.execPath, [hook], { env, stdio: ['pipe', 'ignore', 'ignore'] });
  c.on('close', res);
  c.stdin.end(input);
});

for (const [what, hooks] of [['two hooks of this version', [HOOK, HOOK]], ['a 0.22.0 hook and a hook of this version', [OLD_HOOK, HOOK]]]) {
  test(`${what} that run at once for one turn count it once, 100 times`, async () => {
    const tmp = mkTmp();
    enable(tmp);
    const env = hookEnv(tmp);
    for (let round = 0; round < 100; round++) {
      const input = JSON.stringify(stop(rollout(tmp, [started(`t${round}`), cat('ralph-qa')]), `t${round}`));
      await Promise.all(hooks.map((h) => runAsync(h, env, input)));
      assert.equal(read(tmp).length, round + 1, `round ${round}: ${read(tmp).join(' | ')}`);
    }
  });
}

test('with the lock held by a live hook, hooks that run at once still count a turn once by the marks', async () => {
  const tmp = mkTmp();
  enable(tmp);
  mkdirSync(`${turnsFile(tmp)}.lock`, { recursive: true }); // a live holder: fresh, so not taken over
  const env = hookEnv(tmp);
  const rounds = [...Array(10).keys()];
  await Promise.all(rounds.map((n) => {
    const input = JSON.stringify(stop(rollout(tmp, [started(`t${n}`), cat('lineage')]), `t${n}`));
    return Promise.all([runAsync(HOOK, env, input), runAsync(HOOK, env, input)]);
  }));
  assert.equal(read(tmp).length, 10, read(tmp).join(' | '));
  assert.equal(readdirSync(marksDir(tmp)).length, 10);
});

test('a turn already in the old turn file is marked but not counted again', () => {
  const tmp = mkTmp();
  enable(tmp);
  writeFileSync(turnsFile(tmp), 's1:t1\tbanker:a\n');
  run(tmp, stop(rollout(tmp, [started('t1'), cat('a')])));
  assert.equal(read(tmp).length, 0);
  assert.ok(existsSync(join(marksDir(tmp), markOf('s1:t1\tbanker:a'))), 'the mark keeps later hooks of this version from counting it');
});

test('a link for the marks folder, a link in place of a mark, and old marks', (t) => {
  const tmp = mkTmp();
  enable(tmp);
  const elsewhere = join(tmp, 'elsewhere');
  mkdirSync(elsewhere);
  try {
    symlinkSync(elsewhere, marksDir(tmp), 'dir');
  } catch {
    t.skip('this account cannot make links');
    return;
  }
  run(tmp, stop(rollout(tmp, [started('t1'), cat('a')])));
  assert.equal(read(tmp).length, 0, 'a linked marks folder is not trusted');
  assert.deepEqual(readdirSync(elsewhere), [], 'nothing is made through the link');
  rmSync(marksDir(tmp));
  mkdirSync(marksDir(tmp));
  symlinkSync(join(tmp, 'gone'), join(marksDir(tmp), markOf('s1:t2\tbanker:a')));
  run(tmp, stop(rollout(tmp, [started('t2'), cat('a')]), 't2'));
  assert.equal(read(tmp).length, 0, 'a broken link where the mark goes is no mark of this hook');
  assert.ok(!existsSync(join(tmp, 'gone')), 'and the link is not followed');
  const stale = join(marksDir(tmp), 'f'.repeat(32));
  writeFileSync(stale, '');
  const days = (Date.now() - 3 * 24 * 3600 * 1000) / 1000;
  utimesSync(stale, days, days);
  run(tmp, stop(rollout(tmp, [started('t3'), cat('a')]), 't3'));
  assert.equal(read(tmp).length, 1);
  assert.ok(!existsSync(stale), 'marks older than two days are cleared');
});

// node:crypto 없이 빌드한 Node 를 흉내 내는 시험 도구(--import). 표지 이름은 그때도 만들어지고 한 번만 센다.
test('without node:crypto the marks still decide, once per turn', () => {
  const tmp = mkTmp();
  enable(tmp);
  const env = { ...hookEnv(tmp), NO_CRYPTO_ONLY: '1', NO_CRYPTO_MARK: join(tmp, 'crypto-mark') };
  const pre = pathToFileURL(join(dirname(HOOK), '..', 'scripts', 'test-fixtures', 'no-crypto.mjs')).href;
  const input = JSON.stringify(stop(rollout(tmp, [started('t1'), cat('a')])));
  for (let i = 0; i < 2; i++) {
    const res = spawnSync(process.execPath, ['--import', pre, HOOK], { input, encoding: 'utf8', env });
    assert.equal(res.status, 0, res.stderr);
  }
  assert.equal(read(tmp).length, 1);
  assert.match(readFileSync(join(tmp, 'crypto-mark'), 'utf8'), /crypto/, 'the hook did try node:crypto and went on without it');
  assert.equal(readdirSync(marksDir(tmp)).length, 1);
});

// Plan S11 B9: where the hook runs (this script, its folder, node) under a config.toml writable_roots entry is a place a
// Codex session can change from the sandbox, and Codex runs the hook outside it: the hook counts nothing and says why.
test('a hook under a sandbox writable root counts nothing and says why on stderr', () => {
  const tmp = mkTmp();
  enable(tmp);
  const file = rollout(tmp, [started('t1'), cat('ralph-qa')]);
  const home = codexHome(tmp);
  writeFileSync(join(home, 'config.toml'), `[sandbox_workspace_write]\nwritable_roots = [${JSON.stringify(dirname(dirname(HOOK)))}]\n`);
  let res = run(tmp, stop(file), { CODEX_HOME: home });
  assert.equal(res.status, 0);
  assert.equal(res.stdout, '');
  assert.match(res.stderr, /^banker hooks skipped: .* is under the sandbox writable root /);
  assert.deepEqual(read(tmp), [], 'nothing counted');
  writeFileSync(join(home, 'config.toml'), `[sandbox_workspace_write]\nwritable_roots = [${JSON.stringify(join(tmp, 'other'))}]\n`);
  res = run(tmp, stop(file), { CODEX_HOME: home });
  assert.equal(res.stderr, '');
  assert.equal(read(tmp).length, 1, 'a writable root elsewhere changes nothing');
});
