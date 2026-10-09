/*
 * Video provider pool for the 3d-intro skills (build + setup).
 *   Primary : Alibaba Cloud Model Studio WAN (e.g. wan3.0-video-prime) over a POOL of API keys.
 *   Fallback: Azure Sora-2 (via azure-adapter.mjs) once every WAN key is exhausted or unusable.
 *
 * CANONICAL COPY: skills/3d-intro-build/references/video-pool.mjs
 *   skills/3d-intro-setup/references/video-pool.mjs is a byte-identical mirror kept in sync by
 *   scripts/sync-adapter.js (run `node scripts/sync-adapter.js --check` in CI).
 *   Edit the build copy only; never the setup copy.
 *
 * Pool config (KEY=VALUE in the same env file resolveCreds() reads):
 *   WAN_<n>_ENDPOINT / WAN_<n>_API_KEY   one pool entry per n (any count, any gaps)
 *   WAN_<n>_MODEL                        per-entry model override (optional)
 *   WAN_MODEL                            pool-wide model (default wan3.0-video-prime)
 *   WAN_RESOLUTION                       480P | 720P | 1080P (default: derived from size)
 *   WAN_PROMPT_EXTEND                    true | false (default false — keeps chained prompts literal)
 *   WAN_MAX_CONCURRENT                   in-flight tasks per key (default 5, the documented limit)
 *   WAN_EXHAUSTED_TTL_HOURS              how long an exhausted key rests before one retry (default 24)
 *   VIDEO_PROVIDER_ORDER                 comma list of wan,sora (default wan,sora)
 *
 * Billing rule: a leg is submitted to a second key ONLY when the first submission provably did
 * not start a task (the server rejected it, the connection failed before the request was sent, or
 * the task ended FAILED/CANCELED with a known key, capacity or transient code). Every other outcome
 * throws, with the taskId when a task exists, so the caller can resume (resumeClip) instead of
 * paying twice. A config error (every WAN entry malformed, ModelNotFound) never falls back to Sora.
 *
 * Pool state lives in ~/.config/banker/3d-intro/video-pool-state.json (0600). It holds
 * FINGERPRINTS (sha256 of endpoint+key+model), never a key, so a rotated key or a changed model
 * starts with a clean record. State is advisory: a failed write is reported, never fatal.
 * Concurrent processes share the file last-write-wins; the per-key in-flight limit is per process.
 *
 * Runtime: Node >=18 builtins only. globalThis.fetch and cp.spawnSync are read at call time so
 * unit tests can stub them. No hardcoded secrets, keys, or endpoints.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import cp from 'node:child_process';
import { createVideo, pollVideo, downloadVideo, resolveFfmpeg, redact } from './azure-adapter.mjs';

export const WAN_DEFAULT_MODEL = 'wan3.0-video-prime';
const WAN_CREATE_PATH = '/api/v1/services/aigc/video-generation/video-synthesis';
const WAN_TASK_PATH = '/api/v1/tasks/';
const WAN_RATIOS = new Set(['21:9', '16:9', '4:3', '1:1', '3:4', '9:16']);
const SORA_SECONDS = [4, 8, 12];
const SORA_DONE = new Set(['completed', 'succeeded']);
const SORA_FAILED = new Set(['failed', 'cancelled', 'canceled', 'error']);
const PROBE_TASK_ID = '00000000-0000-0000-0000-000000000000';

const RATE_BASE_MS = 30_000;
const RATE_MAX_MS = 10 * 60_000;
const QUOTA_STRIKES_TO_EXHAUST = 3;
const QUOTA_STRIKE_TTL_MS = 3_600_000;
const TRANSIENT_BASE_MS = 15_000;
const UNKNOWN_POLLS_TO_FAIL = 5;
const API_TIMEOUT_MS = 120_000;
const DOWNLOAD_TIMEOUT_MS = 600_000;

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

// Codes from the Model Studio error-code reference, grouped by what the pool does with them.
const DENIED_CODES = new Set(['AccessDenied', 'Model.AccessDenied', 'Workspace.AccessDenied']);
const EXHAUSTED_CODES = new Set(['Arrearage', 'BudgetLimitExceeded', 'PostpaidBillOverdue', 'PrepaidBillOverdue']);
const RATE_CODES = new Set(['Throttling', 'Throttling.RateQuota', 'Throttling.BurstRate']);
const CONTENT_CODES = new Set(['DataInspectionFailed', 'IPInfringementSuspect']);
const TRANSIENT_CODES = new Set([
  'InternalError', 'InternalError.Timeout', 'ServiceUnavailable', 'ModelUnavailable', 'Throttling.ServiceOverloaded',
]);
// Errors that mean the request never left this machine, so resubmitting elsewhere cannot double-bill.
const PRE_SEND_ERRORS = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'ERR_INVALID_URL']);

/**
 * Map a WAN failure to a pool action.
 *   unusable  key rejected (InvalidApiKey) — retired until the key changes
 *   denied    key/workspace lacks access to the model — rests WAN_EXHAUSTED_TTL_HOURS
 *   exhausted quota or billing stop — rests WAN_EXHAUSTED_TTL_HOURS
 *   quota     Throttling.AllocationQuota (rate OR allocation limit) — cooldown; 3 in a row = 1 h rest
 *   rate      request-rate limit — cooldown only, never retires the key
 *   transient server-side trouble — short cooldown, next key
 *   content / invalid_request — not a key problem; thrown to the caller
 * @returns {'unusable'|'denied'|'exhausted'|'quota'|'rate'|'transient'|'content'|'invalid_request'}
 */
export function classifyWanError({ status, code } = {}) {
  const kind = codeKind(code);
  if (kind) return kind;
  if (status === 401) return 'unusable';
  if (status === 403) return 'denied';
  if (status === 429) return 'rate';
  return !status || status >= 500 ? 'transient' : 'invalid_request';
}

