/**
 * banker's /progress, a Claude Mods command: a pane listing how the session's work stands.
 *
 * Steps are the task list Claude keeps (TaskCreate and TaskUpdate, or TodoWrite). Without one,
 * each prompt of the session is a step and the running one is in progress; with nothing at all
 * yet, the pane still shows one step for the work at hand. Under each step are the tool calls
 * made while it was the step in progress, one level deep. A press on a step or a call shows a
 * short description under the list; a press on a step's arrow folds or unfolds its calls.
 *
 * `/progress` and `/progress show` toggle the pane, `on` and `off` set it. The command is
 * registered `immediate`, so it answers while a turn runs. An engine without mods never loads
 * this file: commands/progress.md and hooks/progress-fallback.mjs answer there instead.
 */

const COMMAND = 'progress';
const PANE = 'banker-progress';
const TITLE = '진행 상황';
const USAGE = '사용법: /progress [show | on | off]. show(기본)는 패널을 켜고 끄며, on 과 off 는 그대로 켜거나 끕니다.';
const MAX_STEPS = 50;
const MAX_KEPT_CALLS = 200;
const MAX_SHOWN_CALLS = 30;
// Bookkeeping calls: they become steps, not calls under a step.
const TASK_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'TodoWrite']);
const STATUS = {
  running: '진행 중', in_progress: '진행 중', pending: '대기', done: '완료', completed: '완료',
  stopped: '중단됨', failed: '오류로 끝남',
};
// The argument a call's row names it by.
const LABEL_ARG = {
  Bash: 'command', Read: 'file_path', Write: 'file_path', Edit: 'file_path', NotebookEdit: 'notebook_path',
  Grep: 'pattern', Glob: 'pattern', WebFetch: 'url', WebSearch: 'query', Agent: 'description', Task: 'description',
  Skill: 'skill',
};
const PATH_ARGS = new Set(['file_path', 'notebook_path']);

export const freshState = () => ({ turns: [], tasks: new Map(), todos: null, loose: [], open: new Set(), selected: null, seq: 0 });

const clip = (text, n) => {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};
const tail = (path) => String(path).split(/[\\/]/).filter(Boolean).slice(-2).join('/');
const seconds = (ms) => (ms < 60000 ? `${Math.max(0, Math.round(ms / 1000))}초` : `${Math.floor(ms / 60000)}분 ${Math.round((ms % 60000) / 1000)}초`);

export function callLabel(e) {
  const arg = LABEL_ARG[e.tool];
  const value = arg && typeof e[arg] === 'string' ? e[arg] : '';
  if (!value) return e.tool;
  return `${e.tool} ${clip(PATH_ARGS.has(arg) ? tail(value) : value, 48)}`;
}

// ── what the module learns from the session ──────────────────────────────────

export function startTurn(s, e, now) {
  for (const t of s.turns) if (t.status === 'running') t.status = 'done';
  s.turns.push({ key: `t-${e.turnId}`, id: e.turnId, title: clip(e.text, 60) || '(이어서 진행)', text: String(e.text ?? ''),
    startedAt: now, endedAt: null, status: 'running', calls: [] });
  if (s.turns.length > MAX_STEPS) s.turns.shift();
}

export function endTurn(s, e, now) {
  if (e.agentId) return;
  const t = s.turns.find((x) => x.id === e.turnId);
  if (!t) return;
  t.status = e.reason === 'answer' ? 'done' : e.reason === 'aborted' ? 'stopped' : 'failed';
  t.endedAt = now;
}

// The step a call belongs to: the task in progress, or the running prompt. A call made before
// the module saw any prompt (it loaded mid-turn) starts the one step for the work at hand.
function owners(s, now) {
  const list = [];
  const task = [...(s.todos ?? []), ...s.tasks.values()].reverse().find((t) => t.status === 'in_progress');
  if (task) list.push(task);
  else if (s.todos?.length || s.tasks.size) list.push({ calls: s.loose });
  let turn = s.turns.at(-1);
  if (!turn) {
    startTurn(s, { turnId: 'now', text: '지금 하는 작업' }, now);
    turn = s.turns.at(-1);
  }
  list.push(turn);
  return list;
}

