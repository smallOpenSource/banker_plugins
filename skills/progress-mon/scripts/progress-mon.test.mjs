// progress-mon.mjs 시험. CLI 를 자식 프로세스로 실행(임시 프로젝트, 임시 HOME, OS 가 고른 빈 포트).
// 분리 실행 서버는 finally 에서 stop, 실패면 PID 종료. 포트 30000, 3456, 3458 은 쓰지 않는다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, HELP } from './progress-mon.mjs';

const T = { timeout: 60000 };
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'progress-mon.mjs');
// 이 폴더를 담은 git 저장소의 운영 자료 폴더(시험이 쓰면 안 됨). 저장소가 아니면 null.
const REPO_DATA = (() => {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: HERE, encoding: 'utf8', windowsHide: true });
  return r.status === 0 && r.stdout.trim() ? path.join(path.resolve(r.stdout.trim()), '.omc', 'progress-mon').toLowerCase() : null;
})();
const FORBIDDEN = [30000, 3456, 3458];
const ROOT = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'progress-mon-test-')));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

// 자식 환경: HOME 계열과 Claude, Codex 설정을 임시 폴더로. 시험 전용 변수와 git 상위 탐색 차단.
const HOME = path.join(ROOT, 'home');
const ENV = (() => {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(CLAUDE_|CODEX_|PROGRESS_MON_|PM_TEST_|GIT_)/i.test(k)) env[k] = v;
  Object.assign(env, {
    HOME,
    USERPROFILE: HOME,
    APPDATA: path.join(HOME, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(HOME, 'AppData', 'Local'),
    CLAUDE_CONFIG_DIR: path.join(HOME, '.claude'),
    CODEX_HOME: path.join(HOME, '.codex'),
    NO_COLOR: '1',
    GIT_CEILING_DIRECTORIES: ROOT,
  });
  return env;
})();

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

let n = 0;
// 임시 프로젝트. dirs 의 폴더를 만든다.
function project(...dirs) {
  const p = path.join(ROOT, `p${++n}`, 'app');
  fs.mkdirSync(p, { recursive: true });
  for (const d of dirs) fs.mkdirSync(path.join(p, d), { recursive: true });
  return p;
}
const dataOf = (p) => path.join(p, '.omc', 'progress-mon');

function cli(args, cwd) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env: ENV, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// 분리 실행 서버 정리. stop 이 실패하면 상태 파일의 PID 를 끝낸다.
function cleanup(p) {
  const sj = path.join(dataOf(p), 'server.json');
  let pid = null;
  try {
    pid = JSON.parse(fs.readFileSync(sj, 'utf8')).pid;
  } catch {
    pid = null;
  }
  cli(['stop'], p);
  if (Number.isInteger(pid) && pid > 1 && alive(pid)) process.kill(pid);
}

function get(port, { pathname = '/', host = `127.0.0.1:${port}`, addr = '127.0.0.1' } = {}) {
  if (FORBIDDEN.includes(port)) throw new Error(`금지 포트 ${port}`);
  return new Promise((resolve, reject) => {
    http
      .get({ host: addr, port, path: pathname, headers: { host }, agent: false }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      })
      .on('error', reject);
  });
}

function guardData(p) {
  if (REPO_DATA && dataOf(p).toLowerCase().startsWith(REPO_DATA)) throw new Error('이 저장소 운영 자료 폴더');
}

test('--help 는 하위 명령 10개를 보이고 serve 는 숨김, 종료 0', T, () => {
  const r = cli(['--help'], ROOT);
  assert.equal(r.code, 0);
  assert.equal(r.out, HELP);
  assert.equal(r.err, '');
  for (const c of ['init', 'start', 'stop', 'status', 'export', 'item', 'note', 'stage', 'story', 'check']) assert.match(r.out, new RegExp(`^  ${c} `, 'm'), c);
  assert.doesNotMatch(r.out, /serve/);
  assert.equal(cli([], ROOT).out, HELP, '인자 없음도 도움말');
});

