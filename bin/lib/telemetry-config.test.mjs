/*
 * telemetry-config 유닛테스트 (node:test + node:assert).
 * XDG_CONFIG_HOME 을 임시 디렉터리로 지정해 실제 사용자 config 를 건드리지 않고 격리한다.
 * 파일명이 .test.mjs 로 끝나 package.json files[] 의 test 제외 패턴으로 배포에서 빠진다.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  configDir, readConfig, writeConfig, isEnabled, endpoint,
  noUpdateCheck, countingActive, installedVersion, compareVersions, writeUpdateCache,
  UPDATE_CHECK_PATH, UPDATE_THROTTLE_MS, NPM_LATEST_URL, DEFAULT_ENDPOINT,
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
