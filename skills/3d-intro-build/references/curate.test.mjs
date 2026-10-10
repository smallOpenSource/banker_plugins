// Tests for curate.mjs, the review page of the 3d-intro-build and motion-graphic-make skills.
// Run from the repo root: node --test skills/3d-intro-build/references/curate.test.mjs
import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  archiveRejected, readDecisions, readInput, recordDecision, renderPage, startCurate,
} from './curate.mjs';

const NOW = new Date('2026-10-10T03:00:00Z');

// A project folder with two scenes: scene 1 has two still takes, scene 2 one clip take (a flight).
function project(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curate-'));
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

const sha = (dir, f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex');

test('every take shows its prompt, exclusions, model, size, time, cost, path and sha256', () => {
  const dir = project();
  const html = renderPage(readInput(dir), readDecisions(dir), { dir });
  for (const text of ['A &lt;b&gt;bold&lt;/b&gt; city', 'text, logos', 'gpt-image-2', '1280x720', '2026-10-10T01:00:00Z',
    '$0.04', 'stills/s1-t1.png', sha(dir, 'stills/s1-t1.png'), '테이크 2']) {
    assert.ok(html.includes(text), `missing ${text}`);
  }
  assert.doesNotMatch(html, /<b>bold<\/b>/, 'a prompt is text, never markup');
});

test('a clip plays as a muted loop, and a flight shows its first and last frames', () => {
  const dir = project();
  const html = renderPage(readInput(dir), readDecisions(dir), { dir });
  assert.match(html, /<video [^>]*src="\/clips\/flight-2\.mp4"[^>]*muted[^>]*loop/);
  assert.match(html, /첫 프레임[\s\S]*stills\/s2\.png[\s\S]*끝 프레임[\s\S]*stills\/s3\.png/);
  assert.match(html, /5초/);
});

test('the top line gives the stage, approved scenes of all, and spend against the budget', () => {
  const dir = project({ spentUsd: 3.5 });
  recordDecision(dir, { scene: '1', verdict: 'approve', take: '2' }, NOW);
  const html = renderPage(readInput(dir), readDecisions(dir), { dir });
  assert.match(html, /스틸 검토/);
  assert.match(html, /승인 1 \/ 2/);
  assert.match(html, /누적 비용 \$3\.5 \/ 승인 예산 \$12/);
  const summed = project();
  assert.match(renderPage(readInput(summed), readDecisions(summed), { dir: summed }), /누적 비용 \$0\.58/, 'without spentUsd the takes are summed');
});

test('a motion-graphics stage labels the prompt as the composition instructions', () => {
  const dir = project({ stage: 'snapshots' });
  const html = renderPage(readInput(dir), readDecisions(dir), { dir });
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

test('a take outside the project folder is shown as refused and never served', () => {
  const dir = project();
  fs.writeFileSync(path.join(dir, 'curate-input.json'), JSON.stringify({ scenes: [{ id: 'a', takes: [{ file: '../../etc/passwd' }] }] }));
  const html = renderPage(readInput(dir), readDecisions(dir), { dir });
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
  const r = await fetch(`http://127.0.0.1:${s.port}/decide`, { method: 'POST', body: JSON.stringify({ scenes }) });
  assert.equal(r.status, 200);
  const d = readDecisions(dir).stills.scenes;
  assert.deepEqual(d.map((x) => [x.id, x.verdict, x.chosen, x.by]), [
    ['s1', 'approve', 'stills/s1-t2.png', 'page'], ['s2', 'regenerate', 'clips/flight-2.mp4', 'page']]);
  assert.deepEqual(d[0].rejected, ['stills/s1-t1.png']);
  assert.equal(d[1].note, '벽 쪽으로 더 낮게');
  const bad = await fetch(`http://127.0.0.1:${s.port}/decide`, { method: 'POST', body: JSON.stringify({ scenes: [{ id: 's1', chosen: '../x.png' }] }) });
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