test('junction(POSIX 는 symlink)을 거쳐 실행해도 CLI 가 돎', T, () => {
  const link = path.join(ROOT, `jn${++n}`);
  fs.symlinkSync(HERE, link, 'junction');
  try {
    const run = (...args) => spawnSync(process.execPath, [path.join(link, 'progress-mon.mjs'), ...args], { cwd: ROOT, env: ENV, encoding: 'utf8', windowsHide: true, timeout: 30000 });
    const r = run('--help');
    assert.equal(r.status, 0);
    assert.equal(r.stdout, HELP);
    const bad = run('bogus');
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /^오류: 모르는 명령: bogus/);
  } finally {
    // 링크만 지운다(대상 폴더는 그대로)
    fs.unlinkSync(link);
  }
  assert.ok(fs.existsSync(CLI));
});

test('모르는 명령과 인자는 종료 1', T, () => {
  const a = cli(['bogus'], ROOT);
  assert.equal(a.code, 1);
  assert.match(a.err, /^오류: 모르는 명령: bogus/);
  const b = cli(['status', '--nope'], ROOT);
  assert.equal(b.code, 1);
  assert.match(b.err, /모르는 인자: --nope/);
  assert.equal(cli(['start', '--port'], ROOT).code, 1);
  assert.equal(cli(['start', '--port', '80'], project('.omc/progress-mon')).code, 1);
  assert.throws(() => parseArgs(['--port-strict=1']), /값을 받지 않음/);
  assert.deepEqual(parseArgs(['start', '--port=5000', '--port-strict', '--host', '10.0.0.1']), { _: ['start'], port: '5000', 'port-strict': true, host: '10.0.0.1' });
});

test('자료 폴더 없으면 갱신 명령과 start 는 종료 1, 읽기 명령은 폴더를 만들지 않음', T, () => {
  const p = project();
  for (const args of [['start'], ['item', '--key', 'k', '--status', 'doing', '--text', 't'], ['note', '--key', 'k', '--note', 'x'], ['stage', '--id', 'plan', '--status', 'started'], ['story', '--id', 'A1', '--status', 'doing']]) {
    const r = cli(args, p);
    assert.equal(r.code, 1, args[0]);
    assert.equal(r.err, '오류: 자료 폴더 없음(.omc/progress-mon/). init 먼저 실행\n', args[0]);
  }
  const s = cli(['status'], p);
  assert.equal(s.code, 3);
  assert.equal(s.out, '꺼짐(자료 폴더 없음: .omc/progress-mon/)\n');
  assert.equal(cli(['stop'], p).code, 0);
  assert.equal(fs.existsSync(path.join(p, '.omc')), false);
  assert.equal(fs.existsSync(path.join(p, '.omx')), false);
});

test('런타임 판별: .omx 만이면 codex, 둘 다면 경고', T, () => {
  const a = project('.omx/progress-mon');
  assert.equal(cli(['status'], a).out, '꺼짐(자료 폴더: .omx/progress-mon/)\n');
  const b = project('.omc/progress-mon', '.omx/progress-mon');
  const r = cli(['status'], b);
  assert.equal(r.out, '꺼짐(자료 폴더: .omc/progress-mon/)\n');
  assert.match(r.err, /^경고: .*모두 있음/);
  const c = project();
  const d = path.join(ROOT, `data${++n}`);
  fs.mkdirSync(d);
  assert.equal(cli(['status', '--data', d], c).code, 3);
  assert.ok(fs.existsSync(path.join(d, 'state.json')));
});

test('자료 폴더가 있으면 state.json 의 skillDir 과 runtime 을 맞춤', T, () => {
  const p = project('.omx/progress-mon');
  const file = path.join(p, '.omx', 'progress-mon', 'state.json');
  fs.writeFileSync(file, JSON.stringify({ skillDir: '/old', runtime: 'claude', memory: { kind: 'agents-md', path: 'AGENTS.md' } }));
  cli(['status'], p);
  const st = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(fs.realpathSync.native(st.skillDir), fs.realpathSync.native(path.resolve(HERE, '..')));
  assert.equal(st.runtime, 'codex');
  assert.deepEqual(st.memory, { kind: 'agents-md', path: 'AGENTS.md' });
  assert.match(st.updatedAt, /Z$/);
  const before = fs.statSync(file).mtimeMs;
  cli(['status'], p);
  assert.equal(fs.statSync(file).mtimeMs, before, '값이 같으면 쓰지 않음');
});

