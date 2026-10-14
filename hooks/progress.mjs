/**
 * banker's /progress, a Claude Mods command: a pane listing how the session's work stands.
 *
 * Steps are the task list Claude keeps (TaskCreate and TaskUpdate, or TodoWrite) until the prompt
 * after the one in which its every item was completed. Without a list, each prompt of the session
 * is a step and the running one is in progress; with nothing at all yet, the pane still shows one
 * step for the work at hand. Under each step are the tool calls made while it was the step in
 * progress (a subagent's or a background agent's included), one level deep. A press on a step or
 * a call shows a short description under the list; a press on a step's arrow folds or unfolds its
 * calls. Of two calls on the task list that overlap, the one begun later stands, and a list or a
 * read begun before a change keeps what changed after it began; the engine's own order of
 * overlapping calls is not something this module can see.
 *
 * Claude 5 models get no task list tool in Claude Code 2.1.296 (only older models, a background
 * job, or CLAUDE_CODE_ENABLE_TODO_TOOLS do). Opening the pane offers the model one of its own
 * (`mcp__banker__todo`, TodoWrite's shape) where it has none, and the list it sends is the steps.
 * Above them the pane shows the plan file the session touched last (progress-plan.mjs reads it):
 * the whole plan as a tree that folds like a toggle list, its sections folded at first.
 * A prompt's harness tags leave its title, and a background task's notice (or a teammate's message)
 * goes on with the last prompt's step instead of becoming one: the step runs again while it does,
 * and keeps its own end and time.
 *
 * `/progress` and `/progress show` toggle the pane, `on` and `off` set it. From Claude Code 2.1.289
 * on the command is registered `immediate`, so it answers while a turn runs; an older engine gets it
 * as a plain command. An engine without mods never loads this file: commands/progress.md and
 * hooks/progress-fallback.mjs answer there instead.
 */

import { cells, clip, fit, parsePlan, pick, planKind, readPrompt } from './progress-plan.mjs';

const COMMAND = 'progress';
const PANE = 'banker-progress';
const TITLE = '진행 상황';
const USAGE = '사용법: /progress [show | on | off]. show(기본)는 패널을 켜고 끄며, on 과 off 는 그대로 켜거나 끕니다.';
const HINT = '단계나 하위 항목을 누르면 설명이 여기에 나옵니다.';
const MAX_STEPS = 50;
const MAX_KEPT_CALLS = 200;
const MAX_SHOWN_CALLS = 30;
// Rows of the plan's tree shown at most, and the characters they hold: the engine draws 100,000
// characters a drawing and blanks the rest, so a long plan must leave room for the steps and the
// description below it. One line past them says how many more rows there are.
const MAX_TREE_ROWS = 300;
const MAX_TREE_TEXT = 40000;
// The calls whose file, when it is a plan file, becomes the plan the pane shows.
const PLAN_TOUCH = new Set(['Write', 'Edit', 'MultiEdit', 'Read', 'NotebookEdit']);
// The id of the step made for work already under way when the module loaded mid-turn.
const AT_HAND = 'now';
// The pane's own to-do tool. The model calls it as `mcp__<plugin>__todo`; it sends the whole list
// each time, as TodoWrite does. Claude Code's own list tools, where the model has one, take its place.
const TODO = 'todo';
export const TODO_TOOL = `mcp__banker__${TODO}`;
const LIST_TOOLS = new Set(['TodoWrite', 'TaskCreate']);
const TODO_STATUS = new Set(['pending', 'in_progress', 'completed']);
const TODO_SPEC = {
  name: TODO,
  description: '진행 상황 패널(/progress)이 켜져 있고, 사람이 이 패널로 지금 하는 일과 남은 일을 본다. '
    + '다음 경우에는 일을 시작하기 전에 이 도구로 할 일 목록 전체를 보낸다: 3단계 이상인 작업, 파일 여러 개를 '
    + '만들거나 고치는 작업, 사용자가 여러 가지를 한꺼번에 시킨 경우. 항목을 시작할 때 in_progress 로, 끝나면 '
    + '바로 completed 로 바꿔 목록 전체를 다시 보낸다. 상태가 바뀔 때만 보내고 같은 목록을 다시 보내지 않는다. '
    + 'in_progress 는 하나만 둔다. 한 단계로 끝나는 일, 질문에 답하기, 대화에는 쓰지 않는다. '
    + '패널이 꺼져 있다고 답하면 다시 부르지 않는다.',
  inputSchema: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: '할 일 목록 전체, 하는 순서대로',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: '할 일 한 줄' },
            status: { type: 'string', enum: [...TODO_STATUS] },
            activeForm: { type: 'string', description: '진행 중일 때 보일 문구(선택)' },
          },
          required: ['content', 'status'],
          additionalProperties: false,
        },
      },
    },
    required: ['todos'],
    additionalProperties: false,
  },
};
// Bookkeeping calls: they become steps, not calls under a step.
const TASK_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'TodoWrite', TODO_TOOL]);
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
// How a notice's turn ended other than with an answer, as the row under its step says it.
const NOTICE_END = { aborted: '알림 처리 중단됨', refusal: '알림 처리 거절됨', error: '알림 처리 오류로 끝남' };
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

