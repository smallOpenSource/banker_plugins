// pm-sources.mjs 시험. 시각 해석, events 상태 전이, stageEvents 합침, 파일 캐시, git 캐시, 판정 함수 4개,
// 옛 서버 라벨 판정과 대등, journal 경계(24시간, 15분, 세션 상한), workflowDirs, 자료 없음.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  parseTime,
  stageStates,
  readLines,
  readJsonFile,
  gitLog,
  gitHead,
  gitInfo,
  storyOfSubject,
  storyOfStartLabel,
  storyOfBusyLabel,
  hiddenAgent,
  activeAgents,
  storyStarts,
  workflowRoots,
  projectSlug,
  storyList,
  stageList,
  readItems,
  collect,
} from './pm-sources.mjs';
import { defaults, validate, ULTRA_STAGES } from './pm-config.mjs';

const T = { timeout: 60000 };
const ROOT = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'progress-mon-test-')));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
let n = 0;
const tmp = (name = 'd') => {
  const p = path.join(ROOT, `s${++n}`, name);
  fs.mkdirSync(p, { recursive: true });
  return p;
};
const write = (p, s) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, s);
};
const jsonl = (rows) => rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';

// 이 저장소(옛 진척도 서버 자료)의 스토리 id 와 workflow journal 라벨 전부의 사본(읽기만 해서 옮김, 429개).
const PCC_IDS = ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S8', 'S7', 'S9', 'S10', 'S11', 'S11b', 'S12', 'S13', 'S14', 'S15', 'S16'];
const LABELS = [
  "architect-r1", "architect-r2", "architect-r3", "architect-r4", "architect-r5", "backbone#1-r1", "backbone#1-r2", "backbone#1-r3",
  "backbone#1-r4", "backbone#1-r5", "backbone#2-r1", "backbone#2-r2", "backbone#2-r3", "backbone#2-r4", "backbone#2-r5", "backbone#3-r1",
  "backbone#3-r2", "backbone#3-r3", "backbone#3-r4", "backbone#3-r5", "backbone#4-r1", "backbone#4-r2", "backbone#4-r3", "backbone#4-r4",
  "backbone#4-r5", "backbone-si#5-r1", "backbone-si#5-r2", "backbone-si#5-r3", "backbone-si#5-r4", "backbone-si#5-r5", "critic",
  "critic-S0-r1", "critic-S1-r1", "critic-S10-r1", "critic-S11-r1", "critic-S11b-1-r1", "critic-S11b-2-r1", "critic-S11b-2-r2",
  "critic-S11b-3a-r1", "critic-S11b-3b-r1", "critic-S12-r1", "critic-S12-r2", "critic-S12-r3", "critic-S13a-r1", "critic-S13a-r2",
  "critic-S2-r1", "critic-S3-r1", "critic-S4-r1", "critic-S5-r1", "critic-S6-r1", "critic-S7-r1", "critic-S8-r1", "critic-S9-r1",
  "critic-r1", "critic-r2", "critic-r3", "critic-r4", "critic-r5", "critic:completeness", "fetch:agensi.io", "fetch:agentskills.io",
  "fetch:code.claude.com", "fetch:codex.danielvaughan.com", "fetch:commareports.com", "fetch:dev.to", "fetch:developer.mozilla.org",
  "fetch:developers.openai.com", "fetch:germano.dev", "fetch:github.com", "fetch:html.spec.whatwg.org", "fetch:leanmind.es",
  "fetch:learn.chatgpt.com", "fetch:modelcontextprotocol.io", "fetch:npmjs.com", "fetch:osv.dev", "fetch:server-sent-events.com",
  "fetch:simonwillison.net", "fetch:vulnerablemcp.info", "fix-1", "fix-2", "fix-r1", "fix-r2", "fix:r1", "fix:r10", "fix:r2", "fix:r3",
  "fix:r4", "fix:r5", "fix:r6", "fix:r7", "fix:r8", "fix:r9", "impl-S0-r1", "impl-S1-r1", "impl-S10-r1", "impl-S10-r1-retry1",
  "impl-S11-r1", "impl-S11b-1-r1", "impl-S11b-2-r1", "impl-S11b-2-r2", "impl-S11b-3a-r1", "impl-S11b-3b-r1", "impl-S12-r1", "impl-S12-r2",
  "impl-S12-r3", "impl-S13a-r1", "impl-S13a-r2", "impl-S2-r1", "impl-S3-r1", "impl-S4-r1", "impl-S5-r1", "impl-S6-r1", "impl-S7-r1",
  "impl-S8-r1", "impl-S9-r1", "implement", "judge:cli-doctor", "judge:cli-drm-sweep-log", "judge:cli-expired",
  "judge:cli-key-helper-expired", "judge:cli-pcc-help", "judge:cli-stop", "judge:hud-line", "judge:map-1", "judge:map-2", "judge:map3-1",
  "judge:map3-2", "judge:map4-1", "judge:map4-2", "judge:repo-release-map", "map:hist-plan-ids", "map:hist-user-readme",
  "map:reports-cli-home", "map:reports-tests-build", "map:rs-new-risks", "map:user-task", "mock-cli", "mock-cli-retry1", "mock-hud",
  "mock-index", "mock-map", "oracle-stage4", "oracle-stage4-check", "oracle-stage4-retry1", "oracle-stage4-retry2", "planner-fix-r1",
  "planner-fix-r2", "planner-fix-r2-a", "planner-fix-r3-a", "planner-fix-r4-a", "planner-r1", "planner-r2", "planner-r3", "planner-r4",
  "planner-r5", "read:backup", "read:build", "read:build-pipeline", "read:claude", "read:env", "read:home-config", "read:launcher",
  "read:launcher-a", "read:launcher-b", "read:requirements-history", "read:run", "read:unit-tests", "review-adversarial-1",
  "review-adversarial-2", "review-adversarial-r1", "review-adversarial-r2", "review-adversarial-r3", "review-conform-1",
  "review-conform-2", "review-conform-r1", "review-conform-r2", "review-conform-r3", "review:cmd-semantics", "review:cmd-sh",
  "review:contract:r1", "review:contract:r10", "review:contract:r11", "review:contract:r2", "review:contract:r3", "review:contract:r4",
  "review:contract:r5", "review:contract:r6", "review:contract:r7", "review:contract:r8", "review:contract:r9", "review:logic-tests",
  "review:part-2", "review:part-3", "review:part-4", "review:part-5", "review:registry:r1", "review:registry:r10", "review:registry:r11",
  "review:registry:r2", "review:registry:r3", "review:registry:r4", "review:registry:r5", "review:registry:r6", "review:registry:r7",
  "review:registry:r8", "review:registry:r9", "review:safety:r1", "review:safety:r10", "review:safety:r11", "review:safety:r2",
  "review:safety:r3", "review:safety:r4", "review:safety:r5", "review:safety:r6", "review:safety:r7", "review:safety:r8",
  "review:safety:r9", "review:state-and-fail", "review:tests-and-docs", "scope", "search:Claude Code 플러그인 스킬 구조와 경로 규칙",
  "search:Codex 스킬 호환", "search:갱신 방식: 폴링 대 SSE", "search:단일 HTML 오프라인 내보내기와 OS 호환", "search:로컬 HTTP 서버 보안 (DNS rebinding)", "synthesize",
  "v0:\"${CLAUDE_PLUGIN_ROOT} 는 설치된 플러그인 버전의 절대…\"", "v0:\"Agent Skills 표준의 스킬은 최소한 SKILL.md 하나를 담은…\"",
  "v0:\"Bash 도구로 실행하는 명령의 환경에는 플러그인 경로 변수가 없음. 따…\"", "v0:\"Claude Code 플러그인 스킬은 각 스킬을 `skills/` 아래…\"",
  "v0:\"Claude Code 플러그인에서는 매니페스트만 .claude-plugi…\"", "v0:\"Claude Code는 플러그인 스킬을 <plugin>/skills/<s…\"",
  "v0:\"Codex SKILL.md frontmatter 의 필수 필드는 name…\"", "v0:\"Codex 가 스킬을 찾는 위치는 저장소, 사용자, 관리자, 시스템 위치…\"",
  "v0:\"Codex 는 현재 작업 폴더부터 저장소 루트까지 모든 단계의 .agen…\"", "v0:\"Codex 스킬은 SKILL.md 를 담은 폴더. scripts/, re…\"",
  "v0:\"Codex 스킬은 SKILL.md 를 둔 폴더 하나. scripts/,…\"", "v0:\"DNS rebinding 의 주된 방어책은 서버 쪽 Host 헤더 검사.…\"",
  "v0:\"SKILL.md 는 YAML frontmatter 와 마크다운 본문으로…\"", "v0:\"SKILL.md 의 필수 frontmatter 는 name 과 descr…\"",
  "v0:\"Vite 권고문 명시: localhost 에서만 도는 개발 서버도 이 취…\"", "v0:\"Vite 권고문(CVE-2025-24010): 비 HTTPS 로컬 개발…\"",
  "v0:\"`${CLAUDE_PLUGIN_DATA}` 는 업데이트 뒤에도 남는 `~…\"", "v0:\"`${CLAUDE_PLUGIN_ROOT}` 는 스킬, 명령, 에이전트 본…\"",
  "v0:\"loopback 에 바인드한 서비스의 Host 허용 목록에는 localh…\"", "v0:\"로컬 HTTP 서버는 DNS rebinding 공격을 막으려고 들어오는…\"",
  "v0:\"로컬에서 실행하는 서버는 모든 네트워크 인터페이스(0.0.0.0) 대신…\"", "v0:\"스킬 안에서 다른 파일(스크립트 포함)을 가리킬 때는 스킬 루트 기준 상…\"",
  "v0:\"스킬에 함께 실은 스크립트는 ${CLAUDE_SKILL_DIR} 로 참조…\"", "v0:\"이 보호 장치(Origin 검사, localhost 바인드, 인증)가 없…\"",
  "v1:\"${CLAUDE_PLUGIN_ROOT} 는 설치된 플러그인 버전의 절대…\"", "v1:\"Agent Skills 표준의 스킬은 최소한 SKILL.md 하나를 담은…\"",
  "v1:\"Bash 도구로 실행하는 명령의 환경에는 플러그인 경로 변수가 없음. 따…\"", "v1:\"Claude Code 플러그인 스킬은 각 스킬을 `skills/` 아래…\"",
  "v1:\"Claude Code 플러그인에서는 매니페스트만 .claude-plugi…\"", "v1:\"Claude Code는 플러그인 스킬을 <plugin>/skills/<s…\"",
  "v1:\"Codex SKILL.md frontmatter 의 필수 필드는 name…\"", "v1:\"Codex 가 스킬을 찾는 위치는 저장소, 사용자, 관리자, 시스템 위치…\"",
  "v1:\"Codex 는 현재 작업 폴더부터 저장소 루트까지 모든 단계의 .agen…\"", "v1:\"Codex 스킬은 SKILL.md 를 담은 폴더. scripts/, re…\"",
  "v1:\"Codex 스킬은 SKILL.md 를 둔 폴더 하나. scripts/,…\"", "v1:\"DNS rebinding 의 주된 방어책은 서버 쪽 Host 헤더 검사.…\"",
  "v1:\"SKILL.md 는 YAML frontmatter 와 마크다운 본문으로…\"", "v1:\"SKILL.md 의 필수 frontmatter 는 name 과 descr…\"",
  "v1:\"Vite 권고문 명시: localhost 에서만 도는 개발 서버도 이 취…\"", "v1:\"Vite 권고문(CVE-2025-24010): 비 HTTPS 로컬 개발…\"",
  "v1:\"`${CLAUDE_PLUGIN_DATA}` 는 업데이트 뒤에도 남는 `~…\"", "v1:\"`${CLAUDE_PLUGIN_ROOT}` 는 스킬, 명령, 에이전트 본…\"",
  "v1:\"loopback 에 바인드한 서비스의 Host 허용 목록에는 localh…\"", "v1:\"로컬 HTTP 서버는 DNS rebinding 공격을 막으려고 들어오는…\"",
  "v1:\"로컬에서 실행하는 서버는 모든 네트워크 인터페이스(0.0.0.0) 대신…\"", "v1:\"스킬 안에서 다른 파일(스크립트 포함)을 가리킬 때는 스킬 루트 기준 상…\"",
  "v1:\"스킬에 함께 실은 스크립트는 ${CLAUDE_SKILL_DIR} 로 참조…\"", "v1:\"이 보호 장치(Origin 검사, localhost 바인드, 인증)가 없…\"",
  "v2:\"${CLAUDE_PLUGIN_ROOT} 는 설치된 플러그인 버전의 절대…\"", "v2:\"Agent Skills 표준의 스킬은 최소한 SKILL.md 하나를 담은…\"",
  "v2:\"Bash 도구로 실행하는 명령의 환경에는 플러그인 경로 변수가 없음. 따…\"", "v2:\"Claude Code 플러그인 스킬은 각 스킬을 `skills/` 아래…\"",
  "v2:\"Claude Code 플러그인에서는 매니페스트만 .claude-plugi…\"", "v2:\"Claude Code는 플러그인 스킬을 <plugin>/skills/<s…\"",
  "v2:\"Codex SKILL.md frontmatter 의 필수 필드는 name…\"", "v2:\"Codex 가 스킬을 찾는 위치는 저장소, 사용자, 관리자, 시스템 위치…\"",
  "v2:\"Codex 는 현재 작업 폴더부터 저장소 루트까지 모든 단계의 .agen…\"", "v2:\"Codex 스킬은 SKILL.md 를 담은 폴더. scripts/, re…\"",
  "v2:\"Codex 스킬은 SKILL.md 를 둔 폴더 하나. scripts/,…\"", "v2:\"DNS rebinding 의 주된 방어책은 서버 쪽 Host 헤더 검사.…\"",
  "v2:\"SKILL.md 는 YAML frontmatter 와 마크다운 본문으로…\"", "v2:\"SKILL.md 의 필수 frontmatter 는 name 과 descr…\"",
  "v2:\"Vite 권고문 명시: localhost 에서만 도는 개발 서버도 이 취…\"", "v2:\"Vite 권고문(CVE-2025-24010): 비 HTTPS 로컬 개발…\"",
  "v2:\"`${CLAUDE_PLUGIN_DATA}` 는 업데이트 뒤에도 남는 `~…\"", "v2:\"`${CLAUDE_PLUGIN_ROOT}` 는 스킬, 명령, 에이전트 본…\"",
  "v2:\"loopback 에 바인드한 서비스의 Host 허용 목록에는 localh…\"", "v2:\"로컬 HTTP 서버는 DNS rebinding 공격을 막으려고 들어오는…\"",
  "v2:\"로컬에서 실행하는 서버는 모든 네트워크 인터페이스(0.0.0.0) 대신…\"", "v2:\"스킬 안에서 다른 파일(스크립트 포함)을 가리킬 때는 스킬 루트 기준 상…\"",
  "v2:\"스킬에 함께 실은 스크립트는 ${CLAUDE_SKILL_DIR} 로 참조…\"", "v2:\"이 보호 장치(Origin 검사, localhost 바인드, 인증)가 없…\"", "verify3:code", "verify3:docs",
  "verify:CRIT-1", "verify:CRIT-10", "verify:CRIT-11", "verify:CRIT-12", "verify:CRIT-13", "verify:CRIT-14", "verify:CRIT-15",
  "verify:CRIT-16", "verify:CRIT-17", "verify:CRIT-18", "verify:CRIT-19", "verify:CRIT-2", "verify:CRIT-20", "verify:CRIT-21",
  "verify:CRIT-22", "verify:CRIT-23", "verify:CRIT-28", "verify:CRIT-29", "verify:CRIT-3", "verify:CRIT-4", "verify:CRIT-5",
  "verify:CRIT-6", "verify:CRIT-7", "verify:CRIT-8", "verify:CRIT-9", "verify:backup", "verify:build", "verify:claude",
  "verify:cmd-semantics-0", "verify:cmd-semantics-1", "verify:cmd-semantics-2", "verify:cmd-semantics-3", "verify:cmd-sh-0",
  "verify:cmd-sh-1", "verify:cmd-sh-2", "verify:env", "verify:hist-plan-ids", "verify:hist-user-readme", "verify:launcher",
  "verify:logic-tests-0", "verify:logic-tests-1", "verify:logic-tests-2", "verify:logic-tests-3", "verify:logic-tests-4",
  "verify:logic-tests-5", "verify:logic-tests-6", "verify:r10:0", "verify:r10:1", "verify:r10:2", "verify:r10:3", "verify:r10:4",
  "verify:r1:0", "verify:r1:1", "verify:r1:10", "verify:r1:11", "verify:r1:12", "verify:r1:13", "verify:r1:14", "verify:r1:15",
  "verify:r1:2", "verify:r1:3", "verify:r1:4", "verify:r1:5", "verify:r1:6", "verify:r1:7", "verify:r1:8", "verify:r1:9", "verify:r2:0",
  "verify:r2:1", "verify:r2:10", "verify:r2:2", "verify:r2:3", "verify:r2:4", "verify:r2:5", "verify:r2:6", "verify:r2:7", "verify:r2:8",
  "verify:r2:9", "verify:r3:0", "verify:r3:1", "verify:r3:10", "verify:r3:2", "verify:r3:3", "verify:r3:4", "verify:r3:5", "verify:r3:6",
  "verify:r3:7", "verify:r3:8", "verify:r3:9", "verify:r4:0", "verify:r4:1", "verify:r4:2", "verify:r4:3", "verify:r4:4", "verify:r5:0",
  "verify:r5:1", "verify:r5:2", "verify:r5:3", "verify:r5:4", "verify:r6:0", "verify:r6:1", "verify:r6:2", "verify:r7:0", "verify:r7:1",
  "verify:r8:0", "verify:r8:1", "verify:r8:2", "verify:r9:0", "verify:r9:1", "verify:r9:2", "verify:r9:3", "verify:r9:4", "verify:r9:5",
  "verify:r9:6", "verify:reports-cli-home", "verify:reports-tests-build", "verify:rs-new-risks", "verify:run", "verify:state-and-fail-0",
  "verify:state-and-fail-1", "verify:state-and-fail-2", "verify:state-and-fail-3", "verify:state-and-fail-4", "verify:state-and-fail-5",
  "verify:tests-and-docs-0", "verify:tests-and-docs-1", "verify:tests-and-docs-2", "verify:tests-and-docs-3", "verify:user-task",
];