export function startCall(s, e, now) {
  if (TASK_TOOLS.has(e.tool)) return null;
  const call = { key: `c-${++s.seq}`, tool: e.tool, label: callLabel(e), detail: clip(e[LABEL_ARG[e.tool]] ?? '', 200),
    isAgent: Boolean(e.agentId), startedAt: now, endedAt: null, ok: null };
  for (const owner of owners(s, now)) {
    owner.calls.push(call);
    if (owner.calls.length > MAX_KEPT_CALLS) owner.calls.shift();
  }
  return call;
}

export function endCall(call, r, now) {
  if (!call) return;
  call.endedAt = now;
  call.ok = !(r?.deny || r?.isError);
}

// TodoWrite sends the whole list each time: an item keeps its calls while its text stays.
function writeTodos(s, todos) {
  const before = new Map((s.todos ?? []).map((t) => [t.title, t]));
  s.todos = todos.map((t, i) => ({ key: `d-${i}`, title: clip(t.content, 60), description: t.content,
    activeForm: t.activeForm, status: t.status, calls: before.get(clip(t.content, 60))?.calls ?? [] }));
}

function updateTask(s, e) {
  const t = s.tasks.get(String(e.taskId));
  if (!t) return;
  if (e.status === 'deleted') {
    s.tasks.delete(String(e.taskId));
    return;
  }
  for (const k of ['description', 'activeForm', 'status']) if (e[k] !== undefined) t[k] = e[k];
  if (e.subject !== undefined) t.title = clip(e.subject, 60);
}

function createTask(s, e, r) {
  const id = r?.result?.task?.id;
  if (id === undefined) return;
  s.tasks.set(String(id), { key: `k-${id}`, id: String(id), title: clip(e.subject, 60), description: e.description ?? '',
    activeForm: e.activeForm, status: 'pending', calls: [] });
}

const TASK_NOTES = {
  TaskCreate: createTask,
  TaskUpdate: updateTask,
  TodoWrite: (s, e) => { if (Array.isArray(e.todos)) writeTodos(s, e.todos); },
};

// A refused or failed call changes nothing: the task list stays as Claude Code holds it.
export function noteTaskTool(s, e, r) {
  if (r?.deny || r?.isError) return;
  TASK_NOTES[e.tool]?.(s, e, r);
}

// ── what the pane shows ──────────────────────────────────────────────────────

// Nothing seen yet: one step that says so, with no state word beside it.
const IDLE = { key: 'idle', title: '진행 중인 작업 없음', status: null, calls: [] };

export function steps(s) {
  const tasks = s.todos?.length ? s.todos : [...s.tasks.values()];
  if (tasks.length) return s.loose.length ? [...tasks, { key: 'loose', title: '작업 목록 밖의 작업', status: 'done', calls: s.loose }] : tasks;
  return s.turns.length ? s.turns : [IDLE];
}

function callCount(step) {
  const failed = step.calls.filter((c) => c.ok === false).length;
  return `도구 호출 ${step.calls.length}회${failed ? `(실패 ${failed}회)` : ''}`;
}

function stepState(step, now) {
  const doing = step.status === 'in_progress' && step.activeForm ? `(${clip(step.activeForm, 40)})` : '';
  const time = step.startedAt ? `, ${seconds((step.endedAt ?? now) - step.startedAt)}` : '';
  return `${STATUS[step.status] ?? step.status}${doing}${time}`;
}

function stepWords(step, now) {
  if (step.key === 'idle') return '아직 시작한 작업이 없습니다. 요청을 보내면 여기에 단계가 쌓입니다.';
  const words = step.text !== undefined ? `요청: ${clip(step.text, 160) || '(이어서 진행)'}` : clip(step.description || step.title, 160);
  const what = words.replace(/[.!?。]+$/, '');
  return `${what}. ${stepState(step, now)}, ${callCount(step)}.`;
}

function callWords(call, now) {
  const state = call.ok === null ? '실행 중' : call.ok ? '성공' : '실패';
  const who = call.isAgent ? '하위 에이전트의 ' : '';
  return `${who}${call.tool}${call.detail ? `: ${call.detail}` : ''}. ${state}, ${seconds((call.endedAt ?? now) - call.startedAt)}.`;
}

// The description under the list: the pressed step's or call's, or how to get one.
export function describe(s, now) {
  const all = steps(s);
  const step = all.find((x) => x.key === s.selected);
  if (step) return stepWords(step, now);
  const call = all.flatMap((x) => x.calls).find((c) => c.key === s.selected);
  if (call) return callWords(call, now);
  return all.length === 1 && all[0].key === 'idle' ? stepWords(IDLE, now) : '단계나 하위 항목을 누르면 설명이 여기에 나옵니다.';
}

