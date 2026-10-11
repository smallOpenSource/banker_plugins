// Tests for progress-plan.mjs: what /progress reads from a prompt's text and from a plan file.
// Run from the repo root: node --test hooks/progress-plan.test.mjs
import { strict as assert } from 'node:assert';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { cells, clip, fit, isPlanPath, parsePlan, readPrompt } from './progress-plan.mjs';

const steps = (plan) => plan.steps.map((s) => [s.title, s.status]);

test('a slash command\'s prompt reads as the command and its arguments, in either tag order', () => {
  const skill = '<command-message>banker:payload-mon</command-message>\n<command-name>/banker:payload-mon</command-name>\n<command-args>on</command-args>';
  assert.deepEqual(readPrompt(skill), { kind: 'prompt', text: '/banker:payload-mon on' });
  const effort = '<command-name>/effort</command-name>\n            <command-message>effort</command-message>\n            <command-args></command-args>';
  assert.deepEqual(readPrompt(effort), { kind: 'prompt', text: '/effort' });
});

test('the harness\'s own tags leave a prompt, and a shell command reads as one', () => {
  assert.equal(readPrompt('<system-reminder>\nnamed "x"\n</system-reminder>README 를 고쳐 줘').text, 'README 를 고쳐 줘');
  assert.equal(readPrompt('<local-command-caveat>Caveat: ...</local-command-caveat><local-command-stdout>Set effort</local-command-stdout>').text, '');
  assert.equal(readPrompt('<bash-input>npm test</bash-input>').text, '! npm test');
  assert.equal(readPrompt('<bash-stdout>ok</bash-stdout><bash-stderr></bash-stderr>').text, '');
  assert.equal(readPrompt('a <b>굵게</b> 쓴 글').text, 'a <b>굵게</b> 쓴 글', 'a tag that is not the harness\'s stays');
});

test('a background task\'s notice reads as a notice with its summary', () => {
  const text = '<task-notification>\n<task-id>aee6ed</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<output-file>/tmp/a.output</output-file>\n<status>completed</status>\n<summary>Agent "리뷰" completed</summary>\n</task-notification>';
  assert.deepEqual(readPrompt(text), { kind: 'notice', text: 'Agent "리뷰" completed', status: 'completed' });
  assert.deepEqual(readPrompt('<task-notification><task-id>x</task-id></task-notification>'), { kind: 'notice', text: '', status: '' });
});

test('plan files are the plan folders\' markdown, a ralph PRD and the ultragoal goals', () => {
  for (const p of ['/w/.omc/plans/a.md', 'C:\\w\\.omc\\plans\\a.md', '/w/docs/superpowers/plans/2026-a.md', '/home/u/.claude/plans/slug.md',
    '/w/.omc/prd.json', '/w/.omc/state/sessions/abc/prd.json', '/w/.omc/ultragoal/goals.json']) assert.ok(isPlanPath(p), p);
  for (const p of ['/w/notes.md', '/w/.omc/plans/sub/a.txt', '/w/.omc/wiki/a.md', '/w/prd.json', '/w/.omc/ultragoal/ledger.jsonl', '', undefined]) {
    assert.ok(!isPlanPath(p), String(p));
  }
});

test('superpowers tasks are the steps, each as far along as its checkboxes', () => {
  const md = '# 배포 계획\n\n## Global\n- [ ] 전역\n\n### Task 1: 설계\n- [x] a\n- [x] b\n\n### Task 2: 구현\n- [x] a\n  - [ ] 들여쓴 것\n\n### Task 3: 검증\n- [ ] a\n';
  const plan = parsePlan('/w/.omc/plans/p.md', md);
  assert.equal(plan.title, '배포 계획');
  assert.deepEqual(steps(plan), [['설계', 'completed'], ['구현', 'in_progress'], ['검증', 'pending']]);
});

test('top-level checkboxes are the steps when there are no tasks', () => {
  const plan = parsePlan('/w/docs/superpowers/plans/a.md', '# 일\n- [x] 하나\n- [ ] 둘\n  - [x] 들여쓴 것은 단계가 아님\n');
  assert.deepEqual(steps(plan), [['하나', 'completed'], ['둘', 'pending']]);
});

