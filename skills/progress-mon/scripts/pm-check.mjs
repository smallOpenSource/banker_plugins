// pm-check.mjs: 자료 파일 검사(계획 6.3절, 4.9절). 한 줄에 하나씩 `FAIL <파일> <json 경로> <이유>` 또는 `WARN ...`,
// 끝에 `check: FAIL n, WARN m`. FAIL 이 있으면 종료 1. 자료 폴더를 만들지 않는다.
// 구성도와 workflow 기하는 렌더와 같은 배치 계산(archLayout, archFlaws, flowLayout)에 검사한다.
// 밀도(4.9절)는 init 이 만든 자료 폴더(state.json 의 memory)나 inventory.json 이 있을 때만 재고, 미달은 WARN(종료 코드 영향 없음).
// 항목마다 재는 밀도 미달 줄은 끝에 못 채운 대상 이름을 붙인다(`: a, b 외 n`).
// 끝에 `density <탭> ok|low` 4줄. 형식 시험 자료와 옮긴 자료(둘 다 init 기록 없음)는 밀도를 재지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, noBom, UsageError } from './pm-config.mjs';
import { readItems, storyList, workflowRoots } from './pm-sources.mjs';
import { ITEM_STATUS, STAGE_STATUS } from './pm-data.mjs';
import { archLayout, archFlaws, flowLayout, nameFits, FLOW } from './pm-render.mjs';
import { color, finite, textW, wrap, TABS } from './pm-html.mjs';
import { memoryWarnings } from './pm-memory.mjs';

const arr = (v) => (Array.isArray(v) ? v : []);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const str = (v) => typeof v === 'string' && v.length > 0;
const REQ_STATES = ['done', 'part', 'doing', 'todo', 'unv', 'excl', 'none'];
const EDGE_KINDS = ['api', 'control', 'data'];
// 크기 지침(4.5절). 넘으면 WARN.
const SIZE = { lanes: 6, steps: 15, nodes: 60, edges: 60 };
// 밀도 하한(4.9절).
const DENSITY = { zones: 5, nodes: 20, edges: 15, legend: 1, main: 1, scenes: 5, lanes: 2, steps: 7 };
// 분기 표가 오른쪽 이웃 칸으로 들어가는 폭(상자 폭 + 칸 사이 - 표 시작 20).
const BRANCH_ROOM = FLOW.FW + FLOW.FGX - 20;

// 두 사각형이 가로와 세로 모두 1 px 이상 겹침. 변이 닿기만 하면 겹침 아님.
const ov = (a0, a1, b0, b1) => Math.min(a1, b1) - Math.max(a0, b0);
const hit = (a, b) => ov(a.x, a.x + a.w, b.x, b.x + b.w) >= 1 && ov(a.y, a.y + a.h, b.y, b.y + b.h) >= 1;
const insideRect = (n, z) => n.x >= z.x && n.y >= z.y && n.x + n.w <= z.x + z.w && n.y + n.h <= z.y + z.h;

// JSON 파일 읽기. 돌려줌: { missing } | { value } | { error }
function readJson(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return e.code === 'ENOENT' ? { missing: true } : { error: `읽기 실패(${e.code || 'error'})` };
  }
  try {
    return { value: JSON.parse(noBom(text)) };
  } catch (e) {
    return { error: `JSON 아님: ${e.message}` };
  }
}

// 검사 결과 모음. 파일마다 FAIL, WARN 줄.
function sink() {
  const lines = [];
  const add = (level) => (file, p, msg) => lines.push({ level, file, path: p || '$', msg });
  return { lines, fail: add('FAIL'), warn: add('WARN') };
}

// ---------- config.json ----------

function checkConfig(ctx, r) {
  const { config, errors } = loadConfig(ctx);
  for (const e of errors) r.fail('config.json', e.path === '$' ? '$' : e.path.replace(/^\$\./, ''), e.msg);
  config.stories.forEach((s, i) => {
    if (s.id.includes('-')) r.warn('config.json', `stories[${i}].id`, `id 에 - 가 있어 에이전트 라벨 토큰 판정이 안 됨: ${s.id}. agentLabelPattern 을 쓰거나 id 를 바꿈`);
  });
  return config;
}

// ---------- items.json ----------

