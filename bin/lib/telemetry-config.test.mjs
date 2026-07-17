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

import { configDir, readConfig, writeConfig, isEnabled, endpoint } from './telemetry-config.mjs';

// 테스트가 만지는 env 만 스냅샷/복원한다.
const ENV_KEYS = ['XDG_CONFIG_HOME', 'APPDATA', 'BANKER_NO_TELEMETRY', 'BANKER_TELEMETRY_ENDPOINT'];
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

test('엔드포인트 미설정이면 false', () => {
  writeConfig({ telemetry: true });
  assert.strictEqual(endpoint(), null);
  assert.strictEqual(isEnabled(), false);
});

test('endpoint 는 env 가 config 보다 우선', () => {
  writeConfig({ telemetry: true, endpoint: 'https://config.test/c' });
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
