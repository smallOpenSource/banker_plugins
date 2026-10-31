// pm-server.mjs: serve, start, stop, status. 바인드, Host 검사, 신원 경로, 상태 파일, 포트 선택, 자기 탐침, 로그.
// 서버는 렌더 결과만 응답한다. 자료 폴더의 파일은 어떤 경로로도 서빙하지 않는다.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { privateIPv4, dataLabel, loadConfig, writeAtomic, readRegular, UsageError } from './pm-config.mjs';
import { workflowRoots } from './pm-sources.mjs';
import { memoryWarnings } from './pm-memory.mjs';

const APP = 'progress-mon';
export const ID_PATH = '/__progress-mon/id';
const LOOPBACK = '127.0.0.1';
const PAGE_PATHS = new Set(['/', '/index.html']);
const LOG_MAX = 1024 * 1024;
const PORT_TRIES = 100;
const START_WAIT_MS = 5000;
const ASK_TIMEOUT_MS = 1500;
const BUSY_WAIT_MS = 10000;
const STOP_WAIT_MS = 3000;

export const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
};
export const ERROR_BODY = '오류. server.log 확인';

// 거부 문구(--host). 사설 IPv4 만 받는다.
export const hostRefusal = (ip) => `--host ${ip} 거부. 사설 IPv4(10/8, 172.16/12, 192.168/16)만 받음`;

// Host 머리 정확 일치: 127.0.0.1, localhost, [::1], 바인드한 IP. 모두 같은 포트. 대소문자 무시.
export function hostAllowed(hostHeader, port, ips = []) {
  const h = String(hostHeader || '').trim().toLowerCase();
  if (!h) return false;
  const ok = [LOOPBACK, 'localhost', '[::1]', ...ips].map((x) => `${String(x).toLowerCase()}:${port}`);
  return ok.includes(h);
}

// 로그에 남길 값: 제어 문자 제거 뒤 80자.
export const cleanForLog = (v) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 80);

const isLoopbackAddr = (a) => a === LOOPBACK || a === '::1' || a === '::ffff:127.0.0.1';
const validPid = (pid) => Number.isInteger(pid) && pid > 1;
const validPort = (p) => Number.isInteger(p) && p > 0 && p <= 65535;
const iso = (ms) => new Date(ms).toISOString();
const urlOf = (ip, port) => `http://${ip}:${port}/`;

export const statePath = (dataDir) => path.join(dataDir, 'server.json');
export const logPath = (dataDir) => path.join(dataDir, 'server.log');

export function readState(dataDir) {
  try {
    return JSON.parse(readRegular(statePath(dataDir)));
  } catch (e) {
    return e.code === 'ENOENT' ? null : { broken: true };
  }
}

// 상태 파일 쓰기(pm-config.mjs 의 원자적 쓰기). 실패는 UsageError.
export const writeState = (dataDir, info) => writeAtomic(statePath(dataDir), JSON.stringify(info) + '\n');

function dropState(dataDir) {
  try {
    fs.rmSync(statePath(dataDir), { force: true });
  } catch {
    // 지울 수 없으면 남김. 다음 start 가 낡은 기록으로 판정한다.
  }
}

const NOFOLLOW = fs.constants.O_NOFOLLOW || 0; // Windows 에는 없음. 거기서는 lstat 만으로 링크를 거른다
const NONBLOCK = fs.constants.O_NONBLOCK || 0;

// server.log 가 링크나 일반 파일이 아닌 것(FIFO 등)이거나 하드링크(nlink > 1)면 참. 없으면 거짓.
// 하드링크를 거르는 까닭: rotateLog 가 옮기지 못할 때 ftruncate 로 비우는데, 하드링크면 그 대상(남의 파일)이 비워진다.
function oddLog(file) {
  try {
    const st = fs.lstatSync(file);
    return !st.isFile() || st.nlink > 1;
  } catch (e) {
    return e.code !== 'ENOENT';
  }
}

// 링크, 특수 파일, 하드링크라 server.log 를 거부한 오류. fs 가 낸 오류(EINVAL 등)와 섞이지 않게 표시를 따로 둔다.
const oddLogError = (msg) => Object.assign(new Error(msg), { oddLog: true });
// lstat 과 open 사이에 링크(ELOOP, BSD 의 EMLINK)나 소켓(ENXIO)으로 바뀐 자리에서 open 이 내는 코드. 같은 거부로 본다.
const ODD_OPEN = new Set(['ELOOP', 'EMLINK', 'ENXIO']);

// server.log 의 fd. 기본은 덧붙이기, append 가 거짓이면 처음부터 다시 쓰기(Windows 의 덧붙이기 fd 는 자를 수 없음).
// 링크와 일반 파일 아닌 것은 열지 않는다(POSIX 는 O_NOFOLLOW, 연 뒤 fstat 다시 확인).
function openLog(file, append = true) {
  if (oddLog(file)) throw oddLogError('server.log 가 일반 파일 아님');
  const { O_WRONLY, O_RDWR, O_APPEND, O_CREAT } = fs.constants;
  const fd = fs.openSync(file, (append ? O_WRONLY | O_APPEND : O_RDWR) | O_CREAT | NOFOLLOW | NONBLOCK, 0o600);
  const st = fs.fstatSync(fd);
  if (!st.isFile() || st.nlink > 1) {
    fs.closeSync(fd);
    throw oddLogError('server.log 가 일반 파일 아님 또는 하드링크');
  }
  return fd;
}