test('a section named for the steps gives its numbered items, else its sub-headings, with no state', () => {
  const numbered = '# 계획\n\n## 1. 목표\n1. 목표는 단계가 아님\n\n## 작업 순서\n\n1. **설계** `a.md`\n2. [구현](x.md)\n   1. 들여쓴 것\n3) 검증\n\n## 위험\n1. 아님\n';
  assert.deepEqual(steps(parsePlan('/w/.omc/plans/a.md', numbered)), [['설계 a.md', null], ['구현', null], ['검증', null]]);
  const headed = '# 계획\n## Implementation Steps\n### 0단계 준비\n내용\n### 1단계 실행\n#### 세부\n## 끝\n';
  assert.deepEqual(steps(parsePlan('/w/.omc/plans/b.md', headed)), [['0단계 준비', null], ['1단계 실행', null]]);
});

test('a plan with no steps it can find keeps its title, and an untitled one is named by its file', () => {
  const plan = parsePlan('/w/.omc/plans/open-questions.md', '그냥 메모\n');
  assert.deepEqual([plan.title, plan.steps], ['open-questions.md', []]);
});

test('a ralph PRD\'s stories are the steps, done where they pass', () => {
  const prd = JSON.stringify({ title: '백업 이력', stories: [
    { id: 'US-001', title: '링크', passes: true, acceptanceCriteria: ['a'] },
    { id: 'US-002', description: '화면', passes: false },
  ] });
  const plan = parsePlan('/w/.omc/prd.json', prd);
  assert.equal(plan.title, '백업 이력');
  assert.deepEqual(steps(plan), [['링크', 'completed'], ['US-002', 'pending']]);
  assert.match(plan.steps[1].text, /화면/);
  assert.deepEqual(steps(parsePlan('/w/.omc/prd.json', JSON.stringify({ userStories: [{ title: 'x' }] }))), [['x', 'pending']]);
});

test('ultragoal goals are the steps, with their states', () => {
  const goals = JSON.stringify({ goals: [
    { id: 'G1', title: '준비', status: 'complete', objective: '폴더' },
    { id: 'G2', title: '실행', status: 'in_progress' },
    { id: 'G3', title: '보고', status: 'pending' },
    { id: 'G4', title: '막힘', status: 'failed' },
  ] });
  const plan = parsePlan('/w/.omc/ultragoal/goals.json', goals);
  assert.equal(plan.title, 'ultragoal');
  assert.deepEqual(steps(plan), [['준비', 'completed'], ['실행', 'in_progress'], ['보고', 'pending'], ['막힘', 'failed']]);
  assert.equal(plan.steps[0].text, '폴더');
});

test('a JSON plan it cannot read is no plan, and control characters never reach a title', () => {
  assert.equal(parsePlan('/w/.omc/prd.json', '{ not json'), null);
  assert.equal(parsePlan('/w/.omc/prd.json', '[]'), null);
  assert.equal(parsePlan('/w/.omc/plans/a.md', '# 제\u001b[31m목\n- [ ] a\u0007b\n').title, '제 [31m목');
});

test('a text\'s cells count a wide character as two, and fit cuts to cells with an ellipsis', () => {
  assert.equal(cells('ab가나'), 6);
  assert.equal(cells('漢字ｱ'), 5);
  assert.equal(fit('가나다라', 8), '가나다라');
  assert.equal(fit('가나다라', 7), '가나다…');
  assert.equal(fit('abcdef', 4), 'abc…');
  assert.equal(fit('abc', 0), '');
  assert.equal(fit('가나', Infinity), '가나');
});

// A parse that finishes well inside the hooks worker's patience: every mod shares that one worker.
function fast(what, fn, ms = 2000) {
  const t0 = performance.now();
  fn();
  const took = performance.now() - t0;
  assert.ok(took < ms, `${what} took ${Math.round(took)} ms`);
}

