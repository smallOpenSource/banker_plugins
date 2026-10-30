// pm-memory.mjs: 메모리 규칙 등록(계획 6.2절). 표식으로 중복을 막고 사용자 파일은 끝에 덧붙이기만 한다.
// 대상 파일은 에이전트가 넘긴다(--memory, --memory-dir). 스크립트는 HOME 아래 쓰기 경로를 스스로 만들지 않는다.
// 덧붙인 뒤 규칙 로드 한도를 재고 경고 줄을 낸다(종료 코드는 그대로). status, check 도 같은 측정을 다시 한다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git, UsageError } from './pm-config.mjs';

export const MARKER = '<!-- progress-mon:rule -->';
export const OMX_OPEN = '<!-- USER:OMX:POLICY:START -->';
export const OMX_CLOSE = '<!-- USER:OMX:POLICY:END -->';
const KINDS = ['claude-md', 'agents-md', 'auto-memory', 'none'];

// 규칙 줄. 경로는 자료 폴더 기준 상대 표기뿐(스킬 폴더 절대 경로는 state.json 의 skillDir).
export function ruleLine(runtime) {
  if (runtime === 'codex') {
    return `진척도 화면(progress-mon): 모든 명령에 --runtime codex 를 붙임. 단계는 stage, 스토리는 story, 그 밖 작업은 item 으로 갱신. .omx/progress-mon/state.json 의 skillDir 아래 scripts/progress-mon.mjs 를 node 로 직접 실행하고, 실패하면 progress-mon 스킬로 호출. 세션 시작 때 status, 꺼져 있으면 start. start, status 는 sandbox_permissions "require_escalated" 로 승인 요청. 세션을 닫아도 화면을 두려면 사용자 터미널에서 serve 실행을 안내. ${MARKER}`;
  }
  return `진척도 화면(progress-mon): 단계는 stage, 스토리는 story, 그 밖 작업은 item 으로 갱신. .omc/progress-mon/state.json 의 skillDir 아래 scripts/progress-mon.mjs 를 node 로 직접 실행하고, 실패하면 progress-mon 스킬로 호출. 세션 시작 때 status, 꺼져 있으면 start. ${MARKER}`;
}

// 자동 메모리 규칙 파일(새로 만들 때)과 MEMORY.md 색인 줄.
const ruleFile = (runtime) => `---
name: progress-mon
description: 진척도 화면(progress-mon) 갱신 규칙. 단계, 스토리, 그 밖 작업을 stage, story, item 으로 기록
metadata:
  type: feedback
---

${ruleLine(runtime)}
`;
const INDEX_LINE = `- [진척도 화면 갱신 규칙](progress-mon.md) - stage, story, item 으로 progress-mon 갱신 ${MARKER}`;

// ---------- 한도 ----------

const MEMORY_LIMIT = { lines: 200, bytes: 25000 };
const CODEX_DEFAULT_BYTES = 32768;
const nine = (n) => Math.ceil(n * 0.9);
const comma = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

// Codex 가 파일을 빈 것으로 보는 기준(Rust trim 과 같이 BOM 은 글로 친다).
const hasContent = (text) => /\P{White_Space}/u.test(text);

// 줄 수: 마지막 줄 끝의 줄바꿈은 줄을 늘리지 않는다.
export function lineCount(text) {
  if (!text) return 0;
  const n = text.split('\n').length;
  return text.endsWith('\n') ? n - 1 : n;
}

// MEMORY.md 한 파일의 측정. 돌려줌: { lines, bytes, level: 'over' | 'near' | null }
export function measureMemory(file) {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return { lines: 0, bytes: 0, level: null };
  }
  const lines = lineCount(buf.toString('utf8'));
  const bytes = buf.length;
  const level = lines >= MEMORY_LIMIT.lines || bytes >= MEMORY_LIMIT.bytes ? 'over' : lines >= nine(MEMORY_LIMIT.lines) || bytes >= nine(MEMORY_LIMIT.bytes) ? 'near' : null;
  return { lines, bytes, level };
}

