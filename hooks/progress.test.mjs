// Tests for progress.mjs, the /progress pane of banker's mods module.
// Run from the repo root: node --test hooks/progress.test.mjs
// (hooks/progress.engine.test.ts runs the same module inside the engine: claude plugin test <copy>.)
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { TODO_TOOL, callLabel, describe, endTurn, freshState, noteTaskTool, planRead, planTarget, planTouched, readTodos, startTurn, takePlan } from './progress.mjs';
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

// The engine's tool list and tool registration: a registered tool is listed from then on, by its
// full name.
const toolStandIn = (listed, seen) => ({
  list: async () => [...listed].map((name) => ({ name, description: '', mcp: name.startsWith('mcp__') })),
  register: async (spec) => {
    seen.tools.push(spec);
    listed.add(`mcp__banker__${spec.name}`);
    return { tool: `mcp__banker__${spec.name}` };
  },
});

// A read takes the file as it is when the read starts; a held one (the first read of a path in
// `held`) delivers it only once released.
const fsStandIn = (files, held, waiting, seen, kinds) => ({
  stat: async (path) => {
    seen.stats.push(path);
    if (!files.has(path)) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    return { kind: kinds.get(path) ?? 'file', size: String(files.get(path)).length, mtimeMs: 0, isLink: false };
  },
  read: async (path) => {
    seen.reads.push(path);
    const [had, text] = [files.has(path), files.get(path)];
    if (held.delete(path)) await new Promise((resolve) => waiting.set(path, resolve));
    if (!had) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    return text;
  },
});

// The engine's panes and drawing: a new pane is shown, and a pane behind another plugin's pane rises only with `focus`.
const uiStandIn = (open, seen, scrollAnswers) => ({
  panes: async () => [...open].map(([id, p]) => ({ id, title: id, isShown: p.isShown, isFocused: false, isPlaced: true })),
  open: async (p) => { seen.opened.push(p); open.set(p.id, { isShown: !open.has(p.id) || open.get(p.id).isShown || p.focus === true }); },
  close: async (p) => { seen.closed.push(p); open.delete(p.id); },
  invalidate: () => { seen.invalidated += 1; },
  scroll: async (a) => { seen.scrolls.push(a); return scrollAnswers.shift() ?? {}; },
  log: (t) => { seen.logs.push(t); },
  resolve: () => ELEMENTS,
});

