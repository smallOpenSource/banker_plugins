// pm-config.mjs: 프로젝트 루트와 자료 폴더 결정, 런타임 판별, config.json 읽기와 기본값, 형식 검사, 원자적 쓰기.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const DATA_REL = { claude: '.omc/progress-mon', codex: '.omx/progress-mon' };
const RUNTIMES = Object.keys(DATA_REL);

// events 출처가 있을 때 쓰는 기본 단계(ultra-chain 10단계).
export const ULTRA_STAGES = [
  { id: 'preflight', label: '0 사전 점검' },
  { id: 'research', label: '1 자료 조사' },
  { id: 'interview', label: '2 모호성 제거' },
  { id: 'plan', label: '3 합의 계획' },
  { id: 'mock', label: '4 목업 승인' },
  { id: 'build', label: '5 구현' },
  { id: 'qa', label: '6 합의 검증, 박스 시험' },
  { id: 'visual', label: '7 시각 검토' },
  { id: 'trace', label: '8 과정 시각화' },
  { id: 'share', label: '9 결과 공유' },
];

export const DEFAULT_REQ_RULE =
  '구현 여부: 근거 AC 의 담당 스토리가 모두 완료되면 완료, 일부만 완료되면 일부, 남은 스토리에 에이전트가 돌면 진행 중, 완료가 없으면 미구현. 담당 스토리가 없는 명세는 미검증. 명세에 state 를 적어 따로 판정한 명세는 그 판정이 앞섬. 대상 제외: 범위에서 뺌. 완료율에 넣지 않음.';
// 담당 스토리 칸이 없을 때(스토리가 없고 AC 에 담당 스토리도 없음) text.reqRule 이 기본 문구 그대로면 대신 보이는 문구(판정은 명세의 state).
export const STORYLESS_REQ_RULE =
  '구현 여부: 스토리가 없는 프로젝트라 명세에 적은 state 로 판정. state 가 없는 명세는 근거 AC 가 있으면 미검증, 없으면 명세 없음. 대상 제외: 범위에서 뺌. 완료율에 넣지 않음.';

export const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

// JSON 글 앞의 BOM 을 뗀다.
export const noBom = (text) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

// 자료와 출처 파일을 읽는 크기 상한.
export const READ_MAX = 32 * 1024 * 1024;

// 일반 파일만 읽는다(링크는 따라감). FIFO, 장치 같은 특수 파일은 열지 않는다(열면 멈추거나 끝없이 읽어 메모리를 다 씀).
// 특수 파일은 EINVAL, max 를 넘는 파일은 EFBIG 예외. encoding 이 null 이면 Buffer.
export function readRegular(file, encoding = 'utf8', fsx = fs, max = READ_MAX) {
  const st = fsx.statSync(file);
  const code = !st.isFile() ? 'EINVAL' : st.size > max ? 'EFBIG' : null;
  // statSync 는 링크를 따라가므로, EINVAL 은 대상이 폴더나 특수 파일일 때(그것을 가리키는 링크 포함)다. EFBIG 는 32 MB 초과.
  if (code) throw Object.assign(new Error(`${path.basename(file)}: ${code === 'EINVAL' ? '일반 파일 아님(폴더나 특수 파일, 또는 그것을 가리키는 링크)' : '크기 상한 초과(32 MB)'}`), { code });
  return fsx.readFileSync(file, encoding);
}

// 실제 경로. native 먼저(Windows 의 8.3 짧은 이름, macOS 와 Windows 의 디스크 대소문자로 푼다). 아직 없는 꼬리는 있는
// 조상까지 풀고 붙인다(macOS 의 /var 는 /private/var 로 가는 링크).
export function realNative(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    try {
      return fs.realpathSync(p);
    } catch {
      const up = path.dirname(p);
      return up === p ? p : path.join(realNative(up), path.basename(p));
    }
  }
}

