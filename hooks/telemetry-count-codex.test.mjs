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

import { skillNames, turnKey } from './telemetry-count-codex.mjs';

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
function run(tmp, input, overrides = {}) {
  const env = { ...process.env, XDG_CONFIG_HOME: tmp, APPDATA: tmp };
  delete env.BANKER_NO_TELEMETRY;
  delete env.BANKER_TELEMETRY_ENDPOINT;
  Object.assign(env, overrides);
  return spawnSync(process.execPath, [HOOK], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', env });
}
const read = (tmp) => (existsSync(usageLog(tmp)) ? readFileSync(usageLog(tmp), 'utf8').split('\n').filter(Boolean) : []);
const cat = (name, turn = 't1') => ({
  session_id: 's1', turn_id: turn, hook_event_name: 'PreToolUse', tool_name: 'Bash',
  tool_input: { command: `cat /home/u/.codex/skills/banker-${name}/SKILL.md` },
});

test('skill names come from SKILL.md paths of banker skills only', () => {
  assert.deepEqual(skillNames(cat('ralph-qa')), ['banker:ralph-qa']);
  assert.deepEqual(skillNames({ tool_input: { path: 'C:\\Users\\u\\.codex\\skills\\banker-lineage\\SKILL.md' } }), ['banker:lineage']);
  assert.deepEqual(skillNames({ tool_input: { command: 'sed -n 1,5p skills/banker-a/SKILL.md skills/banker-a/SKILL.md skills/banker-b/SKILL.md' } }),
    ['banker:a', 'banker:b']);
  for (const other of ['cat ~/.codex/skills/hud/SKILL.md', 'cat skills/banker-x/README.md', 'cat skills/banker-a\tb/SKILL.md']) {
    assert.deepEqual(skillNames({ tool_input: { command: other } }), [], other);
  }
  assert.equal(turnKey({ session_id: 's', turn_id: 't' }), 's:t');
  assert.equal(turnKey({ session_id: 's\tx', turn_id: 't' }), null);
});

test('a skill read once per turn is counted once, and again in a new turn', () => {
  const tmp = mkTmp();
  enable(tmp);
  assert.equal(run(tmp, cat('ralph-qa')).status, 0);
  run(tmp, cat('ralph-qa'));
  assert.equal(read(tmp).length, 1, 'two reads in one turn count once');
  assert.match(read(tmp)[0], /^banker:ralph-qa\t\d{1,2}$/);
  run(tmp, cat('ralph-qa', 't2'));
  assert.equal(read(tmp).length, 2);
  assert.ok(readFileSync(join(bankerDir(tmp), 'used-skills.json'), 'utf8').includes('banker:ralph-qa'));
});

test('opt-out, no endpoint state, odd input and other tools write nothing', () => {
  const tmp = mkTmp();
  enable(tmp);
  run(tmp, cat('ralph-qa'), { BANKER_NO_TELEMETRY: '1' });
  run(tmp, '{not json');
  run(tmp, { session_id: 's', turn_id: 't', tool_input: { command: 'ls' } });
  run(tmp, { tool_input: { command: 'cat skills/banker-a/SKILL.md' } });
  assert.equal(read(tmp).length, 0);
  const res = run(tmp, cat('x'));
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
  run(tmp, cat('a'));
  assert.equal(readFileSync(victim, 'utf8'), 'keep');
});
