// Tests for the Codex progress script. Run from the repo root: node --test codex/skills/progress/scripts/progress.test.mjs
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { codexPlanKind, follower, lastPlan, pathsOf, readRecord, records, render, rolloutFor, tail } from './progress.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'progress.mjs');
const root = mkdtempSync(join(tmpdir(), 'progress-codex-'));
after(() => rmSync(root, { recursive: true, force: true }));
const ID = '01a17e65-99ef-7521-afab-678084f9edb2';

// A rollout as Codex 0.144.5 writes it.
const meta = (cwd) => ({ type: 'session_meta', payload: { id: ID, cwd } });
const said = (text) => ({ type: 'event_msg', payload: { type: 'user_message', message: text } });
const sh = (cmd, workdir) => ({ type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd, workdir }) } });
const patch = (path) => ({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', input: `*** Begin Patch\n*** Add File: ${path}\n+x\n*** End Patch` } });
const plan = (steps) => ({ type: 'response_item', payload: { type: 'function_call', name: 'update_plan', arguments: JSON.stringify({ plan: steps }) } });
const write = (name, recs) => {
  const f = join(root, name);
  writeFileSync(f, `${recs.map((r) => JSON.stringify(r)).join('\n')}\n`);
  return f;
};

test('plan folders: OMX plans count like OMC ones, review rounds are weak', () => {
  assert.equal(codexPlanKind('/w/.omx/plans/a.md'), 'plan');
  assert.equal(codexPlanKind('/w/.omx/plans/a-critic-r2.md'), 'weak');
  assert.equal(codexPlanKind('/w/.omx/state/x.md'), null);
  assert.equal(codexPlanKind('C:\\w\\.omx\\plans\\a.md'), 'plan');
});

test('the plan is the last one the session wrote or read, relative paths from the workdir', () => {
  const w = join(root, 'w1');
  mkdirSync(join(w, '.omx', 'plans'), { recursive: true });
  for (const f of ['a.md', 'b.md', 'b-critic-r1.md']) writeFileSync(join(w, '.omx', 'plans', f), '# T\n');
  const r = records([meta(w), sh('cat .omx/plans/a.md', w), patch(join(w, '.omx/plans/b.md')), sh('cat .omx/plans/b-critic-r1.md')].map((x) => JSON.stringify(x)));
  assert.equal(lastPlan(r.calls, r.cwd), join(w, '.omx', 'plans', 'b.md'));
  const weakOnly = records([meta(w), sh('cat .omx/plans/b-critic-r1.md'), sh('cat .omx/plans/gone.md')].map((x) => JSON.stringify(x)));
  assert.equal(lastPlan(weakOnly.calls, weakOnly.cwd), join(w, '.omx', 'plans', 'b-critic-r1.md'));
});

test('steps come from the last update_plan, and the step in progress shows the calls after it', () => {
  const w = join(root, 'w2');
  mkdirSync(join(w, '.omx', 'plans'), { recursive: true });
  writeFileSync(join(w, '.omx', 'plans', 'p.md'), '# 계획\n\n## 단계 1\n- [x] 하나\n- [ ] 둘\n\n## 단계 2\n- [ ] 셋\n');
  const f = write('r2.jsonl', [meta(w), said('계획대로 해 줘'), sh('cat .omx/plans/p.md', w), plan([{ step: '읽기', status: 'completed' }]),
    plan([{ step: '읽기', status: 'completed' }, { step: '고치기', status: 'in_progress' }, { step: '시험', status: 'pending' }]), sh('npm test', w)]);
  const text = render(f);
  assert.match(text, /계획: .*p\.md {2}0\/2\n {2}단계 1 \(1\/2\)\n {4}\[x\] 하나/);
  assert.match(text, /단계 1.*\(1\/2\)/);
  assert.match(text, /\[x\] 읽기\n {2}\[>\] 고치기\n {6}- exec_command: npm test\n {2}\[ \] 시험/);
  assert.doesNotMatch(text, /cat \.omx/, 'calls before the last update_plan are not under the step');
});

test('with no update_plan the requests are the steps, and no rollout found stops with 2', () => {
  const f = write('r3.jsonl', [meta('/nowhere'), said('첫 요청'), sh('ls'), said('둘째 요청'), sh('pwd')]);
  const text = render(f);
  assert.match(text, /계획 파일 없음/);
  assert.match(text, /\[x\] 첫 요청\n {2}\[>\] 둘째 요청\n {6}- exec_command: pwd$/);
  const home = join(root, 'codex');
  const day = join(home, 'sessions', '2026', '10', '28');
  mkdirSync(day, { recursive: true });
  writeFileSync(join(day, `rollout-2026-10-28T02-00-00-${ID}.jsonl`), '');
  assert.equal(rolloutFor(ID, { CODEX_HOME: home }), join(day, `rollout-2026-10-28T02-00-00-${ID}.jsonl`));
  assert.equal(rolloutFor('../x', { CODEX_HOME: home }), null);
  const env = { ...process.env, CODEX_HOME: home };
  delete env.CODEX_THREAD_ID;
  assert.equal(spawnSync(process.execPath, [SCRIPT], { env, encoding: 'utf8' }).status, 2);
});

test('a Windows path written in JS source (backslashes doubled) is found as the plan', () => {
  const r = records([meta('C:\\w'), JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec',
    input: "text(await tools.exec_command({cmd:'Get-Content C:\\\\w\\\\.omx\\\\plans\\\\a.md'}))" } })].map((x) => (typeof x === 'string' ? x : JSON.stringify(x))));
  assert.ok(pathsOf(r.calls[0], r.cwd).some((x) => x.replaceAll('\\', '/').endsWith('w/.omx/plans/a.md')), 'one backslash between the parts');
  assert.equal(codexPlanKind(pathsOf(r.calls[0], r.cwd).find((x) => x.endsWith('a.md'))), 'plan');
});

