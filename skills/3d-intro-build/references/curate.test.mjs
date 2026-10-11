// Tests for curate.mjs, the review page of the 3d-intro-build and motion-graphic-make skills.
// Run from the repo root: node --test skills/3d-intro-build/references/curate.test.mjs
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  archiveRejected, hashFile, readDecisions, readInput, recordDecision, renderPage, startCurate,
} from './curate.mjs';
import { readState, stopServer } from './preview-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NOW = new Date('2026-10-10T03:00:00Z');
const made = [];
process.on('exit', () => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

// A project folder with two scenes: scene 1 has two still takes, scene 2 one clip take (a flight).
function project(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curate-'));
  made.push(dir);
  fs.mkdirSync(path.join(dir, 'stills'));
  fs.mkdirSync(path.join(dir, 'clips'));
  for (const f of ['stills/s1-t1.png', 'stills/s1-t2.png', 'stills/s2.png', 'stills/s3.png']) fs.writeFileSync(path.join(dir, f), `png ${f}`);
  fs.writeFileSync(path.join(dir, 'clips/flight-2.mp4'), 'mp4 bytes');
  const input = {
    title: 'Demo', stage: 'stills', budgetUsd: 12, scenes: [
      { id: 's1', label: '문제 제기', takes: [
        { file: 'stills/s1-t1.png', take: 1, prompt: 'A <b>bold</b> city', negativePrompt: 'text, logos', model: 'gpt-image-2',
          size: '1280x720', createdAt: '2026-10-10T01:00:00Z', costUsd: 0.04 },
        { file: 'stills/s1-t2.png', take: 2, prompt: 'A calmer city', model: 'gpt-image-2', size: '1280x720', costUsd: 0.04 },
      ] },
      { id: 's2', label: '해법', takes: [
        { file: 'clips/flight-2.mp4', take: 1, prompt: 'Glide over the wall', model: 'wan3.0-video-prime', seconds: 5,
          firstFrame: 'stills/s2.png', lastFrame: 'stills/s3.png', costUsd: 0.5 },
      ] },
    ], ...extra,
  };
  fs.writeFileSync(path.join(dir, 'curate-input.json'), JSON.stringify(input));
  return dir;
}

const post = (port, body, headers = { 'Content-Type': 'application/json' }) =>
  fetch(`http://127.0.0.1:${port}/decide`, { method: 'POST', headers, body: JSON.stringify(body) });
const sha = (dir, f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex');

test('every take shows its prompt, exclusions, model, size, time, cost, path and sha256', async () => {
  const dir = project();
  const html = await renderPage(readInput(dir), readDecisions(dir), { dir });
  for (const text of ['A &lt;b&gt;bold&lt;/b&gt; city', 'text, logos', 'gpt-image-2', '1280x720', '2026-10-10T01:00:00Z',
    '$0.04', 'stills/s1-t1.png', sha(dir, 'stills/s1-t1.png'), '테이크 2']) {
    assert.ok(html.includes(text), `missing ${text}`);
  }
  assert.doesNotMatch(html, /<b>bold<\/b>/, 'a prompt is text, never markup');
});

test('a take is hashed in chunks, hashed anew once its file changes, and a folder in its place fails', async () => {
  const dir = project();
  const clip = path.join(dir, 'clips/flight-2.mp4');
  fs.writeFileSync(clip, crypto.randomBytes(300 * 1024 + 7));
  assert.equal(await hashFile(clip), sha(dir, 'clips/flight-2.mp4'), 'a file of several read chunks');
  fs.appendFileSync(clip, 'a regenerated take');
  fs.mkdirSync(path.join(dir, 'stills', 'folder.png'));
  const input = readInput(dir);
  input.scenes[0].takes.push({ file: 'stills/folder.png', take: 3 });
  const html = await renderPage(input, readDecisions(dir), { dir });
  assert.ok(html.includes(sha(dir, 'clips/flight-2.mp4')), 'the changed file shows its new hash');
  assert.match(html, /해시 실패\(일반 파일 아님\)/, 'a folder listed as a take');
  await assert.rejects(hashFile(path.join(dir, 'missing.mp4')), { code: 'ENOENT' });
});

test('a device is never read for a hash, and a take linked to one is refused before that', { skip: process.platform === 'win32' && 'symlinks need a privilege on Windows', timeout: 10_000 }, async () => {
  await assert.rejects(hashFile('/dev/zero'), /일반 파일 아님/);
  const dir = project();
  fs.symlinkSync('/dev/zero', path.join(dir, 'clips/zero.mp4'));
  const input = readInput(dir);
  input.scenes[1].takes.push({ file: 'clips/zero.mp4', take: 2 });
  const html = await renderPage(input, readDecisions(dir), { dir });
  assert.match(html, /링크가 프로젝트 폴더 밖을 가리켜/);
  assert.doesNotMatch(html, /src="\/clips\/zero\.mp4"/);
});

test('a listed file that is not an image or a video, or that links out of the project, is neither shown nor served', async (t) => {
  const dir = project();
  fs.writeFileSync(path.join(dir, '.env.3d-intro.local'), 'AZURE_API_KEY=secret');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'curate-out-'));
  made.push(outside);
  fs.writeFileSync(path.join(outside, 'leak.png'), 'from outside');
  const links = process.platform !== 'win32';
  if (links) {
    fs.symlinkSync(path.join(outside, 'leak.png'), path.join(dir, 'stills', 'link.png'));
    fs.symlinkSync(path.join(dir, '.env.3d-intro.local'), path.join(dir, 'stills', 'inner.png'));
  }
  const input = JSON.parse(fs.readFileSync(path.join(dir, 'curate-input.json'), 'utf8'));
  input.scenes[0].takes.push({ file: '.env.3d-intro.local', take: 3 },
    ...(links ? [{ file: 'stills/link.png', take: 4 }, { file: 'stills/inner.png', take: 5 }] : []));
  fs.writeFileSync(path.join(dir, 'curate-input.json'), JSON.stringify(input));
  const s = await startCurate(dir, {});
  t.after(() => s.close());
  const get = (p) => fetch(`http://127.0.0.1:${s.port}${p}`);
  const html = await (await get('/')).text();
  assert.equal((await get('/.env.3d-intro.local')).status, 404);
  assert.match(html, /이미지나 영상 파일이 아니라/);
  assert.ok(!html.includes(crypto.createHash('sha256').update('AZURE_API_KEY=secret').digest('hex')), 'the key file is not hashed');
  if (links) {
    assert.equal((await get('/stills/link.png')).status, 404);
    assert.equal((await get('/stills/inner.png')).status, 404, 'a .png name linked to the key file inside');
    assert.match(html, /링크가 프로젝트 폴더 밖을 가리켜/);
    assert.match(html, /링크가 이미지나 영상이 아닌 파일을 가리켜/);
    assert.ok(!html.includes(crypto.createHash('sha256').update('from outside').digest('hex')));
  }
  assert.equal((await get('/stills/s1-t1.png')).status, 200, 'a listed image inside is still served');
});

