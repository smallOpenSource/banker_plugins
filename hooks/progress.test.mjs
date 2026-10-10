// Tests for progress.mjs, the /progress pane of banker's mods module.
// Run from the repo root: node --test hooks/progress.test.mjs
// (hooks/progress.engine.test.ts runs the same module inside the engine: claude plugin test <copy>.)
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { callLabel } from './progress.mjs';
import { register } from './register.mjs';

const PANE = 'banker-progress';
// What a terminal's `$.ui.resolve(e)` hands a render hook, as plain data to read back.
const ELEMENTS = {
  Box: (props) => ({ type: 'Box', props }),
  Text: (props) => ({ type: 'Text', props }),
  Button: (props) => ({ type: 'Button', props }),
};

// A stand-in for the engine's side: it records what the module registers and calls on `$`,
// keeps the open panes, and raises events through the module's hooks the way the engine does,
// `bottom` standing for the engine's own answer.
function engine({ placed = true } = {}) {
  const hooks = [];
  // Like the engine, one module may hook an event once per matcher (no matcher counts as one).
  const on = (event, matcher, hook) => {
    if (typeof matcher === 'function') [hook, matcher] = [matcher, undefined];
    const id = (h) => `${h.event} ${JSON.stringify(h.matcher ?? null)}`;
    if (hooks.some((h) => id(h) === id({ event, matcher }))) throw new Error(`on("${event}") is registered twice`);
    hooks.push({ event, matcher, hook });
    return { catch: () => {} };
  };
  const open = new Set();
  const seen = { registered: [], opened: [], closed: [], invalidated: 0, logs: [] };
  const $ = {
    command: { register: async (spec) => { seen.registered.push(spec); return { command: spec.name }; } },
    session: { version: async () => ({ version: '2.1.296', base: '2.1.296' }) },
    ui: {
      panes: async () => [...open].map((id) => ({ id })),
      open: async (p) => { seen.opened.push(p); open.add(p.id); return placed ? { isPlaced: true } : { isPlaced: false, reason: 'narrow' }; },
      close: async (p) => { seen.closed.push(p); open.delete(p.id); },
      invalidate: () => { seen.invalidated += 1; },
      log: (t) => { seen.logs.push(t); },
      resolve: () => ELEMENTS,
    },
  };
  register(on);
  const fits = (h, e) => !h.matcher || Object.entries(h.matcher).every(([k, v]) => e[k] === v);
  const raise = (event, e, bottom = async () => ({})) => {
    const chain = hooks.filter((h) => h.event === event && fits(h, e));
    const call = (i, ev) => (i < chain.length ? chain[i].hook($, ev, (next) => call(i + 1, next ?? ev)) : bottom(ev));
    return call(0, e);
  };
  const tool = (e, answer = { result: {} }) => raise('tool.call', e, async () => {
    if (answer instanceof Error) throw answer;
    return answer;
  });
  const draw = () => raise('ui.render', { component: 'Pane', requestId: PANE, surface: 'terminal' });
  return { $, seen, open, raise, tool, draw };
}

const walk = (node, out = []) => {
  if (!node || typeof node !== 'object') return out;
  out.push(node);
  for (const child of node.props?.children ?? []) walk(child, out);
  return out;
};
const buttons = (tree) => walk(tree).filter((n) => n.type === 'Button');
const button = (tree, label) => buttons(tree).find((b) => b.props.label === label);
const about = (tree) => walk(tree).find((n) => n.props?.key === 'about');
const textOf = (node) => walk(node).filter((n) => n.type === 'Text').flatMap((n) => n.props.children).join(' ');
const rowOf = (tree, key) => walk(tree).find((n) => n.props?.key === `row-${key}`);

test('session.start registers /progress to run at once, with its argument hint', async () => {
  const eng = engine();
  await eng.raise('session.start', {});
  const mine = eng.seen.registered.filter((s) => s.name === 'progress');
  assert.deepEqual(mine.map((s) => [s.name, s.immediate, s.argumentHint]), [['progress', true, '[show | on | off]']]);
});

