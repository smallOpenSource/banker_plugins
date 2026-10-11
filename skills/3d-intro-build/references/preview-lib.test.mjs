// Tests for preview-lib.mjs and serve.mjs: the local servers of the 3d-intro-build and
// motion-graphic-make skills. Run from the repo root:
//   node --test skills/3d-intro-build/references/preview-lib.test.mjs
import { strict as assert } from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  PID_ROUTE, STRICT_CSP, askHost, cspFrom, decodePath, hostAllowed, hostWarning, portMatches, readState, resolveInside, stopServer,
  urlFor,
} from './preview-lib.mjs';
import { startServe } from './serve.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const made = [];
process.on('exit', () => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-lib-')); made.push(d); return d; };
const portOpen = (port) => new Promise((resolve) => {
  const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(true); });
  s.on('error', () => resolve(false));
});
// A request sent as written: fetch() would fold `..` segments before they reach the server. A server
// that never answers is a result, not a hang.
const raw = (port, p, headers = {}) => new Promise((resolve, reject) => {
  const req = http.get({ host: '127.0.0.1', port, path: p, headers, timeout: 5000 }, (res) => { res.resume(); resolve(res.statusCode); });
  req.on('timeout', () => { req.destroy(); resolve('no answer in 5 s'); });
  req.on('error', reject);
});
const site = () => {
  const dir = path.join(tmp(), 'site');
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>t</title>');
  fs.writeFileSync(path.join(dir, 'assets', 'a.mp4'), Buffer.alloc(1000, 7));
  return dir;
};

test('a path stays inside the served folder, and a malformed one is refused', () => {
  const dir = path.resolve('/srv/site');
  assert.equal(resolveInside(dir, '/assets/a.mp4'), path.join(dir, 'assets', 'a.mp4'));
  assert.equal(resolveInside(dir, '/../secret.txt'), null);
  assert.equal(resolveInside(dir, '/assets/../../x'), null);
  assert.equal(decodePath('/a%20b.png?x=1'), '/a b.png');
  assert.equal(decodePath('/%E0%A4%A'), null, 'a broken escape is not a path');
});

test('a CSP comes from a preset, a policy text or nothing', () => {
  assert.equal(cspFrom('strict'), STRICT_CSP);
  assert.match(STRICT_CSP, /media-src 'self' blob:/);
  assert.doesNotMatch(STRICT_CSP, /unsafe-inline/);
  assert.equal(cspFrom("default-src 'self'"), "default-src 'self'");
  assert.equal(cspFrom(undefined), null);
});

test('only a host other than loopback carries a warning', () => {
  assert.equal(hostWarning('127.0.0.1'), null);
  assert.match(hostWarning('0.0.0.0'), /0\.0\.0\.0/);
});

test('a request is answered only for a Host that names this machine by address or as localhost', () => {
  for (const ok of ['localhost:8080', '127.0.0.1:9', '192.168.0.7:3000', '[::1]:9', 'localhost']) assert.equal(hostAllowed(ok), true, ok);
  for (const bad of ['evil.example:8080', 'localhost.evil.example', '', undefined]) assert.equal(hostAllowed(bad), false, String(bad));
  assert.equal(hostAllowed('devbox:8080', ['devbox']), true, 'the name the server was bound to');
  assert.equal(hostAllowed('devbox:8080'), false);
});

test('a running server answers a start asking no port, its port, or the port its own start asked for', () => {
  const st = { port: 5000, requestedPort: 8080 };
  assert.equal(portMatches(st, undefined), true);
  assert.equal(portMatches(st, Number.NaN), true, 'a --port that is not a number asks nothing');
  assert.equal(portMatches(st, 5000), true);
  assert.equal(portMatches(st, 8080), true, 'asked before, busy then, so the system gave 5000');
  assert.equal(portMatches(st, 8081), false);
  assert.equal(portMatches({ port: 5000 }, 8080), false, 'a record without requestedPort');
});