function checkItems(dir, r) {
  const got = readJson(path.join(dir, 'items.json'));
  if (got.missing) return;
  const F = 'items.json';
  if (got.error) return r.fail(F, '$', got.error);
  const v = obj(got.value);
  if (!v) return r.fail(F, '$', '객체가 아님');
  for (const k of ['notes', 'storyCommits', 'storyStates']) if (v[k] !== undefined && !obj(v[k])) r.fail(F, k, '객체가 아님');
  for (const k of ['items', 'stageEvents']) if (v[k] !== undefined && !Array.isArray(v[k])) r.fail(F, k, '배열이 아님');
  for (const [k, n] of Object.entries(obj(v.notes) || {})) {
    if (!obj(n)) r.fail(F, `notes.${k}`, '객체가 아님');
    else for (const f of ['note', 'issue']) if (n[f] !== undefined && typeof n[f] !== 'string') r.fail(F, `notes.${k}.${f}`, '문자열이 아님');
  }
  arr(v.items).forEach((x, i) => {
    const p = `items[${i}]`;
    if (!obj(x)) return r.fail(F, p, '객체가 아님');
    if (!ITEM_STATUS.includes(x.status)) r.fail(F, `${p}.status`, `todo, doing, done 가운데 하나가 아님: ${x.status}`);
    if (typeof x.text !== 'string') r.fail(F, `${p}.text`, '문자열이 아님');
    for (const f of ['key', 't', 's', 'note', 'issue', 'hash']) if (x[f] !== undefined && typeof x[f] !== 'string') r.fail(F, `${p}.${f}`, '문자열이 아님');
    if (typeof x.hash === 'string' && !/^[0-9a-f]{7,40}$/i.test(x.hash)) r.fail(F, `${p}.hash`, `7~40자 16진 해시가 아님: ${x.hash}`);
  });
  for (const [id, c] of Object.entries(obj(v.storyCommits) || {})) {
    if (typeof c !== 'string' && !(obj(c) && typeof c.hash === 'string')) r.fail(F, `storyCommits.${id}`, '해시 문자열 또는 {hash} 가 아님');
  }
  for (const [id, s] of Object.entries(obj(v.storyStates) || {})) {
    if (!obj(s) || !ITEM_STATUS.includes(s.status)) r.fail(F, `storyStates.${id}`, '{status: todo|doing|done} 가 아님');
  }
  arr(v.stageEvents).forEach((e, i) => {
    if (!obj(e) || !str(e.stage) || !STAGE_STATUS.includes(e.status)) r.fail(F, `stageEvents[${i}]`, '{t, stage, status: started|done|skipped|failed|stopped} 가 아님');
  });
}

// ---------- 구현요건 ----------

function checkReq(dir, r, storyIds) {
  const spec = readJson(path.join(dir, 'req-spec.json'));
  const reqs = readJson(path.join(dir, 'reqs.json'));
  const S = 'req-spec.json';
  const Q = 'reqs.json';
  let acIds = null;
  const acStories = new Map();
  if (reqs.error) r.fail(Q, '$', reqs.error);
  else if (reqs.value !== undefined) {
    const v = obj(reqs.value);
    if (!v) r.fail(Q, '$', '객체가 아님');
    else if (!Array.isArray(v.acs)) r.fail(Q, 'acs', '배열이 아님');
    else {
      acIds = new Set();
      const known = new Set([...storyIds, ...Object.keys(obj(spec.value && spec.value.stories) || {})]);
      v.acs.forEach((a, i) => {
        if (!obj(a) || !str(a.id)) return r.fail(Q, `acs[${i}]`, 'id 가 없음');
        if (acIds.has(a.id)) r.fail(Q, `acs[${i}].id`, `id 겹침: ${a.id}`);
        acIds.add(a.id);
        if (a.stories !== undefined && !(Array.isArray(a.stories) && a.stories.every(str))) return r.fail(Q, `acs[${i}].stories`, '문자열 배열이 아님');
        acStories.set(a.id, arr(a.stories));
        for (const s of arr(a.stories)) if (!known.has(s)) r.fail(Q, `acs[${i}].stories`, `스토리 없음: ${s}`);
      });
    }
  }
  if (spec.missing) return { users: [], specs: [], acStories };
  if (spec.error) {
    r.fail(S, '$', spec.error);
    return { users: [], specs: [], acStories };
  }
  const v = obj(spec.value);
  if (!v) {
    r.fail(S, '$', '객체가 아님');
    return { users: [], specs: [], acStories };
  }
  if (!Array.isArray(v.users)) r.fail(S, 'users', '배열이 아님');
  if (v.stories !== undefined && !obj(v.stories)) r.fail(S, 'stories', '객체가 아님');
  if (reqs.missing && arr(v.users).some((u) => arr(obj(u) && u.specs).some((x) => arr(obj(x) && x.acs).length))) r.warn(Q, '$', '파일 없음. 근거 AC 의 담당 스토리를 알 수 없어 미검증으로 판정');
  const specs = [];
  // 밀도 미달 줄에 쓰는 json 경로(요구, 명세 객체마다).
  const where = new Map();
  arr(v.users).forEach((u, ui) => {
    const p = `users[${ui}]`;
    if (!obj(u)) return r.fail(S, p, '객체가 아님');
    where.set(u, p);
    if (typeof u.text !== 'string') r.fail(S, `${p}.text`, '문자열이 아님');
    if (!Array.isArray(u.specs)) return r.fail(S, `${p}.specs`, '배열이 아님');
    u.specs.forEach((x, si) => {
      const q = `${p}.specs[${si}]`;
      if (!obj(x)) return r.fail(S, q, '객체가 아님');
      if (typeof x.text !== 'string') r.fail(S, `${q}.text`, '문자열이 아님');
      if (x.acs !== undefined && !(Array.isArray(x.acs) && x.acs.every(str))) return r.fail(S, `${q}.acs`, '문자열 배열이 아님');
      if (x.state !== undefined && !REQ_STATES.includes(x.state)) r.fail(S, `${q}.state`, `${REQ_STATES.join(', ')} 가운데 하나가 아님: ${x.state}`);
      if (acIds) for (const a of arr(x.acs)) if (!acIds.has(a)) r.fail(S, `${q}.acs`, `AC 없음: ${a}`);
      specs.push(x);
      where.set(x, q);
    });
  });
  return { users: arr(v.users).filter(obj), specs, acStories, where };
}