// $CODEX_HOME/config.toml 의 최상위 project_doc_max_bytes(읽기만). 첫 [표] 머리 전의 줄만 보고 주석은 뺀다.
// 돌려줌: { bytes, assumed } (파일이 없거나 값이 정수가 아니면 기본값 가정)
export function codexLimit(env = process.env) {
  const home = env.CODEX_HOME || path.join(os.homedir(), '.codex');
  let text;
  try {
    text = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
  } catch {
    return { bytes: CODEX_DEFAULT_BYTES, assumed: true };
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (line.startsWith('[')) break;
    const m = /^project_doc_max_bytes\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const v = m[1].trim();
    if (!/^\+?\d+(?:_\d+)*$/.test(v)) return { bytes: CODEX_DEFAULT_BYTES, assumed: true };
    return { bytes: Number(v.replace(/[+_]/g, '')), assumed: false };
  }
  return { bytes: CODEX_DEFAULT_BYTES, assumed: true };
}

// ---------- Codex 쓰기 대상(계획 6.2절 표) ----------

const readText = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

// banker 블록과 우리 블록을 뺀 글. 안이 빈 USER:OMX:POLICY 묶음도 뺀다.
export function ownText(text) {
  const kept = [];
  let banker = null;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (banker) {
      if (t === `<!-- banker:${banker}:end -->`) banker = null;
      continue;
    }
    const m = /^<!-- banker:([a-z0-9-]+):start -->$/.exec(t);
    if (m) {
      banker = m[1];
      continue;
    }
    if (line.includes(MARKER)) continue;
    kept.push(line);
  }
  const out = [];
  for (let i = 0; i < kept.length; i++) {
    if (kept[i].trim() === OMX_OPEN) {
      let j = i + 1;
      while (j < kept.length && kept[j].trim() !== OMX_CLOSE && !hasContent(kept[j])) j++;
      if (j < kept.length && kept[j].trim() === OMX_CLOSE) {
        i = j;
        continue;
      }
    }
    out.push(kept[i]);
  }
  return out.join('\n');
}

// 폴더 하나에서 Codex 가 읽는 파일과 우리가 쓸 파일. shadow: override 에 블록만 있어 AGENTS.md 가 가려짐.
export function codexTarget(dir) {
  const override = path.join(dir, 'AGENTS.override.md');
  const main = path.join(dir, 'AGENTS.md');
  const ot = readText(override);
  if (ot === null || !hasContent(ot)) return { file: main, shadow: false };
  return { file: override, shadow: !hasContent(ownText(ot)) };
}

const gitTop = (dir) => {
  try {
    return path.resolve(git(dir, ['rev-parse', '--show-toplevel']));
  } catch {
    return null;
  }
};

// Codex 프로젝트 지시 합계: 저장소 루트에서 프로젝트 루트까지 각 폴더에서 Codex 가 읽는 파일 크기의 합.
export function measureCodex(project, env = process.env) {
  const limit = codexLimit(env);
  const proj = path.resolve(project);
  const top = gitTop(proj);
  const rel = top ? path.relative(top, proj) : '';
  const dirs = [top && !rel.startsWith('..') && !path.isAbsolute(rel) ? top : proj];
  if (dirs[0] !== proj) for (const part of rel.split(path.sep).filter(Boolean)) dirs.push(path.join(dirs[dirs.length - 1], part));
  let total = 0;
  for (const d of dirs) {
    try {
      total += fs.statSync(codexTarget(d).file).size;
    } catch {
      // 그 폴더에 지시 파일 없음
    }
  }
  const level = limit.bytes === 0 ? 'off' : total >= limit.bytes ? 'over' : total >= nine(limit.bytes) ? 'near' : null;
  return { total, limit: limit.bytes, assumed: limit.assumed, level };
}

// ---------- 경고 줄 ----------