test('--host 0.0.0.0, 공인 IP, 이름은 거부', T, () => {
  const p = project('.omc/progress-mon');
  for (const h of ['0.0.0.0', '8.8.8.8', '::', 'localhost', '169.254.1.1', '100.64.0.1']) {
    const r = cli(['start', '--port', '40000', '--host', h], p);
    assert.equal(r.code, 1, h);
    assert.equal(r.err, `오류: --host ${h} 거부. 사설 IPv4(10/8, 172.16/12, 192.168/16)만 받음\n`);
  }
  assert.equal(fs.existsSync(path.join(dataOf(p), 'server.json')), false);
});

test('start, 재사용, status, stop 수명 주기와 HTTP 응답', T, async () => {
  const p = project('.omc/progress-mon');
  guardData(p);
  const port = await freePort();
  try {
    const a = cli(['start', '--port', String(port)], p);
    assert.equal(a.err, '');
    assert.equal(a.out, `시작함: http://127.0.0.1:${port}/\n`);
    assert.equal(a.code, 0);
    const st = JSON.parse(fs.readFileSync(path.join(dataOf(p), 'server.json'), 'utf8'));
    assert.ok(alive(st.pid));
    assert.notEqual(st.pid, process.pid);

    const b = cli(['start', '--port', String(port)], p);
    assert.equal(b.out, `이미 실행 중(재사용): http://127.0.0.1:${port}/\n`);
    assert.equal(b.code, 0);

    // 재사용 우선순위: --host 다름, strict 와 다른 포트
    const c = cli(['start', '--port', String(port), '--host', '10.0.0.77'], p);
    assert.equal(c.code, 1);
    assert.match(c.err, /stop 먼저/);
    const d = cli(['start', '--port', String(port + 1), '--port-strict'], p);
    assert.equal(d.code, 1);
    assert.match(d.err, /stop 먼저/);

    assert.equal((await get(port, { host: `evil.example:${port}` })).status, 403);
    assert.equal((await get(port, { pathname: '/server.json' })).status, 404);
    const id = await get(port, { pathname: '/__progress-mon/id' });
    assert.equal(JSON.parse(id.body).pid, st.pid);

    const s = cli(['status'], p);
    assert.equal(s.code, 0);
    const lines = s.out.split('\n');
    assert.equal(lines[0], `실행 중: http://127.0.0.1:${port}/ (PID ${st.pid})`);
    assert.equal(lines[1], '주소: 127.0.0.1');
    assert.equal(lines[2], '자료 폴더: .omc/progress-mon/');
    assert.equal(lines[3], '탭 자료: 진척도 없음, 구현요건 없음, workflow 없음, 구성도 없음');
    assert.match(lines[4], /^시작: \d{4}-\d\d-\d\dT.*Z$/);
    assert.match(lines[5], /^요청: 1, 마지막 요청: .*Z, 마지막 오류: 없음$/, '403 은 세지 않음');

    const e = cli(['stop'], p);
    assert.equal(e.out, `정지함: http://127.0.0.1:${port}/ (PID ${st.pid}). 상태 파일 삭제\n`);
    assert.equal(e.code, 0);
    assert.equal(fs.existsSync(path.join(dataOf(p), 'server.json')), false);
    await assert.rejects(get(port), /ECONNREFUSED/);
    assert.equal(cli(['status'], p).code, 3);
  } finally {
    cleanup(p);
  }
});

