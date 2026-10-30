/*
 * Unit tests for the WAN key pool + Sora fallback (node:test + node:assert/strict). Filename ends
 * in .test.mjs so it is excluded from the npm package (see package.json "files").
 *
 * No network and no ffmpeg binary are required: globalThis.fetch and cp.spawnSync are stubbed
 * per-test and restored in afterEach. Only placeholder creds are used; pool state goes to a temp dir.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import util from 'node:util';
import * as P from './video-pool.mjs';

const WAN = (n) => `https://ws-unit${n}.example.com`;
const SORA = 'https://sora-unit.example.com';
const CREATE = '/api/v1/services/aigc/video-generation/video-synthesis';

const orig = { fetch: globalThis.fetch, spawnSync: cp.spawnSync, FFMPEG_PATH: process.env.FFMPEG_PATH };
const tmps = [];
afterEach(() => {
  globalThis.fetch = orig.fetch;
  cp.spawnSync = orig.spawnSync;
  if (orig.FFMPEG_PATH === undefined) delete process.env.FFMPEG_PATH; else process.env.FFMPEG_PATH = orig.FFMPEG_PATH;
  while (tmps.length) fs.rmSync(tmps.pop(), { recursive: true, force: true });
});
function tmpState() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'video-pool-test-'));
  tmps.push(d);
  return path.join(d, 'state.json');
}

function creds(extra = {}) {
  return {
    WAN_1_ENDPOINT: WAN(1), WAN_1_API_KEY: ('placeholder-wan' + '-key-1111'),
    WAN_2_ENDPOINT: WAN(2), WAN_2_API_KEY: ('placeholder-wan' + '-key-2222'),
    WAN_3_ENDPOINT: `${WAN(3)}/`, WAN_3_API_KEY: ('placeholder-wan' + '-key-3333'),
    AZURE_SORA_ENDPOINT: SORA, AZURE_SORA_API_KEY: ('placeholder-sora' + '-key-0000'),
    ...extra,
  };
}

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const MP4 = Buffer.from('fake-mp4-bytes');

// Minimal PNG header: signature + IHDR (only bytes 0..25 matter to the code under test).
function png(colorType) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12); b.writeUInt32BE(720, 16); b.writeUInt32BE(1280, 20);
  b[24] = 8; b[25] = colorType;
  return b;
}

// The WAN answer for a ws-unit URL: a submit gets a task (or wanCreate's answer), a poll SUCCEEDED
// (or wanTask's). null for another path.
function wanAnswer(m, call, { wanCreate, wanTask }, nextId) {
  if (m[2] === CREATE) {
    return (wanCreate && wanCreate(Number(m[1]), call)) || json(200, { request_id: 'r', output: { task_id: nextId(m[1]), task_status: 'PENDING' } });
  }
  if (!m[2].startsWith('/api/v1/tasks/')) return null;
  const id = decodeURIComponent(m[2].slice('/api/v1/tasks/'.length));
  return (wanTask && wanTask(id)) || json(200, { output: { task_id: id, task_status: 'SUCCEEDED', video_url: `https://oss.example.com/${id}.mp4` }, usage: { duration: 5 } });
}

// The download and Sora answers, or null for a URL no test serves.
function otherAnswer(u, opts, sora) {
  if (u.startsWith('https://oss.example.com/')) return new Response(MP4, { status: 200 });
  if (u.startsWith(`${SORA}/openai/v1/videos?`)) {
    if (opts.method !== 'POST') return json(200, { data: [] });
    return sora === 'ok' ? json(200, { id: 'sora-job-1', status: 'queued' }) : sora();
  }
  if (u.startsWith(`${SORA}/openai/v1/videos/sora-job-1/content`)) return new Response(MP4, { status: 200, headers: { 'content-type': 'video/mp4' } });
  if (u.startsWith(`${SORA}/openai/v1/videos/sora-job-1?`)) return json(200, { id: 'sora-job-1', status: 'completed' });
  return null;
}

/**
 * Route stubbed fetch calls. `wanCreate(n, call)` decides each WAN create response for entry n;
 * tasks succeed on first poll unless `wanTask(taskId)` says otherwise. Every call is recorded.
 */
function installFetch({ wanCreate, wanTask, sora = 'ok' } = {}) {
  const calls = [];
  let seq = 0;
  const nextId = (n) => `task-${n}-${++seq}`;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const call = { url: u, opts, body: opts.body && typeof opts.body === 'string' ? JSON.parse(opts.body) : opts.body };
    calls.push(call);
    const m = u.match(/^https:\/\/ws-unit(\d)\.example\.com(.*)$/);
    const r = (m && wanAnswer(m, call, { wanCreate, wanTask }, nextId)) || otherAnswer(u, opts, sora);
    if (r) return r;
    throw new Error(`unrouted fetch ${u}`);
  };
  return calls;
}

const creates = (calls) => calls.filter((c) => c.url.endsWith(CREATE));
// poolSummary's WAN rows (its last row is Sora's)
const wanRows = (summary) => summary.filter((e) => e.provider === 'wan');
const createdOn = (calls) => creates(calls).map((c) => Number(c.url.match(/ws-unit(\d)/)[1]));

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; }, sleep: async (ms) => { t += ms; } };
}

function run(opts) {
  const c = opts.clock || clock();
  return P.generateClip({
    prompt: 'glide forward', size: '720x1280', seconds: 5, pollIntervalMs: 0, pollTimeoutMs: 5,
    now: c.now, sleep: c.sleep, ...opts,
  });
}

// ---------------------------------------------------------------------------

test('loadWanPool: WAN_01_* and WAN_1_* stay separate entries; endpoints are reduced to their origin', () => {
  const pool = P.loadWanPool({
    WAN_01_ENDPOINT: WAN(1), WAN_01_API_KEY: 'k01',
    WAN_1_ENDPOINT: `${WAN(2)}/api/v1/services/aigc/video-generation/video-synthesis`, WAN_1_API_KEY: 'k1',
  });
  assert.deepEqual(pool.map((e) => [e.label, e.key, e.endpoint]), [['WAN_01', 'k01', WAN(1)], ['WAN_1', 'k1', WAN(2)]]);
});

test('loadWanPool: scans WAN_<n> entries in numeric order, trims endpoints, skips entries without a key', () => {
  const pool = P.loadWanPool({
    WAN_10_ENDPOINT: WAN(9), WAN_10_API_KEY: 'k10',
    WAN_2_ENDPOINT: `${WAN(2)}//`, WAN_2_API_KEY: 'k2', WAN_2_MODEL: 'wan3.0-video',
    WAN_5_ENDPOINT: WAN(5),
    WAN_MODEL: 'pool-model',
  });
  assert.deepEqual(pool.map((e) => e.label), ['WAN_2', 'WAN_10']);
  assert.equal(pool[0].endpoint, WAN(2));
  assert.equal(pool[0].model, 'wan3.0-video', 'per-entry model wins');
  assert.equal(pool[1].model, 'pool-model', 'pool-wide WAN_MODEL applies');
  assert.equal(P.loadWanPool({ WAN_1_ENDPOINT: WAN(1), WAN_1_API_KEY: 'k' })[0].model, P.WAN_DEFAULT_MODEL);
  assert.notEqual(pool[0].fp, P.loadWanPool({ WAN_2_ENDPOINT: WAN(2), WAN_2_API_KEY: 'rotated' })[0].fp, 'a rotated key gets a new fingerprint');
});

test('classifyWanError: documented codes map to pool actions; HTTP status is the fallback signal', () => {
  const cases = [
    [{ status: 401, code: 'InvalidApiKey' }, 'unusable'],
    [{ status: 403, code: 'Model.AccessDenied' }, 'denied'],
    [{ status: 404, code: 'ModelNotFound' }, 'invalid_request'],
    [{ status: 403, code: 'AllocationQuota.FreeTierOnly' }, 'exhausted'],
    [{ status: 403, code: 'AllocationQuota.SomethingNew' }, 'exhausted'],
    [{ status: 400, code: 'Arrearage' }, 'exhausted'],
    [{ status: 429, code: 'BudgetLimitExceeded' }, 'exhausted'],
    [{ status: 429, code: 'Throttling.RateQuota' }, 'rate'],
    [{ status: 429, code: 'Throttling.AllocationQuota' }, 'quota'],
    [{ status: 429, code: 'Throttling.ServiceOverloaded' }, 'transient'],
    [{ status: 400, code: 'DataInspectionFailed' }, 'content'],
    [{ status: 500, code: 'InternalError.Timeout' }, 'transient'],
    [{ status: 500, code: 'InvalidParameter' }, 'invalid_request'],
    [{ status: 401 }, 'denied'],
    [{ status: 403 }, 'denied'],
    [{ status: 429 }, 'rate'],
    [{ status: 0 }, 'transient'],
    [{ status: 503 }, 'transient'],
    [{ status: 400, code: 'SomethingNew' }, 'invalid_request'],
  ];
  for (const [input, want] of cases) assert.equal(P.classifyWanError(input), want, JSON.stringify(input));
});

test('wanParams: resolution and ratio follow the output size; a first frame switches ratio to adaptive', () => {
  assert.deepEqual(
    P.wanParams({ size: '720x1280', seconds: 5 }),
    { resolution: '720P', ratio: '9:16', duration: 5, audio: false, watermark: false, prompt_extend: false },
  );
  assert.equal(P.wanParams({ size: '1280x720', hasFrame: true }).ratio, 'adaptive');
  assert.equal(P.wanParams({ size: '1920x1080' }).resolution, '1080P');
  assert.equal(P.wanParams({ size: '480x854' }).resolution, '480P');
  assert.equal(P.wanParams({ size: '480x854' }).ratio, 'adaptive', 'non-standard aspect -> adaptive');
  assert.equal(P.wanParams({ seconds: 99 }).duration, 30);
  assert.equal(P.wanParams({ seconds: 1 }).duration, 2);
  assert.equal(P.wanParams({ creds: { WAN_RESOLUTION: '480P', WAN_PROMPT_EXTEND: 'true' } }).resolution, '480P');
  assert.equal(P.wanParams({ creds: { WAN_PROMPT_EXTEND: 'true' } }).prompt_extend, true);
});

test('generateClip: WAN success sends an async Bearer request with the first frame as a data URI', async () => {
  const calls = installFetch();
  const statePath = tmpState();
  const frame = png(2);
  const r = await run({ creds: creds(), statePath, firstFramePng: frame });
  assert.equal(r.provider, 'wan');
  assert.equal(r.label, 'WAN_1');
  assert.ok(r.mp4.equals(MP4));
  const c = creates(calls)[0];
  assert.equal(c.opts.headers.Authorization, 'Bearer placeholder-wan-key-1111');
  assert.equal(c.opts.headers['X-DashScope-Async'], 'enable');
  assert.equal(c.body.model, P.WAN_DEFAULT_MODEL);
  assert.deepEqual(c.body.input.media, [{ type: 'first_frame', url: `data:image/png;base64,${frame.toString('base64')}` }]);
  assert.equal(c.body.parameters.ratio, 'adaptive');
  assert.equal(P.poolSummary({ creds: creds(), statePath })[0].okCount, 1);
  const raw = fs.readFileSync(statePath, 'utf8');
  assert.ok(!raw.includes('placeholder-wan-key'), 'state file never holds a key');
});

// 0.20.5 review: creds from a project key file git tracks may have come with the repository (its endpoint receives the
// prompt and the frames). The build stops on them in code, not only by the skill's words.
test('generateClip: creds from a key file git tracks are refused before anything is sent', async () => {
  const calls = installFetch();
  await assert.rejects(run({ creds: { ...creds(), _tracked: true, _source: '/repo/.env.3d-intro.local' }, statePath: tmpState() }),
    (e) => e.kind === 'invalid_request' && /tracked by git/.test(e.message) && e.message.includes('/repo/.env.3d-intro.local'));
  assert.deepEqual(calls, []);
});

test('generateClip: requests rotate least-recently-used across the pool', async () => {
  const calls = installFetch();
  const statePath = tmpState();
  const c = clock();
  for (let i = 0; i < 4; i++) { await run({ creds: creds(), statePath, clock: c }); c.advance(1000); }
  assert.deepEqual(createdOn(calls), [1, 2, 3, 1]);
});