test('a stop asks the address the server was bound to, a wildcard at loopback; IPv6 sits in brackets', () => {
  assert.equal(askHost('0.0.0.0'), '127.0.0.1');
  assert.equal(askHost('::'), '::1');
  assert.equal(askHost('192.168.0.7'), '192.168.0.7');
  assert.equal(askHost(undefined), '127.0.0.1');
  assert.equal(urlFor('::1', 9000), 'http://[::1]:9000/');
  assert.equal(urlFor('192.168.0.7', 9000), 'http://192.168.0.7:9000/');
});

test('the server takes a port the system gives, records it with its PID, and answers who it is', async (t) => {
  const dir = site();
  const s = await startServe(dir, {});
  t.after(() => s.close());
  assert.ok(s.port > 0);
  const state = readState(s.stateFile);
  assert.equal(state.port, s.port);
  assert.equal(state.pid, process.pid);
  assert.equal(state.dir, dir);
  assert.equal(path.dirname(s.stateFile), path.dirname(dir), 'the state file sits beside the served folder, not in it');
  assert.equal(fs.existsSync(path.join(dir, 'port.txt')), false, 'nothing is written into the served folder');
  const who = await (await fetch(`http://127.0.0.1:${s.port}${PID_ROUTE}`)).json();
  assert.equal(who.pid, process.pid);
});

test('the server sends the CSP header, ranges for video, and refuses escapes', async (t) => {
  const dir = site();
  const s = await startServe(dir, { csp: 'strict' });
  t.after(() => s.close());
  const base = `http://127.0.0.1:${s.port}`;
  const page = await fetch(`${base}/`);
  assert.equal(page.headers.get('content-security-policy'), STRICT_CSP);
  const part = await fetch(`${base}/assets/a.mp4`, { headers: { Range: 'bytes=0-99' } });
  assert.equal(part.status, 206);
  assert.equal((await part.arrayBuffer()).byteLength, 100);
  assert.equal(await raw(s.port, '/../x'), 403);
  assert.equal(await raw(s.port, '/%2e%2e/%2e%2e/x'), 403);
  assert.equal(await raw(s.port, '/%E0%A4%A'), 400);
  assert.equal(await raw(s.port, '/missing.png'), 404);
  assert.equal(await raw(s.port, '/', { Host: 'evil.example' }), 403, 'a rebound DNS name is refused');
  assert.equal(await raw(s.port, '/', { Host: `localhost:${s.port}` }), 200);
});