// ---------- workflow ----------

function checkFlow(dir, r) {
  const got = readJson(path.join(dir, 'flow.json'));
  const F = 'flow.json';
  if (got.missing) return null;
  if (got.error) return r.fail(F, '$', got.error), null;
  const f = obj(got.value);
  if (!f) return r.fail(F, '$', '객체가 아님'), null;
  if (!Array.isArray(f.lanes)) return r.fail(F, 'lanes', '배열이 아님'), null;
  if (f.lanes.length > SIZE.lanes) r.warn(F, 'lanes', `크기 지침 초과: 흐름 ${f.lanes.length} > ${SIZE.lanes}`);
  const laneIds = new Map();
  let broken = false;
  f.lanes.forEach((l, li) => {
    const p = `lanes[${li}]`;
    if (!obj(l)) return r.fail(F, p, '객체가 아님'), (broken = true);
    if (!str(l.id)) r.fail(F, `${p}.id`, '빈 문자열이 아닌 문자열이 아님');
    else if (laneIds.has(l.id)) r.fail(F, `${p}.id`, `id 겹침: ${l.id}`);
    if (typeof l.title !== 'string') r.fail(F, `${p}.title`, '문자열이 아님');
    if (l.color !== undefined && !color(l.color, '')) r.fail(F, `${p}.color`, `#rrggbb 가 아님: ${l.color}`);
    if (!Array.isArray(l.steps)) return r.fail(F, `${p}.steps`, '배열이 아님'), (broken = true);
    if (l.steps.length > SIZE.steps) r.warn(F, `${p}.steps`, `크기 지침 초과: 단계 ${l.steps.length} > ${SIZE.steps}`);
    const ids = new Set();
    l.steps.forEach((s, si) => {
      const q = `${p}.steps[${si}]`;
      if (!obj(s) || !str(s.id)) return r.fail(F, q, 'id 가 없음'), (broken = true);
      if (ids.has(s.id)) r.fail(F, `${q}.id`, `id 겹침: ${s.id}`);
      ids.add(s.id);
      for (const k of ['label', 'detail', 'actor']) if (typeof s[k] !== 'string') r.fail(F, `${q}.${k}`, '문자열이 아님');
      if (s.refs !== undefined && !(Array.isArray(s.refs) && s.refs.every((x) => typeof x === 'string'))) r.fail(F, `${q}.refs`, '문자열 배열이 아님');
    });
    if (str(l.id)) laneIds.set(l.id, ids);
    for (const [key, ends] of [['branches', ['from', 'to']], ['externals', ['linkTo']]]) {
      if (l[key] === undefined) continue;
      if (!Array.isArray(l[key])) return r.fail(F, `${p}.${key}`, '배열이 아님'), (broken = true);
      l[key].forEach((b, bi) => {
        const q = `${p}.${key}[${bi}]`;
        if (!obj(b)) return r.fail(F, q, '객체가 아님'), (broken = true);
        for (const k of ends) {
          // 분기 to 가 빈 문자열이면 흐름 끝(종료)
          if (k === 'to' && (b.to === '' || b.to === undefined)) continue;
          if (!ids.has(b[k])) r.fail(F, `${q}.${k}`, `단계 없음: ${b[k]}`);
        }
        const text = key === 'branches' ? 'when' : 'label';
        if (typeof b[text] !== 'string') r.fail(F, `${q}.${text}`, '문자열이 아님');
      });
    }
  });
  arr(f.scenes).forEach((s, i) => {
    const q = `scenes[${i}]`;
    if (!obj(s)) return r.fail(F, q, '객체가 아님');
    if (s.sec !== undefined && !(finite(s.sec) && s.sec >= 0)) r.fail(F, `${q}.sec`, '0 이상 수가 아님');
    // lane 이 없거나 빈 문자열이면 전체(렌더의 "전체")
    const all = s.lane === undefined || s.lane === '';
    if (!all && !laneIds.has(s.lane)) return r.fail(F, `${q}.lane`, `흐름 없음: ${s.lane}`);
    const ids = all ? new Set([...laneIds.values()].flatMap((x) => [...x])) : laneIds.get(s.lane);
    for (const x of arr(s.focus)) if (!ids.has(x)) r.fail(F, `${q}.focus`, `단계 없음: ${x}`);
  });
  if (broken) return null;
  f.lanes.forEach((l, li) => flowGeometry(l, li, r));
  return f;
}

