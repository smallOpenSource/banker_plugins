// pm-memory.mjs 시험. 메모리 파일은 모두 임시 폴더에만 쓴다(임시 HOME, CODEX_HOME). 실제 사용자 파일은 건드리지 않는다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MARKER, OMX_OPEN, OMX_CLOSE, SHADOW_WARN, INDEX_LINE, ruleLine, currentLine, planMemory, applyMemory, measureMemory, measureCodex, codexLimit, codexTarget, ownText, memoryWarnings, lineCount } from './pm-memory.mjs';
import { UsageError } from './pm-config.mjs';

const T = { timeout: 60000 };
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'progress-mon.mjs');
const ROOT = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'progress-mon-test-')));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const HOME = path.join(ROOT, 'home');
const CODEX = path.join(HOME, '.codex');
fs.mkdirSync(CODEX, { recursive: true });
const ENV = (() => {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(CLAUDE_|CODEX_|PROGRESS_MON_|PM_TEST_|GIT_)/i.test(k)) env[k] = v;
  return Object.assign(env, {
    HOME,
    USERPROFILE: HOME,
    APPDATA: path.join(HOME, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(HOME, 'AppData', 'Local'),
    CLAUDE_CONFIG_DIR: path.join(HOME, '.claude'),
    CODEX_HOME: CODEX,
    NO_COLOR: '1',
    GIT_CEILING_DIRECTORIES: ROOT,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(ROOT, 'gitconfig-empty'),
  });
})();
fs.writeFileSync(ENV.GIT_CONFIG_GLOBAL, '');
// 이 프로세스 안에서 부르는 git(측정 함수)도 임시 폴더 위로 올라가지 않게 한다.
process.env.GIT_CEILING_DIRECTORIES = ROOT;

