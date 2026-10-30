// pm-check.mjs 시험. 임시 자료 폴더에 고정 자료(assets/fixture)와 그 변형을 두고 runCheck 를 부른다.
// HOME 계열과 CODEX_HOME 은 임시 폴더(env 인자). CLI 사례는 자식 프로세스.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runCheck, density, densityLine } from './pm-check.mjs';

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
  });
})();
process.env.GIT_CEILING_DIRECTORIES = ROOT;
const read = (f) => JSON.parse(fs.readFileSync(path.join(FIXTURE, f), 'utf8'));
const FILES = ['config.json', 'items.json', 'req-spec.json', 'reqs.json', 'flow.json', 'arch.json'];

let n = 0;
// 고정 자료를 복사한 자료 폴더. over: {파일: 값 | null(지움)}. 돌려줌: ctx
function data(over = {}) {
  const project = path.join(ROOT, `p${++n}`);
  const dataDir = path.join(project, '.omc', 'progress-mon');
  fs.mkdirSync(dataDir, { recursive: true });
  for (const f of FILES) fs.copyFileSync(path.join(FIXTURE, f), path.join(dataDir, f));
  for (const [f, v] of Object.entries(over)) {
    if (v === null) fs.rmSync(path.join(dataDir, f), { force: true });
    else fs.writeFileSync(path.join(dataDir, f), typeof v === 'string' ? v : JSON.stringify(v));
  }
  return { project, runtime: 'claude', dataDir, exists: true };
}
const check = (ctx) => runCheck(ctx, ENV).lines;
const only = (lines, re) => lines.filter((l) => re.test(l));
const problems = (lines) => lines.filter((l) => /^(FAIL|WARN) /.test(l));

test('고정 자료: FAIL 0, WARN 0, init 기록과 inventory 가 없으면 밀도 줄 없음', T, () => {
  const lines = check(data());
  assert.deepEqual(lines, ['check: FAIL 0, WARN 0']);
});

test('변형 check-overlap, check-auto: 기대 출력과 같은 줄', T, () => {
  const ov = check(data({ 'arch.json': read('variants/check-overlap/arch.json') }));
  assert.deepEqual(ov, ['FAIL arch.json nodes[1] 상자 겹침: n2, n1', 'check: FAIL 1, WARN 0']);
  // 같은 행의 가운데 상자를 건너뛰는 연결: 자동 배치는 그 상자를 돌아가므로 WARN 없음
  const au = check(data({ 'arch.json': read('variants/check-auto/arch.json') }));
  assert.deepEqual(au, ['check: FAIL 0, WARN 0']);
});

test('형식: JSON 아님, 필수 키, status 값, 색, 수, 정규식 컴파일', T, () => {
  const cfg = { ...read('config.json'), commitRegex: '(', agentLabelPattern: '(S\\d+)' };
  const it = { notes: { A1: 'x' }, items: [{ status: 'wip', text: 'x' }, { status: 'done', text: 'y', hash: 'xyz1234' }, { status: 'done', text: 'z', hash: 'ABCdef0' }], storyCommits: { A1: 5, B1: 'nothex!', B2: { hash: 'abcd' } }, storyStates: { A2: { status: 'later' } }, stageEvents: [{ stage: 'plan', status: 'begun' }] };
  const lines = check(data({ 'config.json': cfg, 'items.json': it, 'flow.json': '{bad' }));
  assert.ok(lines.includes('FAIL flow.json $ JSON 아님: ' + (() => {
    try {
      JSON.parse('{bad');
    } catch (e) {
      return e.message;
    }
  })()));
  assert.equal(only(lines, /^FAIL config\.json commitRegex /).length, 1);
  assert.equal(only(lines, /^FAIL config\.json agentLabelPattern .*그룹/).length, 1);
  for (const p of ['notes.A1', 'items[0].status', 'storyCommits.A1', 'storyStates.A2', 'stageEvents[0]']) assert.equal(only(lines, new RegExp(`^FAIL items\\.json ${p.replace(/[.[\]]/g, '\\$&')} `)).length, 1, p);
  // items[].hash 는 4~40자 16진(대소문자 무관)
  assert.ok(lines.includes('FAIL items.json items[1].hash 4~40자 16진 해시가 아님: xyz1234'));
  assert.equal(only(lines, /items\[2\]/).length, 0);
  // storyCommits 도 16진 4~40자(문자열과 {hash} 둘 다). B1 은 16진 아님, B2 는 유효
  assert.ok(lines.includes('FAIL items.json storyCommits.B1 4~40자 16진 해시가 아님: nothex!'));
  assert.equal(only(lines, /storyCommits\.B2/).length, 0);
  const arch = read('arch.json');
  arch.zones[0].color = 'red';
  arch.scenes[0].sec = 'x';
  arch.edges[0].kind = 'pipe';
  const l2 = check(data({ 'arch.json': arch }));
  assert.ok(l2.includes('FAIL arch.json zones[0].color #rrggbb 가 아님: red'));
  assert.ok(l2.includes('FAIL arch.json scenes[0].sec 0 이상 수가 아님'));
  assert.ok(l2.includes('FAIL arch.json edges[0].kind api, control, data 가운데 하나가 아님: pipe'));
});