test('a second start finds the recorded server running and only reports its address', async (t) => {
  const dir = site();
  const script = path.join(HERE, 'serve.mjs');
  const child = spawn(process.execPath, [script, dir], { stdio: 'ignore' });
  reap(t, child);
  const stateFile = path.join(path.dirname(dir), 'site.server.json');
  for (let i = 0; i < 100 && !fs.existsSync(stateFile); i++) await new Promise((r) => setTimeout(r, 50));
  const first = readState(stateFile);
  const again = spawn(process.execPath, [script, dir], { stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  again.stdout.on('data', (c) => { out += c; });
  const code = await new Promise((resolve) => again.on('exit', resolve));
  assert.equal(code, 0);
  assert.match(out, /already running/);
  assert.equal(readState(stateFile).pid, first.pid, 'the record still names the first server');
  const strict = spawn(process.execPath, [script, dir, '--csp', 'strict'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  strict.stderr.on('data', (c) => { err += c; });
  assert.equal(await new Promise((resolve) => strict.on('exit', resolve)), 1, 'other settings never pass for the running ones');
  assert.match(err, /different settings[\s\S]*--stop/);
  assert.equal(readState(stateFile).pid, first.pid);
  const exited = new Promise((resolve) => child.on('exit', resolve));
  assert.equal((await stopServer(stateFile, { timeoutMs: 5000 })).reason, 'stopped');
  await exited;
});

// Ends a spawned server even when an assertion fails first, so the test run never hangs on it.
const reap = (t, child) => t.after(() => { try { process.kill(child.pid); } catch { /* gone */ } });

// Runs serve.mjs to its exit: { code, out } with stdout and stderr together.
const runServe = (args) => new Promise((resolve) => {
  const c = spawn(process.execPath, [path.join(HERE, 'serve.mjs'), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  c.stdout.on('data', (d) => { out += d; });
  c.stderr.on('data', (d) => { out += d; });
  c.on('exit', (code) => resolve({ code, out }));
});

test('a start asking another port than the running server is refused; the port its start asked for is not', async (t) => {
  const dir = site();
  const busy = net.createServer().listen(0, '127.0.0.1');
  await new Promise((resolve) => busy.once('listening', resolve));
  t.after(() => busy.close());
  const asked = busy.address().port;
  const child = spawn(process.execPath, [path.join(HERE, 'serve.mjs'), dir, '--port', String(asked)], { stdio: 'ignore' });
  reap(t, child);
  const stateFile = path.join(path.dirname(dir), 'site.server.json');
  for (let i = 0; i < 100 && !fs.existsSync(stateFile); i++) await new Promise((r) => setTimeout(r, 50));
  const first = readState(stateFile);
  assert.notEqual(first.port, asked, 'the asked port was busy, so the system gave another');
  assert.equal(first.requestedPort, asked);
  for (const port of [asked, first.port]) {
    const r = await runServe([dir, '--port', String(port)]);
    assert.deepEqual([r.code, /already running/.test(r.out)], [0, true], `--port ${port}`);
  }
  const other = [1, 2, 3].map((k) => first.port + k).find((p) => p !== asked);
  const refused = await runServe([dir, '--port', String(other)]);
  assert.equal(refused.code, 1);
  assert.match(refused.out, new RegExp(`different settings[\\s\\S]*port: ${first.port}[\\s\\S]*--stop`));
  assert.equal(readState(stateFile).pid, first.pid, 'the record still names the first server');
  const exited = new Promise((resolve) => child.on('exit', resolve));
  assert.equal((await stopServer(stateFile, { timeoutMs: 5000 })).reason, 'stopped');
  await exited;
});

test('a file the server cannot read gets 403 and the server keeps serving; a folder is 404', { skip: (process.platform === 'win32' || process.getuid?.() === 0) && 'file modes do not stop this user' }, async (t) => {
  const dir = site();
  const clip = path.join(dir, 'assets', 'a.mp4');
  fs.chmodSync(clip, 0o000);
  t.after(() => fs.chmodSync(clip, 0o644));
  const s = await startServe(dir, {});
  t.after(() => s.close());
  assert.equal(await raw(s.port, '/assets/a.mp4'), 403);
  assert.equal(await raw(s.port, '/assets/a.mp4', { Range: 'bytes=0-9' }), 403);
  assert.equal(await raw(s.port, '/assets'), 404);
  assert.equal(await raw(s.port, '/'), 200, 'the server is still up');
});

test('a download the browser drops midway closes its file', { skip: process.platform === 'win32' && 'counts open files under /proc or /dev/fd' }, async (t) => {
  const dir = site();
  fs.writeFileSync(path.join(dir, 'assets', 'big.mp4'), Buffer.alloc(4 * 1024 * 1024, 7));
  const s = await startServe(dir, {});
  t.after(() => s.close());
  const open = () => fs.readdirSync(process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd').length;
  const drop = (headers) => new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: s.port, path: '/assets/big.mp4', headers }, (res) => {
      res.once('data', () => { req.destroy(); resolve(); });
    });
    req.on('error', () => resolve());
  });
  const before = open();
  for (let k = 0; k < 20; k++) await drop(k % 2 ? { Range: 'bytes=0-' } : {});
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(open() - before <= 2, `open files grew by ${open() - before} after 20 dropped downloads`);
});

// Replaces fs.fstatSync (which sendFile calls on the file it opened) for one test: `wrap` gets the
// real call.
function wrapFstat(t, wrap) {
  const real = fs.fstatSync;
  fs.fstatSync = (fd, ...rest) => wrap(() => real(fd, ...rest));
  t.after(() => { fs.fstatSync = real; });
}

test('a file whose status cannot be read once it is open gets 403, and the server keeps serving', async (t) => {
  const dir = site();
  const s = await startServe(dir, {});
  t.after(() => s.close());
  let fail = true;
  wrapFstat(t, (stat) => {
    if (!fail) return stat();
    fail = false;
    throw Object.assign(new Error('i/o error'), { code: 'EIO' });
  });
  assert.equal(await raw(s.port, '/assets/a.mp4'), 403);
  assert.equal(await raw(s.port, '/'), 200);
});

test('a file that grows while it is sent goes out at the size it had', async (t) => {
  const dir = site();
  const clip = path.join(dir, 'assets', 'a.mp4');
  const s = await startServe(dir, {});
  t.after(() => s.close());
  wrapFstat(t, (stat) => {
    const st = stat();
    fs.appendFileSync(clip, Buffer.alloc(256 * 1024, 1));
    return st;
  });
  // Every byte on the connection: fetch would stop at Content-Length and hide what runs past it.
  const wire = await new Promise((resolve, reject) => {
    const chunks = [];
    const sock = net.connect({ host: '127.0.0.1', port: s.port }, () => {
      sock.write(`GET /assets/a.mp4 HTTP/1.1\r\nHost: localhost:${s.port}\r\nConnection: close\r\n\r\n`);
    });
    sock.on('data', (c) => chunks.push(c));
    sock.on('end', () => resolve(Buffer.concat(chunks)));
    sock.on('error', reject);
  });
  const split = wire.indexOf('\r\n\r\n');
  assert.match(wire.subarray(0, split).toString(), /content-length: 1000/i);
  assert.equal(wire.length - split - 4, 1000, 'nothing past the declared length');
});

test('a path that is a FIFO is refused at once instead of stopping the server', { skip: (process.platform === 'win32' || spawnSync('mkfifo', ['--help']).error) && 'needs mkfifo', timeout: 20_000 }, async (t) => {
  const dir = site();
  assert.equal(spawnSync('mkfifo', [path.join(dir, 'assets', 'pipe.mp4')]).status, 0);
  const state = path.join(tmp(), 'fifo.server.json');
  const child = spawn(process.execPath, [path.join(HERE, 'serve.mjs'), dir, '--state', state], { stdio: 'ignore' });
  // SIGKILL: a server stuck opening the FIFO cannot run its SIGTERM handler.
  t.after(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } });
  for (let i = 0; i < 100 && !fs.existsSync(state); i++) await new Promise((r) => setTimeout(r, 50));
  const { port } = readState(state);
  const status = await new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/assets/pipe.mp4', timeout: 3000 }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('timeout', () => { req.destroy(); resolve('no answer in 3 s'); });
    req.on('error', () => resolve('error'));
  });
  assert.equal(status, 404);
});

