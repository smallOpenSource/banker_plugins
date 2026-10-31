// pm-data.mjs 시험. init, item, note, stage, story 와 items.json 잠금, 원자적 쓰기.
// CLI 는 자식 프로세스(임시 프로젝트, 임시 HOME). 잠금과 쓰기 재시도는 대역 fs 로 직접 부른다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { acquireLock, releaseLock, updateItems, itemChange, isoSec } from './pm-data.mjs';
import { writeAtomic } from './pm-config.mjs';
import { ruleLine } from './pm-memory.mjs';

const T = { timeout: 60000 };
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'progress-mon.mjs');
const FIXTURE = path.resolve(HERE, '..', 'assets', 'fixture');
const ROOT = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'progress-mon-test-')));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const HOME = path.join(ROOT, 'home');
const ENV = (() => {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(CLAUDE_|CODEX_|PROGRESS_MON_|PM_TEST_|GIT_)/i.test(k)) env[k] = v;
  return Object.assign(env, {
    HOME,
    USERPROFILE: HOME,
    APPDATA: path.join(HOME, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(HOME, 'AppData', 'Local'),
    CLAUDE_CONFIG_DIR: path.join(HOME, '.claude'),
    CODEX_HOME: path.join(HOME, '.codex'),
    NO_COLOR: '1',
    GIT_CEILING_DIRECTORIES: ROOT,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(ROOT, 'gitconfig-empty'),
    GIT_AUTHOR_NAME: 'example',
    GIT_AUTHOR_EMAIL: 'example@example.invalid',
    GIT_COMMITTER_NAME: 'example',
    GIT_COMMITTER_EMAIL: 'example@example.invalid',
  });
})();
fs.writeFileSync(ENV.GIT_CONFIG_GLOBAL, '');

let n = 0;
// 임시 프로젝트. git: git init 한 저장소. data: 고정 자료(assets/fixture)를 자료 폴더에 복사.
function project({ git = false, data = false } = {}) {
  const p = path.join(ROOT, `p${++n}`, 'app');
  fs.mkdirSync(p, { recursive: true });
  if (git) execFileSync('git', ['init', '-q'], { cwd: p, env: ENV, windowsHide: true });
  if (data) {
    const d = path.join(p, '.omc', 'progress-mon');
    fs.mkdirSync(d, { recursive: true });
    for (const f of ['config.json', 'items.json']) fs.copyFileSync(path.join(FIXTURE, f), path.join(d, f));
  }
  return p;
}
const dataOf = (p) => path.join(p, '.omc', 'progress-mon');
const items = (p) => JSON.parse(fs.readFileSync(path.join(dataOf(p), 'items.json'), 'utf8'));
const cli = (args, cwd) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env: ENV, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const Z = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;
const NEXT = '다음 할 일\n  1. references/authoring.md 를 읽고 req-spec.json, reqs.json, flow.json, arch.json 작성\n  2. check 로 검사. FAIL 0 까지 최대 3회\n  3. start 로 서버 시작\n';

test('init: --memory 없음과 틀린 값은 종료 1, 아무것도 만들지 않음', T, () => {
  const p = project({ git: true });
  const a = cli(['init'], p);
  assert.equal(a.code, 1);
  assert.equal(a.err, '오류: init 에는 --memory claude-md|agents-md|auto-memory|none 가 필요함\n');
  const b = cli(['init', '--memory', 'home'], p);
  assert.equal(b.code, 1);
  assert.match(b.err, /받은 값 home/);
  assert.equal(fs.existsSync(path.join(p, '.omc')), false);
});

