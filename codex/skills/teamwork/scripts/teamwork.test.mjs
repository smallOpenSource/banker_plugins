// teamwork.mjs 단위 시험. 가짜 codex(판 출력, queue 인자 기록)로 돌린다. 실제 Codex 는 tmux e2e 에서만.
// 엔진은 임시 폴더 아래의 Codex 홈과 프로그램을 거부하므로, 설치 흐름의 고정물은 임시 폴더 밖에 둔다:
// 이 머신은 저장소의 git 무시 폴더 work/teamwork-fixture/, 박스는 시험 실행기가 주는 고정 폴더(TEAMWORK_FIXTURE_ROOT).
// 그 변수는 이 시험만 읽고 제품 코드는 읽지 않는다. 명령은 임시 폴더(세션 폴더 역할)에서 돈다.
// 실행: node --test codex/skills/teamwork/scripts/teamwork.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');
const SCRIPT = path.join(HERE, 'teamwork.mjs');
const OLD_ENGINE = path.join(REPO, 'scripts', 'test-fixtures', 'teamwork-0.2.1.mjs.txt');
const A = '01a18000-0000-7000-8000-000000aaaaaa';
const B = '01a18000-0000-7000-8000-000000bbbbbb';
const POSIX = process.platform !== 'win32';

// 모든 test() 를 등록하기 전에 불러 둔다 (중간의 top-level await 는 옛 Node 에서 after 를 먼저 돌림)
const engine = await import(pathToFileURL(SCRIPT).href);
const ch = await import(pathToFileURL(path.join(REPO, 'bin', 'lib', 'codex-hooks.mjs')).href);
// Windows 에서는 on 이 미지원(6)으로 끝나므로 설치 흐름 시험은 POSIX 에서만 돈다 (OS 고유 조건)
const ptest = (name, ...rest) => {
  const opts = rest.length > 1 ? rest[0] : {};
  return test(name, { ...opts, skip: (!POSIX && 'Windows 는 on 미지원') || opts.skip }, rest.at(-1));
};

const FIX_ROOT = process.env.TEAMWORK_FIXTURE_ROOT || path.join(REPO, 'work', 'teamwork-fixture');
fs.mkdirSync(FIX_ROOT, { recursive: true });
const RUN = fs.mkdtempSync(path.join(FIX_ROOT, `run-${process.pid}-`));
const CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'teamwork-cwd-'));
after(() => { fs.rmSync(RUN, { recursive: true, force: true }); fs.rmSync(CWD, { recursive: true, force: true }); });

// 가짜 codex: --version 에 판을 내고, queue 인자는 파일에 적는다
const FAKE = path.join(RUN, 'bin');
const QUEUE_LOG = path.join(FAKE, 'queue.log');
fs.mkdirSync(FAKE);
fs.writeFileSync(path.join(FAKE, 'codex'), '#!/bin/sh\nif [ "$1" = --version ]; then echo "codex-cli 0.165.0"; exit 0; fi\nprintf "%s\\n" "$*" >> "$(dirname "$0")/queue.log"\n', { mode: 0o755 });
const PATH_WITH_FAKE = `${FAKE}${path.delimiter}${process.env.PATH}`;

let n = 0;
function home(seed = true) {
  const dir = path.join(RUN, `h${++n}`);
  fs.mkdirSync(dir);
  // 다른 도구가 이미 쓰는 훅이 있는 상태를 재현
  if (seed) fs.writeFileSync(path.join(dir, 'hooks.json'), JSON.stringify({
    hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: '/usr/bin/true other-tool' }] }] },
  }));
  return dir;
}

function envFor(codexHome, { threadId, path: p } = {}) {
  const env = { ...process.env, CODEX_HOME: codexHome, PATH: p || PATH_WITH_FAKE };
  delete env.CODEX_THREAD_ID;
  if (threadId) env.CODEX_THREAD_ID = threadId;
  return env;
}