const CODE_KIND = new Map([
  ['InvalidApiKey', 'unusable'], ['ModelNotFound', 'invalid_request'], ['Throttling.AllocationQuota', 'quota'],
  ...[...DENIED_CODES].map((c) => [c, 'denied']), ...[...EXHAUSTED_CODES].map((c) => [c, 'exhausted']),
  ...[...RATE_CODES].map((c) => [c, 'rate']), ...[...CONTENT_CODES].map((c) => [c, 'content']),
  ...[...TRANSIENT_CODES].map((c) => [c, 'transient']),
]);

// The pool action a documented code calls for, or null for a code the pool does not know.
function codeKind(code) {
  if (!code) return null;
  if (CODE_KIND.has(code)) return CODE_KIND.get(code);
  if (/^InvalidParameter/.test(code)) return 'invalid_request';
  return /^AllocationQuota/.test(code) ? 'exhausted' : null;
}

// ---------------------------------------------------------------------------
// Pool entries + persisted state
// ---------------------------------------------------------------------------

// Endpoints are origins: a pasted console URL with a path would otherwise 404 every call. A value
// new URL() rejects (an inline "# comment" the env parser kept, a bare host, a key pasted into the
// wrong field) gives null. The raw value is never echoed, because it may be a key.
function originOf(url) {
  try {
    const u = new URL(String(url).trim());
    return /^https?:$/.test(u.protocol) && u.host ? `${u.protocol}//${u.host}` : null;
  } catch { return null; }
}
const fingerprint = (endpoint, key, model) => crypto.createHash('sha256').update(`${endpoint}\n${key}\n${model}`).digest('hex').slice(0, 16);
// A model id is one token (wan3.0-video-prime). A space fails every call, and an sk- value is a
// key pasted into the wrong field, so neither counts as a model.
const MODEL_RE = /^[A-Za-z0-9][\w.-]*$/;
const isModelId = (model) => MODEL_RE.test(model) && !/^sk-/i.test(model);
const hostOf = (endpoint) => (endpoint ? new URL(endpoint).host : '(invalid endpoint)');
const shownModel = (e) => (e.badModel ? '(invalid model)' : e.model);
// What a report may show about an entry: no raw value of a field that failed validation.
const shownEntry = (e) => ({ label: e.label, host: hostOf(e.endpoint), model: shownModel(e) });
// The field that makes an entry unusable, or null.
const malformedField = (e) => (e.badEndpoint ? 'endpoint' : e.badModel ? 'model' : null);

/**
 * Build the WAN pool from creds: every WAN_<n>_ENDPOINT with a matching WAN_<n>_API_KEY, by n.
 * An entry whose endpoint is not an http(s) URL (`badEndpoint`) or whose model is not one model id
 * (`badModel`) is kept so the preflight can report it; generateClip skips it.
 */
export function loadWanPool(creds = {}) {
  const pool = [];
  for (const k of Object.keys(creds)) {
    const m = k.match(/^WAN_(\d+)_ENDPOINT$/);
    if (m && creds[k] && creds[`WAN_${m[1]}_API_KEY`]) pool.push(poolEntry(creds, m[1]));
  }
  return pool.sort((a, b) => a.n - b.n || a.label.localeCompare(b.label));
}

// id keeps the literal digits so WAN_01_* never pairs with WAN_1_*
function poolEntry(creds, id) {
  const endpoint = originOf(creds[`WAN_${id}_ENDPOINT`]);
  const key = creds[`WAN_${id}_API_KEY`];
  const model = String(creds[`WAN_${id}_MODEL`] || creds.WAN_MODEL || WAN_DEFAULT_MODEL).trim();
  return {
    n: Number(id), label: `WAN_${id}`, endpoint, key, model, fp: fingerprint(endpoint, key, model),
    badEndpoint: !endpoint, badModel: !isModelId(model),
  };
}

export function defaultStatePath() {
  return path.join(os.homedir(), '.config', 'banker', '3d-intro', 'video-pool-state.json');
}

export function loadPoolState(file = defaultStatePath()) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (s && typeof s === 'object' && s.entries && typeof s.entries === 'object') return s;
  } catch { /* missing or corrupt — start clean */ }
  return { version: 1, entries: {} };
}

export function savePoolState(state, file = defaultStatePath()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* chmod unsupported (e.g. Windows) — best effort */ }
  return file;
}

// Read-modify-write one entry so updates from other runs since our last read are kept. State is
// advisory: a write failure (read-only HOME, a Windows rename lock) is reported, never thrown —
// a clip that is already paid for must still reach the caller.
function updateEntry(file, entry, fn, emit) {
  try {
    const state = loadPoolState(file);
    const cur = state.entries[entry.fp] || { label: entry.label, status: 'ok', okCount: 0 };
    state.entries[entry.fp] = { ...fn({ ...cur }), label: entry.label };
    savePoolState(state, file);
  } catch (e) {
    if (typeof emit === 'function') emit({ type: 'state-error', label: entry.label, message: e.message });
  }
}

/** Clear recorded state for all entries, or only for the given labels (e.g. ['WAN_2']). */
export function resetPoolState({ statePath = defaultStatePath(), creds, labels } = {}) {
  const state = loadPoolState(statePath);
  if (!labels) state.entries = {};
  else {
    const fps = new Set(loadWanPool(creds).filter((e) => labels.includes(e.label)).map((e) => e.fp));
    for (const fp of Object.keys(state.entries)) if (fps.has(fp)) delete state.entries[fp];
  }
  return savePoolState(state, statePath);
}

const exhaustedTtlMs = (creds) => (Number(creds.WAN_EXHAUSTED_TTL_HOURS) || 24) * 3_600_000;

