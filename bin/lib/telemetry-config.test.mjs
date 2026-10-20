/*
 * telemetry-config 유닛테스트 (node:test + node:assert).
 * XDG_CONFIG_HOME 을 임시 디렉터리로 지정해 실제 사용자 config 를 건드리지 않고 격리한다.
 * 파일명이 .test.mjs 로 끝나 package.json files[] 의 test 제외 패턴으로 배포에서 빠진다.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  configDir, readConfig, writeConfig, isEnabled, endpoint,
  noUpdateCheck, countingActive, installedVersion, compareVersions, writeUpdateCache,
  readUsedSkills, recordUsedSkill, changedSkillsBetween, appendUsageLog, readRegular, writeByRename, randomHex, collectBody,
  UPDATE_CHECK_PATH, UPDATE_THROTTLE_MS, NPM_LATEST_URL, DEFAULT_ENDPOINT,
  SKILL_CHANGES_URL, USED_SKILLS_PATH, USED_SKILLS_MAX, SKILL_NAME_RE, netDeadlineMs,
} from './telemetry-config.mjs';

// 테스트가 만지는 env 만 스냅샷/복원한다.
const ENV_KEYS = ['XDG_CONFIG_HOME', 'APPDATA', 'BANKER_NO_TELEMETRY', 'BANKER_TELEMETRY_ENDPOINT', 'BANKER_NO_UPDATE_CHECK'];
let savedEnv;
let tmpDir;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  // 각 테스트를 고유 임시 디렉터리로 격리 (실제 홈/config 오염 방지).
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'banker-tc-'));
  process.env.XDG_CONFIG_HOME = tmpDir;
  delete process.env.BANKER_NO_TELEMETRY;
  delete process.env.BANKER_TELEMETRY_ENDPOINT;
  delete process.env.BANKER_NO_UPDATE_CHECK;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 정리 실패는 무시 */ }
});

test('기본값: config 없음이면 isEnabled 는 false', () => {
  assert.strictEqual(isEnabled(), false);
});

test('세 조건 충족 시 isEnabled 는 true', () => {
  assert.strictEqual(writeConfig({ telemetry: true, endpoint: 'https://example.test/collect' }), true);
  assert.strictEqual(isEnabled(), true);
});

test('BANKER_NO_TELEMETRY=1 이면 config.telemetry=true 여도 false', () => {
  writeConfig({ telemetry: true, endpoint: 'https://example.test/collect' });
  process.env.BANKER_NO_TELEMETRY = '1';
  assert.strictEqual(isEnabled(), false);
});

test('BANKER_NO_TELEMETRY 가 falsey(빈문자열/0/false) 면 opt-out 아님', () => {
  writeConfig({ telemetry: true, endpoint: 'https://example.test/collect' });
  for (const v of ['', '0', 'false']) {
    process.env.BANKER_NO_TELEMETRY = v;
    assert.strictEqual(isEnabled(), true, 'value=' + JSON.stringify(v));
  }
});

test('endpoint 미설정 시 내장 기본(DEFAULT_ENDPOINT) 반환, isEnabled 는 telemetry 미설정이라 false', () => {
  // env·config 둘 다 미설정 → 내장 기본 엔드포인트를 반환한다(count-default-on).
  assert.strictEqual(endpoint(), DEFAULT_ENDPOINT);
  // isEnabled 는 여전히 telemetry===true 를 요구하므로 telemetry 미설정이면 false 를 유지한다.
  assert.strictEqual(isEnabled(), false);
});

test('endpoint 우선순위: env > config > DEFAULT_ENDPOINT', () => {
  // config.endpoint 는 내장 기본을 override 한다.
  writeConfig({ telemetry: true, endpoint: 'https://config.test/c' });
  assert.strictEqual(endpoint(), 'https://config.test/c');
  assert.strictEqual(isEnabled(), true);
  // env 는 config 보다 우선한다.
  process.env.BANKER_TELEMETRY_ENDPOINT = 'https://env.test/c';
  assert.strictEqual(endpoint(), 'https://env.test/c');
  assert.strictEqual(isEnabled(), true);
});

test('config 왕복: write 한 값을 read 로 그대로 얻는다', () => {
  const cfg = { telemetry: true, endpoint: 'https://example.test/collect', extra: 42 };
  assert.strictEqual(writeConfig(cfg), true);
  assert.deepStrictEqual(readConfig(), cfg);
});