let n = 0;
const dir = (name = 'p') => {
  const d = path.join(ROOT, `${name}${++n}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const count = (s, sub) => s.split(sub).length - 1;
const cli = (args, cwd) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env: ENV, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const register = (o) => applyMemory(planMemory(o), o.project, ENV);
// 옛 판(bd4d7cd) init 이 쓴 규칙 줄과 색인 줄.
const OLD = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'assets', 'fixture', 'variants', 'legacy-init', 'rules.json'), 'utf8'));

test('규칙 줄: 경로 없음, 표식, Codex 는 --runtime codex', T, () => {
  const c = ruleLine('claude');
  const x = ruleLine('codex');
  for (const r of [c, x]) {
    assert.ok(r.endsWith(MARKER));
    assert.doesNotMatch(r, /[A-Za-z]:[\\/]|\/home\/|\/Users\//, '절대 경로 없음');
    assert.doesNotMatch(r, /\n/);
    for (const w of ['stage', 'story', 'item', 'status', 'start', 'skillDir']) assert.ok(r.includes(w), w);
  }
  assert.ok(c.includes('.omc/progress-mon/state.json'));
  assert.ok(!c.includes('--runtime codex'));
  assert.ok(x.includes('.omx/progress-mon/state.json'));
  assert.ok(x.includes('--runtime codex'));
  assert.ok(x.includes('require_escalated'));
});

test('claude-md: 새로 만듦, 다시 실행하면 이미 있음(중복 0)', T, () => {
  const p = dir();
  assert.deepEqual(register({ kind: 'claude-md', project: p, runtime: 'claude' }), ['규칙 추가: CLAUDE.md (새로 만듦, 1줄)']);
  const once = fs.readFileSync(path.join(p, 'CLAUDE.md'));
  assert.equal(once.toString(), ruleLine('claude') + '\n');
  assert.deepEqual(register({ kind: 'claude-md', project: p, runtime: 'claude' }), ['규칙 이미 있음: CLAUDE.md']);
  assert.deepEqual(fs.readFileSync(path.join(p, 'CLAUDE.md')), once);
});

test('원본 바이트 보존: 앞부분 그대로, CRLF 유지, 끝 줄바꿈 없으면 먼저 넣음', T, () => {
  const p = dir();
  const f = path.join(p, 'CLAUDE.md');
  const orig = Buffer.from('# 내 규칙\r\n- 하나\r\n- 둘', 'utf8');
  fs.writeFileSync(f, orig);
  assert.deepEqual(register({ kind: 'claude-md', project: p, runtime: 'claude' }), ['규칙 추가: CLAUDE.md (1줄)']);
  const now = fs.readFileSync(f);
  assert.deepEqual(now.subarray(0, orig.length), orig);
  assert.equal(now.subarray(orig.length).toString(), `\r\n${ruleLine('claude')}\r\n`);
  assert.equal(count(now.toString().replace(/\r\n/g, ''), '\n'), 0, '맨 LF 없음');
});

test('BOM 유지(\\u{FEFF} 로 시작하는 파일)', T, () => {
  const p = dir();
  const f = path.join(p, 'CLAUDE.md');
  const orig = Buffer.from('\u{FEFF}# 제목\n', 'utf8');
  fs.writeFileSync(f, orig);
  register({ kind: 'claude-md', project: p, runtime: 'claude' });
  const now = fs.readFileSync(f);
  assert.deepEqual(now.subarray(0, orig.length), orig);
  assert.deepEqual([...now.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(now.subarray(orig.length).toString(), ruleLine('claude') + '\n');
});

test('일반 파일이 아니면 거부, UTF-8 아니면 거부(아무것도 바꾸지 않음)', T, () => {
  const p = dir();
  fs.mkdirSync(path.join(p, 'CLAUDE.md'));
  // 거부 문구에 종류별 대안이 붙는다(claude-md 면 agents-md 와 auto-memory)
  assert.throws(() => planMemory({ kind: 'claude-md', project: p, runtime: 'claude' }), /일반 파일이 아니라 거부\. 대안: --memory agents-md, 또는 --memory auto-memory --memory-dir <dir>/);
  fs.rmSync(path.join(p, 'CLAUDE.md'), { recursive: true });
  fs.mkdirSync(path.join(p, 'AGENTS.md'));
  assert.throws(() => planMemory({ kind: 'agents-md', project: p, runtime: 'codex' }), /대안: --memory claude-md, 또는 --memory auto-memory --memory-dir <dir>/);
  const q = dir();
  const bad = Buffer.from([0xff, 0xfe, 0x41, 0x00]);
  fs.writeFileSync(path.join(q, 'CLAUDE.md'), bad);
  assert.throws(() => planMemory({ kind: 'claude-md', project: q, runtime: 'claude' }), /UTF-8 이 아니라 거부/);
  assert.deepEqual(fs.readFileSync(path.join(q, 'CLAUDE.md')), bad);
  const r = dir();
  try {
    fs.symlinkSync(path.join(r, 'nowhere.md'), path.join(r, 'CLAUDE.md'), 'file');
  } catch {
    return; // 링크를 만들 권한이 없는 환경. 위 두 사례로 충분
  }
  assert.throws(() => planMemory({ kind: 'claude-md', project: r, runtime: 'claude' }), /대상이 없는 링크/);
  assert.equal(fs.existsSync(path.join(r, 'nowhere.md')), false);
});

test('auto-memory: 규칙 파일 frontmatter, MEMORY.md 색인 한 줄, 다시 실행해도 중복 0', T, () => {
  const mem = path.join(dir('mem'), 'memory');
  const p = dir();
  assert.deepEqual(register({ kind: 'auto-memory', memoryDir: mem, project: p, runtime: 'claude' }), ['규칙 추가: 자동 메모리 progress-mon.md (새로 만듦)', '규칙 추가: 자동 메모리 MEMORY.md (새로 만듦, 색인 1줄)']);
  const rule = fs.readFileSync(path.join(mem, 'progress-mon.md'), 'utf8');
  assert.match(rule, /^---\nname: progress-mon\ndescription: .+\nmetadata:\n {2}type: feedback\n---\n\n/);
  assert.equal(count(rule, MARKER), 1);
  const index = fs.readFileSync(path.join(mem, 'MEMORY.md'), 'utf8');
  assert.match(index, /^- \[.+\]\(progress-mon\.md\) .+<!-- progress-mon:rule -->\n$/);
  assert.deepEqual(register({ kind: 'auto-memory', memoryDir: mem, project: p, runtime: 'claude' }), ['규칙 이미 있음: 자동 메모리 progress-mon.md', '규칙 이미 있음: 자동 메모리 MEMORY.md']);
  assert.equal(fs.readFileSync(path.join(mem, 'MEMORY.md'), 'utf8'), index);
  assert.throws(() => planMemory({ kind: 'auto-memory', project: p, runtime: 'claude' }), /--memory-dir <dir> 가 필요함/);
  assert.throws(() => planMemory({ kind: 'claude-md', memoryDir: mem, project: p, runtime: 'claude' }), /auto-memory 에만/);
  assert.throws(() => planMemory({ project: p, runtime: 'claude' }), /--memory claude-md\|agents-md\|auto-memory\|none 가 필요함/);
  assert.throws(() => planMemory({ kind: 'home', project: p, runtime: 'claude' }), /받은 값 home/);
});

test('none: 아무 파일도 쓰지 않음', T, () => {
  const p = dir();
  assert.deepEqual(register({ kind: 'none', project: p, runtime: 'claude' }), ['규칙 등록 안 함(--memory none)']);
  assert.deepEqual(fs.readdirSync(p), []);
});

test('agents-md: OMX 블록 3줄, 중복 0, Codex 규칙 줄', T, () => {
  const p = dir();
  assert.deepEqual(register({ kind: 'agents-md', project: p, runtime: 'codex' }), ['규칙 추가: AGENTS.md (새로 만듦, 3줄)']);
  const text = fs.readFileSync(path.join(p, 'AGENTS.md'), 'utf8');
  assert.equal(text, `${OMX_OPEN}\n${ruleLine('codex')}\n${OMX_CLOSE}\n`);
  assert.deepEqual(register({ kind: 'agents-md', project: p, runtime: 'codex' }), ['규칙 이미 있음: AGENTS.md']);
  assert.equal(fs.readFileSync(path.join(p, 'AGENTS.md'), 'utf8'), text);
});

test('Codex 쓰기 대상 표 3행: 없음과 공백뿐은 AGENTS.md, 자기 내용은 override, 블록만은 override 와 가려짐 경고', T, () => {
  const a = dir();
  assert.deepEqual(codexTarget(a), { file: path.join(a, 'AGENTS.md'), shadow: false });
  fs.writeFileSync(path.join(a, 'AGENTS.override.md'), ' \r\n\t\n');
  assert.deepEqual(codexTarget(a), { file: path.join(a, 'AGENTS.md'), shadow: false });
  assert.deepEqual(register({ kind: 'agents-md', project: a, runtime: 'codex' }), ['규칙 추가: AGENTS.md (새로 만듦, 3줄)']);

  const b = dir();
  fs.writeFileSync(path.join(b, 'AGENTS.override.md'), '# 이 저장소 지시\n');
  assert.deepEqual(codexTarget(b), { file: path.join(b, 'AGENTS.override.md'), shadow: false });
  assert.deepEqual(register({ kind: 'agents-md', project: b, runtime: 'codex' }), ['규칙 추가: AGENTS.override.md (3줄)']);
  assert.equal(fs.existsSync(path.join(b, 'AGENTS.md')), false);

  const c = dir();
  const banker = `${OMX_OPEN}\n<!-- banker:tone-compact:start -->\n규칙 본문\n<!-- banker:tone-compact:end -->\n${OMX_CLOSE}\n`;
  fs.writeFileSync(path.join(c, 'AGENTS.override.md'), banker);
  fs.writeFileSync(path.join(c, 'AGENTS.md'), '# 가려지는 파일\n');
  assert.equal(ownText(banker).trim(), '');
  assert.deepEqual(codexTarget(c), { file: path.join(c, 'AGENTS.override.md'), shadow: true });
  assert.deepEqual(register({ kind: 'agents-md', project: c, runtime: 'codex' }), ['규칙 추가: AGENTS.override.md (3줄)', SHADOW_WARN]);
  assert.ok(fs.readFileSync(path.join(c, 'AGENTS.override.md'), 'utf8').startsWith(banker));

  // 우리 블록만 남은 override 도 가려짐
  const d = dir();
  fs.writeFileSync(path.join(d, 'AGENTS.override.md'), `${OMX_OPEN}\n${ruleLine('codex')}\n${OMX_CLOSE}\n`);
  assert.equal(codexTarget(d).shadow, true);
  assert.deepEqual(memoryWarnings({ kind: 'agents-md', path: path.join(d, 'AGENTS.override.md') }, d, ENV), [SHADOW_WARN]);
  // 블록 밖 OMX 정책 글은 자기 내용
  assert.ok(ownText(`${OMX_OPEN}\n사용자 정책\n${OMX_CLOSE}\n`).includes('사용자 정책'));
});

test('MEMORY.md 로드 한도: 179/180줄, 22,499/22,500 B, 25,000 B, 200줄', T, () => {
  const d = dir();
  const f = path.join(d, 'MEMORY.md');
  const lines = (k) => Array.from({ length: k }, (_, i) => `- ${i}`).join('\n') + '\n';
  const bytes = (k) => 'a'.repeat(k - 1) + '\n';
  const cases = [
    [lines(179), null],
    [lines(180), 'near'],
    [lines(199), 'near'],
    [lines(200), 'over'],
    [bytes(22499), null],
    [bytes(22500), 'near'],
    [bytes(24999), 'near'],
    [bytes(25000), 'over'],
  ];
  for (const [text, level] of cases) {
    fs.writeFileSync(f, text);
    assert.equal(measureMemory(f).level, level, `${lineCount(text)}줄 ${Buffer.byteLength(text)} B`);
  }
  assert.equal(lineCount('a\nb'), 2);
  assert.equal(lineCount(''), 0);
});

test('auto-memory 경고: 덧붙이기 전 이미 초과, 덧붙인 뒤 90%, 대안은 claude-md', T, () => {
  const over = dir('mem');
  fs.writeFileSync(path.join(over, 'MEMORY.md'), Array.from({ length: 201 }, (_, i) => `- ${i}`).join('\n') + '\n');
  const out = register({ kind: 'auto-memory', memoryDir: over, project: dir(), runtime: 'claude' });
  assert.deepEqual(out.slice(2), ['경고: MEMORY.md 가 로드 한도(200줄 또는 25,000 B)를 넘어 규칙이 로드되지 않음', '대안: --memory claude-md 로 다시 등록(CLAUDE.md 는 한도 없음)']);
  const near = dir('mem');
  fs.writeFileSync(path.join(near, 'MEMORY.md'), Array.from({ length: 179 }, (_, i) => `- ${i}`).join('\n') + '\n');
  const o2 = register({ kind: 'auto-memory', memoryDir: near, project: dir(), runtime: 'claude' });
  assert.deepEqual(o2.slice(2), ['경고: MEMORY.md 가 로드 한도(200줄 또는 25,000 B)의 90% 이상이라 규칙이 곧 로드 밖으로 밀릴 수 있음', '대안: --memory claude-md 로 다시 등록(CLAUDE.md 는 한도 없음)']);
});

test('config.toml: 최상위 키만, 표 안과 주석 무시, 정수 아님과 파일 없음은 기본값 가정, 0 은 로딩 꺼짐', T, () => {
  const home = dir('codex');
  const env = { CODEX_HOME: home };
  const toml = (t) => fs.writeFileSync(path.join(home, 'config.toml'), t);
  assert.deepEqual(codexLimit(env), { bytes: 32768, assumed: true });
  toml('model = "x"\nproject_doc_max_bytes = 40_000 # 주석\n[profiles.a]\nproject_doc_max_bytes = 5\n');
  assert.deepEqual(codexLimit(env), { bytes: 40000, assumed: false });
  toml('# project_doc_max_bytes = 5\n[tui]\nproject_doc_max_bytes = 7\n');
  assert.deepEqual(codexLimit(env), { bytes: 32768, assumed: true });
  toml('project_doc_max_bytes = "big"\n');
  assert.deepEqual(codexLimit(env), { bytes: 32768, assumed: true });
  toml('project_doc_max_bytes = 0\n');
  const p = dir();
  fs.writeFileSync(path.join(p, 'AGENTS.md'), 'x\n');
  assert.equal(measureCodex(p, env).level, 'off');
  assert.deepEqual(memoryWarnings({ kind: 'agents-md', path: path.join(p, 'AGENTS.md') }, p, env), ['경고: Codex 프로젝트 문서 로딩이 꺼져 있어 규칙이 로드되지 않음', '대안: config.toml 의 project_doc_max_bytes 설정 확인']);
  toml('project_doc_max_bytes = 1000\n');
  fs.writeFileSync(path.join(p, 'AGENTS.md'), 'a'.repeat(1000));
  assert.deepEqual(memoryWarnings({ kind: 'agents-md', path: path.join(p, 'AGENTS.md') }, p, env), ['경고: Codex 프로젝트 지시 합계가 로드 한도(1,000 B)를 넘어 규칙이 로드되지 않음', '대안: 프로젝트 지시 파일 정리(banker cleansing-memory)']);
});

test('Codex 지시 합계: 저장소 루트부터 프로젝트까지, 29,491/29,492/32,768 B, 기본값 가정 문구', T, () => {
  const repo = dir('repo');
  execFileSync('git', ['init', '-q'], { cwd: repo, env: ENV, windowsHide: true });
  const proj = path.join(repo, 'sub', 'app');
  fs.mkdirSync(proj, { recursive: true });
  const env = { CODEX_HOME: dir('nocodex') };
  const set = (top, mid, low) => {
    fs.writeFileSync(path.join(repo, 'AGENTS.md'), 'a'.repeat(top));
    fs.writeFileSync(path.join(repo, 'sub', 'AGENTS.md'), 'b'.repeat(mid));
    fs.writeFileSync(path.join(proj, 'AGENTS.md'), 'c'.repeat(low));
  };
  set(10000, 10000, 9491);
  assert.deepEqual(measureCodex(proj, env), { total: 29491, limit: 32768, assumed: true, level: null });
  set(10000, 10000, 9492);
  assert.equal(measureCodex(proj, env).level, 'near');
  assert.equal(memoryWarnings({ kind: 'agents-md' }, proj, env)[0], '경고: Codex 프로젝트 지시 합계가 로드 한도(32,768 B, 기본값 가정)의 90% 이상이라 규칙이 곧 로드 밖으로 밀릴 수 있음');
  set(10000, 10000, 12768);
  assert.equal(measureCodex(proj, env).level, 'over');
  // override 에 글이 있으면 그 폴더는 override 크기
  fs.writeFileSync(path.join(repo, 'sub', 'AGENTS.override.md'), 'o');
  assert.equal(measureCodex(proj, env).total, 10000 + 1 + 12768);
});

test('CLI: init 이 state.json 에 memory 저장, status 와 check 가 다시 재서 같은 경고', T, () => {
  const p = dir();
  const mem = dir('mem');
  fs.writeFileSync(path.join(mem, 'MEMORY.md'), Array.from({ length: 201 }, (_, i) => `- ${i}`).join('\n') + '\n');
  const r = cli(['init', '--memory', 'auto-memory', '--memory-dir', mem], p);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^경고: MEMORY\.md 가 로드 한도/m);
  const st = JSON.parse(fs.readFileSync(path.join(p, '.omc', 'progress-mon', 'state.json'), 'utf8'));
  assert.deepEqual(st.memory, { kind: 'auto-memory', path: path.join(mem, 'MEMORY.md') });
  const s = cli(['status'], p);
  assert.equal(s.code, 3);
  assert.match(s.err, /^경고: MEMORY\.md 가 로드 한도\(200줄 또는 25,000 B\)를 넘어 규칙이 로드되지 않음\n대안: --memory claude-md/m);
  const c = cli(['check'], p);
  assert.match(c.out, /^WARN state\.json memory MEMORY\.md 가 로드 한도\(200줄 또는 25,000 B\)를 넘어 규칙이 로드되지 않음\. 대안: --memory claude-md/m);
});

test('CLI: override 에 우리 블록만 남아 AGENTS.md 를 가리면 status, check 가 다시 경고', T, () => {
  const p = dir();
  fs.writeFileSync(path.join(p, 'AGENTS.md'), '# 원래 지시\n');
  fs.writeFileSync(path.join(p, 'AGENTS.override.md'), '임시 메모\n');
  const r = cli(['init', '--runtime', 'codex', '--memory', 'agents-md'], p);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^규칙 추가: AGENTS\.override\.md \(3줄\)$/m);
  // 사용자가 자기 메모를 지워 우리 블록만 남음
  const left = fs.readFileSync(path.join(p, 'AGENTS.override.md'), 'utf8').replace('임시 메모\n', '');
  fs.writeFileSync(path.join(p, 'AGENTS.override.md'), left);
  assert.ok(cli(['status'], p).err.includes(SHADOW_WARN));
  assert.ok(cli(['check'], p).out.includes(`WARN state.json memory ${SHADOW_WARN.slice(4)}`));
});

// 파일 링크. Windows 에서 권한(개발자 모드)이 없어 만들 수 없으면 거짓.
function fileLink(target, p) {
  try {
    fs.symlinkSync(target, p, 'file');
    return true;
  } catch (e) {
    if (process.platform === 'win32' && e.code === 'EPERM') return false;
    throw e;
  }
}

test('메모리 파일이 프로젝트(auto-memory 는 --memory-dir) 밖을 가리키는 링크면 거부, 밖 파일 그대로', T, (t) => {
  const out = dir('outside');
  const victim = path.join(out, 'victim.md');
  fs.writeFileSync(victim, 'keep\n');
  const p = dir();
  if (!fileLink(victim, path.join(p, 'CLAUDE.md'))) return t.skip('Windows 에서 파일 링크를 만들 권한이 없음(개발자 모드 꺼짐)');
  assert.throws(() => planMemory({ kind: 'claude-md', project: p, runtime: 'claude' }), /CLAUDE\.md 은 .+ 밖을 가리키는 링크라 거부/);
  const q = dir();
  fileLink(victim, path.join(q, 'AGENTS.md'));
  assert.throws(() => planMemory({ kind: 'agents-md', project: q, runtime: 'codex' }), /AGENTS\.md 은 .+ 밖을 가리키는 링크라 거부/);
  const mem = dir('memory');
  fileLink(victim, path.join(mem, 'MEMORY.md'));
  assert.throws(() => planMemory({ kind: 'auto-memory', memoryDir: mem, project: p, runtime: 'claude' }), /MEMORY\.md 은 .+ 밖을 가리키는 링크라 거부/);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'keep\n');
});

test('메모리 파일이 하드링크면 거부, 다른 이름의 파일 그대로', T, () => {
  const out = dir('outside');
  const victim = path.join(out, 'victim.md');
  fs.writeFileSync(victim, 'keep\n');
  const p = dir();
  fs.linkSync(victim, path.join(p, 'CLAUDE.md'));
  assert.throws(() => planMemory({ kind: 'claude-md', project: p, runtime: 'claude' }), /CLAUDE\.md 은 하드링크\(이름 2개\)라 거부/);
  const mem = dir('memory');
  fs.linkSync(victim, path.join(mem, 'MEMORY.md'));
  assert.throws(() => planMemory({ kind: 'auto-memory', memoryDir: mem, project: p, runtime: 'claude' }), /MEMORY\.md 은 하드링크\(이름 3개\)라 거부/);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'keep\n');
});

test('검사 뒤 쓰기 전에 하드링크로 바뀐 메모리 파일에는 쓰지 않음, 다른 이름의 파일 그대로', T, () => {
  const out = dir('outside');
  const victim = path.join(out, 'victim.md');
  fs.writeFileSync(victim, 'keep\n');
  const p = dir();
  const file = path.join(p, 'CLAUDE.md');
  fs.writeFileSync(file, '# 지시\n');
  const plan = planMemory({ kind: 'claude-md', project: p, runtime: 'claude' });
  fs.rmSync(file);
  fs.linkSync(victim, file); // 검사(planMemory)와 쓰기(applyMemory) 사이에 바뀜
  assert.throws(() => applyMemory(plan, p, ENV), /CLAUDE\.md 이 검사 뒤 하드링크나 특수 파일로 바뀌어 쓰지 않음/);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'keep\n');
});

test('검사 뒤 쓰기 전에 FIFO 로 바뀐 메모리 파일에서 멈추지 않고 쓰지 않음', { ...T, skip: process.platform === 'win32' && 'FIFO 는 POSIX 전용' }, () => {
  const p = dir();
  const file = path.join(p, 'CLAUDE.md');
  fs.writeFileSync(file, '# 지시\n');
  const plan = planMemory({ kind: 'claude-md', project: p, runtime: 'claude' });
  fs.rmSync(file);
  execFileSync('mkfifo', [file]); // 읽는 쪽이 없는 FIFO: 막는 open 이면 여기서 멈춤
  assert.throws(() => applyMemory(plan, p, ENV), (e) => e instanceof UsageError && /검사 뒤 하드링크나 특수 파일로 바뀌어 쓰지 않음/.test(e.message));
  assert.ok(fs.lstatSync(file).isFIFO());
});

test('쓰려고 열 때 EAGAIN(다른 프로세스의 잠금 등)이면 날 오류 대신 거부 문구로 끝나고 쓰지 않음', T, () => {
  const p = dir();
  const file = path.join(p, 'CLAUDE.md');
  fs.writeFileSync(file, '# 지시\n');
  const plan = planMemory({ kind: 'claude-md', project: p, runtime: 'claude' });
  const real = fs.openSync;
  fs.openSync = (f, ...rest) => {
    if (String(f) === file) throw Object.assign(new Error('EAGAIN'), { code: 'EAGAIN' });
    return real(f, ...rest);
  };
  try {
    assert.throws(() => applyMemory(plan, p, ENV), (e) => e instanceof UsageError && /CLAUDE\.md 이 검사 뒤 바뀌었거나 다른 프로세스가 잡고 있어 쓰지 않음/.test(e.message));
  } finally {
    fs.openSync = real;
  }
  assert.equal(fs.readFileSync(file, 'utf8'), '# 지시\n');
});

test('프로젝트 안을 가리키는 링크(CLAUDE.md -> AGENTS.md)는 그대로 받아 대상 파일에 덧붙임', T, (t) => {
  const p = dir();
  fs.writeFileSync(path.join(p, 'AGENTS.md'), '# 지시\n');
  if (!fileLink('AGENTS.md', path.join(p, 'CLAUDE.md'))) return t.skip('Windows 에서 파일 링크를 만들 권한이 없음(개발자 모드 꺼짐)');
  const plan = planMemory({ kind: 'claude-md', project: p, runtime: 'claude' });
  applyMemory(plan, p, ENV);
  assert.ok(fs.lstatSync(path.join(p, 'CLAUDE.md')).isSymbolicLink());
  assert.equal(count(fs.readFileSync(path.join(p, 'AGENTS.md'), 'utf8'), MARKER), 1);
});

test('Codex 규칙 줄: 승인 목록은 SKILL 런타임 표와 같은 start, stop, status, 다시 부를 이름은 Codex 이름', T, () => {
  const line = ruleLine('codex');
  assert.match(line, /start, stop, status 는 sandbox_permissions "require_escalated" 로 승인 요청/);
  assert.match(line, /banker-progress-mon 스킬\(플러그인 설치는 banker:progress-mon\)로 호출/);
  assert.match(fs.readFileSync(path.join(HERE, '..', 'SKILL.md'), 'utf8'), /^\| `start`, `stop`, `status` \| 바로 실행 \| 명령 하나씩 `sandbox_permissions: "require_escalated"`/m);
  assert.doesNotMatch(ruleLine('claude'), /sandbox_permissions/);
});

test('규칙 줄 교체 대상: 표식과 앞머리(규칙 줄, 색인 줄)로만 가리고, 규칙 줄 런타임은 --runtime codex 유무', T, () => {
  assert.equal(currentLine(OLD.claude), ruleLine('claude'));
  assert.equal(currentLine(OLD.codex), ruleLine('codex'));
  assert.equal(currentLine(OLD.index), INDEX_LINE);
  assert.equal(currentLine(ruleLine('claude')), ruleLine('claude'));
  assert.equal(currentLine(`사용자 메모 ${MARKER}`), null, '앞머리가 다른 표식 줄은 손대지 않음');
  assert.equal(currentLine(`  ${OLD.claude}`), null, '앞머리는 줄 맨 앞');
  assert.equal(currentLine(OLD.claude.replace(MARKER, '')), null, '표식 없는 줄');
  for (const r of [ruleLine('claude'), ruleLine('codex')]) assert.match(r, /adr\.json\(ADR 탭\)을 고치고 check/);
  assert.match(INDEX_LINE, /adr\.json/);
});

test('규칙 줄 교체: 옛 규칙 줄(CRLF, BOM)의 CLAUDE.md 는 그 줄만 바뀌고 나머지 바이트 그대로, 첫 원본 백업, 두 번째는 바뀐 것 없음', T, () => {
  const p = dir();
  const f = path.join(p, 'CLAUDE.md');
  const head = Buffer.from('\u{FEFF}# 내 규칙\r\n- 하나\r\n', 'utf8');
  const tail = Buffer.from('\r\n- 끝\r\n사용자 메모 ' + MARKER + '\r\n', 'utf8');
  const orig = Buffer.concat([head, Buffer.from(OLD.claude, 'utf8'), tail]);
  fs.writeFileSync(f, orig);
  const bak = `${f}.progress-mon.bak`;
  assert.deepEqual(register({ kind: 'claude-md', project: p, runtime: 'claude' }), [`규칙 줄 교체(백업 ${bak}): CLAUDE.md`]);
  const want = Buffer.concat([head, Buffer.from(ruleLine('claude'), 'utf8'), tail]);
  assert.deepEqual(fs.readFileSync(f), want);
  assert.deepEqual(fs.readFileSync(bak), orig);
  assert.deepEqual(register({ kind: 'claude-md', project: p, runtime: 'claude' }), ['규칙 이미 있음: CLAUDE.md']);
  assert.deepEqual(fs.readFileSync(f), want);
  assert.deepEqual(fs.readFileSync(bak), orig, '.bak 그대로');
  // 새로 만든 파일이 지금 판이면 다시 실행해도 아무것도 쓰지 않고 백업도 없음
  const q = dir();
  register({ kind: 'claude-md', project: q, runtime: 'claude' });
  register({ kind: 'claude-md', project: q, runtime: 'claude' });
  assert.deepEqual(fs.readdirSync(q), ['CLAUDE.md']);
});

test('규칙 줄 교체: 백업이 이미 있으면 덮지 않음, CLAUDE.md 의 옛 Codex 규칙 줄은 Codex 판으로', T, () => {
  const p = dir();
  const f = path.join(p, 'CLAUDE.md');
  fs.writeFileSync(f, `${OLD.codex}\n`);
  fs.writeFileSync(`${f}.progress-mon.bak`, '처음 원본');
  register({ kind: 'claude-md', project: p, runtime: 'claude' });
  assert.equal(fs.readFileSync(f, 'utf8'), `${ruleLine('codex')}\n`);
  assert.equal(fs.readFileSync(`${f}.progress-mon.bak`, 'utf8'), '처음 원본');
});

test('규칙 줄 교체: AGENTS.md 의 Codex 3줄 블록은 가운데 줄만 바뀌고 바깥 두 줄과 블록 밖 바이트 그대로', T, () => {
  const p = dir();
  const f = path.join(p, 'AGENTS.md');
  const text = (rule) => `# 지시\n\n${OMX_OPEN}\n${rule}\n${OMX_CLOSE}\n뒤 내용\n`;
  fs.writeFileSync(f, text(OLD.codex));
  assert.deepEqual(register({ kind: 'agents-md', project: p, runtime: 'codex' }), [`규칙 줄 교체(백업 ${f}.progress-mon.bak): AGENTS.md`]);
  assert.equal(fs.readFileSync(f, 'utf8'), text(ruleLine('codex')));
  assert.equal(fs.readFileSync(`${f}.progress-mon.bak`, 'utf8'), text(OLD.codex));
  const after = fs.readFileSync(f);
  assert.deepEqual(register({ kind: 'agents-md', project: p, runtime: 'codex' }), ['규칙 이미 있음: AGENTS.md']);
  assert.deepEqual(fs.readFileSync(f), after);
});