test('generateClip: an exhausted key is retired (and stays retired across runs); the next key serves', async () => {
  const calls = installFetch({
    wanCreate: (n) => (n === 1 ? json(403, { code: 'AllocationQuota.FreeTierOnly', message: 'The free tier of the model has been exhausted.' }) : null),
  });
  const statePath = tmpState();
  const c = clock();
  const r = await run({ creds: creds(), statePath, clock: c });
  assert.equal(r.label, 'WAN_2');
  const s = P.poolSummary({ creds: creds(), statePath, now: c.now() });
  assert.equal(s[0].status, 'exhausted');
  assert.equal(s[0].reason, 'AllocationQuota.FreeTierOnly');
  c.advance(60_000);
  await run({ creds: creds(), statePath, clock: c });
  assert.deepEqual(createdOn(calls), [1, 2, 3], 'second run never touches the exhausted WAN_1');
  c.advance(25 * 3_600_000);
  assert.equal(P.poolSummary({ creds: creds(), statePath, now: c.now() })[0].status, 'ok', 'after WAN_EXHAUSTED_TTL_HOURS the key is retried');
});

test('generateClip: a request-rate 429 only cools the key down (Retry-After honored), never retires it', async () => {
  installFetch({ wanCreate: (n) => (n === 1 ? json(429, { code: 'Throttling.RateQuota' }, { 'retry-after': '7' }) : null) });
  const statePath = tmpState();
  const c = clock();
  const cr = creds({ WAN_2_ENDPOINT: undefined, WAN_3_ENDPOINT: undefined, AZURE_SORA_ENDPOINT: undefined });
  const events = [];
  await assert.rejects(() => run({ creds: cr, statePath, clock: c, maxRateWaitMs: 60_000, onEvent: (e) => events.push(e) }), /no video provider/);
  const waits = events.filter((e) => e.type === 'wait').map((e) => e.ms);
  assert.ok(waits.length >= 3 && waits.every((ms) => ms === 7000), 'waited the server Retry-After between attempts');
  assert.equal(P.poolSummary({ creds: cr, statePath, now: c.now() })[0].status, 'cooldown');
});

test('generateClip: three straight Throttling.AllocationQuota hits rest a key for 1 h; stale strikes are forgotten', async () => {
  installFetch({ wanCreate: (n) => (n === 1 ? json(429, { code: 'Throttling.AllocationQuota' }, { 'retry-after': '5' }) : null) });
  const statePath = tmpState();
  const c = clock();
  const cr = creds({ WAN_2_ENDPOINT: undefined, WAN_3_ENDPOINT: undefined, AZURE_SORA_ENDPOINT: undefined });
  await assert.rejects(() => run({ creds: cr, statePath, clock: c }), /no video provider/);
  let s = P.poolSummary({ creds: cr, statePath, now: c.now() })[0];
  assert.equal(s.status, 'exhausted');
  assert.match(s.reason, /Throttling.AllocationQuota x3/);
  assert.equal(P.poolSummary({ creds: cr, statePath, now: c.now() + 3_600_001 })[0].status, 'ok', 'rests 1 h, not 24 h');
  c.advance(3_600_001);
  await assert.rejects(() => run({ creds: cr, statePath, clock: c, maxRateWaitMs: 0 }), /no video provider/);
  s = P.poolSummary({ creds: cr, statePath, now: c.now() })[0];
  assert.equal(s.status, 'cooldown', 'one hit after the rest is strike 1 again, not an instant retirement');
});

test('generateClip: a provider-wide ServiceOverloaded never retires keys', async () => {
  installFetch({ wanCreate: () => json(429, { code: 'Throttling.ServiceOverloaded' }) });
  const statePath = tmpState();
  const c = clock();
  const r = await run({ creds: creds(), statePath, clock: c, maxRateWaitMs: 0 });
  assert.equal(r.provider, 'sora');
  assert.ok(wanRows(P.poolSummary({ creds: creds(), statePath, now: c.now() })).every((e) => e.status === 'cooldown'));
  assert.ok(P.poolSummary({ creds: creds(), statePath, now: c.now() + 3_600_000 }).every((e) => e.status === 'ok'));
});

test('generateClip: a long cooldown is not waited out; the pool reports unavailable and Sora takes over', async () => {
  const calls = installFetch({ wanCreate: () => json(429, { code: 'Throttling' }, { 'retry-after': '600' }) });
  const statePath = tmpState();
  const events = [];
  const r = await run({ creds: creds(), statePath, maxRateWaitMs: 120_000, onEvent: (e) => events.push(e) });
  assert.equal(r.provider, 'sora');
  assert.deepEqual(createdOn(calls), [1, 2, 3], 'each WAN key tried once before falling back');
  assert.ok(events.some((e) => e.type === 'pool-unavailable'));
  assert.ok(events.some((e) => e.type === 'fallback' && e.provider === 'sora'));
});

test('generateClip: when every WAN key is exhausted, Sora renders with the first frame and snapped seconds', async () => {
  const calls = installFetch({ wanCreate: () => json(400, { code: 'Arrearage' }) });
  const statePath = tmpState();
  const c = clock();
  const r = await run({ creds: creds(), statePath, clock: c, firstFramePng: png(2), seconds: 5 });
  assert.equal(r.provider, 'sora');
  assert.equal(r.seconds, 4, 'Sora accepts 4/8/12 s; 5 snaps to 4');
  assert.ok(r.mp4.equals(MP4));
  const post = calls.find((c) => c.url.startsWith(`${SORA}/openai/v1/videos?`) && c.opts.method === 'POST');
  assert.equal(post.body.get('seconds'), '4');
  assert.ok(post.body.get('input_reference'), 'first frame forwarded as input_reference');
  assert.ok(wanRows(P.poolSummary({ creds: creds(), statePath, now: c.now() })).every((e) => e.status === 'exhausted'));
});

test('generateClip: a quota code on a FAILED task retires the key and resubmits on the next one', async () => {
  const calls = installFetch({
    wanTask: (id) => (id.startsWith('task-1-') ? json(200, { output: { task_id: id, task_status: 'FAILED', code: 'AllocationQuota.FreeTierOnly', message: 'exhausted' } }) : null),
  });
  const statePath = tmpState();
  const c = clock();
  const r = await run({ creds: creds(), statePath, clock: c });
  assert.equal(r.label, 'WAN_2');
  assert.deepEqual(createdOn(calls), [1, 2]);
  assert.equal(P.poolSummary({ creds: creds(), statePath, now: c.now() })[0].status, 'exhausted');
});

test('generateClip: content moderation stops immediately — no other key, no Sora', async () => {
  const calls = installFetch({ wanCreate: () => json(400, { code: 'DataInspectionFailed', message: 'Input data may contain inappropriate content.' }) });
  await assert.rejects(() => run({ creds: creds(), statePath: tmpState() }), (e) => e instanceof P.ContentRejectedError && e.code === 'DataInspectionFailed');
  assert.equal(creates(calls).length, 1);
  assert.ok(!calls.some((c) => c.url.startsWith(SORA)));
});

test('generateClip: ModelNotFound is a config error — thrown, and no key is blamed for it', async () => {
  const calls = installFetch({ wanCreate: () => json(404, { code: 'ModelNotFound', message: 'Model not exist.' }) });
  const statePath = tmpState();
  await assert.rejects(() => run({ creds: creds(), statePath }), (e) => e.kind === 'invalid_request' && e.code === 'ModelNotFound');
  assert.equal(creates(calls).length, 1);
  assert.ok(P.poolSummary({ creds: creds(), statePath }).every((e) => e.status === 'ok'));
  assert.notEqual(P.loadWanPool(creds())[0].fp, P.loadWanPool(creds({ WAN_MODEL: 'other' }))[0].fp, 'model is part of the fingerprint');
});

test('generateClip: InvalidParameter is a request bug — thrown without burning other keys', async () => {
  const calls = installFetch({ wanCreate: () => json(400, { code: 'InvalidParameter', message: 'bad media' }) });
  const statePath = tmpState();
  await assert.rejects(() => run({ creds: creds(), statePath }), (e) => e.kind === 'invalid_request' && e.code === 'InvalidParameter');
  assert.equal(creates(calls).length, 1);
  assert.equal(P.poolSummary({ creds: creds(), statePath })[0].status, 'ok', 'the key is not blamed');
});

test('generateClip: a poll timeout throws with the taskId and never submits a duplicate', async () => {
  const calls = installFetch({ wanTask: (id) => json(200, { output: { task_id: id, task_status: 'RUNNING' } }) });
  await assert.rejects(() => run({ creds: creds(), statePath: tmpState(), pollIntervalMs: 1, pollTimeoutMs: 3 }), (e) => e.kind === 'timeout' && e.taskId === 'task-1-1');
  assert.equal(creates(calls).length, 1);
});

test('generateClip: an invalid key is retired permanently and the next key serves', async () => {
  installFetch({ wanCreate: (n) => (n === 1 ? json(401, { code: 'InvalidApiKey' }) : null) });
  const statePath = tmpState();
  const c = clock();
  const r = await run({ creds: creds(), statePath, clock: c });
  assert.equal(r.label, 'WAN_2');
  c.advance(100 * 3_600_000);
  assert.equal(P.poolSummary({ creds: creds(), statePath, now: c.now() })[0].status, 'invalid');
});

test('generateClip: VIDEO_PROVIDER_ORDER=sora skips WAN; missing providers end in a clear error', async () => {
  const calls = installFetch();
  const r = await run({ creds: creds({ VIDEO_PROVIDER_ORDER: 'sora' }), statePath: tmpState() });
  assert.equal(r.provider, 'sora');
  assert.equal(creates(calls).length, 0);
  await assert.rejects(() => run({ creds: { WAN_1_ENDPOINT: WAN(1) }, statePath: tmpState() }), /no video provider available/);
});

test('defaultClipMode: dive without exits on any provider, WAN marked not measured; a run that cannot make a leg gets null', () => {
  const statePath = tmpState();
  const mode = (c, o = {}) => P.defaultClipMode(c, { statePath, ...o }).mode;
  const sora = { AZURE_SORA_ENDPOINT: SORA, AZURE_SORA_API_KEY: creds().AZURE_SORA_API_KEY };
  assert.equal(mode(sora), 'dive', 'no WAN entry: the video runs on Sora');
  assert.equal(mode(creds()), 'dive', 'WAN entries first (default order wan,sora): dive too');
  assert.deepEqual((({ exit, provider, measured }) => ({ exit, provider, measured }))(P.defaultClipMode(creds(), { statePath })), { exit: false, provider: 'wan', measured: false }, 'WAN: not measured');
  assert.deepEqual((({ exit, provider, measured }) => ({ exit, provider, measured }))(P.defaultClipMode(sora, { statePath })), { exit: false, provider: 'sora', measured: true });
  assert.equal(mode(creds({ VIDEO_PROVIDER_ORDER: 'sora' })), 'dive', 'order sora: Sora runs even with WAN keys');
  assert.equal(mode(creds({ VIDEO_PROVIDER_ORDER: 'wan' })), 'dive');
  assert.equal(mode({ WAN_1_ENDPOINT: WAN(1), WAN_1_API_KEY: 'k' }), 'dive', 'WAN only');
  const bad = { WAN_1_ENDPOINT: 'http://ws.example.com', WAN_1_API_KEY: 'k', ...sora };
  const r = P.defaultClipMode(bad, { statePath });
  assert.deepEqual([r.mode, r.provider], [null, 'wan'], 'every WAN entry malformed: generateClip stops, Sora is not used');
  assert.match(r.reason, /does not use Sora/);
  assert.equal(mode({ ...sora, VIDEO_PROVIDER_ORDER: 'wan' }), null, 'order wan without a WAN entry: nothing runs');
  assert.equal(mode({ ...sora, AZURE_SORA_ENDPOINT: 'http://sora.example.com' }), null, 'a Sora endpoint that is not https stops the leg');
  assert.equal(mode({}), null, 'nothing set up');
  // a Sora deployment recorded retired is skipped as generateClip skips it: a WAN entry after it takes over
  const fp = `sora:${crypto.createHash('sha256').update(`${SORA}\nsora-2`).digest('hex').slice(0, 16)}`;
  P.savePoolState({ version: 1, entries: { [fp]: { status: 'retired', retiredAt: Date.now(), label: 'AZURE_SORA' } } }, statePath);
  assert.equal(mode(sora), null, 'Sora retired, no WAN: stop before any paid still');
  assert.equal(P.defaultClipMode(creds({ VIDEO_PROVIDER_ORDER: 'sora,wan' }), { statePath }).provider, 'wan', 'Sora retired: WAN takes over');
  assert.equal(mode(sora, { now: Date.now() + 25 * 3_600_000 }), 'dive', 'the record lasts 24 h');
});