test('malformed config.json: readConfig 가 던지지 않고 {} 반환, isEnabled 는 false', () => {
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(path.join(configDir(), 'config.json'), '{ not valid json ');
  assert.deepStrictEqual(readConfig(), {});
  assert.strictEqual(isEnabled(), false);
});

test('resolver: XDG_CONFIG_HOME 설정 시 그 하위 banker 경로', () => {
  process.env.XDG_CONFIG_HOME = tmpDir;
  assert.strictEqual(configDir(), path.join(tmpDir, 'banker'));
});

test('resolver: XDG_CONFIG_HOME 미설정 시 홈 기반 fallback', () => {
  delete process.env.XDG_CONFIG_HOME;
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    assert.strictEqual(configDir(), path.join(base, 'banker'));
  } else {
    assert.strictEqual(configDir(), path.join(os.homedir(), '.config', 'banker'));
  }
});

// ---- 업데이트-체크 확장 (UA-1) ----

test('신규 export 상수: throttle=24h · npm URL · 캐시 경로 basename', () => {
  assert.strictEqual(UPDATE_THROTTLE_MS, 24 * 60 * 60 * 1000);
  assert.strictEqual(NPM_LATEST_URL, 'https://registry.npmjs.org/@kaydash9999/banker-plugins/latest');
  assert.ok(UPDATE_CHECK_PATH.endsWith('update-check.json'));
});

test('noUpdateCheck: env falsey(빈문자열/0/false)·unset 면 false, 그 외 값이면 true', () => {
  for (const v of ['', '0', 'false']) {
    process.env.BANKER_NO_UPDATE_CHECK = v;
    assert.strictEqual(noUpdateCheck(), false, 'value=' + JSON.stringify(v));
  }
  delete process.env.BANKER_NO_UPDATE_CHECK;
  assert.strictEqual(noUpdateCheck(), false);
  for (const v of ['1', 'true', 'yes']) {
    process.env.BANKER_NO_UPDATE_CHECK = v;
    assert.strictEqual(noUpdateCheck(), true, 'value=' + JSON.stringify(v));
  }
});

test('noUpdateCheck: config.updateCheck===false 면 true, ===true 면 false', () => {
  writeConfig({ updateCheck: false });
  assert.strictEqual(noUpdateCheck(), true);
  writeConfig({ updateCheck: true });
  assert.strictEqual(noUpdateCheck(), false);
});

test('countingActive: default-on 이라 env·config 미설정+미opt-out 이면 내장 기본 엔드포인트로 true', () => {
  assert.strictEqual(countingActive(), true); // 미설정이어도 DEFAULT_ENDPOINT 내장 → default-on
  writeConfig({ endpoint: 'https://example.test/collect' });
  assert.strictEqual(countingActive(), true); // config 엔드포인트여도(telemetry 미설정) 여전히 활성
});

test('countingActive: telemetry===false 면 false, ===true 면 true (엔드포인트 있음)', () => {
  writeConfig({ endpoint: 'https://example.test/collect', telemetry: false });
  assert.strictEqual(countingActive(), false);
  writeConfig({ endpoint: 'https://example.test/collect', telemetry: true });
  assert.strictEqual(countingActive(), true);
});

test('countingActive: BANKER_NO_TELEMETRY opt-out 이면 false, falsey 면 true', () => {
  writeConfig({ endpoint: 'https://example.test/collect' });
  process.env.BANKER_NO_TELEMETRY = '1';
  assert.strictEqual(countingActive(), false);
  for (const v of ['', '0', 'false']) {
    process.env.BANKER_NO_TELEMETRY = v;
    assert.strictEqual(countingActive(), true, 'value=' + JSON.stringify(v));
  }
});

test('installedVersion: 실제 plugin.json 은 문자열 · 경로조작 malformed/비문자열/없음 → null', () => {
  assert.strictEqual(typeof installedVersion(), 'string');
  const bad = path.join(tmpDir, 'bad-plugin.json');
  fs.writeFileSync(bad, '{ not valid json ');
  assert.strictEqual(installedVersion(bad), null);
  const noVer = path.join(tmpDir, 'no-version.json');
  fs.writeFileSync(noVer, JSON.stringify({ version: 123 }));
  assert.strictEqual(installedVersion(noVer), null);
  assert.strictEqual(installedVersion(path.join(tmpDir, 'nope.json')), null);
});