test('init --memory none: 자료 폴더, 설정, state.json, git 제외 목록(--git-path) 한 줄, 메모리 파일 0', T, () => {
  const p = project({ git: true });
  const r = cli(['init', '--memory', 'none', '--title', '내 앱 진척도'], p);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.err, '');
  assert.equal(
    r.out,
    '자료 폴더: .omc/progress-mon/\n새로 만듦: .omc/progress-mon/config.json\n새로 만듦: .omc/progress-mon/items.json\n새로 만듦: .omc/progress-mon/state.json\n' +
      'git 제외 목록 추가: /.omc/progress-mon/ (.git/info/exclude)\n규칙 등록 안 함(--memory none)\n' + NEXT,
  );
  const cfg = JSON.parse(fs.readFileSync(path.join(dataOf(p), 'config.json'), 'utf8'));
  assert.equal(cfg.title, '내 앱 진척도');
  assert.equal(cfg.stages, 'auto');
  assert.deepEqual(items(p), { notes: {}, items: [], storyCommits: {}, storyStates: {}, stageEvents: [] });
  const st = JSON.parse(fs.readFileSync(path.join(dataOf(p), 'state.json'), 'utf8'));
  assert.equal(fs.realpathSync.native(st.skillDir), fs.realpathSync.native(path.resolve(HERE, '..')));
  assert.equal(st.runtime, 'claude');
  assert.deepEqual(st.memory, { kind: 'none', path: null });
  assert.match(st.updatedAt, Z);
  const excl = path.resolve(p, execFileSync('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd: p, env: ENV, encoding: 'utf8' }).trim());
  const cfgBytes = fs.readFileSync(path.join(dataOf(p), 'config.json'));
  const again = cli(['init', '--memory', 'none', '--title', '다른 제목'], p);
  assert.equal(again.code, 0);
  assert.match(again.out, /^그대로 둠: \.omc\/progress-mon\/config\.json$/m);
  assert.match(again.out, /^git 제외 목록: 이미 있음$/m);
  assert.doesNotMatch(again.out, /state\.json/);
  assert.deepEqual(fs.readFileSync(path.join(dataOf(p), 'config.json')), cfgBytes, '설정 그대로');
  assert.equal(fs.readFileSync(excl, 'utf8').split(/\r?\n/).filter((l) => l === '/.omc/progress-mon/').length, 1, '제외 줄 중복 0');
  assert.deepEqual(fs.readdirSync(p).sort(), ['.git', '.omc']);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: p, env: ENV, encoding: 'utf8' }), '', '자료 폴더가 git 무시 대상');
});

test('init: git 저장소가 아니면 제외 목록은 알림만, claude-md 규칙 새로 만듦', T, () => {
  const p = project();
  const r = cli(['init', '--memory', 'claude-md'], p);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^git 제외 목록: git 저장소 아님, 건너뜀$/m);
  assert.match(r.out, /^규칙 추가: CLAUDE\.md \(새로 만듦, 1줄\)$/m);
  assert.equal(fs.readFileSync(path.join(p, 'CLAUDE.md'), 'utf8'), ruleLine('claude') + '\n');
});

test('init --runtime codex: .omx 자료 폴더와 Codex 규칙 블록', T, () => {
  const p = project({ git: true });
  const r = cli(['init', '--runtime', 'codex', '--memory', 'agents-md'], p);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^자료 폴더: \.omx\/progress-mon\/$/m);
  assert.match(r.out, /^git 제외 목록 추가: \/\.omx\/progress-mon\/ /m);
  assert.ok(fs.readFileSync(path.join(p, 'AGENTS.md'), 'utf8').includes(ruleLine('codex')));
  const cfg = JSON.parse(fs.readFileSync(path.join(p, '.omx', 'progress-mon', 'config.json'), 'utf8'));
  assert.deepEqual(cfg.sources.workflowDirs, []);
});

test('item: 같은 key 대체와 시작 시각 s 유지, Z 형식, 모르는 status 거부', T, () => {
  const p = project({ data: true });
  const a = cli(['item', '--key', 'k1', '--status', 'doing', '--text', '작업', '--note', '근거 abc'], p);
  assert.equal(a.code, 0, a.err);
  assert.equal(a.out, 'item k1: 추가(doing). 항목 4개\n');
  const first = items(p).items.find((x) => x.key === 'k1');
  assert.match(first.s, Z);
  assert.match(first.t, Z);
  const b = cli(['item', '--key', 'k1', '--status', 'done', '--text', '작업 끝', '--issue', '없음'], p);
  assert.equal(b.out, 'item k1: 대체(doing 에서 done), 시작 시각 유지. 항목 4개\n');
  const list = items(p).items.filter((x) => x.key === 'k1');
  assert.equal(list.length, 1);
  assert.equal(list[0].s, first.s);
  assert.equal(list[0].status, 'done');
  assert.equal(list[0].text, '작업 끝');
  assert.equal(list[0].issue, '없음');
  // 시작 시각이 없던 todo 항목은 doing 이 된 시각을 시작 시각으로
  cli(['item', '--key', 'bench', '--status', 'doing', '--text', '속도 측정'], p);
  const bench = items(p).items.find((x) => x.key === 'bench');
  assert.equal(bench.s, bench.t);
  assert.notEqual(bench.s, '2026-10-29T02:00:00Z', '옛 t(todo 기록 시각)가 아님');
  const bad = cli(['item', '--key', 'k1', '--status', 'wip', '--text', 'x'], p);
  assert.equal(bad.code, 1);
  assert.equal(bad.err, '오류: --status 는 todo, doing, done 가운데 하나(받은 값 wip)\n');
  assert.equal(cli(['item', '--key', 'k2', '--status', 'done'], p).err, '오류: item 에는 --text 가 필요함\n');
  // 바꾸기 함수 직접: 시각은 넘긴 now
  const v = { items: [] };
  itemChange({ key: 'x', status: 'todo', text: 't', _: [] }, Date.parse('2026-10-29T03:00:00.456Z'))(v);
  assert.equal(v.items[0].t, '2026-10-29T03:00:00Z');
});

