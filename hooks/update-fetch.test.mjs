/*
 * update-fetch 훅 테스트 (node:test + node:assert). 파일명이 .test.mjs 라 배포에서 제외된다.
 * XDG_CONFIG_HOME 을 mkdtemp 로 격리하고, BANKER_NPM_URL 로 loopback http mock 서버를 주입한다.
 * 성공 경로는 in-process http 서버와 통신해야 하므로 이벤트 루프를 막지 않도록 spawn(비동기)로 실행한다
 * (spawnSync 는 루프를 막아 in-process 서버와 데드락 - 그래서 async spawn 을 쓴다).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FETCH_HOOK = join(HERE, 'update-fetch.mjs');

const tmps = [];
after(() => { for (const t of tmps) rmSync(t, { recursive: true, force: true }); });

function mkTmp() {
  const t = mkdtempSync(join(tmpdir(), 'banker-fetch-'));
  tmps.push(t);
  return t;
}

const bankerDir = (tmp) => join(tmp, 'banker');
const cachePath = (tmp) => join(bankerDir(tmp), 'update-check.json');

function writeCache(tmp, obj) {
  mkdirSync(bankerDir(tmp), { recursive: true });
  writeFileSync(cachePath(tmp), JSON.stringify(obj));
}

function readCache(tmp) {
  return JSON.parse(readFileSync(cachePath(tmp), 'utf8'));
}

function fetchEnv(tmp, npmUrl) {
  const env = { ...process.env, XDG_CONFIG_HOME: tmp };
  delete env.BANKER_NO_UPDATE_CHECK;
  if (npmUrl) env.BANKER_NPM_URL = npmUrl;
  else delete env.BANKER_NPM_URL;
  return env;
}

// in-process 서버와 통신하는 경로용: 이벤트 루프를 살려두려면 비동기 spawn 이어야 한다.
function runFetch(tmp, npmUrl) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [FETCH_HOOK], { env: fetchEnv(tmp, npmUrl), stdio: 'ignore' });
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

// JSON 응답을 한 번 돌려주는 mock 서버. body 가 문자열이면 raw 그대로(malformed/빈 응답 테스트용),
// 객체면 JSON.stringify 해서 응답한다. onRequest 로 수신한 요청을 관측할 수 있다.
function mockServer({ status = 200, body = '', onRequest } = {}) {
  const server = http.createServer((req, res) => {
    if (onRequest) onRequest(req);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
  return new Promise((resolvePromise) => {
    server.listen(0, '127.0.0.1', () => resolvePromise(server));
  });
}

test('throttle 미경과면 fetch 안 함(mock 미호출), 캐시 불변', async () => {
  const tmp = mkTmp();
  let hit = false;
  const server = await mockServer({ body: { version: '9.9.9' }, onRequest: () => { hit = true; } });
  try {
    const port = server.address().port;
    writeCache(tmp, { latest: '0.9.0', checkedAt: Date.now() }); // 방금 체크 - throttle 안.
    const code = await runFetch(tmp, `http://127.0.0.1:${port}/latest`);
    assert.equal(code, 0);
    assert.equal(hit, false, 'throttle 미경과면 mock 서버 호출 없음');
    assert.equal(readCache(tmp).latest, '0.9.0', '캐시 불변');
  } finally {
    server.close();
  }
});

test('캐시 없음이면 throttle 가드 없이 진행한다', async () => {
  const tmp = mkTmp(); // update-check.json 자체가 없음.
  let hit = false;
  const server = await mockServer({ body: { version: '1.2.3' }, onRequest: () => { hit = true; } });
  try {
    const port = server.address().port;
    const code = await runFetch(tmp, `http://127.0.0.1:${port}/latest`);
    assert.equal(code, 0);
    assert.equal(hit, true, '캐시 없으면 throttle 없이 조회');
    assert.equal(readCache(tmp).latest, '1.2.3');
  } finally {
    server.close();
  }
});

test('정상 응답: 캐시 latest/checkedAt 갱신 + GET 무페이로드', async () => {
  const tmp = mkTmp();
  let method = null;
  const server = await mockServer({ body: { version: '0.9.0' }, onRequest: (req) => { method = req.method; } });
  try {
    const port = server.address().port;
    writeCache(tmp, { latest: '0.8.0', checkedAt: 0 }); // throttle 만료(epoch 0).
    const code = await runFetch(tmp, `http://127.0.0.1:${port}/latest`);
    assert.equal(code, 0);
    assert.equal(method, 'GET', 'GET 요청(페이로드 없음)');
    const cache = readCache(tmp);
    assert.equal(cache.latest, '0.9.0');
    assert.ok(typeof cache.checkedAt === 'number' && cache.checkedAt > 0, 'checkedAt 갱신');
  } finally {
    server.close();
  }
});

test('빈 응답 본문 → 캐시 미기록', async () => {
  const tmp = mkTmp();
  const server = await mockServer({ body: '' });
  try {
    const port = server.address().port;
    const code = await runFetch(tmp, `http://127.0.0.1:${port}/latest`);
    assert.equal(code, 0);
    assert.ok(!existsSync(cachePath(tmp)), '빈 본문이면 캐시 파일조차 안 만든다');
  } finally {
    server.close();
  }
});

test('malformed JSON 응답 → 캐시 미기록', async () => {
  const tmp = mkTmp();
  const server = await mockServer({ body: 'not json {' });
  try {
    const port = server.address().port;
    const code = await runFetch(tmp, `http://127.0.0.1:${port}/latest`);
    assert.equal(code, 0);
    assert.ok(!existsSync(cachePath(tmp)));
  } finally {
    server.close();
  }
});

test('version 필드 없음/비문자열 응답 → 캐시 미기록', async () => {
  const tmp = mkTmp();
  const server = await mockServer({ body: { error: 'not found' } }); // version 없음.
  try {
    const port = server.address().port;
    const code = await runFetch(tmp, `http://127.0.0.1:${port}/latest`);
    assert.equal(code, 0);
    assert.ok(!existsSync(cachePath(tmp)), 'version 필드 없음 - 캐시 미기록');
  } finally {
    server.close();
  }

  const tmp2 = mkTmp();
  const server2 = await mockServer({ body: { version: 123 } }); // version 비문자열.
  try {
    const port2 = server2.address().port;
    const code2 = await runFetch(tmp2, `http://127.0.0.1:${port2}/latest`);
    assert.equal(code2, 0);
    assert.ok(!existsSync(cachePath(tmp2)), 'version 비문자열 - 캐시 미기록');
  } finally {
    server2.close();
  }
});

test('3xx 리다이렉트는 따라가지 않고 no-op(캐시 미기록)', async () => {
  const tmp = mkTmp();
  const server = http.createServer((req, res) => {
    res.writeHead(302, { location: 'http://127.0.0.1:1/elsewhere' });
    res.end();
  });
  try {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const code = await runFetch(tmp, `http://127.0.0.1:${port}/latest`);
    assert.equal(code, 0);
    assert.ok(!existsSync(cachePath(tmp)), '리다이렉트를 따라가지 않고 캐시 미기록');
  } finally {
    server.close();
  }
});

test('네트워크 오류(닫힌 포트) → no-op·exit 0·hang 없음', () => {
  const tmp = mkTmp();
  return closedPort().then((port) => {
    const start = Date.now();
    const res = spawnSync(process.execPath, [FETCH_HOOK], { encoding: 'utf8', env: fetchEnv(tmp, `http://127.0.0.1:${port}/latest`) });
    const elapsed = Date.now() - start;
    assert.equal(res.status, 0);
    assert.ok(!existsSync(cachePath(tmp)), '연결 거부 - 캐시 미기록');
    assert.ok(elapsed < 9000, `hang 없이 빠르게 종료(${elapsed}ms)`);
  });
});

test('비-https 비-loopback URL 은 전송 시도 없이 즉시 no-op', () => {
  const tmp = mkTmp();
  // 192.0.2.1 = TEST-NET-1(RFC5737) 예약대역(라우팅 불가). loopback 아니므로 평문 http 는
  // 가드에 막혀 연결조차 시도하지 않아야 한다(가드 없으면 최대 10s hang).
  const start = Date.now();
  const res = spawnSync(process.execPath, [FETCH_HOOK], { encoding: 'utf8', env: fetchEnv(tmp, 'http://192.0.2.1:80/latest') });
  const elapsed = Date.now() - start;
  assert.equal(res.status, 0);
  assert.ok(elapsed < 3000, `가드가 즉시 no-op 이어야 한다(${elapsed}ms)`);
  assert.ok(!existsSync(cachePath(tmp)), '차단됐으므로 캐시 미기록');
});

test('https 스킴은 loopback 여부와 무관하게 통과한다(가드가 조기 차단하지 않는다)', () => {
  // TLS 핸드셰이크까지는 요구하지 않는다 - 닫힌 포트라 즉시 거부되지만, 핵심은 가드가 finish(null)
  // 로 미리 막지 않고 transport.request(https) 까지 도달한다는 것. 실패해도 캐시 미기록·exit 0.
  const tmp = mkTmp();
  return closedPort().then((port) => {
    const start = Date.now();
    const res = spawnSync(process.execPath, [FETCH_HOOK], { encoding: 'utf8', env: fetchEnv(tmp, `https://127.0.0.1:${port}/latest`) });
    const elapsed = Date.now() - start;
    assert.equal(res.status, 0);
    assert.ok(elapsed < 9000, `https 경로도 hang 없이 종료(${elapsed}ms)`);
    assert.ok(!existsSync(cachePath(tmp)), 'https 실패 시 캐시 미기록');
  });
});

test('병합: 같은 latest 재조회는 notified 보존, 다른 latest 는 notified 초기화', async () => {
  // (a) 같은 latest.
  const tmpA = mkTmp();
  const serverA = await mockServer({ body: { version: '0.9.0' } });
  try {
    const portA = serverA.address().port;
    writeCache(tmpA, { latest: '0.9.0', notified: '0.9.0', checkedAt: 0 });
    const codeA = await runFetch(tmpA, `http://127.0.0.1:${portA}/latest`);
    assert.equal(codeA, 0);
    const cacheA = readCache(tmpA);
    assert.equal(cacheA.latest, '0.9.0');
    assert.equal(cacheA.notified, '0.9.0', '동일 latest - notified 보존');
  } finally {
    serverA.close();
  }

  // (b) 다른 latest.
  const tmpB = mkTmp();
  const serverB = await mockServer({ body: { version: '1.0.0' } });
  try {
    const portB = serverB.address().port;
    writeCache(tmpB, { latest: '0.9.0', notified: '0.9.0', checkedAt: 0 });
    const codeB = await runFetch(tmpB, `http://127.0.0.1:${portB}/latest`);
    assert.equal(codeB, 0);
    const cacheB = readCache(tmpB);
    assert.equal(cacheB.latest, '1.0.0');
    assert.equal(cacheB.notified, null, '다른 latest - notified 초기화');
  } finally {
    serverB.close();
  }
});

test('네트워크 hang 방지 장치가 배선돼 있다(자체 timeout + destroy + error 핸들러)', () => {
  const src = readFileSync(FETCH_HOOK, 'utf8');
  assert.match(src, /setTimeout\(\s*NET_TIMEOUT_MS/, '자체 응답 timeout 설정');
  assert.match(src, /10_000|10000/, 'timeout 값 10s');
  assert.match(src, /\.destroy\(\)/, 'timeout 시 소켓 파기');
  assert.match(src, /req\.on\(\s*'error'/, '연결 오류 핸들러');
});

test('loopback http 판별 가드가 배선돼 있다(::1/127.0.0.1/localhost)', () => {
  const src = readFileSync(FETCH_HOOK, 'utf8');
  assert.match(src, /function isLoopback/, 'loopback 판별 함수 정의');
  assert.match(src, /'localhost'/, 'localhost loopback 포함');
  assert.match(src, /'127\.0\.0\.1'/, '127.0.0.1 loopback 포함');
  assert.match(src, /'::1'/, '::1 loopback 포함');
});
