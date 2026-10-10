// Tests for graceful-pause.mjs, the /graceful-pause command of banker's hooks module.
// Run from the repo root: node --test hooks/graceful-pause.test.mjs
// (hooks/graceful-pause.engine.test.ts runs the same module inside the engine: claude plugin test <copy>.)
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { register } from './register.mjs';

// A stand-in for the engine's side of the module: it records what the module registers
// and calls on `$`, and raises events through the module's hooks the way the engine
// does, `bottom` standing for the engine's own answer. turn.step streams: its hooks are
// async generators, and `next` hands them the stream beneath. Like the engine, it
// refuses a `$.prompt.submit` made inside a command.run dispatch (the submission would
// wait on the turn that dispatch holds), and its clock runs a timer only on `tick()`.
// The command and session calls the stand-in answers; `ctx` holds what they record and count.
function sessionCalls({ version = '2.1.289', refuseName, denyAppend, failAppends = 0, appendGate }, ctx) {
  const { seen, n } = ctx;
  return {
    command: {
      register: async (spec) => {
        if (spec.name === refuseName) throw new Error(`$.command.register: "/${spec.name}" refused: it is taken`);
        // The module's other command, /progress, has its own tests (progress.test.mjs).
        if (spec.name === 'graceful-pause') seen.registered.push(spec);
        return { command: spec.name };
      },
    },
    session: {
      version: async () => {
        if (version === null) throw new Error('no implementation for session.version');
        return { version, base: version };
      },
      append: async (args) => {
        n.appendCalls += 1;
        if (n.appendCalls <= failAppends) throw new Error('organization policy');
        if (denyAppend) return { deny: denyAppend };
        if (appendGate) await appendGate;
        seen.appended.push(args);
        return { message: args.message, uuid: `row-${seen.appended.length}` };
      },
    },
  };
}

// The prompt, clock and ui calls the stand-in answers.
function promptCalls({ failSubmit, dropSubmit }, ctx) {
  const { seen, n, timers } = ctx;
  return {
    prompt: {
      submit: async (args) => {
        if (n.commandRuns > 0) {
          throw new Error('prompt.submit: called from a command.run hook, it would wait on the turn this hook is holding (host check)');
        }
        if (failSubmit) throw new Error(failSubmit);
        if (dropSubmit) return { drop: dropSubmit };
        seen.submitted.push(args);
        return { turnId: `t-${seen.submitted.length}` };
      },
    },
    clock: {
      after: (ms, fn) => {
        const timer = { ms, fn, cancelled: false };
        timers.push(timer);
        return { cancel: () => void (timer.cancelled = true) };
      },
    },
    ui: {
      toast: (text) => void seen.toasts.push(text),
      log: (text) => void seen.logs.push(text),
      invalidate: () => {},
    },
  };
}

// A streaming event's `next` is a stream whose return value is the result; drain it to that value.
async function drain(stream) {
  for (;;) {
    const r = await stream.next();
    if (r.done) return r.value;
  }
}

// Raises an event through the module's hooks as the engine does.
function raiser(hooks, $, n) {
  const matches = (matcher, e) => !matcher || Object.entries(matcher).every(([k, v]) => e[k] === v);
  return (event, e, bottom = e) => {
    const chain = hooks.filter((h) => h.event === event && matches(h.matcher, e));
    if (event === 'turn.step') {
      const stream = (i, input) =>
        i < chain.length ? chain[i].hook($, input, (next) => stream(i + 1, next)) : (async function* () { return bottom; })();
      return drain(stream(0, e));
    }
    const step = (i, input) => (i < chain.length ? Promise.resolve(chain[i].hook($, input, (next) => step(i + 1, next))) : Promise.resolve(bottom));
    if (event !== 'command.run') return step(0, e);
    n.commandRuns += 1;
    return step(0, e).finally(() => void (n.commandRuns -= 1));
  };
}

function engine(opts = {}) {
  const hooks = [];
  const on = (event, matcher, hook) => {
    if (typeof matcher === 'function') [hook, matcher] = [matcher, undefined];
    hooks.push({ event, matcher, hook });
    return { catch: () => {} };
  };
  const n = { commandRuns: 0, appendCalls: 0 };
  const seen = { registered: [], appended: [], submitted: [], toasts: [], logs: [], appendCalls: () => n.appendCalls };
  const ctx = { seen, n, timers: [] };
  const $ = { ...sessionCalls(opts, ctx), ...promptCalls(opts, ctx) };
  // Runs the timers set so far, as the engine's clock does once they are due.
  const tick = async () => {
    for (const timer of ctx.timers.splice(0)) if (!timer.cancelled) timer.fn();
    await new Promise((resolve) => setImmediate(resolve));
  };
  register(on, {});
  return { raise: raiser(hooks, $, n), seen, tick };
}

