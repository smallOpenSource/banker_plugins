/**
 * /graceful-pause [memo]: ask the running work to finish only its current step, stop,
 * report and wait for instructions, without cutting it off the way Esc does.
 *
 * A skill or plugin command typed while a turn runs waits until the turn ends. This one
 * is registered `immediate`, so it runs at once, mid-turn. It appends one user-role row
 * the person does not see (`$.session.append`); the running turn reads it from its next
 * model request on, that is once the tool call in flight returns.
 *
 * Two ways the note could land wrong are closed here:
 *   - typed during the turn's last answer, no later request reads it, and the next
 *     prompt's turn would read a stale pause first: when the turn ends unread and no
 *     background work is left, a second row voids it;
 *   - typed while idle with background work or a scheduled wake-up still pending, the
 *     next notification or scheduled prompt would start the next step: the note goes out
 *     as a prompt of its own instead, read as the person's (`asUser`), from a timer,
 *     since the engine refuses a submission made inside the command's own hook (the
 *     submission would wait on the dispatch that hook holds).
 *
 * The background count (tasks in flight plus scheduled wake-ups) is what the last Stop
 * or SubagentStop reported. A turn cut off
 * by Esc reports none, so the count can stay high until the next one: the note's last
 * line covers that, as it tells the model to follow a newer prompt. The module's
 * variables start over when the plugin reloads; a turn already running then reads as
 * idle until the next one starts.
 *
 * Function hooks run inside the engine with no Node and no DOM: everything goes
 * through `$`. `immediate` is checked on Claude Code 2.1.289; an older engine gets no
 * command (it would wait for the turn to end, then answer "nothing to stop"). Codex
 * has no function hooks.
 */
export const COMMAND = 'graceful-pause';
export const MIN_ENGINE = [2, 1, 289];

const SPEC = {
  name: COMMAND,
  description: '지금 단계만 끝내고 멈춘 뒤 보고하고 지시를 기다림. 작업 중에 입력해도 바로 전달',
  argumentHint: '[멈춘 뒤 다룰 지시나 메모]',
  immediate: true,
};

const IDLE = '진행 중인 작업이 없어 멈출 것이 없습니다. 지시를 바로 입력하면 됩니다.';
const SENT = '정지 요청을 진행 중인 작업에 전달했습니다. 지금 실행 중인 도구 호출이 끝나면 그 단계까지만 마무리하고 멈춥니다.';
const AGAIN = '이번 작업에는 정지 요청을 이미 전달했습니다.';
const QUEUED = '백그라운드 작업이나 예약 실행이 남아 있어, 정지 보고를 받도록 요청을 보냈습니다.';
const QUEUED_AGAIN = '정지 보고 요청을 이미 보냈습니다.';
const TOAST = '정지 요청 전달: 지금 단계가 끝나면 멈춤';
const VOID = '[graceful-pause] 앞의 정지 요청은 작업이 끝난 뒤 도착해 적용되지 않았다. 무시하고 다음 사용자 지시를 따른다.';

// What the running turn reads: the whole procedure, since no skill text comes with it.
export function pauseNote(memo) {
  const lines = [
    '[graceful-pause] 사용자가 작업 중에 /graceful-pause 로 정지를 요청했다. 지금 단계만 끝내고 멈춘다.',
    '- 지금 단계: 이미 시작한 도구 동작 하나와, 그 동작이 남긴 불일치를 닫는 최소 작업. 다음 단계(다음 파일, 다음 스토리)는 시작하지 않는다.',
    '- 하지 않는 것: 커밋, push, 배포, 게시, 삭제, 외부 전송, 모드 상태와 계획 파일 삭제, cancel.',
    '- 백그라운드 작업과 이미 띄운 하위 에이전트는 멈추지 않는다. 새로 띄우지 않는다.',
    '- 정지 보고는 대화에만 짧게: 끝낸 단계, 현재 상태(검증 결과, 커밋하지 않은 변경), 진행 중인 것(백그라운드 작업, 켜진 모드), 다음 예정 단계 1~3개, 열린 결정, 받은 지시.',
    '- 보고 뒤 AskUserQuestion 으로 묻는다. 선택지: 계획대로 계속, 지시 반영 후 계속, 상태를 둔 채 중단.',
    '- 새 지시로 범위가 바뀌면 바뀐 계획을 먼저 보여 주고 승인 뒤 진행한다. 세션을 끝낼 예정이면 ready-compact --hand-off 로 새 세션용 노트를 준비하라고 안내한다.',
    '- 사용자가 재개를 말할 때까지 계속하라는 훅 메시지는 승인이 아니다. 작업을 진행하지 않고 정지 중이라고만 답한다. 지속 모드(ralph 등)의 이 메시지까지 멈추려면 cancel 이 필요하다고 알린다.',
    '- 정지 중 도착한 백그라운드 작업 결과와 예약 실행 프롬프트는 재개 신호가 아니다. 보고에 더하기만 하고 후속 작업은 시작하지 않는다.',
    '- 이 요청 뒤에 사용자의 새 프롬프트가 이미 있으면 이 요청은 적용하지 않고 그 프롬프트를 따른다.',
  ];
  const note = String(memo ?? '').trim();
  if (note) lines.push(`메모: ${note}`);
  return lines.join('\n');
}