test('규칙 줄 교체: 자동 메모리 progress-mon.md 의 규칙 줄과 MEMORY.md 색인 줄, 다른 줄 그대로', T, () => {
  const mem = dir('mem');
  const p = dir();
  const rule = (l) => `---\nname: progress-mon\ndescription: 옛 설명\nmetadata:\n  type: feedback\n---\n\n${l}\n`;
  const index = (l) => `# 색인\n- [다른 메모](a.md) - 설명\n${l}\n`;
  fs.writeFileSync(path.join(mem, 'progress-mon.md'), rule(OLD.claude));
  fs.writeFileSync(path.join(mem, 'MEMORY.md'), index(OLD.index));
  const out = register({ kind: 'auto-memory', memoryDir: mem, project: p, runtime: 'claude' });
  assert.deepEqual(out, [
    `규칙 줄 교체(백업 ${path.join(mem, 'progress-mon.md.progress-mon.bak')}): 자동 메모리 progress-mon.md`,
    `규칙 줄 교체(백업 ${path.join(mem, 'MEMORY.md.progress-mon.bak')}): 자동 메모리 MEMORY.md`,
  ]);
  assert.equal(fs.readFileSync(path.join(mem, 'progress-mon.md'), 'utf8'), rule(ruleLine('claude')), 'frontmatter 는 옛 그대로');
  assert.equal(fs.readFileSync(path.join(mem, 'MEMORY.md'), 'utf8'), index(INDEX_LINE));
  assert.deepEqual(register({ kind: 'auto-memory', memoryDir: mem, project: p, runtime: 'claude' }), ['규칙 이미 있음: 자동 메모리 progress-mon.md', '규칙 이미 있음: 자동 메모리 MEMORY.md']);
});