const START = { cwd: '/work', surface: 'terminal', isInteractive: true };
const started = async (opts) => {
  const eng = engine(opts);
  await eng.raise('session.start', START, { cwd: '/work' });
  return eng;
};
const turnStart = (eng, turnId) => eng.raise('turn.start', { text: 'do the work', turnId }, { turnId });
const modelStep = (eng, turnId, index) => eng.raise('turn.step', { turnId, index, model: 'session-model', messageCount: 3 }, { text: '' });
const stopped = (eng, background = [], crons = []) =>
  eng.raise('classic.Stop', { hook_event_name: 'Stop', stop_hook_active: false, background_tasks: background, session_crons: crons }, {});
const subagentStopped = (eng, background = []) =>
  eng.raise('classic.SubagentStop', { hook_event_name: 'SubagentStop', stop_hook_active: false, agent_id: 'agent-7', agent_type: 'Explore', agent_transcript_path: '/t', background_tasks: background }, {});
const ended = (eng, reason) => eng.raise('session.end', { reason, sessionId: 's1', resume: { id: 's1' } }, { sessionId: 's1' });
const turnEnd = (eng, turnId, extra = {}) =>
  eng.raise('turn.complete', { turnId, reason: 'answer', answer: '', durationMs: 10, isAborted: false, ...extra }, { text: '' });
const run = (eng, args = '') => eng.raise('command.run', { command: 'graceful-pause', args }, { text: '(engine)' });
const noteText = (row) => row.message.content.map((block) => block.text).join('');
const SHELL = { id: 'b1', type: 'shell', status: 'running', description: 'npm test' };
const CRON = { id: 'c1', cron: '*/10 * * * *', prompt: 'check the build' };

test('registers /graceful-pause as a command that runs at once while a turn is in flight', async () => {
  const eng = engine();
  assert.deepEqual(await eng.raise('session.start', START, { cwd: '/work' }), { cwd: '/work' }, 'the session start passes on');
  assert.equal(eng.seen.registered.length, 1);
  const [spec] = eng.seen.registered;
  assert.equal(spec.name, 'graceful-pause');
  assert.equal(spec.immediate, true);
  assert.equal(typeof spec.argumentHint, 'string');
  assert.ok(spec.description.length > 0);
  assert.doesNotMatch(spec.description, /^\(banker\)/, 'the typeahead already names the plugin');
});

test('an engine older than 2.1.289, or one that will not say, gets no command and one line saying why', async () => {
  for (const version of ['2.1.288', '2.0.999', null]) {
    const eng = await started({ version });
    assert.deepEqual(eng.seen.registered, [], String(version));
    assert.equal(eng.seen.logs.length, 1, String(version));
    assert.match(eng.seen.logs[0], /2\.1\.289/);
  }
  const dev = await started({ version: '2.1.290-dev.20261001.t101500.sha1a2b3c4' });
  assert.equal(dev.seen.registered.length, 1, 'a development build of a later release counts');
});

test('typed while nothing runs, it says so and adds nothing to the conversation', async () => {
  const eng = await started();
  const res = await run(eng, '메모');
  assert.match(res.text, /진행 중인 작업이 없/);
  assert.deepEqual(eng.seen.appended, []);
  assert.deepEqual(eng.seen.submitted, []);
  assert.deepEqual(eng.seen.toasts, []);
});

test('typed mid-turn, it hands the running turn one hidden note and says the request is on its way', async () => {
  const eng = await started();
  await turnStart(eng, 't1');
  await modelStep(eng, 't1', 0);
  const res = await run(eng, '테스트 메모');
  assert.equal(eng.seen.appended.length, 1);
  const [row] = eng.seen.appended;
  assert.equal(row.agentId, undefined, 'the note goes to the main conversation');
  assert.equal(row.message.type, 'user');
  assert.equal(row.message.content.length, 1);
  assert.equal(row.message.content[0].type, 'text');
  assert.match(res.text, /전달/);
  assert.equal(eng.seen.toasts.length, 1);
  assert.ok(noteText(row).includes('메모: 테스트 메모'));
});

