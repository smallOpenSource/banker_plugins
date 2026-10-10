#!/usr/bin/env node
/*
 * Local preview server for an assembled intro (index.html + scrub-engine.js + assets/), so the
 * scroll-scrubbed page is checked in a real browser. The project convention is a self-contained
 * local page on an unused port, never a claude.ai artifact. Shared by 3d-intro-build and
 * motion-graphic-make (scripts/sync-adapter.js keeps the copies identical).
 *
 * Why a server at all: the engine loads each clip with fetch() into a Blob, which file:// cannot
 * serve, and video plays smoother with byte ranges (206).
 *
 * Usage:
 *   node serve.mjs [dir] [--port N] [--csp strict|"<policy>"] [--state file]
 *   node serve.mjs --stop [dir] [--state file]
 *     dir      folder to serve (default: the current one)
 *     --port   preferred port; when busy or absent the system picks a free one
 *     --csp    sends Content-Security-Policy on every response: `strict` (no inline script or
 *              style; blob: media) or the production policy as written. Check a page for a site
 *              with a CSP under that same policy: a plain server hides CSP errors.
 *     --state  state file (default: <dir>.server.json beside the folder, never inside it)
 *     --stop   ends the server the state file records, only when it answers with that PID
 *   A start while the recorded server still answers only reports its address. A request whose
 *   Host is a DNS name other than localhost is refused (DNS rebinding).
 *   On listen it writes the state file and prints  PREVIEW http://localhost:<port>/
 *   PREVIEW_HOST=0.0.0.0 binds every interface (on-device phone checks) and prints a warning.
 *
 * Runtime: Node >=18 builtins only. No shell, cross-platform.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LOOPBACK, answersPid, cspFrom, decodePath, forgetSelf, hostAllowed, hostWarning, isRunning, listen, readState,
  resolveInside, send, sendFile, siblingState, stopServer, urlFor, writeState,
} from './preview-lib.mjs';

function handler(dir, headers) {
  return (req, res) => {
    if (!hostAllowed(req.headers.host)) return send(res, 403, 'host not allowed', headers);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, '405', headers);
    const urlPath = decodePath(req.url);
    if (urlPath === null) return send(res, 400, '400', headers);
    if (answersPid(urlPath, res)) return;
    const fp = resolveInside(dir, urlPath === '/' ? '/index.html' : urlPath);
    if (!fp) return send(res, 403, '403', headers);
    sendFile(req, res, fp, headers);
  };
}

/**
 * Serves `dir` until close(). Resolves to { server, port, host, url, stateFile, close }.
 * @param {{ port?: number, host?: string, csp?: string, stateFile?: string }} opts
 */
export async function startServe(dir, { port, host = process.env.PREVIEW_HOST || LOOPBACK, csp, stateFile } = {}) {
  const root = path.resolve(dir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`serve: not a directory: ${root}`);
  const policy = cspFrom(csp);
  const server = http.createServer(handler(root, policy ? { 'Content-Security-Policy': policy } : {}));
  const bound = await listen(server, { host, port });
  const url = urlFor(host, bound);
  const file = stateFile ? path.resolve(stateFile) : siblingState(root);
  writeState(file, { pid: process.pid, port: bound, host, url, dir: root, csp: policy, startedAt: new Date().toISOString() });
  const close = () => new Promise((resolve) => { forgetSelf(file); server.close(() => resolve()); });
  return { server, port: bound, host, url, stateFile: file, close };
}

function parseArgs(argv) {
  const o = { dir: null, port: null, csp: null, state: null, stop: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [key, inline] = a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, null];
    const value = () => (inline !== null ? inline : argv[++i]);
    if (key === '--port') o.port = Number(value());
    else if (key === '--csp') o.csp = value();
    else if (key === '--state') o.state = value();
    else if (key === '--stop') o.stop = true;
    else if (!a.startsWith('--')) o.dir = a;
  }
  return o;
}

// Nothing left running is a success; a port held by another program, or one that stays open, is not.
async function stopMain(o, dir) {
  const r = await stopServer(o.state ? path.resolve(o.state) : siblingState(dir));
  console.log(`STOP ${r.reason}`);
  process.exit(['stopped', 'not-running', 'no-state'].includes(r.reason) ? 0 : 1);
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const dir = path.resolve(o.dir || process.cwd());
  if (o.stop) return stopMain(o, dir);
  const recorded = o.state ? path.resolve(o.state) : siblingState(dir);
  if (await isRunning(recorded)) return console.log(`PREVIEW ${readState(recorded).url} (already running, pid ${readState(recorded).pid})`);
  const s = await startServe(dir, { port: o.port || undefined, csp: o.csp || undefined, stateFile: o.state || undefined });
  const warn = hostWarning(s.host);
  if (warn) console.warn(warn);
  console.log(`PREVIEW ${s.url}`);
  console.log(`serving ${dir}${o.csp ? '  (with Content-Security-Policy)' : ''}  state: ${s.stateFile}`);
  const quit = () => { forgetSelf(s.stateFile); s.server.close(); process.exit(0); };
  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((e) => { console.error(String(e?.message || e)); process.exit(1); });
}