// A stand-in for the engine's side: it records what the module registers and calls on `$`,
// keeps the open panes, and raises events through the module's hooks the way the engine does. As
// in Claude Code 2.1.296, `$.ui.open` resolves to nothing, a new pane is shown, and a pane behind
// another plugin's pane rises only with `focus`. `files` holds what `$.fs.read` finds: a path it
// does not hold rejects, as a missing file does. A read of a path in `held` waits for `release`.
// `tools` names the tools the model has besides the ones a plugin registers.
function engine({ files = new Map(), held = new Set(), tools = ['Bash', 'Read', 'Write'], kinds = new Map() } = {}) {
  const listed = new Set(tools);
  const waiting = new Map();
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
  const seen = { registered: [], opened: [], closed: [], invalidated: 0, logs: [], reads: [], stats: [], tools: [], scrolls: [], waits: [] };
  // The engine's timers: a callback runs once the test settles them, as after a wait.
  const timers = [];
  // What a move answers, one per call; past the end, a move that went through.
  const scrollAnswers = [];
  const $ = {
    command: { register: async (spec) => { seen.registered.push(spec); return { command: spec.name }; } },
    tool: toolStandIn(listed, seen),
    session: { version: async () => ({ version: '2.1.296', base: '2.1.296' }) },
    clock: { after: (ms, fn) => { seen.waits.push(ms); timers.push(fn); return { cancel: () => {} }; } },
    fs: fsStandIn(files, held, waiting, seen, kinds),
    ui: uiStandIn(open, seen, scrollAnswers),
  };
  register(on);
  const raise = raiser(hooks, $);
  const tool = (e, answer = { result: {} }) => raise('tool.call', e, async () => {
    if (answer instanceof Error) throw answer;
    return answer;
  });
  const draw = (props) => raise('ui.render', { component: 'Pane', requestId: PANE, surface: 'terminal', props });
  // Another plugin opens a pane in front: this plugin's panes become tabs behind it.
  const cover = () => { for (const p of open.values()) p.isShown = false; };
  const caught = (event) => hooks.find((h) => h.event === event)?.caught;
  // Lets a held read go on, and waits for the hooks that awaited it.
  const release = async (path) => {
    held.delete(path);
    waiting.get(path)?.();
    await new Promise((resolve) => setImmediate(resolve));
  };
  // Runs the timers due, and those they set, until none is left.
  const settle = async () => {
    while (timers.length) await timers.shift()();
  };
  return { $, seen, open, files, held, raise, tool, draw, cover, caught, release, settle, scrollAnswers };
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
// A plan node's row whose own words are exactly these.
const rowSaying = (tree, words) => walk(tree).find((n) => /^row-n/.test(String(n.props?.key))
  && walk(n).some((x) => x.type === 'Text' && x.props.children?.length === 1 && x.props.children[0] === words));
const HINT = '단계나 하위 항목을 누르면 설명이 여기에 나옵니다.';
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

test('/clear (session.end, and no session.start after it) empties the list, and the pane is asked to draw it at once', async () => {
  const eng = engine();
  await eng.raise('turn.start', { turnId: 't1', text: '작업' });
  const asked = eng.seen.invalidated;
  await eng.raise('session.end', { reason: 'clear' });
  assert.ok(eng.seen.invalidated > asked, 'a pane that stays as drawn shows the old list until the next prompt');
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

// The pane follows the step in progress as it draws: a drawing asks for a move (after a wait) when that step changed.
const into = (key) => ({ to: { key }, in: PANE, block: 'nearest' });
const NOT_DRAWN = { deny: 'no element of its own is drawn under that key' };

test('the step in progress is brought into the pane\'s window when it changes, and only then', async () => {
  const eng = engine();
  await eng.raise('command.run', { command: 'progress', args: 'on' });
  const todos = (at) => Array.from({ length: 50 }, (_, i) => ({ content: `단계 ${i + 1}`, status: i + 1 === at ? 'in_progress' : i + 1 < at ? 'completed' : 'pending' }));
  await eng.raise('tool.call', { tool: TODO_TOOL, todos: todos(40) });
  let tree = await eng.draw();
  assert.deepEqual(eng.seen.scrolls, [], 'the move waits');
  await eng.settle();
  assert.deepEqual(eng.seen.scrolls, [into(rowLabeled(tree, '단계 40').props.key)]);
  await eng.raise('tool.call', { tool: TODO_TOOL, todos: todos(40) });
  await eng.tool({ tool: 'Bash', command: 'make' });
  await eng.draw();
  await eng.settle();
  assert.equal(eng.seen.scrolls.length, 1, 'the same step in progress asks for no move');
  await eng.raise('tool.call', { tool: TODO_TOOL, todos: todos(41) });
  tree = await eng.draw();
  await eng.settle();
  assert.deepEqual(eng.seen.scrolls.at(-1), into(rowLabeled(tree, '단계 41').props.key));
  assert.equal(eng.seen.scrolls.length, 2);
});

test('a pane opened again follows the step in progress, which it may hold below the window', async () => {
  const eng = engine();
  await eng.raise('command.run', { command: 'progress', args: 'on' });
  await eng.raise('turn.start', { turnId: 't1', text: '하나' });
  await eng.draw();
  await eng.settle();
  await eng.raise('command.run', { command: 'progress', args: 'off' });
  // an engine may draw the pane before the open answers
  const open = eng.$.ui.open;
  eng.$.ui.open = async (p) => {
    await open(p);
    await eng.draw();
  };
  await eng.raise('command.run', { command: 'progress', args: 'on' });
  await eng.settle();
  assert.deepEqual(eng.seen.scrolls, [into('row-t-t1'), into('row-t-t1')]);
});

test('a move refused because the row is not drawn yet is asked again; a closed pane, or the person\'s own move, ends it', async () => {
  const eng = engine();
  eng.scrollAnswers.push(NOT_DRAWN, NOT_DRAWN);
  await eng.raise('turn.start', { turnId: 't1', text: '하나' });
  await eng.draw();
  await eng.settle();
  assert.equal(eng.seen.scrolls.length, 3, 'asked again until the row was drawn');
  assert.ok(eng.seen.waits.every((ms) => ms > 0), 'each ask waits first');
  await eng.raise('turn.complete', { turnId: 't1', reason: 'answer' });
  for (const deny of ['no-surface: the pane is not open', 'the window moved meanwhile']) {
    const before = eng.seen.scrolls.length;
    eng.scrollAnswers.push({ deny });
    await eng.raise('turn.start', { turnId: `t-${before}`, text: deny });
    await eng.draw();
    await eng.settle();
    await eng.raise('turn.complete', { turnId: `t-${before}`, reason: 'answer' });
    assert.equal(eng.seen.scrolls.length, before + 1, deny);
  }
});

test('a move refused as not drawn yet is asked four times at most', async () => {
  const eng = engine();
  for (let i = 0; i < 10; i++) eng.scrollAnswers.push(NOT_DRAWN);
  await eng.raise('turn.start', { turnId: 't1', text: '하나' });
  await eng.draw();
  await eng.settle();
  assert.equal(eng.seen.scrolls.length, 4);
});

test('Claude Code\'s own task tools bring the step in progress into view too', async () => {
  const eng = engine();
  await eng.tool({ tool: 'TaskCreate', subject: '설계' }, created('1', '설계'));
  await eng.tool({ tool: 'TaskCreate', subject: '구현' }, created('2', '구현'));
  await eng.tool({ tool: 'TaskUpdate', taskId: '2', status: 'in_progress' }, updated('2', { from: 'pending', to: 'in_progress' }));
  await eng.draw();
  await eng.settle();
  assert.deepEqual(eng.seen.scrolls.at(-1), into('row-k-2'));
});

test('a move still waiting when the step in progress changes again, or after /clear, asks for nothing', async () => {
  const eng = engine();
  await eng.tool({ tool: 'TaskCreate', subject: '설계' }, created('1', '설계'));
  await eng.tool({ tool: 'TaskCreate', subject: '구현' }, created('2', '구현'));
  await eng.tool({ tool: 'TaskUpdate', taskId: '1', status: 'in_progress' }, updated('1', { from: 'pending', to: 'in_progress' }));
  await eng.draw();
  await eng.tool({ tool: 'TaskUpdate', taskId: '1', status: 'completed' }, updated('1', { from: 'in_progress', to: 'completed' }));
  await eng.tool({ tool: 'TaskUpdate', taskId: '2', status: 'in_progress' }, updated('2', { from: 'pending', to: 'in_progress' }));
  await eng.draw();
  await eng.settle();
  assert.deepEqual(eng.seen.scrolls.map((a) => a.to.key), ['row-k-2']);
  await eng.raise('turn.start', { turnId: 't1', text: '하나' });
  await eng.raise('session.end', { reason: 'clear' });
  await eng.draw();
  await eng.settle();
  assert.deepEqual(eng.seen.scrolls.map((a) => a.to.key), ['row-k-2'], 'nothing is asked for a list /clear emptied');
});

test('a new prompt\'s step is brought into view as the pane draws it; an engine that lacks the move changes nothing', async () => {
  const eng = engine();
  await eng.raise('turn.start', { turnId: 't1', text: '하나' });
  await eng.draw();
  await eng.settle();
  assert.deepEqual(eng.seen.scrolls, [into('row-t-t1')]);
  await eng.raise('turn.complete', { turnId: 't1', reason: 'answer' });
  delete eng.$.ui.scroll;
  await eng.raise('turn.start', { turnId: 't2', text: '둘' });
  await eng.draw();
  await eng.settle();
  delete eng.$.clock;
  await eng.raise('turn.complete', { turnId: 't2', reason: 'answer' });
  await eng.raise('turn.start', { turnId: 't3', text: '셋' });
  assert.deepEqual(labels(await eng.draw()), ['하나', '둘', '셋']);
});

test('a subagent\'s or a fork\'s turn.start makes no step; its calls go under the step in progress', async () => {
  const eng = engine();
  await eng.raise('turn.start', { turnId: 't1', text: '포크로 pwd 실행해 줘' });
  await eng.tool({ tool: 'Agent', description: 'pwd 실행' });
  await eng.raise('turn.start', { turnId: 'f1', text: 'Bash 로 pwd 를 실행하라', agentId: 'a1' });
  await eng.raise('turn.complete', { turnId: 't1', reason: 'answer' });
  await eng.tool({ tool: 'Bash', command: 'pwd', agentId: 'a1' });
  await eng.raise('turn.complete', { turnId: 'f1', reason: 'answer', agentId: 'a1' });
  let tree = await eng.draw();
  assert.deepEqual(labels(tree), ['▸', '포크로 pwd 실행해 줘']);
  assert.match(textOf(rowOf(tree, 't-t1')), /완료/, 'no step is left running');
  button(tree, '▸').props.onPress({});
  tree = await eng.draw();
  assert.ok(labels(tree).includes('Bash pwd'), labels(tree).join(' | '));
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

test('a TaskList begun before another change still brings in the tasks only it names', async () => {
  const eng = engine();
  await eng.tool({ tool: 'TaskCreate', subject: '설계' }, created('1', '설계'));
  const listing = later(eng, { tool: 'TaskList' });
  await eng.tool({ tool: 'TaskUpdate', taskId: '1', status: 'in_progress' }, updated('1', { from: 'pending', to: 'in_progress' }));
  await listing.end({ result: { tasks: [
    { id: '1', subject: '설계', status: 'pending', blockedBy: [] },
    { id: '7', subject: '다른 세션의 작업', status: 'pending', blockedBy: [] },
  ] } });
  const tree = await eng.draw();
  assert.deepEqual(labels(tree), ['설계', '다른 세션의 작업']);
  assert.match(textOf(rowOf(tree, 'k-1')), /진행 중/, 'the update that landed after the list was read stays');
});

test('of two TaskLists that overlap, the one begun first changes nothing once the later one is in', async () => {
  const eng = engine();
  await eng.tool({ tool: 'TaskCreate', subject: '설계' }, created('1', '설계'));
  const first = later(eng, { tool: 'TaskList', agentId: 'a1' });
  const second = later(eng, { tool: 'TaskList', agentId: 'a2' });
  await second.end({ result: { tasks: [
    { id: '1', subject: '설계', status: 'in_progress', blockedBy: [] },
    { id: '2', subject: '구현', status: 'pending', blockedBy: [] },
  ] } });
  await first.end({ result: { tasks: [{ id: '1', subject: '설계', status: 'pending', blockedBy: [] }] } });
  const tree = await eng.draw();
  assert.deepEqual(labels(tree), ['설계', '구현']);
  assert.match(textOf(rowOf(tree, 'k-1')), /진행 중/);
});

test('a TaskList or TaskGet begun before a delete does not bring the deleted task back', async () => {
  for (const read of [
    { e: { tool: 'TaskList' }, answer: { result: { tasks: [{ id: '1', subject: '설계', status: 'pending', blockedBy: [] }, { id: '2', subject: '구현', status: 'pending', blockedBy: [] }] } } },
    { e: { tool: 'TaskGet', taskId: '1' }, answer: { result: { task: { id: '1', subject: '설계', status: 'pending', blocks: [] } } } },
  ]) {
    const eng = engine();
    await eng.tool({ tool: 'TaskCreate', subject: '설계' }, created('1', '설계'));
    await eng.tool({ tool: 'TaskCreate', subject: '구현' }, created('2', '구현'));
    const reading = later(eng, read.e);
    await eng.tool({ tool: 'TaskUpdate', taskId: '1', status: 'deleted' }, updated('1', { from: 'pending', to: 'deleted' }));
    await reading.end(read.answer);
    assert.deepEqual(labels(await eng.draw()), ['구현'], read.e.tool);
  }
});

test('an update begun before a delete that ends after it does not bring the task back', async () => {
  const eng = engine();
  await eng.tool({ tool: 'TaskCreate', subject: '설계' }, created('1', '설계'));
  await eng.tool({ tool: 'TaskCreate', subject: '구현' }, created('2', '구현'));
  const starting = later(eng, { tool: 'TaskUpdate', taskId: '1', status: 'in_progress' });
  await eng.tool({ tool: 'TaskUpdate', taskId: '1', status: 'deleted' }, updated('1', { from: 'pending', to: 'deleted' }));
  await starting.end(updated('1', { from: 'pending', to: 'in_progress' }));
  assert.deepEqual(labels(await eng.draw()), ['구현']);
});

test('an update with no status begun later does not undo an earlier-begun status update', async () => {
  const eng = engine();
  await eng.tool({ tool: 'TaskCreate', subject: '설계' }, created('1', '설계'));
  const finishing = later(eng, { tool: 'TaskUpdate', taskId: '1', status: 'completed' });
  await eng.tool({ tool: 'TaskUpdate', taskId: '1', owner: 'w' }, { result: { success: true, taskId: '1', updatedFields: ['owner'] } });
  await finishing.end(updated('1', { from: 'pending', to: 'completed' }));
  assert.match(textOf(rowOf(await eng.draw(), 'k-1')), /완료/);
});

test('a TaskCreate that ends after a later-begun update of its task keeps that update\'s status', async () => {
  const eng = engine();
  const creating = later(eng, { tool: 'TaskCreate', subject: '설계' });
  await eng.tool({ tool: 'TaskUpdate', taskId: '1', status: 'in_progress' }, updated('1', { from: 'pending', to: 'in_progress' }));
  await creating.end(created('1', '설계'));
  assert.match(textOf(rowOf(await eng.draw(), 'k-1')), /진행 중/);
});

test('a TaskList begun before a TaskGet changes nothing the TaskGet brought', async () => {
  const eng = engine();
  await eng.tool({ tool: 'TaskCreate', subject: '설계' }, created('1', '설계'));
  const listing = later(eng, { tool: 'TaskList' });
  await eng.tool({ tool: 'TaskGet', taskId: '1' }, { result: { task: { id: '1', subject: '설계', status: 'in_progress', blocks: [] } } });
  await listing.end({ result: { tasks: [{ id: '1', subject: '설계', status: 'pending', blockedBy: [] }] } });
  assert.match(textOf(rowOf(await eng.draw(), 'k-1')), /진행 중/);
});

test('an update with no status of a task the pane does not hold leaves a list begun before it alone', async () => {
  const eng = engine();
  const listing = later(eng, { tool: 'TaskList' });
  await eng.tool({ tool: 'TaskUpdate', taskId: '7', owner: 'w' }, { result: { success: true, taskId: '7', updatedFields: ['owner'] } });
  await listing.end({ result: { tasks: [{ id: '7', subject: '다른 세션의 작업', status: 'pending', blockedBy: [] }] } });
  assert.deepEqual(labels(await eng.draw()), ['다른 세션의 작업']);
});

test('a list or a read begun before a status update shows that update\'s status for a task the pane did not hold', async () => {
  const eng = engine();
  const listing = later(eng, { tool: 'TaskList' });
  await eng.tool({ tool: 'TaskUpdate', taskId: '7', status: 'completed' }, updated('7', { from: 'in_progress', to: 'completed' }));
  await listing.end({ result: { tasks: [
    { id: '7', subject: '다른 세션의 작업', status: 'in_progress', blockedBy: [] },
    { id: '8', subject: '남은 작업', status: 'pending', blockedBy: [] },
  ] } });
  let tree = await eng.draw();
  assert.deepEqual(labels(tree), ['다른 세션의 작업', '남은 작업']);
  assert.match(textOf(rowOf(tree, 'k-7')), /완료/);
  const reading = later(eng, { tool: 'TaskGet', taskId: '9' });
  await eng.tool({ tool: 'TaskUpdate', taskId: '9', status: 'completed' }, updated('9', { from: 'in_progress', to: 'completed' }));
  await reading.end({ result: { task: { id: '9', subject: '또 다른 작업', status: 'in_progress', blocks: [] } } });
  tree = await eng.draw();
  assert.ok(!labels(tree).includes('또 다른 작업'), 'a read older than the completion does not bring the task back as in progress');
});

test('of two TaskUpdates on one task, the one begun later stands whichever ends first', async () => {
  const eng = engine();
  await eng.tool({ tool: 'TaskCreate', subject: '설계' }, created('1', '설계'));
  const first = later(eng, { tool: 'TaskUpdate', taskId: '1', status: 'in_progress' });
  const second = later(eng, { tool: 'TaskUpdate', taskId: '1', status: 'completed' });
  await second.end(updated('1', { from: 'in_progress', to: 'completed' }));
  await first.end(updated('1', { from: 'pending', to: 'in_progress' }));
  assert.match(textOf(rowOf(await eng.draw(), 'k-1')), /완료/);
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

test('a slash command\'s step is named by the command and its arguments, not by its tags', async () => {
  const eng = engine();
  const text = '<command-message>banker:payload-mon</command-message>\n<command-name>/banker:payload-mon</command-name>\n<command-args>on</command-args>';
  await eng.raise('turn.start', { turnId: 't1', text });
  let tree = await eng.draw();
  assert.deepEqual(labels(tree), ['/banker:payload-mon on']);
  button(tree, '/banker:payload-mon on').props.onPress({});
  tree = await eng.draw();
  assert.match(textOf(about(tree)), /^요청: \/banker:payload-mon on\. 진행 중/);
});

test('a background task\'s notice joins the last prompt\'s step instead of becoming one', async () => {
  const eng = engine();
  const notice = '<task-notification>\n<task-id>abd53</task-id>\n<status>completed</status>\n<summary>Agent "리뷰" completed</summary>\n</task-notification>';
  await eng.raise('turn.start', { turnId: 't1', text: '검토해 줘' });
  await eng.raise('turn.complete', { turnId: 't1', reason: 'answer' });
  await eng.raise('turn.start', { turnId: 't2', text: notice });
  await eng.tool({ tool: 'Read', file_path: '/w/review.md' });
  let tree = await eng.draw();
  assert.deepEqual(labels(tree), ['▸', '검토해 줘'], 'no step for the notice');
  assert.match(textOf(rowOf(tree, 't-t1')), /진행 중/, 'the step runs again');
  button(tree, '▸').props.onPress({});
  tree = await eng.draw();
  assert.deepEqual(labels(tree), ['▾', '검토해 줘', '백그라운드 작업 끝남: Agent "리뷰" completed', 'Read w/review.md']);
  await eng.raise('turn.complete', { turnId: 't2', reason: 'answer' });
  assert.match(textOf(rowOf(await eng.draw(), 't-t1')), /완료/, 'the notice\'s turn ends the step');
});

test('a notice before any prompt is a step of its own, and a notice leaves an unfinished list as the steps', async () => {
  const eng = engine();
  await eng.raise('turn.start', { turnId: 't1', text: '<task-notification><summary>끝</summary></task-notification>' });
  assert.deepEqual(labels(await eng.draw()), ['▸', '백그라운드 작업 알림']);
  await eng.tool({ tool: 'TaskCreate', subject: '설계' }, created('1', '설계'));
  await eng.raise('turn.start', { turnId: 't2', text: '<task-notification><summary>또</summary></task-notification>' });
  assert.deepEqual(labels(await eng.draw()).filter((l) => !/^[▸▾]$/.test(l)), ['설계']);
});

const PLAN = '/w/.omc/plans/deploy.md';
const PLAN_MD = '# 배포 계획\n\n## 작업 순서\n\n1. 설계\n2. 구현\n3. 검증\n';

test('a plan file the session writes shows above the steps as a tree, its sections folded', async () => {
  const eng = engine({ files: new Map([[PLAN, PLAN_MD]]) });
  await eng.raise('turn.start', { turnId: 't1', text: '계획을 세워 줘' });
  await eng.tool({ tool: 'Write', file_path: PLAN, content: PLAN_MD });
  let tree = await eng.draw();
  assert.deepEqual(labels(tree).slice(0, 4), ['▾', '계획: 배포 계획', '▸', '작업 순서'], 'the section is folded at first');
  assert.match(textOf(rowOf(tree, 'plan')), /3단계/);
  assert.ok(!rowSaying(tree, '설계'), 'what a folded section holds stays out');
  assert.ok(labels(tree).includes('계획을 세워 줘'), 'the prompts stay below the plan');
  button(tree, '작업 순서').props.onPress({});
  tree = await eng.draw();
  assert.deepEqual(labels(tree).slice(2, 4), ['▾', '작업 순서']);
  assert.match(textOf(rowSaying(tree, '설계')), /1\. 설계/);
  assert.ok(rowSaying(tree, '구현') && rowSaying(tree, '검증'));
  button(tree, '계획: 배포 계획').props.onPress({});
  tree = await eng.draw();
  assert.match(textOf(about(tree)), /^계획 파일: \.omc\/plans\/deploy\.md\. 단계 3개\.$/);
  button(tree, '▾').props.onPress({});
  assert.deepEqual(labels(await eng.draw()).slice(0, 3), ['▸', '계획: 배포 계획', '▸'], 'the plan\'s arrow folds the whole plan');
});

test('a plan with states counts what is done, and the newest plan file the session touched wins', async () => {
  const prd = '/w/.omc/prd.json';
  const files = new Map([[PLAN, PLAN_MD], [prd, JSON.stringify({ title: '백업', stories: [{ title: 'A', passes: true }, { title: 'B', passes: false }] })]]);
  const eng = engine({ files });
  await eng.tool({ tool: 'Read', file_path: PLAN });
  await eng.tool({ tool: 'Edit', file_path: prd, old_string: 'a', new_string: 'b' });
  const tree = await eng.draw();
  assert.deepEqual(labels(tree).slice(0, 2), ['▾', '계획: 백업']);
  assert.match(textOf(rowOf(tree, 'plan')), /1\/2 완료/);
  assert.match(textOf(rowSaying(tree, 'A')), /완료/);
  assert.match(textOf(rowSaying(tree, 'B')), /대기/);
});

test('the plan is read again as each turn starts and ends, and a failed read keeps what was read', async () => {
  const eng = engine({ files: new Map([[PLAN, PLAN_MD]]) });
  await eng.tool({ tool: 'Write', file_path: PLAN });
  eng.files.set(PLAN, '# 배포 계획\n- [x] 설계\n- [ ] 구현\n');
  await eng.raise('turn.start', { turnId: 't1', text: '진행해' });
  const tree = await eng.draw();
  assert.deepEqual(labels(tree).slice(1, 2), ['계획: 배포 계획']);
  assert.match(textOf(rowSaying(tree, '설계')), /완료/);
  assert.match(textOf(rowSaying(tree, '구현')), /대기/);
  eng.files.set(PLAN, '# 배포 계획\n- [x] 설계\n- [x] 구현\n');
  await eng.raise('turn.complete', { turnId: 't1', reason: 'answer' });
  assert.match(textOf(rowOf(await eng.draw(), 'plan')), /2\/2 완료/);
  eng.files.delete(PLAN);
  await eng.raise('turn.start', { turnId: 't2', text: '다음' });
  assert.match(textOf(rowOf(await eng.draw(), 'plan')), /2\/2 완료/, 'a missing file keeps the plan as last read');
});

test('a file outside the plan folders, a refused write, and a plan with no steps shown whole without a count', async () => {
  const notes = '/w/notes.md';
  const files = new Map([[notes, '# 메모\n- [ ] a\n'], [PLAN, PLAN_MD], ['/w/.omc/plans/open.md', '메모뿐\n']]);
  const eng = engine({ files });
  await eng.tool({ tool: 'Write', file_path: notes });
  await eng.tool({ tool: 'Write', file_path: PLAN }, { deny: 'no' });
  assert.ok(!labels(await eng.draw()).some((l) => l.startsWith('계획')), 'neither shows a plan');
  assert.ok(!eng.seen.reads.includes(notes), 'a file outside the plan folders is never read');
  await eng.tool({ tool: 'Write', file_path: '/w/.omc/plans/open.md' });
  let tree = await eng.draw();
  assert.deepEqual(labels(tree).slice(0, 2), ['▾', '계획: open.md']);
  assert.equal(textOf(rowOf(tree, 'plan')), '계획: open.md', 'no count where no steps are found');
  assert.ok(rowSaying(tree, '메모뿐'));
  button(tree, '계획: open.md').props.onPress({});
  tree = await eng.draw();
  assert.equal(textOf(about(tree)), '계획 파일: .omc/plans/open.md.');
});

test('a long plan shows its first 300 rows and says how many more there are; /clear drops the plan', async () => {
  const md = `# 긴 계획\n${Array.from({ length: 325 }, (_, i) => `- [ ] 단계 ${i + 1}`).join('\n')}\n`;
  const eng = engine({ files: new Map([[PLAN, md]]) });
  await eng.tool({ tool: 'Write', file_path: PLAN });
  const tree = await eng.draw();
  assert.ok(rowSaying(tree, '단계 300') && !rowSaying(tree, '단계 301'));
  assert.match(textOf(tree), /외 25줄/);
  await eng.raise('session.end', { reason: 'clear' });
  assert.ok(!labels(await eng.draw()).some((l) => l.startsWith('계획')));
});

test('a step\'s title is cut to the pane\'s width, a plan node\'s words wrap with its state kept whole beside them', async () => {
  const eng = engine({ files: new Map([[PLAN, `# 계획\n- [ ] ${'가'.repeat(40)}\n`]]) });
  await eng.raise('turn.start', { turnId: 't1', text: `${'나'.repeat(30)} 끝` });
  await eng.tool({ tool: 'Write', file_path: PLAN });
  button(await eng.draw(), '▸').props.onPress({});
  const tree = await eng.draw({ bodyColumns: 40 });
  const cells = (t) => [...t].reduce((n, c) => n + (/[ᄀ-ᅟ가-힣]/.test(c) ? 2 : 1), 0);
  const step = labels(tree).find((l) => l.startsWith('나'));
  assert.ok(step.endsWith('…') && cells(step) <= 40 - 2 - 1 - cells('진행 중'), step);
  const planned = rowSaying(tree, '가'.repeat(40));
  assert.ok(planned, 'the words are whole');
  assert.equal(walk(planned).find((n) => n.type === 'Text' && n.props.children[0] === '가'.repeat(40)).props.wrap, 'wrap');
  const state = planned.props.children.at(-1);
  assert.equal(state.type, 'Box');
  assert.equal(state.props.flexShrink, 0, 'the state keeps its width');
  assert.equal(textOf(state), '대기');
  const call = labels(tree).find((l) => l.startsWith('Write'));
  assert.ok(cells(call) <= 40 - 4, call);
  const callRow = rowLabeled(tree, call);
  assert.equal(callRow.props.children.length, 1, 'a call that went through has no empty state beside it to take a gap');
  assert.equal(labels(await eng.draw()).find((l) => l.startsWith('나')), `${'나'.repeat(30)} 끝`, 'no width, no cut beyond 60 characters');
});

test('a file that is no plan leaves the plan, and the plan\'s file is still read again', async () => {
  const other = '/w/.omc/prd.json';
  const eng = engine({ files: new Map([[PLAN, PLAN_MD], [other, '{"notes":[]}']]) });
  await eng.tool({ tool: 'Write', file_path: PLAN });
  await eng.tool({ tool: 'Read', file_path: other });
  await eng.tool({ tool: 'Read', file_path: '/w/.omc/plans/gone.md' });
  assert.deepEqual(labels(await eng.draw()).slice(1, 2), ['계획: 배포 계획']);
  eng.files.set(PLAN, '# 배포 계획\n- [x] 설계\n- [ ] 구현\n');
  await eng.raise('turn.start', { turnId: 't1', text: '다음' });
  assert.match(textOf(rowOf(await eng.draw(), 'plan')), /1\/2 완료/);
});

test('a read that a newer plan touch overtook changes nothing', async () => {
  const b = '/w/.omc/plans/b.md';
  const eng = engine({ files: new Map([[PLAN, PLAN_MD], [b, '# 새 계획\n- [ ] x\n']]), held: new Set([PLAN]) });
  const first = eng.tool({ tool: 'Write', file_path: PLAN });
  await new Promise((resolve) => setImmediate(resolve));
  await eng.tool({ tool: 'Write', file_path: b });
  await eng.release(PLAN);
  await first;
  assert.deepEqual(labels(await eng.draw()).slice(1, 2), ['계획: 새 계획']);
});

test('a plan file whose items are not what a plan holds never breaks the hooks or leaves a step running', async () => {
  const prd = '/w/.omc/prd.json';
  const eng = engine({ files: new Map([[prd, JSON.stringify({ userStories: [null, { id: 'US-9', title: { a: 1 } }] })]]) });
  await eng.raise('turn.start', { turnId: 't1', text: '진행' });
  await eng.tool({ tool: 'Edit', file_path: prd });
  await eng.raise('turn.complete', { turnId: 't1', reason: 'answer' });
  const tree = await eng.draw();
  assert.deepEqual(labels(tree).slice(1, 2), ['계획: prd.json']);
  assert.ok(rowSaying(tree, 'US-9'));
  assert.match(textOf(rowOf(tree, 't-t1')), /완료/);
});

test('a notice keeps the prompt\'s own end and time, and a failed task says so', async (t) => {
  let clock = 0;
  t.mock.method(Date, 'now', () => clock);
  const eng = engine();
  await eng.raise('turn.start', { turnId: 't1', text: '검토해 줘' });
  clock = 30_000;
  await eng.raise('turn.complete', { turnId: 't1', reason: 'answer' });
  clock = 600_000;
  await eng.raise('turn.start', { turnId: 't2', text: '<task-notification>\n<status>failed</status>\n<summary>Agent "검토" failed: 시간 초과로 멈춤</summary>\n</task-notification>' });
  let tree = await eng.draw();
  assert.match(textOf(rowOf(tree, 't-t1')), /진행 중/);
  clock = 635_000;
  await eng.raise('turn.complete', { turnId: 't2', reason: 'aborted' });
  tree = await eng.draw();
  button(tree, '검토해 줘').props.onPress({});
  button(tree, '▸').props.onPress({});
  tree = await eng.draw();
  assert.match(textOf(about(tree)), /완료, 30초, 도구 호출 0회\.$/, 'the prompt\'s own end and time stay');
  const row = labels(tree).find((l) => l.startsWith('백그라운드 작업 실패'));
  assert.ok(row, labels(tree).join(' | '));
  assert.match(textOf(rowLabeled(tree, row)), /실패/);
  button(tree, row).props.onPress({});
  assert.equal(textOf(about(await eng.draw())), '백그라운드 작업 실패: Agent "검토" failed: 시간 초과로 멈춤.');
});

test('a notice that starts before the prompt\'s turn ends leaves no step running once both end', async () => {
  const eng = engine();
  await eng.raise('turn.start', { turnId: 't1', text: '하나' });
  await eng.raise('turn.start', { turnId: 't2', text: '<task-notification><status>completed</status><summary>끝</summary></task-notification>' });
  await eng.raise('turn.complete', { turnId: 't1', reason: 'answer' });
  assert.match(textOf(rowOf(await eng.draw(), 't-t1')), /진행 중/, 'the notice still runs');
  await eng.raise('turn.complete', { turnId: 't2', reason: 'answer' });
  assert.match(textOf(rowOf(await eng.draw(), 't-t1')), /완료/);
});

test('a notice\'s turn stopped by Esc says so under the step, and the step keeps its own state', async () => {
  const eng = engine();
  await eng.raise('turn.start', { turnId: 't1', text: '검토해 줘' });
  await eng.raise('turn.complete', { turnId: 't1', reason: 'answer' });
  await eng.raise('turn.start', { turnId: 't2', text: '<task-notification><status>completed</status><summary>끝</summary></task-notification>' });
  await eng.raise('turn.complete', { turnId: 't2', reason: 'aborted' });
  let tree = await eng.draw();
  assert.match(textOf(rowOf(tree, 't-t1')), /완료/, 'the step keeps its own state');
  button(tree, '▸').props.onPress({});
  tree = await eng.draw();
  assert.ok(labels(tree).includes('알림 처리 중단됨'), labels(tree).join(' | '));
});

test('a teammate\'s message joins the step, another session\'s is a step of its own', async () => {
  const eng = engine();
  await eng.raise('turn.start', { turnId: 't1', text: '팀으로 해' });
  await eng.raise('turn.start', { turnId: 't2', text: '<teammate-message teammate_id="r1">\n리뷰 끝\n</teammate-message>' });
  await eng.raise('turn.start', { turnId: 't3', text: '<cross-session-message from="w">\n테스트 돌려 줘\n</cross-session-message>' });
  let tree = await eng.draw();
  assert.deepEqual(labels(tree), ['▸', '팀으로 해', '[다른 세션] 테스트 돌려 줘']);
  button(tree, '▸').props.onPress({});
  tree = await eng.draw();
  assert.ok(labels(tree).includes('팀원 메시지: 리뷰 끝'));
});

test('a reviewer agent reading a plan does not make it the plan, an agent writing one does', async () => {
  const b = '/w/.omc/plans/b.md';
  const eng = engine({ files: new Map([[PLAN, PLAN_MD], [b, '# 다른 계획\n- [ ] x\n']]) });
  await eng.tool({ tool: 'Write', file_path: PLAN });
  await eng.tool({ tool: 'Read', file_path: b, agentId: 'a1' });
  assert.deepEqual(labels(await eng.draw()).slice(1, 2), ['계획: 배포 계획']);
  await eng.tool({ tool: 'Write', file_path: b, agentId: 'a1' });
  assert.deepEqual(labels(await eng.draw()).slice(1, 2), ['계획: 다른 계획']);
});

test('another plan file starts folded, a section of the same name too, and its title is no longer pressed', async () => {
  const b = '/w/.omc/plans/b.md';
  const eng = engine({ files: new Map([[PLAN, PLAN_MD], [b, '# 다른 계획\n## 작업 순서\n- [ ] 엉뚱한 단계\n']]) });
  await eng.tool({ tool: 'Write', file_path: PLAN });
  const tree = await eng.draw();
  button(tree, '작업 순서').props.onPress({});
  button(tree, '계획: 배포 계획').props.onPress({});
  await eng.tool({ tool: 'Write', file_path: b });
  const after = await eng.draw();
  assert.equal(textOf(about(after)), HINT);
  assert.ok(!rowSaying(after, '엉뚱한 단계'));
});

test('the plan\'s title is drawn bold, and a long plan counts the steps past the first 50', async () => {
  const md = `# 긴 계획\n${Array.from({ length: 120 }, (_, i) => `- [${i < 50 ? 'x' : ' '}] 단계 ${i + 1}`).join('\n')}\n`;
  const eng = engine({ files: new Map([[PLAN, md]]) });
  await eng.tool({ tool: 'Write', file_path: PLAN });
  const tree = await eng.draw();
  const head = button(tree, '계획: 긴 계획');
  assert.ok(walk(head).some((n) => n.type === 'Text' && n.props.bold === true), 'a bold Text inside the Button');
  assert.match(textOf(rowOf(tree, 'plan')), /50\/120 완료/);
  assert.ok(rowSaying(tree, '단계 120') && !/외 \d+줄/.test(textOf(tree)), '120 rows fit under 300');
});

test('a plan whose read lands after a file that is no plan still becomes the plan', async () => {
  const other = '/w/.omc/prd.json';
  const eng = engine({ files: new Map([[PLAN, PLAN_MD], [other, '{"notes":[]}']]), held: new Set([PLAN]) });
  const first = eng.tool({ tool: 'Read', file_path: PLAN });
  await new Promise((resolve) => setImmediate(resolve));
  await eng.tool({ tool: 'Read', file_path: other });
  await eng.release(PLAN);
  await first;
  assert.deepEqual(labels(await eng.draw()).slice(1, 2), ['계획: 배포 계획']);
});

test('a read again that lands after a newer write of the plan does not undo it', async () => {
  const eng = engine({ files: new Map([[PLAN, '# 배포 계획\n- [ ] 설계\n- [ ] 구현\n']]) });
  await eng.tool({ tool: 'Write', file_path: PLAN });
  eng.held.add(PLAN);
  const ending = eng.raise('turn.complete', { turnId: 't0', reason: 'answer' });
  await new Promise((resolve) => setImmediate(resolve));
  eng.files.set(PLAN, '# 배포 계획\n- [x] 설계\n- [x] 구현\n');
  await eng.tool({ tool: 'Edit', file_path: PLAN, agentId: 'a1' });
  assert.match(textOf(rowOf(await eng.draw(), 'plan')), /2\/2 완료/);
  await eng.release(PLAN);
  await ending;
  assert.match(textOf(rowOf(await eng.draw(), 'plan')), /2\/2 완료/, 'the read of the old text that landed late changed nothing');
});

test('a file with no steps does not take the place of a plan with steps', async () => {
  const seat = '/w/.omc/plans/seat-backbone-1.md';
  const eng = engine({ files: new Map([[PLAN, PLAN_MD], [seat, '# 검토 결과\n의견만 있음\n']]) });
  await eng.tool({ tool: 'Write', file_path: PLAN });
  await eng.tool({ tool: 'Write', file_path: seat, agentId: 'a1' });
  assert.deepEqual(labels(await eng.draw()).slice(1, 2), ['계획: 배포 계획']);
});

test('a prd.json outside .omc becomes the plan when it is a PRD, and leaves the plan alone when it is not', async () => {
  const top = '/w/prd.json';
  const moved = '/srv/omc-state/p1/state/sessions/s1/prd.json';
  const other = '/w/app/prd.json';
  const prd = (title) => JSON.stringify({ title, stories: [{ title: 'A', passes: true }, { title: 'B', passes: false }] });
  const eng = engine({ files: new Map([[top, prd('맨 위 PRD')], [moved, prd('옮긴 PRD')], [other, '{"name":"not a prd"}']]) });
  await eng.tool({ tool: 'Write', file_path: top });
  assert.deepEqual(labels(await eng.draw()).slice(1, 2), ['계획: 맨 위 PRD']);
  await eng.tool({ tool: 'Write', file_path: moved });
  assert.deepEqual(labels(await eng.draw()).slice(1, 2), ['계획: 옮긴 PRD']);
  await eng.tool({ tool: 'Write', file_path: other });
  assert.deepEqual(labels(await eng.draw()).slice(1, 2), ['계획: 옮긴 PRD'], 'a prd.json that is no PRD leaves the plan');
});

test('a review round shows as the plan only while there is no other plan', async () => {
  const review = '/w/.omc/plans/deploy-critic-r1.md';
  const eng = engine({ files: new Map([[PLAN, PLAN_MD], [review, '# 검토 의견\n- [ ] 고칠 것\n']]) });
  await eng.tool({ tool: 'Write', file_path: review });
  assert.deepEqual(labels(await eng.draw()).slice(1, 2), ['계획: 검토 의견'], 'alone, the review round is the plan');
  await eng.tool({ tool: 'Write', file_path: PLAN });
  assert.deepEqual(labels(await eng.draw()).slice(1, 2), ['계획: 배포 계획'], 'a plan takes its place');
  await eng.tool({ tool: 'Write', file_path: review });
  assert.deepEqual(labels(await eng.draw()).slice(1, 2), ['계획: 배포 계획'], 'and keeps it');
});

test('a node that holds others folds by its arrow or its words; a heading is bold, a code line dim, a number set apart', async () => {
  const md = '# 계획\n## 구현\n1. 설계\n   - [x] 초안\n```bash\n  npm test\n```\n| 칸 | 값 |\n|---|---|\n| a | 1 |\n';
  const eng = engine({ files: new Map([[PLAN, md]]) });
  await eng.tool({ tool: 'Write', file_path: PLAN });
  let tree = await eng.draw();
  const head = button(tree, '구현');
  assert.ok(walk(head).some((n) => n.type === 'Text' && n.props.bold === true), 'a heading\'s words are bold');
  assert.match(textOf(rowSaying(tree, '구현')), /1\/1/, 'a heading counts the checkboxes under it');
  walk(tree).find((n) => n.type === 'Button' && String(n.props.key).startsWith('arrow-n')).props.onPress({});
  tree = await eng.draw();
  const step = rowSaying(tree, '설계');
  const marker = step.props.children[1];
  assert.equal(marker.type, 'Box');
  assert.equal(marker.props.flexShrink, 0);
  assert.equal(textOf(marker), '1.');
  assert.ok(!rowSaying(tree, '초안'), 'a list item that holds items is folded too');
  button(tree, '설계').props.onPress({});
  button(tree, '코드 bash (1줄)').props.onPress({});
  button(tree, '표: 칸 | 값 (1행)').props.onPress({});
  tree = await eng.draw();
  assert.match(textOf(rowSaying(tree, '초안')), /완료/);
  const line = walk(rowSaying(tree, '  npm test')).find((n) => n.type === 'Text' && n.props.children[0] === '  npm test');
  assert.equal(line.props.dimColor, true, 'a code line is dim and keeps its indent');
  assert.ok(rowSaying(tree, 'a | 1'));
  button(tree, '설계').props.onPress({});
  assert.ok(!rowSaying(await eng.draw(), '초안'), 'a second press folds it again');
});

test('unfolded sections stay unfolded when the plan is read again, and one the plan lost is forgotten', async () => {
  const eng = engine({ files: new Map([[PLAN, '# 계획\n## A\n- a\n## B\n- b\n']]) });
  await eng.tool({ tool: 'Write', file_path: PLAN });
  let tree = await eng.draw();
  button(tree, 'A').props.onPress({});
  button(tree, 'B').props.onPress({});
  eng.files.set(PLAN, '# 계획\n## 새 구역\n- n\n## A\n- a\n- [x] 더한 항목\n');
  await eng.raise('turn.start', { turnId: 't1', text: '다음' });
  tree = await eng.draw();
  assert.ok(rowSaying(tree, 'a') && rowSaying(tree, '더한 항목'), 'A stays open around the new section');
  assert.ok(!rowSaying(tree, 'n'), 'a new section starts folded');
  eng.files.set(PLAN, '# 계획\n## A\n- a\n## B\n- b\n');
  await eng.raise('turn.complete', { turnId: 't1', reason: 'answer' });
  assert.ok(!rowSaying(await eng.draw(), 'b'), 'B left the plan in between, so it comes back folded');
});

test('opening the pane offers the to-do tool once, where the model has no task list tool of Claude Code\'s', async () => {
  const eng = engine();
  await eng.raise('command.run', { command: 'progress', args: 'on' });
  assert.equal(eng.seen.tools.length, 1);
  const [spec] = eng.seen.tools;
  assert.equal(spec.name, 'todo');
  assert.match(spec.description, /진행 상황 패널/);
  assert.deepEqual(spec.inputSchema.required, ['todos']);
  assert.deepEqual(spec.inputSchema.properties.todos.items.properties.status.enum, ['pending', 'in_progress', 'completed']);
  await eng.raise('command.run', { command: 'progress', args: 'off' });
  await eng.raise('command.run', { command: 'progress', args: 'on' });
  assert.equal(eng.seen.tools.length, 1, 'the tool is there already');
  for (const tools of [['TodoWrite'], ['TaskCreate', 'TaskUpdate']]) {
    const other = engine({ tools });
    await other.raise('command.run', { command: 'progress', args: '' });
    assert.equal(other.seen.tools.length, 0, tools.join());
  }
  const quiet = engine();
  await quiet.raise('command.run', { command: 'progress', args: 'off' });
  assert.equal(quiet.seen.tools.length, 0, 'off offers nothing');
});

test('an engine without the tool list still opens the pane', async () => {
  const eng = engine();
  delete eng.$.tool;
  assert.deepEqual(await eng.raise('command.run', { command: 'progress', args: 'on' }), {});
  assert.equal(eng.seen.opened.length, 1);
});

test('the to-do tool\'s list becomes the steps and calls go under the item in progress; it is no call of its own', async () => {
  const eng = engine();
  await eng.raise('command.run', { command: 'progress', args: 'on' });
  await eng.raise('turn.start', { turnId: 't1', text: '여러 단계 작업' });
  const todos = [{ content: '설계', status: 'completed' }, { content: '구현', status: 'in_progress', activeForm: '구현하는 중' }, { content: '검증', status: 'pending' }];
  const answer = await eng.raise('tool.call', { tool: TODO_TOOL, todos });
  assert.deepEqual(answer, { result: '진행 상황 패널에 할 일 3개를 보였습니다(진행 중 1개).' });
  await eng.tool({ tool: 'Bash', command: 'npm test' });
  let tree = await eng.draw();
  assert.deepEqual(labels(tree).filter((l) => !/^[▸▾]$/.test(l)), ['설계', '구현', '검증']);
  assert.match(textOf(rowLabeled(tree, '구현')), /진행 중/);
  button(tree, '▸').props.onPress({});
  button(tree, '구현').props.onPress({});
  tree = await eng.draw();
  assert.ok(labels(tree).includes('Bash npm test'));
  assert.ok(!labels(tree).some((l) => l.startsWith('mcp__')), 'the to-do call itself is no row');
  assert.match(textOf(about(tree)), /^구현\. 진행 중\(구현하는 중\)/);
});

test('a to-do list that is not one is refused with why, and a subagent\'s list leaves the session\'s alone', async () => {
  const eng = engine();
  await eng.raise('turn.start', { turnId: 't1', text: '작업' });
  for (const todos of [undefined, 'a', [{ content: '', status: 'pending' }], [{ content: 'x', status: 'done' }], [{ content: 3, status: 'pending' }],
    Array.from({ length: 51 }, () => ({ content: 'x', status: 'pending' }))]) {
    const answer = await eng.raise('tool.call', { tool: TODO_TOOL, todos });
    assert.ok(typeof answer.deny === 'string' && answer.deny.length > 0, JSON.stringify(todos)?.slice(0, 40));
  }
  await eng.raise('tool.call', { tool: TODO_TOOL, todos: [{ content: '하위 일', status: 'in_progress' }], agentId: 'a1' });
  assert.deepEqual(labels(await eng.draw()), ['작업'], 'the prompt is still the step');
  assert.deepEqual(readTodos([{ content: ` ${'가'.repeat(300)}\u0007`, status: 'pending', activeForm: 7 }]).map((t) => [t.content.length, t.activeForm]), [[200, undefined]]);
});

test('the to-do tool is listed up front rather than behind ToolSearch, and its hook answers in words when it throws', async () => {
  const eng = engine();
  const shown = await eng.raise('tool.describe', { tool: TODO_TOOL, description: 'd', isDeferred: true }, async (e) => ({ description: e.description, isDeferred: true }));
  assert.deepEqual(shown, { description: 'd', isDeferred: false });
  const other = await eng.raise('tool.describe', { tool: 'mcp__x__y', description: 'd', isDeferred: true }, async (e) => ({ description: e.description, isDeferred: true }));
  assert.equal(other.isDeferred, true, 'another tool keeps its place');
  const bad = { tool: TODO_TOOL, get todos() { throw new Error('boom'); } };
  assert.deepEqual(await eng.raise('tool.call', bad), { deny: '진행 상황 패널이 할 일 목록을 받지 못했습니다.' });
});

test('with the pane closed the to-do tool keeps the list and says it need not be sent; a subagent hears its list is not shown', async () => {
  const eng = engine();
  await eng.raise('turn.start', { turnId: 't1', text: '작업' });
  const closed = await eng.raise('tool.call', { tool: TODO_TOOL, todos: [{ content: '하나', status: 'in_progress' }] });
  assert.match(closed.result, /꺼져 있습니다.*부르지 않아도 됩니다/);
  await eng.raise('command.run', { command: 'progress', args: 'on' });
  assert.deepEqual(labels(await eng.draw()), ['하나'], 'the list kept while closed shows once the pane opens');
  const sub = await eng.raise('tool.call', { tool: TODO_TOOL, todos: [{ content: '하위', status: 'in_progress' }], agentId: 'a1' });
  assert.match(sub.result, /하위 에이전트의 할 일 목록은 진행 상황 패널에 보이지 않습니다/);
  assert.deepEqual(labels(await eng.draw()), ['하나']);
  const spec = eng.seen.tools[0];
  assert.equal(spec.inputSchema.additionalProperties, false);
  assert.equal(spec.inputSchema.properties.todos.items.additionalProperties, false);
});

test('a long plan stops drawing rows at 40,000 characters, so the steps and the description below still get room', async () => {
  const md = `# 긴 계획\n${Array.from({ length: 60 }, (_, i) => `- [ ] ${`${i}가`.repeat(450)}`).join('\n')}\n`;
  const eng = engine({ files: new Map([[PLAN, md]]) });
  await eng.raise('turn.start', { turnId: 't1', text: '긴 계획' });
  await eng.tool({ tool: 'Write', file_path: PLAN });
  const tree = await eng.draw();
  const shown = walk(tree).filter((n) => /^row-n/.test(String(n.props?.key))).length;
  assert.ok(shown > 0 && shown < 60, `${shown} rows`);
  assert.match(textOf(tree), new RegExp(`외 ${60 - shown}줄`));
  assert.ok(labels(tree).includes('긴 계획'), 'the prompt is still drawn');
});

test('a plan path that leads to no plain file is not read; an engine without stat still reads', async () => {
  const pipe = '/w/.omc/plans/pipe.md';
  const eng = engine({ files: new Map([[pipe, '# 파이프\n- a\n']]), kinds: new Map([[pipe, 'other']]) });
  await eng.tool({ tool: 'Write', file_path: pipe });
  assert.ok(!eng.seen.reads.includes(pipe));
  assert.ok(!labels(await eng.draw()).some((l) => l.startsWith('계획')));
  const old = engine({ files: new Map([[PLAN, PLAN_MD]]) });
  delete old.$.fs.stat;
  await old.tool({ tool: 'Write', file_path: PLAN });
  assert.deepEqual(labels(await old.draw()).slice(1, 2), ['계획: 배포 계획']);
  old.files.set(PLAN, '# 배포 계획\n- [x] 설계\n');
  await old.raise('turn.start', { turnId: 't1', text: '다음' });
  assert.match(textOf(rowOf(await old.draw(), 'plan')), /1\/1 완료/, 'the read again at a turn works without stat too');
});

test('a plan the session itself writes takes the place of one with steps; an agent\'s or a read note does not', async () => {
  const notes = '/w/.omc/plans/notes.md';
  const read = '/w/.omc/plans/read.md';
  const eng = engine({ files: new Map([[PLAN, PLAN_MD], [notes, '# 메모 계획\n결정만 적음\n'], [read, '# 읽은 글\n의견\n']]) });
  await eng.tool({ tool: 'Write', file_path: PLAN });
  await eng.tool({ tool: 'Read', file_path: read });
  assert.deepEqual(labels(await eng.draw()).slice(1, 2), ['계획: 배포 계획'], 'a note the session only read does not push the plan away');
  await eng.tool({ tool: 'Write', file_path: notes });
  assert.deepEqual(labels(await eng.draw()).slice(1, 2), ['계획: 메모 계획'], 'one it wrote does');
});

test('a plan cut short says so at the end of its rows and in its description', async () => {
  const long = `# 긴 파일\n${'- 줄\n'.repeat(70000)}`;
  const many = `# 많은 항목\n${Array.from({ length: 3100 }, (_, i) => `- 항목 ${i}`).join('\n')}\n`;
  for (const [md, words] of [[long, /파일이 길어 앞부분만 읽었습니다/], [many, /항목이 많아 앞부분만 보입니다/]]) {
    const eng = engine({ files: new Map([[PLAN, md]]) });
    await eng.tool({ tool: 'Write', file_path: PLAN });
    let tree = await eng.draw();
    assert.match(textOf(walk(tree).find((n) => n.props?.key === 'plan-cut')), /계획이 길어 앞부분만 보입니다/);
    button(tree, labels(tree)[1]).props.onPress({});
    tree = await eng.draw();
    assert.match(textOf(about(tree)), words);
  }
});

test('a registration the engine refuses is said in one line, and the pane still opens', async () => {
  const eng = engine();
  eng.$.tool.register = async () => { throw new Error('a user MCP server holds the name'); };
  assert.deepEqual(await eng.raise('command.run', { command: 'progress', args: 'on' }), {});
  assert.equal(eng.seen.opened.length, 1);
  assert.deepEqual(eng.seen.logs, ['할 일 도구를 등록하지 못했습니다(a user MCP server holds the name). 진행 상황 패널은 요청을 단계로 보입니다.']);
});

test('a plan read again at a turn is not read once its path leads to no plain file; the to-do tool takes the list when the pane list fails', async () => {
  const kinds = new Map();
  const eng = engine({ files: new Map([[PLAN, PLAN_MD]]), kinds });
  await eng.tool({ tool: 'Write', file_path: PLAN });
  kinds.set(PLAN, 'other');
  eng.files.set(PLAN, '# 바뀐 계획\n- [x] a\n');
  const reads = eng.seen.reads.length;
  await eng.raise('turn.start', { turnId: 't1', text: '다음' });
  assert.equal(eng.seen.reads.length, reads, 'no read of a pipe');
  assert.deepEqual(labels(await eng.draw()).slice(1, 2), ['계획: 배포 계획']);
  eng.$.ui.panes = async () => { throw new Error('pane list refused'); };
  const answer = await eng.raise('tool.call', { tool: TODO_TOOL, todos: [{ content: '하나', status: 'in_progress' }] });
  assert.match(answer.result, /할 일 1개를 보였습니다/);
});

test('a notice whose status is named like an object\'s own property gets the plain word', async () => {
  const eng = engine();
  await eng.raise('turn.start', { turnId: 't1', text: '하나' });
  await eng.raise('turn.start', { turnId: 't2', text: '<task-notification><status>constructor</status><summary>끝</summary></task-notification>' });
  button(await eng.draw(), '▸').props.onPress({});
  assert.ok(labels(await eng.draw()).includes('백그라운드 작업 알림: 끝'));
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

const REVIEW = '/w/.omc/plans/deploy-critic-r1.md';
const REVIEW_MD = '# 검토 의견\n- [ ] 고칠 것\n';

test('a review round whose read lands first does not overtake a plan touched before it', async () => {
  const eng = engine({ files: new Map([[PLAN, PLAN_MD], [REVIEW, REVIEW_MD]]), held: new Set([PLAN]) });
  const first = eng.tool({ tool: 'Write', file_path: PLAN });
  await new Promise((resolve) => setImmediate(resolve));
  await eng.tool({ tool: 'Write', file_path: REVIEW });
  await eng.release(PLAN);
  await first;
  assert.deepEqual(labels(await eng.draw()).slice(1, 2), ['계획: 배포 계획']);
});

test('a plan with no steps that the session only read replaces a review round that has checkboxes', async () => {
  const notes = '/w/.omc/plans/design-notes.md';
  const eng = engine({ files: new Map([[REVIEW, REVIEW_MD], [notes, '# 설계 메모\n결정만 적음\n']]) });
  await eng.tool({ tool: 'Write', file_path: REVIEW });
  assert.deepEqual(labels(await eng.draw()).slice(1, 2), ['계획: 검토 의견']);
  await eng.tool({ tool: 'Read', file_path: notes });
  assert.deepEqual(labels(await eng.draw()).slice(1, 2), ['계획: 설계 메모']);
});

test('the first review round keeps its place against a later one, as the design says: a plan on the pane is not changed', async () => {
  const second = '/w/.omc/plans/deploy-architect-review-r1.md';
  const eng = engine({ files: new Map([[REVIEW, REVIEW_MD], [second, '# 다른 검토\n- [ ] 다른 것\n']]) });
  await eng.tool({ tool: 'Write', file_path: REVIEW });
  await eng.tool({ tool: 'Write', file_path: second });
  assert.deepEqual(labels(await eng.draw()).slice(1, 2), ['계획: 검토 의견']);
});

test('every way a notice\'s turn ends without an answer says so under the step, as a failed row', async () => {
  const eng = engine();
  await eng.raise('turn.start', { turnId: 't1', text: '검토해 줘' });
  await eng.raise('turn.complete', { turnId: 't1', reason: 'answer' });
  const notice = '<task-notification><status>completed</status><summary>끝</summary></task-notification>';
  const says = { aborted: '알림 처리 중단됨', refusal: '알림 처리 거절됨', error: '알림 처리 오류로 끝남' };
  for (const reason of Object.keys(says)) {
    await eng.raise('turn.start', { turnId: `n-${reason}`, text: notice });
    await eng.raise('turn.complete', { turnId: `n-${reason}`, reason });
  }
  button(await eng.draw(), '▸').props.onPress({});
  const tree = await eng.draw();
  for (const word of Object.values(says)) assert.match(textOf(rowLabeled(tree, word)), /실패/, word);
});

test('with two items in progress the calls go under the last one, and the pane follows it', async () => {
  const eng = engine();
  const item = (content, status) => ({ content, status, activeForm: `${content} 중` });
  await eng.tool({ tool: 'TodoWrite', todos: [item('A 하기', 'in_progress'), item('B 하기', 'in_progress'), item('C 하기', 'pending')] });
  await eng.tool({ tool: 'Bash', command: 'make' });
  const tree = await eng.draw();
  assert.deepEqual(labels(tree), ['A 하기', '▸', 'B 하기', 'C 하기'], 'only B holds the call');
  await eng.settle();
  assert.deepEqual(eng.seen.scrolls.at(-1), into(rowLabeled(tree, 'B 하기').props.key));
});

test('a TaskList begun after a TaskCreate that leaves the task out drops it', async () => {
  const eng = engine();
  await eng.tool({ tool: 'TaskCreate', subject: '설계' }, created('1', '설계'));
  await eng.tool({ tool: 'TaskList' }, { result: { tasks: [{ id: '2', subject: '다른 세션의 작업', status: 'pending', blockedBy: [] }] } });
  assert.deepEqual(labels(await eng.draw()), ['다른 세션의 작업']);
});

test('a TaskList that took a task in makes an earlier-begun TaskGet of it stale', async () => {
  const eng = engine();
  await eng.tool({ tool: 'TaskCreate', subject: '설계' }, created('1', '설계'));
  const reading = later(eng, { tool: 'TaskGet', taskId: '1' });
  await eng.tool({ tool: 'TaskList' }, { result: { tasks: [{ id: '1', subject: '설계', status: 'in_progress', blockedBy: [] }] } });
  await reading.end({ result: { task: { id: '1', subject: '설계', status: 'pending', blocks: [] } } });
  assert.match(textOf(rowOf(await eng.draw(), 'k-1')), /진행 중/);
});

test('a TaskCreate that ends after a later-begun delete of its task does not make it', async () => {
  const eng = engine();
  const creating = later(eng, { tool: 'TaskCreate', subject: '설계' });
  await eng.tool({ tool: 'TaskUpdate', taskId: '1', status: 'deleted' }, updated('1', { from: 'pending', to: 'deleted' }));
  await creating.end(created('1', '설계'));
  assert.deepEqual(labels(await eng.draw()), ['진행 중인 작업 없음']);
});

test('a read finding a task gone beats an earlier-begun read of it, and a read that brought a task beats an earlier-begun list that left it out', async () => {
  const task = { id: '1', subject: '설계', status: 'pending', blocks: [] };
  const eng = engine();
  await eng.tool({ tool: 'TaskCreate', subject: '설계' }, created('1', '설계'));
  const first = later(eng, { tool: 'TaskGet', taskId: '1' });
  await eng.tool({ tool: 'TaskGet', taskId: '1' }, { result: { task: null } });
  await first.end({ result: { task } });
  assert.deepEqual(labels(await eng.draw()), ['진행 중인 작업 없음'], 'a TaskGet that found it gone');
  const other = engine();
  await other.tool({ tool: 'TaskCreate', subject: '설계' }, created('1', '설계'));
  await other.tool({ tool: 'TaskCreate', subject: '구현' }, created('2', '구현'));
  const getting = later(other, { tool: 'TaskGet', taskId: '1' });
  await other.tool({ tool: 'TaskList' }, { result: { tasks: [{ id: '2', subject: '구현', status: 'pending', blockedBy: [] }] } });
  await getting.end({ result: { task } });
  assert.deepEqual(labels(await other.draw()), ['구현'], 'a TaskList that left it out');
  const third = engine();
  await third.tool({ tool: 'TaskCreate', subject: '설계' }, created('1', '설계'));
  const listing = later(third, { tool: 'TaskList' });
  await third.tool({ tool: 'TaskGet', taskId: '7' }, { result: { task: { id: '7', subject: '다른 세션의 작업', status: 'pending', blocks: [] } } });
  await listing.end({ result: { tasks: [{ id: '1', subject: '설계', status: 'pending', blockedBy: [] }] } });
  assert.deepEqual(labels(await third.draw()), ['설계', '다른 세션의 작업'], 'a TaskGet that brought it in');
});

test('the pane is asked again after each change it shows: a tool call, a plan taken in, a turn end and start, a to-do list', async () => {
  const eng = engine({ files: new Map([[PLAN, PLAN_MD]]), held: new Set([PLAN]) });
  let drawing = Promise.resolve(null);
  eng.$.ui.invalidate = () => { eng.seen.invalidated += 1; drawing = eng.draw(); }; // the surface asks at once
  const shown = async () => labels(await drawing);
  await eng.raise('turn.start', { turnId: 't1', text: '작업' });
  assert.deepEqual(await shown(), ['작업']);
  await eng.tool({ tool: 'Bash', command: 'ls' });
  assert.deepEqual(await shown(), ['▸', '작업'], 'a tool call draws its arrow');
  const writing = eng.tool({ tool: 'Write', file_path: PLAN });
  await new Promise((resolve) => setImmediate(resolve));
  await eng.release(PLAN);
  await writing;
  assert.deepEqual((await shown()).slice(0, 2), ['▾', '계획: 배포 계획'], 'the last asking came after the plan was taken in');
  await eng.raise('turn.complete', { turnId: 't1', reason: 'answer' });
  assert.match(textOf(rowOf(await drawing, 't-t1')), /완료/, 'a turn end draws the step done');
  eng.files.set(PLAN, '# 배포 계획\n- [x] 설계\n');
  await eng.raise('turn.start', { turnId: 't2', text: '다음' });
  assert.match(textOf(rowOf(await drawing, 'plan')), /1\/1 완료/, 'a turn start draws the plan read again');
  await eng.raise('tool.call', { tool: TODO_TOOL, todos: [{ content: '하나', status: 'in_progress' }] });
  assert.ok((await shown()).includes('하나'), 'the to-do list draws');
});

test('a TaskList begun after a TaskGet leaves out a task the pane never held: the TaskGet that finds it later changes nothing', async () => {
  const eng = engine();
  const reading = later(eng, { tool: 'TaskGet', taskId: '7' });
  await eng.tool({ tool: 'TaskList' }, { result: { tasks: [{ id: '8', subject: '다른 작업', status: 'pending', blockedBy: [] }] } });
  await reading.end({ result: { task: { id: '7', subject: '지워진 작업', status: 'pending', blocks: [] } } });
  assert.deepEqual(labels(await eng.draw()), ['다른 작업'], 'the list begun later stands');
});

// A read that finds a task deleted takes it off the pane, as a delete does, so it wins over an earlier-begun read
// whatever that read brought.
test('a TaskGet that reads a task on the pane as deleted takes it off, and an earlier-begun read changes nothing', async () => {
  for (const earlier of [{ task: { id: '7', subject: '설계', status: 'in_progress', blocks: [] } }, { task: { id: '7', subject: '설계', status: 'completed', blocks: [] } }, { task: null }]) {
    const eng = engine();
    await eng.tool({ tool: 'TaskCreate', subject: '설계' }, created('7', '설계'));
    const reading = later(eng, { tool: 'TaskGet', taskId: '7' });
    await eng.tool({ tool: 'TaskGet', taskId: '7' }, { result: { task: { id: '7', subject: '설계', status: 'deleted', blocks: [] } } });
    await reading.end({ result: earlier });
    assert.deepEqual(labels(await eng.draw()), ['진행 중인 작업 없음'], JSON.stringify(earlier));
  }
});

test('a TaskGet that reads a task off the pane as completed beats an earlier-begun TaskGet that read it pending', async () => {
  const task = (status) => ({ result: { task: { id: '7', subject: '다른 세션의 작업', status, blocks: [] } } });
  const eng = engine();
  const reading = later(eng, { tool: 'TaskGet', taskId: '7' });
  await eng.tool({ tool: 'TaskGet', taskId: '7' }, task('completed'));
  await reading.end(task('pending'));
  assert.deepEqual(labels(await eng.draw()), ['진행 중인 작업 없음'], 'the read begun later stands: a completed task stays off the pane');
});

// ---- reads that overlap, against a random model (seeded: the same runs every time) ----
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A TaskGet or TaskList whose start, read and end fall at random: { e, start, read, end, saw } with `saw` the shared
// list at its read, which is what its answer says.
function randomRead(rand, truth) {
  const start = rand() * 100;
  const read = start + rand() * 50;
  const e = rand() < 0.5 ? { tool: 'TaskList' } : { tool: 'TaskGet', taskId: String(1 + Math.floor(rand() * 6)) };
  return { e, start, read, end: read + rand() * 50, answer() {
    this.saw = new Map(truth);
    const task = (id) => ({ id, subject: `작업 ${id}`, status: truth.get(id), blockedBy: [], blocks: [] });
    return e.tool === 'TaskList' ? { result: { tasks: [...truth.keys()].map(task) } }
      : { result: { task: truth.has(e.taskId) ? task(e.taskId) : null } };
  } };
}

// Another session's change to the shared list: a new task, a delete, or a move between pending and in progress.
function otherSession(rand, truth, made) {
  const ids = [...truth.keys()];
  const kind = rand();
  if (kind < 0.35 && made.next <= 6) truth.set(String(made.next++), 'pending');
  else if (kind < 0.7 && ids.length) truth.delete(ids[Math.floor(rand() * ids.length)]);
  else if (ids.length) {
    const id = ids[Math.floor(rand() * ids.length)];
    truth.set(id, truth.get(id) === 'pending' ? 'in_progress' : 'pending');
  }
}

// The ids where the pane differs from the latest-begun call that said anything about them, and whether two calls
// ended in another order than they began.
function overlapRun(rand) {
  const s = freshState();
  const truth = new Map();
  for (const id of ['1', '2', '3', '4']) {
    truth.set(id, 'pending');
    noteTaskTool(s, { tool: 'TaskCreate', subject: `작업 ${id}` }, { result: { task: { id } } }, 0);
  }
  const calls = Array.from({ length: 6 }, () => randomRead(rand, truth));
  const made = { next: 5 };
  const events = calls.flatMap((c) => [
    [c.start, 0, () => { c.since = s.rev; c.order = ++s.order; }],
    [c.read, 1, () => { c.r = c.answer(); }],
    [c.end, 2, () => noteTaskTool(s, c.e, c.r, 0, c.since, c.order)],
  ]);
  for (let i = 0; i < 4; i++) events.push([rand() * 150, 3, () => otherSession(rand, truth, made)]);
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  for (const [, , run] of events) run();
  const differs = ['1', '2', '3', '4', '5', '6'].filter((id) => {
    const says = calls.filter((c) => c.e.tool === 'TaskList' || c.e.taskId === id).sort((a, b) => b.order - a.order)[0];
    const want = says ? (says.saw.get(id) ?? null) : (Number(id) <= 4 ? 'pending' : null);
    return (s.tasks.get(id)?.status ?? null) !== want;
  });
  const byStart = [...calls].sort((a, b) => a.start - b.start);
  return { differs, crossed: byStart.some((c, i) => i > 0 && c.end < byStart[i - 1].end) };
}

test('reads that overlap at random: the pane always shows what the latest-begun read said about each task', () => {
  let runs = 0;
  let crossed = 0;
  const wrong = [];
  for (const seed of [1, 2, 3]) {
    const rand = seeded(seed);
    for (let i = 0; i < 1500; i++) {
      const run = overlapRun(rand);
      runs += 1;
      crossed += run.crossed ? 1 : 0;
      if (run.differs.length) wrong.push(`seed ${seed} run ${i}: ${run.differs.join(', ')}`);
    }
  }
  assert.ok(crossed > runs / 2, `the model overlaps calls in most runs (${crossed} of ${runs})`);
  assert.deepEqual(wrong.slice(0, 5), [], `${wrong.length} runs broke the start-order rule`);
});

test('a review round touched twice keeps the newer read when the older one lands last', async () => {
  const eng = engine({ files: new Map([[REVIEW, REVIEW_MD]]), held: new Set([REVIEW]) });
  const first = eng.tool({ tool: 'Read', file_path: REVIEW });
  await new Promise((resolve) => setImmediate(resolve));
  eng.files.set(REVIEW, '# 검토 의견\n- [x] 고칠 것\n');
  await eng.tool({ tool: 'Edit', file_path: REVIEW, agentId: 'a1' });
  await eng.release(REVIEW);
  await first;
  assert.match(textOf(rowOf(await eng.draw(), 'plan')), /1\/1 완료/);
});

test('a read again that lands after a newer write of a review round does not undo it', async () => {
  const eng = engine({ files: new Map([[REVIEW, REVIEW_MD]]) });
  await eng.tool({ tool: 'Write', file_path: REVIEW });
  eng.held.add(REVIEW);
  const ending = eng.raise('turn.complete', { turnId: 't0', reason: 'answer' });
  await new Promise((resolve) => setImmediate(resolve));
  eng.files.set(REVIEW, '# 검토 의견\n- [x] 고칠 것\n');
  await eng.tool({ tool: 'Edit', file_path: REVIEW, agentId: 'a1' });
  await eng.release(REVIEW);
  await ending;
  assert.match(textOf(rowOf(await eng.draw(), 'plan')), /1\/1 완료/, 'the read again of the old text that landed late changed nothing');
});

test('TaskGet reads of ids the store does not have keep at most 1,000 marks, none for an id past 64 characters, and a task on the pane keeps its own', () => {
  const s = freshState();
  noteTaskTool(s, { tool: 'TaskCreate', subject: '구현' }, created('1', '구현'), 0);
  noteTaskTool(s, { tool: 'TaskUpdate', taskId: '1', status: 'in_progress' }, updated('1', { from: 'pending', to: 'in_progress' }), 0);
  for (let i = 0; i < 5000; i++) noteTaskTool(s, { tool: 'TaskGet', taskId: `x${i}` }, { result: { task: null } }, 0);
  noteTaskTool(s, { tool: 'TaskGet', taskId: 'y'.repeat(65) }, { result: { task: null } }, 0);
  assert.ok(s.marks.size <= 1000, `${s.marks.size} marks`);
  assert.ok([...s.marks.keys()].every((k) => k.length <= 64), 'no mark for an id longer than 64 characters');
  assert.equal(s.marks.get('1')?.status, 'in_progress', 'the mark of a task on the pane stays');
});

test('a task id or state the pane does not know is drawn cleaned, never as a function\'s text', async () => {
  const eng = engine();
  await eng.tool({ tool: 'TaskList' }, { result: { tasks: [
    { id: '1', subject: '상태가 이상함', status: 'constructor' },
    { id: '2\u001b[31m\u202e', status: 'in_progress' },
  ] } });
  const tree = await eng.draw();
  const children = walk(tree).filter((n) => n.type === 'Text').flatMap((n) => n.props.children);
  assert.ok(children.every((c) => typeof c === 'string'), 'every word drawn is text');
  assert.ok(labels(tree).every((l) => !/[\u0000-\u001f\u007f\u202a-\u202e]/.test(l)), JSON.stringify(labels(tree)));
  button(tree, '상태가 이상함').props.onPress({});
  assert.doesNotMatch(textOf(about(await eng.draw())), /function|native code/);
});

test('a touch\'s read of a review round begun before a read again does not take the read again\'s words when it lands last', async () => {
  const eng = engine({ files: new Map([[REVIEW, REVIEW_MD]]) });
  await eng.tool({ tool: 'Write', file_path: REVIEW });
  eng.held.add(REVIEW);
  const late = eng.tool({ tool: 'Edit', file_path: REVIEW, agentId: 'a1' }); // its read takes the text as it is now
  await new Promise((resolve) => setImmediate(resolve));
  eng.files.set(REVIEW, '# 검토 의견\n- [x] 고칠 것\n');
  await eng.raise('turn.complete', { turnId: 't0', reason: 'answer' }); // the read again takes the newer text
  await eng.release(REVIEW);
  await late;
  assert.match(textOf(rowOf(await eng.draw(), 'plan')), /1\/1 완료/, 'the older read that landed last left the newer words');
});

test('the mark cap, reached while a late TaskList is taken in, keeps the marks of the tasks on the pane', () => {
  const s = freshState();
  noteTaskTool(s, { tool: 'TaskCreate', subject: '구현' }, created('1', '구현'), 0);
  noteTaskTool(s, { tool: 'TaskUpdate', taskId: '1', status: 'in_progress' }, updated('1', { from: 'pending', to: 'in_progress' }), 0);
  for (let i = 0; i < 1200; i++) noteTaskTool(s, { tool: 'TaskGet', taskId: `x${i}` }, { result: { task: null } }, 0);
  const since = s.rev;
  const order = ++s.order; // a TaskList begins here
  noteTaskTool(s, { tool: 'TaskUpdate', taskId: '1', status: 'completed' }, updated('1', { from: 'in_progress', to: 'completed' }), 0);
  const late = { result: { tasks: [{ id: 'n1', subject: '다른 세션의 작업', status: 'pending' }, { id: '1', subject: '구현', status: 'in_progress' }] } };
  noteTaskTool(s, { tool: 'TaskList' }, late, 0, since, order);
  assert.equal(s.tasks.get('1')?.status, 'completed', 'the list begun before the task was completed does not bring it back');
  assert.ok(s.marks.size <= 1000, `${s.marks.size} marks`);
});

// ---- 0.20.5 (B5 plan rows R4, D-S4, B5 rows 5, 6)
// B5-01 R4: reads land in any order, and the pane shows the plan the touches would leave in their order. A later touch's
// read that landed first used to make the earlier touch's read late, so the plan shown hung on which read came first.
test('two review rounds written side by side keep the first one on the pane when the second one\'s read lands first', async () => {
  const second = '/w/.omc/plans/deploy-architect-review-r1.md';
  const eng = engine({ files: new Map([[REVIEW, REVIEW_MD], [second, '# 다른 검토\n- [ ] 다른 것\n']]), held: new Set([REVIEW]) });
  const first = eng.tool({ tool: 'Write', file_path: REVIEW, agentId: 'critic' });
  await new Promise((resolve) => setImmediate(resolve));
  await eng.tool({ tool: 'Write', file_path: second, agentId: 'architect' });
  await eng.release(REVIEW);
  await first;
  assert.deepEqual(labels(await eng.draw()).slice(1, 2), ['계획: 검토 의견'], 'as when the reads land in the order the rounds were written');
});

test('a plan read that lands last still takes the place a file with no steps took from a review round', async () => {
  const notes = '/w/.omc/plans/design-notes.md';
  const eng = engine({ files: new Map([[PLAN, PLAN_MD], [REVIEW, REVIEW_MD], [notes, '# 설계 메모\n결정만 적음\n']]), held: new Set([PLAN]) });
  await eng.tool({ tool: 'Write', file_path: REVIEW });
  const plan = eng.tool({ tool: 'Read', file_path: PLAN });
  await new Promise((resolve) => setImmediate(resolve));
  await eng.tool({ tool: 'Read', file_path: notes });
  await eng.release(PLAN);
  await plan;
  assert.deepEqual(labels(await eng.draw()).slice(1, 2), ['계획: 배포 계획'], 'in touch order the plan is shown, and a note the session only read does not push it away');
});

test('a note the session wrote, read last, stays when the plan read before it lands late', async () => {
  const notes = '/w/.omc/plans/design-notes.md';
  const eng = engine({ files: new Map([[PLAN, PLAN_MD], [REVIEW, REVIEW_MD], [notes, '# 설계 메모\n결정만 적음\n']]), held: new Set([PLAN, notes]) });
  await eng.tool({ tool: 'Write', file_path: REVIEW });
  const plan = eng.tool({ tool: 'Write', file_path: PLAN });
  await new Promise((resolve) => setImmediate(resolve));
  const wrote = eng.tool({ tool: 'Write', file_path: notes });
  await new Promise((resolve) => setImmediate(resolve));
  await eng.tool({ tool: 'Read', file_path: notes });
  await eng.release(PLAN);
  await plan;
  await eng.release(notes);
  await wrote;
  assert.deepEqual(labels(await eng.draw()).slice(1, 2), ['계획: 설계 메모']);
});

test('a touch whose read never lands holds back no later plan, and the reads kept for it stay bounded', () => {
  const s = freshState();
  const lost = '/w/.omc/plans/lost.md';
  planTouched(s, { tool: 'Write', file_path: lost }, { ok: true }); // its read never comes
  const write = (text) => {
    const r = planTouched(s, { tool: 'Write', file_path: PLAN }, { ok: true });
    takePlan(s, PLAN, text, { touch: r.touch, own: r.own, weak: r.weak });
  };
  let most = 0;
  for (let i = 0; i < 100; i++) {
    write(`# 배포 계획\n- [x] 하나\n${'- [ ] 다음\n'.repeat(i % 3)}`);
    most = Math.max(most, s.reads.length);
  }
  assert.equal(s.planPath, PLAN, 'the plan written last is on the pane');
  assert.equal(s.plan.total, 1 + (99 % 3), 'with the words of its last write');
  assert.ok(most <= 16, `${most} reads kept`);
  takePlan(s, lost, '# 잃어버린 계획\n- [ ] x\n', { touch: 1, own: true, weak: false }); // it lands at last, past its place
  for (let i = 0; i < 100; i++) write('# 배포 계획\n- [x] 하나\n');
  assert.equal(s.planPath, PLAN);
  assert.equal(s.reads.length, 0, 'no read piles up behind the lost one');
});

// B5 plan row D-S4: a long TodoWrite list is cut in one pass; one item at a time took the square of its length.
const oneByOne = (items, max) => {
  const out = [...items];
  while (out.length > max) out.splice(out.indexOf(out.find((t) => t.status === 'completed') ?? out[0]), 1);
  return out;
};
test('a TodoWrite list of 20,000 items is cut to the pane\'s 50 in well under the hooks worker\'s patience, as one cut at a time would leave it', () => {
  const STATES = ['pending', 'in_progress', 'completed'];
  const next = seeded(7);
  const rand = (n) => Math.floor(next() * n);
  for (let run = 0; run < 300; run++) {
    const todos = Array.from({ length: rand(140) }, (_, i) => ({ content: `할 일 ${i}`, status: STATES[rand(3)] }));
    const s = freshState();
    noteTaskTool(s, { tool: 'TodoWrite', todos }, {}, 0);
    assert.deepEqual(s.todos.map((t) => t.description), oneByOne(todos, 50).map((t) => t.content), `run ${run}`);
  }
  const s = freshState();
  const big = Array.from({ length: 20000 }, (_, i) => ({ content: `할 일 ${i}`, status: STATES[i % 3] }));
  const t0 = performance.now();
  noteTaskTool(s, { tool: 'TodoWrite', todos: big }, {}, 0);
  assert.ok(performance.now() - t0 < 1000, `${Math.round(performance.now() - t0)} ms`);
  assert.equal(s.todos.length, 50);
});

// B5 row 6: the state keeps a task's words no longer than any description reads of them.
test('a task\'s description and its words in progress are kept no longer than a description reads, and the pane says the same', () => {
  const s = freshState();
  const long = `${'설명 '.repeat(100)}${'x'.repeat(5_000_000)}`;
  noteTaskTool(s, { tool: 'TaskCreate', subject: '구현', description: long, activeForm: long }, created('1', '구현'), 0);
  noteTaskTool(s, { tool: 'TodoWrite', todos: [{ content: long, status: 'in_progress', activeForm: long }] }, {}, 0);
  const held = s.tasks.get('1');
  assert.ok(held.description.length <= 4096 && held.activeForm.length <= 4096, `${held.description.length}, ${held.activeForm.length}`);
  assert.ok(s.todos[0].description.length <= 4096 && s.todos[0].activeForm.length <= 4096);
  const shown = describe({ ...freshState(), tasks: new Map([['1', { ...held, description: long, activeForm: long }]]), selected: held.key }, 0);
  assert.equal(describe({ ...s, todos: null, selected: held.key }, 0), shown, 'what the pane says of the task is the same');
});

// B5 row 5: the engine drops a Box key that holds a control character or runs past 10,000 characters (2.1.305).
test('a task id that holds a control character or runs past 10,000 characters gets a key the engine keeps; a plain id keeps k-<id>', async () => {
  const eng = engine();
  await eng.tool({ tool: 'TaskList' }, { result: { tasks: [
    { id: '1', subject: '보통', status: 'in_progress' },
    { id: '2\u{1b}[31m', subject: '제어 글자', status: 'pending' },
    { id: 'x'.repeat(20000), subject: '긴 id', status: 'pending' },
  ] } });
  const tree = await eng.draw();
  const keys = walk(tree).filter((n) => n.type === 'Box' && n.props?.key).map((n) => String(n.props.key));
  assert.ok(keys.includes('row-k-1'), keys.join(' ').slice(0, 200));
  const bad = keys.filter((k) => /[\u{0}-\u{1f}\u{7f}-\u{9f}]/u.test(k) || k.length > 10000);
  assert.deepEqual(bad.map((k) => k.slice(0, 20)), []);
  assert.equal(new Set(keys).size, keys.length, 'no two rows share a key');
});

// B5-01 R4, at large: random runs of plan touches (writes and reads, by the session or an agent) and reads again at a
// turn's edge, each read landing any time after it began, show what the same reads show when each lands at once.
const R4_FILES = [
  [REVIEW, REVIEW_MD], [REVIEW, '# 검토 의견\n- [x] 고칠 것\n'], ['/w/.omc/plans/deploy-architect-review-r1.md', '# 다른 검토\n- [ ] 다른 것\n'],
  ['/w/.omc/plans/open-questions.md', '# 열린 질문\n- [ ] 질문 하나\n'], [PLAN, PLAN_MD], [PLAN, '# 배포 계획\n- [x] 설계\n- [ ] 구현\n'],
  ['/w/.omc/plans/design-notes.md', '# 설계 메모\n결정만 적음\n'], ['/w/.omc/prd.json', '{"이것은": "계획이 아님"}'],
];
// events: [item, 'start' | 'land'] in the order they happen. A read again reads the plan shown when it starts.
// What one item's start leaves to land: a read again of the plan shown, or a touch's read of what it wrote.
function startRead(s, disk, it) {
  if (it.again) return s.planPath ? { path: s.planPath, text: disk.get(s.planPath) ?? null, read: { since: s.touch, order: ++s.order } } : null;
  disk.set(it.path, it.text);
  const r = planTouched(s, { tool: it.tool, file_path: it.path, agentId: it.agentId }, { ok: true });
  return r ? { path: it.path, text: it.text, read: { touch: r.touch, own: r.own, weak: r.weak } } : null;
}
function playReads(items, events) {
  const s = freshState();
  const disk = new Map();
  const pending = [];
  for (const [i, kind] of events) {
    if (kind !== 'land') pending[i] = startRead(s, disk, items[i]);
    else if (pending[i]) takePlan(s, pending[i].path, pending[i].text, pending[i].read);
  }
  return `${s.planPath ?? '-'}|${s.plan?.done ?? '-'}|${s.plan?.total ?? '-'}`;
}
test('of two reads again begun after the same touches, the one begun later wins whichever lands last', () => {
  const s = freshState();
  const r = planTouched(s, { tool: 'Write', file_path: PLAN }, { ok: true });
  takePlan(s, PLAN, '# 배포 계획\n- [ ] 설계\n- [ ] 구현\n', { touch: r.touch, own: r.own, weak: r.weak });
  const first = planTarget(s);
  const second = planTarget(s);
  assert.ok(second.order > first.order, JSON.stringify([first, second]));
  planRead(s, second, '# 배포 계획\n- [x] 설계\n- [x] 구현\n- [ ] 배포\n');
  planRead(s, first, '# 배포 계획\n- [x] 설계\n- [ ] 구현\n');
  assert.deepEqual([s.plan.done, s.plan.total], [2, 3], 'the words of the read begun later stay');
});

test('reads that land in any order show the plan the same reads show when each lands at once (2,000 random runs)', () => {
  const MODES = [{ tool: 'Write' }, { tool: 'Read' }, { tool: 'Write', agentId: 'a1' }];
  const TYPES = [...R4_FILES.flatMap(([path, text]) => MODES.map((m) => ({ path, text, ...m }))), { again: true }];
  const next = seeded(11);
  const rand = (n) => Math.floor(next() * n);
  for (let run = 0; run < 2000; run++) {
    const items = Array.from({ length: 1 + rand(4) }, () => TYPES[rand(TYPES.length)]);
    const atOnce = items.flatMap((_, i) => [[i, 'start'], [i, 'land']]);
    const events = [];
    const open = [];
    for (let next = 0; events.length < 2 * items.length;) {
      if (next < items.length && (!open.length || rand(2))) {
        events.push([next, 'start']);
        open.push(next++);
      } else events.push([open.splice(rand(open.length), 1)[0], 'land']);
    }
    const what = () => JSON.stringify({ items: items.map((t) => (t.again ? 'again' : `${t.tool}${t.agentId ? '(agent)' : ''} ${t.path.split('/').at(-1)}`)), events });
    assert.equal(playReads(items, events), playReads(items, atOnce), what());
  }
});
