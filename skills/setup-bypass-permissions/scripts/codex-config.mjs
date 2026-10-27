/*
 * Codex 의 config.toml 을 줄 단위로 읽고 고치는 공통 모듈. setup-bypass-permissions 가 정본이고 setup-omc-hud 의
 * assets/ 에 같은 사본을 둔다(scripts/sync-adapter.js 가 지킴).
 *
 * TOML 전체를 다시 쓰지 않는다. 바꾸는 키의 줄만 고쳐 주석, 순서, 다른 표는 그대로 둔다.
 * - 최상위 키는 첫 표 머리([...]) 앞의 줄만 본다. 표 안의 키는 그 표 머리 다음부터 다음 표 머리 전까지만 본다.
 * - 값이 여러 줄 배열이면 괄호가 닫히는 줄까지를 한 값으로 본다(문자열 안의 괄호는 센다고 보지 않는다).
 * - 파일이 링크이거나 일반 파일이 아니면 고치지 않는다. 쓰기 전 원본을 백업하고, 새 파일에 쓴 뒤 바꿔 넣으며 파일
 *   모드를 지킨다.
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
  if (backup && fs.existsSync(file)) fs.copyFileSync(file, backup);
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

const HEADER_RE = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/;
const lines = (text) => text.split(/\r?\n/);
const eol = (text) => (text.includes('\r\n') ? '\r\n' : '\n');
const keyRe = (key) => new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`);
const depth = (s) => [...s.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '')].reduce((d, c) => d + (c === '[' ? 1 : c === ']' ? -1 : 0), 0);

// 표의 줄 범위 [from, to). table '' 은 최상위. 표가 없으면 null.
function tableRange(ls, table) {
  let from = table ? -1 : 0;
  for (let i = 0; i < ls.length; i++) {
    const m = HEADER_RE.exec(ls[i]);
    if (!m) continue;
    if (from >= 0) return [from, i];
    if (m[1] === table) from = i + 1;
  }
  return from >= 0 ? [from, ls.length] : null;
}

// 키의 줄 범위 { at, end, raw } (end 는 값이 끝나는 줄 다음). 없으면 null.
export function findKey(text, table, key) {
  const ls = lines(text);
  const range = tableRange(ls, table);
  if (!range) return null;
  for (let i = range[0]; i < range[1]; i++) {
    if (!keyRe(key).test(ls[i])) continue;
    let end = i + 1;
    let d = depth(ls[i].slice(ls[i].indexOf('=') + 1).replace(/#.*$/, ''));
    while (d > 0 && end < range[1]) d += depth(ls[end++].replace(/#.*$/, ''));
    const raw = ls.slice(i, end).join('\n').replace(keyRe(key), '').trim();
    return { at: i, end, raw };
  }
  return null;
}

// 키를 rawValue 로 둔다. 있으면 그 줄을 바꾸고, 없으면 표 끝(최상위는 첫 표 머리 앞)에 넣는다. 표가 없으면 끝에 만든다.
// comment 가 있으면 키 바로 위에 그 주석 줄을 둔다.
export function setKey(text, table, key, rawValue, comment = '') {
  const ls = lines(text);
  const line = [...(comment ? [comment] : []), `${key} = ${rawValue}`];
  const hit = findKey(text, table, key);
  if (hit) {
    const above = comment && ls[hit.at - 1] === comment ? 1 : 0;
    ls.splice(hit.at - above, hit.end - hit.at + above, ...line);
    return ls.join(eol(text));
  }
  const range = tableRange(ls, table);
  if (!range) {
    while (ls.length && ls[ls.length - 1] === '') ls.pop();
    return [...ls, ...(ls.length ? [''] : []), `[${table}]`, ...line, ''].join(eol(text));
  }
  let at = range[1];
  while (at > range[0] && ls[at - 1].trim() === '') at--;
  ls.splice(at, 0, ...line);
  return ls.join(eol(text));
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

// 이름이 prefix 로 시작하는 표들 중 key 를 정한 표 이름(예: profiles.* 의 approval_policy).
export function tablesSetting(text, prefix, key) {
  const names = lines(text).map((l) => HEADER_RE.exec(l)?.[1]).filter((n) => n && n.startsWith(prefix));
  return [...new Set(names)].filter((n) => findKey(text, n, key));
}

// 쓰기 실패가 이 계정의 권한(샌드박스, 읽기 전용, 다른 소유자) 때문인지.
export const denied = (e) => ['EACCES', 'EPERM', 'EROFS'].includes(e?.code);
