// Tests for progress-plan.mjs: what /progress reads from a prompt's text and from a plan file.
// Run from the repo root: node --test hooks/progress-plan.test.mjs
import { strict as assert } from 'node:assert';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { cells, clip, fit, isPlanPath, nameNodes, parsePlan, planKind, planTree, readPrompt, untag, withoutPastes } from './progress-plan.mjs';

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
    '/w/.omc/prd.json', '/w/.omc/state/sessions/abc/prd.json', '/w/.omc/ultragoal/goals.json', '/w/prd.json']) assert.ok(isPlanPath(p), p);
  for (const p of ['/w/notes.md', '/w/.omc/plans/sub/a.txt', '/w/.omc/wiki/a.md', '/w/prd.json.bak', '/w/.omc/ultragoal/ledger.jsonl', '', undefined]) {
    assert.ok(!isPlanPath(p), String(p));
  }
});

test('a ralph PRD and ultragoal goals are plans wherever they sit; review rounds beside a plan are weak plans', () => {
  for (const p of ['/w/prd.json', '/srv/omc-state/p1/state/sessions/abc/prd.json', '/srv/omc-state/p1/ultragoal/goals.json', 'C:\\w\\prd.json']) {
    assert.equal(planKind(p), 'plan', p);
  }
  for (const p of ['/w/.omc/plans/x-critic-r2.md', '/w/.omc/plans/open-questions.md', '/w/.omc/plans/x-review.md']) assert.equal(planKind(p), 'weak', p);
  for (const p of ['/w/notes.md', '/w/prd.json.bak', '/w/goals.json', '/w/.omc/ultragoal/ledger.jsonl', '', undefined]) assert.equal(planKind(p), null, String(p));
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
    '/w/.omc/plans/banker-ralph-qa-impl-review.md', '/w/.omc/plans/open-questions.md', '/w/.omc/plans/vertical-pptx-architect.md',
    '/w/.omc/plans/banker-ralph-qa-architect-r2.md']) assert.ok(!isPlanPath(p), p);
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
  fast('25k stories, under the JSON cap', () => assert.equal(parsePlan('/w/.omc/prd.json', JSON.stringify({ stories: Array.from({ length: 25000 }, (_, i) => ({ title: `s${i}` })) })).total, 25000));
  fast('16k unclosed reminders', () => readPrompt('<system-reminder>'.repeat(16000)));
  fast('16k unclosed command names', () => readPrompt(`x${'<command-name>'.repeat(16000)}`));
  fast('a 1 MiB prompt', () => readPrompt('가'.repeat(1 << 20)));
});

test('a steps section\'s own numbered items come before the sub-headings after them', () => {
  const md = '# 계획\n## 구현 순서\n1. 설계\n2. 구현\n3. 검증\n### 참고\n내용\n';
  assert.deepEqual(steps(parsePlan('/w/.omc/plans/a.md', md)), [['설계', null], ['구현', null], ['검증', null]]);
});

test('only a name that ends as a review round is no plan', () => {
  for (const p of ['/w/.omc/plans/architecture-migration.md', '/w/.omc/plans/2026-10-01-code-review-bot.md', '/w/.omc/plans/feedback-form.md',
    '/w/.omc/plans/open-questions-answered.md']) assert.ok(isPlanPath(p), p);
  for (const p of ['/w/.omc/plans/review-r2.md', '/w/.omc/plans/x_critic.md', '/w/.omc/plans/x-feedback.md']) assert.ok(!isPlanPath(p), p);
});

test('a line that opens with inline code is no fence', () => {
  const md = '# 계획\n- [ ] 하나\n```bash``` 로 감싼다\n- [ ] 둘\n- [ ] 셋\n';
  assert.deepEqual(steps(parsePlan('/w/.omc/plans/a.md', md)).map(([t]) => t), ['하나', '둘', '셋']);
});

test('a status named like an object\'s own property is no state', () => {
  const goals = JSON.stringify({ goals: ['constructor', '__proto__', 'toString', 'hasOwnProperty'].map((status, i) => ({ title: `g${i}`, status })) });
  assert.deepEqual(steps(parsePlan('/w/.omc/ultragoal/goals.json', goals)), [['g0', null], ['g1', null], ['g2', null], ['g3', null]]);
});

test('a long reminder before the request still leaves the title', () => {
  assert.equal(readPrompt(`<system-reminder>${'x'.repeat(70000)}</system-reminder>README 를 고쳐 줘`).text, 'README 를 고쳐 줘');
});

