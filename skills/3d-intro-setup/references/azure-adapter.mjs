/*
 * Shared Azure OpenAI / Sora adapter for the 3d-intro skills (build + setup).
 *
 * CANONICAL COPY: skills/3d-intro-build/references/azure-adapter.mjs
 *   skills/3d-intro-setup/references/azure-adapter.mjs is a byte-identical mirror kept in
 *   sync by scripts/sync-adapter.js (run `node scripts/sync-adapter.js --check` in CI).
 *   Edit the build copy only; never the setup copy.
 *
 * Runtime: Node >=18 builtins ONLY — global fetch/FormData/Blob, node:fs/path/os/child_process.
 *   The one optional dependency, ffmpeg-static, is resolved LAZILY at runtime via dynamic
 *   import() inside resolveFfmpeg(); it is never a hard top-level import, so the module loads
 *   (and every non-ffmpeg export works) even when ffmpeg-static is not installed.
 *
 * Testability: azFetch() calls globalThis.fetch and the ffmpeg helpers call cp.spawnSync
 *   (property access at call time, not a destructured binding), so unit tests can stub both by
 *   assigning globalThis.fetch / cp.spawnSync. No hardcoded secrets, keys, or endpoints.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
// Default import (the CJS module.exports object) so ffmpeg helpers can read cp.spawnSync at
// call time — a destructured `import { spawnSync }` snapshots the binding and cannot be stubbed.
import cp from 'node:child_process';

// ---------------------------------------------------------------------------
// small internal helpers (not exported)
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round2 = (x) => Math.round(x * 100) / 100;

// Scheme+host of a URL, dropping any path/query — Azure endpoints are the origin only.
function originOf(url) {
  const raw = String(url || '');
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}`;
  } catch {
    // Not a URL: null, never the raw text, which may be a key pasted into the endpoint field.
    const m = raw.match(/^(https?:\/\/[^/\s]+)/i);
    return m ? m[1] : null;
  }
}

// Compact any value to a short one-line string for error messages (never throws).
function truncate(x, n = 300) {
  let s;
  if (typeof x === 'string') s = x;
  else { try { s = JSON.stringify(x); } catch { s = String(x); } }
  if (!s) return '';
  return s.length > n ? `${s.slice(0, n)}…(+${s.length - n})` : s;
}

// Why an azFetch result has no HTTP answer, for error messages: " (EINSECURE)" and the like. The
// error's code or name only, never its text: fetch can quote a header value, a key included.
const why = (r) => (r.error ? ` (${r.error.cause?.code || r.error.code || r.error.name})` : '');

// Last n chars of ffmpeg stderr (the useful part) for error messages.
const tail = (s, n = 400) => { const str = String(s || ''); return str.length > n ? str.slice(-n) : str; };

// Map an arbitrary WxH request to the nearest discrete size the classic image API accepts.
function classicSize(size) {
  const m = String(size || '').match(/^(\d+)x(\d+)$/);
  if (!m) return '1024x1024';
  const w = +m[1], h = +m[2];
  if (w < h) return '1024x1536';
  if (w > h) return '1536x1024';
  return '1024x1024';
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/**
 * Extract Azure connection fields from a pasted console sample — works on BOTH a `curl`
 * command and a Python SDK snippet. Missing fields come back as null (never throws).
 * @returns {{endpoint:string|null, deployment:string|null, apiKey:string|null, apiVersion:string|null}}
 */