test('reqs.json 의 모르는 키는 허용, 상호 참조(AC, 스토리, 분기, 외부, 장면, 연결 끝, 영역) 는 FAIL', T, () => {
  assert.ok(read('reqs.json').generated, '고정 자료에 모르는 키 있음');
  const spec = read('req-spec.json');
  spec.users[0].specs[0].acs = ['AC-99'];
  spec.users[0].specs[1].state = 'maybe';
  const reqs = read('reqs.json');
  reqs.acs[0].stories = ['Z9'];
  const flow = read('flow.json');
  flow.lanes[0].branches[0].from = 'nope';
  flow.lanes[0].branches[1].to = 'gone';
  flow.lanes[0].externals[0].linkTo = 'p99';
  flow.scenes[0].focus = ['e1'];
  flow.scenes[2].lane = 'x';
  const arch = read('arch.json');
  arch.edges[0].to = 'mars';
  arch.nodes[0].zone = 'void';
  arch.scenes[0].focus.push('ghost');
  arch.main.push('ghost');
  const lines = check(data({ 'req-spec.json': spec, 'reqs.json': reqs, 'flow.json': flow, 'arch.json': arch }));
  const want = [
    'FAIL reqs.json acs[0].stories 스토리 없음: Z9',
    'FAIL req-spec.json users[0].specs[0].acs AC 없음: AC-99',
    'FAIL req-spec.json users[0].specs[1].state done, part, doing, todo, unv, excl, none 가운데 하나가 아님: maybe',
    'FAIL flow.json lanes[0].branches[0].from 단계 없음: nope',
    'FAIL flow.json lanes[0].branches[1].to 단계 없음: gone',
    'FAIL flow.json lanes[0].externals[0].linkTo 단계 없음: p99',
    'FAIL flow.json scenes[0].focus 단계 없음: e1',
    'FAIL flow.json scenes[2].lane 흐름 없음: x',
    'FAIL arch.json nodes[0].zone 영역 없음: void',
    'FAIL arch.json edges[0].to 연결 끝 없음: e-req, mars',
    'FAIL arch.json scenes[0].focus 장면 대상 없음: ghost',
    'FAIL arch.json main[3] 구성요소 없음: ghost',
  ];
  for (const w of want) assert.ok(lines.includes(w), w);
  // 분기 to 가 빈 문자열(흐름 끝)과 영역을 끝으로 쓰는 연결(e-write)은 정상
  assert.equal(only(lines, /branches\[0\]\.to|e-write/).length, 0);
});

