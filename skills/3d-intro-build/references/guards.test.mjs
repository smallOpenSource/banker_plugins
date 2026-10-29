// 0.20.5 guards of the shared 3d-intro modules: HEAD requests, state files that name another machine, review files a
// project ships as links, the take hash cache, key files with CR line ends, poll floors, Sora's 429 without
// Retry-After, a WAN 401 without a code, and a project key file the repository tracks. Mocks and loopback only.
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import cp from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import * as A from './azure-adapter.mjs';
import * as P from './video-pool.mjs';
import { hashFile, readDecisions, readInput, recordDecision, renderPage, startCurate } from './curate.mjs';
import { isRunning, stopServer } from './preview-lib.mjs';
import { startServe } from './serve.mjs';
import { symlinkSkip } from '../../../scripts/test-fixtures/can-symlink.mjs';

const made = [];
process.on('exit', () => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (p = 'r4-') => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); made.push(d); return d; };
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const openFds = () => fs.readdirSync(process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd').length;
function project() {
  const dir = tmp('r4-curate-');
  fs.mkdirSync(path.join(dir, 'stills'));
  fs.writeFileSync(path.join(dir, 'stills', 's1.png'), 'png s1');
  fs.writeFileSync(path.join(dir, 'curate-input.json'), JSON.stringify({ stage: 'stills', scenes: [{ id: 's1', takes: [{ file: 'stills/s1.png' }] }] }));
  return dir;
}
// The header block of one raw request on a kept-alive connection, or null when none comes in 3 s.
const headOf = (port, p, extra = '') => new Promise((resolve) => {
  let wire = '';
  const sock = net.connect({ host: '127.0.0.1', port }, () => sock.write(`HEAD ${p} HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: keep-alive\r\n${extra}\r\n`));
  const timer = setTimeout(() => { sock.destroy(); resolve(null); }, 3000);
  sock.on('data', (c) => { wire += c; if (wire.includes('\r\n\r\n')) { clearTimeout(timer); sock.destroy(); resolve(wire.slice(0, wire.indexOf('\r\n\r\n'))); } });
  sock.on('error', () => {});
  sock.on('close', () => { clearTimeout(timer); resolve(wire.includes('\r\n\r\n') ? wire.slice(0, wire.indexOf('\r\n\r\n')) : null); });
});

// B4-8
test('a HEAD request gets its headers without the file being read, also for a file shorter than its declared length', { skip: process.platform === 'win32' && 'counts open files under /proc or /dev/fd' }, async (t) => {
  const dir = path.join(tmp('r4-site-'), 'site');
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'assets', 'a.mp4'), Buffer.alloc(1000, 7));
  const s = await startServe(dir, {});
  t.after(() => s.close());
  const { fstatSync, createReadStream } = fs;
  t.after(() => Object.assign(fs, { fstatSync, createReadStream }));
  fs.fstatSync = (fd, ...rest) => { const st = fstatSync(fd, ...rest); return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { size: st.size + (typeof st.size === 'bigint' ? 500n : 500) }); };
  const reads = [];
  fs.createReadStream = (...a) => { reads.push(a[0]); return createReadStream(...a); };
  const before = openFds();
  const whole = await headOf(s.port, '/assets/a.mp4');
  const part = await headOf(s.port, '/assets/a.mp4', 'Range: bytes=0-99\r\n');
  assert.match(String(whole), /^HTTP\/1\.1 200[\s\S]*content-length: 1500/i, 'the headers of the length it was declared at');
  assert.match(String(part), /^HTTP\/1\.1 206[\s\S]*content-length: 100/i);
  assert.deepEqual(reads, [], 'HEAD reads no file');
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(openFds() - before <= 1, 'the files HEAD opened are closed');
});

