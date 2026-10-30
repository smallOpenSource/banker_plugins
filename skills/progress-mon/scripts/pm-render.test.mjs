// pm-render.mjs 시험. 4탭 고정 입력 사실, 구현요건 판정 4행, workflow 간격 확장과 이름 줄바꿈, 구성도 좌표와 자동 배치,
// 자료 없음 안내, 위험 문자열, 스토리 0, events 없음, 시각은 now 인자만, export 명령, 저장소 고유 문자열 0.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pageFrom, snapshotFrom, renderTab, command, flowLayout, labelLines, archLayout, archEdges, archFlaws, autoRoutes, missingCoord, tabKey, groupKind, FLOW } from './pm-render.mjs';
import { textW } from './pm-html.mjs';
import { collect } from './pm-sources.mjs';
import { validate, UsageError } from './pm-config.mjs';

const T = { timeout: 60000 };
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, '..', 'assets', 'fixture');
const ROOT = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'progress-mon-test-')));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const NOW = Date.parse('2026-10-29T03:00:00Z');
const readFix = (...p) => JSON.parse(fs.readFileSync(path.join(FIX, ...p), 'utf8'));
const count = (s, re) => (s.match(re) || []).length;
const two = (n) => String(n).padStart(2, '0');
// 렌더와 같은 현지 시각 표기(시험이 도는 시간대를 따름)
const local = (ms) => {
  const d = new Date(ms);
  return `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
};

// 구성도 선분 [{ id, h, c, lo, hi }] (h: 가로, c: 줄 좌표, lo hi: 구간)
const segsOf = (es) => es.flatMap((e) => e.pts.slice(1).map((q, k) => {
  const p = e.pts[k];
  const h = p[1] === q[1];
  return { id: e.id, h, c: h ? p[1] : p[0], lo: Math.min(h ? p[0] : p[1], h ? q[0] : q[1]), hi: Math.max(h ? p[0] : p[1], h ? q[0] : q[1]) };
}));
// 다른 연결의 같은 방향 선분이 구간이 겹치면서 6 px 보다 가까운 쌍
const closeLines = (es) => {
  const s = segsOf(es);
  const out = [];
  for (let i = 0; i < s.length; i++) for (let j = i + 1; j < s.length; j++) {
    const [a, b] = [s[i], s[j]];
    if (a.id !== b.id && a.h === b.h && Math.abs(a.c - b.c) < 6 && Math.min(a.hi, b.hi) - Math.max(a.lo, b.lo) > 0) out.push(`${a.id}~${b.id}`);
  }
  return out;
};

// 자동 배치 선의 자리 문제: 영역 제목 띠(렌더의 영역 이름 자리)를 지나는 선분, 나란한 영역 테두리에서 6 px 보다 가까운 선분,
// 그림 가장자리에서 6 px 보다 가까운 선분. 돌려줌 ['종류 연결 id 영역 id'].
const edgeRoom = (f, L, es) => {
  const out = [];
  for (const s of segsOf(es)) {
    if (s.hi <= s.lo) continue;
    const seg = s.h ? { x: s.lo, y: s.c, w: s.hi - s.lo, h: 0 } : { x: s.c, y: s.lo, w: 0, h: s.hi - s.lo };
    for (const z of f.zones) {
      const r = L.zone.get(z.id);
      const t = { x: r.x + 12, y: r.y + 5, w: textW(z.label) * 1.3, h: 18 };
      if (seg.x + seg.w > t.x && seg.x < t.x + t.w && seg.y + seg.h > t.y && seg.y < t.y + t.h) out.push(`제목 ${s.id} ${z.id}`);
      const [b0, b1, lines] = s.h ? [r.x, r.x + r.w, [r.y, r.y + r.h]] : [r.y, r.y + r.h, [r.x, r.x + r.w]];
      if (Math.min(s.hi, b1) - Math.max(s.lo, b0) > 0 && lines.some((v) => Math.abs(s.c - v) < 6)) out.push(`테두리 ${s.id} ${z.id}`);
    }
    if (s.c < 6 || s.c > (s.h ? L.height : L.width) - 6) out.push(`가장자리 ${s.id}`);
  }
  return out;
};

let n = 0;
// 임시 프로젝트와 자료 폴더. files: { 이름: 내용(객체면 JSON) }
function project(files = {}) {
  const proj = path.join(ROOT, `p${++n}`, 'app');
  const dataDir = path.join(proj, '.omc', 'progress-mon');
  fs.mkdirSync(dataDir, { recursive: true });
  for (const [f, v] of Object.entries(files)) fs.writeFileSync(path.join(dataDir, f), typeof v === 'string' ? v : JSON.stringify(v));
  return { project: proj, runtime: 'claude', dataDir, exists: true };
}
const cfgOf = (raw = {}, proj = '/x/app') => {
  const { config, errors } = validate({ ...raw, sources: { workflowDirs: [], git: false, ...(raw.sources || {}) } }, proj);
  assert.deepEqual(errors, []);
  return config;
};

// 고정 입력 모델. 출처 읽기 없이 렌더만 본다.
function model(over = {}) {
  return {
    head: 'abc1234 마지막 커밋',
    commits: {},
    stages: [],
    stageState: {},
    stories: [],
    ids: [],
    storyStates: {},
    notes: {},
    items: [],
    agents: [],
    starts: {},
    reqSpec: { missing: true },
    reqs: { missing: true },
    flow: { missing: true },
    arch: { missing: true },
    ...over,
  };
}
const rowsOf = (html, k) => count(html, new RegExp(`<tr class="${k}">`, 'g'));

test('탭 key: flow 는 workflow, 모르는 값은 진척도', T, () => {
  assert.equal(tabKey('flow'), 'workflow');
  assert.equal(tabKey('arch'), 'arch');
  assert.equal(tabKey(null), 'history');
  assert.equal(tabKey('x'), 'history');
});

test('진척도: 단계, 스토리(커밋, storyStates, 진행 중 에이전트), 숨김, 기타 항목, 진척률, 비고와 문제점', T, () => {
  const cfg = cfgOf({ title: '예시 진척도', shortName: 'ex', stories: [{ id: 'A1', name: '화면' }, { id: 'A2', name: '설정' }, { id: 'A3', name: '검사' }, { id: 'A4', name: '내보내기' }, { id: 'A5', name: '알림' }] });
  const ms = (s) => Date.parse(s);
  const m = model({
    stages: [{ id: 'plan', label: '3 합의 계획' }, { id: 'mock', label: '4 목업 승인' }, { id: 'build', label: '5 구현' }],
    stageState: { plan: { s: 'done', t: ms('2026-10-28T02:00:00Z'), start: ms('2026-10-28T01:00:00Z') }, mock: { s: 'stopped', t: ms('2026-10-29T01:00:00Z'), start: ms('2026-10-29T00:00:00Z') } },
    stories: cfg.stories,
    ids: ['A1', 'A2', 'A3', 'A4', 'A5'],
    commits: { A1: { h: 'a186510', t: ms('2026-10-27T02:00:00Z') } },
    storyStates: { A2: { status: 'done', t: '2026-10-28T05:00:00Z' }, A4: { status: 'doing', t: '2026-10-29T02:00:00Z' } },
    agents: [{ label: 'impl-A3-r1', since: ms('2026-10-29T02:59:00Z') }, { label: 'check-docs', since: ms('2026-10-29T02:50:00Z') }],
    notes: { 'stage:plan': { note: '검토 2회차' }, A3: { note: '정리 중', issue: '자료 부족' } },
    items: [
      { t: '2026-10-28T04:00:00', s: '2026-10-28T03:00:00', status: 'done', text: '안내 초안' },
      { t: '2026-10-29T02:00:00Z', status: 'todo', text: '측정', issue: '측정 PC 미정. 다음 주' },
    ],
  });
  const h = pageFrom(m, cfg, 'history', NOW);
  assert.ok(h.startsWith('<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta http-equiv="refresh" content="30;url=/?tab=history">\n<title>ex 진척도</title>'));
  assert.ok(h.includes('<h1>예시 진척도</h1>'));
  assert.ok(h.includes('<div>스토리 2/5 완료 (40%)</div><div class="bar"><i style="width:40%"></i></div>'), '커밋과 storyStates done 이 완료');
  assert.equal(rowsOf(h, 'done'), 4);
  assert.equal(rowsOf(h, 'doing'), 4, '멈춘 단계, A4(storyStates), A3(에이전트), check-docs');
  assert.equal(rowsOf(h, 'todo'), 3);
  assert.ok(h.includes('<td><small>스토리</small> A3 검사</td><td class="h"></td><td class="p">자료 부족</td><td class="n">impl-A3-r1, 정리 중</td>'));
  assert.ok(h.includes('<td><small>에이전트</small> check-docs</td>'));
  assert.ok(!h.includes('<small>에이전트</small> impl-A3-r1'), '스토리 라벨 에이전트는 숨김');
  assert.ok(h.includes('<td class="n">멈춤</td>'), '멈춘 단계');
  assert.ok(h.includes('<td class="n">검토 2회차</td>'));
  assert.ok(h.includes('<td class="h">a186510</td>'));
  assert.ok(h.includes(`<td class="t">10-28 04:00</td><td class="d">1:00</td><td><span class="b done">완료</span></td><td><small>기타</small> 안내 초안`), 'Z 없는 옛 시각은 현지 시각 그대로(옛 서버와 같음)');
  assert.ok(h.includes('<td class="p">측정 PC 미정.<br>다음 주</td>'), '문제점 문장 줄바꿈');
  // 완료와 진행 중은 시각 순, 순번은 이어짐
  const seq = [...h.matchAll(/<td class="q">(\d+)<\/td>/g)].map((x) => Number(x[1]));
  assert.deepEqual(seq, Array.from({ length: 11 }, (_, i) => i + 1));
  const done = [...h.matchAll(/<tr class="done">[\s\S]*?<td class="t">([^<]*)<\/td>/g)].map((x) => x[1]);
  assert.deepEqual(done, [...done].sort());
});

test('진척도: 스토리 0 이면 단계와 기타 항목으로 진척률. 행이 없으면 기록하는 법 한 줄. events 없으면 예정 단계 행 0', T, () => {
  const cfg = cfgOf();
  const h = pageFrom(model(), cfg, 'history', NOW);
  assert.ok(!h.includes('<div>스토리'));
  // 승인 목업(빈 자료)의 문구: 기록이 없는 까닭과 기록 명령
  assert.ok(h.includes('<div class="meta">단계와 스토리 기록 없음. ultra-chain 실행 기록(events.jsonl)이 없고 config.json 의 stories 가 비어 있음. stage, story, item 명령으로 기록</div>'));
  assert.equal(count(h, /<small>단계<\/small>/g), 0);
  const h2 = pageFrom(model({ stages: [{ id: 'design', label: '설계' }], stageState: { design: { s: 'doing', t: NOW - 600e3, start: NOW - 600e3 } } }), cfg, 'history', NOW);
  assert.ok(!h2.includes('<div>스토리') && !h2.includes('기록 없음'));
  assert.ok(h2.includes('<div>항목 0/1 완료 (0%)</div><div class="bar"><i style="width:0%"></i></div>'));
  assert.ok(h2.includes('<td class="d">0:10</td>'));
  assert.ok(h2.includes('<th>소요<br>시간</th>'), '소요시간이 하나라도 있으면 머리글은 옛 꼴 그대로');
  // 스토리와 단계가 없어도 기타 항목이 있으면 안내를 내지 않음(표에 행이 있는데 "없음" 이라 하지 않게)
  const h3 = pageFrom(model({ items: [{ key: 'k', status: 'done', t: '2026-10-29T19:46:30Z', s: '2026-10-29T19:46:30Z', text: '저장소 시작' }] }), cfg, 'history', NOW);
  assert.ok(!h3.includes('기록 없음'), '항목이 있으면 없음 안내 없음');
  assert.ok(h3.includes('저장소 시작'));
  // 스토리와 단계가 모두 없으면 표에서 한글 낱말 가운데를 꺾지 않음. 단계가 있으면(h2) 옛 꼴 그대로
  assert.ok(h3.includes('<table style="word-break:keep-all"><thead>'));
  assert.ok(h2.includes('<table><thead>') && !h2.includes('keep-all'));
  // 소요시간이 모두 "-"(지난 커밋 항목만)면 좁은 칸에서 머리글이 한 글자씩 꺾이지 않게 그 머리글만 nowrap
  const h5 = pageFrom(model({ items: [{ key: 'c-1', status: 'done', t: '2026-10-28T01:00:00Z', text: '지난 커밋' }] }), cfg, 'history', NOW);
  assert.ok(h5.includes('<th style="white-space:nowrap">소요<br>시간</th>'));
  // 스토리가 없으면 단계와 기타 항목으로 "항목 완료/전체". 에이전트 행은 세지 않음. s 없는 항목은 소요시간 "-", hash 는 앞 7자리
  const h4 = pageFrom(
    model({
      stages: [{ id: 'plan', label: '계획' }],
      stageState: { plan: { s: 'done', t: NOW - 7200e3, start: NOW - 9000e3 } },
      agents: [{ label: 'helper', since: NOW - 60e3 }],
      items: [
        { key: 'c-1', status: 'done', t: '2026-10-28T01:00:00Z', text: '지난 커밋', hash: '1a2b3c4d5e6f' },
        { key: 'c-2', status: 'done', t: '2026-10-28T02:00:00Z', text: '지난 커밋 둘' },
        { key: 'w-1', status: 'doing', t: '2026-10-29T02:00:00Z', s: '2026-10-29T02:00:00Z', text: '진행' },
        { key: 'w-2', status: 'todo', t: '2026-10-29T02:30:00Z', text: '남은 일' },
      ],
    }),
    cfg,
    'history',
    NOW,
  );
  assert.ok(h4.includes('<div>항목 3/5 완료 (60%)</div><div class="bar"><i style="width:60%"></i></div>'));
  assert.ok(h4.includes('<td class="d">-</td><td><span class="b done">완료</span></td><td><small>기타</small> 지난 커밋</td><td class="h">1a2b3c4</td>'));
  assert.ok(h4.includes('<td class="d">-</td><td><span class="b todo">예정</span></td><td><small>기타</small> 남은 일</td><td class="h"></td>'));
  assert.ok(h4.includes('<td class="d">1:00</td><td><span class="b doing">진행 중</span></td><td><small>기타</small> 진행</td>'));
});

test('시각 표시는 now 인자만: 같은 now 면 같은 바이트, now 가 바뀌면 갱신 시각과 진행 중 소요시간만 바뀜', T, () => {
  const cfg = cfgOf();
  const m = model({ items: [{ t: '2026-10-29T02:00:00Z', s: '2026-10-29T02:00:00Z', status: 'doing', text: '작업' }] });
  const a = pageFrom(m, cfg, 'history', NOW);
  assert.equal(pageFrom(m, cfg, 'history', NOW), a);
  assert.ok(a.includes(`갱신 ${new Date(NOW).toLocaleString('ko-KR', { hour12: false })} |`));
  assert.ok(a.includes('<td class="d">1:00</td>'));
  const b = pageFrom(m, cfg, 'history', NOW + 3600e3);
  assert.ok(b.includes('<td class="d">2:00</td>'));
  assert.ok(b.includes(`갱신 ${new Date(NOW + 3600e3).toLocaleString('ko-KR', { hour12: false })} |`));
});

test('구현요건 판정 4행: state 우선, AC 와 스토리, 스토리 없는 AC 는 미검증, AC 없음은 명세 없음', T, () => {
  const cfg = cfgOf({ stories: [{ id: 'A1', name: '화면' }, { id: 'A2', name: '설정' }, { id: 'A3', name: '검사' }], text: { reqRule: '판정 규칙. 둘째 문장.' } });
  const spec = {
    excluded: '제외 이유.',
    users: [
      {
        text: '요구 하나',
        source: '원문',
        specs: [
          { text: 'state 가 앞섬', acs: ['AC-1'], state: 'unv', note: '실기 불가' },
          { text: '모두 완료', acs: ['AC-1'] },
          { text: '일부', acs: ['AC-2'] },
          { text: '진행 중', acs: ['AC-3'] },
          { text: '스토리 없음', acs: ['AC-9'] },
          { text: 'AC 없음', acs: [] },
          { text: '대상 제외', acs: ['AC-1'], state: 'excl', note: '범위 밖' },
          { text: '미구현', acs: ['AC-4'] },
        ],
      },
    ],
    stories: { A1: ['화면', '표'], A2: ['설정', '읽기'], A3: ['검사', '형식'] },
  };
  const reqs = { generated: '모르는 키', acs: [{ id: 'AC-1', stories: ['A1'] }, { id: 'AC-2', stories: ['A1', 'A2'] }, { id: 'AC-3', stories: ['A3'] }, { id: 'AC-4', stories: ['A2'] }, { id: 'AC-9', stories: [] }] };
  const m = model({ stories: cfg.stories, ids: ['A1', 'A2', 'A3'], commits: { A1: { h: 'x', t: 1 } }, agents: [{ label: 'impl-A3', since: NOW }], reqSpec: { value: spec }, reqs: { value: reqs } });
  const h = pageFrom(m, cfg, 'req', NOW);
  const kinds = [...h.matchAll(/<tr><td class="q">1\.\d+<\/td>[\s\S]*?<span class="b (\w+)">/g)].map((x) => x[1]);
  assert.deepEqual(kinds, ['unv', 'done', 'part', 'doing', 'unv', 'miss', 'excl', 'todo']);
  assert.ok(h.includes('<td class="n">담당 스토리 없음</td>'));
  assert.ok(h.includes('<td class="n">남은 스토리 A2</td>'));
  assert.ok(h.includes('<td class="n">실기 불가</td>'));
  assert.ok(h.includes('요구 1건, 기능 명세 8건: 완료 1, 일부 1, 진행 중 1, 미구현 1, 미검증 2, 대상 제외 1, 명세 없음 1 (대상 제외를 뺀 완료 14%)'));
  assert.ok(h.includes('<div class="meta">판정 규칙.<br>둘째 문장.<br>제외 이유.</div>'), '판정 문구는 설정');
  assert.ok(h.includes('<tr class="sec"><td class="q">1</td><td colspan="3">요구 하나 <small>원문</small></td><td><span class="b doing">진행 중</span>'));
  const sty = [...h.matchAll(/<tr><td class="st"><span class="s[^"]*">(\w+)<\/span>[\s\S]*?<span class="b (\w+)">/g)].map((x) => `${x[1]}:${x[2]}`);
  assert.deepEqual(sty, ['A1:done', 'A2:todo', 'A3:doing']);
});

test('구현요건 묶음 상태: 모두 미검증이면 미검증, 모두 명세 없음이면 명세 없음, 대상 제외는 빼고 판정', T, () => {
  const cases = [
    [['done', 'done', 'excl'], 'done'],
    [['done', 'doing', 'unv'], 'doing'],
    [['done', 'todo'], 'part'],
    [['part', 'unv'], 'part'],
    [['unv', 'unv'], 'unv'],
    [['unv', 'none', 'excl'], 'unv'],
    [['none', 'none'], 'none'],
    [['todo', 'unv'], 'todo'],
    [['todo', 'none'], 'todo'],
    [['excl', 'excl'], 'excl'],
  ];
  for (const [ks, k] of cases) assert.equal(groupKind(ks), k, ks.join(','));
  // 화면: 요약 줄과 같은 판정(미구현 0, 미검증 2 인 요구는 미검증), 명세 없음 묶음은 miss 표
  const spec = { users: [{ text: '요구', source: '원문', specs: [{ text: '하나', acs: ['AC-1'] }, { text: '둘', acs: ['AC-2'] }] }, { text: '빈 요구', source: '원문', specs: [{ text: '셋', acs: [] }] }] };
  const reqs = { acs: [{ id: 'AC-1', stories: [] }, { id: 'AC-2', stories: [] }] };
  const h = pageFrom(model({ reqSpec: { value: spec }, reqs: { value: reqs } }), cfgOf(), 'req', NOW);
  assert.ok(h.includes('미구현 0, 미검증 2, 대상 제외 0, 명세 없음 1'));
  assert.ok(h.includes('<tr class="sec"><td class="q">1</td><td colspan="2">요구 <small>원문</small></td><td><span class="b unv">미검증</span>'));
  assert.ok(h.includes('<tr class="sec"><td class="q">2</td><td colspan="2">빈 요구 <small>원문</small></td><td><span class="b miss">명세 없음</span>'));
});

test('구현요건: 스토리가 없는 프로젝트는 담당 스토리 칸과 스토리 표를 그리지 않음', T, () => {
  const cfg = cfgOf();
  const spec = { users: [{ text: '요구', source: '원문', specs: [{ text: '명세', acs: ['AC-1'] }, { text: '완료', acs: ['AC-2'], state: 'done' }] }] };
  const reqs = { acs: [{ id: 'AC-1', stories: [] }, { id: 'AC-2', stories: [] }] };
  const h = pageFrom(model({ reqSpec: { value: spec }, reqs: { value: reqs } }), cfg, 'req', NOW);
  assert.ok(!h.includes('담당 스토리</th>') && !h.includes('<td class="st">'));
  assert.ok(!h.includes('<h2>스토리</h2>') && !h.includes('class="sty"'));
  // 담당 스토리 칸이 없으면 상태 칸이 좁아 "구현 여/부" 로 꺾이므로 그 머리글만 nowrap
  assert.ok(h.includes('<th>근거 AC</th><th style="white-space:nowrap">구현 여부</th>'));
  assert.ok(h.includes('<td colspan="2">요구 <small>원문</small></td>'));
  assert.equal(count(h, /<tr><td class="q">1\.\d<\/td>(?:<td[^>]*>[\s\S]*?<\/td>){4}<\/tr>/g), 2, '명세 행 칸 5개');
  // 판정 문구가 기본(스토리 기준) 그대로면 state 판정 문구. 설정에서 바꾼 문구는 그대로
  assert.ok(h.includes('<div class="meta">구현 여부: 스토리가 없는 프로젝트라 명세에 적은 state 로 판정.<br>state 가 없는 명세는 근거 AC 가 있으면 미검증, 없으면 명세 없음.<br>대상 제외: 범위에서 뺌.<br>완료율에 넣지 않음. </div>'));
  assert.ok(!h.includes('담당 스토리가 모두 완료되면'));
  const own = pageFrom(model({ reqSpec: { value: spec }, reqs: { value: reqs } }), cfgOf({ text: { reqRule: '손으로 쓴 규칙' } }), 'req', NOW);
  assert.ok(own.includes('<div class="meta">손으로 쓴 규칙 </div>'));
  // story 명령으로 더한 스토리가 있으면 그대로 그림(기본 문구, 머리글도 옛 꼴)
  const m2 = model({ stories: [{ id: 'M1', name: '' }], ids: ['M1'], reqSpec: { value: spec }, reqs: { value: reqs } });
  const h2 = pageFrom(m2, cfg, 'req', NOW);
  assert.ok(h2.includes('<th>담당 스토리</th><th>구현 여부</th>') && h2.includes('<h2>스토리</h2>'));
  assert.ok(h2.includes('담당 스토리가 모두 완료되면'));
  // 스토리 설정이 없어도 AC 에 담당 스토리가 있으면 담당 스토리 칸이 있으므로 기본 문구 그대로
  const reqs3 = { acs: [{ id: 'AC-1', stories: ['X1'] }, { id: 'AC-2', stories: [] }] };
  const h3 = pageFrom(model({ reqSpec: { value: spec }, reqs: { value: reqs3 } }), cfg, 'req', NOW);
  assert.ok(h3.includes('<th>담당 스토리</th><th>구현 여부</th>'));
  assert.ok(h3.includes('담당 스토리가 모두 완료되면') && !h3.includes('스토리가 없는 프로젝트라'));
});

test('자료 없음: 세 탭은 안내와 스키마 문서 경로, 진척도는 빈 표', T, () => {
  const cfg = cfgOf();
  const s = snapshotFrom(model(), cfg, NOW);
  assert.equal(count(s, /<div class="meta empty">/g), 3);
  assert.ok(s.includes('<code>references/req-spec.md</code>, <code>references/reqs.md</code>'));
  assert.ok(s.includes('<code>references/flow.md</code>'));
  assert.ok(s.includes('<code>references/arch.md</code>'));
  assert.ok(s.includes('HEAD <code>abc1234 마지막 커밋</code>'));
});

test('workflow: 고정 자료는 옛 배치 그대로(간격 104, 줄바꿈 없음), 사실 수', T, () => {
  const cfg = cfgOf({ shortName: 'example-app' });
  const flow = readFix('flow.json');
  const h = pageFrom(model({ flow: { value: flow } }), cfg, 'workflow', NOW);
  assert.ok(!h.includes('http-equiv="refresh"'), 'workflow 는 자동 갱신 없음');
  assert.equal(count(h, /<svg class="flow"/g), 2);
  assert.equal(count(h, /<g class="n[" ]/g), 10);
  assert.equal(count(h, /class="lb l2"/g), 0);
  assert.ok(h.includes('자료: <code>flow.json</code>.'));
  for (const l of flow.lanes) {
    const L = flowLayout(l);
    for (let r = 1; r < L.rows; r++) assert.equal(L.rowTop[r] - L.rowTop[r - 1], FLOW.FH + FLOW.FGY);
  }
});

test('workflow: 분기 표가 아래 줄 외부 표와 겹치면 그 줄 간격만 늘림, 넘치는 이름만 두 줄, 설명은 내려 3줄(상자를 늘림)', T, () => {
  const flow = readFix('variants', 'workflow-wide', 'flow.json');
  const L = flowLayout(flow.lanes[0]);
  assert.equal(L.rowTop[1] - L.rowTop[0], FLOW.FH + 152);
  // 실제 겹침(1 px 이상) 0
  const ov = (a, b) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) >= 1 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) >= 1;
  const boxes = L.pos.map((p, i) => ({ x: p.x, y: p.y, w: FLOW.FW, h: L.hs[i] }));
  const brs = L.branches.map((b) => ({ x: b.x, y: b.y, w: b.w, h: 20 }));
  const exts = L.externals.map((e) => ({ x: e.x, y: e.y, w: e.w, h: 18 }));
  for (const b of brs) for (const o of [...boxes, ...exts]) assert.ok(!ov(b, o), JSON.stringify([b, o]));
  for (const q of L.branches) assert.ok(q.y >= L.pos[q.i].y + L.hs[q.i] + 10, '분기 표는 늘린 상자 아래');
  assert.deepEqual(L.names[4], ['설정 파일 형식 검사와', '보정']);
  assert.deepEqual(L.names[8], ['결과 알림 보내기'], '예정 단계도 표기 앞에 들어가면 한 줄');
  assert.equal(L.descs[4].length, 3, '이름이 두 줄이어도 설명 3줄');
  assert.deepEqual(L.hs, [92, 92, 92, 92, 107, 92, 92, 92, 92, 92], '내린 설명이 3줄인 상자만 15 px 늘림');
  const h = pageFrom(model({ flow: { value: flow } }), cfgOf(), 'workflow', NOW);
  assert.equal(count(h, /class="lb l2"/g), 1);
  assert.ok(h.includes('<text x="928" y="71" class="lb l2">보정</text>'));
  assert.ok(h.includes('<rect x="896" y="34" width="176" height="107" rx="10"'));
  assert.ok(h.includes('<text x="906" y="91" class="dt">'), '설명 첫 줄을 15 px 내림');
  assert.ok(h.includes('<text x="906" y="121" class="dt">'), '설명 셋째 줄');
  assert.ok(h.includes('<text x="906" y="134" class="who">'), '행위자 줄은 늘린 상자 아래');
  assert.ok(h.includes('viewBox="0 0 1112 504"'));
});

test('workflow: 단계 이름은 정말 넘칠 때만 두 줄(실측 기반 폭 추정, 옛 서버는 줄바꿈 없음)', T, () => {
  // 실측(맑은 고딕 굵게 14px) 140.8 px, 상자 안 끝 172.8 px. 옛 서버(포트 30000)는 한 줄로 그림
  for (const t of ['벤더 복사와 해시 대조', '설정 패치와 경로 이전', '시작 기록과 만료 키', '만료 키 넣은 cc.exe', 'payload 묶음과 zip', '브랜치와 태그 push', 'RESTORE.md 생성']) assert.deepEqual(labelLines(t, false), [t], t);
  assert.deepEqual(labelLines('설정 파일 형식 검사와 보정', false), ['설정 파일 형식 검사와', '보정'], '실측 173.7 px, 넘침');
  assert.deepEqual(labelLines('결과 알림 보내기', true), ['결과 알림 보내기'], '예정 표기 앞 8 px 남음');
  assert.deepEqual(labelLines('결과 알림 모아 보내기', true), ['결과 알림 모아', '보내기'], '예정 표기와 겹침');
  assert.deepEqual(labelLines('짧은 이름', false), ['짧은 이름']);
  assert.deepEqual(labelLines('띄어쓰기없는아주아주긴단계이름', false), ['띄어쓰기없는아주아주긴단계이름'], '나눌 곳이 없으면 한 줄');
  // 두 줄 이름이어도 설명이 2줄 이하면 상자 높이 그대로
  const L = flowLayout({ id: 'x', steps: [{ id: 'a', label: '설정 파일 형식 검사와 보정', detail: '짧은 설명', actor: 'x' }] });
  assert.deepEqual([L.names[0].length, L.descs[0].length, L.hs[0]], [2, 1, FLOW.FH]);
});

test('구성도: 좌표가 모두 맞으면 그대로, 사실 수와 이름', T, () => {
  const arch = readFix('arch.json');
  assert.equal(missingCoord(arch), null);
  const h = pageFrom(model({ arch: { value: arch } }), cfgOf({ shortName: 'example-app' }), 'arch', NOW);
  assert.equal(count(h, /<g class="zn"/g), 3);
  assert.equal(count(h, /<g class="nd"/g), 6);
  assert.equal(count(h, /<g class="eg"/g), 7);
  assert.equal(count(h, /<g class="el-tag"/g), 5);
  assert.ok(h.includes('aria-label="example-app 구성도"'));
  assert.ok(h.includes(`viewBox="0 0 ${arch.width} ${arch.height}"`));
  assert.ok(!h.includes('자동 배치함'));
});

test('구성도: 좌표 키 하나가 빠지거나 틀리면 그림 전체 자동 배치. 상자 겹침 0, 영역 밖 0, 이름표가 상자를 덮지 않음', T, () => {
  const base = readFix('arch.json');
  const variants = {
    'zones[1].h': readFix('variants', 'arch-auto', 'arch.json'),
    'nodes[0].x': { ...base, nodes: base.nodes.map((nd, i) => (i ? nd : { ...nd, x: '40' })) },
    width: { ...base, width: undefined },
    'edges[0].lx': { ...base, edges: base.edges.map((e, i) => (i ? e : { ...e, lx: 'x' })) },
    'edges[1].via': { ...base, edges: base.edges.map((e, i) => (i === 1 ? { ...e, via: [[1]] } : e)) },
  };
  for (const [key, f] of Object.entries(variants)) {
    assert.equal(missingCoord(f), key);
    const L = archLayout(f);
    assert.equal(L.auto, true);
    const nodes = [...L.node.values()];
    const ov = (a, b) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) >= 1 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) >= 1;
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) assert.ok(!ov(nodes[i], nodes[j]), `${key} 상자 겹침`);
    for (const nd of f.nodes) {
      const r = L.node.get(nd.id);
      const z = L.zone.get(nd.zone);
      assert.ok(r.x >= z.x && r.y >= z.y && r.x + r.w <= z.x + z.w && r.y + r.h <= z.y + z.h, `${key} ${nd.id} 영역 밖`);
      assert.ok(r.x + r.w <= L.width && r.y + r.h <= L.height);
    }
    for (const e of archEdges(f, L)) {
      if (!e.e.label) continue;
      const lab = { x: e.lx - e.lw / 2, y: e.ly - 8, w: e.lw, h: 16 };
      for (const nd of nodes) assert.ok(!ov(lab, nd), `${key} 이름표 ${e.id}`);
    }
    const h = pageFrom(model({ arch: { value: f } }), cfgOf(), 'arch', NOW);
    assert.ok(!h.includes('자동 배치함') && !h.includes(`<code>${key}</code>`), '화면에 배치 안내 없음(check 와 문서가 알림)');
    assert.equal(count(h, /<g class="nd"/g), 6);
    assert.equal(count(h, /<g class="eg"/g), 7);
  }
});

test('구성도 자동 배치: 좌표 없는 자료, 영역 끝 연결, 같은 두 끝의 연결은 벌림', T, () => {
  const f = {
    zones: [{ id: 'z1', label: '영역', color: '#1565c0' }, { id: 'z2', label: '둘', color: '#2e7d32' }],
    nodes: [{ id: 'a', zone: 'z1', label: '가', detail: '설명이 조금 긴 상자라서 두 줄로 나뉨', items: ['칩 하나', '예정 칩'] }, { id: 'b', zone: 'z1', label: '나' }, { id: 'c', zone: 'z2', label: '다', planned: true }, { id: 'd', zone: 'zz', label: '영역 없음' }],
    edges: [{ from: 'a', to: 'c', label: '가다' }, { from: 'c', to: 'a', label: '다가' }, { from: 'b', to: 'z2', kind: 'data', label: '' }, { from: 'a', to: 'nope' }],
  };
  const L = archLayout(f);
  assert.equal(L.auto, true);
  assert.equal(L.missing, 'width');
  const es = archEdges(f, L);
  assert.equal(es.length, 3, '끝을 못 찾은 연결은 뺌');
  assert.deepEqual(closeLines(es), [], '같은 두 끝의 두 연결이 겹치지 않음(나란한 선 6 px 이상)');
  const z2 = L.zone.get('z2');
  const [ex, ey] = es[2].pts.at(-1);
  assert.ok([z2.x, z2.x + z2.w].includes(ex) || [z2.y, z2.y + z2.h].includes(ey), '영역 끝은 영역 사각형 가장자리');
  assert.ok(L.node.get('d').y > z2.y + z2.h, '영역 없는 상자는 맨 아래');
  const h = pageFrom(model({ arch: { value: f } }), cfgOf(), 'arch', NOW);
  assert.ok(h.includes('stroke-dasharray="3 2"/><text') && h.includes('class="ck">예정 칩</text>'), '예정 칩');
  assert.ok(h.includes('class="tag">예정</text>'));
});

test('구성도 자동 배치: 상자 20개 이상은 가로로 넓게(폭 1600 이하, 가로세로 비 1.2 이상), 영역 사이 연결은 상자를 피해 가로세로로 꺾음', T, () => {
  const zones = Array.from({ length: 8 }, (_, i) => ({ id: `z${i}`, label: `영역 ${i}` }));
  const nodes = zones.flatMap((z, i) => Array.from({ length: 4 }, (_, k) => ({ id: `n${i}${k}`, zone: z.id, label: `상자 ${i}-${k}`, detail: '설명 한 줄' })));
  const edges = zones.slice(1).map((z, i) => ({ from: `n${i}3`, to: `n${i + 1}0`, label: '다음' }));
  const f = { zones, nodes, edges };
  const L = archLayout(f);
  assert.ok(L.width <= 1600 && L.width / L.height >= 1.2, `${L.width}x${L.height}`);
  assert.ok(new Set([...L.zone.values()].map((z) => z.y)).size < zones.length, '한 띠에 영역 여럿');
  assert.equal(archLayout(f), L, '같은 자료 객체는 다시 계산하지 않음');
  const es = archEdges(f, L);
  const bent = es.filter((e) => e.pts.length > 2);
  assert.ok(bent.length > 0);
  for (const e of bent) for (let k = 1; k < e.pts.length; k++) assert.ok(e.pts[k][0] === e.pts[k - 1][0] || e.pts[k][1] === e.pts[k - 1][1], `${e.id} 가로세로`);
  assert.deepEqual(archFlaws(f, L), []);
  const h = pageFrom(model({ arch: { value: f } }), cfgOf(), 'arch', NOW);
  assert.ok(h.includes(`viewBox="0 0 ${L.width} ${L.height}"`));
});

test('구성도 자동 배치: 모든 연결은 가로세로 선분(대각선 0), 그림 폭은 1800 이하(상자가 많은 영역은 줄을 늘림)', T, () => {
  const ortho = (es) => es.every((e) => e.pts.every((p, k) => !k || p[0] === e.pts[k - 1][0] || p[1] === e.pts[k - 1][1]));
  // 상자를 지나지 않는 대각 직선이 나올 자리: 위아래 띠의 어긋난 상자, 같은 영역의 다른 줄 다른 칸
  const zones = [{ id: 'a', label: '가' }, { id: 'b', label: '나' }, { id: 'c', label: '다' }];
  const nodes = [
    ...Array.from({ length: 12 }, (_, i) => ({ id: `a${i}`, zone: 'a', label: `상자 이름 ${i}`, detail: '설명 한 줄', items: ['칩 하나', '칩 둘', '칩 셋', '칩 넷'] })),
    ...Array.from({ length: 5 }, (_, i) => ({ id: `b${i}`, zone: 'b', label: `나 ${i}` })),
    { id: 'c0', zone: 'c', label: '다 하나' },
  ];
  const edges = [
    { from: 'a0', to: 'b4', label: '멀리' },
    { from: 'a11', to: 'c0', label: '아래' },
    { from: 'a0', to: 'a7', label: '' },
    { from: 'b0', to: 'c', kind: 'data', label: '영역' },
    { from: 'c0', to: 'a5', label: '돌아감' },
  ];
  const f = { zones, nodes, edges };
  const L = archLayout(f);
  assert.ok(L.width <= 1800, `폭 ${L.width}`);
  const es = archEdges(f, L);
  assert.equal(es.length, 5);
  assert.ok(ortho(es), JSON.stringify(es.map((e) => e.pts)));
  // 좌표가 모두 있으면 연결을 그대로 씀(좌표 사용 렌더는 바꾸지 않음)
  const fixed = readFix('arch.json');
  const F = archLayout(fixed);
  assert.equal(F.auto, false);
  for (const e of fixed.edges) assert.equal(F.edge(e), e);
});

test('구성도 자동 배치: 선은 두 끝이 아닌 상자를 지나지 않고 다른 연결과 겹치지 않음, 이름표는 상자와 이름표와 겹치지 않고 그림 안, 결과가 늘 같음', T, () => {
  // 같은 행의 가운데 상자를 건너뛰는 연결(check-auto), 같은 영역 안 건너뛰기, 한 상자에서 여럿으로, 여럿에서 한 상자로, 영역 끝
  const zones = [{ id: 'a', label: '가' }, { id: 'b', label: '나' }, { id: 'c', label: '다' }];
  const nodes = [
    ...Array.from({ length: 6 }, (_, i) => ({ id: `a${i}`, zone: 'a', label: `가 상자 ${i}`, detail: '설명 한 줄' })),
    ...Array.from({ length: 6 }, (_, i) => ({ id: `b${i}`, zone: 'b', label: `나 상자 ${i}`, detail: '설명이 조금 더 길어서 두 줄로 나뉘는 상자' })),
    ...Array.from({ length: 4 }, (_, i) => ({ id: `c${i}`, zone: 'c', label: `다 ${i}` })),
  ];
  const edges = [
    { from: 'a0', to: 'a2', label: '건너뜀' },
    { from: 'a0', to: 'a5', label: '' },
    { from: 'a3', to: 'a5', label: '옆 옆으로' },
    ...['b0', 'b2', 'b4', 'c1', 'c3'].map((t, i) => ({ id: `fan${i}`, from: 'a1', to: t, label: `퍼짐 ${i}` })),
    ...['a4', 'b1', 'b5', 'c0'].map((s, i) => ({ id: `in${i}`, from: s, to: 'c2', kind: 'data', label: i % 2 ? '' : `모임 ${i}` })),
    { from: 'b3', to: 'a', kind: 'data', label: '영역으로' },
    { from: 'c3', to: 'a0', kind: 'api', label: '돌아감' },
  ];
  const f = { zones, nodes, edges };
  const L = archLayout(f);
  const es = archEdges(f, L);
  assert.equal(es.length, edges.length);
  const boxes = new Map(nodes.map((nd) => [nd.id, L.node.get(nd.id)]));
  for (const e of es) {
    for (let k = 1; k < e.pts.length; k++) {
      const [p, q] = [e.pts[k - 1], e.pts[k]];
      assert.ok(p[0] === q[0] || p[1] === q[1], `${e.id} 대각선`);
      for (const [id, r] of boxes) {
        if (id === e.e.from || id === e.e.to) continue;
        const inside = Math.max(p[0], q[0]) > r.x && Math.min(p[0], q[0]) < r.x + r.w && Math.max(p[1], q[1]) > r.y && Math.min(p[1], q[1]) < r.y + r.h;
        assert.ok(!inside, `${e.id} 이 ${id} 를 지남`);
      }
    }
    const last = e.pts.at(-1);
    const prev = e.pts.at(-2);
    assert.ok(Math.abs(last[0] - prev[0]) + Math.abs(last[1] - prev[1]) >= 10, `${e.id} 끝 선분이 화살표보다 짧음`);
  }
  assert.deepEqual(closeLines(es), []);
  assert.deepEqual(archFlaws(f, L), []);
  const labs = es.filter((e) => e.e.label).map((e) => ({ id: e.id, x: e.lx - e.lw / 2, y: e.ly - 8, w: e.lw, h: 16 }));
  const ov = (a, b) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0;
  for (const [i, l] of labs.entries()) {
    assert.ok(l.x - 0.4 >= 0 && l.x + l.w + 0.4 <= L.width && l.y >= 0 && l.y + l.h <= L.height, `${l.id} 이름표가 그림 밖`);
    for (const r of boxes.values()) assert.ok(!ov(l, r), `${l.id} 이름표가 상자를 덮음`);
    for (const o of labs.slice(i + 1)) assert.ok(!ov(l, o), `${l.id}, ${o.id} 이름표 겹침`);
  }
  // 같은 자료면 늘 같은 선(새 객체로 다시 계산)
  const again = JSON.parse(JSON.stringify(f));
  assert.deepEqual(archEdges(again, archLayout(again)).map((e) => [e.pts, e.lx, e.ly]), es.map((e) => [e.pts, e.lx, e.ly]));
  // check-auto 변형: 가운데 상자를 지나지 않음
  const ca = readFix('variants', 'check-auto', 'arch.json');
  const cl = archLayout(ca);
  assert.deepEqual(archFlaws(ca, cl), []);
});

test('구성도 자동 배치: 선은 영역 제목 띠를 지나지 않고, 나란한 영역 테두리와 그림 가장자리에서 6 px 이상, 연결 툴팁에 undefined 없음', T, () => {
  // 두 띠에 걸친 영역(긴 제목), 위 띠에서 아래 띠로 여러 줄, 맨 아래 행 상자 사이 연결(상자 아래 통로), 이름표와 설명이 없는 연결
  const zones = ['빌드 단계 00~08 아주 긴 제목', '외부 도구', '런처 실행', '릴리스 도구와 배포', '설정'].map((label, i) => ({ id: `z${i}`, label }));
  const nodes = zones.flatMap((z, i) => Array.from({ length: i === 0 ? 9 : 3 }, (_, k) => ({ id: `n${i}${k}`, zone: z.id, label: `상자 ${i}-${k}`, detail: '설명 한 줄' })));
  const edges = [
    ...Array.from({ length: 8 }, (_, k) => ({ id: `chain${k}`, from: `n0${k}`, to: `n0${k + 1}` })),
    ...[1, 2, 3, 4].flatMap((i) => [{ id: `down${i}`, from: 'n00', to: `n${i}2`, label: `아래 ${i}` }, { id: `up${i}`, from: `n${i}0`, to: 'n08', kind: 'data' }]),
    { id: 'zone', from: 'n31', to: 'z1', kind: 'data', label: '영역으로' },
    { id: 'skip', from: 'n20', to: 'n22', label: '건너뜀' },
  ];
  const f = { zones, nodes, edges };
  const sets = { 합성: f, 'arch-auto': readFix('variants', 'arch-auto', 'arch.json'), 'check-auto': readFix('variants', 'check-auto', 'arch.json') };
  for (const [name, d] of Object.entries(sets)) {
    const L = archLayout(d);
    assert.equal(L.auto, true);
    const es = archEdges(d, L);
    assert.deepEqual(edgeRoom(d, L, es), [], name);
    assert.deepEqual(archFlaws(d, L, es), [], name);
    assert.deepEqual(closeLines(es), [], name);
    // 이름표는 상자에서 5 px 이상, 100 px 넘게 영역 테두리와 나란한 선분은 테두리에서 12 px 이상
    for (const e of es.filter((x) => x.e.label)) {
      const l = { x: e.lx - e.lw / 2, y: e.ly - 8, w: e.lw, h: 16 };
      for (const [id, r] of L.node) assert.ok(Math.hypot(Math.max(0, r.x - l.x - l.w, l.x - r.x - r.w), Math.max(0, r.y - l.y - l.h, l.y - r.y - r.h)) >= 5, `${name} ${e.id} 이름표가 ${id} 에 5 px 안`);
    }
    for (const s of segsOf(es)) {
      for (const [id, r] of L.zone) {
        const [b0, b1, lines] = s.h ? [r.x, r.x + r.w, [r.y, r.y + r.h]] : [r.y, r.y + r.h, [r.x, r.x + r.w]];
        if (Math.min(s.hi, b1) - Math.max(s.lo, b0) > 100) assert.ok(lines.every((v) => Math.abs(s.c - v) >= 12), `${name} ${s.id} 이 ${id} 테두리와 12 px 안에서 길게 나란함`);
      }
    }
  }
  const h = pageFrom(model({ arch: { value: f } }), cfgOf(), 'arch', NOW);
  assert.ok(!h.includes('undefined'), '툴팁에 undefined 없음');
  assert.ok(h.includes('<g class="eg" id="e-chain0-line" data-scene=""><title></title>'), '이름표와 설명이 없으면 빈 글');
  assert.ok(h.includes('<title>아래 1</title>'), '설명이 없으면 이름표');
  f.edges[0].refs = ['src/a.js:1'];
  const h2 = pageFrom(model({ arch: { value: { ...f } } }), cfgOf(), 'arch', NOW);
  assert.ok(h2.includes('<g class="eg" id="e-chain0-line" data-scene=""><title>(src/a.js:1)</title>'), '근거만 있으면 근거만');
});

test('구성도 자동 배치: 끝 자리가 모두 막히면 한 번 꺾은 선, 그 선이 상자를 지나면 archFlaws 가 알림(check 는 WARN)', T, () => {
  // a 의 네 옆면 바로 앞(4 px)에 상자: 옆면에서 나가는 모든 자리의 첫 격자점이 막힘
  const box = (x, y) => ({ x, y, w: 40, h: 40 });
  const node = new Map([['a', box(100, 100)], ['t', box(100, 56)], ['d', box(100, 144)], ['l', box(56, 100)], ['r', box(144, 100)], ['b', box(300, 240)]]);
  const L = { auto: true, width: 400, height: 320, zone: new Map(), node, titles: [] };
  const f = { zones: [], nodes: [...node.keys()].map((id) => ({ id, label: id })), edges: [{ id: 'ab', from: 'a', to: 'b', label: '막힘' }] };
  const routes = autoRoutes(L, f.edges);
  const pts = routes.get(f.edges[0]);
  assert.deepEqual(pts, [[140, 120], [320, 120], [320, 240]], '한 번 꺾은 선(a 오른쪽 옆면에서 b 위로)');
  const flaws = archFlaws(f, { ...L, edge: (e) => ({ ...e, pts: routes.get(e) }) });
  assert.deepEqual(flaws.map((x) => [x.kind, x.id]), [['cross', 'r']]);
});

test('구성도 자동 배치: 연결이 많은 영역끼리 이웃, 이름표는 영역 테두리를 덮지 않고 다른 선과 4 px 이상, 이름표가 지나는 영역 틈은 넓힘', T, () => {
  // 첫 영역과 끝 영역이 연결 6개로 이어짐. 배열 순서대로면 두 영역이 띠 양 끝에 놓여 선이 영역 넷을 건넌다.
  const zones = ['가', '나', '다', '라', '마', '바'].map((label, i) => ({ id: `z${i}`, label }));
  const nodes = zones.flatMap((z, i) => [0, 1, 2].map((k) => ({ id: `n${i}${k}`, zone: z.id, label: `상자 ${i}-${k}` })));
  const edges = [...[0, 1, 2].flatMap((k) => [{ from: `n0${k}`, to: `n5${k}` }, { from: `n5${k}`, to: `n0${k}` }]), { from: 'n10', to: 'n20' }, { from: 'n30', to: 'n40' }];
  const L = archLayout({ zones, nodes, edges });
  const [z0, z5] = [L.zone.get('z0'), L.zone.get('z5')];
  // 두 영역 사이 거리(어느 쪽이 왼쪽이든)가 영역 사이 틈 48 이하
  assert.ok(z0.y === z5.y && Math.max(z5.x - (z0.x + z0.w), z0.x - (z5.x + z5.w)) <= 48, `z0 과 z5 가 같은 띠 이웃 ${JSON.stringify([z0, z5])}`);
  // 고정 자료 변형 arch-auto: 이름표와 영역 테두리, 다른 연결 선, 나란한 선 간격
  const f = readFix('variants', 'arch-auto', 'arch.json');
  const A = archLayout(f);
  const es = archEdges(f, A);
  const borders = [...A.zone.values()].flatMap((z) => [[z.y, z.x, z.x + z.w, true], [z.y + z.h, z.x, z.x + z.w, true], [z.x, z.y, z.y + z.h, false], [z.x + z.w, z.y, z.y + z.h, false]]);
  const segs = segsOf(es);
  for (const e of es.filter((x) => x.e.label)) {
    const l = { x: e.lx - e.lw / 2, y: e.ly - 8, w: e.lw, h: 16 };
    for (const [c, lo, hi, h] of borders) {
      const on = h ? c > l.y - 1 && c < l.y + l.h + 1 && Math.min(hi, l.x + l.w) - Math.max(lo, l.x) > 0 : c > l.x - 1 && c < l.x + l.w + 1 && Math.min(hi, l.y + l.h) - Math.max(lo, l.y) > 0;
      assert.ok(!on, `${e.id} 이름표가 영역 테두리 위`);
    }
    for (const s of segs.filter((x) => x.id !== e.id)) {
      const [x0, x1, y0, y1] = s.h ? [s.lo, s.hi, s.c, s.c] : [s.c, s.c, s.lo, s.hi];
      assert.ok(Math.hypot(Math.max(0, x0 - l.x - l.w, l.x - x1), Math.max(0, y0 - l.y - l.h, l.y - y1)) >= 4, `${e.id} 이름표와 ${s.id} 선이 4 px 안`);
    }
  }
  for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
    const [a, b] = [segs[i], segs[j]];
    if (a.id !== b.id && a.h === b.h && Math.min(a.hi, b.hi) - Math.max(a.lo, b.lo) > 0) assert.ok(Math.abs(a.c - b.c) >= 12, `${a.id}, ${b.id} 나란한 선 간격`);
  }
  // 이름표 있는 연결(시작, 정지: 폭 64)이 지나는 사용자 쪽과 앱 사이 틈: 64 + 2 x 4 + 8 = 80
  assert.equal(A.zone.get('app').x - (A.zone.get('user').x + A.zone.get('user').w), 80);
});

test('구성도 자동 배치: 끝 자리 쪽에서 되돌아 들어오는 길은 쓰지 않음(끝 선분이 화살표 길이 이상)', T, () => {
  // b 의 위, 오른쪽, 아래를 4 px 앞 상자로 막아 왼쪽 옆면만 남긴다. c 의 가운데 세로선(x=291)이 b 왼쪽 9 px 에 있어
  // 끝 자리의 첫 격자점(x=270)보다 b 에 가깝다. w 가 x=270 세로선 위쪽을 막는다.
  // 규칙이 없으면 x=291 로 내려와 x=270 으로 갔다가 되돌아 b 로 들어가 끝 선분이 9 px 로 줄어든다.
  // x=291 세로 선분은 b 와 나란한 구간에서 상자 거리 10 px 을 지키려고 x=290 으로 옮긴다.
  const box = (x, y, w = 40, h = 40) => ({ x, y, w, h });
  const node = new Map([['a', box(400, 20)], ['b', box(300, 200)], ['t', box(300, 156)], ['r', box(344, 200)], ['d', box(300, 244)], ['c', box(271, 400)], ['w', box(230, 120, 45, 60)]]);
  const L = { auto: true, width: 520, height: 480, zone: new Map(), node, titles: [] };
  const edges = [{ id: 'ab', from: 'a', to: 'b' }];
  const pts = autoRoutes(L, edges).get(edges[0]);
  assert.deepEqual(pts, [[400, 40], [290, 40], [290, 200], [270, 200], [270, 220], [300, 220]]);
  const [p, q] = pts.slice(-2);
  assert.ok(q[0] - p[0] >= 10 && p[1] === q[1], '끝 선분은 b 왼쪽 옆면으로 들어가는 10 px 이상 가로 선분');
});

test('구성도 자동 배치: 두 끝이 속하지 않는 영역은 지나는 길이만큼 값을 더해 비킬 길이 있으면 돌아감', T, () => {
  // z1 의 a 에서 z3 의 b 로. 그 사이 z2(폭 400)를 곧게 지나면 400 px 이 다른 영역 안. z2 위아래로 돌아가는 길이 더 싸다.
  const box = (x, y, w, h) => ({ x, y, w, h });
  const zone = new Map([['z1', box(20, 20, 200, 300)], ['z2', box(268, 120, 400, 120)], ['z3', box(716, 20, 200, 300)]]);
  const node = new Map([['a', box(40, 150, 160, 64)], ['b', box(736, 150, 160, 64)]]);
  const L = { auto: true, width: 936, height: 340, zone, node, titles: [] };
  const edges = [{ id: 'ab', from: 'a', to: 'b' }];
  const pts = autoRoutes(L, edges).get(edges[0]);
  const z2 = zone.get('z2');
  for (let k = 1; k < pts.length; k++) {
    const [p, q] = [pts[k - 1], pts[k]];
    const inside = Math.max(p[0], q[0]) > z2.x && Math.min(p[0], q[0]) < z2.x + z2.w && Math.max(p[1], q[1]) > z2.y && Math.min(p[1], q[1]) < z2.y + z2.h;
    assert.ok(!inside, `z2 안을 지남 ${JSON.stringify(pts)}`);
  }
  // 두 끝이 속한 영역은 값 없이 지난다(z2 에 끝을 두면 곧은 선)
  const L2 = { ...L, zone: new Map([['z1', zone.get('z1')], ['z3', zone.get('z3')], ['z2', box(220, 120, 496, 120)]]), node: new Map([['a', box(240, 150, 160, 64)], ['b', box(536, 150, 160, 64)]]) };
  assert.deepEqual(autoRoutes(L2, edges).get(edges[0]), [[400, 182], [536, 182]]);
});

test('구성도 자동 배치: 다른 영역과 잇는 연결이 4개 이상 몰린 허브 상자는 그 영역 쪽 맨 끝 칸으로', T, () => {
  // a0 이 배열 맨 앞이지만 나 영역 상자 넷과 이어져 가 영역의 맨 뒤 칸(아래 행 오른쪽)으로 옮긴다.
  const zones = [{ id: 'a', label: '가' }, { id: 'b', label: '나' }];
  const nodes = [...[0, 1, 2, 3].map((k) => ({ id: `a${k}`, zone: 'a', label: `가 ${k}` })), ...[0, 1, 2, 3].map((k) => ({ id: `b${k}`, zone: 'b', label: `나 ${k}` }))];
  const edges = [0, 1, 2, 3].map((k) => ({ from: 'a0', to: `b${k}` }));
  const L = archLayout({ zones, nodes, edges });
  const za = [0, 1, 2, 3].map((k) => L.node.get(`a${k}`));
  const hub = za[0];
  assert.ok(za.every((r) => r.y < hub.y || (r.y === hub.y && r.x <= hub.x)), `a0 이 맨 뒤 칸이 아님 ${JSON.stringify(za)}`);
  assert.ok(L.zone.get('b').x > L.zone.get('a').x, '나 영역이 가 영역 오른쪽');
  // 연결이 3개면 옮기지 않는다(배열 순서 그대로 첫 칸)
  const L3 = archLayout({ zones, nodes, edges: edges.slice(0, 3) });
  const z3 = [0, 1, 2, 3].map((k) => L3.node.get(`a${k}`));
  assert.ok(z3.every((r) => r.y > z3[0].y || (r.y === z3[0].y && r.x >= z3[0].x)), `a0 이 첫 칸이 아님 ${JSON.stringify(z3)}`);
});

test('위험 문자열과 색: 모든 글 escape, 색은 #rrggbb 만', T, () => {
  const EVIL = `<script>alert("x")</script>&'`;
  const cfg = cfgOf({ title: EVIL, shortName: EVIL, stories: [{ id: 'A1', name: EVIL }] });
  const flow = { note: EVIL, lanes: [{ id: EVIL, title: EVIL, color: 'red" onload="x', note: EVIL, steps: [{ id: 's1', label: EVIL, detail: EVIL, actor: EVIL, refs: [EVIL] }], branches: [{ from: 's1', to: '', when: EVIL, note: EVIL }], externals: [{ id: 'x', label: EVIL, linkTo: 's1', note: EVIL }] }], scenes: [{ n: 1, sec: 1, lane: EVIL, focus: [EVIL], caption: EVIL }] };
  const arch = { note: EVIL, width: 400, height: 300, legend: [EVIL], zones: [{ id: EVIL, label: EVIL, x: 0, y: 0, w: 400, h: 300, color: 'url(x)' }], nodes: [{ id: EVIL, zone: EVIL, label: EVIL, detail: EVIL, x: 10, y: 30, w: 200, h: 80, items: [EVIL], color: '#fff" x' }], edges: [{ id: EVIL, from: EVIL, to: EVIL, label: EVIL, kind: EVIL, color: '#a1b2c3"' }], scenes: [{ n: EVIL, sec: EVIL, focus: [EVIL], caption: EVIL }] };
  const spec = { excluded: EVIL, users: [{ text: EVIL, source: EVIL, specs: [{ text: EVIL, acs: [EVIL], note: EVIL, state: 'excl' }] }], stories: { [EVIL]: [EVIL, EVIL] } };
  const m = model({ head: EVIL, stories: cfg.stories, ids: ['A1'], notes: { A1: { note: EVIL, issue: EVIL } }, items: [{ status: 'done', text: EVIL, note: EVIL, issue: EVIL }], agents: [{ label: EVIL, since: NOW }], flow: { value: flow }, arch: { value: arch }, reqSpec: { value: spec }, reqs: { value: { acs: [] } } });
  const s = snapshotFrom(m, cfg, NOW);
  assert.ok(!s.includes('<script>alert'), 'script 태그 없음');
  assert.equal(count(s, /<script>/g), 1, '탭 전환 스크립트 하나');
  assert.ok(!s.includes('"x")'), '따옴표가 escape 됨');
  assert.ok(!/ onload=/.test(s));
  assert.ok(!s.includes('url(x)') && !s.includes('#fff" x') && !s.includes('#a1b2c3"'));
  assert.ok(s.includes('stroke="#555555" stroke-width="1.5"'), '틀린 영역 색은 기본 색');
  assert.ok(s.includes('r="10" fill="#455a64"/>'), '틀린 흐름 색은 기본 색');
  for (const k of ['history', 'req', 'workflow', 'arch']) assert.ok(!pageFrom(m, cfg, k, NOW).includes('<script>'), k);
});

