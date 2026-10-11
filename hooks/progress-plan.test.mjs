// Tests for progress-plan.mjs: what /progress reads from a prompt's text and from a plan file.
// Run from the repo root: node --test hooks/progress-plan.test.mjs
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { cells, fit, isPlanPath, parsePlan, readPrompt } from './progress-plan.mjs';

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