// workflow 기하(6.3절 표). 렌더와 같은 배치(flowLayout: 간격 확장, 이름 줄바꿈 뒤)에 검사한다.
function flowGeometry(l, li, r) {
  const F = 'flow.json';
  const L = flowLayout(l);
  const { FW } = FLOW;
  const steps = arr(l.steps);
  const box = (i) => ({ x: L.pos[i].x, y: L.pos[i].y, w: FW, h: L.hs[i] });
  const brRect = (q) => ({ x: q.x, y: q.y, w: q.w, h: 20 });
  const exRect = (q) => ({ x: q.x, y: q.y, w: q.w, h: 18 });
  const bp = (q) => `lanes[${li}].branches[${arr(l.branches).indexOf(q.b)}]`;
  const ep = (q) => `lanes[${li}].externals[${arr(l.externals).indexOf(q.e)}]`;
  const stepId = (i) => steps[i].id;
  for (const q of L.branches) {
    const rr = brRect(q);
    const row = L.pos[q.i].r;
    for (let i = 0; i < L.n; i++) if (L.pos[i].r > row && hit(rr, box(i))) r.fail(F, bp(q), `분기 표가 아래 줄 상자와 겹침: ${stepId(q.i)}, ${stepId(i)}`);
    for (const x of L.externals) if (hit(rr, exRect(x))) r.fail(F, bp(q), `외부 표와 분기 표 겹침: ${stepId(q.i)}, ${x.e.id}`);
    for (const o of L.branches) {
      if (o.i === q.i) continue;
      const line = { x: o.sx - 0.5, y: o.y0, w: 1, h: o.cy - o.y0 };
      if (hit(rr, brRect(o)) || (o.sx > rr.x && o.sx < rr.x + rr.w && ov(rr.y, rr.y + rr.h, line.y, line.y + line.h) >= 1)) {
        r.fail(F, bp(q), `분기 표가 이웃 칸 분기와 겹침: ${stepId(q.i)}, ${stepId(o.i)}`);
        break;
      }
    }
    const right = L.pos.some((p) => p.r === row && p.x === L.pos[q.i].x + FW + FLOW.FGX);
    if (q.w > BRANCH_ROOM && right) r.warn(F, bp(q), `분기 표 폭 ${Math.round(q.w)} px 가 ${BRANCH_ROOM} px 를 넘어 오른쪽 칸으로 들어감: ${stepId(q.i)}`);
  }
  const extOf = new Map();
  for (const x of L.externals) {
    if (!extOf.has(x.i)) extOf.set(x.i, []);
    extOf.get(x.i).push(x);
    for (const o of L.externals) if (o.i !== x.i && L.externals.indexOf(o) > L.externals.indexOf(x) && hit(exRect(x), exRect(o))) r.fail(F, ep(o), `외부 표가 이웃 칸 외부 표와 겹침: ${o.e.id}, ${x.e.id}`);
  }
  for (const [i, xs] of extOf) {
    const last = xs[xs.length - 1];
    const span = last.x + last.w - xs[0].x;
    if (span > FW) r.warn(F, ep(xs[0]), `외부 표 합계 폭 ${Math.round(span)} px 가 상자 폭 ${FW} px 를 넘음: ${stepId(i)}`);
  }
  steps.forEach((s, i) => {
    const nm = L.names[i];
    const p = `lanes[${li}].steps[${i}]`;
    // 이름 둘째 줄(기준선 37)과 설명 첫 줄(기준선 42 + 내림)의 글 상자(기준선 위 11, 아래 3)
    if (nm.length > 1 && L.descs[i].length && 42 + L.downs[i] - 37 < 14) r.fail(F, p, `이름 둘째 줄과 설명 첫 줄 겹침: ${s.id}`);
    if (nm.some((t) => !nameFits(t, s.planned))) r.warn(F, `${p}.label`, `단계 이름 넘침(두 줄로도 넘침): ${s.id}`);
  });
}