test('compareVersions: 정상 비교와 malformed → null', () => {
  assert.ok(compareVersions('1.2.3', '1.2.4') < 0);
  assert.ok(compareVersions('2.0.0', '1.9.9') > 0);
  assert.strictEqual(compareVersions('1.2.3', '1.2.3'), 0);
  assert.strictEqual(compareVersions('1.2', '1.2.3'), null);
  assert.strictEqual(compareVersions('a.b.c', '1.2.3'), null);
  assert.strictEqual(compareVersions('1.2.3-rc', '1.2.3'), null);
  assert.strictEqual(compareVersions('1.2.3', '1.2.3-rc'), null);
});

test('writeUpdateCache: read-modify-write 병합으로 형제 필드 보존', () => {
  const cachePath = path.join(configDir(), 'update-check.json');
  assert.strictEqual(writeUpdateCache({ latest: '1.0.0', checkedAt: 111 }), true);
  assert.strictEqual(writeUpdateCache({ notified: '1.0.0' }), true);
  assert.deepStrictEqual(
    JSON.parse(fs.readFileSync(cachePath, 'utf8')),
    { latest: '1.0.0', checkedAt: 111, notified: '1.0.0' },
  );
  // 기존 필드 덮어쓰기 시에도 나머지 형제 필드는 미소실
  assert.strictEqual(writeUpdateCache({ latest: '2.0.0' }), true);
  assert.deepStrictEqual(
    JSON.parse(fs.readFileSync(cachePath, 'utf8')),
    { latest: '2.0.0', checkedAt: 111, notified: '1.0.0' },
  );
});

test('writeUpdateCache: 기존 캐시가 malformed 여도 던지지 않고 patch 로 재작성', () => {
  const cachePath = path.join(configDir(), 'update-check.json');
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(cachePath, '{ broken ');
  assert.strictEqual(writeUpdateCache({ latest: '9.9.9' }), true);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(cachePath, 'utf8')), { latest: '9.9.9' });
});

// ---- 개인화 알림 확장 (used-skills 집합 + changedSkillsBetween) ----

test('신규 export: SKILL_CHANGES_URL(GitHub raw) · USED_SKILLS_PATH · USED_SKILLS_MAX', () => {
  assert.strictEqual(SKILL_CHANGES_URL, 'https://raw.githubusercontent.com/smallOpenSource/banker_plugins/main/skill-changes.json');
  assert.ok(USED_SKILLS_PATH.endsWith('used-skills.json'));
  assert.ok(Number.isInteger(USED_SKILLS_MAX) && USED_SKILLS_MAX > 0);
});

test('readUsedSkills: 없음·malformed·비배열 → [] · 문자열 원소만 남긴다', () => {
  assert.deepStrictEqual(readUsedSkills(), []); // 파일 없음.
  fs.mkdirSync(configDir(), { recursive: true });
  const p = path.join(configDir(), 'used-skills.json');
  fs.writeFileSync(p, '{ not json');
  assert.deepStrictEqual(readUsedSkills(), []); // malformed.
  fs.writeFileSync(p, JSON.stringify({ a: 1 }));
  assert.deepStrictEqual(readUsedSkills(), []); // 비배열 객체.
  fs.writeFileSync(p, JSON.stringify(['banker:foo', 123, '', 'banker:bar']));
  assert.deepStrictEqual(readUsedSkills(), ['banker:foo', 'banker:bar']); // 문자열 원소만.
});

test('recordUsedSkill: union(중복 무기록)·비문자열 방어 + 왕복', () => {
  assert.strictEqual(recordUsedSkill('banker:foo'), true);
  assert.deepStrictEqual(readUsedSkills(), ['banker:foo']);
  assert.strictEqual(recordUsedSkill('banker:foo'), false, '이미 있으면 false(무기록)');
  assert.strictEqual(recordUsedSkill('banker:bar'), true);
  assert.deepStrictEqual(readUsedSkills(), ['banker:foo', 'banker:bar']);
  for (const bad of ['', null, undefined, 123, {}]) {
    assert.strictEqual(recordUsedSkill(bad), false, 'value=' + JSON.stringify(bad));
  }
  assert.deepStrictEqual(readUsedSkills(), ['banker:foo', 'banker:bar'], '방어 입력은 집합 불변');
});

