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
import { fileURLToPath, pathToFileURL } from 'node:url';
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
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  cwd: process.cwd(),
  platform: Object.getOwnPropertyDescriptor(process, 'platform'),
};
const tmps = [];
const restoreEnv = (name) => { if (orig[name] === undefined) delete process.env[name]; else process.env[name] = orig[name]; };
afterEach(() => {
  globalThis.fetch = orig.fetch;
  cp.spawnSync = orig.spawnSync;
  for (const name of ['PATH', 'FFMPEG_PATH', 'HOME', 'USERPROFILE']) restoreEnv(name);
  process.chdir(orig.cwd);
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

test('generateImage: HTTP 429 waits Retry-After and retries v1 instead of falling back to classic', async () => {
  const b64 = Buffer.from('png-after-429').toString('base64');
  const calls = installFetch((url, opts, i) => {
    if (i < 2) {
      const r = mockJson({ error: { code: 'RateLimitReached' } }, 429);
      r.headers = { get: (k) => (String(k).toLowerCase() === 'retry-after' ? '0' : String(k).toLowerCase() === 'content-type' ? 'application/json' : null) };
      return r;
    }
    return mockJson({ data: [{ b64_json: b64 }] });
  });
  const notes = [];
  const buf = await A.generateImage({ endpoint: EP, key: KEY, deployment: 'img-dep', prompt: 'p', onNote: (m) => notes.push(m) });
  assert.equal(buf.toString(), 'png-after-429');
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c.url.includes('/openai/v1/images/generations')), 'never left the v1 path');
  assert.equal(notes.filter((m) => /HTTP 429/.test(m)).length, 2);
});

test('generateImage: 429 that outlasts the retries is reported, not masked by the classic path', async () => {
  const calls = installFetch(() => {
    const r = mockJson({ error: { code: 'RateLimitReached' } }, 429);
    r.headers = { get: (k) => (String(k).toLowerCase() === 'retry-after' ? '0' : String(k).toLowerCase() === 'content-type' ? 'application/json' : null) };
    return r;
  });
  await assert.rejects(() => A.generateImage({ endpoint: EP, key: KEY, deployment: 'img-dep', prompt: 'p', retry429: 1 }), /HTTP 429/);
  assert.equal(calls.length, 2);
});

test('generateImage: a lost connection on v1 is not retried on the classic path (it may have billed)', async () => {
  const calls = installFetch(() => { throw new TypeError('fetch failed'); });
  await assert.rejects(() => A.generateImage({ endpoint: EP, key: KEY, deployment: 'img-dep', prompt: 'p' }), /HTTP 0/);
  assert.equal(calls.length, 1);
});

