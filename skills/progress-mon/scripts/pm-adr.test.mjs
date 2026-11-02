// pm-adr.mjs 시험. 임시 프로젝트에 고정 자료(assets/fixture)와 adr.json 이 가리키는 파일을 만들고 check, 정리, 렌더, export,
// 서버, 옛 판 자료 폴더의 ADR 단계를 본다. 화면 e2e 는 Playwright Chromium(테스트박스 도구 폴더, 없으면 이 PC 의 전역)으로 export 한 HTML 을 연다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runCheck } from './pm-check.mjs';
import { adrRows, adrSchema, cleanAdr } from './pm-adr.mjs';
import { checkNote, refText } from './pm-adr-view.mjs';
import { renderTab, command as renderCommand } from './pm-render.mjs';
import { serve } from './pm-server.mjs';
import { validate } from './pm-config.mjs';
// 이 계정이 심볼릭 링크를 만들 수 있는지(Windows 는 관리자나 개발자 모드). 못 만들면 링크 시험은 그 까닭으로 건너뜀.
// scripts/test-fixtures/can-symlink.mjs 와 같은 일을 여기서 한다: progress-mon 의 파일은 node: 와 ./ 만 가져온다(progress-mon.test.mjs AC-4).
const symlinkSkip = (() => {
  if (process.platform !== 'win32') return false;
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'can-symlink-'));
  try {
    fs.writeFileSync(path.join(d, 't'), '');
    fs.symlinkSync(path.join(d, 't'), path.join(d, 'l'), 'file');
    return false;
  } catch {
    return 'this Windows account cannot make symbolic links (needs an elevated administrator or Developer Mode)';
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
})();


const T = { timeout: 60000 };
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'progress-mon.mjs');
const FIX = path.resolve(HERE, '..', 'assets', 'fixture');
const ROOT = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'progress-mon-test-')));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const HOME = path.join(ROOT, 'home');
const ENV = (() => {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(CLAUDE_|CODEX_|PROGRESS_MON_|PM_TEST_|GIT_)/i.test(k)) env[k] = v;
  return Object.assign(env, {
    HOME,
    USERPROFILE: HOME,
    APPDATA: path.join(HOME, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(HOME, 'AppData', 'Local'),
    CLAUDE_CONFIG_DIR: path.join(HOME, '.claude'),
    CODEX_HOME: path.join(HOME, '.codex'),
    NO_COLOR: '1',
    GIT_CEILING_DIRECTORIES: ROOT,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(ROOT, 'gitconfig-empty'),
  });
})();
fs.writeFileSync(ENV.GIT_CONFIG_GLOBAL, '');
process.env.GIT_CEILING_DIRECTORIES = ROOT;
const NOW = Date.parse('2026-10-29T03:00:00Z');
const FILES = ['config.json', 'items.json', 'req-spec.json', 'reqs.json', 'flow.json', 'arch.json'];
const readFix = (...p) => JSON.parse(fs.readFileSync(path.join(FIX, ...p), 'utf8'));
const EVIL = `<script>alert("x")</script>&'`;
const COMMIT_WARN = 'WARN adr.json project.proof.implemented[0].proofs[1] 참조: git 저장소가 아니거나 git 이 없어 커밋을 확인 못 함: 1a2b3c4';
// 고정 자료의 gap 은 ADR-2 의 확장 대응 하나. ADR 밀도는 adr.json 이 있으면 init 기록이 없어도 늘 나온다
const FIX_TAIL = ['WARN density adr 빈 항목 8/9: decisions[1].scaling', 'check: FAIL 0, WARN 2', 'adr 근거 없음 1칸, 미검증 0, 구현 못 함 1, 참조 없는 서술 0'];

let n = 0;
// adr.json 이 가리키는 프로젝트 파일.
function refFiles(project) {
  const put = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(project, rel)), { recursive: true });
    fs.writeFileSync(path.join(project, rel), text);
  };
  put('src/app.mjs', 'export const a = 1;\nexport const b = 2;\nexport function render() {}\n');
  put('test/app.test.mjs', "test('설정 읽기', () => {});\ntest('바인드', () => {});\n");
  put('docs/evidence/test-run.md', '명령: node --test test/\n종료 코드: 0\n시각: 2026-10-29T03:00:00Z\n');
  put('docs/adr/0001-data-file.md', '# 자료는 JSON 파일\n');
}

// 고정 자료를 복사한 자료 폴더와 참조 파일. o: { adr: 값 | null(쓰지 않음) | 문자열, files, initd, config }
function project(o = {}) {
  const proj = path.join(ROOT, `p${++n}`);
  const dataDir = path.join(proj, '.omc', 'progress-mon');
  fs.mkdirSync(dataDir, { recursive: true });
  for (const f of FILES) fs.copyFileSync(path.join(FIX, f), path.join(dataDir, f));
  if (o.config) fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(o.config));
  const adr = o.adr === undefined ? readFix('adr.json') : o.adr;
  if (adr !== null) fs.writeFileSync(path.join(dataDir, 'adr.json'), typeof adr === 'string' ? adr : JSON.stringify(adr, null, 2));
  if (o.files !== false) refFiles(proj);
  if (o.initd) fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ memory: { kind: 'none', path: null } }));
  return { project: proj, runtime: 'claude', dataDir, exists: true };
}
const check = (ctx) => runCheck(ctx, ENV);
const adrLines = (lines) => lines.filter((l) => / adr\.json |density adr /.test(l));
const configOf = (ctx) => validate(JSON.parse(fs.readFileSync(path.join(ctx.dataDir, 'config.json'), 'utf8')), ctx.project).config;
const cli = (args, cwd) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env: ENV, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const GIT = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
const symlink = (target, p) => {
  try {
    fs.symlinkSync(target, p, 'file');
    return true;
  } catch (e) {
    if (process.platform === 'win32' && e.code === 'EPERM') return false;
    throw e;
  }
};

test('check: 고정 adr.json 은 FAIL 0, 커밋은 git 저장소가 아니라 WARN, init 기록이 없어도 ADR 밀도 WARN 과 근거 없음 칸 수', T, () => {
  const { lines, fails } = check(project());
  assert.equal(fails, 0);
  assert.deepEqual(lines, [COMMIT_WARN, ...FIX_TAIL]);
  assert.deepEqual(check(project({ adr: null })).lines.slice(-1), ['adr 근거 없음 0칸, 미검증 0, 구현 못 함 0, 참조 없는 서술 0'], 'adr.json 이 없어도 0 으로');
});

