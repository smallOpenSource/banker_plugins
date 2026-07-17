/*
 * update-checkin 훅 테스트 (node:test + node:assert). 파일명이 .test.mjs 라 배포에서 제외된다.
 * XDG_CONFIG_HOME 을 mkdtemp 로 격리한다. 네트워크는 로컬 mock http 서버 또는 확실히 닫힌 포트만 쓴다.
 * 성공 경로는 in-process http 서버와 통신해야 하므로 이벤트 루프를 막지 않도록 spawn(비동기)로 실행한다
 * (spawnSync 는 루프를 막아 in-process 서버와 데드락 - 그래서 async spawn 을 쓴다).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKIN_HOOK = join(HERE, 'update-checkin.mjs');
const PLUGIN_JSON = join(HERE, '..', '.claude-plugin', 'plugin.json');
const VERSION = JSON.parse(readFileSync(PLUGIN_JSON, 'utf8')).version;

const tmps = [];
after(() => { for (const t of tmps) rmSync(t, { recursive: true, force: true }); });

function mkTmp() {
  const t = mkdtempSync(join(tmpdir(), 'banker-checkin-'));
  tmps.push(t);
  return t;
}

const bankerDir = (tmp) => join(tmp, 'banker');
const usageLog = (tmp) => join(bankerDir(tmp), 'usage-log');
const lastFlush = (tmp) => join(bankerDir(tmp), 'last-flush');
const updateCheck = (tmp) => join(bankerDir(tmp), 'update-check.json');

function writeConfig(tmp, cfg) {
  mkdirSync(bankerDir(tmp), { recursive: true });
  writeFileSync(join(bankerDir(tmp), 'config.json'), JSON.stringify(cfg));
}

// 격리 env: XDG 로 config 를 tmp 에 가두고, 상속된 텔레메트리/업데이트 env 오버라이드를 제거한다.
function checkinEnv(tmp) {
  const env = { ...process.env, XDG_CONFIG_HOME: tmp };
  delete env.BANKER_NO_TELEMETRY;
  delete env.BANKER_TELEMETRY_ENDPOINT;
  delete env.BANKER_NO_UPDATE_CHECK;
  return env;
}

// in-process 서버와 통신하는 성공 경로용: 이벤트 루프를 살려두려면 비동기 spawn 이어야 한다.
function runCheckin(tmp) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [CHECKIN_HOOK], { env: checkinEnv(tmp), stdio: 'ignore' });
    child.on('close', (code) => resolvePromise(code ?? 0));
  });
}

// 확실히 닫힌 loopback 포트(열었다가 즉시 닫아 확보) -> 연결 즉시 거부(빠른 실패).
function closedPort() {
  return new Promise((resolvePromise) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolvePromise(port));
    });
  });
}

test('미활성(telemetry=false)이면 무동작: 로그를 truncate 하지 않고 요청도 없다', () => {
  const tmp = mkTmp();
  writeConfig(tmp, { telemetry: false, endpoint: 'http://127.0.0.1:1/collect' });
  writeFileSync(usageLog(tmp), 'banker:foo\t9\n');
  const res = spawnSync(process.execPath, [CHECKIN_HOOK], { encoding: 'utf8', env: checkinEnv(tmp) });
  assert.equal(res.status, 0);
  assert.equal(readFileSync(usageLog(tmp), 'utf8'), 'banker:foo\t9\n', '미활성이면 로그 그대로');
  assert.ok(!existsSync(lastFlush(tmp)), '미활성이면 last-flush 갱신 안 함');
  assert.ok(!existsSync(updateCheck(tmp)), '미활성이면 캐시 미생성(요청 없음)');
});

test('opt-out(BANKER_NO_TELEMETRY=1)이면 무동작: 로그 미변경·전송 없음', () => {
  const tmp = mkTmp();
  // 내장 기본 엔드포인트로 기본이 활성이므로 inactive 는 opt-out 으로 만든다(엔드포인트는 있어도 무동작).
  writeConfig(tmp, { telemetry: true, endpoint: 'http://127.0.0.1:1/collect' });
  writeFileSync(usageLog(tmp), 'banker:foo\t9\n');
  const env = checkinEnv(tmp);
  env.BANKER_NO_TELEMETRY = '1';
  const res = spawnSync(process.execPath, [CHECKIN_HOOK], { encoding: 'utf8', env });
  assert.equal(res.status, 0);
  assert.equal(readFileSync(usageLog(tmp), 'utf8'), 'banker:foo\t9\n', 'opt-out 이면 로그 그대로');
  assert.ok(!existsSync(lastFlush(tmp)));
  assert.ok(!existsSync(updateCheck(tmp)));
});

test('정상 체크인: 스킬별 x 시간대 counts/version/os POST, PII/IP/식별자 없음, 로그 truncate', async () => {
  let body = null;
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      try { body = JSON.parse(data); } catch { /* ignore */ }
      res.writeHead(200);
      res.end(JSON.stringify({ latest: '0.9.0' }));
    });
  });
  try {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const tmp = mkTmp();
    writeConfig(tmp, { telemetry: true, endpoint: `http://127.0.0.1:${port}/collect` });
    // banker:compact-copy 는 9시 3회 + 14시 1회, banker:setup 은 9시 1회.
    writeFileSync(usageLog(tmp),
      'banker:compact-copy\t9\nbanker:compact-copy\t9\nbanker:compact-copy\t9\nbanker:compact-copy\t14\nbanker:setup\t9\n');

    const code = await runCheckin(tmp);

    assert.equal(code, 0);
    assert.ok(body, '서버가 JSON 본문을 받았다');
    assert.deepEqual(body.counts, {
      'banker:compact-copy': { '9': 3, '14': 1 },
      'banker:setup': { '9': 1 },
    }, '스킬별 x 시간대별 count 집계');
    assert.equal(body.version, VERSION, 'plugin.json 버전');
    assert.equal(body.os, process.platform, '플랫폼 계열');
    assert.deepEqual(Object.keys(body).sort(), ['counts', 'os', 'version'], '오직 세 키');
    // PII/IP/식별자 없음: 식별자성 키 부재 + 호스트명/사용자명 문자열 미포함.
    for (const k of ['ip', 'host', 'hostname', 'user', 'username', 'session', 'sessionId', 'id', 'uuid', 'mac', 'cwd']) {
      assert.ok(!(k in body), `식별자 키 없음: ${k}`);
    }
    const serial = JSON.stringify(body);
    assert.ok(!serial.includes(os.hostname()), '호스트명 미포함');
    try { assert.ok(!serial.includes(os.userInfo().username), '사용자명 미포함'); } catch { /* userInfo 불가 환경 */ }
    assert.equal(readFileSync(usageLog(tmp), 'utf8'), '', '전송 후 로그 truncate');
    assert.ok(existsSync(lastFlush(tmp)), 'last-flush 갱신');
  } finally {
    server.close();
  }
});

