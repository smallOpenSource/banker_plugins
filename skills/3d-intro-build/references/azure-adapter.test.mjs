/*
 * Unit tests for the shared Azure adapter (node:test + node:assert/strict). Filename ends in
 * .test.mjs so it is excluded from the npm package (see package.json "files").
 *
 * No network and no ffmpeg binary are required: globalThis.fetch and cp.spawnSync are stubbed
 * per-test and restored in afterEach. Only placeholder creds are used.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as A from './azure-adapter.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EP = 'https://unit-test.example.com';
const KEY = 'placeholder-key-0000';

// ---- save / restore globals stubbed by the tests ----
const orig = {
  fetch: globalThis.fetch,
  spawnSync: cp.spawnSync,
  PATH: process.env.PATH,
  FFMPEG_PATH: process.env.FFMPEG_PATH,
  platform: Object.getOwnPropertyDescriptor(process, 'platform'),
};
const tmps = [];
afterEach(() => {
  globalThis.fetch = orig.fetch;
  cp.spawnSync = orig.spawnSync;
  if (orig.PATH === undefined) delete process.env.PATH; else process.env.PATH = orig.PATH;
  if (orig.FFMPEG_PATH === undefined) delete process.env.FFMPEG_PATH; else process.env.FFMPEG_PATH = orig.FFMPEG_PATH;
  Object.defineProperty(process, 'platform', orig.platform);
  while (tmps.length) fs.rmSync(tmps.pop(), { recursive: true, force: true });
});
function mkTmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmps.push(d);
  return d;
}

// ---- fetch mock helpers ----
function installFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts: opts || {} });
    return handler(String(url), opts || {}, calls.length - 1);
  };
  return calls;
}
function mockJson(json, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => json,
    text: async () => JSON.stringify(json),
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}
function mockBinary(buf, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => 'application/octet-stream' },
    json: async () => null,
    text: async () => '',
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  };
}

// =====================================================================
// parseConsoleSample
// =====================================================================

test('parseConsoleSample: curl sample (classic deployments path)', () => {
  const sample = [
    'curl -X POST "https://my-res.openai.azure.com/openai/deployments/gpt-image-2/images/generations?api-version=2025-04-01-preview" \\',
    '  -H "Content-Type: application/json" \\',
    '  -H "api-key: PLACEHOLDERKEY1234" \\',
    "  -d '{ \"prompt\": \"hello\" }'",
  ].join('\n');
  assert.deepEqual(A.parseConsoleSample(sample), {
    endpoint: 'https://my-res.openai.azure.com',
    deployment: 'gpt-image-2',
    apiVersion: '2025-04-01-preview',
    apiKey: 'PLACEHOLDERKEY1234',
  });
});

test('parseConsoleSample: python SDK sample (kwargs + Bearer auth)', () => {
  const sample = [
    'from openai import AzureOpenAI',
    'client = AzureOpenAI(',
    '    api_version="preview",',
    '    azure_endpoint="https://my-res.openai.azure.com/",',
    ')',
    'headers = {"Authorization": "Bearer PLACEHOLDERPYKEY99"}',
    'resp = client.images.generate(model="gpt-image-2", prompt="hi")',
  ].join('\n');
  assert.deepEqual(A.parseConsoleSample(sample), {
    endpoint: 'https://my-res.openai.azure.com',
    deployment: 'gpt-image-2',
    apiVersion: 'preview',
    apiKey: 'PLACEHOLDERPYKEY99',
  });
});

test('parseConsoleSample: missing fields come back null (never throws)', () => {
  const empty = { endpoint: null, deployment: null, apiKey: null, apiVersion: null };
  assert.deepEqual(A.parseConsoleSample('nothing to see here'), empty);
  assert.deepEqual(A.parseConsoleSample(''), empty);
  assert.deepEqual(A.parseConsoleSample(undefined), empty);
});

// =====================================================================
// Images
// =====================================================================

test('generateImage: v1 happy path decodes b64_json into a PNG Buffer', async () => {
  const png = Buffer.from('PLACEHOLDER-PNG-BYTES');
  const calls = installFetch(() => mockJson({ data: [{ b64_json: png.toString('base64') }] }));
  const buf = await A.generateImage({ endpoint: EP, key: KEY, deployment: 'gpt-image-2', prompt: 'x' });
  assert.ok(Buffer.isBuffer(buf));
  assert.equal(buf.toString(), 'PLACEHOLDER-PNG-BYTES');
  assert.equal(calls.length, 1, 'v1 success -> exactly one request');
  assert.match(calls[0].url, /\/openai\/v1\/images\/generations\?api-version=preview$/);
  assert.equal(JSON.parse(calls[0].opts.body).model, 'gpt-image-2', 'body model = deployment');
});

test('generateImage: v1 failure falls back to the classic deployments path', async () => {
  const png = Buffer.from('CLASSIC-PNG');
  let noteMsg = null;
  const calls = installFetch((url) =>
    url.includes('/openai/v1/images/generations')
      ? mockJson({ error: 'bad request' }, 400)
      : mockJson({ data: [{ b64_json: png.toString('base64') }] }));
  const buf = await A.generateImage({
    endpoint: EP, key: KEY, deployment: 'gpt-image-2', prompt: 'x', size: '720x1280',
    onNote: (m) => { noteMsg = m; },
  });
  assert.equal(buf.toString(), 'CLASSIC-PNG');
  assert.equal(calls.length, 2, 'v1 then classic');
  assert.match(calls[1].url, /\/openai\/deployments\/gpt-image-2\/images\/generations\?api-version=2025-04-01-preview$/);
  assert.equal(JSON.parse(calls[1].opts.body).size, '1024x1536', 'classic uses a discrete portrait size');
  assert.ok(noteMsg && noteMsg.includes('classic'), 'onNote reported the fallback');
});

test('editImage: multipart edit decodes b64_json into a PNG Buffer', async () => {
  const png = Buffer.from('EDITED-PNG');
  const calls = installFetch(() => mockJson({ data: [{ b64_json: png.toString('base64') }] }));
  const buf = await A.editImage({
    endpoint: EP, key: KEY, deployment: 'gpt-image-2', prompt: 'add a lamp', imageBuf: Buffer.from('IMG'),
  });
  assert.equal(buf.toString(), 'EDITED-PNG');
  assert.match(calls[0].url, /\/openai\/v1\/images\/edits\?api-version=preview$/);
  assert.ok(calls[0].opts.body instanceof FormData, 'edit posts multipart FormData');
});

// =====================================================================
// Video
// =====================================================================

test('video: createVideo -> pollVideo(terminal) -> downloadVideo', async () => {
  const mp4 = Buffer.from('MP4-BYTES');
  const calls = installFetch((url) => {
    if (url.includes('/content')) return mockBinary(mp4);
    if (/\/openai\/v1\/videos\/vid-1(\?|$)/.test(url)) return mockJson({ id: 'vid-1', status: 'completed', progress: 100 });
    if (url.includes('/openai/v1/videos')) return mockJson({ id: 'vid-1', status: 'queued' });
    return mockJson({}, 404);
  });

  const job = await A.createVideo({ endpoint: EP, key: KEY, prompt: 'fly in', inputReferencePng: Buffer.from('PNG') });
  assert.equal(job.id, 'vid-1');
  assert.ok(calls[0].opts.body instanceof FormData, 'createVideo posts multipart FormData');
  assert.match(calls[0].url, /\/openai\/v1\/videos\?api-version=preview$/);

  const ticks = [];
  const st = await A.pollVideo({ endpoint: EP, key: KEY, id: 'vid-1', onTick: (s, i) => ticks.push([s.status, i]) });
  assert.equal(st.status, 'completed');
  assert.equal(ticks.length, 1, 'terminal on the first poll -> no sleep/loop');

  const bytes = await A.downloadVideo({ endpoint: EP, key: KEY, id: 'vid-1' });
  assert.ok(Buffer.isBuffer(bytes));
  assert.equal(bytes.toString(), 'MP4-BYTES');
});

// =====================================================================
// azFetch auth fallback
// =====================================================================

test('azFetch: retries with Authorization Bearer after api-key gets 401', async () => {
  const calls = installFetch((_url, _opts, i) => (i === 0 ? mockJson({ error: 'unauthorized' }, 401) : mockJson({ ok: true })));
  const res = await A.azFetch(`${EP}/openai/v1/videos?api-version=preview`, { key: KEY });
  assert.equal(res.status, 200);
  assert.equal(res.ok, true);
  assert.equal(res.authStyle, 'Authorization');
  assert.equal(calls.length, 2, 'one api-key attempt + one Bearer retry');
  assert.equal(calls[0].opts.headers['api-key'], KEY, 'first attempt used the api-key header');
  assert.equal(calls[1].opts.headers.Authorization, `Bearer ${KEY}`, 'retry used Authorization: Bearer');
  assert.ok(!('api-key' in calls[1].opts.headers), 'retry did not resend api-key');
});

// =====================================================================
// estimateCost
// =====================================================================

test('estimateCost: $0.10/sec video + per-scene image gen', () => {
  assert.deepEqual(A.estimateCost({ nScenes: 3, seconds: 4 }), { images: 0.06, videos: 1.2, usd: 1.26 });
  assert.deepEqual(A.estimateCost({ nScenes: 3, seconds: 4, twoImage: true }), { images: 0.12, videos: 1.2, usd: 1.32 });
  assert.deepEqual(A.estimateCost({ nScenes: 0 }), { images: 0, videos: 0, usd: 0 });
});

// =====================================================================
// ffmpeg helpers: ARG ARRAY (not a shell string), flags
// =====================================================================

test('colorMatch: builds an ffmpeg arg ARRAY (never a shell string) with the expected flags', async () => {
  const seen = [];
  cp.spawnSync = (bin, args) => { seen.push({ bin, args }); return { status: 0, stdout: '', stderr: '' }; };
  const out = await A.colorMatch('/in/src.png', '/in/ref.png', '/out/matched.png', { ffmpeg: '/fake/ffmpeg' });
  assert.equal(out, '/out/matched.png');
  assert.equal(seen.length, 1);
  const { bin, args } = seen[0];
  assert.equal(bin, '/fake/ffmpeg');
  assert.ok(Array.isArray(args), 'args is an ARRAY');
  assert.ok(!args.some((a) => typeof a === 'string' && /\s-\w/.test(a)), 'no arg smuggles a shell-joined command');
  assert.ok(args.includes('-i') && args.includes('/in/src.png'), 'discrete -i <src>');
  assert.ok(args.includes('/out/matched.png'), 'discrete output argv entry');
  assert.match(args[args.indexOf('-vf') + 1], /histeq/, 'uses histeq histogram normalization');
});

test('concatClips: builds an arg ARRAY with one -i per clip, a concat filter, and -map', async () => {
  const seen = [];
  cp.spawnSync = (bin, args) => { seen.push({ bin, args }); return { status: 0, stdout: '', stderr: '' }; };
  const clips = ['/c/a.mp4', '/c/b.mp4', '/c/c.mp4'];
  const out = await A.concatClips(clips, '/out/chain.mp4', { ffmpeg: '/fake/ffmpeg' });
  assert.equal(out, '/out/chain.mp4');
  const { args } = seen[0];
  assert.ok(Array.isArray(args), 'args is an ARRAY');
  assert.equal(args.filter((a) => a === '-i').length, 3, 'one -i per clip');
  for (const c of clips) assert.ok(args.includes(c), `clip ${c} is its own argv entry`);
  assert.ok(args.includes('-filter_complex') && args.includes('-map') && args.includes('[v]'), 'has -filter_complex -map [v]');
  assert.match(args[args.indexOf('-filter_complex') + 1], /concat=n=3:v=1/, 'concat filter counts the clips');
  assert.ok(!args.some((a) => typeof a === 'string' && / -i /.test(a)), 'no shell-joined arg');
});

// =====================================================================
// resolveFfmpeg: env / PATH / windows .exe / not-found
// =====================================================================

test('resolveFfmpeg: $FFMPEG_PATH wins when it exists', async () => {
  const dir = mkTmp('adapter-ff-');
  const fake = path.join(dir, 'my-ffmpeg');
  fs.writeFileSync(fake, '');
  process.env.FFMPEG_PATH = fake;
  process.env.PATH = '';
  assert.equal(await A.resolveFfmpeg(), fake);
});

test('resolveFfmpeg: scans $PATH entries for the ffmpeg binary (no shell)', async () => {
  const dir = mkTmp('adapter-ff-');
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir);
  const fake = path.join(binDir, 'ffmpeg');
  fs.writeFileSync(fake, '');
  delete process.env.FFMPEG_PATH;
  process.env.PATH = ['/no/such/dir', binDir].join(path.delimiter);
  assert.equal(await A.resolveFfmpeg(), fake);
});

test('resolveFfmpeg: finds ffmpeg.exe on Windows (platform mocked)', async () => {
  const dir = mkTmp('adapter-ff-');
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir);
  const exe = path.join(binDir, 'ffmpeg.exe');
  fs.writeFileSync(exe, '');
  delete process.env.FFMPEG_PATH;
  process.env.PATH = binDir;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  assert.equal(await A.resolveFfmpeg(), exe, 'resolves the .exe name on win32');
});

test('resolveFfmpeg: throws an actionable error when nothing is found', async () => {
  delete process.env.FFMPEG_PATH;
  process.env.PATH = path.join(mkTmp('adapter-ff-'), 'empty');
  await assert.rejects(A.resolveFfmpeg(), /ffmpeg not found; run motion-graphic-setup or 3d-intro-setup/);
});

// =====================================================================
// creds round-trip (cross-platform path.join) + probeDims + redact
// =====================================================================

test('persistCreds + resolveCreds round-trip (cross-platform path.join; 0600 where supported)', () => {
  const dir = mkTmp('adapter-creds-');
  const projectDir = path.join(dir, 'proj');
  fs.mkdirSync(projectDir, { recursive: true });
  const target = path.join(projectDir, '.env.3d-intro.local');

  const written = A.persistCreds(
    { AZURE_SORA_ENDPOINT: EP, AZURE_SORA_API_KEY: KEY, _source: '/skip/me', NOTHING: null },
    { target },
  );
  // the returned path is exactly the path.join-built target (uses this OS's separator)
  assert.equal(written, target);
  assert.equal(written, path.join(projectDir, '.env.3d-intro.local'));

  const body = fs.readFileSync(target, 'utf8');
  assert.match(body, /^AZURE_SORA_ENDPOINT=https:\/\/unit-test\.example\.com$/m);
  assert.ok(!body.includes('_source'), 'underscore keys are not persisted');
  assert.ok(!body.includes('NOTHING'), 'null values are not persisted');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(target).mode & 0o777, 0o600, 'chmod 0600 on POSIX');
  }

  const creds = A.resolveCreds({ projectDir });
  assert.equal(creds.AZURE_SORA_ENDPOINT, EP);
  assert.equal(creds.AZURE_SORA_API_KEY, KEY);
  assert.equal(creds._source, target, 'reports the file it loaded');
});

test('probeDims: reads PNG IHDR width/height (no ffprobe)', () => {
  const buf = Buffer.alloc(24);
  buf.writeUInt32BE(0x89504e47, 0); // PNG signature (first 4 bytes)
  buf.writeUInt32BE(720, 16);       // width  @ offset 16
  buf.writeUInt32BE(1280, 20);      // height @ offset 20
  assert.deepEqual(A.probeDims(buf), { width: 720, height: 1280 });
  assert.throws(() => A.probeDims(Buffer.from('not a png at all')), /not a PNG/);
});

test('redact: masks the middle + appends length; short secrets fully masked', () => {
  assert.equal(A.redact('abcdefghijklmnop'), 'abcd…mnop(16)');
  assert.equal(A.redact('short'), '…(5)');
  assert.equal(A.redact(''), '(missing)');
  assert.equal(A.redact(null), '(missing)');
});

// keep HERE referenced (documents the co-located adapter under test)
test('adapter module resolves next to this test file', () => {
  assert.ok(fs.existsSync(path.join(HERE, 'azure-adapter.mjs')));
});