test('an error page says what failed without the absolute path of the folder', async (t) => {
  const dir = project();
  fs.rmSync(path.join(dir, 'curate-input.json'));
  const s = await startCurate(dir, {});
  t.after(() => s.close());
  const r = await fetch(`http://127.0.0.1:${s.port}/`);
  const body = await r.text();
  assert.equal(r.status, 500);
  assert.match(body, /curate-input\.json 을 읽지 못했습니다\(ENOENT\)/);
  assert.ok(!body.includes(dir), body);
});

test('a request body with control characters reaches the server log escaped', async (t) => {
  const dir = project();
  const s = await startCurate(dir, {});
  t.after(() => s.close());
  const logged = [];
  const real = console.error;
  console.error = (...args) => logged.push(args.join(' '));
  t.after(() => { console.error = real; });
  const r = await fetch(`http://127.0.0.1:${s.port}/decide`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"x":\u001b[2J \u007f\u009b2J\u0085\u202e}' });
  console.error = real;
  assert.equal(r.status, 400);
  assert.ok(logged.length > 0 && logged.every((l) => !/[\u001b\u007f\u009b\u0085\u202e]/.test(l)), JSON.stringify(logged));
});

test('archiving moves no file that a folder link leads out of the project', { skip: process.platform === 'win32' && 'symlinks need a privilege on Windows' }, () => {
  const dir = project();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'curate-out-'));
  made.push(outside);
  fs.writeFileSync(path.join(outside, 'shared.png'), 'png shared');
  fs.symlinkSync(outside, path.join(dir, 'linked'), 'dir');
  const input = JSON.parse(fs.readFileSync(path.join(dir, 'curate-input.json'), 'utf8'));
  input.scenes[0].takes.push({ file: 'linked/shared.png', take: 3 });
  fs.writeFileSync(path.join(dir, 'curate-input.json'), JSON.stringify(input));
  recordDecision(dir, { scene: '1', verdict: 'reject', take: '3' }, NOW);
  assert.deepEqual(archiveRejected(dir, { now: NOW }).map((m) => m.file), []);
  assert.equal(fs.readFileSync(path.join(outside, 'shared.png'), 'utf8'), 'png shared', 'the shared original stays');
});