test('구성도 좌표 기하 5종은 FAIL: 겹침, 영역 밖, 글 넘침, 선이 상자 지남, 이름표 덮음. 변 접촉은 겹침 아님', T, () => {
  const base = () => ({
    width: 900,
    height: 300,
    zones: [{ id: 'z', label: '영역', x: 10, y: 10, w: 880, h: 280 }],
    nodes: [
      { id: 'a', zone: 'z', label: '가', x: 40, y: 40, w: 160, h: 64 },
      { id: 'b', zone: 'z', label: '나', x: 200, y: 40, w: 160, h: 64 },
      { id: 'c', zone: 'z', label: '다', x: 600, y: 40, w: 160, h: 64 },
    ],
    edges: [],
    scenes: [],
  });
  assert.deepEqual(problems(check(data({ 'arch.json': base() }))), [], '변 접촉(a 오른쪽 = b 왼쪽)은 겹침 아님');
  const f = base();
  f.nodes[1].x = 199;
  f.nodes[2].y = 250;
  f.nodes[0].label = '아주 아주 긴 상자 이름이 넘침';
  f.nodes[0].detail = '설명 한 줄 설명 두 줄 설명 세 줄 설명 네 줄 설명 다섯 줄 설명 여섯 줄';
  f.edges = [{ id: 'e1', from: 'a', to: 'c', kind: 'control', label: '' }, { id: 'e2', from: 'b', to: 'c', kind: 'data', label: '이름표', lx: 680, ly: 270 }];
  const lines = check(data({ 'arch.json': f }));
  for (const w of ['FAIL arch.json nodes[1] 상자 겹침: b, a', 'FAIL arch.json nodes[2] 영역 밖: c, z', 'FAIL arch.json nodes[0] 글 넘침: a 이름', 'FAIL arch.json edges[0] 선이 상자 지남: e1, b', 'FAIL arch.json edges[1] 이름표 덮음: e2, c']) assert.ok(lines.includes(w), w);
  assert.ok(lines.includes('WARN arch.json nodes[0] 설명 잘림: a (4줄 > 2줄). lines 를 늘리거나 설명을 줄임'));
});

test('구성도 자동 배치: 겹침, 영역 밖, 글 넘침 FAIL 없음, 이름표는 WARN, 영역 끝 연결, 좌표 일부 누락 WARN', T, () => {
  const strip = (f) => {
    delete f.width;
    delete f.height;
    for (const x of [...f.zones, ...f.nodes]) for (const k of ['x', 'y', 'w', 'h']) delete x[k];
    for (const e of f.edges) for (const k of ['via', 'lx', 'ly', 'off', 'offTo']) delete e[k];
    return f;
  };
  // 고정 자료 구성도(영역 끝 연결 e-write 포함)의 좌표를 모두 뺌: FAIL 0, 좌표 누락 WARN 없음
  const auto = check(data({ 'arch.json': strip(read('arch.json')) }));
  assert.equal(only(auto, /^FAIL /).length, 0, auto.join('\n'));
  assert.equal(only(auto, /좌표/).length, 0);
  // 이웃 두 상자 사이 틈보다 긴 이름표: 선이 이름표가 들어가는 통로로 돌아가 덮음 없음.
  // 그림보다 넓은 이름표는 놓을 곳이 없어 그림 밖(WARN)
  const f = strip(read('variants/check-auto/arch.json'));
  f.nodes = f.nodes.slice(0, 2);
  f.edges[0] = { ...f.edges[0], to: 'n2', label: '아주 긴 연결 이름표가 두 상자 사이 틈보다 훨씬 길어서 덮어 버림' };
  assert.deepEqual(check(data({ 'arch.json': f })), ['check: FAIL 0, WARN 0']);
  f.edges[0].label = f.edges[0].label.repeat(3);
  const lines = check(data({ 'arch.json': f }));
  assert.equal(only(lines, /^FAIL /).length, 0);
  assert.deepEqual(only(lines, /^WARN arch\.json edges\[0\] /), ['WARN arch.json edges[0] 이름표가 그림 밖: e1'], lines.join('\n'));
  const part = read('arch.json');
  delete part.nodes[2].w;
  const pl = check(data({ 'arch.json': part }));
  assert.ok(pl.includes('WARN arch.json nodes[2].w 좌표 일부가 빠지거나 틀려 그림 전체를 자동 배치'), pl.join('\n'));
  assert.equal(only(pl, /^FAIL /).length, 0);
  // 크기 지침(상자 60 넘음)
  const big = { zones: [{ id: 'z', label: '영역' }], nodes: Array.from({ length: 61 }, (_, i) => ({ id: `n${i}`, zone: 'z', label: `상자${i}` })), edges: [], scenes: [] };
  assert.ok(check(data({ 'arch.json': big })).includes('WARN arch.json nodes 크기 지침 초과: 상자 61 > 60'));
});

