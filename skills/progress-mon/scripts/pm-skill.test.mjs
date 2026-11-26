// SKILL.md 시험(계획 9.1 SKILL.md 행, AC-2, AC-3, AC-17, AC-18). 문서가 스크립트의 실제 동작과 맞는지 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HELP } from './progress-mon.mjs';

const T = { timeout: 60000 };
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.dirname(HERE);
const SKILL = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8');
const MARKER = 'progress-mon skill body marker v1';
const REFS = ['config.md', 'items.md', 'req-spec.md', 'reqs.md', 'flow.md', 'arch.md', 'authoring.md', 'inventory.md', 'adr.md', 'wbs.md'];

// frontmatter: 첫 줄 --- 부터 다음 --- 까지. 돌려줌: { keys: {이름: 값}, body }
function frontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(m, 'frontmatter 없음');
  const keys = {};
  for (const line of m[1].split('\n')) {
    const k = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (k) keys[k[1]] = k[2].replace(/^"(.*)"$/, '$1');
  }
  return { keys, body: text.slice(m[0].length) };
}

// 절 하나의 본문(## 머리부터 다음 ## 전까지).
function section(title) {
  const start = SKILL.indexOf(`\n## ${title}\n`);
  assert.ok(start >= 0, `절 없음: ${title}`);
  const next = SKILL.indexOf('\n## ', start + 4);
  return SKILL.slice(start, next < 0 ? undefined : next);
}

test('SKILL.md: 인코딩 UTF-8, BOM 없음, LF', T, () => {
  const buf = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'));
  assert.notEqual(buf[0], 0xef, 'BOM');
  assert.ok(!buf.includes(0x0d), 'CR');
  assert.doesNotThrow(() => new TextDecoder('utf-8', { fatal: true }).decode(buf));
});