test('lines inside a fenced code block are code, not headings, checkboxes or numbered items', () => {
  const task = '### Task 1: Parser\n- [x] Step 1\n```python\n# Arrange\n- [ ] not a step\n1) not an item\n```\n- [ ] Step 2\n- [ ] Step 3\n';
  const plan = parsePlan('/w/docs/superpowers/plans/a.md', `# 계획\n\n${task}\n### Task 2: Done\n~~~bash\n# install\n~~~\n- [x] a\n`);
  assert.deepEqual(steps(plan), [['Parser', 'in_progress'], ['Done', 'completed']]);
  const fenced = '# 계획\n## 작업 순서\n````md\n```\n1) build\n````\n### 1단계 준비\n### 2단계 실행\n';
  assert.deepEqual(steps(parsePlan('/w/.omc/plans/b.md', fenced)), [['1단계 준비', null], ['2단계 실행', null]]);
  assert.deepEqual(steps(parsePlan('/w/.omc/plans/c.md', '# 계획\n- [x] 하나\n```\n- [ ] 닫히지 않은 펜스 안\n')), [['하나', 'completed']]);
});

test('headings named as steps are the steps, each as far along as its checkboxes', () => {
  const md = '# 계획\n## 4. 집행 순서\n### Phase 1 — 작성\n#### 함정\n- [x] a\n### Phase 2 — 매니페스트\n- [x] a\n- [ ] b\n### Phase 2.5 — 단언\n## 5. 게이트\n';
  assert.deepEqual(steps(parsePlan('/w/.omc/plans/a.md', md)), [['Phase 1 — 작성', 'completed'], ['Phase 2 — 매니페스트', 'in_progress'], ['Phase 2.5 — 단언', null]]);
  const korean = '# 계획\n## 작업\n### 0단계 준비\n### 1단계 실행\n';
  assert.deepEqual(steps(parsePlan('/w/.omc/plans/b.md', korean)), [['0단계 준비', null], ['1단계 실행', null]]);
  const one = '# 계획\n### Phase 1 외톨이\n#### 세부\n## 구현 순서\n1. 하나\n2. 둘\n';
  assert.deepEqual(steps(parsePlan('/w/.omc/plans/c.md', one)), [['하나', null], ['둘', null]], 'one step-named heading is no list of steps');
});

test('a section named for the steps gives its sub-headings before the numbered items under them', () => {
  const md = '# 계획\n## 6. 구현 단계\n### S0 — 테스트 베드\n1. 안쪽 번호\n### S1 — 검증기\n## 7. ADR\n';
  assert.deepEqual(steps(parsePlan('/w/.omc/plans/a.md', md)), [['S0 — 테스트 베드', null], ['S1 — 검증기', null]]);
});

test('checkboxes under acceptance criteria are a test of the work, not its steps', () => {
  const md = '# 계획\n## 7. ACCEPTANCE CRITERIA\n- [ ] 기준 하나\n- [x] 기준 둘\n## 할 일\n- [ ] 실제 단계\n';
  assert.deepEqual(steps(parsePlan('/w/.omc/plans/a.md', md)), [['실제 단계', 'pending']]);
  assert.deepEqual(steps(parsePlan('/w/.omc/plans/b.md', '# 계획\n## 수용 기준\n- [ ] a\n')), []);
});

test('a plan counts every step before the pane keeps its first 50', () => {
  const md = `# 긴 계획\n${Array.from({ length: 120 }, (_, i) => `- [${i < 50 ? 'x' : ' '}] 단계 ${i + 1}`).join('\n')}\n`;
  const plan = parsePlan('/w/.omc/plans/a.md', md);
  assert.deepEqual([plan.steps.length, plan.total, plan.done, plan.hasStates], [50, 120, 50, true]);
  const prd = JSON.stringify({ stories: Array.from({ length: 70 }, (_, i) => ({ title: `s${i}`, passes: i >= 60 })) });
  const json = parsePlan('/w/.omc/prd.json', prd);
  assert.deepEqual([json.steps.length, json.total, json.done], [50, 70, 10]);
});

test('JSON items that are not what a plan holds are passed over, never thrown on', () => {
  const prd = JSON.stringify({ userStories: [null, 5, 'x', [], { id: 'US-9', title: { a: 1 }, description: ['d'] }, { title: 'ok', passes: 'yes' }] });
  assert.deepEqual(steps(parsePlan('/w/.omc/prd.json', prd)), [['US-9', 'pending'], ['ok', 'pending']]);
  const goals = JSON.stringify({ goals: [{ id: 'G1', title: 'a', objective: { x: 1 }, status: 'review_blocked' }, { title: 'b', status: 'weird\u0007' }, 7] });
  const plan = parsePlan('/w/.omc/ultragoal/goals.json', goals);
  assert.deepEqual(steps(plan), [['a', 'blocked'], ['b', null]]);
  assert.equal(plan.steps[0].text, 'a');
});

