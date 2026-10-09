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
    WAN_1_ENDPOINT: WAN(1), WAN_1_API_KEY: 'placeholder-wan-key-1111',
    WAN_2_ENDPOINT: WAN(2), WAN_2_API_KEY: 'placeholder-wan-key-2222',
    WAN_3_ENDPOINT: `${WAN(3)}/`, WAN_3_API_KEY: 'placeholder-wan-key-3333',
    AZURE_SORA_ENDPOINT: SORA, AZURE_SORA_API_KEY: 'placeholder-sora-key-0000',
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

/**
 * Route stubbed fetch calls. `wanCreate(n, call)` decides each WAN create response for entry n;
 * tasks succeed on first poll unless `wanTask(taskId)` says otherwise. Every call is recorded.
 */
function installFetch({ wanCreate, wanTask, sora = 'ok' } = {}) {
  const calls = [];
  let seq = 0;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const call = { url: u, opts, body: opts.body && typeof opts.body === 'string' ? JSON.parse(opts.body) : opts.body };
    calls.push(call);
    const m = u.match(/^https:\/\/ws-unit(\d)\.example\.com(.*)$/);
    if (m && m[2] === CREATE) {
      const r = wanCreate ? wanCreate(Number(m[1]), call) : null;
      if (r) return r;
      const id = `task-${m[1]}-${++seq}`;
      return json(200, { request_id: 'r', output: { task_id: id, task_status: 'PENDING' } });
    }
    if (m && m[2].startsWith('/api/v1/tasks/')) {
      const id = decodeURIComponent(m[2].slice('/api/v1/tasks/'.length));
      const r = wanTask ? wanTask(id) : null;
      if (r) return r;
      return json(200, { output: { task_id: id, task_status: 'SUCCEEDED', video_url: `https://oss.example.com/${id}.mp4` }, usage: { duration: 5 } });
    }
    if (u.startsWith('https://oss.example.com/')) return new Response(MP4, { status: 200 });
    if (u.startsWith(`${SORA}/openai/v1/videos?`)) {
      if (opts.method === 'POST') return sora === 'ok' ? json(200, { id: 'sora-job-1', status: 'queued' }) : sora();
      return json(200, { data: [] });
    }
    if (u.startsWith(`${SORA}/openai/v1/videos/sora-job-1/content`)) return new Response(MP4, { status: 200, headers: { 'content-type': 'video/mp4' } });
    if (u.startsWith(`${SORA}/openai/v1/videos/sora-job-1?`)) return json(200, { id: 'sora-job-1', status: 'completed' });
    throw new Error(`unrouted fetch ${u}`);
  };
  return calls;
}

const creates = (calls) => calls.filter((c) => c.url.endsWith(CREATE));
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
    [{ status: 401 }, 'unusable'],
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
  assert.ok(P.poolSummary({ creds: creds(), statePath, now: c.now() }).every((e) => e.status === 'cooldown'));
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
  assert.ok(P.poolSummary({ creds: creds(), statePath, now: c.now() }).every((e) => e.status === 'exhausted'));
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
  assert.deepEqual(P.poolSummary({ creds: creds(), statePath, now: c.now() }).map((e) => e.status), ['ok', 'exhausted', 'ok']);
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

test('loadWanPool / probeWanPool / generateClip: an endpoint without http(s) is skipped and reported, not fatal', async () => {
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
