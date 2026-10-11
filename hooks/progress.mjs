/**
 * banker's /progress, a Claude Mods command: a pane listing how the session's work stands.
 *
 * Steps are the task list Claude keeps (TaskCreate and TaskUpdate, or TodoWrite) until the prompt
 * after the one in which its every item was completed. Without a list, each prompt of the session
 * is a step and the running one is in progress; with nothing at all yet, the pane still shows one
 * step for the work at hand. Under each step are the tool calls made while it was the step in
 * progress (a subagent's or a background agent's included), one level deep. A press on a step or
 * a call shows a short description under the list; a press on a step's arrow folds or unfolds its
 * calls.
 *
 * Claude 5 models get no task list tool in Claude Code 2.1.296 (only older models, a background
 * job, or CLAUDE_CODE_ENABLE_TODO_TOOLS do), so there prompts are the steps. Above them the pane
 * shows the plan file the session touched last (progress-plan.mjs reads it), as steps of its own.
 * A prompt's harness tags leave its title, and a background task's notice (or a teammate's message)
 * goes on with the last prompt's step instead of becoming one: the step runs again while it does,
 * and keeps its own end and time.
 *
 * `/progress` and `/progress show` toggle the pane, `on` and `off` set it. The command is
 * registered `immediate`, so it answers while a turn runs. An engine without mods never loads
 * this file: commands/progress.md and hooks/progress-fallback.mjs answer there instead.
 */

import { cells, clip, fit, isPlanPath, parsePlan, readPrompt } from './progress-plan.mjs';

const COMMAND = 'progress';
const PANE = 'banker-progress';
const TITLE = '진행 상황';
const USAGE = '사용법: /progress [show | on | off]. show(기본)는 패널을 켜고 끄며, on 과 off 는 그대로 켜거나 끕니다.';
const HINT = '단계나 하위 항목을 누르면 설명이 여기에 나옵니다.';
const MAX_STEPS = 50;
const MAX_KEPT_CALLS = 200;
const MAX_SHOWN_CALLS = 30;
const MAX_SHOWN_PLAN = 20;
// The calls whose file, when it is a plan file, becomes the plan the pane shows.
const PLAN_TOUCH = new Set(['Write', 'Edit', 'MultiEdit', 'Read', 'NotebookEdit']);
// The id of the step made for work already under way when the module loaded mid-turn.
const AT_HAND = 'now';
// Bookkeeping calls: they become steps, not calls under a step.
const TASK_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'TodoWrite']);
const STATUS = {
  running: '진행 중', in_progress: '진행 중', pending: '대기', done: '완료', completed: '완료',
  stopped: '중단됨', refused: '거절됨', failed: '오류로 끝남',
};
// A plan step's state, as progress-plan.mjs names it.
const PLAN_STATUS = { completed: '완료', in_progress: '진행 중', pending: '대기', failed: '실패', blocked: '막힘' };
// A notice's row, by the status it came with.
const NOTICE = {
  completed: '백그라운드 작업 끝남', failed: '백그라운드 작업 실패', stopped: '백그라운드 작업 중지됨',
  killed: '백그라운드 작업 중지됨', message: '팀원 메시지',
};
// How a prompt's turn ended (turn.complete's reason), as its step's state.
const ENDED = { answer: 'done', aborted: 'stopped', refusal: 'refused', error: 'failed' };
// Why a hook failed (the kind of the engine's HookFailure), for a failure that brings no message.
const FAILURES = { throw: '오류', timeout: '시간 초과', 're-entry': '중첩 호출' };
// The argument a call's row names it by.
const LABEL_ARG = {
  Bash: 'command', Read: 'file_path', Write: 'file_path', Edit: 'file_path', NotebookEdit: 'notebook_path',
  Grep: 'pattern', Glob: 'pattern', WebFetch: 'url', WebSearch: 'query', Agent: 'description', Task: 'description',
  Skill: 'skill',
};
const PATH_ARGS = new Set(['file_path', 'notebook_path']);

// What a step keeps of its calls: the newest ones, how many it had and how many of them failed.
const tally = () => ({ calls: [], count: 0, failed: 0 });
// The calls made while the task list has no task in progress.
const looseStep = () => ({ key: 'loose', title: '작업 목록 밖의 작업', ...tally() });