// B4-12
test('a state file naming a host other than this machine is left alone: nothing is asked there, nothing is signalled', async (t) => {
  const asked = []; const killed = [];
  const { get } = http; const { connect } = net; const { kill } = process;
  t.after(() => { http.get = get; net.connect = connect; process.kill = kill; });
  http.get = (o, cb) => { asked.push(o.host); const req = new EventEmitter(); req.destroy = () => {}; const res = new EventEmitter(); process.nextTick(() => { cb(res); res.emit('data', '{"pid":4242}'); res.emit('end'); }); return req; };
  net.connect = (o) => { asked.push(o.host); const s = new EventEmitter(); s.destroy = () => {}; process.nextTick(() => s.emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }))); return s; };
  process.kill = (pid, sig) => { killed.push([pid, sig]); };
  // 0.20.5 review: a DNS name that starts like a loopback address is a name, resolved anywhere
  for (const host of ['192.0.2.10', '127.evil.test', '127.0.0.1.evil.test', '127.0.0.1x']) {
    const file = path.join(tmp('r4-state-'), 'curate.server.json');
    fs.writeFileSync(file, JSON.stringify({ pid: 4242, port: 8080, host }));
    assert.equal(await isRunning(file), false, host);
    assert.deepEqual(await stopServer(file, { timeoutMs: 300 }), { stopped: false, reason: 'invalid-state' }, host);
    assert.deepEqual([asked, killed], [[], []], host);
    assert.ok(fs.existsSync(file), 'left for a person to look at');
  }
});

// N1 (new): review files a repository ships as links
test('a link a project ships at a review file name is never written through', { skip: symlinkSkip }, async () => {
  const dir = project();
  const victim = path.join(tmp('r4-victim-'), 'bashrc');
  fs.writeFileSync(victim, 'untouched');
  fs.symlinkSync(victim, path.join(dir, 'decisions.json.tmp'));
  fs.symlinkSync(victim, path.join(dir, 'curate.server.json'));
  recordDecision(dir, { scene: 's1', verdict: 'approve', take: '1' });
  const s = await startCurate(dir, {});
  await s.close();
  assert.equal(fs.readFileSync(victim, 'utf8'), 'untouched');
  assert.ok(fs.lstatSync(path.join(dir, 'decisions.json')).isFile(), 'decisions.json is a file of its own');
  // the temp name is drawn at random, and a link already at the drawn name is refused, not followed
  const { randomBytes } = crypto;
  crypto.randomBytes = (n) => Buffer.alloc(n);
  try {
    fs.symlinkSync(victim, path.join(dir, `decisions.json.${'00'.repeat(8)}.tmp`));
    assert.throws(() => recordDecision(dir, { scene: 's1', verdict: 'pending' }), { code: 'EEXIST' });
  } finally { crypto.randomBytes = randomBytes; }
  assert.equal(fs.readFileSync(victim, 'utf8'), 'untouched');
});

// 정리-19 (and the racy case found with it)
function wrapStat(t, file, fields) {
  const real = fs.promises.open;
  fs.promises.open = async (...a) => {
    const fh = await real(...a);
    if (a[0] !== file) return fh;
    const stat = fh.stat.bind(fh);
    fh.stat = async (o) => {
      const st = await stat(o);
      const f = fields();
      const v = o?.bigint ? { ino: f.ino, mtimeMs: f.ms, ctimeMs: f.ms, mtimeNs: f.ms * 1_000_000n, ctimeNs: f.ms * 1_000_000n }
        : { ino: Number(f.ino), mtimeMs: Number(f.ms), ctimeMs: Number(f.ms) };
      return Object.assign(Object.create(Object.getPrototypeOf(st)), st, v);
    };
    return fh;
  };
  t.after(() => { fs.promises.open = real; });
}
test('a take replaced by one whose 64-bit file id reads as the same Number is hashed anew', async (t) => {
  const p = path.join(tmp('r4-hash-'), 'take.mp4');
  let id = 2n ** 60n + 1n;
  const old = BigInt(Date.now() - 60_000);
  wrapStat(t, p, () => ({ ino: id, ms: old }));
  fs.writeFileSync(p, 'aaaa');
  await hashFile(p);
  fs.rmSync(p); fs.writeFileSync(p, 'bbbb'); id = 2n ** 60n + 2n;
  assert.equal(await hashFile(p), sha(p));
});
test('a take rewritten in place with the same size in the same timestamp step is hashed anew', async (t) => {
  const p = path.join(tmp('r4-hash-'), 'take.mp4');
  const now = BigInt(Date.now());
  wrapStat(t, p, () => ({ ino: 77n, ms: now }));
  fs.writeFileSync(p, 'cccc');
  await hashFile(p);
  fs.writeFileSync(p, 'dddd');
  assert.equal(await hashFile(p), sha(p));
});