test('실행 중 서버는 config.json 변경을 다음 응답에 반영, 형식 오류는 안내 화면, 다시 띄워야 하는 값은 status 경고', T, async () => {
  const p = project('.omc/progress-mon');
  guardData(p);
  const port = await freePort();
  const cfg = path.join(dataOf(p), 'config.json');
  try {
    assert.equal(cli(['start', '--port', String(port)], p).code, 0);
    assert.doesNotMatch((await get(port)).body, /스토리 0\/2/);
    fs.writeFileSync(cfg, JSON.stringify({ title: '바꾼 제목', stories: [{ id: 'S1', name: '하나' }, { id: 'S2', name: '둘' }] }));
    const after = (await get(port)).body;
    assert.match(after, /<h1>바꾼 제목<\/h1>/);
    assert.match(after, /스토리 0\/2 완료/);
    fs.writeFileSync(cfg, JSON.stringify({ title: '' }));
    const bad = await get(port);
    assert.equal(bad.status, 200);
    assert.match(bad.body, /config\.json 형식 오류/);
    assert.match(bad.body, /\$\.title/);
    fs.writeFileSync(cfg, JSON.stringify({ title: '다시', port: port + 7 }));
    assert.match((await get(port)).body, /<h1>다시<\/h1>/);
    const s = cli(['status'], p);
    assert.equal(s.code, 0);
    assert.match(s.err, /경고: 서버를 띄운 뒤 config\.json 의 port 가 바뀜\. 적용하려면 stop 뒤 start/);
    fs.writeFileSync(path.join(dataOf(p), 'req-spec.json'), '{');
    assert.match(cli(['status'], p).out, /^탭 자료: 진척도 없음, 구현요건 깨짐, workflow 없음, 구성도 없음$/m, '깨진 JSON 은 있음이 아니라 깨짐');
  } finally {
    cleanup(p);
  }
});

function cliAsync(args, cwd) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [CLI, ...args], { cwd, env: ENV, windowsHide: true });
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (err += d));
    c.on('close', (code) => resolve({ code, out, err }));
  });
}

test('동시에 부른 start 는 서버 하나를 띄우고 모두 같은 URL, 거짓 실패와 끌 수 없는 서버 없음(5회)', { timeout: 300000 }, async () => {
  for (let round = 0; round < 5; round++) {
    const p = project('.omc/progress-mon');
    guardData(p);
    const port = await freePort();
    try {
      const rs = await Promise.all([0, 1, 2, 3].map(() => cliAsync(['start', '--port', String(port)], p)));
      const url = `http://127.0.0.1:${port}/`;
      assert.deepEqual(rs.map((r) => r.code), [0, 0, 0, 0], JSON.stringify(rs));
      assert.equal(rs.filter((r) => r.out === `시작함: ${url}\n`).length, 1, JSON.stringify(rs));
      assert.equal(rs.filter((r) => r.out === `이미 실행 중(재사용): ${url}\n`).length, 3, JSON.stringify(rs));
      assert.equal(fs.existsSync(path.join(dataOf(p), 'server.json.lock')), false, '잠금은 돌려줌');
      assert.equal(cli(['stop'], p).code, 0);
      for (let q = port; q <= port + 4; q++) await assert.rejects(get(q), /ECONNREFUSED/, `포트 ${q} 에 남은 서버 없음`);
    } finally {
      cleanup(p);
    }
  }
});

test('start 잠금: 죽은 프로세스의 잠금과 링크 잠금은 넘겨받고, 살아 있는 잠금은 기다림', T, async () => {
  const p = project('.omc/progress-mon');
  guardData(p);
  const lock = path.join(dataOf(p), 'server.json.lock');
  const port = await freePort();
  try {
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    fs.writeFileSync(lock, `${dead.stdout} 2026-10-30T00:00:00.000Z\n`);
    const a = cli(['start', '--port', String(port)], p);
    assert.equal(a.code, 0, a.err);
    assert.equal(fs.existsSync(lock), false);
    assert.equal(cli(['stop'], p).code, 0);
    if (process.platform !== 'win32') {
      const victim = path.join(ROOT, `victim${++n}`);
      fs.writeFileSync(victim, 'keep');
      fs.symlinkSync(victim, lock);
      assert.equal(cli(['start', '--port', String(port)], p).code, 0);
      assert.equal(fs.readFileSync(victim, 'utf8'), 'keep', '링크 대상은 그대로');
      assert.equal(cli(['stop'], p).code, 0);
    }
    fs.writeFileSync(lock, `${process.pid} 2026-10-30T00:00:00.000Z\n`);
    const t0 = Date.now();
    const b = cliAsync(['start', '--port', String(port)], p);
    await new Promise((r) => setTimeout(r, 1500));
    fs.rmSync(lock);
    const rb = await b;
    assert.equal(rb.code, 0, rb.err);
    assert.ok(Date.now() - t0 >= 1500, '살아 있는 잠금이 풀릴 때까지 기다림');
  } finally {
    cleanup(p);
  }
});