test('generateClip: lastFramePng is sent as last_frame on WAN and needs a first frame', async () => {
  const calls = installFetch();
  await run({ creds: creds(), statePath: tmpState(), firstFramePng: png(2), lastFramePng: png(2) });
  assert.deepEqual(creates(calls)[0].body.input.media.map((m) => m.type), ['first_frame', 'last_frame']);
  await assert.rejects(() => P.wanCreateTask({ entry: P.loadWanPool(creds())[0], prompt: 'x', lastFramePng: png(2) }), /needs firstFramePng/);
});

test('resetPoolState: clears one label or the whole pool', async () => {
  installFetch({ wanCreate: (n) => (n <= 2 ? json(403, { code: 'AllocationQuota.FreeTierOnly' }) : null) });
  const statePath = tmpState();
  const c = clock();
  await run({ creds: creds(), statePath, clock: c });
  P.resetPoolState({ statePath, creds: creds(), labels: ['WAN_1'] });
  assert.deepEqual(wanRows(P.poolSummary({ creds: creds(), statePath, now: c.now() })).map((e) => e.status), ['ok', 'exhausted', 'ok']);
  P.resetPoolState({ statePath });
  assert.ok(P.poolSummary({ creds: creds(), statePath, now: c.now() }).every((e) => e.status === 'ok'));
});

test('probeWanPool: GET of a nonexistent task tells valid keys (200) from invalid ones (401), keys redacted', async () => {
  globalThis.fetch = async (url, opts) => {
    assert.match(String(url), /\/api\/v1\/tasks\/0{8}-/);
    return opts.headers.Authorization.endsWith('2222')
      ? json(401, { code: 'InvalidApiKey', message: 'Invalid API-key provided.' })
      : json(200, { output: { task_status: 'UNKNOWN' } });
  };
  const r = await P.probeWanPool({ creds: creds() });
  assert.deepEqual(r.map((x) => [x.label, x.status, x.authOk]), [['WAN_1', 200, true], ['WAN_2', 401, false], ['WAN_3', 200, true]]);
  assert.equal(r[1].code, 'InvalidApiKey');
  assert.ok(r.every((x) => !x.key.includes('placeholder-wan-key')));
});

test('frameDataUri: RGB PNG passes through; RGBA PNG is flattened via ffmpeg; JPEG keeps its MIME', async () => {
  const rgb = png(2);
  assert.equal(await P.frameDataUri(rgb), `data:image/png;base64,${rgb.toString('base64')}`);
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'video-pool-ff-'));
  tmps.push(d);
  process.env.FFMPEG_PATH = path.join(d, 'ffmpeg');
  fs.writeFileSync(process.env.FFMPEG_PATH, '');
  const flat = png(2);
  let args;
  cp.spawnSync = (_bin, a) => { args = a; fs.writeFileSync(a[a.length - 1], flat); return { status: 0, stdout: '', stderr: '' }; };
  assert.equal(await P.frameDataUri(png(6)), `data:image/png;base64,${flat.toString('base64')}`);
  assert.ok(args.includes('format=rgb24'));
  assert.match(await P.frameDataUri(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), /^data:image\/jpeg;base64,/);
});

test('snapSoraSeconds / parseProviderOrder', () => {
  assert.deepEqual([3, 5, 6, 7, 10, 30].map(P.snapSoraSeconds), [4, 4, 4, 8, 8, 12]);
  assert.deepEqual(P.parseProviderOrder(''), ['wan', 'sora']);
  assert.deepEqual(P.parseProviderOrder(' Sora , wan, x, sora'), ['sora', 'wan']);
});

// ---- billing-safety regressions: none of these may submit the same leg twice ----

function netError(code) {
  const e = new TypeError('fetch failed');
  e.cause = Object.assign(new Error(code), { code });
  return e;
}

test('generateClip: a lost connection on submit is not resubmitted to another key (could bill twice)', async () => {
  const calls = installFetch({ wanCreate: () => { throw netError('ECONNRESET'); } });
  await assert.rejects(() => run({ creds: creds(), statePath: tmpState() }), (e) => e.kind === 'submit_unknown' && e.label === 'WAN_1');
  assert.equal(creates(calls).length, 1);
  assert.ok(!calls.some((c) => c.url.startsWith(SORA)));
});

test('generateClip: a connection refused before sending moves on to the next key', async () => {
  const calls = installFetch({ wanCreate: (n) => { if (n === 1) throw netError('ECONNREFUSED'); return null; } });
  const r = await run({ creds: creds(), statePath: tmpState() });
  assert.equal(r.label, 'WAN_2');
  assert.deepEqual(createdOn(calls), [1, 2]);
});

test('generateClip: a failed download after SUCCEEDED keeps the taskId and signed URL for recovery and records the success', async () => {
  const realFetch = installFetch();
  const routed = globalThis.fetch;
  globalThis.fetch = async (url, opts) => (String(url).startsWith('https://oss.example.com/') ? new Response('', { status: 503 }) : routed(url, opts));
  const statePath = tmpState();
  await assert.rejects(() => run({ creds: creds(), statePath }), (e) => {
    assert.equal(e.kind, 'download');
    assert.equal(e.taskId, 'task-1-1');
    assert.equal(e.label, 'WAN_1');
    assert.equal(e.videoUrl, 'https://oss.example.com/task-1-1.mp4');
    assert.ok(!e.message.includes('oss.example.com'), 'signed URL stays out of the message');
    assert.ok(!JSON.stringify(e).includes('oss.example.com'), 'nor in a JSON log of the error');
    assert.ok(!util.inspect(e).includes('oss.example.com'), 'nor in console.error(e)');
    return true;
  });
  assert.equal(creates(realFetch).length, 1);
  assert.equal(P.poolSummary({ creds: creds(), statePath })[0].okCount, 1);
  globalThis.fetch = routed;
  assert.ok((await P.downloadWanVideo('https://oss.example.com/task-1-1.mp4')).equals(MP4));
});

test('generateClip: SUCCEEDED without video_url is reported, not resubmitted', async () => {
  const calls = installFetch({ wanTask: (id) => json(200, { output: { task_id: id, task_status: 'SUCCEEDED' } }) });
  await assert.rejects(() => run({ creds: creds(), statePath: tmpState() }), (e) => e.kind === 'no_video' && e.taskId === 'task-1-1');
  assert.equal(creates(calls).length, 1);
});

test('generateClip: an unwritable pool state never costs a finished clip', async () => {
  installFetch();
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'video-pool-ro-'));
  tmps.push(d);
  const blocker = path.join(d, 'not-a-dir');
  fs.writeFileSync(blocker, '');
  const events = [];
  const r = await run({ creds: creds(), statePath: path.join(blocker, 'state.json'), onEvent: (e) => events.push(e) });
  assert.equal(r.provider, 'wan');
  assert.ok(r.mp4.equals(MP4));
  assert.ok(events.some((e) => e.type === 'state-error'));
});

test('generateClip: poll answers 404 / 401 / UNKNOWN end the leg with the taskId instead of resubmitting', async () => {
  for (const [answer, check] of [
    [() => json(404, { code: 'NotFound' }), (e) => e.kind === 'task_lost' && e.status === 404],
    [() => json(401, { code: 'InvalidApiKey' }), (e) => e.kind === 'task_lost' && e.status === 401],
    [(id) => json(200, { output: { task_id: id, task_status: 'UNKNOWN' } }), (e) => e.kind === 'task_lost'],
  ]) {
    const calls = installFetch({ wanTask: answer });
    const statePath = tmpState();
    await assert.rejects(() => run({ creds: creds(), statePath, pollIntervalMs: 1, pollTimeoutMs: 100 }), (e) => check(e) && e.taskId === 'task-1-1');
    assert.equal(creates(calls).length, 1);
    if (answer().status === 401) assert.equal(P.poolSummary({ creds: creds(), statePath })[0].status, 'invalid');
  }
});

test('generateClip: a Sora job still running at the poll deadline throws kind timeout with its id', async () => {
  const calls = installFetch({ wanCreate: () => json(400, { code: 'Arrearage' }) });
  const routed = globalThis.fetch;
  globalThis.fetch = async (url, opts) => (String(url).startsWith(`${SORA}/openai/v1/videos/sora-job-1?`) ? json(200, { id: 'sora-job-1', status: 'in_progress' }) : routed(url, opts));
  await assert.rejects(() => run({ creds: creds(), statePath: tmpState(), pollIntervalMs: 1, pollTimeoutMs: 3 }), (e) => e.kind === 'timeout' && e.provider === 'sora' && e.taskId === 'sora-job-1');
  assert.equal(calls.filter((c) => c.url.startsWith(`${SORA}/openai/v1/videos?`) && c.opts.method === 'POST').length, 1);
});

test('resumeClip: finishes a timed-out WAN task without submitting anything', async () => {
  let ready = false;
  const calls = installFetch({ wanTask: (id) => (ready ? null : json(200, { output: { task_id: id, task_status: 'RUNNING' } })) });
  const statePath = tmpState();
  let err;
  await run({ creds: creds(), statePath, pollIntervalMs: 1, pollTimeoutMs: 3 }).catch((e) => { err = e; });
  assert.equal(err.kind, 'timeout');
  ready = true;
  const r = await P.resumeClip({ creds: creds(), statePath, provider: err.provider, label: err.label, taskId: err.taskId, seconds: 5, pollIntervalMs: 0, sleep: async () => {} });
  assert.equal(r.provider, 'wan');
  assert.equal(r.taskId, 'task-1-1');
  assert.equal(creates(calls).length, 1, 'resume never submits');
  await assert.rejects(() => P.resumeClip({ creds: creds(), label: 'WAN_9', taskId: 'x' }), /not in the WAN pool/);
});

test('generateClip: a key at its in-flight limit is waited for even when maxRateWaitMs is 0', async () => {
  let polls = 0;
  const calls = installFetch({ wanTask: (id) => (++polls < 3 ? json(200, { output: { task_id: id, task_status: 'RUNNING' } }) : null) });
  const cr = creds({ WAN_2_ENDPOINT: undefined, WAN_3_ENDPOINT: undefined, WAN_MAX_CONCURRENT: '1' });
  const statePath = tmpState();
  const sleep = () => new Promise((r) => setImmediate(r));
  const events = [];
  const [a, b] = await Promise.all([
    run({ creds: cr, statePath, sleep, maxRateWaitMs: 0, pollTimeoutMs: 1000, pollIntervalMs: 1 }),
    run({ creds: cr, statePath, sleep, maxRateWaitMs: 0, pollTimeoutMs: 1000, pollIntervalMs: 1, onEvent: (e) => events.push(e) }),
  ]);
  assert.ok(events.some((e) => e.type === 'wait' && /in-flight/.test(e.reason)), 'second leg waited on the busy key');
  assert.deepEqual([a.provider, b.provider], ['wan', 'wan'], 'neither leg fell back to paid Sora');
  assert.equal(creates(calls).length, 2);
});

test('generateClip: a lost connection on the Sora submit stops with submit_unknown; a refused one is unreachable', async () => {
  for (const [code, kind] of [['ECONNRESET', 'submit_unknown'], ['ECONNREFUSED', 'unreachable']]) {
    const calls = installFetch({ sora: () => { throw netError(code); } });
    await assert.rejects(() => run({ creds: creds({ VIDEO_PROVIDER_ORDER: 'sora' }), statePath: tmpState() }), (e) => e.kind === kind && e.provider === 'sora');
    assert.equal(calls.filter((c) => c.url.startsWith(`${SORA}/openai/v1/videos?`) && c.opts.method === 'POST').length, 1);
  }
});

test('generateClip: a bare gateway 5xx or a 2xx without task_id on submit is ambiguous — no resubmit', async () => {
  for (const answer of [() => new Response('<html>502 Bad Gateway</html>', { status: 502 }), () => json(200, { request_id: 'r', output: {} })]) {
    const calls = installFetch({ wanCreate: answer });
    await assert.rejects(() => run({ creds: creds(), statePath: tmpState() }), (e) => e.kind === 'submit_unknown' && e.label === 'WAN_1');
    assert.equal(creates(calls).length, 1);
  }
  const calls = installFetch({ wanCreate: (n) => (n === 1 ? json(500, { code: 'InternalError', message: 'x' }) : null) });
  assert.equal((await run({ creds: creds(), statePath: tmpState() })).label, 'WAN_2', 'a coded DashScope 5xx is a refusal and moves on');
  assert.deepEqual(createdOn(calls), [1, 2]);
});

