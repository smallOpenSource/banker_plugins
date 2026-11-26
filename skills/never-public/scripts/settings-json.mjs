/*
 * JSON 설정 파일(Claude Code settings.json, banker config.json, Codex hooks.json)을 읽고 고치는 공통 모듈.
 * never-public 이 정본이고 in-korean 의 scripts/ 에 같은 사본을 둔다(scripts/sync-adapter.js 가 지킴).
 *
 * - 읽기: 없으면 {}. 빈 파일(공백만)도 {}. 앞의 BOM 은 지켜 다시 쓴다. UTF-8 이 아니거나, JSON 이 깨졌거나, 최상위가
 *   객체가 아니거나, 일반 파일이 아니면(폴더, FIFO) 까닭을 돌려주고 고치지 않는다. 링크는 따라가 그 너머 파일을 읽는다.
 * - 쓰기: 같은 폴더의 난수 이름 새 파일(wx)에 쓰고 rename 으로 바꿔 넣는다. 중간에 멈춰도 반쯤 쓴 파일이 남지 않는다.
 *   링크이면 링크는 두고 그 너머 파일을 바꾼다. 파일 모드는 지키고, 새 파일은 0600.
 * - 백업: 바꾸기 전 원래 바이트를 <파일>.<이름>.bak 에 둔다(이 계정만 읽음. 설정에 비밀 값이 있을 수 있다).
 * - 경로 값: ['attribution', 'commit'] 처럼 키 배열로 읽고, 두고, 뺀다. 빼서 빈 객체가 된 부모는 지운다(만든 쪽이 뺄 때).
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

export const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const sameValue = (a, b) => isDeepStrictEqual(a, b);

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }); // BOM 은 글에 남기고, 다른 인코딩은 거부

// 파일의 종류를 본다. 없으면 'missing', 일반 파일(링크면 그 너머)이면 '', 그 밖은 까닭.
function kindOf(file) {
  try {
    lstatSync(file);
  } catch (e) {
    if (e.code === 'ENOENT') return 'missing';
    return `${file} 을 확인하지 못함(${e.code})`;
  }
  try {
    return statSync(file).isFile() ? '' : `${file} 이 일반 파일이 아님(폴더나 특수 파일)`;
  } catch (e) {
    return e.code === 'ENOENT' ? `${file} 이 끊어진 링크임` : `${file} 을 확인하지 못함(${e.code})`;
  }
}

// { exists, raw, data, bom } 또는 { why }. raw 는 원래 바이트(없으면 null).
export function readJson(file) {
  const kind = kindOf(file);
  if (kind === 'missing') return { exists: false, raw: null, data: {}, bom: '' };
  if (kind) return { why: kind };
  const raw = readFileSync(file);
  let text;
  try {
    text = utf8.decode(raw);
  } catch {
    return { why: `${file} 이 UTF-8 이 아님` };
  }
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const body = text.slice(bom.length);
  if (!body.trim()) return { exists: true, raw, data: {}, bom };
  let data;
  try {
    data = JSON.parse(body);
  } catch (e) {
    return { why: `${file} 이 올바른 JSON 이 아님(${e.message}). 고치지 않고 그대로 둠` };
  }
  return isObject(data) ? { exists: true, raw, data, bom } : { why: `${file} 의 최상위가 JSON 객체가 아님` };
}

// 난수 이름 새 파일에 쓴 뒤 file 자리로 바꿔 넣는다. 그 자리의 폴더는 거부한다(Windows 는 EPERM 으로 답해 권한 문제로 보임).
export function writeFresh(file, data, mode = 0o600) {
  if (lstatSync(file, { throwIfNoEntry: false })?.isDirectory()) {
    throw Object.assign(new Error(`쓸 자리에 폴더가 있음: ${file}`), { code: 'EISDIR' });
  }
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, data, { flag: 'wx', mode });
    chmodSync(tmp, mode); // umask 와 관계없이
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

export const serialize = (data, bom = '') => `${bom}${JSON.stringify(data, null, 2)}\n`;

// data 를 file 에 쓴다. 링크면 그 너머 파일을 바꾸고, 원래 모드를 지킨다. backup 이 있고 원래 바이트가 있으면 먼저 백업.
export function writeJson(file, data, { bom = '', raw = null, backup = null } = {}) {
  if (backup && raw) writeFresh(backup, raw, 0o600);
  const real = existsSync(file) ? realpathSync(file) : file;
  const mode = existsSync(real) ? statSync(real).mode & 0o777 : 0o600;
  writeFresh(real, serialize(data, bom), mode);
}

// 경로의 값. { has, value }.
export function getPath(obj, keys) {
  let cur = obj;
  for (const k of keys) {
    if (!isObject(cur) || !Object.prototype.hasOwnProperty.call(cur, k)) return { has: false };
    cur = cur[k];
  }
  return { has: true, value: cur };
}

// 경로의 부모 중 객체가 아닌 값이 있는 첫 경로(점으로 이음), 없으면 ''. 그 자리에는 값을 둘 수 없다.
export function blockedParent(obj, keys) {
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!Object.prototype.hasOwnProperty.call(cur, keys[i])) return '';
    cur = cur[keys[i]];
    if (!isObject(cur)) return keys.slice(0, i + 1).join('.');
  }
  return '';
}

// 경로에 값을 둔다(없는 부모 객체는 만든다). obj 를 바로 고친다.
export function setPath(obj, keys, value) {
  let cur = obj;
  for (const k of keys.slice(0, -1)) {
    if (!isObject(cur[k])) cur[k] = {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
}

// 경로의 값을 뺀다. prune 에 든 부모 경로(점으로 이음)는 비면 함께 지운다. obj 를 바로 고친다.
export function deletePath(obj, keys, prune = []) {
  const chain = [obj];
  for (const k of keys.slice(0, -1)) {
    const next = chain[chain.length - 1][k];
    if (!isObject(next)) return;
    chain.push(next);
  }
  delete chain[chain.length - 1][keys[keys.length - 1]];
  for (let i = chain.length - 1; i > 0; i--) {
    const name = keys.slice(0, i).join('.');
    if (!prune.includes(name) || Object.keys(chain[i]).length) break;
    delete chain[i - 1][keys[i - 1]];
  }
}

// 기록 파일(JSON 객체)을 읽는다. 없거나 깨졌거나 객체가 아니면 null.
export function readRecord(file) {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    return isObject(data) ? data : null;
  } catch {
    return null;
  }
}

// 쓰기 실패가 이 계정의 권한(샌드박스, 읽기 전용, 다른 소유자) 때문인지.
export const denied = (e) => ['EACCES', 'EPERM', 'EROFS'].includes(e?.code);