// `rev` counts the task changes (TaskCreate, TaskUpdate) taken in, and `order` the calls begun: a TaskList or
// TaskGet begun before a change keeps what changed after it began, and of two calls that overlap the one begun later
// stands. `listAt` is the order of the TaskList the list last came from.
// `plan` is the plan last read from `planPath`, `planShut` whether the whole plan is folded and
// `planOpen` the ids of its nodes unfolded. `touch` counts the calls that touched a plan file and
// `taken` is the touch the plan came from, to tell a read that a newer one overtook. `followed` is the step in
// progress the pane last brought into view.
export const freshState = () => ({ turns: [], tasks: new Map(), todos: null, loose: looseStep(), open: new Set(), selected: null, seq: 0, rev: 0,
  order: 0, listAt: 0, plan: null, planPath: null, planShut: false, planOpen: new Set(), touch: 0, taken: 0, followed: null });

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
  const word = pick(NOTICE, said.status) ?? '백그라운드 작업 알림';
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

// A main turn's start. A subagent's, a fork's or a teammate's run (it carries an agentId; Claude Code 2.1.300
// raises turn.start for them too) makes no step: its calls go under the step in progress.
export function startTurn(s, e, now) {
  if (e.agentId) return;
  const said = readPrompt(e.text);
  if (said.kind === 'notice') return noticeTurn(s, e, said, now);
  dropFinished(s);
  addTurn(s, e.turnId, said.text, now);
}