test('huge fields in a JSON plan and huge prompts are cut before they are cleaned', () => {
  fast('a 4 MiB title, past the JSON cap', () => assert.equal(parsePlan('/w/.omc/prd.json', JSON.stringify({ title: 'a '.repeat(2 << 20), stories: [{ title: 'x' }] })), null), 300);
  fast('a 200 Ki title and description, under the cap', () => assert.equal(parsePlan('/w/.omc/prd.json', JSON.stringify({ title: 'a '.repeat(100000), stories: [{ title: 'x', description: 'b '.repeat(100000) }] })).total, 1), 300);
  fast('a 4 MiB prompt of unclosed tags', () => readPrompt('<command-args>'.repeat(300000)));
  fast('a 4 MiB prompt', () => readPrompt(`${'가 '.repeat(2 << 20)}끝`));
  assert.equal(clip(`${'가'.repeat(5000)}`, 3), '가가…');
});

// ── the plan as a tree ───────────────────────────────────────────────────────

// A tree as nested arrays: kind and text, then marker, status and count where a node has them, then
// its children.
const shape = (nodes) => nodes.map((n) => [n.kind, n.text, ...['marker', 'status', 'count'].filter((k) => n[k]).map((k) => `${k}=${n[k]}`), ...shape(n.children)]);
const tree = (md) => planTree(md).nodes;
const depthOf = (nodes) => (nodes.length ? 1 + Math.max(...nodes.map((n) => depthOf(n.children))) : 0);

test('a pasted block reads as what was pasted, its tags gone with their ids', () => {
  assert.equal(readPrompt('<pasted_content id="e6a9">\n[HANDOFF] banker 0.16.3 게시 이후\n</pasted_content id="e6a9">').text, '[HANDOFF] banker 0.16.3 게시 이후');
  assert.equal(readPrompt('고쳐 줘. <pasted_content id="a1">계획: x</pasted_content id="a1"> 이렇게 나와').text, '고쳐 줘. 계획: x 이렇게 나와');
  assert.equal(readPrompt('<pasted_content>그대로</pasted_content>').text, '그대로', 'a tag without an id goes too');
  assert.equal(readPrompt('<pasted_content id="b">하나</pasted_content id="b"><pasted_content id="c">둘</pasted_content id="c">').text, '하나 둘');
  assert.equal(untag(`<pasted_content ${'x'.repeat(100)}>`, 'pasted_content').trim(), `<pasted_content ${'x'.repeat(100)}>`, 'a > past 64 characters closes no tag');
  assert.equal(untag('pasted_content 라는 낱말과 <pasted_contents>', 'pasted_content'), 'pasted_content 라는 낱말과 <pasted_contents>');
  fast('64k unclosed pasted tags', () => readPrompt('<pasted_content id="x"'.repeat(64000)));
  fast('64k pasted tags', () => readPrompt('<pasted_content id="x">가</pasted_content id="x">'.repeat(64000)));
});

test('a markdown plan is a tree: a heading holds what follows it, a list item its nested items', () => {
  const md = '# 계획\n\n상태: 진행\n\n## A\n\n- 하나\n  - 하나의 하위\n- 둘\n\n### A1\n\n1. 첫째\n2) 둘째\n\n## B\n\n문단 첫 줄\n이어지는 줄\n\n> 인용\n';
  assert.deepEqual(shape(tree(md)), [
    ['text', '상태: 진행'],
    ['head', 'A', ['item', '하나', 'marker=-', ['item', '하나의 하위', 'marker=-']], ['item', '둘', 'marker=-'],
      ['head', 'A1', ['item', '첫째', 'marker=1.'], ['item', '둘째', 'marker=2)']]],
    ['head', 'B', ['text', '문단 첫 줄 이어지는 줄'], ['text', '인용']],
  ]);
  assert.deepEqual(shape(tree('- 항목\n이어짐\n\n  들여쓴 문단\n문단')), [['item', '항목 이어짐', 'marker=-', ['text', '들여쓴 문단 문단']]],
    'a line right after a line goes on with it; after a blank line an indented one goes under the item');
});