test('SKILL.md: frontmatter 키는 name, description 둘. name 은 폴더 이름이고 표준 규칙', T, () => {
  const { keys } = frontmatter(SKILL);
  assert.deepEqual(Object.keys(keys).sort(), ['description', 'name']);
  assert.equal(keys.name, 'progress-mon');
  assert.equal(keys.name, path.basename(SKILL_DIR));
  assert.match(keys.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  assert.ok(keys.name.length <= 64);
  assert.ok(keys.description.length > 0 && keys.description.length <= 1024, `description ${keys.description.length}자`);
});

test('SKILL.md: 본문 표식 평문 한 줄, 한 번만, HTML 주석과 코드 블록 밖', T, () => {
  const { body } = frontmatter(SKILL);
  const lines = body.split('\n');
  assert.equal(lines.filter((l) => l.includes(MARKER)).length, 1);
  assert.equal(lines.filter((l) => l.trim() === MARKER).length, 1, '줄 전체가 표식');
  assert.equal(body.replace(/<!--[\s\S]*?-->/g, '').split('\n').filter((l) => l.trim() === MARKER).length, 1, 'HTML 주석 안');
  let fence = false;
  for (const l of lines) {
    if (/^\s*```/.test(l)) fence = !fence;
    if (l.trim() === MARKER) assert.equal(fence, false, '코드 블록 안');
  }
});

test('SKILL.md: --help 의 하위 명령 11개가 모두 하위 명령 표에 있음, serve 는 내부용으로만', T, () => {
  const cmds = [...HELP.matchAll(/^ {2}([a-z]+) /gm)].map((m) => m[1]);
  assert.deepEqual(cmds, ['init', 'start', 'stop', 'status', 'export', 'static', 'item', 'note', 'stage', 'story', 'check']);
  const table = section('하위 명령');
  for (const c of cmds) assert.match(table, new RegExp(`^\\| \`${c}\` \\|`, 'm'), c);
  assert.match(table, /내부용 `serve`/);
});

test('SKILL.md: 인자 없는 호출 3단계(자료 폴더 없으면 init, 서버 없으면 start, URL 보고)', T, () => {
  const s = section('인자 없는 호출');
  assert.match(s, /`status` 를 실행/);
  assert.match(s, /자료 폴더 없음[\s\S]*init 절차/);
  assert.match(s, /`start` 를 실행하고 출력의 URL/);
  assert.match(s, /실행 중: <URL>[\s\S]*URL/);
  // 문서가 인용한 출력 문구는 스크립트가 실제로 내는 문구
  const server = fs.readFileSync(path.join(HERE, 'pm-server.mjs'), 'utf8');
  for (const w of ['꺼짐(자료 폴더 없음: ', '꺼짐(자료 폴더: ', '실행 중: ', '시작함: ', '이미 실행 중(재사용): ']) {
    assert.ok(SKILL.includes(w.trim()), `SKILL.md: ${w}`);
    assert.ok(server.includes(w), `pm-server.mjs: ${w}`);
  }
});

test('SKILL.md: 런타임 표(Claude Code, Codex)와 스킬 디렉터리 표기, Codex 승인 문구', T, () => {
  const s = section('런타임 표');
  assert.match(s, /^\| 항목 \| Claude Code \| Codex \|$/m);
  for (const w of ['Base directory for this skill:', '~/.codex/skills/banker-progress-mon/', './.codex/skills/banker-progress-mon/', '`.omc/progress-mon/`', '`.omx/progress-mon/`', 'sandbox_permissions: "require_escalated"', 'serve --runtime codex']) {
    assert.ok(s.includes(w), w);
  }
  for (const k of ['auto-memory', 'claude-md', 'agents-md']) assert.ok(s.includes(`\`${k}\``), k);
  // 스크립트 호출은 <S> 표기만, 절대 경로 없음(AC-3)
  assert.match(SKILL, /node "<S>\/scripts\/progress-mon\.mjs"/);
  assert.doesNotMatch(SKILL, /(?<![A-Za-z])[A-Za-z]:[\\/]/);
  assert.match(SKILL, /`skillDir`/);
});

test('SKILL.md: 규칙 줄 안내(stage, story, item, Codex --runtime codex)와 로드 한도 경고 전달 단계', T, () => {
  const rule = section('갱신 규칙(init 뒤 세션)');
  for (const w of ['`stage --id', '`story --id', '`item --key', '`note --key', '`--runtime codex`', 'state.json']) assert.ok(rule.includes(w), w);
  const init = section('init 절차');
  assert.match(init, /`경고:` 줄[\s\S]*그대로 전한다/);
  assert.match(init, /`--memory claude-md` 로 다시 등록/);
  assert.match(init, /cleansing-memory/);
  assert.match(init, /`check`[\s\S]*최대 3회/);
  assert.match(init, /자료 없음/);
  assert.match(init, /`--note`[\s\S]*`--issue`/);
});

test('SKILL.md, README.md 가 가리키는 파일이 모두 있음. references 10개', T, () => {
  assert.deepEqual(fs.readdirSync(path.join(SKILL_DIR, 'references')).sort(), [...REFS].sort());
  for (const r of REFS) assert.ok(SKILL.includes(r), `SKILL.md 가 ${r} 를 안내하지 않음`);
  const readme = fs.readFileSync(path.join(SKILL_DIR, 'README.md'), 'utf8');
  for (const [name, text] of [['SKILL.md', SKILL], ['README.md', readme]]) {
    for (const m of text.matchAll(/\b(references\/[\w.-]+\.md|scripts\/(?:pm-|progress-mon|index)[\w.-]*\.m?js|assets\/[\w./-]+\.(?:json|jsonl|md))\b/g)) {
      assert.ok(fs.existsSync(path.join(SKILL_DIR, m[1])), `${name}: ${m[1]}`);
    }
  }
});

test('SKILL.md: init 절차의 ADR 단계와 근거 출처 순서, 정리 단계의 두 처리, 갱신 규칙 표의 ADR 행', T, () => {
  const init = section('init 절차');
  assert.match(init, /^8\. ADR 단계: `<data>\/adr\.json` 을 쓴다\(`references\/adr\.md`\)/m);
  const order = ['`docs/adr/`', '`.omc/plans/*.md`', 'ultra-chain 실행 기록', '`git log`'].map((w) => init.indexOf(w));
  assert.ok(order.every((i) => i > 0) && order.every((i, k) => !k || i > order[k - 1]), `근거 출처 순서 ${order}`);
  assert.match(init, /실제로 돌린 명령의 출력만 참조/);
  assert.match(init, /^12\. 정리 단계/m);
  assert.match(init, /`check --adr-cleanup`[\s\S]*스키마 FAIL 이 남으면 지우지 않고 `adr\.json\.rejected-<YYYYMMDD-HHMMSS>` 로 옮겨[\s\S]*참조 FAIL[\s\S]*\{ "gap": "참조 확인 실패: <이유>" \}/);
  assert.match(init, /^15\. `start` 를 실행하고 URL 을 보고한다$/m);
  const rule = section('갱신 규칙(init 뒤 세션)');
  assert.match(rule, /^ {2}\| 결정이 생기거나 스토리가 끝남 \| `<data>\/adr\.json` 을 고치고/m);
});

test('SKILL.md: 인자 없는 호출 표의 ADR 없음 행, 진행 전 확인(AskUserQuestion, request_user_input, --auto), state.json memory 로 init 다시 실행, Codex 승인', T, () => {
  const s = section('인자 없는 호출');
  assert.match(s, /^ {3}\| 자료 폴더가 있고 `탭 자료:` 줄이 `ADR 없음` \| .*기존 프로젝트의 ADR 단계/m);
  assert.match(s, /`ADR 깨짐` 이면 하지 않고/);
  for (const w of ['AskUserQuestion', 'request_user_input', '`--auto`', '--memory-dir "<path 의 폴더>"`', '`sandbox_permissions: "require_escalated"`', '`규칙 줄 교체(백업 <경로>): <파일>`', '사용자가 손으로 고친 표식 줄도 덮으므로']) assert.ok(s.includes(w), w);
  // 문서가 인용한 출력 문구는 스크립트가 실제로 내는 문구
  assert.ok(fs.readFileSync(path.join(HERE, 'pm-server.mjs'), 'utf8').includes("ADR ${has('adr.json')}"));
  assert.ok(fs.readFileSync(path.join(HERE, 'pm-memory.mjs'), 'utf8').includes('`규칙 줄 교체(백업 ${bak}): ${s.name}`'));
});

test('옛 탭 수 문구(ADR 이전과 WBS 이전)가 대상 파일(SKILL.md, README.md, references, scripts, banker 등록 지점)에 0건, description 에 ADR', T, () => {
  const files = ['SKILL.md', 'README.md', ...REFS.map((r) => `references/${r}`), ...fs.readdirSync(HERE).filter((f) => /\.(mjs|js)$/.test(f)).map((f) => `scripts/${f}`)].map((f) => path.join(SKILL_DIR, f));
  // banker 저장소 안에서 돌 때만 있는 등록 지점(스킬 폴더만 옮긴 원본에는 없음)
  const repo = path.resolve(SKILL_DIR, '..', '..');
  for (const f of ['codex/manifest.json', 'codex/transform-matrix.md', 'README.md']) if (fs.existsSync(path.join(repo, 'codex', 'manifest.json'))) files.push(path.join(repo, f));
  const bad = new RegExp(['4' + '탭', '네 ' + '탭', 'four ' + 'tabs', '5' + '탭', '다섯 ' + '탭', 'five ' + 'tabs'].join('|'));
  const hits = files.filter((f) => bad.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(hits, []);
  assert.match(frontmatter(SKILL).keys.description, /6탭 웹 화면\(진척도, 구현요건, workflow, 구성도, ADR, WBS\)/);
});

test('SKILL.md: init 절차의 WBS 단계(ADR 단계 뒤, 날짜 출처 순서, 지어내지 않음, 공휴일 오프라인), 정리 단계의 wbs.json, 갱신 규칙 표의 WBS 행', T, () => {
  const init = section('init 절차');
  assert.match(init, /^9\. WBS 단계: `<data>\/wbs\.json` 을 쓴다\(`references\/wbs\.md`\)/m);
  assert.ok(init.indexOf('8. ADR 단계') < init.indexOf('9. WBS 단계'));
  const wbs = init.slice(init.indexOf('9. WBS 단계'), init.indexOf('\n10. '));
  const order = ['`stories`', '`.omc/plans/*.md`', '`events.jsonl`', '`git log`'].map((w) => wbs.indexOf(w));
  assert.ok(order.every((i) => i > 0) && order.every((i, k) => !k || i > order[k - 1]), `날짜 출처 순서 ${order}`);
  for (const w of ['날짜를 지어내지 않는다', '`pending`', '`[가정·변경]`', '공휴일은 내려받지 않는다', '`"없음"`', '`공휴일 미확인`', '2일 이내']) assert.ok(wbs.includes(w), w);
  assert.match(init, /^12\. 정리 단계[\s\S]*`arch\.json`, `wbs\.json`\)은 FAIL 이 난 그 파일만 지워/m);
  const rule = section('갱신 규칙(init 뒤 세션)');
  assert.match(rule, /^ {2}\| 일정이 바뀌거나 단계, 스토리가 시작하거나 끝남 \| `<data>\/wbs\.json` 을 고치고/m);
});

test('SKILL.md: 인자 없는 호출 표의 WBS 없음 행과 기존 프로젝트의 WBS 단계(한 번 묻기, --auto, init 다시 실행, 9~12)', T, () => {
  const s = section('인자 없는 호출');
  assert.match(s, /^ {3}\| 자료 폴더가 있고 `탭 자료:` 줄이 `WBS 없음` 으로 끝남 \| .*기존 프로젝트의 WBS 단계.*`WBS 없음\(묻지 않음\)` 이면 하지 않는다/m);
  assert.match(s, /`WBS 깨짐` 이면 하지 않고/);
  assert.match(s, /`WBS 없음\(wbsAsk 값 오류\)` 이면 WBS 단계를 묻지 않고, `config\.json` 의 `wbsAsk` 를 `true` 나 `false`\(따옴표 없는 JSON 참거짓\)로 고치거나 지우라고 보고/);
  const step = s.slice(s.indexOf('### 기존 프로젝트의 WBS 단계'));
  for (const w of ['AskUserQuestion', 'request_user_input', '`--auto`', '`init` 을 다시 실행', '`규칙 줄 교체(백업 <경로>): <파일>`', '9(WBS 단계), 10~12']) assert.ok(step.includes(w), w);
  const server = fs.readFileSync(path.join(HERE, 'pm-server.mjs'), 'utf8');
  assert.ok(server.includes("const wbs = has('wbs.json');") && server.includes('WBS ${wbs}${quiet}') && server.includes("'(묻지 않음)'"));
  const table = section('하위 명령');
  assert.match(table, /`FAIL wbs\.json <json 경로> <이유>`/);
});

test('references/wbs.md: 스키마는 wbs-gen 계획, 시간 단위 규칙, 날짜 출처, 공휴일 오프라인', T, () => {
  const doc = fs.readFileSync(path.join(SKILL_DIR, 'references', 'wbs.md'), 'utf8');
  for (const w of ['wbs-gen', '`plan.json`', '`YYYY-MM-DD HH:MM`', '`M/D HH:MM`', '2일 이내', '48', '`11:00`', '`items.json`', '`events.jsonl`', '`git log`', '`공휴일 미확인`', '`pending`']) assert.ok(doc.includes(w), w);
  assert.ok(!doc.includes('\r'), 'LF');
});

test('SKILL.md, references: 시각은 현지 시간대(Z, 시차 환산 예), 주말과 공휴일은 걸친 영업일과 notes, 지우지 않음, wbsAsk 로 묻지 않음', T, () => {
  const init = section('init 절차');
  const wbs = init.slice(init.indexOf('9. WBS 단계'), init.indexOf('\n10. '));
  for (const w of ['프로젝트 현지 시간대', '`2026-11-25T01:00:00Z` 는 `2026-11-25 10:00`', '떼기만 하지 않는다', '다음 영업일', '앞 영업일', '`[가정·변경]`', '`"wbsAsk": false`']) assert.ok(wbs.includes(w), w);
  assert.match(init, /`wbs\.json` 의 `주말이나 공휴일` FAIL 은 지우지 않는다/);
  assert.match(init, /`WARN density wbs` 줄은 근거가 있는 것만 보충한다[\s\S]*날짜를 만들어 넣지 않는다/);
  const step = section('인자 없는 호출');
  for (const w of ['다시 묻지 않음', '`WBS 없음(묻지 않음)`', '`"wbsAsk": false`', '`wbs.json` 줄만 고친다']) assert.ok(step.includes(w), w);
  const doc = fs.readFileSync(path.join(SKILL_DIR, 'references', 'wbs.md'), 'utf8');
  for (const w of ['## 시간대', '`2026-11-25T01:00:00Z` | KST(+09:00) | `2026-11-25 10:00`', '## 주말과 공휴일', '`[주말·공휴일 작업]`', '세 파일', '`24:00`', '그날 첫 칸']) assert.ok(doc.includes(w), w);
  assert.ok(!doc.includes('두 파일'));
  const cfg = fs.readFileSync(path.join(SKILL_DIR, 'references', 'config.md'), 'utf8');
  assert.match(cfg, /^\| `wbsAsk` \| 참, 거짓 \|/m);
  assert.ok(fs.readFileSync(path.join(HERE, 'pm-config.mjs'), 'utf8').includes("take('wbsAsk',"));
});

test('SKILL.md: 인자 표의 --static 행, 스냅샷 절차(자료 없음은 init --memory later 와 4~14, 있음은 check 와 정리, 서버 그대로, 보고), 규칙 등록 한 번 묻기', T, () => {
  const args = section('인자');
  assert.match(args, /^\| `--static \[<파일>\]` \| .*스냅샷\(`--static`\)/m);
  const s = section('스냅샷(`--static`)');
  for (const w of ['`init --runtime <rt> --memory later', '"init 절차" 의 4~14', '15(`start`)는 하지 않는다', '`check` 를 실행한다', '12 의 정리 단계', '코드를 다시 읽어 자료를 갱신하지 않는다', '`<data>/snapshots/progress-mon-<YYYYMMDD-HHmm>.html`', '`-2`, `-3`', '`스냅샷: <절대 경로>`', '`기준 시각: <시각>`', '브라우저를 대신 열지 않는다', '서버를 띄우지도 끄지도 않는다']) assert.ok(s.includes(w), w);
  assert.match(s, /node "<S>\/scripts\/progress-mon\.mjs" static --runtime <rt> \[<파일>\]/);
  const bare = section('인자 없는 호출');
  assert.match(bare, /^ {3}\| 자료 폴더가 있고 `갱신 규칙: 미등록\(묻기\)` 줄이 있음 \| .*스냅샷으로 만든 자료 폴더의 규칙 등록.*`미등록\(묻지 않음\)` 이면 하지 않는다/m);
  const step = bare.slice(bare.indexOf('### 스냅샷으로 만든 자료 폴더의 규칙 등록'));
  for (const w of ['AskUserQuestion', 'request_user_input', '`--auto`', '`"ruleAsk": false`', '`갱신 규칙: 미등록(묻지 않음)`', '다른 종류(`claude-md`, `agents-md`, `auto-memory`, `none`)로 init 한 자료 폴더는 줄이 없고 묻지 않는다']) assert.ok(step.includes(w), w);
  // 문서가 인용한 출력 문구는 스크립트가 실제로 내는 문구
  const server = fs.readFileSync(path.join(HERE, 'pm-server.mjs'), 'utf8');
  for (const w of ["'미등록(묻기)'", "'미등록(묻지 않음)'", "'미등록(ruleAsk 값 오류)'", 'io.out(`갱신 규칙: ${r}`)']) assert.ok(server.includes(w), w);
  const render = fs.readFileSync(path.join(HERE, 'pm-render.mjs'), 'utf8');
  for (const w of ['io.out(`스냅샷: ${out}`)', 'io.out(`기준 시각: ${nowText(now)}`)', '`progress-mon-${minuteStamp(now)}`', '스냅샷 ${esc(nowText(now))} 기준']) assert.ok(render.includes(w), w);
  assert.ok(fs.readFileSync(path.join(HERE, 'pm-memory.mjs'), 'utf8').includes("'none', 'later']"));
  const cfg = fs.readFileSync(path.join(SKILL_DIR, 'references', 'config.md'), 'utf8');
  assert.match(cfg, /^\| `ruleAsk` \| 참, 거짓 \|/m);
  assert.ok(fs.readFileSync(path.join(HERE, 'pm-config.mjs'), 'utf8').includes("take('ruleAsk',"));
  assert.match(frontmatter(SKILL).keys.description, /`--static \[<파일>\]`/);
});

test('SKILL.md: <파일> 과 export 는 덮어쓰지 않음(번호, 링크 안 따라감, .html, .htm), 스냅샷 절의 오류 행, 규칙 등록과 ADR, WBS 단계는 한 질문', T, () => {
  const s = section('스냅샷(`--static`)');
  assert.ok(!SKILL.includes('있으면 덮어씀'), '덮어쓰기 문구 없음');
  for (const w of ['`.html` 이나 `.htm` 으로 끝나야 한다', '덮어쓰지 않고 확장자 앞에 `-2`, `-3`', '링크(끊어진 것 포함)는 따라가지 않는다', '`status` 를 실행한다. 서버 상태는 보기만 한다. 종료 1 또는 2 면 오류 줄을 그대로 보고하고 멈춤', '종료 1 또는 2(예: `config.json 형식 오류`, `파일 이름은 .html 이나 .htm 으로 끝나야 함`']) assert.ok(s.includes(w), w);
  const table = section('하위 명령');
  assert.match(table, /^\| `export` \| .*`\.html` 이나 `\.htm` 으로 끝나야 함\(아니면 종료 1\)\. 있는 파일은 덮어쓰지 않고.*예전 판은 덮어썼다/m);
  const step = section('인자 없는 호출');
  assert.ok(step.includes('그 단계의 질문에 규칙 등록을 묶어 한 번에 묻는다. `init` 다시 실행은 한 번만'));
  const render = fs.readFileSync(path.join(HERE, 'pm-render.mjs'), 'utf8');
  for (const w of ['파일 이름은 .html 이나 .htm 으로 끝나야 함: ', 'snapshots 자리에 폴더가 아닌 것(링크 포함)이 있어 거부', 'export const NUMBER_MAX = 999;', 'snapshots 의 실제 경로가 자료 폴더 밖이라 거부']) assert.ok(render.includes(w), w);
  assert.ok(s.includes('그 사이 폴더나 위 폴더가 링크로 바뀌면 내용을 쓰지 않고 종료 1(`폴더가 바뀌어 쓰지 않음`)'));
  assert.ok(s.includes('Windows 네트워크 경로(SMB 공유, 매핑 드라이브)는 폴더 고정을 확인할 수 없어 쓴 직후 대조로 대신한다'));
  assert.ok(fs.readFileSync(path.join(HERE, 'pm-config.mjs'), 'utf8').includes("const isNetwork = (real) => real.startsWith('\\\\\\\\');"));
  assert.ok(fs.readFileSync(path.join(HERE, 'pm-config.mjs'), 'utf8').includes('`폴더가 바뀌어 쓰지 않음(링크 바꿔치기로 보임): '));
});

// 실제 codex exec 실측(2026-11-26): init 이 승인 없이 돌아 git 제외 줄이 빠졌고, 작업 폴더가 하위 폴더면 자료 폴더 쓰기가 EROFS.
test('SKILL.md: Codex 샌드박스 쓰기 범위 규칙(init 은 처음부터 승인, 자료 폴더가 작업 폴더 밖이면 승인, 막힘 안내 줄과 같은 문구, --add-dir 안내 없음)', T, () => {
  const rt = section('런타임 표');
  assert.match(rt, /^\| `init` \| 바로 실행 \| git 제외 목록\(`\.git` 안\) 쓰기 때문에 처음부터 승인 요청\. 승인 없이 돌아 `알림: git 제외 목록에 추가하지 못함\(EROFS\)` 가 나오면 승인 요청으로 같은 `init` 을 한 번 더 실행/m);
  assert.match(rt, /^\| `static` \| 바로 실행 \| 자료 폴더와 `<파일>` 이 작업 폴더 안이면 바로 실행\. 어느 쪽이든 작업 폴더 밖이면/m);
  for (const w of ['작업 폴더가 프로젝트 루트가 아니면 먼저 사용자에게 알리고', '출력에 `알림: 쓰기가 막힘` 이 나오면 같은 명령 하나를 승인 요청으로 다시 실행한다', '`!` 를 붙여 그 명령을 직접 실행']) assert.ok(rt.includes(w), w);
  assert.ok(!/--add-dir` 에 .*(넣는다|넣어|추가한다)/.test(SKILL), '--add-dir 로 넓히는 안내 없음');
  const cli = fs.readFileSync(path.join(HERE, 'progress-mon.mjs'), 'utf8');
  assert.ok(cli.includes("'알림: 쓰기가 막힘. Codex 샌드박스면 같은 명령 하나를 sandbox_permissions: \"require_escalated\" 로 다시 실행"));
  assert.ok(fs.readFileSync(path.join(HERE, 'pm-data.mjs'), 'utf8').includes('샌드박스가 막았으면 승인을 받아 init 을 다시 실행(자료 파일은 그대로 두고 제외 줄만 더함)'));
});
