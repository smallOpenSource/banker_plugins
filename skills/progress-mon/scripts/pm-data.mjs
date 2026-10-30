// pm-data.mjs: init, item, note, stage, story(계획 3절, 4.1절, 4.7절, 6.2절).
// items.json 은 잠금(items.json.lock) 안에서 다시 읽고 바꾼 칸만 고친 뒤 임시 파일에 써서 rename 한다.
// 새로 쓰는 시각은 Z 붙은 UTC ISO 8601(YYYY-MM-DDTHH:MM:SSZ). 시각은 명령 진입에서 한 번 정해 넘긴다.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dataLabel, defaults, loadConfig, eventsPath, writeAtomic, git, noBom, readRegular, UsageError } from './pm-config.mjs';
import { stageList } from './pm-sources.mjs';
import { planMemory, applyMemory } from './pm-memory.mjs';

export const ITEM_STATUS = ['todo', 'doing', 'done'];
export const STAGE_STATUS = ['started', 'done', 'skipped', 'failed', 'stopped'];
const LOCK_WAIT_MS = 5000;
const STEP_MS = 50;
// 정리 잠금(items.json.lock.break)이 이보다 오래 남으면 정리 중 죽은 것으로 보고 지운다. 정리는 수 ms.
const BREAK_STALE_MS = 3000;
// wx 가 이 코드면 잠금이 있거나 지우는 중(Windows)이라 기다린다.
const BUSY_CODES = new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = () => crypto.randomBytes(6).toString('hex');
// 초 단위 UTC 시각.
export const isoSec = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);

// ---------- 잠금 ----------

// 기록된 pid 가 죽었는지. 살아 있거나 알 수 없으면 거짓.
function pidDead(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return e.code === 'ESRCH';
  }
}

// 낡은 잠금 후보: 기록된 pid 가 죽었고 createdAt 이 LOCK_WAIT_MS 보다 오래됨. 정상 보유는 수 ms 라 이 둘을 함께 본다.
// pid 만 보면 다른 pid 공간(WSL 등)의 살아 있는 잠금을 죽었다고 볼 수 있다.
const staleLock = (info, now) =>
  Boolean(info) && Number.isInteger(info.pid) && info.pid > 0 && now - Date.parse(info.createdAt) > LOCK_WAIT_MS && pidDead(info.pid);
const sameLock = (a, b) => Boolean(a && b) && a.pid === b.pid && a.token === b.token && a.createdAt === b.createdAt;

// 잠금 파일 내용. 없으면 null, 읽거나 풀지 못하면 빈 객체(낡았는지 모름, 기다림).
function readLock(file, fsx) {
  try {
    return JSON.parse(readRegular(file, 'utf8', fsx));
  } catch (e) {
    return e.code === 'ENOENT' ? null : {};
  }
}

// 낡은 잠금 정리. 정리 잠금(items.json.lock.break)을 wx 로 쥔 프로세스 하나만 한다.
// 그 안에서 잠금을 다시 읽어 처음 본 잠금과 같고(pid, token, createdAt) 여전히 낡았을 때만 지운다.
// 처음 읽은 뒤 주인이 풀고 다른 프로세스가 새로 잡은 잠금은 내용이 달라 지우지 않는다.
// 정리 잠금이 이미 있으면 정리를 맡기고 돌아간다. BREAK_STALE_MS 보다 오래 남은 정리 잠금(정리 중 죽음)만 지운다.
// 돌려줌: 낡은 잠금을 지웠으면 참.
function breakStale(file, seen, fsx) {
  const brk = `${file}.break`;
  try {
    fsx.writeFileSync(brk, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }) + '\n', { flag: 'wx' });
  } catch (e) {
    if (!BUSY_CODES.has(e.code)) return false;
    try {
      // 낡은 정리 잠금: 낡음을 판정한 그 내용(원문)을 기억해 두고, 지우기 직전 다시 읽어 같을 때만 지운다.
      // 두 대기자가 같은 옛 정리 잠금을 낡았다고 봐도 뒤쪽이 그 사이 새로 생긴 정리 잠금을 지우지 않게 한다.
      // 나이는 내용의 createdAt, 읽을 수 없으면 파일 mtime 으로 잰다.
      const seenRaw = readRegular(brk, 'utf8', fsx);
      let born = NaN;
      try {
        born = Date.parse(JSON.parse(seenRaw).createdAt);
      } catch {
        // 깨진 정리 잠금
      }
      if (!Number.isFinite(born)) born = fsx.statSync(brk).mtimeMs;
      if (Date.now() - born > BREAK_STALE_MS && readRegular(brk, 'utf8', fsx) === seenRaw) fsx.rmSync(brk, { force: true });
    } catch {
      // 그 사이 지워짐
    }
    return false;
  }
  let removed = false;
  try {
    const cur = readLock(file, fsx);
    if (sameLock(cur, seen) && staleLock(cur, Date.now())) {
      fsx.rmSync(file, { force: true });
      removed = true;
    }
  } catch {
    // 지우지 못함. 기다리며 다시 본다
  }
  try {
    fsx.rmSync(brk, { force: true });
  } catch {
    // 남으면 BREAK_STALE_MS 뒤 다른 프로세스가 지운다
  }
  return removed;
}