test('stop reports a stopped server even when its state file cannot be removed', { skip: (process.platform === 'win32' || process.getuid?.() === 0) && 'file modes do not stop this user' }, async (t) => {
  const dir = site();
  const parent = tmp();
  const state = path.join(parent, 'ro.server.json');
  const child = spawn(process.execPath, [path.join(HERE, 'serve.mjs'), dir, '--state', state], { stdio: 'ignore' });
  reap(t, child);
  for (let i = 0; i < 100 && !fs.existsSync(state); i++) await new Promise((r) => setTimeout(r, 50));
  const exited = new Promise((resolve) => child.on('exit', resolve));
  fs.chmodSync(parent, 0o555);
  let r;
  try {
    r = await stopServer(state, { timeoutMs: 5000 });
  } finally {
    fs.chmodSync(parent, 0o755);
  }
  assert.equal(r.reason, 'stopped');
  await exited;
});

test('closing a server goes on when its state file cannot be removed', { skip: (process.platform === 'win32' || process.getuid?.() === 0) && 'file modes do not stop this user' }, async () => {
  const dir = site();
  const s = await startServe(dir, {});
  const parent = path.dirname(dir);
  fs.chmodSync(parent, 0o555);
  try {
    await s.close();
  } finally {
    fs.chmodSync(parent, 0o755);
  }
  assert.equal(await portOpen(s.port), false);
  assert.equal(fs.existsSync(s.stateFile), true, 'left behind; the next start finds it stale');
});