test('구성도 자기 연결(from 과 to 가 같음)은 상자든 영역이든, 자동 배치든 좌표 사용이든 WARN. 다른 연결은 알리지 않음', T, () => {
  const f = {
    zones: [{ id: 'z', label: '영역' }],
    nodes: ['a', 'b', 'c'].map((id) => ({ id, zone: 'z', label: id, detail: '설명' })),
    edges: [{ id: 'aa', from: 'a', to: 'a', label: '스스로' }, { id: 'zz', from: 'z', to: 'z' }, { id: 'ab', from: 'a', to: 'b', label: '옆' }],
  };
  const lines = check(data({ 'arch.json': f }));
  assert.equal(only(lines, /^FAIL /).length, 0, lines.join('\n'));
  assert.deepEqual(only(lines, /자기 연결/), [
    'WARN arch.json edges[0] 자기 연결(from 과 to 가 같음): aa',
    'WARN arch.json edges[1] 자기 연결(from 과 to 가 같음): zz',
  ], lines.join('\n'));
  assert.equal(only(lines, /edges\[2\]/).length, 0);
  // 자기 연결만 있는 그림: 선이 상자를 지나지 않음(길이 0 인 선)
  const one = { zones: [{ id: 'z', label: '영역' }], nodes: [{ id: 'a', zone: 'z', label: 'a', detail: '설명' }], edges: [{ id: 'zz', from: 'z', to: 'z' }] };
  assert.deepEqual(check(data({ 'arch.json': one })), ['WARN arch.json edges[0] 자기 연결(from 과 to 가 같음): zz', 'check: FAIL 0, WARN 1']);
  // 좌표 사용 자료도 자기 연결은 WARN
  const fixed = read('arch.json');
  fixed.edges.push({ id: 'self', from: fixed.nodes[0].id, to: fixed.nodes[0].id, label: '스스로' });
  assert.ok(check(data({ 'arch.json': fixed })).includes(`WARN arch.json edges[${fixed.edges.length - 1}] 자기 연결(from 과 to 가 같음): self`));
});

test('workflow 기하: workflow-wide 는 FAIL 0, 가로 실제 겹침 FAIL, 194 px WARN 은 오른쪽 이웃 칸이 있을 때만, 외부 표 합계 WARN, 이름 넘침 WARN', T, () => {
  const wide = check(data({ 'flow.json': read('variants/workflow-wide/flow.json') }));
  assert.equal(only(wide, /^FAIL /).length, 0, wide.join('\n'));
  const step = (id, label = id) => ({ id, label, detail: '설명', actor: 'cli', refs: [] });
  const long = '가'.repeat(20);
  const lane = {
    id: 'l',
    title: '흐름',
    steps: ['s1', 's2', 's3', 's4', 's5'].map((s) => step(s)),
    branches: [
      { from: 's1', to: '', when: long },
      { from: 's2', to: '', when: '짧음' },
      { from: 's5', to: '', when: long },
    ],
    externals: [
      { id: 'x1', label: '가'.repeat(10), linkTo: 's3' },
      { id: 'x2', label: '나'.repeat(10), linkTo: 's3' },
      { id: 'x3', label: '외부', linkTo: 's4' },
    ],
  };
  lane.steps[0].label = 'Averyveryverylongsinglewordlabelthatcannotwrap';
  const lines = check(data({ 'flow.json': { lanes: [lane], scenes: [] } }));
  const w = Math.round(textWidth(long) + 16);
  for (const want of [
    'FAIL flow.json lanes[0].branches[0] 분기 표가 이웃 칸 분기와 겹침: s1, s2',
    `WARN flow.json lanes[0].branches[0] 분기 표 폭 ${w} px 가 194 px 를 넘어 오른쪽 칸으로 들어감: s1`,
    'FAIL flow.json lanes[0].externals[2] 외부 표가 이웃 칸 외부 표와 겹침: x3, x2',
    'WARN flow.json lanes[0].externals[0] 외부 표 합계 폭 248 px 가 상자 폭 176 px 를 넘음: s3',
    'WARN flow.json lanes[0].steps[0].label 단계 이름 넘침(두 줄로도 넘침): s1',
  ]) assert.ok(lines.includes(want), `${want}\n${lines.join('\n')}`);
  assert.equal(only(lines, /branches\[2\]/).length, 0, '줄 끝 칸(s5)은 194 px 검사 안 함');
  // 긴 이름 줄바꿈은 설명을 내려 이름 둘째 줄과 겹치지 않음
  const named = { lanes: [{ id: 'm', title: 't', steps: [{ ...step('a'), label: '아주 긴 단계 이름 둘째 줄', detail: '설명 첫 줄 설명 둘째 줄 설명 셋째 줄 설명 넷째 줄' }], branches: [], externals: [] }], scenes: [] };
  assert.equal(only(check(data({ 'flow.json': named })), /겹침/).length, 0);
  // 크기 지침
  const many = { lanes: Array.from({ length: 7 }, (_, i) => ({ id: `l${i}`, title: 't', steps: [step('a')] })), scenes: [] };
  many.lanes[0].steps = Array.from({ length: 16 }, (_, i) => step(`s${i}`));
  const ml = check(data({ 'flow.json': many }));
  assert.ok(ml.includes('WARN flow.json lanes 크기 지침 초과: 흐름 7 > 6'));
  assert.ok(ml.includes('WARN flow.json lanes[0].steps 크기 지침 초과: 단계 16 > 15'));
});