// B4-11
test('a take whose read stalls does not hold the page; the next view shows its hash', async (t) => {
  const dir = project();
  const big = path.join(dir, 'stills', 's1.png');
  const real = fs.promises.open;
  let release;
  const gate = new Promise((r) => { release = r; });
  fs.promises.open = async (...a) => {
    const fh = await real(...a);
    if (a[0] !== big) return fh;
    const stream = fh.createReadStream.bind(fh);
    fh.createReadStream = (o) => { const s = stream(o); s.pause(); gate.then(() => s.resume()); return s; };
    return fh;
  };
  t.after(() => { fs.promises.open = real; release(); });
  const page = renderPage(readInput(dir), readDecisions(dir), { dir, hashWaitMs: 300 });
  const first = await Promise.race([page, new Promise((r) => setTimeout(() => r(null), 3000))]);
  assert.ok(first, 'the page came back within 3 s');
  assert.match(first, /읽는 중/);
  release();
  fs.promises.open = real;
  assert.ok((await renderPage(readInput(dir), readDecisions(dir), { dir })).includes(sha(big)));
});

// 정리-7
test('a key file whose lines end in CR alone is read line by line; a write keeps its other keys and its line ends', () => {
  const fake = ['place', 'holder'].join('');
  const text = `AZURE_SORA_ENDPOINT=https://sora.example.com\rAZURE_SORA_API_KEY=${fake}-1\rAZURE_SORA_DEPLOYMENT=sora-2\r`;
  assert.deepEqual(A.parseEnvFile(text), { AZURE_SORA_ENDPOINT: 'https://sora.example.com', AZURE_SORA_API_KEY: `${fake}-1`, AZURE_SORA_DEPLOYMENT: 'sora-2' });
  const target = path.join(tmp('r4-cr-'), 'env');
  fs.writeFileSync(target, text);
  A.persistCreds({ AZURE_SORA_ENDPOINT: 'https://sora2.example.com', AZURE_SORA_API_VERSION: 'preview' }, { target });
  assert.equal(fs.readFileSync(target, 'utf8'), `AZURE_SORA_ENDPOINT=https://sora2.example.com\rAZURE_SORA_API_KEY=${fake}-1\rAZURE_SORA_DEPLOYMENT=sora-2\rAZURE_SORA_API_VERSION=preview\r`);
  const mixed = `AZURE_IMAGE_API_KEY=${fake}-2\nAZURE_IMAGE_OPENAI_ENDPOINT=https://img.example.com\rAZURE_SORA_API_KEY=${fake}-3\n`;
  assert.equal(A.parseEnvFile(mixed).AZURE_IMAGE_OPENAI_ENDPOINT, 'https://img.example.com', 'no key is read into an endpoint');
});

// B4-10
test('the pool takes its request limits and error codes from the adapter instead of copies of its own', () => {
  const src = fs.readFileSync(new URL('./video-pool.mjs', import.meta.url), 'utf8');
  for (const name of ["errnoOf", "timeLeft", "API_TIMEOUT_MS", "DOWNLOAD_TIMEOUT_MS", "HELD_KEY"]) assert.ok(!new RegExp(`\\bconst ${name}\\s*=`).test(src), `video-pool.mjs has its own ${name}`);
  assert.deepEqual([A.API_TIMEOUT_MS, A.DOWNLOAD_TIMEOUT_MS, A.timeLeft(10.2, 0), A.timeLeft(0, 5), A.timeLeft(1e9, 0)], [120_000, 600_000, 11, 1, 120_000]);
  assert.deepEqual([A.errnoOf({ name: 'TimeoutError', code: 23 }), A.errnoOf({ cause: { code: 'ECONNRESET' } }), [...A.HELD_KEY]], ['TimeoutError', 'ECONNRESET', ['EINSECURE', 'EPROXYKEY']]);
});