test('recordUsedSkill: 상한(USED_SKILLS_MAX) 도달 시 새 이름 무시', () => {
  const full = Array.from({ length: USED_SKILLS_MAX }, (_, i) => `banker:s${i}`);
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(path.join(configDir(), 'used-skills.json'), JSON.stringify(full));
  assert.strictEqual(recordUsedSkill('banker:overflow'), false, '상한이면 false');
  assert.strictEqual(readUsedSkills().length, USED_SKILLS_MAX, '집합 크기 불변');
  assert.ok(!readUsedSkills().includes('banker:overflow'));
});

test('changedSkillsBetween: installed<v<=latest 합집합·중복제거·순서 + 방어', () => {
  const map = {
    '0.8.0': ['banker:a'],               // <= installed → 제외
    '0.9.0': ['banker:b', 'banker:c'],
    '0.10.0': ['banker:c', 'banker:d'],  // banker:c 중복 → 한 번만
    '0.11.0': ['banker:e'],              // > latest → 제외
  };
  assert.deepStrictEqual(
    changedSkillsBetween(map, '0.8.0', '0.10.0'),
    ['banker:b', 'banker:c', 'banker:d'],
  );
  assert.deepStrictEqual(changedSkillsBetween(map, '0.10.0', '0.10.0'), [], '경계: installed==latest → 빈');
  // 방어: map 비객체/배열·비문자열 버전 → [].
  assert.deepStrictEqual(changedSkillsBetween(null, '0.8.0', '0.9.0'), []);
  assert.deepStrictEqual(changedSkillsBetween(['x'], '0.8.0', '0.9.0'), []);
  assert.deepStrictEqual(changedSkillsBetween(map, 0.8, '0.9.0'), []);
  // malformed 버전 키·비배열 값은 건너뛴다(throw 없음).
  const messy = { 'x.y.z': ['banker:z'], '0.9.0': 'notarray', '0.9.1': ['banker:ok', 42] };
  assert.deepStrictEqual(changedSkillsBetween(messy, '0.8.0', '0.9.5'), ['banker:ok']);
  assert.deepStrictEqual(changedSkillsBetween({ '0.9.0': ['banker:b'] }, '0.8.0', '0.10'), [], 'malformed latest');
  assert.deepStrictEqual(changedSkillsBetween({ '0.9.0': ['banker:b'] }, '0.8', '0.10.0'), [], 'malformed installed');
});

test('netDeadlineMs: 시험용 값은 마감을 줄이기만 한다(30초보다 길면 30초)', () => {
  assert.strictEqual(netDeadlineMs({ BANKER_NET_DEADLINE_MS: '60000' }), 30_000);
  assert.strictEqual(netDeadlineMs({ BANKER_NET_DEADLINE_MS: '2147483647' }), 30_000);
  assert.strictEqual(netDeadlineMs({ BANKER_NET_DEADLINE_MS: '1500' }), 1500);
  assert.strictEqual(netDeadlineMs({}), 30_000);
});

test('SKILL_NAME_RE: banker:<이름> 의 이름은 64자까지이고 실제 스킬과 명령의 이름은 모두 맞는다', () => {
  assert.ok(SKILL_NAME_RE.test(`banker:${'a'.repeat(64)}`));
  assert.ok(!SKILL_NAME_RE.test(`banker:${'a'.repeat(65)}`), '긴 이름은 사용 기록과 체크인에 싣지 않는다');
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const names = [
    ...fs.readdirSync(path.join(root, 'skills')).filter((d) => fs.existsSync(path.join(root, 'skills', d, 'SKILL.md'))),
    ...fs.readdirSync(path.join(root, 'commands')).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)),
  ];
  assert.ok(names.length > 10);
  for (const n of names) assert.ok(SKILL_NAME_RE.test(`banker:${n}`), n);
});

// ---- 새 파일 쓰기가 임시 이름의 링크를 따라가지 않는다 ----
// 옛 판은 `<이름>.<pid>.tmp` 에 그냥 써서, 그 이름에 놓인 링크가 가리키는 파일을 덮었다.

// 이 계정이 여기서 심볼릭 링크를 만들 수 있는지(Windows 는 권한이 있어야 한다).
function canSymlink() {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'banker-tc-link-'));
  try {
    fs.symlinkSync('nowhere', path.join(probe, 'probe'));
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
}
const NO_LINKS = !canSymlink() && '이 계정은 링크를 만들 수 없다';