// ---------- 구성도 ----------

function anyCoord(f) {
  if (f.width !== undefined || f.height !== undefined) return true;
  for (const x of [...arr(f.zones), ...arr(f.nodes)]) if (obj(x) && ['x', 'y', 'w', 'h'].some((k) => x[k] !== undefined)) return true;
  return arr(f.edges).some((e) => obj(e) && ['via', 'lx', 'ly', 'off', 'offTo'].some((k) => e[k] !== undefined));
}

function checkArch(dir, r, prefix) {
  const got = readJson(path.join(dir, 'arch.json'));
  const F = 'arch.json';
  if (got.missing) return null;
  if (got.error) return r.fail(F, '$', got.error), null;
  const f = obj(got.value);
  if (!f) return r.fail(F, '$', '객체가 아님'), null;
  for (const k of ['zones', 'nodes', 'edges']) if (f[k] !== undefined && !Array.isArray(f[k])) return r.fail(F, k, '배열이 아님'), null;
  for (const k of ['legend', 'main', 'scenes']) if (f[k] !== undefined && !Array.isArray(f[k])) r.fail(F, k, '배열이 아님');
  const zones = arr(f.zones);
  const nodes = arr(f.nodes);
  const edges = arr(f.edges);
  let broken = false;
  const zoneIds = new Set();
  zones.forEach((z, i) => {
    if (!obj(z) || !str(z.id)) return r.fail(F, `zones[${i}]`, 'id 가 없음'), (broken = true);
    if (zoneIds.has(z.id)) r.fail(F, `zones[${i}].id`, `id 겹침: ${z.id}`);
    zoneIds.add(z.id);
    if (typeof z.label !== 'string') r.fail(F, `zones[${i}].label`, '문자열이 아님');
    if (z.color !== undefined && !color(z.color, '')) r.fail(F, `zones[${i}].color`, `#rrggbb 가 아님: ${z.color}`);
  });
  const nodeIds = new Set();
  nodes.forEach((n, i) => {
    if (!obj(n) || !str(n.id)) return r.fail(F, `nodes[${i}]`, 'id 가 없음'), (broken = true);
    if (nodeIds.has(n.id)) r.fail(F, `nodes[${i}].id`, `id 겹침: ${n.id}`);
    nodeIds.add(n.id);
    if (typeof n.label !== 'string') r.fail(F, `nodes[${i}].label`, '문자열이 아님');
    if (!zoneIds.has(n.zone)) r.fail(F, `nodes[${i}].zone`, `영역 없음: ${n.zone}`);
    if (n.color !== undefined && !color(n.color, '')) r.fail(F, `nodes[${i}].color`, `#rrggbb 가 아님: ${n.color}`);
    if (n.lines !== undefined && !(Number.isInteger(n.lines) && n.lines >= 1)) r.fail(F, `nodes[${i}].lines`, '1 이상 정수가 아님');
    if (n.items !== undefined && !(Array.isArray(n.items) && n.items.every((t) => typeof t === 'string'))) r.fail(F, `nodes[${i}].items`, '문자열 배열이 아님');
  });
  const edgeIds = new Set();
  edges.forEach((e, i) => {
    if (!obj(e)) return r.fail(F, `edges[${i}]`, '객체가 아님'), (broken = true);
    const id = e.id || `${e.from}-${e.to}`;
    if (edgeIds.has(id)) r.fail(F, `edges[${i}].id`, `id 겹침: ${id}`);
    edgeIds.add(id);
    for (const k of ['from', 'to']) if (!nodeIds.has(e[k]) && !zoneIds.has(e[k])) r.fail(F, `edges[${i}].${k}`, `연결 끝 없음: ${id}, ${e[k]}`);
    // 자기 연결은 그릴 길이 없다(화면에는 길이 0 인 선).
    if (e.from === e.to && (nodeIds.has(e.from) || zoneIds.has(e.from))) r.warn(F, `edges[${i}]`, `자기 연결(from 과 to 가 같음): ${id}`);
    if (e.kind !== undefined && !EDGE_KINDS.includes(e.kind)) r.fail(F, `edges[${i}].kind`, `api, control, data 가운데 하나가 아님: ${e.kind}`);
    if (e.color !== undefined && !color(e.color, '')) r.fail(F, `edges[${i}].color`, `#rrggbb 가 아님: ${e.color}`);
  });
  arr(f.scenes).forEach((s, i) => {
    if (!obj(s)) return r.fail(F, `scenes[${i}]`, '객체가 아님');
    if (s.sec !== undefined && !(finite(s.sec) && s.sec >= 0)) r.fail(F, `scenes[${i}].sec`, '0 이상 수가 아님');
    for (const x of arr(s.focus)) if (!nodeIds.has(x) && !edgeIds.has(x)) r.fail(F, `scenes[${i}].focus`, `장면 대상 없음: ${x}`);
  });
  arr(f.main).forEach((m, i) => {
    if (!nodeIds.has(m)) r.fail(F, `main[${i}]`, `구성요소 없음: ${m}`);
  });
  if (nodes.length > SIZE.nodes) r.warn(F, 'nodes', `크기 지침 초과: 상자 ${nodes.length} > ${SIZE.nodes}`);
  if (edges.length > SIZE.edges) r.warn(F, 'edges', `크기 지침 초과: 연결 ${edges.length} > ${SIZE.edges}`);
  if (broken) return null;
  const L = archLayout(f, prefix);
  if (L.auto && anyCoord(f)) r.warn(F, L.missing, '좌표 일부가 빠지거나 틀려 그림 전체를 자동 배치');
  archGeometry(f, L, r, prefix);
  return { f, L };
}