// 렌더가 4초 걸리는 serve(같은 모듈, 렌더만 바꿈)를 따로 띄운다. 렌더는 동기라 그동안 신원 요청이 줄을 선다.
// 렌더를 시작하면 marker 파일을 쓴다. 돌려줌: { child, busy() }. busy() 는 느린 요청을 보내고 렌더가 시작될 때까지 기다린다.
async function slowServe(p, port) {
  const helper = path.join(ROOT, `slow-serve${++n}.mjs`);
  const marker = `${helper}.rendering`;
  const url = (f) => JSON.stringify(new URL(f, `file://${HERE.replaceAll('\\', '/').replace(/^(?=[A-Za-z]:)/, '/')}/`).href);
  fs.writeFileSync(helper, [
    `import fs from 'node:fs';`,
    `import { serve } from ${url('pm-server.mjs')};`,
    `import { defaults } from ${url('pm-config.mjs')};`,
    `const [project, port, marker] = process.argv.slice(2);`,
    `const ctx = { project, runtime: 'claude', dataDir: project + '/.omc/progress-mon', exists: true, warn: null };`,
    `const render = () => { fs.writeFileSync(marker, '1'); const end = Date.now() + 4000; while (Date.now() < end); return 'slow'; };`,
    `await serve(ctx, defaults(project), { port: Number(port) }, { out: () => {}, err: () => {} }, { render });`,
  ].join('\n'));
  const child = spawn(process.execPath, [helper, p, String(port), marker], { env: ENV, stdio: 'ignore', windowsHide: true });
  for (let i = 0; i < 200 && !fs.existsSync(path.join(dataOf(p), 'server.json')); i++) await new Promise((r) => setTimeout(r, 50));
  const busy = async () => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', headers: { host: `127.0.0.1:${port}` }, agent: false });
    req.on('error', () => {});
    for (let i = 0; i < 200 && !fs.existsSync(marker); i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(fs.existsSync(marker), '느린 렌더가 시작됨(그래서 신원 응답이 늦음)');
    return req;
  };
  return { child, busy };
}

test('떠 있는 서버의 렌더가 느려 신원 응답이 늦어도 start 는 재사용(거짓 실패와 둘째 서버 없음)', T, async () => {
  const p = project('.omc/progress-mon');
  guardData(p);
  const port = await freePort();
  const { child, busy } = await slowServe(p, port);
  try {
    const req = await busy();
    const a = await cliAsync(['start', '--port', String(port)], p);
    assert.equal(a.code, 0, a.err);
    assert.equal(a.out, `이미 실행 중(재사용): http://127.0.0.1:${port}/\n`);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataOf(p), 'server.json'), 'utf8')).pid, child.pid, '상태 파일은 처음 서버');
    await assert.rejects(get(port + 1), /ECONNREFUSED/, '옆 포트에 둘째 서버 없음');
    req.destroy();
  } finally {
    child.kill();
    cleanup(p);
  }
});

test('렌더가 느린 동안 부른 stop 도 그 서버를 끔(PID 대조는 그대로)', T, async () => {
  const p = project('.omc/progress-mon');
  guardData(p);
  const port = await freePort();
  const { child, busy } = await slowServe(p, port);
  try {
    const req = await busy();
    const r = await cliAsync(['stop'], p);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, `정지함: http://127.0.0.1:${port}/ (PID ${child.pid}). 상태 파일 삭제\n`);
    await assert.rejects(get(port), /ECONNREFUSED/);
    req.destroy();
  } finally {
    child.kill();
    cleanup(p);
  }
});

test('떠 있는 서버 옆에서 serve 를 띄우면 바인드 전에 닫고 종료 1, 처음 서버는 그대로', T, async () => {
  const p = project('.omc/progress-mon');
  guardData(p);
  const port = await freePort();
  try {
    assert.equal(cli(['start', '--port', String(port)], p).code, 0);
    const first = JSON.parse(fs.readFileSync(path.join(dataOf(p), 'server.json'), 'utf8')).pid;
    const r = cli(['serve', '--port', String(port)], p);
    assert.equal(r.code, 1);
    assert.match(r.err, new RegExp(`이미 실행 중인 서버가 있음: http://127\\.0\\.0\\.1:${port}/ \\(PID ${first}\\)\\. 이 서버는 닫음`));
    assert.equal(r.out, '', '옆 포트 알림 없이 바로 닫음');
    assert.ok(alive(first));
    assert.match(cli(['status'], p).out, new RegExp(`^실행 중: http://127\\.0\\.0\\.1:${port}/ \\(PID ${first}\\)$`, 'm'));
    await assert.rejects(get(port + 1), /ECONNREFUSED/);
  } finally {
    cleanup(p);
  }
});

