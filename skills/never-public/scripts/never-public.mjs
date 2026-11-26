#!/usr/bin/env node
/*
 * never-public: 로컬 PC 밖으로 나가는 통신(원격 제어, 세션 올리기, 피드백, 텔레메트리, 업데이트 확인)을 끄는 설정을
 * 한 번에 켜고 끈다.
 *
 *   node never-public.mjs on     [--only claude,codex,banker]   세 대상에 끄는 값을 둠
 *   node never-public.mjs off    [--only ...]                   on 하기 전 값으로 되돌림
 *   node never-public.mjs status [--only ...]                   대상마다 키와 지금 값
 *
 * 대상(--only 가 없으면 설정 폴더가 있는 대상 모두. banker 는 늘)
 * - claude: <CLAUDE_CONFIG_DIR 또는 ~/.claude>/settings.json 의 값 13개(경로 키 attribution.*, env.DISABLE_TELEMETRY,
 *   env.DISABLE_ERROR_REPORTING 포함. 다른 env 키는 그대로)
 * - codex: <CODEX_HOME 또는 ~/.codex>/config.toml 의 키(줄 단위로 고쳐 주석과 다른 키를 지킴, codex-config.mjs)
 * - banker: banker 설정 config.json(XDG_CONFIG_HOME/banker, Windows %APPDATA%\banker, 그 밖 ~/.config/banker)의
 *   telemetry, updateCheck(업데이트 확인과 사용량 체크인을 끔), promptedStarV1(설치 때 GitHub 별 질문을 건너뜀)
 *
 * 되돌리기: on 이 바꾸기 전 값을 <파일>.never-public.json 에 기록하고, 처음 on 의 원래 바이트를 <파일>.never-public.bak 에 둔다(off 뒤 지움).
 * off 는 키마다 지금 값이 on 이 둔 값일 때만 되돌린다(원래 없던 키는 지우고, on 이 만든 빈 부모 객체와 TOML 표도 지움).
 * on 뒤에 사용자가 바꾼 키는 그대로 두고 알린다. 다시 on 해도 처음 기록은 지킨다.
 *
 * 쓰기 전에 모든 대상을 먼저 읽는다. 하나라도 깨진 파일(JSON, TOML 자리 문제)이면 아무것도 바꾸지 않는다.
 * 종료: 0 완료 또는 이미 그 상태, 1 거부나 사용법 오류(바꾼 것 없음), 2 예기치 못한 오류(메시지의 바꾼 파일 확인),
 * 3 이 계정이 쓸 수 없음(샌드박스 등).
 */
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { codexConfigFile, definedInline, dropEmptyTable, eolOf, findKey, nameParts, readToml, Refused, removeKey, scan, setKey, unclosedKey, writeToml } from './codex-config.mjs';
import { backupFor, blockedParent, deletePath, denied, getPath, readJson, readRecord, sameValue, setPath, writeFresh, writeJson } from './settings-json.mjs';

const SLUG = 'never-public';

// Claude Code settings.json. 값과 뜻은 Claude Code 2.1.332 의 설정 스키마로 확인함.
export const CLAUDE_WANT = [
  [['disableRemoteControl'], true],
  [['autoUploadSessions'], false],
  [['remoteControlAtStartup'], false],
  [['attribution', 'commit'], ''],
  [['attribution', 'pr'], ''],
  [['attribution', 'sessionUrl'], false],
  [['feedbackSurveyRate'], 0],
  [['feedbackDrafts'], 'off'],
  [['enableArtifact'], false],
  // claude.ai 에서 켠 플러그인과 스킬을 내려받는 동기화. false 만 받는다. 끄면 이미 받은 스킬은 다음 시작 때 숨겨지고
  // ~/.claude/skills/.trash 로 옮겨진다(2.1.332 설명). 다시 켜면 새로 받는다.
  [['syncClaudeAiPlugins'], false],
  [['syncClaudeAiSkills'], false],
  // 사용 텔레메트리와 오류 보고(환경 변수라 settings 의 env 에 둠). CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC 은 자동 업데이트까지
  // 막아 넣지 않는다(남는 통신 목록에 적음).
  [['env', 'DISABLE_TELEMETRY'], '1'],
  [['env', 'DISABLE_ERROR_REPORTING'], '1'],
];