test('주장에는 증거: 구현됨 기능의 증명, 검증한 모듈의 evidence 가 gap 뿐이거나 참조 0개면 FAIL 과 벗어나는 길', T, () => {
  const cases = [
    [(a) => (a.project.verification[1].evidence = [{ gap: '시험 안 돌림' }]), 'FAIL adr.json project.verification[1].evidence 증거 없음: 확인된 검증 증거가 없음(FAIL, WARN 없이 확인된 참조 0개). 증거를 지어내지 말고 그 모듈을 미검증으로 옮김: status "unverified" 와 why(사유)'],
    [(a) => (a.project.verification[1].evidence = []), 'FAIL adr.json project.verification[1].evidence 증거 없음: 확인된 검증 증거가 없음(FAIL, WARN 없이 확인된 참조 0개). 증거를 지어내지 말고 그 모듈을 미검증으로 옮김: status "unverified" 와 why(사유)'],
    [(a) => (a.project.proof.implemented[0].proofs = [{ gap: '아직 없음' }]), 'FAIL adr.json project.proof.implemented[0].proofs 증거 없음: 확인된 구현 증명이 없음(FAIL, WARN 없이 확인된 참조 0개). 증거를 지어내지 말고 그 기능을 구현 못 함 목록으로 옮김: notImplemented 에 feature 와 why(사유)'],
    [(a) => (a.project.proof.implemented[0].proofs = []), 'FAIL adr.json project.proof.implemented[0].proofs 증거 없음: 확인된 구현 증명이 없음(FAIL, WARN 없이 확인된 참조 0개). 증거를 지어내지 말고 그 기능을 구현 못 함 목록으로 옮김: notImplemented 에 feature 와 why(사유)'],
    [(a) => (a.project.verification = { gap: '모름' }), 'FAIL adr.json project.verification 증거 없음: 검증 칸 전체를 gap 으로 둘 수 없음. 모듈을 적고 증거를 지어내지 말고 그 모듈을 미검증으로 옮김: status "unverified" 와 why(사유)'],
    [(a) => (a.project.proof = { gap: '모름' }), 'FAIL adr.json project.proof 증거 없음: 증거 칸 전체를 gap 으로 둘 수 없음. implemented 를 비우고 증거를 지어내지 말고 그 기능을 구현 못 함 목록으로 옮김: notImplemented 에 feature 와 why(사유)'],
    [(a) => (a.project.verification[1] = { id: 'M-2', module: '화면 렌더', status: 'unverified' }), 'FAIL adr.json project.verification[1].why 칸 없음'],
  ];
  for (const [edit, want] of cases) {
    const a = readFix('adr.json');
    edit(a);
    const { lines, fails } = check(project({ adr: a }));
    assert.ok(lines.includes(want), `${want}\n${lines.join('\n')}`);
    assert.ok(fails >= 1);
  }
  // 벗어나는 길: 그 모듈을 미검증으로(evidence 불필요), 그 기능을 구현 못 함 목록으로
  const a = readFix('adr.json');
  a.project.verification[1] = { id: 'M-2', module: '화면 렌더', status: 'unverified', why: '렌더 시험을 아직 돌리지 않음' };
  a.project.proof.notImplemented.push({ feature: a.project.proof.implemented[0].feature, why: '증명할 시험 기록이 없음' });
  a.project.proof.implemented = [];
  const ctx = project({ adr: a });
  const { lines, fails } = check(ctx);
  assert.equal(fails, 0, lines.join('\n'));
  const h = renderTab(ctx, configOf(ctx), 'adr', NOW);
  assert.ok(h.includes('<span class="b unv">미검증: 렌더 시험을 아직 돌리지 않음</span>'));
});

test('주장에는 증거: 확인 못 한 참조(출력 없는 명령, 파일에 없는 시험 이름, git 이 꺼진 커밋)는 증거로 세지 않아 FAIL, 확인된 file 참조 하나면 통과', T, () => {
  const M = 'FAIL adr.json project.verification[1].evidence 증거 없음: ';
  const F = 'FAIL adr.json project.proof.implemented[0].proofs 증거 없음: ';
  const off = readFix('config.json');
  off.sources.git = false;
  const cases = [
    [(a) => (a.project.verification[1].evidence = [{ kind: 'cmd', cmd: 'node --test test/' }]), M, undefined],
    [(a) => (a.project.proof.implemented[0].proofs = [{ kind: 'test', path: 'test/app.test.mjs', name: '없는 시험' }]), F, undefined],
    [(a) => (a.project.proof.implemented[0].proofs = [{ kind: 'commit', hash: '1a2b3c4' }]), F, off],
    [(a) => (a.project.verification[1].evidence = [{ kind: 'file', path: 'src/none.mjs' }]), M, undefined],
  ];
  for (const [edit, head, config] of cases) {
    const a = readFix('adr.json');
    edit(a);
    const { lines } = check(project({ adr: a, config }));
    const hit = lines.find((l) => l.startsWith(head));
    assert.ok(hit && hit.endsWith('증거를 지어내지 말고 ' + (head === M ? '그 모듈을 미검증으로 옮김: status "unverified" 와 why(사유)' : '그 기능을 구현 못 함 목록으로 옮김: notImplemented 에 feature 와 why(사유)')), `${head}\n${lines.join('\n')}`);
  }
  const a = readFix('adr.json');
  a.project.verification[1].evidence = [{ kind: 'cmd', cmd: 'x' }, { kind: 'file', path: 'src/app.mjs' }];
  a.project.proof.implemented[0].proofs = [{ kind: 'file', path: 'src/app.mjs', line: 1 }];
  const { lines, fails } = check(project({ adr: a }));
  assert.equal(fails, 0, lines.join('\n'));
});

