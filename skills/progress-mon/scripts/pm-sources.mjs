// pm-sources.mjs: 진척도 자료 출처 읽기. events.jsonl, git log, 워크플로 journal, items.json, 탭 자료 JSON.
// 없는 출처는 빈 값. 커밋과 에이전트 라벨 판정 함수 4개, 시각 해석, 읽기 캐시(계획 4.3, 4.6, 4.7절).
// 판정과 렌더는 now 인자만 쓴다. 시각을 직접 재지 않는다(캐시 유효 시간은 단조 시계).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { eventsPath, stagesFor, isDir, noBom, readRegular } from './pm-config.mjs';

// ---------- 시각 ----------

// Z 없는 19자 옛 형식(YYYY-MM-DDTHH:MM:SS)은 현지 시각으로 읽는다(옛 서버의 Date.parse 와 같음). 옛 자료에는 UTC 값을
// Z 없이 쓴 줄도 섞여 있지만 고치지 않는다. 그래야 옛 화면(포트 30000)과 같은 시각이 나온다.
// Z 나 시차(+09:00)가 있으면 그 값 그대로. 읽지 못하면 0.
export function parseTime(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v !== 'string' || !v) return 0;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : 0;
}

// 캐시 유효 시간용 단조 시계(ms). 벽시계가 아니라 판정에 쓰지 않는다.
const mono = () => Number(process.hrtime.bigint() / 1000000n);

// ---------- 파일 읽기 캐시 ----------
// (경로, mtime, 크기)가 같으면 파싱 결과를 다시 쓴다.

const fileCache = new Map();

function cached(file, parse) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    fileCache.delete(file);
    return { missing: true };
  }
  const hit = fileCache.get(file);
  if (hit && hit.parse === parse && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.out;
  let out;
  try {
    const text = readRegular(file);
    out = { value: parse(noBom(text)) };
  } catch (e) {
    out = { error: e instanceof SyntaxError ? 'JSON 아님' : `읽기 실패(${e.code || 'error'})` };
  }
  fileCache.set(file, { parse, mtimeMs: st.mtimeMs, size: st.size, out });
  return out;
}

