/*
 * update-checkin 훅 테스트 (node:test + node:assert). 파일명이 .test.mjs 라 배포에서 제외된다.
 * XDG_CONFIG_HOME 을 mkdtemp 로 격리한다. 네트워크는 로컬 mock http 서버 또는 확실히 닫힌 포트만 쓴다.
 * 성공 경로는 in-process http 서버와 통신해야 하므로 이벤트 루프를 막지 않도록 spawn(비동기)로 실행한다
 * (spawnSync 는 루프를 막아 in-process 서버와 데드락 - 그래서 async spawn 을 쓴다).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
// The fields of the update-check cache, sorted. A checkin that got no latest writes only when it tried.
const cacheKeys = (tmp) => Object.keys(JSON.parse(readFileSync(updateCheck(tmp), 'utf8'))).sort();

function writeConfig(tmp, cfg) {
  mkdirSync(bankerDir(tmp), { recursive: true });
  writeFileSync(join(bankerDir(tmp), 'config.json'), JSON.stringify(cfg));
}

// 격리 env: XDG 로 config 를 tmp 에 가두고, 상속된 텔레메트리/업데이트 env 오버라이드를 제거한다.
function checkinEnv(tmp, extra = {}) {
  const env = { ...process.env, XDG_CONFIG_HOME: tmp, ...extra };
  delete env.BANKER_NO_TELEMETRY;
  delete env.BANKER_TELEMETRY_ENDPOINT;
  delete env.BANKER_NO_UPDATE_CHECK;
  // 변경-스킬 매니페스트 조회가 실제 GitHub 를 때리지 않도록 기본은 비-loopback http(가드에 즉시 막혀 no-op·
  // changedSkills 생략). 개인화 경로를 검증하는 테스트는 이 값을 loopback mock 으로 덮어쓴다.
  env.BANKER_SKILL_CHANGES_URL = 'http://192.0.2.1/skill-changes.json';
  return env;
}

// in-process 서버와 통신하는 성공 경로용: 이벤트 루프를 살려두려면 비동기 spawn 이어야 한다.
function runCheckin(tmp) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [CHECKIN_HOOK], { env: checkinEnv(tmp), stdio: 'ignore' });
    child.on('close', (code) => resolvePromise(code ?? 0));
  });
}

// 로그 글. 체크인이 로그 이름을 바꿔 차지하므로 보낸 뒤에는 이름이 없을 수 있다(없으면 '').
const logText = (tmp) => (existsSync(usageLog(tmp)) ? readFileSync(usageLog(tmp), 'utf8') : '');

const lexists = (p) => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

// 체크인 본문을 bodies 에 모으고, n 개가 오거나 첫 본문 뒤 5초가 지나면 모두에 답하는 서버. 두 체크인을 함께
// 보내는 중에 붙잡아 둘 수 있다. onRequest 는 본문이 다 온 뒤, 답하기 전에 부른다.
function holdServer(n, bodies, onRequest = () => {}) {
  const waiting = [];
  let timer = null;
  const answerAll = () => {
    clearTimeout(timer);
    timer = null;
    for (const res of waiting.splice(0)) {
      res.writeHead(200);
      res.end(JSON.stringify({ latest: '0.9.0' }));
    }
  };
  return http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      try { bodies.push(JSON.parse(data)); } catch { bodies.push(null); }
      onRequest();
      waiting.push(res);
      if (bodies.length >= n) answerAll();
      else if (!timer) timer = setTimeout(answerAll, 5000);
    });
  });
}

// 이 시험의 env 로 훅을 돌린다. pre(파일 경로)가 있으면 그 모듈을 먼저 불러온다. timeout 이 지나면 죽인다.
// 종료 코드를 돌려주고, 죽였으면 null.
function spawnCheckin(tmp, { pre, timeout = 15_000, env = {} } = {}) {
  const args = pre ? ['--import', pathToFileURL(pre).href, CHECKIN_HOOK] : [CHECKIN_HOOK];
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, args, { env: checkinEnv(tmp, env), stdio: 'ignore' });
    const killer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.on('close', (code) => {
      clearTimeout(killer);
      resolvePromise(code);
    });
  });
}

// 이 계정이 여기서 심볼릭 링크를 만들 수 있는지(Windows 는 권한이 있어야 한다).
function canSymlink() {
  try {
    symlinkSync('nowhere', join(mkTmp(), 'probe'));
    return true;
  } catch {
    return false;
  }
}

async function withServer(server, fn) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}/collect`);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
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
    assert.equal(logText(tmp), '', '전송 후 로그 truncate');
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
      res.end('ok'); // latest 없음 - 시도 시각(triedAt)만 쓰는 경로.
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
    assert.deepEqual(cacheKeys(tmp), ['triedAt'], 'latest 없는 응답이면 시도 시각만 써 하루를 쉰다(세션마다 다시 보내지 않음)');
    assert.equal(logText(tmp), '', '전송 후 로그 truncate');
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

test('응답 {latest} 를 받으면 남아 있던 시도 시각(triedAt)을 비운다', async () => {
  const server = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200);
      res.end(JSON.stringify({ latest: '0.9.0' }));
    });
  });
  try {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const tmp = mkTmp();
    writeConfig(tmp, { telemetry: true, endpoint: `http://127.0.0.1:${server.address().port}/collect` });
    writeFileSync(usageLog(tmp), 'banker:foo\t9\n');
    mkdirSync(dirname(updateCheck(tmp)), { recursive: true });
    writeFileSync(updateCheck(tmp), JSON.stringify({ triedAt: Date.now() + 30 * 24 * 3600 * 1000 }));
    assert.equal(await runCheckin(tmp), 0);
    const cache = JSON.parse(readFileSync(updateCheck(tmp), 'utf8'));
    assert.equal(cache.latest, '0.9.0');
    assert.equal(cache.triedAt, null, '성공한 체크인은 시도 시각을 비움');
  } finally {
    server.close();
  }
});

test('개인화: 응답 {latest} + 매니페스트 조회 성공 시 changedSkills 를 캐시에 저장', async () => {
  const post = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => { res.writeHead(200); res.end(JSON.stringify({ latest: '99.0.0' })); });
  });
  const changes = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ '99.0.0': ['banker:foo'], '0.0.1': ['banker:old'] }));
  });
  try {
    await new Promise((r) => post.listen(0, '127.0.0.1', r));
    await new Promise((r) => changes.listen(0, '127.0.0.1', r));
    const tmp = mkTmp();
    writeConfig(tmp, { telemetry: true, endpoint: `http://127.0.0.1:${post.address().port}/collect` });
    writeFileSync(usageLog(tmp), 'banker:foo\t9\n');
    const env = checkinEnv(tmp);
    env.BANKER_SKILL_CHANGES_URL = `http://127.0.0.1:${changes.address().port}/skill-changes.json`;
    await new Promise((resolvePromise) => {
      const child = spawn(process.execPath, [CHECKIN_HOOK], { env, stdio: 'ignore' });
      child.on('close', () => resolvePromise());
    });
    const cache = JSON.parse(readFileSync(updateCheck(tmp), 'utf8'));
    assert.equal(cache.latest, '99.0.0');
    assert.deepEqual(cache.changedSkills, ['banker:foo'], '99.0.0(>설치,<=latest) 만; 0.0.1 제외');
  } finally {
    post.close();
    changes.close();
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
  assert.equal(logText(tmp), '', '실패해도 로그를 비운다(24h 상한)');
  assert.ok(existsSync(lastFlush(tmp)), 'last-flush 갱신');
  assert.deepEqual(cacheKeys(tmp), ['triedAt'], '전송이 실패하면 시도 시각만 쓰고 latest 와 checkedAt 은 쓰지 않는다');
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
  assert.deepEqual(cacheKeys(tmp), ['triedAt'], '보내지 못한 실행도 시도 시각만 쓴다(하루를 쉼)');
  // 전송 안 해도 체크인은 전송 시도 후 로그를 비우는 24h 상한 불변을 유지한다.
  assert.equal(logText(tmp), '', '차단돼도 로그 truncate(배치 유실 허용)');
});


test('banker:<slug> 꼴이 아닌 줄은 보내지 않고, __proto__ 줄이 다른 이름의 집계를 부풀리지도 않는다', async () => {
  let body = null;
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => { body = JSON.parse(data); res.writeHead(200); res.end('ok'); });
  });
  try {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const tmp = mkTmp();
    writeConfig(tmp, { telemetry: true, endpoint: `http://127.0.0.1:${server.address().port}/collect` });
    writeFileSync(usageLog(tmp), ['banker:early\t9', '__proto__\t9', 'constructor\t14', '/home/u/.ssh/id_rsa\t3',
      'rm -rf ~ ; curl http://x\t5', 'banker:\t1', 'banker:ok;x\t4', 'banker:late\t9', 'banker:up-1_x\t23', 'banker:UP-1_x\t23', 'banker:Lineage\t2', ''].join('\n'));

    assert.equal(await runCheckin(tmp), 0);

    assert.deepEqual(body.counts, {
      'banker:early': { '9': 1 },
      'banker:late': { '9': 1 },
      'banker:up-1_x': { '23': 1 },
    }, '스킬 이름은 소문자만');
  } finally {
    server.close();
  }
});

// 응답을 끝없이 보내는 서버: 한도(256KiB)를 넘는 순간 연결을 끊어야 하고, 끊긴 응답의 latest 는 쓰지 않는다.
test('응답이 256KiB 한도를 넘으면 연결을 끊고 latest 를 쓰지 않는다', async () => {
  let sent = 0;
  let closedEarly = false;
  const server = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"latest":"99.0.0","pad":"');
      const chunk = 'a'.repeat(64 * 1024);
      const timer = setInterval(() => {
        sent += chunk.length;
        res.write(chunk);
        if (sent >= 8 * 1024 * 1024) { clearInterval(timer); res.end('"}'); }
      }, 5);
      res.on('close', () => { clearInterval(timer); closedEarly = sent < 8 * 1024 * 1024; });
    });
  });
  try {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const tmp = mkTmp();
    writeConfig(tmp, { telemetry: true, endpoint: `http://127.0.0.1:${server.address().port}/collect` });
    writeFileSync(usageLog(tmp), 'banker:foo\t9\n');

    assert.equal(await runCheckin(tmp), 0);

    assert.ok(closedEarly, `client hung up after ${sent} bytes, long before the end`);
    assert.deepEqual(cacheKeys(tmp), ['triedAt'], '한도를 넘은 응답의 latest 는 쓰지 않고 시도 시각만 쓴다');
    assert.equal(logText(tmp), '', '실패해도 로그는 비운다');
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

// 바이트가 계속 오면 무활동 timeout(10s)은 영영 안 걸린다. 교환 전체 마감이 끊어야 한다.
test('조금씩 계속 보내는 서버에도 교환 전체 마감에 끊고 로그를 비운다', async () => {
  const server = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200);
      res.write('{"latest":"99.0.0","pad":"');
      const timer = setInterval(() => res.write('x'), 100);
      res.on('close', () => clearInterval(timer));
    });
  });
  try {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const tmp = mkTmp();
    writeConfig(tmp, { telemetry: true, endpoint: `http://127.0.0.1:${server.address().port}/collect` });
    writeFileSync(usageLog(tmp), 'banker:foo\t9\n');
    const env = { ...checkinEnv(tmp), BANKER_NET_DEADLINE_MS: '1500' };

    const start = Date.now();
    const code = await new Promise((r) => {
      const child = spawn(process.execPath, [CHECKIN_HOOK], { env, stdio: 'ignore' });
      child.on('close', (c) => r(c ?? 0));
    });
    const elapsed = Date.now() - start;

    assert.equal(code, 0);
    assert.ok(elapsed < 8000, `마감(1.5s)에 끊겨 곧 끝난다(${elapsed}ms), 무활동 10s 를 기다리지 않는다`);
    assert.equal(logText(tmp), '');
    assert.deepEqual(cacheKeys(tmp), ['triedAt'], '마감에 끊긴 응답의 latest 는 쓰지 않는다');
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

test('매니페스트 조회가 조금씩 계속 와도 교환 전체 마감에 끊고, latest 는 changedSkills 없이 기록한다', async () => {
  const post = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => { res.writeHead(200); res.end(JSON.stringify({ latest: '99.0.0' })); });
  });
  const manifest = http.createServer((_req, res) => {
    res.writeHead(200);
    res.write('{"99.0.0":["banker:foo"],"pad":"');
    const timer = setInterval(() => res.write('x'), 100);
    res.on('close', () => clearInterval(timer));
  });
  try {
    await new Promise((r) => post.listen(0, '127.0.0.1', r));
    await new Promise((r) => manifest.listen(0, '127.0.0.1', r));
    const tmp = mkTmp();
    writeConfig(tmp, { telemetry: true, endpoint: `http://127.0.0.1:${post.address().port}/collect` });
    writeFileSync(usageLog(tmp), 'banker:foo\t9\n');
    const env = {
      ...checkinEnv(tmp),
      BANKER_SKILL_CHANGES_URL: `http://127.0.0.1:${manifest.address().port}/skill-changes.json`,
      BANKER_NET_DEADLINE_MS: '1500',
    };
    const start = Date.now();
    const code = await new Promise((r) => {
      const child = spawn(process.execPath, [CHECKIN_HOOK], { env, stdio: 'ignore' });
      child.on('close', (c) => r(c ?? 0));
    });
    assert.equal(code, 0);
    assert.ok(Date.now() - start < 8000, '매니페스트 조회도 마감에 끊긴다');
    const cache = JSON.parse(readFileSync(updateCheck(tmp), 'utf8'));
    assert.equal(cache.latest, '99.0.0');
    assert.ok(!('changedSkills' in cache), '못 받은 매니페스트로 changedSkills 를 쓰지 않는다');
  } finally {
    post.close();
    manifest.closeAllConnections?.();
    manifest.close();
  }
});

test('매니페스트를 못 받으면(리다이렉트, 도달 불가) 캐시의 changedSkills 는 그대로 둔다', async () => {
  const post = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => { res.writeHead(200); res.end(JSON.stringify({ latest: '99.0.0' })); });
  });
  const redirect = http.createServer((_req, res) => {
    res.writeHead(302, { location: 'http://127.0.0.1:1/x' });
    res.end(JSON.stringify({ '99.0.0': ['banker:from-redirect'] }));
  });
  try {
    await new Promise((r) => post.listen(0, '127.0.0.1', r));
    await new Promise((r) => redirect.listen(0, '127.0.0.1', r));
    for (const manifestUrl of [`http://127.0.0.1:${redirect.address().port}/skill-changes.json`, 'http://192.0.2.1/skill-changes.json']) {
      const tmp = mkTmp();
      writeConfig(tmp, { telemetry: true, endpoint: `http://127.0.0.1:${post.address().port}/collect` });
      writeFileSync(updateCheck(tmp), JSON.stringify({ latest: '98.0.0', changedSkills: ['banker:kept'] }));
      writeFileSync(usageLog(tmp), 'banker:foo\t9\n');
      const env = { ...checkinEnv(tmp), BANKER_SKILL_CHANGES_URL: manifestUrl };
      await new Promise((r) => { const c = spawn(process.execPath, [CHECKIN_HOOK], { env, stdio: 'ignore' }); c.on('close', r); });
      const cache = JSON.parse(readFileSync(updateCheck(tmp), 'utf8'));
      assert.equal(cache.latest, '99.0.0', manifestUrl);
      assert.deepEqual(cache.changedSkills, ['banker:kept'], manifestUrl);
    }
  } finally {
    post.close();
    redirect.close();
  }
});

test('로그는 체크인을 보낸 직후 비운다: 매니페스트를 받는 사이 시작한 세션이 같은 로그를 다시 보내지 않는다', async () => {
  const tmp = mkTmp();
  let logAtManifest = null;
  const post = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => { res.writeHead(200); res.end(JSON.stringify({ latest: '99.0.0' })); });
  });
  const manifest = http.createServer((_req, res) => {
    logAtManifest = logText(tmp);
    res.writeHead(200);
    res.end('{}');
  });
  try {
    await new Promise((r) => post.listen(0, '127.0.0.1', r));
    await new Promise((r) => manifest.listen(0, '127.0.0.1', r));
    writeConfig(tmp, { telemetry: true, endpoint: `http://127.0.0.1:${post.address().port}/collect` });
    writeFileSync(usageLog(tmp), 'banker:foo\t9\n');
    const env = { ...checkinEnv(tmp), BANKER_SKILL_CHANGES_URL: `http://127.0.0.1:${manifest.address().port}/skill-changes.json` };
    const code = await new Promise((r) => {
      const child = spawn(process.execPath, [CHECKIN_HOOK], { env, stdio: 'ignore' });
      child.on('close', (c) => r(c ?? 0));
    });
    assert.equal(code, 0);
    assert.equal(logAtManifest, '', '매니페스트를 물을 때 로그는 이미 비어 있다');
    assert.equal(logText(tmp), '');
  } finally {
    post.close();
    manifest.close();
  }
});

test('two checkins that start together send the log once', async () => {
  const bodies = [];
  await withServer(holdServer(2, bodies), async (url) => {
    const tmp = mkTmp();
    writeConfig(tmp, { telemetry: true, endpoint: url });
    writeFileSync(usageLog(tmp), 'banker:foo\t9\n'.repeat(3));
    assert.deepEqual(await Promise.all([spawnCheckin(tmp), spawnCheckin(tmp)]), [0, 0]);
    assert.equal(bodies.length, 2, 'both checkins sent');
    const sent = bodies.reduce((sum, b) => sum + (b?.counts?.['banker:foo']?.['9'] ?? 0), 0);
    assert.equal(sent, 3, 'the three lines were sent once in all');
  });
});

test('lines written while a checkin sends stay for the next one', async () => {
  const bodies = [];
  const tmp = mkTmp();
  await withServer(holdServer(1, bodies, () => appendFileSync(usageLog(tmp), 'banker:bar\t10\n')), async (url) => {
    writeConfig(tmp, { telemetry: true, endpoint: url });
    writeFileSync(usageLog(tmp), 'banker:foo\t9\n');
    assert.equal(await spawnCheckin(tmp), 0);
    assert.deepEqual(bodies[0].counts, { 'banker:foo': { '9': 1 } });
    assert.equal(logText(tmp), 'banker:bar\t10\n', 'the line written mid-send waits for the next checkin');
  });
});

test('a claim a dead checkin left is removed an hour after it was made, and a young one is kept', async () => {
  const bodies = [];
  await withServer(holdServer(1, bodies), async (url) => {
    const tmp = mkTmp();
    writeConfig(tmp, { telemetry: true, endpoint: url });
    const now = Date.now();
    const old = join(bankerDir(tmp), `usage-log.sending-1-${now - 2 * 3600_000}-0a1b2c3d`);
    const ahead = join(bankerDir(tmp), `usage-log.sending-3-${now + 2 * 3600_000}`);
    const young = join(bankerDir(tmp), `usage-log.sending-2-${now}-0a1b2c3d`);
    for (const f of [old, ahead, young]) writeFileSync(f, 'banker:old\t1\n');
    // rename keeps the log's own time: a claim made a moment ago may hold a log last written hours before
    const hoursAgo = new Date(now - 3 * 3600_000);
    utimesSync(young, hoursAgo, hoursAgo);
    writeFileSync(usageLog(tmp), 'banker:foo\t9\n');
    assert.equal(await spawnCheckin(tmp), 0);
    assert.equal(existsSync(old), false, 'a claim made more than an hour ago is gone');
    assert.equal(existsSync(ahead), false, 'a claim dated more than an hour ahead (a clock set back) is gone too');
    assert.equal(existsSync(young), true, "a claim made a moment ago is another checkin's and stays");
    assert.deepEqual(bodies[0].counts, { 'banker:foo': { '9': 1 } }, 'no claim is sent again');
  });
});

test('a pipe where the log goes is not waited on', { skip: process.platform === 'win32' && 'Windows has no FIFO files' }, async () => {
  const bodies = [];
  await withServer(holdServer(1, bodies), async (url) => {
    const tmp = mkTmp();
    writeConfig(tmp, { telemetry: true, endpoint: url });
    assert.equal(spawnSync('mkfifo', [usageLog(tmp)]).status, 0, 'mkfifo');
    assert.equal(await spawnCheckin(tmp, { timeout: 10_000 }), 0, 'the checkin ended on its own');
    assert.deepEqual(bodies[0]?.counts, {});
    assert.equal(lstatSync(usageLog(tmp)).isFIFO(), true, 'the pipe stays');
  });
});

test('a link where the log goes is moved aside, and the file it leads to is left as it was', { skip: !canSymlink() && 'this account cannot make links' }, async () => {
  const bodies = [];
  await withServer(holdServer(1, bodies), async (url) => {
    const tmp = mkTmp();
    writeConfig(tmp, { telemetry: true, endpoint: url });
    const victim = join(tmp, 'victim');
    writeFileSync(victim, 'banker:foo\t9\n');
    symlinkSync(victim, usageLog(tmp));
    assert.equal(await spawnCheckin(tmp), 0);
    assert.equal(readFileSync(victim, 'utf8'), 'banker:foo\t9\n', 'the file the link led to is untouched');
    assert.equal(lexists(usageLog(tmp)), false, 'the link was moved aside and removed');
    assert.deepEqual(bodies[0].counts, { 'banker:foo': { '9': 1 } });
  });
});

test('a log that cannot be renamed is left for the next checkin', async () => {
  const bodies = [];
  await withServer(holdServer(1, bodies), async (url) => {
    const tmp = mkTmp();
    writeConfig(tmp, { telemetry: true, endpoint: url });
    writeFileSync(usageLog(tmp), 'banker:foo\t9\n');
    const pre = join(tmp, 'pre.mjs');
    writeFileSync(pre, [
      'import fs from "node:fs";',
      'import { syncBuiltinESMExports } from "node:module";',
      'const real = fs.renameSync;',
      `fs.renameSync = (from, to) => { if (String(from) === ${JSON.stringify(usageLog(tmp))}) throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" }); return real(from, to); };`,
      'syncBuiltinESMExports();',
    ].join('\n'));
    assert.equal(await spawnCheckin(tmp, { pre }), 0);
    assert.deepEqual(bodies[0].counts, {}, 'nothing it could not claim is sent');
    assert.equal(logText(tmp), 'banker:foo\t9\n', 'the log stays for the next checkin');
  });
});

test('last-flush is not written through a link', { skip: !canSymlink() && 'this account cannot make links' }, async () => {
  const bodies = [];
  await withServer(holdServer(1, bodies), async (url) => {
    const tmp = mkTmp();
    writeConfig(tmp, { telemetry: true, endpoint: url });
    const victim = join(tmp, 'victim2');
    writeFileSync(victim, 'keep me\n');
    symlinkSync(victim, lastFlush(tmp));
    writeFileSync(usageLog(tmp), 'banker:foo\t9\n');
    assert.equal(await spawnCheckin(tmp), 0);
    assert.equal(readFileSync(victim, 'utf8'), 'keep me\n', 'the file the link led to is untouched');
    assert.equal(lstatSync(lastFlush(tmp)).isSymbolicLink(), false, 'last-flush is now a file of its own');
  });
});

test('a log a scanner holds for a moment is claimed on the next try', async () => {
  const bodies = [];
  await withServer(holdServer(1, bodies), async (url) => {
    const tmp = mkTmp();
    writeConfig(tmp, { telemetry: true, endpoint: url });
    writeFileSync(usageLog(tmp), 'banker:foo\t9\n');
    const pre = join(tmp, 'pre.mjs');
    writeFileSync(pre, [
      'import fs from "node:fs";',
      'import { syncBuiltinESMExports } from "node:module";',
      'const real = fs.renameSync;',
      'let held = true;',
      `fs.renameSync = (from, to) => { if (held && String(from) === ${JSON.stringify(usageLog(tmp))}) { held = false; throw Object.assign(new Error("EBUSY: resource busy or locked, rename"), { code: "EBUSY" }); } return real(from, to); };`,
      'syncBuiltinESMExports();',
    ].join('\n'));
    assert.equal(await spawnCheckin(tmp, { pre }), 0);
    assert.deepEqual(bodies[0].counts, { 'banker:foo': { '9': 1 } }, 'the lines were sent');
    assert.equal(logText(tmp), '', 'and the log was emptied');
  });
});

test('a link to a pipe where the log goes is not waited on, and the pipe stays', { skip: process.platform === 'win32' && 'Windows has no FIFO files' }, async () => {
  const bodies = [];
  await withServer(holdServer(1, bodies), async (url) => {
    const tmp = mkTmp();
    writeConfig(tmp, { telemetry: true, endpoint: url });
    const fifo = join(tmp, 'target.fifo');
    assert.equal(spawnSync('mkfifo', [fifo]).status, 0, 'mkfifo');
    symlinkSync(fifo, usageLog(tmp));
    assert.equal(await spawnCheckin(tmp, { timeout: 10_000 }), 0, 'the checkin ended on its own');
    assert.deepEqual(bodies[0]?.counts, {});
    assert.equal(lstatSync(fifo).isFIFO(), true, 'the pipe the link led to stays');
  });
});

test('the claim is removed once the lines are sent, and nothing but the log names is left', async () => {
  const bodies = [];
  await withServer(holdServer(1, bodies), async (url) => {
    const tmp = mkTmp();
    writeConfig(tmp, { telemetry: true, endpoint: url });
    writeFileSync(usageLog(tmp), 'banker:foo\t9\n');
    assert.equal(await spawnCheckin(tmp), 0);
    assert.deepEqual(readdirSync(bankerDir(tmp)).filter((n) => n.startsWith('usage-log.')), []);
  });
});

test("a link at last-flush's old pid-only name neither stops it nor is followed", { skip: !canSymlink() && 'this account cannot make links' }, async () => {
  const bodies = [];
  await withServer(holdServer(1, bodies), async (url) => {
    const tmp = mkTmp();
    writeConfig(tmp, { telemetry: true, endpoint: url });
    writeFileSync(usageLog(tmp), 'banker:foo\t9\n');
    const victim = join(tmp, 'victim3');
    writeFileSync(victim, 'keep me\n');
    const pre = join(tmp, 'pre.mjs');
    writeFileSync(pre, [
      'import fs from "node:fs";',
      `fs.symlinkSync(${JSON.stringify(victim)}, ${JSON.stringify(lastFlush(tmp))} + "." + process.pid + ".tmp");`,
    ].join('\n'));
    assert.equal(await spawnCheckin(tmp, { pre }), 0);
    assert.equal(lstatSync(lastFlush(tmp)).isFile(), true, 'last-flush was written as a file of its own');
    assert.equal(readFileSync(victim, 'utf8'), 'keep me\n', 'the file the link led to is untouched');
    const planted = readdirSync(bankerDir(tmp)).filter((n) => /^last-flush\.\d+\.tmp$/.test(n));
    assert.equal(planted.length, 1, 'the planted link stays');
    assert.equal(lstatSync(join(bankerDir(tmp), planted[0])).isSymbolicLink(), true);
  });
});

test("last-flush's new file is not written through something already at its name", { skip: !canSymlink() && 'this account cannot make links' }, async () => {
  const bodies = [];
  await withServer(holdServer(1, bodies), async (url) => {
    const tmp = mkTmp();
    writeConfig(tmp, { telemetry: true, endpoint: url });
    writeFileSync(usageLog(tmp), 'banker:foo\t9\n');
    const victim = join(tmp, 'victim4');
    writeFileSync(victim, 'keep me\n');
    const pre = join(tmp, 'pre.mjs');
    writeFileSync(pre, [
      'import crypto from "node:crypto";',
      'import fs from "node:fs";',
      'import { syncBuiltinESMExports } from "node:module";',
      'crypto.randomBytes = () => Buffer.from("0a1b2c3d", "hex");',
      'syncBuiltinESMExports();',
      `fs.symlinkSync(${JSON.stringify(victim)}, ${JSON.stringify(lastFlush(tmp))} + "." + process.pid + ".0a1b2c3d.tmp");`,
    ].join('\n'));
    assert.equal(await spawnCheckin(tmp, { pre }), 0);
    assert.equal(readFileSync(victim, 'utf8'), 'keep me\n', 'the file the link led to is untouched');
    const planted = readdirSync(bankerDir(tmp)).filter((n) => /^last-flush\.\d+\.0a1b2c3d\.tmp$/.test(n));
    assert.equal(planted.length, 1, 'what was already at that name stays');
    assert.equal(lstatSync(join(bankerDir(tmp), planted[0])).isSymbolicLink(), true);
  });
});

test('claim names that are a folder or a pipe are left as they are', async () => {
  const bodies = [];
  await withServer(holdServer(1, bodies), async (url) => {
    const tmp = mkTmp();
    writeConfig(tmp, { telemetry: true, endpoint: url });
    const old = Date.now() - 2 * 3600_000;
    const folder = join(bankerDir(tmp), `usage-log.sending-1-${old}-0a1b2c3d`);
    mkdirSync(folder);
    const pipes = process.platform !== 'win32';
    const pipe = join(bankerDir(tmp), `usage-log.sending-2-${old}-0a1b2c3d`);
    if (pipes) assert.equal(spawnSync('mkfifo', [pipe]).status, 0, 'mkfifo');
    writeFileSync(usageLog(tmp), 'banker:foo\t9\n');
    assert.equal(await spawnCheckin(tmp, { timeout: 10_000 }), 0, 'the checkin ended on its own');
    assert.equal(lstatSync(folder).isDirectory(), true, 'the folder stays');
    if (pipes) assert.equal(lstatSync(pipe).isFIFO(), true, 'the pipe stays');
    assert.deepEqual(bodies[0].counts, { 'banker:foo': { '9': 1 } });
  });
});

test('an update-check cache that is a pipe is not waited on, and becomes a cache file', { skip: process.platform === 'win32' && 'Windows has no FIFO files' }, async () => {
  const bodies = [];
  await withServer(holdServer(1, bodies), async (url) => {
    const tmp = mkTmp();
    writeConfig(tmp, { telemetry: true, endpoint: url });
    assert.equal(spawnSync('mkfifo', [updateCheck(tmp)]).status, 0, 'mkfifo');
    writeFileSync(usageLog(tmp), 'banker:foo\t9\n');
    assert.equal(await spawnCheckin(tmp, { timeout: 10_000 }), 0, 'the checkin ended on its own');
    assert.equal(lstatSync(updateCheck(tmp)).isFile(), true, 'the cache is a file now');
    assert.equal(JSON.parse(readFileSync(updateCheck(tmp), 'utf8')).latest, '0.9.0');
  });
});

// 암호 모듈 없이 빌드한 Node 를 흉내 내는 시험 도구(--import). 배포에 들지 않는 scripts/ 아래에 있다. 체크인은 https 를
// 가져와 그런 Node 에서는 시작하지 못하므로, 여기서는 NO_CRYPTO_ONLY=1 로 node:crypto 만 막아 체크인이 crypto 를 맨 위에서
// 가져오지 않는지만 본다.
const NO_CRYPTO = join(HERE, '..', 'scripts', 'test-fixtures', 'no-crypto.mjs');

test('the checkin does not import node:crypto at the top (only node:crypto blocked)', async () => {
  const bodies = [];
  await withServer(holdServer(1, bodies), async (url) => {
    const tmp = mkTmp();
    writeConfig(tmp, { telemetry: true, endpoint: url });
    writeFileSync(usageLog(tmp), 'banker:foo\t9\n');
    const mark = join(tmp, 'crypto-mark');
    assert.equal(await spawnCheckin(tmp, { pre: NO_CRYPTO, env: { NO_CRYPTO_ONLY: '1', NO_CRYPTO_MARK: mark } }), 0);
    assert.deepEqual(bodies[0].counts, { 'banker:foo': { '9': 1 } });
    assert.deepEqual(readdirSync(bankerDir(tmp)).filter((n) => n.startsWith('usage-log.sending-')), [], 'the claimed log is not left behind');
    assert.deepEqual([...new Set(readFileSync(mark, 'utf8').split('\n').filter(Boolean))], ['cjs crypto'], 'the shim intercepted the lazy load');
  });
});