const MEM_ALT = '대안: --memory claude-md 로 다시 등록(CLAUDE.md 는 한도 없음)';
const CODEX_ALT = '대안: 프로젝트 지시 파일 정리(banker cleansing-memory)';
export const SHADOW_WARN = '경고: AGENTS.override.md 에 블록만 있어 AGENTS.md 가 가려짐';

function memoryLines(m) {
  const lim = `로드 한도(${MEMORY_LIMIT.lines}줄 또는 ${comma(MEMORY_LIMIT.bytes)} B)`;
  if (m.level === 'over') return [`경고: MEMORY.md 가 ${lim}를 넘어 규칙이 로드되지 않음`, MEM_ALT];
  if (m.level === 'near') return [`경고: MEMORY.md 가 ${lim}의 90% 이상이라 규칙이 곧 로드 밖으로 밀릴 수 있음`, MEM_ALT];
  return [];
}

function codexLines(c) {
  if (c.level === 'off') return ['경고: Codex 프로젝트 문서 로딩이 꺼져 있어 규칙이 로드되지 않음', '대안: config.toml 의 project_doc_max_bytes 설정 확인'];
  const lim = `로드 한도(${comma(c.limit)} B${c.assumed ? ', 기본값 가정' : ''})`;
  if (c.level === 'over') return [`경고: Codex 프로젝트 지시 합계가 ${lim}를 넘어 규칙이 로드되지 않음`, CODEX_ALT];
  if (c.level === 'near') return [`경고: Codex 프로젝트 지시 합계가 ${lim}의 90% 이상이라 규칙이 곧 로드 밖으로 밀릴 수 있음`, CODEX_ALT];
  return [];
}

// state.json 의 memory 로 다시 잰 경고 줄(status, check, init 이 같이 씀). 경고가 없으면 빈 목록.
export function memoryWarnings(memory, project, env = process.env) {
  if (!memory || typeof memory !== 'object') return [];
  if (memory.kind === 'auto-memory' && typeof memory.path === 'string') return memoryLines(measureMemory(memory.path));
  if (memory.kind === 'agents-md') return [...(codexTarget(project).shadow ? [SHADOW_WARN] : []), ...codexLines(measureCodex(project, env))];
  return [];
}

// ---------- 쓰기 ----------

// 덧붙일 수 있는 파일인지. 일반 파일이나 일반 파일을 가리키는 링크만. 없으면 새로 만든다.
// 돌려줌: { exists, text, eol }. 거부는 UsageError.
function inspect(file, name) {
  let lst;
  try {
    lst = fs.lstatSync(file);
  } catch (e) {
    if (e.code === 'ENOENT') return { exists: false, text: '', eol: '\n' };
    throw new UsageError(`${name} 을 읽지 못함(${e.code || e.message})`);
  }
  let st = lst;
  if (lst.isSymbolicLink()) {
    try {
      st = fs.statSync(file);
    } catch {
      throw new UsageError(`${name} 은 대상이 없는 링크라 거부`);
    }
  }
  if (!st.isFile()) throw new UsageError(`${name} 은 일반 파일이 아니라 거부`);
  const buf = fs.readFileSync(file);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    throw new UsageError(`${name} 이 UTF-8 이 아니라 거부`);
  }
  // TextDecoder 는 BOM 을 떼므로 줄 끝 판정만 쓴다. 쓰기는 원본 바이트 뒤에 덧붙인다.
  return { exists: true, text, eol: text.includes('\r\n') ? '\r\n' : '\n' };
}

// 원본 바이트를 그대로 두고 끝에 줄을 덧붙인다. 마지막 줄에 줄바꿈이 없으면 먼저 넣는다.
function append(file, info, lines) {
  const glue = info.text && !info.text.endsWith('\n') ? info.eol : '';
  const body = glue + lines.join(info.eol) + info.eol;
  if (info.exists) fs.appendFileSync(file, body);
  else fs.writeFileSync(file, body, { flag: 'wx' });
}

