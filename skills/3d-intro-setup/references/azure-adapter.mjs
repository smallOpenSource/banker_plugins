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
import crypto from 'node:crypto';
// Default import (the CJS module.exports object) so ffmpeg helpers can read cp.spawnSync at
// call time — a destructured `import { spawnSync }` snapshots the binding and cannot be stubbed.
import cp from 'node:child_process';

// ---------------------------------------------------------------------------
// small internal helpers (not exported)
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A real wait between polls is at least 1 s: an interval of 0 must not poll a paid API in a busy loop.
const MIN_POLL_WAIT_MS = 1000;
const pollSleep = (ms) => sleep(Math.max(MIN_POLL_WAIT_MS, ms));
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
const why = (r) => (r.error ? ` (${r.errno || r.error.name})` : '');
// AbortSignal.timeout rejects with a DOMException whose numeric code (23) means nothing to a reader
export const errnoOf = (e) => (e?.name === 'TimeoutError' ? 'TimeoutError' : e?.cause?.code || e?.code || null);

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
  for (const line of String(text || '').split(/\r\n|\r|\n/)) {
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
  if (p === home) return creds;
  return trackedByGit(p) ? { ...withoutMachineOnly(creds), _tracked: true } : withoutMachineOnly(creds);
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
 * The file's lines stay as a person wrote them (comments, `export` lines, names not set here, each
 * line's own end, bytes in another encoding): only the line each set name is read from changes, and a
 * name the file lacks is added at the end. The new file replaces the old one whole, so a write cut
 * short by an error leaves the old one. A file with a second name (a hard link), one the new copy would
 * give another owner, or one in a folder that takes no new file (or that Windows holds open) is written
 * in place, as before. The home key and settings files are written where a link of theirs points; any other
 * key file that is a link (one a repository can bring) is refused, as are a folder, a pipe and a link to nothing.
 */
export function persistCreds(creds, { target } = {}) {
  if (!target) throw new Error('persistCreds: target path required');
  const set = Object.entries(creds || {}).filter(([k, v]) => !k.startsWith('_') && v != null).map(([k, v]) => [k, String(v)]);
  for (const [k, v] of set) envLine(k, v);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  refuseTracked(target);
  const file = keyFileAt(target);
  writeKeyFile(file, mergedEnv(readIfAny(file), set));
  return target;
}

// Where the key file's bytes live: the path, or what a link there points to (a plain write would
// follow it too). Anything but a regular file is refused: a pipe would block the write for good.
function keyFileAt(target) {
  let st;
  try { st = fs.lstatSync(target); } catch (e) { if (e.code === 'ENOENT') return target; throw e; }
  const file = st.isSymbolicLink() ? linkedFile(target) : target;
  if (!fs.statSync(file).isFile()) throw new Error(`persistCreds: ${target} is not a regular file; nothing was written`);
  if (file !== target) refuseProjectLink(target);
  return file;
}

// A project key file git tracks would carry a key into the next commit (.gitignore does not untrack it).
function refuseTracked(target) {
  if ([homeCredsPath(), homeSettingsPath()].includes(path.resolve(target)) || !trackedByGit(target)) return;
  throw new Error(`persistCreds: ${target} is tracked by git, so a key written there would go into a commit; nothing was written. Untrack it (git rm --cached) and keep it in .gitignore, or use the home key file`);
}

// Whether git tracks `file`: true, or false when it does not or cannot say (no git, no repository).
// git runs from the home folder with -C: Windows looks for a program in the folder it starts in first,
// and a repository can bring a git.exe. fsmonitor is off, so a repository's config starts no hook.
function trackedByGit(file) {
  const r = cp.spawnSync('git', ['-C', path.dirname(path.resolve(file)), '-c', 'core.fsmonitor=false', 'ls-files', '--error-unmatch', '--', path.basename(file)], {
    cwd: os.homedir(), stdio: 'ignore', timeout: 5000, windowsHide: true,
  });
  return r.status === 0;
}

// A project's key file can come with a repository, and a link there can lead to a file of the user's (a
// dotfile) or of the repository (its .git/config, a tracked file) that must not get KEY= lines: a link
// there is refused. The home key and settings files keep following a link anywhere (a dotfiles setup).
function refuseProjectLink(target) {
  if ([homeCredsPath(), homeSettingsPath()].includes(path.resolve(target))) return;
  throw new Error(`persistCreds: ${target} is a link, and a project key file is written only as a file of its own; nothing was written. Edit the file it points at yourself, or put a file of its own there (or use the home key file)`);
}

function linkedFile(link) {
  try { return fs.realpathSync(link); } catch (e) {
    if (e.code === 'ENOENT') throw new Error(`persistCreds: ${link} is a link to nothing; nothing was written`);
    throw e;
  }
}

// latin1 reads each byte as one character, so a line in another encoding (a CP949 comment) is
// written back byte for byte.
function readIfAny(file) {
  try { return fs.readFileSync(file, 'latin1'); } catch (e) { if (e.code === 'ENOENT') return ''; throw e; }
}

// The file's bytes with each set name's value in place. parseEnvFile reads a name's last assignment,
// so that line is the one replaced, unless it already reads as the new value; a name the file lacks
// is appended. Every line keeps its own end; an added one takes \r\n when the file has any. New text
// goes in as UTF-8.
function mergedEnv(text, set) {
  const eol = eolOf(text);
  const lines = splitLines(text, eol);
  const lastAt = new Map(lines.map((l, i) => [assignedName(l.body), i]).filter(([k]) => k));
  for (const [k, v] of set) {
    const i = lastAt.get(k);
    const line = asLatin1(envLine(k, v));
    if (i === undefined) lines.push({ body: line, end: eol });
    else if (parseEnvFile(asUtf8(lines[i].body))[k] !== v) lines[i].body = line;
  }
  return Buffer.from(lines.map((l) => l.body + l.end).join(''), 'latin1');
}

// Each line with its own end; a last line without one gets `eol`.
// The line end an added line takes: \r\n when the file has any, else a lone \r when it has one, else \n.
const eolOf = (text) => (text.includes('\r\n') ? '\r\n' : text.includes('\r') ? '\r' : '\n');

function splitLines(text, eol) {
  return (text.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) || []).map((l) => {
    const m = /(?:\r\n|\r|\n)$/.exec(l);
    return m ? { body: l.slice(0, m.index), end: m[0] } : { body: l, end: eol };
  });
}