// 옛 서버 판정(server.mjs 77, 400, 407)을 그대로 옮긴 것. 결과는 설정 id 일 때만 쓰였다.
const old77 = (l, ids) => {
  const m = String(l || '').match(/(?:^|-)(S\d+b?)(?:-|$)/);
  return m && ids.includes(m[1]) ? m[1] : null;
};
const old400 = (l, ids) => {
  const m = l.match(/S\d+b?/);
  return m && ids.includes(m[0]) ? m[0] : null;
};
const old407 = (l) => /S\d+b?/.test(l);

test('시각 해석: Z 있음, Z 없는 19자는 현지 시각(옛 서버와 같음), 읽지 못하면 0', T, () => {
  assert.equal(parseTime('2026-10-29T03:00:00Z'), Date.UTC(2026, 9, 29, 3));
  assert.equal(parseTime('2026-10-29T03:00:00'), new Date(2026, 9, 29, 3).getTime());
  assert.equal(parseTime('2026-10-24T14:55:20.182Z'), Date.UTC(2026, 9, 24, 14, 55, 20, 182));
  assert.equal(parseTime('2026-10-29T12:00:00+09:00'), Date.UTC(2026, 9, 29, 3));
  for (const bad of ['', 'x', null, undefined, {}, NaN]) assert.equal(parseTime(bad), 0, String(bad));
  assert.equal(parseTime(5), 5);
});