// items.json.lock 을 wx 로 만든다. 있으면 50 ms 간격으로 최대 waitMs 기다린다.
// Windows 에서 지우는 중인 파일에 wx 하면 EPERM(또는 EACCES, EBUSY)이라 EEXIST 처럼 기다린다.
// 낡은 잠금은 breakStale 로만 정리한다.
// 돌려줌: { file, mine }. 시간 초과는 UsageError(잠금 경로, pid, createdAt, 수동 삭제 안내).
export async function acquireLock(dataDir, { fsx = fs, waitMs = LOCK_WAIT_MS, label = '' } = {}) {
  const file = path.join(dataDir, 'items.json.lock');
  const mine = { pid: process.pid, createdAt: isoSec(Date.now()), token: rand() };
  const body = JSON.stringify(mine) + '\n';
  const until = Date.now() + waitMs;
  let last = {};
  let seenLock = false; // 기다리는 동안 잠금 파일이 한 번이라도 보였는지
  for (;;) {
    let code;
    try {
      fsx.writeFileSync(file, body, { flag: 'wx' });
      return { file, mine };
    } catch (e) {
      code = e.code;
      if (!BUSY_CODES.has(code)) throw new UsageError(`잠금 파일을 만들지 못함(${code || e.message})`);
    }
    const info = readLock(file, fsx);
    // 그 사이 풀림: 바로 다시. 지우는 중(EPERM 등)이면 아래에서 기다린다
    if (info === null && code === 'EEXIST' && Date.now() < until) continue;
    if (info) seenLock = true;
    if (info && info.pid !== undefined) last = info;
    if (staleLock(info, Date.now()) && breakStale(file, info, fsx)) continue;
    if (Date.now() >= until) {
      // 잠금 파일이 끝내 없었으면 다른 쓰기가 아니라 만들지 못한 것(권한 등)
      if (!seenLock && code !== 'EEXIST') throw new UsageError(`잠금 파일을 만들지 못함(${code})`);
      throw new UsageError(
        `다른 쓰기가 끝나지 않음(잠금 ${label}items.json.lock, pid ${last.pid ?? '알 수 없음'}, createdAt ${last.createdAt ?? '알 수 없음'}). 그 프로세스가 끝났는데도 남아 있으면 잠금 파일을 지운 뒤 다시 실행`,
      );
    }
    await sleep(STEP_MS);
  }
}

// 잠금 해제: 내용의 pid 와 무작위 값이 자기 것일 때만 지운다.
export function releaseLock(h, fsx = fs) {
  const info = readLock(h.file, fsx);
  if (info && info.pid === h.mine.pid && info.token === h.mine.token) fsx.rmSync(h.file, { force: true });
}

// ---------- items.json ----------

const EMPTY_ITEMS = () => ({ notes: {}, items: [], storyCommits: {}, storyStates: {}, stageEvents: [] });

// 잠금 안에서 쓰는 원본 읽기. 모르는 키는 그대로 둔다. 깨진 파일은 고치지 않고 거부.
function readItemsRaw(file, fsx) {
  let text;
  try {
    text = readRegular(file, 'utf8', fsx);
  } catch (e) {
    if (e.code === 'ENOENT') return EMPTY_ITEMS();
    throw new UsageError(`items.json 을 읽지 못함(${e.code || e.message})`);
  }
  let v;
  try {
    v = JSON.parse(noBom(text));
  } catch {
    throw new UsageError('items.json 이 JSON 이 아님. check 로 확인하고 고친 뒤 다시 실행');
  }
  if (!obj(v)) throw new UsageError('items.json 이 객체가 아님. 고친 뒤 다시 실행');
  for (const [k, mk] of Object.entries(EMPTY_ITEMS())) {
    if (v[k] === undefined) v[k] = mk;
    else if (Array.isArray(mk) !== Array.isArray(v[k]) || typeof v[k] !== 'object' || v[k] === null) throw new UsageError(`items.json 의 ${k} 형식이 틀림. 고친 뒤 다시 실행`);
  }
  return v;
}