// banker config.json(bin/lib/telemetry-config.mjs 가 읽는 값).
export const BANKER_WANT = [
  [['telemetry'], false],
  [['updateCheck'], false],
  [['promptedStarV1'], true],
];

// Codex config.toml. [표, 키, TOML 값]. 표 '' 는 최상위. Codex 0.165.0 의 설정 스키마로 확인함: metrics_exporter 의 기본값
// statsig 는 ab.chatgpt.com 으로 지표를 보내고, analytics 는 chatgpt.com 으로 사용 이벤트를, feedback 은 /feedback 의 올리기를,
// check_for_update_on_startup 은 npm, GitHub, Homebrew 에 새 판을 묻는다. exporter, trace_exporter 는 기본이 none 이지만 분명히 둔다.
export const CODEX_WANT = [
  ['', 'check_for_update_on_startup', 'false'],
  ['analytics', 'enabled', 'false'],
  ['feedback', 'enabled', 'false'],
  ['otel', 'exporter', '"none"'],
  ['otel', 'trace_exporter', '"none"'],
  ['otel', 'metrics_exporter', '"none"'],
];

// 상대 경로 CODEX_HOME 은 Codex 처럼 지금 폴더 기준. banker 설정 폴더는 telemetry-config.mjs 의 configDir 과 같은 규칙.
export function defaults(env = process.env, platform = process.platform) {
  const xdg = env.XDG_CONFIG_HOME;
  const appData = env.APPDATA || join(homedir(), 'AppData', 'Roaming');
  const bankerDir = xdg ? join(xdg, 'banker') : platform === 'win32' ? join(appData, 'banker') : join(homedir(), '.config', 'banker');
  return {
    claudeDir: env.CLAUDE_CONFIG_DIR ? resolve(env.CLAUDE_CONFIG_DIR) : join(homedir(), '.claude'),
    codexFile: codexConfigFile(env),
    bankerDir,
  };
}

const recordOf = (file) => `${file}.${SLUG}.json`;
const backupOf = (file) => `${file}.${SLUG}.bak`;
const show = (v) => (v === undefined ? '(없음)' : JSON.stringify(v));

/* ---------- JSON 대상(claude, banker) ---------- */

function jsonTarget(name, file, want, needDir) {
  return { name, file, kind: 'json', want, needDir };
}

// 이미 그 값인지. attribution 이 false 면 Claude Code 가 {commit: "", pr: "", sessionUrl: false} 와 같게 본다(2.1.332 스키마).
function isSet(data, keys, value) {
  if (keys[0] === 'attribution' && data.attribution === false) return true;
  const cur = getPath(data, keys);
  return cur.has && sameValue(cur.value, value);
}

// 쓰기 전 확인: 파일을 읽고, 값을 둘 수 없는 자리가 있으면 까닭.
function loadJson(t) {
  const r = readJson(t.file);
  if (r.why) return { why: r.why };
  const bad = t.want.filter(([keys, value]) => !isSet(r.data, keys, value)).map(([keys]) => blockedParent(r.data, keys)).find(Boolean);
  return bad ? { why: `${t.file} 의 ${bad} 가 객체가 아니라 그 아래 키를 둘 수 없음` } : { doc: r };
}

// 한 키의 처음 값 기록. 이미 있으면(다시 on) 처음 기록을 지킨다.
function firstSeen(record, data, keys) {
  const id = keys.join('.');
  if (record.keys[id]) return;
  const cur = getPath(data, keys);
  record.keys[id] = cur.has ? { had: true, value: cur.value } : { had: false };
  const parent = keys.slice(0, -1).join('.');
  if (parent && !getPath(data, keys.slice(0, -1)).has && !record.created.includes(parent)) record.created.push(parent);
}