test('WARN 유지: 결정의 최적화 로직, 확장 대응, 포기와 얻은 것과 프로젝트 흐름의 gap 은 FAIL 이 아니고 밀도 WARN, 근거 없음 칸 수. 확인된 참조 0개인 서술 칸은 참조 없는 서술 n 과 빨강 배지', T, () => {
  const a = readFix('adr.json');
  a.project.flow = { gap: '흐름 문서 없음' };
  a.decisions[0].optimization = { gap: '벤치 안 함' };
  a.decisions[0].scaling = { gap: '규모 시험 안 함' };
  a.decisions[0].tradeoffs = { gap: '정리 안 함' };
  a.decisions[0].sources = [{ gap: '문서 없음' }];
  const ctx = project({ adr: a });
  fs.rmSync(path.join(ctx.project, 'docs', 'adr'), { recursive: true });
  const { lines, fails } = check(ctx);
  assert.equal(fails, 0, lines.join('\n'));
  assert.ok(lines.includes('WARN density adr 빈 항목 4/9: project.flow, decisions[0].optimization, decisions[0].scaling, decisions[0].tradeoffs, decisions[1].scaling'), lines.join('\n'));
  assert.equal(lines[lines.length - 1], 'adr 근거 없음 6칸, 미검증 0, 구현 못 함 1, 참조 없는 서술 0', '여섯 항목 칸 5개와 참조 자리 1개');
  const h = renderTab(ctx, configOf(ctx), 'adr', NOW);
  assert.ok(h.includes('<div class="meta"><span class="b miss">근거 없음 6칸, 미검증 0, 구현 못 함 1, 참조 없는 서술 0</span> <span class="b unv">check 기록 없음. 참조 확인은 check</span></div>\n<h2>프로젝트 요약</h2>'), '배지는 프로젝트 요약 위, 그 옆에 check 대조');
  // 확장 대응을 채웠지만 refs 에 확인된 참조가 0개: 규칙은 WARN(FAIL 0)이고, 배지와 마지막 줄에 참조 없는 서술 1, 배지는 초록이 아님
  a.decisions[1].scaling = { argument: '규모와 무관', refs: [] };
  for (const k of ['optimization', 'scaling', 'tradeoffs']) a.decisions[0][k] = readFix('adr.json').decisions[0][k];
  a.project.flow = readFix('adr.json').project.flow;
  delete a.decisions[0].sources;
  a.project.proof.notImplemented = [];
  fs.writeFileSync(path.join(ctx.dataDir, 'adr.json'), JSON.stringify(a));
  const bare = check(ctx);
  assert.equal(bare.fails, 0, bare.lines.join('\n'));
  assert.equal(bare.lines.slice(-1)[0], 'adr 근거 없음 0칸, 미검증 0, 구현 못 함 0, 참조 없는 서술 1');
  assert.ok(bare.lines.includes('WARN density adr 서술참조 3/4: decisions[1].scaling'), bare.lines.join('\n'));
  assert.ok(renderTab(ctx, configOf(ctx), 'adr', NOW).includes('<span class="b miss">근거 없음 0칸, 미검증 0, 구현 못 함 0, 참조 없는 서술 1</span>'), '참조 없는 서술이 있으면 초록이 아님');
  // 확인 못 하는 참조(출력 파일 없는 명령)만 있으면 check 는 참조 없는 서술로 셈. 화면은 파일을 읽지 않아 적힌 참조로 셈
  a.decisions[1].scaling.refs = [{ kind: 'cmd', cmd: 'node bench.mjs' }];
  fs.writeFileSync(path.join(ctx.dataDir, 'adr.json'), JSON.stringify(a));
  assert.equal(check(ctx).lines.slice(-1)[0], 'adr 근거 없음 0칸, 미검증 0, 구현 못 함 0, 참조 없는 서술 1');
  a.decisions[1].scaling.refs = [{ kind: 'file', path: 'src/app.mjs' }];
  fs.writeFileSync(path.join(ctx.dataDir, 'adr.json'), JSON.stringify(a));
  assert.equal(check(ctx).lines.slice(-1)[0], 'adr 근거 없음 0칸, 미검증 0, 구현 못 함 0, 참조 없는 서술 0');
  assert.ok(renderTab(ctx, configOf(ctx), 'adr', NOW).includes('<span class="b done">근거 없음 0칸, 미검증 0, 구현 못 함 0, 참조 없는 서술 0</span>'), '0 이면 0 으로');
  // 모든 모듈이 미검증이면 근거 없음 0칸이어도 초록이 아니고 미검증 수가 보임
  a.project.verification = a.project.verification.map((m) => ({ id: m.id, module: m.module, status: 'unverified', why: '시험 안 돌림' }));
  fs.writeFileSync(path.join(ctx.dataDir, 'adr.json'), JSON.stringify(a));
  assert.equal(check(ctx).lines.slice(-1)[0], 'adr 근거 없음 0칸, 미검증 2, 구현 못 함 0, 참조 없는 서술 0');
  assert.ok(renderTab(ctx, configOf(ctx), 'adr', NOW).includes('<span class="b miss">근거 없음 0칸, 미검증 2, 구현 못 함 0, 참조 없는 서술 0</span>'));
});

test('check 대조: check 명령이 adr-check.json 에 집계와 adr.json sha256 을 남기고, 화면은 같음, 바뀜, 다름을 알림', T, () => {
  const a = readFix('adr.json');
  const ctx = project({ adr: a });
  const rec = () => JSON.parse(fs.readFileSync(path.join(ctx.dataDir, 'adr-check.json'), 'utf8'));
  const tab = () => renderTab(ctx, configOf(ctx), 'adr', NOW);
  assert.ok(!fs.existsSync(path.join(ctx.dataDir, 'adr-check.json')), 'runCheck 는 자료 폴더에 쓰지 않음');
  check(ctx);
  assert.ok(!fs.existsSync(path.join(ctx.dataDir, 'adr-check.json')), 'runCheck 만으로는 기록을 쓰지 않음');
  assert.equal(cli(['check'], ctx.project).code, 0);
  const r1 = rec();
  assert.match(r1.sha, /^[0-9a-f]{64}$/);
  assert.equal(r1.tally, FIX_TAIL[2].slice(4));
  assert.match(tab(), /<span class="b done">check\(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC\) 와 같음<\/span>/);
  // 확인 못 하는 참조(출력 파일 없는 명령)로 바꿈: check 전에는 바뀜, check 뒤에는 check 기준 수와 다름을 알림
  a.decisions[0].scaling.refs = [{ kind: 'cmd', cmd: 'node bench.mjs' }];
  fs.writeFileSync(path.join(ctx.dataDir, 'adr.json'), JSON.stringify(a, null, 2));
  assert.match(tab(), /<span class="b unv">check\([^)]*\) 뒤 adr\.json 이 바뀜\. check 를 다시 실행하면 대조<\/span>/);
  assert.equal(cli(['check'], ctx.project).code, 0);
  const r2 = rec();
  assert.notEqual(r2.sha, r1.sha);
  assert.match(r2.tally, /참조 없는 서술 1$/);
  const h = tab();
  assert.ok(h.includes('참조 없는 서술 0</span>'), '화면 배지는 적힌 참조로 0');
  assert.ok(h.includes(`<span class="b miss">check(${r2.at.slice(0, 19).replace('T', ' ')} UTC) 기준: ${r2.tally}. 화면은 적힌 참조로 세어 다름. 확인 못 한 참조는 check 의 참조 줄</span>`), h);
  // BOM 이 붙어도 같은 글로 보아 같음
  assert.equal(cli(['check'], ctx.project).code, 0);
  fs.writeFileSync(path.join(ctx.dataDir, 'adr.json'), `\ufeff${JSON.stringify(a, null, 2)}`);
  assert.ok(tab().includes('기준: '), 'BOM 만 붙은 adr.json 은 같은 글');
  // 깨진 기록은 기록 없음
  fs.writeFileSync(path.join(ctx.dataDir, 'adr-check.json'), '{');
  assert.ok(tab().includes('<span class="b unv">check 기록 없음. 참조 확인은 check</span>'));
  // 기록 자리에 폴더가 있으면 쓰기 실패 경고만 stderr 에, 검사 결과와 종료 코드는 그대로
  fs.rmSync(path.join(ctx.dataDir, 'adr-check.json'));
  fs.mkdirSync(path.join(ctx.dataDir, 'adr-check.json'));
  const w = cli(['check'], ctx.project);
  assert.equal(w.code, 0, w.err);
  assert.match(w.err, /경고: adr-check\.json 쓰기 실패\([A-Z]+\)\. 원본 그대로\. 화면의 check 대조가 낡을 수 있음/);
  assert.match(w.out, /\nadr 근거 없음 1칸, 미검증 0, 구현 못 함 1, 참조 없는 서술 1\n$/);
  assert.deepEqual(fs.readdirSync(ctx.dataDir).filter((x) => x.endsWith('.tmp')), [], '임시 파일 남지 않음');
  // adr.json 이 없으면 기록을 쓰지 않음
  const none = project({ adr: null });
  assert.equal(cli(['check'], none.project).code, 0);
  assert.ok(!fs.existsSync(path.join(none.dataDir, 'adr-check.json')));
  // adr.json 이 JSON 이 아니면 FAIL 이고 기록을 쓰지 않음
  const broken = project({ adr: '{' });
  assert.equal(cli(['check'], broken.project).code, 1);
  assert.ok(!fs.existsSync(path.join(broken.dataDir, 'adr-check.json')));
});

