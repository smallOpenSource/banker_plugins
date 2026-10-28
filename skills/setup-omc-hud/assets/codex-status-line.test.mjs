// Tests for codex-status-line.mjs. Run: node --test skills/setup-omc-hud/assets/codex-status-line.test.mjs
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { MARK, owner, status, turnOff, turnOn } from './codex-status-line.mjs';

const root = mkdtempSync(join(tmpdir(), 'codex-status-line-'));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const file = (text) => {
  const d = join(root, `h${n++}`);
  mkdirSync(d);
  const f = join(d, 'config.toml');
  if (text !== undefined) writeFileSync(f, text);
  return f;
};
const BASE = 'model = "x"\n\n[tui]\nstatus_line_use_colors = true\n\n[projects."/w"]\ntrust_level = "trusted"\n';

test('on adds the line under [tui] with the banker mark, off takes exactly it away', () => {
  const f = file(BASE);
  assert.equal(turnOn({ file: f }).code, 0);
  const on = readFileSync(f, 'utf8');
  assert.match(on, new RegExp(`\\[tui\\]\\nstatus_line_use_colors = true\\n${MARK}\\nstatus_line = \\["model-with-reasoning", "git-branch", "context-remaining"`));
  assert.equal(owner(on).owner, 'banker');
  assert.equal(turnOn({ file: f }).msg, '이미 켜져 있음');
  assert.match(status({ file: f }).msg, /^status_line\(banker\)/);
  turnOff({ file: f });
  assert.equal(readFileSync(f, 'utf8'), BASE);
  assert.equal(readFileSync(`${f}.banker-hud.bak`, 'utf8'), BASE);
});

test('a line OMX or the user set is left alone by on and off; a config with no [tui] gets one', () => {
  for (const [mark, who] of [['# omx:managed-status-line\n', 'omx'], ['', 'user']]) {
    const text = `[tui]\n${mark}status_line = ["a"]\n`;
    const f = file(text);
    assert.match(turnOn({ file: f }).msg, /이미 있음/);
    assert.match(turnOff({ file: f }).msg, new RegExp(who));
    assert.equal(readFileSync(f, 'utf8'), text);
  }
  const f = file('model = "x"\n');
  turnOn({ file: f, preset: 'minimal' });
  assert.equal(readFileSync(f, 'utf8'), `model = "x"\n\n[tui]\n${MARK}\nstatus_line = ["model-with-reasoning", "git-branch"]\n`);
  assert.equal(turnOn({ file: file(BASE), preset: 'huge' }).code, 1);
});

test('a config that sets tui with a dotted key or an inline table is refused, and off leaves a marked line whose value the user changed', () => {
  for (const text of ['tui.theme = "dark"\n', 'tui = { theme = "dark" }\n']) {
    const f = file(text);
    assert.equal(turnOn({ file: f }).code, 1, text);
    assert.equal(readFileSync(f, 'utf8'), text);
  }
  const edited = `[tui]\n${MARK}\nstatus_line = ["model-with-reasoning", "my-field"]\n`;
  const f = file(edited);
  assert.match(turnOff({ file: f }).msg, /사용자가 값을 고친/);
  assert.equal(readFileSync(f, 'utf8'), edited);
  assert.equal(turnOn({ file: file(BASE), preset: '__proto__' }).code, 1);
});

test('off after on leaves no empty [tui] behind when banker made it, and keeps a [tui] that has other keys', () => {
  for (const text of ['model = "x"\n', 'model = "x"\n\n[other]\nk = 1\n']) {
    const f = file(text);
    turnOn({ file: f });
    turnOff({ file: f });
    assert.equal(readFileSync(f, 'utf8'), text, JSON.stringify(text));
  }
});