test('/progress and /progress show toggle the pane; on and off set it', async () => {
  const eng = engine();
  const run = (args) => eng.raise('command.run', { command: 'progress', args });
  assert.deepEqual(await run(''), {});
  assert.ok(eng.open.has(PANE), 'show opens a closed pane');
  await run('show');
  assert.ok(!eng.open.has(PANE), 'show closes an open pane');
  await run('on');
  await run('on');
  assert.ok(eng.open.has(PANE), 'on keeps it open');
  await run('off');
  await run('off');
  assert.ok(!eng.open.has(PANE));
  assert.equal(eng.seen.closed.length, 2, 'off on a closed pane closes nothing');
  assert.equal(eng.seen.opened[0].title, '진행 상황');
});

test('an argument it does not know answers with the usage, and a pane not placed yet says so', async () => {
  const eng = engine();
  assert.match((await eng.raise('command.run', { command: 'progress', args: 'toggle' })).text, /사용법: \/progress/);
  const narrow = engine({ placed: false });
  assert.match((await narrow.raise('command.run', { command: 'progress', args: 'on' })).text, /넓혀/);
});

test('the markdown command\'s name runs the same toggle here, so it never expands into a model turn', async () => {
  const eng = engine();
  let expanded = false;
  await eng.raise('command.run', { command: 'banker:progress', args: '' }, async () => { expanded = true; return {}; });
  assert.ok(eng.open.has(PANE));
  assert.equal(expanded, false);
});

test('with nothing seen yet the pane shows one idle step and says how steps appear', async () => {
  const eng = engine();
  const tree = await eng.draw();
  assert.deepEqual(buttons(tree).map((b) => b.props.label), ['진행 중인 작업 없음']);
  assert.equal(textOf(rowOf(tree, 'idle')).trim(), '', 'no state word repeats the title');
  assert.match(textOf(about(tree)), /아직 시작한 작업이 없습니다/);
});

test('each prompt is a step; the running one is in progress and its tool calls fold under an arrow', async () => {
  const eng = engine();
  await eng.raise('turn.start', { turnId: 't1', text: 'README 를 고쳐 줘.' });
  await eng.tool({ tool: 'Read', file_path: '/repo/docs/README.md' });
  await eng.tool({ tool: 'Bash', command: 'npm test' }, { isError: true, result: {} });
  let tree = await eng.draw();
  assert.match(textOf(rowOf(tree, 't-t1')), /진행 중/);
  assert.equal(button(tree, 'Read docs/README.md'), undefined, 'folded at first');
  button(tree, '▸').props.onPress({});
  tree = await eng.draw();
  assert.ok(button(tree, '▾'), 'the arrow turns');
  assert.ok(button(tree, 'Read docs/README.md') && button(tree, 'Bash npm test'));
  assert.match(textOf(rowOf(tree, 'c-2')), /실패/);
  button(tree, 'README 를 고쳐 줘.').props.onPress({});
  tree = await eng.draw();
  assert.match(textOf(about(tree)), /^요청: README 를 고쳐 줘\. 진행 중, \d+초, 도구 호출 2회\(실패 1회\)\.$/, 'one period after a prompt that ends in one');
  button(tree, 'Bash npm test').props.onPress({});
  assert.match(textOf(about(await eng.draw())), /^Bash: npm test\. 실패, \d+초\.$/);
  await eng.raise('turn.complete', { turnId: 't1', reason: 'answer' });
  assert.match(textOf(rowOf(await eng.draw(), 't-t1')), /완료/);
  assert.ok(eng.seen.invalidated > 0, 'every change asks for a redraw');
});

test('a press on the shown step clears the description, and a second arrow press folds the list', async () => {
  const eng = engine();
  await eng.raise('turn.start', { turnId: 't1', text: '작업' });
  await eng.tool({ tool: 'Grep', pattern: 'TODO' });
  let tree = await eng.draw();
  button(tree, '작업').props.onPress({});
  button(tree, '작업').props.onPress({});
  assert.match(textOf(about(await eng.draw())), /누르면 설명이/);
  button(tree, '▸').props.onPress({});
  tree = await eng.draw();
  button(tree, '▾').props.onPress({});
  assert.equal(button(await eng.draw(), 'Grep TODO'), undefined);
});

test('/clear (session.end, and no session.start after it) empties the list', async () => {
  const eng = engine();
  await eng.raise('turn.start', { turnId: 't1', text: '작업' });
  await eng.raise('session.end', { reason: 'clear' });
  assert.deepEqual(buttons(await eng.draw()).map((b) => b.props.label), ['진행 중인 작업 없음']);
});

