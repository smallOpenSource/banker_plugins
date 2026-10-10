// Tests for progress.mjs, the /progress pane of banker's mods module.
// Run from the repo root: node --test hooks/progress.test.mjs
// (hooks/progress.engine.test.ts runs the same module inside the engine: claude plugin test <copy>.)
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { callLabel, describe, endTurn, freshState, noteTaskTool, startTurn } from './progress.mjs';
import { register } from './register.mjs';

const PANE = 'banker-progress';
// What a terminal's `$.ui.resolve(e)` hands a render hook, as plain data to read back.
const ELEMENTS = {
  Box: (props) => ({ type: 'Box', props }),
  Text: (props) => ({ type: 'Text', props }),
  Button: (props) => ({ type: 'Button', props }),
};

// Raises an event through the module's hooks, `bottom` standing for the engine's own answer. A hook
// that throws runs again as its `.catch` handler, whose `next` says why and replays what the hook's
// own `next` settled to. The handler's answer stands; undefined, or no handler, leaves the hook
// absent: what it had called beneath stands, or else the hooks beneath run once.
function raiser(hooks, $) {
  const fits = (h, e) => !h.matcher || Object.entries(h.matcher).every(([k, v]) => e[k] === v);
  const run = async (h, ev, below) => {
    let called = false;
    let settled;
    const next = (n) => { called = true; settled = below(n ?? ev); return settled; };
    try {
      return await h.hook($, ev, next);
    } catch (err) {
      const again = Object.assign((n) => (called ? settled : below(n ?? ev)),
        { error: { kind: 'throw', message: String(err?.message ?? err), budget: 1000 }, called });
      const answer = h.caught ? await h.caught($, ev, again) : undefined;
      return answer === undefined ? again(ev) : answer;
    }
  };
  return (event, e, bottom = async () => ({})) => {
    const chain = hooks.filter((h) => h.event === event && fits(h, e));
    const call = (i, ev) => (i < chain.length ? run(chain[i], ev, (n) => call(i + 1, n)) : bottom(ev));
    return call(0, e);
  };
}

// A stand-in for the engine's side: it records what the module registers and calls on `$`,
// keeps the open panes, and raises events through the module's hooks the way the engine does. As
// in Claude Code 2.1.296, `$.ui.open` resolves to nothing, a new pane is shown, and a pane behind
// another plugin's pane rises only with `focus`.
function engine() {
  const hooks = [];
  // Like the engine, one module may hook an event once per matcher (no matcher counts as one),
  // and each registration takes one `.catch` handler.
  const on = (event, matcher, hook) => {
    if (typeof matcher === 'function') [hook, matcher] = [matcher, undefined];
    const id = (h) => `${h.event} ${JSON.stringify(h.matcher ?? null)}`;
    if (hooks.some((h) => id(h) === id({ event, matcher }))) throw new Error(`on("${event}") is registered twice`);
    const reg = { event, matcher, hook, caught: null };
    hooks.push(reg);
    return { catch: (handler) => { reg.caught = handler; } };
  };
  const open = new Map();
  const seen = { registered: [], opened: [], closed: [], invalidated: 0, logs: [] };
  const $ = {
    command: { register: async (spec) => { seen.registered.push(spec); return { command: spec.name }; } },
    session: { version: async () => ({ version: '2.1.296', base: '2.1.296' }) },
    ui: {
      panes: async () => [...open].map(([id, p]) => ({ id, title: id, isShown: p.isShown, isFocused: false, isPlaced: true })),
      open: async (p) => { seen.opened.push(p); open.set(p.id, { isShown: !open.has(p.id) || open.get(p.id).isShown || p.focus === true }); },
      close: async (p) => { seen.closed.push(p); open.delete(p.id); },
      invalidate: () => { seen.invalidated += 1; },
      log: (t) => { seen.logs.push(t); },
      resolve: () => ELEMENTS,
    },
  };
  register(on);
  const raise = raiser(hooks, $);
  const tool = (e, answer = { result: {} }) => raise('tool.call', e, async () => {
    if (answer instanceof Error) throw answer;
    return answer;
  });
  const draw = () => raise('ui.render', { component: 'Pane', requestId: PANE, surface: 'terminal' });
  // Another plugin opens a pane in front: this plugin's panes become tabs behind it.
  const cover = () => { for (const p of open.values()) p.isShown = false; };
  const caught = (event) => hooks.find((h) => h.event === event)?.caught;
  return { $, seen, open, raise, tool, draw, cover, caught };
}