// 잠금 안에서 items.json 을 다시 읽어 change(v) 로 고치고 원자적으로 쓴다. 돌려줌: change 의 값.
export async function updateItems(dataDir, change, { fsx = fs, waitMs, label = '' } = {}) {
  const h = await acquireLock(dataDir, { fsx, waitMs, label });
  try {
    const file = path.join(dataDir, 'items.json');
    const v = readItemsRaw(file, fsx);
    const r = change(v);
    await writeAtomic(file, JSON.stringify(v, null, 2) + '\n', fsx);
    return r;
  } finally {
    releaseLock(h, fsx);
  }
}

// ---------- 갱신 명령의 바꾸기 함수 ----------

const need = (o, key, cmd) => {
  if (typeof o[key] !== 'string' || !o[key]) throw new UsageError(`${cmd} 에는 --${key} 가 필요함`);
  // 객체 칸 이름으로 쓰면 JSON 에 남지 않는 이름(쓰기 성공 출력 뒤 기록이 사라지던 것)
  if (o[key] === '__proto__') throw new UsageError(`--${key} 에 __proto__ 는 쓰지 않음`);
  return o[key];
};
const oneOf = (v, list) => {
  if (!list.includes(v)) throw new UsageError(`--status 는 ${list.join(', ')} 가운데 하나(받은 값 ${v})`);
};

// --at 형식: 날짜, 시각(초 선택), 시간대(Z 나 +09:00) 모두 있는 ISO 8601. git log --format=%cI 가 이 꼴.
const AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

// item: 같은 key 는 대체하고 시작 시각 s 는 유지. 새 key 는 끝에 추가.
// s 는 doing 으로 기록할 때만 정한다(이미 있으면 유지). 처음부터 done 이나 todo 면 s 없음(소요시간 "-").
// --at 이 있으면 지금 대신 그 시각을 t 로 쓴다. 지난 커밋을 커밋 시각으로 기록할 때.
// --commit 은 7~40자 16진 해시. hash 칸에 두고 진척도 표 commit Hash 칸에 앞 7자리로 보인다. --commit 이 없으면 있던 hash 를 유지.
export function itemChange(o, now) {
  const key = need(o, 'key', 'item');
  const status = need(o, 'status', 'item');
  oneOf(status, ITEM_STATUS);
  const text = need(o, 'text', 'item');
  let at = now;
  if (o.at !== undefined) {
    at = typeof o.at === 'string' && AT_RE.test(o.at) ? Date.parse(o.at) : NaN;
    if (!Number.isFinite(at)) throw new UsageError(`--at 은 시간대가 붙은 ISO 8601 시각(예 2026-10-29T12:34:56+09:00): ${o.at}`);
  }
  if (o.commit !== undefined && !(typeof o.commit === 'string' && /^[0-9a-f]{7,40}$/i.test(o.commit))) throw new UsageError(`--commit 은 7~40자 16진 해시(받은 값 ${o.commit})`);
  const t = isoSec(at);
  return (v) => {
    const i = v.items.findIndex((x) => obj(x) && x.key === key);
    const prev = i >= 0 ? v.items[i] : null;
    const s = (prev && prev.s) || (status === 'doing' ? t : undefined);
    const next = s ? { key, t, s, status, text } : { key, t, status, text };
    if (o.note !== undefined) next.note = o.note;
    if (o.issue !== undefined) next.issue = o.issue;
    if (o.commit !== undefined) next.hash = o.commit;
    else if (prev && typeof prev.hash === 'string') next.hash = prev.hash;
    if (prev) v.items[i] = next;
    else v.items.push(next);
    // 시작 시각이 있던 항목만 "시작 시각 유지"(처음부터 done, todo 로 쓴 항목은 시작 시각이 없음).
    return prev ? `item ${key}: 대체(${prev.status} 에서 ${status})${prev.s ? ', 시작 시각 유지' : ''}. 항목 ${v.items.length}개` : `item ${key}: 추가(${status}). 항목 ${v.items.length}개`;
  };
}