// 한도를 넘은 server.log 를 server.log.1 로 옮기고 새 fd 를 돌려준다(rename 은 링크를 따라가지 않음). 옮기면 ok() 를 부른다.
// 옮긴 뒤 새 파일을 못 열면 그 오류를 던진다(옮기기는 된 것이라 쓰기 실패로 알림).
function rotateLog(file, fd, warn, ok) {
  fs.closeSync(fd);
  try {
    fs.renameSync(file, `${file}.1`);
  } catch (e) {
    return keepLog(file, e, warn);
  }
  ok();
  return openLog(file);
}

// 옮기지 못하면(그 자리에 폴더 등) 로그를 버리지 않도록 server.log(일반 파일로 확인함)를 비우고 계속 쓰며, 그 사실을 warn 으로 알린다.
function keepLog(file, e, warn) {
  const again = openLog(file, false);
  try {
    fs.ftruncateSync(again, 0);
  } catch (t) {
    fs.closeSync(again);
    throw t;
  }
  warn(`server.log 를 server.log.1 로 옮기지 못함(${e.code || e.message}). 대신 server.log 를 비우고 계속 기록. server.log.1 자리를 치우면 다시 옮김`);
  return again;
}

// server.log 를 못 쓴 까닭의 경고 문구. 링크, 특수 파일, 하드링크 거부와 fs 오류를 나눈다.
function logFailure(e) {
  if (e && (e.oddLog || ODD_OPEN.has(e.code))) return 'server.log 가 링크, 특수 파일이거나 하드링크라 기록하지 않음. 그 파일을 치우면 다시 기록';
  return `server.log 에 기록하지 못함(${(e && (e.code || e.message)) || e}). 서버는 계속`;
}

const PENDING_KEEP = 10; // 쓰지 못하고 쌓아 두는 경고와 회복 줄은 앞 10줄과 뒤 10줄만 남기고 가운데는 개수만 남긴다

// server.log 경고 상태. 종류별 칸이 따로 있다: 'fail' 은 기록이 멈춘 경고라 쓰기가 다시 되면 지우고, 'rotate' 는 다음 옮기기가 되면 지운다.
// 같은 까닭은 한 번만 알리고, 까닭이 바뀌면 다시 알린다. status 에는 fail 이 있으면 fail, 없으면 rotate 를 보인다(바뀔 때만 onWarn).
// 알림과 회복 줄은 쌓아 두었다가 다음에 쓰는 줄과 함께 쓴다. 쓰기에 성공한 뒤에만 비운다
function logWarnings(onWarn) {
  const shown = { fail: null, rotate: null };
  let lines = [];
  let dropped = 0;
  const current = () => shown.fail || shown.rotate;
  const set = (kind, text) => {
    const before = current();
    shown[kind] = text;
    if (current() !== before) onWarn(current());
  };
  // 처음 까닭과 최신 까닭(회복 줄 포함)이 함께 남도록 넘치면 가운데 줄을 뺀다
  const note = (text) => {
    lines.push(`${new Date().toISOString()} ${text}\n`);
    if (lines.length > PENDING_KEEP * 2) {
      lines.splice(PENDING_KEEP, 1);
      dropped++;
    }
  };
  const omitted = () => (dropped ? [`${new Date().toISOString()} 경고: 쓰지 못한 경고와 회복 줄 ${dropped}개 생략\n`] : []);
  return {
    warn(kind, text) {
      if (shown[kind] === text) return;
      set(kind, text);
      note(`경고: ${text}`);
    },
    clear(kind) {
      if (!shown[kind]) return false;
      note(`회복: 앞의 경고가 풀림(${shown[kind]})`);
      set(kind, null);
      return true;
    },
    head: () => [...lines.slice(0, PENDING_KEEP), ...omitted(), ...lines.slice(PENDING_KEEP)].join(''),
    sent() {
      lines = [];
      dropped = 0;
    },
  };
}