test('checkNote: 기록의 글은 이스케이프하고, 꼴이 틀린 기록은 기록 없음', () => {
  const m = (value, sha = 'x') => ({ adr: { value: {}, sha }, adrCheck: { value } });
  assert.ok(checkNote(m({ sha: 'x', tally: EVIL, at: EVIL }), 'y').includes('&lt;script&gt;'));
  assert.ok(!checkNote(m({ sha: 'x', tally: EVIL, at: EVIL }), 'y').includes('<script>'));
  for (const v of [null, [], { sha: 1, tally: 'a' }, { sha: 'x' }]) assert.ok(checkNote(m(v), 'a').includes('check 기록 없음'), JSON.stringify(v));
  assert.ok(checkNote({ adr: { missing: true } }, 'a').includes('check 기록 없음'));
  assert.ok(checkNote(m({ sha: 'x', tally: 'a' }), 'a').includes('b done">check 와 같음'), '시각 없는 기록');
});

test('check 스키마: project, project.flow, 결정의 tradeoffs 없음, 선택지 1개에 rejected 없음, 사유 없는 gap, 모듈 id 겹침과 없는 id 는 FAIL 과 json 경로', T, () => {
  const cases = [
    [(a) => delete a.project, 'FAIL adr.json project 칸 없음'],
    [(a) => delete a.project.flow, 'FAIL adr.json project.flow 칸 없음'],
    [(a) => delete a.decisions[0].tradeoffs, 'FAIL adr.json decisions[0].tradeoffs 칸 없음'],
    [(a) => delete a.decisions[1].rejected, 'FAIL adr.json decisions[1].options 선택지 1개. 2개 미만이면 rejected(다른 선택지를 버린 사유) 필요'],
    [(a) => (a.decisions[1].scaling = { gap: ' ' }), 'FAIL adr.json decisions[1].scaling.gap gap 에 사유 없음'],
    [(a) => (a.project.verification[1].id = 'M-1'), 'FAIL adr.json project.verification[1].id 모듈 id 겹침: M-1'],
    [(a) => (a.decisions[0].optimization.modules = ['M-9']), 'FAIL adr.json decisions[0].optimization.modules[0] 모듈 없음: M-9'],
    [(a) => (a.project.proof.implemented[0].modules = ['M-1', 'M-7']), 'FAIL adr.json project.proof.implemented[0].modules[1] 모듈 없음: M-7'],
    [(a) => (a.decisions[0].status = 'done'), 'FAIL adr.json decisions[0].status accepted, proposed, superseded 가운데 하나가 아님: done'],
    [(a) => (a.decisions[0].sources[0] = { kind: 'url', path: 'x' }), 'FAIL adr.json decisions[0].sources[0].kind file, test, commit, cmd 가운데 하나가 아님: url'],
    [(a) => (a.project.flow = 'x'), 'FAIL adr.json project.flow 객체이거나 { gap: 사유 } 가 아님'],
  ];
  for (const [edit, want] of cases) {
    const a = readFix('adr.json');
    edit(a);
    const { lines, fails } = check(project({ adr: a }));
    assert.ok(lines.includes(want), `${want}\n${lines.join('\n')}`);
    assert.ok(fails >= 1);
  }
  assert.ok(check(project({ adr: '{' })).lines.some((l) => l.startsWith('FAIL adr.json $ JSON 아님')));
  assert.deepEqual(adrSchema([]).schema, [{ p: '$', msg: '객체가 아님' }]);
});

test('check 참조: 없는 파일, 줄 수를 넘는 line, 절대 경로, .. 경로는 FAIL 참조, 시험 이름 없음과 output 없는 cmd 는 WARN', T, () => {
  const a = readFix('adr.json');
  a.project.verification[1].evidence[0] = { kind: 'file', path: 'src/none.mjs' };
  a.project.flow.refs[0] = { kind: 'file', path: 'src/app.mjs', line: 99 };
  a.decisions[0].scaling.refs[0] = { kind: 'file', path: path.join(ROOT, 'outside.md') };
  a.decisions[0].optimization.refs[0] = { kind: 'cmd', cmd: 'node --test test/', output: '../evidence.md' };
  a.project.verification[0].evidence[0] = { kind: 'test', path: 'test/app.test.mjs', name: '없는 이름' };
  a.project.verification[0].evidence[1] = { kind: 'cmd', cmd: 'node --test test/' };
  const lines = adrLines(check(project({ adr: a })).lines);
  for (const w of [
    'FAIL adr.json project.verification[1].evidence[0] 참조: 파일 없음: src/none.mjs',
    'FAIL adr.json project.flow.refs[0] 참조: 줄 99 이 줄 수 3 을 넘음: src/app.mjs',
    `FAIL adr.json decisions[0].scaling.refs[0] 참조: 절대 경로: ${path.join(ROOT, 'outside.md')}`,
    'FAIL adr.json decisions[0].optimization.refs[0] 참조: .. 이 든 경로: ../evidence.md',
    'WARN adr.json project.verification[0].evidence[0] 참조: 시험 이름이 파일에 없음: test/app.test.mjs 의 없는 이름',
    'WARN adr.json project.verification[0].evidence[1] 참조: 출력 파일이 없어 명령 결과를 확인 못 함: node --test test/',
  ]) assert.ok(lines.includes(w), `${w}\n${lines.join('\n')}`);
});

