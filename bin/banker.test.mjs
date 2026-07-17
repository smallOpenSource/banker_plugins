/*
 * banker.js CLI 유닛테스트 (node:test): telemetry 서브커맨드(US-7) + 비TTY setup 가드(US-6).
 * 블랙박스로 실제 CLI 를 자식프로세스로 실행한다. stdin 은 파이프('' 입력)라 항상 비TTY 이며,
 * 프롬프트 경로는 절대 진입하지 않는다(hang 불가). XDG_CONFIG_HOME 임시 디렉터리로 실제 config 격리.
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

test('telemetry status 기본값: consent off / 엔드포인트 미설정 / effective disabled', () => withXdg((dir) => {
  const { out, code } = run(['telemetry', 'status'], dir);
  assert.strictEqual(code, 0);
  assert.match(out, /동의\(consent\): off/);
  assert.match(out, /엔드포인트 설정: 미설정/);
  assert.match(out, /실효 상태\(effective\): disabled/);
  assert.ok(!fs.existsSync(cfgPath(dir)), 'status 는 read-only: config 를 만들지 않는다');
}));

test('telemetry on -> config telemetry:true + 엔드포인트 미설정 안내', () => withXdg((dir) => {
  const { out, code } = run(['telemetry', 'on'], dir);
  assert.strictEqual(code, 0);
  assert.strictEqual(readCfg(dir).telemetry, true);
  assert.match(out, /켰습니다 \(on\)/);
  assert.match(out, /엔드포인트가 설정되어 있지 않아/);
}));

test('telemetry off -> config telemetry:false', () => withXdg((dir) => {
  run(['telemetry', 'on'], dir);
  const { out } = run(['telemetry', 'off'], dir);
  assert.strictEqual(readCfg(dir).telemetry, false);
  assert.match(out, /껐습니다 \(off\)/);
}));

test('telemetry on 은 기존 config 키를 보존한다 (spread merge)', () => withXdg((dir) => {
  fs.mkdirSync(path.join(dir, 'banker'), { recursive: true });
  fs.writeFileSync(cfgPath(dir), JSON.stringify({ endpoint: 'https://keep.test/c', foo: 1 }));
  run(['telemetry', 'on'], dir);
  assert.deepStrictEqual(readCfg(dir), { endpoint: 'https://keep.test/c', foo: 1, telemetry: true });
}));

test('status: 동의 on + 엔드포인트(env) 설정 시 effective enabled', () => withXdg((dir) => {
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
  assert.match(out, /BANKER_NO_TELEMETRY opt-out: 적용됨/);
  assert.match(out, /실효 상태\(effective\): disabled/);
}));

test('알 수 없는/누락 하위명령 -> 사용법 출력', () => withXdg((dir) => {
  assert.match(run(['telemetry', 'bogus'], dir).out, /Usage: banker telemetry <on\|off\|status>/);
  assert.match(run(['telemetry'], dir).out, /Usage: banker telemetry <on\|off\|status>/);
}));

test('비TTY setup --claude --dry-run: hang·프롬프트·persist 없이 done', () => withXdg((dir) => {
  const { out, code } = run(['setup', '--claude', '--dry-run'], dir);
  assert.strictEqual(code, 0);
  assert.match(out, /done\./);
  assert.ok(!/GitHub 별/.test(out) && !/익명 사용량 수집/.test(out), '비TTY 는 프롬프트 금지');
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