test('포트 점유면 다음 포트와 알림, strict 면 거부', T, async () => {
  const p = project('.omc/progress-mon');
  const holder = http.createServer((q, s) => (s.writeHead(404), s.end()));
  let port = 0;
  for (let i = 0; i < 20 && !port; i++) {
    const cand = await freePort();
    const ok = await new Promise((r) => {
      holder.once('error', () => r(false));
      holder.listen(cand, '127.0.0.1', () => r(true));
    });
    if (ok) port = cand;
  }
  try {
    const a = cli(['start', '--port', String(port)], p);
    assert.equal(a.code, 0, a.err);
    const got = JSON.parse(fs.readFileSync(path.join(dataOf(p), 'server.json'), 'utf8')).port;
    assert.ok(got > port);
    assert.equal(a.out, `알림: 포트 ${port} 사용 중이라 ${got} 사용\n시작함: http://127.0.0.1:${got}/\n`);
    assert.equal(cli(['stop'], p).code, 0);
    const b = cli(['start', '--port', String(port), '--port-strict'], p);
    assert.equal(b.code, 1);
    assert.equal(b.out, '');
    assert.equal(b.err, `오류: 포트 ${port} 사용 중(--port-strict). 다른 포트를 고르지 않음\n`);
    assert.match(fs.readFileSync(path.join(dataOf(p), 'server.log'), 'utf8'), /오류: 포트 \d+ 사용 중/);
  } finally {
    cleanup(p);
    await new Promise((r) => holder.close(r));
  }
});

test('stop: 상태 파일 pid 가 다른 살아 있는 프로세스면 거부, 두 프로세스 그대로', T, async () => {
  const p = project('.omc/progress-mon');
  const port = await freePort();
  const sleeper = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'ignore', windowsHide: true });
  const sj = path.join(dataOf(p), 'server.json');
  let pid0 = null;
  try {
    assert.equal(cli(['start', '--port', String(port)], p).code, 0);
    const st = JSON.parse(fs.readFileSync(sj, 'utf8'));
    pid0 = st.pid;
    fs.writeFileSync(sj, JSON.stringify({ ...st, pid: sleeper.pid }));
    const r = cli(['stop'], p);
    assert.equal(r.code, 1);
    assert.equal(r.err, `오류: 포트 ${port} 의 서버 PID ${pid0} 가 상태 파일 PID ${sleeper.pid} 와 다름. 상태 파일 그대로 둠\n`);
    assert.ok(alive(pid0) && alive(sleeper.pid));
    assert.equal(JSON.parse(fs.readFileSync(sj, 'utf8')).pid, sleeper.pid);
    fs.writeFileSync(sj, JSON.stringify(st));
  } finally {
    cleanup(p);
    if (pid0 && alive(pid0)) process.kill(pid0);
    sleeper.kill();
  }
});

