// Tests for register.mjs, which hooks the events banker's mods share and registers its commands.
// Run from the repo root: node --test hooks/register.test.mjs
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { register } from './register.mjs';

// The engine's rule: a module hooks an event once per matcher, or it is refused.
function engine({ version = '2.1.296', refuse = null } = {}) {
  const hooks = new Map();
  const on = (event, matcher, hook) => {
    if (typeof matcher === 'function') [hook, matcher] = [matcher, undefined];
    const id = `${event} ${JSON.stringify(matcher ?? null)}`;
    if (hooks.has(id)) throw new Error(`on("${event}") is registered twice`);
    hooks.set(id, hook);
    return { catch: () => {} };
  };
  const seen = { registered: [], logs: [] };
  const $ = {
    session: { version: async () => ({ version, base: version }) },
    command: {
      register: async (spec) => {
        if (spec.name === refuse) throw new Error('taken');
        seen.registered.push(spec.name);
        return { command: spec.name };
      },
    },
    ui: { log: (t) => { seen.logs.push(t); }, invalidate: () => {} },
  };
  register(on);
  const start = () => hooks.get('session.start null')($, { cwd: '/w' }, async () => ({ started: true }));
  return { hooks, seen, start };
}

test('every event is hooked once in the module, as the engine requires', () => {
  const { hooks } = engine();
  assert.deepEqual([...hooks.keys()].sort(), [
    'classic.Stop null', 'classic.SubagentStop null', 'command.run {"command":"banker:progress"}',
    'command.run {"command":"graceful-pause"}', 'command.run {"command":"progress"}', 'session.end null',
    'session.start null', 'tool.call null', 'turn.complete null', 'turn.start null', 'turn.step null',
    'ui.render {"component":"Pane"}',
  ]);
});

test('session.start registers both commands and passes the session on', async () => {
  const eng = engine();
  assert.deepEqual(await eng.start(), { started: true });
  assert.deepEqual(eng.seen.registered, ['graceful-pause', 'progress']);
  assert.deepEqual(eng.seen.logs, []);
});

test('an engine older than 2.1.289 gets /progress but not /graceful-pause, and one line saying why', async () => {
  const eng = engine({ version: '2.1.288' });
  await eng.start();
  assert.deepEqual(eng.seen.registered, ['progress']);
  assert.equal(eng.seen.logs.length, 1);
  assert.match(eng.seen.logs[0], /^\/graceful-pause .*2\.1\.289/, 'the engine puts the plugin\'s name before the line');
});

test('a command the engine refuses is logged, and the other still registers', async () => {
  const eng = engine({ refuse: 'progress' });
  await eng.start();
  assert.deepEqual(eng.seen.registered, ['graceful-pause']);
  assert.equal(eng.seen.logs.length, 1);
  assert.match(eng.seen.logs[0], /^\/progress 를 등록하지 못했습니다 \(taken\)$/);
});
