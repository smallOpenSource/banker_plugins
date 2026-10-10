/*
 * Shared by serve.mjs and curate.mjs: the local servers of the 3d-intro-build skill (mirrored
 * byte-identical into motion-graphic-make by scripts/sync-adapter.js).
 *
 * - A port the system picks (a preferred one first when asked), bound to loopback by default.
 * - A state file recording { pid, port, host, url, dir }: serve.mjs keeps it beside the folder it
 *   serves, curate.mjs in the project folder, which it does not serve (it serves listed takes only).
 * - Requests whose Host is a name other than localhost are refused, so a DNS name rebound to this
 *   machine cannot read what is served.
 * - A stop that ends only the process answering on that port with the recorded PID, then waits
 *   for the port to close. Nothing is matched by command line (no pkill -f).
 * - An optional Content-Security-Policy header, so a page is checked under the policy it ships with.
 *
 * Runtime: Node >=18 builtins only (node:fs / node:http / node:net / node:path). No shell.
 */
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

export const LOOPBACK = '127.0.0.1';
// Answers { pid } so a stop can tell this server from another process on the same port.
export const PID_ROUTE = '/__preview/pid';
// As strict as a production site: no inline script or style. The scrub engine fetches its clips
// from its own origin and plays them from blob: URLs.
export const STRICT_CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data: blob:",
  "media-src 'self' blob:", "connect-src 'self'", "font-src 'self'", "object-src 'none'",
  "base-uri 'self'", "frame-ancestors 'none'",
].join('; ');

export const MIME = {
  '.html': 'text/html;charset=utf-8', '.css': 'text/css;charset=utf-8', '.js': 'text/javascript;charset=utf-8',
  '.mjs': 'text/javascript;charset=utf-8', '.json': 'application/json;charset=utf-8', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.woff2': 'font/woff2',
};

// `strict` is the policy above; any other text is a policy as written; nothing means no header.
export const cspFrom = (value) => (value ? (value === 'strict' ? STRICT_CSP : String(value)) : null);

export function hostWarning(host) {
  if (!host || [LOOPBACK, 'localhost', '::1'].includes(host)) return null;
  return `주의: ${host} 에 바인드합니다. 같은 네트워크의 기기가 아직 공개하지 않은 산출물을 볼 수 있습니다. 끝나면 --stop 으로 닫으세요.`;
}

// True for a Host header naming this machine as localhost, by an IP address, or by a name the server
// was bound to (`names`); any other DNS name fails, which is what a rebinding attack needs.
export function hostAllowed(hostHeader, names = []) {
  const h = String(hostHeader || '').trim().toLowerCase();
  if (!h) return false;
  if (h.startsWith('[')) return /^\[[0-9a-f:.]+\](:\d+)?$/.test(h);
  const name = h.split(':')[0];
  return name === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(name) || names.map((n) => String(n).toLowerCase()).includes(name);
}

// The request path without its query, or null when its escapes are broken.
export function decodePath(rawUrl) {
  try { return decodeURIComponent(String(rawUrl || '/').split('?')[0]); } catch { return null; }
}

// The file a request path names inside `dir`, or null when the path leaves it.
export function resolveInside(dir, urlPath) {
  const fp = path.normalize(path.join(dir, urlPath));
  return fp === dir || fp.startsWith(dir + path.sep) ? fp : null;
}

export function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...headers, 'Content-Type': 'text/plain;charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(String(body));
}