test('a verdict that cannot be saved says so without the absolute path of the folder', { skip: (process.platform === 'win32' || process.getuid?.() === 0) && 'file modes do not stop this user' }, async (t) => {
  const dir = project();
  const s = await startCurate(dir, {});
  t.after(() => s.close());
  fs.chmodSync(dir, 0o555);
  let r;
  try {
    r = await post(s.port, { scenes: [{ id: 's1', chosen: 'stills/s1-t1.png' }] });
  } finally {
    fs.chmodSync(dir, 0o755);
  }
  const body = await r.text();
  assert.equal(r.status, 400);
  assert.match(body, /판정을 저장하지 못했습니다\(EACCES\)/);
  assert.ok(!body.includes(dir), body);
});

// Replaces fs.promises.open (which hashFile calls) for one test: `wrap` gets each FileHandle opened
// under `dir`, so work an earlier test left running (a review server's warm-up hashing) is untouched.
function wrapOpen(t, dir, wrap) {
  const real = fs.promises.open;
  fs.promises.open = async (...args) => {
    const fh = await real(...args);
    return String(args[0]).startsWith(dir + path.sep) ? wrap(fh) : fh;
  };
  t.after(() => { fs.promises.open = real; });
  return real;
}

test('a take that grows while it is hashed is read only up to the size it had', async (t) => {
  const dir = project();
  const clip = path.join(dir, 'clips/flight-2.mp4');
  fs.writeFileSync(clip, Buffer.alloc(200 * 1024, 1));
  const before = sha(dir, 'clips/flight-2.mp4');
  wrapOpen(t, dir, (fh) => {
    const stat = fh.stat.bind(fh);
    fh.stat = async (...a) => {
      const st = await stat(...a);
      fs.appendFileSync(clip, Buffer.alloc(100 * 1024, 2));
      return st;
    };
    return fh;
  });
  assert.equal(await hashFile(clip), before);
});

test('a read that fails partway is not kept: the next view reads the take again', async (t) => {
  const dir = project();
  const clip = path.join(dir, 'clips/flight-2.mp4');
  fs.writeFileSync(clip, crypto.randomBytes(300 * 1024));
  let fail = true;
  const real = wrapOpen(t, dir, (fh) => {
    const stream = fh.createReadStream.bind(fh);
    fh.createReadStream = (opts) => {
      const s = stream(opts);
      if (fail) {
        fail = false;
        process.nextTick(() => s.destroy(Object.assign(new Error('read failed'), { code: 'EIO' })));
      }
      return s;
    };
    return fh;
  });
  await assert.rejects(hashFile(clip), { code: 'EIO' });
  fs.promises.open = real;
  assert.equal(await hashFile(clip), sha(dir, 'clips/flight-2.mp4'));
});