// B4-07, 정리-9
test('polls with an interval of 0 and the real timer still rest at least 1 s between requests', { timeout: 20_000 }, async (t) => {
  const real = globalThis.fetch;
  t.after(() => { globalThis.fetch = real; });
  const calls = { wan: 0, sora: 0 };
  globalThis.fetch = async (url) => (String(url).includes('/api/v1/tasks/')
    ? (calls.wan++, json(200, { output: { task_id: 't', task_status: 'RUNNING' } }))
    : (calls.sora++, json(200, { id: 'j', status: 'in_progress' })));
  const entry = P.loadWanPool({ WAN_1_ENDPOINT: 'https://ws.example.com', WAN_1_API_KEY: 'placeholder' })[0];
  const t0 = Date.now();
  const [w] = await Promise.all([
    P.wanPollTask({ entry, taskId: 't', intervalMs: 0, timeoutMs: 2500 }),
    A.pollVideo({ endpoint: 'https://sora.example.com', key: 'placeholder', id: 'j', intervalMs: 0, maxTicks: 1_000_000, timeoutMs: 2500 }),
  ]);
  assert.equal(w.state, 'TIMEOUT');
  assert.ok(calls.wan <= 4 && calls.sora <= 4, `polls: ${JSON.stringify(calls)}`);
  assert.ok(Date.now() - t0 >= 1900, 'the waits happened');
});

// 정리-5
test('a Sora 429 without Retry-After stops as rate once its next doubled wait is past maxRateWaitMs', async (t) => {
  const real = globalThis.fetch;
  t.after(() => { globalThis.fetch = real; });
  let posts = 0;
  globalThis.fetch = async (url, o = {}) => { if (o.method === 'POST') posts++; return json(429, { error: { code: 'too_many_requests' } }); };
  const slept = [];
  const err = await P.generateClip({
    creds: { AZURE_SORA_ENDPOINT: 'https://sora.example.com', AZURE_SORA_API_KEY: 'placeholder' }, prompt: 'p', order: ['sora'],
    statePath: path.join(tmp('r4-sora-'), 'state.json'), sleep: async (ms) => { slept.push(ms); }, now: () => 0,
  }).then(() => null, (e) => e);
  assert.deepEqual([err?.kind, err?.status, posts, slept], ['rate', 429, 4, [30_000, 60_000, 120_000]]);
  assert.match(err.message, /next wait \(240 s\)[\s\S]*past maxRateWaitMs \(120000 ms\); no job was made/);
});

// B4-04
test('a WAN 401 without a code rests the key like a 403 and it comes back; InvalidApiKey still retires it', async (t) => {
  assert.deepEqual([P.classifyWanError({ status: 401 }), P.classifyWanError({ status: 401, code: 'InvalidApiKey' })], ['denied', 'unusable']);
  const real = globalThis.fetch;
  t.after(() => { globalThis.fetch = real; });
  const creds = { WAN_1_ENDPOINT: 'https://ws1.example.com', WAN_1_API_KEY: 'p1', WAN_2_ENDPOINT: 'https://ws2.example.com', WAN_2_API_KEY: 'p2' };
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith('https://ws1.')) return new Response('', { status: 401 });
    if (u.includes('video-synthesis')) return json(200, { output: { task_id: 't2', task_status: 'PENDING' } });
    if (u.includes('/api/v1/tasks/')) return json(200, { output: { task_id: 't2', task_status: 'SUCCEEDED', video_url: 'https://oss.example.com/t2.mp4' } });
    return new Response('mp4', { status: 200 });
  };
  const t0 = 1_000_000;
  const statePath = path.join(tmp('r4-401-'), 'state.json');
  const r = await P.generateClip({ creds, prompt: 'p', statePath, order: ['wan'], now: () => t0, sleep: async () => {} });
  const at = (h) => P.poolSummary({ creds, statePath, now: t0 + h * 3_600_000 })[0].status;
  assert.deepEqual([r.label, at(1), at(25)], ['WAN_2', 'exhausted', 'ok']);
});