// 글 폭 추정(pm-html textW 와 같은 규칙): 한글 10.5, 그 밖 6.
const textWidth = (t) => [...t].reduce((a, ch) => a + (ch.charCodeAt(0) > 0x2e7f ? 10.5 : 6), 0);

test('설정: - 든 스토리 id WARN, workflowDirs auto 0개 WARN', T, () => {
  const cfg = read('config.json');
  cfg.stories.push({ id: 'B-1', name: '하이픈' });
  cfg.sources.workflowDirs = 'auto';
  const lines = check(data({ 'config.json': cfg }));
  assert.ok(lines.includes('WARN config.json stories[5].id id 에 - 가 있어 에이전트 라벨 토큰 판정이 안 됨: B-1. agentLabelPattern 을 쓰거나 id 를 바꿈'));
  assert.ok(lines.includes('WARN workflowDirs auto: 찾은 폴더 0'));
});

// 밀도 시험용: init 기록(state.json memory)을 남긴 자료 폴더.
function initd(over = {}) {
  const ctx = data(over);
  fs.writeFileSync(path.join(ctx.dataDir, 'state.json'), JSON.stringify({ memory: { kind: 'none', path: null } }));
  return ctx;
}

test('밀도: init 기록이 있으면 4.9절 하한 미달을 WARN(종료 코드 영향 없음), 요약 4줄', T, () => {
  const ctx = initd();
  const { lines, fails } = runCheck(ctx, ENV);
  assert.equal(fails, 0);
  for (const w of ['WARN density arch 영역 3/5', 'WARN density arch 상자 6/20', 'WARN density arch 연결 7/15', 'WARN density arch 장면 2/5', 'WARN density workflow 단계:export 3/7', 'WARN density workflow 흐름설명 0/2: main(1문장), export(0문장)', 'WARN density history 비고 1/3: doc-guide, bench']) assert.ok(lines.includes(w), `${w}\n${lines.join('\n')}`);
  // 항목마다 재는 줄은 못 채운 대상(상자 id, 흐름/단계 id, 연결 id, 명세 json 경로)을 붙인다
  for (const w of [
    'WARN density arch 연결근거 0/7: e-req, e-render, e-read, e-log, e-ctl, e-write, e-res',
    'WARN density workflow 단계근거 9/10: export/e3',
    'WARN density workflow 실패분기 1/2: export',
    'WARN density req 명세AC 6/7: users[1].specs[2]',
  ]) assert.ok(lines.includes(w), `${w}\n${lines.join('\n')}`);
  assert.ok(lines.some((l) => l.startsWith('WARN density workflow 단계설명 1/10: main/p1(1줄), ')), lines.join('\n'));
  assert.equal(only(lines, /^WARN density (workflow 단계:main|req 비고) /).length, 0, '하한을 채운 항목은 WARN 없음');
  assert.deepEqual(lines.slice(-4), ['density history low', 'density req low', 'density workflow low', 'density arch low']);
  assert.match(lines[lines.length - 5], /^check: FAIL 0, WARN \d+$/);
});