test('item --at: 지난 시각으로 기록(처음부터 done 이면 s 없음), doing 이 된 시각이 s, 대체는 s 유지, 시간대 없는 값 거부', T, () => {
  const p = project({ data: true });
  const a = cli(['item', '--key', 'c1', '--status', 'done', '--text', '지난 커밋', '--at', '2026-10-20T12:34:56+09:00'], p);
  assert.equal(a.code, 0, a.err);
  assert.deepEqual(items(p).items.find((x) => x.key === 'c1'), { key: 'c1', t: '2026-10-20T03:34:56Z', status: 'done', text: '지난 커밋' });
  cli(['item', '--key', 'c1', '--status', 'done', '--text', '지난 커밋 고침', '--at', '2026-10-21T00:00Z'], p);
  const c1 = items(p).items.find((x) => x.key === 'c1');
  assert.deepEqual([c1.t, c1.s], ['2026-10-21T00:00:00Z', undefined]);
  // todo 는 s 없음, doing 이 되면 그 시각, done 은 그 s 유지
  cli(['item', '--key', 'w1', '--status', 'todo', '--text', '할 일', '--at', '2026-10-21T01:00Z'], p);
  assert.equal(items(p).items.find((x) => x.key === 'w1').s, undefined);
  cli(['item', '--key', 'w1', '--status', 'doing', '--text', '할 일', '--at', '2026-10-21T02:00Z'], p);
  cli(['item', '--key', 'w1', '--status', 'done', '--text', '할 일', '--at', '2026-10-21T03:30Z'], p);
  const w1 = items(p).items.find((x) => x.key === 'w1');
  assert.deepEqual([w1.s, w1.t], ['2026-10-21T02:00:00Z', '2026-10-21T03:30:00Z']);
  for (const bad of ['2026-10-20T12:34:56', '2026-10-20', 'yesterday', '2026-13-40T99:00:00Z']) {
    const r = cli(['item', '--key', 'c2', '--status', 'done', '--text', 'x', '--at', bad], p);
    assert.equal(r.code, 1, bad);
    assert.equal(r.err, `오류: --at 은 시간대가 붙은 ISO 8601 시각(예 2026-10-29T12:34:56+09:00): ${bad}\n`);
  }
  assert.equal(items(p).items.some((x) => x.key === 'c2'), false, '거부하면 쓰지 않음');
});

test('item --commit: 4~40자 16진 해시를 hash 칸에, 그 밖은 거부(story --commit 과 같은 규칙)', T, () => {
  const p = project({ data: true });
  const a = cli(['item', '--key', 'c-1a2b3c4', '--status', 'done', '--text', '지난 커밋', '--at', '2026-10-20T12:34:56+09:00', '--commit', '1a2b3c4d5e'], p);
  assert.equal(a.code, 0, a.err);
  assert.deepEqual(items(p).items.find((x) => x.key === 'c-1a2b3c4'), { key: 'c-1a2b3c4', t: '2026-10-20T03:34:56Z', status: 'done', text: '지난 커밋', hash: '1a2b3c4d5e' });
  // 4자리는 받는다(story --commit 과 같은 하한)
  const short = cli(['item', '--key', 'c-short', '--status', 'done', '--text', 'x', '--commit', 'abcd'], p);
  assert.equal(short.code, 0, short.err);
  assert.equal(items(p).items.find((x) => x.key === 'c-short').hash, 'abcd');
  for (const bad of ['1a2', 'xyz1234', 'a'.repeat(41), '']) {
    const r = cli(['item', '--key', 'c2', '--status', 'done', '--text', 'x', '--commit', bad], p);
    assert.equal(r.code, 1, bad);
    assert.equal(r.err, `오류: --commit 은 4~40자 16진 해시(받은 값 ${bad})\n`);
  }
  assert.equal(items(p).items.some((x) => x.key === 'c2'), false, '거부하면 쓰지 않음');
  // --commit 없이 다시 기록하면 있던 hash 유지, 시작 시각이 없던 항목은 "시작 시각 유지" 문구 없음
  const again = cli(['item', '--key', 'c-1a2b3c4', '--status', 'done', '--text', '지난 커밋 고침'], p);
  assert.equal(again.out, 'item c-1a2b3c4: 대체(done 에서 done). 항목 5개\n');
  assert.equal(items(p).items.find((x) => x.key === 'c-1a2b3c4').hash, '1a2b3c4d5e');
  cli(['item', '--key', 'c-1a2b3c4', '--status', 'done', '--text', '지난 커밋', '--commit', 'abcdef1'], p);
  assert.equal(items(p).items.find((x) => x.key === 'c-1a2b3c4').hash, 'abcdef1', '--commit 을 주면 바꿈');
});

