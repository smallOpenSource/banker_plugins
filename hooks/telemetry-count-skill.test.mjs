/*
 * telemetry-count-skill 훅 테스트 (node:test + node:assert). 파일명이 .test.mjs 라 배포에서 제외된다.
 * XDG_CONFIG_HOME 을 mkdtemp 임시 디렉터리로 지정해 실제 홈/config 를 건드리지 않는다. 네트워크 0.
 * 각 테스트는 훅을 자식 프로세스로 spawn 하고, <tmp>/banker/usage-log 산출물만 검사한다.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LOG_MAX_LINES } from '../bin/lib/telemetry-config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_HOOK = join(HERE, 'telemetry-count-skill.mjs');

const tmps = [];
after(() => { for (const t of tmps) rmSync(t, { recursive: true, force: true }); });

function mkTmp() {
  const t = mkdtempSync(join(tmpdir(), 'banker-count-skill-'));
  tmps.push(t);
  return t;
}

const bankerDir = (tmp) => join(tmp, 'banker');
const usageLog = (tmp) => join(bankerDir(tmp), 'usage-log');

// countingActive() 가 true 가 되는 최소 상태(엔드포인트 설정 + opt-out 아님)로 만든다.
function enable(tmp, { endpoint = 'http://127.0.0.1:1/collect' } = {}) {
  mkdirSync(bankerDir(tmp), { recursive: true });
  writeFileSync(join(bankerDir(tmp), 'config.json'), JSON.stringify({ telemetry: true, endpoint }));
}

function runSkillCount(tmp, input, overrides = {}) {
  const env = { ...process.env, XDG_CONFIG_HOME: tmp };
  delete env.BANKER_NO_TELEMETRY;
  delete env.BANKER_TELEMETRY_ENDPOINT;
  Object.assign(env, overrides); // 마지막에 적용해 opt-out(BANKER_NO_TELEMETRY) 주입 가능.
  return spawnSync(process.execPath, [SKILL_HOOK], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env,
  });
}

test('opt-out(BANKER_NO_TELEMETRY=1)이면 무동작: 로그 파일조차 만들지 않는다', () => {
  const tmp = mkTmp();
  enable(tmp); // 엔드포인트 설정으로 활성 조건이지만 opt-out 이 우선해 countingActive false.
  const res = runSkillCount(tmp, { tool_name: 'Skill', tool_input: { skill: 'banker:compact-copy' } }, { BANKER_NO_TELEMETRY: '1' });
  assert.equal(res.status, 0);
  assert.ok(!existsSync(usageLog(tmp)), 'opt-out 훅은 로컬 쓰기조차 하지 않는다');
});

test('malformed stdin 이면 exit 0 (쓰기 없음)', () => {
  const tmp = mkTmp();
  enable(tmp);
  const res = runSkillCount(tmp, '{not json');
  assert.equal(res.status, 0);
  assert.ok(!existsSync(usageLog(tmp)), 'parse 실패는 어떤 추출/쓰기보다 앞서 종료된다');
});

test('활성 + tool_input.skill 이면 usage-log 에 `name\\thour` 한 줄 append (주 소스)', () => {
  const tmp = mkTmp();
  enable(tmp);
  const res = runSkillCount(tmp, {
    tool_name: 'Skill',
    tool_input: { skill: 'banker:compact-copy' },
    tool_response: { commandName: 'banker:compact-copy' },
  });
  assert.equal(res.status, 0);
  const line = readFileSync(usageLog(tmp), 'utf8');
  const [name, hourStr] = line.trim().split('\t');
  assert.equal(name, 'banker:compact-copy');
  assert.ok(/^\d+$/.test(hourStr), `hour 필드가 숫자가 아님: ${JSON.stringify(hourStr)}`);
});

test('폴백: tool_input.skill 없으면 tool_response.commandName 으로 기록', () => {
  const tmp = mkTmp();
  enable(tmp);
  const res = runSkillCount(tmp, { tool_name: 'Skill', tool_response: { commandName: 'banker:bar' } });
  assert.equal(res.status, 0);
  const [name] = readFileSync(usageLog(tmp), 'utf8').trim().split('\t');
  assert.equal(name, 'banker:bar');
});

test('banker 필터: tool_input.skill·tool_response.commandName 모두 banker: 접두가 아니면 무동작', () => {
  const tmp = mkTmp();
  enable(tmp);
  const res = runSkillCount(tmp, {
    tool_name: 'Skill',
    tool_input: { skill: 'other:foo' },
    tool_response: { commandName: 'other:foo' },
  });
  assert.equal(res.status, 0);
  assert.ok(!existsSync(usageLog(tmp)), 'banker: 접두가 아니면 기록하지 않는다');
});

test('hour 범위: 기록된 hour 는 0-23 정수이며 실행 시각 창(전/후) 안에 있다', () => {
  const tmp = mkTmp();
  enable(tmp);
  const before = new Date().getHours();
  const res = runSkillCount(tmp, { tool_name: 'Skill', tool_input: { skill: 'banker:foo' } });
  const after = new Date().getHours();
  assert.equal(res.status, 0);
  const [, hourStr] = readFileSync(usageLog(tmp), 'utf8').trim().split('\t');
  const hour = Number(hourStr);
  assert.ok(Number.isInteger(hour) && hour >= 0 && hour <= 23, `hour 범위 밖: ${hourStr}`);
  assert.ok(hour === before || hour === after, `hour(${hour}) 가 실행 창[${before},${after}] 밖`);
});

test('상한(LOG_MAX_LINES) 도달 시 append 스킵', () => {
  const tmp = mkTmp();
  enable(tmp);
  writeFileSync(usageLog(tmp), 'banker:x\t0\n'.repeat(LOG_MAX_LINES)); // 정확히 상한.
  const res = runSkillCount(tmp, { tool_name: 'Skill', tool_input: { skill: 'banker:foo' } });
  assert.equal(res.status, 0);
  const lines = readFileSync(usageLog(tmp), 'utf8').split('\n').filter(Boolean).length;
  assert.equal(lines, LOG_MAX_LINES, '상한에서는 더 쌓지 않는다(체크인이 비우면 재개)');
});