// `rev` counts the task changes (TaskCreate, TaskUpdate) taken in, to tell a stale TaskList or TaskGet.
// `plan` is the plan last read from `planPath`, `planShut` whether its steps are folded, and `touch`
// counts the calls that touched a plan file, to tell a read a newer touch overtook.
export const freshState = () => ({ turns: [], tasks: new Map(), todos: null, loose: looseStep(), open: new Set(), selected: null, seq: 0, rev: 0,
  plan: null, planPath: null, planShut: false, touch: 0 });

const tail = (path) => String(path).split(/[\\/]/).filter(Boolean).slice(-2).join('/');
const seconds = (ms) => {
  const all = Math.max(0, Math.round(ms / 1000));
  return all < 60 ? `${all}초` : `${Math.floor(all / 60)}분 ${all % 60}초`;
};

export function callLabel(e) {
  const arg = LABEL_ARG[e.tool];
  const value = arg && typeof e[arg] === 'string' ? e[arg] : '';
  if (!value) return e.tool;
  return `${e.tool} ${clip(PATH_ARGS.has(arg) ? tail(value) : value, 48)}`;
}

// ── what the module learns from the session ──────────────────────────────────

// A prompt as a step. A prompt whose end never came is done where the next one starts, and so are
// the notices still running on a step. `notices` holds the turns of the notices running on it.
function addTurn(s, turnId, text, now, title) {
  for (const t of s.turns) {
    if (t.status === 'running') Object.assign(t, { status: 'done', endedAt: now });
    t.notices.clear();
  }
  s.turns.push({ key: `t-${turnId}`, id: turnId, title: title ?? (clip(text, 60) || '(이어서 진행)'), text,
    startedAt: now, endedAt: null, status: 'running', notices: new Set(), ...tally() });
  if (s.turns.length > MAX_STEPS) s.turns.shift();
}

// A step's state on the pane: a prompt's step runs again while a notice runs on it.
const statusOf = (step) => (step.notices?.size ? 'running' : step.status);

// A row under a step that is no tool call: it counts as none. `ok` false shows it failed.
function note(s, step, label, ok, now) {
  step.calls.push({ key: `c-${++s.seq}`, tool: '', label: clip(label, 60), detail: clip(label, 240), isNote: true,
    startedAt: now, endedAt: now, ok, steps: [step] });
  if (step.calls.length > MAX_KEPT_CALLS) step.calls.shift();
}

// A background task's end (or a teammate's message) opens a turn of its own: it runs on the last
// prompt's step, under which a row says so, and the list stays as it is. Before any prompt it is a
// step of its own.
function noticeTurn(s, e, said, now) {
  const word = NOTICE[said.status] ?? '백그라운드 작업 알림';
  if (!s.turns.length) addTurn(s, e.turnId, '', now, said.status === 'message' ? word : '백그라운드 작업 알림');
  const t = s.turns.at(-1);
  if (t.id !== e.turnId) t.notices.add(e.turnId);
  if (said.text) note(s, t, `${word}: ${said.text}`, said.status !== 'failed', now);
}

// The task list's items, which are the steps while there are any: TodoWrite's, else the Tasks list's.
function listItems(s) {
  return s.todos?.length ? s.todos : [...s.tasks.values()];
}

// A list whose every item is completed is over, as in Claude Code (TodoWrite drops it at once, the
// Tasks list soon after). It stays on the pane until the next prompt, which is a step again. An
// emptied list takes the calls made outside it along.
function dropFinished(s) {
  const items = listItems(s);
  if (items.some((t) => t.status !== 'completed')) return;
  s.todos = null;
  s.tasks = new Map();
  s.loose = looseStep();
}

export function startTurn(s, e, now) {
  const said = readPrompt(e.text);
  if (said.kind === 'notice') return noticeTurn(s, e, said, now);
  dropFinished(s);
  addTurn(s, e.turnId, said.text, now);
}

// A main turn's end; a subagent's (it carries an agentId) ends no step, and a notice's leaves its
// step's own end as it was. A turn the module never saw start (it loaded mid-turn) ends the step for
// the work at hand.
export function endTurn(s, e, now) {
  if (e.agentId) return;
  const host = s.turns.find((x) => x.notices.has(e.turnId));
  if (host) {
    host.notices.delete(e.turnId);
    return;
  }
  const t = s.turns.find((x) => x.id === e.turnId) ?? s.turns.find((x) => x.id === AT_HAND && x.status === 'running');
  if (!t) return;
  t.status = ENDED[e.reason] ?? 'failed';
  t.endedAt = now;
}