test('note: 같은 key 칸 단위 대체, 빈 값은 칸 삭제', T, () => {
  const p = project({ data: true });
  assert.equal(cli(['note', '--key', 'A3', '--note', '새 비고'], p).out, 'note A3: 대체(note). notes 2개\n');
  assert.deepEqual(items(p).notes.A3, { note: '새 비고', issue: '예시 자료 부족' });
  assert.equal(cli(['note', '--key', 'A3', '--issue', ''], p).out, 'note A3: 대체(issue). notes 2개\n');
  assert.deepEqual(items(p).notes.A3, { note: '새 비고' });
  assert.equal(cli(['note', '--key', 'stage:build', '--note', '1회차', '--issue', '느림'], p).out, 'note stage:build: 추가. notes 3개\n');
  assert.equal(cli(['note', '--key', 'A1'], p).code, 1);
});

test('stage: 상태 검사, 설정에 없는 단계는 새 행, stageEvents 에 Z 시각', T, () => {
  const p = project({ data: true });
  fs.mkdirSync(path.join(p, '.omc', 'ultra-chain', 'r1'), { recursive: true });
  fs.writeFileSync(path.join(p, '.omc', 'ultra-chain', 'r1', 'events.jsonl'), '');
  assert.equal(cli(['stage', '--id', 'plan', '--status', 'started'], p).out, 'stage plan: started 기록함\n');
  assert.equal(cli(['stage', '--id', 'deploy', '--status', 'done', '--label', '배포'], p).out, 'stage deploy: done 기록함. 새 단계 행(배포)\n');
  assert.equal(cli(['stage', '--id', 'deploy', '--status', 'failed'], p).out, 'stage deploy: failed 기록함\n');
  const ev = items(p).stageEvents;
  assert.equal(ev.length, 3);
  assert.deepEqual({ ...ev[1], t: 0 }, { t: 0, stage: 'deploy', status: 'done', label: '배포' });
  for (const e of ev) assert.match(e.t, Z);
  const bad = cli(['stage', '--id', 'plan', '--status', 'wip'], p);
  assert.equal(bad.code, 1);
  assert.equal(bad.err, '오류: --status 는 started, done, skipped, failed, stopped 가운데 하나(받은 값 wip)\n');
});

test('story: --status 는 storyStates, --commit 은 storyCommits, 새 스토리 행, 인자 검사', T, () => {
  const p = project({ data: true });
  assert.equal(cli(['story', '--id', 'A1', '--commit', 'abc1234'], p).out, 'story A1: 커밋 abc1234 기록함\n');
  assert.equal(cli(['story', '--id', 'M1', '--status', 'doing', '--name', '화면 초안'], p).out, 'story M1: doing 기록함. 새 스토리 행(화면 초안)\n');
  assert.equal(cli(['story', '--id', 'M1', '--status', 'done'], p).out, 'story M1: done 기록함\n');
  const v = items(p);
  assert.equal(v.storyCommits.A1.hash, 'abc1234');
  assert.match(v.storyCommits.A1.t, Z);
  assert.equal(v.storyStates.M1.status, 'done');
  assert.equal(v.storyStates.M1.name, '화면 초안', '이름 유지');
  assert.equal(cli(['story', '--id', 'A1'], p).err, '오류: story 에는 --status 또는 --commit 가운데 하나가 필요함\n');
  assert.equal(cli(['story', '--id', 'A1', '--status', 'done', '--commit', 'abcd'], p).code, 1);
  assert.match(cli(['story', '--id', 'A1', '--commit', 'xyz'], p).err, /16진 해시/);
  assert.match(cli(['story', '--id', 'A1', '--status', 'wip'], p).err, /todo, doing, done/);
});