test('시각 해석: Z 없는 19자는 실행 환경 시간대를 따름(자식 프로세스 TZ 지정)', T, () => {
  const src = new URL('./pm-sources.mjs', import.meta.url).href;
  const code = `const { parseTime } = await import(${JSON.stringify(src)}); console.log(JSON.stringify(['2026-10-25T16:01:00', '2026-10-25T16:01:00Z', '2026-10-25T16:01:00+09:00'].map((v) => new Date(parseTime(v)).toISOString())));`;
  const at = (tz) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, TZ: tz }, encoding: 'utf8', windowsHide: true }));
  assert.deepEqual(at('Asia/Seoul'), ['2026-10-25T07:01:00.000Z', '2026-10-25T16:01:00.000Z', '2026-10-25T07:01:00.000Z']);
  assert.deepEqual(at('UTC'), ['2026-10-25T16:01:00.000Z', '2026-10-25T16:01:00.000Z', '2026-10-25T07:01:00.000Z']);
  assert.deepEqual(at('America/New_York'), ['2026-10-25T20:01:00.000Z', '2026-10-25T16:01:00.000Z', '2026-10-25T07:01:00.000Z']);
});

test('단계 상태 전이: 시작, 완료, 건너뜀, 실패와 멈춤, 완료 뒤 시작은 무시, 첫 시작 시각 유지', T, () => {
  const st = stageStates([
    { t: '2026-10-28T00:00:00Z', stage: 'a', status: 'started' },
    { t: '2026-10-28T00:10:00Z', stage: 'a', status: 'done' },
    { t: '2026-10-28T00:20:00Z', stage: 'a', status: 'started' },
    { t: '2026-10-28T01:00:00Z', stage: 'b', status: 'started' },
    { t: '2026-10-28T01:30:00Z', stage: 'b', status: 'failed' },
    { t: '2026-10-28T02:00:00Z', stage: 'c', status: 'skipped' },
    { t: '2026-10-28T03:00:00Z', stage: 'd', status: 'started' },
    { t: '2026-10-28T03:10:00Z', stage: 'd', status: 'started' },
    { t: '2026-10-28T04:00:00Z', stage: 'e', status: 'stopped' },
    { t: '2026-10-28T05:00:00Z', stage: 'f', status: 'wip' },
  ]);
  const ms = (h, m = 0) => Date.UTC(2026, 9, 28, h, m);
  assert.deepEqual(st.a, { s: 'done', t: ms(0, 10), start: ms(0) });
  assert.deepEqual(st.b, { s: 'stopped', t: ms(1, 30), start: ms(1) });
  assert.deepEqual(st.c, { s: 'done', t: ms(2), start: 0 });
  assert.deepEqual(st.d, { s: 'doing', t: ms(3, 10), start: ms(3) });
  assert.deepEqual(st.e, { s: 'stopped', t: ms(4), start: 0 });
  assert.equal(st.f, undefined);
});