test('stop refuses a state file whose PID is not a positive process id, and leaves the file', async () => {
  for (const pid of [-1, 0, 1, '123', 1.5]) {
    const f = path.join(tmp(), 'bad.server.json');
    fs.writeFileSync(f, JSON.stringify({ pid, port: 1 }));
    assert.deepEqual(await stopServer(f), { stopped: false, reason: 'invalid-state' }, String(pid));
    assert.equal(fs.existsSync(f), true);
  }
});

test('a start for another folder that shares the state file is refused, not taken for its server', async (t) => {
  const [a, b] = [site(), site()];
  const state = path.join(tmp(), 'shared.server.json');
  const child = spawn(process.execPath, [path.join(HERE, 'serve.mjs'), a, '--state', state], { stdio: 'ignore' });
  reap(t, child);
  for (let i = 0; i < 100 && !fs.existsSync(state); i++) await new Promise((r) => setTimeout(r, 50));
  const r = await runServe([b, '--state', state]);
  assert.equal(r.code, 1);
  assert.match(r.out, /different settings[\s\S]*folder[\s\S]*--stop/);
  const exited = new Promise((resolve) => child.on('exit', resolve));
  assert.equal((await stopServer(state, { timeoutMs: 5000 })).reason, 'stopped');
  await exited;
});

test('stop ends only the recorded server, waits for its port to close and removes the state file', async (t) => {
  const dir = site();
  const child = spawn(process.execPath, [path.join(HERE, 'serve.mjs'), dir], { stdio: 'ignore' });
  reap(t, child);
  const stateFile = path.join(path.dirname(dir), 'site.server.json');
  for (let i = 0; i < 100 && !fs.existsSync(stateFile); i++) await new Promise((r) => setTimeout(r, 50));
  const { port, pid } = readState(stateFile);
  assert.equal(pid, child.pid);
  assert.equal(await portOpen(port), true);
  const exited = new Promise((resolve) => child.on('exit', resolve));
  const r = await stopServer(stateFile, { timeoutMs: 5000 });
  assert.deepEqual([r.stopped, r.reason], [true, 'stopped']);
  await exited;
  assert.equal(await portOpen(port), false);
  assert.equal(fs.existsSync(stateFile), false);
});

test('stop leaves a port alone when another process answers there, and clears a stale record', async (t) => {
  const dir = site();
  const s = await startServe(dir, {});
  t.after(() => s.close());
  const fake = path.join(tmp(), 'other.server.json');
  fs.writeFileSync(fake, JSON.stringify({ pid: 999999, port: s.port, dir }));
  const r = await stopServer(fake, { timeoutMs: 500 });
  assert.deepEqual([r.stopped, r.reason], [false, 'other-process']);
  assert.equal(await portOpen(s.port), true, 'the live server is untouched');
  const free = await new Promise((resolve) => { const x = net.createServer().listen(0, '127.0.0.1', () => { const p = x.address().port; x.close(() => resolve(p)); }); });
  const stale = path.join(tmp(), 'stale.server.json');
  fs.writeFileSync(stale, JSON.stringify({ pid: 999999, port: free, dir }));
  const r2 = await stopServer(stale, { timeoutMs: 500 });
  assert.deepEqual([r2.stopped, r2.reason], [false, 'not-running']);
  assert.equal(fs.existsSync(stale), false);
  assert.deepEqual(await stopServer(path.join(tmp(), 'none.json')), { stopped: false, reason: 'no-state' });
});