test('a tool call seen before any prompt starts the one step for the work at hand', async () => {
  const eng = engine();
  await eng.tool({ tool: 'Glob', pattern: '**/*.mjs' });
  const tree = await eng.draw();
  assert.deepEqual(buttons(tree).map((b) => b.props.label), ['▸', '지금 하는 작업']);
  assert.match(textOf(rowOf(tree, 't-now')), /진행 중/);
});

test('a subagent\'s turn.complete does not end the main step, and its calls are marked as its own', async () => {
  const eng = engine();
  await eng.raise('turn.start', { turnId: 't1', text: '조사' });
  await eng.tool({ tool: 'WebSearch', query: 'mods', agentId: 'a1' });
  await eng.raise('turn.complete', { turnId: 't1', reason: 'answer', agentId: 'a1' });
  let tree = await eng.draw();
  assert.match(textOf(rowOf(tree, 't-t1')), /진행 중/);
  button(tree, '▸').props.onPress({});
  tree = await eng.draw();
  button(tree, 'WebSearch mods').props.onPress({});
  assert.match(textOf(about(await eng.draw())), /^하위 에이전트의 WebSearch: mods\./);
});

test('the task list replaces prompts as steps, and calls go to the task in progress', async () => {
  const eng = engine();
  await eng.raise('turn.start', { turnId: 't1', text: '만들어 줘' });
  await eng.tool({ tool: 'TaskCreate', subject: '설계', description: '구조를 정한다' }, { result: { task: { id: '1', subject: '설계' } } });
  await eng.tool({ tool: 'TaskCreate', subject: '구현', description: '코드를 쓴다' }, { result: { task: { id: '2', subject: '구현' } } });
  await eng.tool({ tool: 'TaskUpdate', taskId: '1', status: 'in_progress', activeForm: '설계하는 중' }, { result: { success: true } });
  await eng.tool({ tool: 'Read', file_path: 'a.md' });
  let tree = await eng.draw();
  assert.deepEqual(buttons(tree).map((b) => b.props.label), ['▸', '설계', '구현']);
  assert.match(textOf(rowOf(tree, 'k-2')), /대기/);
  button(tree, '설계').props.onPress({});
  tree = await eng.draw();
  assert.match(textOf(about(tree)), /^구조를 정한다\. 진행 중\(설계하는 중\), 도구 호출 1회\.$/);
  button(tree, '▸').props.onPress({});
  assert.deepEqual(buttons(await eng.draw()).map((b) => b.props.label), ['▾', '설계', 'Read a.md', '구현'], 'task tools are not calls');
  await eng.tool({ tool: 'TaskUpdate', taskId: '2', status: 'deleted' }, { result: { success: true } });
  assert.equal(button(await eng.draw(), '구현'), undefined);
});

test('a task call the engine refused or that failed changes no step', async () => {
  const eng = engine();
  await eng.tool({ tool: 'TaskCreate', subject: '설계', description: 'x' }, { deny: 'not now' });
  assert.deepEqual(buttons(await eng.draw()).map((b) => b.props.label), ['진행 중인 작업 없음']);
  await eng.tool({ tool: 'TaskCreate', subject: '설계', description: 'x' }, { result: { task: { id: '1', subject: '설계' } } });
  await eng.tool({ tool: 'TaskUpdate', taskId: '1', status: 'completed' }, { deny: 'not now' });
  await eng.tool({ tool: 'TaskUpdate', taskId: '1', status: 'completed' }, { isError: true, result: {} });
  assert.match(textOf(rowOf(await eng.draw(), 'k-1')), /대기/);
  await eng.tool({ tool: 'TodoWrite', todos: [{ content: 'Z', status: 'pending', activeForm: 'Z' }] }, { deny: 'not now' });
  assert.deepEqual(buttons(await eng.draw()).map((b) => b.props.label), ['설계'], 'a refused TodoWrite does not replace the steps');
});