test('단일 HTML 스냅숏: 절 4, 인라인 스크립트 1, 외부 참조 0, 자동 갱신 없음, 탭은 # 링크', T, () => {
  const cfg = cfgOf({ title: '예시', shortName: 'ex' });
  const m = model({ flow: { value: readFix('flow.json') }, arch: { value: readFix('arch.json') }, reqSpec: { value: readFix('req-spec.json') }, reqs: { value: readFix('reqs.json') } });
  const s = snapshotFrom(m, cfg, NOW);
  assert.equal(count(s, /<section id="tab-/g), 4);
  assert.equal(count(s, /<script\b/g), 1);
  assert.ok(!/http-equiv="refresh"/.test(s));
  assert.ok(!/(?:src|href)\s*=\s*["']?(?:https?:)?\/\//i.test(s));
  assert.ok(s.includes('<title>ex 진척도 스냅숏</title>'));
  assert.ok(s.includes('<div class="tabs"><a href="#history" data-tab="history">진척도</a><a href="#req" data-tab="req">구현요건</a><a href="#workflow" data-tab="workflow">workflow</a><a href="#arch" data-tab="arch">구성도</a></div>'));
  assert.ok(s.includes('<section id="tab-req" class="tab"><h2 class="tt">구현요건</h2>\n\n<div>요구 2건'));
  assert.ok(!s.includes('/?tab='), '서버 주소 링크 없음');
});

test('고정 자료 프로젝트로 renderTab: 출처를 읽어 4탭(git 없음, events 자동 탐색)', T, () => {
  const files = {};
  for (const f of ['config.json', 'items.json', 'req-spec.json', 'reqs.json', 'flow.json', 'arch.json']) files[f] = fs.readFileSync(path.join(FIX, f), 'utf8');
  const ctx = project(files);
  const ev = path.join(ctx.project, '.omc', 'ultra-chain', 'example-run', 'events.jsonl');
  fs.mkdirSync(path.dirname(ev), { recursive: true });
  fs.copyFileSync(path.join(FIX, 'events.jsonl'), ev);
  const { config } = validate(JSON.parse(files['config.json']), ctx.project);
  const h = renderTab(ctx, config, 'history', NOW);
  assert.equal(count(h, /<small>단계<\/small>/g), 10);
  assert.ok(h.includes('<div>스토리 0/5 완료 (0%)</div>'));
  assert.ok(h.includes('HEAD <code>-</code>'));
  assert.equal(count(renderTab(ctx, config, 'req', NOW), /<tr><td class="q">\d+\.\d+<\/td>/g), 7);
  assert.equal(count(renderTab(ctx, config, 'flow', NOW), /<svg class="flow"/g), 2);
  assert.equal(count(renderTab(ctx, config, 'arch', NOW), /<g class="nd"/g), 6);
  const m = collect(ctx, config, NOW);
  assert.equal(m.stages.length, 10);
});

test('export 명령: 파일을 쓰고 경로 한 줄, --now 형식, 파일 인자, 자료 폴더를 만들지 않음', T, async () => {
  const ctx = project({ 'flow.json': fs.readFileSync(path.join(FIX, 'flow.json'), 'utf8') });
  const lines = [];
  const io = { out: (l) => lines.push(l), err: (l) => lines.push(`ERR ${l}`) };
  const out = path.join(ROOT, 'snap.html');
  assert.equal(await command('export', ctx, { _: ['export', out], now: '2026-10-29T03:00:00Z' }, io), 0);
  assert.deepEqual(lines, [`내보냄: ${out}`]);
  const html = fs.readFileSync(out, 'utf8');
  assert.ok(html.includes(`스냅숏 ${new Date(NOW).toLocaleString('ko-KR', { hour12: false })} |`));
  assert.equal(count(html, /<section id="tab-/g), 4);
  await assert.rejects(command('export', ctx, { _: ['export', out], now: 'yesterday' }, io), (e) => e instanceof UsageError && /--now/.test(e.message));
  await assert.rejects(command('export', ctx, { _: ['export'] }, io), UsageError);
  await assert.rejects(command('export', ctx, { _: ['export', path.join(ROOT, 'no-such-dir', 'x.html')] }, io), /쓰기 실패/);
  const bare = path.join(ROOT, 'bare', 'app');
  fs.mkdirSync(bare, { recursive: true });
  const ctx2 = { project: bare, runtime: 'claude', dataDir: path.join(bare, '.omc', 'progress-mon'), exists: false };
  assert.equal(await command('export', ctx2, { _: ['export', path.join(ROOT, 'bare.html')], now: '2026-10-29T03:00:00Z' }, io), 0);
  assert.equal(fs.existsSync(path.join(bare, '.omc')), false);
  const cfgBad = project({ 'config.json': '{"port": 1}' });
  await assert.rejects(command('export', cfgBad, { _: ['export', path.join(ROOT, 'c.html')] }, io), /config.json 형식 오류/);
});

// AC-7: 저장소 고유 값이 스크립트에 하드코딩되지 않음(*.test.mjs 제외). 이 파일은 검사 대상이 아니다.
test('AC-7: 시험이 아닌 스크립트에 S0~S16 꼴 id, pcc, portable-cc 문자열 0', T, () => {
  const files = fs.readdirSync(HERE).filter((f) => /\.(mjs|js)$/.test(f) && !/\.test\.mjs$/.test(f));
  assert.ok(files.length >= 7);
  for (const f of files) {
    const src = fs.readFileSync(path.join(HERE, f), 'utf8');
    assert.ok(!/\bS(?:1[0-6]|\d)[a-z]?\b/.test(src), `${f}: 스토리 id 꼴`);
    assert.ok(!/pcc/i.test(src), `${f}: pcc`);
    assert.ok(!/portable-cc/i.test(src), `${f}: portable-cc`);
  }
});

test('agentLabelPattern 시간 상한은 요청마다 하나: 에이전트가 많아도 200 ms 근처에서 이유가 든 오류로 끝남', T, () => {
  const proj = path.join(ROOT, 'many-agents');
  const run = path.join(proj, 'wf', 'run1');
  const ctx = { project: proj, runtime: 'claude', dataDir: path.join(proj, '.omc', 'progress-mon') };
  fs.mkdirSync(run, { recursive: true });
  fs.mkdirSync(ctx.dataDir, { recursive: true });
  // 라벨 하나는 상한 아래(20 ms 이상), 모두 합치면 상한을 크게 넘는 길이와 수를 이 PC 에서 잰다(V8 판과 PC 마다 빠르기가 다름)
  const re = /(?:a+)+$/;
  const cost = (k) => {
    const t = process.hrtime.bigint();
    re.exec('a'.repeat(k) + '!');
    return Number(process.hrtime.bigint() - t) / 1e6;
  };
  let k = 14;
  while (k < 40 && Math.min(cost(k), cost(k)) < 20) k++;
  const each = Math.min(cost(k), cost(k));
  assert.ok(each < 200, `라벨 하나 ${each} ms`);
  const many = Math.min(300, Math.ceil(1500 / each));
  const slow = 'a'.repeat(k) + '!';
  const lines = [];
  for (let i = 0; i < many; i++) {
    lines.push(JSON.stringify({ type: 'started', key: `k${i}`, agentId: `a${i}`, label: slow }));
    fs.writeFileSync(path.join(run, `agent-a${i}.jsonl`), '{}\n');
  }
  fs.writeFileSync(path.join(run, 'journal.jsonl'), lines.join('\n') + '\n');
  const { config } = validate({ stories: [{ id: 'S1', name: '하나' }], agentLabelPattern: '(?:a+)+$', sources: { git: false, workflowDirs: ['wf'] } }, proj);
  const t0 = Date.now();
  assert.throws(() => renderTab(ctx, config, 'history', Date.now()), /agentLabelPattern 가 200 ms 안에 끝나지 않음/);
  assert.ok(Date.now() - t0 < 3000, `${Date.now() - t0} ms`);
  const ok = validate({ stories: [{ id: 'S1', name: '하나' }], agentLabelPattern: 'S\\d+', sources: { git: false, workflowDirs: ['wf'] } }, proj).config;
  fs.writeFileSync(path.join(run, 'journal.jsonl'), JSON.stringify({ type: 'started', key: 'k', agentId: 'a0', label: 'impl-S1-r1' }) + '\n');
  assert.match(renderTab(ctx, ok, 'history', Date.now()), /진행 중/);
});