test('loadWanPool / probeWanPool / generateClip: an endpoint without a scheme is skipped and reported, not fatal', async () => {
  const cr = creds({ WAN_1_ENDPOINT: 'ws-unit1.example.com' });
  assert.equal(P.loadWanPool(cr)[0].badEndpoint, true);
  installFetch();
  const probe = await P.probeWanPool({ creds: cr });
  assert.deepEqual([probe[0].code, probe[0].authOk], ['BadEndpoint', false]);
  const events = [];
  const r = await run({ creds: cr, statePath: tmpState(), onEvent: (e) => events.push(e) });
  assert.equal(r.label, 'WAN_2');
  assert.ok(events.some((e) => e.type === 'skip' && e.label === 'WAN_1'));
});

test('generateClip: explicit undefined options keep the defaults; WAN_MAX_CONCURRENT below 1 is clamped', async () => {
  const calls = installFetch({ wanCreate: (n) => (n === 1 ? json(429, { code: 'Throttling' }, { 'retry-after': '1' }) : null) });
  const cr = creds({ WAN_2_ENDPOINT: undefined, WAN_3_ENDPOINT: undefined, WAN_MAX_CONCURRENT: '-1' });
  let n = 0;
  globalThis.fetch = ((inner) => async (url, opts) => {
    if (String(url).endsWith(CREATE) && ++n > 1) return json(200, { output: { task_id: 'task-1-9', task_status: 'PENDING' } });
    return inner(url, opts);
  })(globalThis.fetch);
  const r = await run({ creds: cr, statePath: tmpState(), maxRateWaitMs: undefined, pollIntervalMs: undefined, pollTimeoutMs: undefined });
  assert.equal(r.provider, 'wan', 'the 1 s cooldown was waited out (default maxRateWaitMs), not skipped to paid Sora');
  assert.equal(n, 2, 'one 429, then one accepted submit');
  assert.equal(creates(calls).length, 1, 'only the 429 reached the base router');
});

test('resumeClip: resuming after a failed download counts the task once and echoes seconds', async () => {
  installFetch();
  const routed = globalThis.fetch;
  globalThis.fetch = async (url, opts) => (String(url).startsWith('https://oss.example.com/') ? new Response('', { status: 503 }) : routed(url, opts));
  const statePath = tmpState();
  let err;
  await run({ creds: creds(), statePath }).catch((e) => { err = e; });
  assert.equal(err.kind, 'download');
  globalThis.fetch = routed;
  const r = await P.resumeClip({ creds: creds(), statePath, provider: err.provider, label: err.label, taskId: err.taskId, seconds: err.seconds, pollIntervalMs: 0, sleep: async () => {} });
  assert.equal(r.seconds, 5);
  assert.equal(P.poolSummary({ creds: creds(), statePath })[0].okCount, 1);
});

test('round-3: Sora 2xx without id is ambiguous; resume reports the real length; null options keep defaults', async () => {
  installFetch({ sora: () => json(200, { status: 'queued' }) });
  await assert.rejects(() => run({ creds: creds({ VIDEO_PROVIDER_ORDER: 'sora' }), statePath: tmpState() }), (e) => e.kind === 'submit_unknown' && e.provider === 'sora');
  installFetch({ wanTask: (id) => json(200, { output: { task_id: id, task_status: 'SUCCEEDED', video_url: `https://oss.example.com/${id}.mp4` }, usage: { duration: 8 } }) });
  const r = await P.resumeClip({ creds: creds(), statePath: tmpState(), provider: 'wan', label: 'WAN_2', taskId: 'task-2-7', pollIntervalMs: 0, sleep: async () => {} });
  assert.equal(r.seconds, 8, 'taken from usage.duration, not a default');
  installFetch({ wanCreate: (n) => (n === 1 ? json(429, { code: 'Throttling' }, { 'retry-after': '1' }) : null) });
  const cr = creds({ WAN_2_ENDPOINT: undefined, WAN_3_ENDPOINT: undefined });
  const events = [];
  await run({ creds: cr, statePath: tmpState(), maxRateWaitMs: null, onEvent: (e) => events.push(e) }).catch(() => {});
  assert.ok(events.some((e) => e.type === 'wait' && e.ms === 1000), 'null maxRateWaitMs fell back to the default and waited');
});

// ---------------------------------------------------------------------------
// Review fixes: Sora resume, malformed entries, FAILED tasks, keys in output

test('resumeClip: a Sora job the server no longer knows ends at once as task_lost, not after a 30-minute poll', async () => {
  let polls = 0;
  globalThis.fetch = async (url) => {
    if (String(url).startsWith(`${SORA}/openai/v1/videos/gone-job?`)) { polls++; return json(404, { error: { code: 'NotFound', message: 'not found' } }); }
    throw new Error(`unrouted fetch ${url}`);
  };
  await assert.rejects(
    () => P.resumeClip({ creds: creds(), statePath: tmpState(), provider: 'sora', taskId: 'gone-job', pollIntervalMs: 1, pollTimeoutMs: 50, sleep: async () => {} }),
    (e) => e.kind === 'task_lost' && e.provider === 'sora' && e.taskId === 'gone-job' && e.status === 404,
  );
  assert.equal(polls, 1);
});

test('resumeClip: a Sora resume without Sora creds stops before sending anything', async () => {
  const calls = installFetch();
  await assert.rejects(
    () => P.resumeClip({ creds: creds({ AZURE_SORA_API_KEY: undefined }), statePath: tmpState(), provider: 'sora', taskId: 'sora-job-1', pollIntervalMs: 1, pollTimeoutMs: 50, sleep: async () => {} }),
    (e) => e.kind === 'invalid_request' && e.provider === 'sora',
  );
  assert.equal(calls.length, 0);
});

test('loadWanPool: an inline "# comment" left in an endpoint or a model marks that entry bad', () => {
  const pool = P.loadWanPool({
    WAN_1_ENDPOINT: `${WAN(1)}     # origin only`, WAN_1_API_KEY: 'k1',
    WAN_2_ENDPOINT: WAN(2), WAN_2_API_KEY: 'k2', WAN_2_MODEL: 'wan3.0-video-prime          # optional',
    WAN_3_ENDPOINT: `${WAN(3)}#console`, WAN_3_API_KEY: 'k3',
  });
  assert.deepEqual(pool.map((e) => [e.label, !!e.badEndpoint, !!e.badModel]), [['WAN_1', true, false], ['WAN_2', false, true], ['WAN_3', false, false]]);
  assert.equal(pool[2].endpoint, WAN(3), 'a fragment is not part of the origin');
});

test('generateClip: when every configured WAN entry is malformed it stops with invalid_request instead of paying for Sora', async () => {
  const calls = installFetch();
  const cr = creds({ WAN_1_ENDPOINT: `${WAN(1)}   # note`, WAN_2_ENDPOINT: 'ws-unit2.example.com', WAN_3_MODEL: 'wan3.0 # x' });
  const events = [];
  await assert.rejects(
    () => run({ creds: cr, statePath: tmpState(), onEvent: (e) => events.push(e) }),
    (e) => e.kind === 'invalid_request' && e.provider === 'wan' && /WAN_1/.test(e.message) && /WAN_3/.test(e.message),
  );
  assert.equal(calls.length, 0, 'neither WAN nor Sora was called');
  assert.equal(events.filter((e) => e.type === 'skip' && e.provider === 'wan' && e.label).length, 3);
});

test('generateClip: a FAILED or CANCELED task without a recognized code stops with its taskId instead of resubmitting', async () => {
  for (const output of [{ task_status: 'FAILED', code: 'SomeNewError', message: 'x' }, { task_status: 'FAILED' }, { task_status: 'CANCELED' }]) {
    const calls = installFetch({ wanTask: (id) => json(200, { output: { task_id: id, ...output } }) });
    await assert.rejects(
      () => run({ creds: creds(), statePath: tmpState() }),
      (e) => e.kind === 'failed' && e.provider === 'wan' && e.taskId === 'task-1-1' && e.label === 'WAN_1',
    );
    assert.equal(creates(calls).length, 1, `${output.task_status} ${output.code || '(no code)'} is not resubmitted`);
    assert.ok(!calls.some((c) => c.url.startsWith(SORA)), 'and not handed to Sora');
  }
});

test('generateClip: a FAILED task with a known transient code moves on; a moderation code stops', async () => {
  let calls = installFetch({ wanTask: (id) => (id.startsWith('task-1-') ? json(200, { output: { task_id: id, task_status: 'FAILED', code: 'InternalError.Timeout', message: 'x' } }) : null) });
  assert.equal((await run({ creds: creds(), statePath: tmpState() })).label, 'WAN_2');
  assert.deepEqual(createdOn(calls), [1, 2]);
  calls = installFetch({ wanTask: (id) => json(200, { output: { task_id: id, task_status: 'FAILED', code: 'DataInspectionFailed', message: 'x' } }) });
  await assert.rejects(() => run({ creds: creds(), statePath: tmpState() }), (e) => e instanceof P.ContentRejectedError);
  assert.equal(creates(calls).length, 1);
});

test('poolSummary / probeWanPool: a malformed endpoint is never echoed, since it may hold a pasted key', async () => {
  const cr = creds({ WAN_1_ENDPOINT: 'sk-ws-PASTEDKEYabcdef123456' });
  installFetch();
  const out = JSON.stringify([P.poolSummary({ creds: cr, statePath: tmpState() }), await P.probeWanPool({ creds: cr })]);
  assert.ok(!out.includes('PASTEDKEY'), out);
  assert.match(out, /\(invalid endpoint\)/);
});

test('generateClip: a fetch error that quotes the Authorization header never carries the key out', async () => {
  const key = creds().WAN_1_API_KEY;
  installFetch({ wanCreate: () => { throw new TypeError(`Headers.append: "Bearer ${key}\u0000" is an invalid header value.`); } });
  const statePath = tmpState();
  const err = await run({ creds: creds(), statePath }).then(() => null, (e) => e);
  assert.ok(err, 'the leg stops');
  assert.ok(!`${err.message} ${JSON.stringify(err)}`.includes(key), err.message);
  assert.ok(!(fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : '').includes(key));
});

test('poolSummary / probeWanPool: a malformed model is not echoed either', async () => {
  const cr = creds({ WAN_2_MODEL: 'sk-ws-PASTEDMODELKEY # x' });
  installFetch();
  const out = JSON.stringify([P.poolSummary({ creds: cr, statePath: tmpState() }), await P.probeWanPool({ creds: cr })]);
  assert.ok(!out.includes('PASTEDMODELKEY'), out);
  assert.match(out, /\(invalid model\)/);
});