// The steps a call belongs to: the task in progress (or, while the list has none, the calls outside
// the list) and the running prompt, which keeps its calls for when the list is gone. A call before
// any prompt (the module loaded mid-turn) starts the step for the work at hand.
function owners(s, now) {
  const items = listItems(s);
  const task = [...items].reverse().find((t) => t.status === 'in_progress');
  const first = task ?? (items.length ? s.loose : null);
  if (!s.turns.length) addTurn(s, AT_HAND, '지금 하는 작업', now);
  return first ? [first, s.turns.at(-1)] : [s.turns.at(-1)];
}

export function startCall(s, e, now) {
  if (TASK_TOOLS.has(e.tool)) return null;
  const call = { key: `c-${++s.seq}`, tool: e.tool, label: callLabel(e), detail: clip(e[LABEL_ARG[e.tool]] ?? '', 200),
    isAgent: Boolean(e.agentId), startedAt: now, endedAt: null, ok: null, steps: owners(s, now) };
  for (const step of call.steps) {
    step.calls.push(call);
    step.count += 1;
    if (step.calls.length > MAX_KEPT_CALLS) step.calls.shift();
  }
  return call;
}

export function endCall(call, r, now) {
  if (!call) return;
  call.endedAt = now;
  call.ok = !(r?.deny || r?.isError);
  if (!call.ok) for (const step of call.steps) step.failed += 1;
}

// When an item started and ended, as far as this module saw. A reopened item runs on from its start;
// one back to waiting has no time until it starts again.
function stamp(t, status, now) {
  if (status === 'pending') t.startedAt = undefined;
  if (status === 'in_progress') t.startedAt ??= now;
  t.endedAt = status === 'completed' && Number.isFinite(t.startedAt) ? (t.endedAt ?? now) : null;
  t.status = status;
}

// A list longer than the pane holds loses its oldest finished item first, else its oldest.
const overflow = (items) => items.find((t) => t.status === 'completed') ?? items[0];

// One item of a TodoWrite list: while its text stays it is the same step (the first unused one of
// that text), with its key, calls and times.
function todoItem(s, before, d, now) {
  const t = before.get(d.content)?.shift() ?? { key: `d-${++s.seq}`, description: d.content, ...tally() };
  t.title = clip(d.content, 60);
  t.activeForm = d.activeForm;
  stamp(t, d.status, now);
  return t;
}

// TodoWrite sends the whole list each time. A subagent keeps a list of its own, not the session's.
function writeTodos(s, e, now) {
  if (e.agentId || !Array.isArray(e.todos)) return;
  const before = new Map();
  for (const t of s.todos ?? []) before.set(t.description, [...(before.get(t.description) ?? []), t]);
  s.todos = e.todos.map((d) => todoItem(s, before, d, now));
  while (s.todos.length > MAX_STEPS) s.todos.splice(s.todos.indexOf(overflow(s.todos)), 1);
}

// Adds a task or brings it up to date; a task keeps its key, calls and times. One known only by
// its id is named by it until a TaskGet or a TaskList says more.
function putTask(s, t, now) {
  const held = s.tasks.get(t.id) ?? { key: `k-${t.id}`, id: t.id, title: `작업 #${t.id}`, description: '', ...tally() };
  const title = clip(t.subject, 60);
  if (title) held.title = title;
  for (const k of ['description', 'activeForm']) if (t[k] !== undefined) held[k] = t[k];
  if (t.status !== undefined) stamp(held, t.status, now);
  s.tasks.set(t.id, held);
  while (s.tasks.size > MAX_STEPS) s.tasks.delete(overflow([...s.tasks.values()]).id);
}

function createTask(s, e, r, now) {
  const id = r?.result?.task?.id;
  if (id === undefined) return;
  putTask(s, { id: String(id), subject: e.subject, description: e.description, activeForm: e.activeForm, status: 'pending' }, now);
}