test('events 와 stageEvents 는 시각 순으로 합침(파일 차례가 아님)', T, () => {
  const events = [{ t: '2026-10-28T02:00:00Z', stage: 'plan', status: 'done' }];
  const manual = [{ t: '2026-10-28T01:00:00Z', stage: 'plan', status: 'started' }];
  const st = stageStates([...events, ...manual]);
  assert.equal(st.plan.s, 'done');
  assert.equal(st.plan.start, Date.UTC(2026, 9, 28, 1));
  // 같은 시각이면 들어온 차례
  const tie = stageStates([
    { t: '2026-10-28T01:00:00Z', stage: 'x', status: 'started' },
    { t: '2026-10-28T01:00:00Z', stage: 'x', status: 'done' },
  ]);
  assert.equal(tie.x.s, 'done');
});

test('JSONL 은 깨진 줄과 객체가 아닌 줄을 건너뜀. 파일이 없으면 빈 목록', T, () => {
  const f = path.join(tmp(), 'e.jsonl');
  write(f, jsonl([{ a: 1 }, '{broken', '3', '[1]', '', { b: 2 }]));
  assert.deepEqual(readLines(f), [{ a: 1 }, { b: 2 }]);
  assert.deepEqual(readLines(path.join(ROOT, 'none.jsonl')), []);
});

