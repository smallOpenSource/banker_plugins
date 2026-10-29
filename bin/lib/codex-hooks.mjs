/*
 * banker 의 Codex 훅 설치. Claude Code 는 플러그인의 hooks/hooks.json 을 바로 읽지만 Codex 는
 * <CODEX_HOME>/hooks.json 만 읽고, 새 훅은 사용자가 신뢰해야 돈다("Hooks need review", /hooks).
 *
 * - 훅 스크립트와 그 의존 파일을 <CODEX_HOME>/hooks-custom/banker/ 에 패키지와 같은 배치로 복사하고, 훅은 그 사본을
 *   돌린다. Codex 는 신뢰한 훅을 샌드박스 밖에서 돌리므로, 작업 폴더 안의 파일을 가리키지 않게 하기 위해서다.
 * - 묶음은 각 이벤트의 맨 뒤에 더한다. Codex 는 신뢰를 <hooks.json>:<이벤트>:<묶음 번호>:<항목 번호> 로 기록해, 앞에
 *   끼우면 OMX 훅의 번호가 밀려 다시 신뢰해야 한다. 빼기는 우리 항목만, 낡은 명령은 같은 자리에서 고친다.
 * - Windows 의 Codex 는 훅 명령을 PowerShell 로 돌린다(Codex 0.160.1 실측): `& '<node>' -e '<검사>' '<스크립트>' 인자`.
 *   검사(hookGuard)는 스크립트의 실제 경로가 임시 폴더나 세션 폴더 아래면 돌리지 않는다.
 * - hooks.json 이 링크이거나 JSON 객체가 아니거나 "없음" 말고 다른 이유로 확인할 수 없으면 바꾸지 않는다. 바꿀 때마다
 *   직전 내용을 hooks.json.banker.bak 에 둔다. smart-compact 의 codex-gate.mjs 와 같은 규칙이다.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 훅마다 이벤트, 스크립트(패키지 기준 경로), 인자, 도구 이름 matcher(있으면 그 도구 호출 뒤에만 돈다).
export const HOOKS = {
  update: { event: 'SessionStart', script: 'hooks/update-notify.mjs', args: ['--codex'] },
  count: { event: 'Stop', script: 'hooks/telemetry-count-codex.mjs', args: [] },
  obsidize: { event: 'PostToolUse', script: 'hooks/obsidize-hook.mjs', args: ['--codex'], matcher: 'Bash' },
};
// 사본으로 옮길 파일(훅 스크립트와 그 의존 파일). 상대 경로를 그대로 둬 '../bin/lib/...' 가져오기가 맞는다.
export const PAYLOAD = [
  '.claude-plugin/plugin.json',
  'bin/lib/telemetry-config.mjs',
  'bin/lib/codex-routes.mjs',
  'hooks/update-notify.mjs',
  'hooks/update-fetch.mjs',
  'hooks/update-checkin.mjs',
  'hooks/telemetry-count-codex.mjs',
  'hooks/obsidize-hook.mjs',
  'skills/obsidizer/obsidize.mjs',
];
export const DEFAULT_HOOKS = ['update', 'count'];

// Codex 처럼 상대 경로 CODEX_HOME 은 지금 폴더 기준으로 푼다.
export function codexPaths(env = process.env) {
  const home = env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(os.homedir(), '.codex');
  return { home, hooks: path.join(home, 'hooks.json'), backup: path.join(home, 'hooks.json.banker.bak'), dir: path.join(home, 'hooks-custom', 'banker') };
}

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, data, { flag: 'wx' });
    const mode = modeOf(file);
    if (mode !== null) fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

function modeOf(file) {
  try {
    const st = fs.lstatSync(file);
    return st.isFile() ? st.mode & 0o7777 : null;
  } catch {
    return null;
  }
}

// 명령 글. POSIX 는 큰따옴표, 셸이 그 안에서 읽는 글자는 거부. Windows 는 PowerShell 호출 연산자와 작은따옴표.
// guard 가 있으면 node -e <guard> <스크립트> 인자 꼴(guard 는 큰따옴표, $, 백틱, 백슬래시가 없는 고정 글).
export function formatCommand(node, script, args, win = process.platform === 'win32', guard = '') {
  const all = [node, script, ...args].join('');
  if (/[\r\n\0]/.test(all)) return null;
  const pre = guard ? ['-e'] : [];
  if (win) {
    const q = (s) => `'${s.replace(/['‘-‛]/g, '$&$&')}'`;
    return ['&', q(node), ...pre, ...(guard ? [q(guard)] : []), q(script), ...args].join(' ');
  }
  if (/["$`\\]/.test(all)) return null;
  return [`"${node}"`, ...pre, ...(guard ? [`"${guard}"`] : []), `"${script}"`, ...args].join(' ');
}

// npm 길 훅 명령이 스크립트를 부르기 전에 하는 검사(Codex 플러그인 훅의 래퍼와 같은 규칙): 스크립트의 실제 경로가 임시
// 폴더나 세션 폴더(Codex 가 훅을 도는 폴더) 아래면 돌리지 않고 까닭을 알린다. 세션 폴더가 홈 폴더 자체면 세션 폴더
// 규칙은 쓰지 않는다. Codex 홈이 세션 폴더 깊은 곳(CODEX_HOME=<세션>/deep/.codex)이면 샌드박스가 그 사본을 고칠 수
// 있기 때문이다. 검사는 신뢰 해시에 묶인 명령 글에 있다. 세션 시작 훅은 systemMessage 로, 다른 훅은 stderr 로 알린다.
export function hookGuard(notice) {
  const say = notice
    ? 'process.stdout.write(JSON.stringify({systemMessage:m}))'
    : 'process.stderr.write(m+String.fromCharCode(10))';
  return [
    "const f=require('fs'),p=require('path'),o=require('os');",
    'const r=(x)=>{try{return f.realpathSync(x)}catch{return x}};',
    'const s=r(process.argv[1]),w=r(process.cwd()),h=r(o.homedir());',
    "const u=(d)=>{const q=p.relative(d,s);return q===''||!(q.startsWith('..')||p.isAbsolute(q))};",
    "if([o.tmpdir()].concat(process.platform==='win32'?[]:['/tmp']).map(r).some(u)||(w!==h&&u(w))){",
    "const m='banker hooks skipped: the hook script is in a temp folder or the session folder ('+s+')';",
    `${say};process.exit(0)}`,
    "import(require('url').pathToFileURL(s).href)",
  ].join('');
}

const hookCommand = (p, id, node, win = process.platform === 'win32') => formatCommand(node, scriptOf(p, id), HOOKS[id].args, win, hookGuard(HOOKS[id].event === 'SessionStart'));

// 임시 폴더의 node 는 거부한다. Codex 안에서 돌 때는 작업 폴더 안의 node 도(샌드박스 안 세션이 고칠 수 있다).
export function safeNode(node, { win = process.platform === 'win32', cwd = process.cwd(), codex = Boolean(process.env.CODEX_THREAD_ID), home = os.homedir() } = {}) {
  const P = win ? path.win32 : path.posix;
  const under = (f, dir) => {
    const r = P.relative(dir, f);
    return r === '' || (!r.startsWith('..') && !P.isAbsolute(r));
  };
  // A link elsewhere is judged where it leads too, so a link in a safe place cannot pin a node from the temp folder.
  const places = [node, real(node)];
  // A session in the home folder is no workspace to judge by (as homeInWorkspace): nvm keeps node under ~/.nvm. Only an
  // absolute home names one (HOME=. would make every folder the home); path.relative compares as the OS does (case on Windows).
  const isHome = P.isAbsolute(home) && P.relative(real(home), real(cwd)) === '';
  const inWork = codex && !isHome;
  return !places.some((f) => under(f, os.tmpdir()) || (inWork && under(f, cwd)));
}

function real(file) {
  try {
    return fs.realpathSync(file);
  } catch {
    return file;
  }
}

const scriptOf = (p, id) => path.join(p.dir, ...HOOKS[id].script.split('/'));
const markOf = (id) => `/hooks-custom/banker/${HOOKS[id].script}`;
const isOurs = (h, id) => isObject(h) && typeof h.command === 'string' && h.command.replace(/\\/g, '/').includes(markOf(id));

function fileKind(file) {
  try {
    const st = fs.lstatSync(file);
    return st.isSymbolicLink() || !st.isFile() ? `${file} 이 일반 파일이 아님(링크나 폴더)` : '';
  } catch (e) {
    return e && e.code === 'ENOENT' ? 'missing' : `${file} 을 확인하지 못함(${e && e.code})`;
  }
}

// hooks.json 을 객체로, 또는 바꿀 수 없는 까닭. 쓰는 이벤트의 값이 배열이 아니면 거부한다.
export function loadHooks(file, events) {
  const kind = fileKind(file);
  if (kind === 'missing') return { doc: { hooks: {} } };
  if (kind) return { why: kind };
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    doc = null;
  }
  if (!isObject(doc)) return { why: `${file} 이 JSON 객체가 아님` };
  if (doc.hooks === undefined) doc.hooks = {};
  if (!isObject(doc.hooks)) return { why: `${file} 의 hooks 가 객체가 아님` };
  const bad = events.find((e) => doc.hooks[e] !== undefined && !Array.isArray(doc.hooks[e]));
  return bad ? { why: `${file} 의 ${bad} 가 배열이 아님` } : { doc };
}

function findOurs(groups, id) {
  for (let g = 0; g < groups.length; g++) {
    const hs = isObject(groups[g]) && Array.isArray(groups[g].hooks) ? groups[g].hooks : [];
    const h = hs.findIndex((x) => isOurs(x, id));
    if (h >= 0) return [g, h];
  }
  return null;
}

function saveHooks(p, doc) {
  if (fs.existsSync(p.hooks)) writeAtomic(p.backup, fs.readFileSync(p.hooks));
  writeAtomic(p.hooks, `${JSON.stringify(doc, null, 2)}\n`);
}

// 사본 폴더. 링크인 폴더는 거부하고, 파일은 내용이 다를 때만 새로 쓴다.
export function installPayload(p, pkgRoot) {
  fs.mkdirSync(p.dir, { recursive: true });
  if (fs.lstatSync(p.dir).isSymbolicLink()) return `${p.dir} 이 링크임`;
  for (const rel of PAYLOAD) {
    const dest = path.join(p.dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (fs.existsSync(dest) && !fs.lstatSync(dest).isFile()) return `${dest} 이 일반 파일이 아님`;
    const data = fs.readFileSync(path.join(pkgRoot, ...rel.split('/')));
    if (!fs.existsSync(dest) || !fs.readFileSync(dest).equals(data)) writeAtomic(dest, data);
  }
  return '';
}

// 한 훅을 제자리에 두기: 없으면 이벤트 맨 뒤 묶음으로, 명령이 낡았으면 같은 자리에서 고친다. 바뀌었으면 true.
function place(doc, id, command) {
  const ev = HOOKS[id].event;
  const groups = doc.hooks[ev] || [];
  const at = findOurs(groups, id);
  if (at && groups[at[0]].hooks[at[1]].command === command) return false;
  if (at) groups[at[0]].hooks[at[1]] = { ...groups[at[0]].hooks[at[1]], command, timeout: 5 };
  else groups.push({ ...(HOOKS[id].matcher ? { matcher: HOOKS[id].matcher } : {}), hooks: [{ type: 'command', command, timeout: 5 }] });
  doc.hooks[ev] = groups;
  return true;
}

// Codex 홈이 지금 폴더 안이면(예: 폴더의 .envrc 가 CODEX_HOME=./.codex) 훅 사본도 작업 폴더 안에 놓여, 샌드박스 안의
// 세션이 샌드박스 밖에서 도는 훅을 고칠 수 있다. 홈 폴더와 파일 시스템 루트는 작업 폴더로 보지 않는다.
export function homeInWorkspace(home, cwd = process.cwd()) {
  const r = real(cwd);
  if (r === real(os.homedir()) || r === path.parse(r).root) return false;
  const h = real(home);
  return h === r || h.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

// Codex 홈에서 위로 올라가며 .git(폴더나 파일)이 있는 첫 폴더, 없으면 ''. git 을 실행하지 않는다. 사용자 홈 폴더 자체의
// .git(dotfiles 저장소)은 보지 않는다.
export function repoAbove(home, userHome = os.homedir()) {
  const skip = real(userHome);
  for (let d = real(home); ; d = path.dirname(d)) {
    if (d !== skip && fs.existsSync(path.join(d, '.git'))) return d;
    if (path.dirname(d) === d) return '';
  }
}

// ids 를 켠다. { code, changed:[id], msg, note }. code 1 이면 아무것도 바꾸지 않았다. note 는 알릴 것(Codex 홈 위의 저장소).
export function enableHooks(p, ids, pkgRoot, node = process.execPath, cwd = process.cwd()) {
  if (!safeNode(node)) return { code: 1, changed: [], msg: `node 가 안전하지 않은 곳에 있음(${node})` };
  if (homeInWorkspace(p.home, cwd)) return { code: 1, changed: [], msg: `Codex 홈(${p.home})이 작업 폴더 안이라 훅을 설치하지 않음. 샌드박스가 고칠 수 있는 곳임` };
  const { doc, why } = loadHooks(p.hooks, ids.map((id) => HOOKS[id].event));
  if (why) return { code: 1, changed: [], msg: why };
  const cmds = ids.map((id) => [id, hookCommand(p, id, node)]);
  if (cmds.some(([, c]) => !c)) return { code: 1, changed: [], msg: '경로에 셸이 읽는 글자가 있음' };
  const bad = installPayload(p, pkgRoot);
  if (bad) return { code: 1, changed: [], msg: bad };
  const changed = cmds.filter(([id, c]) => place(doc, id, c)).map(([id]) => id);
  if (changed.length) saveHooks(p, doc);
  const repo = repoAbove(p.home);
  const note = repo ? `Codex 홈(${p.home})이 git 저장소(${repo}) 안에 있음. Codex 홈을 품은 폴더에서 Codex 를 열면 banker 훅은 돌지 않고 세션 시작 때 까닭을 알림` : '';
  return { code: 0, changed, msg: '', note };
}

// ids 를 끈다: 우리 항목만 빼고, 비는 묶음과 이벤트를 지운다. 뒤 묶음의 번호가 밀리면 shifted 에 이벤트를 적는다.
export function disableHooks(p, ids) {
  const { doc, why } = loadHooks(p.hooks, ids.map((id) => HOOKS[id].event));
  if (why) return { code: 1, changed: [], shifted: [], msg: why };
  const changed = [];
  const shifted = [];
  for (const id of ids) {
    const ev = HOOKS[id].event;
    const groups = doc.hooks[ev] || [];
    const at = findOurs(groups, id);
    if (!at) continue;
    const hs = groups[at[0]].hooks.filter((h) => !isOurs(h, id));
    if (hs.length) groups[at[0]].hooks = hs;
    else {
      if (at[0] < groups.length - 1) shifted.push(ev);
      groups.splice(at[0], 1);
    }
    if (groups.length) doc.hooks[ev] = groups;
    else delete doc.hooks[ev];
    changed.push(id);
  }
  if (changed.length) saveHooks(p, doc);
  return { code: 0, changed, shifted, msg: '' };
}

// 훅마다 'on' | 'off' | 'stale'(명령이 이 node 와 사본을 가리키지 않거나 사본이 이 판과 다름). 읽지 못하면 why.
export function hookStatus(p, ids, pkgRoot, node = process.execPath) {
  const { doc, why } = loadHooks(p.hooks, ids.map((id) => HOOKS[id].event));
  if (why) return { why };
  const out = {};
  for (const id of ids) {
    const groups = doc.hooks[HOOKS[id].event] || [];
    const at = findOurs(groups, id);
    if (!at) out[id] = 'off';
    else out[id] = groups[at[0]].hooks[at[1]].command === hookCommand(p, id, node) && copyCurrent(p, pkgRoot) ? 'on' : 'stale';
  }
  return { status: out };
}

function copyCurrent(p, pkgRoot) {
  try {
    return PAYLOAD.every((rel) => fs.readFileSync(path.join(p.dir, ...rel.split('/'))).equals(fs.readFileSync(path.join(pkgRoot, ...rel.split('/')))));
  } catch {
    return false;
  }
}

// 모든 banker 훅을 빼고 사본 폴더를 지운다(banker uninstall --codex).
export function removeAll(p) {
  const r = disableHooks(p, Object.keys(HOOKS));
  if (r.code === 0) fs.rmSync(p.dir, { recursive: true, force: true });
  return r;
}

export const TRUST_NOTE = 'Codex 를 다시 열면 뜨는 Hooks need review 창이나 /hooks 에서 banker 훅을 신뢰하십시오. 신뢰 전에는 돌지 않습니다.';