test('a view that waits for another view\'s hash of the same take holds no file while it waits', async (t) => {
  const dir = project();
  const clip = path.join(dir, 'clips/flight-2.mp4');
  fs.writeFileSync(clip, crypto.randomBytes(64 * 1024));
  const n = { opened: 0, closed: 0, reading: false };
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  wrapOpen(t, dir, (fh) => {
    const first = ++n.opened === 1;
    const close = fh.close.bind(fh);
    fh.close = async () => { n.closed++; return close(); };
    const stream = fh.createReadStream.bind(fh);
    fh.createReadStream = (opts) => {
      const s = stream(opts);
      if (first) { s.pause(); n.reading = true; gate.then(() => s.resume()); }
      return s;
    };
    return fh;
  });
  const until = async (cond) => { for (let i = 0; i < 300 && !cond(); i++) await new Promise((r) => setTimeout(r, 10)); };
  const views = [hashFile(clip)];
  await until(() => n.reading);
  for (let k = 0; k < 5; k++) views.push(hashFile(clip));
  await until(() => n.opened === 6 && n.closed === 5);
  assert.equal(n.opened - n.closed, 1, 'only the view that reads holds its file');
  release();
  assert.ok((await Promise.all(views)).every((h) => h === sha(dir, 'clips/flight-2.mp4')));
});

test('a take is read only up to the size it had when its hash began, so an endless file still ends', { skip: !fs.existsSync('/proc/self/pagemap') && 'needs /proc/self/pagemap', timeout: 10_000 }, async () => {
  const dir = project();
  fs.symlinkSync('/proc/self/pagemap', path.join(dir, 'clips/endless.mp4'));
  assert.equal(await hashFile(path.join(dir, 'clips/endless.mp4')), crypto.createHash('sha256').digest('hex'), 'size 0 when it began');
});

test('a take that could not be read shows the failure and is read again on the next view', { skip: (process.platform === 'win32' || process.getuid?.() === 0) && 'file modes do not stop this user' }, async () => {
  const dir = project();
  const still = path.join(dir, 'stills/s1-t1.png');
  fs.chmodSync(still, 0o000);
  try {
    assert.match(await renderPage(readInput(dir), readDecisions(dir), { dir }), /해시 실패\(EACCES\)/);
  } finally {
    fs.chmodSync(still, 0o644);
  }
  assert.ok((await renderPage(readInput(dir), readDecisions(dir), { dir })).includes(sha(dir, 'stills/s1-t1.png')));
});

test('takes are hashed a few at a time, so a long list does not run out of file handles', async (t) => {
  const dir = project();
  const input = readInput(dir);
  for (let k = 0; k < 40; k++) {
    fs.writeFileSync(path.join(dir, `stills/x${k}.png`), `png ${k}`);
    input.scenes[0].takes.push({ file: `stills/x${k}.png`, take: k + 3 });
  }
  let open = 0;
  let peak = 0;
  wrapOpen(t, dir, (fh) => {
    peak = Math.max(peak, ++open);
    const close = fh.close.bind(fh);
    fh.close = async () => { open--; return close(); };
    return fh;
  });
  const html = await renderPage(input, readDecisions(dir), { dir });
  assert.ok(html.includes(sha(dir, 'stills/x39.png')));
  assert.ok(peak >= 1 && peak <= 4, `at most 4 files open at once, saw ${peak}`);
});

test('a clip plays as a muted loop, and a flight shows its first and last frames', async () => {
  const dir = project();
  const html = await renderPage(readInput(dir), readDecisions(dir), { dir });
  assert.match(html, /<video [^>]*src="\/clips\/flight-2\.mp4"[^>]*muted[^>]*loop/);
  assert.match(html, /첫 프레임[\s\S]*stills\/s2\.png[\s\S]*끝 프레임[\s\S]*stills\/s3\.png/);
  assert.match(html, /5초/);
});