export function parseConsoleSample(text) {
  const s = String(text || '');
  const out = { endpoint: null, deployment: null, apiKey: null, apiVersion: null };

  // endpoint: an explicit kwarg (python/JS SDK) wins; else the origin of the first URL (curl).
  let m = s.match(/(?:azure_endpoint|azure_openai_endpoint|base_url|endpoint)\s*[=:]\s*["']([^"'\r\n]+)["']/i);
  if (m) out.endpoint = originOf(m[1]);
  else { m = s.match(/https?:\/\/[^\s"'`)]+/); if (m) out.endpoint = originOf(m[0]); }

  // api-version: URL query (?api-version=...) or SDK kwarg (api_version="...").
  m = s.match(/api[-_]version["']?\s*[=:]\s*["']?([A-Za-z0-9._-]+)/i);
  if (m) out.apiVersion = m[1];

  // deployment: URL path /deployments/<dep>/ wins; else a model/deployment kwarg.
  m = s.match(/\/deployments\/([^/?"'\s]+)/i);
  if (m) out.deployment = decodeURIComponent(m[1]);
  else {
    m = s.match(/(?:azure_deployment|deployment_name|deployment|model)\s*[=:]\s*["']([^"'\r\n]+)["']/i);
    if (m) out.deployment = m[1];
  }

  // key: Authorization: Bearer <k> | api-key: <k> (curl header) | api_key="<k>", "api-key": "<k>",
  // apiKey: '<k>' (python/JS SDK). An SDK value counts only in quotes: api_key=subscription_key or
  // apiKey: process.env.X names a variable, and taking that name for the key would replace a real one.
  m = s.match(/Authorization["']?\s*[:=]\s*["']?\s*Bearer\s+([A-Za-z0-9._-]+)/i)
    || s.match(/api-key\s*:\s*([A-Za-z0-9._-]+)/i)
    || s.match(/api[-_]?key["']?\s*[:=]\s*["']([A-Za-z0-9._-]+)["']/i);
  if (m) out.apiKey = m[1];

  return out;
}

/**
 * Parse a KEY=VALUE .env body into a plain object, skipping comment lines. A quoted value keeps
 * everything inside its quotes. In an unquoted value, a # that follows whitespace starts a comment
 * (also right after `=`), so a note after a value never becomes part of an endpoint or a key.
 */
export function parseEnvFile(text) {
  const env = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    if (line.trimStart().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=([^\n]*)$/);
    if (m) env[m[1]] = envValue(m[2]);
  }
  return env;
}

// `raw` is everything after `=`, so the whitespace before a leading # is still there. A stray
// trailing \r (a \r\r\n line end) is whitespace too.
function envValue(raw) {
  const v = raw.trim();
  const q = v[0];
  const end = q === '"' || q === "'" ? v.indexOf(q, 1) : -1;
  if (end > 0) return v.slice(1, end);
  return raw.trimEnd().replace(/\s+#.*$/, '').trim().replace(/^["']|["']$/g, '');
}

/** The home key file, `~/.config/banker/3d-intro/env`: the keys when no project key file is used. */
export function homeCredsPath() {
  return path.join(os.homedir(), '.config', 'banker', '3d-intro', 'env');
}

/**
 * This machine's settings file, `~/.config/banker/3d-intro/settings.env` (FFMPEG_PATH). It holds no
 * key, so it can exist without making the home key file look set up.
 */
export function homeSettingsPath() {
  return path.join(os.homedir(), '.config', 'banker', '3d-intro', 'settings.env');
}

/** The settings file as a KEY=VALUE map; {} when it is missing or cannot be read. */
export function readSettings() {
  return readEnvQuietly(homeSettingsPath);
}

// A KEY=VALUE file named by fileOf(); {} when there is none or it cannot be read (no home folder, no
// permission, a folder in its place).
function readEnvQuietly(fileOf) {
  try { return parseEnvFile(fs.readFileSync(fileOf(), 'utf8')); } catch { return {}; }
}

// Settings that name a program to run. Only the shell or this machine's own files set them (the
// settings file, or the home key file from an earlier setup): a project's .env.3d-intro.local can come
// with a repository, and must not choose what runs on this machine.
const MACHINE_ONLY = ['FFMPEG_PATH'];

/**
 * Load creds from `.env.3d-intro.local` in projectDir, else `~/.config/banker/3d-intro/env`.
 * Returns the parsed KEY=VALUE map plus `_source` (the file used, or null if none found). From a
 * project file, FFMPEG_PATH is left out and returned under `_ignored` so the caller can say why.
 */
export function resolveCreds({ projectDir } = {}) {
  const home = homeCredsPath();
  const candidates = [];
  if (projectDir) candidates.push(path.join(projectDir, '.env.3d-intro.local'));
  candidates.push(home);
  const p = candidates.find((c) => fs.existsSync(c));
  if (!p) return { _source: null };
  const creds = { ...parseEnvFile(fs.readFileSync(p, 'utf8')), _source: p };
  return p === home ? creds : withoutMachineOnly(creds);
}

function withoutMachineOnly(creds) {
  const ignored = Object.fromEntries(MACHINE_ONLY.filter((k) => creds[k] != null).map((k) => [k, creds[k]]));
  for (const k of MACHINE_ONLY) delete creds[k];
  return Object.keys(ignored).length ? { ...creds, _ignored: ignored } : creds;
}

/**
 * Persist creds to a KEY=VALUE env file, chmod 0600 where supported. Keys starting with `_`
 * and null/undefined values are skipped. Returns the written path. A name that is not a variable
 * name, or a value with a line break, throws before anything is written: either would add lines of
 * its own (a FFMPEG_PATH, a second endpoint) to the file.
 */
export function persistCreds(creds, { target } = {}) {
  if (!target) throw new Error('persistCreds: target path required');
  const lines = Object.entries(creds || {}).filter(([k, v]) => !k.startsWith('_') && v != null).map(([k, v]) => envLine(k, String(v)));
  const body = lines.length ? `${lines.join('\n')}\n` : '';
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, body, { mode: 0o600 });
  try { fs.chmodSync(target, 0o600); } catch { /* chmod unsupported (e.g. Windows) — best effort */ }
  return target;
}

// One KEY=VALUE line for persistCreds, refusing a name or value that would make lines of its own.
function envLine(k, v) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`persistCreds: ${JSON.stringify(k)} is not a variable name; nothing was written`);
  if (/[\r\n]/.test(v)) throw new Error(`persistCreds: ${k} contains a line break; nothing was written`);
  return `${k}=${envLiteral(v)}`;
}

// Quote a value that parseEnvFile would otherwise cut at " #", trim, or strip of its quotes.
function envLiteral(v) {
  if (!/\s#|^["'\s]|["'\s]$/.test(v)) return v;
  return v.includes('"') ? `'${v}'` : `"${v}"`;
}

/**
 * Redact a secret to its length only, `…(len)`: no character of it, since keys share fixed
 * prefixes (`sk-ws-`) and a shown tail narrows them down. Falsy -> "(missing)".
 */
export function redact(s) {
  if (!s) return '(missing)';
  return `…(${String(s).length})`;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const SECRET_HEADERS = new Set(['authorization', 'api-key', 'proxy-authorization', 'cookie']);
const MAX_HOPS = 5;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const localHttp = (u) => u.protocol === 'http:' && LOOPBACK.has(u.hostname);
const refused = (code, message) => Object.assign(new TypeError(`fetch failed: ${message}`), { cause: { code } });
const isSecret = (name) => SECRET_HEADERS.has(name.toLowerCase());
const withoutSecrets = (headers) => Object.fromEntries(Object.entries(headers).filter(([k]) => !isSecret(k)));
// Every form fetch takes (an object, [name, value] pairs, Headers) as one plain object, so a key is
// found in any of them. Pairs would otherwise read as headers named "0", "1".
const plainHeaders = (h) => (Array.isArray(h) || h instanceof Headers ? Object.fromEntries(new Headers(h)) : { ...h });

/** Whether a key may go to this URL: over https, or over http only to this machine (a local mock or proxy). */
export const safeForKey = (u) => u.protocol === 'https:' || localHttp(u);

// Where a redirect goes. The request was sent already, so a Location that is not a URL, or one that
// leaves https, ends it with a code that does not read as "nothing sent". http stays allowed only
// while the request is on this machine over http (a local mock); from anywhere else, an https
// localhost included, it would reach a service here or on the network.
function redirectTarget(location, from) {
  let next;
  try { next = new URL(location, from); } catch { throw refused('EBADREDIRECT', 'the redirect location is not a URL'); }
  if (next.protocol === 'https:' || (localHttp(next) && localHttp(from))) return next;
  throw refused('EINSECUREREDIRECT', 'a redirect away from https is not followed');
}

// The request for the next hop of a redirect. A request with a body (a prompt, a frame, a paid submit)
// follows only a 307 or 308 within its origin, which send it again as it was. A 301, 302 or 303 would
// make it a GET, and another origin is another server: either way the next answer does not answer this
// request, and its 401 or 429 would read as this key's (a key retired, a submit sent again elsewhere).
// Without a body, a 303, and a 301 or 302 after a POST, go on as a GET, as browsers do, and a hop to
// another origin goes without the secret headers.
function nextHop(req, status, crossOrigin) {
  if (req.body != null && (crossOrigin || status < 307)) {
    throw refused(crossOrigin ? 'ECROSSREDIRECT' : 'EBODYREDIRECT', 'a request with a body follows only a 307 or 308 within its origin');
  }
  const toGet = status === 303 || ((status === 301 || status === 302) && req.method === 'POST');
  const next = toGet ? { ...req, method: 'GET', body: undefined } : req;
  return crossOrigin ? { ...next, headers: withoutSecrets(next.headers) } : next;
}

/**
 * fetch that follows redirects by hand (at most 5): a request without a body as fetch would, but to
 * another origin without the key headers; a request with a body only by a 307 or 308 within its
 * origin (fetch itself forwards a custom `api-key` header and re-sends the body on 307 and 308 to
 * any origin, and turns a POST into a GET on 301 to 303). A key goes only where safeForKey allows: an http
 * URL with one is refused before anything is sent (cause.code EINSECURE), and no redirect leaves
 * https. Throws as fetch does on a network error.
 */
export async function fetchGuarded(url, init = {}) {
  let target = new URL(String(url));
  let req = { ...init, headers: plainHeaders(init.headers), redirect: 'manual' };
  if (!safeForKey(target) && Object.keys(req.headers).some(isSecret)) throw refused('EINSECURE', 'a key is sent only over https');
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const r = await globalThis.fetch(target.href, req);
    const location = REDIRECT_STATUS.has(r.status) ? r.headers.get('location') : null;
    if (!location) return r;
    try { await r.body?.cancel(); } catch { /* the redirect body is not needed */ }
    const next = redirectTarget(location, target);
    req = nextHop(req, r.status, next.origin !== target.origin);
    target = next;
  }
  throw refused('ETOOMANYREDIRECTS', 'too many redirects');
}

// Retry-After / retry-after-ms response header -> milliseconds (null when absent or unparsable).
function retryAfterMsOf(headers) {
  const ms = Number(headers.get('retry-after-ms'));
  if (headers.get('retry-after-ms') && Number.isFinite(ms)) return Math.max(0, ms);
  const h = headers.get('retry-after');
  if (!h) return null;
  const sec = Number(h);
  if (Number.isFinite(sec)) return Math.max(0, sec * 1000);
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

/**
 * Fetch an Azure URL trying the `api-key` header first and, on 401/403, retrying with
 * `Authorization: Bearer`. Never throws on HTTP status; a network error yields {status:0}.
 * `retryAfterMs` carries the server's Retry-After hint (null when absent).
 * @returns {Promise<{status:number, ok:boolean, ct:string, body:any, authStyle:string|null, retryAfterMs:number|null, error?:Error}>}
 */
export async function azFetch(url, { key, binary = false, headers = {}, method = 'GET', body } = {}) {
  const styles = key ? [{ 'api-key': key }, { Authorization: `Bearer ${key}` }] : [{}];
  let last = { status: 0, ok: false, ct: '', body: null, authStyle: null };
  for (const auth of styles) {
    const opts = { method, headers: { ...headers, ...auth } };
    if (body !== undefined) opts.body = body;
    let r;
    try {
      r = await fetchGuarded(url, opts);
    } catch (e) {
      last = { status: 0, ok: false, ct: '', body: null, authStyle: null, error: e };
      break; // network error is not an auth problem — do not retry other styles
    }
    const ct = r.headers.get('content-type') || '';
    let parsed;
    if (binary) parsed = Buffer.from(await r.arrayBuffer());
    else if (ct.includes('json')) parsed = await r.json().catch(() => null);
    else parsed = await r.text().catch(() => null);
    last = { status: r.status, ok: r.ok, ct, body: parsed, authStyle: Object.keys(auth)[0] || null, retryAfterMs: retryAfterMsOf(r.headers) };
    if (r.status !== 401 && r.status !== 403) return last; // accepted (or a non-auth error)
    // else: this auth style was rejected — fall through and try the next
  }
  return last;
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

// POST JSON, retrying HTTP 429 up to `retries` times. Waits the server's Retry-After when given,
// else 10s, 20s, 40s…; either way at most 60s per wait. Low-tier (S0) image deployments hit this.
async function postJsonWith429Retry(url, { key, body, retries, onNote }) {
  for (let i = 0; ; i++) {
    const r = await azFetch(url, { key, method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    if (r.status !== 429 || i >= retries) return r;
    const ms = Math.min(60000, r.retryAfterMs ?? 10000 * 2 ** i);
    if (typeof onNote === 'function') onNote(`HTTP 429; retry ${i + 1}/${retries} in ${ms} ms`);
    await sleep(ms);
  }
}

/**
 * Generate a still via the v1 images path; on failure fall back to the classic
 * `deployments/<dep>` path @2025-04-01-preview (discrete size). Returns a PNG Buffer.
 * HTTP 429 is retried on the same path first (`retry429` times) — the classic path shares the
 * deployment's rate limit, so falling back on 429 would only fail again.
 * `onNote(msg)` (optional) is invoked on 429 waits and when the classic fallback is taken.
 */
export async function generateImage({
  endpoint, key, deployment, apiVersion = 'preview',
  prompt, size = '720x1280', quality = 'low', n = 1, onNote, retry429 = 3,
} = {}) {
  const genBody = { model: deployment, prompt, size, quality, n };
  let r = await postJsonWith429Retry(`${endpoint}/openai/v1/images/generations?api-version=${apiVersion}`, {
    key, body: JSON.stringify(genBody), retries: retry429, onNote,
  });
  let note = 'v1';
  // no classic retry on 429 (shared limit) or on a lost connection (the v1 call may have billed)
  if (!(r.ok && r.body?.data?.[0]?.b64_json) && r.status !== 429 && r.status !== 0) {
    note = 'classic-fallback(2025-04-01-preview)';
    if (typeof onNote === 'function') onNote(`generateImage: v1 path failed (HTTP ${r.status}); trying ${note}`);
    r = await postJsonWith429Retry(`${endpoint}/openai/deployments/${deployment}/images/generations?api-version=2025-04-01-preview`, {
      key, body: JSON.stringify({ ...genBody, size: classicSize(size) }), retries: retry429, onNote,
    });
  }
  const b64 = r.body?.data?.[0]?.b64_json;
  if (!(r.ok && b64)) throw new Error(`generateImage failed (${note}): HTTP ${r.status}${why(r)} ${truncate(r.body)}`);
  return Buffer.from(b64, 'base64');
}

/** Edit an image (optional mask) via the v1 images/edits multipart path. Returns a PNG Buffer. */
export async function editImage({
  endpoint, key, deployment, apiVersion = 'preview', prompt, imageBuf, maskBuf, size,
} = {}) {
  const fd = new FormData();
  fd.append('model', deployment);
  fd.append('prompt', prompt);
  if (size) fd.append('size', size);
  fd.append('image', new Blob([imageBuf], { type: 'image/png' }), 'image.png');
  if (maskBuf) fd.append('mask', new Blob([maskBuf], { type: 'image/png' }), 'mask.png');
  const r = await azFetch(`${endpoint}/openai/v1/images/edits?api-version=${apiVersion}`, {
    key, method: 'POST', body: fd,
  });
  const b64 = r.body?.data?.[0]?.b64_json;
  if (!(r.ok && b64)) throw new Error(`editImage failed: HTTP ${r.status}${why(r)} ${truncate(r.body)}`);
  return Buffer.from(b64, 'base64');
}

/** Generate a still via the Black Forest Labs FLUX provider path. Returns a PNG Buffer. */
export async function generateImageFlux({ endpoint, key, prompt, width, height, apiVersion = 'preview' } = {}) {
  const r = await azFetch(`${endpoint}/providers/blackforestlabs/v1/flux-2-pro?api-version=${apiVersion}`, {
    key, method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, width, height }),
  });
  const b64 = r.body?.data?.[0]?.b64_json || r.body?.b64_json || r.body?.image;
  if (!(r.ok && b64)) throw new Error(`generateImageFlux failed: HTTP ${r.status}${why(r)} ${truncate(r.body)}`);
  return Buffer.from(b64, 'base64');
}

// ---------------------------------------------------------------------------
// Video (Sora)
// ---------------------------------------------------------------------------

const TERMINAL_STATUS = new Set(['completed', 'succeeded', 'failed', 'cancelled', 'canceled', 'error']);

/** List Sora video jobs. Returns the raw azFetch result ({status, ok, ct, body}). */
export async function listVideos({ endpoint, key, apiVersion = 'preview' } = {}) {
  return azFetch(`${endpoint}/openai/v1/videos?api-version=${apiVersion}`, { key, method: 'GET' });
}

/**
 * Create a Sora video from ONE input_reference frame (forward-chaining seam). Returns the
 * job object ({id, status, ...}); throws if the API did not return an id.
 */
export async function createVideo({
  endpoint, key, model = 'sora-2', prompt, size = '720x1280', seconds = 4, inputReferencePng, apiVersion = 'preview',
} = {}) {
  const fd = new FormData();
  fd.append('model', model);
  fd.append('prompt', prompt);
  fd.append('size', size);
  fd.append('seconds', String(seconds));
  if (inputReferencePng) {
    fd.append('input_reference', new Blob([inputReferencePng], { type: 'image/png' }), 'input_reference.png');
  }
  const r = await azFetch(`${endpoint}/openai/v1/videos?api-version=${apiVersion}`, { key, method: 'POST', body: fd });
  if (!(r.ok && r.body?.id)) {
    // status 0 = network error; errno tells a refused connection (nothing sent) from a lost one
    const err = new Error(`createVideo failed: HTTP ${r.status}${why(r)} ${truncate(r.body)}`);
    err.status = r.status;
    err.errno = r.error?.cause?.code || r.error?.code || null;
    throw err;
  }
  return r.body;
}

const POLL_DEFAULTS = { apiVersion: 'preview', intervalMs: 5000, maxTicks: 180 };
const POLL_RETRY_4XX = new Set([408, 429]);
const withoutUndefined = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));

/**
 * Poll a Sora job until a terminal status (or maxTicks). Polls first, then sleeps, so a job
 * that is already terminal returns without waiting. `onTick(status, i)` is optional; `sleep`
 * replaces the wait between polls. 408, 429, 5xx and network errors keep polling. Any other
 * 4xx throws at once with `err.status` and `err.code`: a job the server no longer knows, or a
 * key it refuses, never turns terminal.
 * @returns the last status object seen.
 */
export async function pollVideo(opts = {}) {
  const o = { ...POLL_DEFAULTS, sleep, ...withoutUndefined(opts) };
  const url = `${o.endpoint}/openai/v1/videos/${o.id}?api-version=${o.apiVersion}`;
  let st = null;
  for (let i = 0; i < o.maxTicks; i++) {
    const r = await azFetch(url, { key: o.key, method: 'GET' });
    throwIfRefused(r, o.id);
    if (r.ok) st = r.body || st;
    if (typeof o.onTick === 'function') o.onTick(st, i);
    if (st && TERMINAL_STATUS.has(st.status)) break;
    await o.sleep(o.intervalMs);
  }
  return st;
}

function throwIfRefused(r, id) {
  if (r.status < 400 || r.status >= 500 || POLL_RETRY_4XX.has(r.status)) return;
  const code = r.body?.error?.code || null;
  throw Object.assign(new Error(`pollVideo: job ${id} answered HTTP ${r.status}${code ? ` ${code}` : ''}`), { status: r.status, code });
}

/** Download finished video bytes. Returns an mp4 Buffer; throws on non-200 / empty body. */
export async function downloadVideo({ endpoint, key, id, apiVersion = 'preview' } = {}) {
  const r = await azFetch(`${endpoint}/openai/v1/videos/${id}/content?api-version=${apiVersion}`, {
    key, method: 'GET', binary: true,
  });
  if (!(r.status === 200 && r.body?.length)) throw new Error(`downloadVideo failed: HTTP ${r.status}${why(r)}`);
  return r.body;
}

/**
 * Probe whether the legacy two-image jobs API is available. Never throws.
 * @returns {Promise<boolean>} true when the legacy jobs endpoint exists and is authorized.
 */
export async function detectTwoImageSupport({ endpoint, key, apiVersion = 'preview' } = {}) {
  try {
    const r = await azFetch(`${endpoint}/openai/v1/video/generations/jobs?api-version=${apiVersion}`, {
      key, method: 'GET',
    });
    // 200 = the collection lists; 400 = present but wants params. 404/401/403/0 = not usable.
    return r.ok || r.status === 400;
  } catch {
    return false;
  }
}

/**
 * UNVALIDATED: legacy two-image (first+last frame) generation via the jobs API with
 * inpaint_items. This path is documented but NOT exercised by our smoke tests — field names
 * and shapes may drift. Gate on detectTwoImageSupport() and fall back to single-reference
 * chaining (createVideo) on any failure. Returns the raw job object on success.
 */
export async function createVideoTwoImage({
  endpoint, key, model = 'sora-2', prompt = '', firstPng, lastPng, size = '720x1280', seconds = 4, apiVersion = 'preview',
} = {}) {
  const fd = new FormData();
  fd.append('model', model);
  fd.append('prompt', prompt);
  fd.append('size', size);
  fd.append('n_seconds', String(seconds));
  // inpaint_items pins the generation to the first (frame 0) and last (frame -1) reference frames.
  fd.append('inpaint_items', JSON.stringify([
    { frame_index: 0, type: 'image', file_name: 'first.png' },
    { frame_index: -1, type: 'image', file_name: 'last.png' },
  ]));
  fd.append('files', new Blob([firstPng], { type: 'image/png' }), 'first.png');
  fd.append('files', new Blob([lastPng], { type: 'image/png' }), 'last.png');
  const r = await azFetch(`${endpoint}/openai/v1/video/generations/jobs?api-version=${apiVersion}`, {
    key, method: 'POST', body: fd,
  });
  const id = r.body?.id || r.body?.job_id;
  if (!(r.ok && id)) throw new Error(`createVideoTwoImage (UNVALIDATED) failed: HTTP ${r.status}${why(r)} ${truncate(r.body)}`);
  return r.body;
}

// ---------------------------------------------------------------------------
// ffmpeg (lazy binary resolution + frame/seam helpers)
// ---------------------------------------------------------------------------

/**
 * Locate an ffmpeg binary without ever invoking a shell:
 *   1) $FFMPEG_PATH from the shell, else FFMPEG_PATH in the settings file, else one an earlier setup
 *      left in the home key file; absolute paths only
 *   2) the absolute $PATH entries (split on path.delimiter), for ffmpeg / ffmpeg.exe
 *   3) the optional ffmpeg-static package (dynamic import — may be absent)
 * A project's .env.3d-intro.local never names the program, and "." or another relative PATH entry is
 * skipped: either would let the files of a project, a cloned repository say, choose what runs.
 * Throws an actionable error if none is found.
 */
export async function resolveFfmpeg() {
  const found = namedFfmpeg() || ffmpegOnPath() || await staticFfmpeg();
  if (!found) throw new Error('ffmpeg not found; run motion-graphic-setup or 3d-intro-setup');
  return found;
}

// The ffmpeg this machine names. Absolute only: a relative value would be looked up in the current
// folder, the project. The files are read only when the shell names nothing usable.
function namedFfmpeg() {
  const usable = (p) => !!p && path.isAbsolute(p) && fs.existsSync(p);
  if (usable(process.env.FFMPEG_PATH)) return process.env.FFMPEG_PATH;
  return [readSettings(), readEnvQuietly(homeCredsPath)].map((s) => s.FFMPEG_PATH).find(usable) || null;
}

function ffmpegOnPath() {
  const names = process.platform === 'win32' ? ['ffmpeg.exe', 'ffmpeg'] : ['ffmpeg'];
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter((d) => path.isAbsolute(d))) {
    const hit = names.map((name) => path.join(dir, name)).find((c) => fs.existsSync(c));
    if (hit) return hit;
  }
  return null;
}

async function staticFfmpeg() {
  try {
    const mod = await import('ffmpeg-static');
    const p = mod?.default || mod;
    return typeof p === 'string' && fs.existsSync(p) ? p : null;
  } catch { return null; /* ffmpeg-static not installed */ }
}

// Run ffmpeg with an ARGUMENT ARRAY (never a shell string). Returns {code, stdout, stderr, args}.
function runFf(bin, args, cwd) {
  const r = cp.spawnSync(bin, args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '', args };
}

/** Extract the exact LAST frame of an mp4 to a PNG (reverse + first-frame trick). Returns out. */
export async function extractLastFrame(mp4, out, { ffmpeg } = {}) {
  const bin = ffmpeg || await resolveFfmpeg();
  const r = runFf(bin, ['-y', '-i', mp4, '-vf', 'reverse', '-frames:v', '1', out]);
  if (r.code !== 0 && !fs.existsSync(out)) throw new Error(`extractLastFrame failed: ${tail(r.stderr)}`);
  return out;
}

/**
 * A still as a short clip: the hold of the hold-and-flight mode. The PNG repeats for `seconds`,
 * encoded as the scrub engine wants (H.264 yuv420p, a keyframe every 8 frames, faststart, no
 * audio). No generation call, so no cost. Every frame is the still, so a flight whose first or last
 * frame is this still meets the hold exactly. `size` ('720x1280') scales; even sizes only. Returns out.
 */
export async function stillToClip(png, out, { ffmpeg, seconds = 1, fps = 24, size } = {}) {
  const bin = ffmpeg || await resolveFfmpeg();
  fs.rmSync(out, { force: true }); // a file from an earlier run must not pass for this one
  const vf = `${size ? `scale=${String(size).replace('x', ':')},` : ''}format=yuv420p`;
  const r = runFf(bin, ['-y', '-loop', '1', '-i', png, '-t', String(seconds), '-r', String(fps), '-vf', vf,
    '-c:v', 'libx264', '-crf', '20', '-g', '8', '-movflags', '+faststart', '-an', out]);
  if (r.code !== 0 && !fs.existsSync(out)) throw new Error(`stillToClip failed: ${tail(r.stderr)}`);
  return out;
}

/** Extract the FIRST frame of an mp4 to a PNG. Returns out. */
export async function extractFirstFrame(mp4, out, { ffmpeg } = {}) {
  const bin = ffmpeg || await resolveFfmpeg();
  const r = runFf(bin, ['-y', '-i', mp4, '-frames:v', '1', out]);
  if (r.code !== 0 && !fs.existsSync(out)) throw new Error(`extractFirstFrame failed: ${tail(r.stderr)}`);
  return out;
}

/**
 * Tone/color continuity pass on srcPng. Stock ffmpeg has no true "match A's histogram to B"
 * filter, so this uses histeq — per-channel histogram equalization — the simplest robust
 * histogram normalization, which keeps a chained clip's first frame from drifting in
 * contrast/tone. refPng is accepted for API symmetry and a future CLUT-based exact match; it
 * is not fed to ffmpeg today (an unmapped extra input would make ffmpeg error). Returns out.
 */
export async function colorMatch(srcPng, refPng, out, { ffmpeg } = {}) {
  const bin = ffmpeg || await resolveFfmpeg();
  void refPng; // reserved (see doc comment)
  const r = runFf(bin, ['-y', '-i', srcPng, '-vf', 'format=rgb24,histeq', '-frames:v', '1', out]);
  if (r.code !== 0 && !fs.existsSync(out)) throw new Error(`colorMatch failed: ${tail(r.stderr)}`);
  return out;
}

/**
 * Crossfade clip A into clip B with an `xfade` transition of `sec` seconds. `offset` (opts) is
 * where the fade starts in A; when omitted it is derived from A's probed duration (dur - sec).
 * Returns out.
 */
export async function crossfade(aMp4, bMp4, out, sec = 0.5, { ffmpeg, offset } = {}) {
  const bin = ffmpeg || await resolveFfmpeg();
  let off = offset;
  if (off == null) {
    const dur = probeDurationSec(bin, aMp4);
    off = dur != null ? Math.max(0, dur - sec) : 0;
  }
  const filter = `[0:v][1:v]xfade=transition=fade:duration=${sec}:offset=${off}`;
  const args = ['-y', '-i', aMp4, '-i', bMp4, '-filter_complex', filter, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out];
  const r = runFf(bin, args);
  if (r.code !== 0 && !fs.existsSync(out)) throw new Error(`crossfade failed: ${tail(r.stderr)}`);
  return out;
}

/**
 * Concatenate mp4 clips into one continuous video via the concat filter (robust to differing
 * codecs; normalizes fps/scale/sar/pix_fmt first). Returns out.
 */
export async function concatClips(mp4List, out, { ffmpeg, fps = 30, width = 720, height = 1280 } = {}) {
  const bin = ffmpeg || await resolveFfmpeg();
  const list = Array.isArray(mp4List) ? mp4List : [];
  if (list.length === 0) throw new Error('concatClips: no input clips');
  const args = ['-y'];
  for (const f of list) args.push('-i', f);
  const norm = list.map((_, i) => `[${i}:v]fps=${fps},scale=${width}:${height},setsar=1,format=yuv420p[v${i}]`);
  const chain = `${list.map((_, i) => `[v${i}]`).join('')}concat=n=${list.length}:v=1[v]`;
  args.push('-filter_complex', `${norm.join(';')};${chain}`, '-map', '[v]', out);
  const r = runFf(bin, args);
  if (r.code !== 0 && !fs.existsSync(out)) throw new Error(`concatClips failed: ${tail(r.stderr)}`);
  return out;
}

// Probe an mp4's duration (seconds) by parsing ffmpeg's stderr banner. Returns null if absent.
function probeDurationSec(bin, mp4) {
  const r = cp.spawnSync(bin, ['-i', mp4], { encoding: 'utf8' });
  const text = `${r.stderr || ''}${r.stdout || ''}`;
  const m = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return null;
  return (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
}

/** Read a PNG's dimensions from its IHDR bytes (width@16, height@20) — no ffprobe. */
export function probeDims(png) {
  const buf = Buffer.isBuffer(png) ? png : fs.readFileSync(png);
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('probeDims: not a PNG');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

const VIDEO_USD_PER_SEC = 0.10;
const IMAGE_USD_EACH = 0.02;

/**
 * Rough budget for an intro of `nScenes` scenes. Video billed at $0.10/sec/clip (the Sora rate:
 * WAN rates cannot be read through an API); one image gen per scene (two per scene in two-image
 * mode). mode 'chain' (default) makes one clip of `seconds` per scene; 'holdFlight' makes one
 * flight of `flightSeconds` between each pair of scenes, the holds being encoded stills (free).
 * Returns per-category USD sub-costs and the total.
 * @returns {{images:number, videos:number, usd:number}}
 */
export function estimateCost({ nScenes, seconds = 4, twoImage = false, mode = 'chain', flightSeconds = 5 } = {}) {
  const n = Number(nScenes) || 0;
  const imageCount = twoImage ? n * 2 : n;
  const images = round2(imageCount * IMAGE_USD_EACH);
  const clipSeconds = mode === 'holdFlight' ? Math.max(0, n - 1) * flightSeconds : n * seconds;
  const videos = round2(clipSeconds * VIDEO_USD_PER_SEC);
  const usd = round2(images + videos);
  return { images, videos, usd };
}