test('resumeClip: a WAN entry whose endpoint is malformed stops before sending anything', async () => {
  const calls = installFetch();
  await assert.rejects(
    () => P.resumeClip({ creds: creds({ WAN_1_ENDPOINT: `${WAN(1)}  # note` }), statePath: tmpState(), provider: 'wan', label: 'WAN_1', taskId: 'task-1-1', pollIntervalMs: 0, sleep: async () => {} }),
    (e) => e.kind === 'invalid_request' && e.label === 'WAN_1',
  );
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------------------
// Review round 2: malformed Sora endpoint, keys in the model field, Step 0 status, guards

test('resumeClip: a Sora resume with a missing or malformed endpoint stops before sending anything', async () => {
  for (const endpoint of [undefined, `${SORA}   # prod`, 'sora-unit.example.com']) {
    const calls = installFetch();
    await assert.rejects(
      () => P.resumeClip({ creds: creds({ AZURE_SORA_ENDPOINT: endpoint }), statePath: tmpState(), provider: 'sora', taskId: 'sora-job-1', pollIntervalMs: 1, pollTimeoutMs: 50, sleep: async () => {} }),
      (e) => e.kind === 'invalid_request' && e.provider === 'sora',
    );
    assert.equal(calls.length, 0, String(endpoint));
  }
});

test('loadWanPool / poolSummary / probeWanPool: a key pasted into the model field is malformed and never echoed', async () => {
  const cr = creds({ WAN_2_MODEL: 'sk-ws-PASTEDINMODEL12345' });
  assert.equal(P.loadWanPool(cr)[1].badModel, true);
  installFetch();
  const probe = await P.probeWanPool({ creds: cr });
  assert.deepEqual([probe[1].code, probe[1].authOk], ['BadModel', false]);
  const out = JSON.stringify([P.poolSummary({ creds: cr, statePath: tmpState() }), probe]);
  assert.ok(!out.includes('PASTEDINMODEL'), out);
});

test('poolSummary: a malformed entry is reported as malformed, so the free Step 0 check catches it', () => {
  const s = wanRows(P.poolSummary({ creds: creds({ WAN_1_ENDPOINT: 'ws-unit1.example.com', WAN_2_MODEL: 'wan3.0 video' }), statePath: tmpState() }));
  assert.deepEqual(s.map((e) => [e.label, e.status, e.reason ?? null]), [['WAN_1', 'malformed', 'endpoint'], ['WAN_2', 'malformed', 'model'], ['WAN_3', 'ok', null]]);
});

test('resumeClip: a WAN entry with a malformed model still resumes, without echoing the model', async () => {
  installFetch();
  const r = await P.resumeClip({ creds: creds({ WAN_1_MODEL: 'sk-ws-SECRETMODEL x' }), statePath: tmpState(), provider: 'wan', label: 'WAN_1', taskId: 'task-1-7', pollIntervalMs: 0, sleep: async () => {} });
  assert.equal(r.provider, 'wan');
  assert.ok(!JSON.stringify({ ...r, mp4: null }).includes('SECRETMODEL'));
});

test('wanCreateTask: a request the fetch refuses to build carries its error name, never its text', async () => {
  const key = creds().WAN_1_API_KEY;
  globalThis.fetch = async () => { throw new TypeError(`Headers.append: "Bearer ${key}\u0000" is an invalid header value.`); };
  const c = await P.wanCreateTask({ entry: P.loadWanPool(creds())[0], prompt: 'x' });
  assert.equal(c.status, 0);
  assert.ok(!JSON.stringify(c).includes(key));
  installFetch({ wanCreate: () => { throw new TypeError(`Headers.append: "Bearer ${key}\u0000" is an invalid header value.`); } });
  const err = await run({ creds: creds(), statePath: tmpState() }).then(() => null, (e) => e);
  assert.match(err.message, /TypeError/, 'the reader learns what kind of failure stopped the leg');
});

test('generateClip: an entry with a malformed model is skipped while the others serve', async () => {
  const calls = installFetch();
  const events = [];
  const r = await run({ creds: creds({ WAN_1_MODEL: 'wan3.0 video' }), statePath: tmpState(), onEvent: (e) => events.push(e) });
  assert.equal(r.label, 'WAN_2');
  assert.deepEqual(createdOn(calls), [2]);
  assert.ok(events.some((e) => e.type === 'skip' && e.label === 'WAN_1'));
});

test('generateClip: a key stays in flight while its task polls, so a leg started meanwhile waits for it', async () => {
  let polls = 0;
  let aPolling;
  const started = new Promise((r) => { aPolling = r; });
  const calls = installFetch({ wanTask: (id) => { if (++polls === 1) aPolling(); return polls < 4 ? json(200, { output: { task_id: id, task_status: 'RUNNING' } }) : null; } });
  const cr = creds({ WAN_2_ENDPOINT: undefined, WAN_3_ENDPOINT: undefined, WAN_MAX_CONCURRENT: '1' });
  const statePath = tmpState();
  const sleep = () => new Promise((r) => setImmediate(r));
  const events = [];
  const a = run({ creds: cr, statePath, sleep, maxRateWaitMs: 0, pollTimeoutMs: 1000, pollIntervalMs: 1 });
  await started;
  const b = run({ creds: cr, statePath, sleep, maxRateWaitMs: 0, pollTimeoutMs: 1000, pollIntervalMs: 1, onEvent: (e) => events.push(e) });
  const [ra, rb] = await Promise.all([a, b]);
  assert.deepEqual([ra.provider, rb.provider], ['wan', 'wan']);
  assert.ok(events.some((e) => e.type === 'wait' && /in-flight/.test(e.reason)), 'the second leg waited while the first one polled');
  assert.equal(creates(calls).length, 2);
});

test('resumeClip: a Sora resume waits with the injected sleep between polls', async () => {
  installFetch();
  const routed = globalThis.fetch;
  let polls = 0;
  globalThis.fetch = async (url, opts) => (String(url).startsWith(`${SORA}/openai/v1/videos/sora-job-1?`) && ++polls === 1 ? json(200, { id: 'sora-job-1', status: 'in_progress' }) : routed(url, opts));
  const slept = [];
  const r = await P.resumeClip({ creds: creds(), statePath: tmpState(), provider: 'sora', taskId: 'sora-job-1', seconds: 8, pollIntervalMs: 2_000, sleep: async (ms) => { slept.push(ms); } });
  assert.equal(r.provider, 'sora');
  assert.deepEqual(slept, [2_000]);
});

test('savePoolState: never writes through a link planted at a guessable name, and keeps its folder private', { skip: process.platform === 'win32' && 'POSIX modes and links' }, () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'video-pool-test-'));
  tmps.push(d);
  const fresh = path.join(d, 'fresh', 'state.json');
  P.savePoolState({ version: 1, entries: {} }, fresh);
  assert.equal(fs.statSync(path.dirname(fresh)).mode & 0o777, 0o700);
  const shared = path.join(d, 'shared');
  fs.mkdirSync(shared);
  const victim = path.join(d, 'victim.txt');
  fs.writeFileSync(victim, 'untouched');
  const file = path.join(shared, 'state.json');
  fs.symlinkSync(victim, `${file}.${process.pid}.tmp`);
  P.savePoolState({ version: 1, entries: { a: { label: 'WAN_1' } } }, file);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'untouched');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).entries.a.label, 'WAN_1');
  assert.deepEqual(fs.readdirSync(shared).filter((f) => f.endsWith('.tmp') && !f.includes(String(process.pid))), [], 'no temp file left');
});

test('loadWanPool / downloadWanVideo: a key goes only over https (loopback excepted), and a video only comes over https', async () => {
  const cr = creds({ WAN_1_ENDPOINT: 'http://ws-unit1.example.com', WAN_2_ENDPOINT: 'http://127.0.0.1:8080', WAN_3_ENDPOINT: 'http://localhost:9' });
  assert.deepEqual(P.loadWanPool(cr).map((e) => e.badEndpoint), [true, false, false]);
  let fetched = 0;
  globalThis.fetch = async () => { fetched++; return new Response(MP4, { status: 200 }); };
  await assert.rejects(P.downloadWanVideo('http://oss.example.com/v.mp4'), /https/);
  assert.equal(fetched, 0, 'nothing fetched');
  const resume = { creds: creds({ AZURE_SORA_ENDPOINT: 'http://sora-unit.example.com' }), statePath: tmpState(), provider: 'sora', taskId: 'sora-job-1', pollIntervalMs: 1, pollTimeoutMs: 5, sleep: async () => {} };
  await assert.rejects(P.resumeClip(resume), (e) => e.kind === 'invalid_request' && /https URL/.test(e.message));
  assert.equal(fetched, 0, 'no Sora request over http either');
});

test('generateClip: a Sora endpoint over http stops the leg before the key is sent', async () => {
  const calls = installFetch();
  const cr = creds({ VIDEO_PROVIDER_ORDER: 'sora', AZURE_SORA_ENDPOINT: 'http://sora-unit.example.com' });
  await assert.rejects(() => run({ creds: cr, statePath: tmpState() }), (e) => e.kind === 'invalid_request' && e.provider === 'sora' && /https URL/.test(e.message));
  assert.equal(calls.length, 0);
});

test('generateClip: a submit answered by a redirect whose Location is not a URL is not resubmitted to another key', async () => {
  const calls = installFetch({ wanCreate: (n) => (n === 1 ? new Response('', { status: 302, headers: { location: 'http://[' } }) : null) });
  await assert.rejects(() => run({ creds: creds(), statePath: tmpState() }), (e) => e.kind === 'submit_unknown' && e.label === 'WAN_1');
  assert.equal(creates(calls).length, 1);
});

test('generateClip: a submit redirected to another origin stops; that origin\'s 401 is never taken for the key\'s answer', async () => {
  const calls = installFetch({ wanCreate: (n) => (n === 1 ? new Response('', { status: 302, headers: { location: 'https://elsewhere.example.org/x' } }) : null) });
  const routed = globalThis.fetch;
  globalThis.fetch = async (url, opts) => (String(url).startsWith('https://elsewhere.example.org/') ? json(401, { code: 'InvalidApiKey' }) : routed(url, opts));
  const statePath = tmpState();
  await assert.rejects(() => run({ creds: creds(), statePath }), (e) => e.kind === 'submit_unknown' && e.label === 'WAN_1');
  assert.equal(creates(calls).length, 1, 'not resubmitted on WAN_2');
  assert.equal(P.poolSummary({ creds: creds(), statePath })[0].status, 'ok', 'WAN_1 is not retired for another server\'s answer');
});

test('generateClip: a submit redirected within its origin by a 303 stops; the GET\'s 429 is never taken for the submit\'s answer', async () => {
  const calls = installFetch({ wanCreate: (n) => (n === 1 ? new Response('', { status: 303, headers: { location: '/throttled' } }) : null) });
  const routed = globalThis.fetch;
  globalThis.fetch = async (url, opts) => (String(url).endsWith('/throttled') ? json(429, { code: 'Throttling.RateQuota' }) : routed(url, opts));
  await assert.rejects(() => run({ creds: creds(), statePath: tmpState() }), (e) => e.kind === 'submit_unknown' && e.label === 'WAN_1');
  assert.equal(creates(calls).length, 1, 'not resubmitted on WAN_2');
});

test('downloadWanVideo: a redirect away from https is not followed', async () => {
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    return String(url).startsWith('https://') ? new Response('', { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } }) : new Response(MP4, { status: 200 });
  };
  await assert.rejects(P.downloadWanVideo('https://oss.example.com/v.mp4', { sleep: async () => {} }), /download failed/);
  assert.ok(seen.every((u) => u.startsWith('https://')), seen.join(' '));
});

test('savePoolState: a write that fails leaves no temp file behind', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'video-pool-test-'));
  tmps.push(d);
  const real = fs.writeFileSync;
  fs.writeFileSync = (target, ...rest) => {
    if (typeof target === 'number') throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    return real(target, ...rest);
  };
  try {
    assert.throws(() => P.savePoolState({ version: 1, entries: {} }, path.join(d, 'state.json')), { code: 'ENOSPC' });
  } finally {
    fs.writeFileSync = real;
  }
  assert.deepEqual(fs.readdirSync(d), []);
});

test('generateClip: a server Retry-After is held between 1 s and 10 min', async () => {
  for (const [ra, check] of [['999999999', (ms) => ms <= 10 * 60_000], ['0', (ms) => ms >= 1000]]) {
    installFetch({ wanCreate: (n) => (n === 1 ? json(429, { code: 'Throttling.RateQuota' }, { 'retry-after': ra }) : null) });
    const statePath = tmpState();
    const c = clock();
    const cr = creds({ WAN_2_ENDPOINT: undefined, WAN_3_ENDPOINT: undefined, AZURE_SORA_ENDPOINT: undefined });
    const events = [];
    await assert.rejects(() => run({ creds: cr, statePath, clock: c, maxRateWaitMs: 60_000, onEvent: (e) => events.push(e) }), /no video provider/);
    const s = P.poolSummary({ creds: cr, statePath, now: c.now() })[0];
    const waits = events.filter((e) => e.type === 'wait').map((e) => e.ms);
    if (ra === '0') assert.ok(waits.length > 0 && waits.every(check), `Retry-After 0 waits at least 1 s: ${waits}`);
    else assert.ok(s.status === 'cooldown' && check(s.until - c.now()), `Retry-After ${ra} rests the key at most 10 min: ${s.until - c.now()}`);
  }
});

test('generateClip: a WAN request is not sent with its key or prompt to another origin on a redirect', async () => {
  const calls = installFetch({ wanCreate: (n) => (n === 1 ? new Response('', { status: 307, headers: { location: 'https://elsewhere.example.org/collect' } }) : null) });
  const routed = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).startsWith('https://elsewhere.example.org/')) throw new Error('the request reached the other origin');
    return routed(url, opts);
  };
  await assert.rejects(() => run({ creds: creds(), statePath: tmpState() }), (e) => e.kind === 'submit_unknown' && e.label === 'WAN_1');
  assert.equal(creates(calls)[0].opts.redirect, 'manual');
});

// ---------------------------------------------------------------------------
// the Sora path, an HTTP-date Retry-After, the attempt cap, poll patience

const soraPosts = (calls) => calls.filter((c) => c.url.startsWith(`${SORA}/openai/v1/videos?`) && c.opts.method === 'POST');
const soraOnly = (extra = {}) => creds({ VIDEO_PROVIDER_ORDER: 'sora', ...extra });