test('the top line gives the stage, approved scenes of all, and spend against the budget', async () => {
  const dir = project({ spentUsd: 3.5 });
  recordDecision(dir, { scene: '1', verdict: 'approve', take: '2' }, NOW);
  const html = await renderPage(readInput(dir), readDecisions(dir), { dir });
  assert.match(html, /스틸 검토/);
  assert.match(html, /승인 1 \/ 2/);
  assert.match(html, /누적 비용 \$3\.5 \/ 승인 예산 \$12/);
  const summed = project();
  assert.match(await renderPage(readInput(summed), readDecisions(summed), { dir: summed }), /누적 비용 \$0\.58/, 'without spentUsd the takes are summed');
});

test('a motion-graphics stage labels the prompt as the composition instructions', async () => {
  const dir = project({ stage: 'snapshots' });
  const html = await renderPage(readInput(dir), readDecisions(dir), { dir });
  assert.match(html, /스냅숏 검토/);
  assert.match(html, /구성 지시문/);
});

test('the old curate input with variants is read as takes', () => {
  const dir = project();
  fs.writeFileSync(path.join(dir, 'curate-input.json'), JSON.stringify({ scenes: [{ id: 'a', variants: [{ file: 'stills/s2.png' }] }] }));
  const input = readInput(dir);
  assert.equal(input.stage, 'stills');
  assert.deepEqual(input.scenes[0].takes.map((t) => [t.file, t.take]), [['stills/s2.png', 1]]);
});