function onJson(t, { doc }) {
  const record = readRecord(recordOf(t.file)) ?? {};
  record.keys ??= {};
  record.created ??= [];
  record.existed ??= doc.exists;
  const data = JSON.parse(JSON.stringify(doc.data));
  const changed = [];
  for (const [keys, value] of t.want) {
    if (isSet(data, keys, value)) continue;
    const cur = getPath(data, keys);
    firstSeen(record, doc.data, keys);
    changed.push(`${keys.join('.')}: ${show(cur.value)} -> ${show(value)}`);
    setPath(data, keys, value);
  }
  if (!changed.length) return { changed };
  if (t.needDir === false) mkdirSync(join(t.file, '..'), { recursive: true });
  const backup = backupFor(backupOf(t.file), recordOf(t.file)); // 두 번째 on 은 첫 원본 백업을 덮지 않음
  // 기록을 먼저 쓴다: 설정 쓰기 뒤에 멈춰도 off 가 되돌릴 값을 안다. 남은 기록은 무해하다(지금 값이 on 의 값일 때만 되돌림).
  writeFresh(recordOf(t.file), `${JSON.stringify(record)}\n`, 0o600);
  writeJson(t.file, data, { bom: doc.bom, style: doc.style, raw: doc.raw, backup });
  return { changed };
}

// 한 키 되돌리기. 바뀐 줄, 그대로 둔 줄, 또는 null(할 일 없음).
function restoreKey(data, keys, value, was, created) {
  const cur = getPath(data, keys);
  const id = keys.join('.');
  if (!cur.has || !sameValue(cur.value, value)) return was ? { kept: `${id}: on 뒤에 ${show(cur.value)} 로 바뀌어 그대로 둠` } : null;
  if (was?.had) {
    if (sameValue(was.value, value)) return null;
    setPath(data, keys, was.value);
    return { changed: `${id}: ${show(value)} -> ${show(was.value)}` };
  }
  deletePath(data, keys, created);
  return { changed: `${id}: ${show(value)} -> (없음)` };
}

// 기록대로 되돌린 data 와 바뀐 줄, 그대로 둔 줄.
function restoreAll(t, data, record) {
  const changed = [];
  const kept = [];
  for (const [keys, value] of t.want) {
    const was = record.keys[keys.join('.')];
    const r = was ? restoreKey(data, keys, value, was, record.created ?? []) : null;
    if (r?.changed) changed.push(r.changed);
    if (r?.kept) kept.push(r.kept);
  }
  return { changed, kept };
}

function offJson(t, { doc }) {
  const record = readRecord(recordOf(t.file));
  // 기록이 없으면 되돌릴 값을 모른다: on 의 값과 같은 키를 남겨 둔다(사용자가 스스로 둔 값일 수 있다).
  if (!record?.keys) {
    rmSync(recordOf(t.file), { force: true }); // 깨진 기록
    return { changed: [], kept: [], noRecord: true };
  }
  const data = JSON.parse(JSON.stringify(doc.data));
  const { changed, kept } = restoreAll(t, data, record);
  // on 이 새로 만든 파일이 다시 비면 지운다.
  if (changed.length && record.existed === false && !Object.keys(data).length) rmSync(t.file, { force: true });
  else if (changed.length) writeJson(t.file, data, { bom: doc.bom, style: doc.style });
  // 되돌렸으니 기록과 켜기 전 백업을 지운다(백업에는 설정의 비밀 값이 있을 수 있음).
  rmSync(recordOf(t.file), { force: true });
  rmSync(backupOf(t.file), { force: true });
  return { changed, kept };
}

function statusJson(t, { doc }) {
  return t.want.map(([keys, value]) => {
    const cur = getPath(doc.data, keys);
    return { id: keys.join('.'), now: show(cur.value), on: isSet(doc.data, keys, value) };
  });
}

/* ---------- TOML 대상(codex) ---------- */

// 키를 둘 자리. [표] 가 있거나 아무 데도 없으면 [표] 안, 최상위가 점 키(`otel.x = 1`)로 그 표를 정했으면 최상위 점 키.
// 최상위가 인라인 표(`otel = { ... }`)면 고칠 수 없다.
// 표 머리 이름과, 키의 전체 이름(최상위 키는 그대로, 표 안의 키는 `<표>.<키>`)을 점으로 이어 모은다.
function subTableNames(text) {
  let table = '';
  const out = [];
  for (const x of scan(text)) {
    const name = x.name?.split('\u0000').join('.');
    if (x.kind === 'header') out.push((table = name));
    else if (x.kind === 'key') out.push(table ? `${table}.${name}` : name);
  }
  return out;
}

