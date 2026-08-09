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
    const m = raw.match(/^(https?:\/\/[^/]+)/i);
    return m ? m[1] : raw.replace(/\/+$/, '');
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
  let m = s.match(/(?:azure_endpoint|azure_openai_endpoint|base_url|endpoint)\s*[=:]\s*["']([^"']+)["']/i);
  if (m) out.endpoint = originOf(m[1]);
  else { m = s.match(/https?:\/\/[^\s"'`)]+/); if (m) out.endpoint = originOf(m[0]); }

  // api-version: URL query (?api-version=...) or SDK kwarg (api_version="...").
  m = s.match(/api[-_]version["']?\s*[=:]\s*["']?([A-Za-z0-9._-]+)/i);
  if (m) out.apiVersion = m[1];

  // deployment: URL path /deployments/<dep>/ wins; else a model/deployment kwarg.
  m = s.match(/\/deployments\/([^/?"'\s]+)/i);
  if (m) out.deployment = decodeURIComponent(m[1]);
  else {
    m = s.match(/(?:azure_deployment|deployment_name|deployment|model)\s*[=:]\s*["']([^"']+)["']/i);
    if (m) out.deployment = m[1];
  }

  // key: Authorization: Bearer <k> | api-key: <k> (curl header) | api_key="<k>" (python/JS SDK).
  m = s.match(/Authorization["']?\s*[:=]\s*["']?\s*Bearer\s+([A-Za-z0-9._-]+)/i);
  if (!m) m = s.match(/api[-_]?key["']?\s*[:=]\s*["']?\s*([A-Za-z0-9._-]+)/i);
  if (m) out.apiKey = m[1];

  return out;
}

/** Parse a KEY=VALUE .env body into a plain object (strips surrounding quotes, skips comments). */
export function parseEnvFile(text) {
  const env = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    if (line.trimStart().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}

/**
 * Load creds from `.env.3d-intro.local` in projectDir, else `~/.config/banker/3d-intro/env`.
 * Returns the parsed KEY=VALUE map plus `_source` (the file used, or null if none found).
 */
export function resolveCreds({ projectDir } = {}) {
  const candidates = [];
  if (projectDir) candidates.push(path.join(projectDir, '.env.3d-intro.local'));
  candidates.push(path.join(os.homedir(), '.config', 'banker', '3d-intro', 'env'));
  for (const p of candidates) {
    if (fs.existsSync(p)) return { ...parseEnvFile(fs.readFileSync(p, 'utf8')), _source: p };
  }
  return { _source: null };
}

/**
 * Persist creds to a KEY=VALUE env file, chmod 0600 where supported. Keys starting with `_`
 * and null/undefined values are skipped. Returns the written path.
 */
export function persistCreds(creds, { target } = {}) {
  if (!target) throw new Error('persistCreds: target path required');
  const lines = [];
  for (const [k, v] of Object.entries(creds || {})) {
    if (k.startsWith('_') || v == null) continue;
    lines.push(`${k}=${String(v)}`);
  }
  const body = lines.length ? `${lines.join('\n')}\n` : '';
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body, { mode: 0o600 });
  try { fs.chmodSync(target, 0o600); } catch { /* chmod unsupported (e.g. Windows) — best effort */ }
  return target;
}

/** Redact a secret to `abcd…wxyz(len)`; short (<=8) secrets are fully masked; falsy -> "(missing)". */
export function redact(s) {
  if (!s) return '(missing)';
  const str = String(s);
  if (str.length <= 8) return `…(${str.length})`;
  return `${str.slice(0, 4)}…${str.slice(-4)}(${str.length})`;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/**
 * Fetch an Azure URL trying the `api-key` header first and, on 401/403, retrying with
 * `Authorization: Bearer`. Never throws on HTTP status; a network error yields {status:0}.
 * @returns {Promise<{status:number, ok:boolean, ct:string, body:any, authStyle:string|null, error?:Error}>}
 */
export async function azFetch(url, { key, binary = false, headers = {}, method = 'GET', body } = {}) {
  const styles = key ? [{ 'api-key': key }, { Authorization: `Bearer ${key}` }] : [{}];
  let last = { status: 0, ok: false, ct: '', body: null, authStyle: null };
  for (const auth of styles) {
    const opts = { method, headers: { ...headers, ...auth } };
    if (body !== undefined) opts.body = body;
    let r;
    try {
      r = await globalThis.fetch(url, opts);
    } catch (e) {
      last = { status: 0, ok: false, ct: '', body: null, authStyle: null, error: e };
      break; // network error is not an auth problem — do not retry other styles
    }
    const ct = r.headers.get('content-type') || '';
    let parsed;
    if (binary) parsed = Buffer.from(await r.arrayBuffer());
    else if (ct.includes('json')) parsed = await r.json().catch(() => null);
    else parsed = await r.text().catch(() => null);
    last = { status: r.status, ok: r.ok, ct, body: parsed, authStyle: Object.keys(auth)[0] || null };
    if (r.status !== 401 && r.status !== 403) return last; // accepted (or a non-auth error)
    // else: this auth style was rejected — fall through and try the next
  }
  return last;
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

/**
 * Generate a still via the v1 images path; on failure fall back to the classic
 * `deployments/<dep>` path @2025-04-01-preview (discrete size). Returns a PNG Buffer.
 * `onNote(msg)` (optional) is invoked when the classic fallback is taken.
 */
export async function generateImage({
  endpoint, key, deployment, apiVersion = 'preview',
  prompt, size = '720x1280', quality = 'low', n = 1, onNote,
} = {}) {
  const genBody = { model: deployment, prompt, size, quality, n };
  let r = await azFetch(`${endpoint}/openai/v1/images/generations?api-version=${apiVersion}`, {
    key, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(genBody),
  });
  let note = 'v1';
  if (!(r.ok && r.body?.data?.[0]?.b64_json)) {
    note = 'classic-fallback(2025-04-01-preview)';
    if (typeof onNote === 'function') onNote(`generateImage: v1 path failed (HTTP ${r.status}); trying ${note}`);
    r = await azFetch(`${endpoint}/openai/deployments/${deployment}/images/generations?api-version=2025-04-01-preview`, {
      key, method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...genBody, size: classicSize(size) }),
    });
  }
  const b64 = r.body?.data?.[0]?.b64_json;
  if (!(r.ok && b64)) throw new Error(`generateImage failed (${note}): HTTP ${r.status} ${truncate(r.body)}`);
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
  if (!(r.ok && b64)) throw new Error(`editImage failed: HTTP ${r.status} ${truncate(r.body)}`);
  return Buffer.from(b64, 'base64');
}

/** Generate a still via the Black Forest Labs FLUX provider path. Returns a PNG Buffer. */
export async function generateImageFlux({ endpoint, key, prompt, width, height, apiVersion = 'preview' } = {}) {
  const r = await azFetch(`${endpoint}/providers/blackforestlabs/v1/flux-2-pro?api-version=${apiVersion}`, {
    key, method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, width, height }),
  });
  const b64 = r.body?.data?.[0]?.b64_json || r.body?.b64_json || r.body?.image;
  if (!(r.ok && b64)) throw new Error(`generateImageFlux failed: HTTP ${r.status} ${truncate(r.body)}`);
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
  if (!(r.ok && r.body?.id)) throw new Error(`createVideo failed: HTTP ${r.status} ${truncate(r.body)}`);
  return r.body;
}

/**
 * Poll a Sora job until a terminal status (or maxTicks). Polls first, then sleeps, so a job
 * that is already terminal returns without waiting. `onTick(status, i)` is optional.
 * @returns the last status object seen.
 */
export async function pollVideo({
  endpoint, key, id, onTick, apiVersion = 'preview', intervalMs = 5000, maxTicks = 180,
} = {}) {
  const url = `${endpoint}/openai/v1/videos/${id}?api-version=${apiVersion}`;
  let st = null;
  for (let i = 0; i < maxTicks; i++) {
    const r = await azFetch(url, { key, method: 'GET' });
    st = r.body || st;
    if (typeof onTick === 'function') onTick(st, i);
    if (st && TERMINAL_STATUS.has(st.status)) break;
    await sleep(intervalMs);
  }
  return st;
}

/** Download finished video bytes. Returns an mp4 Buffer; throws on non-200 / empty body. */
export async function downloadVideo({ endpoint, key, id, apiVersion = 'preview' } = {}) {
  const r = await azFetch(`${endpoint}/openai/v1/videos/${id}/content?api-version=${apiVersion}`, {
    key, method: 'GET', binary: true,
  });
  if (!(r.status === 200 && r.body?.length)) throw new Error(`downloadVideo failed: HTTP ${r.status}`);
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
  if (!(r.ok && id)) throw new Error(`createVideoTwoImage (UNVALIDATED) failed: HTTP ${r.status} ${truncate(r.body)}`);
  return r.body;
}

// ---------------------------------------------------------------------------
// ffmpeg (lazy binary resolution + frame/seam helpers)
// ---------------------------------------------------------------------------

/**
 * Locate an ffmpeg binary without ever invoking a shell:
 *   1) $FFMPEG_PATH (if it exists)
 *   2) scan $PATH entries (split on path.delimiter) for ffmpeg / ffmpeg.exe
 *   3) the optional ffmpeg-static package (dynamic import — may be absent)
 * Throws an actionable error if none is found.
 */
export async function resolveFfmpeg() {
  const fromEnv = process.env.FFMPEG_PATH;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;

  const names = process.platform === 'win32' ? ['ffmpeg.exe', 'ffmpeg'] : ['ffmpeg'];
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  try {
    const mod = await import('ffmpeg-static');
    const p = mod?.default || mod;
    if (typeof p === 'string' && fs.existsSync(p)) return p;
  } catch { /* ffmpeg-static not installed — fall through to the error */ }

  throw new Error('ffmpeg not found; run motion-graphic-setup or 3d-intro-setup');
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
 * Rough budget for an intro of `nScenes` scenes. Video billed at $0.10/sec/clip; one image gen
 * per scene (two per scene in two-image mode). Returns per-category USD sub-costs and the total.
 * @returns {{images:number, videos:number, usd:number}}
 */
export function estimateCost({ nScenes, seconds = 4, twoImage = false } = {}) {
  const n = Number(nScenes) || 0;
  const imageCount = twoImage ? n * 2 : n;
  const images = round2(imageCount * IMAGE_USD_EACH);
  const videos = round2(n * seconds * VIDEO_USD_PER_SEC);
  const usd = round2(images + videos);
  return { images, videos, usd };
}