// B4-02
const gitOk = !cp.spawnSync('git', ['--version']).error;
test('a project key file the repository tracks is never written, and resolveCreds says so', { skip: !gitOk && 'needs git' }, (t) => {
  const env = { GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL };
  const root = tmp('r4-git-');
  Object.assign(process.env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig') });
  t.after(() => { for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  const repo = path.join(root, 'repo');
  const git = (...a) => cp.spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { encoding: 'utf8' });
  fs.mkdirSync(repo);
  git('init', '-q');
  const target = path.join(repo, '.env.3d-intro.local');
  fs.writeFileSync(target, 'WAN_1_ENDPOINT=https://ws.example.com\n');
  git('add', '.env.3d-intro.local'); git('commit', '-qm', 'ships a key file');
  assert.throws(() => A.persistCreds({ AZURE_SORA_DEPLOYMENT: 'sora-2' }, { target }), /tracked by git/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'WAN_1_ENDPOINT=https://ws.example.com\n');
  assert.equal(A.resolveCreds({ projectDir: repo })._tracked, true);
  git('rm', '-q', '--cached', '.env.3d-intro.local');
  A.persistCreds({ AZURE_SORA_DEPLOYMENT: 'sora-2' }, { target });
  assert.match(fs.readFileSync(target, 'utf8'), /AZURE_SORA_DEPLOYMENT=sora-2/, 'an untracked one is written as before');
  // git runs from the home folder (Windows looks for a program in the folder it starts in first)
  const seen = [];
  const { spawnSync } = cp;
  cp.spawnSync = (cmd, args, o) => { seen.push({ cmd, args, cwd: o?.cwd }); return spawnSync(cmd, args, o); };
  try { A.resolveCreds({ projectDir: repo }); } finally { cp.spawnSync = spawnSync; }
  const g = seen.find((s) => s.cmd === 'git');
  assert.ok(g && g.cwd === os.homedir() && g.args[0] === '-C' && g.args.includes('core.fsmonitor=false'), JSON.stringify(seen));
});

// 범위 밖 1 (and the same guard in persistCreds)
test('a link at the temp name a write draws is refused (wx), not written through', { skip: symlinkSkip }, () => {
  const d = tmp('r4-wx-');
  const victim = path.join(d, 'victim.md');
  fs.writeFileSync(victim, 'untouched');
  const state = path.join(d, 'state.json');
  const keys = path.join(d, 'env');
  fs.writeFileSync(keys, 'A=1\n');
  fs.symlinkSync(victim, `${state}.${'00'.repeat(8)}.tmp`);
  fs.symlinkSync(victim, `${keys}.${'00'.repeat(8)}.tmp`);
  const { randomBytes } = crypto;
  crypto.randomBytes = (n) => Buffer.alloc(n);
  try {
    assert.throws(() => P.savePoolState({ version: 1, entries: {} }, state), { code: 'EEXIST' });
    assert.throws(() => A.persistCreds({ B: '2' }, { target: keys }), { code: 'EEXIST' });
  } finally { crypto.randomBytes = randomBytes; }
  assert.equal(fs.readFileSync(victim, 'utf8'), 'untouched');
  assert.equal(fs.readFileSync(keys, 'utf8'), 'A=1\n');
});

// The tone and seam sentences of both SKILL files name functions that exist (no promise without code).
test('SKILL: the tone and seam lines in build Step 4A and setup §2 name functions that the modules export', async () => {
  const C = await import('./clip-post.mjs');
  const D = await import('./dive-mode.mjs');
  const exported = new Set([...Object.keys(A), ...Object.keys(C), ...Object.keys(D)]);
  const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
  const build = read('../SKILL.md');
  const tone = build.split('\n').find((l) => l.startsWith('톤 정합은 생성된 클립 쪽에서 한다'));
  const seam = build.split('\n').find((l) => l.startsWith('이음매 디졸브는 엔진의 `crossfade`'));
  assert.ok(tone && seam, 'build Step 4A says where tone and seams are handled');
  assert.doesNotMatch(build, /톤 정합은 조립, 재생 계층에서 처리한다/);
  const setupLine = read('../../3d-intro-setup/SKILL.md').split('\n').find((l) => l.includes('`ffmpeg` 바이너리를 요구한다'));
  for (const line of [tone, seam, setupLine]) {
    const names = [...line.matchAll(/`([a-z][A-Za-z]+)[`(]/g)].map((m) => m[1]).filter((n) => /^[a-z]+[A-Z]/.test(n));
    assert.ok(names.length >= 1, line);
    for (const n of names) assert.ok(exported.has(n), `${n} is exported (${line.slice(0, 40)}...)`);
  }
  assert.doesNotMatch(setupLine, /colorMatch/);
});