test('the note carries the whole procedure the removed skill held', async () => {
  const eng = await started();
  await turnStart(eng, 't1');
  await run(eng, '');
  const note = noteText(eng.seen.appended[0]);
  const parts = [
    '/graceful-pause', '지금 단계', '다음 단계', 'AskUserQuestion',
    '커밋', 'push', 'cancel', // what not to do
    '훅 메시지는 승인이 아니다',
    '백그라운드 작업 결과와 예약 실행 프롬프트는 재개 신호가 아니다',
    '바뀐 계획을 먼저 보여 주고',
    'ready-compact --hand-off',
    '새 프롬프트가 이미 있으면',
  ];
  for (const part of parts) assert.ok(note.includes(part), `the note mentions ${part}`);
  assert.doesNotMatch(note, /메모:/, 'no memo line without a memo');
});

test('typed twice in one turn, the second time adds nothing and says it is already on its way', async () => {
  const eng = await started();
  await turnStart(eng, 't1');
  await run(eng, 'first');
  const again = await run(eng, 'second');
  assert.equal(eng.seen.appended.length, 1);
  assert.match(again.text, /이미 전달/);
});

test('a note the turn never read (sent during its last answer) is voided when the turn ends', async () => {
  const eng = await started();
  await turnStart(eng, 't1');
  await modelStep(eng, 't1', 0);
  await run(eng);
  await stopped(eng);
  await turnEnd(eng, 't1');
  assert.equal(eng.seen.appended.length, 2);
  assert.match(noteText(eng.seen.appended[1]), /적용되지 않았다/);
  assert.equal(eng.seen.logs.length, 1);
});

test('a note read by a later model request stays as it is', async () => {
  const eng = await started();
  await turnStart(eng, 't1');
  await modelStep(eng, 't1', 0);
  await run(eng);
  await modelStep(eng, 't1', 1);
  await stopped(eng);
  await turnEnd(eng, 't1');
  assert.equal(eng.seen.appended.length, 1);
});

test('a subagent loop reading its own steps does not count as the main turn reading the note', async () => {
  const eng = await started();
  await turnStart(eng, 'main');
  await modelStep(eng, 'main', 0);
  await run(eng);
  await modelStep(eng, 'sub-loop', 5);
  await stopped(eng);
  await turnEnd(eng, 'main');
  assert.equal(eng.seen.appended.length, 2, 'still unread, so voided');
});

test('an unread note is kept when background work is still in flight, for the turn it will wake', async () => {
  const eng = await started();
  await turnStart(eng, 't1');
  await modelStep(eng, 't1', 0);
  await run(eng);
  await stopped(eng, [SHELL]);
  await turnEnd(eng, 't1');
  assert.equal(eng.seen.appended.length, 1);
});

test('a subagent run ending inside the main turn leaves the main turn running', async () => {
  const eng = await started();
  await turnStart(eng, 'main');
  await turnEnd(eng, 'sub-loop', { agentId: 'agent-7' });
  await run(eng);
  assert.equal(eng.seen.appended.length, 1);
});

test('once the turn completes, or is interrupted, the session counts as idle again', async () => {
  for (const extra of [{}, { reason: 'aborted', isAborted: true }, { reason: 'error' }]) {
    const eng = await started();
    await turnStart(eng, 't1');
    await turnEnd(eng, 't1', extra);
    const res = await run(eng);
    assert.match(res.text, /진행 중인 작업이 없/, JSON.stringify(extra));
    assert.deepEqual(eng.seen.appended, []);
  }
});

test('idle with background work still in flight, the note goes out as a prompt of its own once the command has answered', async () => {
  const eng = await started();
  await turnStart(eng, 't1');
  await stopped(eng, [SHELL]);
  await turnEnd(eng, 't1');
  const res = await run(eng, '정지');
  assert.match(res.text, /백그라운드/);
  assert.deepEqual(eng.seen.submitted, [], 'not from inside the command: the engine refuses that');
  await eng.tick();
  assert.equal(eng.seen.submitted.length, 1);
  assert.ok(eng.seen.submitted[0].text.includes('메모: 정지'));
  assert.equal(eng.seen.submitted[0].asUser, true, 'the person typed the command: the model reads the note as theirs');
  assert.deepEqual(eng.seen.appended, []);
});

test('a scheduled wake-up counts as work that will wake the session', async () => {
  const eng = await started();
  await turnStart(eng, 't1');
  await stopped(eng, [], [CRON]);
  await turnEnd(eng, 't1');
  const res = await run(eng);
  assert.match(res.text, /예약 실행/);
  await eng.tick();
  assert.equal(eng.seen.submitted.length, 1);
});