// A task this module never saw (a list from before it loaded, or one another session shares) joins
// the list while it is not done.
function updateTask(s, e, r, now) {
  const id = String(e.taskId);
  const status = r?.result?.statusChange?.to ?? e.status;
  if (status === 'deleted') {
    s.tasks.delete(id);
    return;
  }
  if (!s.tasks.has(id) && status !== 'pending' && status !== 'in_progress') return;
  putTask(s, { id, subject: e.subject, description: e.description, activeForm: e.activeForm, status }, now);
}

// TaskList names the whole list, in its order: a task it leaves out is gone. A list whose every task
// is completed is over, and only brings up to date the tasks still on the pane.
function listTasks(s, _e, r, now, since) {
  const listed = r?.result?.tasks;
  if (since !== s.rev || !Array.isArray(listed)) return;
  const over = listed.every((t) => t.status === 'completed');
  const before = s.tasks;
  s.tasks = new Map();
  for (const t of listed) {
    const id = String(t.id);
    if (before.has(id)) s.tasks.set(id, before.get(id));
    if (before.has(id) || !over) putTask(s, { id, subject: t.subject, status: t.status }, now);
  }
}

// TaskGet reads one task: one it cannot find is gone, and a completed one off the pane stays off.
function getTask(s, e, r, now, since) {
  if (since !== s.rev) return;
  const t = r?.result?.task;
  if (t === null) s.tasks.delete(String(e.taskId));
  if (!t || (t.status === 'completed' && !s.tasks.has(String(t.id)))) return;
  putTask(s, { id: String(t.id), subject: t.subject, description: t.description, status: t.status }, now);
}

const TASK_NOTES = {
  TaskCreate: createTask,
  TaskUpdate: updateTask,
  TaskList: listTasks,
  TaskGet: getTask,
  TodoWrite: (s, e, _r, now) => writeTodos(s, e, now),
};

// A refused or failed call changes nothing: the task list stays as Claude Code holds it. A TaskUpdate
// that changed nothing (an id it cannot find, a TaskCompleted hook that blocks) answers
// `success: false` without isError.
// TaskList and TaskGet run beside other calls: one that read the list before a change landed (`since`,
// the count when it started, is behind) is stale and changes nothing.
const refused = (r) => Boolean(r?.deny || r?.isError || r?.result?.success === false);
const CHANGES = new Set(['TaskCreate', 'TaskUpdate']);

export function noteTaskTool(s, e, r, now, since) {
  if (refused(r)) return;
  TASK_NOTES[e.tool]?.(s, e, r, now, since ?? s.rev);
  if (CHANGES.has(e.tool)) s.rev += 1;
}

// The plan file a call touched, with the touch's count, when it is one and the call went through:
// a write by anyone, a read by the session itself (an agent reviewing a plan does not make it the plan).
export function planTouched(s, e, call) {
  const path = e.file_path ?? e.notebook_path;
  if (!call?.ok || !PLAN_TOUCH.has(e.tool) || !isPlanPath(path) || (e.tool === 'Read' && e.agentId)) return null;
  s.touch += 1;
  return { path, touch: s.touch };
}

function parsed(path, text) {
  try {
    return typeof text === 'string' ? parsePlan(path, text) : null;
  } catch {
    return null; /* a plan the parser trips on leaves the pane as it was */
  }
}

// What a read of a plan file found. A read for the newest touch (`touch`) makes its file the plan,
// and a read again (no `touch`) of the plan's own file brings it up to date. A file that cannot be
// read or is no plan leaves the plan as it was; so does a read that a newer touch overtook.
export function takePlan(s, path, text, touch) {
  const again = path === s.planPath;
  if (touch === undefined ? !again : touch !== s.touch) return;
  const plan = parsed(path, text);
  if (!plan) return;
  if (!again && (s.selected === 'plan' || /^p-\d+$/.test(s.selected ?? ''))) s.selected = null;
  s.planPath = path;
  s.plan = { ...plan, path, steps: plan.steps.map((st, i) => ({ ...st, key: `p-${i}`, planStep: true })) };
}

// ── what the pane shows ──────────────────────────────────────────────────────

// Nothing seen yet: one step that says so, with no state word beside it.
const IDLE = { key: 'idle', title: '진행 중인 작업 없음', status: null, ...tally() };

// The calls outside the list are in progress while calls still go there: no task is in progress
// and the prompt runs.
function looseStatus(s, items) {
  const last = s.turns.at(-1);
  const going = !items.some((t) => t.status === 'in_progress') && last !== undefined && statusOf(last) === 'running';
  return going ? 'running' : 'done';
}