// 두 경로가 같은 폴더인지: 장치와 inode(bigint), inode 가 없는 파일 시스템은 realNative 철자(Windows, macOS 는 접어서).
// 문자열 비교는 대소문자, 8.3 이름, 링크인 부모 폴더처럼 철자만 다른 같은 폴더를 다른 폴더로 본다.
export function sameFolder(a, b) {
  try {
    const x = fs.statSync(a, { bigint: true });
    const y = fs.statSync(b, { bigint: true });
    if (x.ino !== 0n && y.ino !== 0n) return x.dev === y.dev && x.ino === y.ino;
  } catch {
    return false;
  }
  const fold = (p) => (process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p);
  return fold(realNative(a)) === fold(realNative(b));
}

// 프로젝트 안 자료 폴더의 경로 가운데 링크인 첫 폴더(.omc, progress-mon 등). 없으면 null.
// 프로젝트 밖(--data)이면 자료 폴더 자체만 본다. 아직 없는 폴더에서 멈춘다. 안팎은 자료 폴더에서 위로 올라가며
// 프로젝트 루트와 같은 폴더(sameFolder)를 만나는지로 본다: --data 를 다른 대소문자나 8.3 이름으로 적어도 안으로 본다.
function linkedDir(root, dataDir) {
  const isLink = (d) => {
    try {
      return fs.lstatSync(d).isSymbolicLink();
    } catch {
      return false;
    }
  };
  // 위로 올라가며 루트를 찾는다. 링크가 아닌 루트를 만나면 그 아래가 안이다(.omc -> . 같은 안의 링크도 목록에 남아
  // 거부된다). 끝까지 못 만나면 루트를 가리키는 첫 링크(루트를 링크 철자로 적은 --data)를 루트로 본다.
  const up = [];
  let rootAt = -1;
  let linkRootAt = -1;
  for (let d = dataDir; ; d = path.dirname(d)) {
    if (sameFolder(d, root)) {
      if (!isLink(d)) {
        rootAt = up.length;
        break;
      }
      if (linkRootAt < 0) linkRootAt = up.length;
    }
    up.push(d);
    if (path.dirname(d) === d) break;
  }
  const cut = rootAt >= 0 ? rootAt : linkRootAt;
  const dirs = cut > 0 ? up.slice(0, cut).reverse() : [dataDir];
  for (const d of dirs) {
    let st;
    try {
      st = fs.lstatSync(d);
    } catch {
      return null;
    }
    if (st.isSymbolicLink()) return d;
  }
  return null;
}

// 자료 폴더나 그 위 폴더가 링크면 거부. 저장소가 심은 링크를 따라 프로젝트 밖의 파일을 쓰거나 지우지 않게.
function refuseLinkedData(ctx) {
  const d = linkedDir(ctx.project, ctx.dataDir);
  if (d) throw new UsageError(`자료 폴더 경로의 ${path.relative(ctx.project, d) || d} 가 링크라 거부. 링크를 지우고 다시 실행`);
  return ctx;
}