test('check 참조: 루트 밖을 가리키는 링크는 FAIL, 안쪽 링크는 통과', T, (t) => {
  const ctx = project();
  fs.writeFileSync(path.join(ROOT, 'outside-target.md'), 'x\n');
  if (!symlink(path.join(ROOT, 'outside-target.md'), path.join(ctx.project, 'docs', 'out.md'))) return t.skip('Windows 에서 링크를 만들 권한이 없음(개발자 모드 꺼짐)');
  symlink(path.join(ctx.project, 'src', 'app.mjs'), path.join(ctx.project, 'docs', 'in.md'));
  const a = readFix('adr.json');
  a.decisions[0].sources = [{ kind: 'file', path: 'docs/out.md' }, { kind: 'file', path: 'docs/in.md', line: 3 }, { kind: 'file', path: 'docs/adr/0001-data-file.md' }];
  fs.writeFileSync(path.join(ctx.dataDir, 'adr.json'), JSON.stringify(a));
  const lines = adrLines(check(ctx).lines);
  assert.ok(lines.includes('FAIL adr.json decisions[0].sources[0] 참조: 프로젝트 루트 밖을 가리키는 링크: docs/out.md'), lines.join('\n'));
  assert.equal(lines.filter((l) => l.includes('sources[1]')).length, 0, lines.join('\n'));
});

test('check 참조: FIFO 와 폴더 자리는 읽지 않고 FAIL, 크기 상한을 넘는 파일은 줄 수 확인 못 함 WARN', T, (t) => {
  const ctx = project();
  fs.rmSync(path.join(ctx.project, 'src', 'app.mjs'));
  fs.mkdirSync(path.join(ctx.project, 'src', 'app.mjs'));
  const big = path.join(ctx.project, 'test', 'app.test.mjs');
  fs.writeFileSync(big, Buffer.alloc(4 * 1024 * 1024 + 1, 0x61));
  let lines = adrLines(check(ctx).lines);
  assert.ok(lines.includes('FAIL adr.json project.verification[1].evidence[0] 참조: 일반 파일이 아님(폴더나 특수 파일): src/app.mjs'), lines.join('\n'));
  assert.ok(lines.includes('WARN adr.json project.verification[0].evidence[0] 참조: 크기 상한(4 MB)을 넘어 내용을 확인 못 함: test/app.test.mjs'), lines.join('\n'));
  if (process.platform === 'win32') return t.skip('FIFO 는 POSIX 전용');
  const fifo = path.join(ctx.project, 'docs', 'evidence', 'test-run.md');
  fs.rmSync(fifo);
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0, 'mkfifo');
  const t0 = Date.now();
  lines = adrLines(check(ctx).lines);
  assert.ok(Date.now() - t0 < 10000, 'FIFO 에서 멈추지 않음');
  assert.ok(lines.includes('FAIL adr.json project.verification[0].evidence[1] 참조: 일반 파일이 아님(폴더나 특수 파일): docs/evidence/test-run.md'), lines.join('\n'));
});

test('check 참조: git 저장소에서 없는 커밋은 FAIL, 있는 커밋은 줄 없음, sources.git 이 꺼지면 WARN', { ...T, skip: GIT ? false : 'git 없음' }, () => {
  const ctx = project();
  const g = (...a) => assert.equal(spawnSync('git', a, { cwd: ctx.project, env: { ...ENV, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }, encoding: 'utf8' }).status, 0, a.join(' '));
  g('init', '-q');
  g('add', 'src/app.mjs');
  g('commit', '-q', '-m', 'first');
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ctx.project, env: ENV, encoding: 'utf8' }).stdout.trim();
  let lines = adrLines(check(ctx).lines);
  assert.ok(lines.some((l) => l.startsWith('FAIL adr.json project.proof.implemented[0].proofs[1] 참조: 커밋 없음') && l.endsWith(': 1a2b3c4')), lines.join('\n'));
  const a = readFix('adr.json');
  a.project.proof.implemented[0].proofs[1].hash = head.slice(0, 7);
  fs.writeFileSync(path.join(ctx.dataDir, 'adr.json'), JSON.stringify(a));
  lines = adrLines(check(ctx).lines);
  assert.equal(lines.filter((l) => l.includes('proofs[1]')).length, 0, lines.join('\n'));
  const cfg = readFix('config.json');
  cfg.sources.git = false;
  fs.writeFileSync(path.join(ctx.dataDir, 'config.json'), JSON.stringify(cfg));
  lines = adrLines(check(ctx).lines);
  assert.ok(lines.includes(`WARN adr.json project.proof.implemented[0].proofs[1] 참조: sources.git 이 꺼져 있어 커밋을 확인 못 함: ${head.slice(0, 7)}`), lines.join('\n'));
});

test('정리: 옮길 이름 자리의 끊어진 링크는 따라가지 않고 다음 번호로, 링크 너머에 파일 없음', { ...T, skip: symlinkSkip }, async () => {
  const bad = readFix('adr.json');
  delete bad.project.flow;
  const ctx = project({ adr: bad });
  const at = new Date(2026, 9, 29, 3, 4, 5).getTime();
  const first = path.join(ctx.dataDir, 'adr.json.rejected-20261029-030405');
  const target = path.join(ctx.project, 'outside-rejected.json');
  fs.symlinkSync(target, first, 'file');
  const out = await cleanAdr(ctx, configOf(ctx), at);
  assert.match(out[0], /adr\.json\.rejected-20261029-030405-2 로 옮김/);
  assert.equal(fs.existsSync(target), false);
  assert.ok(fs.lstatSync(first).isSymbolicLink(), '링크는 그대로');
});