// server.log 한 줄 덧붙이기. 덧붙이면 max(1 MB)를 넘을 때 먼저 server.log.1 로 옮긴다(대상을 자르지 않음).
// 링크이거나 일반 파일이 아니면 쓰지 않는다. 못 쓰거나 옮기지 못한 일은 onWarn(서버의 status 경고)과 로그의 경고 줄로 알리고,
// 회복하면 onWarn(null) 로 status 경고를 지운다. 실패해도 서버는 계속.
export function makeLogger(dataDir, max = LOG_MAX, onWarn = () => {}) {
  const file = logPath(dataDir);
  const w = logWarnings(onWarn);
  const rotateWarn = (text) => w.warn('rotate', text);
  const rotateOk = () => w.clear('rotate');
  return (msg) => {
    const line = `${new Date().toISOString()} ${msg}\n`;
    let fd = null;
    try {
      fd = openLog(file);
      if (fs.fstatSync(fd).size + Buffer.byteLength(w.head() + line) > max) {
        const old = fd;
        fd = null;
        fd = rotateLog(file, old, rotateWarn, rotateOk);
      }
      fs.writeSync(fd, w.head() + line);
      w.sent();
      if (w.clear('fail')) {
        fs.writeSync(fd, w.head());
        w.sent();
      }
    } catch (e) {
      // 로그를 못 써도 응답은 계속. 기록이 멈춘 것을 까닭과 함께 알린다(status 경고)
      w.warn('fail', logFailure(e));
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  };
}

// 요청 처리기. srv: { port, ips, render(tab, now), log, stats, now() }. port 와 ips 는 요청 때 읽는다.
export function createHandler(srv) {
  const send = (req, res, status, body, type = 'text/plain; charset=utf-8', extra = {}) => {
    res.writeHead(status, { 'content-type': type, ...SECURITY_HEADERS, ...extra });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
  return (req, res) => {
    const raw = String(req.url || '/');
    const pathname = raw.split('?')[0];
    const note = (status) => srv.log(`${status} ${cleanForLog(req.method)} ${cleanForLog(pathname)} host=${cleanForLog(req.headers.host)}`);
    if (!hostAllowed(req.headers.host, srv.port, srv.ips)) {
      note(403);
      return send(req, res, 403, '거부된 Host');
    }
    // Host 검사를 통과한 요청만 센다(403 은 status 의 요청 수에 넣지 않음). 신원 경로도 세지 않는다.
    if (pathname !== ID_PATH) {
      srv.stats.requests++;
      srv.stats.lastRequestAt = iso(Date.now());
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      note(405);
      return send(req, res, 405, '허용하지 않는 메서드', undefined, { allow: 'GET, HEAD' });
    }
    if (pathname === ID_PATH) {
      const body = isLoopbackAddr(req.socket.localAddress)
        ? { app: APP, pid: process.pid, startedAt: srv.stats.startedAt, requests: srv.stats.requests, lastRequestAt: srv.stats.lastRequestAt, lastErrorAt: srv.stats.lastErrorAt, logWarning: srv.stats.logWarning }
        : { app: APP };
      return send(req, res, 200, JSON.stringify(body), 'application/json; charset=utf-8');
    }
    if (!PAGE_PATHS.has(pathname)) {
      note(404);
      return send(req, res, 404, '없음');
    }
    let tab = null;
    try {
      tab = new URL(raw, 'http://x').searchParams.get('tab');
    } catch {
      tab = null;
    }
    let html;
    try {
      html = srv.render(tab, srv.now());
    } catch (e) {
      srv.stats.lastErrorAt = iso(Date.now());
      srv.log(`500 ${cleanForLog(req.method)} ${cleanForLog(pathname)} 렌더 오류\n${(e && e.stack) || e}`);
      return send(req, res, 500, ERROR_BODY);
    }
    send(req, res, 200, html, 'text/html; charset=utf-8');
  };
}

// 실제 리스너 하나. 오류는 코드가 든 예외로.
function listenHttp(handler) {
  return (port, host) =>
    new Promise((resolve, reject) => {
      const s = http.createServer(handler);
      const onError = (e) => {
        s.off('listening', onListening);
        reject(e);
      };
      const onListening = () => {
        s.off('error', onError);
        resolve(s);
      };
      s.once('error', onError);
      s.once('listening', onListening);
      s.listen(port, host);
    });
}

const closeAll = (servers) => Promise.all(servers.map((s) => new Promise((r) => s.close(() => r()))));

// 포트 선택과 바인드(계획 3절). hosts: [{ ip, from: 'arg' | 'config' }].
// listen(port, host) 는 서버를 돌려주거나 code 가 든 예외를 던진다. probe(port) 가 거짓이면 그 포트는 다른 프로그램.
// 돌려줌: { port, servers, ips, notes }. 실패는 UsageError.
export async function bindServers({ port, strict, hosts = [], listen, probe = async () => true }) {
  const notes = [];
  const busy = () => new UsageError(`포트 ${port} 사용 중(--port-strict). 다른 포트를 고르지 않음`);
  const last = strict ? port : Math.min(65535, port + PORT_TRIES - 1);
  const skipped = new Set();
  for (let p = port; p <= last; p++) {
    let main;
    try {
      main = await listen(p, LOOPBACK);
    } catch (e) {
      if (e.code === 'EADDRINUSE' || e.code === 'EACCES') {
        if (strict) throw e.code === 'EADDRINUSE' ? busy() : new UsageError(`포트 ${p} 를 열 권한 없음(${e.code})`);
        continue;
      }
      throw new UsageError(`포트 ${p} 바인드 실패(${e.code || e.message})`);
    }
    const servers = [main];
    const ips = [];
    let retry = false;
    for (const h of hosts) {
      if (skipped.has(h.ip)) continue;
      try {
        servers.push(await listen(p, h.ip));
        ips.push(h.ip);
      } catch (e) {
        if (e.code === 'EADDRINUSE') {
          await closeAll(servers);
          if (strict) throw busy();
          retry = true;
          break;
        }
        if (e.code === 'EADDRNOTAVAIL' && h.from === 'config') {
          skipped.add(h.ip);
          notes.push(`경고: config.hosts 의 ${h.ip} 는 이 PC 주소가 아님. 그 주소는 열지 않고 계속`);
          continue;
        }
        await closeAll(servers);
        if (e.code === 'EADDRNOTAVAIL') throw new UsageError(`--host ${h.ip} 는 이 PC 주소가 아님`);
        throw new UsageError(`${h.ip}:${p} 바인드 실패(${e.code || e.message})`);
      }
    }
    if (retry) continue;
    if (!(await probe(p))) {
      // 같은 포트를 다른 프로그램이 넓은 주소로 쥐고 있어 우리 서버가 답하지 않음
      await closeAll(servers);
      if (strict) throw busy();
      continue;
    }
    if (p !== port) notes.push(`알림: 포트 ${port} 사용 중이라 ${p} 사용`);
    for (const ip of ips) notes.push(`경고: ${ip} 에 바인드. 같은 네트워크의 기기가 화면을 볼 수 있음. 끝나면 stop 으로 닫음`);
    return { port: p, servers, ips, notes };
  }
  throw new UsageError(`포트 ${port}~${last} 모두 사용 중`);
}

// 신원 경로 요청. 돌려줌: { kind: 'ok', info } | { kind: 'refused' } | { kind: 'timeout' } | { kind: 'other' }
export function askIdentity(port, timeoutMs = ASK_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let done = false;
    const end = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    const req = http.get({ host: LOOPBACK, port, path: ID_PATH, headers: { host: `${LOOPBACK}:${port}` }, timeout: timeoutMs, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        if (body.length < 4096) body += c;
      });
      res.on('end', () => {
        try {
          const info = JSON.parse(body);
          end(res.statusCode === 200 && info && info.app === APP ? { kind: 'ok', info } : { kind: 'other' });
        } catch {
          end({ kind: 'other' });
        }
      });
      res.on('error', () => end({ kind: 'other' }));
    });
    req.on('timeout', () => {
      req.destroy();
      end({ kind: 'timeout' });
    });
    req.on('error', (e) => end(e.code === 'ECONNREFUSED' ? { kind: 'refused' } : { kind: 'other' }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 상태 파일의 서버가 지금 그 포트에서 그 pid 로 답하는지.
// 신원 응답이 시간을 넘겨도 상태 파일의 pid 가 살아 있으면 렌더가 느린(큰 저장소의 첫 git log 등) 서버로 보고
// BUSY_WAIT_MS 까지 한 번 더 기다린다. 렌더는 동기라 그동안 신원 요청이 줄을 서기 때문(살아 있는 서버를 없다고 보지 않게).
async function runningServer(dataDir) {
  const st = readState(dataDir);
  if (!st || st.broken || !validPid(st.pid) || !validPort(st.port)) return null;
  let r = await askIdentity(st.port);
  if (r.kind === 'timeout' && alive(st.pid)) r = await askIdentity(st.port, BUSY_WAIT_MS);
  return r.kind === 'ok' && r.info.pid === st.pid ? { st, info: r.info } : null;
}

function hostList(config, host) {
  const out = [];
  for (const ip of config.hosts || []) if (!out.some((h) => h.ip === ip)) out.push({ ip, from: 'config' });
  if (host && !out.some((h) => h.ip === host)) out.push({ ip: host, from: 'arg' });
  else if (host) out.find((h) => h.ip === host).from = 'arg';
  return out;
}

// 서버를 다시 띄워야 적용되는 config 값(나머지는 요청마다 다시 읽음). 상태 파일에 남겨 status 가 바뀜을 알린다.
const restartValues = (config) => ({ port: config.port, portStrict: config.portStrict, hosts: [...(config.hosts || [])].sort() });

// 상태 파일의 다른 서버가 살아 있으면 이 서버는 상태 파일을 덮지 않고 닫는다(끌 수 없는 서버가 남지 않게).
async function refuseSecond(dataDir) {
  const run = await runningServer(dataDir);
  if (run && run.st.pid !== process.pid) throw new UsageError(`이미 실행 중인 서버가 있음: ${urlOf(LOOPBACK, run.st.port)} (PID ${run.st.pid}). 이 서버는 닫음`);
}

// 앞에서 도는 서버. 돌려줌: 닫기 함수가 든 객체. 실패는 UsageError.
// opts: { port, portStrict, host }, io: { out(line), err(line) }
export async function serve(ctx, config, opts, io, { render } = {}) {
  if (opts.host !== undefined && !privateIPv4(opts.host)) throw new UsageError(hostRefusal(opts.host));
  const stats = { startedAt: iso(Date.now()), requests: 0, lastRequestAt: null, lastErrorAt: null, logWarning: null };
  const log = makeLogger(ctx.dataDir, LOG_MAX, (w) => (stats.logWarning = w));
  const fail = (e) => {
    log(`오류: ${e.message}`);
    throw e;
  };
  const fixedNow = process.env.PROGRESS_MON_NOW ? Date.parse(process.env.PROGRESS_MON_NOW) : NaN;
  if (!render) {
    const { liveRender } = await import('./pm-render.mjs');
    render = liveRender(ctx, config);
  }
  const srv = {
    port: 0,
    ips: [],
    log,
    stats,
    render,
    now: () => (Number.isFinite(fixedNow) ? fixedNow : Date.now()),
  };
  const handler = createHandler(srv);
  const port = opts.port ?? config.port;
  const strict = Boolean(opts.portStrict || config.portStrict);
  let bound;
  try {
    await refuseSecond(ctx.dataDir); // 바인드 전에도 본다(다른 서버가 있으면 옆 포트 알림 없이 바로 닫음)
    bound = await bindServers({
      port,
      strict,
      hosts: hostList(config, opts.host),
      listen: listenHttp(handler),
      probe: async (p) => {
        srv.port = p;
        const r = await askIdentity(p);
        return r.kind === 'ok' && r.info.pid === process.pid;
      },
    });
  } catch (e) {
    return fail(e);
  }
  srv.port = bound.port;
  srv.ips = bound.ips;
  const hosts = [LOOPBACK, ...bound.ips];
  for (const n of bound.notes) {
    log(n);
    io.out(n);
  }
  log(`시작 port=${bound.port} 주소=${hosts.join(',')} PID ${process.pid}`);
  for (const s of bound.servers)
    s.on('error', (e) => {
      log(`오류: 리스너 오류(${e.code || e.message})`);
      process.exit(1);
    });
  try {
    await refuseSecond(ctx.dataDir);
    await writeState(ctx.dataDir, { port: bound.port, pid: process.pid, hosts, project: ctx.project, startedAt: stats.startedAt, applied: restartValues(config) });
  } catch (e) {
    await closeAll(bound.servers);
    return fail(e);
  }
  io.out(`시작함: ${urlOf(LOOPBACK, bound.port)}`);
  for (const ip of bound.ips) io.out(`추가 주소: ${urlOf(ip, bound.port)}`);
  const close = async () => {
    await closeAll(bound.servers);
    const st = readState(ctx.dataDir);
    if (st && st.pid === process.pid) dropState(ctx.dataDir);
  };
  return { port: bound.port, ips: bound.ips, close };
}

// server.log 의 off 바이트 뒤 줄 가운데 머리(오류:, 알림:, 경고:)로 시작하는 것. 시각 칸은 뺀다.
// 링크이거나 일반 파일이 아니면 읽지 않는다.
export function logLinesSince(dataDir, off, heads) {
  let text = '';
  try {
    if (oddLog(logPath(dataDir))) return [];
    const buf = readRegular(logPath(dataDir), null);
    text = buf.subarray(buf.length < off ? 0 : off).toString('utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .map((l) => l.replace(/^\S+ /, ''))
    .filter((l) => heads.some((h) => l.startsWith(h)));
}

// 기존 config.json 의 hosts 에 주소 추가. 서버는 이미 떠 있으므로 읽기, 쓰기 실패는 경고만. 깨진 파일은 고치지 않는다.
export async function saveHost(ctx, ip, io, fsx = fs) {
  const file = path.join(ctx.dataDir, 'config.json');
  let raw = {};
  try {
    raw = JSON.parse(readRegular(file));
  } catch (e) {
    if (e.code !== 'ENOENT') {
      io.err(`경고: config.json 을 읽지 못해 --host ${ip} 를 저장하지 않음`);
      return;
    }
  }
  const hosts = Array.isArray(raw.hosts) ? raw.hosts : [];
  if (hosts.includes(ip)) return;
  raw.hosts = [...hosts, ip];
  try {
    await writeAtomic(file, JSON.stringify(raw, null, 2) + '\n', fsx);
  } catch (e) {
    io.err(`경고: --host ${ip} 를 config.json 에 저장하지 못함(${e.message}). 서버는 계속`);
  }
}

// ---------- start 잠금 ----------
// 동시에 부른 start 가 서버를 둘 띄우지 않게 start 전체를 server.json.lock 으로 감싼다(wx: 둘 가운데 하나만 만듦,
// 그 자리의 링크는 따라가지 않고 EEXIST). 못 잡은 쪽은 기다렸다가 잡고, 그 안에서 떠 있는 서버를 다시 보아 재사용한다.
// 낡은 잠금(쥔 프로세스가 죽음, 또는 START_LOCK_STALE_MS 넘게 남음, 링크나 일반 파일 아님)은 넘겨받기 표지
// server.json.lock.taking 을 wx 로 잡은 쪽만, 그 안에서 다시 판정한 뒤 지우고 새로 만든다.
const START_LOCK = 'server.json.lock';
const START_LOCK_STALE_MS = 30000;
const START_LOCK_WAIT_MS = 15000;

// 잠금이 있는 것처럼 기다릴 wx 실패. Windows 는 다른 프로세스가 지우는 중인 파일(delete pending) 자리에 EEXIST 대신
// EPERM(또는 EACCES, EBUSY)을 낸다. 잠금을 돌려주는 순간과 겹친 start 가 실패하지 않게 한다(items.json 잠금과 같은 규칙).
const LOCK_BUSY = new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY']);

// 돌려줌: 만들었으면 null, 아니면 그 까닭 코드. 그 밖 오류는 UsageError.
function makeLockFile(file) {
  try {
    fs.writeFileSync(file, `${process.pid} ${iso(Date.now())}\n`, { flag: 'wx', mode: 0o600 });
    return null;
  } catch (e) {
    if (LOCK_BUSY.has(e.code)) return e.code;
    throw new UsageError(`잠금 ${path.basename(file)} 을 만들지 못함(${e.code || e.message})`);
  }
}

const lockPid = (file) => {
  try {
    const pid = Number(readRegular(file).split(' ')[0]);
    return validPid(pid) ? pid : null;
  } catch {
    return null;
  }
};

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

// 지금 낡았는지. 없으면 거짓(다시 만들면 됨). pid 를 아직 못 읽는 잠금(막 만들어 쓰는 중)은 시간으로만 본다.
function staleLock(file, now) {
  let st;
  try {
    st = fs.lstatSync(file);
  } catch {
    return false;
  }
  if (!st.isFile() || now - st.mtimeMs > START_LOCK_STALE_MS) return true;
  const pid = lockPid(file);
  return pid !== null && !alive(pid);
}

// 낡은 잠금을 넘겨받는다. 돌려줌: 넘겨받았으면 null, 아니면 기다릴 까닭 { code, slot }(slot 은 그 코드를 낸 파일).
// 표지를 EEXIST 밖의 까닭(EPERM, EACCES, EBUSY)으로 못 만들면 slot 은 표지다. 그래야 표지 자리의 진짜 권한 오류가
// 잠금 자리처럼 1초대에 끝나고, 15초 뒤 "다른 start 가 끝나지 않음" 으로 잘못 안내하지 않는다.
function takeOverLock(file, now) {
  const taking = `${file}.taking`;
  const code = makeLockFile(taking);
  if (code !== null) {
    // 넘겨받던 start 가 죽어 남은 표지는 START_LOCK_STALE_MS 뒤 치운다(이번은 기다리고 다음에 넘겨받음)
    try {
      if (now - fs.lstatSync(taking).mtimeMs > START_LOCK_STALE_MS) fs.rmSync(taking, { force: true });
    } catch {
      // 그 사이 지워짐, 또는 표지가 없음(EPERM 등)
    }
    return { code, slot: taking };
  }
  try {
    if (!staleLock(file, now)) return { code: 'EEXIST', slot: file };
    fs.rmSync(file, { force: true });
    const again = makeLockFile(file);
    return again === null ? null : { code: again, slot: file };
  } finally {
    fs.rmSync(taking, { force: true });
  }
}

// start 잠금을 잡을 때까지 waitMs 기다린다. 돌려줌: 잠금 경로. 시간 초과는 UsageError: 잠금 파일이 한 번이라도 보였으면
// 다른 start, 끝내 없었으면(EPERM 등이 계속, 권한 등) 만들지 못함.
// 잠금 파일이 끝내 안 보이는 동안 EPERM/EACCES/EBUSY 가 pendingMs(1초) 넘게 이어지면 바로 실패한다: Windows 의
// delete pending 은 ms 안에 풀려 그 사이 성공하지만, 읽기 전용 폴더 같은 진짜 권한 오류는 15초를 기다리지 않고 끝낸다.
// 잠금을 만들거나 낡은 것을 넘겨받으면 { lock }, 아니면 그 까닭 { code, slot }.
function tryStartLock(file, now) {
  const code = makeLockFile(file);
  if (code === null) return { lock: file };
  if (!staleLock(file, now)) return { code, slot: file };
  const why = takeOverLock(file, now);
  return why === null ? { lock: file } : why;
}

// 전체 대기가 끝났을 때 던질 오류: 잠금 파일을 한 번도 못 봤으면 만들지 못함, 봤으면 다른 start 가 끝나지 않음.
function startWaitError(file, seen, code) {
  if (!seen) return new UsageError(`잠금 ${START_LOCK} 을 만들지 못함(${code})`);
  return new UsageError(`다른 start 가 끝나지 않음(잠금 ${START_LOCK}, pid ${lockPid(file) ?? '알 수 없음'}). 30초 뒤 다시 실행. 그 start 가 끝났는데도 남아 있으면 잠금 파일을 지운 뒤 다시 실행`);
}

// 잠금을 못 잡은 반복의 상태 갱신. 돌려줌: [seen, errSince]. 그 코드를 낸 파일(slot: 잠금 또는 넘겨받기 표지)이 없는
// EPERM/EACCES/EBUSY 가 pendingMs 넘게 이어지면(진짜 권한 오류) 바로 실패시킨다. errSince 는 그런 코드가 처음 난 때.
// seen 은 잠금 파일을 한 번이라도 본 것(표지를 못 만든 반복도 잠금 파일은 있음).
function startWaitStep(file, { code, slot }, seen, errSince, now, pendingMs) {
  const here = code === 'EEXIST' || fs.existsSync(slot);
  const es = here ? null : (errSince ?? now);
  if (es !== null && now - es >= pendingMs) throw new UsageError(`잠금 ${path.basename(slot)} 을 만들지 못함(${code})`);
  return [seen || here || (slot !== file && fs.existsSync(file)), es];
}

export async function takeStartLock(dataDir, waitMs = START_LOCK_WAIT_MS, pendingMs = 1000) {
  const file = path.join(dataDir, START_LOCK);
  const until = Date.now() + waitMs;
  let seen = false;
  let errSince = null;
  for (;;) {
    const now = Date.now();
    const r = tryStartLock(file, now);
    if (r.lock) return r.lock;
    [seen, errSince] = startWaitStep(file, r, seen, errSince, now, pendingMs);
    if (now >= until) throw startWaitError(file, seen, r.code);
    await sleep(100);
  }
}

// 잠금은 이 프로세스의 것일 때만 돌려준다.
export function giveBackLock(file) {
  if (lockPid(file) === process.pid) fs.rmSync(file, { force: true });
}

// serve 를 분리 실행하고 자기 탐침으로 최대 5초 기다린다. 동시에 부른 start 는 잠금 순서대로, 뒤쪽은 앞쪽 서버를 재사용한다.
// 돌려줌: 종료 코드.
export async function start(ctx, config, opts, io, deps) {
  if (opts.host !== undefined && !privateIPv4(opts.host)) throw new UsageError(hostRefusal(opts.host));
  const lock = await takeStartLock(ctx.dataDir);
  try {
    return await startLocked(ctx, config, opts, io, deps);
  } finally {
    giveBackLock(lock);
  }
}

async function startLocked(ctx, config, opts, io, { cliPath }) {
  const port = opts.port ?? config.port;
  const strict = Boolean(opts.portStrict || config.portStrict);
  const run = await runningServer(ctx.dataDir);
  if (run) {
    const { st } = run;
    if (strict && st.port !== port) throw new UsageError(`포트 ${port} 가 아닌 ${st.port} 에서 실행 중(--port-strict). stop 먼저`);
    if (opts.host !== undefined && !(st.hosts || []).includes(opts.host)) throw new UsageError(`실행 중 서버의 주소(${(st.hosts || []).join(', ')})에 ${opts.host} 가 없음. stop 먼저`);
    io.out(`이미 실행 중(재사용): ${urlOf(LOOPBACK, st.port)}`);
    return 0;
  }
  let off = 0;
  try {
    off = fs.statSync(logPath(ctx.dataDir)).size;
  } catch {
    off = 0;
  }
  const args = [cliPath, 'serve', '--port', String(port), '--project', ctx.project, '--data', ctx.dataDir, '--runtime', ctx.runtime];
  if (strict) args.push('--port-strict');
  if (opts.host !== undefined) args.push('--host', opts.host);
  const child = spawn(process.execPath, args, { cwd: ctx.project, detached: true, stdio: 'ignore', windowsHide: true });
  let exited = false;
  child.on('exit', () => (exited = true));
  child.on('error', () => (exited = true));
  const until = Date.now() + START_WAIT_MS;
  while (Date.now() < until) {
    await sleep(100);
    if (exited) break;
    const st = readState(ctx.dataDir);
    if (!st || st.pid !== child.pid || !validPort(st.port)) continue;
    const r = await askIdentity(st.port);
    if (r.kind !== 'ok' || r.info.pid !== child.pid) continue;
    for (const l of logLinesSince(ctx.dataDir, off, ['알림:', '경고:'])) io.out(l);
    io.out(`시작함: ${urlOf(LOOPBACK, st.port)}`);
    for (const ip of (st.hosts || []).filter((h) => h !== LOOPBACK)) io.out(`추가 주소: ${urlOf(ip, st.port)}`);
    if (opts.host !== undefined) await saveHost(ctx, opts.host, io);
    child.unref();
    return 0;
  }
  if (!exited) {
    try {
      process.kill(child.pid);
    } catch {
      // 이미 끝남
    }
    io.err('오류: 서버가 5초 안에 답하지 않음. server.log 확인');
    return 1;
  }
  const errs = logLinesSince(ctx.dataDir, off, ['오류:']);
  io.err(errs.length ? errs[errs.length - 1] : '오류: 서버 시작 실패. server.log 확인');
  return 1;
}

function portOpen(port) {
  return askIdentity(port, 500).then((r) => r.kind !== 'refused');
}

// 정지 규칙(계획 9.2절). 돌려줌: 종료 코드.
export async function stop(ctx, io) {
  if (!ctx.exists) {
    io.out(`이미 꺼짐(자료 폴더 없음: ${dataLabel(ctx)})`);
    return 0;
  }
  const st = readState(ctx.dataDir);
  if (!st) {
    io.out('이미 꺼짐(상태 파일 없음)');
    return 0;
  }
  if (st.broken || !validPid(st.pid) || !validPort(st.port)) {
    io.err('오류: 상태 파일 server.json 이 올바르지 않음. 그대로 둠');
    return 1;
  }
  let r = await askIdentity(st.port);
  // runningServer 와 같은 확인: 렌더가 느린 서버는 pid 가 살아 있으면 BUSY_WAIT_MS 까지 기다린다(PID 대조는 아래 그대로)
  if (r.kind === 'timeout' && alive(st.pid)) r = await askIdentity(st.port, BUSY_WAIT_MS);
  if (r.kind === 'refused') {
    dropState(ctx.dataDir);
    io.out(`이미 꺼짐(포트 ${st.port} 연결 거부). 상태 파일 삭제`);
    return 0;
  }
  if (r.kind === 'timeout') {
    io.err(`오류: 포트 ${st.port} 응답 시간 초과(${alive(st.pid) ? '11.5' : '1.5'}초). 상태 파일 그대로 둠`);
    return 1;
  }
  if (r.kind === 'other') {
    io.err(`오류: 포트 ${st.port} 에 다른 프로그램이 답함. 상태 파일 그대로 둠`);
    return 1;
  }
  if (r.info.pid !== st.pid) {
    io.err(`오류: 포트 ${st.port} 의 서버 PID ${r.info.pid} 가 상태 파일 PID ${st.pid} 와 다름. 상태 파일 그대로 둠`);
    return 1;
  }
  for (const sig of ['SIGTERM', 'SIGKILL']) {
    try {
      process.kill(st.pid, sig);
    } catch {
      // 이미 끝남
    }
    const until = Date.now() + STOP_WAIT_MS;
    while (Date.now() < until && (await portOpen(st.port))) await sleep(100);
    if (!(await portOpen(st.port))) {
      dropState(ctx.dataDir);
      io.out(`정지함: ${urlOf(LOOPBACK, st.port)} (PID ${st.pid}). 상태 파일 삭제`);
      return 0;
    }
  }
  io.err(`오류: 정지 시간 초과. 포트 ${st.port} 가 아직 열림. 상태 파일 그대로 둠`);
  return 1;
}

// 탭 자료 유무 줄. 읽지 못하거나 JSON 이 아닌 파일은 깨짐(check 로 확인).
function tabData(dataDir) {
  const has = (f) => {
    try {
      JSON.parse(readRegular(path.join(dataDir, f)));
      return '있음';
    } catch (e) {
      return e.code === 'ENOENT' ? '없음' : '깨짐';
    }
  };
  return `진척도 ${has('items.json')}, 구현요건 ${has('req-spec.json')}, workflow ${has('flow.json')}, 구성도 ${has('arch.json')}`;
}

// 서버를 띄운 뒤 config.json 의 port, portStrict, hosts 가 바뀌었으면 경고 한 줄(그 값은 다시 띄워야 적용).
function restartWarning(ctx, st, io) {
  const { config, errors } = loadConfig(ctx);
  if (errors.length || !st.applied) return;
  const now = restartValues(config);
  const changed = Object.keys(now).filter((k) => JSON.stringify(now[k]) !== JSON.stringify(st.applied[k]));
  if (changed.length) io.err(`경고: 서버를 띄운 뒤 config.json 의 ${changed.join(', ')} 가 바뀜. 적용하려면 stop 뒤 start`);
}

// 다시 잰 규칙 로드 한도와 override 가려짐 경고(state.json 의 memory), workflowDirs auto 0개. stderr 로.
function statusWarnings(ctx, io) {
  let memory = null;
  try {
    memory = JSON.parse(readRegular(path.join(ctx.dataDir, 'state.json'))).memory;
  } catch {
    memory = null;
  }
  for (const l of memoryWarnings(memory, ctx.project)) io.err(l);
  const { config } = loadConfig(ctx);
  if (config.sources.workflowDirs === 'auto' && !workflowRoots(config, ctx).length) io.err('WARN workflowDirs auto: 찾은 폴더 0');
}

// 실행 여부. 돌려줌: 0 실행 중, 3 꺼짐.
export async function status(ctx, io) {
  const label = dataLabel(ctx);
  if (!ctx.exists) {
    io.out(`꺼짐(자료 폴더 없음: ${label})`);
    return 3;
  }
  const run = await runningServer(ctx.dataDir);
  if (!run) {
    io.out(`꺼짐(자료 폴더: ${label})`);
    statusWarnings(ctx, io);
    return 3;
  }
  const { st, info } = run;
  io.out(`실행 중: ${urlOf(LOOPBACK, st.port)} (PID ${st.pid})`);
  io.out(`주소: ${(st.hosts || [LOOPBACK]).join(', ')}`);
  io.out(`자료 폴더: ${label}`);
  io.out(`탭 자료: ${tabData(ctx.dataDir)}`);
  io.out(`시작: ${info.startedAt || st.startedAt || '알 수 없음'}`);
  io.out(`요청: ${info.requests ?? 0}, 마지막 요청: ${info.lastRequestAt || '없음'}, 마지막 오류: ${info.lastErrorAt || '없음'}`);
  if (typeof info.logWarning === 'string') io.err(`경고: ${info.logWarning.replace(/[\u0000-\u001f\u007f]/g, '')}`);
  restartWarning(ctx, st, io);
  statusWarnings(ctx, io);
  return 0;
}
