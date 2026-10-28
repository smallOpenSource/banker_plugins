/*
 * telemetry-count-codex 훅 테스트 (node:test + node:assert). 파일명이 .test.mjs 라 배포에서 제외된다.
 * XDG_CONFIG_HOME(Windows 는 APPDATA)을 임시 폴더로 지정해 실제 홈을 건드리지 않는다. 네트워크 0.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { codexHomeOf, namesIn, turnKey, turnSkills } from './telemetry-count-codex.mjs';

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
  assert.deepEqual(turnSkills(f, 't1', 64), [], 'a turn start past the read cap is not guessed');
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
  for (const other of [`cat ${p}/hooks/x/SKILL.md`, 'cat /h/.codex/plugins/cache/m/other/1/skills/lfm/SKILL.md', 'cat /h/.codex/plugins/cache/../banker/1/skills/lfm/SKILL.md', 'cat /h/.codex/plugins/cache/m/banker/../skills/lfm/SKILL.md', `cat ${p}/command-skills/setup/SKILL.md`]) {
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
    call('cat /x/.codex/plugins/cache/banker-plugins/banker/0.22.0/skills/secret-here/SKILL.md')]);
  run(tmp, stop(f));
  assert.deepEqual(read(tmp).map((l) => l.split('\t')[0]).sort(), ['banker:lfm', 'banker:setup']);
});

test('a plugin hook finds the Codex home from PLUGIN_ROOT when the rollout is elsewhere', () => {
  const tmp = mkTmp();
  enable(tmp);
  const home = codexHome(tmp);
  const lfm = pluginSkill(home, 'skills', 'lfm');
  run(tmp, stop(rollout(tmp, [started('t1'), call(`cat ${lfm}`)])), { CODEX_HOME: 'not-here', PLUGIN_ROOT: join(home, 'plugins', 'cache', 'banker-plugins', 'banker', '0.22.0') });
  assert.deepEqual(read(tmp).map((l) => l.split('\t')[0]), ['banker:lfm']);
});