test('generateClip: a Sora 429 on submit waits with the injected sleep and retries; only the accepted request makes a job', async () => {
  let posts = 0;
  installFetch({ sora: () => (++posts < 3 ? json(429, { error: { code: 'too_many_requests' } }) : json(200, { id: 'sora-job-1', status: 'queued' })) });
  const slept = [];
  const events = [];
  const r = await run({ creds: soraOnly(), statePath: tmpState(), sleep: async (ms) => { slept.push(ms); }, onEvent: (e) => events.push(e) });
  assert.equal(r.provider, 'sora');
  assert.equal(posts, 3);
  assert.deepEqual(events.filter((e) => e.type === 'wait' && e.provider === 'sora').map((e) => e.ms), [30_000, 60_000]);
  assert.deepEqual(slept, [30_000, 60_000], 'the waits go through the injected sleep');
});

test('generateClip: a Sora 429 that never clears stops after five requests', async () => {
  let posts = 0;
  installFetch({ sora: () => { posts++; return json(429, { error: { code: 'too_many_requests' } }); } });
  const err = await run({ creds: soraOnly(), statePath: tmpState(), maxRateWaitMs: 240_000, sleep: async () => {} }).then(() => null, (e) => e);
  assert.equal(posts, 5);
  assert.equal(err.provider, 'sora');
  assert.equal(err.status, 429);
});

test('generateClip: a Sora submit refused by moderation is ContentRejectedError, not resubmitted', async () => {
  let posts = 0;
  installFetch({ sora: () => { posts++; return json(400, { error: { code: 'moderation_blocked', message: 'rejected by the safety system' } }); } });
  await assert.rejects(() => run({ creds: soraOnly(), statePath: tmpState() }), (e) => e instanceof P.ContentRejectedError && e.provider === 'sora');
  assert.equal(posts, 1);
});

test('generateClip: a Sora job that fails moderation is ContentRejectedError; another failed job stops as failed with its id', async () => {
  for (const [error, check] of [
    [{ code: 'moderation_blocked', message: 'blocked' }, (e) => e instanceof P.ContentRejectedError && e.provider === 'sora'],
    [{ code: 'internal_error', message: 'x' }, (e) => e.kind === 'failed' && e.provider === 'sora' && e.taskId === 'sora-job-1' && e.code === 'internal_error'],
  ]) {
    const calls = installFetch();
    const routed = globalThis.fetch;
    globalThis.fetch = async (url, opts) => (String(url).startsWith(`${SORA}/openai/v1/videos/sora-job-1?`) ? json(200, { id: 'sora-job-1', status: 'failed', error }) : routed(url, opts));
    await assert.rejects(() => run({ creds: soraOnly(), statePath: tmpState() }), check);
    assert.equal(soraPosts(calls).length, 1, `${error.code} is not resubmitted`);
    assert.ok(!calls.some((c) => c.url.includes('/content')), 'nothing downloaded');
  }
});

test('generateClip: a Sora clip that cannot be downloaded stops as download with the job id and seconds, for resumeClip', async () => {
  const calls = installFetch();
  const routed = globalThis.fetch;
  globalThis.fetch = async (url, opts) => (String(url).startsWith(`${SORA}/openai/v1/videos/sora-job-1/content`) ? new Response('', { status: 503 }) : routed(url, opts));
  await assert.rejects(() => run({ creds: soraOnly(), statePath: tmpState(), seconds: 8 }),
    (e) => e.kind === 'download' && e.provider === 'sora' && e.taskId === 'sora-job-1' && e.label === 'AZURE_SORA' && e.seconds === 8);
  assert.equal(soraPosts(calls).length, 1);
});

test('generateClip: a Sora submit answered 5xx may have made a job (submit_unknown); a 4xx made none (invalid_request)', async () => {
  for (const [status, kind] of [[500, 'submit_unknown'], [503, 'submit_unknown'], [400, 'invalid_request']]) {
    let posts = 0;
    installFetch({ sora: () => { posts++; return json(status, { error: { code: 'x', message: 'y' } }); } });
    await assert.rejects(() => run({ creds: soraOnly(), statePath: tmpState() }), (e) => e.kind === kind && e.provider === 'sora' && e.status === status);
    assert.equal(posts, 1, `HTTP ${status} is not sent again`);
  }
});

test('generateClip / resumeClip: Sora uses the deployment and api-version from the key file, and resume echoes snapped seconds', async () => {
  const calls = installFetch();
  const cr = soraOnly({ AZURE_SORA_DEPLOYMENT: 'sora-2-prod', AZURE_SORA_API_VERSION: '2025-05-01' });
  const r = await run({ creds: cr, statePath: tmpState() });
  const post = soraPosts(calls)[0];
  assert.equal(post.body.get('model'), 'sora-2-prod');
  assert.match(post.url, /[?&]api-version=2025-05-01(&|$)/);
  assert.equal(r.model, 'sora-2-prod');
  const back = await P.resumeClip({ creds: cr, statePath: tmpState(), provider: 'sora', taskId: 'sora-job-1', seconds: 5, pollIntervalMs: 0, sleep: async () => {} });
  assert.equal(back.seconds, 4, '5 s is reported as the 4 s Sora made');
  assert.match(calls.filter((c) => c.url.includes('/videos/sora-job-1')).at(-1).url, /api-version=2025-05-01/);
});

test('generateClip: a Sora endpoint without its key is skipped with an event and never called', async () => {
  const calls = installFetch({ wanCreate: () => json(400, { code: 'Arrearage' }) });
  const events = [];
  await assert.rejects(() => run({ creds: creds({ AZURE_SORA_API_KEY: undefined }), statePath: tmpState(), onEvent: (e) => events.push(e) }), /no video provider available \(tried: wan\)/);
  assert.ok(events.some((e) => e.type === 'skip' && e.provider === 'sora'));
  assert.ok(!calls.some((c) => c.url.startsWith(SORA)));
});

test('snapSoraSeconds: a missing or zero length is the 4 s default', () => {
  assert.deepEqual([undefined, null, 0, 'x'].map(P.snapSoraSeconds), [4, 4, 4, 4]);
});

test('generateClip: a Retry-After given as an HTTP date rests the key until that time', async () => {
  const at = new Date(Date.now() + 90_000).toUTCString();
  installFetch({ wanCreate: (n) => (n === 1 ? json(429, { code: 'Throttling.RateQuota' }, { 'retry-after': at }) : null) });
  const statePath = tmpState();
  const c = clock();
  const cr = creds({ WAN_3_ENDPOINT: undefined });
  assert.equal((await run({ creds: cr, statePath, clock: c, maxRateWaitMs: 0 })).label, 'WAN_2');
  const s = P.poolSummary({ creds: cr, statePath, now: c.now() })[0];
  assert.equal(s.status, 'cooldown');
  assert.ok(s.until - c.now() > 60_000 && s.until - c.now() <= 90_000, `about 90 s, not the 30 s default: ${s.until - c.now()}`);
});

test('generateClip: a key that keeps answering 429 is tried pool x 4 + 2 times, then the pool gives up', async () => {
  const calls = installFetch({ wanCreate: () => json(429, { code: 'Throttling.RateQuota' }, { 'retry-after': '7' }) });
  const cr = creds({ WAN_2_ENDPOINT: undefined, WAN_3_ENDPOINT: undefined, AZURE_SORA_ENDPOINT: undefined });
  const events = [];
  await assert.rejects(() => run({ creds: cr, statePath: tmpState(), maxRateWaitMs: 60_000, onEvent: (e) => events.push(e) }), /no video provider/);
  assert.equal(creates(calls).length, 6);
  assert.ok(events.some((e) => e.type === 'pool-unavailable' && /gave up after 6 attempts/.test(e.reason || '')));
});

test('generateClip: a poll keeps going through UNKNOWN (under five), 429 and 5xx answers to the finished task', async () => {
  const answers = [
    (id) => json(200, { output: { task_id: id, task_status: 'UNKNOWN' } }),
    () => json(429, { code: 'Throttling' }),
    () => new Response('bad gateway', { status: 502 }),
    (id) => json(200, { output: { task_id: id, task_status: 'UNKNOWN' } }),
  ];
  let i = 0;
  const calls = installFetch({ wanTask: (id) => (i < answers.length ? answers[i++](id) : null) });
  const r = await run({ creds: creds(), statePath: tmpState(), pollIntervalMs: 1, pollTimeoutMs: 100 });
  assert.equal(r.provider, 'wan');
  assert.equal(i, answers.length);
  assert.equal(creates(calls).length, 1);
});

test('generateClip: a 429 without Retry-After cools the key 30 s; a quota 429 then rests it 30 s, 60 s', async () => {
  for (const [code, want] of [['Throttling.RateQuota', [30_000]], ['Throttling.AllocationQuota', [30_000, 60_000]]]) {
    installFetch({ wanCreate: (n) => (n === 1 ? json(429, { code }) : null) });
    const statePath = tmpState();
    const c = clock();
    const cr = creds({ WAN_3_ENDPOINT: undefined, AZURE_SORA_ENDPOINT: undefined });
    const got = [];
    for (const _ of want) {
      await run({ creds: cr, statePath, clock: c, maxRateWaitMs: 0 });
      const s = P.poolSummary({ creds: cr, statePath, now: c.now() })[0];
      got.push(s.until - c.now());
      c.advance(s.until - c.now());
    }
    assert.deepEqual(got, want, code);
  }
});

test('generateClip: a submit whose redirect was refused says so, not that the connection was lost', async () => {
  for (const [answer, code] of [
    [() => new Response('', { status: 302, headers: { location: 'https://elsewhere.example.org/x' } }), 'ECROSSREDIRECT'],
    [() => new Response('', { status: 303, headers: { location: '/throttled' } }), 'EBODYREDIRECT'],
    [() => new Response('', { status: 302, headers: { location: 'http://[' } }), 'EBADREDIRECT'],
  ]) {
    installFetch({ wanCreate: (n) => (n === 1 ? answer() : null) });
    const err = await run({ creds: creds(), statePath: tmpState() }).then(() => null, (e) => e);
    assert.equal(err.kind, 'submit_unknown');
    assert.ok(err.message.includes(code), err.message);
    assert.doesNotMatch(err.message, /lost its connection/, err.message);
  }
});

test('downloadWanVideo: a failed try is retried after a growing wait; three failures stop', async () => {
  let n = 0;
  globalThis.fetch = async () => (++n < 3 ? new Response('', { status: 503 }) : new Response(MP4, { status: 200 }));
  const slept = [];
  assert.ok((await P.downloadWanVideo('https://oss.example.com/v.mp4', { sleep: async (ms) => { slept.push(ms); } })).equals(MP4));
  assert.deepEqual([n, slept], [3, [2000, 4000]]);
  n = -10;
  await assert.rejects(P.downloadWanVideo('https://oss.example.com/v.mp4', { sleep: async () => {} }), /HTTP 503/);
  assert.equal(n, -7, 'three tries, then the stop');
});

test('generateClip: a Sora submit still throttled after five tries stops as rate, each wait the server\'s Retry-After from 1 s to 10 min', async () => {
  // 3600 s is past the default maxRateWaitMs, which stops at once: given a longer one, the wait is held to 10 min
  for (const [ra, ms, maxRateWaitMs] of [['7', 7000], ['3600', 600_000, 3_600_000], ['0', 1000]]) {
    let posts = 0;
    installFetch({ sora: () => { posts++; return json(429, { error: { code: 'too_many_requests' } }, { 'retry-after': ra }); } });
    const slept = [];
    const err = await run({ creds: soraOnly(), statePath: tmpState(), maxRateWaitMs, sleep: async (t) => { slept.push(t); } }).then(() => null, (e) => e);
    assert.equal(posts, 5);
    assert.deepEqual([err?.kind, err?.provider, err?.status], ['rate', 'sora', 429]);
    assert.deepEqual(slept, [ms, ms, ms, ms]);
  }
});

test('generateClip: a WAN 5xx submit with a code the pool does not know may have made a task, so it is not sent to the next key', async () => {
  const calls = installFetch({ wanCreate: (n) => (n === 1 ? json(503, { code: 'SomeServer5xx', message: 'x' }) : null) });
  await assert.rejects(() => run({ creds: creds(), statePath: tmpState() }), (e) => e.kind === 'submit_unknown' && e.label === 'WAN_1' && e.status === 503);
  assert.deepEqual(createdOn(calls), [1]);
});

test('downloadWanVideo: a connection dropped mid-body counts as a failed try and is tried again', async () => {
  let n = 0;
  const dropped = () => ({ status: 200, ok: true, headers: new Headers(), arrayBuffer: async () => { throw Object.assign(new TypeError('terminated'), { cause: { code: 'UND_ERR_SOCKET' } }); } });
  globalThis.fetch = async () => (++n < 3 ? dropped() : new Response(MP4, { status: 200 }));
  const slept = [];
  assert.ok((await P.downloadWanVideo('https://oss.example.com/v.mp4', { sleep: async (t) => { slept.push(t); } })).equals(MP4));
  assert.deepEqual([n, slept], [3, [2000, 4000]]);
});

