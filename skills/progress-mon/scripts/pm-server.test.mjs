// pm-server.mjs 시험(같은 프로세스). Host 검사, 로그 정리, 포트 선택, 처리기 응답, 정지 규칙, 자기 탐침, 로그 비움.
// 포트는 OS 가 고른 빈 포트만 쓴다. 30000, 3456, 3458 은 바인드도 요청도 하지 않는다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import {
  hostAllowed,
  cleanForLog,
  bindServers,
  createHandler,
  askIdentity,
  serve,
  stop,
  status,
  makeLogger,
  logLinesSince,
  saveHost,
  readState,
  writeState,
  statePath,
  logPath,
  hostRefusal,
  SECURITY_HEADERS,
  ERROR_BODY,
  ID_PATH,
} from './pm-server.mjs';
import { defaults, UsageError } from './pm-config.mjs';

const T = { timeout: 60000 };
const FORBIDDEN = [30000, 3456, 3458];
const ROOT = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'progress-mon-test-')));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

// 금지 포트와 그 위 100 칸(포트 선택이 넘어갈 수 있는 범위)을 피한 빈 포트.
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => (FORBIDDEN.some((f) => f >= p && f <= p + 100) ? resolve(freePort()) : resolve(p)));
    });
  });
}
const guard = (port) => {
  if (FORBIDDEN.includes(port)) throw new Error(`금지 포트 ${port}`);
  return port;
};

let n = 0;
function ctxOf() {
  const project = path.join(ROOT, `p${++n}`);
  const dataDir = path.join(project, '.omc', 'progress-mon');
  fs.mkdirSync(dataDir, { recursive: true });
  return { project, runtime: 'claude', dataDir, exists: true, warn: null };
}
const quietIo = () => {
  const out = [];
  const err = [];
  return { out: (l) => out.push(l), err: (l) => err.push(l), lines: { out, err } };
};

