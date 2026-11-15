// Tests for stop-codex.mjs: the Codex plugin's one Stop hook asks the ralph turn first, then counts usage, and never fails.
// Run: node --test hooks/stop-codex.test.mjs
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { onStop } from './stop-codex.mjs';

const HOOK = fileURLToPath(new URL('./stop-codex.mjs', import.meta.url));

test('the ralph turn is asked and written first, then usage is counted, each with the same input', () => {
  const seen = [];
  const out = [];
  const payload = { session_id: 's', turn_id: 't' };
  onStop(payload, { write: (s) => { seen.push('write'); out.push(s); }, ralph: (p) => { seen.push(['ralph', p]); return 'keep going'; }, count: (p) => seen.push(['count', p]) });
  assert.deepEqual(seen, [['ralph', payload], 'write', ['count', payload]]);
  assert.deepEqual(out.map((s) => JSON.parse(s)), [{ decision: 'block', reason: 'keep going' }]);
});

test('no reason writes nothing; a failing ralph still counts, and a failing count still leaves the ralph answer', () => {
  const out = [];
  let counted = 0;
  onStop({}, { write: (s) => out.push(s), ralph: () => null, count: () => { counted += 1; } });
  assert.deepEqual([out, counted], [[], 1]);
  onStop({}, { write: (s) => out.push(s), ralph: () => { throw new Error('x'); }, count: () => { counted += 1; } });
  assert.deepEqual([out, counted], [[], 2]);
  onStop({}, { write: (s) => out.push(s), ralph: () => 'go on', count: () => { throw new Error('y'); } });
  assert.equal(out.length, 1);
});

// Run as Codex runs it (input without a final newline, then EOF), with no ralph run and counting off: no output, exit 0.
test('run as a hook: a Stop input with nothing to do, or bad input, exits 0 with no output', () => {
  const home = mkdtempSync(join(tmpdir(), 'stop-codex-'));
  after(() => rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), APPDATA: join(home, 'AppData'), BANKER_NO_TELEMETRY: '1' };
  for (const input of [JSON.stringify({ session_id: 'x', turn_id: 't', cwd: home, hook_event_name: 'Stop' }), 'not json', '']) {
    const r = spawnSync(process.execPath, [HOOK], { input, encoding: 'utf8', env, cwd: home, timeout: 20000 });
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', ''], input);
  }
});