test('규칙 줄 교체: init 다시 실행은 표식 줄만 바꾸고 자료 폴더의 config.json, items.json, state.json 의 memory 는 그대로', T, () => {
  const p = dir();
  assert.equal(cli(['init', '--memory', 'claude-md'], p).code, 0);
  const data = path.join(p, '.omc', 'progress-mon');
  const f = path.join(p, 'CLAUDE.md');
  fs.writeFileSync(f, `# 내 규칙\n${OLD.claude}\n`);
  const keep = ['config.json', 'items.json'].map((x) => fs.readFileSync(path.join(data, x)));
  const r = cli(['init', '--memory', 'claude-md'], p);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^규칙 줄 교체\(백업 .*CLAUDE\.md\.progress-mon\.bak\): CLAUDE\.md$/m);
  assert.match(r.out, /^그대로 둠: \.omc\/progress-mon\/config\.json$/m);
  assert.equal(fs.readFileSync(f, 'utf8'), `# 내 규칙\n${ruleLine('claude')}\n`);
  assert.deepEqual(['config.json', 'items.json'].map((x) => fs.readFileSync(path.join(data, x))), keep);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(data, 'state.json'), 'utf8')).memory, { kind: 'claude-md', path: f });
});

test('규칙 줄 교체: 검사 뒤 UTF-8 이 아니게 바뀐 파일은 바꾸지 않고 경고, 바이트와 백업 없음 그대로', T, () => {
  const p = dir();
  const f = path.join(p, 'CLAUDE.md');
  fs.writeFileSync(f, `${OLD.claude}\n`);
  const plan = planMemory({ kind: 'claude-md', project: p, runtime: 'claude' });
  const bad = Buffer.concat([Buffer.from(`${OLD.claude}\n`, 'utf8'), Buffer.from([0xff, 0xfe, 0x0a])]);
  fs.writeFileSync(f, bad);
  assert.deepEqual(applyMemory(plan, p, ENV), ['경고: CLAUDE.md 이 UTF-8 이 아니라 규칙 줄을 바꾸지 않음']);
  assert.deepEqual(fs.readFileSync(f), bad, 'U+FFFD 로 바뀌지 않음');
  assert.deepEqual(fs.readdirSync(p), ['CLAUDE.md'], '백업과 임시 파일 없음');
});