const asLatin1 = (s) => Buffer.from(s, 'utf8').toString('latin1');
const asUtf8 = (s) => Buffer.from(s, 'latin1').toString('utf8');

// The name a line assigns, as parseEnvFile reads it (null for a comment, an `export` line, or text).
function assignedName(line) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
  return m ? m[1] : null;
}

// The new contents go to a fresh random name opened exclusively ('wx') and are renamed over the old
// file. A file with a second name (a hard link), or one the new copy would give another owner or
// group, is written in place: a rename would part it from its other name, or hand it to this user.
// So is one whose folder takes no new file, or whose rename the system refuses: the old in-place
// write still works there.
function writeKeyFile(file, body) {
  const old = statIfAny(file);
  if (old && old.nlink > 1) return writeInPlace(file, body);
  const tmp = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  const fd = openNew(tmp);
  if (fd === null) return writeInPlace(file, body);
  let moved = false;
  try {
    moved = fillTemp(fd, body, old) && renamed(tmp, file);
  } finally {
    if (!moved) fs.rmSync(tmp, { force: true });
  }
  return moved ? chmodPrivate(file) : writeInPlace(file, body);
}

// A read-only folder, one that is not this user's, or (on Windows) a file another program holds.
const NO_NEW_FILE = new Set(['EACCES', 'EPERM', 'EBUSY', 'EROFS']);

function openNew(tmp) {
  try { return fs.openSync(tmp, 'wx', 0o600); } catch (e) { if (NO_NEW_FILE.has(e.code)) return null; throw e; }
}

function renamed(tmp, file) {
  try { fs.renameSync(tmp, file); return true; } catch (e) { if (NO_NEW_FILE.has(e.code)) return false; throw e; }
}