const parseJson = (t) => JSON.parse(t);
// JSONL: 깨진 줄과 객체가 아닌 줄은 건너뛴다.
const parseLines = (t) =>
  t
    .split('\n')
    .map((l) => {
      try {
        const o = JSON.parse(l);
        return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean);

// JSON 파일. 돌려줌: { value } | { missing: true } | { error }
export const readJsonFile = (file) => cached(file, parseJson);
// JSONL 파일의 객체 줄 목록. 없거나 못 읽으면 빈 목록.
export const readLines = (file) => cached(file, parseLines).value || [];

// ---------- 사용자 정규식 ----------

const REGEX_MS = 200;
const REGEX_INPUT_MAX = 1000;
const regexCtx = vm.createContext({});
const regexRun = new vm.Script(
  '(() => { const re = new RegExp(src); return inputs.map((s) => { const m = re.exec(s); return m ? [m[0], m.groups ? m.groups.id : undefined] : null; }); })()',
);

// 사용자 정규식(commitRegex, agentLabelPattern)을 입력 묶음에 한 번 돌린다. 돌려줌: 입력마다 [일치, 그룹 id] 또는 null.
// 역추적이 폭발하는 정규식이 이벤트 루프를 멈추지 않게 vm 의 시간 제한(REGEX_MS) 안에서만 돌리고, 입력은 앞 REGEX_INPUT_MAX 자만 본다.
// 시간을 넘으면 거짓 판정 대신 예외(서버는 500 과 server.log, 명령은 오류 줄).
export function regexBatch(src, key, inputs) {
  regexCtx.src = src;
  regexCtx.inputs = inputs.map((x) => String(x).slice(0, REGEX_INPUT_MAX));
  try {
    return regexRun.runInContext(regexCtx, { timeout: REGEX_MS });
  } catch (e) {
    if (e && e.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') throw new Error(`${key} 가 ${REGEX_MS} ms 안에 끝나지 않음(역추적이 폭발하는 정규식). config.json 의 ${key} 를 고침`);
    throw e;
  } finally {
    regexCtx.inputs = null;
  }
}

// ---------- 판정 함수(계획 4.3절) ----------

// 커밋 제목마다 스토리(subjectStories 는 묶음, storyOfSubject 는 하나). commitRegex 가 있으면 그룹 id 값이 설정 id 일 때.
// 없으면 설정 id 를 긴 것부터 보아 제목이 id 로 시작하고 뒤가 `:`, `(`, 공백, 또는 소문자 한 자 뒤 `:`, `(`, 공백이면 그 id.
export function subjectStories(subjects, ids, commitRegex) {
  if (!ids.length) return subjects.map(() => null);
  if (commitRegex) {
    const hits = regexBatch(commitRegex, 'commitRegex', subjects.map((s) => (typeof s === 'string' ? s : '')));
    return hits.map((h, i) => (typeof subjects[i] === 'string' && h && h[1] && ids.includes(h[1]) ? h[1] : null));
  }
  const byLength = [...ids].sort((a, b) => b.length - a.length);
  return subjects.map((s) => (typeof s === 'string' ? byLength.find((id) => s.startsWith(id) && /^([:( ]|[a-z][:( ])/.test(s.slice(id.length))) || null : null));
}

export const storyOfSubject = (subject, ids, commitRegex) => subjectStories([subject], ids, commitRegex)[0];

// 스토리 시작 시각용: 라벨을 - 로 나눈 토큰을 왼쪽부터 보아 설정 id 와 정확히 같은 첫 토큰.
export function storyOfStartLabel(label, ids) {
  if (!ids.length) return null;
  for (const tok of String(label || '').split('-')) if (ids.includes(tok)) return tok;
  return null;
}

// 진행 중 스토리용. agentLabelPattern 이 있으면 라벨의 첫 일치 값이 설정 id 일 때.
// 없으면 토큰을 왼쪽부터 보아, 토큰이 id 로 시작하고 바로 뒤가 끝이거나 숫자가 아닌 첫 토큰. 같은 토큰에 둘 이상이면 긴 id.
export function storyOfBusyLabel(label, ids, pattern) {
  if (!ids.length) return null;
  const l = String(label || '');
  if (pattern) {
    const [m] = regexBatch(pattern, 'agentLabelPattern', [l]);
    return m && ids.includes(m[0]) ? m[0] : null;
  }
  for (const tok of l.split('-')) {
    let best = null;
    for (const id of ids) {
      if (!tok.startsWith(id) || /^\d/.test(tok.slice(id.length))) continue;
      if (!best || id.length > best.length) best = id;
    }
    if (best) return best;
  }
  return null;
}

// 에이전트 행 숨김. 패턴이 있으면 라벨에 일치가 있을 때(스토리가 아니어도). 없으면 진행 중 스토리가 있을 때.
export function hiddenAgent(label, ids, pattern) {
  if (pattern) return regexBatch(pattern, 'agentLabelPattern', [String(label || '')])[0] !== null;
  return storyOfBusyLabel(label, ids, null) !== null;
}

// ---------- 단계 ----------

// 단계 기록(events.jsonl 과 items.json 의 stageEvents)을 시각 순으로 한 상태 전이로 합친다.
// 단계마다 { s: doing|done|stopped, t: 완료 시각 또는 시작 시각, start: 첫 시작 시각 }.
export function stageStates(records) {
  const st = {};
  const list = records.map((e, i) => ({ e, i, t: parseTime(e.t) }));
  list.sort((a, b) => a.t - b.t || a.i - b.i);
  for (const { e, t } of list) {
    if (typeof e.stage !== 'string') continue;
    const cur = Object.prototype.hasOwnProperty.call(st, e.stage) ? st[e.stage] : null;
    const start = (cur && cur.start) || (e.status === 'started' ? t : 0);
    if (e.status === 'started') {
      if (!cur || cur.s !== 'done') st[e.stage] = { s: 'doing', t, start };
    } else if (e.status === 'done' || e.status === 'skipped') st[e.stage] = { s: 'done', t, start };
    else if (e.status === 'failed' || e.status === 'stopped') st[e.stage] = { s: 'stopped', t, start };
  }
  return st;
}

// ---------- git ----------

const gitCache = new Map();
const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });

const readText = (p) => {
  try {
    return readRegular(p);
  } catch {
    return null;
  }
};
const HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

// project 에서 위로 올라가며 찾은 .git. 폴더면 그 폴더, 파일(worktree, 하위 모듈)이면 gitdir 값.
// common 은 브랜치와 packed-refs 가 있는 폴더(worktree 는 commondir 값). 없으면 null.
function gitDirs(project) {
  for (let d = path.resolve(project); ; ) {
    const dot = path.join(d, '.git');
    let st = null;
    try {
      st = fs.statSync(dot);
    } catch {
      st = null;
    }
    if (st && st.isDirectory()) return { dir: dot, common: dot };
    if (st && st.isFile()) {
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(readText(dot) || '');
      if (!m) return undefined;
      const dir = path.resolve(d, m[1]);
      const c = readText(path.join(dir, 'commondir'));
      return { dir, common: c ? path.resolve(dir, c.trim()) : dir };
    }
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

// HEAD 커밋 해시를 git 을 띄우지 않고 파일에서 읽는다(요청마다 부르는 캐시 키, 저사양 대상).
// 분리된 HEAD 는 해시 그대로, 브랜치는 느슨한 ref 파일, 없으면 packed-refs.
// 저장소가 아니거나 브랜치에 커밋이 없으면 null. 읽지 못하는 꼴(reftable, 깨진 HEAD 등)은 undefined.
export function gitHead(project) {
  const g = gitDirs(project);
  if (!g) return g;
  const head = readText(path.join(g.dir, 'HEAD'));
  if (head === null || fs.existsSync(path.join(g.common, 'reftable'))) return undefined;
  const t = head.trim();
  if (HASH.test(t)) return t;
  const m = /^ref:\s*(refs\/\S+)$/.exec(t);
  if (!m) return undefined;
  const ref = m[1];
  // worktree 마다 따로인 ref 는 그 worktree 폴더, 그 밖은 공용 폴더.
  const base = /^refs\/(?:bisect|worktree|rewritten)\//.test(ref) ? g.dir : g.common;
  const loose = readText(path.join(base, ...ref.split('/')));
  if (loose !== null) return HASH.test(loose.trim()) ? loose.trim() : undefined;
  const packed = readText(path.join(g.common, 'packed-refs'));
  for (const line of (packed || '').split('\n')) {
    const [h, name] = line.trim().split(' ');
    if (name === ref && HASH.test(h)) return h;
  }
  return null;
}

// git log 원문 줄(%h|%cI|%s). 캐시 키는 HEAD 해시(gitHead, 읽지 못하면 git rev-parse HEAD).
// git log 는 키가 바뀔 때만 띄운다. git 이 없거나 커밋이 없으면 null. HEAD 를 읽었는데 git log 가 실패하면(git 없음 등)
// 그 실패(null)도 같은 키로 캐시해 요청마다 git 을 다시 띄우지 않는다. HEAD 가 바뀌면 다시 띄운다.
export function gitLog(project, max) {
  let head = gitHead(project);
  if (head === undefined) {
    try {
      head = git(project, ['rev-parse', 'HEAD']).trim();
    } catch {
      return null;
    }
  }
  if (!head) return null;
  const key = `${project}\n${head}\n${max}`;
  if (gitCache.has(key)) return gitCache.get(key);
  let lines;
  try {
    lines = git(project, ['log', '-n', String(max), '--format=%h|%cI|%s']).split('\n').filter(Boolean);
  } catch {
    lines = null;
  }
  for (const k of gitCache.keys()) if (k.startsWith(`${project}\n`)) gitCache.delete(k);
  gitCache.set(key, lines);
  return lines;
}

// 해시 앞부분이 같으면 같은 커밋(짧은 쪽 4자 이상).
const sameHash = (a, b) => a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a));

// git log 줄에서 HEAD 표시와 스토리별 마지막 커밋. 제목에 id 가 없는 커밋은 items.json 의 storyCommits {id: 해시}.
// log 에 없는 storyCommits 해시도 완료로 친다(시각은 값의 t, 없으면 0).
export function gitInfo(lines, ids, storyCommits = {}, commitRegex = null) {
  const commits = {};
  const rows = (lines || []).map((l) => l.split('|'));
  const found = subjectStories(rows.map((r) => r[2] || null), ids, commitRegex);
  rows.forEach(([h, t], i) => {
    const id = found[i];
    if (id && !commits[id]) commits[id] = { h, t: Date.parse(t) };
  });
  for (const [id, v] of Object.entries(storyCommits || {})) {
    if (commits[id]) continue;
    const h = typeof v === 'string' ? v : v && typeof v.hash === 'string' ? v.hash : '';
    if (!h) continue;
    const hit = rows.find((r) => sameHash(r[0], h));
    commits[id] = hit ? { h: hit[0], t: Date.parse(hit[1]) } : { h: h.slice(0, 7), t: parseTime(v && v.t) };
  }
  const [h0, , s0] = rows[0] || [];
  return { head: rows.length ? h0 + ' ' + s0 : '-', commits };
}

// ---------- 워크플로 journal ----------

const listDir = (p) => {
  try {
    return fs.readdirSync(p).sort();
  } catch {
    return [];
  }
};

// Claude Code 자동 메모리 slug: 절대 경로의 영문자와 숫자 밖 글자를 - 로.
export const projectSlug = (project) => path.resolve(project).replace(/[^A-Za-z0-9]/g, '-');

// workflows 루트 목록(그 아래 실행 폴더마다 journal.jsonl, agent-<id>.jsonl). 읽기만 한다.
// "auto": CLAUDE_CONFIG_DIR 또는 ~/.claude 의 projects/<slug>/<세션>/subagents/workflows. slug 는 대소문자 무시.
export function workflowRoots(config, ctx, env = process.env) {
  const v = config.sources.workflowDirs;
  // 폴더가 아닌 경로(특수 파일 등)는 listDir 이 빈 목록으로 보고, 그 아래 파일은 readRegular 로만 읽는다
  if (Array.isArray(v)) return v.map((p) => path.resolve(ctx.project, p));
  if (v !== 'auto') return [];
  const base = path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
  const slug = projectSlug(ctx.project).toLowerCase();
  const out = [];
  for (const name of listDir(base)) {
    if (name.toLowerCase() !== slug) continue;
    for (const session of listDir(path.join(base, name))) {
      const root = path.join(base, name, session, 'subagents', 'workflows');
      if (isDir(root)) out.push(root);
    }
  }
  return out;
}

const statOf = (stat, p) => {
  try {
    return stat(p);
  } catch {
    return null;
  }
};

// 끝나지 않은 에이전트(started 뒤 result, failed, error, skipped 없음). journal 이 maxAgeH 시간 넘게,
// agent 파일이 staleMin 분 넘게 멈춘 것은 뺀다. maxSessions 가 0 보다 크면 최근 루트 그 수만.
// stat 은 파일 시각 함수(시험에서 주입). since 는 agent 파일 생성 시각.
export function activeAgents(roots, now, { staleMin = 15, maxAgeH = 24, maxSessions = 0 } = {}, stat = fs.statSync) {
  let use = roots;
  if (maxSessions > 0 && roots.length > maxSessions) {
    use = roots
      .map((r, i) => ({ r, i, t: (statOf(stat, r) || { mtimeMs: 0 }).mtimeMs }))
      .sort((a, b) => b.t - a.t || a.i - b.i)
      .slice(0, maxSessions)
      .map((x) => x.r);
  }
  const out = [];
  for (const root of use) {
    for (const d of listDir(root)) {
      const j = path.join(root, d, 'journal.jsonl');
      const st = statOf(stat, j);
      if (!st || now - st.mtimeMs > maxAgeH * 3600e3) continue;
      const open = new Map();
      for (const o of readLines(j)) {
        if (o.type === 'started') open.set(o.key, o);
        else if (o.key && (o.type === 'result' || o.type === 'failed' || o.type === 'error' || o.type === 'skipped')) open.delete(o.key);
      }
      for (const o of open.values()) {
        const a = statOf(stat, path.join(root, d, `agent-${o.agentId}.jsonl`));
        if (!a || now - a.mtimeMs > staleMin * 60e3) continue;
        out.push({ label: o.label || '?', since: a.birthtimeMs });
      }
    }
  }
  return out;
}

// 진행 중 스캔 캐시: 같은 루트와 설정이면 5초(단조 시계) 안, 같은 now 근처에서 다시 쓴다.
const agentCache = new Map();
function activeAgentsCached(roots, now, opts, stat) {
  if (stat !== fs.statSync) return activeAgents(roots, now, opts, stat);
  const key = JSON.stringify([roots, opts]);
  const hit = agentCache.get(key);
  const m = mono();
  if (hit && m - hit.at < 5000 && Math.abs(now - hit.now) < 5000) return hit.list;
  const list = activeAgents(roots, now, opts, stat);
  agentCache.set(key, { at: m, now, list });
  return list;
}

// 스토리마다 첫 에이전트 시작 시각(agent 파일 생성 시각의 최소). 모든 루트, 상한 없음.
// journal 마다 (mtime, id 목록) 가 같으면 결과를 다시 쓴다.
const startCache = new Map();
export function storyStarts(roots, ids, stat = fs.statSync) {
  const out = {};
  if (!ids.length) return out;
  const idsKey = ids.join('\n');
  for (const root of roots) {
    for (const d of listDir(root)) {
      const j = path.join(root, d, 'journal.jsonl');
      const st = statOf(stat, j);
      if (!st) continue;
      const useCache = stat === fs.statSync;
      const hit = useCache && startCache.get(j);
      let found;
      if (hit && hit.mtimeMs === st.mtimeMs && hit.idsKey === idsKey) found = hit.found;
      else {
        found = {};
        for (const o of readLines(j)) {
          const id = o.type === 'started' && storyOfStartLabel(o.label, ids);
          if (!id) continue;
          const a = statOf(stat, path.join(root, d, `agent-${o.agentId}.jsonl`));
          if (!a) continue;
          if (!(id in found) || a.birthtimeMs < found[id]) found[id] = a.birthtimeMs;
        }
        if (useCache) startCache.set(j, { mtimeMs: st.mtimeMs, idsKey, found });
      }
      for (const [id, b] of Object.entries(found)) if (!(id in out) || b < out[id]) out[id] = b;
    }
  }
  return out;
}

// ---------- 모아 읽기 ----------

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

// items.json. 없거나 깨졌으면 빈 값.
export function readItems(dataDir) {
  const r = readJsonFile(path.join(dataDir, 'items.json'));
  const v = obj(r.value);
  return {
    notes: obj(v.notes),
    items: Array.isArray(v.items) ? v.items.filter((x) => x && typeof x === 'object') : [],
    storyCommits: obj(v.storyCommits),
    storyStates: obj(v.storyStates),
    stageEvents: Array.isArray(v.stageEvents) ? v.stageEvents.filter((x) => x && typeof x === 'object') : [],
  };
}

// 스토리 목록: 설정 stories 뒤에 story 명령으로 더한 id(storyCommits, storyStates 차례). 이름은 값의 name 또는 id.
export function storyList(config, items) {
  const out = config.stories.map((s) => ({ id: s.id, name: s.name || '' }));
  const seen = new Set(out.map((s) => s.id));
  for (const src of [items.storyCommits, items.storyStates]) {
    for (const [id, v] of Object.entries(src)) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, name: (v && typeof v === 'object' && typeof v.name === 'string' && v.name) || id });
    }
  }
  return out;
}