export function steps(s) {
  const items = listItems(s);
  if (!items.length) return s.turns.length ? s.turns : [IDLE];
  return s.loose.calls.length ? [...items, { ...s.loose, status: looseStatus(s, items) }] : items;
}

function callCount(step) {
  return `도구 호출 ${step.count}회${step.failed ? `(실패 ${step.failed}회)` : ''}`;
}

function stepState(step, now) {
  const status = statusOf(step);
  const doing = status === 'in_progress' && step.activeForm ? `(${clip(step.activeForm, 40)})` : '';
  const time = Number.isFinite(step.startedAt) ? `, ${seconds((step.endedAt ?? now) - step.startedAt)}` : '';
  return `${STATUS[status] ?? status}${doing}${time}`;
}

function stepWords(step, now) {
  if (step.key === 'idle') return '아직 시작한 작업이 없습니다. 요청을 보내면 여기에 단계가 쌓입니다.';
  const words = step.text !== undefined ? `요청: ${clip(step.text, 160) || '(이어서 진행)'}` : clip(step.description || step.title, 160);
  const what = words.replace(/[.!?。]+$/, '');
  return `${what}. ${stepState(step, now)}, ${callCount(step)}.`;
}

function callWords(call, now) {
  if (call.isNote) return `${call.detail.replace(/[.!?。]+$/, '')}.`;
  const state = call.ok === null ? '실행 중' : call.ok ? '성공' : '실패';
  const who = call.isAgent ? '하위 에이전트의 ' : '';
  return `${who}${call.tool}${call.detail ? `: ${call.detail}` : ''}. ${state}, ${seconds((call.endedAt ?? now) - call.startedAt)}.`;
}

function planWords(plan) {
  const where = `계획 파일: ${clip(plan.path.split(/[\\/]/).filter(Boolean).slice(-3).join('/'), 120)}`;
  const cut = plan.cut ? ' 파일 앞 256KiB 만 읽었습니다.' : '';
  if (!plan.total) return `${where}. 단계를 찾지 못했습니다.${cut}`;
  const done = plan.hasStates ? `, 완료 ${plan.done}개` : '';
  return `${where}. 단계 ${plan.total}개${done}.${cut}`;
}

function planStepWords(st) {
  const what = st.text.replace(/[.!?。]+$/, '');
  return st.status ? `${what}. ${PLAN_STATUS[st.status]}.` : `${what}.`;
}

// What the person pressed last, while it is still on the pane: the plan or one of its steps, a
// step, or a call under one.
function pressed(s) {
  if (s.plan && s.selected === 'plan') return { key: 'plan', isPlan: true };
  const plan = s.plan?.steps.find((st) => st.key === s.selected);
  if (plan) return plan;
  const all = steps(s);
  return all.find((x) => x.key === s.selected) ?? all.flatMap((x) => x.calls).find((c) => c.key === s.selected);
}

function itemWords(s, item, now) {
  if (item.isPlan) return planWords(s.plan);
  if (item.planStep) return planStepWords(item);
  return item.tool !== undefined ? callWords(item, now) : stepWords(item, now);
}

// The description under the list: the pressed step's or call's, or how to get one.
export function describe(s, now) {
  const item = pressed(s);
  if (item) return itemWords(s, item, now);
  const all = steps(s);
  return all.length === 1 && all[0].key === 'idle' ? stepWords(IDLE, now) : HINT;
}

// A label cut so that it, the cells before it and the words after it fit on one row of the pane.
const room = (label, act, before, after) => fit(label, (act.cols ?? Infinity) - before - (after ? cells(after) + 1 : 0));

function callRows(ui, step, act) {
  const { Box, Text, Button } = ui;
  const shown = step.calls.slice(-MAX_SHOWN_CALLS);
  const rows = shown.map((c) => {
    const state = c.ok === null ? '실행 중' : c.ok ? '' : '실패';
    return Box({ key: `row-${c.key}`, flexDirection: 'row', columnGap: 1, paddingLeft: 4, children: [
      Button({ key: c.key, label: room(c.label, act, 4, state), plain: true, dimColor: c.ok !== false, onPress: () => act.select(c.key) }),
      ...stateWord(ui, state, false),
    ] });
  });
  const hidden = step.calls.length - shown.length;
  return hidden ? [Box({ paddingLeft: 4, children: [Text({ children: [`앞의 ${hidden}개는 줄였습니다`], dimColor: true })] }), ...rows] : rows;
}