// 키 자체가 하위 표(`[otel.exporter.otlp-http]`, `[otel] exporter.otlp-http.x = 1`)로 정해져 있으면 값 하나로 바꿀 수 없다.
function placeOf(text, table, key) {
  if (!table) return { table: '', key };
  const sub = `${table}.${key}`;
  if (subTableNames(text).some((n) => n.startsWith(`${sub}.`))) {
    return { why: `config.toml 의 ${sub} 가 표로 정해져 있어(내보내기 설정 등) 줄 단위로 "none" 으로 바꿀 수 없음. 그 표를 직접 지운 뒤 다시 실행` };
  }
  if (findKey(text, '', sub)) return { table: '', key: sub };
  if (findKey(text, '', table)) return { why: `config.toml 최상위의 ${table} 가 인라인 표라 그 안의 ${key} 를 줄 단위로 고칠 수 없음` };
  if (definedInline(text, table) && !hasHeader(text, table)) return { table: '', key: `${table}.${key}` };
  return { table, key };
}

const hasHeader = (text, table) => text.split(/\r?\n/).some((l) => {
  const m = /^\s*\[([^[\]]+)\]\s*(#.*)?$/.exec(l);
  return m && nameParts(m[1]).join('.') === table;
});

function loadToml(t) {
  let toml;
  try {
    toml = readToml(t.file);
  } catch (e) {
    if (e instanceof Refused) return { why: e.message };
    throw e;
  }
  const open = unclosedKey(toml.text);
  if (open) return { why: `${t.file} 의 ${open} 값이 파일 끝까지 닫히지 않음(깨진 TOML). 고치지 않고 그대로 둠` };
  const places = t.want.map(([table, key]) => placeOf(toml.text, table, key));
  const bad = places.find((p) => p.why);
  return bad ? { why: bad.why } : { doc: { ...toml, places } };
}

const rawAt = (text, p) => findKey(text, p.table, p.key)?.raw ?? null;
const tomlId = ([table, key]) => (table ? `${table}.${key}` : key);

function onToml(t, { doc }) {
  const record = readRecord(recordOf(t.file)) ?? {};
  record.keys ??= {};
  record.created ??= [];
  record.existed ??= doc.exists;
  let text = doc.text;
  const changed = [];
  t.want.forEach((w, i) => {
    const p = doc.places[i];
    const cur = rawAt(text, p);
    if (cur === w[2]) return;
    const id = tomlId(w);
    if (!record.keys[id]) record.keys[id] = cur === null ? { had: false } : { had: true, raw: cur };
    if (p.table && !hasHeader(text, p.table) && !record.created.includes(p.table)) record.created.push(p.table);
    changed.push(`${id}: ${cur ?? '(없음)'} -> ${w[2]}`);
    text = setKey(text, p.table, p.key, w[2]);
  });
  if (!changed.length) return { changed };
  const nl = eolOf(doc.text);
  const backup = doc.exists ? backupFor(backupOf(t.file), recordOf(t.file)) : null;
  writeFresh(recordOf(t.file), `${JSON.stringify(record)}\n`, 0o600);
  writeToml(t.file, text.endsWith(nl) ? text : `${text}${nl}`, { mode: doc.mode, backup });
  return { changed };
}

function restoreToml(text, p, w, was) {
  const cur = rawAt(text, p);
  const id = tomlId(w);
  if (cur !== w[2]) return { text, kept: `${id}: on 뒤에 ${cur ?? '(없음)'} 로 바뀌어 그대로 둠` };
  if (was.had) return was.raw === w[2] ? { text } : { text: setKey(text, p.table, p.key, was.raw), changed: `${id}: ${w[2]} -> ${was.raw}` };
  return { text: removeKey(text, p.table, p.key), changed: `${id}: ${w[2]} -> (없음)` };
}

// 기록대로 되돌린 글과 바뀐 줄, 그대로 둔 줄. on 이 만든 빈 표도 뺀다.
function restoreAllToml(t, doc, record) {
  let text = doc.text;
  const changed = [];
  const kept = [];
  t.want.forEach((w, i) => {
    const was = record?.keys?.[tomlId(w)];
    if (!was) return;
    const r = restoreToml(text, doc.places[i], w, was);
    text = r.text;
    if (r.changed) changed.push(r.changed);
    if (r.kept) kept.push(r.kept);
  });
  for (const table of record?.created ?? []) text = dropEmptyTable(text, table);
  return { text, changed, kept };
}

function offToml(t, { doc }) {
  const record = readRecord(recordOf(t.file));
  const { text, changed, kept } = restoreAllToml(t, doc, record);
  if (text !== doc.text && record?.existed === false && !text.trim()) rmSync(t.file, { force: true });
  else if (text !== doc.text) writeToml(t.file, text, { mode: doc.mode });
  rmSync(recordOf(t.file), { force: true });
  if (record) rmSync(backupOf(t.file), { force: true }); // 되돌렸으니 켜기 전 백업도 지운다
  return { changed, kept, noRecord: !record?.keys };
}

function statusToml(t, { doc }) {
  return t.want.map((w, i) => {
    const cur = rawAt(doc.text, doc.places[i]);
    return { id: tomlId(w), now: cur ?? '(없음)', on: cur === w[2] };
  });
}

/* ---------- 대상 고르기와 실행 ---------- */

const OPS = {
  json: { load: loadJson, on: onJson, off: offJson, status: statusJson },
  toml: { load: loadToml, on: onToml, off: offToml, status: statusToml },
};
const LABEL = { claude: 'Claude Code', codex: 'Codex', banker: 'banker' };
const RESTART = {
  claude: '실행 중인 Claude Code 는 다시 시작해야 확실히 적용됨',
  codex: '실행 중인 Codex 는 다시 시작해야 적용됨',
  banker: 'banker 훅이 다음 세션 시작부터 읽음(재시작 불필요)',
};

export function targets(o, only = null) {
  const all = [
    jsonTarget('claude', join(o.claudeDir, 'settings.json'), CLAUDE_WANT, o.claudeDir),
    { name: 'codex', file: o.codexFile, kind: 'toml', want: CODEX_WANT, needDir: join(o.codexFile, '..') },
    jsonTarget('banker', join(o.bankerDir, 'config.json'), BANKER_WANT, false),
  ];
  const picked = only ? all.filter((t) => only.includes(t.name)) : all;
  // --only 로 고른 대상은 폴더가 없어도 그 사실을 알린다. 고르지 않았으면 폴더가 있는 대상만.
  return picked.map((t) => ({ ...t, absent: t.needDir !== false && !existsSync(t.needDir) })).filter((t) => only || !t.absent);
}

function loadAll(list) {
  const loaded = [];
  for (const t of list) {
    if (t.absent) return { why: `${LABEL[t.name]} 설정 폴더가 없음(${t.needDir})` };
    const r = OPS[t.kind].load(t);
    if (r.why) return { why: r.why, failed: t.name };
    loaded.push([t, r]);
  }
  return { loaded };
}

// 한 대상이 거부되면 나머지만 켜는 방법. 남는 대상이 없으면 ''.
function onlyHint(list, failed) {
  const rest = list.map((t) => t.name).filter((n) => n !== failed);
  return failed && rest.length ? `\n${LABEL[failed]} 를 빼고 나머지만 하려면 --only ${rest.join(',')}` : '';
}

// on 뒤에 늘 알리는 남는 통신.
export const REMAINING = '- 남는 통신(이 스킬이 끄지 않음): 모델 API 호출, Claude Code 와 Codex 의 자동 업데이트(CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC 은 자동 업데이트와 banker 업데이트 경로까지 막아 넣지 않음), '
  + 'Codex 의 플러그인 마켓플레이스 동기화, 웹 검색, MCP 서버, 사용자가 부르는 banker 스킬의 통신(update-banker, setup-*, deep-research, wbs-gen 공휴일, 3d-intro 의 Azure 등)';

// 대상 하나의 결과 줄. 바뀐 것이 없으면 한 줄.
function reportChange(lines, t, r, action) {
  const kept = r.kept ?? [];
  if (!r.changed.length && !kept.length) {
    lines.push(`- ${LABEL[t.name]}: ${r.noRecord ? 'on 기록이 없어 바꾸지 않음' : `이미 ${action === 'on' ? '켜짐' : '꺼짐'}`} (${t.file})`);
    return;
  }
  lines.push(`- ${LABEL[t.name]} (${t.file})`, ...[...r.changed, ...kept].map((x) => `  - ${x}`));
  if (r.changed.length) lines.push(`  - ${RESTART[t.name]}`);
  if (action === 'off' && r.changed.some((c) => c.startsWith('syncClaudeAi'))) lines.push(`  ${RESYNC}`);
}

/* ---------- claude.ai 동기화 두 키의 확인 ---------- */

// 동기화 키와 그 항목이 사는 폴더(<설정 폴더>/<폴더>/synced/<조직>_<계정>/<이름>). 2.1.332: 키를 false 로 두면 다음 시작 때
// 그 항목이 숨겨지고 <설정 폴더>/<폴더>/.trash 로 옮겨지며, cleanupPeriodDays 뒤 지워진다. 다시 켜면 되살리지 않고 새로 받는다.
export const SYNC = [
  { key: 'syncClaudeAiSkills', dir: 'skills', label: '스킬' },
  { key: 'syncClaudeAiPlugins', dir: 'plugins', label: '플러그인' },
];

// 동기화로 받은 항목 이름. 버킷(<조직>_<계정>) 안의 점으로 시작하지 않는 폴더. 읽지 못하면 빈 목록.
export function syncedNames(claudeDir, dir) {
  const root = join(claudeDir, dir, 'synced');
  const names = new Set();
  for (const bucket of listDirs(root)) {
    if (/^[0-9a-f-]{36}_([0-9a-f-]{36}|unbound)$/i.test(bucket)) for (const n of listDirs(join(root, bucket))) names.add(n);
  }
  return [...names].sort();
}

function listDirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name);
  } catch {
    return [];
  }
}