// Fill and close the new file. False, with nothing written, when its owner or group is not the old file's.
function fillTemp(fd, body, old) {
  try {
    const st = fs.fstatSync(fd);
    if (old && (st.uid !== old.uid || st.gid !== old.gid)) return false;
    fs.writeFileSync(fd, body);
    syncIfAble(fd);
    return true;
  } finally {
    fs.closeSync(fd);
  }
}

// fsync where the file system does it. One that does not (EINVAL, ENOTSUP) still gets the whole new
// file by the rename; only its crash safety is less.
const NO_FSYNC = new Set(['EINVAL', 'ENOTSUP']);
function syncIfAble(fd) {
  try { fs.fsyncSync(fd); } catch (e) { if (!NO_FSYNC.has(e.code)) throw e; }
}

function writeInPlace(file, body) {
  fs.writeFileSync(file, body, { mode: 0o600 });
  return chmodPrivate(file);
}

function statIfAny(file) {
  try { return fs.statSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

function chmodPrivate(file) {
  try { fs.chmodSync(file, 0o600); } catch { /* chmod unsupported (e.g. Windows) — best effort */ }
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

/**
 * Whether this process's fetch sends an http request to `u` through a proxy named in the environment:
 * Node 22 and 24 do when NODE_USE_ENV_PROXY=1 or --use-env-proxy is on and http_proxy or HTTP_PROXY is
 * set, unless NO_PROXY names the host. Over plain http the proxy reads the request, a key included.
 * Read as Node 22.23 and 24.13 do (measured), and toward "proxied" where unsure: NODE_USE_ENV_PROXY
 * other than empty or 0 is on (Node takes only 1); the flag on the command line or in NODE_OPTIONS is on
 * in any spelling Node takes (`_` for `-`, quoted, with a value, even `=false`), and so is a Node
 * config file, which can turn it on unseen; and the host
 * must be named in no_proxy and NO_PROXY both, when set (Node takes no_proxy when it is set, even
 * empty). An entry names it as `*`, the host, or the host with this URL's own port written out;
 * a leading dot, a range or a default port does not count.
 */
export function envProxied(u, env = process.env, flags = process.execArgv) {
  if (!envProxyOn(env, flags) || !(env.http_proxy || env.HTTP_PROXY)) return false;
  const lists = [env.no_proxy, env.NO_PROXY].filter((list) => list !== undefined);
  return !lists.length || !lists.every((list) => noProxyNames(list, u));
}

function envProxyOn(env, flags) {
  if (env.NODE_USE_ENV_PROXY && env.NODE_USE_ENV_PROXY !== '0') return true;
  const given = [...flags, env.NODE_OPTIONS || ''].join(' ');
  return PROXY_FLAG.test(given) || CONFIG_FILE_FLAG.test(given);
}

// `--use-env-proxy` as Node takes it (`--no-use-env-proxy` turns it off), and the flags that load a
// Node config file, whose nodeOptions can turn it on without either showing here.
const PROXY_FLAG = /--use[-_]env[-_]proxy(?![\w-])/;
const CONFIG_FILE_FLAG = /--experimental[-_](?:default[-_])?config[-_]file(?![\w-])/;

// Entries are split at commas and spaces, and compared in lower case (URL gives the host in lower case).
const noProxyNames = (list, u) => list.toLowerCase().split(/[\s,]+/).some((x) => noProxyEntry(x, u));

function noProxyEntry(x, u) {
  if (x === '*') return true;
  const m = x.match(/^(\[[^\]]*\]|[^:[\]]*)(?::(\d+))?$/);
  return Boolean(m) && m[1] === u.hostname && (m[2] === undefined || m[2] === u.port);
}

// The environment as this module found it. Node takes the proxy settings when it starts, so a change
// made later does not take the proxy away: a key is held back when either says a proxy is in the way.
const ENV_AT_LOAD = { ...process.env };

/** Whether a key is held back from this URL (EPROXYKEY): http that an env proxy would carry, now or as Node started. */
export const keyHeldBack = (u) => u.protocol === 'http:' && (envProxied(u) || envProxied(u, ENV_AT_LOAD));

// A key goes only where safeForKey allows, and over http only straight to this machine: not through
// a proxy the environment puts in the way. Both refusals come before anything is sent.
function assertKeyMayGo(target, headers) {
  if (!Object.keys(headers).some(isSecret)) return;
  if (!safeForKey(target)) throw refused('EINSECURE', 'a key is sent only over https');
  if (keyHeldBack(target)) {
    throw refused('EPROXYKEY', 'a key over http goes only straight to this machine, and the environment sends http through a proxy (NO_PROXY can name the host)');
  }
}

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
 * URL with one is refused before anything is sent (cause.code EINSECURE), and so is an http one to this
 * machine that an env proxy would carry (EPROXYKEY); no redirect leaves https. Throws as fetch does on
 * a network error.
 */
export async function fetchGuarded(url, init = {}) {
  let target = new URL(String(url));
  let req = { ...init, headers: plainHeaders(init.headers), redirect: 'manual' };
  assertKeyMayGo(target, req.headers);
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

// Each request ends within its limit. Without one, a server that takes the connection and never
// answers holds a request for undici's 300 s, and a poll of 180 requests for hours.
export const API_TIMEOUT_MS = 120_000;
export const DOWNLOAD_TIMEOUT_MS = 600_000;
// An image is made while its request waits, and is billed: it keeps the 300 s undici gave it.
const IMAGE_TIMEOUT_MS = 300_000;

/**
 * Fetch an Azure URL trying the `api-key` header first and, on 401/403, retrying with
 * `Authorization: Bearer`. Never throws on HTTP status; a network error, before the answer or
 * while its body is read, yields {status:0} with `error` (its name and codes only, no message text) and `errno` (a code such as
 * ECONNRESET or TimeoutError). Each request is limited to `timeoutMs` (default 120 s, 600 s
 * for a binary download). `retryAfterMs` carries the server's Retry-After hint (null when absent).
 * @param {{key?:string, binary?:boolean, headers?:object, method?:string, body?:any, timeoutMs?:number}} [opts] method defaults to GET
 * @returns {Promise<{status:number, ok:boolean, ct:string, body:any, authStyle:string|null, retryAfterMs:number|null, error?:Error, errno?:string|null}>}
 */
export async function azFetch(url, opts = {}) {
  const { key, binary = false } = opts;
  const limitMs = Math.ceil(opts.timeoutMs ?? (binary ? DOWNLOAD_TIMEOUT_MS : API_TIMEOUT_MS)); // AbortSignal.timeout takes whole ms only
  let last;
  for (const auth of authStyles(key)) {
    last = await azAttempt(url, { ...opts, auth, binary, limitMs });
    // accepted, a non-auth error, or a network error (not an auth problem): no other style is tried
    if (last.status !== 401 && last.status !== 403) return last;
  }
  return last;
}

const authStyles = (key) => (key ? [{ 'api-key': key }, { Authorization: `Bearer ${key}` }] : [{}]);

// One request with one auth style. The body is read inside the try: a connection that drops
// mid-body is a network error like any other, not a throw past the caller's retry. So is a time limit
// AbortSignal.timeout will not take (not a whole number of ms).
async function azAttempt(url, { method = 'GET', headers = {}, body, auth, binary, limitMs }) {
  const authStyle = Object.keys(auth)[0] || null;
  try {
    const opts = { method, headers: { ...headers, ...auth }, signal: AbortSignal.timeout(limitMs) };
    if (body !== undefined) opts.body = body;
    const r = await fetchGuarded(url, opts);
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, ok: r.ok, ct, body: await azBody(r, ct, binary), authStyle, retryAfterMs: retryAfterMsOf(r.headers) };
  } catch (e) {
    return { status: 0, ok: false, ct: '', body: null, authStyle: null, error: codeOnly(e), errno: errnoOf(e) };
  }
}

// The error a request failed with, without its text: undici quotes a header value it refuses (a key
// with a NUL or a line break) in its message. Its name, its code and its cause's code stay.
function codeOnly(e) {
  const { name, code, cause } = Object(e);
  const err = Object.assign(new Error(errnoOf(e) || name || 'network error'), { name: name || 'Error' });
  if (code !== undefined) err.code = code;
  if (cause && cause.code) err.cause = { code: cause.code };
  return err;
}

// A read cut short throws (the caller's catch makes it status 0); a JSON body that does not parse is null.
async function azBody(r, ct, binary) {
  if (binary) return Buffer.from(await r.arrayBuffer());
  const text = await r.text();
  if (!ct.includes('json')) return text;
  try { return JSON.parse(text); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

// POST JSON, retrying HTTP 429 up to `retries` times. Waits the server's Retry-After when given,
// else 10s, 20s, 40s…; either way at most 60s per wait. Low-tier (S0) image deployments hit this.
async function postJsonWith429Retry(url, { key, body, retries, onNote }) {
  for (let i = 0; ; i++) {
    const r = await azFetch(url, { key, method: 'POST', headers: { 'Content-Type': 'application/json' }, body, timeoutMs: IMAGE_TIMEOUT_MS });
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
  const post = (url, body) => postJsonWith429Retry(url, { key, body: JSON.stringify(body), retries: retry429, onNote });
  let r = await post(`${endpoint}/openai/v1/images/generations?api-version=${apiVersion}`, genBody);
  let note = 'v1';
  if (classicWorthTrying(r)) {
    note = 'classic-fallback(2025-04-01-preview)';
    if (typeof onNote === 'function') onNote(`generateImage: v1 path failed (HTTP ${r.status}); trying ${note}`);
    r = await post(`${endpoint}/openai/deployments/${deployment}/images/generations?api-version=2025-04-01-preview`, { ...genBody, size: classicSize(size) });
  }
  return pngFrom(r, dataB64(r), `generateImage failed (${note})`);
}

// no classic retry on 429 (shared limit) or on a lost connection (the v1 call may have billed)
const classicWorthTrying = (r) => !(r.ok && dataB64(r)) && r.status !== 429 && r.status !== 0;
const dataB64 = (r) => r.body?.data?.[0]?.b64_json;

// The PNG an image call answered with, or an error that starts with `failed`.
function pngFrom(r, b64, failed) {
  if (!(r.ok && b64)) throw new Error(`${failed}: HTTP ${r.status}${why(r)} ${truncate(r.body)}`);
  return Buffer.from(b64, 'base64');
}

/** Edit an image (optional mask) via the v1 images/edits multipart path. Returns a PNG Buffer. */
export async function editImage({
  endpoint, key, deployment, apiVersion = 'preview', prompt, imageBuf, maskBuf, size,
} = {}) {
  const r = await azFetch(`${endpoint}/openai/v1/images/edits?api-version=${apiVersion}`, {
    key, method: 'POST', body: editForm({ deployment, prompt, imageBuf, maskBuf, size }), timeoutMs: IMAGE_TIMEOUT_MS,
  });
  return pngFrom(r, dataB64(r), 'editImage failed');
}

function editForm({ deployment, prompt, imageBuf, maskBuf, size }) {
  const fd = new FormData();
  fd.append('model', deployment);
  fd.append('prompt', prompt);
  if (size) fd.append('size', size);
  fd.append('image', new Blob([imageBuf], { type: 'image/png' }), 'image.png');
  if (maskBuf) fd.append('mask', new Blob([maskBuf], { type: 'image/png' }), 'mask.png');
  return fd;
}

/** Generate a still via the Black Forest Labs FLUX provider path. Returns a PNG Buffer. */
export async function generateImageFlux({ endpoint, key, prompt, width, height, apiVersion = 'preview' } = {}) {
  const r = await azFetch(`${endpoint}/providers/blackforestlabs/v1/flux-2-pro?api-version=${apiVersion}`, {
    key, method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, width, height }), timeoutMs: IMAGE_TIMEOUT_MS,
  });
  return pngFrom(r, dataB64(r) || r.body?.b64_json || r.body?.image, 'generateImageFlux failed');
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
  const body = videoForm({ model, prompt, size, seconds, inputReferencePng });
  const r = await azFetch(`${endpoint}/openai/v1/videos?api-version=${apiVersion}`, { key, method: 'POST', body });
  if (!(r.ok && r.body?.id)) throw createVideoError(r);
  return r.body;
}

function videoForm({ model, prompt, size, seconds, inputReferencePng }) {
  const fd = new FormData();
  fd.append('model', model);
  fd.append('prompt', prompt);
  fd.append('size', size);
  fd.append('seconds', String(seconds));
  if (inputReferencePng) {
    fd.append('input_reference', new Blob([inputReferencePng], { type: 'image/png' }), 'input_reference.png');
  }
  return fd;
}

// status 0 = network error; errno tells a refused connection (nothing sent) from a lost one.
// retryAfterMs is the server's wait for a 429.
// code is the answer's error.code (DeploymentNotFound and the like), for a 404 or 410 the caller reads.
function createVideoError(r) {
  const err = new Error(`createVideo failed: HTTP ${r.status}${why(r)} ${truncate(r.body)}`);
  return Object.assign(err, { status: r.status, errno: r.errno || null, retryAfterMs: r.retryAfterMs ?? null, code: errorCodeOf(r) });
}

const errorCodeOf = (r) => (typeof r.body?.error?.code === 'string' ? r.body.error.code : null);

const POLL_DEFAULTS = { apiVersion: 'preview', intervalMs: 5000, maxTicks: 180, now: Date.now };
const POLL_RETRY_4XX = new Set([408, 429]);
const withoutUndefined = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));

/**
 * Poll a Sora job until a terminal status, maxTicks polls, or `timeoutMs` of wall time on the
 * `now` clock (default maxTicks x intervalMs, at least one request's 120 s), whichever comes first. Each request is limited to
 * the time left, so a server that stops answering cannot stretch the wait. Polls first, then
 * sleeps, so a job that is already terminal returns without waiting. `onTick(status, i)` is
 * optional; `sleep` replaces the wait between polls. 408, 429, 5xx and network errors keep
 * polling. Any other 4xx throws at once with `err.status` and `err.code`: a job the server no
 * longer knows, or a key it refuses, never turns terminal. So does a key held back before sending
 * (err.status 0, err.code EINSECURE or EPROXYKEY): no later poll could send it.
 * @returns the last status object seen.
 */
export async function pollVideo(opts = {}) {
  const o = { ...POLL_DEFAULTS, sleep: pollSleep, ...withoutUndefined(opts) };
  const url = `${o.endpoint}/openai/v1/videos/${o.id}?api-version=${o.apiVersion}`;
  const end = o.now() + (o.timeoutMs ?? Math.max(o.intervalMs * o.maxTicks, API_TIMEOUT_MS));
  let st = null;
  for (let i = 0; i < o.maxTicks; i++) {
    const r = await azFetch(url, { key: o.key, method: 'GET', timeoutMs: timeLeft(end, o.now()) });
    throwIfHeldBack(r, o.id);
    throwIfRefused(r, o.id);
    if (r.ok) st = r.body || st;
    if (typeof o.onTick === 'function') o.onTick(st, i);
    if (settled(st)) break;
    await o.sleep(o.intervalMs);
    if (o.now() >= end) break;
  }
  return st;
}

// A poll request's limit: the usual one, or less when the deadline is nearer (azFetch rounds it up to whole ms).
export const timeLeft = (end, t) => Math.min(API_TIMEOUT_MS, Math.max(1, Math.ceil(end - t)));
const settled = (st) => Boolean(st) && TERMINAL_STATUS.has(st.status);

export const HELD_KEY = new Set(['EINSECURE', 'EPROXYKEY']);
function throwIfHeldBack(r, id) {
  if (r.status !== 0 || !HELD_KEY.has(r.errno)) return;
  throw Object.assign(new Error(`pollVideo: job ${id}: the key was held back (${r.errno}); nothing was sent`), { status: 0, code: r.errno });
}

function throwIfRefused(r, id) {
  if (r.status < 400 || r.status >= 500 || POLL_RETRY_4XX.has(r.status)) return;
  const code = r.body?.error?.code || null;
  throw Object.assign(new Error(`pollVideo: job ${id} answered HTTP ${r.status}${code ? ` ${code}` : ''}`), { status: r.status, code });
}

/** Download finished video bytes. Returns an mp4 Buffer; throws on non-200 / empty body, with err.status. */
export async function downloadVideo({ endpoint, key, id, apiVersion = 'preview' } = {}) {
  const r = await azFetch(`${endpoint}/openai/v1/videos/${id}/content?api-version=${apiVersion}`, {
    key, method: 'GET', binary: true,
  });
  if (!(r.status === 200 && r.body?.length)) throw Object.assign(new Error(`downloadVideo failed: HTTP ${r.status}${why(r)}`), { status: r.status });
  return r.body;
}

// ---------------------------------------------------------------------------
// Sora deployment probe (FREE: two GETs, nothing is generated)
// ---------------------------------------------------------------------------

const DEPLOYMENT_API_VERSION = '2022-12-01';
/** A retirement date this many days away or nearer is reported (`soon`). */
export const RETIRE_SOON_DAYS = 14;
const DAY_MS = 86_400_000;
const RETIRED_LIFECYCLE = new Set(['retired', 'removed']);

/**
 * FREE check of a Sora deployment that makes no job. POST /openai/v1/videos checks every parameter
 * before it looks the deployment up (a deployment that does not exist answers the same 400 as one
 * that does, measured 2026-10-29), and a POST that passes the checks is a paid generation. So the
 * check is two GETs:
 *   GET /openai/deployments/<name>?api-version=2022-12-01   200 {model, status}, or 404 when there is none
 *   GET /openai/v1/models?api-version=preview                 the model's lifecycle_status and deprecation.inference
 * state: deployed | no_deployment | retired | auth | unreachable | unknown. `retired` means the
 * deployment answered 410, the model list calls the model retired, or its inference retirement date
 * has passed. `retiresAt` (ms) and `daysLeft` come from the model list; when the deployment names the
 * model without its version, the newest dated version is taken (`versionInferred`). `soon` is true
 * within RETIRE_SOON_DAYS. The result holds no key and no URL.
 */
export async function probeSoraDeployment({ endpoint, key, deployment = 'sora-2', now = Date.now } = {}) {
  const d = await azFetch(`${endpoint}/openai/deployments/${encodeURIComponent(deployment)}?api-version=${DEPLOYMENT_API_VERSION}`, { key, method: 'GET' });
  const base = { deployment, status: d.status, code: errorCodeOf(d), errno: d.errno || null };
  if (d.status !== 200) return { ...base, state: deploymentState(d.status) };
  const { model, deploymentStatus } = deploymentOf(d.body);
  const life = model ? await modelLifecycle(endpoint, key, model) : {};
  return withSchedule({ ...base, deploymentStatus, model, ...life }, now());
}

const deploymentOf = (b) => ({ model: typeof b?.model === 'string' ? b.model : null, deploymentStatus: b?.status ?? null });

const DEPLOYMENT_STATE = new Map([[404, 'no_deployment'], [410, 'retired'], [401, 'auth'], [403, 'auth'], [0, 'unreachable']]);
const deploymentState = (status) => DEPLOYMENT_STATE.get(status) || 'unknown';

// The model's entry in the resource's model list: its lifecycle and inference retirement date.
async function modelLifecycle(endpoint, key, model) {
  const r = await azFetch(`${endpoint}/openai/v1/models?api-version=preview`, { key, method: 'GET' });
  const m = r.ok ? modelEntry(r.body?.data, model) : null;
  if (!m) return { modelVersion: null, lifecycle: null, retiresAt: null };
  return { modelVersion: m.entry.id, versionInferred: m.inferred, lifecycle: m.entry.lifecycle_status ?? null, retiresAt: msOf(m.entry.deprecation?.inference) };
}

// The entry named exactly `model`, else the newest `<model>-YYYY-MM-DD` one (a deployment names only the model).
function modelEntry(list, model) {
  if (!Array.isArray(list)) return null;
  const exact = list.find((x) => x?.id === model);
  if (exact) return { entry: exact, inferred: false };
  const dated = (id) => typeof id === 'string' && id.startsWith(`${model}-`) && /^\d{4}-\d{2}-\d{2}$/.test(id.slice(model.length + 1));
  const versions = list.filter((x) => dated(x?.id)).sort((a, b) => b.id.localeCompare(a.id));
  return versions.length ? { entry: versions[0], inferred: true } : null;
}

// deprecation.inference is unix seconds; an ISO date is read too.
function msOf(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v * 1000;
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : null;
}

function withSchedule(r, t) {
  const daysLeft = r.retiresAt == null ? null : Math.ceil((r.retiresAt - t) / DAY_MS);
  const gone = (r.retiresAt != null && r.retiresAt <= t) || RETIRED_LIFECYCLE.has(r.lifecycle);
  const ready = !r.deploymentStatus || r.deploymentStatus === 'succeeded';
  const state = gone ? 'retired' : ready ? 'deployed' : 'unknown';
  return { ...r, state, daysLeft, soon: !gone && daysLeft != null && daysLeft <= RETIRE_SOON_DAYS };
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
  const r = await azFetch(`${endpoint}/openai/v1/video/generations/jobs?api-version=${apiVersion}`, {
    key, method: 'POST', body: twoImageForm({ model, prompt, firstPng, lastPng, size, seconds }),
  });
  if (!(r.ok && jobIdOf(r))) throw new Error(`createVideoTwoImage (UNVALIDATED) failed: HTTP ${r.status}${why(r)} ${truncate(r.body)}`);
  return r.body;
}

const jobIdOf = (r) => r.body?.id || r.body?.job_id;

function twoImageForm({ model, prompt, firstPng, lastPng, size, seconds }) {
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
  return fd;
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
  const r = runFf(bin, concatArgs(clipList(mp4List), out, { fps, width, height }));
  if (r.code !== 0 && !fs.existsSync(out)) throw new Error(`concatClips failed: ${tail(r.stderr)}`);
  return out;
}

function clipList(mp4List) {
  const list = Array.isArray(mp4List) ? mp4List : [];
  if (list.length === 0) throw new Error('concatClips: no input clips');
  return list;
}

// One -i per clip, each normalized (fps, scale, sar, pix_fmt) before the concat filter joins them.
function concatArgs(list, out, { fps, width, height }) {
  const args = ['-y'];
  for (const f of list) args.push('-i', f);
  const norm = list.map((_, i) => `[${i}:v]fps=${fps},scale=${width}:${height},setsar=1,format=yuv420p[v${i}]`);
  const chain = `${list.map((_, i) => `[v${i}]`).join('')}concat=n=${list.length}:v=1[v]`;
  args.push('-filter_complex', `${norm.join(';')};${chain}`, '-map', '[v]', out);
  return args;
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
 * flight of `flightSeconds` between each pair of scenes, the holds being encoded stills (free);
 * 'dive' makes one clip of `diveSeconds` per scene (the dives and the finale) and, with `exit`, one
 * exit of `exitSeconds` between each pair of scenes (6 scenes: $6.8 with exits, $4.8 without).
 * Returns per-category USD sub-costs and the total.
 * @returns {{images:number, videos:number, usd:number}}
 */
const COST_DEFAULTS = { seconds: 4, twoImage: false, mode: 'chain', flightSeconds: 5, diveSeconds: 8, exitSeconds: 4, exit: true };
// The clip seconds an intro bills, by mode.
const CLIP_SECONDS = {
  chain: (n, o) => n * o.seconds,
  holdFlight: (n, o) => Math.max(0, n - 1) * o.flightSeconds,
  dive: (n, o) => n * o.diveSeconds + (o.exit ? Math.max(0, n - 1) * o.exitSeconds : 0),
};

export function estimateCost(opts = {}) {
  const o = { ...COST_DEFAULTS, ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) };
  const n = Number(o.nScenes) || 0;
  const imageCount = o.twoImage ? n * 2 : n;
  const images = round2(imageCount * IMAGE_USD_EACH);
  const clipSeconds = (CLIP_SECONDS[o.mode] || CLIP_SECONDS.chain)(n, o);
  const videos = round2(clipSeconds * VIDEO_USD_PER_SEC);
  const usd = round2(images + videos);
  return { images, videos, usd };
}
