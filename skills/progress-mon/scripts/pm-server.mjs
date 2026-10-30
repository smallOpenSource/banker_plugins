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

// server.log 가 링크나 일반 파일이 아닌 것(FIFO 등)이면 참. 없으면 거짓.
function oddLog(file) {
  try {
    return !fs.lstatSync(file).isFile();
  } catch (e) {
    return e.code !== 'ENOENT';
  }
}

// 덧붙이기로 연 server.log 의 fd. 링크와 일반 파일 아닌 것은 열지 않는다(POSIX 는 O_NOFOLLOW, 연 뒤 fstat 다시 확인).
function openLog(file) {
  if (oddLog(file)) throw Object.assign(new Error('server.log 가 일반 파일 아님'), { code: 'EINVAL' });
  const { O_WRONLY, O_APPEND, O_CREAT } = fs.constants;
  const fd = fs.openSync(file, O_WRONLY | O_APPEND | O_CREAT | NOFOLLOW | NONBLOCK, 0o600);
  if (!fs.fstatSync(fd).isFile()) {
    fs.closeSync(fd);
    throw Object.assign(new Error('server.log 가 일반 파일 아님'), { code: 'EINVAL' });
  }
  return fd;
}

// server.log 한 줄 덧붙이기. 덧붙이면 max(1 MB)를 넘을 때 먼저 server.log.1 로 옮긴다(대상을 자르지 않음, rename 은 링크를 따라가지 않음).
// 링크이거나 일반 파일이 아니면 쓰지 않는다. 실패해도 서버는 계속.
export function makeLogger(dataDir, max = LOG_MAX) {
  const file = logPath(dataDir);
  return (msg) => {
    const line = `${new Date().toISOString()} ${msg}\n`;
    let fd = null;
    try {
      fd = openLog(file);
      if (fs.fstatSync(fd).size + Buffer.byteLength(line) > max) {
        fs.closeSync(fd);
        fd = null;
        fs.renameSync(file, `${file}.1`);
        fd = openLog(file);
      }
      fs.writeSync(fd, line);
    } catch {
      // 로그를 못 써도 응답은 계속
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
        ? { app: APP, pid: process.pid, startedAt: srv.stats.startedAt, requests: srv.stats.requests, lastRequestAt: srv.stats.lastRequestAt, lastErrorAt: srv.stats.lastErrorAt }
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
async function runningServer(dataDir) {
  const st = readState(dataDir);
  if (!st || st.broken || !validPid(st.pid) || !validPort(st.port)) return null;
  const r = await askIdentity(st.port);
  return r.kind === 'ok' && r.info.pid === st.pid ? { st, info: r.info } : null;
}

function hostList(config, host) {
  const out = [];
  for (const ip of config.hosts || []) if (!out.some((h) => h.ip === ip)) out.push({ ip, from: 'config' });
  if (host && !out.some((h) => h.ip === host)) out.push({ ip: host, from: 'arg' });
  else if (host) out.find((h) => h.ip === host).from = 'arg';
  return out;
}

// 앞에서 도는 서버. 돌려줌: 닫기 함수가 든 객체. 실패는 UsageError.
// opts: { port, portStrict, host }, io: { out(line), err(line) }
export async function serve(ctx, config, opts, io, { render } = {}) {
  if (opts.host !== undefined && !privateIPv4(opts.host)) throw new UsageError(hostRefusal(opts.host));
  const log = makeLogger(ctx.dataDir);
  const fail = (e) => {
    log(`오류: ${e.message}`);
    throw e;
  };
  const stats = { startedAt: iso(Date.now()), requests: 0, lastRequestAt: null, lastErrorAt: null };
  const fixedNow = process.env.PROGRESS_MON_NOW ? Date.parse(process.env.PROGRESS_MON_NOW) : NaN;
  if (!render) {
    const { renderTab } = await import('./pm-render.mjs');
    render = (tab, now) => renderTab(ctx, config, tab, now);
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
    await writeState(ctx.dataDir, { port: bound.port, pid: process.pid, hosts, project: ctx.project, startedAt: stats.startedAt });
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

// serve 를 분리 실행하고 자기 탐침으로 최대 5초 기다린다. 돌려줌: 종료 코드.
export async function start(ctx, config, opts, io, { cliPath }) {
  if (opts.host !== undefined && !privateIPv4(opts.host)) throw new UsageError(hostRefusal(opts.host));
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
  const r = await askIdentity(st.port);
  if (r.kind === 'refused') {
    dropState(ctx.dataDir);
    io.out(`이미 꺼짐(포트 ${st.port} 연결 거부). 상태 파일 삭제`);
    return 0;
  }
  if (r.kind === 'timeout') {
    io.err(`오류: 포트 ${st.port} 응답 시간 초과(1.5초). 상태 파일 그대로 둠`);
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

// 탭 자료 유무 줄.
function tabData(dataDir) {
  const has = (f) => (fs.existsSync(path.join(dataDir, f)) ? '있음' : '없음');
  return `진척도 ${has('items.json')}, 구현요건 ${has('req-spec.json')}, workflow ${has('flow.json')}, 구성도 ${has('arch.json')}`;
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
  statusWarnings(ctx, io);
  return 0;
}