// on 에서 동기화 키를 끄면 사라질 항목. 이미 false 인 키는 뺀다. [{ key, label, names, dir }].
function syncLosses(t, o) {
  const r = readJson(t.file);
  if (r.why) return [];
  return SYNC.filter((s) => r.data[s.key] !== false)
    .map((s) => ({ ...s, names: syncedNames(o.claudeDir, s.dir), trash: join(o.claudeDir, s.dir, '.trash') }))
    .filter((s) => s.names.length);
}

function lossLines(losses, yes) {
  const lines = [`- ${yes ? '적용함' : '확인 필요'}: claude.ai 동기화를 끄면 아래 항목은 다음 시작 때 숨겨지고 .trash 로 옮겨짐`];
  for (const s of losses) lines.push(`  - ${s.label}(${s.trash} 로): ${s.names.join(', ')}`);
  lines.push('  - .trash 는 cleanupPeriodDays 뒤 지워짐. off 로 되돌리면 되살리지 않고 Claude 계정으로 새로 받으므로 네트워크가 필요함');
  if (!yes) lines.push(`- 남은 일: 목록을 확인한 뒤 never-public on --yes 로 ${losses.map((s) => s.key).join(', ')} 도 끔(이번에는 건너뜀)`);
  return lines;
}

// on 의 Claude Code 대상에서, 확인(--yes) 없이는 사라질 항목이 있는 동기화 키를 뺀다. { list, lines }.
function syncGate(list, o, yes) {
  const t = list.find((x) => x.name === 'claude' && !x.absent);
  const losses = t ? syncLosses(t, o) : [];
  if (!losses.length) return { list, lines: [] };
  const skip = yes ? [] : losses.map((s) => s.key);
  const gated = list.map((x) => (x === t ? { ...x, want: x.want.filter(([keys]) => !skip.includes(keys[0])) } : x));
  return { list: gated, lines: lossLines(losses, yes) };
}

