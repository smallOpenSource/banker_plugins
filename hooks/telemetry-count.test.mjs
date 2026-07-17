/*
 * telemetry-count 훅 테스트 (node:test + node:assert). 파일명이 .test.mjs 라 배포에서 제외된다.
 * XDG_CONFIG_HOME 을 mkdtemp 임시 디렉터리로 지정해 실제 홈/config 를 건드리지 않는다. 네트워크 0.
 * 각 테스트는 훅을 자식 프로세스로 spawn 하고, <tmp>/banker/ 아래 산출물만 검사한다.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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
const lastFlush = (tmp) => join(bankerDir(tmp), 'last-flush');
const flushLock = (tmp) => join(bankerDir(tmp), 'last-flush.lock'); // claimFlush 의 mkdir 락(= LAST_FLUSH_PATH + '.lock').

// 24h 윈도우 판정용 시각 조작: 파일 mtime 을 hoursAgo 시간 전으로 되돌린다(flushDue/stale-lock 검증).
function ageFile(path, hoursAgo) {
  const t = new Date(Date.now() - hoursAgo * 3600_000);
  utimesSync(path, t, t);
}

// claim 이 방금 연 fresh ISO 타임스탬프인지. content sentinel(OLD_ISO)과 구별해 "flush 기동 여부"를 관찰한다.
function isFreshIso(s) {
  const t = Date.parse((s || '').trim());
  return Number.isFinite(t) && Math.abs(Date.now() - t) < 120_000;
}

// last-flush content sentinel: claim 이 이 값을 덮어썼는지로 기동 여부를 본다. 과거 ISO 라 mtime(24h 판정)과 무관.
const OLD_ISO = '2000-01-01T00:00:00.000Z';

// 동의 상태로 만든다. freshFlush=true 면 last-flush 를 현재 시각으로 써 flush spawn 을 막는다
// (테스트가 flush 의 detached 부작용과 경합하지 않도록). endpoint 는 도달 불가 주소(안전망).
function enable(tmp, { freshFlush = true, endpoint = 'http://127.0.0.1:1/collect' } = {}) {
  mkdirSync(bankerDir(tmp), { recursive: true });
  writeFileSync(join(bankerDir(tmp), 'config.json'), JSON.stringify({ telemetry: true, endpoint }));
  if (freshFlush) writeFileSync(lastFlush(tmp), new Date().toISOString());
}

function runCount(tmp, input) {
  const env = { ...process.env, XDG_CONFIG_HOME: tmp };
  delete env.BANKER_NO_TELEMETRY;
  delete env.BANKER_TELEMETRY_ENDPOINT;
  return spawnSync(process.execPath, [COUNT_HOOK], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env,
  });
}

test('미동의면 무동작: 로그 파일조차 만들지 않는다', () => {
  const tmp = mkTmp(); // config 없음 -> isEnabled false.
  const res = runCount(tmp, { command: 'banker:foo' });
  assert.equal(res.status, 0);
  assert.ok(!existsSync(usageLog(tmp)), '미동의 훅은 로컬 쓰기조차 하지 않는다');
});

test('malformed stdin 이면 exit 0 (쓰기 없음)', () => {
  const tmp = mkTmp();
  enable(tmp);
  const res = runCount(tmp, '{not json');
  assert.equal(res.status, 0);
  assert.ok(!existsSync(usageLog(tmp)), 'parse 실패는 어떤 추출/쓰기보다 앞서 종료된다');
});

test('동의 + banker:foo 이벤트면 로그에 한 줄 append', () => {
  const tmp = mkTmp();
  enable(tmp);
  const res = runCount(tmp, { command: 'banker:foo' });
  assert.equal(res.status, 0);
  assert.equal(readFileSync(usageLog(tmp), 'utf8'), 'banker:foo\n');
});

test('방어적 추출: 알려지지 않은 중첩 필드도 원시 stdin 스캔으로 잡는다', () => {
  const tmp = mkTmp();
  enable(tmp);
  // 커맨드 이름이 미지의 키에만 있어도(payload 필드 미검증) raw 스캔이 banker:bar 를 찾는다.
  const res = runCount(tmp, { some_unknown: { deeply: 'please run /banker:bar now' } });
  assert.equal(res.status, 0);
  assert.equal(readFileSync(usageLog(tmp), 'utf8'), 'banker:bar\n');
});

test('banker:<name> 토큰이 없으면 무동작', () => {
  const tmp = mkTmp();
  enable(tmp);
  const res = runCount(tmp, { prompt: 'hello world, nothing to see here' });
  assert.equal(res.status, 0);
  assert.ok(!existsSync(usageLog(tmp)), '토큰 없으면 로그를 만들지 않는다');
});

test('상한(LOG_MAX_LINES) 도달 시 append 스킵', () => {
  const tmp = mkTmp();
  enable(tmp);
  writeFileSync(usageLog(tmp), 'banker:x\n'.repeat(LOG_MAX_LINES)); // 정확히 상한.
  const res = runCount(tmp, { command: 'banker:foo' });
  assert.equal(res.status, 0);
  const lines = readFileSync(usageLog(tmp), 'utf8').split('\n').filter(Boolean).length;
  assert.equal(lines, LOG_MAX_LINES, '상한에서는 더 쌓지 않는다(flush 가 비우면 재개)');
});

/*
 * herd 방지 동시성 가드(US-3a AC "24h당 flush 정확히 1회 기동"). flushDue/claimFlush 는 export 되지
 * 않으므로(모듈 로드 시 main() 이 stdin 을 읽음) 훅을 spawn 해 last-flush/lock 파일 상태로 관찰하는
 * 블랙박스 테스트다. enable({freshFlush:false}) 로 last-flush 를 직접 통제하고, endpoint 는 loopback
 * 도달 불가 주소(127.0.0.1:1)라 승자가 spawn 하는 flush 는 즉시 실패한다(실제 네트워크 전송 0).
 * "기동함" = claim 이 last-flush 를 fresh ISO 로 열었다(부모가 spawn 전에 동기 기록). "기동 안 함" =
 * last-flush 부재 유지 또는 sentinel content 보존.
 */