test('a take outside the project folder is shown as refused and never served', async () => {
  const dir = project();
  fs.writeFileSync(path.join(dir, 'curate-input.json'), JSON.stringify({ scenes: [{ id: 'a', takes: [{ file: '../../etc/passwd' }] }] }));
  const html = await renderPage(readInput(dir), readDecisions(dir), { dir });
  assert.match(html, /프로젝트 폴더 밖/);
  assert.doesNotMatch(html, /src="\/\.\.\//);
});

test('verdicts from the page are stored per stage with who gave them', async (t) => {
  const dir = project();
  const s = await startCurate(dir, {});
  t.after(() => s.close());
  const scenes = [
    { id: 's1', chosen: 'stills/s1-t2.png', note: '', rejected: ['stills/s1-t1.png'] },
    { id: 's2', chosen: 'clips/flight-2.mp4', note: '벽 쪽으로 더 낮게' },
  ];
  const r = await post(s.port, { scenes });
  assert.equal(r.status, 200);
  const d = readDecisions(dir).stills.scenes;
  assert.deepEqual(d.map((x) => [x.id, x.verdict, x.chosen, x.by]), [
    ['s1', 'approve', 'stills/s1-t2.png', 'page'], ['s2', 'regenerate', 'clips/flight-2.mp4', 'page']]);
  assert.deepEqual(d[0].rejected, ['stills/s1-t1.png']);
  assert.equal(d[1].note, '벽 쪽으로 더 낮게');
  const basedOn = readDecisions(dir).stills.updatedAt;
  const bad = await post(s.port, { basedOn, scenes: [{ id: 's1', chosen: '../x.png' }] });
  assert.equal(bad.status, 400, 'a chosen file must be one of the takes');
});

test('a verdict given in chat is recorded by scene and take number', () => {
  const dir = project();
  recordDecision(dir, { scene: '2', verdict: 'approve', take: '1' }, NOW);
  recordDecision(dir, { scene: 's1', verdict: 'regenerate', note: '글자가 깨짐' }, NOW);
  let d = readDecisions(dir).stills.scenes;
  assert.deepEqual(d.map((x) => [x.id, x.verdict, x.chosen ?? null, x.by]), [
    ['s2', 'approve', 'clips/flight-2.mp4', 'chat'], ['s1', 'regenerate', null, 'chat']]);
  recordDecision(dir, { scene: '2', verdict: 'reject', take: '1' }, NOW);
  d = readDecisions(dir).stills.scenes;
  assert.deepEqual([d[0].verdict, d[0].chosen ?? null, d[0].rejected], ['pending', null, ['clips/flight-2.mp4']]);
  assert.throws(() => recordDecision(dir, { scene: '9', verdict: 'approve', take: '1' }, NOW), /장면/);
  assert.throws(() => recordDecision(dir, { scene: '1', verdict: 'approve', take: '7' }, NOW), /테이크/);
  assert.throws(() => recordDecision(dir, { scene: '1', verdict: 'maybe' }, NOW), /판정/);
});

test('rejected takes move to a dated folder and leave the review', () => {
  const dir = project();
  recordDecision(dir, { scene: '1', verdict: 'reject', take: '1' }, NOW);
  recordDecision(dir, { scene: '1', verdict: 'approve', take: '2' }, NOW);
  const moves = archiveRejected(dir, { now: NOW });
  const folder = `rejected-${NOW.getFullYear()}${String(NOW.getMonth() + 1).padStart(2, '0')}${String(NOW.getDate()).padStart(2, '0')}`;
  assert.deepEqual(moves, [{ file: 'stills/s1-t1.png', to: `${folder}/stills/s1-t1.png` }]);
  assert.ok(fs.existsSync(path.join(dir, folder, 'stills', 's1-t1.png')));
  assert.ok(!fs.existsSync(path.join(dir, 'stills', 's1-t1.png')));
  assert.deepEqual(readInput(dir).scenes[0].takes.map((x) => x.file), ['stills/s1-t2.png']);
  const s1 = readDecisions(dir).stills.scenes.find((x) => x.id === 's1');
  assert.deepEqual([s1.rejected, s1.archived], [[], moves]);
  assert.deepEqual(archiveRejected(dir, { now: NOW }), [], 'a second run moves nothing');
});

test('the review server hashes the listed takes as it starts', async (t) => {
  const dir = project();
  const s = await startCurate(dir, {});
  t.after(() => s.close());
  const warmed = await s.warmed;
  assert.equal(warmed.get('stills/s1-t1.png'), sha(dir, 'stills/s1-t1.png'));
  assert.equal(warmed.get('clips/flight-2.mp4'), sha(dir, 'clips/flight-2.mp4'));
});

test('the page server records its PID beside the review files', async (t) => {
  const dir = project();
  const s = await startCurate(dir, {});
  t.after(() => s.close());
  assert.equal(s.stateFile, path.join(dir, 'curate.server.json'));
  const page = await (await fetch(`http://127.0.0.1:${s.port}/`)).text();
  assert.match(page, /테이크 1/);
  const img = await fetch(`http://127.0.0.1:${s.port}/stills/s2.png`);
  assert.equal(await img.text(), 'png stills/s2.png');
});

// Runs curate.mjs to its exit: { code, out } with stdout and stderr together.
const runCurate = (args) => new Promise((resolve) => {
  const c = spawn(process.execPath, [path.join(HERE, 'curate.mjs'), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  c.stdout.on('data', (d) => { out += d; });
  c.stderr.on('data', (d) => { out += d; });
  c.on('exit', (code) => resolve({ code, out }));
});

test('a second review server start reports the running one, and another port is refused', async (t) => {
  const dir = project();
  const busy = net.createServer().listen(0, '127.0.0.1');
  await new Promise((resolve) => busy.once('listening', resolve));
  t.after(() => busy.close());
  const asked = busy.address().port;
  const child = spawn(process.execPath, [path.join(HERE, 'curate.mjs'), dir, '--port', String(asked)], { stdio: 'ignore' });
  t.after(() => { try { process.kill(child.pid); } catch { /* gone */ } });
  const stateFile = path.join(dir, 'curate.server.json');
  for (let i = 0; i < 100 && !fs.existsSync(stateFile); i++) await new Promise((r) => setTimeout(r, 50));
  const first = readState(stateFile);
  assert.deepEqual([first.requestedPort === asked, first.port !== asked], [true, true], 'busy, so the system gave another');
  for (const args of [[dir], [dir, '--port', String(asked)], [dir, '--port', String(first.port)]]) {
    const r = await runCurate(args);
    assert.deepEqual([r.code, /already running/.test(r.out)], [0, true], args.join(' '));
  }
  const other = [1, 2, 3].map((k) => first.port + k).find((p) => p !== asked);
  const refused = await runCurate([dir, '--port', String(other)]);
  assert.equal(refused.code, 1);
  assert.match(refused.out, new RegExp(`different settings[\\s\\S]*port: ${first.port}[\\s\\S]*--stop`));
  const exited = new Promise((resolve) => child.on('exit', resolve));
  assert.equal((await stopServer(stateFile, { timeoutMs: 5000 })).reason, 'stopped');
  await exited;
});

test('only the takes and frames the input lists are served, never the keys beside them', async (t) => {
  const dir = project();
  fs.writeFileSync(path.join(dir, '.env.3d-intro.local'), 'AZURE_API_KEY=secret');
  const s = await startCurate(dir, {});
  t.after(() => s.close());
  const get = (p) => fetch(`http://127.0.0.1:${s.port}${p}`).then((r) => r.status);
  for (const p of ['/.env.3d-intro.local', '/curate-input.json', '/decisions.json', '/curate.server.json']) assert.equal(await get(p), 404, p);
  assert.equal(await get('/stills/s1-t1.png'), 200);
  assert.equal(await get('/stills/s3.png'), 200, 'a flight frame the input lists');
  const rebound = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: s.port, path: '/', headers: { Host: 'evil.example' } }, (r) => { r.resume(); resolve(r.statusCode); }).on('error', reject);
  });
  assert.equal(rebound, 403, 'a rebound DNS name is refused');
});