// 구성도 기하 5종(6.3절 표). 좌표 사용이면 모두 FAIL, 자동 배치면 선과 이름표는 WARN.
function archGeometry(f, L, r, prefix) {
  const F = 'arch.json';
  const nodes = arr(f.nodes);
  const soft = L.auto ? r.warn : r.fail;
  const zoneOf = (n) => L.zone.get(n.zone);
  nodes.forEach((n, i) => {
    const b = L.node.get(n.id);
    const p = `nodes[${i}]`;
    const z = zoneOf(n);
    if (z && !insideRect(b, z)) r.fail(F, p, `영역 밖: ${n.id}, ${n.zone}`);
    if (b.x < 0 || b.y < 0 || b.x + b.w > L.width || b.y + b.h > L.height) r.fail(F, p, `그림 밖: ${n.id}`);
    const tag = n.planned ? textW(prefix) + 8 : 0;
    if (textW(n.label) * 1.15 + 8 + tag > b.w) r.fail(F, p, `글 넘침: ${n.id} 이름`);
    const all = wrap(n.detail, b.w - 16);
    const sub = all.slice(0, n.lines || 2);
    if (sub.some((t) => textW(t) * 1.1 > b.w - 12)) r.fail(F, p, `글 넘침: ${n.id} 설명`);
    if (all.length > sub.length) r.warn(F, p, `설명 잘림: ${n.id} (${all.length}줄 > ${sub.length}줄). lines 를 늘리거나 설명을 줄임`);
    let cx = b.x + 8;
    let cy = b.y + 26 + sub.length * 14 + 4;
    let bottom = b.y + 34 + (sub.length - 1) * 14 + 4;
    for (const t of arr(n.items)) {
      const w = textW(t) + 12;
      if (cx + w > b.x + b.w - 6) {
        cx = b.x + 8;
        cy += 19;
      }
      if (w > b.w - 14) r.fail(F, p, `글 넘침: ${n.id} 칩 ${t}`);
      cx += w + 4;
      bottom = cy + 16;
    }
    if (bottom > b.y + b.h - 2) r.fail(F, p, `글 넘침: ${n.id} 내용이 상자 아래로 넘침`);
    for (let j = 0; j < i; j++) if (hit(b, L.node.get(nodes[j].id))) r.fail(F, p, `상자 겹침: ${n.id}, ${nodes[j].id}`);
  });
  const zones = arr(f.zones);
  zones.forEach((z, i) => {
    for (let j = 0; j < i; j++) if (hit(L.zone.get(z.id), L.zone.get(zones[j].id))) r.fail(F, `zones[${i}]`, `영역 겹침: ${z.id}, ${zones[j].id}`);
  });
  const edges = arr(f.edges);
  const msg = { cross: (x) => `선이 상자 지남: ${x.g.id}, ${x.id}`, out: (x) => `이름표가 그림 밖: ${x.g.id}`, cover: (x) => `이름표 덮음: ${x.g.id}, ${x.id}` };
  for (const x of archFlaws(f, L)) soft(F, `edges[${edges.indexOf(x.g.e0)}]`, msg[x.kind](x));
}

// ---------- inventory.json ----------