test('createVideo: failures carry status and errno for the caller\'s billing decision', async () => {
  installFetch(() => { const e = new TypeError('fetch failed'); e.cause = Object.assign(new Error('x'), { code: 'ECONNRESET' }); throw e; });
  await assert.rejects(() => A.createVideo({ endpoint: EP, key: KEY, prompt: 'p' }), (e) => e.status === 0 && e.errno === 'ECONNRESET');
  installFetch(() => mockJson({ error: { code: 'too_many' } }, 429));
  await assert.rejects(() => A.createVideo({ endpoint: EP, key: KEY, prompt: 'p' }), (e) => e.status === 429);
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

test('pollVideo: a 4xx other than 408/429 stops at once with its status; an answer it cannot use is not polled to maxTicks', async () => {
  for (const [status, fetches] of [[404, 1], [400, 1], [401, 2]]) {
    const calls = installFetch(() => mockJson({ error: { code: 'NotFound', message: 'gone' } }, status));
    await assert.rejects(
      () => A.pollVideo({ endpoint: EP, key: KEY, id: 'vid-x', intervalMs: 1, maxTicks: 50, sleep: async () => {} }),
      (e) => e.status === status,
    );
    assert.equal(calls.length, fetches, `HTTP ${status} is not polled again (401 tries both auth styles once)`);
  }
});

test('pollVideo: 408, 429 and 5xx keep polling, paced by the injected sleep; an error body is not taken as status', async () => {
  const answers = [mockJson({ error: { code: 'TooMany' } }, 429), mockJson({}, 503), mockJson({}, 408), mockJson({ id: 'vid-x', status: 'completed' })];
  installFetch((url, opts, i) => answers[i]);
  const slept = [];
  const ticks = [];
  const st = await A.pollVideo({ endpoint: EP, key: KEY, id: 'vid-x', intervalMs: 1500, maxTicks: 50, sleep: async (ms) => { slept.push(ms); }, onTick: (s) => ticks.push(s) });
  assert.equal(st.status, 'completed');
  assert.deepEqual(slept, [1500, 1500, 1500]);
  assert.deepEqual(ticks.slice(0, 3), [null, null, null], 'no status seen until the first 2xx');
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

test('estimateCost: hold-and-flight bills only the flights between scenes; the holds are encoded stills', () => {
  assert.deepEqual(A.estimateCost({ nScenes: 7, mode: 'holdFlight' }), { images: 0.14, videos: 3, usd: 3.14 });
  assert.deepEqual(A.estimateCost({ nScenes: 7, mode: 'holdFlight', flightSeconds: 4 }), { images: 0.14, videos: 2.4, usd: 2.54 });
  assert.deepEqual(A.estimateCost({ nScenes: 1, mode: 'holdFlight' }), { images: 0.02, videos: 0, usd: 0.02 });
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

test('stillToClip: repeats the still for the hold, encoded as the engine wants, as an arg ARRAY', async () => {
  const seen = [];
  cp.spawnSync = (bin, args) => { seen.push({ bin, args }); return { status: 0, stdout: '', stderr: '' }; };
  const out = await A.stillToClip('/in/s1.png', '/out/hold-1.mp4', { ffmpeg: '/fake/ffmpeg', size: '720x1280' });
  assert.equal(out, '/out/hold-1.mp4');
  const { bin, args } = seen[0];
  assert.equal(bin, '/fake/ffmpeg');
  assert.ok(Array.isArray(args));
  const after = (flag) => args[args.indexOf(flag) + 1];
  assert.deepEqual([after('-loop'), after('-i'), after('-t'), after('-r')], ['1', '/in/s1.png', '1', '24']);
  assert.equal(after('-vf'), 'scale=720:1280,format=yuv420p');
  assert.deepEqual([after('-c:v'), after('-crf'), after('-g'), after('-movflags')], ['libx264', '20', '8', '+faststart']);
  assert.ok(args.includes('-an') && args.at(-1) === '/out/hold-1.mp4');
  await A.stillToClip('/in/s1.png', '/out/h.mp4', { ffmpeg: '/fake/ffmpeg', seconds: 2 });
  assert.deepEqual([seen[1].args[seen[1].args.indexOf('-t') + 1], seen[1].args[seen[1].args.indexOf('-vf') + 1]], ['2', 'format=yuv420p']);
  cp.spawnSync = () => ({ status: 1, stdout: '', stderr: 'Unknown encoder libx264' });
  await assert.rejects(A.stillToClip('/in/s1.png', path.join(os.tmpdir(), 'never-written.mp4'), { ffmpeg: '/fake/ffmpeg' }), /stillToClip failed: Unknown encoder/);
  const old = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hold-')), 'hold-1.mp4');
  fs.writeFileSync(old, 'a hold from an earlier run');
  await assert.rejects(A.stillToClip('/in/s1.png', old, { ffmpeg: '/fake/ffmpeg' }), /stillToClip failed/, 'an earlier file never passes for a failed run');
  assert.equal(fs.existsSync(old), false);
  fs.rmSync(path.dirname(old), { recursive: true, force: true });
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
  useHome(path.join(dir, 'home'));
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
  useHome(path.join(dir, 'home'));
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  assert.equal(await A.resolveFfmpeg(), exe, 'resolves the .exe name on win32');
});

test('resolveFfmpeg: throws an actionable error when nothing is found', async () => {
  delete process.env.FFMPEG_PATH;
  useHome(path.join(mkTmp('adapter-home-'), 'home'));
  process.env.PATH = path.join(mkTmp('adapter-ff-'), 'empty');
  await assert.rejects(A.resolveFfmpeg(), /ffmpeg not found; run motion-graphic-setup or 3d-intro-setup/);
});

// A home folder of its own for this test (os.homedir() reads HOME, or USERPROFILE on Windows).
function useHome(home) {
  fs.mkdirSync(path.join(home, '.config', 'banker', '3d-intro'), { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return path.join(home, '.config', 'banker', '3d-intro', 'env');
}

test('resolveFfmpeg: the program comes from the shell, the settings file or the home key file, never from a project key file or a relative PATH entry', async () => {
  const root = mkTmp('ff-trust-');
  const homeFile = useHome(path.join(root, 'home'));
  const proj = path.join(root, 'project');
  fs.mkdirSync(proj);
  const planted = path.join(proj, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  fs.writeFileSync(planted, '');
  fs.writeFileSync(path.join(proj, '.env.3d-intro.local'), `FFMPEG_PATH=${planted}\n`);
  delete process.env.FFMPEG_PATH;
  process.env.PATH = ['.', 'bin', path.join(root, 'empty')].join(path.delimiter);
  process.chdir(proj);
  await assert.rejects(A.resolveFfmpeg(), /ffmpeg not found/, 'a file that came with the project picks nothing');
  const mine = path.join(root, 'my-ffmpeg');
  fs.writeFileSync(mine, '');
  fs.writeFileSync(homeFile, `FFMPEG_PATH=${mine}\n`);
  assert.equal(await A.resolveFfmpeg(), mine, 'a path an earlier setup left in the home key file still counts');
  const set = path.join(root, 'set-ffmpeg');
  fs.writeFileSync(set, '');
  fs.writeFileSync(A.homeSettingsPath(), `FFMPEG_PATH=${set}\n`);
  assert.equal(await A.resolveFfmpeg(), set, 'the settings file comes before the key file');
});

test('resolveFfmpeg: a settings or key file it cannot read names nothing; a usable shell value is taken without reading them', async () => {
  const root = mkTmp('ff-unread-');
  useHome(path.join(root, 'home'));
  fs.mkdirSync(A.homeSettingsPath());
  fs.mkdirSync(A.homeCredsPath());
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const onPath = path.join(bin, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  fs.writeFileSync(onPath, '');
  delete process.env.FFMPEG_PATH;
  process.env.PATH = bin;
  assert.equal(await A.resolveFfmpeg(), onPath, 'the unreadable files are passed over');
  const mine = path.join(root, 'mine');
  fs.writeFileSync(mine, '');
  process.env.FFMPEG_PATH = mine;
  assert.equal(await A.resolveFfmpeg(), mine);
});

test('resolveCreds: a program path in a project key file is left out and reported; the home key file keeps it', () => {
  const root = mkTmp('creds-ff-');
  const homeFile = useHome(path.join(root, 'home'));
  const proj = path.join(root, 'project');
  fs.mkdirSync(proj);
  fs.writeFileSync(path.join(proj, '.env.3d-intro.local'), 'AZURE_SORA_API_KEY=placeholder-k\nFFMPEG_PATH=./tools/run.sh\n');
  const c = A.resolveCreds({ projectDir: proj });
  assert.deepEqual([c.AZURE_SORA_API_KEY, c.FFMPEG_PATH, c._ignored], ['placeholder-k', undefined, { FFMPEG_PATH: './tools/run.sh' }]);
  fs.rmSync(path.join(proj, '.env.3d-intro.local'));
  fs.writeFileSync(homeFile, 'FFMPEG_PATH=/opt/ffmpeg/bin/ffmpeg\n');
  assert.equal(A.resolveCreds({ projectDir: proj }).FFMPEG_PATH, '/opt/ffmpeg/bin/ffmpeg');
  assert.equal(A.homeCredsPath(), homeFile);
});

test('resolveFfmpeg: a relative FFMPEG_PATH, from the shell or the home file, is not resolved against the current folder', async () => {
  const root = mkTmp('ff-rel-');
  const homeFile = useHome(path.join(root, 'home'));
  const proj = path.join(root, 'project');
  fs.mkdirSync(path.join(proj, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'bin', 'ffmpeg'), '');
  process.env.PATH = path.join(root, 'empty');
  process.chdir(proj);
  process.env.FFMPEG_PATH = path.join('bin', 'ffmpeg');
  await assert.rejects(A.resolveFfmpeg(), /ffmpeg not found/, 'shell value');
  delete process.env.FFMPEG_PATH;
  fs.writeFileSync(homeFile, `FFMPEG_PATH=${path.join('bin', 'ffmpeg')}\n`);
  fs.writeFileSync(A.homeSettingsPath(), `FFMPEG_PATH=${path.join('bin', 'ffmpeg')}\n`);
  await assert.rejects(A.resolveFfmpeg(), /ffmpeg not found/, 'settings and key file values');
});

test('persistCreds: a value or name with a line break is refused and nothing is written, so a sample cannot add lines', () => {
  const target = path.join(mkTmp('persist-nl-'), 'env');
  fs.writeFileSync(target, 'AZURE_SORA_ENDPOINT=https://sora.example.com\n');
  for (const creds of [{ AZURE_SORA_DEPLOYMENT: 'sora-2\nFFMPEG_PATH=/usr/bin/true' }, { AZURE_SORA_DEPLOYMENT: 'a\rb' }, { 'X\nFFMPEG_PATH': '1' }]) {
    assert.throws(() => A.persistCreds(creds, { target }), /line break|not a variable name/);
  }
  assert.equal(fs.readFileSync(target, 'utf8'), 'AZURE_SORA_ENDPOINT=https://sora.example.com\n');
  const p = A.parseConsoleSample('client = AzureOpenAI(azure_endpoint="https://r.example.com", model="sora-2\nFFMPEG_PATH=/usr/bin/true")');
  assert.ok(!/[\r\n]/.test(JSON.stringify(Object.values(p))) && !String(p.deployment).includes('FFMPEG_PATH'), JSON.stringify(p));
});

test('persistCreds: a key folder it creates is private', { skip: process.platform === 'win32' && 'POSIX modes' }, () => {
  const dir = path.join(mkTmp('persist-dir-'), 'a', 'b');
  A.persistCreds({ X: '1' }, { target: path.join(dir, 'env') });
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
});

// =====================================================================
// creds round-trip (cross-platform path.join) + probeDims + redact
// =====================================================================

test('parseEnvFile: a " # comment" after an unquoted value is dropped; quotes and a bare # keep the text', () => {
  const env = A.parseEnvFile([
    'WAN_1_ENDPOINT=https://ws.example.com     # origin only',
    'VIDEO_PROVIDER_ORDER=wan,sora  # fallback',
    'QUOTED="a # b" # note',
    "SINGLE='c#d'",
    'BARE=e#f',
    'WAN_MODEL=   # optional, left empty',
    'HASHY=#x',
    'STRAY_CR=kept # note\r\r',
    '# FULL=a comment line',
    'LAST_CR=z\r',
  ].join('\n'));
  assert.deepEqual(env, { WAN_1_ENDPOINT: 'https://ws.example.com', VIDEO_PROVIDER_ORDER: 'wan,sora', QUOTED: 'a # b', SINGLE: 'c#d', BARE: 'e#f', WAN_MODEL: '', HASHY: '#x', STRAY_CR: 'kept', LAST_CR: 'z' });
});

test('persistCreds: a value the parser would cut at " #" or strip of quotes reads back unchanged', () => {
  const dir = mkTmp('az-persist-quote-');
  const target = path.join(dir, '.env.3d-intro.local');
  const values = { NOTE_PATH: 'C:\\Program Files\\ff #2\\ffmpeg.exe', QUOTED_LOOK: '"x"', TRAILING_QUOTE: 'abc"', SPACED: ' padded ', LEAD: ' lead', TRAIL: 'trail ', PLAIN: 'https://r.example.com' };
  A.persistCreds(values, { target });
  assert.deepEqual(A.parseEnvFile(fs.readFileSync(target, 'utf8')), values);
});

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

test('redact: shows only the length, no character of the secret (an sk-ws- key would give its tail away)', () => {
  assert.equal(A.redact('abcdefghijklmnop'), '…(16)');
  assert.equal(A.redact('sk-ws-0123456789abcdef'), '…(22)');
  assert.equal(A.redact('short'), '…(5)');
  assert.equal(A.redact(''), '(missing)');
  assert.equal(A.redact(null), '(missing)');
});

test('parseConsoleSample: an endpoint field that is not a URL comes back null, never as its raw text', () => {
  const p = A.parseConsoleSample('client = AzureOpenAI(azure_endpoint="sk-pasted-in-the-wrong-field-0123", api_key="PLACEHOLDER")');
  assert.equal(p.endpoint, null);
  assert.ok(!JSON.stringify(p).includes('sk-pasted'), 'the pasted value is not echoed back');
});

// A fetch stub that answers by URL: [status, location] for a redirect, else 200 with `body`.
function routeFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    const hit = routes[String(url)];
    if (!hit) throw new Error(`unrouted ${url}`);
    return hit.location ? new Response('', { status: hit.status, headers: { location: hit.location } }) : new Response(hit.body ?? 'ok', { status: 200 });
  };
  return calls;
}

test('fetchGuarded: a redirect to another origin never carries the key, and a request with a body is not sent there', async () => {
  const calls = routeFetch({
    'https://api.example.com/content': { status: 302, location: 'https://blob.example.net/v.mp4?sig=1' },
    'https://blob.example.net/v.mp4?sig=1': { body: 'video' },
    'https://api.example.com/create': { status: 307, location: 'https://elsewhere.example.org/collect' },
    'https://api.example.com/same': { status: 307, location: '/moved' },
    'https://api.example.com/moved': { body: 'done' },
  });
  const r = await A.fetchGuarded('https://api.example.com/content', { headers: { 'api-key': 'k', Authorization: 'Bearer k', Accept: 'video/mp4' } });
  assert.equal(await r.text(), 'video');
  assert.equal(calls[0].opts.redirect, 'manual');
  assert.deepEqual(Object.keys(calls[1].opts.headers), ['Accept'], 'the other origin gets no key');
  await assert.rejects(A.fetchGuarded('https://api.example.com/create', { method: 'POST', headers: { 'api-key': 'k' }, body: '{"prompt":"p"}' }),
    (e) => e.cause?.code === 'ECROSSREDIRECT');
  assert.ok(!calls.some((c) => c.url.startsWith('https://elsewhere.example.org')), 'the prompt never left for the other origin');
  const s = await A.fetchGuarded('https://api.example.com/same', { method: 'POST', headers: { 'api-key': 'k' }, body: 'b' });
  assert.equal(await s.text(), 'done');
  assert.deepEqual([calls.at(-1).opts.headers['api-key'], calls.at(-1).opts.body], ['k', 'b'], 'the same origin keeps both');
});

test('azFetch: Azure requests go through the guarded fetch (manual redirects)', async () => {
  const calls = routeFetch({ 'https://res.example.com/x': { body: '{}' } });
  await A.azFetch('https://res.example.com/x', { key: 'k' });
  assert.equal(calls[0].opts.redirect, 'manual');
});

test('fetchGuarded: a key is not sent over http, except to this machine; a request without a key may go', async () => {
  const calls = routeFetch({ 'http://localhost:9/x': { body: 'local' }, 'http://plain.example.com/open': { body: 'open' } });
  for (const headers of [{ 'api-key': 'k' }, [['Authorization', 'Bearer k']], new Headers({ 'api-key': 'k' })]) {
    await assert.rejects(A.fetchGuarded('http://plain.example.com/x', { headers }), (e) => e.cause?.code === 'EINSECURE');
  }
  assert.equal(calls.length, 0, 'nothing left this machine');
  assert.equal(await (await A.fetchGuarded('http://localhost:9/x', { headers: { 'api-key': 'k' } })).text(), 'local');
  assert.equal(await (await A.fetchGuarded('http://plain.example.com/open')).text(), 'open');
});

test('azFetch: an http endpoint gets no key; the result says why, and nothing is sent', async () => {
  const calls = routeFetch({});
  const r = await A.azFetch('http://res.example.com/openai/v1/videos?api-version=preview', { key: 'k' });
  assert.deepEqual([r.status, r.error?.cause?.code, calls.length], [0, 'EINSECURE', 0]);
});

test('fetchGuarded: a redirect away from https, or a Location that is not a URL, ends the request', async () => {
  const calls = routeFetch({
    'https://oss.example.com/v.mp4': { status: 302, location: 'http://169.254.169.254/latest/meta-data/' },
    'https://api.example.com/to-local': { status: 302, location: 'http://127.0.0.1:8080/admin' },
    'https://api.example.com/bad': { status: 302, location: 'http://[' },
    'http://127.0.0.1:8080/a': { status: 307, location: '/b' },
    'http://127.0.0.1:8080/b': { body: 'local' },
  });
  await assert.rejects(A.fetchGuarded('https://oss.example.com/v.mp4'), (e) => e.cause?.code === 'EINSECUREREDIRECT');
  await assert.rejects(A.fetchGuarded('https://api.example.com/to-local'), (e) => e.cause?.code === 'EINSECUREREDIRECT');
  await assert.rejects(A.fetchGuarded('https://api.example.com/bad'), (e) => e.cause?.code === 'EBADREDIRECT');
  assert.ok(!calls.some((c) => c.url.includes('169.254') || c.url.includes('/admin')), 'neither address was fetched');
  const r = await A.fetchGuarded('http://127.0.0.1:8080/a', { method: 'POST', headers: { 'api-key': 'k' }, body: 'b' });
  assert.equal(await r.text(), 'local', 'a local mock may redirect within this machine');
});

test('fetchGuarded: http is followed only while the request stays on this machine over http', async () => {
  const calls = routeFetch({
    'https://api.example.com/via-local': { status: 302, location: 'https://localhost/b' },
    'https://localhost/b': { status: 302, location: 'http://localhost:8080/c' },
    'http://localhost:8080/c': { body: 'local service' },
  });
  await assert.rejects(A.fetchGuarded('https://api.example.com/via-local'), (e) => e.cause?.code === 'EINSECUREREDIRECT');
  assert.ok(!calls.some((c) => c.url.startsWith('http://localhost:8080')), 'the local http service was not reached');
});

test('fetchGuarded: a request with a body is never followed to another origin, not even as a GET', async () => {
  for (const status of [301, 302, 303, 307]) {
    const calls = routeFetch({ 'https://api.example.com/submit': { status, location: 'https://elsewhere.example.org/x' }, 'https://elsewhere.example.org/x': { body: 'other' } });
    await assert.rejects(A.fetchGuarded('https://api.example.com/submit', { method: 'POST', headers: { 'api-key': 'k' }, body: 'b' }),
      (e) => e.cause?.code === 'ECROSSREDIRECT', String(status));
    assert.equal(calls.length, 1, `${status}: the other origin's answer can never be read as this key's answer`);
  }
  const calls = routeFetch({
    'https://api.example.com/submit': { status: 303, location: '/status' },
    'https://api.example.com/status': { status: 302, location: 'https://elsewhere.example.org/x' },
    'https://elsewhere.example.org/x': { body: 'other' },
  });
  await assert.rejects(A.fetchGuarded('https://api.example.com/submit', { method: 'POST', headers: { 'api-key': 'k' }, body: 'b' }),
    (e) => e.cause?.code === 'EBODYREDIRECT', 'nor turned into a GET within its origin first');
  assert.equal(calls.length, 1);
});

test('azFetch helpers: a request refused before sending says why in the error', async () => {
  const calls = routeFetch({});
  await assert.rejects(A.generateImage({ endpoint: 'http://img.example.com', key: 'k', deployment: 'd', prompt: 'p' }), /HTTP 0 \(EINSECURE\)/);
  await assert.rejects(A.downloadVideo({ endpoint: 'http://sora.example.com', key: 'k', id: 'v' }), /HTTP 0 \(EINSECURE\)/);
  await assert.rejects(A.createVideo({ endpoint: 'http://sora.example.com', key: 'k', prompt: 'p' }), (e) => /\(EINSECURE\)/.test(e.message) && e.errno === 'EINSECURE');
  assert.equal(calls.length, 0);
});

test('fetchGuarded: the key is found in every header form fetch takes, and the other headers go on', async () => {
  for (const headers of [[['api-key', 'secret-1'], ['Accept', 'video/mp4']], new Headers({ 'api-key': 'secret-1', Accept: 'video/mp4' })]) {
    const calls = routeFetch({
      'https://api.example.com/content': { status: 302, location: 'https://blob.example.net/v.mp4' },
      'https://blob.example.net/v.mp4': { body: 'video' },
    });
    assert.equal(await (await A.fetchGuarded('https://api.example.com/content', { headers })).text(), 'video');
    const sent = new Headers(calls[1].opts.headers);
    assert.equal(sent.get('accept'), 'video/mp4');
    assert.ok(![...sent].some(([k, v]) => `${k}${v}`.includes('secret-1')), 'the other origin gets no key');
  }
});

test('fetchGuarded: a request with a body follows only a 307 or 308 within its origin, sent again as it was', async () => {
  for (const status of [307, 308]) {
    const calls = routeFetch({ 'https://api.example.com/a': { status, location: '/b' }, 'https://api.example.com/b': { body: 'ok' } });
    await A.fetchGuarded('https://api.example.com/a', { method: 'POST', headers: { 'api-key': 'k' }, body: 'b' });
    assert.deepEqual([calls[1].opts.method, calls[1].opts.body, calls[1].opts.headers['api-key']], ['POST', 'b', 'k'], String(status));
  }
  for (const status of [301, 302, 303]) {
    const calls = routeFetch({ 'https://api.example.com/a': { status, location: '/b' }, 'https://api.example.com/b': { body: 'ok' } });
    await assert.rejects(A.fetchGuarded('https://api.example.com/a', { method: 'POST', headers: { 'api-key': 'k' }, body: 'b' }),
      (e) => e.cause?.code === 'EBODYREDIRECT', String(status));
    assert.equal(calls.length, 1, `${status}: a GET's answer is never read as the POST's`);
  }
});

test('fetchGuarded: a request without a body follows any redirect; 303, and 301 or 302 after a POST, go on as a GET', async () => {
  for (const [status, method, want] of [[303, 'GET', 'GET'], [302, 'GET', 'GET'], [301, 'GET', 'GET'], [307, 'GET', 'GET'], [302, 'POST', 'GET'], [303, 'POST', 'GET'], [308, 'POST', 'POST']]) {
    const calls = routeFetch({ 'https://api.example.com/a': { status, location: '/b' }, 'https://api.example.com/b': { body: 'ok' } });
    await A.fetchGuarded('https://api.example.com/a', { method, headers: { 'api-key': 'k' } });
    assert.equal(calls[1].opts.method, want, `${status} after ${method}`);
  }
});

test('fetchGuarded: at most 5 redirects are followed', async () => {
  const chain = (n) => Object.fromEntries([...Array(n).keys()].map((i) => [`https://api.example.com/${i}`, { status: 302, location: `/${i + 1}` }])
    .concat([[`https://api.example.com/${n}`, { body: 'end' }]]));
  let calls = routeFetch(chain(5));
  assert.equal(await (await A.fetchGuarded('https://api.example.com/0')).text(), 'end');
  assert.equal(calls.length, 6);
  calls = routeFetch(chain(6));
  await assert.rejects(A.fetchGuarded('https://api.example.com/0'), (e) => e.cause?.code === 'ETOOMANYREDIRECTS');
  assert.equal(calls.length, 6, 'the sixth redirect is not followed');
});

test('parseConsoleSample: an SDK key argument counts only when quoted; a variable name is never taken for the key', () => {
  for (const sample of [
    'client = AzureOpenAI(azure_endpoint=endpoint, api_key=subscription_key, api_version="2025-04-01-preview")',
    'client = AzureOpenAI(api_key=os.getenv("AZURE_OPENAI_API_KEY"))',
    'const client = new AzureOpenAI({ apiKey: process.env.AZURE_OPENAI_API_KEY });',
    'headers = {"api-key": os.environ["AZURE_OPENAI_API_KEY"]}',
    'curl -H "api-key: $AZURE_API_KEY" https://r.example.com/x',
  ]) assert.equal(A.parseConsoleSample(sample).apiKey, null, sample);
  for (const sample of ['api_key="PLACEHOLDER-1"', "apiKey: 'PLACEHOLDER-1'", 'headers = {"api-key": "PLACEHOLDER-1"}', 'curl -H "api-key: PLACEHOLDER-1"']) {
    assert.equal(A.parseConsoleSample(sample).apiKey, 'PLACEHOLDER-1', sample);
  }
});

test('3d-intro-setup: keys are written by the person into a private file, never into a command the agent runs', () => {
  const doc = fs.readFileSync(path.join(HERE, '..', '..', '3d-intro-setup', 'SKILL.md'), 'utf8');
  assert.doesNotMatch(doc, /API_KEY: '<입력값>'/, 'no key placeholder inside a node -e command');
  assert.match(doc, /umask 077/, 'the key file is created private');
  assert.match(doc, /Model Studio[^\n]*(교체|재발급)/, 'WAN keys get rotation advice too');
  assert.doesNotMatch(doc, /key 를 물어본다/, 'the FLUX key is not asked for in chat either');
  assert.ok(doc.includes('[ -e ~/.config/banker/3d-intro/env ] || (umask 077 && touch .env.3d-intro.local)'),
    'an empty project key file is not created over a home key file');
});

test('3d-intro-build: the program path is not copied from the key file into FFMPEG_PATH', () => {
  const doc = fs.readFileSync(path.join(HERE, '..', 'SKILL.md'), 'utf8');
  assert.doesNotMatch(doc, /process\.env\.FFMPEG_PATH\s*=\s*creds\.FFMPEG_PATH/);
  const setup = fs.readFileSync(path.join(HERE, '..', '..', '3d-intro-setup', 'SKILL.md'), 'utf8');
  for (const d of [doc, setup]) assert.doesNotMatch(d, /JSON\.stringify\(\w+\._ignored\)/, 'a value that came with a repository is not echoed, only its name');
  assert.doesNotMatch(setup, /npm install --no-save ffmpeg-static/, 'the fallback is not installed by npm inside the project');
});

// setup §2 run in a project folder of its own, with a home folder of its own.
function runSetupFfmpeg(projectEnv, env) {
  const root = mkTmp('setup-ff-');
  const home = path.join(root, 'home');
  const proj = path.join(root, 'project');
  fs.mkdirSync(home);
  fs.mkdirSync(proj);
  fs.writeFileSync(path.join(proj, '.env.3d-intro.local'), projectEnv);
  const r = orig.spawnSync(process.execPath, ['-e', setupScript('## 2. ffmpeg 확보')],
    { cwd: proj, env: { ...process.env, HOME: home, USERPROFILE: home, ...env }, encoding: 'utf8' });
  const conf = path.join(home, '.config', 'banker', '3d-intro');
  return { r, root, proj, settings: path.join(conf, 'settings.env'), keyFile: path.join(conf, 'env') };
}

test('3d-intro-setup: an ffmpeg found only through the shell is saved to the settings file, never to a key file', () => {
  const fake = path.join(mkTmp('setup-ff-bin-'), 'ffmpeg-bin');
  fs.writeFileSync(fake, '');
  const s = runSetupFfmpeg('AZURE_SORA_API_KEY=placeholder-k\n', { FFMPEG_PATH: fake });
  assert.equal(s.r.status, 0, s.r.stderr);
  assert.equal(fs.existsSync(s.settings) && A.parseEnvFile(fs.readFileSync(s.settings, 'utf8')).FFMPEG_PATH, fake);
  assert.equal(fs.existsSync(s.keyFile), false, 'no home key file appears, so the key-file step is not misled');
  assert.equal(fs.readFileSync(path.join(s.proj, '.env.3d-intro.local'), 'utf8'), 'AZURE_SORA_API_KEY=placeholder-k\n', 'the project key file is untouched');
});

test('3d-intro-setup: a path left in the project key file is named even when no ffmpeg is found', () => {
  const s = runSetupFfmpeg('FFMPEG_PATH=/old/project/ffmpeg\n', { FFMPEG_PATH: '', PATH: path.join(mkTmp('setup-ff-path-'), 'empty') });
  assert.equal(s.r.status, 1, s.r.stderr);
  assert.match(s.r.stdout, /프로젝트 키 파일에서 쓰지 않는 값: FFMPEG_PATH/);
  assert.match(s.r.stdout, /ffmpeg 미확보/);
  assert.ok(!s.r.stdout.includes('/old/project/ffmpeg'), 'the value itself is not shown');
});

// The JavaScript of the first `node -e "..."` command after `heading` in the setup skill, with the
// modules filled in where the shell puts $ADAPTER and $POOL.
function setupScript(heading) {
  const doc = fs.readFileSync(path.join(HERE, '..', '..', '3d-intro-setup', 'SKILL.md'), 'utf8');
  const body = doc.slice(doc.indexOf(heading)).match(/node -e "\r?\n([\s\S]*?)\r?\n"/)[1];
  return body.replaceAll('$ADAPTER', pathToFileURL(path.join(HERE, 'azure-adapter.mjs')).href)
    .replaceAll('$POOL', pathToFileURL(path.join(HERE, 'video-pool.mjs')).href);
}

// A project folder without a key file, and a home folder whose fallback key file holds a key the person wrote.
function setupFolders() {
  const root = mkTmp('setup-doc-');
  const home = path.join(root, 'home');
  const homeFile = path.join(home, '.config', 'banker', '3d-intro', 'env');
  fs.mkdirSync(path.dirname(homeFile), { recursive: true });
  fs.mkdirSync(path.join(root, 'project'));
  fs.writeFileSync(homeFile, 'AZURE_SORA_ENDPOINT=https://sora.example.com\nAZURE_SORA_API_KEY=placeholder-human-key-0001\n');
  const run = (heading, args) => orig.spawnSync(process.execPath, ['-e', setupScript(heading), ...args],
    { cwd: path.join(root, 'project'), env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8' });
  return { root, homeFile, projectFile: path.join(root, 'project', '.env.3d-intro.local'), run };
}

test('3d-intro-setup: modes (a) and (b) write into the key file already in use, so a home key file is never hidden', () => {
  const f = setupFolders();
  const sample = path.join(f.root, 'sample.txt');
  const keyOf = () => A.parseEnvFile(fs.readFileSync(f.homeFile, 'utf8')).AZURE_SORA_API_KEY;
  fs.writeFileSync(sample, 'client = AzureOpenAI(azure_endpoint="https://sora.example.com", api_key=subscription_key)');
  let r = f.run('### 모드 (b)', [sample, 'sora']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(f.projectFile), false, 'no new project file hides the home one');
  assert.equal(keyOf(), 'placeholder-human-key-0001', 'a variable name in the sample never replaces the key');
  fs.writeFileSync(sample, 'curl https://sora.example.com/openai/v1/videos -H "api-key: placeholder-sample-key-02"');
  r = f.run('### 모드 (b)', [sample, 'sora']);
  const out = JSON.parse(r.stdout);
  assert.deepEqual([out.apiKey, out.replaced], [A.redact('placeholder-sample-key-02'), A.redact('placeholder-human-key-0001')], 'a replaced key is shown by length');
  assert.ok(!r.stdout.includes('placeholder-'), 'no key text on screen');
  assert.equal(keyOf(), 'placeholder-sample-key-02');
  r = f.run('### 모드 (a)', []);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(f.projectFile), false);
  assert.equal(keyOf(), 'placeholder-sample-key-02', 'mode (a) keeps the key it never sees');
});

test('3d-intro-setup: a sample for another endpoint without its own key is not saved, so the old key never meets the new host', () => {
  const f = setupFolders();
  const sample = path.join(f.root, 'sample.txt');
  const before = fs.readFileSync(f.homeFile, 'utf8');
  fs.writeFileSync(sample, 'client = AzureOpenAI(azure_endpoint="https://other.example.net", api_key=subscription_key)');
  const r = f.run('### 모드 (b)', [sample, 'sora']);
  assert.equal(r.status, 3, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).endpointChanged, { from: 'https://sora.example.com', to: 'https://other.example.net' });
  assert.equal(fs.readFileSync(f.homeFile, 'utf8'), before, 'nothing written');
});

test('3d-intro-setup: the free preflight says why a request was not sent, and sends nothing for a bad endpoint', () => {
  const f = setupFolders();
  fs.writeFileSync(f.projectFile, 'AZURE_SORA_ENDPOINT=not-a-url\nAZURE_SORA_API_KEY=placeholder-k1\nAZURE_IMAGE_OPENAI_ENDPOINT=http://img.invalid\nAZURE_IMAGE_API_KEY=placeholder-k2\n');
  const r = f.run('## 4. 프리플라이트', []);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /sora\.listVideos -> 0 \(ERR_INVALID_URL\)/);
  assert.match(r.stdout, /images\.badreq -> 0 \(EINSECURE\)/);
  assert.ok(!r.stdout.includes('placeholder-'), 'keys only by length');
});

// keep HERE referenced (documents the co-located adapter under test)
test('adapter module resolves next to this test file', () => {
  assert.ok(fs.existsSync(path.join(HERE, 'azure-adapter.mjs')));
});