// victim 파일(`keep\n`)과 at 에서 그리로 가는 링크를 만들고 victim 경로를 돌려준다.
function plantLink(at) {
  fs.mkdirSync(path.dirname(at), { recursive: true });
  const victim = path.join(tmpDir, 'victim');
  fs.writeFileSync(victim, 'keep\n');
  fs.symlinkSync(victim, at);
  return victim;
}

// crypto.randomBytes 를 고정한 채 fn 을 부른다. 임시 이름을 미리 알아 그 자리에 무엇을 둬 보는 시험용.
function withFixedRandom(fn) {
  const real = crypto.randomBytes;
  crypto.randomBytes = () => Buffer.from('0a1b2c3d', 'hex');
  syncBuiltinESMExports();
  try {
    return fn();
  } finally {
    crypto.randomBytes = real;
    syncBuiltinESMExports();
  }
}

test('writeUpdateCache: pid 만 쓴 옛 임시 이름의 링크는 따라가지도 막히지도 않는다', { skip: NO_LINKS }, () => {
  const old = path.join(configDir(), `update-check.json.${process.pid}.tmp`);
  const victim = plantLink(old);
  assert.strictEqual(writeUpdateCache({ latest: '1.0.0' }), true, '옛 이름의 링크가 쓰기를 막지 않는다');
  assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'keep\n', '링크가 가리키는 파일은 그대로');
  const cachePath = path.join(configDir(), 'update-check.json');
  assert.strictEqual(fs.lstatSync(cachePath).isSymbolicLink(), false, '캐시는 링크가 아닌 파일');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(cachePath, 'utf8')), { latest: '1.0.0' });
  assert.strictEqual(fs.lstatSync(old).isSymbolicLink(), true, '심은 링크는 그대로');
});

test('recordUsedSkill: pid 만 쓴 옛 임시 이름의 링크는 따라가지도 막히지도 않는다', { skip: NO_LINKS }, () => {
  const old = path.join(configDir(), `used-skills.json.${process.pid}.tmp`);
  const victim = plantLink(old);
  assert.strictEqual(recordUsedSkill('banker:foo'), true, '옛 이름의 링크가 쓰기를 막지 않는다');
  assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'keep\n', '링크가 가리키는 파일은 그대로');
  assert.strictEqual(fs.lstatSync(path.join(configDir(), 'used-skills.json')).isSymbolicLink(), false, '집합은 링크가 아닌 파일');
  assert.deepStrictEqual(readUsedSkills(), ['banker:foo']);
});

test('writeUpdateCache: 임시 이름에 이미 무엇이 있으면 쓰지 않고, 그것을 지우지도 그 너머에 쓰지도 않는다', { skip: NO_LINKS }, () => {
  const taken = path.join(configDir(), `update-check.json.${process.pid}.0a1b2c3d.tmp`);
  const victim = plantLink(taken);
  assert.strictEqual(withFixedRandom(() => writeUpdateCache({ latest: '1.0.0' })), false);
  assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'keep\n', '링크가 가리키는 파일은 그대로');
  assert.strictEqual(fs.lstatSync(taken).isSymbolicLink(), true, '이 쓰기가 만든 것이 아니라 그대로 둔다');
  assert.strictEqual(fs.existsSync(path.join(configDir(), 'update-check.json')), false, '캐시는 생기지 않는다');
});

test('writeUpdateCache: 캐시 자리가 폴더면 그대로 두고 임시 파일을 남기지 않는다', () => {
  const cachePath = path.join(configDir(), 'update-check.json');
  fs.mkdirSync(cachePath, { recursive: true });
  assert.strictEqual(writeUpdateCache({ latest: '1.0.0' }), false);
  assert.strictEqual(fs.statSync(cachePath).isDirectory(), true, '폴더는 그대로');
  assert.deepStrictEqual(fs.readdirSync(configDir()).filter((n) => n.endsWith('.tmp')), [], '임시 파일이 남지 않는다');
});

// ---- 사용 기록 한 줄 더하기(appendUsageLog): FIFO 를 기다리지 않고 링크 너머에 쓰지 않는다 ----

const usageLogPath = () => path.join(configDir(), 'usage-log');

