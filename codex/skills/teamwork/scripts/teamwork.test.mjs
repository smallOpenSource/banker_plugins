// teamwork.mjs 단위 시험. 임시 CODEX_HOME 과 가짜 codex(판 출력, queue 인자 기록)로 돌린다. 실제 Codex 는 tmux e2e 에서만.
// 실행: node --test codex/skills/teamwork/scripts/teamwork.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'teamwork.mjs');
// 가짜 codex: --version 에 판을 내고, queue 인자는 파일에 적는다
const FAKE = fs.mkdtempSync(path.join(os.tmpdir(), 'teamwork-fake-'));
fs.writeFileSync(path.join(FAKE, 'codex'), '#!/bin/sh\nif [ "$1" = --version ]; then echo "codex-cli 0.165.0"; exit 0; fi\nprintf "%s\\n" "$*" >> "$(dirname "$0")/queue.log"\n', { mode: 0o755 });
const PATH_WITH_FAKE = `${FAKE}${path.delimiter}${process.env.PATH}`;
const A = '01a18000-0000-7000-8000-000000aaaaaa';
const B = '01a18000-0000-7000-8000-000000bbbbbb';

function home() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamwork-test-'));
  // 다른 도구가 이미 쓰는 훅이 있는 상태를 재현
  fs.writeFileSync(path.join(dir, 'hooks.json'), JSON.stringify({
    hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: '/usr/bin/true other-tool' }] }] },
  }));
  return dir;
}