function checkInventory(ctx, r) {
  const got = readJson(path.join(ctx.dataDir, 'inventory.json'));
  const F = 'inventory.json';
  if (got.missing) return null;
  if (got.error) return r.fail(F, '$', got.error), null;
  const v = obj(got.value);
  if (!v) return r.fail(F, '$', '객체가 아님'), null;
  // 근거 경로는 프로젝트 루트 기준. `파일:줄` 이면 줄 번호를 뗀다.
  const exists = (p) => str(p) && fs.existsSync(path.resolve(ctx.project, p.replace(/:\d+(?:-\d+)?$/, '')));
  for (const [key, field] of [['components', 'path'], ['flows', 'evidence'], ['externals', 'evidence']]) {
    if (!Array.isArray(v[key])) {
      r.fail(F, key, '배열이 아님');
      continue;
    }
    v[key].forEach((x, i) => {
      if (!obj(x)) return r.fail(F, `${key}[${i}]`, '객체가 아님');
      if (!exists(x[field])) r.fail(F, `${key}[${i}].${field}`, `경로 없음: ${x[field]}`);
      if (key === 'flows' && !(Number.isInteger(x.steps) && x.steps >= 0)) r.fail(F, `${key}[${i}].steps`, '0 이상 정수가 아님');
    });
  }
  if (v.read !== undefined && !Array.isArray(v.read)) r.fail(F, 'read', '배열이 아님');
  return { components: arr(v.components).length, flows: arr(v.flows).map((x) => (obj(x) && Number.isInteger(x.steps) ? x.steps : 0)) };
}

// ---------- 밀도(4.9절) ----------

const sentences = (t) => String(t || '').split(/\.\s+/).filter((x) => x.trim()).length;
const lines23 = (n) => n >= 2 && n <= 3;

// 돌려줌: { rows: [{tab, item, value, min, miss}], low: Set(탭) }. value < min 이면 미달.
// miss 는 항목마다 재는 줄(상자, 단계, 흐름, 명세, 기타 항목)에서 기준을 못 채운 대상 이름. 수만 재는 줄은 빈 배열.
export function density({ arch, flow, req, items, inv, storyCount }) {
  const rows = [];
  const add = (tab, item, value, min, miss = []) => rows.push({ tab, item, value, min, miss });
  // 대상마다 ok 를 재어 값, 하한(대상 수), 못 채운 대상 이름을 한 줄로.
  const each = (tab, item, list, ok, name) => {
    const miss = [];
    list.forEach((x, i) => ok(x) || miss.push(name(x, i)));
    add(tab, item, list.length - miss.length, list.length, miss);
  };
  // 작은 저장소 예외: inventory.json 의 실제 수로 하한을 낮춘다.
  const lim = (base, actual) => (inv ? Math.min(base, actual) : base);
  const f = arch ? arch.f : {};
  const zones = arr(f.zones);
  const nodes = arr(f.nodes);
  const edges = arr(f.edges);
  add('arch', '영역', zones.length, lim(DENSITY.zones, inv && inv.components));
  add('arch', '상자', nodes.length, lim(DENSITY.nodes, inv && inv.components));
  const boxLines = (n) => wrap(n.detail, (arch ? arch.L.node.get(n.id).w : 0) - 16).length;
  each('arch', '상자설명', nodes, (n) => lines23(boxLines(n)), (n) => `${n.id}(${boxLines(n)}줄)`);
  // 연결 하한: inventory.json 이 있으면 arch.json 에 그린 상자 수(nodes) - 1 로 낮춘다.
  add('arch', '연결', edges.length, lim(DENSITY.edges, Math.max(0, nodes.length - 1)));
  each('arch', '연결근거', edges, (e) => arr(e.refs).length, (e) => e.id || `${e.from}-${e.to}`);
  add('arch', '범례', arr(f.legend).length, DENSITY.legend);
  add('arch', '주흐름', arr(f.main).length, DENSITY.main);
  add('arch', '장면', arr(f.scenes).length, DENSITY.scenes);
  const lanes = flow ? arr(flow.lanes) : [];
  const invSteps = inv ? [...inv.flows].sort((a, b) => b - a) : [];
  add('workflow', '흐름', lanes.length, lim(DENSITY.lanes, inv && inv.flows.length));
  // 흐름당 단계: 단계가 많은 흐름부터 inventory 흐름과 짝지어 하한을 낮춘다.
  const byLen = lanes.map((l, i) => ({ l, i })).sort((a, b) => arr(b.l.steps).length - arr(a.l.steps).length || a.i - b.i);
  const bound = new Map(byLen.map((x, k) => [x.l, inv ? Math.min(DENSITY.steps, invSteps[k] ?? invSteps[invSteps.length - 1] ?? 0) : DENSITY.steps]));
  for (const l of lanes) add('workflow', `단계:${l.id}`, arr(l.steps).length, bound.get(l));
  // 단계 이름은 `<흐름 id>/<단계 id>`(단계 id 는 흐름 안에서만 겹치지 않음).
  const steps = lanes.flatMap((l) => arr(l.steps).map((s) => ({ s, name: `${l.id}/${s.id}` })));
  const stepLines = (x) => wrap(x.s.detail, FLOW.FW - 20).length;
  each('workflow', '단계설명', steps, (x) => lines23(stepLines(x)), (x) => `${x.name}(${stepLines(x)}줄)`);
  each('workflow', '행위자', steps, (x) => str(x.s.actor), (x) => x.name);
  each('workflow', '단계근거', steps, (x) => arr(x.s.refs).length, (x) => x.name);
  each('workflow', '실패분기', lanes, (l) => arr(l.branches).length, (l) => l.id);
  each('workflow', '외부', lanes, (l) => arr(l.externals).length, (l) => l.id);
  each('workflow', '흐름설명', lanes, (l) => sentences(l.note) >= 3, (l) => `${l.id}(${sentences(l.note)}문장)`);
  const at = (x, alt) => (req.where && req.where.get(x)) || alt;
  if (req.users.length) each('req', '요구', req.users, (u) => str(u.text) && str(u.source), (u, i) => at(u, `users[${i}]`));
  else add('req', '요구', 0, 1);
  const specName = (x, i) => at(x, `specs[${i}]`);
  each('req', '명세AC', req.specs, (x) => arr(x.acs).length, specName);
  if (storyCount) each('req', '명세스토리', req.specs, (x) => arr(x.acs).some((a) => arr(req.acStories.get(a)).length), specName);
  const stated = req.specs.filter((x) => x.state !== undefined);
  each('req', '비고', stated, (x) => str(x.note), (x) => at(x, `specs[${req.specs.indexOf(x)}]`));
  each('history', '비고', items, (x) => str(x.note), (x, i) => (str(x.key) ? x.key : `items[${i}]`));
  return { rows, low: new Set(rows.filter((x) => x.value < x.min).map((x) => x.tab)) };
}