test('정리: 참조 FAIL 만 있으면 파일을 남기고 그 참조를 gap 으로, 다시 돈 check 는 FAIL 0 과 WARN. 스키마 FAIL 이 남으면 adr.json.rejected-<시각> 으로 옮김(바이트 같음, 이름이 있으면 번호)', T, async () => {
  const a = readFix('adr.json');
  a.project.verification[1].evidence[0] = { kind: 'file', path: 'src/none.mjs' };
  // M-2 의 evidence 는 이 참조 하나: 정리 뒤 증거가 모두 gap 이 되어도 자동으로 옮기지 않고 FAIL 로 보고, 파일은 남음
  const ctx = project({ adr: a, initd: true });
  assert.equal(check(ctx).fails, 2, '참조 FAIL 과 증거 없음');
  const out = await cleanAdr(ctx, configOf(ctx));
  assert.deepEqual(out, ['정리: adr.json 참조 FAIL 1건을 gap 으로 바꿈: project.verification[1].evidence[0]', '정리: 증거가 남지 않은 주장 1건(자동으로 옮기지 않음, check 의 FAIL 참고): project.verification[1].evidence']);
  const now = JSON.parse(fs.readFileSync(path.join(ctx.dataDir, 'adr.json'), 'utf8'));
  assert.deepEqual(now.project.verification[1].evidence[0], { gap: '참조 확인 실패: 파일 없음: src/none.mjs' });
  assert.equal(now.project.verification[1].status, undefined, '모듈을 자동으로 미검증으로 옮기지 않음');
  const again = check(ctx);
  assert.equal(again.fails, 1, again.lines.join('\n'));
  assert.ok(again.lines.some((l) => l.startsWith('FAIL adr.json project.verification[1].evidence 증거 없음: ')), again.lines.join('\n'));
  assert.deepEqual(await cleanAdr(ctx, configOf(ctx)), ['정리: adr.json 참조 FAIL 0, 바꾼 것 없음'], '증거 없는 주장은 파일을 옮기지 않음');
  assert.ok(fs.existsSync(path.join(ctx.dataDir, 'adr.json')));
  // 다른 참조가 남는 FAIL 은 정리 뒤 FAIL 0
  const b = readFix('adr.json');
  b.project.verification[0].evidence[0] = { kind: 'test', path: 'test/none.test.mjs', name: '설정 읽기' };
  const ctxb = project({ adr: b });
  assert.deepEqual(await cleanAdr(ctxb, configOf(ctxb)), ['정리: adr.json 참조 FAIL 1건을 gap 으로 바꿈: project.verification[0].evidence[0]']);
  assert.equal(check(ctxb).fails, 0);
  const bad = readFix('adr.json');
  delete bad.project.flow;
  bad.project.verification[1].evidence[0] = { kind: 'file', path: 'src/none.mjs' };
  const ctx2 = project({ adr: bad });
  const src = path.join(ctx2.dataDir, 'adr.json');
  const orig = fs.readFileSync(src);
  const at = new Date(2026, 9, 29, 3, 4, 5).getTime();
  const moved = path.join(ctx2.dataDir, 'adr.json.rejected-20261029-030405');
  assert.deepEqual(await cleanAdr(ctx2, configOf(ctx2), at), [`정리: adr.json 을 ${moved} 로 옮김(스키마 FAIL 1건이 남아 자료 없음으로 둠)`]);
  assert.equal(fs.existsSync(src), false, '탭은 자료 없음');
  assert.deepEqual(fs.readFileSync(moved), orig, '옮긴 파일 바이트가 원본과 같음');
  // 같은 시각에 다시 옮기면 있는 파일을 덮지 않고 -2
  fs.writeFileSync(src, '{"project": 1}');
  assert.deepEqual(await cleanAdr(ctx2, configOf(ctx2), at), [`정리: adr.json 을 ${moved}-2 로 옮김(스키마 FAIL 2건이 남아 자료 없음으로 둠)`]);
  assert.deepEqual(fs.readFileSync(moved), orig, '먼저 옮긴 파일 그대로');
  assert.equal(fs.readFileSync(`${moved}-2`, 'utf8'), '{"project": 1}');
  const ctx3 = project({ adr: b });
  const r = cli(['check', '--adr-cleanup'], ctx3.project);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /^정리: adr\.json 참조 FAIL 1건을 gap 으로 바꿈: project\.verification\[0\]\.evidence\[0\]\n/);
  assert.match(r.out, /\ncheck: FAIL 0, WARN 2\nadr 근거 없음 2칸, 미검증 0, 구현 못 함 1, 참조 없는 서술 0\n$/);
});

test('밀도: init 기록이 있으면 빈 항목과 프로젝트, 결정별 하한 미달이 WARN density adr, 요약 끝 5줄. 채우면 density adr ok', T, () => {
  const ctx = project({ initd: true });
  const { lines } = check(ctx);
  assert.ok(lines.includes('WARN density adr 빈 항목 8/9: decisions[1].scaling'), lines.join('\n'));
  assert.deepEqual(lines.slice(-6), ['density history low', 'density req low', 'density workflow low', 'density arch low', 'density adr low', 'adr 근거 없음 1칸, 미검증 0, 구현 못 함 1, 참조 없는 서술 0']);
  assert.match(lines[lines.length - 7], /^check: FAIL 0, WARN \d+$/);
  const a = readFix('adr.json');
  a.decisions[1].scaling = { argument: '바인드 주소는 설정 하나라 규모와 무관', refs: [{ kind: 'file', path: 'src/app.mjs' }] };
  fs.writeFileSync(path.join(ctx.dataDir, 'adr.json'), JSON.stringify(a));
  const ok = check(ctx).lines;
  assert.equal(ok.filter((l) => l.startsWith('WARN density adr ')).length, 0, ok.join('\n'));
  assert.deepEqual(ok.slice(-2), ['density adr ok', 'adr 근거 없음 0칸, 미검증 0, 구현 못 함 1, 참조 없는 서술 0']);
  const none = project({ adr: null, initd: true });
  const l2 = check(none).lines;
  for (const w of ['WARN density adr 빈 항목 0/3: project.verification, project.flow, project.proof', 'WARN density adr 검증 0/1', 'WARN density adr 흐름 0/3: 입력, 처리, 출력', 'WARN density adr 증거 0/1', 'WARN density adr 결정 0/1']) assert.ok(l2.includes(w), `${w}\n${l2.join('\n')}`);
});