// A row's state word, bold while it runs; none where the state is empty, so no gap is kept for it.
function stateWord(ui, state, running) {
  return state ? [ui.Text({ children: [state], dimColor: !running, bold: running })] : [];
}

function stepRow(ui, s, step, act) {
  const { Box, Text, Button } = ui;
  const isOpen = s.open.has(step.key);
  const arrow = step.calls.length
    ? Button({ key: `arrow-${step.key}`, label: isOpen ? '▾' : '▸', plain: true, onPress: () => act.fold(step.key) })
    : Text({ children: [' '] });
  const status = statusOf(step);
  const state = STATUS[status] ?? status ?? '';
  return Box({ key: `row-${step.key}`, flexDirection: 'row', columnGap: 1, children: [
    arrow,
    Button({ key: step.key, label: room(step.title, act, 2, state), plain: true, onPress: () => act.select(step.key) }),
    ...stateWord(ui, state, status === 'running' || status === 'in_progress'),
  ] });
}

// The plan's row: its title in bold (a Button draws its Text children in place of its label) and
// how far along it is.
function planHead(ui, s, act) {
  const { Box, Text, Button } = ui;
  const { plan } = s;
  const count = !plan.total ? '단계 없음' : plan.hasStates ? `${plan.done}/${plan.total} 완료` : `${plan.total}단계`;
  const arrow = plan.steps.length
    ? Button({ key: 'arrow-plan', label: s.planShut ? '▸' : '▾', plain: true, onPress: () => act.foldPlan() })
    : Text({ children: [' '] });
  const label = room(`계획: ${plan.title}`, act, 2, count);
  return Box({ key: 'row-plan', flexDirection: 'row', columnGap: 1, children: [
    arrow,
    Button({ key: 'plan', label, plain: true, onPress: () => act.select('plan'), children: [Text({ bold: true, children: [label] })] }),
    Text({ children: [count], dimColor: true }),
  ] });
}

// The plan's rows: its title, then its first steps unless folded, then a line for the plan's rest.
function planRows(ui, s, act) {
  const { Box, Text, Button } = ui;
  if (!s.plan) return [];
  const rows = [planHead(ui, s, act)];
  if (s.planShut) return [...rows, Box({ key: 'plan-gap', marginBottom: 1 })];
  const shown = s.plan.steps.slice(0, MAX_SHOWN_PLAN);
  for (const st of shown) {
    const state = PLAN_STATUS[st.status] ?? '';
    rows.push(Box({ key: `row-${st.key}`, flexDirection: 'row', columnGap: 1, paddingLeft: 2, children: [
      Button({ key: st.key, label: room(st.title, act, 2, state), plain: true, onPress: () => act.select(st.key) }),
      ...stateWord(ui, state, st.status === 'in_progress'),
    ] }));
  }
  const rest = s.plan.total - shown.length;
  if (rest > 0) rows.push(Box({ key: 'plan-more', paddingLeft: 2, children: [Text({ children: [`외 ${rest}개`], dimColor: true })] }));
  return [...rows, Box({ key: 'plan-gap', marginBottom: 1 })];
}

// The pane's tree. `ui` is the surface's element table; `act` holds what a press does and `cols`,
// the cells across the pane's body (Infinity where the engine gives none).
export function draw(ui, s, now, act) {
  const { Box, Text } = ui;
  const rows = planRows(ui, s, act);
  for (const step of steps(s)) {
    rows.push(stepRow(ui, s, step, act));
    if (s.open.has(step.key)) rows.push(...callRows(ui, step, act));
  }
  rows.push(Box({ key: 'about', marginTop: 1, children: [Text({ children: [describe(s, now)], dimColor: !pressed(s), wrap: 'wrap' })] }));
  return Box({ flexDirection: 'column', children: rows });
}

// ── the command and the hooks ────────────────────────────────────────────────