test('AC-29: events 없는 프로젝트에 stage, story 로 쓴 상태가 진척도 탭에 반영', T, () => {
  const p = project({ git: true });
  assert.equal(cli(['init', '--memory', 'none'], p).code, 0);
  cli(['stage', '--id', 'design', '--status', 'done', '--label', '설계'], p);
  cli(['story', '--id', 'M1', '--status', 'doing', '--name', '화면 초안'], p);
  cli(['item', '--key', 'k', '--status', 'todo', '--text', '문서 정리', '--note', '근거'], p);
  const out = path.join(ROOT, `out${++n}.html`);
  assert.equal(cli(['export', out, '--now', '2026-10-29T03:00:00Z'], p).code, 0);
  const html = fs.readFileSync(out, 'utf8');
  assert.ok(html.includes('설계'));
  assert.ok(html.includes('M1 화면 초안'));
  assert.ok(html.includes('문서 정리'));
  assert.ok(!html.includes('0 사전 점검'), '예정 단계 행 없음');
});

// 동시 쓰기 한 회: 프로젝트 p 에 writers 개 item 을 한꺼번에.
// 돌려줌: { codes, lost(성공한 쓰기 수 - 늘어난 항목 수), missing(빠진 key), left(남은 잠금, 임시 파일) }
async function burst(p, writers, tag) {
  const run = (key) =>
    new Promise((resolve) => {
      const c = spawn(process.execPath, [CLI, 'item', '--key', key, '--status', 'doing', '--text', key], { cwd: p, env: ENV, stdio: 'ignore', windowsHide: true });
      c.on('exit', (code) => resolve(code));
    });
  const before = items(p).items.length;
  const keys = Array.from({ length: writers }, (_, i) => `${tag}-${i}`);
  const codes = await Promise.all(keys.map(run));
  const after = items(p).items;
  const have = new Set(after.map((x) => x.key));
  const lost = codes.filter((c) => c === 0).length - (after.length - before);
  const left = fs.readdirSync(dataOf(p)).filter((f) => f.includes('.lock') || f.endsWith('.tmp'));
  return { codes, lost, missing: keys.filter((k) => !have.has(k)), left };
}
const WRITERS = 24;
const ROUNDS = 5;
const deadPid = () => spawnSync(process.execPath, ['-e', ''], { windowsHide: true }).pid;

for (const stale of [false, true]) {
  const what = stale ? '낡은 잠금(죽은 pid, 오래된 createdAt) 위 동시 쓰기' : '동시 쓰기';
  test(`${what}: ${WRITERS}개 프로세스 x ${ROUNDS}회, 모두 종료 0, 항목 수 = 성공한 쓰기 수, 잠금 정리`, T, async () => {
    const lost = [];
    for (let r = 0; r < ROUNDS; r++) {
      const p = project({ data: true });
      if (stale) fs.writeFileSync(path.join(dataOf(p), 'items.json.lock'), JSON.stringify({ pid: deadPid(), createdAt: '2026-10-29T00:00:00Z', token: 'old' }));
      const b = await burst(p, WRITERS, `${stale ? 's' : 'c'}${r}`);
      lost.push(b.lost);
      assert.deepEqual(b.codes, Array(WRITERS).fill(0), `회 ${r} 종료 코드`);
      assert.deepEqual(b.missing, [], `회 ${r} 빠진 항목(회별 잃은 수 ${lost.join(',')})`);
      assert.deepEqual(b.left, [], `회 ${r} 잠금, 정리 잠금, 임시 파일 정리`);
    }
    assert.deepEqual(lost, Array(ROUNDS).fill(0), '회별 잃은 수');
  });
}