// A main turn's end; a subagent's (it carries an agentId) ends no step, and a notice's leaves its
// step's own end as it was. A notice's turn that did not end with an answer (stopped, refused, an
// error) adds a row saying so under the step. A turn the module never saw start (it loaded mid-turn)
// ends the step for the work at hand.
export function endTurn(s, e, now) {
  if (e.agentId) return;
  const host = s.turns.find((x) => x.notices.has(e.turnId));
  if (host) {
    host.notices.delete(e.turnId);
    const how = pick(NOTICE_END, e.reason);
    if (how) note(s, host, how, false, now);
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

// Notes on a task still on the list the order of the call that last changed or read it.
function mark(s, id, key, order) {
  const held = s.tasks.get(id);
  if (held) held[key] = order;
}

// A task this module never saw (a list from before it loaded, or one another session shares) joins
// the list while it is not done. Of two updates to one task, the one begun later stands.
function updateTask(s, e, r, now, { order }) {
  const id = String(e.taskId);
  const held = s.tasks.get(id);
  if (held && order < (held.updAt ?? 0)) return;
  const status = r?.result?.statusChange?.to ?? e.status;
  if (status === 'deleted') {
    s.tasks.delete(id);
    return;
  }
  if (!held && status !== 'pending' && status !== 'in_progress') return;
  putTask(s, { id, subject: e.subject, description: e.description, activeForm: e.activeForm, status }, now);
  mark(s, id, 'updAt', order);
}

// Whether the pane changed a task after a list or a read of it began.
const changedSince = (held, since) => (held.changedRev ?? 0) > since;
// Whether a read begun at (since, order) is older than what the pane holds of a task.
const behind = (held, since, order) => Boolean(held) && (changedSince(held, since) || order < (held.seenAt ?? 0));

// One task a TaskList names: as the pane holds it where it changed since the list began, else as listed.
function takeListed(s, before, t, { over, since, order, now }) {
  const id = String(t.id);
  const held = before.get(id);
  if (held) s.tasks.set(id, held);
  if (held && changedSince(held, since)) return;
  if (held || !over) putTask(s, { id, subject: t.subject, status: t.status }, now);
  mark(s, id, 'seenAt', order);
}

// TaskList names the whole list, in its order: a task it leaves out is gone, unless it changed after the list
// began. A list whose every task is completed is over, and only brings up to date the tasks still on the pane. A
// list begun before one already taken in changes nothing.
function listTasks(s, _e, r, now, { since, order }) {
  const listed = r?.result?.tasks;
  if (!Array.isArray(listed) || order < s.listAt) return;
  s.listAt = order;
  const over = listed.every((t) => t.status === 'completed');
  const before = s.tasks;
  const named = new Set(listed.map((t) => String(t.id)));
  s.tasks = new Map();
  for (const t of listed) takeListed(s, before, t, { over, since, order, now });
  for (const [id, held] of before) if (!named.has(id) && changedSince(held, since)) s.tasks.set(id, held);
}

// TaskGet reads one task: one it cannot find is gone, and a completed one off the pane stays off. A read older than
// what the pane holds of the task changes nothing.
function getTask(s, e, r, now, { since, order }) {
  if (behind(s.tasks.get(String(e.taskId)), since, order)) return;
  const t = r?.result?.task;
  if (t === null) s.tasks.delete(String(e.taskId));
  if (!t || (t.status === 'completed' && !s.tasks.has(String(t.id)))) return;
  putTask(s, { id: String(t.id), subject: t.subject, description: t.description, status: t.status }, now);
  mark(s, String(t.id), 'seenAt', order);
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
// TaskList and TaskGet run beside other calls (`since` is the count of changes when one began, `order` its place
// among the calls begun): what changed after it began, or what a later-begun call already brought, stays.
const refused = (r) => Boolean(r?.deny || r?.isError || r?.result?.success === false);
const CHANGES = new Set(['TaskCreate', 'TaskUpdate']);
// The task a TaskCreate or TaskUpdate changed.
const changedId = (e, r) => String(e.tool === 'TaskCreate' ? r?.result?.task?.id : e.taskId);

export function noteTaskTool(s, e, r, now, since = s.rev, order = ++s.order) {
  if (refused(r)) return;
  TASK_NOTES[e.tool]?.(s, e, r, now, { since, order });
  if (!CHANGES.has(e.tool)) return;
  s.rev += 1;
  const held = s.tasks.get(changedId(e, r));
  if (held) held.changedRev = s.rev;
}

// The list a to-do call sent, each item's words cleaned, or what is wrong with it.
export function readTodos(todos) {
  if (!Array.isArray(todos)) return 'todos 는 할 일의 배열이어야 합니다.';
  if (todos.length > MAX_STEPS) return `할 일은 ${MAX_STEPS}개까지 보낼 수 있습니다.`;
  const out = [];
  for (const t of todos) {
    const content = typeof t?.content === 'string' ? clip(t.content, 200) : '';
    if (!content || !TODO_STATUS.has(t.status)) return '항목마다 content(할 일)와 status(pending, in_progress, completed 중 하나)가 있어야 합니다.';
    out.push({ content, status: t.status, activeForm: typeof t.activeForm === 'string' ? clip(t.activeForm, 80) : undefined });
  }
  return out;
}

// What the to-do tool answers, in words that say what happened. The list goes to the pane as
// TodoWrite's would, kept while the pane is closed too, so it shows when the pane opens again; the
// model is told it need not send more meanwhile. A subagent's list is its own, as with TodoWrite, and
// leaves the session's as it is. A list that is not one is refused, so the model reads why.
export function answerTodo(s, e, now, paneOpen = true) {
  const todos = readTodos(e.todos);
  if (typeof todos === 'string') return { deny: todos };
  if (e.agentId) return { result: '하위 에이전트의 할 일 목록은 진행 상황 패널에 보이지 않습니다. 이 도구를 부르지 않아도 됩니다.' };
  writeTodos(s, { todos }, now);
  if (!paneOpen) return { result: '진행 상황 패널이 꺼져 있습니다. 목록은 받아 두었고, 패널이 다시 켜질 때까지 이 도구를 부르지 않아도 됩니다.' };
  const going = todos.filter((t) => t.status === 'in_progress').length;
  return { result: `진행 상황 패널에 할 일 ${todos.length}개를 보였습니다(진행 중 ${going}개).` };
}

// The plan file a call touched, with the touch's count, when it is one and the call went through:
// a write by anyone, a read by the session itself (an agent reviewing a plan does not make it the plan).
// `own` is a write by the session itself; `weak` a review round or open questions beside a plan.
export function planTouched(s, e, call) {
  const path = e.file_path ?? e.notebook_path;
  const kind = planKind(path);
  if (!call?.ok || !PLAN_TOUCH.has(e.tool) || !kind || (e.tool === 'Read' && e.agentId)) return null;
  s.touch += 1;
  return { path, touch: s.touch, own: !e.agentId && e.tool !== 'Read', weak: kind === 'weak' };
}

function parsed(path, text) {
  try {
    return typeof text === 'string' ? parsePlan(path, text) : null;
  } catch {
    return null; /* a plan the parser trips on leaves the pane as it was */
  }
}

// Whether a read may change the plan: a read for a touch newer than the one the plan came from, or a
// read again of the plan's own file (begun when `since` touches were counted) that no touch taken
// in the meantime overtook.
function current(s, path, { touch, since }) {
  if (touch !== undefined) return touch > s.taken;
  return path === s.planPath && s.taken <= since;
}

// Whether what was read stays off the pane: no plan; a review round or open questions while the pane shows another
// plan; or a file with no steps in place of a plan that has some, unless the session wrote it itself (an agent's
// review written beside a plan, or a note the session only read, does not push the plan away; a plan the session
// writes is the plan, steps or not).
const keepsOff = (s, path, plan, read) => !plan
  || (path !== s.planPath && Boolean(s.plan) && read.weak === true)
  || (path !== s.planPath && !plan.total && Boolean(s.plan?.total) && !read.own);

// The ids in a tree, to keep the unfolded ones that are still there when a plan is read again.
function treeIds(nodes, out = new Set()) {
  for (const n of nodes) {
    out.add(n.id);
    treeIds(n.children, out);
  }
  return out;
}

// What a read of a plan file found (`read` is `{ touch }` for a touch's read, `{ since }` for a read
// again). A file that cannot be read or is no plan leaves the plan as it was. Another plan starts
// folded; the same plan read again keeps the nodes unfolded that it still holds.
export function takePlan(s, path, text, read = {}) {
  if (!current(s, path, read)) return;
  const plan = parsed(path, text);
  if (keepsOff(s, path, plan, read)) return;
  const moving = path !== s.planPath;
  if (read.touch !== undefined) s.taken = read.touch;
  if (moving && s.selected === 'plan') s.selected = null;
  const ids = treeIds(plan.tree);
  s.planOpen = moving ? new Set() : new Set([...s.planOpen].filter((id) => ids.has(id)));
  s.planPath = path;
  s.plan = { ...plan, path };
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

// The key of the step in progress (a task or a to-do item in progress, or the prompt that runs), or null.
const runningKey = (s) => [...steps(s)].reverse().find((t) => ['in_progress', 'running'].includes(statusOf(t)))?.key ?? null;

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
  const done = plan.hasStates ? `, 완료 ${plan.done}개` : '';
  const count = plan.total ? ` 단계 ${plan.total}개${done}.` : '';
  const cut = plan.cut ? ' 파일이 길어 앞부분만 읽었습니다.' : '';
  const many = plan.treeCut ? ' 항목이 많아 앞부분만 보입니다.' : '';
  return `${where}.${count}${cut}${many}`;
}

// What the person pressed last, while it is still on the pane: the plan, a step, or a call under one.
// A plan's sections fold where they are pressed, and say nothing more below.
function pressed(s) {
  if (s.plan && s.selected === 'plan') return { key: 'plan', isPlan: true };
  const all = steps(s);
  return all.find((x) => x.key === s.selected) ?? all.flatMap((x) => x.calls).find((c) => c.key === s.selected);
}

function itemWords(s, item, now) {
  if (item.isPlan) return planWords(s.plan);
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

// The plan's row: its title in bold (a Button draws its Text children in place of its label) and,
// where its steps say, how far along it is.
function planHead(ui, s, act) {
  const { Box, Text, Button } = ui;
  const { plan } = s;
  const count = !plan.total ? '' : plan.hasStates ? `${plan.done}/${plan.total} 완료` : `${plan.total}단계`;
  const arrow = plan.tree.length
    ? Button({ key: 'arrow-plan', label: s.planShut ? '▸' : '▾', plain: true, onPress: () => act.foldPlan() })
    : Text({ children: [' '] });
  const label = room(`계획: ${plan.title}`, act, 2, count);
  return Box({ key: 'row-plan', flexDirection: 'row', columnGap: 1, children: [
    arrow,
    Button({ key: 'plan', label, plain: true, onPress: () => act.select('plan'), children: [Text({ bold: true, children: [label] })] }),
    ...(count ? [Text({ children: [count], dimColor: true })] : []),
  ] });
}

// A node's state on the pane: its checkbox's word, or how many of the checkboxes under it are done.
const nodeState = (n) => n.count ?? PLAN_STATUS[n.status] ?? '';
const NODE_STYLE = { head: { bold: true }, story: { bold: true }, 'code-line': { dimColor: true } };
// A part of a row that keeps its width while the words beside it wrap.
const fixed = (ui, children) => ui.Box({ flexShrink: 0, children });

// A node's row: an arrow where it holds nodes, its number or dash, its words (wrapping on the pane's
// width; a press on them folds it too) and its state.
function nodeRow(ui, s, n, depth, act) {
  const { Box, Text, Button } = ui;
  const holds = n.children.length > 0;
  const fold = () => act.foldNode(n.id);
  const words = Text({ children: [n.text], wrap: 'wrap', ...(pick(NODE_STYLE, n.kind) ?? {}) });
  const state = nodeState(n);
  return Box({ key: `row-${n.id}`, flexDirection: 'row', columnGap: 1, paddingLeft: depth * 2, children: [
    holds ? Button({ key: `arrow-${n.id}`, label: s.planOpen.has(n.id) ? '▾' : '▸', plain: true, onPress: fold }) : Text({ children: [' '] }),
    ...(n.marker ? [fixed(ui, [Text({ children: [n.marker] })])] : []),
    holds ? Button({ key: n.id, label: n.text, plain: true, onPress: fold, children: [words] }) : words,
    ...(state ? [fixed(ui, stateWord(ui, state, n.status === 'in_progress'))] : []),
  ] });
}

// The plan's nodes as rows, what a folded node holds left out: rows while they stay within
// MAX_TREE_ROWS and MAX_TREE_TEXT characters, then how many more would show.
function treeRows(ui, s, act) {
  const rows = [];
  let more = 0;
  let used = 0;
  const visit = (nodes, depth) => {
    for (const n of nodes) {
      used += n.text.length + (n.marker?.length ?? 0);
      if (!more && rows.length < MAX_TREE_ROWS && used <= MAX_TREE_TEXT) rows.push(nodeRow(ui, s, n, depth, act));
      else more += 1;
      if (n.children.length && s.planOpen.has(n.id)) visit(n.children, depth + 1);
    }
  };
  visit(s.plan.tree, 1);
  return { rows, more };
}

// The plan's rows: its title, then its tree unless folded, then a line for the rows past the first 300.
function planRows(ui, s, act) {
  const { Box, Text } = ui;
  if (!s.plan) return [];
  const rows = [planHead(ui, s, act)];
  if (!s.planShut) {
    const tree = treeRows(ui, s, act);
    rows.push(...tree.rows);
    if (tree.more) rows.push(Box({ key: 'plan-more', paddingLeft: 2, children: [Text({ children: [`외 ${tree.more}줄`], dimColor: true })] }));
    if (s.plan.cut || s.plan.treeCut) rows.push(Box({ key: 'plan-cut', paddingLeft: 2, children: [Text({ children: ['계획이 길어 앞부분만 보입니다'], dimColor: true })] }));
  }
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

// Offers the model the to-do tool where it has no task list tool of Claude Code's and the tool is not
// there yet. An engine without a tool list offers nothing; a registration the engine refuses (`--bare`,
// a user MCP server of the same name) is said in one line, and the pane goes on with prompts as steps.
async function offerTodo($) {
  let tools;
  try {
    tools = await $.tool.list();
  } catch {
    return;
  }
  if (tools.some((t) => LIST_TOOLS.has(t.name) || t.name === TODO_TOOL)) return;
  try {
    await $.tool.register(TODO_SPEC);
  } catch (e) {
    $.ui.log(`할 일 도구를 등록하지 못했습니다(${clip(e?.message ?? e, 120)}). 진행 상황 패널은 요청을 단계로 보입니다.`);
  }
}

// `show` (the default) toggles what the person sees; `on` and `off` set the pane whatever it was.
// Opening it offers the to-do tool, from the next prompt on.
export async function runProgress($, args) {
  const want = String(args ?? '').trim().toLowerCase() || 'show';
  if (!['show', 'on', 'off'].includes(want)) return { text: USAGE };
  const pane = (await $.ui.panes()).find((p) => p.id === PANE);
  if (want === 'off' || (want === 'show' && pane?.isShown)) {
    if (pane) await $.ui.close({ id: PANE });
    return {};
  }
  await showPane($, pane);
  await offerTodo($);
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
  const order = ++s.order;
  const call = startCall(s, e, Date.now());
  let r = { isError: true };
  try {
    r = await next(e);
    return r;
  } finally {
    endCall(call, r, Date.now());
    if (TASK_TOOLS.has(e.tool)) noteTaskTool(s, e, r, Date.now(), since, order);
    const touched = planTouched(s, e, call);
    if (touched) takePlan(s, touched.path, await readText($, touched.path), { touch: touched.touch, own: touched.own, weak: touched.weak });
    $.ui.invalidate('ui.render');
    void progressFollow($);
  }
}

// A file's text, or null where it cannot be read (missing, over the engine's 4 MiB, refused) or is no
// plain file: a plan path that leads to a pipe or a device would hold the read, and the hooks worker.
async function readText($, path) {
  try {
    if ((await $.fs.stat(path)).kind !== 'file') return null;
  } catch {
    /* an engine without stat, or nothing there: the read below tells */
  }
  try {
    return await $.fs.read(path);
  } catch {
    return null;
  }
}

// The session's progress, one per loaded module.
const ref = { s: freshState() };

// Brings the step in progress into the pane's window when it changes (a task started, a new prompt): in a long list
// it can sit below the window. `nearest` moves nothing while its row shows, and the person's own scrolling stands
// until the next change. A refusal (the pane is closed: no surface) or an engine without the move changes nothing.
export async function progressFollow($) {
  const key = runningKey(ref.s);
  if (!key || key === ref.s.followed) return;
  ref.s.followed = key;
  try {
    await $.ui.scroll({ to: { key: `row-${key}` }, in: PANE, block: 'nearest' });
  } catch {
    /* an engine without $.ui.scroll */
  }
}

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
  // The to-do tool: this hook answers it, and its schema is listed up front rather than behind
  // ToolSearch, so the model sees it without asking.
  on('tool.call', { tool: TODO_TOOL }, async ($, e) => {
    let open = true;
    try {
      open = (await $.ui.panes()).some((p) => p.id === PANE);
    } catch {
      /* the pane list failed: take the list as for an open pane rather than refuse it */
    }
    const answer = answerTodo(ref.s, e, Date.now(), open);
    $.ui.invalidate('ui.render');
    void progressFollow($);
    return answer;
  }).catch(() => ({ deny: '진행 상황 패널이 할 일 목록을 받지 못했습니다.' }));
  on('tool.describe', { tool: TODO_TOOL }, async (_$, e, next) => ({ ...(await next(e)), isDeferred: false })).catch(() => undefined);
  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e);
    const redraw = () => $.ui.invalidate('ui.render');
    const cols = Number.isFinite(e.props?.bodyColumns) ? e.props.bodyColumns : Infinity;
    const act = {
      cols,
      select: (key) => { ref.s.selected = ref.s.selected === key ? null : key; redraw(); },
      fold: (key) => { if (!ref.s.open.delete(key)) ref.s.open.add(key); redraw(); },
      foldPlan: () => { ref.s.planShut = !ref.s.planShut; redraw(); },
      foldNode: (id) => { if (!ref.s.planOpen.delete(id)) ref.s.planOpen.add(id); redraw(); },
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

// The plan file to read again as a turn starts and ends (register.mjs reads it), with the touches
// counted when the read begins; null without a plan.
export function progressPlanTarget() {
  return ref.s.planPath ? { path: ref.s.planPath, since: ref.s.touch } : null;
}

export function progressPlanRead(target, text) {
  takePlan(ref.s, target.path, text, { since: target.since });
}