test('파일 캐시: 같은 (mtime, 크기) 면 같은 결과, 바뀌면 다시 읽음. BOM, 깨진 JSON, 없음', T, () => {
  const f = path.join(tmp(), 'a.json');
  write(f, '{"v":1}');
  const a = readJsonFile(f);
  assert.deepEqual(a.value, { v: 1 });
  assert.equal(readJsonFile(f), a, '바뀌지 않으면 같은 객체');
  write(f, '{"v":22}');
  fs.utimesSync(f, new Date(Date.UTC(2026, 0, 2)), new Date(Date.UTC(2026, 0, 2)));
  assert.deepEqual(readJsonFile(f).value, { v: 22 });
  write(f, '\u{FEFF}{"v":3}');
  fs.utimesSync(f, new Date(Date.UTC(2026, 0, 3)), new Date(Date.UTC(2026, 0, 3)));
  assert.deepEqual(readJsonFile(f).value, { v: 3 });
  write(f, '{x');
  fs.utimesSync(f, new Date(Date.UTC(2026, 0, 4)), new Date(Date.UTC(2026, 0, 4)));
  assert.equal(readJsonFile(f).error, 'JSON 아님');
  assert.equal(readJsonFile(path.join(ROOT, 'no.json')).missing, true);
});

const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'e', GIT_AUTHOR_EMAIL: 'e@example.invalid', GIT_COMMITTER_NAME: 'e', GIT_COMMITTER_EMAIL: 'e@example.invalid' };
const g = (cwd, ...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, env: gitEnv, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });

test('git: 저장소가 아니거나 커밋이 없으면 null. log 캐시 키는 HEAD 값이라 새 커밋이면 다시 읽음', T, () => {
  const p = tmp('repo');
  g(p, 'init', '-q');
  assert.equal(gitLog(p, 50), null, '커밋 없음');
  g(p, 'commit', '-q', '--allow-empty', '-m', 'A1: 첫 커밋');
  const one = gitLog(p, 50);
  assert.equal(one.length, 1);
  assert.match(one[0], /^[0-9a-f]{4,}\|\d{4}-\d\d-\d\dT[^|]+\|A1: 첫 커밋$/);
  assert.equal(gitLog(p, 50), one, '같은 HEAD 면 캐시');
  g(p, 'commit', '-q', '--allow-empty', '-m', 'A2: 둘째');
  const two = gitLog(p, 50);
  assert.equal(two.length, 2);
  assert.match(two[0], /\|A2: 둘째$/);
  assert.equal(gitLog(p, 1).length, 1, 'gitMax');
});

test('gitHead: git 을 띄우지 않고 파일에서 HEAD 해시. 느슨한 ref, packed-refs, 분리된 HEAD, 하위 폴더, worktree', T, () => {
  const p = tmp('heads');
  const outside = tmp('plain');
  assert.equal(gitHead(outside), null, '저장소 아님');
  g(p, 'init', '-q');
  assert.equal(gitHead(p), null, '브랜치에 커밋 없음');
  g(p, 'commit', '-q', '--allow-empty', '-m', 'A1: 첫 커밋');
  const rev = (cwd) => g(cwd, 'rev-parse', 'HEAD').trim();
  assert.equal(gitHead(p), rev(p), '느슨한 ref');
  const sub = path.join(p, 'a', 'b');
  fs.mkdirSync(sub, { recursive: true });
  assert.equal(gitHead(sub), rev(p), '하위 폴더');
  g(p, 'pack-refs', '--all');
  const branch = g(p, 'symbolic-ref', 'HEAD').trim();
  assert.ok(!fs.existsSync(path.join(p, '.git', ...branch.split('/'))), 'pack-refs 뒤 느슨한 ref 없음');
  assert.equal(gitHead(p), rev(p), 'packed-refs');
  g(p, 'commit', '-q', '--allow-empty', '-m', 'A2: 둘째');
  assert.equal(gitHead(p), rev(p), 'packed-refs 뒤 새 커밋은 느슨한 ref');
  const second = rev(p);
  g(p, 'checkout', '-q', '--detach', 'HEAD~1');
  assert.equal(gitHead(p), rev(p), '분리된 HEAD');
  assert.notEqual(gitHead(p), second);
  g(p, 'checkout', '-q', '-');
  const wt = path.join(path.dirname(p), 'wt');
  g(p, 'worktree', 'add', '-q', '-b', 'side', wt);
  assert.ok(fs.statSync(path.join(wt, '.git')).isFile(), 'worktree 의 .git 은 파일');
  g(wt, 'commit', '-q', '--allow-empty', '-m', 'A3: 옆 가지');
  assert.equal(gitHead(wt), rev(wt), 'worktree(gitdir, commondir)');
  assert.notEqual(gitHead(wt), gitHead(p));
  assert.equal(gitHead(p), second, 'worktree 커밋은 본 저장소 HEAD 를 바꾸지 않음');
});

test('gitLog: 같은 HEAD 면 git 을 띄우지 않음(PATH 를 비워도 캐시 값), HEAD 가 바뀌면 그때만 git log', T, () => {
  const p = tmp('nospawn');
  g(p, 'init', '-q');
  g(p, 'commit', '-q', '--allow-empty', '-m', 'A1: 첫 커밋');
  const one = gitLog(p, 50);
  assert.equal(one.length, 1);
  const saved = process.env.PATH;
  try {
    process.env.PATH = '';
    assert.throws(() => execFileSync('git', ['--version'], { stdio: 'ignore', windowsHide: true }), 'PATH 가 비면 git 을 못 띄움');
    assert.equal(gitLog(p, 50), one, 'HEAD 읽기와 캐시만으로 응답');
  } finally {
    process.env.PATH = saved;
  }
  g(p, 'commit', '-q', '--allow-empty', '-m', 'A2: 둘째');
  try {
    process.env.PATH = '';
    assert.equal(gitLog(p, 50), null, '새 HEAD 를 파일에서 알아채고 git log 를 띄우려 함(여기서는 실패)');
  } finally {
    process.env.PATH = saved;
  }
  assert.equal(gitLog(p, 50), null, '같은 HEAD 의 실패는 캐시(git 을 다시 띄우지 않음)');
  g(p, 'commit', '-q', '--allow-empty', '-m', 'A3: 셋째');
  assert.equal(gitLog(p, 50).length, 3, 'HEAD 가 바뀌면 다시 띄움');
});

