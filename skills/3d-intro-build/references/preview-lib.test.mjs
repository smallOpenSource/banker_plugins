// Tests for preview-lib.mjs and serve.mjs: the local servers of the 3d-intro-build and
// motion-graphic-make skills. Run from the repo root:
//   node --test skills/3d-intro-build/references/preview-lib.test.mjs
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  PID_ROUTE, STRICT_CSP, cspFrom, decodePath, hostWarning, readState, resolveInside, stopServer,
} from './preview-lib.mjs';
import { startServe } from './serve.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'preview-lib-'));
const portOpen = (port) => new Promise((resolve) => {
  const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(true); });
  s.on('error', () => resolve(false));
});
// A request sent as written: fetch() would fold `..` segments before they reach the server.
const raw = (port, p) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
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
});

test('stop ends only the recorded server, waits for its port to close and removes the state file', async () => {
  const dir = site();
  const child = spawn(process.execPath, [path.join(HERE, 'serve.mjs'), dir], { stdio: 'ignore' });
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
