/*
 * banker.js CLI 유닛테스트 (node:test): telemetry 서브커맨드(US-08, count-default-on) + 비TTY setup 가드(US-6).
 * 카운팅은 opt-in 이 아니라 기본-on(default-on): off 는 opt-out 저장, on 은 opt-out 해제(기본값 복귀).
 * status 는 카운팅(countingActive)·업데이트-체크(noUpdateCheck) 양쪽 상태를 정직하게 표시한다.
 * 블랙박스로 실제 CLI 를 자식프로세스로 실행한다. stdin 은 파이프('' 입력)라 항상 비TTY 이며,
 * 프롬프트/고지 경로는 절대 진입하지 않는다(hang 불가) — 인터랙티브 TTY 경로(별 프롬프트·텔레메트리
 * 투명 고지)는 이 하네스로 재현 불가하므로 비TTY 가드만 검증한다.
 * XDG_CONFIG_HOME 임시 디렉터리로 실제 config 격리.
 * 파일명이 .test.mjs 라 package.json files[] 의 test 제외 글롭으로 배포에서 빠진다.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BANKER = fileURLToPath(new URL('./banker.js', import.meta.url));

function withXdg(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'banker-cli-'));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
function run(args, dir, extraEnv = {}) {
  const env = { ...process.env, XDG_CONFIG_HOME: dir, ...extraEnv };
  // input:'' -> stdin is a closed pipe (never a TTY); timeout guards against any accidental hang.
  const r = spawnSync(process.execPath, [BANKER, ...args], { encoding: 'utf8', input: '', env, timeout: 20000 });
  return { out: `${r.stdout || ''}${r.stderr || ''}`, code: r.status, r };
}
const cfgPath = (dir) => path.join(dir, 'banker', 'config.json');
const readCfg = (dir) => JSON.parse(fs.readFileSync(cfgPath(dir), 'utf8'));
const updateCachePath = (dir) => path.join(dir, 'banker', 'update-check.json');
const writeUpdateCacheFixture = (dir, obj) => {
  fs.mkdirSync(path.join(dir, 'banker'), { recursive: true });
  fs.writeFileSync(updateCachePath(dir), JSON.stringify(obj));
};

test('telemetry status 기본값: 카운팅 enabled(내장 기본 엔드포인트) · opt-out 미적용 · 업데이트체크 캐시 없음', () => withXdg((dir) => {
  const { out, code } = run(['telemetry', 'status'], dir);
  assert.strictEqual(code, 0);
  assert.match(out, /엔드포인트 설정: 설정됨/);
  assert.match(out, /opt-out\(BANKER_NO_TELEMETRY\): 미적용/);
  assert.match(out, /opt-out\(config\.telemetry=false\): 미적용/);
  assert.match(out, /실효 상태\(effective\): enabled/);
  assert.match(out, /opt-out\(BANKER_NO_UPDATE_CHECK\/config\.updateCheck=false\): 미적용/);
  assert.match(out, /마지막 체크: 없음/);
  assert.match(out, /캐시된 최신 버전: 없음/);
  assert.ok(!fs.existsSync(cfgPath(dir)), 'status 는 read-only: config 를 만들지 않는다');
}));

test('status: config.telemetry=false 가 카운팅 opt-out 을 정직히 반영', () => withXdg((dir) => {
  run(['telemetry', 'off'], dir);
  const { out } = run(['telemetry', 'status'], dir, { BANKER_TELEMETRY_ENDPOINT: 'https://env.test/c' });
  assert.match(out, /opt-out\(config\.telemetry=false\): 적용됨/);
  assert.match(out, /실효 상태\(effective\): disabled/);
}));

test('status: BANKER_NO_UPDATE_CHECK opt-out 을 정직히 반영', () => withXdg((dir) => {
  const { out } = run(['telemetry', 'status'], dir, { BANKER_NO_UPDATE_CHECK: '1' });
  assert.match(out, /opt-out\(BANKER_NO_UPDATE_CHECK\/config\.updateCheck=false\): 적용됨/);
}));

test('status: 업데이트-체크 캐시 반영 (마지막 체크 시각 · 캐시 latest vs 설치버전 · 업데이트 있음)', () => withXdg((dir) => {
  const checkedAt = 1700000000000;
  writeUpdateCacheFixture(dir, { latest: '999.0.0', checkedAt });
  const { out } = run(['telemetry', 'status'], dir);
  assert.ok(out.includes(new Date(checkedAt).toISOString()), '마지막 체크 시각이 ISO 로 출력되어야 한다');
  assert.match(out, /캐시된 최신 버전: 999\.0\.0/);
  assert.match(out, /업데이트 있음/);
}));

test('telemetry on (기본 상태) -> opt-out 해제 확인 (내장 기본 엔드포인트라 미설정 안내 없음)', () => withXdg((dir) => {
  const { out, code } = run(['telemetry', 'on'], dir);
  assert.strictEqual(code, 0);
  assert.strictEqual(readCfg(dir).telemetry, undefined);
  assert.match(out, /해제했습니다 \(on\)/);
  assert.ok(!/엔드포인트가 설정되어 있지 않아/.test(out), '내장 기본 엔드포인트가 있으므로 미설정 안내는 출력하지 않는다');
}));

test('telemetry off -> config telemetry:false (opt-out)', () => withXdg((dir) => {
  run(['telemetry', 'on'], dir);
  const { out } = run(['telemetry', 'off'], dir);
  assert.strictEqual(readCfg(dir).telemetry, false);
  assert.match(out, /껐습니다 \(off\)/);
}));

test('telemetry on 은 기존 config 키를 보존하며 opt-out 을 해제한다 (spread merge)', () => withXdg((dir) => {
  fs.mkdirSync(path.join(dir, 'banker'), { recursive: true });
  fs.writeFileSync(cfgPath(dir), JSON.stringify({ endpoint: 'https://keep.test/c', foo: 1, telemetry: false }));
  run(['telemetry', 'on'], dir);
  assert.deepStrictEqual(readCfg(dir), { endpoint: 'https://keep.test/c', foo: 1 });
}));

test('status: opt-out 해제 + 엔드포인트(env) 설정 시 effective enabled', () => withXdg((dir) => {
  run(['telemetry', 'on'], dir);
  const { out } = run(['telemetry', 'status'], dir, { BANKER_TELEMETRY_ENDPOINT: 'https://env.test/c' });
  assert.match(out, /엔드포인트 설정: 설정됨/);
  assert.match(out, /실효 상태\(effective\): enabled/);
}));

test('status: BANKER_NO_TELEMETRY opt-out 이 실효를 disabled 로 강제', () => withXdg((dir) => {
  run(['telemetry', 'on'], dir);
  const { out } = run(['telemetry', 'status'], dir, {
    BANKER_TELEMETRY_ENDPOINT: 'https://env.test/c', BANKER_NO_TELEMETRY: '1',
  });
  assert.match(out, /opt-out\(BANKER_NO_TELEMETRY\): 적용됨/);
  assert.match(out, /실효 상태\(effective\): disabled/);
}));

test('알 수 없는/누락 하위명령 -> 사용법 출력', () => withXdg((dir) => {
  assert.match(run(['telemetry', 'bogus'], dir).out, /Usage: banker telemetry <on\|off\|status>/);
  assert.match(run(['telemetry'], dir).out, /Usage: banker telemetry <on\|off\|status>/);
}));

test('비TTY setup --claude --dry-run: hang·프롬프트·고지·persist 없이 done', () => withXdg((dir) => {
  const { out, code } = run(['setup', '--claude', '--dry-run'], dir);
  assert.strictEqual(code, 0);
  assert.match(out, /done\./);
  assert.ok(!/GitHub 별/.test(out) && !/익명 사용량 카운트/.test(out), '비TTY 는 프롬프트·고지 금지');
  assert.ok(!fs.existsSync(cfgPath(dir)), '비TTY/dry-run 은 config 를 쓰지 않는다');
}));

test('비TTY setup --codex --scope project --dry-run: config 미기록', () => withXdg((dir) => {
  const { out, code } = run(['setup', '--codex', '--scope', 'project', '--dry-run'], dir);
  assert.strictEqual(code, 0);
  assert.match(out, /done\./);
  assert.ok(!fs.existsSync(cfgPath(dir)), '비TTY/dry-run 은 config 를 쓰지 않는다');
}));

test('help 에 telemetry 서브커맨드가 문서화됨', () => withXdg((dir) => {
  assert.match(run(['help'], dir).out, /banker telemetry <on\|off\|status>/);
}));