// 단계 목록: 설정(또는 events 가 있을 때 기본 10단계) 뒤에 stageEvents 의 새 id(처음 나온 차례, 이름은 label 또는 id).
export function stageList(config, hasEvents, stageEvents) {
  const out = stagesFor(config, hasEvents);
  const seen = new Set(out.map((s) => s.id));
  for (const e of stageEvents) {
    if (typeof e.stage !== 'string') continue;
    const label = typeof e.label === 'string' && e.label ? e.label : '';
    if (!seen.has(e.stage)) {
      seen.add(e.stage);
      out.push({ id: e.stage, label: label || e.stage, added: !label });
    } else if (label) {
      const s = out.find((x) => x.id === e.stage);
      if (s.added) {
        s.label = label;
        s.added = false;
      }
    }
  }
  return out.map(({ id, label }) => ({ id, label }));
}

// 렌더 입력 하나로 모은다. inject: { gitLines, stat, roots, env } 는 시험과 대등 확인에서 출처를 바꿔 넣는다.
export function collect(ctx, config, now, inject = {}) {
  const src = config.sources;
  const items = readItems(ctx.dataDir);
  const stories = storyList(config, items);
  const ids = stories.map((s) => s.id);
  const evFile = eventsPath(config, ctx);
  const hasEvents = Boolean(evFile) && fs.existsSync(evFile);
  const events = hasEvents ? readLines(evFile) : [];
  const stages = stageList(config, hasEvents, items.stageEvents);
  const lines = inject.gitLines !== undefined ? inject.gitLines : src.git ? gitLog(ctx.project, src.gitMax) : null;
  const g = gitInfo(lines, ids, items.storyCommits, config.commitRegex);
  const roots = inject.roots || workflowRoots(config, ctx, inject.env);
  const stat = inject.stat || fs.statSync;
  const agents = activeAgentsCached(roots, now, { staleMin: src.agentStaleMin, maxAgeH: src.journalMaxAgeH, maxSessions: src.journalMaxSessions }, stat);
  const tab = (name) => readJsonFile(path.join(ctx.dataDir, name));
  return {
    head: g.head,
    commits: g.commits,
    stages,
    stageState: stageStates([...events, ...items.stageEvents]),
    stories,
    ids,
    storyStates: items.storyStates,
    notes: items.notes,
    items: items.items,
    agents,
    starts: storyStarts(roots, ids, stat),
    reqSpec: tab('req-spec.json'),
    reqs: tab('reqs.json'),
    flow: tab('flow.json'),
    arch: tab('arch.json'),
  };
}