test('밀도: inventory.json 으로 하한을 낮춤, 없는 경로는 FAIL, inventory 만 있어도 밀도 검사', T, () => {
  const ctx = data();
  fs.writeFileSync(path.join(ctx.project, 'main.mjs'), '');
  fs.mkdirSync(path.join(ctx.project, 'lib'));
  fs.writeFileSync(path.join(ctx.project, 'lib', 'a.mjs'), '');
  const inv = {
    components: [{ name: '진입점', path: 'main.mjs' }, { name: '모듈', path: 'lib/a.mjs' }, { name: '폴더', path: 'lib' }],
    flows: [{ name: '실행', steps: 7, evidence: 'main.mjs:1' }, { name: '내보내기', steps: 3, evidence: 'lib/a.mjs' }],
    externals: [{ name: 'git', evidence: 'main.mjs' }],
    read: ['main.mjs'],
  };
  fs.writeFileSync(path.join(ctx.dataDir, 'inventory.json'), JSON.stringify(inv));
  const lines = check(ctx);
  assert.equal(only(lines, /^FAIL /).length, 0, lines.join('\n'));
  // 영역 3/min(5,3), 상자 6/min(20,3), 연결 7/min(15,5), 흐름 2/min(2,2), 단계 7/7 과 3/3 은 통과
  assert.equal(only(lines, /^WARN density arch (영역|상자|연결) /).length, 0, lines.join('\n'));
  assert.equal(only(lines, /^WARN density workflow (흐름 |단계:)/).length, 0, lines.join('\n'));
  assert.ok(lines.includes('WARN density arch 장면 2/5'), '장면 하한은 낮추지 않음');
  inv.components[0].path = 'missing.mjs';
  inv.flows[1].evidence = 'gone/x.mjs:3';
  fs.writeFileSync(path.join(ctx.dataDir, 'inventory.json'), JSON.stringify(inv));
  const l2 = check(ctx);
  assert.ok(l2.includes('FAIL inventory.json components[0].path 경로 없음: missing.mjs'));
  assert.ok(l2.includes('FAIL inventory.json flows[1].evidence 경로 없음: gone/x.mjs:3'));
});

test('밀도: 하한을 채우면 4탭 ok, 함수 직접', T, () => {
  const zones = Array.from({ length: 5 }, (_, i) => ({ id: `z${i}` }));
  const det = '두 줄이 되도록 충분히 긴 설명 문장을 여기에 적어 둠';
  const nodes = Array.from({ length: 20 }, (_, i) => ({ id: `n${i}`, zone: 'z0', detail: det }));
  const edges = Array.from({ length: 15 }, (_, i) => ({ from: 'n0', to: `n${i + 1}`, refs: ['a.mjs:1'] }));
  const L = { node: new Map(nodes.map((x) => [x.id, { w: 160 }])) };
  const arch = { f: { zones, nodes, edges, legend: ['범례'], main: ['n0'], scenes: [1, 2, 3, 4, 5] }, L };
  const steps = Array.from({ length: 7 }, (_, i) => ({ id: `s${i}`, detail: det, actor: 'cli', refs: ['a.mjs:2'] }));
  const lane = { id: 'l', steps, branches: [{}], externals: [{}], note: '명령. 실패 처리. 근거.' };
  const flow = { lanes: [lane, { ...lane, id: 'm' }] };
  const req = { users: [{ text: 't', source: 's' }], specs: [{ acs: ['AC-1'], state: 'done', note: '근거' }], acStories: new Map([['AC-1', ['A1']]]) };
  const d = density({ arch, flow, req, items: [{ note: 'n' }], inv: null, storyCount: 1 });
  assert.deepEqual(d.rows.filter((x) => x.value < x.min), []);
  assert.equal(d.low.size, 0);
});