test('밀도 함수: 검증 0, 흐름 빈 칸, 결정 0, 포기와 얻은 것 비움, 참조 줄 없음', T, () => {
  const a = readFix('adr.json');
  a.project.flow.input = '';
  a.project.proof.implemented[0].proofs = [{ gap: '아직 없음' }];
  a.decisions[0].tradeoffs.gained = [];
  const row = (rows, item) => rows.find((x) => x.item === item);
  const rows = adrRows(a);
  assert.deepEqual(row(rows, '흐름'), { tab: 'adr', item: '흐름', value: 2, min: 3, miss: ['입력'] });
  assert.equal(row(rows, '참조'), undefined, '증거 없는 주장은 밀도가 아니라 FAIL');
  assert.deepEqual(row(rows, '포기얻음').miss, ['ADR-1']);
  a.project.verification = [];
  a.decisions = [];
  const r2 = adrRows(a);
  assert.deepEqual([row(r2, '검증').value, row(r2, '결정').value], [0, 0]);
});

test('두 원본 갈라짐: docs/adr 의 파일 2개 가운데 sources 가 가리키지 않는 1개만 WARN, docs/adr 가 없으면 줄 없음', T, () => {
  const ctx = project();
  fs.writeFileSync(path.join(ctx.project, 'docs', 'adr', '0002-other.md'), '# 다른 결정\n');
  fs.writeFileSync(path.join(ctx.project, 'docs', 'adr', '.gitkeep'), '');
  const lines = adrLines(check(ctx).lines);
  assert.deepEqual(lines.filter((l) => l.includes('sources:')), ['WARN adr.json sources: docs/adr/0002-other.md 를 가리키는 결정 없음']);
  const a = readFix('adr.json');
  delete a.decisions[0].sources;
  const ctx2 = project({ adr: a });
  fs.rmSync(path.join(ctx2.project, 'docs', 'adr'), { recursive: true });
  assert.deepEqual(check(ctx2).lines, [COMMIT_WARN, ...FIX_TAIL]);
});

test('렌더: 프로젝트 요약의 검증, 흐름, 증거와 결정 상세의 최적화 로직, 확장 대응, 포기와 얻은 것, 근거 없음, 참조 글, 참조한 모듈', T, () => {
  const ctx = project();
  const h = renderTab(ctx, configOf(ctx), 'adr', NOW);
  for (const s of ['검증', '흐름', '증거', '최적화 로직', '확장 대응', '포기와 얻은 것']) assert.ok(h.includes(`<h3>${s}</h3>`), s);
  assert.equal((h.match(/<h3>최적화 로직<\/h3>/g) || []).length, 2, '결정마다');
  assert.ok(h.includes('<span class="b miss">근거 없음: 규모 확장 근거를 아직 재지 않음</span>'));
  assert.ok(h.includes('파일 <code>src/app.mjs:3</code> <small>render 함수</small>'));
  assert.ok(h.includes('시험 <code>test/app.test.mjs</code> 의 설정 읽기'));
  assert.ok(h.includes('커밋 <code>1a2b3c4</code>'));
  assert.ok(h.includes('명령 <code>node --test test/</code>, 출력 <code>docs/evidence/test-run.md</code>'));
  assert.ok(h.includes('참조한 모듈: M-1') && h.includes('참조한 모듈: M-2'));
  assert.ok(h.includes('<td class="d">3/3</td>') && h.includes('<td class="d">2/3</td>'), '결정별 3항목 채움 수');
  assert.ok(h.includes('<span class="b miss">확장 대응</span>'), '빈 항목 표시');
  assert.ok(h.includes('<a href="/?tab=adr" class="on">ADR</a>'));
  assert.ok(!h.includes('http-equiv="refresh"'), 'ADR 은 자동 갱신 없음');
  assert.ok(h.includes('<title>example-app ADR</title>'));
  assert.equal(refText({ kind: 'cmd', cmd: 'x' }), '명령 <code>x</code>, 출력 없음');
});

test('렌더 escape: 결정과 모듈과 참조의 <script>, ", & 는 escape 된 채 보임', T, () => {
  const a = readFix('adr.json');
  a.decisions[0].title = EVIL;
  a.decisions[0].context = EVIL;
  a.project.verification[0].module = EVIL;
  a.project.verification[1].evidence[0] = { kind: 'file', path: EVIL, note: EVIL };
  a.decisions[1].scaling = { gap: EVIL };
  const ctx = project({ adr: a, files: false });
  const h = renderTab(ctx, configOf(ctx), 'adr', NOW);
  assert.ok(!h.includes('<script>'), 'script 태그 없음');
  assert.ok(h.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;'));
  assert.ok(h.includes(`근거 없음: &lt;script&gt;`));
});

test('자료 없음과 깨진 JSON: 다른 탭처럼 자료 없음 안내와 references/adr.md', T, () => {
  for (const adr of [null, '{']) {
    const ctx = project({ adr, files: false });
    const h = renderTab(ctx, configOf(ctx), 'adr', NOW);
    assert.ok(h.includes('<div class="meta empty">자료 없음. 만드는 법: <code>references/adr.md</code></div>'), String(adr));
  }
});

test('export: tab-adr 절과 #adr 전환, 외부 자원 0', T, async () => {
  const ctx = project();
  const out = path.join(ROOT, `adr-${++n}.html`);
  assert.equal(await renderCommand('export', ctx, { _: ['export', out], now: '2026-10-29T03:00:00Z' }, { out() {}, err() {} }), 0);
  const html = fs.readFileSync(out, 'utf8');
  assert.ok(html.includes('<section id="tab-adr" class="tab"><h2 class="tt">ADR</h2>'));
  assert.ok(html.includes('<a href="#adr" data-tab="adr">ADR</a>'));
  assert.ok(html.includes('"adr"]'), '전환 스크립트의 탭 목록');
  assert.ok(!/(?:src|href)\s*=\s*["']?(?:https?:)?\/\//i.test(html));
});

// Playwright: 테스트박스 도구 폴더(BUILD_TESTBOX_PLAYWRIGHT_DIR, node_modules 를 담은 폴더. build-testbox 시험과 같은 관례)가
// 먼저, 없으면 이 PC 의 전역 npm root. 둘 다 없으면 { skip: 사유 }.
function playwrightModules() {
  const given = process.env.BUILD_TESTBOX_PLAYWRIGHT_DIR;
  if (given) return { dir: path.join(given, 'node_modules'), from: 'BUILD_TESTBOX_PLAYWRIGHT_DIR' };
  const win = process.platform === 'win32';
  const r = spawnSync(win ? 'npm.cmd' : 'npm', ['root', '-g'], { encoding: 'utf8', shell: win, timeout: 30000 });
  return { dir: r.status === 0 ? r.stdout.trim() : '', from: 'npm root -g', status: r.status };
}

async function chromium() {
  const { dir, from, status } = playwrightModules();
  if (!dir || !fs.existsSync(path.join(dir, 'playwright'))) return { skip: `Playwright 없음(${from}: ${dir || status})` };
  try {
    const mod = await import(pathToFileURL(createRequire(path.join(dir, 'noop.js')).resolve('playwright')).href);
    const browser = await (mod.chromium || mod.default.chromium).launch();
    return { browser };
  } catch (e) {
    return { skip: `Chromium 을 띄우지 못함: ${String(e.message).split('\n')[0]}` };
  }
}

test('화면 e2e: export 한 HTML 을 Chromium 으로 열어 #adr 전환 뒤 ADR 절과 6항목 절 제목이 보임', { timeout: 120000 }, async (t) => {
  const got = await chromium();
  if (got.skip) return t.skip(got.skip);
  const ctx = project();
  const out = path.join(ROOT, `e2e-${++n}.html`);
  await renderCommand('export', ctx, { _: ['export', out], now: '2026-10-29T03:00:00Z' }, { out() {}, err() {} });
  try {
    const page = await got.browser.newPage();
    await page.goto(`${pathToFileURL(out).href}#adr`);
    assert.equal(await page.isVisible('#tab-adr'), true, 'ADR 절이 보임');
    assert.equal(await page.isVisible('#tab-history'), false, '다른 탭은 숨김');
    assert.equal(await page.getAttribute('.tabs a[data-tab="adr"]', 'class'), 'on');
    const heads = await page.$$eval('#tab-adr h3', (hs) => hs.filter((h) => h.offsetParent !== null).map((h) => h.textContent));
    for (const s of ['검증', '흐름', '증거', '최적화 로직', '확장 대응', '포기와 얻은 것']) assert.ok(heads.includes(s), `${s}: ${heads.join(', ')}`);
    const shot = await page.screenshot({ fullPage: true });
    assert.deepEqual([...shot.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'PNG 스크린숏');
    if (process.env.PM_ADR_SHOT) fs.writeFileSync(process.env.PM_ADR_SHOT, shot);
  } finally {
    await got.browser.close();
  }
});

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => ([3456, 3458, 30000].includes(p) ? resolve(freePort()) : resolve(p)));
    });
  });
}
const get = (port, p) =>
  new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers: { host: `127.0.0.1:${port}` } }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });

test('서버 통합: /?tab=adr 는 200 과 ADR 화면, adr.json 은 어떤 경로로도 내보내지 않음', T, async () => {
  const ctx = project();
  const port = await freePort();
  const lines = [];
  const srv = await serve(ctx, configOf(ctx), { port }, { out: (l) => lines.push(l), err: (l) => lines.push(l) });
  try {
    const ok = await get(port, '/?tab=adr');
    assert.equal(ok.status, 200);
    assert.ok(ok.body.includes('<h3>최적화 로직</h3>') && ok.body.includes('<a href="/?tab=adr" class="on">ADR</a>'));
    for (const p of ['/adr.json', '/.omc/progress-mon/adr.json', '/../adr.json', '/?tab=../adr.json', '/index.html/adr.json']) {
      const r = await get(port, p);
      assert.ok(!r.body.includes('"decisions"'), `${p} 가 adr.json 을 내보냄`);
      if (!p.startsWith('/?')) assert.equal(r.status, 404, p);
    }
  } finally {
    await srv.close();
  }
});

// 옛 판으로 init 한 자료 폴더: 고정 자료 탭 파일, 옛 state.json(auto-memory), 옛 규칙 줄이 든 자동 메모리.
function legacy() {
  const ctx = project({ adr: null });
  const mem = path.join(ROOT, `mem${++n}`);
  fs.mkdirSync(mem);
  const rules = readFix('variants', 'legacy-init', 'rules.json');
  fs.writeFileSync(path.join(mem, 'progress-mon.md'), `---\nname: progress-mon\ndescription: 옛 규칙\nmetadata:\n  type: feedback\n---\n\n${rules.claude}\n`);
  fs.writeFileSync(path.join(mem, 'MEMORY.md'), `# 색인\n${rules.index}\n- [다른 메모](other.md)\n`);
  const st = fs.readFileSync(path.join(FIX, 'variants', 'legacy-init', 'state.json'), 'utf8').replace('<memory-dir>', JSON.stringify(mem).slice(1, -1));
  fs.writeFileSync(path.join(ctx.dataDir, 'state.json'), st);
  return { ctx, mem };
}

test('기존 프로젝트 ADR 단계: status 가 ADR 없음, state.json 의 memory 로 init 다시 실행(auto-memory 는 --memory-dir), adr.json 을 넣은 check 가 FAIL 0', T, () => {
  const { ctx, mem } = legacy();
  const s = cli(['status'], ctx.project);
  assert.equal(s.code, 3);
  assert.match(s.out, /^탭 자료: 진척도 있음, 구현요건 있음, workflow 있음, 구성도 있음, ADR 없음$/m);
  const before = Object.fromEntries(['config.json', 'items.json', 'req-spec.json'].map((f) => [f, fs.readFileSync(path.join(ctx.dataDir, f))]));
  const memory = JSON.parse(fs.readFileSync(path.join(ctx.dataDir, 'state.json'), 'utf8')).memory;
  assert.equal(memory.kind, 'auto-memory');
  const r = cli(['init', '--memory', memory.kind, '--memory-dir', path.dirname(memory.path)], ctx.project);
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.includes(`규칙 줄 교체(백업 ${path.join(mem, 'progress-mon.md.progress-mon.bak')}): 자동 메모리 progress-mon.md`), r.out);
  assert.ok(r.out.includes(`규칙 줄 교체(백업 ${path.join(mem, 'MEMORY.md.progress-mon.bak')}): 자동 메모리 MEMORY.md`), r.out);
  assert.match(fs.readFileSync(path.join(mem, 'progress-mon.md'), 'utf8'), /adr\.json\(ADR 탭\)을 고치고 check/);
  for (const [f, b] of Object.entries(before)) assert.deepEqual(fs.readFileSync(path.join(ctx.dataDir, f)), b, `${f} 그대로`);
  fs.copyFileSync(path.join(FIX, 'adr.json'), path.join(ctx.dataDir, 'adr.json'));
  const c = cli(['check'], ctx.project);
  assert.match(c.out, /^check: FAIL 0, WARN \d+$/m, c.out);
  assert.equal(c.code, 0);
  assert.match(cli(['status'], ctx.project).out, /, ADR 있음$/m);
});