function run(codexHome, args, { input, threadId, cwd, script = SCRIPT, path: p } = {}) {
  const r = spawnSync(process.execPath, [script, ...args], { env: envFor(codexHome, { threadId, path: p }), cwd: cwd || CWD, input: input ?? '', encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function hook(codexHome, kind, sessionId, extra = {}) {
  const r = run(codexHome, ['hook', kind], { input: JSON.stringify({ session_id: sessionId, cwd: '/work', ...extra }) });
  assert.equal(r.code, 0, r.err);
  const j = JSON.parse(r.out);
  return j.hookSpecificOutput?.additionalContext ?? null;
}

ptest('on 은 훅을 기존 훅과 합쳐 설치하고 승인 규칙을 쓴다', () => {
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
  assert.match(rules, /prefix_rule\(pattern=\[".*teamwork\/bin\/teamwork", \["peers","role","send","reply","status","version"\]\], decision="allow"\)/);
  assert.doesNotMatch(rules, /"on"|"off"|"uninstall"/);
  assert.ok(fs.statSync(path.join(h, 'teamwork', 'bin', 'teamwork')).mode & 0o111, '실행 권한');
});

ptest('on 을 다시 해도 훅이 늘지 않는다', () => {
  const h = home();
  run(h, ['on']); run(h, ['off']); run(h, ['on']);
  const hooks = JSON.parse(fs.readFileSync(path.join(h, 'hooks.json'), 'utf8')).hooks;
  for (const ev of ['SessionStart', 'UserPromptSubmit']) {
    const ours = hooks[ev].flatMap((g) => g.hooks).filter((x) => x.command.includes('teamwork/bin/teamwork'));
    assert.equal(ours.length, 1, ev);
  }
});

ptest('설치 뒤 래퍼로 실행된다', () => {
  const h = home();
  run(h, ['on']);
  const r = spawnSync(path.join(h, 'teamwork', 'bin', 'teamwork'), ['version'], { env: { ...process.env, CODEX_HOME: h }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^\d+\.\d+\.\d+/);
});

ptest('켜져 있으면 새 세션은 등록되고 규칙 전체를 받는다', () => {
  const h = home();
  run(h, ['on'], { threadId: A });
  const ctx = hook(h, 'session-start', B);
  assert.match(ctx, /\[teamwork 켜짐\]/);
  assert.match(ctx, /bbbbbb/);
  assert.match(ctx, /aaaaaa/);
  const st = run(h, ['status']);
  assert.match(st.out, /켜짐/);
});

ptest('UserPromptSubmit 은 처음에 규칙, 이후에는 목록이 바뀔 때만 넣는다', () => {
  const h = home();
  run(h, ['on']);
  assert.match(hook(h, 'prompt', A), /\[teamwork 켜짐\]/);
  assert.equal(hook(h, 'prompt', A), null, '변화 없으면 주입 안 함');
  hook(h, 'session-start', B);
  assert.match(hook(h, 'prompt', A), /피어 목록이 바뀌었다/);
  assert.equal(hook(h, 'prompt', A), null);
});

ptest('off 뒤에는 각 세션이 한 번만 꺼짐 안내를 받는다', () => {
  const h = home();
  run(h, ['on']);
  hook(h, 'prompt', A);
  run(h, ['off']);
  assert.match(hook(h, 'prompt', A), /\[teamwork 꺼짐\]/);
  assert.equal(hook(h, 'prompt', A), null);
  assert.equal(hook(h, 'session-start', B), null, '꺼진 뒤 새 세션은 등록 안 함');
  assert.doesNotMatch(run(h, ['status']).out, /bbbbbb/);
});

ptest('다시 켜면 꺼짐 안내를 받았던 세션도 규칙을 다시 받는다', () => {
  const h = home();
  run(h, ['on']); hook(h, 'prompt', A); run(h, ['off']); hook(h, 'prompt', A); run(h, ['on']);
  assert.match(hook(h, 'prompt', A), /\[teamwork 켜짐\]/);
});

ptest('role 은 이 세션의 역할을 기록하고 목록에 보인다', () => {
  const h = home();
  run(h, ['on']);
  hook(h, 'session-start', A);
  const r = run(h, ['role', '검토', '담당'], { threadId: A });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /역할: 검토-담당/);
  assert.match(run(h, ['peers']).out, /역할:검토-담당/);
});

ptest('꺼져 있으면 send 와 role 은 거절한다', () => {
  const h = home();
  run(h, ['on']); run(h, ['off']);
  assert.equal(run(h, ['send', 'all', 'x'], { threadId: A }).code, 3);
  assert.equal(run(h, ['role', 'x'], { threadId: A }).code, 3);
});

ptest('받을 세션이 없으면 4 로 끝난다', () => {
  const h = home();
  run(h, ['on'], { threadId: A });
  const r = run(h, ['send', '없는역할', '내용'], { threadId: A });
  assert.equal(r.code, 4);
  assert.match(r.err, /받을 세션이 없습니다/);
});

ptest('죽은 Codex 프로세스의 세션은 목록에서 빠진다', () => {
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

ptest('uninstall 은 우리 훅만 지우고 다른 훅은 남긴다', () => {
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

ptest('reply 는 이 세션이 받은 요청에만 보낼 수 있다', () => {
  const h = home();
  run(h, ['on']);
  hook(h, 'session-start', A);
  seedLog(h, [{ rid: 'bbbbbb-1', kind: 'request', from: B, to: A, ok: true, text: 'x' }]);
  const r = run(h, ['reply', 'bbbbbb-9', '결과'], { threadId: A });
  assert.equal(r.code, 4);
  assert.match(r.err, /받은 요청 bbbbbb-9 이 없습니다/);
  assert.equal(run(h, ['reply', 'bbbbbb-1', '결과'], { threadId: B }).code, 4, '나에게 온 요청이 아님');
});

ptest('결과 메시지에는 reply 할 수 없다', () => {
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

ptest('같은 요청에 결과를 두 번 보낼 수 없다', () => {
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

ptest('요청한 세션이 닫혔으면 reply 는 4 로 끝난다', () => {
  const h = home();
  run(h, ['on']);
  seedLog(h, [{ rid: 'aaaaaa-1', kind: 'request', from: A, to: B, ok: true, text: 'x' }]);
  const r = run(h, ['reply', 'aaaaaa-1', '결과'], { threadId: B });
  assert.equal(r.code, 4);
  assert.match(r.err, /닫혔습니다/);
});

ptest('기록에 깨진 줄이 있어도 나머지 기록을 읽는다', () => {
  const h = home();
  run(h, ['on']);
  seedLog(h, [{ rid: 'aaaaaa-1', kind: 'request', from: A, to: B, ok: true, text: 'x' }], '{"rid":');
  fs.appendFileSync(path.join(h, 'teamwork', 'log.jsonl'), '\n');
  const r = run(h, ['reply', 'aaaaaa-1', '결과'], { threadId: B });
  assert.match(r.err, /닫혔습니다/, '요청을 찾은 뒤 다음 단계에서 멈춰야 함');
});

ptest('Codex 밖에서 온 요청에는 reply 하지 않는다', () => {
  const h = home();
  run(h, ['on']);
  seedLog(h, [{ rid: 'u0a1b2c-1', kind: 'request', from: null, to: B, ok: true, text: 'x' }]);
  const r = run(h, ['reply', 'u0a1b2c-1', '결과'], { threadId: B });
  assert.equal(r.code, 4);
  assert.match(r.err, /Codex 밖에서 왔습니다/);
});

ptest('다시 on 해도 훅 파일은 바뀌지 않는다 (재신뢰 방지)', () => {
  const h = home();
  run(h, ['on']);
  const f = path.join(h, 'hooks.json');
  const before = fs.readFileSync(f, 'utf8');
  run(h, ['off']);
  const r = run(h, ['on']);
  assert.equal(fs.readFileSync(f, 'utf8'), before);
  assert.doesNotMatch(r.out, /훅을 다시 넣었습니다|처음 설치했습니다/);
});

ptest('hooks.json 이 심볼릭 링크면 링크를 유지하고 대상 파일을 고친다', () => {
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

ptest('경로 조각만 같은 다른 도구의 훅은 지우지 않는다', () => {
  const h = home();
  const other = '/opt/x/teamwork/bin/teamwork-other notify';
  fs.writeFileSync(path.join(h, 'hooks.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: other }] }] } }));
  run(h, ['on']);
  run(h, ['uninstall']);
  const hooks = JSON.parse(fs.readFileSync(path.join(h, 'hooks.json'), 'utf8')).hooks;
  assert.deepEqual(hooks.SessionStart.flatMap((g) => g.hooks.map((x) => x.command)), [other]);
});

ptest('상태 폴더와 파일은 이 사용자만 읽는다', () => {
  const h = home();
  run(h, ['on'], { threadId: A });
  const tw = path.join(h, 'teamwork');
  assert.equal(fs.statSync(tw).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(tw, 'state.json')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(tw, 'peers', `${A}.json`)).mode & 0o777, 0o600);
});

ptest('훅은 내부 오류가 나도 빈 응답과 0 으로 끝난다', () => {
  const h = home();
  run(h, ['on']);
  fs.writeFileSync(path.join(h, 'teamwork', 'seen'), 'not a dir');
  const r = run(h, ['hook', 'prompt'], { input: JSON.stringify({ session_id: A, cwd: '/w' }) });
  assert.equal(r.code, 0);
  assert.equal(r.out.trim(), '{}');
  assert.match(r.err, /teamwork 훅 오류/);
});

ptest('엔진이 지워져도 래퍼의 훅 호출은 빈 응답으로 끝난다', () => {
  const h = home();
  run(h, ['on']);
  fs.unlinkSync(path.join(h, 'teamwork', 'bin', 'teamwork.mjs'));
  const r = spawnSync(path.join(h, 'teamwork', 'bin', 'teamwork'), ['hook', 'prompt'], { input: '{}', encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), '{}');
  const other = spawnSync(path.join(h, 'teamwork', 'bin', 'teamwork'), ['status'], { encoding: 'utf8' });
  assert.equal(other.status, 6);
});

ptest('하위 에이전트 세션은 피어로 등록하지 않는다', () => {
  const h = home();
  run(h, ['on']);
  const tp = path.join(h, 'rollout.jsonl');
  fs.writeFileSync(tp, JSON.stringify({ type: 'session_meta', payload: { source: { subagent: { thread_spawn: { parent_thread_id: A } } } } }) + '\n');
  assert.equal(hook(h, 'session-start', B, { transcript_path: tp }), null);
  assert.doesNotMatch(run(h, ['peers']).out, /bbbbbb/);
});

ptest('역할 이름의 특수 문자는 바꾼다', () => {
  const h = home();
  run(h, ['on']);
  hook(h, 'session-start', A);
  const r = run(h, ['role', "검토 [teamwork] 'x'"], { threadId: A });
  assert.match(r.out, /역할: 검토-teamwork-x/);
});

ptest('긴 본문은 거절하고 --file 은 파일을 읽는다', () => {
  const h = home();
  run(h, ['on'], { threadId: A });
  const long = run(h, ['send', 'all', 'x'.repeat(8001)], { threadId: A });
  assert.equal(long.code, 2);
  const f = path.join(h, 'msg.txt');
  fs.writeFileSync(f, "따옴표 ' 와 $HOME 과 `백틱`");
  const r = run(h, ['send', 'all', '--file', f], { threadId: A, cwd: h });
  assert.equal(r.code, 4, '피어가 없어 대상 없음까지 진행');
});

ptest('쓸 수 없는 상태 폴더면 짧은 안내와 6 으로 끝난다', { skip: process.getuid?.() === 0 }, () => {
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

ptest('피어 메시지로 시작한 턴에는 send 를 막고, 사용자 입력 턴에는 풀어 준다', () => {
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

ptest('--file 은 작업 폴더와 임시 폴더 밖의 파일을 거절한다', () => {
  const h = home();
  run(h, ['on'], { threadId: A });
  const outside = path.join(RUN, `outside${++n}.txt`);
  fs.writeFileSync(outside, 'x');
  const r = run(h, ['send', 'all', '--file', outside], { threadId: A, cwd: h });
  assert.equal(r.code, 2);
  assert.match(r.err, /안의 파일만 보낼 수 있습니다/);
});

ptest('승인 규칙 파일은 0600 이다', () => {
  const h = home();
  run(h, ['on']);
  assert.equal(fs.statSync(path.join(h, 'rules', 'teamwork.rules')).mode & 0o777, 0o600);
});

ptest('래퍼에 적힌 node 가 사라지면 PATH 의 node 로 대신하지 않는다', () => {
  const h = home();
  run(h, ['on']);
  const w = path.join(h, 'teamwork', 'bin', 'teamwork');
  fs.writeFileSync(w, fs.readFileSync(w, 'utf8').replaceAll(fs.realpathSync(process.execPath), '/nonexistent/node'));
  const env = { ...process.env, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` };
  const r = spawnSync(w, ['version'], { env, encoding: 'utf8' });
  assert.equal(r.status, 6);
  assert.match(r.stderr, /on 을 다시/);
  const none = spawnSync(w, ['hook', 'prompt'], { env, input: '{}', encoding: 'utf8' });
  assert.equal(none.status, 0);
  assert.equal(none.stdout.trim(), '{}');
  assert.match(none.stderr, /훅을 건너뜁니다/);
});

ptest('대화 기록 첫 줄이 64KB 를 넘어도 하위 에이전트를 알아본다', () => {
  const h = home();
  run(h, ['on']);
  const tp = path.join(h, 'rollout.jsonl');
  const meta = { type: 'session_meta', payload: { base_instructions: 'x'.repeat(200000), source: { subagent: { thread_spawn: {} } } } };
  fs.writeFileSync(tp, JSON.stringify(meta) + '\n{"type":"next"}\n');
  assert.equal(hook(h, 'session-start', B, { transcript_path: tp }), null);
  assert.doesNotMatch(run(h, ['peers']).out, /bbbbbb/);
});

// ---------- 0.3.0: 샌드박스 경계, 훅 공유 잠금, 엔진 판 ----------

const hooksOf = (h) => JSON.parse(fs.readFileSync(path.join(h, 'hooks.json'), 'utf8')).hooks;
const cmdsOf = (h, ev) => (hooksOf(h)[ev] || []).flatMap((g) => g.hooks.map((x) => x.command));
const ours = (h, ev) => cmdsOf(h, ev).filter((c) => c.includes('/teamwork/bin/teamwork'));

test('unsafePath: 상대 경로, 임시 폴더, 세션 폴더, 그 git 저장소, writable_roots 아래를 거부한다', () => {
  const ctx = { cwd: '/w/proj', gitTop: '/w', tmpRoots: ['/tmp'], writableRoots: ['/data/rw'], home: '/home/u' };
  assert.match(engine.unsafePath('bin/codex', ctx), /절대 경로가 아님/);
  assert.match(engine.unsafePath('./node', ctx), /절대 경로가 아님/);
  assert.match(engine.unsafePath('/tmp/x/codex', ctx), /임시 폴더/);
  assert.match(engine.unsafePath('/w/proj/deep/.codex', ctx), /세션 폴더 아래/);
  assert.match(engine.unsafePath('/w/proj/codexhome', ctx), /세션 폴더 아래/);
  assert.match(engine.unsafePath('/w/other/.codex', ctx), /git 저장소/);
  assert.match(engine.unsafePath('/data/rw/h', ctx), /writable_roots/);
  assert.equal(engine.unsafePath('/home/u/.codex', ctx), '');
  assert.equal(engine.unsafePath('/w/projx/.codex', { ...ctx, gitTop: '' }), '', '이름만 비슷한 옆 폴더');
  assert.equal(engine.unsafePath('/home/u/.codex', { ...ctx, cwd: '/home/u', gitTop: '/home/u' }), '', '세션 폴더가 홈 자체면 예외');
  assert.equal(engine.unsafePath('/opt/x', { ...ctx, cwd: '/', gitTop: '' }), '', '루트는 세션 폴더로 보지 않음');
});

function refused(h, opts) {
  const r = run(h, ['on'], opts);
  assert.equal(r.code, 6, r.err);
  assert.ok(!fs.existsSync(path.join(h, 'rules', 'teamwork.rules')), '규칙 파일 없음');
  assert.ok(!fs.existsSync(path.join(h, 'teamwork', 'bin', 'teamwork')), '래퍼 없음');
  return r.err;
}

ptest('Codex 홈이 세션 폴더 안(깊은 폴더, 다른 이름), 임시 폴더, writable_roots 아래면 설치하지 않는다', { skip: !POSIX }, () => {
  const proj = path.join(RUN, `proj${++n}`);
  for (const sub of ['deep/.codex', 'codexhome']) {
    fs.mkdirSync(path.join(proj, sub), { recursive: true });
    assert.match(refused(path.join(proj, sub), { cwd: proj }), /세션 폴더 아래/);
  }
  fs.mkdirSync(path.join(proj, '.git'));
  fs.mkdirSync(path.join(proj, 'sub'));
  assert.match(refused(path.join(proj, 'codexhome'), { cwd: path.join(proj, 'sub') }), /git 저장소/);
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'teamwork-home-'));
  try { assert.match(refused(tmpHome), /임시 폴더/); } finally { fs.rmSync(tmpHome, { recursive: true, force: true }); }
  const h = home();
  fs.writeFileSync(path.join(h, 'config.toml'), `[sandbox_workspace_write]\nwritable_roots = ["${RUN}"]\n`);
  assert.match(refused(h), /writable_roots/);
});

// 가짜 프로그램: 실행되면 표지 파일을 남긴다
function plant(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ['node', 'codex', 'ps', 'sh']) {
    fs.writeFileSync(path.join(dir, name), `#!/bin/sh\necho "${name} $*" >> "${path.join(dir, 'MARK')}"\necho "codex-cli 9.9.9"\n`, { mode: 0o755 });
  }
  return path.join(dir, 'MARK');
}

ptest('세션 폴더와 임시 폴더에 심은 node, codex, ps, sh 는 on, send, 훅 어디서도 돌지 않는다', { skip: !POSIX }, () => {
  const h = home();
  const mark = plant(path.join(CWD, 'planted'));
  const tmpBin = fs.mkdtempSync(path.join(os.tmpdir(), 'teamwork-plant-'));
  const tmpMark = plant(tmpBin);
  const p = ['planted', tmpBin, FAKE, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter);
  try {
    assert.equal(run(h, ['on'], { path: p }).code, 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(h, 'teamwork', 'state.json'), 'utf8')).tools.codex, fs.realpathSync(path.join(FAKE, 'codex')));
    const w = path.join(h, 'teamwork', 'bin', 'teamwork');
    const env = envFor(h, { path: p, threadId: A });
    spawnSync(w, ['hook', 'session-start'], { env, cwd: CWD, input: JSON.stringify({ session_id: B, cwd: CWD }), encoding: 'utf8' });
    fs.rmSync(QUEUE_LOG, { force: true });
    const s = spawnSync(w, ['send', 'all', '검산'], { env, cwd: CWD, encoding: 'utf8' });
    assert.equal(s.status, 0, s.stderr);
    assert.match(fs.readFileSync(QUEUE_LOG, 'utf8'), new RegExp(`queue --thread ${B} --message \\[teamwork 요청`), '기록한 codex 로 보냄');
    spawnSync(w, ['peers'], { env, cwd: CWD, encoding: 'utf8' });
    assert.ok(!fs.existsSync(mark) && !fs.existsSync(tmpMark), '심은 프로그램이 돌지 않음');
  } finally { fs.rmSync(tmpBin, { recursive: true, force: true }); }
});

ptest('PATH 에 안전한 codex 가 없으면 6 으로 끝나고 아무것도 쓰지 않는다', { skip: !POSIX }, () => {
  plant(path.join(CWD, 'only'));
  assert.match(refused(home(), { path: ['only', path.join(CWD, 'only'), '/usr/bin', '/bin'].join(path.delimiter) }), /Codex CLI 를 PATH 에서 찾지 못했습니다/);
});

ptest('기록한 codex 가 사라지면 이름으로 대신하지 않고 6 과 on 안내', { skip: !POSIX }, () => {
  const h = home();
  run(h, ['on']);
  hook(h, 'session-start', B);
  const st = path.join(h, 'teamwork', 'state.json');
  const j = JSON.parse(fs.readFileSync(st, 'utf8'));
  fs.writeFileSync(st, JSON.stringify({ ...j, tools: { ...j.tools, codex: '/nonexistent/codex' } }));
  const r = run(h, ['send', 'all', 'x'], { threadId: A });
  assert.equal(r.code, 6);
  assert.match(r.err, /on 을 다시/);
});

ptest('같은 이름의 사용자 규칙 파일은 덮어쓰지도 지우지도 않는다', { skip: !POSIX }, () => {
  const h = home();
  fs.mkdirSync(path.join(h, 'rules'));
  const f = path.join(h, 'rules', 'teamwork.rules');
  fs.writeFileSync(f, 'prefix_rule(pattern=["mine"], decision="allow")\n');
  assert.match(run(h, ['on']).out, /teamwork 가 만든 파일이 아니라 두었습니다/);
  run(h, ['uninstall']);
  assert.equal(fs.readFileSync(f, 'utf8'), 'prefix_rule(pattern=["mine"], decision="allow")\n');
});

function variant(version, extra = '') {
  const dir = path.join(RUN, `v${++n}`);
  fs.mkdirSync(dir);
  const f = path.join(dir, 'teamwork.mjs');
  fs.writeFileSync(f, fs.readFileSync(SCRIPT, 'utf8').replace(/^const VERSION = '[^']*';$/m, `const VERSION = '${version}';`) + extra);
  return f;
}
const engineVersion = (h) => /^const VERSION = '([^']*)'/m.exec(fs.readFileSync(path.join(h, 'teamwork', 'bin', 'teamwork.mjs'), 'utf8'))[1];

ptest('낮은 판 스크립트로 on 해도 엔진 판은 그대로다', { skip: !POSIX }, () => {
  const h = home();
  run(h, ['on'], { script: variant('9.0.0') });
  const r = run(h, ['on'], { script: variant('0.0.1') });
  assert.equal(r.code, 0, r.err);
  assert.equal(engineVersion(h), '9.0.0');
});

ptest('훅 명령에 엔진 표지가 있고, 엔진 판이 오르면 같은 자리에서 고쳐 신뢰를 다시 묻는다', { skip: !POSIX }, () => {
  const h = home();
  run(h, ['on']);
  const before = ours(h, 'UserPromptSubmit');
  assert.match(before[0], /hook prompt --rev [0-9a-f]{12}$/);
  const r = run(h, ['on'], { script: variant('9.1.0', '\n// changed\n') });
  assert.match(r.out, /훅을 다시 넣었습니다/);
  const after = cmdsOf(h, 'UserPromptSubmit');
  assert.deepEqual(after.length, 2);
  assert.equal(after[0], '/usr/bin/true other-tool', '다른 훅의 자리 유지');
  assert.notEqual(after[1], before[0]);
  assert.equal(ours(h, 'SessionStart').length, 1);
  assert.equal(hooksOf(h).UserPromptSubmit.at(-1).hooks[0].timeout, 5);
});

test('상주 app-server 가 돌린 훅은 pid 를 적지 않는다 (활동 시각으로 정리)', () => {
  const tree = { 10: { comm: 'node', ppid: 20 }, 20: { comm: 'codex', ppid: 1 } };
  const info = (pid) => tree[pid] || null;
  assert.equal(engine.findCodexPid(10, info, () => 'codex app-server --listen x'), null);
  assert.equal(engine.findCodexPid(10, info, () => 'codex resume --last'), 20);
});

ptest('banker 가 지워지면 훅은 멈추고 정리 명령을 한 번 안내한다', { skip: !POSIX }, () => {
  const h = home();
  const copy = variant('0.3.0');
  run(h, ['on'], { script: copy });
  hook(h, 'session-start', A);
  fs.rmSync(path.dirname(copy), { recursive: true });
  assert.match(hook(h, 'prompt', A), /banker 가 이 기기에서 지워져.*uninstall/);
  assert.equal(hook(h, 'prompt', A), null, '한 번만');
  assert.equal(run(h, ['uninstall']).code, 0);
});

const P = (h) => ch.codexPaths({ CODEX_HOME: h });
const bankerOn = (h) => ch.enableHooks(P(h), ['update', 'count'], REPO, process.execPath, CWD);
const bankerCmds = (h) => ['SessionStart', 'Stop'].flatMap((ev) => cmdsOf(h, ev)).filter((c) => c.includes('/hooks-custom/banker/'));

ptest('banker 훅과 teamwork 를 어떤 순서로 켜고 꺼도 서로의 항목을 지우지 않는다', { skip: !POSIX }, () => {
  const h = home();
  assert.equal(bankerOn(h).code, 0);
  assert.equal(run(h, ['on']).code, 0);
  assert.equal(bankerCmds(h).length, 2);
  assert.equal(ours(h, 'SessionStart').length + ours(h, 'UserPromptSubmit').length, 2);
  const mid = fs.readFileSync(path.join(h, 'hooks.json'), 'utf8');
  assert.deepEqual(bankerOn(h).changed, []);
  assert.equal(fs.readFileSync(path.join(h, 'hooks.json'), 'utf8'), mid);
  assert.equal(run(h, ['uninstall']).code, 0);
  assert.equal(bankerCmds(h).length, 2);
  assert.ok(cmdsOf(h, 'UserPromptSubmit').includes('/usr/bin/true other-tool'));
  assert.equal(ch.disableHooks(P(h), ['update', 'count']).code, 0);
  assert.deepEqual(cmdsOf(h, 'UserPromptSubmit'), ['/usr/bin/true other-tool']);
  assert.equal(hooksOf(h).SessionStart, undefined);
});

ptest('잠금 없는 옛 엔진(0.2.1)이 넣은 훅도 새 엔진이 같은 자리에서 고치고 banker 항목은 남긴다', { skip: !POSIX }, () => {
  const h = home();
  const old = path.join(RUN, `old${++n}`, 'teamwork.mjs');
  fs.mkdirSync(path.dirname(old));
  fs.copyFileSync(OLD_ENGINE, old);
  assert.equal(run(h, ['on'], { script: old }).code, 0);
  assert.equal(bankerOn(h).code, 0);
  assert.equal(run(h, ['on']).code, 0);
  assert.equal(engineVersion(h), '0.3.0');
  for (const ev of ['SessionStart', 'UserPromptSubmit']) {
    assert.equal(ours(h, ev).length, 1, ev);
    assert.match(ours(h, ev)[0], / --rev [0-9a-f]{12}$/);
  }
  assert.equal(bankerCmds(h).length, 2);
  assert.match(fs.readFileSync(path.join(h, 'rules', 'teamwork.rules'), 'utf8'), /"send"/);
});

const spawnP = (args, env) => new Promise((resolve) => {
  const c = spawn(process.execPath, args, { env, cwd: CWD, stdio: 'ignore' });
  c.on('close', resolve);
});

ptest('banker 와 teamwork 가 동시에 20번 hooks.json 을 고쳐도 잃는 항목이 없다', { skip: !POSIX }, async () => {
  const lib = pathToFileURL(path.join(REPO, 'bin', 'lib', 'codex-hooks.mjs')).href;
  for (let round = 0; round < 2; round++) {
    const h = home();
    const env = envFor(h);
    const banker = `import(${JSON.stringify(lib)}).then((c) => { const r = c.enableHooks(c.codexPaths(process.env), ['update', 'count'], ${JSON.stringify(REPO)}, process.execPath, ${JSON.stringify(CWD)}); if (r.code) { console.error(r.msg); process.exit(1); } })`;
    const jobs = Array.from({ length: 20 }, (_, i) => (i % 2 ? spawnP([SCRIPT, 'on'], env) : spawnP(['-e', banker], env)));
    assert.ok((await Promise.all(jobs)).every((c) => c === 0));
    assert.equal(bankerCmds(h).length, 2, `round ${round}`);
    assert.equal(ours(h, 'SessionStart').length + ours(h, 'UserPromptSubmit').length, 2);
    assert.ok(cmdsOf(h, 'UserPromptSubmit').includes('/usr/bin/true other-tool'));
    assert.ok(!fs.existsSync(path.join(h, 'hooks.json.lock')));
    assert.deepEqual(fs.readdirSync(h).filter((f) => f.endsWith('.tmp')), []);
  }
});

test('Windows 는 전제 실측 전이라 on 이 까닭을 밝히고 6 으로 끝난다', { skip: POSIX }, () => {
  const r = run(home(false), ['on']);
  assert.equal(r.code, 6);
  assert.match(r.err, /Windows 는 아직 지원하지 않습니다/);
});

ptest('banker uninstall --codex 는 다른 banker 길이 남아 있으면 teamwork 를 두고, 없을 때만 지운다', { skip: !POSIX || process.getuid?.() === 0 }, () => {
  const h = home();
  run(h, ['on']);
  const plugin = path.join(h, 'plugins', 'cache', 'banker-plugins', 'banker', '9.9.9', 'codex', 'skills', 'teamwork');
  fs.mkdirSync(plugin, { recursive: true });
  fs.writeFileSync(path.join(plugin, 'SKILL.md'), '---\nname: teamwork\n---\n');
  fs.writeFileSync(path.join(h, 'config.toml'), '[plugins."banker@banker-plugins"]\nenabled = true\n');
  const banker = () => spawnSync(process.execPath, [path.join(REPO, 'bin', 'banker.js'), 'uninstall', '--codex', '--scope', 'user'], { env: envFor(h), cwd: CWD, encoding: 'utf8' });
  assert.match(banker().stdout, /teamwork kept/);
  assert.ok(fs.existsSync(path.join(h, 'teamwork', 'state.json')));
  fs.rmSync(path.join(h, 'plugins'), { recursive: true });
  fs.rmSync(path.join(h, 'config.toml'));
  assert.match(banker().stdout, /removed teamwork/);
  assert.ok(!fs.existsSync(path.join(h, 'teamwork')));
  assert.ok(!fs.existsSync(path.join(h, 'rules', 'teamwork.rules')));
  assert.deepEqual(cmdsOf(h, 'UserPromptSubmit'), ['/usr/bin/true other-tool']);
});