// A request that never answers: it ends only when its signal aborts. Like a socket it keeps the event loop
// alive meanwhile; the timer behind AbortSignal.timeout does not, and Node 20 and 22 would end the test
// file with the request still pending.
const hang = (signal) => new Promise((_, reject) => {
  const alive = setInterval(() => {}, 1000);
  signal.addEventListener('abort', () => { clearInterval(alive); reject(signal.reason); }, { once: true });
});
const realClock = { now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

test('generateClip: a poll whose requests never answer ends at the poll deadline and says how long it polled', { timeout: 10_000 }, async () => {
  for (const [cr, polled, check] of [
    [creds(), '/api/v1/tasks/', (e) => e.provider === 'wan' && e.taskId === 'task-1-1'],
    [soraOnly(), `${SORA}/openai/v1/videos/sora-job-1?`, (e) => e.provider === 'sora' && e.taskId === 'sora-job-1'],
  ]) {
    installFetch();
    const routed = globalThis.fetch;
    let polls = 0;
    globalThis.fetch = (url, opts) => (String(url).includes(polled) ? (polls++, hang(opts.signal)) : routed(url, opts));
    const t0 = Date.now();
    const err = await run({ creds: cr, statePath: tmpState(), ...realClock, pollIntervalMs: 50, pollTimeoutMs: 300 }).then(() => null, (e) => e);
    const took = Date.now() - t0;
    assert.equal(err?.kind, 'timeout', err?.message);
    assert.ok(check(err), err.message);
    assert.ok(took < 2000, `ended in ${took} ms`);
    assert.ok(polls <= 2, `${polls} polls`);
    // the hung request ends at the deadline, then one interval passes: more than 300 ms in all
    const said = Number(err.message.match(/after polling for (\d+) ms/)?.[1]);
    assert.ok(said > 300 && said <= took, `said ${said} ms, took ${took} ms: ${err.message}`);
  }
});

test('generateClip: poll time is counted on the injected clock, slow poll requests included', async () => {
  for (const [cr, polled, running] of [
    [creds(), '/api/v1/tasks/', () => json(200, { output: { task_id: 'task-1-1', task_status: 'RUNNING' } })],
    [soraOnly(), `${SORA}/openai/v1/videos/sora-job-1?`, () => json(200, { id: 'sora-job-1', status: 'in_progress' })],
  ]) {
    const c = clock();
    installFetch();
    const routed = globalThis.fetch;
    let polls = 0;
    globalThis.fetch = async (url, opts) => {
      if (!String(url).includes(polled)) return routed(url, opts);
      polls++;
      c.advance(1000);
      return running();
    };
    const err = await run({ creds: cr, statePath: tmpState(), clock: c, pollIntervalMs: 1, pollTimeoutMs: 3000 }).then(() => null, (e) => e);
    assert.equal(err?.kind, 'timeout', err?.message);
    assert.equal(polls, 3, `${polls} polls of 1 s each in a 3 s poll`);
    assert.match(err.message, /after polling for 3003 ms/);
  }
});

test('wanPollTask: each poll request is limited to 120 s, or to the time left when that is less', async () => {
  const seen = [];
  const timeout = AbortSignal.timeout;
  AbortSignal.timeout = (ms) => { seen.push(ms); return timeout.call(AbortSignal, ms); };
  try {
    let n = 0;
    installFetch({ wanTask: (id) => (++n < 2 ? json(200, { output: { task_id: id, task_status: 'RUNNING' } }) : null) });
    const c = clock();
    const entry = P.loadWanPool(creds())[0];
    const p = await P.wanPollTask({ entry, taskId: 't', intervalMs: 1000, timeoutMs: 30 * 60_000, now: c.now, sleep: async () => { c.advance(30 * 60_000 - 50_000); } });
    assert.equal(p.state, 'SUCCEEDED');
  } finally {
    AbortSignal.timeout = timeout;
  }
  assert.deepEqual(seen, [120_000, 50_000]);
});

test('generateClip: a Sora job polled with no interval still gets every poll up to the deadline', async () => {
  let polls = 0;
  installFetch();
  const routed = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (!String(url).startsWith(`${SORA}/openai/v1/videos/sora-job-1?`)) return routed(url, opts);
    return json(200, { id: 'sora-job-1', status: ++polls < 3 ? 'in_progress' : 'completed' });
  };
  const r = await run({ creds: soraOnly(), statePath: tmpState(), pollIntervalMs: 0, pollTimeoutMs: 5 });
  assert.equal(r.provider, 'sora');
  assert.equal(polls, 3);
});