test('a UTF-8 byte order mark is no part of the plan', () => {
  assert.deepEqual(steps(parsePlan('/w/.omc/prd.json', '\uFEFF{"stories":[{"title":"a","passes":true}]}')), [['a', 'completed']]);
  assert.equal(parsePlan('/w/.omc/plans/a.md', '\uFEFF# 제목\n- [ ] a\n').title, '제목');
});

test('review rounds and open questions beside a plan are no plan', () => {
  for (const p of ['/w/.omc/plans/vertical-pptx-critic-r2.md', '/w/.omc/plans/architect-review-r1.md', '/w/.omc/plans/critic-verdict-r1.md',
    '/w/.omc/plans/banker-ralph-qa-impl-review.md', '/w/.omc/plans/open-questions.md']) assert.ok(!isPlanPath(p), p);
  assert.ok(isPlanPath('/w/.omc/plans/vertical-pptx.md'));
});

test('a step keeps markdown\'s link text and code, and only bold\'s asterisks go', () => {
  assert.deepEqual(steps(parsePlan('/w/.omc/plans/a.md', '# p\n- [ ] **굵게** [링크](x.md) `__init__.py` a*b\n')), [['굵게 링크 __init__.py a*b', 'pending']]);
});

test('a lone surrogate never reaches the pane', () => {
  assert.equal(clip('a\uD800b', 10), 'a\uFFFDb');
  assert.equal(clip('😀'.repeat(5), 3), '😀😀…');
});

test('an emoji drawn as emoji takes two cells, a combining mark none', () => {
  for (const e of ['✅', '✨', '⭐', '❌', '⏳', '⚡', '🚀', '🟢', '🪄']) assert.equal(cells(e), 2, e);
  assert.equal(cells('é'), 1);
  assert.equal(fit('✅✅✅', 5), '✅✅…');
});

test('another session\'s message is a prompt of its own, a teammate\'s joins the step as a notice', () => {
  const cross = '<cross-session-message from="worker" from-name="worker">\n테스트 돌려 줘\n</cross-session-message>';
  assert.deepEqual(readPrompt(cross), { kind: 'prompt', text: '[다른 세션] 테스트 돌려 줘' });
  const mate = '<teammate-message teammate_id="r1" color="blue">\n리뷰 끝\n</teammate-message>';
  assert.deepEqual(readPrompt(mate), { kind: 'notice', text: '리뷰 끝', status: 'message' });
  assert.deepEqual(readPrompt('<task-notification><status>failed</status><summary>깨짐</summary></task-notification>'), { kind: 'notice', text: '깨짐', status: 'failed' });
});

test('hostile plans and prompts parse in bounded time', () => {
  const md = (body) => () => parsePlan('/w/.omc/plans/x.md', body);
  fast('a heading of 80k spaces', md(`# ${' '.repeat(80000)}x`));
  fast('80k brackets', md('['.repeat(80000)));
  fast('a checkbox of 80k brackets', md(`- [ ] ${'['.repeat(80000)}`));
  fast('a heading of 80k brackets', md(`# ${'['.repeat(80000)}`));
  fast('50k step headings', md(Array.from({ length: 50000 }, (_, i) => `## Step ${i}`).join('\n')));
  const block = '### Task 1: a\n- [ ] Step\n```js\n# x\n```\n';
  fast('a 4 MiB plan', md(block.repeat(Math.ceil((4 << 20) / block.length))));
  fast('100k stories', () => parsePlan('/w/.omc/prd.json', JSON.stringify({ stories: Array.from({ length: 100000 }, (_, i) => ({ title: `s${i}` })) })));
  fast('16k unclosed reminders', () => readPrompt('<system-reminder>'.repeat(16000)));
  fast('16k unclosed command names', () => readPrompt(`x${'<command-name>'.repeat(16000)}`));
  fast('a 1 MiB prompt', () => readPrompt('가'.repeat(1 << 20)));
});