test('checkboxes carry their state, and a node over checkboxes counts how many are done', () => {
  const md = '# 계획\n## 1단계\n- [x] a\n- [ ] b\n## 2단계\n1. 설계\n   - [x] c\n   - [X] d\n';
  assert.deepEqual(shape(tree(md)), [
    ['head', '1단계', 'count=1/2', ['item', 'a', 'status=completed'], ['item', 'b', 'status=pending']],
    ['head', '2단계', 'count=2/2', ['item', '설계', 'marker=1.', 'count=2/2', ['item', 'c', 'status=completed'], ['item', 'd', 'status=completed']]],
  ]);
});

test('a table is one node with a row per data row, and a code block one with a line per line', () => {
  const md = '# 계획\n| 단계 | 할 일 |\n|---|:-:|\n| 1 | 설계 |\n| 2 | `구현` |\n\n```bash\n  npm test\n\tx\n```\n~~~\nunclosed\n';
  assert.deepEqual(shape(tree(md)), [
    ['table', '표: 단계 | 할 일 (2행)', ['row', '1 | 설계'], ['row', '2 | 구현']],
    ['code', '코드 bash (2줄)', ['code-line', '  npm test'], ['code-line', '  x']],
    ['code', '코드 (1줄)', ['code-line', 'unclosed']],
  ]);
  assert.deepEqual(shape(tree('```bash``` 로 감싼다\n')), [['text', 'bash 로 감싼다']], 'a fence with a backtick after it is inline code');
  assert.deepEqual(shape(tree('- 단계\n  ```\n  # 주석\n  ```\n')), [['item', '단계', 'marker=-', ['code', '코드 (1줄)', ['code-line', '  # 주석']]]]);
});

test('a level-1 title with nothing before it is no node; front matter and comments are no part of the tree', () => {
  const md = '---\ntitle: x\n---\n<!-- 메모\n여러 줄 -->\n# 제목\n본문\n<!-- 한 줄 -->\n***\n## 다음\n';
  assert.deepEqual(shape(tree(md)), [['text', '본문'], ['head', '다음']]);
  assert.deepEqual(shape(tree('들머리\n# 제목\n')), [['text', '들머리'], ['head', '제목']], 'a title after other text is a heading of its own');
  assert.deepEqual(shape(tree('# 제목 ##\n## 둘 #\n### 셋#\n')), [['head', '둘', ['head', '셋#']]], 'a closing run of # goes after a space only');
  assert.deepEqual(shape(tree('\u{FEFF}# 제목\r\n- a\r\n')), [['item', 'a', 'marker=-']]);
});

test('a node keeps its id when the plan is written again around it, and same-named siblings get ids of their own', () => {
  const ids = (nodes) => Object.fromEntries(nodes.flatMap((n) => [[`${n.kind}:${n.text}`, n.id], ...Object.entries(ids(n.children))]));
  const before = ids(tree('# p\n## A\n- x\n## B\n- y\n'));
  const after = ids(tree('# p\n## 새 구역\n- z\n## A\n- x\n- [x] 새 항목\n## B\n- y\n'));
  for (const k of ['head:A', 'item:x', 'head:B', 'item:y']) assert.equal(after[k], before[k], k);
  const twins = tree('# p\n## A\n## A\n');
  assert.notEqual(twins[0].id, twins[1].id);
  const all = [];
  const collect = (nodes) => nodes.forEach((n) => { all.push(n.id); collect(n.children); });
  collect(tree(Array.from({ length: 500 }, () => '## 같음\n- 같음').join('\n')));
  assert.equal(new Set(all).size, all.length, 'every id is its own');
});

test('the tree stops at 3000 nodes, 12 list levels and 200 lines a code block, and says it was cut', () => {
  const many = planTree(Array.from({ length: 3100 }, (_, i) => `- 항목 ${i}`).join('\n'));
  assert.equal(many.nodes.length, 3000);
  assert.equal(many.cut, true);
  assert.equal(planTree('- a\n').cut, false);
  assert.equal(depthOf(tree(Array.from({ length: 30 }, (_, i) => `${'  '.repeat(i)}- 깊이 ${i}`).join('\n'))), 12);
  const code = tree(`\`\`\`\n${Array.from({ length: 250 }, (_, i) => `줄 ${i}`).join('\n')}\n\`\`\`\n`)[0];
  assert.equal(code.text, '코드 (250줄)');
  assert.equal(code.children.length, 201);
  assert.equal(code.children.at(-1).text, '외 50줄');
});