test('flushDue: 신선한 last-flush(24h 미만)면 flush 를 기동하지 않는다', () => {
  const tmp = mkTmp();
  enable(tmp, { freshFlush: false });
  writeFileSync(lastFlush(tmp), OLD_ISO); // mtime=now -> flushDue false, content=sentinel.
  const res = runCount(tmp, { command: 'banker:foo' });
  assert.equal(res.status, 0);
  assert.equal(readFileSync(lastFlush(tmp), 'utf8'), OLD_ISO, '24h 미만이면 claim 이 윈도우를 다시 열지 않는다');
  assert.ok(!existsSync(flushLock(tmp)), '기동 안 했으니 락 잔재도 없다');
});

test('flushDue: last-flush 부재면 24h 초과로 보고 claim 이 윈도우를 연다', () => {
  const tmp = mkTmp();
  enable(tmp, { freshFlush: false }); // last-flush 없음.
  assert.ok(!existsSync(lastFlush(tmp)), '사전 조건: last-flush 부재');
  const res = runCount(tmp, { command: 'banker:foo' });
  assert.equal(res.status, 0);
  assert.ok(existsSync(lastFlush(tmp)), '부재면 flushDue true -> claim 이 last-flush 를 생성');
  assert.ok(isFreshIso(readFileSync(lastFlush(tmp), 'utf8')), 'fresh ISO 로 새 24h 윈도우를 연다');
});

test('flushDue: stale last-flush(24h 초과)면 claim 이 새 윈도우를 연다', () => {
  const tmp = mkTmp();
  enable(tmp, { freshFlush: false });
  writeFileSync(lastFlush(tmp), OLD_ISO);
  ageFile(lastFlush(tmp), 25); // mtime 25h 전 -> flushDue true.
  const res = runCount(tmp, { command: 'banker:foo' });
  assert.equal(res.status, 0);
  const after = readFileSync(lastFlush(tmp), 'utf8');
  assert.notEqual(after, OLD_ISO, 'stale 면 claim 이 sentinel 을 덮어쓴다');
  assert.ok(isFreshIso(after), '덮어쓴 값은 fresh ISO(새 윈도우)');
});

test('claimFlush: 락이 잡혀 있으면(동시 호출) claim 을 양보한다(윈도우당 1회)', () => {
  const tmp = mkTmp();
  enable(tmp, { freshFlush: false }); // last-flush 부재 -> flushDue true.
  mkdirSync(flushLock(tmp)); // 다른 훅이 이미 claim 중(fresh 락).
  const res = runCount(tmp, { command: 'banker:foo' });
  assert.equal(res.status, 0);
  assert.ok(!existsSync(lastFlush(tmp)), '락 보유 중이면 mkdir 실패 -> claim 양보 -> 윈도우 미오픈');
  assert.ok(existsSync(flushLock(tmp)), '남의 락은 건드리지 않는다');
});

test('claimFlush: 24h 초과 stale 락은 회수하고 claim 한다', () => {
  const tmp = mkTmp();
  enable(tmp, { freshFlush: false });
  mkdirSync(flushLock(tmp));
  ageFile(flushLock(tmp), 25); // 크래시로 남은 stale 락(정상 보유는 microsecond).
  const res = runCount(tmp, { command: 'banker:foo' });
  assert.equal(res.status, 0);
  assert.ok(existsSync(lastFlush(tmp)), 'stale 락 회수 후 claim 이 윈도우를 연다');
  assert.ok(isFreshIso(readFileSync(lastFlush(tmp), 'utf8')), 'fresh ISO 로 윈도우 오픈');
  assert.ok(!existsSync(flushLock(tmp)), '승자는 finally 에서 자기 락을 제거한다');
});

test('herd 방지: 락이 잡힌 채 연속 두 번 spawn 해도 어느 쪽도 flush 를 열지 않는다', () => {
  const tmp = mkTmp();
  enable(tmp, { freshFlush: false }); // last-flush 부재 -> 두 번 다 flushDue true.
  mkdirSync(flushLock(tmp)); // 승자(다른 훅)가 claim 을 쥔 상황.
  const a = runCount(tmp, { command: 'banker:foo' });
  const b = runCount(tmp, { command: 'banker:foo' });
  assert.equal(a.status, 0);
  assert.equal(b.status, 0);
  assert.ok(!existsSync(lastFlush(tmp)), '두 후발 훅 모두 claim 양보 -> 윈도우 미오픈(0회 기동)');
  assert.ok(existsSync(flushLock(tmp)), '승자의 락은 두 호출 내내 보존된다');
});