test('gitInfo: 스토리별 마지막 커밋, storyCommits 해시 앞부분 대조, HEAD 표시, 자료 없음', T, () => {
  const lines = ['ccc3333|2026-10-28T05:00:00Z|A2(2/2): 설정 검사', 'bbb2222|2026-10-28T03:00:00Z|A2(1/2): 설정 읽기', 'aaa1111|2026-10-27T02:00:00Z|문서 정리'];
  const r = gitInfo(lines, ['A1', 'A2', 'A3', 'A4'], { A1: 'aaa1111ffff', A2: 'bbb2222', A4: { hash: 'ddd4444', t: '2026-10-29T00:00:00Z' } });
  assert.equal(r.head, 'ccc3333 A2(2/2): 설정 검사');
  assert.deepEqual(r.commits.A2, { h: 'ccc3333', t: Date.parse('2026-10-28T05:00:00Z') }, '제목 판정이 storyCommits 보다 앞섬');
  assert.deepEqual(r.commits.A1, { h: 'aaa1111', t: Date.parse('2026-10-27T02:00:00Z') });
  assert.deepEqual(r.commits.A4, { h: 'ddd4444', t: Date.parse('2026-10-29T00:00:00Z') }, 'log 에 없는 해시도 완료');
  assert.equal(r.commits.A3, undefined);
  assert.deepEqual(gitInfo(null, ['A1']), { head: '-', commits: {} });
});

test('커밋 판정: 옛 storyOf 와 같은 사례', T, () => {
  const ids = ['S1', 'S2', 'S10', 'S11', 'S11b', 'S12', 'S13', 'S14'];
  const cases = [
    ['S12: 로컬 스모크', 'S12'],
    ['S12(1/2): 앞 절반', 'S12'],
    ['S11b(3a/3): 저사양', 'S11b'],
    ['S14 복원 확인', 'S14'],
    ['S13a: 박스 일부', 'S13'],
    ['S13b 남은 일', 'S13'],
    ['S2x: 소문자 한 자', 'S2'],
    ['S2xy: 두 자', null],
    ['S20: 미설정', null],
    ['S1: 하나', 'S1'],
    ['S10: 열', 'S10'],
    ['S1', null],
    ['문서 S1: 앞에 글', null],
  ];
  for (const [s, want] of cases) assert.equal(storyOfSubject(s, ids), want, s);
  assert.equal(storyOfSubject('A.1: 점 id', ['A.1', 'AX1']), 'A.1', '특수 문자 id 는 글자 그대로');
  assert.equal(storyOfSubject('AX1: 다른 id', ['A.1']), null);
  assert.equal(storyOfSubject('S1: 하나', []), null, '스토리 없으면 판정 끔');
  const re = '^\\[(?<id>[A-Z]\\d+)\\]';
  assert.equal(storyOfSubject('[A1] 화면', ['A1'], re), 'A1');
  assert.equal(storyOfSubject('[A9] 화면', ['A1'], re), null, '그룹 값이 설정 id 가 아님');
  assert.equal(storyOfSubject('A1: 화면', ['A1'], re), null, 'commitRegex 가 있으면 기본 판정을 쓰지 않음');
});

test('시작 시각 라벨: 토큰이 설정 id 와 정확히 같은 첫 토큰', T, () => {
  const ids = PCC_IDS;
  assert.equal(storyOfStartLabel('impl-S10-r1', ids), 'S10');
  assert.equal(storyOfStartLabel('impl-S11b-1-r1', ids), 'S11b');
  assert.equal(storyOfStartLabel('impl-S13a-r1', ids), null);
  assert.equal(old77('impl-S13a-r1', ids), null, '옛 77 도 없음');
  assert.equal(storyOfStartLabel('x-S1-S10', ids), 'S1');
  assert.equal(old77('x-S1-S10', ids), 'S1');
  assert.equal(storyOfStartLabel('S10', ids), 'S10');
  assert.equal(storyOfStartLabel('x-S1', ['S10']), null, 'S1 대 S10');
  // 의도한 차이(계획 12.2): 옛 77 은 첫 일치 S99(미설정)를 잡고 버려 결과 없음, 새 함수는 S1
  assert.equal(storyOfStartLabel('x-S99-S1', ids), 'S1');
  assert.equal(old77('x-S99-S1', ids), null);
  assert.equal(storyOfStartLabel('impl-A1', []), null);
});

test('진행 중 라벨: 패턴 S\\d+b? 는 옛 400, 407 과 같음', T, () => {
  const ids = PCC_IDS;
  const P = 'S\\d+b?';
  assert.equal(storyOfBusyLabel('impl-S13a-r1', ids, P), 'S13');
  assert.equal(storyOfBusyLabel('x-S12b', ids, P), null, 'S12b 미설정');
  assert.equal(hiddenAgent('x-S12b', ids, P), true, '스토리가 아니어도 에이전트 행에서 숨김');
  assert.equal(storyOfBusyLabel('fixS10x', ids, P), 'S10');
  assert.equal(storyOfBusyLabel('x-S1-S10', ids, P), 'S1');
  assert.equal(hiddenAgent('check-docs', ids, P), false);
});

test('진행 중 라벨 기본 규칙: 첫 토큰 우선, 같은 토큰 안 긴 id, 숫자 경계', T, () => {
  const ids = ['S1', 'S10', 'A1'];
  assert.equal(storyOfBusyLabel('x-S1-S10', ids), 'S1', '첫 위치');
  assert.equal(storyOfBusyLabel('impl-S10x-r1', ids), 'S10', 'S10x 토큰에 S1 불일치(뒤가 숫자), S10 일치');
  assert.equal(storyOfBusyLabel('impl-S10-r1', ['S1', 'S10']), 'S10');
  assert.equal(storyOfBusyLabel('impl-S100', ids), null, '숫자가 이어지면 아님');
  assert.equal(storyOfBusyLabel('impl-A1-r1', ids), 'A1');
  assert.equal(storyOfBusyLabel('check-docs', ids), null);
  assert.equal(hiddenAgent('impl-A1-r1', ids), true);
  assert.equal(hiddenAgent('check-docs', ids), false);
  assert.equal(storyOfBusyLabel('impl-A1', []), null, '스토리 없으면 판정 끔');
  // id 에 - 가 있으면 토큰 판정이 안 됨(check 가 WARN)
  assert.equal(storyOfBusyLabel('impl-a-b', ['a-b']), null);
});