// 사설 IPv4(10/8, 172.16/12, 192.168/16)만 참. 이름, IPv6, 0.0.0.0, 공인, 링크 로컬, 100.64/10 은 거짓.
export function privateIPv4(ip) {
  if (typeof ip !== 'string' || !net.isIPv4(ip)) return false;
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

// git 출력(앞뒤 공백 제거). git 이 없거나 실패하면 예외. 홈 폴더에서 git -C 로 부른다: Windows 는 일하는 폴더의
// 프로그램을 먼저 찾으므로, 프로젝트 안의 git.exe 가 실행되지 않게.
// 프로그램을 띄울 폴더: 홈 폴더(없으면 임시 폴더).
export const runDir = () => (fs.existsSync(os.homedir()) ? os.homedir() : os.tmpdir());
export const git = (cwd, args) => execFileSync('git', ['-C', path.resolve(cwd), ...args], { cwd: runDir(), encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();

// 프로젝트 루트: --project, 아니면 cwd 의 git 최상위, 실패면 cwd.
export function projectRoot(cwd, project) {
  if (project) return path.resolve(cwd, project);
  try {
    const top = git(cwd, ['rev-parse', '--show-toplevel']);
    if (top) return path.resolve(top);
  } catch {
    // git 이 없거나 저장소가 아님. cwd 를 씀.
  }
  return path.resolve(cwd);
}

// 런타임과 자료 폴더 판별(계획 3절). 폴더를 만들지 않는다. 자료 폴더 경로에 링크가 있으면 UsageError.
// 돌려줌: { project, runtime, dataDir, exists, warn }
export const resolveContext = (opts = {}) => refuseLinkedData(pickContext(opts));

function pickContext({ cwd = process.cwd(), project, runtime, data } = {}) {
  if (runtime !== undefined && !RUNTIMES.includes(runtime)) throw new UsageError(`--runtime 은 claude 또는 codex: ${runtime}`);
  const root = projectRoot(cwd, project);
  if (data) {
    const dataDir = path.resolve(cwd, data);
    return { project: root, runtime: runtime || 'claude', dataDir, exists: isDir(dataDir), warn: null };
  }
  const dirOf = (rt) => path.join(root, ...DATA_REL[rt].split('/'));
  if (runtime) return { project: root, runtime, dataDir: dirOf(runtime), exists: isDir(dirOf(runtime)), warn: null };
  const omc = isDir(dirOf('claude'));
  const omx = isDir(dirOf('codex'));
  if (omx && !omc) return { project: root, runtime: 'codex', dataDir: dirOf('codex'), exists: true, warn: null };
  const warn = omc && omx ? '경고: .omc/progress-mon/ 과 .omx/progress-mon/ 이 모두 있음. .omc/progress-mon/ 사용(--runtime codex 로 바꿀 수 있음)' : null;
  return { project: root, runtime: 'claude', dataDir: dirOf('claude'), exists: omc, warn };
}

// 사용법 오류(종료 1).
export class UsageError extends Error {}

// 고정 이름(잠금, 백업, 처음 만드는 설정)에 새 파일을 만든다(wx). 그 이름에 무엇이든 있으면 끊어진 링크까지 EEXIST.
// 까닭: Windows 의 wx 는 끊어진 링크를 따라가 그 너머에 파일을 만든다(macOS, Linux 는 EEXIST). 그래서 먼저 lstat 로
// 보고, 연 뒤 쓰기 전에 연 파일(fstat)과 이름(lstat)을 대조한다. 이름이 없거나 링크이거나 다른 파일이면 아무것도 쓰지
// 않고 EEXIST(링크를 따라 만든 빈 파일은 지움). 볼 수 없으면(ESTALE, EPERM 등) 보통의 wx 처럼 그대로 쓴다. 쓰기가
// 실패하면 이름이 아직 그 파일일 때 지운다(빈 잠금이나 빈 백업이 남지 않게). 처음 lstat 의 EPERM 등(Windows 에서 지우는
// 중인 파일)은 그대로 던진다. 부른 쪽은 wx 의 같은 코드처럼 기다린다.
export function writeNew(file, data, opts = {}, fsx = fs) {
  if (fsx.lstatSync(file, { throwIfNoEntry: false }) !== undefined) throw eexist(file);
  const fd = fsx.openSync(file, 'wx', opts.mode);
  try {
    const made = fstatOr(fd, fsx);
    if (namesOpened(file, made, fsx) === false) throw eexist(file);
    try {
      fsx.writeFileSync(fd, data);
    } catch (e) {
      if (namesOpened(file, made, fsx) === true) fsx.rmSync(file, { force: true });
      throw e;
    }
  } finally {
    fsx.closeSync(fd);
  }
}

const fstatOr = (fd, fsx) => {
  try {
    return fsx.fstatSync(fd, { bigint: true });
  } catch {
    return null;
  }
};

// 이름이 연 파일(made)을 가리키는지: 참, 거짓(없음, 링크, 다른 파일), 볼 수 없으면 null. 링크면 그 링크로 만든 빈 파일을 지움.
function namesOpened(file, made, fsx) {
  let st;
  try {
    st = fsx.lstatSync(file, { bigint: true, throwIfNoEntry: false });
  } catch {
    return null;
  }
  if (!st) return false;
  if (st.isSymbolicLink()) {
    if (made) dropFollowed(file, made, fsx);
    return false;
  }
  if (!made || made.ino === 0n) return null;
  return st.dev === made.dev && st.ino === made.ino;
}

// 링크를 따라 연 파일이 아직 그 빈 파일이면 지운다.
function dropFollowed(file, made, fsx) {
  try {
    const target = fsx.realpathSync(file);
    const at = fsx.statSync(target, { bigint: true });
    if (at.dev === made.dev && at.ino === made.ino && at.size === 0n) fsx.rmSync(target, { force: true });
  } catch {
    // 링크가 또 바뀜: 되돌릴 것을 찾지 못함
  }
}

const eexist = (file) => Object.assign(new Error(`EEXIST: file already exists, open '${file}'`), { code: 'EEXIST', syscall: 'open', path: file });

// 그 자리에 일반 파일이 아닌 것(링크, 폴더 등)이 있는지. 없거나 볼 수 없으면 거짓.
export function notPlainFile(file, fsx = fs) {
  try {
    const st = fsx.lstatSync(file, { throwIfNoEntry: false });
    return st !== undefined && !st.isFile();
  } catch {
    return false;
  }
}

const RENAME_RETRIES = 5;
const RENAME_STEP_MS = 50;
const RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

// 원자적 쓰기: 고유 이름 임시 파일을 wx 로 만들고 rename. 그 자리의 링크를 따라 쓰지 않는다.
// Windows 의 EPERM, EBUSY, EACCES 는 50 ms 간격으로 5회 다시. 실패면 임시 파일을 지우고 UsageError(원본 그대로).
export async function writeAtomic(file, text, fsx = fs) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const fail = (e) => {
    try {
      fsx.rmSync(tmp, { force: true });
    } catch {
      // 임시 파일을 못 지워도 원본은 그대로
    }
    return new UsageError(`${path.basename(file)} 쓰기 실패(${e.code || e.message}). 원본 그대로`);
  };
  try {
    fsx.writeFileSync(tmp, text, { flag: 'wx' });
  } catch (e) {
    throw e.code === 'EEXIST' ? new UsageError(`${path.basename(file)} 쓰기 실패(EEXIST). 원본 그대로`) : fail(e);
  }
  for (let i = 0; ; i++) {
    try {
      fsx.renameSync(tmp, file);
      return;
    } catch (e) {
      if (i < RENAME_RETRIES && RENAME_RETRY_CODES.has(e.code)) {
        await new Promise((r) => setTimeout(r, RENAME_STEP_MS));
        continue;
      }
      throw fail(e);
    }
  }
}

// 화면 표기용 자료 폴더: 프로젝트 기준 상대 경로, / 구분, 끝에 /. 절대 경로를 내지 않는다.
export function dataLabel(ctx) {
  const rel = path.relative(ctx.project, ctx.dataDir).split(path.sep).join('/');
  if (!rel) return './';
  if (path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) return path.basename(ctx.dataDir) + '/';
  return rel + '/';
}

export function defaults(project, runtime = 'claude') {
  const name = path.basename(project);
  return {
    schema: 1,
    title: `${name} 진척도`,
    shortName: name,
    port: 30000,
    portStrict: false,
    hosts: [],
    refreshSec: 30,
    stages: 'auto',
    stories: [],
    commitRegex: null,
    agentLabelPattern: null,
    sources: {
      events: 'auto',
      git: true,
      gitMax: 5000,
      workflowDirs: runtime === 'codex' ? [] : 'auto',
      agentStaleMin: 15,
      journalMaxAgeH: 24,
      journalMaxSessions: 20,
    },
    text: { reqRule: DEFAULT_REQ_RULE, plannedPrefix: '예정' },
  };
}

const isInt = (v) => Number.isInteger(v);
const isStr = (v) => typeof v === 'string' && v.length > 0;

// 사용자 정규식(commitRegex, agentLabelPattern)의 길이 상한. 실행 시간 상한은 pm-sources.mjs 의 regexBatch.
export const REGEX_MAX = 300;

// 정규식 문자열 컴파일. 실패면 이유 문자열.
function compileError(src, { needId, noGroups }) {
  if (src.length > REGEX_MAX) return `정규식이 ${REGEX_MAX}자를 넘음(${src.length}자)`;
  try {
    new RegExp(src);
  } catch (e) {
    return `정규식 컴파일 실패: ${e.message}`;
  }
  // 빈 대안을 붙여 빈 문자열에 맞추면 결과 길이 - 1 이 캡처 그룹 수.
  const groups = new RegExp(`${src}|`).exec('').length - 1;
  if (needId && !/\(\?<id>/.test(src)) return '이름 그룹 id 가 없음';
  if (noGroups && groups > 0) return '그룹을 쓰지 않음(비캡처 (?:) 만)';
  return null;
}

// 설정 형식 검사. 돌려줌: [{ path, msg }]. 틀린 칸은 기본값으로 둔다.
export function validate(raw, project, runtime = 'claude') {
  const d = defaults(project, runtime);
  const errors = [];
  const cfg = { ...d, sources: { ...d.sources }, text: { ...d.text } };
  const bad = (p, msg) => errors.push({ path: p, msg });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    bad('$', '객체가 아님');
    return { config: cfg, errors };
  }
  // from[key] 가 있으면 ok 일 때 into 에 넣고, 아니면 base.key 오류.
  const taker = (from, into, base) => (key, ok, msg) => {
    if (from[key] === undefined) return;
    if (ok(from[key])) into[key] = from[key];
    else bad(`${base}.${key}`, msg);
  };
  const take = taker(raw, cfg, '$');
  take('schema', (v) => v === 1, '1 이어야 함');
  take('title', isStr, '빈 문자열이 아닌 문자열');
  take('shortName', isStr, '빈 문자열이 아닌 문자열');
  take('port', (v) => isInt(v) && v >= 1024 && v <= 65535, '1024~65535 정수');
  take('portStrict', (v) => typeof v === 'boolean', '참 또는 거짓');
  take('hosts', (v) => Array.isArray(v) && v.every(privateIPv4), '사설 IPv4(10/8, 172.16/12, 192.168/16) 목록');
  take('refreshSec', (v) => isInt(v) && v >= 5 && v <= 3600, '5~3600 정수');
  const idList = (v, nameKey) => Array.isArray(v) && v.every((x) => x && isStr(x.id) && (x[nameKey] === undefined || typeof x[nameKey] === 'string')) && new Set(v.map((x) => x.id)).size === v.length;
  take('stages', (v) => v === 'auto' || idList(v, 'label'), '"auto" 또는 [{id, label}](id 겹침 없음)');
  take('stories', (v) => idList(v, 'name'), '[{id, name}](id 겹침 없음)');
  for (const [key, opt] of [['commitRegex', { needId: true }], ['agentLabelPattern', { noGroups: true }]]) {
    if (raw[key] === undefined || raw[key] === null) continue;
    if (typeof raw[key] !== 'string') {
      bad(`$.${key}`, '정규식 문자열');
      continue;
    }
    const why = compileError(raw[key], opt);
    if (why) bad(`$.${key}`, why);
    else cfg[key] = raw[key];
  }
  const src = raw.sources;
  if (src !== undefined) {
    if (!src || typeof src !== 'object' || Array.isArray(src)) bad('$.sources', '객체가 아님');
    else {
      const s = taker(src, cfg.sources, '$.sources');
      s('events', (v) => v === null || isStr(v), '"auto", 경로, null');
      s('git', (v) => typeof v === 'boolean', '참 또는 거짓');
      s('gitMax', (v) => isInt(v) && v > 0, '양의 정수');
      s('workflowDirs', (v) => v === 'auto' || (Array.isArray(v) && v.every(isStr)), '"auto" 또는 경로 목록');
      s('agentStaleMin', (v) => isInt(v) && v > 0, '양의 정수');
      s('journalMaxAgeH', (v) => isInt(v) && v > 0, '양의 정수');
      s('journalMaxSessions', (v) => isInt(v) && v >= 0, '0 이상 정수(0 은 상한 없음)');
    }
  }
  const text = raw.text;
  if (text !== undefined) {
    if (!text || typeof text !== 'object' || Array.isArray(text)) bad('$.text', '객체가 아님');
    else
      for (const key of ['reqRule', 'plannedPrefix']) {
        if (text[key] === undefined) continue;
        if (typeof text[key] === 'string') cfg.text[key] = text[key];
        else bad(`$.text.${key}`, '문자열');
      }
  }
  return { config: cfg, errors };
}

// 자료 폴더의 config.json 을 읽는다. 없으면 기본값. 돌려줌: { config, errors, found }
export function loadConfig(ctx) {
  const file = path.join(ctx.dataDir, 'config.json');
  let text;
  try {
    text = readRegular(file);
  } catch (e) {
    if (e.code === 'ENOENT') return { config: defaults(ctx.project, ctx.runtime), errors: [], found: false };
    // e.message 는 readRegular 가 지은 구체 문구(일반 파일 아님 / 크기 상한 초과)이거나 그 밖 fs 오류다.
    return { config: defaults(ctx.project, ctx.runtime), errors: [{ path: '$', msg: `읽기 실패: ${e.message || e.code || 'error'}` }], found: true };
  }
  let raw;
  try {
    raw = JSON.parse(noBom(text));
  } catch (e) {
    return { config: defaults(ctx.project, ctx.runtime), errors: [{ path: '$', msg: `JSON 아님: ${e.message}` }], found: true };
  }
  return { ...validate(raw, ctx.project, ctx.runtime), found: true };
}

// config.json 을 읽고 형식 오류가 있으면 UsageError.
export function configOrFail(ctx) {
  const { config, errors } = loadConfig(ctx);
  if (errors.length) throw new UsageError(`config.json 형식 오류: ${errors.map((e) => `${e.path} ${e.msg}`).join('; ')}`);
  return config;
}

// 단계 목록. "auto" 는 events 출처가 있으면 ultra-chain 10단계, 없으면 빈 목록.
export function stagesFor(config, hasEvents) {
  if (config.stages === 'auto') return hasEvents ? ULTRA_STAGES.map((s) => ({ ...s })) : [];
  return config.stages.map((s) => ({ id: s.id, label: s.label || s.id }));
}

// events.jsonl 경로. "auto" 는 <project>/.omc(Codex .omx)/ultra-chain/*/events.jsonl 가운데 수정 시각 최신.
// 상대 경로는 프로젝트 루트 기준. null 이나 찾지 못하면 null.
export function eventsPath(config, ctx) {
  const v = config.sources.events;
  if (v === null || v === undefined) return null;
  if (v !== 'auto') return path.resolve(ctx.project, v);
  const base = path.join(ctx.project, ctx.runtime === 'codex' ? '.omx' : '.omc', 'ultra-chain');
  let best = null;
  let bestT = -Infinity;
  let runs = [];
  try {
    runs = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of runs) {
    if (!e.isDirectory()) continue;
    const f = path.join(base, e.name, 'events.jsonl');
    try {
      const t = fs.statSync(f).mtimeMs;
      if (t > bestT) {
        bestT = t;
        best = f;
      }
    } catch {
      // events 가 없는 실행 폴더
    }
  }
  return best;
}