// note: notes 의 key 칸 단위 대체. 빈 값은 그 칸을 지운다.
function noteChange(o) {
  const key = need(o, 'key', 'note');
  const fields = ['note', 'issue'].filter((k) => o[k] !== undefined);
  if (!fields.length) throw new UsageError('note 에는 --note 또는 --issue 가 필요함');
  return (v) => {
    const had = Object.prototype.hasOwnProperty.call(v.notes, key);
    const cur = obj(v.notes[key]) ? { ...v.notes[key] } : {};
    for (const k of fields) {
      if (o[k] === '') delete cur[k];
      else cur[k] = o[k];
    }
    v.notes[key] = cur;
    const n = Object.keys(v.notes).length;
    return had ? `note ${key}: 대체(${fields.join(', ')}). notes ${n}개` : `note ${key}: 추가. notes ${n}개`;
  };
}

// stage: stageEvents 에 {t, stage, status[, label]} 추가. 단계 목록에 없는 id 면 새 단계 행.
function stageChange(o, now, known) {
  const id = need(o, 'id', 'stage');
  const status = need(o, 'status', 'stage');
  oneOf(status, STAGE_STATUS);
  const t = isoSec(now);
  return (v) => {
    const ev = { t, stage: id, status };
    if (o.label) ev.label = o.label;
    const fresh = !known(v).includes(id);
    v.stageEvents.push(ev);
    return `stage ${id}: ${status} 기록함${fresh ? `. 새 단계 행(${o.label || id})` : ''}`;
  };
}

// story: --status 는 storyStates, --commit 은 storyCommits. 설정에 없는 id 면 새 스토리 행(이름은 --name 또는 id).
function storyChange(o, now, configIds) {
  const id = need(o, 'id', 'story');
  if ((o.status === undefined) === (o.commit === undefined)) throw new UsageError('story 에는 --status 또는 --commit 가운데 하나가 필요함');
  if (o.status !== undefined) oneOf(o.status, ITEM_STATUS);
  if (o.commit !== undefined && !/^[0-9a-f]{4,40}$/i.test(o.commit)) throw new UsageError(`--commit 은 4~40자 16진 해시(받은 값 ${o.commit})`);
  const t = isoSec(now);
  return (v) => {
    const known = new Set([...configIds, ...Object.keys(v.storyCommits), ...Object.keys(v.storyStates)]);
    const fresh = !known.has(id);
    const box = o.commit !== undefined ? v.storyCommits : v.storyStates;
    const prev = obj(box[id]) || {};
    const next = o.commit !== undefined ? { hash: o.commit, t } : { status: o.status, t };
    const name = o.name !== undefined ? o.name : prev.name;
    if (name) next.name = name;
    box[id] = next;
    const what = o.commit !== undefined ? `커밋 ${o.commit}` : o.status;
    return `story ${id}: ${what} 기록함${fresh ? `. 새 스토리 행(${name || id})` : ''}`;
  };
}

// ---------- init ----------

const NEXT = ['다음 할 일', '  1. references/authoring.md 를 읽고 req-spec.json, reqs.json, flow.json, arch.json 작성', '  2. check 로 검사. FAIL 0 까지 최대 3회', '  3. start 로 서버 시작'];

const slash = (p) => p.split(path.sep).join('/');
const realOr = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};
const inside = (rel) => rel && !rel.startsWith('..') && !path.isAbsolute(rel);