test('appendUsageLog: 없으면 만들고 name\\thour 한 줄을 더한다', () => {
  assert.strictEqual(appendUsageLog('banker:foo'), true);
  assert.strictEqual(appendUsageLog('banker:foo'), true);
  const lines = fs.readFileSync(usageLogPath(), 'utf8').split('\n');
  assert.strictEqual(lines.pop(), '', '줄마다 개행으로 끝난다');
  assert.strictEqual(lines.length, 2);
  for (const line of lines) assert.match(line, /^banker:foo\t([0-9]|1[0-9]|2[0-3])$/);
});

test('appendUsageLog: banker:<이름> 꼴이 아니면 쓰지 않는다', () => {
  for (const bad of ['banker:a\tb', 'other:x', '']) {
    assert.strictEqual(appendUsageLog(bad), false, JSON.stringify(bad));
  }
  assert.strictEqual(fs.existsSync(usageLogPath()), false, '기록이 생기지 않는다');
});

test('appendUsageLog: 기록 자리의 링크 너머에 쓰지 않고 링크는 그대로 둔다', { skip: NO_LINKS }, () => {
  const victim = plantLink(usageLogPath());
  assert.strictEqual(appendUsageLog('banker:foo'), false);
  assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'keep\n', '링크가 가리키는 파일은 그대로');
  assert.strictEqual(fs.lstatSync(usageLogPath()).isSymbolicLink(), true, '링크는 그대로');
});

test('appendUsageLog: 끊어진 링크인 기록 자리로 새 파일을 만들지 않는다', { skip: NO_LINKS }, () => {
  fs.mkdirSync(configDir(), { recursive: true });
  const nowhere = path.join(tmpDir, 'nowhere');
  fs.symlinkSync(nowhere, usageLogPath());
  assert.strictEqual(appendUsageLog('banker:foo'), false);
  assert.strictEqual(fs.existsSync(nowhere), false, '링크 대상 자리에 아무것도 생기지 않는다');
});

test('appendUsageLog: 같은 파일에 다른 이름이 있으면(하드 링크) 쓰지 않는다', () => {
  fs.mkdirSync(configDir(), { recursive: true });
  const victim = path.join(tmpDir, 'victim');
  fs.writeFileSync(victim, 'keep\n');
  fs.linkSync(victim, usageLogPath());
  assert.strictEqual(appendUsageLog('banker:foo'), false);
  assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'keep\n', '다른 이름의 내용은 그대로');
});

test('appendUsageLog: 기록 자리가 폴더면 그대로 둔다', () => {
  fs.mkdirSync(usageLogPath(), { recursive: true });
  assert.strictEqual(appendUsageLog('banker:foo'), false);
  assert.strictEqual(fs.statSync(usageLogPath()).isDirectory(), true, '폴더는 그대로');
});

test('appendUsageLog: 설정 폴더 자체가 링크여도 줄을 더한다', { skip: NO_LINKS }, () => {
  const real = path.join(tmpDir, 'real-banker');
  fs.mkdirSync(real);
  fs.symlinkSync(real, configDir(), 'dir');
  assert.strictEqual(appendUsageLog('banker:foo'), true);
  assert.match(fs.readFileSync(path.join(real, 'usage-log'), 'utf8'), /^banker:foo\t([0-9]|1[0-9]|2[0-3])\n$/);
});

// ---- 링크인 설정, 공용 도우미 둘(readRegular, writeByRename)의 직접 시험 ----

const NO_FIFO = process.platform === 'win32' && 'Windows 에는 FIFO 가 없다';
const TC_URL = new URL('./telemetry-config.mjs', import.meta.url).href;
const tmpNames = () => fs.readdirSync(configDir()).filter((n) => n.endsWith('.tmp'));

test('countingActive: 링크인 config.json 의 telemetry:false 도 따른다', { skip: NO_LINKS }, () => {
  const real = path.join(tmpDir, 'dotfiles', 'banker.json');
  fs.mkdirSync(path.dirname(real), { recursive: true });
  fs.writeFileSync(real, JSON.stringify({ telemetry: false }));
  fs.mkdirSync(configDir(), { recursive: true });
  fs.symlinkSync(real, path.join(configDir(), 'config.json'));
  assert.deepStrictEqual(readConfig(), { telemetry: false });
  assert.strictEqual(countingActive(), false, '링크로 둔 설정의 끔을 따른다');
});