function get(port, { pathname = '/', host = `127.0.0.1:${port}`, method = 'GET', addr = '127.0.0.1' } = {}) {
  guard(port);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: addr, port, path: pathname, method, headers: { host }, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('Host 허용 4종, 다른 포트, 포트 생략, 다른 이름, 빈 값, 대문자', T, () => {
  const P = 41234;
  for (const ok of [`127.0.0.1:${P}`, `localhost:${P}`, `[::1]:${P}`, `10.1.2.3:${P}`, `LOCALHOST:${P}`, ` localhost:${P} `]) assert.equal(hostAllowed(ok, P, ['10.1.2.3']), true, ok);
  for (const bad of [`127.0.0.1:${P + 1}`, '127.0.0.1', 'localhost', `evil.example:${P}`, `127.0.0.2:${P}`, `10.1.2.4:${P}`, '', undefined, `localhost:${P}.evil`]) assert.equal(hostAllowed(bad, P, ['10.1.2.3']), false, String(bad));
  assert.equal(hostAllowed(`10.1.2.3:${P}`, P, []), false, '바인드하지 않은 IP');
});

test('로그 값은 제어 문자 제거 뒤 80자', T, () => {
  assert.equal(cleanForLog('a\r\nb\u0000c\u001bd\u007f'), 'abcd');
  assert.equal(cleanForLog('x'.repeat(200)).length, 80);
  assert.equal(cleanForLog(undefined), '');
});

test('거부 문구', T, () => {
  assert.equal(hostRefusal('0.0.0.0'), '--host 0.0.0.0 거부. 사설 IPv4(10/8, 172.16/12, 192.168/16)만 받음');
});

// 가짜 리스너: busy 는 "port/host" 를 EADDRINUSE, missing 은 EADDRNOTAVAIL.
function fakeListen({ busy = [], missing = [] } = {}) {
  const open = new Set();
  const listen = async (port, host) => {
    const key = `${port}/${host}`;
    const err = (code) => Object.assign(new Error(code), { code });
    if (busy.includes(key)) throw err('EADDRINUSE');
    if (missing.includes(host)) throw err('EADDRNOTAVAIL');
    open.add(key);
    return { close: (cb) => (open.delete(key), cb && cb()) };
  };
  return { listen, open };
}

test('포트 선택: 점유면 P+1 과 알림', T, async () => {
  const f = fakeListen({ busy: ['5000/127.0.0.1'] });
  const r = await bindServers({ port: 5000, strict: false, listen: f.listen });
  assert.equal(r.port, 5001);
  assert.deepEqual(r.notes, ['알림: 포트 5000 사용 중이라 5001 사용']);
});

test('포트 선택: strict 면 점유 거부', T, async () => {
  const f = fakeListen({ busy: ['5000/127.0.0.1'] });
  await assert.rejects(bindServers({ port: 5000, strict: true, listen: f.listen }), (e) => e instanceof UsageError && e.message === '포트 5000 사용 중(--port-strict). 다른 포트를 고르지 않음');
});

test('포트 선택: 추가 주소 EADDRINUSE 면 모두 닫고 다음 포트', T, async () => {
  const f = fakeListen({ busy: ['5000/10.0.0.5'] });
  const r = await bindServers({ port: 5000, strict: false, hosts: [{ ip: '10.0.0.5', from: 'arg' }], listen: f.listen });
  assert.equal(r.port, 5001);
  assert.deepEqual([...f.open].sort(), ['5001/10.0.0.5', '5001/127.0.0.1']);
  assert.deepEqual(r.ips, ['10.0.0.5']);
  assert.ok(r.notes.some((x) => x.startsWith('경고: 10.0.0.5 에 바인드')));
  const g = fakeListen({ busy: ['5000/10.0.0.5'] });
  await assert.rejects(bindServers({ port: 5000, strict: true, hosts: [{ ip: '10.0.0.5', from: 'arg' }], listen: g.listen }), UsageError);
  assert.equal(g.open.size, 0);
});

test('포트 선택: config.hosts 주소가 없으면 그 주소만 경고, --host 주소가 없으면 거부', T, async () => {
  const f = fakeListen({ missing: ['10.9.9.9'] });
  const r = await bindServers({ port: 5000, strict: false, hosts: [{ ip: '10.9.9.9', from: 'config' }], listen: f.listen });
  assert.equal(r.port, 5000);
  assert.deepEqual(r.ips, []);
  assert.ok(r.notes[0].includes('config.hosts 의 10.9.9.9'));
  const g = fakeListen({ missing: ['10.9.9.9'] });
  await assert.rejects(bindServers({ port: 5000, strict: false, hosts: [{ ip: '10.9.9.9', from: 'arg' }], listen: g.listen }), /이 PC 주소가 아님/);
  assert.equal(g.open.size, 0, '열린 것을 모두 닫음');
});

test('포트 선택: 자기 탐침이 실패한 포트는 넘김', T, async () => {
  const f = fakeListen();
  const r = await bindServers({ port: 5000, strict: false, listen: f.listen, probe: async (p) => p !== 5000 });
  assert.equal(r.port, 5001);
  await assert.rejects(bindServers({ port: 5000, strict: true, listen: fakeListen().listen, probe: async () => false }), UsageError);
});

// 처리기만 시험하는 가짜 요청과 응답.
function fakeCall(handler, { url = '/', host = 'localhost:5000', method = 'GET', local = '127.0.0.1' } = {}) {
  const res = { status: 0, headers: {}, body: undefined };
  handler(
    { url, method, headers: { host }, socket: { localAddress: local } },
    {
      writeHead: (s, h) => {
        res.status = s;
        res.headers = h;
      },
      end: (b) => (res.body = b),
    },
  );
  return res;
}
const srvOf = (over = {}) => ({ port: 5000, ips: ['10.0.0.5'], log: () => {}, stats: { startedAt: 'T0', requests: 0, lastRequestAt: null, lastErrorAt: null }, render: (tab) => `<p>${tab}</p>`, now: () => 0, ...over });

test('신원 경로: 루프백 연결은 pid, 사설 IP 연결은 app 만', T, () => {
  const h = createHandler(srvOf());
  const a = JSON.parse(fakeCall(h, { url: ID_PATH }).body);
  assert.equal(a.app, 'progress-mon');
  assert.equal(a.pid, process.pid);
  const b = JSON.parse(fakeCall(h, { url: ID_PATH, host: '10.0.0.5:5000', local: '10.0.0.5' }).body);
  assert.deepEqual(b, { app: 'progress-mon' });
});

test('처리기: 403, 405, 404, 200, 탭 인자, 보안 머리, 요청 수는 Host 검사 뒤', T, () => {
  const lines = [];
  const srv = srvOf({ log: (l) => lines.push(l) });
  const h = createHandler(srv);
  assert.equal(fakeCall(h, { host: 'evil.example:5000' }).status, 403);
  assert.ok(lines[0].startsWith('403 GET / host=evil.example:5000'));
  assert.equal(fakeCall(h, { host: 'evil.example:5000', url: ID_PATH }).status, 403);
  assert.deepEqual([srv.stats.requests, srv.stats.lastRequestAt], [0, null], '403 은 세지 않음');
  const post = fakeCall(h, { method: 'POST' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.allow, 'GET, HEAD');
  for (const p of ['/server.json', '/config.json', '/items.json', '/server.log', '/../server.json', '/x']) assert.equal(fakeCall(h, { url: p }).status, 404, p);
  const ok = fakeCall(h, { url: '/index.html?tab=req' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body, '<p>req</p>');
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) assert.equal(ok.headers[k], v, k);
  assert.equal(fakeCall(h, { method: 'HEAD' }).body, undefined);
  assert.equal(srv.stats.requests, 9, '405, 404 6개, 200, HEAD');
  fakeCall(h, { url: ID_PATH });
  assert.equal(srv.stats.requests, 9, '신원 경로는 세지 않음');
});

test('렌더 예외는 500 과 일반 문구, 스택은 server.log 에만', T, () => {
  const ctx = ctxOf();
  const srv = srvOf({
    log: makeLogger(ctx.dataDir),
    render: () => {
      throw new Error(`깨진 자료 ${path.join(ctx.dataDir, 'flow.json')}`);
    },
  });
  const r = fakeCall(createHandler(srv), { url: '/?tab=workflow' });
  assert.equal(r.status, 500);
  assert.equal(r.body, ERROR_BODY);
  assert.ok(!/\bat\s|[A-Za-z]:[\\/]|\.m?js:\d+/.test(r.body));
  const log = fs.readFileSync(logPath(ctx.dataDir), 'utf8');
  assert.match(log, /500 GET \/ 렌더 오류/);
  assert.match(log, /\n\s+at /, '스택이 로그에 있음');
  assert.ok(srv.stats.lastErrorAt);
});

test('자기 탐침은 127.0.0.1 로 연결하고 Host 도 127.0.0.1:<port>', T, async () => {
  const seen = [];
  const s = http.createServer((req, res) => {
    seen.push({ host: req.headers.host, remote: req.socket.remoteAddress });
    res.end(JSON.stringify({ app: 'progress-mon', pid: 7 }));
  });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const port = guard(s.address().port);
  try {
    const r = await askIdentity(port);
    assert.deepEqual(r, { kind: 'ok', info: { app: 'progress-mon', pid: 7 } });
    assert.equal(seen[0].host, `127.0.0.1:${port}`);
    assert.equal(seen[0].remote, '127.0.0.1');
  } finally {
    await new Promise((r) => s.close(r));
  }
});

// 실제 바인드: serve 를 같은 프로세스에서 띄움(렌더 대역).
test('serve: 바인드, 상태 파일, 응답 머리, 상태 파일 서빙 안 함, 닫으면 상태 파일 삭제', T, async () => {
  const ctx = ctxOf();
  const port = await freePort();
  const io = quietIo();
  const srv = await serve(ctx, defaults(ctx.project), { port }, io, { render: (tab) => `<p>${tab}</p>` });
  try {
    assert.equal(srv.port, port);
    assert.deepEqual(io.lines.out, [`시작함: http://127.0.0.1:${port}/`]);
    const st = readState(ctx.dataDir);
    assert.equal(st.pid, process.pid);
    assert.equal(st.port, port);
    assert.deepEqual(st.hosts, ['127.0.0.1']);
    assert.match(st.startedAt, /Z$/);
    const ok = await get(port, { pathname: '/?tab=arch' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body, '<p>arch</p>');
    assert.equal(ok.headers['content-security-policy'], SECURITY_HEADERS['content-security-policy']);
    assert.equal(ok.headers['x-content-type-options'], 'nosniff');
    assert.equal(ok.headers['referrer-policy'], 'no-referrer');
    assert.equal(ok.headers['cache-control'], 'no-store');
    assert.equal((await get(port, { pathname: '/server.json' })).status, 404);
    assert.equal((await get(port, { host: `evil.example:${port}` })).status, 403);
    assert.equal((await get(port, { host: `localhost:${port}` })).status, 200);
    assert.equal((await get(port, { method: 'DELETE' })).status, 405);
    const log = fs.readFileSync(logPath(ctx.dataDir), 'utf8');
    assert.match(log, new RegExp(`시작 port=${port} 주소=127\\.0\\.0\\.1 PID ${process.pid}`));
    const io2 = quietIo();
    assert.equal(await status(ctx, io2), 0);
    assert.match(io2.lines.out[5], /^요청: 4, 마지막 요청: \d{4}-.*Z, 마지막 오류: 없음$/, '403 은 세지 않음');
  } finally {
    await srv.close();
  }
  assert.equal(fs.existsSync(statePath(ctx.dataDir)), false);
});

test('serve: strict 점유면 거부하고 server.log 에 오류 한 줄', T, async () => {
  const ctx = ctxOf();
  const holder = net.createServer();
  await new Promise((r) => holder.listen(0, '127.0.0.1', r));
  const port = guard(holder.address().port);
  try {
    await assert.rejects(serve(ctx, defaults(ctx.project), { port, portStrict: true }, quietIo(), { render: () => '' }), /사용 중\(--port-strict\)/);
    assert.match(fs.readFileSync(logPath(ctx.dataDir), 'utf8'), /오류: 포트 \d+ 사용 중/);
    assert.equal(fs.existsSync(statePath(ctx.dataDir)), false);
    await assert.rejects(serve(ctx, defaults(ctx.project), { port, host: '0.0.0.0' }, quietIo(), { render: () => '' }), (e) => e.message === hostRefusal('0.0.0.0'));
  } finally {
    await new Promise((r) => holder.close(r));
  }
});

test('serve: 1 MB 넘는 server.log 는 시작 때 server.log.1 로 옮김', T, async () => {
  const ctx = ctxOf();
  fs.writeFileSync(logPath(ctx.dataDir), 'x'.repeat(1024 * 1024 + 10));
  const srv = await serve(ctx, defaults(ctx.project), { port: await freePort() }, quietIo(), { render: () => '' });
  await srv.close();
  assert.ok(fs.statSync(logPath(ctx.dataDir)).size < 1000);
});

test('server.log 는 쓸 때마다 크기를 보고 한도를 넘기 전에 server.log.1 로 옮김', T, () => {
  const ctx = ctxOf();
  const max = 400;
  fs.writeFileSync(logPath(ctx.dataDir), 'x'.repeat(350));
  const log = makeLogger(ctx.dataDir, max);
  const sizes = [];
  for (let i = 0; i < 40; i++) {
    log(`줄 ${i} ${'y'.repeat(20)}`);
    sizes.push(fs.statSync(logPath(ctx.dataDir)).size);
  }
  assert.ok(sizes.every((s) => s <= max), `크기 ${Math.max(...sizes)} <= ${max}`);
  assert.ok(sizes[0] < 350, '처음 한 줄이 한도를 넘기면 먼저 옮김');
  assert.ok(sizes.some((s, i) => i > 0 && s < sizes[i - 1]), '실행 중에도 옮김');
  assert.match(fs.readFileSync(logPath(ctx.dataDir), 'utf8'), /줄 39 y+\n$/);
});

test('saveHost: config.json 쓰기 실패는 경고만(서버는 계속), 원본 그대로, 임시 파일 정리', T, async () => {
  const ctx = ctxOf();
  const file = path.join(ctx.dataDir, 'config.json');
  const body = JSON.stringify({ hosts: [] });
  fs.writeFileSync(file, body);
  const ok = quietIo();
  await saveHost(ctx, '10.0.0.5', ok);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).hosts, ['10.0.0.5']);
  assert.deepEqual(ok.lines.err, []);
  fs.writeFileSync(file, body);
  const io = quietIo();
  const broken = { ...fs, renameSync: () => { throw Object.assign(new Error('io'), { code: 'EIO' }); } };
  await saveHost(ctx, '10.0.0.6', io, broken);
  assert.deepEqual(io.lines.err, ['경고: --host 10.0.0.6 를 config.json 에 저장하지 못함(config.json 쓰기 실패(EIO). 원본 그대로). 서버는 계속']);
  assert.equal(fs.readFileSync(file, 'utf8'), body);
  assert.deepEqual(fs.readdirSync(ctx.dataDir), ['config.json']);
});

// 정지 규칙: 대역 서버로 상태 파일과 다른 응답을 만든다.
async function fakeServer(onReq) {
  const s = onReq === 'silent' ? net.createServer(() => {}) : http.createServer(onReq);
  const sockets = new Set();
  s.on('connection', (c) => {
    sockets.add(c);
    c.on('close', () => sockets.delete(c));
  });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return {
    port: guard(s.address().port),
    close: () =>
      new Promise((r) => {
        for (const c of sockets) c.destroy();
        s.close(r);
      }),
  };
}

test('stop: 연결 거부면 상태 파일만 삭제, 종료 0', T, async () => {
  const ctx = ctxOf();
  const port = await freePort();
  await writeState(ctx.dataDir, { port, pid: 999999, hosts: ['127.0.0.1'], project: ctx.project, startedAt: 'x' });
  const io = quietIo();
  assert.equal(await stop(ctx, io), 0);
  assert.deepEqual(io.lines.out, [`이미 꺼짐(포트 ${port} 연결 거부). 상태 파일 삭제`]);
  assert.equal(fs.existsSync(statePath(ctx.dataDir)), false);
});

test('stop: 다른 pid, 다른 프로그램, 시간 초과는 상태 파일 그대로, 종료 1', T, async () => {
  const cases = [
    [(q, s) => s.end(JSON.stringify({ app: 'progress-mon', pid: 4242 })), /서버 PID 4242 가 상태 파일 PID \d+ 와 다름/],
    [(q, s) => (s.writeHead(404), s.end('<html>other</html>')), /다른 프로그램이 답함/],
    ['silent', /응답 시간 초과\(1\.5초\)/],
  ];
  for (const [onReq, msg] of cases) {
    const ctx = ctxOf();
    const f = await fakeServer(onReq);
    try {
      await writeState(ctx.dataDir, { port: f.port, pid: process.pid, hosts: ['127.0.0.1'], project: ctx.project, startedAt: 'x' });
      const io = quietIo();
      assert.equal(await stop(ctx, io), 1);
      assert.match(io.lines.err[0], msg);
      assert.equal(readState(ctx.dataDir).pid, process.pid, '상태 파일 그대로');
    } finally {
      await f.close();
    }
  }
});

test('stop: 깨진 상태 파일과 상태 파일 없음', T, async () => {
  const ctx = ctxOf();
  const io = quietIo();
  assert.equal(await stop(ctx, io), 0);
  assert.deepEqual(io.lines.out, ['이미 꺼짐(상태 파일 없음)']);
  for (const bad of ['{x', JSON.stringify({ port: 5000, pid: 1 }), JSON.stringify({ port: 0, pid: 1234 })]) {
    fs.writeFileSync(statePath(ctx.dataDir), bad);
    const io2 = quietIo();
    assert.equal(await stop(ctx, io2), 1);
    assert.ok(fs.existsSync(statePath(ctx.dataDir)));
  }
});

test('status: 자료 폴더 없음, 꺼짐은 종료 3', T, async () => {
  const ctx = ctxOf();
  const io = quietIo();
  assert.equal(await status(ctx, io), 3);
  assert.deepEqual(io.lines.out, ['꺼짐(자료 폴더: .omc/progress-mon/)']);
  const none = { ...ctx, exists: false, dataDir: path.join(ctx.project, '.omx', 'progress-mon') };
  const io2 = quietIo();
  assert.equal(await status(none, io2), 3);
  assert.deepEqual(io2.lines.out, ['꺼짐(자료 폴더 없음: .omx/progress-mon/)']);
});

// 파일 링크. Windows 에서 권한(개발자 모드)이 없어 만들 수 없으면 거짓.
function fileLink(target, p) {
  try {
    fs.symlinkSync(target, p, 'file');
    return true;
  } catch (e) {
    if (process.platform === 'win32' && e.code === 'EPERM') return false;
    throw e;
  }
}

test('server.log 가 링크면 따라가지 않음: 대상을 쓰지도 비우지도 읽지도 않음', T, (t) => {
  const ctx = ctxOf();
  const target = path.join(ROOT, `victim${++n}.txt`);
  const body = `2026-10-30T00:00:00.000Z 오류: ${'s'.repeat(600)}\n`;
  fs.writeFileSync(target, body);
  if (!fileLink(target, logPath(ctx.dataDir))) return t.skip('Windows 에서 파일 링크를 만들 권한이 없음(개발자 모드 꺼짐)');
  const log = makeLogger(ctx.dataDir, 400);
  log('한 줄');
  log('두 줄');
  assert.equal(fs.readFileSync(target, 'utf8'), body, '대상 그대로(1 MB 넘는 대상을 비우던 결함)');
  assert.ok(fs.lstatSync(logPath(ctx.dataDir)).isSymbolicLink(), '링크도 그대로');
  assert.deepEqual(logLinesSince(ctx.dataDir, 0, ['오류:']), [], '링크를 따라 읽지 않음');
});

test('server.log 가 한도를 넘으면 server.log.1 로 옮기고 새로 씀', T, () => {
  const ctx = ctxOf();
  fs.writeFileSync(logPath(ctx.dataDir), 'x'.repeat(350));
  const log = makeLogger(ctx.dataDir, 400);
  log(`줄 ${'y'.repeat(60)}`);
  assert.equal(fs.readFileSync(`${logPath(ctx.dataDir)}.1`, 'utf8'), 'x'.repeat(350));
  assert.match(fs.readFileSync(logPath(ctx.dataDir), 'utf8'), /^\S+ 줄 y+\n$/);
  assert.deepEqual(logLinesSince(ctx.dataDir, 0, ['줄']), [`줄 ${'y'.repeat(60)}`]);
});