test('TodoWrite lists become steps, and an item keeps its calls while its text stays', async () => {
  const eng = engine();
  const todos = (a, b) => [{ content: 'A 하기', status: a, activeForm: 'A 하는 중' }, { content: 'B 하기', status: b, activeForm: 'B 하는 중' }];
  await eng.tool({ tool: 'TodoWrite', todos: todos('in_progress', 'pending') });
  await eng.tool({ tool: 'Bash', command: 'make' });
  await eng.tool({ tool: 'TodoWrite', todos: todos('completed', 'in_progress') });
  const tree = await eng.draw();
  assert.deepEqual(buttons(tree).map((b) => b.props.label), ['▸', 'A 하기', 'B 하기']);
  assert.match(textOf(rowOf(tree, 'd-0')), /완료/);
  assert.match(textOf(rowOf(tree, 'd-1')), /진행 중/);
});

test('calls made while no task is in progress go to a step of their own', async () => {
  const eng = engine();
  await eng.tool({ tool: 'TaskCreate', subject: '설계', description: 'x' }, { result: { task: { id: '1', subject: '설계' } } });
  await eng.tool({ tool: 'Edit', file_path: '/w/src/app.js' });
  const tree = await eng.draw();
  assert.deepEqual(buttons(tree).map((b) => b.props.label), ['설계', '▸', '작업 목록 밖의 작업']);
});

test('a call that throws is recorded as failed, so its row does not stay running', async () => {
  const eng = engine();
  await eng.raise('turn.start', { turnId: 't1', text: 'x' });
  await assert.rejects(eng.tool({ tool: 'WebFetch', url: 'https://example.invalid' }, new Error('boom')));
  let tree = await eng.draw();
  button(tree, '▸').props.onPress({});
  tree = await eng.draw();
  assert.match(textOf(rowOf(tree, 'c-1')), /실패/);
});

test('a long sub-list shows the newest 30 calls and says how many it cut', async () => {
  const eng = engine();
  await eng.raise('turn.start', { turnId: 't1', text: 'x' });
  for (let i = 0; i < 35; i++) await eng.tool({ tool: 'Bash', command: `step ${i}` });
  let tree = await eng.draw();
  button(tree, '▸').props.onPress({});
  tree = await eng.draw();
  const calls = buttons(tree).filter((b) => /^Bash /.test(b.props.label));
  assert.equal(calls.length, 30);
  assert.equal(calls[0].props.label, 'Bash step 5');
  assert.match(textOf(tree), /앞의 5개는 줄였습니다/);
});

test('a call is named by its main argument, a path by its last two parts', () => {
  assert.equal(callLabel({ tool: 'Read', file_path: 'C:\\repo\\src\\main.js' }), 'Read src/main.js');
  assert.equal(callLabel({ tool: 'Bash', command: 'git status --short' }), 'Bash git status --short');
  assert.equal(callLabel({ tool: 'mcp__x__y' }), 'mcp__x__y');
  assert.equal(callLabel({ tool: 'Bash', command: 'x'.repeat(80) }).length, 'Bash '.length + 48);
});

test('a pane that is not this one is left to the hooks beneath', async () => {
  const eng = engine();
  const other = await eng.raise('ui.render', { component: 'Pane', requestId: 'clock', surface: 'terminal' }, async () => 'beneath');
  assert.equal(other, 'beneath');
});

test('register.mjs wires /progress beside /graceful-pause', async () => {
  const eng = engine();
  await eng.raise('session.start', { cwd: '/w' });
  assert.deepEqual(eng.seen.registered.map((s) => s.name).sort(), ['graceful-pause', 'progress']);
});

test('without mods the fallback hook stops the expansion with the one message, and the command says only that', () => {
  const hook = fileURLToPath(new URL('./progress-fallback.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [hook], { input: '{"hook_event_name":"UserPromptExpansion"}', encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout), { decision: 'block', reason: 'mod 를 지원하지않는 claude code 버전입니다' });
  const md = readFileSync(new URL('../commands/progress.md', import.meta.url), 'utf8');
  assert.match(md, /^disable-model-invocation: true$/m);
  assert.match(md, /\n\nmod 를 지원하지않는 claude code 버전입니다\n$/);
  const hooks = JSON.parse(readFileSync(new URL('./hooks.json', import.meta.url), 'utf8'));
  const entry = hooks.hooks.UserPromptExpansion.find((x) => x.matcher === '^banker:progress$');
  assert.match(entry.hooks[0].command, /hooks\/progress-fallback\.mjs"?$/);
});