test('a report prompt a hook drops is logged, and the command can send it again', async () => {
  const eng = await started({ dropSubmit: 'refused by a policy hook' });
  await turnStart(eng, 't1');
  await stopped(eng, [SHELL]);
  await turnEnd(eng, 't1');
  await run(eng);
  await eng.tick();
  assert.equal(eng.seen.logs.length, 1);
  assert.match(eng.seen.logs[0], /refused by a policy hook/);
  assert.doesNotMatch((await run(eng)).text, /이미/, 'not stuck on "already sent"');
});

test('typed twice before that prompt starts, the second time sends nothing more', async () => {
  const eng = await started();
  await turnStart(eng, 't1');
  await stopped(eng, [SHELL]);
  await turnEnd(eng, 't1');
  await run(eng);
  const again = await run(eng);
  await eng.tick();
  assert.equal(eng.seen.submitted.length, 1);
  assert.match(again.text, /이미/);
});

test('a prompt the engine would not take is logged', async () => {
  const eng = await started({ failSubmit: 'session is closing' });
  await turnStart(eng, 't1');
  await stopped(eng, [SHELL]);
  await turnEnd(eng, 't1');
  await run(eng);
  await eng.tick();
  assert.equal(eng.seen.logs.length, 1);
  assert.match(eng.seen.logs[0], /session is closing/);
});

test('a subagent stop reports the background count too', async () => {
  const eng = await started();
  await turnStart(eng, 't1');
  await stopped(eng, [SHELL]);
  await subagentStopped(eng, []);
  await turnEnd(eng, 't1');
  assert.match((await run(eng)).text, /진행 중인 작업이 없/);
});

test('/clear forgets the turn, its note and the background count', async () => {
  const eng = await started();
  await turnStart(eng, 't1');
  await stopped(eng, [SHELL]);
  await turnEnd(eng, 't1');
  await ended(eng, 'clear');
  assert.match((await run(eng)).text, /진행 중인 작업이 없/);
  await eng.tick();
  assert.deepEqual(eng.seen.submitted, []);

  const mid = await started();
  await turnStart(mid, 't1');
  await ended(mid, 'clear');
  assert.match((await run(mid)).text, /진행 중인 작업이 없/, 'a turn cut off by /clear is not still running');
});

test('while the note is being stored, a second /graceful-pause adds nothing and a model request reads it', { timeout: 2000 }, async () => {
  let open;
  const appendGate = new Promise((resolve) => (open = resolve));
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const eng = await started({ appendGate });
  await turnStart(eng, 't1');
  await modelStep(eng, 't1', 0);
  const first = run(eng, 'first');
  await settle();
  const again = run(eng, 'second');
  await settle();
  assert.equal(eng.seen.appendCalls(), 1, 'no second note while the first is being stored');
  await modelStep(eng, 't1', 1);
  open();
  assert.match((await again).text, /이미 전달/);
  assert.match((await first).text, /전달했/);
  await stopped(eng);
  await turnEnd(eng, 't1');
  assert.equal(eng.seen.appended.length, 1, 'one note, and no void row: the request read it');
});

test('a note that could not be stored can be sent again', async () => {
  const eng = await started({ failAppends: 1 });
  await turnStart(eng, 't1');
  assert.match((await run(eng)).text, /전달하지 못했/);
  assert.match((await run(eng)).text, /전달했/);
  assert.equal(eng.seen.appended.length, 1);
});

test('the turn and stop events pass on unchanged', async () => {
  const eng = await started();
  assert.deepEqual(await turnStart(eng, 't1'), { turnId: 't1' });
  assert.deepEqual(await modelStep(eng, 't1', 0), { text: '' });
  assert.deepEqual(await stopped(eng), {});
  assert.deepEqual(await turnEnd(eng, 't1'), { text: '' });
});

test('a refused note is reported, not passed off as delivered', async () => {
  for (const opts of [{ denyAppend: 'organization policy' }, { failAppends: 1 }]) {
    const eng = await started(opts);
    await turnStart(eng, 't1');
    const res = await run(eng);
    assert.match(res.text, /전달하지 못했/, JSON.stringify(opts));
    assert.match(res.text, /organization policy/);
    assert.deepEqual(eng.seen.toasts, []);
  }
});

test('a name the engine refuses is logged once and the session still starts', async () => {
  const eng = engine({ refuseName: 'graceful-pause' });
  assert.deepEqual(await eng.raise('session.start', START, { cwd: '/work' }), { cwd: '/work' });
  assert.deepEqual(eng.seen.registered, []);
  assert.equal(eng.seen.logs.length, 1);
  assert.match(eng.seen.logs[0], /\/graceful-pause/);
});