test('Codex 0.160: requests from completed UserMessage items, and a shell call made from code shows its command', () => {
  const user = (text) => ({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text }] } } });
  const code = (src) => ({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input: src } });
  const w = join(root, 'w4');
  mkdirSync(join(w, '.omx', 'plans'), { recursive: true });
  writeFileSync(join(w, '.omx', 'plans', 'q.md'), '# Q\n\n- [x] 하나\n');
  const f = write('r4.jsonl', [meta(w), user('계획 읽어'), said('계획 읽어'), code(`text(await tools.exec_command({cmd:'cat ${join(w, '.omx', 'plans', 'q.md').replaceAll('\\', '\\\\')}'}))`)]);
  const text = render(f);
  assert.match(text, /계획: .*q\.md/);
  assert.match(text, /\[>\] 계획 읽어\n {6}- exec_command: cat /);
  assert.equal(text.match(/계획 읽어/g).length, 1, 'the same request written in both forms shows once');
});

test('run through a linked folder, the script still prints (the main check compares real paths)', (t) => {
  const link = join(root, 'linked-scripts');
  try {
    symlinkSync(dirname(SCRIPT), link, 'dir');
  } catch {
    return t.skip('no folder links');
  }
  const f = write('r5.jsonl', [meta('/nowhere'), said('링크로 실행')]);
  const r = spawnSync(process.execPath, [join(link, 'progress.mjs'), '--rollout', f], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /\[>\] 링크로 실행/);
});

test('a rollout whose requests cannot be read says so instead of an empty view', () => {
  const f = write('r6.jsonl', [{ type: 'session_meta', payload: { id: ID, cwd: '/w', cli_version: '9.9.9' } }, { type: 'event_msg', payload: { type: 'user_said_v2', text: 'x' } }]);
  assert.match(render(f), /경고: 이 Codex 9\.9\.9 기록에서 사용자 요청을 하나도 읽지 못함/);
  assert.doesNotMatch(render(write('r7.jsonl', [meta('/w'), said('요청')])), /경고/);
});

test('a record read only from its end says the early part was not read, instead of the shape warning', () => {
  const pad = { type: 'event_msg', payload: { type: 'token_count', pad: 'x'.repeat(1000) } };
  const f = write('r8.jsonl', [{ type: 'session_meta', payload: { id: ID, cwd: '/w', cli_version: '0.144.5' } }, said('맨 앞 요청'), ...Array(50).fill(pad)]);
  const lines = tail(f, 10000);
  assert.equal(lines.cut, true);
  assert.equal(records(lines).prompts.length, 0);
  const text = render(f, 2, 10000);
  assert.match(text, /참고: 기록이 32 MB 를 넘어/);
  assert.doesNotMatch(text, /경고:/);
});

test('--follow redraws at the next tick when only the plan file changed, without reading the record again', () => {
  const w = join(root, 'wf');
  mkdirSync(join(w, '.omx', 'plans'), { recursive: true });
  const planFile = join(w, '.omx', 'plans', 'p.md');
  writeFileSync(planFile, '# P\n\n- [ ] one\n- [ ] two\n');
  const f = write(`rollout-2026-10-29T00-00-00-${ID}.jsonl`, [meta(w), said('go'), sh(`cat ${planFile}`, w)]);
  let reads = 0;
  const shown = [];
  const draw = follower(f, 2, { read: (file) => { reads++; return readRecord(file); }, write: (t) => shown.push(t), columns: () => 100 });
  assert.equal(draw(), true);
  assert.equal(draw(), false, 'nothing changed: no redraw');
  assert.equal(reads, 1);
  writeFileSync(planFile, '# P\n\n- [x] one\n- [ ] two\n');
  const later = Date.now() / 1000 + 5;
  utimesSync(planFile, later, later);
  assert.equal(draw(), true, 'the plan file alone changed: redrawn at the next tick');
  assert.equal(reads, 1, 'the record was not read again');
  assert.match(shown.at(-1), /1\/2/);
  writeFileSync(f, `${JSON.stringify(meta(w))}\n${JSON.stringify(said('go'))}\n${JSON.stringify(said('more'))}\n${JSON.stringify(sh(`cat ${planFile}`, w))}\n`);
  assert.equal(draw(), true);
  assert.equal(reads, 2, 'a grown record is read again');
  assert.match(shown.at(-1), /more/);
});