export const RESYNC = '- claude.ai 스킬과 플러그인은 되살리지 않음. 다음 시작 때 Claude 계정으로 새로 받음(네트워크 필요). .trash 의 사본은 cleanupPeriodDays 뒤 지워짐';

// on 이나 off. { code, message }. 쓰기 도중 오류는 앞서 바꾼 파일을 함께 알린다.
export function apply(action, o, only = null, yes = false) {
  const gate = action === 'on' ? syncGate(targets(o, only), o, yes) : { list: targets(o, only), lines: [] };
  const list = gate.list;
  if (!list.length) return { code: 1, message: '바꿀 대상이 없음(설정 폴더가 없음)' };
  const { loaded, why, failed } = loadAll(list);
  if (why) return { code: 1, message: `거부: ${why}. 아무것도 바꾸지 않음${onlyHint(list, failed)}` };
  const lines = [`never-public ${action}`, ...gate.lines];
  const done = [];
  for (const [t, r] of loaded) {
    try {
      const res = OPS[t.kind][action](t, r);
      if (res.changed.length) done.push(t.file);
      reportChange(lines, t, res, action);
    } catch (e) {
      e.done = done;
      throw e;
    }
  }
  if (action === 'on') lines.push(REMAINING);
  return { code: 0, message: lines.join('\n') };
}