test('serve 앞 실행: 신원 경로와 Host 검사', T, async () => {
  const p = project('.omc/progress-mon');
  const port = await freePort();
  const child = spawn(process.execPath, [CLI, 'serve', '--port', String(port), '--port-strict'], { cwd: p, env: ENV, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c) => (out += c));
  try {
    for (let i = 0; i < 100 && !out.includes('시작함'); i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(out, `시작함: http://127.0.0.1:${port}/\n`);
    const id = JSON.parse((await get(port, { pathname: '/__progress-mon/id', host: `localhost:${port}` })).body);
    assert.equal(id.pid, child.pid);
    assert.equal((await get(port, { host: `[::1]:${port}` })).status !== 403, true);
    assert.equal((await get(port, { host: `127.0.0.1:${port + 1}` })).status, 403);
  } finally {
    child.kill();
    await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
  }
});

test('사설 IP 바인드(PM_TEST_PRIVATE_IP)', T, async (t) => {
  const ip = process.env.PM_TEST_PRIVATE_IP;
  if (!ip) {
    t.diagnostic('PM_TEST_PRIVATE_IP 없음. 사설 바인드 미검증');
    return;
  }
  const p = project('.omc/progress-mon');
  const port = await freePort();
  try {
    const r = cli(['start', '--port', String(port), '--host', ip], p);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, new RegExp(`경고: ${ip.replace(/\./g, '\\.')} 에 바인드`));
    assert.match(r.out, new RegExp(`추가 주소: http://${ip.replace(/\./g, '\\.')}:${port}/`));
    const id = await get(port, { pathname: '/__progress-mon/id', host: `${ip}:${port}`, addr: ip });
    assert.equal(id.status, 200);
    assert.deepEqual(JSON.parse(id.body), { app: 'progress-mon' });
    assert.equal((await get(port, { host: `evil.example:${port}`, addr: ip })).status, 403);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataOf(p), 'config.json'), 'utf8')).hosts, [ip]);
  } finally {
    cleanup(p);
  }
});

// AC-4: 내장 모듈과 상대 경로만 import. Node 18 에 없는 API 0(계획 9.1.1). 이 파일도 검사하므로 목록은 조각으로 만든다.
test('AC-4: import 는 node: 와 상대 경로만, Node 18 금지 목록 0', T, () => {
  const j = (...a) => a.join('');
  const words = [
    j('import.meta.', 'dirname'),
    j('import.meta.', 'filename'),
    j('process.', 'getBuiltinModule'),
    j('node:', 'sqlite'),
    j('fs.', 'glob'),
    j('promises.', 'glob'),
    j('process.', 'loadEnvFile'),
    j('style', 'Text'),
    j('URL.', 'canParse'),
    j('navi', 'gator'),
    j('mock.', 'timers'),
    j('Object.', 'groupBy'),
    j('Map.', 'groupBy'),
    j('Promise.', 'withResolvers'),
    j('Array.', 'fromAsync'),
    j('.to', 'Sorted('),
    j('.to', 'Reversed('),
    j('.to', 'Spliced('),
    j('.wi', 'th('),
    j('.isWell', 'Formed('),
    j('.uni', 'on('),
    j('.inter', 'section('),
    j('.diff', 'erence('),
    j('.symmetric', 'Difference('),
    j('.isSub', 'setOf('),
    j('.isSuper', 'setOf('),
    j('.isDis', 'jointFrom('),
  ];
  const patterns = [
    new RegExp(j('readdirSync\\([^)]*', 'recursive')),
    new RegExp(j('(?:with|assert)\\s*\\{\\s*', 'type\\s*:')),
    new RegExp(j("new RegExp\\([^)]*,\\s*['\"][a-z]*", "v[a-z]*['\"]")),
    new RegExp(j('[=(,:]\\s*\\/(?:\\\\.|[^/\\n\\\\])+\\/[dgimsuy]*', 'v[dgimsuy]*\\b')),
  ];
  const files = fs.readdirSync(HERE).filter((f) => /\.(mjs|js)$/.test(f));
  assert.ok(files.length >= 9);
  for (const f of files) {
    const src = fs.readFileSync(path.join(HERE, f), 'utf8');
    for (const m of src.matchAll(/(?:^|\n)\s*import\s[^'"]*?from\s+['"]([^'"]+)['"]|\bimport\(\s*[`'"]([^`'"]+)/g)) {
      const spec = m[1] || m[2];
      assert.ok(spec.startsWith('node:') || spec.startsWith('./'), `${f}: ${spec}`);
    }
    for (const m of src.matchAll(/\brequire\(\s*['"]([^'"]+)['"]/g)) assert.ok(m[1].startsWith('node:'), `${f}: ${m[1]}`);
    for (const w of words) assert.ok(!src.includes(w), `${f}: ${w}`);
    // readdirSync 의 recursive 옵션과 정규식 v 플래그는 꼴로 찾는다
    for (const re of patterns) assert.ok(!re.test(src), `${f}: ${re}`);
  }
});