test('readRegular: 일반 파일은 글을, 없거나 폴더면 빈 글을 준다', () => {
  fs.mkdirSync(configDir(), { recursive: true });
  const file = path.join(configDir(), 'a.txt');
  fs.writeFileSync(file, 'a\n');
  assert.strictEqual(readRegular(file), 'a\n');
  assert.strictEqual(readRegular(path.join(configDir(), 'none')), '', '없는 이름');
  assert.strictEqual(readRegular(configDir()), '', '폴더');
});

test('readRegular: 일반 파일로 가는 링크는 따라가 글을 준다', { skip: NO_LINKS }, () => {
  const at = path.join(configDir(), 'linked.json');
  plantLink(at);
  assert.strictEqual(readRegular(at), 'keep\n');
});

test('readRegular: FIFO 를 기다리지 않고 빈 글을 준다', { skip: NO_FIFO }, () => {
  fs.mkdirSync(configDir(), { recursive: true });
  const fifo = path.join(configDir(), 'pipe');
  assert.strictEqual(spawnSync('mkfifo', [fifo]).status, 0, 'mkfifo');
  const code = `import { readRegular } from ${JSON.stringify(TC_URL)}; process.stdout.write(JSON.stringify(readRegular(process.argv[1])));`;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', code, fifo], { encoding: 'utf8', timeout: 10_000 });
  assert.strictEqual(res.signal, null, '스스로 끝났다');
  assert.strictEqual(res.status, 0);
  assert.strictEqual(res.stdout, '""');
});

test('writeByRename: 새 파일을 쓰고 덮으며 임시 파일을 남기지 않는다', () => {
  fs.mkdirSync(configDir(), { recursive: true });
  const target = path.join(configDir(), 'thing.json');
  writeByRename(target, 'x');
  writeByRename(target, 'y');
  assert.strictEqual(fs.readFileSync(target, 'utf8'), 'y');
  assert.deepStrictEqual(tmpNames(), [], '임시 파일이 남지 않는다');
});

test('writeByRename: 링크 자리는 링크만 새 파일로 바뀌고 가리키던 파일은 그대로다', { skip: NO_LINKS }, () => {
  const target = path.join(configDir(), 'thing.json');
  const victim = plantLink(target);
  writeByRename(target, 'new');
  assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'keep\n', '링크가 가리키던 파일은 그대로');
  assert.strictEqual(fs.lstatSync(target).isSymbolicLink(), false, '그 자리는 링크가 아닌 파일');
  assert.strictEqual(fs.readFileSync(target, 'utf8'), 'new');
});

test('writeByRename: 같은 파일의 다른 이름(하드 링크)은 그대로다', () => {
  fs.mkdirSync(configDir(), { recursive: true });
  const victim = path.join(tmpDir, 'victim');
  fs.writeFileSync(victim, 'keep\n');
  const target = path.join(configDir(), 'thing.json');
  fs.linkSync(victim, target);
  writeByRename(target, 'new');
  assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'keep\n', '다른 이름의 내용은 그대로');
  assert.strictEqual(fs.readFileSync(target, 'utf8'), 'new');
});

test('writeByRename: 임시 이름에 이미 무엇이 있으면 EEXIST 로 던지고 그것을 그대로 둔다', () => {
  fs.mkdirSync(configDir(), { recursive: true });
  const target = path.join(configDir(), 'thing.json');
  const taken = `${target}.${process.pid}.0a1b2c3d.tmp`;
  fs.writeFileSync(taken, 'mine\n');
  withFixedRandom(() => assert.throws(() => writeByRename(target, 'x'), { code: 'EEXIST' }));
  assert.strictEqual(fs.readFileSync(taken, 'utf8'), 'mine\n', '이 쓰기가 만든 것이 아니라 그대로 둔다');
  assert.strictEqual(fs.existsSync(target), false, '대상은 생기지 않는다');
});

test('writeByRename: 옮기지 못하면 던지고 만든 임시 파일을 지운다', () => {
  const target = path.join(configDir(), 'thing.json');
  fs.mkdirSync(target, { recursive: true });
  assert.throws(() => writeByRename(target, 'x'));
  assert.strictEqual(fs.statSync(target).isDirectory(), true, '폴더는 그대로');
  assert.deepStrictEqual(tmpNames(), [], '만든 임시 파일을 지운다');
});

// ---- 임시 이름의 난수(randomHex): node:crypto 는 부를 때 불러오고, 못 불러오면 대체 값 ----