test('글자 id: 기본 규칙은 auth 가 author 에 맞음(제약), agentLabelPattern 을 주면 맞지 않음', T, () => {
  assert.equal(storyOfBusyLabel('review-author-r1', ['auth']), 'auth');
  assert.equal(storyOfBusyLabel('review-author-r1', ['auth'], '\\bauth\\b'), null);
  assert.equal(storyOfBusyLabel('review-auth-r1', ['auth'], '\\bauth\\b'), 'auth');
});

test('대등 고정: 이 저장소 journal 라벨 전부에 옛 77, 400, 407 과 새 함수가 같은 결과', T, () => {
  assert.equal(LABELS.length, 429);
  const P = 'S\\d+b?';
  let story = 0;
  for (const l of LABELS) {
    assert.equal(storyOfStartLabel(l, PCC_IDS), old77(l, PCC_IDS), `시작 ${l}`);
    assert.equal(storyOfBusyLabel(l, PCC_IDS, P), old400(l, PCC_IDS), `진행 ${l}`);
    assert.equal(hiddenAgent(l, PCC_IDS, P), old407(l), `숨김 ${l}`);
    if (old400(l, PCC_IDS)) story++;
  }
  assert.ok(story >= 40, `스토리 라벨 ${story}`);
});

// 가짜 workflow 루트. agents: { id: [생성 시각, mtime] }, open: 끝나지 않은 agent id.
function fakeRoot(runs) {
  const root = tmp('workflows');
  const times = new Map();
  for (const [run, { journalM, agents, open = [], labels = {} }] of Object.entries(runs)) {
    const dir = path.join(root, run);
    const rows = [{ type: 'launched' }];
    for (const id of Object.keys(agents)) {
      rows.push({ type: 'started', key: `k-${id}`, agentId: id, label: labels[id] || `impl-${id}` });
      if (!open.includes(id)) rows.push({ type: 'result', key: `k-${id}`, agentId: id });
      write(path.join(dir, `agent-${id}.jsonl`), '');
      times.set(path.join(dir, `agent-${id}.jsonl`), { birthtimeMs: agents[id][0], mtimeMs: agents[id][1] });
    }
    write(path.join(dir, 'journal.jsonl'), jsonl(rows));
    times.set(path.join(dir, 'journal.jsonl'), { mtimeMs: journalM });
  }
  const stat = (p) => {
    if (times.has(p)) return times.get(p);
    return fs.statSync(p);
  };
  return { root, stat, times };
}

test('journal: 고정 now 로 24시간과 15분 경계, 끝난 agent 제외, since 는 생성 시각', T, () => {
  const now = Date.UTC(2026, 9, 29, 3);
  const H = 3600e3;
  const M = 60e3;
  const { root, stat } = fakeRoot({
    wf_a: { journalM: now - 24 * H, agents: { a1: [now - 2 * H, now - 15 * M], a2: [now - H, now - 15 * M - 1], a3: [now - H, now] }, open: ['a1', 'a2'], labels: { a1: 'impl-A1-r1', a2: 'impl-A2-r1' } },
    wf_b: { journalM: now - 24 * H - 1, agents: { b1: [now - H, now] }, open: ['b1'] },
  });
  const got = activeAgents([root], now, { staleMin: 15, maxAgeH: 24, maxSessions: 0 }, stat);
  assert.deepEqual(got, [{ label: 'impl-A1-r1', since: now - 2 * H }]);
});

test('journal: 진행 중 스캔만 세션(루트) 상한. 스토리 시작 시각은 상한 없이 모든 루트', T, () => {
  const now = Date.UTC(2026, 9, 29, 3);
  const roots = [];
  const stats = [];
  for (let i = 0; i < 3; i++) {
    const f = fakeRoot({ [`wf_${i}`]: { journalM: now - 60e3, agents: { [`x${i}`]: [now - (i + 1) * 3600e3, now - 60e3] }, open: [`x${i}`], labels: { [`x${i}`]: `impl-A${i}-r1` } } });
    roots.push(f.root);
    stats.push(f);
  }
  const rootM = new Map(roots.map((r, i) => [r, { mtimeMs: now - (3 - i) * 1000 }]));
  const stat = (p) => rootM.get(p) || stats.find((s) => s.times.has(p))?.times.get(p) || fs.statSync(p);
  assert.equal(activeAgents(roots, now, { maxSessions: 0 }, stat).length, 3);
  const two = activeAgents(roots, now, { maxSessions: 2 }, stat);
  assert.deepEqual(two.map((a) => a.label).sort(), ['impl-A1-r1', 'impl-A2-r1'], '최근 루트 2개');
  const starts = storyStarts(roots, ['A0', 'A1', 'A2'], stat);
  assert.deepEqual(starts, { A0: now - 3600e3, A1: now - 2 * 3600e3, A2: now - 3 * 3600e3 });
});

test('스토리 시작 시각은 라벨 토큰 판정과 가장 이른 생성 시각', T, () => {
  const now = Date.UTC(2026, 9, 29, 3);
  const { root, stat } = fakeRoot({
    wf_a: { journalM: now, agents: { a1: [100, 0], a2: [50, 0], a3: [10, 0] }, labels: { a1: 'impl-A1-r1', a2: 'critic-A1-r1', a3: 'impl-A1x-r1' } },
  });
  assert.deepEqual(storyStarts([root], ['A1'], stat), { A1: 50 });
  assert.deepEqual(storyStarts([root], [], stat), {});
});

test('workflowDirs: 경로 목록은 프로젝트 기준, auto 는 CLAUDE_CONFIG_DIR 의 slug 를 대소문자 무시로 찾음', T, () => {
  const proj = tmp('my-app');
  const cfg = defaults(proj);
  assert.deepEqual(workflowRoots({ ...cfg, sources: { ...cfg.sources, workflowDirs: ['wf', path.join(ROOT, 'abs')] } }, { project: proj }), [path.join(proj, 'wf'), path.join(ROOT, 'abs')]);
  const home = tmp('claude-home');
  const slug = projectSlug(proj);
  assert.ok(/^[A-Za-z0-9-]+$/.test(slug));
  const sess = path.join(home, 'projects', slug.toLowerCase(), 'sess-1', 'subagents', 'workflows');
  fs.mkdirSync(sess, { recursive: true });
  fs.mkdirSync(path.join(home, 'projects', slug.toLowerCase(), 'sess-2'), { recursive: true });
  fs.mkdirSync(path.join(home, 'projects', 'other-project', 's', 'subagents', 'workflows'), { recursive: true });
  assert.deepEqual(workflowRoots(cfg, { project: proj }, { CLAUDE_CONFIG_DIR: home }), [sess]);
  assert.deepEqual(workflowRoots({ ...cfg, sources: { ...cfg.sources, workflowDirs: [] } }, { project: proj }), []);
});