// One entry's effective availability at time t.
function entryStatus(st, t) {
  if (!st) return { status: 'ok' };
  if (st.status === 'invalid') return { status: 'invalid', reason: st.reason };
  if (st.status === 'exhausted' && (!st.until || t < st.until)) return { status: 'exhausted', reason: st.reason, until: st.until };
  if (st.cooldownUntil && t < st.cooldownUntil) return { status: 'cooldown', reason: st.reason, until: st.cooldownUntil };
  return { status: 'ok' };
}

/** Per-entry availability for reporting. Never includes a key, nor a malformed endpoint or model. */
export function poolSummary({ creds = {}, statePath = defaultStatePath(), now = Date.now() } = {}) {
  const state = loadPoolState(statePath);
  return loadWanPool(creds).map((e) => {
    const st = state.entries[e.fp];
    const field = malformedField(e);
    return { ...shownEntry(e), okCount: st?.okCount || 0, ...(field ? { status: 'malformed', reason: field } : entryStatus(st, now)) };
  });
}

// In-process in-flight counter per fingerprint (the documented limit is per key).
const inflight = new Map();

function pickEntry(pool, state, t, limit) {
  const ready = [];
  let soonest = null;
  let busy = false;
  for (const e of pool) {
    const s = entryStatus(state.entries[e.fp], t);
    if (s.status === 'invalid' || s.status === 'exhausted') continue;
    if (s.status === 'cooldown') { soonest = soonest == null ? s.until : Math.min(soonest, s.until); continue; }
    if ((inflight.get(e.fp) || 0) >= limit) { busy = true; continue; }
    ready.push(e);
  }
  if (ready.length) {
    // least recently used first: spreads requests over the pool, so no single key takes every rate hit
    ready.sort((a, b) => (state.entries[a.fp]?.lastUsedAt || 0) - (state.entries[b.fp]?.lastUsedAt || 0) || a.n - b.n);
    return { entry: ready[0] };
  }
  // a busy key frees up as soon as one of our own tasks finishes — always worth waiting for
  if (busy) return { entry: null, waitMs: 1000, busy: true };
  if (soonest != null) return { entry: null, waitMs: Math.max(0, soonest - t) };
  return { entry: null, waitMs: null };
}

// ---------------------------------------------------------------------------
// WAN HTTP
// ---------------------------------------------------------------------------