test('규칙 줄 교체는 임시 파일과 rename: 권한 유지, 임시 파일 남지 않음, 안쪽 링크(CLAUDE.md -> AGENTS.md)는 링크 그대로 대상만 바뀜', T, (t) => {
  const p = dir();
  const f = path.join(p, 'AGENTS.md');
  fs.writeFileSync(f, `# 지시\n${OLD.claude}\n`);
  if (process.platform !== 'win32') fs.chmodSync(f, 0o640);
  if (!fileLink('AGENTS.md', path.join(p, 'CLAUDE.md'))) return t.skip('Windows 에서 링크를 만들 권한이 없음(개발자 모드 꺼짐)');
  const out = register({ kind: 'claude-md', project: p, runtime: 'claude' });
  assert.deepEqual(out, [`규칙 줄 교체(백업 ${path.join(p, 'CLAUDE.md.progress-mon.bak')}): CLAUDE.md`]);
  assert.ok(fs.lstatSync(path.join(p, 'CLAUDE.md')).isSymbolicLink(), '링크 그대로');
  assert.equal(fs.readFileSync(f, 'utf8'), `# 지시\n${ruleLine('claude')}\n`);
  if (process.platform !== 'win32') assert.equal(fs.statSync(f).mode & 0o777, 0o640, '권한 유지');
  assert.deepEqual(fs.readdirSync(p).sort(), ['AGENTS.md', 'CLAUDE.md', 'CLAUDE.md.progress-mon.bak'], '임시 파일 없음');
});