// 등록 계획. 쓰기 전에 대상을 모두 검사한다(거부면 아무것도 바꾸지 않음).
// o: { kind, memoryDir, project, runtime }. 돌려줌: { kind, runtime, steps, memory: {kind, path} }
export function planMemory({ kind, memoryDir, project, runtime }) {
  if (kind === undefined) throw new UsageError('init 에는 --memory claude-md|agents-md|auto-memory|none 가 필요함');
  if (!KINDS.includes(kind)) throw new UsageError(`--memory 는 ${KINDS.join(', ')} 가운데 하나(받은 값 ${kind})`);
  if (kind === 'none') return { kind, runtime, steps: [], memory: { kind, path: null } };
  if (kind === 'auto-memory') {
    if (!memoryDir) throw new UsageError('--memory auto-memory 에는 --memory-dir <dir> 가 필요함');
    const dir = path.resolve(memoryDir);
    if (fs.existsSync(dir) && !fs.statSync(dir).isDirectory()) throw new UsageError('--memory-dir 가 폴더가 아님');
    const rule = path.join(dir, 'progress-mon.md');
    const index = path.join(dir, 'MEMORY.md');
    return {
      kind,
      runtime,
      dir,
      steps: [
        { file: rule, name: '자동 메모리 progress-mon.md', info: inspect(rule, 'progress-mon.md'), what: 'rule-file' },
        { file: index, name: '자동 메모리 MEMORY.md', info: inspect(index, 'MEMORY.md'), what: 'index' },
      ],
      memory: { kind, path: index },
    };
  }
  if (memoryDir) throw new UsageError('--memory-dir 는 --memory auto-memory 에만 씀');
  const root = path.resolve(project);
  if (kind === 'claude-md') {
    const file = path.join(root, 'CLAUDE.md');
    return { kind, runtime, steps: [{ file, name: 'CLAUDE.md', info: inspect(file, 'CLAUDE.md'), what: 'line' }], memory: { kind, path: file } };
  }
  const t = codexTarget(root);
  const name = path.basename(t.file);
  return { kind, runtime, steps: [{ file: t.file, name, info: inspect(t.file, name), what: 'block' }], memory: { kind, path: t.file } };
}

// 계획대로 쓴다. 돌려줌: 출력 줄 목록(규칙 줄, 경고 줄).
export function applyMemory(plan, project, env = process.env) {
  if (plan.kind === 'none') return ['규칙 등록 안 함(--memory none)'];
  const out = [];
  if (plan.dir) fs.mkdirSync(plan.dir, { recursive: true });
  for (const s of plan.steps) {
    const { info } = s;
    if (info.text.includes(MARKER)) {
      out.push(`규칙 이미 있음: ${s.name}`);
      continue;
    }
    const fresh = !info.exists;
    if (s.what === 'rule-file') {
      if (fresh) fs.writeFileSync(s.file, ruleFile(plan.runtime), { flag: 'wx' });
      else append(s.file, info, [ruleLine(plan.runtime)]);
      out.push(`규칙 추가: ${s.name} (${fresh ? '새로 만듦' : '1줄'})`);
    } else if (s.what === 'index') {
      append(s.file, info, [INDEX_LINE]);
      out.push(`규칙 추가: ${s.name} (${fresh ? '새로 만듦, ' : ''}색인 1줄)`);
    } else if (s.what === 'line') {
      append(s.file, info, [ruleLine(plan.runtime)]);
      out.push(`규칙 추가: ${s.name} (${fresh ? '새로 만듦, ' : ''}1줄)`);
    } else {
      append(s.file, info, [OMX_OPEN, ruleLine(plan.runtime), OMX_CLOSE]);
      out.push(`규칙 추가: ${s.name} (${fresh ? '새로 만듦, ' : ''}3줄)`);
    }
  }
  return [...out, ...memoryWarnings(plan.memory, project, env)];
}