test('items.json 없음이나 깨짐은 빈 값. story 로 더한 스토리와 stage 로 더한 단계', T, () => {
  const d = tmp('data');
  assert.deepEqual(readItems(d), { notes: {}, items: [], storyCommits: {}, storyStates: {}, stageEvents: [] });
  write(path.join(d, 'items.json'), '{bad');
  assert.deepEqual(readItems(d).items, []);
  const cfg = validate({ stories: [{ id: 'A1', name: '화면' }] }, d).config;
  const items = { storyCommits: { M2: { hash: 'abc1234', name: '설정' }, A1: 'x' }, storyStates: { M1: { status: 'doing', name: '초안' }, M3: { status: 'todo' } } };
  assert.deepEqual(storyList(cfg, items), [
    { id: 'A1', name: '화면' },
    { id: 'M2', name: '설정' },
    { id: 'M1', name: '초안' },
    { id: 'M3', name: 'M3' },
  ]);
  const ev = [{ stage: 'design', status: 'started', label: '설계' }, { stage: 'design', status: 'done' }, { stage: 'build', status: 'started' }, { stage: 'build', status: 'done', label: '구현' }];
  assert.deepEqual(stageList(cfg, false, ev), [{ id: 'design', label: '설계' }, { id: 'build', label: '구현' }]);
  assert.deepEqual(stageList(cfg, true, []).map((s) => s.id), ULTRA_STAGES.map((s) => s.id), 'events 가 있으면 기본 10단계');
  assert.deepEqual(stageList(cfg, true, [{ stage: 'plan', status: 'started', label: '다른 이름' }]).find((s) => s.id === 'plan').label, '3 합의 계획', '설정 단계 이름은 그대로');
});

test('collect: 자료가 하나도 없어도 오류 없음, git 없음, events 없음이면 단계 0', T, () => {
  const proj = tmp('empty-app');
  const dataDir = path.join(proj, '.omc', 'progress-mon');
  fs.mkdirSync(dataDir, { recursive: true });
  const ctx = { project: proj, runtime: 'claude', dataDir, exists: true };
  const cfg = defaults(proj);
  const m = collect(ctx, { ...cfg, sources: { ...cfg.sources, workflowDirs: [] } }, Date.UTC(2026, 9, 29, 3));
  assert.equal(m.head, '-');
  assert.deepEqual(m.stages, []);
  assert.deepEqual(m.stories, []);
  assert.deepEqual(m.agents, []);
  assert.equal(m.reqSpec.missing, true);
  assert.equal(m.flow.missing, true);
  assert.equal(m.arch.missing, true);
  const m2 = collect(ctx, { ...cfg, sources: { ...cfg.sources, git: false, workflowDirs: [] } }, 0, { gitLines: ['a1b2c3d|2026-10-28T00:00:00Z|첫 커밋'] });
  assert.equal(m2.head, 'a1b2c3d 첫 커밋', '주입한 git 줄');
});

test('역추적이 폭발하는 commitRegex, agentLabelPattern 은 이벤트 루프를 멈추지 않고 이유가 든 오류', T, () => {
  const evil = 'a'.repeat(40) + '!';
  const t0 = Date.now();
  assert.throws(() => storyOfSubject(evil, ['S1'], '(?<id>(a+)+)$'), /commitRegex 가 200 ms 안에 끝나지 않음/);
  assert.throws(() => gitInfo([`a1b2c3d|2026-10-28T00:00:00Z|${evil}`], ['S1'], {}, '(?<id>(a+)+)$'), /commitRegex/);
  assert.throws(() => storyOfBusyLabel(evil, ['S1'], '(?:a+)+$'), /agentLabelPattern 가 200 ms/);
  assert.throws(() => hiddenAgent(evil, ['S1'], '(?:a+)+$'), /agentLabelPattern/);
  assert.ok(Date.now() - t0 < 10000, `${Date.now() - t0} ms`);
  // 보통 정규식은 그대로 판정, 긴 입력은 앞 1000자만 봄
  assert.equal(storyOfSubject('S1: x', ['S1'], '^(?<id>S\\d+):'), 'S1');
  assert.equal(storyOfSubject(`${'x'.repeat(1000)}S1:`, ['S1'], '(?<id>S\\d+):'), null);
  assert.equal(storyOfBusyLabel('impl-S2-r1', ['S2'], 'S\\d+'), 'S2');
  assert.equal(hiddenAgent('review', ['S2'], '^rev'), true);
});

test('events, journal 이 특수 파일(FIFO, /dev/zero)이면 읽지 않고 빈 출처로', T, (t) => {
  if (process.platform === 'win32') return t.skip('FIFO 와 /dev/zero 는 POSIX 만');
  const proj = tmp('special');
  const fifo = path.join(proj, 'events.jsonl');
  execFileSync('mkfifo', [fifo]);
  assert.deepEqual(readLines(fifo), [], 'FIFO 는 열지 않음(열면 쓰는 쪽을 기다리며 멈춤)');
  assert.deepEqual(readLines('/dev/zero'), [], '장치는 읽지 않음');
  const run = path.join(proj, 'wf', 'run1');
  fs.mkdirSync(run, { recursive: true });
  fs.symlinkSync('/dev/zero', path.join(run, 'journal.jsonl'));
  const ctx = { project: proj, runtime: 'claude', dataDir: path.join(proj, '.omc', 'progress-mon') };
  fs.mkdirSync(ctx.dataDir, { recursive: true });
  const cfg = defaults(proj);
  const m = collect(ctx, { ...cfg, sources: { ...cfg.sources, git: false, events: fifo, workflowDirs: ['wf', '/dev/zero'] } }, Date.now());
  assert.deepEqual(m.agents, []);
  assert.deepEqual(m.stageState, {});
});