test('살아 있는 pid 의 잠금은 오래되어도 지우지 않고 5초 뒤 종료 1(잠금 경로, pid, createdAt, 수동 삭제 안내)', T, () => {
  const p = project({ data: true });
  const lock = path.join(dataOf(p), 'items.json.lock');
  const body = JSON.stringify({ pid: process.pid, createdAt: '2020-01-01T00:00:00Z', token: 't' });
  fs.writeFileSync(lock, body);
  const before = fs.readFileSync(path.join(dataOf(p), 'items.json'));
  const t0 = Date.now();
  const r = cli(['item', '--key', 'k', '--status', 'done', '--text', 'x'], p);
  assert.ok(Date.now() - t0 >= 4500, '5초 기다림');
  assert.equal(r.code, 1);
  assert.equal(r.err, `오류: 다른 쓰기가 끝나지 않음(잠금 .omc/progress-mon/items.json.lock, pid ${process.pid}, createdAt 2020-01-01T00:00:00Z). 그 프로세스가 끝났는데도 남아 있으면 잠금 파일을 지운 뒤 다시 실행\n`);
  assert.equal(fs.readFileSync(lock, 'utf8'), body);
  assert.deepEqual(fs.readFileSync(path.join(dataOf(p), 'items.json')), before);
});

// 잠금 시험용 폴더와 대역 fs. removed: rmSync 로 지운 경로.
function lockDir() {
  const d = path.join(ROOT, `lock${++n}`);
  fs.mkdirSync(d);
  const removed = [];
  const fsx = { ...fs, rmSync: (f, o) => (removed.push(f), fs.rmSync(f, o)) };
  return { d, lock: path.join(d, 'items.json.lock'), brk: path.join(d, 'items.json.lock.break'), removed, fsx };
}

test('살아 있는 잠금은 동시에 돈 낡은 잠금 검사가 지우지 않음(처음 읽은 잠금과 다르면 그대로)', T, async () => {
  const { d, lock, removed, fsx } = lockDir();
  // B 가 A 의 잠금(죽은 pid, 오래됨)을 읽은 뒤 A 가 풀고 C 가 새로 잡은 상황: 첫 읽기만 A 의 잠금으로 보인다
  const live = JSON.stringify({ pid: process.pid, createdAt: isoSec(Date.now()), token: 'live' });
  fs.writeFileSync(lock, live);
  let fooled = false;
  fsx.readFileSync = (f, enc) => {
    if (f === lock && !fooled) {
      fooled = true;
      return JSON.stringify({ pid: deadPid(), createdAt: '2026-10-29T00:00:00Z', token: 'old' });
    }
    return fs.readFileSync(f, enc);
  };
  await assert.rejects(acquireLock(d, { fsx, waitMs: 300 }), /다른 쓰기가 끝나지 않음/);
  assert.ok(fooled);
  assert.equal(fs.readFileSync(lock, 'utf8'), live, '살아 있는 잠금 그대로');
  assert.ok(!removed.includes(lock), '잠금 파일 지우기 0');
  assert.deepEqual(fs.readdirSync(d), ['items.json.lock'], '정리 잠금 남지 않음');
});

test('낡은 잠금 판정: 죽은 pid 와 오래된 createdAt 이 함께여야 정리. 살아 있는 pid, 방금 만든 잠금은 그대로', T, async () => {
  const dead = deadPid();
  for (const [body, gone] of [
    [{ pid: dead, createdAt: '2026-10-29T00:00:00Z', token: 'old' }, true],
    [{ pid: dead, createdAt: isoSec(Date.now() + 60000), token: 'new' }, false],
    [{ pid: process.pid, createdAt: '2020-01-01T00:00:00Z', token: 'live' }, false],
    [{ pid: dead, token: 'no-time' }, false],
  ]) {
    const { d, lock, fsx } = lockDir();
    fs.writeFileSync(lock, JSON.stringify(body));
    if (gone) {
      const h = await acquireLock(d, { fsx, waitMs: 1000 });
      assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).token, h.mine.token, `${body.token}: 정리 뒤 새 잠금`);
      releaseLock(h, fsx);
      assert.deepEqual(fs.readdirSync(d), [], `${body.token}: 잠금과 정리 잠금 정리`);
    } else {
      await assert.rejects(acquireLock(d, { fsx, waitMs: 200 }), /다른 쓰기가 끝나지 않음/);
      assert.deepEqual(JSON.parse(fs.readFileSync(lock, 'utf8')), body, `${body.token}: 그대로`);
    }
  }
});