test('control characters and lone surrogates never reach a node, and a code line keeps its indent', () => {
  const [item, code] = tree('# 계획\n- a\u0007b \ud800\n```\n\u001b[31m    red\t!\n```\n');
  assert.equal(item.text, 'a b �');
  assert.equal(code.children[0].text, '[31m    red  !');
  const texts = [];
  const each = (nodes) => nodes.forEach((n) => { texts.push(n.text); each(n.children); });
  each(tree('\u0000\u0001\n- \u0002\n| \u0003 |\n```\n\u0004\n```\n'));
  assert.ok(texts.length >= 4, texts.join('|'));
  for (const t of texts) assert.ok(!/[\p{Cc}\p{Co}]/u.test(t), JSON.stringify(t));
});

test('a ralph PRD and ultragoal goals are trees too: a story holds its description, criteria and notes', () => {
  const prd = parsePlan('/w/.omc/prd.json', JSON.stringify({ project: 'todo-lite', description: '목록 JSON', userStories: [
    { id: 'US-1', title: '시험', description: 'd', acceptanceCriteria: ['a', 7, 'b'], passes: true, notes: 'n' }, { id: 'US-2', title: '구현', passes: false }] }));
  assert.equal(prd.title, 'todo-lite: 목록 JSON');
  assert.deepEqual(shape(prd.tree), [
    ['story', 'US-1 시험', 'status=completed', ['text', 'd'],
      ['group', '수용 기준 (3)', ['item', 'a', 'marker=-'], ['item', '7', 'marker=-'], ['item', 'b', 'marker=-']], ['text', '메모: n']],
    ['story', 'US-2 구현', 'status=pending'],
  ]);
  const goals = parsePlan('/w/.omc/ultragoal/goals.json', JSON.stringify({ goals: [
    { id: 'g1', title: '목표', objective: 'o', status: 'complete', evidence: 'e' }, { id: 'g2', objective: 'x', status: 'failed', failureReason: 'f' }] }));
  assert.deepEqual(shape(goals.tree), [
    ['story', '목표', 'status=completed', ['text', 'o'], ['text', '근거: e']],
    ['story', 'g2', 'status=failed', ['text', 'x'], ['text', '실패 이유: f']],
  ]);
  const big = parsePlan('/w/.omc/prd.json', JSON.stringify({ stories: Array.from({ length: 1000 }, (_, i) => ({ title: `s${i}`, acceptanceCriteria: ['a', 'b', 'c'] })) }));
  assert.equal(big.treeCut, true);
  assert.equal(big.total, 1000, 'the steps still count them all');
});

test('hostile plans parse into a tree in bounded time', () => {
  const md = (body) => () => planTree(body);
  fast('100k nested items', md(Array.from({ length: 100000 }, (_, i) => `${' '.repeat(i % 1000)}- x`).join('\n')));
  fast('250 lines of table rule bars', md(Array.from({ length: 250 }, () => `${'|-'.repeat(500)}x`).join('\n')));
  fast('lines of rule dashes', md(Array.from({ length: 250 }, () => `${'- '.repeat(500)}x`).join('\n')));
  fast('a paragraph of 128k lines', md('a\n'.repeat(128000)));
  fast('64k unclosed comments', md('<!--\n'.repeat(64000)));
  fast('64k fences', md('```\n'.repeat(64000)));
  fast('lines of 1000 #', md(`${'#'.repeat(1000)}\n`.repeat(250)));
  fast('lines of spaces then a hash', md(`${' '.repeat(1000)}#\n`.repeat(250)));
  fast('a 4 MiB plan through parsePlan', () => parsePlan('/w/.omc/plans/x.md', '### Task 1: a\n- [ ] Step\n```js\n# x\n```\n| a | b |\n'.repeat(80000)));
});

test('what the engine will not draw never reaches a node, a code line or a title: private-use, bidi overrides', () => {
  const bad = '\u{10EEEE}\u{E000}\u{202E}\u{2066}';
  const [item, code] = tree(`# 계획\n- a${bad}b\n\`\`\`\nx${bad}y\n\`\`\`\n`);
  assert.equal(item.text, 'a b');
  assert.equal(code.children[0].text, 'xy');
  assert.equal(clip(readPrompt(`요청${bad}끝`).text, 60), '요청 끝', 'a title is drawn through clip');
  assert.equal(clip(`\u{10EEEE}`, 10), '');
});