const NO_CRYPTO_URL = new URL('../../scripts/test-fixtures/no-crypto.mjs', import.meta.url).href;

test('randomHex: 16진 8자를 내고 부를 때마다 다르다', () => {
  const a = randomHex();
  const b = randomHex();
  assert.match(a, /^[0-9a-f]{8}$/);
  assert.match(b, /^[0-9a-f]{8}$/);
  assert.notStrictEqual(a, b);
});

test('randomHex: crypto 를 불러오지 못하는 Node 에서는 Math.random 으로 16진 8자를 낸다', () => {
  const mark = path.join(tmpDir, 'crypto-mark');
  // Math.random 을 고정해 정확한 출력을 본다: 0.5 * 2^32 = 0x80000000, 0.001 * 2^32 = 4294967.296 에서 0x418937(앞을 0 으로 채움).
  // 상수와 16비트 난수는 꼴(16진 8자)만 보는 단언을 통과하고, 0 채움 빠짐도 대개(두 번 불러 약 88%) 통과한다.
  const code = `import { randomHex } from ${JSON.stringify(TC_URL)};
const seq = [0.5, 0.001]; Math.random = () => seq.shift();
process.stdout.write(randomHex() + ' ' + randomHex());`;
  const res = spawnSync(process.execPath, ['--import', NO_CRYPTO_URL, '--input-type=module', '-e', code], {
    encoding: 'utf8', env: { ...process.env, NO_CRYPTO_MARK: mark },
  });
  assert.strictEqual(res.status, 0, res.stderr);
  assert.strictEqual(res.stdout, '80000000 00418937');
  const tries = fs.readFileSync(mark, 'utf8').split('\n').filter(Boolean);
  assert.ok(tries.length > 0 && tries.every((t) => t === 'cjs crypto'), `흉내가 부를 때의 불러오기를 가로챘다: ${tries.join(',')}`);
});

test('시험 도구: 암호 모듈 없이 빌드한 Node 처럼 https 와 tls 도 불러오지 못하게 한다', () => {
  const code = [
    "import { createRequire } from 'node:module';",
    'const got = [];',
    "try { await import('node:https'); got.push('loaded'); } catch (e) { got.push(e.code); }",
    "try { createRequire(import.meta.url)('tls'); got.push('loaded'); } catch (e) { got.push(e.code); }",
    "process.stdout.write(got.join(' '));",
  ].join('\n');
  const res = spawnSync(process.execPath, ['--import', NO_CRYPTO_URL, '--input-type=module', '-e', code], { encoding: 'utf8' });
  assert.strictEqual(res.status, 0, res.stderr);
  assert.strictEqual(res.stdout, 'ERR_NO_CRYPTO ERR_NO_CRYPTO');
});

// The values collectBody hands done for an answer of n bytes sent in one go from this machine: a length, or null.
async function collectFromLoopback(n, max) {
  const server = http.createServer((q, res) => { res.writeHead(200, { 'content-length': n }); res.end(Buffer.alloc(n, 0x61)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const got = [];
    await new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port: server.address().port, path: '/' }, (res) => {
        collectBody(res, max, (body) => { got.push(body === null ? null : body.length); });
        res.on('close', () => setTimeout(resolve, 50));
      }).on('error', () => setTimeout(resolve, 50));
    });
    return got;
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
}

test('collectBody: 정확히 한도(256KiB)인 몸은 받고, 한도+1 은 null 을 한 번만 넘긴다', async () => {
  const MAX = 256 * 1024;
  assert.deepStrictEqual(await collectFromLoopback(MAX, MAX), [MAX]);
  assert.deepStrictEqual(await collectFromLoopback(MAX + 1, MAX), [null], '끊은 뒤 오는 end 로 잘린 몸을 다시 넘기지 않는다');
});

test('collectBody: 한도를 넘은 뒤 오는 data, error, end 는 done 을 다시 부르지 않는다', () => {
  const res = new EventEmitter();
  let destroyed = 0;
  res.destroy = () => { destroyed += 1; };
  const calls = [];
  collectBody(res, 4, (body) => calls.push(body));
  res.emit('data', Buffer.from('abcde'));
  res.emit('data', Buffer.from('f'));
  res.emit('error', new Error('aborted'));
  res.emit('end');
  assert.deepStrictEqual(calls, [null]);
  assert.strictEqual(destroyed, 1);
});