test('정리 잠금: 쥔 프로세스가 있으면 낡은 잠금을 지우지 않고 기다림, 3초보다 오래 남은 정리 잠금은 지움', T, async () => {
  const stale = { pid: deadPid(), createdAt: '2026-10-29T00:00:00Z', token: 'old' };
  const a = lockDir();
  fs.writeFileSync(a.lock, JSON.stringify(stale));
  fs.writeFileSync(a.brk, '{}');
  await assert.rejects(acquireLock(a.d, { fsx: a.fsx, waitMs: 300 }), /다른 쓰기가 끝나지 않음/);
  assert.deepEqual(JSON.parse(fs.readFileSync(a.lock, 'utf8')), stale, '다른 정리 중: 낡은 잠금 그대로');
  assert.ok(fs.existsSync(a.brk), '새 정리 잠금 그대로');
  const old = (Date.now() - 60000) / 1000;
  fs.utimesSync(a.brk, old, old);
  const h = await acquireLock(a.d, { fsx: a.fsx, waitMs: 1000 });
  releaseLock(h, a.fsx);
  assert.deepEqual(fs.readdirSync(a.d), [], '오래된 정리 잠금, 낡은 잠금 정리');
});

test('잠금 wx 의 EPERM, EACCES, EBUSY 는 EEXIST 처럼 기다렸다 다시, 다른 오류는 바로 종료 1', T, async () => {
  const { d, lock, fsx } = lockDir();
  const codes = ['EPERM', 'EACCES', 'EBUSY'];
  let calls = 0;
  fsx.writeFileSync = (f, data, o) => {
    if (f === lock && calls < codes.length) throw Object.assign(new Error('busy'), { code: codes[calls++] });
    return fs.writeFileSync(f, data, o);
  };
  const h = await acquireLock(d, { fsx, waitMs: 2000 });
  assert.equal(calls, 3);
  releaseLock(h, fsx);
  const bad = { ...fs, writeFileSync: () => { throw Object.assign(new Error('ro'), { code: 'EROFS' }); } };
  await assert.rejects(acquireLock(d, { fsx: bad, waitMs: 2000 }), /잠금 파일을 만들지 못함\(EROFS\)/);
});

test('오래된 정리 잠금 제거: 다시 읽은 pid, createdAt 이 처음 읽은 것과 다르면(그 사이 새로 생김) 지우지 않음', T, async () => {
  const stale = { pid: deadPid(), createdAt: '2026-10-29T00:00:00Z', token: 'old' };
  const { d, lock, brk, removed, fsx } = lockDir();
  fs.writeFileSync(lock, JSON.stringify(stale));
  const fresh = JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() });
  fs.writeFileSync(brk, JSON.stringify({ pid: 1, createdAt: '2026-10-29T00:00:00.000Z' }));
  const old = (Date.now() - 60000) / 1000;
  fs.utimesSync(brk, old, old);
  let reads = 0;
  fsx.readFileSync = (f, enc) => {
    if (f === brk && ++reads === 2) fs.writeFileSync(brk, fresh); // 두 번째 읽기 직전에 다른 대기자가 정리 잠금을 지우고 새로 만든 상황
    return fs.readFileSync(f, enc);
  };
  await assert.rejects(acquireLock(d, { fsx, waitMs: 120 }), /다른 쓰기가 끝나지 않음/);
  assert.ok(reads >= 2);
  assert.ok(!removed.includes(brk), '정리 잠금 지우기 0');
  assert.ok(fs.existsSync(brk));
  assert.deepEqual(JSON.parse(fs.readFileSync(lock, 'utf8')), stale, '낡은 잠금 그대로');
});

test('잠금 wx 가 EPERM, EACCES 로 끝까지 실패하고 잠금 파일이 없으면 만들지 못함 메시지, 잠금 파일이 보였으면 다른 쓰기 메시지', T, async () => {
  for (const code of ['EPERM', 'EACCES']) {
    const { d, lock, fsx } = lockDir();
    fsx.writeFileSync = (f, data, o) => {
      if (f === lock) throw Object.assign(new Error('denied'), { code });
      return fs.writeFileSync(f, data, o);
    };
    await assert.rejects(acquireLock(d, { fsx, waitMs: 200 }), (e) => e.message === `잠금 파일을 만들지 못함(${code})`);
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, createdAt: isoSec(Date.now()), token: 'live' }));
    await assert.rejects(acquireLock(d, { fsx, waitMs: 200 }), /다른 쓰기가 끝나지 않음/);
  }
});