function run(codexHome, args, { input, threadId, cwd } = {}) {
  const env = { ...process.env, CODEX_HOME: codexHome, PATH: PATH_WITH_FAKE };
  delete env.CODEX_THREAD_ID;
  if (threadId) env.CODEX_THREAD_ID = threadId;
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { env, cwd, input: input ?? '', encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function hook(codexHome, kind, sessionId, extra = {}) {
  const r = run(codexHome, ['hook', kind], { input: JSON.stringify({ session_id: sessionId, cwd: '/work', ...extra }) });
  assert.equal(r.code, 0, r.err);
  const j = JSON.parse(r.out);
  return j.hookSpecificOutput?.additionalContext ?? null;
}

test('on 은 훅을 기존 훅과 합쳐 설치하고 승인 규칙을 쓴다', () => {
  const h = home();
  const r = run(h, ['on'], { threadId: A });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /처음 설치했습니다/);
  const hooks = JSON.parse(fs.readFileSync(path.join(h, 'hooks.json'), 'utf8')).hooks;
  assert.equal(hooks.SessionStart.length, 1);
  assert.equal(hooks.SessionStart[0].matcher, 'startup|resume|clear');
  const cmds = hooks.UserPromptSubmit.flatMap((g) => g.hooks.map((x) => x.command));
  assert.ok(cmds.includes('/usr/bin/true other-tool'), '기존 훅 유지');
  assert.equal(cmds.filter((c) => c.includes('teamwork/bin/teamwork')).length, 1);
  const rules = fs.readFileSync(path.join(h, 'rules', 'teamwork.rules'), 'utf8');
  assert.match(rules, /prefix_rule\(pattern=\[".*teamwork\/bin\/teamwork"\], decision="allow"\)/);
  assert.ok(fs.statSync(path.join(h, 'teamwork', 'bin', 'teamwork')).mode & 0o111, '실행 권한');
});

test('on 을 다시 해도 훅이 늘지 않는다', () => {
  const h = home();
  run(h, ['on']); run(h, ['off']); run(h, ['on']);
  const hooks = JSON.parse(fs.readFileSync(path.join(h, 'hooks.json'), 'utf8')).hooks;
  for (const ev of ['SessionStart', 'UserPromptSubmit']) {
    const ours = hooks[ev].flatMap((g) => g.hooks).filter((x) => x.command.includes('teamwork/bin/teamwork'));
    assert.equal(ours.length, 1, ev);
  }
});

test('설치 뒤 래퍼로 실행된다', () => {
  const h = home();
  run(h, ['on']);
  const r = spawnSync(path.join(h, 'teamwork', 'bin', 'teamwork'), ['version'], { env: { ...process.env, CODEX_HOME: h }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^\d+\.\d+\.\d+/);
});

test('켜져 있으면 새 세션은 등록되고 규칙 전체를 받는다', () => {
  const h = home();
  run(h, ['on'], { threadId: A });
  const ctx = hook(h, 'session-start', B);
  assert.match(ctx, /\[teamwork 켜짐\]/);
  assert.match(ctx, /bbbbbb/);
  assert.match(ctx, /aaaaaa/);
  const st = run(h, ['status']);
  assert.match(st.out, /켜짐/);
});

test('UserPromptSubmit 은 처음에 규칙, 이후에는 목록이 바뀔 때만 넣는다', () => {
  const h = home();
  run(h, ['on']);
  assert.match(hook(h, 'prompt', A), /\[teamwork 켜짐\]/);
  assert.equal(hook(h, 'prompt', A), null, '변화 없으면 주입 안 함');
  hook(h, 'session-start', B);
  assert.match(hook(h, 'prompt', A), /피어 목록이 바뀌었다/);
  assert.equal(hook(h, 'prompt', A), null);
});

test('off 뒤에는 각 세션이 한 번만 꺼짐 안내를 받는다', () => {
  const h = home();
  run(h, ['on']);
  hook(h, 'prompt', A);
  run(h, ['off']);
  assert.match(hook(h, 'prompt', A), /\[teamwork 꺼짐\]/);
  assert.equal(hook(h, 'prompt', A), null);
  assert.equal(hook(h, 'session-start', B), null, '꺼진 뒤 새 세션은 등록 안 함');
  assert.doesNotMatch(run(h, ['status']).out, /bbbbbb/);
});

test('다시 켜면 꺼짐 안내를 받았던 세션도 규칙을 다시 받는다', () => {
  const h = home();
  run(h, ['on']); hook(h, 'prompt', A); run(h, ['off']); hook(h, 'prompt', A); run(h, ['on']);
  assert.match(hook(h, 'prompt', A), /\[teamwork 켜짐\]/);
});

test('role 은 이 세션의 역할을 기록하고 목록에 보인다', () => {
  const h = home();
  run(h, ['on']);
  hook(h, 'session-start', A);
  const r = run(h, ['role', '검토', '담당'], { threadId: A });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /역할: 검토-담당/);
  assert.match(run(h, ['peers']).out, /역할:검토-담당/);
});

test('꺼져 있으면 send 와 role 은 거절한다', () => {
  const h = home();
  run(h, ['on']); run(h, ['off']);
  assert.equal(run(h, ['send', 'all', 'x'], { threadId: A }).code, 3);
  assert.equal(run(h, ['role', 'x'], { threadId: A }).code, 3);
});

test('받을 세션이 없으면 4 로 끝난다', () => {
  const h = home();
  run(h, ['on'], { threadId: A });
  const r = run(h, ['send', '없는역할', '내용'], { threadId: A });
  assert.equal(r.code, 4);
  assert.match(r.err, /받을 세션이 없습니다/);
});

test('죽은 Codex 프로세스의 세션은 목록에서 빠진다', () => {
  const h = home();
  run(h, ['on']);
  hook(h, 'session-start', B);
  const f = path.join(h, 'teamwork', 'peers', `${B}.json`);
  const p = JSON.parse(fs.readFileSync(f, 'utf8'));
  const dead = spawnSync('sh', ['-c', 'echo $$']).stdout.toString().trim();
  fs.writeFileSync(f, JSON.stringify({ ...p, pid: Number(dead) }));
  assert.doesNotMatch(run(h, ['peers']).out, /bbbbbb/);
  assert.ok(!fs.existsSync(f));
});

test('uninstall 은 우리 훅만 지우고 다른 훅은 남긴다', () => {
  const h = home();
  run(h, ['on']);
  assert.equal(run(h, ['uninstall']).code, 0);
  const hooks = JSON.parse(fs.readFileSync(path.join(h, 'hooks.json'), 'utf8')).hooks;
  assert.equal(hooks.SessionStart, undefined);
  assert.deepEqual(hooks.UserPromptSubmit.flatMap((g) => g.hooks.map((x) => x.command)), ['/usr/bin/true other-tool']);
  assert.ok(!fs.existsSync(path.join(h, 'teamwork')));
  assert.ok(!fs.existsSync(path.join(h, 'rules', 'teamwork.rules')));
});

test('잘못된 인자는 2 로 끝난다', () => {
  assert.equal(run(home(), ['bogus']).code, 2);
});

// 앞선 주고받기 기록을 재현한다 (실제 전송은 e2e 에서 시험)
function seedLog(h, entries, extra = '') {
  fs.writeFileSync(path.join(h, 'teamwork', 'log.jsonl'), entries.map((e) => JSON.stringify(e)).join('\n') + '\n' + extra);
}

test('reply 는 이 세션이 받은 요청에만 보낼 수 있다', () => {
  const h = home();
  run(h, ['on']);
  hook(h, 'session-start', A);
  seedLog(h, [{ rid: 'bbbbbb-1', kind: 'request', from: B, to: A, ok: true, text: 'x' }]);
  const r = run(h, ['reply', 'bbbbbb-9', '결과'], { threadId: A });
  assert.equal(r.code, 4);
  assert.match(r.err, /받은 요청 bbbbbb-9 이 없습니다/);
  assert.equal(run(h, ['reply', 'bbbbbb-1', '결과'], { threadId: B }).code, 4, '나에게 온 요청이 아님');
});

test('결과 메시지에는 reply 할 수 없다', () => {
  const h = home();
  run(h, ['on']);
  seedLog(h, [
    { rid: 'aaaaaa-1', kind: 'request', from: A, to: B, ok: true, text: 'x' },
    { rid: 'bbbbbb-1', kind: 'result', re: 'aaaaaa-1', from: B, to: A, ok: true, text: 'y' },
  ]);
  const r = run(h, ['reply', 'bbbbbb-1', '확인했습니다'], { threadId: A });
  assert.equal(r.code, 4);
  assert.match(r.err, /결과 메시지에는 회신하지 않습니다/);
});

test('같은 요청에 결과를 두 번 보낼 수 없다', () => {
  const h = home();
  run(h, ['on']);
  seedLog(h, [
    { rid: 'aaaaaa-1', kind: 'request', from: A, to: B, ok: true, text: 'x' },
    { rid: 'bbbbbb-1', kind: 'result', re: 'aaaaaa-1', from: B, to: A, ok: true, text: 'y' },
  ]);
  const r = run(h, ['reply', 'aaaaaa-1', '다시'], { threadId: B });
  assert.equal(r.code, 4);
  assert.match(r.err, /이미 결과를 보냈습니다/);
});

test('요청한 세션이 닫혔으면 reply 는 4 로 끝난다', () => {
  const h = home();
  run(h, ['on']);
  seedLog(h, [{ rid: 'aaaaaa-1', kind: 'request', from: A, to: B, ok: true, text: 'x' }]);
  const r = run(h, ['reply', 'aaaaaa-1', '결과'], { threadId: B });
  assert.equal(r.code, 4);
  assert.match(r.err, /닫혔습니다/);
});

test('기록에 깨진 줄이 있어도 나머지 기록을 읽는다', () => {
  const h = home();
  run(h, ['on']);
  seedLog(h, [{ rid: 'aaaaaa-1', kind: 'request', from: A, to: B, ok: true, text: 'x' }], '{"rid":');
  fs.appendFileSync(path.join(h, 'teamwork', 'log.jsonl'), '\n');
  const r = run(h, ['reply', 'aaaaaa-1', '결과'], { threadId: B });
  assert.match(r.err, /닫혔습니다/, '요청을 찾은 뒤 다음 단계에서 멈춰야 함');
});

test('Codex 밖에서 온 요청에는 reply 하지 않는다', () => {
  const h = home();
  run(h, ['on']);
  seedLog(h, [{ rid: 'u0a1b2c-1', kind: 'request', from: null, to: B, ok: true, text: 'x' }]);
  const r = run(h, ['reply', 'u0a1b2c-1', '결과'], { threadId: B });
  assert.equal(r.code, 4);
  assert.match(r.err, /Codex 밖에서 왔습니다/);
});

test('다시 on 해도 훅 파일은 바뀌지 않는다 (재신뢰 방지)', () => {
  const h = home();
  run(h, ['on']);
  const f = path.join(h, 'hooks.json');
  const before = fs.readFileSync(f, 'utf8');
  run(h, ['off']);
  const r = run(h, ['on']);
  assert.equal(fs.readFileSync(f, 'utf8'), before);
  assert.doesNotMatch(r.out, /훅을 다시 넣었습니다|처음 설치했습니다/);
});

test('hooks.json 이 심볼릭 링크면 링크를 유지하고 대상 파일을 고친다', () => {
  const h = home();
  const real = path.join(h, 'dotfiles-hooks.json');
  fs.renameSync(path.join(h, 'hooks.json'), real);
  fs.chmodSync(real, 0o640);
  fs.symlinkSync(real, path.join(h, 'hooks.json'));
  run(h, ['on']);
  assert.ok(fs.lstatSync(path.join(h, 'hooks.json')).isSymbolicLink());
  assert.match(fs.readFileSync(real, 'utf8'), /teamwork\/bin\/teamwork/);
  assert.equal(fs.statSync(real).mode & 0o777, 0o640);
});

test('경로 조각만 같은 다른 도구의 훅은 지우지 않는다', () => {
  const h = home();
  const other = '/opt/x/teamwork/bin/teamwork-other notify';
  fs.writeFileSync(path.join(h, 'hooks.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: other }] }] } }));
  run(h, ['on']);
  run(h, ['uninstall']);
  const hooks = JSON.parse(fs.readFileSync(path.join(h, 'hooks.json'), 'utf8')).hooks;
  assert.deepEqual(hooks.SessionStart.flatMap((g) => g.hooks.map((x) => x.command)), [other]);
});

test('상태 폴더와 파일은 이 사용자만 읽는다', () => {
  const h = home();
  run(h, ['on'], { threadId: A });
  const tw = path.join(h, 'teamwork');
  assert.equal(fs.statSync(tw).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(tw, 'state.json')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(tw, 'peers', `${A}.json`)).mode & 0o777, 0o600);
});

test('훅은 내부 오류가 나도 빈 응답과 0 으로 끝난다', () => {
  const h = home();
  run(h, ['on']);
  fs.writeFileSync(path.join(h, 'teamwork', 'seen'), 'not a dir');
  const r = run(h, ['hook', 'prompt'], { input: JSON.stringify({ session_id: A, cwd: '/w' }) });
  assert.equal(r.code, 0);
  assert.equal(r.out.trim(), '{}');
  assert.match(r.err, /teamwork 훅 오류/);
});

test('엔진이 지워져도 래퍼의 훅 호출은 빈 응답으로 끝난다', () => {
  const h = home();
  run(h, ['on']);
  fs.unlinkSync(path.join(h, 'teamwork', 'bin', 'teamwork.mjs'));
  const r = spawnSync(path.join(h, 'teamwork', 'bin', 'teamwork'), ['hook', 'prompt'], { input: '{}', encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), '{}');
  const other = spawnSync(path.join(h, 'teamwork', 'bin', 'teamwork'), ['status'], { encoding: 'utf8' });
  assert.equal(other.status, 6);
});

test('하위 에이전트 세션은 피어로 등록하지 않는다', () => {
  const h = home();
  run(h, ['on']);
  const tp = path.join(h, 'rollout.jsonl');
  fs.writeFileSync(tp, JSON.stringify({ type: 'session_meta', payload: { source: { subagent: { thread_spawn: { parent_thread_id: A } } } } }) + '\n');
  assert.equal(hook(h, 'session-start', B, { transcript_path: tp }), null);
  assert.doesNotMatch(run(h, ['peers']).out, /bbbbbb/);
});

test('역할 이름의 특수 문자는 바꾼다', () => {
  const h = home();
  run(h, ['on']);
  hook(h, 'session-start', A);
  const r = run(h, ['role', "검토 [teamwork] 'x'"], { threadId: A });
  assert.match(r.out, /역할: 검토-teamwork-x/);
});

test('긴 본문은 거절하고 --file 은 파일을 읽는다', () => {
  const h = home();
  run(h, ['on'], { threadId: A });
  const long = run(h, ['send', 'all', 'x'.repeat(8001)], { threadId: A });
  assert.equal(long.code, 2);
  const f = path.join(h, 'msg.txt');
  fs.writeFileSync(f, "따옴표 ' 와 $HOME 과 `백틱`");
  const r = run(h, ['send', 'all', '--file', f], { threadId: A, cwd: h });
  assert.equal(r.code, 4, '피어가 없어 대상 없음까지 진행');
});

test('쓸 수 없는 상태 폴더면 짧은 안내와 6 으로 끝난다', { skip: process.getuid?.() === 0 }, () => {
  const h = home();
  run(h, ['on']);
  hook(h, 'session-start', A);
  const peers = path.join(h, 'teamwork', 'peers');
  fs.chmodSync(peers, 0o500);
  try {
    const r = run(h, ['role', '검토'], { threadId: A });
    assert.equal(r.code, 6);
    assert.match(r.err, /쓰기 실패 \(EACCES\)/);
    assert.doesNotMatch(r.err, /at .*teamwork\.mjs/);
  } finally { fs.chmodSync(peers, 0o700); }
});

test('피어 메시지로 시작한 턴에는 send 를 막고, 사용자 입력 턴에는 풀어 준다', () => {
  const h = home();
  run(h, ['on']);
  hook(h, 'prompt', A, { prompt: "[teamwork 요청 from:검토(bbbbbb) bbbbbb-1]\n본문" });
  const r = run(h, ['send', 'all', '질문'], { threadId: A });
  assert.equal(r.code, 4);
  assert.match(r.err, /처리하는 턴에는 send 할 수 없습니다/);
  hook(h, 'prompt', A, { prompt: '[teamwork 결과 from:x y 요청:z]' });
  assert.match(run(h, ['send', 'all', 'x'], { threadId: A }).err, /처리하는 턴에는/);
  hook(h, 'prompt', A, { prompt: '검토에게 다시 물어봐' });
  assert.match(run(h, ['send', 'all', 'x'], { threadId: A }).err, /받을 세션이 없습니다/, '사용자 턴에서는 대상 확인 단계까지 감');
});

test('--file 은 작업 폴더와 임시 폴더 밖의 파일을 거절한다', () => {
  const h = home();
  run(h, ['on'], { threadId: A });
  const r = run(h, ['send', 'all', '--file', '/etc/hostname'], { threadId: A, cwd: h });
  assert.equal(r.code, 2);
  assert.match(r.err, /안의 파일만 보낼 수 있습니다/);
});

test('승인 규칙 파일은 0600 이다', () => {
  const h = home();
  run(h, ['on']);
  assert.equal(fs.statSync(path.join(h, 'rules', 'teamwork.rules')).mode & 0o777, 0o600);
});

test('래퍼에 적힌 node 가 사라져도 PATH 의 node 로 실행된다', () => {
  const h = home();
  run(h, ['on']);
  const w = path.join(h, 'teamwork', 'bin', 'teamwork');
  fs.writeFileSync(w, fs.readFileSync(w, 'utf8').replace(/^NODE=.*$/m, "NODE='/nonexistent/node'"));
  const env = { ...process.env, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` };
  const r = spawnSync(w, ['version'], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const none = spawnSync(w, ['hook', 'prompt'], { env: { ...process.env, PATH: '/nonexistent' }, input: '{}', encoding: 'utf8' });
  assert.equal(none.status, 0);
  assert.equal(none.stdout.trim(), '{}');
});

test('대화 기록 첫 줄이 64KB 를 넘어도 하위 에이전트를 알아본다', () => {
  const h = home();
  run(h, ['on']);
  const tp = path.join(h, 'rollout.jsonl');
  const meta = { type: 'session_meta', payload: { base_instructions: 'x'.repeat(200000), source: { subagent: { thread_spawn: {} } } } };
  fs.writeFileSync(tp, JSON.stringify(meta) + '\n{"type":"next"}\n');
  assert.equal(hook(h, 'session-start', B, { transcript_path: tp }), null);
  assert.doesNotMatch(run(h, ['peers']).out, /bbbbbb/);
});