const walk = (node, out = []) => {
  if (!node || typeof node !== 'object') return out;
  out.push(node);
  for (const child of node.props?.children ?? []) walk(child, out);
  return out;
};
const buttons = (tree) => walk(tree).filter((n) => n.type === 'Button');
const labels = (tree) => buttons(tree).map((b) => b.props.label);
const button = (tree, label) => buttons(tree).find((b) => b.props.label === label);
const about = (tree) => walk(tree).find((n) => n.props?.key === 'about');
const textOf = (node) => walk(node).filter((n) => n.type === 'Text').flatMap((n) => n.props.children).join(' ');
const rowOf = (tree, key) => walk(tree).find((n) => n.props?.key === `row-${key}`);
// The row whose own button carries this label.
const rowLabeled = (tree, label) => walk(tree).find((n) => String(n.props?.key).startsWith('row-')
  && (n.props.children ?? []).some((c) => c?.type === 'Button' && c.props.label === label));
// A tool call still running: `end(answer)` lets it finish and resolves to what the hooks return.
const later = (eng, e) => {
  let finish;
  const done = eng.raise('tool.call', e, () => new Promise((resolve) => { finish = resolve; }));
  return { end: (answer) => { finish(answer); return done; } };
};
// What TaskCreate and TaskUpdate answer, as Claude Code 2.1.296 does.
const created = (id, subject) => ({ result: { task: { id, subject } }, text: `Task #${id} created successfully: ${subject}` });
const updated = (taskId, statusChange) => ({ result: { success: true, taskId, updatedFields: statusChange ? ['status'] : [], statusChange } });

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
  assert.equal(eng.seen.opened.length, 2, 'on leaves a shown pane as it is');
  assert.ok(eng.seen.opened.every((p) => p.focus === undefined), 'a pane it opens leaves the keyboard at the prompt');
});

test('show and on raise the pane from behind another plugin\'s pane, and off closes it there', async () => {
  const eng = engine();
  const run = (args) => eng.raise('command.run', { command: 'progress', args });
  await run('');
  eng.cover();
  await run('show');
  assert.equal(eng.open.get(PANE).isShown, true, 'show raises a pane it cannot be seeing');
  assert.equal(eng.seen.opened.at(-1).focus, true, 'a pane behind another rises only with the keyboard');
  eng.cover();
  await run('on');
  assert.equal(eng.open.get(PANE).isShown, true, 'on raises it too');
  assert.equal(eng.seen.closed.length, 0);
  eng.cover();
  await run('off');
  assert.ok(!eng.open.has(PANE));
});

test('an argument it does not know answers with the usage', async () => {
  const eng = engine();
  assert.match((await eng.raise('command.run', { command: 'progress', args: 'toggle' })).text, /사용법: \/progress/);
  assert.equal(eng.open.size, 0);
});

test('the markdown command\'s name runs the same toggle here, so it never expands into a model turn', async () => {
  const eng = engine();
  let expanded = false;
  await eng.raise('command.run', { command: 'banker:progress', args: '' }, async () => { expanded = true; return {}; });
  assert.ok(eng.open.has(PANE));
  assert.equal(expanded, false);
});

test('a command whose hook fails says so, and the markdown fallback beneath never answers', async () => {
  for (const command of ['progress', 'banker:progress']) {
    const eng = engine();
    eng.$.ui.panes = async () => { throw new Error('pane list gone'); };
    let expanded = false;
    const r = await eng.raise('command.run', { command, args: '' }, async () => { expanded = true; return {}; });
    assert.match(r.text, /^진행 상황 패널을 바꾸지 못했습니다\(pane list gone\)/, command);
    assert.equal(expanded, false, command);
  }
});

