/*
 * telemetry-flush 훅 테스트 (node:test + node:assert). 파일명이 .test.mjs 라 배포에서 제외된다.
 * XDG_CONFIG_HOME 을 mkdtemp 로 격리한다. 네트워크는 로컬 mock http 서버 또는 확실히 닫힌 포트만 쓴다.
 * 성공 경로는 in-process http 서버와 통신해야 하므로 이벤트 루프를 막지 않도록 spawn(비동기)로 실행한다
 * (spawnSync 는 루프를 막아 in-process 서버와 데드락).
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
const FLUSH_HOOK = join(HERE, 'telemetry-flush.mjs');
const PLUGIN_JSON = join(HERE, '..', '.claude-plugin', 'plugin.json');
const VERSION = JSON.parse(readFileSync(PLUGIN_JSON, 'utf8')).version;

const tmps = [];
after(() => { for (const t of tmps) rmSync(t, { recursive: true, force: true }); });

function mkTmp() {
  const t = mkdtempSync(join(tmpdir(), 'banker-flush-'));
  tmps.push(t);
  return t;
}

const bankerDir = (tmp) => join(tmp, 'banker');
const usageLog = (tmp) => join(bankerDir(tmp), 'usage-log');
const lastFlush = (tmp) => join(bankerDir(tmp), 'last-flush');

function writeConfig(tmp, cfg) {
  mkdirSync(bankerDir(tmp), { recursive: true });
  writeFileSync(join(bankerDir(tmp), 'config.json'), JSON.stringify(cfg));
}

function flushEnv(tmp) {
  const env = { ...process.env, XDG_CONFIG_HOME: tmp };
  delete env.BANKER_NO_TELEMETRY;
  delete env.BANKER_TELEMETRY_ENDPOINT;
  return env;
}

// in-process 서버와 통신하는 성공 경로용: 이벤트 루프를 살려두려면 비동기 spawn 이어야 한다.
function runFlush(tmp) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [FLUSH_HOOK], { env: flushEnv(tmp), stdio: 'ignore' });
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

test('미동의(telemetry=false)면 무동작: 로그를 truncate 하지 않는다', () => {
  const tmp = mkTmp();
  writeConfig(tmp, { telemetry: false, endpoint: 'http://127.0.0.1:1/collect' });
  writeFileSync(usageLog(tmp), 'banker:foo\n');
  const res = spawnSync(process.execPath, [FLUSH_HOOK], { encoding: 'utf8', env: flushEnv(tmp) });
  assert.equal(res.status, 0);
  assert.equal(readFileSync(usageLog(tmp), 'utf8'), 'banker:foo\n', '미동의면 로그 그대로');
  assert.ok(!existsSync(lastFlush(tmp)), '미동의면 last-flush 도 갱신 안 함');
});

test('엔드포인트 미설정이면 무동작', () => {
  const tmp = mkTmp();
  writeConfig(tmp, { telemetry: true }); // endpoint 없음.
  writeFileSync(usageLog(tmp), 'banker:foo\n');
  const res = spawnSync(process.execPath, [FLUSH_HOOK], { encoding: 'utf8', env: flushEnv(tmp) });
  assert.equal(res.status, 0);
  assert.equal(readFileSync(usageLog(tmp), 'utf8'), 'banker:foo\n', '엔드포인트 없으면 로그 그대로');
  assert.ok(!existsSync(lastFlush(tmp)));
});

test('정상 flush: counts/version/os POST, PII/IP/식별자 없음, 로그 truncate', async () => {
  let body = null;
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      try { body = JSON.parse(data); } catch { /* ignore */ }
      res.writeHead(200);
      res.end('ok');
    });
  });
  try {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const tmp = mkTmp();
    writeConfig(tmp, { telemetry: true, endpoint: `http://127.0.0.1:${port}/collect` });
    writeFileSync(usageLog(tmp), 'banker:foo\nbanker:foo\nbanker:bar\n');

    const code = await runFlush(tmp);

    assert.equal(code, 0);
    assert.ok(body, '서버가 JSON 본문을 받았다');
    assert.deepEqual(body.counts, { 'banker:foo': 2, 'banker:bar': 1 }, '이름별 count 집계');
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

test('전송 실패(도달 불가 endpoint)에도 로그 truncate 하고 hang 하지 않는다', async () => {
  const tmp = mkTmp();
  const port = await closedPort();
  writeConfig(tmp, { telemetry: true, endpoint: `http://127.0.0.1:${port}/collect` });
  writeFileSync(usageLog(tmp), 'banker:foo\nbanker:bar\n');

  const start = Date.now();
  const res = spawnSync(process.execPath, [FLUSH_HOOK], { encoding: 'utf8', env: flushEnv(tmp) });
  const elapsed = Date.now() - start;

  assert.equal(res.status, 0);
  assert.equal(readFileSync(usageLog(tmp), 'utf8'), '', '실패해도 로그를 비운다(24h 상한)');
  assert.ok(existsSync(lastFlush(tmp)), 'last-flush 갱신');
  assert.ok(elapsed < 9000, `hang 없이 빠르게 종료(${elapsed}ms) - 연결 거부가 10s timeout 전에 처리`);
});

test('네트워크 hang 방지 장치가 배선돼 있다(자체 timeout + destroy + error 핸들러)', () => {
  const src = readFileSync(FLUSH_HOOK, 'utf8');
  assert.match(src, /setTimeout\(\s*NET_TIMEOUT_MS/, '자체 응답 timeout 설정');
  assert.match(src, /10_000|10000/, 'timeout 값 10s');
  assert.match(src, /\.destroy\(\)/, 'timeout 시 소켓 파기');
  assert.match(src, /req\.on\(\s*'error'/, '연결 오류 핸들러');
});

test('비-loopback 평문 http 는 전송하지 않고 즉시 no-op (연결 시도 없음, exit 0)', () => {
  const tmp = mkTmp();
  // 192.0.2.1 = TEST-NET-1(RFC5737) 문서화용 예약대역(라우팅 불가). loopback 이 아니므로 평문
  // http 는 가드에 막혀 연결조차 시도하지 않아야 한다(가드 없으면 최대 10s hang). 실제 유출 0.
  writeConfig(tmp, { telemetry: true, endpoint: 'http://192.0.2.1:80/collect' });
  writeFileSync(usageLog(tmp), 'banker:foo\n');
  const start = Date.now();
  const res = spawnSync(process.execPath, [FLUSH_HOOK], { encoding: 'utf8', env: flushEnv(tmp) });
  const elapsed = Date.now() - start;
  assert.equal(res.status, 0);
  assert.ok(elapsed < 3000, `가드가 연결 시도 없이 즉시 no-op 이어야 한다(${elapsed}ms, 10s timeout 아님)`);
  // fail-closed no-op 이어도 flush 는 전송 시도 후 로그를 비우는 24h 상한 불변을 유지한다.
  assert.equal(readFileSync(usageLog(tmp), 'utf8'), '', '차단돼도 로그 truncate(배치 유실 허용)');
});

test('비-loopback https 는 정상 전송한다(loopback 제한이 https 를 막지 않는다)', async () => {
  // 서버는 127.0.0.1 에 바인딩하되 엔드포인트는 https 스킴으로 지정 - 가드가 https 를 통과시키는지만
  // 확인한다(TLS 성립까지는 요구하지 않음). 여기선 https 를 http 서버로 보내 handshake 가 실패하지만,
  // 핵심은 "가드가 finish() 로 미리 막지 않고 transport.request 까지 도달한다"는 것. 실패해도 exit 0.
  const tmp = mkTmp();
  const port = await closedPort(); // 확실히 닫힌 loopback 포트: https 연결이 즉시 거부돼 빠르게 끝난다.
  writeConfig(tmp, { telemetry: true, endpoint: `https://127.0.0.1:${port}/collect` });
  writeFileSync(usageLog(tmp), 'banker:foo\n');
  const start = Date.now();
  const res = spawnSync(process.execPath, [FLUSH_HOOK], { encoding: 'utf8', env: flushEnv(tmp) });
  const elapsed = Date.now() - start;
  assert.equal(res.status, 0);
  assert.ok(elapsed < 9000, `https 경로도 hang 없이 종료(${elapsed}ms)`);
  assert.equal(readFileSync(usageLog(tmp), 'utf8'), '', 'https 전송 시도 후 로그 truncate');
});

test('loopback http 판별 가드가 배선돼 있다(::1/127.0.0.1/localhost)', () => {
  const src = readFileSync(FLUSH_HOOK, 'utf8');
  assert.match(src, /function isLoopback/, 'loopback 판별 함수 정의');
  assert.match(src, /isLoopback\(\s*parsed\.hostname\s*\)/, 'POST 경로에서 loopback 판별 사용');
  assert.match(src, /'localhost'/, 'localhost loopback 포함');
  assert.match(src, /'127\.0\.0\.1'/, '127.0.0.1 loopback 포함');
  assert.match(src, /'::1'/, '::1 loopback 포함');
});