function callRows(ui, step, act) {
  const { Box, Text, Button } = ui;
  const shown = step.calls.slice(-MAX_SHOWN_CALLS);
  const rows = shown.map((c) => Box({ key: `row-${c.key}`, flexDirection: 'row', columnGap: 1, paddingLeft: 4, children: [
    Button({ key: c.key, label: c.label, plain: true, dimColor: c.ok !== false, onPress: () => act.select(c.key) }),
    Text({ children: [c.ok === null ? '실행 중' : c.ok ? '' : '실패'], dimColor: true }),
  ] }));
  const hidden = step.calls.length - shown.length;
  return hidden ? [Box({ paddingLeft: 4, children: [Text({ children: [`앞의 ${hidden}개는 줄였습니다`], dimColor: true })] }), ...rows] : rows;
}

function stepRow(ui, s, step, act) {
  const { Box, Text, Button } = ui;
  const isOpen = s.open.has(step.key);
  const arrow = step.calls.length
    ? Button({ key: `arrow-${step.key}`, label: isOpen ? '▾' : '▸', plain: true, onPress: () => act.fold(step.key) })
    : Text({ children: [' '] });
  const running = step.status === 'running' || step.status === 'in_progress';
  return Box({ key: `row-${step.key}`, flexDirection: 'row', columnGap: 1, children: [
    arrow,
    Button({ key: step.key, label: step.title, plain: true, onPress: () => act.select(step.key) }),
    Text({ children: [STATUS[step.status] ?? step.status ?? ''], dimColor: !running, bold: running }),
  ] });
}

// The pane's tree. `ui` is the surface's element table; `act` holds what a press does.
export function draw(ui, s, now, act) {
  const { Box, Text } = ui;
  const rows = [];
  for (const step of steps(s)) {
    rows.push(stepRow(ui, s, step, act));
    if (s.open.has(step.key)) rows.push(...callRows(ui, step, act));
  }
  rows.push(Box({ key: 'about', marginTop: 1, children: [Text({ children: [describe(s, now)], dimColor: !s.selected, wrap: 'wrap' })] }));
  return Box({ flexDirection: 'column', children: rows });
}

// ── the command and the hooks ────────────────────────────────────────────────

// `show` (the default) toggles; `on` and `off` set the pane whatever it was.
export async function runProgress($, args) {
  const want = String(args ?? '').trim().toLowerCase() || 'show';
  if (!['show', 'on', 'off'].includes(want)) return { text: USAGE };
  const isUp = (await $.ui.panes()).some((p) => p.id === PANE);
  if (want === 'off' || (want === 'show' && isUp)) {
    if (isUp) await $.ui.close({ id: PANE });
    return {};
  }
  const opened = await $.ui.open({ id: PANE, title: TITLE });
  if (opened && opened.isPlaced === false) return { text: `진행 패널을 열었지만 아직 화면에 놓이지 않았습니다(${opened.reason}). 터미널 창을 넓혀 주십시오.` };
  return {};
}

// The command, which register.mjs registers at session.start with the module's others.
export const SPEC = { name: COMMAND, description: '진행 상황 패널을 켜고 끔(목록, 설명, 하위 목록 펼치기)', argumentHint: '[show | on | off]', immediate: true };

// A call that throws is recorded as failed, so its row does not stay running.
async function watchCall($, e, next) {
  const call = startCall(ref.s, e, Date.now());
  let r = { isError: true };
  try {
    r = await next(e);
    return r;
  } finally {
    endCall(call, r, Date.now());
    if (TASK_TOOLS.has(e.tool)) noteTaskTool(ref.s, e, r);
    $.ui.invalidate('ui.render');
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
  on('command.run', { command: 'progress' }, async ($, e) => runProgress($, e.args));
  on('command.run', { command: 'banker:progress' }, async ($, e) => runProgress($, e.args));
  // Every tool call passes here: a fault in this hook leaves the call as if the hook were absent.
  on('tool.call', async ($, e, next) => watchCall($, e, next)).catch(() => undefined);
  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e);
    const redraw = () => $.ui.invalidate('ui.render');
    const act = {
      select: (key) => { ref.s.selected = ref.s.selected === key ? null : key; redraw(); },
      fold: (key) => { if (!ref.s.open.delete(key)) ref.s.open.add(key); redraw(); },
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