test('malformed/빈 줄은 무시하고 유효한 name\\thour 만 집계한다', async () => {
  let body = null;
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      try { body = JSON.parse(data); } catch { /* ignore */ }
      res.writeHead(200);
      res.end('ok'); // latest 없음 - 캐시 미변경 경로.
    });
  });
  try {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const tmp = mkTmp();
    writeConfig(tmp, { telemetry: true, endpoint: `http://127.0.0.1:${port}/collect` });
    // 유효: banker:foo\t0, banker:foo\t0 / 무시: 빈 줄, TAB 없는 줄, hour 24(범위밖), hour 비수치, 이름 없음.
    writeFileSync(usageLog(tmp),
      'banker:foo\t0\n\nbanker:foo\t0\nbanker:noTab\nbanker:foo\t24\nbanker:foo\tx\n\t9\n');

    const code = await runCheckin(tmp);

    assert.equal(code, 0);
    assert.ok(body, '서버가 JSON 본문을 받았다');
    assert.deepEqual(body.counts, { 'banker:foo': { '0': 2 } }, 'malformed/범위밖 무시, 유효 줄만 집계');
    assert.ok(!existsSync(updateCheck(tmp)), 'latest 없는 응답이면 캐시 미변경');
    assert.equal(readFileSync(usageLog(tmp), 'utf8'), '', '전송 후 로그 truncate');
  } finally {
    server.close();
  }
});