test('잠금 해제는 자기 pid 와 무작위 값일 때만', T, async () => {
  const d = path.join(ROOT, `lock${++n}`);
  fs.mkdirSync(d);
  const h = await acquireLock(d);
  const lock = path.join(d, 'items.json.lock');
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).pid, process.pid);
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'other' }));
  releaseLock(h);
  assert.ok(fs.existsSync(lock), '남의 잠금은 그대로');
  fs.writeFileSync(lock, JSON.stringify(h.mine));
  releaseLock(h);
  assert.equal(fs.existsSync(lock), false);
});

test('rename EPERM, EBUSY, EACCES 는 50 ms 간격 5회 재시도, 그래도 실패면 원본 그대로', T, async () => {
  const d = path.join(ROOT, `w${++n}`);
  fs.mkdirSync(d);
  const f = path.join(d, 'items.json');
  fs.writeFileSync(f, 'old');
  let calls = 0;
  const flaky = { ...fs };
  flaky.renameSync = (a, b) => {
    calls++;
    if (calls <= 3) throw Object.assign(new Error('busy'), { code: ['EPERM', 'EBUSY', 'EACCES'][calls - 1] });
    return fs.renameSync(a, b);
  };
  await writeAtomic(f, 'new', flaky);
  assert.equal(fs.readFileSync(f, 'utf8'), 'new');
  assert.equal(calls, 4);
  calls = 0;
  const stuck = { ...fs, renameSync: () => {
    calls++;
    throw Object.assign(new Error('busy'), { code: 'EBUSY' });
  } };
  await assert.rejects(writeAtomic(f, 'newer', stuck), /items\.json 쓰기 실패\(EBUSY\)\. 원본 그대로/);
  assert.equal(calls, 6);
  assert.equal(fs.readFileSync(f, 'utf8'), 'new');
  assert.deepEqual(fs.readdirSync(d), ['items.json'], '임시 파일 정리');
  // 다른 오류는 바로 실패
  await assert.rejects(writeAtomic(f, 'x', { ...fs, renameSync: () => { throw Object.assign(new Error('no'), { code: 'ENOSPC' }); } }), /ENOSPC/);
});

test('updateItems: 깨진 items.json 은 고치지 않고 거부, 모르는 키는 보존', T, async () => {
  const d = path.join(ROOT, `u${++n}`);
  fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, 'items.json'), '{broken');
  await assert.rejects(updateItems(d, () => 'x'), /JSON 이 아님/);
  assert.equal(fs.readFileSync(path.join(d, 'items.json'), 'utf8'), '{broken');
  assert.equal(fs.existsSync(path.join(d, 'items.json.lock')), false, '잠금 해제');
  fs.writeFileSync(path.join(d, 'items.json'), JSON.stringify({ extra: 1, items: [] }));
  await updateItems(d, (v) => v.items.push({ key: 'a' }));
  const v = JSON.parse(fs.readFileSync(path.join(d, 'items.json'), 'utf8'));
  assert.equal(v.extra, 1);
  assert.deepEqual(v.stageEvents, []);
  assert.equal(isoSec(Date.parse('2026-01-02T03:04:05.999Z')), '2026-01-02T03:04:05Z');
});

test('--key, --id 에 __proto__ 는 거부(쓰기 성공 출력 뒤 JSON 에 남지 않던 것)', T, () => {
  assert.throws(() => itemChange({ key: '__proto__', status: 'done', text: 'x' }, Date.now()), /__proto__ 는 쓰지 않음/);
  const p = project({ data: true });
  const before = fs.readFileSync(path.join(dataOf(p), 'items.json'), 'utf8');
  for (const args of [['note', '--key', '__proto__', '--note', 'x'], ['story', '--id', '__proto__', '--status', 'done'], ['stage', '--id', '__proto__', '--status', 'done']]) {
    const r = cli(args, p);
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.err, /__proto__ 는 쓰지 않음/);
  }
  assert.equal(fs.readFileSync(path.join(dataOf(p), 'items.json'), 'utf8'), before);
});

test('init: 링크 경로로 준 --project 도 git 제외 목록에 넣음(macOS /var, Windows junction)', T, () => {
  const p = project({ git: true });
  const via = path.join(ROOT, `via${++n}`);
  fs.symlinkSync(p, via, process.platform === 'win32' ? 'junction' : 'dir');
  const r = cli(['init', '--memory', 'none', '--project', via], via);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^git 제외 목록 추가: \/\.omc\/progress-mon\/ /m);
  assert.match(fs.readFileSync(path.join(p, '.git', 'info', 'exclude'), 'utf8'), /^\/\.omc\/progress-mon\/$/m);
});