test('a lone CR ends a line, so lines of spaces before a CR parse in linear time', () => {
  assert.deepEqual(shape(tree('# 계획\r## 하나\r- a\r- b\r')), [['head', '하나', ['item', 'a', 'marker=-'], ['item', 'b', 'marker=-']]]);
  const crs = (lead) => `${lead}${' '.repeat(1000)}\rx\n`.repeat(256);
  fast('heading lines with a CR inside', () => parsePlan('/w/.omc/plans/x.md', crs('# ')), 300);
  fast('item lines with a CR inside', () => parsePlan('/w/.omc/plans/x.md', crs('- ')), 300);
  fast('fence lines with a CR inside', () => parsePlan('/w/.omc/plans/x.md', `\`\`\`\n${crs('```')}`), 300);
});

test('nodes whose names hash alike get their own ids at once, however many there are', () => {
  const nodes = Array.from({ length: 3000 }, (_, i) => ({ kind: 'item', text: `t${i}`, children: [] }));
  fast('3000 names that all hash alike', () => nameNodes(nodes, 'n', new Map(), () => 'same'), 300);
  assert.equal(new Set(nodes.map((n) => n.id)).size, 3000);
  assert.deepEqual(nodes.slice(0, 3).map((n) => n.id), ['nsame', 'nsame_1', 'nsame_2']);
});

test('a JSON plan past 512 Ki characters is no plan', () => {
  const big = JSON.stringify({ stories: Array.from({ length: 200000 }, () => ({})) });
  assert.ok(big.length > 512 * 1024);
  fast('a 1.4 MiB JSON plan', () => assert.equal(parsePlan('/w/.omc/prd.json', big), null), 300);
});

test('a command or shell tag inside pasted text names no command in the title', () => {
  const pasted = '<pasted_content id="a"><command-name>/deploy</command-name><command-args>prod</command-args>붙인 글</pasted_content id="a">';
  assert.equal(readPrompt(`${pasted} 확인해 줘`).text, '붙인 글 확인해 줘');
  assert.equal(readPrompt('<pasted_content id="b"><bash-input>ls</bash-input></pasted_content id="b">').text.startsWith('!'), false);
  assert.equal(readPrompt('<command-name>/x</command-name><pasted_content id="c">글</pasted_content id="c">').text, '/x 글');
  assert.equal(withoutPastes('a<pasted_content id="d">b</pasted_content id="d">c<pasted_content id="e">열림'), 'ac');
});

test('a checkbox item that holds checkboxes shows its own state, not their count', () => {
  assert.deepEqual(shape(tree('- [ ] 부모\n  - [x] 자식\n  - [ ] 자식2\n')),
    [['item', '부모', 'status=pending', ['item', '자식', 'status=completed'], ['item', '자식2', 'status=pending']]]);
});

test('a JSON plan of exactly as many nodes as the tree takes is not cut; one more is', () => {
  const stories = (n) => JSON.stringify({ stories: Array.from({ length: n }, (_, i) => ({ title: `s${i}` })) });
  assert.equal(parsePlan('/w/.omc/prd.json', stories(3000)).treeCut, false);
  assert.equal(parsePlan('/w/.omc/prd.json', stories(3001)).treeCut, true);
});

test('a table or a code block keeps its id as rows and lines are added', () => {
  const before = tree('# p\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nx\n```\n');
  const after = tree('# p\n| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n\n```js\nx\ny\n```\n');
  assert.deepEqual(after.map((n) => n.id), before.map((n) => n.id));
  assert.equal(after[0].text, '표: a | b (2행)');
});

test('a first line --- with no closing line near is a rule, not front matter', () => {
  assert.deepEqual(shape(tree('---\n# 제목\n- a\n- b\n')), [['item', 'a', 'marker=-'], ['item', 'b', 'marker=-']], 'the rule is no content, so the H1 is still the title');
  assert.deepEqual(shape(tree(`---\n${'x\n'.repeat(70)}---\n- a\n`)).at(-1), ['item', 'a', 'marker=-'], 'a close past 60 lines opens nothing');
});

test('past the node cap no line joins the last node, and code lines left out mark the tree cut', () => {
  const md = `${Array.from({ length: 3000 }, (_, i) => `- 항목 ${i}`).join('\n')}\n- 잘린 항목\n이어지는 줄\n`;
  const t = planTree(md);
  assert.equal(t.nodes.at(-1).text, '항목 2999');
  assert.equal(t.cut, true);
  const code = planTree(`${Array.from({ length: 2999 }, (_, i) => `- ${i}`).join('\n')}\n\`\`\`\na\nb\n\`\`\`\n`);
  assert.equal(code.cut, true);
});