function parseRetryAfter(h) {
  if (!h) return null;
  const sec = Number(h);
  if (Number.isFinite(sec)) return Math.max(0, sec * 1000);
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

const WAN_FETCH_DEFAULTS = { method: 'GET', binary: false, timeoutMs: API_TIMEOUT_MS };

async function wanFetch(url, opts = {}) {
  const o = { ...WAN_FETCH_DEFAULTS, ...defined(opts) };
  let r;
  try {
    r = await globalThis.fetch(url, {
      method: o.method, headers: wanHeaders(o), body: o.body === undefined ? undefined : JSON.stringify(o.body), signal: AbortSignal.timeout(o.timeoutMs),
    });
  } catch (e) {
    return networkFailure(e);
  }
  const retryAfterMs = parseRetryAfter(r.headers.get('retry-after'));
  if (o.binary) return { status: r.status, ok: r.ok, body: Buffer.from(await r.arrayBuffer()), code: null, message: null, retryAfterMs };
  return { status: r.status, ok: r.ok, ...(await parsedBody(r)), retryAfterMs };
}

function wanHeaders({ key, body }) {
  const headers = {};
  if (key) headers.Authorization = `Bearer ${key}`;
  if (body !== undefined) Object.assign(headers, { 'Content-Type': 'application/json', 'X-DashScope-Async': 'enable' });
  return headers;
}

// AbortSignal.timeout rejects with a DOMException whose numeric code means nothing to a reader
const errnoOf = (e) => (e?.name === 'TimeoutError' ? 'TimeoutError' : e?.cause?.code || e?.code || null);

// A fetch that threw. Its message can quote a request header in full (undici names an invalid
// header value, Authorization included), so only the error code travels on, never the text.
function networkFailure(e) {
  const errno = errnoOf(e);
  return { status: 0, ok: false, body: null, code: null, message: errno || e?.name || 'network error', retryAfterMs: null, preSend: PRE_SEND_ERRORS.has(errno), errno };
}

async function parsedBody(r) {
  const text = await r.text().catch(() => '');
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { body: parsed, code: parsed?.code || null, message: parsed?.message || null };
}

// PNG color type 4/6 or a tRNS chunk means transparency; WAN rejects PNGs with an alpha channel.
function pngHasAlpha(buf) {
  if (buf.length < 26 || buf.readUInt32BE(0) !== 0x89504e47) return false;
  const colorType = buf[25];
  return colorType === 4 || colorType === 6 || buf.includes(Buffer.from('tRNS'));
}

async function stripAlpha(buf) {
  const bin = await resolveFfmpeg();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-pool-'));
  try {
    const src = path.join(dir, 'in.png');
    const out = path.join(dir, 'out.png');
    fs.writeFileSync(src, buf);
    const r = cp.spawnSync(bin, ['-y', '-i', src, '-vf', 'format=rgb24', '-frames:v', '1', out], { encoding: 'utf8' });
    if (!fs.existsSync(out)) throw new Error(`stripAlpha failed: ${String(r.stderr || '').slice(-400)}`);
    return fs.readFileSync(out);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Encode a PNG/JPEG frame as the data URI WAN accepts, dropping any PNG alpha channel first. */
export async function frameDataUri(buf) {
  const b = Buffer.isBuffer(buf) ? buf : fs.readFileSync(buf);
  if (b[0] === 0xff && b[1] === 0xd8) return `data:image/jpeg;base64,${b.toString('base64')}`;
  const png = pngHasAlpha(b) ? await stripAlpha(b) : b;
  return `data:image/png;base64,${png.toString('base64')}`;
}

/** WAN generation parameters for an output size like '720x1280'. */
export function wanParams({ size = '720x1280', seconds = 5, hasFrame = false, creds = {}, overrides = {} } = {}) {
  const m = String(size).match(/^(\d+)x(\d+)$/);
  const w = m ? +m[1] : 720, h = m ? +m[2] : 1280;
  const short = Math.min(w, h);
  const resolution = creds.WAN_RESOLUTION || (short >= 1080 ? '1080P' : short >= 720 ? '720P' : '480P');
  const g = (a, b) => (b ? g(b, a % b) : a);
  const d = g(w, h);
  const exact = `${w / d}:${h / d}`;
  // with a first frame, 'adaptive' follows the frame's own aspect, so nothing gets cropped
  const ratio = hasFrame ? 'adaptive' : (WAN_RATIOS.has(exact) ? exact : 'adaptive');
  const duration = Math.min(30, Math.max(2, Math.round(Number(seconds) || 5)));
  const promptExtend = String(creds.WAN_PROMPT_EXTEND || '').toLowerCase() === 'true';
  return { resolution, ratio, duration, audio: false, watermark: false, prompt_extend: promptExtend, ...overrides };
}

/** Submit one WAN task. Returns the wanFetch result plus taskId when accepted. PAID CALL. */
export async function wanCreateTask({ entry, prompt, firstFramePng, lastFramePng, parameters } = {}) {
  if (lastFramePng && !firstFramePng) throw new Error('wanCreateTask: lastFramePng needs firstFramePng');
  const media = [];
  if (firstFramePng) media.push({ type: 'first_frame', url: await frameDataUri(firstFramePng) });
  if (lastFramePng) media.push({ type: 'last_frame', url: await frameDataUri(lastFramePng) });
  const input = { prompt };
  if (media.length) input.media = media;
  const r = await wanFetch(`${entry.endpoint}${WAN_CREATE_PATH}`, {
    key: entry.key, method: 'POST', body: { model: entry.model, input, parameters },
  });
  return { ...r, taskId: r.ok ? r.body?.output?.task_id || null : null };
}

/**
 * Poll a WAN task to a terminal state. Returns {state, output} where state is
 * SUCCEEDED | FAILED | CANCELED | UNKNOWN | TIMEOUT | HTTP (a 4xx other than 429 on the poll itself).
 */
export async function wanPollTask({ entry, taskId, intervalMs = 15_000, timeoutMs = 30 * 60_000, sleep = realSleep, onTick } = {}) {
  const url = `${entry.endpoint}${WAN_TASK_PATH}${encodeURIComponent(taskId)}`;
  const ticks = Math.max(1, Math.ceil(timeoutMs / Math.max(1, intervalMs)));
  let unknown = 0;
  for (let i = 0; i < ticks; i++) {
    const r = await wanFetch(url, { key: entry.key });
    if (r.ok) {
      const out = r.body?.output || {};
      if (typeof onTick === 'function') onTick(out.task_status, i);
      if (out.task_status === 'SUCCEEDED' || out.task_status === 'FAILED' || out.task_status === 'CANCELED') {
        return { state: out.task_status, output: out, usage: r.body?.usage || null };
      }
      if (out.task_status === 'UNKNOWN' && ++unknown >= UNKNOWN_POLLS_TO_FAIL) return { state: 'UNKNOWN', output: out };
    } else if (r.status >= 400 && r.status < 500 && r.status !== 429) {
      return { state: 'HTTP', output: { code: r.code, message: r.message }, status: r.status };
    }
    // 429/5xx/network on a poll: keep polling — the task itself is still running
    await sleep(intervalMs);
  }
  return { state: 'TIMEOUT', output: {} };
}

/** Download a finished WAN video (signed URL, no auth header). Returns an mp4 Buffer. */
export async function downloadWanVideo(url, { sleep = realSleep, tries = 3 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    last = await wanFetch(url, { binary: true, timeoutMs: DOWNLOAD_TIMEOUT_MS });
    if (last.status === 200 && last.body?.length) return last.body;
    if (i < tries - 1) await sleep(2000 * (i + 1));
  }
  throw new Error(`WAN video download failed: HTTP ${last?.status}`);
}

/**
 * FREE auth check for every pool entry: GET a nonexistent task. 200 (task_status UNKNOWN) means
 * the key and workspace endpoint authenticate; 401 InvalidApiKey means they do not. Remaining
 * quota is NOT visible this way — Model Studio has no documented quota API.
 */
export async function probeWanPool({ creds = {} } = {}) {
  const results = [];
  for (const e of loadWanPool(creds)) results.push(await probeEntry(e));
  return results;
}

async function probeEntry(e) {
  const base = { ...shownEntry(e), key: redact(e.key) };
  const field = malformedField(e);
  if (field) return { ...base, status: 0, code: field === 'endpoint' ? 'BadEndpoint' : 'BadModel', authOk: false };
  const r = await wanFetch(`${e.endpoint}${WAN_TASK_PATH}${PROBE_TASK_ID}`, { key: e.key });
  return { ...base, status: r.status, code: r.code, authOk: r.status === 200 };
}

// ---------------------------------------------------------------------------
// Orchestration: WAN pool -> Sora fallback
// ---------------------------------------------------------------------------

/** Error for a prompt/frame that content moderation rejected; switching keys cannot fix it. */
export class ContentRejectedError extends Error {
  constructor(provider, code, message) {
    super(`${provider} rejected the content (${code}): ${message || ''}`.trim());
    this.kind = 'content';
    this.provider = provider;
    this.code = code;
  }
}

// An error that must NOT be retried by resubmitting the leg: the task may exist and bill.
// kind: timeout | submit_unknown | download | no_video | task_lost. Carries taskId/label when known.
function stopError(kind, message, props = {}) {
  const err = new Error(message);
  Object.assign(err, { kind, ...props });
  return err;
}

export function parseProviderOrder(s) {
  const list = String(s || '').split(',').map((x) => x.trim().toLowerCase()).filter((x) => x === 'wan' || x === 'sora');
  return list.length ? [...new Set(list)] : ['wan', 'sora'];
}

export function snapSoraSeconds(sec) {
  const s = Number(sec) || 4;
  return SORA_SECONDS.reduce((best, v) => (Math.abs(v - s) < Math.abs(best - s) ? v : best), SORA_SECONDS[0]);
}

function applyFailure(file, entry, kind, { code, status, retryAfterMs, message }, t, creds, emit) {
  const reason = code || (status ? `HTTP ${status}` : 'network');
  updateEntry(file, entry, (st) => {
    // strikes count CONSECUTIVE hits: anything older than the window they guard is forgotten
    const fresh = st.lastFailAt && t - st.lastFailAt < RATE_MAX_MS * 2;
    const base = { ...st, reason, lastFailAt: t };
    if (kind === 'unusable') return { ...base, status: 'invalid', at: t };
    if (kind === 'denied' || kind === 'exhausted') return { ...base, status: 'exhausted', at: t, until: t + exhaustedTtlMs(creds), quotaStrikes: 0 };
    if (kind === 'quota') {
      const strikes = (fresh ? st.quotaStrikes || 0 : 0) + 1;
      if (strikes >= QUOTA_STRIKES_TO_EXHAUST) {
        return { ...base, status: 'exhausted', reason: `${reason} x${strikes}`, quotaStrikes: 0, at: t, until: t + QUOTA_STRIKE_TTL_MS };
      }
      return { ...base, quotaStrikes: strikes, cooldownUntil: t + (retryAfterMs ?? RATE_BASE_MS * 2 ** (strikes - 1)) };
    }
    if (kind === 'rate') {
      const strikes = (fresh ? st.rateStrikes || 0 : 0) + 1;
      return { ...base, rateStrikes: strikes, cooldownUntil: t + (retryAfterMs ?? Math.min(RATE_MAX_MS, RATE_BASE_MS * 2 ** (strikes - 1))) };
    }
    // transient
    const n = (fresh ? st.transientStrikes || 0 : 0) + 1;
    return {
      ...base, transientStrikes: n, cooldownUntil: t + Math.min(RATE_MAX_MS, TRANSIENT_BASE_MS * n),
      reason: message ? `${reason}: ${String(message).slice(0, 120)}` : reason,
    };
  }, emit);
}

// Idempotent per task: resuming a task whose download failed must not count it twice.
function recordSuccess(file, entry, t, taskId, emit) {
  updateEntry(file, entry, (st) => ({
    ...st, status: 'ok', reason: null, rateStrikes: 0, quotaStrikes: 0, transientStrikes: 0, cooldownUntil: null, until: null,
    okCount: (st.okCount || 0) + (st.lastOkTaskId === taskId ? 0 : 1), lastOkAt: t, lastOkTaskId: taskId,
  }), emit);
}

// Poll an accepted WAN task to a downloaded clip. Throws stopError for every outcome where the
// task may have billed; returns {fail} only when the task ended without output for a known reason.
async function finishWanTask(ctx, e, taskId, parameters) {
  const p = await wanPollTask({
    entry: e, taskId, intervalMs: ctx.pollIntervalMs, timeoutMs: ctx.pollTimeoutMs, sleep: ctx.sleep,
    onTick: (s, i) => ctx.emit({ type: 'poll', provider: 'wan', label: e.label, taskId, status: s, tick: i }),
  });
  if (p.state === 'SUCCEEDED') return { clip: await succeededClip(ctx, e, taskId, p, parameters.duration) };
  if (p.state === 'FAILED' || p.state === 'CANCELED') return { fail: failedTask(e, taskId, p) };
  throw lostTask(ctx, e, taskId, p, parameters.duration);
}

// A FAILED or CANCELED task is resubmitted only when its code says why nothing came out: a key or
// capacity problem, or a known transient server error. An unknown or missing code may be the
// input's fault, or a failure that billed, so the leg stops with the taskId instead of trying every key.
function failedTask(e, taskId, p) {
  const code = p.output.code || null;
  if (codeKind(code)) return { code, status: null, message: p.output.message };
  throw stopError('failed', `WAN task ${taskId} (${e.label}) ended ${p.state}${code ? ` (${code})` : ''} for a reason the pool does not know: ${p.output.message || 'no message'}; check the task in the Model Studio console before generating the leg again`, { provider: 'wan', taskId, label: e.label, code: code || p.state });
}

// The poll could not tell how the task ended: keep the taskId so nothing is submitted twice.
function lostTask(ctx, e, taskId, p, seconds) {
  if (p.state === 'TIMEOUT') {
    return stopError('timeout', `WAN task ${taskId} (${e.label}) still running after ${ctx.pollTimeoutMs} ms; resume with resumeClip`, { provider: 'wan', taskId, label: e.label, seconds });
  }
  if (p.state === 'HTTP') {
    if (p.status === 401) applyFailure(ctx.statePath, e, 'unusable', { code: p.output.code, status: p.status }, ctx.now(), ctx.creds, ctx.emit);
    return stopError('task_lost', `WAN poll for task ${taskId} (${e.label}) failed: HTTP ${p.status} ${p.output.code || ''}; check the Model Studio console before resubmitting`, { provider: 'wan', taskId, label: e.label, status: p.status, code: p.output.code });
  }
  return stopError('task_lost', `WAN task ${taskId} (${e.label}) reports UNKNOWN (expired or not found); check the console before resubmitting`, { provider: 'wan', taskId, label: e.label });
}

// SUCCEEDED: the clip is paid for from here on — record it before touching the network again
async function succeededClip(ctx, e, taskId, p, seconds) {
  recordSuccess(ctx.statePath, e, ctx.now(), taskId, ctx.emit);
  const videoUrl = p.output.video_url;
  if (!videoUrl) throw stopError('no_video', `WAN task ${taskId} (${e.label}) succeeded without a video_url`, { provider: 'wan', taskId, label: e.label });
  let mp4;
  try {
    mp4 = await downloadWanVideo(videoUrl, { sleep: ctx.sleep });
  } catch (err) {
    // videoUrl is a signed URL: kept as a property for recovery (valid 24 h), never in the message
    throw stopError('download', `${err.message} for WAN task ${taskId} (${e.label}); resume with resumeClip within 24 h`, { provider: 'wan', taskId, label: e.label, videoUrl, seconds });
  }
  ctx.emit({ type: 'done', provider: 'wan', label: e.label, taskId });
  return { mp4, provider: 'wan', label: e.label, model: shownModel(e), seconds: seconds ?? p.usage?.duration ?? null, taskId, usage: p.usage };
}

async function runWan(ctx) {
  const pool = usablePool(ctx);
  if (!pool.length) return null;
  const limit = Math.max(1, Math.floor(Number(ctx.creds.WAN_MAX_CONCURRENT) || 5));
  const parameters = wanParams({ size: ctx.size, seconds: ctx.seconds, hasFrame: !!ctx.firstFramePng, creds: ctx.creds, overrides: ctx.wanOverrides });
  const maxAttempts = pool.length * (QUOTA_STRIKES_TO_EXHAUST + 1) + 2;
  let attempts = 0;
  while (attempts < maxAttempts) {
    const pick = pickEntry(pool, loadPoolState(ctx.statePath), ctx.now(), limit);
    if (!pick.entry) {
      if (await waitForKey(ctx, pick)) continue;
      return poolUnavailable(ctx);
    }
    attempts++;
    const out = await attemptOnKey(ctx, pick.entry, parameters, attempts);
    if (out.clip) return out.clip;
    recordFailure(ctx, pick.entry, out.fail);
  }
  return poolUnavailable(ctx, `gave up after ${attempts} attempts`);
}

// The usable part of the WAN pool. Malformed entries are skipped with an event. When every configured
// entry is malformed the leg stops: a config error must not turn into a paid Sora clip.
function usablePool(ctx) {
  const all = loadWanPool(ctx.creds);
  const bad = all.filter(malformedField);
  for (const b of bad) ctx.emit({ type: 'skip', provider: 'wan', label: b.label, reason: `${malformedField(b)} is malformed (not an http(s) URL / not one model id)` });
  if (all.length && bad.length === all.length) {
    throw stopError('invalid_request', `every WAN entry is malformed (${bad.map((b) => `${b.label} ${malformedField(b)}`).join(', ')}); fix the env file — nothing was sent, and Sora was not used`, { provider: 'wan' });
  }
  const pool = all.filter((e) => !malformedField(e));
  if (!pool.length) ctx.emit({ type: 'skip', provider: 'wan', reason: 'no usable WAN_<n>_ENDPOINT + WAN_<n>_API_KEY entries' });
  return pool;
}

// Wait when a key frees up soon: an in-flight slot always, a cooldown only within maxRateWaitMs.
async function waitForKey(ctx, pick) {
  if (!pick.busy && (pick.waitMs == null || pick.waitMs > ctx.maxRateWaitMs)) return false;
  ctx.emit({ type: 'wait', provider: 'wan', ms: pick.waitMs, reason: pick.busy ? 'every usable key is at its in-flight limit' : 'every usable key is cooling down' });
  await ctx.sleep(pick.waitMs);
  return true;
}

function poolUnavailable(ctx, reason) {
  const summary = poolSummary({ creds: ctx.creds, statePath: ctx.statePath, now: ctx.now() });
  ctx.emit(reason ? { type: 'pool-unavailable', provider: 'wan', reason, summary } : { type: 'pool-unavailable', provider: 'wan', summary });
  return null;
}

// One paid submission on one key. Returns {clip} or {fail} (the task provably produced nothing);
// throws when resubmitting could bill the leg twice.
async function attemptOnKey(ctx, e, parameters, attempt) {
  updateEntry(ctx.statePath, e, (st) => ({ ...st, lastUsedAt: ctx.now() }), ctx.emit);
  inflight.set(e.fp, (inflight.get(e.fp) || 0) + 1);
  try {
    ctx.emit({ type: 'submit', provider: 'wan', label: e.label, model: e.model, attempt });
    const c = await wanCreateTask({ entry: e, prompt: ctx.prompt, firstFramePng: ctx.firstFramePng, lastFramePng: ctx.lastFramePng, parameters });
    assertSubmitSettled(e, c);
    if (c.taskId) return await finishWanTask(ctx, e, c.taskId, parameters);
    return { fail: { code: c.code, status: c.status, retryAfterMs: c.retryAfterMs, message: c.message } };
  } finally {
    inflight.set(e.fp, Math.max(0, (inflight.get(e.fp) || 1) - 1));
  }
}

// A submission whose fate is unknown must not go to another key: the request may have reached the
// server, and a second key would bill the same leg twice.
function assertSubmitSettled(e, c) {
  if (c.status === 0 && !c.preSend) {
    throw stopError('submit_unknown', `WAN submit to ${e.label} lost its connection (${c.message || 'network error'}); the task may exist — check the Model Studio console before resubmitting`, { provider: 'wan', label: e.label });
  }
  if (!c.taskId && (c.ok || (c.status >= 500 && !c.code))) {
    // a 2xx without task_id or a bare gateway 5xx: the backend may have accepted the task
    throw stopError('submit_unknown', `WAN submit to ${e.label} got an ambiguous answer (HTTP ${c.status}, no task_id); the task may exist — check the Model Studio console before resubmitting`, { provider: 'wan', label: e.label, status: c.status });
  }
}

// A provable non-start: moderation and request errors end the leg; key problems are recorded so
// the next pick avoids that key.
function recordFailure(ctx, e, fail) {
  const kind = classifyWanError(fail);
  ctx.emit({ type: 'fail', provider: 'wan', label: e.label, kind, code: fail.code, status: fail.status });
  if (kind === 'content') throw new ContentRejectedError('wan', fail.code, fail.message);
  if (kind === 'invalid_request') {
    throw stopError('invalid_request', `WAN rejected the request (${fail.code || `HTTP ${fail.status}`}): ${fail.message || ''}`, { provider: 'wan', code: fail.code, label: e.label });
  }
  applyFailure(ctx.statePath, e, kind, fail, ctx.now(), ctx.creds, ctx.emit);
}

function soraConn(creds) {
  return {
    endpoint: creds.AZURE_SORA_ENDPOINT, key: creds.AZURE_SORA_API_KEY,
    apiVersion: creds.AZURE_SORA_API_VERSION || 'preview', model: creds.AZURE_SORA_DEPLOYMENT || 'sora-2',
  };
}

// Poll an accepted Sora job to a downloaded clip; same stop rules as finishWanTask.
async function finishSoraJob(ctx, jobId, secs) {
  const conn = soraConn(ctx.creds);
  const st = await pollSoraJob(ctx, conn, jobId);
  if (st && SORA_FAILED.has(st.status)) throw soraFailure(st, jobId);
  if (!st || !SORA_DONE.has(st.status)) {
    throw stopError('timeout', `Sora job ${jobId} still ${st?.status ?? 'unknown'} after ${ctx.pollTimeoutMs} ms; resume with resumeClip`, { provider: 'sora', taskId: jobId, label: 'AZURE_SORA', seconds: secs });
  }
  const mp4 = await downloadSoraClip(conn, jobId, secs);
  ctx.emit({ type: 'done', provider: 'sora', label: 'AZURE_SORA', taskId: jobId });
  return { mp4, provider: 'sora', label: 'AZURE_SORA', model: conn.model, seconds: secs, taskId: jobId, usage: null };
}

// pollVideo throws on a 4xx other than 408/429 (the job is gone, or the key is refused): such a job
// never turns terminal, so the leg ends at once as task_lost instead of polling to the deadline.
async function pollSoraJob(ctx, conn, jobId) {
  const interval = Math.max(0, ctx.pollIntervalMs);
  try {
    return await pollVideo({
      endpoint: conn.endpoint, key: conn.key, id: jobId, apiVersion: conn.apiVersion, sleep: ctx.sleep,
      intervalMs: interval, maxTicks: Math.max(1, Math.ceil(ctx.pollTimeoutMs / Math.max(1, interval))),
      onTick: (s, i) => ctx.emit({ type: 'poll', provider: 'sora', taskId: jobId, status: s?.status, tick: i }),
    });
  } catch (e) {
    if (!e.status) throw e;
    throw stopError('task_lost', `Sora poll for job ${jobId} failed: HTTP ${e.status}${e.code ? ` ${e.code}` : ''}; check the job in Azure before resubmitting`, { provider: 'sora', taskId: jobId, label: 'AZURE_SORA', status: e.status, code: e.code });
  }
}

function soraFailure(st, jobId) {
  const code = st.error?.code || st.status;
  if (/moderation|content_policy|safety/i.test(`${code} ${st.error?.message || ''}`)) return new ContentRejectedError('sora', code, st.error?.message);
  return stopError('failed', `Sora job ${jobId} ended ${st.status}: ${JSON.stringify(st.error || '')}`, { provider: 'sora', taskId: jobId, code });
}

async function downloadSoraClip(conn, jobId, secs) {
  try {
    return await downloadVideo({ endpoint: conn.endpoint, key: conn.key, id: jobId, apiVersion: conn.apiVersion });
  } catch (err) {
    throw stopError('download', `${err.message} for Sora job ${jobId}; resume with resumeClip`, { provider: 'sora', taskId: jobId, label: 'AZURE_SORA', seconds: secs });
  }
}

async function runSora(ctx) {
  const { creds, prompt, firstFramePng, lastFramePng, size, seconds, emit, sleep } = ctx;
  const { endpoint, key, apiVersion, model } = soraConn(creds);
  const secs = snapSoraSeconds(seconds);
  if (lastFramePng) emit({ type: 'note', provider: 'sora', message: 'Sora takes one input_reference; the last frame is ignored (forward-chaining)' });
  let job;
  for (let i = 0; ; i++) {
    try {
      emit({ type: 'submit', provider: 'sora', label: 'AZURE_SORA', model, attempt: i + 1 });
      job = await createVideo({ endpoint, key, model, prompt, size, seconds: secs, inputReferencePng: firstFramePng, apiVersion });
      break;
    } catch (e) {
      // a 429 is a refusal, so retrying it cannot double-bill; a lost connection or a bare 5xx can
      if (e.status === 429 && i < 4) {
        const ms = Math.min(RATE_MAX_MS, RATE_BASE_MS * 2 ** i);
        emit({ type: 'wait', provider: 'sora', ms, reason: 'HTTP 429' });
        await sleep(ms);
        continue;
      }
      if (/moderation|content_policy|safety/i.test(e.message)) throw new ContentRejectedError('sora', 'moderation', e.message);
      if ((e.status === 0 && !PRE_SEND_ERRORS.has(e.errno)) || e.status >= 500 || (e.status >= 200 && e.status < 300)) {
        throw stopError('submit_unknown', `Sora submit got no usable answer (${e.status === 0 ? e.errno || 'network' : `HTTP ${e.status}`}); the job may exist — check Azure before resubmitting`, { provider: 'sora', status: e.status });
      }
      throw stopError(e.status === 0 ? 'unreachable' : 'invalid_request', e.message, { provider: 'sora', status: e.status });
    }
  }
  return finishSoraJob(ctx, job.id, secs);
}

// Explicit `undefined`/`null` options fall back to the defaults instead of overriding them.
const defined = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null));

function makeCtx(opts) {
  const emit = (e) => { if (typeof opts.onEvent === 'function') opts.onEvent(e); };
  return { ...opts, emit };
}

const DEFAULTS = { size: '720x1280', seconds: 5, pollIntervalMs: 15_000, pollTimeoutMs: 30 * 60_000, maxRateWaitMs: 120_000 };

/**
 * Generate ONE clip: try providers in VIDEO_PROVIDER_ORDER (default wan, sora). WAN rotates its
 * key pool and records exhaustion; when no WAN key is usable, the next provider (Sora) runs.
 * PAID CALL. firstFramePng seeds the clip (forward-chaining); lastFramePng (WAN only) pins the end.
 *
 * Throws (never resubmitting the leg) when retrying could pay twice or cannot help:
 *   ContentRejectedError                moderation — change the prompt/frame
 *   kind 'invalid_request'              malformed request, ModelNotFound or every WAN entry malformed (config)
 *   kind 'timeout' | 'download'         the task exists — call resumeClip({ ..., provider, label, taskId })
 *   kind 'submit_unknown' | 'task_lost' | 'no_video' | 'failed'  outcome unknown — check the console
 *                                       ('failed': the task ended for a reason the pool does not know)
 *   kind 'unreachable'                  Sora host refused the connection (nothing was sent)
 * @returns {Promise<{mp4:Buffer, provider:'wan'|'sora', label:string, model:string, seconds:number, taskId:string, usage:object|null}>}
 */
export async function generateClip(opts = {}) {
  const o = { ...DEFAULTS, statePath: defaultStatePath(), sleep: realSleep, now: Date.now, ...defined(opts) };
  if (!o.creds) throw new Error('generateClip: creds required (resolveCreds())');
  if (!o.prompt) throw new Error('generateClip: prompt required');
  const ctx = makeCtx(o);
  const tried = [];
  for (const p of o.order || parseProviderOrder(o.creds.VIDEO_PROVIDER_ORDER)) {
    if (p === 'wan') {
      tried.push('wan');
      const r = await runWan(ctx);
      if (r) return r;
    } else if (p === 'sora') {
      if (!o.creds.AZURE_SORA_ENDPOINT || !o.creds.AZURE_SORA_API_KEY) { ctx.emit({ type: 'skip', provider: 'sora', reason: 'AZURE_SORA_ENDPOINT/API_KEY missing' }); continue; }
      tried.push('sora');
      ctx.emit({ type: 'fallback', provider: 'sora', from: tried.slice(0, -1) });
      return runSora(ctx);
    }
  }
  throw new Error(`generateClip: no video provider available (tried: ${tried.join(', ') || 'none'})`);
}

/**
 * Finish a clip whose task already exists (after a 'timeout' or 'download' error) without
 * submitting anything new. FREE except for the work already billed. Same return shape as
 * generateClip. Pass the error's `seconds` (or the leg's) to have it echoed back in the result.
 */
export async function resumeClip(opts = {}) {
  // no default seconds here: an unknown length is reported from the task's usage, not invented
  const { seconds: _unused, ...defaults } = DEFAULTS;
  const o = { ...defaults, statePath: defaultStatePath(), sleep: realSleep, now: Date.now, ...defined(opts) };
  if (!o.creds || !o.taskId) throw new Error('resumeClip: creds and taskId required');
  const ctx = makeCtx(o);
  if (o.provider !== 'sora') return resumeWan(ctx, o);
  if (!originOf(o.creds.AZURE_SORA_ENDPOINT) || !o.creds.AZURE_SORA_API_KEY) {
    throw stopError('invalid_request', 'resumeClip: resuming a Sora job needs AZURE_SORA_ENDPOINT as an http(s) URL and AZURE_SORA_API_KEY (run 3d-intro-setup); nothing was sent', { provider: 'sora', taskId: o.taskId });
  }
  return finishSoraJob(ctx, o.taskId, o.seconds == null ? null : snapSoraSeconds(o.seconds));
}

async function resumeWan(ctx, o) {
  const e = loadWanPool(o.creds).find((x) => x.label === o.label);
  if (!e) throw new Error(`resumeClip: ${o.label} is not in the WAN pool (was the key removed?)`);
  if (e.badEndpoint) {
    throw stopError('invalid_request', `resumeClip: ${o.label} endpoint is not an http(s) URL; fix the env file — nothing was sent`, { provider: 'wan', label: o.label, taskId: o.taskId });
  }
  const out = await finishWanTask(ctx, e, o.taskId, { duration: Math.round(Number(o.seconds) || 0) || null });
  if (out.clip) return out.clip;
  throw stopError('failed', `WAN task ${o.taskId} (${o.label}) ended ${out.fail.code}: ${out.fail.message || ''}; it produced no clip — generate the leg again`, { provider: 'wan', taskId: o.taskId, label: o.label, code: out.fail.code });
}