// Runs fn with an env proxy that would carry http, as NODE_USE_ENV_PROXY=1 and HTTP_PROXY do.
async function withEnvProxy(fn) {
  const saved = Object.fromEntries(['NODE_USE_ENV_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'no_proxy'].map((k) => [k, process.env[k]]));
  Object.assign(process.env, { NODE_USE_ENV_PROXY: '1', HTTP_PROXY: 'http://proxy.example:3128' });
  delete process.env.NO_PROXY;
  delete process.env.no_proxy;
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test('generateClip: a WAN entry whose key an env proxy would carry over http is skipped before anything is sent, and the next key serves', async () => {
  await withEnvProxy(async () => {
    const calls = installFetch();
    const events = [];
    const r = await run({ creds: creds({ WAN_1_ENDPOINT: 'http://localhost:9' }), statePath: tmpState(), onEvent: (e) => events.push(e) });
    assert.equal(r.label, 'WAN_2');
    assert.ok(!calls.some((c) => c.url.startsWith('http://localhost:9')), 'nothing went to the http endpoint');
    assert.ok(events.some((e) => e.type === 'skip' && e.label === 'WAN_1' && /EPROXYKEY/.test(e.reason)), JSON.stringify(events.slice(0, 3)));
    assert.ok(!events.some((e) => e.type === 'submit' && e.label === 'WAN_1'), 'WAN_1 was never submitted to');
  });
});

test('generateClip: when an env proxy would carry every WAN key, the leg stops as invalid_request without paying for Sora', async () => {
  await withEnvProxy(async () => {
    const calls = installFetch();
    const cr = creds({ WAN_1_ENDPOINT: 'http://localhost:9', WAN_2_ENDPOINT: 'http://127.0.0.1:9', WAN_3_ENDPOINT: 'http://[::1]:9' });
    await assert.rejects(() => run({ creds: cr, statePath: tmpState() }), (e) => e.kind === 'invalid_request' && e.provider === 'wan' && /held back/.test(e.message) && /WAN_3 EPROXYKEY/.test(e.message));
    assert.equal(calls.length, 0, 'nothing was sent, Sora included');
  });
});

test('generateClip and resumeClip: a Sora or WAN endpoint whose key an env proxy would carry stops as invalid_request, nothing sent', async () => {
  await withEnvProxy(async () => {
    const calls = installFetch();
    const sora = creds({ AZURE_SORA_ENDPOINT: 'http://localhost:9', VIDEO_PROVIDER_ORDER: 'sora' });
    await assert.rejects(() => run({ creds: sora, statePath: tmpState() }), (e) => e.kind === 'invalid_request' && e.provider === 'sora' && /EPROXYKEY/.test(e.message));
    const resume = { statePath: tmpState(), pollIntervalMs: 1, pollTimeoutMs: 50, sleep: async () => {} };
    await assert.rejects(P.resumeClip({ ...resume, creds: sora, provider: 'sora', taskId: 'sora-job-1' }), (e) => e.kind === 'invalid_request' && e.taskId === 'sora-job-1' && /EPROXYKEY/.test(e.message));
    await assert.rejects(P.resumeClip({ ...resume, creds: creds({ WAN_1_ENDPOINT: 'http://localhost:9' }), provider: 'wan', label: 'WAN_1', taskId: 'task-1-1' }), (e) => e.kind === 'invalid_request' && e.label === 'WAN_1' && /EPROXYKEY/.test(e.message));
    assert.equal(calls.length, 0);
  });
});

const buildSkill = () => fs.readFileSync(new URL('../SKILL.md', import.meta.url), 'utf8');

test('SKILL: a FAILED task sent to the next key rests on a premise the docs do not confirm, with its worst case', () => {
  const line = buildSkill().split('\n').find((l) => l.includes('같은 leg 를 두 번 과금하지 않는다'));
  assert.match(line, /FAILED\/CANCELED task 가 과금되지 않는다는 것은 전제/);
  assert.match(line, /키 수 x 4 \+ 2/);
  assert.doesNotMatch(line, /task 를 만들지 않은 게 확실할 때뿐/);
  const head = fs.readFileSync(new URL('./video-pool.mjs', import.meta.url), 'utf8').split('\n').slice(0, 40).join(' ');
  assert.match(head, /an assumption the official docs do not confirm/);
  assert.match(head, /keys x 4 \+ 2/);
  assert.doesNotMatch(head, /provably did/);
});

test('SKILL: the cost approval says the Sora estimate applies whenever no WAN key can take the leg, not only when keys run out', () => {
  const line = buildSkill().split('\n').find((l) => l.includes('이 Sora 추정이 적용된다'));
  assert.match(line, /소진, 2분 넘는 쿨다운, 시도 한도/);
});

test('SKILL: a task_lost leg whose task the console still shows is finished with resumeClip, not submitted again', () => {
  const row = buildSkill().split('\n').find((l) => l.trim().startsWith('|') && l.includes("'task_lost'"));
  assert.match(row, /`task_lost` 인데 콘솔에 task 가 있으면 `resumeClip` 으로 마저 받음\(새 제출 없음\)/);
});

test('wanParams: a size it cannot read is taken as 720x1280', () => {
  assert.deepEqual([P.wanParams({ size: 'bogus' }).resolution, P.wanParams({ size: 'bogus' }).ratio], ['720P', '9:16']);
});

test('generateClip: a WAN task without frames sends no media field', async () => {
  const calls = installFetch();
  await run({ creds: creds(), statePath: tmpState() });
  assert.deepEqual(Object.keys(creates(calls)[0].body.input), ['prompt']);
});

test('generateClip: request-rate cooldowns without Retry-After double from 30 s and stop at 10 min', async () => {
  const c = clock();
  installFetch({ wanCreate: () => json(429, { code: 'Throttling.RateQuota' }) });
  const one = creds({ WAN_2_ENDPOINT: undefined, WAN_2_API_KEY: undefined, WAN_3_ENDPOINT: undefined, WAN_3_API_KEY: undefined, VIDEO_PROVIDER_ORDER: 'wan' });
  const statePath = tmpState();
  const waits = [];
  await assert.rejects(run({ creds: one, statePath, clock: c, maxRateWaitMs: 3_600_000, onEvent: (e) => { if (e.type === 'wait') waits.push(e.ms); } }), /no video provider available/);
  assert.deepEqual(waits, [30_000, 60_000, 120_000, 240_000, 480_000]);
  const [s] = P.poolSummary({ creds: one, statePath, now: c.now() });
  assert.deepEqual([s.status, s.until - c.now()], ['cooldown', 600_000]);
});

test('generateClip: a transient failure keeps the first 120 characters of its message in the key\'s reason', async () => {
  const c = clock();
  installFetch({ wanCreate: (n) => (n === 1 ? json(500, { code: 'InternalError', message: 'x'.repeat(200) }) : null) });
  const statePath = tmpState();
  await run({ creds: creds(), statePath, clock: c });
  const s = P.poolSummary({ creds: creds(), statePath, now: c.now() }).find((e) => e.label === 'WAN_1');
  assert.equal(s.reason, `InternalError: ${'x'.repeat(120)}`);
});

test('generateClip: a WAN submit whose answer is cut off mid-body is a lost connection (submit_unknown), named as such', async () => {
  const cut = () => ({ status: 200, ok: true, headers: new Headers({ 'content-type': 'application/json' }), text: async () => { throw Object.assign(new TypeError('terminated'), { cause: { code: 'UND_ERR_SOCKET' } }); } });
  const calls = installFetch({ wanCreate: (n) => (n === 1 ? cut() : null) });
  await assert.rejects(() => run({ creds: creds(), statePath: tmpState() }), (e) => e.kind === 'submit_unknown' && e.label === 'WAN_1' && /no usable answer \(UND_ERR_SOCKET\)/.test(e.message));
  assert.deepEqual(createdOn(calls), [1]);
});

test('wanPollTask: a clock that gives fractions of a ms still sends its first poll', async () => {
  installFetch();
  let t = 0.25;
  const entry = P.loadWanPool(creds())[0];
  const p = await P.wanPollTask({ entry, taskId: 't', intervalMs: 1, timeoutMs: 1000, now: () => (t += 0.5), sleep: async () => {} });
  assert.equal(p.state, 'SUCCEEDED');
  assert.ok(t < 10, `the first poll was answered (the clock is at ${t} ms, not near the deadline)`);
});

// 0.20.4 last cleanup
test('generateClip: a Sora 429 whose Retry-After is past maxRateWaitMs stops as rate at once; a longer maxRateWaitMs waits it out', async () => {
  let posts = 0;
  installFetch({ sora: () => { posts++; return json(429, { error: { code: 'too_many_requests' } }, { 'retry-after': '600' }); } });
  const slept = [];
  const err = await run({ creds: soraOnly(), statePath: tmpState(), sleep: async (t) => { slept.push(t); } }).then(() => null, (e) => e);
  assert.deepEqual([posts, slept, err?.kind, err?.status, err?.retryAfterMs], [1, [], 'rate', 429, 600_000]);
  assert.match(err.message, /Retry-After of 600 s, past maxRateWaitMs \(120000 ms\); no job was made/);
  posts = 0;
  const waited = [];
  const err2 = await run({ creds: soraOnly(), statePath: tmpState(), maxRateWaitMs: 600_000, sleep: async (t) => { waited.push(t); } }).then(() => null, (e) => e);
  assert.deepEqual([posts, waited, err2?.kind], [5, [600_000, 600_000, 600_000, 600_000], 'rate']);
});

test('wanPollTask: a key held back before sending (EINSECURE) ends the poll at once as HTTP 0, not as TIMEOUT', async () => {
  const calls = installFetch();
  let ticks = 0;
  const p = await P.wanPollTask({ entry: { endpoint: 'http://example.invalid', key: creds().WAN_1_API_KEY, label: 'WAN_1' }, taskId: 't', sleep: async () => { ticks++; } });
  assert.deepEqual([p.state, p.status, p.output.code, ticks, calls.length], ['HTTP', 0, 'EINSECURE', 0, 0]);
});

// ---------------------------------------------------------------------------
// Sora retirement (HTTP 410)

// Sora routes on top of installFetch: `route(url, opts)` answers first (null passes the call on).
// Each test names its own deployment, since the free probe runs once per process and deployment.
function soraRoutes(route, opts = {}) {
  const calls = installFetch(opts);
  const routed = globalThis.fetch;
  globalThis.fetch = async (url, o = {}) => {
    const r = await route(String(url), o);
    if (!r) return routed(url, o);
    calls.push({ url: String(url), opts: o, body: o.body });
    return r;
  };
  return calls;
}
const soraGone = () => json(410, { error: { code: 'ModelDeprecated', message: 'The model has been retired.' } });
const isProbe = (u) => u.includes('/openai/deployments/') || u.includes('/openai/v1/models?');
const deploymentAnswer = (gone) => (u) => (u.includes('/openai/deployments/') ? (gone ? soraGone() : json(200, { model: 'sora-2', status: 'succeeded' })) : null);
const soraKey = () => creds().AZURE_SORA_API_KEY;

test('generateClip: a Sora submit answered 410 stops as retired at once, records it, and sends Sora nothing for 24 h', async () => {
  const c = clock();
  const statePath = tmpState();
  const events = [];
  const cr = soraOnly({ AZURE_SORA_DEPLOYMENT: 'sora-r410a' });
  const calls = soraRoutes((u, o) => (u.startsWith(`${SORA}/openai/v1/videos?`) && o.method === 'POST' ? soraGone() : null));
  const err = await run({ creds: cr, statePath, clock: c, onEvent: (e) => events.push(e) }).then(() => null, (e) => e);
  assert.deepEqual([err?.kind, err?.provider, err?.status, soraPosts(calls).length], ['retired', 'sora', 410, 1]);
  assert.match(err.message, /no job was made/);
  const rec = Object.values(JSON.parse(fs.readFileSync(statePath, 'utf8')).entries).find((e) => e.label === 'AZURE_SORA');
  assert.deepEqual([rec.status, rec.retiredAt], ['retired', c.now()]);
  assert.ok(!calls.some((x) => isProbe(x.url)), 'a submit 410 needs no probe');
  const again = await run({ creds: cr, statePath, clock: c, onEvent: (e) => events.push(e) }).then(() => null, (e) => e);
  assert.deepEqual([again?.kind, soraPosts(calls).length], ['retired', 1], 'the second leg sends Sora nothing');
  assert.match(again.message, /nothing was sent/);
  assert.ok(events.some((e) => e.type === 'skip' && e.provider === 'sora' && e.reason === 'retired'));
  const sora = P.poolSummary({ creds: cr, statePath, now: c.now() }).at(-1);
  assert.deepEqual([sora.label, sora.provider, sora.status, sora.until], ['AZURE_SORA', 'sora', 'retired', c.now() + 86_400_000]);
  const out = `${err.message} ${again.message} ${JSON.stringify(events)} ${fs.readFileSync(statePath, 'utf8')}`;
  assert.ok(!out.includes(soraKey()), 'no key in errors, events or the state file');
});

test('generateClip: a Sora retirement record ends after 24 h or with resetPoolState AZURE_SORA', async () => {
  const c = clock();
  const statePath = tmpState();
  const cr = soraOnly({ AZURE_SORA_DEPLOYMENT: 'sora-r410b' });
  let gone = true;
  const calls = soraRoutes((u, o) => (gone && u.startsWith(`${SORA}/openai/v1/videos?`) && o.method === 'POST' ? soraGone() : null));
  await assert.rejects(() => run({ creds: cr, statePath, clock: c }), (e) => e.kind === 'retired');
  gone = false;
  c.advance(86_400_000);
  assert.equal((await run({ creds: cr, statePath, clock: c })).provider, 'sora', 'sent again after 24 h');
  gone = true;
  await assert.rejects(() => run({ creds: cr, statePath, clock: c }), (e) => e.kind === 'retired');
  gone = false;
  P.resetPoolState({ statePath, labels: ['WAN_1'] });
  await assert.rejects(() => run({ creds: cr, statePath, clock: c }), (e) => e.kind === 'retired', 'clearing a WAN label keeps the Sora record');
  P.resetPoolState({ statePath, labels: ['AZURE_SORA'] });
  assert.equal(P.poolSummary({ creds: cr, statePath, now: c.now() }).at(-1).status, 'ok');
  assert.equal((await run({ creds: cr, statePath, clock: c })).provider, 'sora');
  assert.equal(soraPosts(calls).length, 4);
});

test('generateClip: with a usable WAN key a Sora retirement record changes nothing', async () => {
  const c = clock();
  const statePath = tmpState();
  const cr = creds({ AZURE_SORA_DEPLOYMENT: 'sora-r410c' });
  soraRoutes((u, o) => (u.startsWith(`${SORA}/openai/v1/videos?`) && o.method === 'POST' ? soraGone() : null));
  await assert.rejects(() => run({ creds: { ...cr, VIDEO_PROVIDER_ORDER: 'sora' }, statePath, clock: c }), (e) => e.kind === 'retired');
  const r = await run({ creds: cr, statePath, clock: c });
  assert.equal(r.provider, 'wan');
});

test('generateClip: a Sora poll answered 410 is retired only when the free probe says so; else task_lost, nothing recorded', async () => {
  for (const [gone, kind] of [[false, 'task_lost'], [true, 'retired']]) {
    const statePath = tmpState();
    const events = [];
    const cr = soraOnly({ AZURE_SORA_DEPLOYMENT: `sora-poll-${gone}` });
    const calls = soraRoutes((u) => deploymentAnswer(gone)(u) || (u.startsWith(`${SORA}/openai/v1/videos/sora-job-1?`) ? soraGone() : null));
    const err = await run({ creds: cr, statePath, onEvent: (e) => events.push(e) }).then(() => null, (e) => e);
    assert.deepEqual([err?.kind, err?.taskId, soraPosts(calls).length], [kind, 'sora-job-1', 1]);
    const probes = calls.filter((x) => isProbe(x.url));
    assert.ok(probes.length >= 1 && probes.every((x) => (x.opts.method || 'GET') === 'GET' && x.opts.body === undefined), 'the probe is GETs without a body');
    assert.ok(events.some((e) => e.type === 'probe' && e.stage === 'poll' && e.state === (gone ? 'retired' : 'deployed')));
    const st = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { entries: {} };
    assert.equal(Object.values(st.entries).some((e) => e.label === 'AZURE_SORA' && e.retiredAt), gone);
    if (gone) assert.match(err.message, /job sora-job-1 may have billed/);
  }
});

test('generateClip: a Sora download answered 410 is checked the same way; the probe runs once per process', async () => {
  for (const [gone, kind] of [[false, 'download'], [true, 'retired']]) {
    const cr = soraOnly({ AZURE_SORA_DEPLOYMENT: `sora-dl-${gone}` });
    const calls = soraRoutes((u) => deploymentAnswer(gone)(u) || (u.startsWith(`${SORA}/openai/v1/videos/sora-job-1/content`) ? soraGone() : null));
    const err = await run({ creds: cr, statePath: tmpState(), seconds: 8 }).then(() => null, (e) => e);
    assert.deepEqual([err?.kind, err?.taskId], [kind, 'sora-job-1']);
    if (!gone) {
      assert.equal(err.seconds, 8, 'still resumable');
      await assert.rejects(() => run({ creds: cr, statePath: tmpState() }), (e) => e.kind === 'download');
      assert.equal(calls.filter((x) => x.url.includes('/openai/deployments/')).length, 1, 'a second 410 in this process reuses the probe');
    }
  }
});

test('generateClip: a Sora 400 that names a deprecated api-version is not retirement; a 404 is invalid_request with a hint, unrecorded', async () => {
  for (const [status, body] of [[400, { error: { code: 'BadRequest', message: 'api-version 2024-01-01 is deprecated' } }], [404, { error: { code: 'DeploymentNotFound', message: 'x' } }]]) {
    const statePath = tmpState();
    const calls = soraRoutes((u, o) => (u.startsWith(`${SORA}/openai/v1/videos?`) && o.method === 'POST' ? json(status, body) : null));
    const err = await run({ creds: soraOnly(), statePath }).then(() => null, (e) => e);
    assert.deepEqual([err?.kind, err?.status, soraPosts(calls).length], ['invalid_request', status, 1]);
    assert.ok(!fs.existsSync(statePath) || !fs.readFileSync(statePath, 'utf8').includes('AZURE_SORA'), 'nothing recorded');
    assert.ok(!calls.some((x) => isProbe(x.url)));
    if (status === 404) assert.deepEqual([err.code, /removed after its model retired/.test(err.message)], ['DeploymentNotFound', true]);
  }
});

test('poolSummary: the Sora row says unset without creds and never shows a malformed endpoint', () => {
  const unset = P.poolSummary({ creds: { WAN_1_ENDPOINT: WAN(1), WAN_1_API_KEY: 'k' }, statePath: tmpState() });
  assert.deepEqual(unset.map((e) => [e.label, e.provider, e.status]), [['WAN_1', 'wan', 'ok'], ['AZURE_SORA', 'sora', 'unset']]);
  const bad = P.poolSummary({ creds: creds({ AZURE_SORA_ENDPOINT: 'sk-PASTEDSORAKEY123' }), statePath: tmpState() }).at(-1);
  assert.deepEqual([bad.status, bad.reason, bad.host], ['malformed', 'endpoint', '(invalid endpoint)']);
  assert.ok(!JSON.stringify(bad).includes('PASTEDSORAKEY'));
});

test('SKILL: Step 0 and setup §4 check the Sora deployment with the free GET probe, and a retired Sora without WAN stops before paid stills', () => {
  const build = buildSkill();
  const setup = fs.readFileSync(new URL('../../3d-intro-setup/SKILL.md', import.meta.url), 'utf8');
  assert.match(build, /probeSoraDeployment\(\{ endpoint: creds\.AZURE_SORA_ENDPOINT/);
  assert.match(build, /WAN 항목이 없으면, 유료 스틸을 만들기 전에 멈춘다/);
  assert.match(build, /\| `kind: 'retired'` \|/);
  assert.match(setup, /const dep = await probeSoraDeployment\(/);
  assert.match(setup, /\| `sora\.deploy` 가 `retired` \|/);
  assert.doesNotMatch(setup, /배포명이 실제 존재하는지는 이 무과금 프리플라이트로 확인 불가/);
});