// 밀도 미달 줄. 못 채운 대상이 있으면 `: ` 뒤에 앞 10개, 넘으면 `외 n`.
const MISS_MAX = 10;
export function densityLine(x) {
  const head = `WARN density ${x.tab} ${x.item} ${x.value}/${x.min}`;
  const miss = arr(x.miss);
  if (!miss.length) return head;
  const more = miss.length > MISS_MAX ? ` 외 ${miss.length - MISS_MAX}` : '';
  return `${head}: ${miss.slice(0, MISS_MAX).join(', ')}${more}`;
}

// ---------- 실행 ----------

// 검사 전체. 돌려줌: { lines: [출력 줄], fails }
export function runCheck(ctx, env = process.env) {
  const r = sink();
  const config = checkConfig(ctx, r);
  checkItems(ctx.dataDir, r);
  const items = readItems(ctx.dataDir);
  const ids = storyList(config, items).map((s) => s.id);
  const req = checkReq(ctx.dataDir, r, ids);
  const flow = checkFlow(ctx.dataDir, r);
  const arch = checkArch(ctx.dataDir, r, config.text.plannedPrefix);
  const inv = checkInventory(ctx, r);
  let state = null;
  try {
    state = obj(JSON.parse(fs.readFileSync(path.join(ctx.dataDir, 'state.json'), 'utf8')));
  } catch {
    state = null;
  }
  const memory = state && obj(state.memory);
  // 경고 줄에 뒤따르는 대안 줄을 붙여 WARN 한 줄로.
  for (const l of memoryWarnings(memory, ctx.project, env)) {
    if (l.startsWith('경고: ')) r.warn('state.json', 'memory', l.slice(4));
    else if (r.lines.length) r.lines[r.lines.length - 1].msg += `. ${l}`;
  }
  const out = r.lines.map((x) => `${x.level} ${x.file} ${x.path} ${x.msg}`);
  if (config.sources.workflowDirs === 'auto' && !workflowRoots(config, ctx, env).length) out.push('WARN workflowDirs auto: 찾은 폴더 0');
  let dens = null;
  if (inv || memory) {
    dens = density({ arch, flow, req, items: items.items, inv, storyCount: ids.length });
    for (const x of dens.rows) if (x.value < x.min) out.push(densityLine(x));
  }
  const fails = out.filter((l) => l.startsWith('FAIL ')).length;
  out.push(`check: FAIL ${fails}, WARN ${out.length - fails}`);
  if (dens) for (const [k] of TABS) out.push(`density ${k} ${dens.low.has(k) ? 'low' : 'ok'}`);
  return { lines: out, fails };
}

export async function command(cmd, ctx, o, io) {
  if (cmd !== 'check') throw new UsageError(`${cmd} 는 pm-check.mjs 가 맡지 않음`);
  if (o._.length > 1) throw new UsageError(`check 는 위치 인자를 받지 않음: ${o._.slice(1).join(' ')}`);
  const { lines, fails } = runCheck(ctx);
  for (const l of lines) io.out(l);
  return fails ? 1 : 0;
}