test('a verdict must come as JSON from the page itself, and a stale page cannot overwrite a newer one', async (t) => {
  const dir = project();
  const s = await startCurate(dir, {});
  t.after(() => s.close());
  const scenes = [{ id: 's1', chosen: 'stills/s1-t1.png' }];
  assert.equal((await post(s.port, { scenes }, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post(s.port, { scenes }, { 'Content-Type': 'application/json', Origin: 'http://evil.example' })).status, 403);
  const page = await (await fetch(`http://127.0.0.1:${s.port}/`)).text();
  const basedOn = /data-based-on="([^"]*)"/.exec(page)[1];
  recordDecision(dir, { scene: '2', verdict: 'approve', take: '1' }, NOW);
  const stale = await post(s.port, { basedOn, scenes });
  assert.equal(stale.status, 409);
  assert.equal(readDecisions(dir).stills.scenes.find((x) => x.id === 's2').verdict, 'approve', 'the chat verdict survives');
  const fresh = await post(s.port, { basedOn: readDecisions(dir).stills.updatedAt, scenes, origin: 'x' },
    { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${s.port}` });
  assert.equal(fresh.status, 200);
});

test('a decisions file that does not parse stops the work instead of being replaced', () => {
  const dir = project();
  fs.writeFileSync(path.join(dir, 'decisions.json'), '{ broken');
  assert.throws(() => readDecisions(dir), /decisions\.json/);
  assert.throws(() => recordDecision(dir, { scene: '1', verdict: 'approve', take: '1' }, NOW), /decisions\.json/);
  assert.equal(fs.readFileSync(path.join(dir, 'decisions.json'), 'utf8'), '{ broken');
});

test('an archived take lands inside the dated folder whatever the spelling of its path', () => {
  const dir = project();
  const input = JSON.parse(fs.readFileSync(path.join(dir, 'curate-input.json'), 'utf8'));
  const odd = `../${path.basename(dir)}/stills/s1-t1.png`;
  input.scenes[0].takes[0].file = odd;
  fs.writeFileSync(path.join(dir, 'curate-input.json'), JSON.stringify(input));
  recordDecision(dir, { scene: '1', verdict: 'reject', take: '1' }, NOW);
  const [move] = archiveRejected(dir, { now: NOW });
  assert.match(move.to, /^rejected-\d{8}\/stills\/s1-t1\.png$/);
  assert.ok(fs.existsSync(path.join(dir, ...move.to.split('/'))));
});