test('with nothing seen yet the pane shows one idle step and says how steps appear', async () => {
  const eng = engine();
  const tree = await eng.draw();
  assert.deepEqual(labels(tree), ['진행 중인 작업 없음']);
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

test('a prompt whose end never came is done once the next starts', async () => {
  const eng = engine();
  await eng.raise('turn.start', { turnId: 't1', text: '하나' });
  await eng.raise('turn.start', { turnId: 't2', text: '둘' });
  const tree = await eng.draw();
  assert.match(textOf(rowOf(tree, 't-t1')), /완료/);
  assert.match(textOf(rowOf(tree, 't-t2')), /진행 중/);
});

test('a prompt that was interrupted, refused or ended by an error says how it ended', async () => {
  const eng = engine();
  const ends = [['t1', 'aborted', /중단됨/], ['t2', 'refusal', /거절됨/], ['t3', 'error', /오류로 끝남/]];
  for (const [turnId, reason] of ends) {
    await eng.raise('turn.start', { turnId, text: turnId });
    await eng.raise('turn.complete', { turnId, reason, isAborted: reason === 'aborted' });
  }
  const tree = await eng.draw();
  for (const [turnId, , word] of ends) assert.match(textOf(rowOf(tree, `t-${turnId}`)), word);
});

test('a step\'s time runs from its start to its end, in whole seconds', () => {
  const s = freshState();
  const said = (key, now) => { s.selected = key; return describe(s, now); };
  startTurn(s, { turnId: 't1', text: '하나' }, 0);
  startTurn(s, { turnId: 't2', text: '둘' }, 10_000);
  assert.match(said('t-t1', 600_000), /완료, 10초,/, 'a prompt the next one closed ends where the next began');
  endTurn(s, { turnId: 't2', reason: 'answer' }, 129_600);
  assert.match(said('t-t2', 600_000), /완료, 2분 0초,/, 'seconds are rounded before minutes are taken');
  noteTaskTool(s, { tool: 'TaskCreate', subject: '설계' }, created('1', '설계'), 0);
  assert.doesNotMatch(said('k-1', 5_000), /초/, 'a task not yet started has no time');
  noteTaskTool(s, { tool: 'TaskUpdate', taskId: '1', status: 'in_progress' }, updated('1', { from: 'pending', to: 'in_progress' }), 1_000);
  noteTaskTool(s, { tool: 'TaskUpdate', taskId: '1', status: 'completed' }, updated('1', { from: 'in_progress', to: 'completed' }), 31_000);
  assert.match(said('k-1', 99_000), /완료, 30초,/);
});

test('the list keeps the newest 50 prompts', async () => {
  const eng = engine();
  for (let i = 0; i < 52; i++) await eng.raise('turn.start', { turnId: `t${i}`, text: `요청 ${i}` });
  const names = labels(await eng.draw());
  assert.equal(names.length, 50);
  assert.deepEqual([names[0], names.at(-1)], ['요청 2', '요청 51']);
});

test('a step keeps its newest 200 calls and counts them all', async () => {
  const eng = engine();
  await eng.raise('turn.start', { turnId: 't1', text: '많이' });
  for (let i = 0; i < 205; i++) await eng.tool({ tool: 'Bash', command: `c ${i}` }, i < 3 ? { isError: true, result: {} } : { result: {} });
  let tree = await eng.draw();
  button(tree, '▸').props.onPress({});
  button(tree, '많이').props.onPress({});
  tree = await eng.draw();
  assert.match(textOf(tree), /앞의 170개는 줄였습니다/);
  assert.match(textOf(about(tree)), /도구 호출 205회\(실패 3회\)\.$/);
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
  assert.deepEqual(labels(await eng.draw()), ['진행 중인 작업 없음']);
});

test('a new session (session.start) starts from an empty list', async () => {
  const eng = engine();
  await eng.raise('turn.start', { turnId: 't1', text: '작업' });
  await eng.tool({ tool: 'TodoWrite', todos: [{ content: 'A 하기', status: 'in_progress', activeForm: 'A 하는 중' }] });
  await eng.raise('session.start', { cwd: '/w' });
  assert.deepEqual(labels(await eng.draw()), ['진행 중인 작업 없음']);
});

test('a tool call seen before any prompt starts the one step for the work at hand', async () => {
  const eng = engine();
  await eng.tool({ tool: 'Glob', pattern: '**/*.mjs' });
  const tree = await eng.draw();
  assert.deepEqual(labels(tree), ['▸', '지금 하는 작업']);
  assert.match(textOf(rowOf(tree, 't-now')), /진행 중/);
});

test('the step for work already under way ends with the turn it belongs to', async () => {
  const eng = engine();
  await eng.tool({ tool: 'Glob', pattern: '**/*.mjs' });
  await eng.raise('turn.complete', { turnId: 'u1', reason: 'answer' });
  assert.match(textOf(rowOf(await eng.draw(), 't-now')), /완료/);
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
  await eng.tool({ tool: 'TaskCreate', subject: '설계', description: '구조를 정한다' }, created('1', '설계'));
  await eng.tool({ tool: 'TaskCreate', subject: '구현', description: '코드를 쓴다' }, created('2', '구현'));
  await eng.tool({ tool: 'TaskUpdate', taskId: '1', status: 'in_progress', activeForm: '설계하는 중' }, updated('1', { from: 'pending', to: 'in_progress' }));
  await eng.tool({ tool: 'Read', file_path: 'a.md' });
  let tree = await eng.draw();
  assert.deepEqual(labels(tree), ['▸', '설계', '구현']);
  assert.match(textOf(rowOf(tree, 'k-2')), /대기/);
  button(tree, '설계').props.onPress({});
  tree = await eng.draw();
  assert.match(textOf(about(tree)), /^구조를 정한다\. 진행 중\(설계하는 중\), \d+초, 도구 호출 1회\.$/);
  button(tree, '▸').props.onPress({});
  assert.deepEqual(labels(await eng.draw()), ['▾', '설계', 'Read a.md', '구현'], 'task tools are not calls');
  await eng.tool({ tool: 'TaskUpdate', taskId: '2', status: 'deleted' }, updated('2', { from: 'pending', to: 'deleted' }));
  assert.equal(button(await eng.draw(), '구현'), undefined);
});

test('TaskUpdate changes a step\'s title, description and active form', async () => {
  const eng = engine();
  await eng.tool({ tool: 'TaskCreate', subject: '설계', description: '구조' }, created('1', '설계'));
  await eng.tool({ tool: 'TaskUpdate', taskId: '1', subject: '새 설계', description: '새 구조를 정한다', activeForm: '새로 설계하는 중', status: 'in_progress' },
    updated('1', { from: 'pending', to: 'in_progress' }));
  const tree = await eng.draw();
  assert.deepEqual(labels(tree), ['새 설계']);
  button(tree, '새 설계').props.onPress({});
  assert.match(textOf(about(await eng.draw())), /^새 구조를 정한다\. 진행 중\(새로 설계하는 중\), \d+초, 도구 호출 0회\.$/);
});

test('a task call the engine refused or that failed changes no step', async () => {
  const eng = engine();
  await eng.tool({ tool: 'TaskCreate', subject: '설계', description: 'x' }, { deny: 'not now' });
  assert.deepEqual(labels(await eng.draw()), ['진행 중인 작업 없음']);
  await eng.tool({ tool: 'TaskCreate', subject: '설계', description: 'x' }, created('1', '설계'));
  await eng.tool({ tool: 'TaskUpdate', taskId: '1', status: 'completed' }, { deny: 'not now' });
  await eng.tool({ tool: 'TaskUpdate', taskId: '1', status: 'completed' }, { isError: true, result: {} });
  assert.match(textOf(rowOf(await eng.draw(), 'k-1')), /대기/);
  await eng.tool({ tool: 'TodoWrite', todos: [{ content: 'Z', status: 'pending', activeForm: 'Z' }] }, { deny: 'not now' });
  assert.deepEqual(labels(await eng.draw()), ['설계'], 'a refused TodoWrite does not replace the steps');
});

test('a TaskUpdate that reports no success changes no step', async () => {
  const eng = engine();
  await eng.tool({ tool: 'TaskCreate', subject: '설계' }, created('1', '설계'));
  const failed = (error) => ({ result: { success: false, taskId: '1', updatedFields: [], error } });
  await eng.tool({ tool: 'TaskUpdate', taskId: '1', status: 'completed' }, failed('a TaskCompleted hook blocked it'));
  await eng.tool({ tool: 'TaskUpdate', taskId: '1', status: 'deleted' }, failed('Failed to delete task'));
  assert.match(textOf(rowOf(await eng.draw(), 'k-1')), /대기/);
});

test('TaskList brings in a list made before this module saw it, in its order, and drops what it no longer names', async () => {
  const eng = engine();
  await eng.tool({ tool: 'TaskCreate', subject: '옛 작업' }, created('9', '옛 작업'));
  await eng.tool({ tool: 'TaskCreate', subject: '구현' }, created('2', '구현'));
  await eng.tool({ tool: 'TaskUpdate', taskId: '2', status: 'in_progress' }, updated('2', { from: 'pending', to: 'in_progress' }));
  await eng.tool({ tool: 'Edit', file_path: 'src/b.js' });
  const tasks = [
    { id: '1', subject: '설계', status: 'completed', blockedBy: [] },
    { id: '2', subject: '구현', status: 'in_progress', blockedBy: [] },
    { id: '3', subject: '시험', status: 'pending', blockedBy: ['2'] },
  ];
  await eng.tool({ tool: 'TaskList' }, { result: { tasks } });
  await eng.tool({ tool: 'Read', file_path: 'src/a.js' });
  const tree = await eng.draw();
  assert.deepEqual(labels(tree), ['설계', '▸', '구현', '시험']);
  assert.match(textOf(rowOf(tree, 'k-2')), /진행 중/);
  button(tree, '구현').props.onPress({});
  assert.match(textOf(about(await eng.draw())), /도구 호출 2회\.$/, 'a task it held keeps its calls');
});

test('a list with work left stays the steps across prompts', async () => {
  const eng = engine();
  await eng.raise('turn.start', { turnId: 't1', text: '만들어 줘' });
  await eng.tool({ tool: 'TaskCreate', subject: '설계' }, created('1', '설계'));
  await eng.tool({ tool: 'TaskCreate', subject: '구현' }, created('2', '구현'));
  await eng.tool({ tool: 'TaskUpdate', taskId: '1', status: 'completed' }, updated('1', { from: 'pending', to: 'completed' }));
  await eng.raise('turn.start', { turnId: 't2', text: '계속해 줘' });
  assert.deepEqual(labels(await eng.draw()), ['설계', '구현']);
});

test('TaskGet adds or updates the task it reads, and a task it cannot find leaves the list', async () => {
  const eng = engine();
  const task = { id: '3', subject: '시험', description: '시험을 돌린다', status: 'pending', blocks: [], blockedBy: [] };
  await eng.tool({ tool: 'TaskGet', taskId: '3' }, { result: { task } });
  let tree = await eng.draw();
  button(tree, '시험').props.onPress({});
  assert.match(textOf(about(await eng.draw())), /^시험을 돌린다\. 대기, 도구 호출 0회\.$/);
  await eng.tool({ tool: 'TaskGet', taskId: '3' }, { result: { task: { ...task, subject: '전체 시험', status: 'in_progress' } } });
  tree = await eng.draw();
  assert.deepEqual(labels(tree), ['전체 시험']);
  assert.match(textOf(rowOf(tree, 'k-3')), /진행 중/);
  await eng.tool({ tool: 'TaskGet', taskId: '3' }, { result: { task: null } });
  assert.deepEqual(labels(await eng.draw()), ['진행 중인 작업 없음']);
});

test('a TaskUpdate on a task it never saw adds it while that task is not done', async () => {
  const eng = engine();
  await eng.tool({ tool: 'TaskUpdate', taskId: '4', status: 'in_progress' }, updated('4', { from: 'pending', to: 'in_progress' }));
  await eng.tool({ tool: 'TaskUpdate', taskId: '5', status: 'completed' }, updated('5', { from: 'in_progress', to: 'completed' }));
  const tree = await eng.draw();
  assert.deepEqual(labels(tree), ['작업 #4']);
  assert.match(textOf(rowOf(tree, 'k-4')), /진행 중/);
});

test('a finished task list stays until the next prompt, which is a step again', async () => {
  const eng = engine();
  await eng.raise('turn.start', { turnId: 't1', text: '만들어 줘' });
  await eng.tool({ tool: 'TaskCreate', subject: '설계' }, created('1', '설계'));
  await eng.tool({ tool: 'TaskUpdate', taskId: '1', status: 'completed' }, updated('1', { from: 'pending', to: 'completed' }));
  assert.deepEqual(labels(await eng.draw()), ['설계'], 'the finished list shows what was done');
  await eng.raise('turn.start', { turnId: 't2', text: '다음 요청' });
  await eng.tool({ tool: 'Read', file_path: 'b.md' });
  const tree = await eng.draw();
  assert.deepEqual(labels(tree), ['만들어 줘', '▸', '다음 요청']);
  assert.match(textOf(rowOf(tree, 't-t2')), /진행 중/);
});

test('a finished TodoWrite list stays until the next prompt, which is a step again', async () => {
  const eng = engine();
  const todos = (status) => [{ content: 'A 하기', status, activeForm: 'A 하는 중' }];
  await eng.raise('turn.start', { turnId: 't1', text: '만들어 줘' });
  await eng.tool({ tool: 'TodoWrite', todos: todos('in_progress') });
  await eng.tool({ tool: 'Bash', command: 'make' });
  await eng.tool({ tool: 'TodoWrite', todos: todos('completed') });
  await eng.raise('turn.complete', { turnId: 't1', reason: 'answer' });
  assert.deepEqual(labels(await eng.draw()), ['▸', 'A 하기']);
  await eng.raise('turn.start', { turnId: 't2', text: '다음 요청' });
  const tree = await eng.draw();
  assert.deepEqual(labels(tree), ['▸', '만들어 줘', '다음 요청']);
  assert.match(textOf(rowOf(tree, 't-t2')), /진행 중/);
});

test('a finished list does not come back from TaskList, TaskGet or TaskUpdate once the next prompt started', async () => {
  const eng = engine();
  const done = { id: '1', subject: '설계', status: 'completed', blockedBy: [] };
  await eng.raise('turn.start', { turnId: 't1', text: '만들어 줘' });
  await eng.tool({ tool: 'TaskCreate', subject: '설계' }, created('1', '설계'));
  await eng.tool({ tool: 'TaskUpdate', taskId: '1', status: 'completed' }, updated('1', { from: 'pending', to: 'completed' }));
  await eng.raise('turn.start', { turnId: 't2', text: '다음 요청' });
  await eng.tool({ tool: 'TaskList' }, { result: { tasks: [done] } });
  await eng.tool({ tool: 'TaskGet', taskId: '1' }, { result: { task: { ...done, description: '구조', blocks: [] } } });
  await eng.tool({ tool: 'TaskUpdate', taskId: '1', status: 'completed' }, updated('1'));
  assert.deepEqual(labels(await eng.draw()), ['만들어 줘', '다음 요청']);
});

test('a TaskList or TaskGet that read the list before an update landed does not undo it', async () => {
  const eng = engine();
  await eng.raise('turn.start', { turnId: 't1', text: '만들어 줘' });
  await eng.tool({ tool: 'TaskCreate', subject: '설계' }, created('1', '설계'));
  await eng.tool({ tool: 'TaskUpdate', taskId: '1', status: 'in_progress' }, updated('1', { from: 'pending', to: 'in_progress' }));
  const stale = { id: '1', subject: '설계', status: 'in_progress', blockedBy: [] };
  const listing = later(eng, { tool: 'TaskList' });
  const reading = later(eng, { tool: 'TaskGet', taskId: '1' });
  await eng.tool({ tool: 'TaskUpdate', taskId: '1', status: 'completed' }, updated('1', { from: 'in_progress', to: 'completed' }));
  await listing.end({ result: { tasks: [stale] } });
  await reading.end({ result: { task: { ...stale, description: '구조', blocks: [] } } });
  assert.match(textOf(rowOf(await eng.draw(), 'k-1')), /완료/);
  await eng.raise('turn.start', { turnId: 't2', text: '다음 요청' });
  assert.deepEqual(labels(await eng.draw()), ['만들어 줘', '다음 요청']);
});

test('a TaskList that read the list before another agent created a task does not drop that task', async () => {
  const eng = engine();
  await eng.tool({ tool: 'TaskCreate', subject: '설계' }, created('1', '설계'));
  const listing = later(eng, { tool: 'TaskList', agentId: 'a1' });
  await eng.tool({ tool: 'TaskCreate', subject: '구현' }, created('2', '구현'));
  await listing.end({ result: { tasks: [{ id: '1', subject: '설계', status: 'pending', blockedBy: [] }] } });
  assert.deepEqual(labels(await eng.draw()), ['설계', '구현']);
});

test('a task call that ends after /clear leaves the new conversation\'s list alone', async () => {
  const eng = engine();
  const listing = later(eng, { tool: 'TaskList' });
  await eng.raise('session.end', { reason: 'clear' });
  await listing.end({ result: { tasks: [{ id: '1', subject: '옛 작업', status: 'pending', blockedBy: [] }] } });
  assert.deepEqual(labels(await eng.draw()), ['진행 중인 작업 없음']);
});

test('a list emptied before the next prompt takes the calls made outside it along', async () => {
  const eng = engine();
  await eng.raise('turn.start', { turnId: 't1', text: '만들어 줘' });
  await eng.tool({ tool: 'TaskCreate', subject: '설계' }, created('1', '설계'));
  await eng.tool({ tool: 'Bash', command: 'make' });
  await eng.tool({ tool: 'TaskUpdate', taskId: '1', status: 'deleted' }, updated('1', { from: 'pending', to: 'deleted' }));
  await eng.raise('turn.start', { turnId: 't2', text: '다시' });
  await eng.tool({ tool: 'TaskCreate', subject: '새 작업' }, created('2', '새 작업'));
  assert.deepEqual(labels(await eng.draw()), ['새 작업']);
});

test('a task back to waiting shows no time, and its time starts again when it does', () => {
  const s = freshState();
  const said = (now) => { s.selected = 'k-1'; return describe(s, now); };
  const update = (status, now) => noteTaskTool(s, { tool: 'TaskUpdate', taskId: '1', status }, updated('1', { from: '', to: status }), now);
  noteTaskTool(s, { tool: 'TaskCreate', subject: '설계' }, created('1', '설계'), 0);
  update('in_progress', 1_000);
  update('pending', 5_000);
  assert.match(said(600_000), /^설계\. 대기, 도구 호출 0회\.$/);
  update('in_progress', 700_000);
  update('completed', 730_000);
  assert.match(said(900_000), /완료, 30초,/);
});

test('TodoWrite lists become steps, and an item keeps its calls while its text stays', async () => {
  const eng = engine();
  const todos = (a, b) => [{ content: 'A 하기', status: a, activeForm: 'A 하는 중' }, { content: 'B 하기', status: b, activeForm: 'B 하는 중' }];
  await eng.tool({ tool: 'TodoWrite', todos: todos('in_progress', 'pending') });
  await eng.tool({ tool: 'Bash', command: 'make' });
  await eng.tool({ tool: 'TodoWrite', todos: todos('completed', 'in_progress') });
  const tree = await eng.draw();
  assert.deepEqual(labels(tree), ['▸', 'A 하기', 'B 하기']);
  assert.match(textOf(rowLabeled(tree, 'A 하기')), /완료/);
  assert.match(textOf(rowLabeled(tree, 'B 하기')), /진행 중/);
});

test('a todo item keeps its row, open and pressed, while items come and go around it', async () => {
  const eng = engine();
  const a = { content: 'A 하기', status: 'in_progress', activeForm: 'A 하는 중' };
  await eng.tool({ tool: 'TodoWrite', todos: [a] });
  await eng.tool({ tool: 'Bash', command: 'make' });
  let tree = await eng.draw();
  button(tree, '▸').props.onPress({});
  button(tree, 'A 하기').props.onPress({});
  await eng.tool({ tool: 'TodoWrite', todos: [{ content: 'N 하기', status: 'pending', activeForm: 'N 하는 중' }, a] });
  tree = await eng.draw();
  assert.deepEqual(labels(tree), ['N 하기', '▾', 'A 하기', 'Bash make']);
  assert.match(textOf(about(tree)), /^A 하기\./);
});

test('a subagent\'s TodoWrite leaves the session\'s list as it is', async () => {
  const eng = engine();
  await eng.tool({ tool: 'TodoWrite', todos: [{ content: 'A 하기', status: 'in_progress', activeForm: 'A 하는 중' }] });
  await eng.tool({ tool: 'TodoWrite', agentId: 'a1', todos: [{ content: 'Z 하기', status: 'pending', activeForm: 'Z 하는 중' }] });
  assert.deepEqual(labels(await eng.draw()), ['A 하기']);
});

test('calls made while no task is in progress go to a step of their own, in progress while they go there', async () => {
  const eng = engine();
  await eng.raise('turn.start', { turnId: 't1', text: '만들어 줘' });
  await eng.tool({ tool: 'TaskCreate', subject: '설계', description: 'x' }, created('1', '설계'));
  await eng.tool({ tool: 'Edit', file_path: '/w/src/app.js' });
  const tree = await eng.draw();
  assert.deepEqual(labels(tree), ['설계', '▸', '작업 목록 밖의 작업']);
  assert.match(textOf(rowOf(tree, 'loose')), /진행 중/);
  await eng.raise('turn.complete', { turnId: 't1', reason: 'answer' });
  assert.match(textOf(rowOf(await eng.draw(), 'loose')), /완료/);
});

test('a task list longer than 50 drops its oldest finished task first, else its oldest', async () => {
  const eng = engine();
  for (let i = 1; i <= 50; i++) await eng.tool({ tool: 'TaskCreate', subject: `작업 ${i}` }, created(String(i), `작업 ${i}`));
  await eng.tool({ tool: 'TaskUpdate', taskId: '7', status: 'completed' }, updated('7', { from: 'pending', to: 'completed' }));
  await eng.tool({ tool: 'TaskCreate', subject: '작업 51' }, created('51', '작업 51'));
  let names = labels(await eng.draw());
  assert.equal(names.length, 50);
  assert.deepEqual([names.includes('작업 7'), names[0], names.at(-1)], [false, '작업 1', '작업 51']);
  await eng.tool({ tool: 'TaskCreate', subject: '작업 52' }, created('52', '작업 52'));
  names = labels(await eng.draw());
  assert.equal(names.length, 50);
  assert.deepEqual([names[0], names.at(-1)], ['작업 2', '작업 52']);
});

test('a TodoWrite list longer than 50 keeps 50, its finished items going first', async () => {
  const eng = engine();
  const todos = Array.from({ length: 52 }, (_, i) => ({ content: `할 일 ${i}`, status: i === 30 ? 'completed' : 'pending', activeForm: 'x' }));
  await eng.tool({ tool: 'TodoWrite', todos });
  const names = labels(await eng.draw());
  assert.equal(names.length, 50);
  assert.deepEqual([names.includes('할 일 30'), names[0], names.at(-1)], [false, '할 일 1', '할 일 51']);
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

test('tool.call takes a catch handler, and a fault in the hook leaves the call as if the hook were absent', async () => {
  const eng = engine();
  const handler = eng.caught('tool.call');
  assert.equal(typeof handler, 'function');
  const next = Object.assign(async () => ({}), { error: { kind: 'throw', message: 'x', budget: 1 }, called: false });
  assert.equal(await handler(eng.$, { tool: 'Bash' }, next), undefined);
  eng.$.ui.invalidate = () => { throw new Error('redraw failed'); };
  assert.deepEqual(await eng.tool({ tool: 'Bash', command: 'ls' }, { result: {}, text: 'ok' }), { result: {}, text: 'ok' });
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

test('control characters in a prompt or an argument never reach the pane', async () => {
  const eng = engine();
  await eng.raise('turn.start', { turnId: 't1', text: '\u001b[31m빨강\u0007 글' });
  await eng.tool({ tool: 'Bash', command: 'printf "\u001b]0;x\u0007"' });
  let tree = await eng.draw();
  button(tree, '▸').props.onPress({});
  button(tree, '[31m빨강 글').props.onPress({});
  tree = await eng.draw();
  assert.doesNotMatch([...labels(tree), textOf(tree)].join(' '), /\p{Cc}/u);
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
