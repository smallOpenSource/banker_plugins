/*
 * update-notify 훅 테스트 (node:test + node:assert). 파일명이 .test.mjs 라 배포에서 제외된다.
 * XDG_CONFIG_HOME 을 mkdtemp 임시 디렉터리로 격리해 실제 홈/config 를 건드리지 않는다. 네트워크 0.
 *
 * 두 갈래로 검증한다:
 *  - 알림 동작(고지/무고지/dedupe/opt-out): 훅을 자식으로 spawn 해 stdout(systemMessage)·캐시 파일만
 *    관찰하는 블랙박스(telemetry-count.test.mjs 패턴). 설치 버전은 실제 plugin.json(0.8.z)이므로
 *    캐시 latest 를 0.0.1(구)·99.0.0(신)으로 브래킷해 실제 버전과 무관하게 판정한다.
 *  - fetcher 선택(chooseFetcher): detached spawn 은 관찰이 곤란하므로 순수 결정 함수를 in-process
 *    import 로 직접 단위테스트한다. (update-notify.mjs 는 직접 실행일 때만 main() 을 돌리므로 import
 *    시 stdin 을 읽지 않는다.)
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { chooseFetcher } from './update-notify.mjs';
import { installedVersion } from '../bin/lib/telemetry-config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const NOTIFY_HOOK = join(HERE, 'update-notify.mjs');

const tmps = [];
after(() => { for (const t of tmps) rmSync(t, { recursive: true, force: true }); });

function mkTmp() {
  const t = mkdtempSync(join(tmpdir(), 'banker-notify-'));
  tmps.push(t);
  return t;
}

const bankerDir = (tmp) => join(tmp, 'banker');
const cachePath = (tmp) => join(bankerDir(tmp), 'update-check.json');
const configPath = (tmp) => join(bankerDir(tmp), 'config.json');

function writeCache(tmp, obj) {
  mkdirSync(bankerDir(tmp), { recursive: true });
  writeFileSync(cachePath(tmp), JSON.stringify(obj));
}

function writeConfig(tmp, obj) {
  mkdirSync(bankerDir(tmp), { recursive: true });
  writeFileSync(configPath(tmp), JSON.stringify(obj));
}

const usedSkillsPath = (tmp) => join(bankerDir(tmp), 'used-skills.json');
function writeUsedSkills(tmp, arr) {
  mkdirSync(bankerDir(tmp), { recursive: true });
  writeFileSync(usedSkillsPath(tmp), JSON.stringify(arr));
}

const readCache = (tmp) => JSON.parse(readFileSync(cachePath(tmp), 'utf8'));

// 훅을 자식으로 spawn. XDG 격리 + BANKER_* 정리 후 overrides 적용(마지막에 이겨 opt-out 주입 가능).
// input 으로 SessionStart payload 를 흘려 stdin EOF 를 보장(비TTY 안전·드레인 검증).
// timeout 은 FIFO 에서 멈추는지 보는 시험용(지나면 죽인다). pre 는 훅보다 먼저 --import 로 불러올 모듈 경로.
function runNotify(tmp, { input = '{}', env: overrides = {}, timeout, pre } = {}) {
  const env = { ...process.env, XDG_CONFIG_HOME: tmp };
  delete env.BANKER_NO_UPDATE_CHECK;
  delete env.BANKER_NO_TELEMETRY;
  delete env.BANKER_TELEMETRY_ENDPOINT;
  Object.assign(env, overrides);
  const args = pre ? ['--import', pathToFileURL(pre).href, NOTIFY_HOOK] : [NOTIFY_HOOK];
  return spawnSync(process.execPath, args, { input, encoding: 'utf8', env, timeout });
}

const NOW = () => Date.now(); // fresh checkedAt → throttle 미경과 → 포그라운드에서 fetcher spawn 안 함.

// throttle 이 경과하는(유효 checkedAt 없는) 케이스는 갱신 fetcher 를 detached spawn 한다. 그 spawn 이
// 실제 외부(npm) 를 때리지 않도록 도달 불가 loopback 엔드포인트로 유도한다(telemetry-count.test.mjs 패턴).
// countingActive+endpoint → update-checkin 선택 → 127.0.0.1:1 POST → 즉시 실패·삼킴. 고지 판정에는 무영향.
const LOOPBACK = { env: { BANKER_TELEMETRY_ENDPOINT: 'http://127.0.0.1:1/collect' } };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Polls `ok` every 50 ms until it holds or `ms` pass (then fails with `msg`).
async function until(ok, ms, msg) {
  for (const end = Date.now() + ms; !ok(); await sleep(50)) {
    if (Date.now() > end) assert.fail(msg);
  }
}
// The detached checkin of a LOOPBACK run fails and writes the time it tried as its last act: waiting for that keeps
// it from writing into a folder the cleanup already removed.
const tried = (tmp) => {
  try { return typeof readCache(tmp).triedAt === 'number'; } catch { return false; }
};

// ---- 알림 동작 (블랙박스 spawn) ----

test('캐시 없음이면 무고지(빈 stdout·exit 0)', async () => {
  const tmp = mkTmp();
  const res = runNotify(tmp, LOOPBACK); // 캐시 없음 → throttle 경과 → detached refresh(loopback 로 무해화)
  await until(() => tried(tmp), 10000, '뒤에서 띄운 체크인이 실패하고 시도 시각을 쓴다');
  assert.equal(res.status, 0);
  assert.equal(res.stdout.trim(), '');
});

test('구버전 캐시(latest <= 설치)면 무고지', () => {
  const tmp = mkTmp();
  writeCache(tmp, { latest: '0.0.1', checkedAt: NOW() });
  const res = runNotify(tmp);
  assert.equal(res.status, 0);
  assert.equal(res.stdout.trim(), '');
});

test('동일 버전 캐시(latest == 설치)면 무고지', () => {
  const tmp = mkTmp();
  writeCache(tmp, { latest: installedVersion(), checkedAt: NOW() });
  const res = runNotify(tmp);
  assert.equal(res.status, 0);
  assert.equal(res.stdout.trim(), '');
});

test('신버전 캐시(latest > 설치)면 systemMessage 고지 + notified 병합 기록(형제 보존)', () => {
  const tmp = mkTmp();
  const t0 = NOW();
  writeCache(tmp, { latest: '99.0.0', checkedAt: t0 });
  const res = runNotify(tmp);
  assert.equal(res.status, 0);

  const out = JSON.parse(res.stdout.trim());
  assert.ok(typeof out.systemMessage === 'string', 'systemMessage 필드 존재(사용자 가시 채널)');
  assert.match(out.systemMessage, /banker 99\.0\.0 사용 가능/);
  assert.match(out.systemMessage, new RegExp('현재 ' + installedVersion().replace(/\./g, '\\.')));
  assert.match(out.systemMessage, /\/banker:update-banker/);
  assert.match(out.systemMessage, /npm i -g @kaydash9999\/banker-plugins/);
  assert.ok(!/\u2014/.test(out.systemMessage), 'em-dash(U+2014) 없음');
  assert.ok(!/\p{Extended_Pictographic}/u.test(out.systemMessage), '이모지 없음');

  const c = readCache(tmp);
  assert.equal(c.notified, '99.0.0', '재고지 방지: notified=latest 기록');
  assert.equal(c.latest, '99.0.0', '형제 필드 latest 보존');
  assert.equal(c.checkedAt, t0, '형제 필드 checkedAt 보존');
});

test('동일 latest 재호출(notified==latest)이면 무고지(dedupe)', () => {
  const tmp = mkTmp();
  writeCache(tmp, { latest: '99.0.0', checkedAt: NOW(), notified: '99.0.0' });
  const res = runNotify(tmp);
  assert.equal(res.status, 0);
  assert.equal(res.stdout.trim(), '');
});

test('새 latest 도착(notified!=latest)이면 다시 고지', () => {
  const tmp = mkTmp();
  writeCache(tmp, { latest: '99.0.0', checkedAt: NOW(), notified: '98.0.0' });
  const res = runNotify(tmp);
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout.trim());
  assert.match(out.systemMessage, /99\.0\.0/);
  assert.equal(readCache(tmp).notified, '99.0.0');
});

test('시퀀스 회귀: 고지 후 재호출은 무고지(notified 병합이 재고지를 막는다)', () => {
  const tmp = mkTmp();
  writeCache(tmp, { latest: '99.0.0', checkedAt: NOW() });
  const first = runNotify(tmp);
  assert.equal(first.status, 0);
  assert.notEqual(first.stdout.trim(), '', '첫 호출은 고지');
  assert.equal(readCache(tmp).notified, '99.0.0');
  const second = runNotify(tmp); // 캐시가 이제 notified==latest.
  assert.equal(second.status, 0);
  assert.equal(second.stdout.trim(), '', '둘째 호출은 dedupe');
});

test('BANKER_NO_UPDATE_CHECK=1 이면 무동작(신버전 캐시여도 무고지·캐시 미변경)', () => {
  const tmp = mkTmp();
  writeCache(tmp, { latest: '99.0.0', checkedAt: NOW() });
  const res = runNotify(tmp, { env: { BANKER_NO_UPDATE_CHECK: '1' } });
  assert.equal(res.status, 0);
  assert.equal(res.stdout.trim(), '');
  assert.ok(!('notified' in readCache(tmp)), 'opt-out 은 캐시도 건드리지 않는다');
});

test('config.updateCheck===false 면 무동작', () => {
  const tmp = mkTmp();
  writeCache(tmp, { latest: '99.0.0', checkedAt: NOW() });
  writeConfig(tmp, { updateCheck: false });
  const res = runNotify(tmp);
  assert.equal(res.status, 0);
  assert.equal(res.stdout.trim(), '');
});

test('malformed 캐시면 무고지·exit 0', async () => {
  const tmp = mkTmp();
  mkdirSync(bankerDir(tmp), { recursive: true });
  writeFileSync(cachePath(tmp), '{ broken ');
  const res = runNotify(tmp, LOOPBACK); // malformed → readCache null → throttle 경과 → detached refresh(loopback)
  await until(() => tried(tmp), 10000, '뒤에서 띄운 체크인이 실패하고 시도 시각을 쓴다');
  assert.equal(res.status, 0);
  assert.equal(res.stdout.trim(), '');
});

test('캐시 latest 가 비-semver 면 무고지(compareVersions 미확정)', () => {
  const tmp = mkTmp();
  writeCache(tmp, { latest: 'not-a-version', checkedAt: NOW() });
  const res = runNotify(tmp);
  assert.equal(res.status, 0);
  assert.equal(res.stdout.trim(), '');
});

test('malformed stdin payload 여도 캐시 기반 고지는 정상(파싱 실패 무해·exit 0)', () => {
  const tmp = mkTmp();
  writeCache(tmp, { latest: '99.0.0', checkedAt: NOW() });
  const res = runNotify(tmp, { input: '{not json' });
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout.trim());
  assert.match(out.systemMessage, /99\.0\.0/);
});

test('체크인이 실패한 뒤 하루 안의 세션 시작은 다시 시도하지 않는다(네트워크 없는 곳)', async () => {
  const tmp = mkTmp();
  const seen = [];
  const server = net.createServer((sock) => { seen.push(Date.now()); sock.destroy(); }); // 받자마자 끊는다
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const env = { BANKER_TELEMETRY_ENDPOINT: `http://127.0.0.1:${server.address().port}/collect` };
  try {
    runNotify(tmp, { env });                  // 캐시 없음: 뒤에서 체크인을 띄운다
    await until(() => seen.length === 1 && tried(tmp), 10000, '첫 체크인이 끊기고 시도 시각을 쓴다');
    assert.deepEqual(Object.keys(readCache(tmp)), ['triedAt'], '실패는 latest 와 checkedAt 을 쓰지 않는다');
    runNotify(tmp, { env });                  // 실패한 지 하루 안
    await sleep(1500);
    assert.equal(seen.length, 1, '두 번째 세션 시작은 연결하지 않는다');
  } finally {
    server.close();
  }
});

test('캐시 자리가 FIFO 여도 기다리지 않는다', { skip: process.platform === 'win32' && 'Windows 에는 FIFO 가 없다' }, async () => {
  const tmp = mkTmp();
  mkdirSync(bankerDir(tmp), { recursive: true });
  assert.equal(spawnSync('mkfifo', [cachePath(tmp)]).status, 0, 'mkfifo');
  // The check-in the hook starts replaces the FIFO when it writes the time it tried: a server that holds the
  // connection keeps it from writing until the FIFO has been looked at.
  const held = [];
  const server = net.createServer((sock) => held.push(sock));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const env = { BANKER_TELEMETRY_ENDPOINT: `http://127.0.0.1:${server.address().port}/collect` };
  try {
    const res = runNotify(tmp, { env, timeout: 10_000 });
    assert.equal(res.signal, null, '훅이 스스로 끝났다');
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), '', '캐시를 읽지 못하면 알리지 않는다');
    await until(() => held.length === 1, 10000, '뒤 체크인이 연결해 기다린다');
    assert.equal(lstatSync(cachePath(tmp)).isFIFO(), true, 'FIFO 는 그대로');
  } finally {
    for (const sock of held) sock.destroy();
    server.close();
  }
  // lstat first: reading the FIFO itself would block this process.
  const triedFile = () => { try { return lstatSync(cachePath(tmp)).isFile() && tried(tmp); } catch { return false; } };
  await until(triedFile, 10000, '뒤 체크인이 끝나고 시도 시각을 쓴다(지운 폴더에 늦게 쓰지 않게)');
});

// node:crypto 를 불러오지 못하는 Node 를 흉내 내는 시험 도구(--import). 배포에 들지 않는 scripts/ 아래에 있다.
const NO_CRYPTO = join(HERE, '..', 'scripts', 'test-fixtures', 'no-crypto.mjs');

test('crypto 를 불러오지 못하는 Node 에서도 알림을 보이고, 보일 것이 없으면 crypto 를 부르지 않는다', () => {
  const quiet = mkTmp();
  writeCache(quiet, { latest: '0.0.1', checkedAt: NOW() });
  const quietMark = join(quiet, 'crypto-mark');
  let res = runNotify(quiet, { env: { ...LOOPBACK.env, NO_CRYPTO_MARK: quietMark }, pre: NO_CRYPTO });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), '');
  assert.equal(existsSync(quietMark), false, '보일 알림이 없으면 crypto 를 부르지 않는다');

  const loud = mkTmp();
  writeCache(loud, { latest: '99.0.0', checkedAt: NOW() });
  const loudMark = join(loud, 'crypto-mark');
  res = runNotify(loud, { env: { ...LOOPBACK.env, NO_CRYPTO_MARK: loudMark }, pre: NO_CRYPTO });
  assert.equal(res.status, 0, res.stderr);
  assert.match(JSON.parse(res.stdout.trim()).systemMessage, /banker 99\.0\.0 사용 가능/);
  assert.equal(readCache(loud).notified, '99.0.0', '알린 버전을 캐시에 남긴다');
  assert.deepEqual(readdirSync(bankerDir(loud)).filter((n) => n.endsWith('.tmp')), [], '임시 파일이 남지 않는다');
  assert.deepEqual([...new Set(readFileSync(loudMark, 'utf8').split('\n').filter(Boolean))], ['cjs crypto'], '캐시를 쓸 때 불러오려다 대체 이름으로 쓴다');
});

// ---- 개인화 알림 (changedSkills ∩ 써본스킬) ----

test('개인화: changedSkills ∩ 써본스킬 이 있으면 그 스킬명을 알림에 넣는다', () => {
  const tmp = mkTmp();
  writeCache(tmp, { latest: '99.0.0', checkedAt: NOW(), changedSkills: ['banker:foo', 'banker:zeta'] });
  writeUsedSkills(tmp, ['banker:foo', 'banker:other']); // 교집합 = banker:foo
  const res = runNotify(tmp);
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout.trim());
  assert.match(out.systemMessage, /banker 99\.0\.0 사용 가능/);
  assert.match(out.systemMessage, /자주 쓰는 스킬이 이번 업데이트에서 바뀌었습니다: /);
  assert.match(out.systemMessage, /foo/, '교집합 스킬명(banker: 접두 제거) 포함');
  assert.ok(!/zeta/.test(out.systemMessage), '안 써본 zeta 는 제외');
  assert.ok(!/—/.test(out.systemMessage), 'em-dash 없음');
  assert.ok(!/\p{Extended_Pictographic}/u.test(out.systemMessage), '이모지 없음');
  assert.equal(readCache(tmp).notified, '99.0.0', '개인화 알림도 notified 기록(재고지 방지)');
});

test('개인화 없음: changedSkills 있어도 써본스킬 파일 없으면 일반 알림', () => {
  const tmp = mkTmp();
  writeCache(tmp, { latest: '99.0.0', checkedAt: NOW(), changedSkills: ['banker:foo'] });
  const res = runNotify(tmp); // used-skills 파일 없음.
  const out = JSON.parse(res.stdout.trim());
  assert.match(out.systemMessage, /banker 99\.0\.0 사용 가능/);
  assert.ok(!/자주 쓰는 스킬/.test(out.systemMessage), '교집합 없으면 개인화 문구 없음(일반 알림)');
});

test('개인화 없음: changedSkills 와 써본스킬이 겹치지 않으면 일반 알림', () => {
  const tmp = mkTmp();
  writeCache(tmp, { latest: '99.0.0', checkedAt: NOW(), changedSkills: ['banker:foo'] });
  writeUsedSkills(tmp, ['banker:other']);
  const res = runNotify(tmp);
  const out = JSON.parse(res.stdout.trim());
  assert.match(out.systemMessage, /banker 99\.0\.0 사용 가능/);
  assert.ok(!/자주 쓰는 스킬/.test(out.systemMessage), '공집합이면 개인화 문구 없음');
});

test('개인화: 교집합이 5개 초과면 5개 + "외 N개"', () => {
  const tmp = mkTmp();
  const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((x) => `banker:${x}`);
  writeCache(tmp, { latest: '99.0.0', checkedAt: NOW(), changedSkills: many });
  writeUsedSkills(tmp, many);
  const res = runNotify(tmp);
  const out = JSON.parse(res.stdout.trim());
  assert.match(out.systemMessage, /외 2개/, '7개 중 5개 표시 + 외 2개');
});

test('개인화 게이트: BANKER_NO_TELEMETRY 면 써본스킬·changedSkills 있어도 일반 알림(표시도 카운팅 게이트)', () => {
  const tmp = mkTmp();
  writeCache(tmp, { latest: '99.0.0', checkedAt: NOW(), changedSkills: ['banker:foo'] });
  writeUsedSkills(tmp, ['banker:foo']); // 교집합은 있지만 텔레메트리 opt-out.
  const res = runNotify(tmp, { env: { BANKER_NO_TELEMETRY: '1' } });
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout.trim());
  assert.match(out.systemMessage, /banker 99\.0\.0 사용 가능/, '업데이트 알림 자체는 표시(noUpdateCheck 아님)');
  assert.ok(!/자주 쓰는 스킬/.test(out.systemMessage), '텔레메트리 opt-out 이면 개인화 표시 안 함(countingActive 게이트)');
});

// ---- fetcher 선택 (in-process 순수 함수 단위테스트) ----

const ENV_KEYS = ['XDG_CONFIG_HOME', 'BANKER_NO_TELEMETRY', 'BANKER_TELEMETRY_ENDPOINT'];

// process.env 를 스냅샷/복원하며 XDG 격리 + config 를 세팅한 상태로 fn 을 실행한다.
function withConfig(cfg, overrides, fn) {
  const saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  const tmp = mkTmp();
  try {
    process.env.XDG_CONFIG_HOME = tmp;
    delete process.env.BANKER_NO_TELEMETRY;
    delete process.env.BANKER_TELEMETRY_ENDPOINT;
    Object.assign(process.env, overrides || {});
    if (cfg) writeConfig(tmp, cfg);
    return fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('chooseFetcher: countingActive+endpoint 면 update-checkin.mjs (이 파일 기준 경로)', () => {
  withConfig({ endpoint: 'https://example.test/collect' }, {}, () => {
    const p = chooseFetcher();
    assert.ok(p.endsWith('update-checkin.mjs'), p);
    assert.equal(dirname(p), HERE, 'fetcher 경로는 hooks/ 기준으로 resolve');
  });
});

test('chooseFetcher: default-on 이라 env·config 미설정이어도 내장 기본 엔드포인트로 update-checkin.mjs', () => {
  withConfig(null, {}, () => {
    // 내장 기본 엔드포인트로 countingActive 가 기본 true → 체크인이 알림 조회를 겸한다.
    assert.ok(chooseFetcher().endsWith('update-checkin.mjs'));
  });
});

test('chooseFetcher: BANKER_NO_TELEMETRY opt-out 이면 countingActive false → update-fetch.mjs', () => {
  withConfig({ endpoint: 'https://example.test/collect' }, { BANKER_NO_TELEMETRY: '1' }, () => {
    assert.ok(chooseFetcher().endsWith('update-fetch.mjs'));
  });
});

test('chooseFetcher: config.telemetry===false 면 countingActive false → update-fetch.mjs', () => {
  withConfig({ endpoint: 'https://example.test/collect', telemetry: false }, {}, () => {
    assert.ok(chooseFetcher().endsWith('update-fetch.mjs'));
  });
});

test('chooseFetcher: BANKER_TELEMETRY_ENDPOINT(env)만으로도 countingActive → update-checkin.mjs', () => {
  withConfig(null, { BANKER_TELEMETRY_ENDPOINT: 'https://env.test/collect' }, () => {
    assert.ok(chooseFetcher().endsWith('update-checkin.mjs'));
  });
});