test('응답 {latest} 수신 시 update-check 캐시에 latest 기록(알림 겸함)', async () => {
  const server = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200);
      res.end(JSON.stringify({ latest: '0.9.0' }));
    });
  });
  try {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const tmp = mkTmp();
    writeConfig(tmp, { telemetry: true, endpoint: `http://127.0.0.1:${port}/collect` });
    writeFileSync(usageLog(tmp), 'banker:foo\t9\n');

    const code = await runCheckin(tmp);

    assert.equal(code, 0);
    assert.ok(existsSync(updateCheck(tmp)), 'update-check 캐시 생성');
    const cache = JSON.parse(readFileSync(updateCheck(tmp), 'utf8'));
    assert.equal(cache.latest, '0.9.0', '응답 latest 를 캐시에 기록');
    assert.equal(typeof cache.checkedAt, 'number', 'checkedAt 타임스탬프 기록');
  } finally {
    server.close();
  }
});

test('전송 실패(도달 불가 endpoint)에도 로그 truncate 하고 hang 하지 않는다', async () => {
  const tmp = mkTmp();
  const port = await closedPort();
  writeConfig(tmp, { telemetry: true, endpoint: `http://127.0.0.1:${port}/collect` });
  writeFileSync(usageLog(tmp), 'banker:foo\t9\nbanker:bar\t14\n');

  const start = Date.now();
  const res = spawnSync(process.execPath, [CHECKIN_HOOK], { encoding: 'utf8', env: checkinEnv(tmp) });
  const elapsed = Date.now() - start;

  assert.equal(res.status, 0);
  assert.equal(readFileSync(usageLog(tmp), 'utf8'), '', '실패해도 로그를 비운다(24h 상한)');
  assert.ok(existsSync(lastFlush(tmp)), 'last-flush 갱신');
  assert.ok(!existsSync(updateCheck(tmp)), '전송 실패면 latest 없음 -> 캐시 미생성');
  assert.ok(elapsed < 9000, `hang 없이 빠르게 종료(${elapsed}ms) - 연결 거부가 10s timeout 전에 처리`);
});

test('비-loopback 평문 http 는 전송하지 않는다(no-op·연결 시도 없음, exit 0)', () => {
  const tmp = mkTmp();
  // 192.0.2.1 = TEST-NET-1(RFC5737) 문서화용 예약대역(라우팅 불가). loopback 이 아니므로 평문
  // http 는 가드에 막혀 연결조차 시도하지 않아야 한다(가드 없으면 최대 10s hang). 실제 유출 0.
  writeConfig(tmp, { telemetry: true, endpoint: 'http://192.0.2.1:80/collect' });
  writeFileSync(usageLog(tmp), 'banker:foo\t9\n');
  const start = Date.now();
  const res = spawnSync(process.execPath, [CHECKIN_HOOK], { encoding: 'utf8', env: checkinEnv(tmp) });
  const elapsed = Date.now() - start;
  assert.equal(res.status, 0);
  assert.ok(elapsed < 3000, `가드가 연결 시도 없이 즉시 no-op 이어야 한다(${elapsed}ms, 10s timeout 아님)`);
  assert.ok(!existsSync(updateCheck(tmp)), '전송 안 하므로 latest 없음 -> 캐시 미생성');
  // 전송 안 해도 체크인은 전송 시도 후 로그를 비우는 24h 상한 불변을 유지한다.
  assert.equal(readFileSync(usageLog(tmp), 'utf8'), '', '차단돼도 로그 truncate(배치 유실 허용)');
});