test('밀도: 미달 대상은 앞 10개와 외 n, 상자설명은 줄 수, 수만 재는 줄은 이름 없음', T, () => {
  const nodes = Array.from({ length: 13 }, (_, i) => ({ id: `n${i}`, zone: 'z0', detail: i ? '짧음' : '두 줄이 되도록 충분히 긴 설명 문장을 여기에 적어 둠' }));
  const L = { node: new Map(nodes.map((x) => [x.id, { w: 160 }])) };
  const arch = { f: { zones: [{ id: 'z0' }], nodes, edges: [] }, L };
  const req = { users: [], specs: [], acStories: new Map() };
  const d = density({ arch, flow: null, req, items: [], inv: null, storyCount: 0 });
  const row = (item) => d.rows.find((x) => x.tab === 'arch' && x.item === item);
  assert.equal(densityLine(row('상자설명')), 'WARN density arch 상자설명 1/13: n1(1줄), n2(1줄), n3(1줄), n4(1줄), n5(1줄), n6(1줄), n7(1줄), n8(1줄), n9(1줄), n10(1줄) 외 2');
  assert.equal(densityLine(row('상자')), 'WARN density arch 상자 13/20');
  assert.equal(densityLine(d.rows.find((x) => x.tab === 'req' && x.item === '요구')), 'WARN density req 요구 0/1');
});

const GIT = spawnSync(process.platform === 'win32' ? 'where' : 'sh', process.platform === 'win32' ? ['git'] : ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.split(/\r?\n/)[0].trim();

test('commitRegex: sources.git 이 꺼졌거나 git 저장소가 아니면 돌려보지 못해 WARN', T, () => {
  const off = data({ 'config.json': { ...read('config.json'), commitRegex: '^(?<id>S\\d+):', sources: { ...read('config.json').sources, git: false } } });
  assert.equal(only(check(off), /^WARN config\.json commitRegex sources\.git 이 꺼져/).length, 1);
  const nogit = data({ 'config.json': { ...read('config.json'), commitRegex: '^(?<id>S\\d+):' } });
  assert.equal(only(check(nogit), /^WARN config\.json commitRegex git 저장소가 아니거나/).length, 1);
});

test('commitRegex: 실제 커밋 제목에서 역추적이 폭발하면 FAIL(화면은 500 인데 check 는 통과하던 것)', { ...T, skip: GIT ? false : 'no git' }, () => {
  const ctx = data({ 'config.json': { ...read('config.json'), commitRegex: '^(?<id>(a+)+)$' } });
  const gitEnv = { ...ENV, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const g = (...a) => assert.equal(spawnSync('git', a, { cwd: ctx.project, env: gitEnv, encoding: 'utf8' }).status, 0, a.join(' '));
  g('init', '-q');
  fs.writeFileSync(path.join(ctx.project, 'f.txt'), 'x');
  g('add', 'f.txt');
  g('commit', '-q', '-m', `${'a'.repeat(40)}!`); // (a+)+$ 가 폭발하는 제목
  const fails = only(check(ctx), /^FAIL config\.json commitRegex .*끝나지 않음/);
  assert.equal(fails.length, 1, '실제 제목에서 시간 초과를 FAIL 로');
});

test('CLI: FAIL 이 있으면 종료 1, 자료 폴더가 없어도 만들지 않음', T, () => {
  const ctx = data({ 'arch.json': read('variants/check-overlap/arch.json') });
  const r = spawnSync(process.execPath, [CLI, 'check'], { cwd: ctx.project, env: ENV, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, 'FAIL arch.json nodes[1] 상자 겹침: n2, n1\ncheck: FAIL 1, WARN 0\n');
  const empty = path.join(ROOT, `e${++n}`);
  fs.mkdirSync(empty);
  const e = spawnSync(process.execPath, [CLI, 'check'], { cwd: empty, env: ENV, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(e.status, 0);
  assert.equal(fs.existsSync(path.join(empty, '.omc')), false);
});