// 자료 폴더를 git 제외 목록(git rev-parse --git-path info/exclude)에 한 줄 추가. 추적 파일은 바꾸지 않는다. 실패는 알림만.
function gitExclude(ctx) {
  let top;
  let excl;
  try {
    top = path.resolve(git(ctx.project, ['rev-parse', '--show-toplevel']));
    excl = path.resolve(ctx.project, git(ctx.project, ['rev-parse', '--git-path', 'info/exclude']));
  } catch {
    return 'git 제외 목록: git 저장소 아님, 건너뜀';
  }
  // 링크 경로(macOS /var 와 /private/var, Windows junction)로 부른 --project 도 git 최상위(실제 경로)와 맞게 푼다
  const rel = path.relative(realOr(top), path.join(realOr(path.dirname(ctx.dataDir)), path.basename(ctx.dataDir)));
  if (!inside(rel)) return 'git 제외 목록: 자료 폴더가 저장소 밖이라 건너뜀';
  const line = `/${slash(rel)}/`;
  const shown = inside(path.relative(ctx.project, excl)) ? slash(path.relative(ctx.project, excl)) : 'info/exclude';
  let text = '';
  try {
    text = fs.readFileSync(excl, 'utf8');
  } catch {
    text = '';
  }
  if (text.split(/\r?\n/).some((l) => l.trim() === line)) return 'git 제외 목록: 이미 있음';
  try {
    git(ctx.project, ['check-ignore', '-q', ctx.dataDir]);
    return 'git 제외 목록: 이미 git 무시 대상이라 추가 안 함';
  } catch {
    // 무시 대상 아님. 아래에서 추가
  }
  try {
    fs.mkdirSync(path.dirname(excl), { recursive: true });
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    fs.appendFileSync(excl, (text && !text.endsWith('\n') ? eol : '') + line + eol);
  } catch (e) {
    return `알림: git 제외 목록에 추가하지 못함(${e.code || e.message})`;
  }
  return `git 제외 목록 추가: ${line} (${shown})`;
}

// 없을 때만 만든다. 돌려줌: 출력 줄.
function makeOnce(file, label, text) {
  if (fs.existsSync(file)) return `그대로 둠: ${label}`;
  fs.writeFileSync(file, text, { flag: 'wx' });
  return `새로 만듦: ${label}`;
}

async function init(ctx, o, io, skillDir, now) {
  // 쓰기 전에 메모리 대상을 모두 검사한다(거부면 아무것도 만들지 않음).
  const plan = planMemory({ kind: o.memory, memoryDir: o['memory-dir'], project: ctx.project, runtime: ctx.runtime });
  if (o.title !== undefined && !o.title) throw new UsageError('--title 은 빈 문자열이 아니어야 함');
  const label = dataLabel(ctx);
  fs.mkdirSync(ctx.dataDir, { recursive: true });
  io.out(`자료 폴더: ${label}`);
  const cfg = defaults(ctx.project, ctx.runtime);
  delete cfg.commitRegex;
  delete cfg.agentLabelPattern;
  if (o.title) cfg.title = o.title;
  io.out(makeOnce(path.join(ctx.dataDir, 'config.json'), `${label}config.json`, JSON.stringify(cfg, null, 2) + '\n'));
  io.out(makeOnce(path.join(ctx.dataDir, 'items.json'), `${label}items.json`, JSON.stringify(EMPTY_ITEMS(), null, 2) + '\n'));
  const stFile = path.join(ctx.dataDir, 'state.json');
  const hadState = fs.existsSync(stFile);
  let st = {};
  try {
    st = obj(JSON.parse(readRegular(stFile))) || {};
  } catch {
    st = {};
  }
  await writeAtomic(stFile, JSON.stringify({ ...st, skillDir, runtime: ctx.runtime, memory: plan.memory, updatedAt: isoSec(now) }, null, 2) + '\n');
  if (!hadState) io.out(`새로 만듦: ${label}state.json`);
  io.out(gitExclude(ctx));
  for (const l of applyMemory(plan, ctx.project)) io.out(l);
  for (const l of NEXT) io.out(l);
  return 0;
}

// ---------- CLI ----------

export async function command(cmd, ctx, o, io, { skillDir } = {}) {
  const now = Date.now();
  if (o._.length > 1) throw new UsageError(`${cmd} 는 위치 인자를 받지 않음: ${o._.slice(1).join(' ')}`);
  if (cmd === 'init') return init(ctx, o, io, skillDir, now);
  const label = dataLabel(ctx);
  let change;
  if (cmd === 'item') change = itemChange(o, now);
  else if (cmd === 'note') change = noteChange(o);
  else if (cmd === 'stage') {
    const { config } = loadConfig(ctx);
    const ev = eventsPath(config, ctx);
    const hasEvents = Boolean(ev) && fs.existsSync(ev);
    change = stageChange(o, now, (v) => stageList(config, hasEvents, v.stageEvents.filter(obj)).map((s) => s.id));
  } else if (cmd === 'story') {
    const { config } = loadConfig(ctx);
    change = storyChange(o, now, config.stories.map((s) => s.id));
  } else throw new UsageError(`${cmd} 는 pm-data.mjs 가 맡지 않음`);
  io.out(await updateItems(ctx.dataDir, change, { label }));
  return 0;
}
