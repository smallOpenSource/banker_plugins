/*
 * Codex 의 config.toml 을 줄 단위로 읽고 고치는 공통 모듈. setup-bypass-permissions 가 정본이고 setup-omc-hud 의
 * assets/ 에 같은 사본을 둔다(scripts/sync-adapter.js 가 지킴).
 *
 * TOML 전체를 다시 쓰지 않는다. 바꾸는 키의 줄만 고쳐 주석, 순서, 다른 표는 그대로 둔다.
 * - 줄을 훑으며 문자열(한 줄, 여러 줄)과 괄호 깊이를 따라가, 여러 줄 문자열이나 배열 안의 줄을 표 머리나 키로 보지 않는다.
 * - 키 이름은 따옴표를 벗겨 비교한다(`"approval_policy"` 도 approval_policy). 값 끝의 주석은 값으로 보지 않는다.
 * - 최상위가 표를 점 키나 인라인 표로 정했는지(definedInline) 알려, 그런 파일에 같은 표를 더하지 않게 한다.
 * - 파일이 링크이거나 일반 파일이 아니면 고치지 않는다. 쓰기 전 원본을 백업(이 계정만 읽음)하고, 새 파일에 쓴 뒤
 *   바꿔 넣으며 파일 모드를 지킨다.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Codex 처럼 상대 경로 CODEX_HOME 은 지금 폴더 기준으로 푼다.
export function codexConfigFile(env = process.env) {
  const home = env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(os.homedir(), '.codex');
  return path.join(home, 'config.toml');
}

export class Refused extends Error {}

// { text, mode, exists }. 없으면 빈 글. 링크나 일반 파일이 아니면 Refused.
export function readToml(file) {
  let st;
  try {
    st = fs.lstatSync(file);
  } catch (e) {
    if (e.code === 'ENOENT') return { text: '', mode: null, exists: false };
    throw e;
  }
  if (!st.isFile()) throw new Refused(`${file} 이 일반 파일이 아님(링크이거나 다른 종류)`);
  return { text: fs.readFileSync(file, 'utf8'), mode: st.mode & 0o7777, exists: true };
}

// 원본을 backup 에 복사한 뒤(원본이 있을 때) 새 파일에 써서 바꿔 넣는다.
export function writeToml(file, text, { mode = null, backup = null } = {}) {
  if (backup && fs.existsSync(file)) {
    fs.copyFileSync(file, backup);
    fs.chmodSync(backup, 0o600); // 원본에 비밀 값이 있을 수 있다
  }
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { flag: 'wx', mode: mode ?? 0o600 });
    if (mode !== null) fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

const lines = (text) => text.split(/\r?\n/);
const eol = (text) => (text.includes('\r\n') ? '\r\n' : '\n');
// 파일이 쓰는 줄바꿈(CRLF 가 하나라도 있으면 CRLF).
export const eolOf = eol;
const TRIPLE = ['"""', "'''"];

// 키나 표 이름을 낱말 배열로. 따옴표 안의 점은 나누지 않는다(`profiles."a.b"` 는 ['profiles', 'a.b']).
export const nameParts = (s) => (s.match(/"[^"]*"|'[^']*'|[^.\s]+/g) ?? []).map((p) => p.replace(/^"(.*)"$|^'(.*)'$/, '$1$2'));
// 비교용 이름. 낱말 사이를 \u0000 으로 이어, 점이 든 낱말과 점으로 나뉜 낱말을 구분한다.
const plainName = (s) => nameParts(s).join('\u0000');

// 한 줄을 문자열 밖에서 훑는다. { d: 괄호 깊이 변화, multi: 줄 끝에 열려 있는 여러 줄 문자열 구분자, cut: 주석 시작 위치 }.
function scanLine(s, multi = '') {
  let d = 0;
  for (let i = 0; i < s.length; i++) {
    if (multi) {
      if (s.startsWith(multi, i)) { i += 2; multi = ''; } else if (multi === TRIPLE[0] && s[i] === '\\') i++;
      continue;
    }
    const c = s[i];
    if (TRIPLE.some((t) => s.startsWith(t, i))) { multi = s.slice(i, i + 3); i += 2; }
    else if (c === '"') { for (i++; i < s.length && s[i] !== '"'; i++) if (s[i] === '\\') i++; }
    else if (c === "'") { const k = s.indexOf("'", i + 1); i = k < 0 ? s.length : k; }
    else if (c === '#') return { d, multi, cut: i };
    else if (c === '[' || c === '{') d++;
    else if (c === ']' || c === '}') d--;
  }
  return { d, multi, cut: s.length };
}

// 표 머리. 이름 안의 따옴표 친 낱말에는 ] 가 들어갈 수 있다(`[projects."/a]b"]`).
const HEADER_RE = /^\s*\[\[?\s*((?:"[^"]*"|'[^']*'|[^\]"'])+?)\s*\]\]?\s*(#.*)?$/;
const KEY_RE = /^\s*((?:"[^"]*"|'[^']*'|[A-Za-z0-9_-]+)(?:\s*\.\s*(?:"[^"]*"|'[^']*'|[A-Za-z0-9_-]+))*)\s*=(.*)$/;

// 줄마다 { kind: 'header'|'key'|'inside'|'other', name, end }. header 의 name 은 표 이름, key 의 name 은 키 이름이고
// end 는 값이 끝나는 줄 다음. 여러 줄 문자열이나 배열 안의 줄은 inside.
export function scan(text) {
  const ls = lines(text);
  const out = ls.map(() => ({ kind: 'other' }));
  for (let i = 0; i < ls.length; i++) {
    const header = HEADER_RE.exec(ls[i]);
    if (header) { out[i] = { kind: 'header', name: plainName(header[1]) }; continue; }
    const key = KEY_RE.exec(ls[i]);
    if (!key) continue;
    let { d, multi } = scanLine(key[2]);
    let j = i + 1;
    for (; (d > 0 || multi) && j < ls.length; j++) {
      out[j] = { kind: 'inside' };
      const r = scanLine(ls[j], multi);
      d += r.d;
      multi = r.multi;
    }
    out[i] = { kind: 'key', name: plainName(key[1]), end: j };
    i = j - 1;
  }
  return out;
}

// 표의 줄 범위 [from, to). table '' 은 최상위. 표가 없으면 null.
function tableRange(info, table) {
  table = table.includes('\u0000') || !table ? table : plainName(table);
  let from = table ? -1 : 0;
  for (let i = 0; i < info.length; i++) {
    if (info[i].kind !== 'header') continue;
    if (from >= 0) return [from, i];
    if (info[i].name === table) from = i + 1;
  }
  return from >= 0 ? [from, info.length] : null;
}

function keysOf(text, table) {
  const info = scan(text);
  const range = tableRange(info, table);
  if (!range) return [];
  const keys = [];
  for (let i = range[0]; i < range[1]; i++) if (info[i].kind === 'key') keys.push({ at: i, end: info[i].end, name: info[i].name });
  return keys;
}

// 키의 { at, end, raw }. raw 는 값 끝의 주석을 뺀 글. 없으면 null.
export function findKey(text, table, key) {
  const want = nameParts(key).join('\u0000');
  const hit = keysOf(text, plainName(table)).find((k) => k.name === want);
  if (!hit) return null;
  const ls = lines(text).slice(hit.at, hit.end);
  const parts = [ls[0].slice(ls[0].indexOf('=') + 1), ...ls.slice(1)];
  let multi = '';
  for (const part of parts.slice(0, -1)) multi = scanLine(part, multi).multi;
  const last = parts.length - 1;
  parts[last] = parts[last].slice(0, scanLine(parts[last], multi).cut); // 마지막 줄의 주석을 뗀다
  const raw = parts.join('\n');
  return { at: hit.at, end: hit.end, raw: raw.trim() };
}

// 최상위가 이 표를 점 키나 인라인 표로 정했는지(`tui.x = 1`, `tui = { ... }`). 그런 파일에 [표] 를 더하면 키가 겹쳐
// Codex 가 설정을 읽지 못한다.
export function definedInline(text, table) {
  const t = plainName(table);
  return keysOf(text, '').some((k) => k.name === t || k.name.startsWith(`${t}\u0000`));
}

// 키를 rawValue 로 둔다. 있으면 그 줄을 바꾸고, 없으면 표 끝(최상위는 첫 표 머리 앞)에 넣는다. 표가 없으면 끝에 만든다.
// comment 가 있으면 키 바로 위에 그 주석 줄을 둔다.
export function setKey(text, table, key, rawValue, comment = '') {
  const ls = lines(text);
  const nl = eol(text);
  const line = [...(comment ? [comment] : []), `${key} = ${rawValue}`];
  const hit = findKey(text, table, key);
  if (hit) {
    const above = comment && ls[hit.at - 1] === comment ? 1 : 0;
    ls.splice(hit.at - above, hit.end - hit.at + above, ...line);
    return ls.join(nl);
  }
  const range = tableRange(scan(text), table);
  if (!range) {
    while (ls.length && ls[ls.length - 1] === '') ls.pop();
    return [...ls, ...(ls.length ? [''] : []), `[${table}]`, ...line, ''].join(nl);
  }
  // 다음 표 머리에 붙은 주석(`# MCP servers` 처럼 머리 바로 위의 주석 줄)과 그 앞 빈 줄은 건너뛰고 넣는다.
  let at = range[1];
  if (range[1] < ls.length) while (at > range[0] && ls[at - 1].trim().startsWith('#')) at--;
  while (at > range[0] && ls[at - 1].trim() === '') at--;
  ls.splice(at, 0, ...line);
  return ls.join(nl);
}

// 키를 뺀다. comment 와 같은 주석 줄이 바로 위에 있으면 그것도 뺀다.
export function removeKey(text, table, key, comment = '') {
  const hit = findKey(text, table, key);
  if (!hit) return text;
  const ls = lines(text);
  const above = comment && ls[hit.at - 1] === comment ? 1 : 0;
  ls.splice(hit.at - above, hit.end - hit.at + above);
  return ls.join(eol(text));
}

// 표에 키도 주석도 없으면 그 머리와 뒤의 빈 줄을 뺀다.
export function dropEmptyTable(text, table) {
  const info = scan(text);
  const range = tableRange(info, table);
  if (!range) return text;
  const ls = lines(text);
  if (ls.slice(range[0], range[1]).some((l) => l.trim())) return text;
  ls.splice(range[0] - 1, range[1] - range[0] + 1);
  return ls.join(eol(text));
}

// 이름이 prefix 로 시작하는 표들 중 key 를 정한 표 이름(예: profiles.* 의 approval_policy).
export function tablesSetting(text, prefix, key) {
  const p = plainName(prefix);
  const names = scan(text).filter((x) => x.kind === 'header' && x.name.startsWith(`${p}\u0000`)).map((x) => x.name);
  return [...new Set(names)].filter((n) => findKey(text, n, key)).map((n) => n.split('\u0000').join('.'));
}

// 쓰기 실패가 이 계정의 권한(샌드박스, 읽기 전용, 다른 소유자) 때문인지.
export const denied = (e) => ['EACCES', 'EPERM', 'EROFS'].includes(e?.code);