// A file, with byte ranges for video (smoother scrubbing). Never cached: a rebuilt page is fresh.
export function sendFile(req, res, fp, headers = {}) {
  let st = null;
  try { st = fs.statSync(fp); } catch { /* missing */ }
  if (!st || st.isDirectory()) return send(res, 404, '404', headers);
  const type = MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream';
  const base = { ...headers, 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
  const range = type.startsWith('video/') ? /bytes=(\d+)-(\d*)/.exec(req.headers.range || '') : null;
  if (range) return sendRange(res, fp, st.size, range, base, headers);
  res.writeHead(200, { ...base, 'Content-Length': st.size });
  fs.createReadStream(fp).pipe(res);
}

function sendRange(res, fp, size, range, base, headers) {
  const start = Number(range[1]);
  const end = Math.min(range[2] ? Number(range[2]) : size - 1, size - 1);
  if (start >= size || start > end) {
    res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` });
    return void res.end();
  }
  res.writeHead(206, { ...base, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
  fs.createReadStream(fp, { start, end }).pipe(res);
}

// True when the request was the PID question, which this answers.
export function answersPid(urlPath, res) {
  if (urlPath !== PID_ROUTE) return false;
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ pid: process.pid }));
  return true;
}

// Listens on `port` when given and free, else on a port the system picks. Resolves to the port.
export function listen(server, { host = LOOPBACK, port } = {}) {
  const attempt = (p) => new Promise((resolve, reject) => {
    const onError = (e) => { server.off('listening', onListening); reject(e); };
    const onListening = () => { server.off('error', onError); resolve(server.address().port); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(p, host);
  });
  if (!port) return attempt(0);
  return attempt(port).catch((e) => (e.code === 'EADDRINUSE' ? attempt(0) : Promise.reject(e)));
}

// The address a person opens: localhost for loopback and the wildcard, IPv6 in brackets.
export function urlFor(host, port) {
  if (!host || host === LOOPBACK || host === '0.0.0.0') return `http://localhost:${port}/`;
  if (host === '::' || host === '::1') return `http://[::1]:${port}/`;
  return host.includes(':') ? `http://[${host}]:${port}/` : `http://${host}:${port}/`;
}

// Where a stop asks a server for its PID: the address it was bound to, a wildcard at loopback.
export function askHost(host) {
  if (!host || host === '0.0.0.0') return LOOPBACK;
  return host === '::' ? '::1' : host;
}
// The state file of a server for `dir`: beside the folder, so a deployed folder never carries it.
export const siblingState = (dir) => path.join(path.dirname(dir), `${path.basename(dir)}.server.json`);

export function writeState(file, info) {
  fs.writeFileSync(file, JSON.stringify(info, null, 2) + '\n');
}

export function readState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

export const removeState = (file) => fs.rmSync(file, { force: true });

// Removes the state file when the process recorded there is this one.
export function forgetSelf(file) {
  if (readState(file)?.pid === process.pid) removeState(file);
}

const NONE = Symbol('none');
// The PID the server on `port` says it has; NONE when nothing listens; null for another program.
function askPid(port, timeoutMs, host) {
  return new Promise((resolve) => {
    const req = http.get({ host: askHost(host), port, path: PID_ROUTE, timeout: timeoutMs, headers: { Host: 'localhost' } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body).pid ?? null); } catch { resolve(null); } });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', (e) => resolve(e.code === 'ECONNREFUSED' ? NONE : null));
  });
}

const portOpen = (port, host) => new Promise((resolve) => {
  const s = net.connect({ host: askHost(host), port }, () => { s.destroy(); resolve(true); });
  s.on('error', () => resolve(false));
});

async function waitClosed(port, timeoutMs, host) {
  for (const until = Date.now() + timeoutMs; Date.now() < until;) {
    if (!(await portOpen(port, host))) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !(await portOpen(port, host));
}

/** True when the server a state file records still answers on its port with its PID. */
export async function isRunning(stateFile) {
  const st = readState(stateFile);
  return Boolean(st && st.port) && (await askPid(st.port, 1500, st.host)) === st.pid;
}

function signal(pid, sig) {
  try { process.kill(pid, sig); } catch { /* already gone */ }
}

// Stops the server a state file records. Result reasons: stopped, no-state, not-running (the
// stale record is removed), other-process (left alone), still-open.
export async function stopServer(stateFile, { timeoutMs = 3000 } = {}) {
  const st = readState(stateFile);
  if (!st || !st.port) return { stopped: false, reason: 'no-state' };
  const who = await askPid(st.port, Math.min(timeoutMs, 1500), st.host);
  if (who === NONE) {
    removeState(stateFile);
    return { stopped: false, reason: 'not-running' };
  }
  if (who !== st.pid) return { stopped: false, reason: 'other-process' };
  signal(st.pid, 'SIGTERM');
  let closed = await waitClosed(st.port, timeoutMs, st.host);
  if (!closed) {
    signal(st.pid, 'SIGKILL');
    closed = await waitClosed(st.port, timeoutMs, st.host);
  }
  if (closed) removeState(stateFile);
  return closed ? { stopped: true, reason: 'stopped' } : { stopped: false, reason: 'still-open' };
}