// Opens the pane, or raises it from behind another plugin's pane, where it is open but not shown:
// only an open with `focus` raises a pane. A pane opened for a command is placed at any width.
async function showPane($, pane) {
  if (!pane) await $.ui.open({ id: PANE, title: TITLE });
  else if (!pane.isShown) await $.ui.open({ id: PANE, title: TITLE, focus: true });
}

// `show` (the default) toggles what the person sees; `on` and `off` set the pane whatever it was.
export async function runProgress($, args) {
  const want = String(args ?? '').trim().toLowerCase() || 'show';
  if (!['show', 'on', 'off'].includes(want)) return { text: USAGE };
  const pane = (await $.ui.panes()).find((p) => p.id === PANE);
  if (want === 'off' || (want === 'show' && pane?.isShown)) {
    if (pane) await $.ui.close({ id: PANE });
  } else await showPane($, pane);
  return {};
}

// The command's answer when its hook fails (it threw, or ran past its time). Without one the hook
// would be absent, and `/banker:progress` would go on to commands/progress.md, which says mods are
// missing.
function commandFailed(_$, _e, next) {
  const why = next?.error?.message || FAILURES[next?.error?.kind] || '알 수 없는 오류';
  return { text: `진행 상황 패널을 바꾸지 못했습니다(${clip(why, 120)}). 다시 입력해 주세요.` };
}

// The command, which register.mjs registers at session.start with the module's others.
export const SPEC = { name: COMMAND, description: '진행 상황 패널을 켜고 끔(목록, 설명, 하위 목록 펼치기)', argumentHint: '[show | on | off]', immediate: true };

// A call that throws is recorded as failed, so its row does not stay running. A call goes to the
// list it started under: one that ends after /clear leaves the new conversation's list alone.
async function watchCall($, e, next) {
  const s = ref.s;
  const since = s.rev;
  const call = startCall(s, e, Date.now());
  let r = { isError: true };
  try {
    r = await next(e);
    return r;
  } finally {
    endCall(call, r, Date.now());
    if (TASK_TOOLS.has(e.tool)) noteTaskTool(s, e, r, Date.now(), since);
    const touched = planTouched(s, e, call);
    if (touched) takePlan(s, touched.path, await readText($, touched.path), touched.touch);
    $.ui.invalidate('ui.render');
  }
}

// A file's text, or null where it cannot be read (missing, over the engine's 4 MiB, refused).
async function readText($, path) {
  try {
    return await $.fs.read(path);
  } catch {
    return null;
  }
}

// The session's progress, one per loaded module.
const ref = { s: freshState() };

// The command and the events only this feature hooks. register.mjs hooks the events every banker
// feature shares (the engine takes one hook per event from the module) and calls the functions
// below for them. The fallback's name is hooked too: where mods run, `/banker:progress` toggles
// the pane instead of expanding commands/progress.md into a model turn.
export function registerProgress(on) {
  ref.s = freshState();
  on('command.run', { command: 'progress' }, async ($, e) => runProgress($, e.args)).catch(commandFailed);
  on('command.run', { command: 'banker:progress' }, async ($, e) => runProgress($, e.args)).catch(commandFailed);
  // Every tool call passes here: a fault in this hook leaves the call as if the hook were absent.
  on('tool.call', async ($, e, next) => watchCall($, e, next)).catch(() => undefined);
  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e);
    const redraw = () => $.ui.invalidate('ui.render');
    const cols = Number.isFinite(e.props?.bodyColumns) ? e.props.bodyColumns : Infinity;
    const act = {
      cols,
      select: (key) => { ref.s.selected = ref.s.selected === key ? null : key; redraw(); },
      fold: (key) => { if (!ref.s.open.delete(key)) ref.s.open.add(key); redraw(); },
      foldPlan: () => { ref.s.planShut = !ref.s.planShut; redraw(); },
    };
    return draw($.ui.resolve(e), ref.s, Date.now(), act);
  });
}

// A new session, or /clear (session.end, and no session.start after it), starts an empty list.
export function progressReset() {
  ref.s = freshState();
}

export function progressTurnStarted(e) {
  startTurn(ref.s, e, Date.now());
}

export function progressTurnCompleted(e) {
  endTurn(ref.s, e, Date.now());
}

// The plan file to read again as a turn starts and ends (register.mjs reads it), or null.
export function progressPlanPath() {
  return ref.s.planPath;
}

export function progressPlanRead(path, text) {
  takePlan(ref.s, path, text);
}
