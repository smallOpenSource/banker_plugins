// WBS 탭 시험. 임시 프로젝트에 고정 자료(assets/fixture)를 넣고 status 의 탭 자료 줄, export, check 종료 코드,
// ADR 탭을 더한 판으로 init 한 프로젝트의 WBS 단계(규칙 줄 교체)를 CLI 로 본다. 렌더와 check 줄은 pm-render, pm-check 시험.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { INDEX_LINE, currentLine, ruleLine } from './pm-memory.mjs';
import { wbsBody } from './pm-wbs-view.mjs';

const T = { timeout: 60000 };
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'progress-mon.mjs');
const FIX = path.resolve(HERE, '..', 'assets', 'fixture');
const ROOT = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'progress-mon-wbs-test-')));
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
  });
})();
const FILES = ['config.json', 'items.json', 'req-spec.json', 'reqs.json', 'flow.json', 'arch.json', 'adr.json', 'wbs.json'];
// ADR 탭을 더한 판(main 3e1826f) init 이 쓴 규칙 줄과 색인 줄.
const OLD = JSON.parse(fs.readFileSync(path.join(FIX, 'variants', 'legacy-adr', 'rules.json'), 'utf8'));
const cli = (args, cwd) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env: ENV, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

let n = 0;
// 고정 자료를 복사한 자료 폴더(.omc/progress-mon). over: {파일: 값 | null(지움)}.
function project(over = {}) {
  const dir = path.join(ROOT, `p${++n}`);
  const data = path.join(dir, '.omc', 'progress-mon');
  fs.mkdirSync(data, { recursive: true });
  for (const f of FILES) fs.copyFileSync(path.join(FIX, f), path.join(data, f));
  for (const [f, v] of Object.entries(over)) {
    if (v === null) fs.rmSync(path.join(data, f), { force: true });
    else fs.writeFileSync(path.join(data, f), typeof v === 'string' ? v : JSON.stringify(v));
  }
  return { dir, data };
}

test('status: 탭 자료 줄 끝에 WBS 있음, 없음, 깨짐', T, () => {
  const p = project();
  assert.match(cli(['status'], p.dir).out, /^탭 자료: 진척도 있음, 구현요건 있음, workflow 있음, 구성도 있음, ADR 있음, WBS 있음$/m);
  fs.writeFileSync(path.join(p.data, 'wbs.json'), '{bad');
  assert.match(cli(['status'], p.dir).out, /, ADR 있음, WBS 깨짐$/m);
  fs.rmSync(path.join(p.data, 'wbs.json'));
  assert.match(cli(['status'], p.dir).out, /, ADR 있음, WBS 없음$/m);
});