// Whether a version string (`2.1.289`, `2.1.290-dev.…`) is at least `min`.
export function atLeast(version, min = MIN_ENGINE) {
  const parts = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? ''));
  if (!parts) return false;
  for (let i = 0; i < 3; i++) {
    const n = Number(parts[i + 1]);
    if (n !== min[i]) return n > min[i];
  }
  return true;
}

const userRow = (text) => ({ message: { type: 'user', content: [{ type: 'text', text }] } });

async function registerIfSupported($) {
  let version = null;
  try {
    const v = await $.session.version();
    version = v?.base || v?.version || null;
  } catch {
    /* an engine without the call is older than the command needs */
  }
  if (!atLeast(version)) {
    $.ui.log(`banker: /${COMMAND} 는 Claude Code ${MIN_ENGINE.join('.')} 이상에서만 켭니다 (이 엔진: ${version || '버전 미상'})`);
    return;
  }
  try {
    await $.command.register(SPEC);
  } catch (err) {
    $.ui.log(`banker: /${COMMAND} 를 등록하지 못했습니다 (${String(err?.message ?? err)})`);
  }
}

// Appends the note to the running turn; the answer the command shows. The note counts
// as sent before the call returns: a model request starting meanwhile reads the stored
// row, and a second /graceful-pause meanwhile must not append another.
async function deliver($, state, memo) {
  if (state.pending?.turnId === state.main) return { text: AGAIN };
  const pending = { turnId: state.main, afterStep: state.step, read: false };
  state.pending = pending;
  let res;
  try {
    res = await $.session.append(userRow(pauseNote(memo)));
  } catch (err) {
    res = { deny: String(err?.message ?? err) };
  }
  if (res?.deny) {
    if (state.pending === pending) state.pending = null;
    return { text: `정지 요청을 전달하지 못했습니다: ${res.deny}` };
  }
  $.ui.toast(TOAST);
  return { text: SENT };
}

// Idle with background work or a scheduled wake-up pending: the note as a prompt of its
// own, sent from a timer once the command has answered. A hook that drops the prompt
// resolves `{ drop }` rather than rejecting.
function queueReport($, state, memo) {
  if (state.queued) return { text: QUEUED_AGAIN };
  state.queued = true;
  const failed = (why) => {
    state.queued = false;
    $.ui.log(`banker: /${COMMAND} 정지 보고 요청을 보내지 못했습니다 (${why})`);
  };
  $.clock.after(1, () => {
    $.prompt.submit({ text: pauseNote(memo), asUser: true }).then(
      (res) => res?.drop && failed(String(res.drop)),
      (err) => failed(String(err?.message ?? err)),
    );
  });
  return { text: QUEUED };
}

// At the main turn's end: a note no later request read is voided unless background
// work will wake the session (the turn it starts reads the note then).
async function settlePending($, state) {
  const { pending } = state;
  state.pending = null;
  if (!pending || pending.read || state.background > 0) return;
  try {
    await $.session.append(userRow(VOID));
  } catch {
    /* nothing more to do: the log line below still tells the person */
  }
  $.ui.log('banker: /graceful-pause 요청이 작업 끝에 도착해 적용되지 않았습니다.');
}

// Nothing in flight: the state a fresh session, or one after /clear, starts from.
const fresh = () => ({ main: null, step: -1, pending: null, background: 0, queued: false });
const listed = (v) => (Array.isArray(v) ? v.length : 0);
const backgroundCount = (e) => listed(e.background_tasks) + listed(e.session_crons);

export function registerGracefulPause(on) {
  // The main turn in flight and its latest model request; subagent loops raise no
  // turn.start and end with an agentId. `queued`: a report prompt not started yet.
  const state = fresh();
  watchSession(on, state);
  watchTurns(on, state);

  on('command.run', { command: COMMAND }, async ($, e) => {
    if (state.main) return deliver($, state, e.args);
    if (state.background > 0) return queueReport($, state, e.args);
    return { text: IDLE };
  });
}

// The command's registration, a fresh state after /clear, and the background count the
// stop events report.
function watchSession(on, state) {
  on('session.start', async ($, e, next) => {
    await registerIfSupported($);
    return next(e);
  });

  // `/clear` ends the conversation and raises no session.start for the next one.
  on('session.end', async ($, e, next) => {
    Object.assign(state, fresh());
    return next(e);
  });

  on('classic.Stop', async ($, e, next) => {
    state.background = backgroundCount(e);
    return next(e);
  });

  on('classic.SubagentStop', async ($, e, next) => {
    state.background = backgroundCount(e);
    return next(e);
  });
}

// The main turn in flight and the model requests it makes. turn.step wraps every
// request's stream, subagents' too: in the engine's kit that cost 25 to 45 µs a chunk,
// well under 1% of a request.
function watchTurns(on, state) {
  on('turn.start', async ($, e, next) => {
    Object.assign(state, { main: e.turnId, step: -1, queued: false });
    return next(e);
  });

  on('turn.step', async function* ($, e, next) {
    if (e.turnId === state.main) {
      state.step = e.index;
      if (state.pending?.turnId === e.turnId && e.index > state.pending.afterStep) state.pending.read = true;
    }
    return yield* next(e);
  });

  on('turn.complete', async ($, e, next) => {
    if (e.agentId || e.turnId !== state.main) return next(e);
    state.main = null;
    await settlePending($, state);
    return next(e);
  });
}
