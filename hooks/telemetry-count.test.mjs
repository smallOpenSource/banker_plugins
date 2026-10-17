/*
 * telemetry-count 훅 테스트 (node:test + node:assert). 파일명이 .test.mjs 라 배포에서 제외된다.
 * XDG_CONFIG_HOME 을 mkdtemp 임시 디렉터리로 지정해 실제 홈/config 를 건드리지 않는다. 네트워크 0.
 * 각 테스트는 훅을 자식 프로세스로 spawn 하고, <tmp>/banker/usage-log 산출물만 검사한다.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LOG_MAX_LINES } from '../bin/lib/telemetry-config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const COUNT_HOOK = join(HERE, 'telemetry-count.mjs');

const tmps = [];
after(() => { for (const t of tmps) rmSync(t, { recursive: true, force: true }); });

function mkTmp() {
  const t = mkdtempSync(join(tmpdir(), 'banker-count-'));
  tmps.push(t);
  return t;
}

const bankerDir = (tmp) => join(tmp, 'banker');
const usageLog = (tmp) => join(bankerDir(tmp), 'usage-log');
const usedSkills = (tmp) => join(bankerDir(tmp), 'used-skills.json'); // 개인화용 로컬 집합(전송 안 함).

// countingActive() 가 true 가 되는 최소 상태(엔드포인트 설정 + opt-out 아님)로 만든다.
function enable(tmp, { endpoint = 'http://127.0.0.1:1/collect' } = {}) {
  mkdirSync(bankerDir(tmp), { recursive: true });
  writeFileSync(join(bankerDir(tmp), 'config.json'), JSON.stringify({ telemetry: true, endpoint }));
}

// opts 는 spawnSync 옵션(예: FIFO 에서 멈추는지 보려는 timeout).
function runCount(tmp, input, overrides = {}, opts = {}) {
  const env = { ...process.env, XDG_CONFIG_HOME: tmp };
  delete env.BANKER_NO_TELEMETRY;
  delete env.BANKER_TELEMETRY_ENDPOINT;
  Object.assign(env, overrides); // 마지막에 적용해 opt-out(BANKER_NO_TELEMETRY) 주입 가능.
  return spawnSync(process.execPath, [COUNT_HOOK], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env,
    ...opts,
  });
}

test('opt-out(BANKER_NO_TELEMETRY=1)이면 무동작: 로그 파일조차 만들지 않는다', () => {
  const tmp = mkTmp();
  enable(tmp); // 엔드포인트 설정으로 활성 조건이지만 opt-out 이 우선해 countingActive false.
  const res = runCount(tmp, { command_name: 'banker:foo', command_source: 'plugin' }, { BANKER_NO_TELEMETRY: '1' });
  assert.equal(res.status, 0);
  assert.ok(!existsSync(usageLog(tmp)), 'opt-out 훅은 로컬 쓰기조차 하지 않는다');
  assert.ok(!existsSync(usedSkills(tmp)), 'opt-out(countingActive false)이면 used-skills 도 미기록');
});

test('malformed stdin 이면 exit 0 (쓰기 없음)', () => {
  const tmp = mkTmp();
  enable(tmp);
  const res = runCount(tmp, '{not json');
  assert.equal(res.status, 0);
  assert.ok(!existsSync(usageLog(tmp)), 'parse 실패는 어떤 추출/쓰기보다 앞서 종료된다');
});

test('활성 + command_name/command_source=plugin 이면 usage-log 에 `name\\thour` 한 줄 append', () => {
  const tmp = mkTmp();
  enable(tmp);
  const res = runCount(tmp, { command_name: 'banker:foo', command_args: '', command_source: 'plugin' });
  assert.equal(res.status, 0);
  const line = readFileSync(usageLog(tmp), 'utf8');
  const [name, hourStr] = line.trim().split('\t');
  assert.equal(name, 'banker:foo');
  assert.ok(/^\d+$/.test(hourStr), `hour 필드가 숫자가 아님: ${JSON.stringify(hourStr)}`);
});

test('활성 + banker 커맨드면 used-skills.json 에 이름 union 기록(개인화용·전송 안 함·중복 무증가)', () => {
  const tmp = mkTmp();
  enable(tmp);
  runCount(tmp, { command_name: 'banker:foo', command_source: 'plugin' });
  runCount(tmp, { command_name: 'banker:foo', command_source: 'plugin' }); // 같은 이름 두 번.
  runCount(tmp, { command_name: 'banker:bar', command_source: 'plugin' });
  const set = JSON.parse(readFileSync(usedSkills(tmp), 'utf8'));
  assert.ok(Array.isArray(set));
  assert.deepEqual([...set].sort(), ['banker:bar', 'banker:foo'], 'union(중복 없이 두 이름)');
});

test('banker 필터 미매치면 used-skills 도 미기록', () => {
  const tmp = mkTmp();
  enable(tmp);
  runCount(tmp, { command_name: 'other:foo', command_source: 'plugin' });
  assert.ok(!existsSync(usedSkills(tmp)), 'banker: 접두 아니면 used-skills 미기록');
});

test('banker 필터: command_name 이 banker: 접두가 아니면 무동작', () => {
  const tmp = mkTmp();
  enable(tmp);
  const res = runCount(tmp, { command_name: 'other:foo', command_source: 'plugin' });
  assert.equal(res.status, 0);
  assert.ok(!existsSync(usageLog(tmp)), 'banker: 접두가 아니면 기록하지 않는다');
});

test('banker 필터: command_source 가 plugin 이 아니면 무동작', () => {
  const tmp = mkTmp();
  enable(tmp);
  const res = runCount(tmp, { command_name: 'banker:foo', command_source: 'user' });
  assert.equal(res.status, 0);
  assert.ok(!existsSync(usageLog(tmp)), "command_source!=='plugin' 이면 기록하지 않는다");
});

test('hour 범위: 기록된 hour 는 0-23 정수이며 실행 시각 창(전/후) 안에 있다', () => {
  const tmp = mkTmp();
  enable(tmp);
  const before = new Date().getHours();
  const res = runCount(tmp, { command_name: 'banker:foo', command_source: 'plugin' });
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
  const res = runCount(tmp, { command_name: 'banker:foo', command_source: 'plugin' });
  assert.equal(res.status, 0);
  const lines = readFileSync(usageLog(tmp), 'utf8').split('\n').filter(Boolean).length;
  assert.equal(lines, LOG_MAX_LINES, '상한에서는 더 쌓지 않는다(체크인이 비우면 재개)');
});

const NO_FIFO = process.platform === 'win32' && 'Windows 에는 FIFO 가 없다';

test('used-skills.json 자리가 FIFO 여도 기다리지 않는다', { skip: NO_FIFO }, () => {
  const tmp = mkTmp();
  enable(tmp);
  assert.equal(spawnSync('mkfifo', [usedSkills(tmp)]).status, 0, 'mkfifo');
  const res = runCount(tmp, { command_name: 'banker:foo', command_source: 'plugin' }, {}, { timeout: 10_000 });
  assert.equal(res.signal, null, '훅이 스스로 끝났다');
  assert.equal(res.status, 0);
  assert.equal(readFileSync(usageLog(tmp), 'utf8').split('\n').filter(Boolean).length, 1, '기록에 줄 하나');
  assert.equal(lstatSync(usedSkills(tmp)).isFile(), true, '집합은 일반 파일이 된다');
  assert.deepEqual(JSON.parse(readFileSync(usedSkills(tmp), 'utf8')), ['banker:foo']);
});

// 이 계정이 여기서 심볼릭 링크를 만들 수 있는지(Windows 는 권한이 있어야 한다).
function canSymlink() {
  try {
    symlinkSync('nowhere', join(mkTmp(), 'probe'));
    return true;
  } catch {
    return false;
  }
}
const NO_LINKS = !canSymlink() && '이 계정은 링크를 만들 수 없다';

test('기록 자리가 FIFO 면 기다리지 않고 FIFO 는 그대로 둔다', { skip: NO_FIFO }, () => {
  const tmp = mkTmp();
  enable(tmp);
  assert.equal(spawnSync('mkfifo', [usageLog(tmp)]).status, 0, 'mkfifo');
  const res = runCount(tmp, { command_name: 'banker:foo', command_source: 'plugin' }, {}, { timeout: 10_000 });
  assert.equal(res.signal, null, '훅이 스스로 끝났다');
  assert.equal(res.status, 0);
  assert.equal(lstatSync(usageLog(tmp)).isFIFO(), true, 'FIFO 는 그대로');
  assert.deepEqual(JSON.parse(readFileSync(usedSkills(tmp), 'utf8')), ['banker:foo'], '써 본 스킬 집합에는 남긴다');
});

test('기록 자리가 링크면 그 너머에 쓰지 않는다', { skip: NO_LINKS }, () => {
  const tmp = mkTmp();
  enable(tmp);
  const victim = join(tmp, 'victim');
  writeFileSync(victim, 'keep\n');
  symlinkSync(victim, usageLog(tmp));
  const res = runCount(tmp, { command_name: 'banker:foo', command_source: 'plugin' });
  assert.equal(res.status, 0);
  assert.equal(readFileSync(victim, 'utf8'), 'keep\n', '링크가 가리키는 파일은 그대로');
  assert.deepEqual(JSON.parse(readFileSync(usedSkills(tmp), 'utf8')), ['banker:foo'], '써 본 스킬 집합에는 남긴다');
});

test('기록 자리에 다른 이름이 있어(하드 링크) 기록을 거절해도 써 본 스킬 집합에는 남긴다', () => {
  const tmp = mkTmp();
  enable(tmp);
  const snap = join(tmp, 'snap');
  writeFileSync(snap, 'keep\n');
  linkSync(snap, usageLog(tmp));
  const res = runCount(tmp, { command_name: 'banker:foo', command_source: 'plugin' });
  assert.equal(res.status, 0);
  assert.equal(readFileSync(snap, 'utf8'), 'keep\n', '다른 이름의 내용은 그대로');
  assert.deepEqual(JSON.parse(readFileSync(usedSkills(tmp), 'utf8')), ['banker:foo'], '써 본 스킬 집합에는 남긴다');
});

test('config.json 자리가 FIFO 여도 기다리지 않는다', { skip: NO_FIFO }, () => {
  const tmp = mkTmp();
  mkdirSync(bankerDir(tmp), { recursive: true });
  const config = join(bankerDir(tmp), 'config.json');
  assert.equal(spawnSync('mkfifo', [config]).status, 0, 'mkfifo');
  const res = runCount(tmp, { command_name: 'banker:foo', command_source: 'plugin' }, {}, { timeout: 10_000 });
  assert.equal(res.signal, null, '훅이 스스로 끝났다');
  assert.equal(res.status, 0);
  assert.match(readFileSync(usageLog(tmp), 'utf8'), /^banker:foo\t/, '설정을 읽지 못해도 기본 켜짐이라 기록한다');
  assert.equal(lstatSync(config).isFIFO(), true, 'FIFO 는 그대로');
});