export function status(o, only = null) {
  const lines = ['never-public 상태'];
  for (const t of targets(o, only)) {
    if (t.absent) {
      lines.push(`- ${LABEL[t.name]}: 설정 폴더 없음(${t.needDir})`);
      continue;
    }
    const r = OPS[t.kind].load(t);
    if (r.why) {
      lines.push(`- ${LABEL[t.name]}: 읽지 못함(${r.why})`);
      continue;
    }
    const rows = OPS[t.kind].status(t, r);
    const on = rows.filter((x) => x.on).length;
    lines.push(`- ${LABEL[t.name]}: ${on === rows.length ? '켜짐' : on ? `일부(${on}/${rows.length})` : '꺼짐'} (${t.file})`);
    for (const x of rows) lines.push(`  - ${x.on ? '[켬]' : '[ ]'} ${x.id} = ${x.now}`);
  }
  return { code: 0, message: lines.join('\n') };
}

/* ---------- 명령줄 ---------- */

const USAGE = '사용법: never-public on [--yes] | off | status [--only claude,codex,banker]';
const NAMES = ['claude', 'codex', 'banker'];

// argv 에서 --<name> x 나 --<name>=x 를 뺀다. { value(없으면 null), rest }.
function takeFlag(argv, name) {
  const rest = [];
  let value = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${name}`) value = argv[++i] ?? '';
    else if (argv[i].startsWith(`--${name}=`)) value = argv[i].slice(name.length + 3);
    else rest.push(argv[i]);
  }
  return { value, rest };
}

export function parseArgs(argv) {
  const { value, rest: all } = takeFlag(argv, 'only');
  const yes = all.includes('--yes'); // on 만: 사라질 claude.ai 항목을 확인했음
  const rest = all.filter((x) => x !== '--yes');
  const only = value === null ? null : value.split(',');
  const command = (rest[0] ?? 'status').toLowerCase();
  const badOnly = only !== null && only.some((x) => !NAMES.includes(x)); // '' 는 [''] 라 여기서 걸림
  const bad = rest.length > 1 || !['on', 'off', 'status'].includes(command) || badOnly || (yes && command !== 'on');
  return bad ? { error: USAGE } : { command, only, yes };
}

function failure(e) {
  const done = e.done?.length ? `\n앞서 바꾼 파일: ${e.done.join(', ')}` : '';
  if (denied(e)) return { code: 3, message: `쓸 권한이 없음(${e.code}): ${e.path ?? ''}${done}\nCodex 에서는 이 명령만 샌드박스 밖 실행 승인을 받아 다시 실행` };
  return { code: 2, message: `예기치 못한 오류로 중단함: ${e.message}${done}\nstatus 로 상태를 확인` };
}

export function main(argv, o = defaults()) {
  const args = parseArgs(argv);
  if (args.error) return { code: 1, message: args.error };
  try {
    return args.command === 'status' ? status(o, args.only) : apply(args.command, o, args.only, args.yes);
  } catch (e) {
    return failure(e);
  }
}

// 직접 실행일 때만. 링크로 부른 경로도 같게 본다(realpath 가 못 읽으면 resolve 로 비교).
const invokedDirectly = () => {
  const ranAs = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
  return Boolean(process.argv[1]) && ranAs(process.argv[1]) === fileURLToPath(import.meta.url);
};

if (invokedDirectly()) {
  const { code, message } = main(process.argv.slice(2));
  process.stdout.write(`${message}\n`);
  process.exitCode = code;
}