test('export: ADR 뒤 WBS 절과 #wbs 전환, 격자와 .wbsg CSS, 외부 자원 0. 시간 단위 변형은 시간 열', T, () => {
  const p = project();
  const out = path.join(ROOT, `snap-${++n}.html`);
  const r = cli(['export', out, '--now', '2026-10-29T03:00:00Z'], p.dir);
  assert.equal(r.code, 0, r.err);
  const html = fs.readFileSync(out, 'utf8');
  const adr = html.indexOf('<section id="tab-adr" class="tab">');
  const wbs = html.indexOf('<section id="tab-wbs" class="tab"><h2 class="tt">WBS</h2>');
  assert.ok(adr > 0 && wbs > adr, 'WBS 절은 ADR 절 뒤');
  assert.ok(html.includes('<a href="#adr" data-tab="adr">ADR</a><a href="#wbs" data-tab="wbs">WBS</a></div>'));
  assert.ok(html.includes('var ks=["history","req","workflow","arch","adr","wbs"]'));
  assert.ok(html.slice(wbs).includes('<div class="wbsg"><div class="wrap"><table'));
  assert.ok(html.slice(wbs).includes('<th class="w" colspan="5">W1</th>'));
  assert.ok(!/(?:src|href)\s*=\s*["']?(?:https?:)?\/\//i.test(html));
  // 스크립트가 꺼져 있으면 모든 절이 보임: 숨김 규칙은 .js 아래뿐
  assert.ok(html.includes('<style>.js .tab{display:none}.js .tab.cur{display:block}'));
  const h = project({ 'wbs.json': fs.readFileSync(path.join(FIX, 'variants', 'wbs-hour', 'wbs.json'), 'utf8') });
  const out2 = path.join(ROOT, `snap-${++n}.html`);
  assert.equal(cli(['export', out2], h.dir).code, 0);
  const hh = fs.readFileSync(out2, 'utf8');
  assert.ok(hh.includes('<th class="w" colspan="15">11/25(수)</th>') && hh.includes('<th>11:00</th>') && hh.includes('>시간</th>'));
});

test('check: 깨진 wbs.json 은 FAIL 과 종료 1, 시간 단위의 공휴일은 WARN 만(종료 0)', T, () => {
  const plan = JSON.parse(fs.readFileSync(path.join(FIX, 'wbs.json'), 'utf8'));
  plan.rows[1].start = '10/24';
  // adr.json 의 참조는 임시 프로젝트에 없는 파일이라 이 시험에서는 뺀다(pm-adr 시험이 맡음)
  const bad = cli(['check'], project({ 'wbs.json': plan, 'adr.json': null }).dir);
  assert.equal(bad.code, 1);
  assert.match(bad.out, /^FAIL wbs\.json rows\[1\] 1\.1 시작: 주말이나 공휴일 \(2026-10-24 토\)\. 실제 날짜면 걸친 영업일로 적고 실제 날짜는 notes 의 \[가정·변경\] 에\(references\/wbs\.md 의 "주말과 공휴일"\)\. wbs\.json 을 지우지 않음$/m);
  const hour = JSON.parse(fs.readFileSync(path.join(FIX, 'variants', 'wbs-hour', 'wbs.json'), 'utf8'));
  hour.holidays = '11/25';
  const warn = cli(['check'], project({ 'wbs.json': hour, 'adr.json': null }).dir);
  assert.equal(warn.code, 0, warn.out);
  assert.match(warn.out, /^WARN wbs\.json \$ 시간 단위\(기간 2일 이내\)는 모든 시간을 보여 공휴일을 쓰지 않음: 2026-11-25$/m);
  assert.match(warn.out, /^check: FAIL 0, WARN \d+$/m);
});

test('WBS 탭 렌더: 고정 자료와 시간 단위 변형이 같은 wbsBody 로', T, () => {
  const read = (...p) => JSON.parse(fs.readFileSync(path.join(FIX, ...p), 'utf8'));
  const none = () => 'EMPTY';
  assert.equal(wbsBody({}, none), 'EMPTY', 'wbs 자료가 없으면 안내');
  const day = wbsBody({ wbs: { value: read('wbs.json') } }, none);
  const hour = wbsBody({ wbs: { value: read('variants', 'wbs-hour', 'wbs.json') } }, none);
  assert.match(day, /영업일 단위: 영업일 15칸, 주 3/);
  assert.match(hour, /시간 단위\(기간 2일 이내\): 모든 시간 33칸/);
  assert.equal((hour.match(/<th(?: class="gate")?>\d{2}:00<\/th>/g) || []).length, 33, '모든 시간 열');
});

test('규칙 줄: WBS 안내(일정, 단계와 스토리의 시작과 끝, wbs.json 고치고 check), ADR 판 줄은 지금 판으로 교체 대상', T, () => {
  for (const r of [ruleLine('claude'), ruleLine('codex')]) {
    assert.match(r, /adr\.json\(ADR 탭\)을 고치고 check\. 일정이 바뀌거나 단계, 스토리가 시작하거나 끝나면 \.om[cx]\/progress-mon\/wbs\.json\(WBS 탭\)을 고치고 check\./);
  }
  assert.match(INDEX_LINE, /adr\.json, wbs\.json 으로 progress-mon 갱신/);
  assert.equal(currentLine(OLD.claude), ruleLine('claude'));
  assert.equal(currentLine(OLD.codex), ruleLine('codex'));
  assert.equal(currentLine(OLD.index), INDEX_LINE);
  assert.notEqual(OLD.claude, ruleLine('claude'), 'ADR 판 줄은 옛 판');
});

test('기존 프로젝트의 WBS 단계: ADR 판 규칙 줄(CLAUDE.md, 자동 메모리, AGENTS.md)을 init 다시 실행이 제자리 교체하고 백업, 자료 파일 그대로', T, () => {
  // CLAUDE.md
  const a = project({ 'wbs.json': null });
  assert.match(cli(['status'], a.dir).out, /, ADR 있음, WBS 없음$/m);
  fs.writeFileSync(path.join(a.data, 'state.json'), JSON.stringify({ runtime: 'claude', memory: { kind: 'claude-md', path: path.join(a.dir, 'CLAUDE.md') } }));
  const claude = path.join(a.dir, 'CLAUDE.md');
  const orig = `# 내 규칙\r\n${OLD.claude}\r\n- 끝\r\n`;
  fs.writeFileSync(claude, orig);
  const keep = ['config.json', 'items.json', 'adr.json'].map((f) => fs.readFileSync(path.join(a.data, f)));
  const r = cli(['init', '--memory', 'claude-md'], a.dir);
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.includes(`규칙 줄 교체(백업 ${claude}.progress-mon.bak): CLAUDE.md`), r.out);
  assert.equal(fs.readFileSync(claude, 'utf8'), `# 내 규칙\r\n${ruleLine('claude')}\r\n- 끝\r\n`);
  assert.equal(fs.readFileSync(`${claude}.progress-mon.bak`, 'utf8'), orig);
  assert.deepEqual(['config.json', 'items.json', 'adr.json'].map((f) => fs.readFileSync(path.join(a.data, f))), keep);
  assert.ok(!fs.existsSync(path.join(a.data, 'wbs.json')), 'init 은 wbs.json 을 쓰지 않음(에이전트가 씀)');
  assert.ok(cli(['init', '--memory', 'claude-md'], a.dir).out.includes('규칙 이미 있음: CLAUDE.md'));
  // 자동 메모리
  const mem = path.join(ROOT, `mem${++n}`);
  fs.mkdirSync(mem);
  fs.writeFileSync(path.join(mem, 'progress-mon.md'), `---\nname: progress-mon\ndescription: 옛 설명\nmetadata:\n  type: feedback\n---\n\n${OLD.claude}\n`);
  fs.writeFileSync(path.join(mem, 'MEMORY.md'), `# 색인\n${OLD.index}\n`);
  const b = project({ 'wbs.json': null });
  const rb = cli(['init', '--memory', 'auto-memory', '--memory-dir', mem], b.dir);
  assert.equal(rb.code, 0, rb.err);
  assert.ok(rb.out.includes('): 자동 메모리 progress-mon.md') && rb.out.includes('): 자동 메모리 MEMORY.md'), rb.out);
  assert.match(fs.readFileSync(path.join(mem, 'progress-mon.md'), 'utf8'), /wbs\.json\(WBS 탭\)을 고치고 check/);
  assert.equal(fs.readFileSync(path.join(mem, 'MEMORY.md'), 'utf8'), `# 색인\n${INDEX_LINE}\n`);
  // Codex AGENTS.md 3줄 블록
  const c = project({ 'wbs.json': null });
  const agents = path.join(c.dir, 'AGENTS.md');
  fs.writeFileSync(agents, `# 지시\n<!-- USER:OMX:POLICY:START -->\n${OLD.codex}\n<!-- USER:OMX:POLICY:END -->\n`);
  fs.renameSync(path.join(c.dir, '.omc'), path.join(c.dir, '.omx'));
  const rc = cli(['init', '--runtime', 'codex', '--memory', 'agents-md'], c.dir);
  assert.equal(rc.code, 0, rc.err);
  assert.equal(fs.readFileSync(agents, 'utf8'), `# 지시\n<!-- USER:OMX:POLICY:START -->\n${ruleLine('codex')}\n<!-- USER:OMX:POLICY:END -->\n`);
});

test('config.json 의 wbsAsk false: status 가 WBS 없음(묻지 않음), wbs.json 이 있으면 그대로 있음, 틀린 값은 check FAIL', T, () => {
  const p = project({ 'wbs.json': null });
  const cfg = JSON.parse(fs.readFileSync(path.join(p.data, 'config.json'), 'utf8'));
  fs.writeFileSync(path.join(p.data, 'config.json'), JSON.stringify({ ...cfg, wbsAsk: false }));
  assert.match(cli(['status'], p.dir).out, /, ADR 있음, WBS 없음\(묻지 않음\)$/m);
  fs.copyFileSync(path.join(FIX, 'wbs.json'), path.join(p.data, 'wbs.json'));
  assert.match(cli(['status'], p.dir).out, /, ADR 있음, WBS 있음$/m, '자료가 생기면 그 설정과 무관');
  fs.rmSync(path.join(p.data, 'wbs.json'));
  fs.writeFileSync(path.join(p.data, 'config.json'), JSON.stringify({ ...cfg, wbsAsk: true }));
  assert.match(cli(['status'], p.dir).out, /, ADR 있음, WBS 없음$/m, 'true 나 없음은 물음');
  fs.writeFileSync(path.join(p.data, 'config.json'), JSON.stringify({ ...cfg, wbsAsk: 'no' }));
  fs.rmSync(path.join(p.data, 'adr.json'));
  const c = cli(['check'], p.dir);
  assert.match(c.out, /^FAIL config\.json wbsAsk 참 또는 거짓$/m, c.out);
});

test('status: BOM 이 붙은 wbs.json 은 check, 화면과 같이 있음(깨짐 아님)', T, () => {
  const p = project({ 'wbs.json': `\uFEFF${fs.readFileSync(path.join(FIX, 'wbs.json'), 'utf8')}` });
  assert.match(cli(['status'], p.dir).out, /, ADR 있음, WBS 있음$/m);
});
