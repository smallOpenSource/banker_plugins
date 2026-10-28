// Tests for codex-config.mjs and codex-bypass.mjs. Run: node --test skills/setup-bypass-permissions/scripts/codex-bypass.test.mjs
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

import { definedInline, findKey, removeKey, setKey, tablesSetting } from './codex-config.mjs';
import { overridingProfile, policyBlock, status, turnOff, turnOn } from './codex-bypass.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'codex-bypass.mjs');
const root = mkdtempSync(join(tmpdir(), 'codex-bypass-'));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const home = (text) => {
  const d = join(root, `h${n++}`);
  mkdirSync(d);
  const file = join(d, 'config.toml');
  if (text !== undefined) writeFileSync(file, text);
  return file;
};
const CONFIG = '# mine\nmodel = "gpt-x"\napproval_policy = "on-request"\n\n[tui]\nstatus_line = [\n  "a",\n  "b",\n]\n\n[profiles.fast]\nsandbox_mode = "read-only"\n';

test('keys are read and changed line by line: top level before the first table, multi-line arrays, tables made at the end', () => {
  assert.equal(findKey(CONFIG, '', 'approval_policy').raw, '"on-request"');
  assert.equal(findKey(CONFIG, '', 'sandbox_mode'), null, 'a key inside a table is not a top-level key');
  assert.equal(findKey(CONFIG, 'tui', 'status_line').raw.replace(/\s/g, ''), '["a","b",]');
  const set = setKey(CONFIG, '', 'sandbox_mode', '"x"');
  assert.ok(set.indexOf('sandbox_mode = "x"') < set.indexOf('[tui]'), 'a new top-level key goes before the first table');
  assert.equal(removeKey(setKey(CONFIG, 'tui', 'status_line', '["c"]'), 'tui', 'status_line'), removeKey(CONFIG, 'tui', 'status_line'));
  assert.match(setKey('a = 1\n', 'tui', 'k', '2', '# m'), /a = 1\n\n\[tui\]\n# m\nk = 2\n/);
  assert.deepEqual(tablesSetting(CONFIG, 'profiles.', 'sandbox_mode'), ['profiles.fast']);
});

test('on records the values before, off puts them back, and everything else stays byte for byte', () => {
  const file = home(CONFIG);
  assert.equal(turnOn({ file, policies: [] }).code, 0);
  const on = readFileSync(file, 'utf8');
  assert.equal(findKey(on, '', 'approval_policy').raw, '"never"');
  assert.equal(findKey(on, '', 'sandbox_mode').raw, '"danger-full-access"');
  assert.equal(readFileSync(`${file}.bypass-permissions.bak`, 'utf8'), CONFIG);
  assert.equal(turnOn({ file, policies: [] }).msg, '이미 켜져 있음');
  assert.equal(turnOff({ file }).code, 0);
  assert.equal(readFileSync(file, 'utf8'), CONFIG);
  assert.ok(!existsSync(`${file}.bypass-permissions.json`));
  assert.match(status({ file, policies: [] }).msg, /꺼짐: approval_policy = "on-request", sandbox_mode = \(없음\)\n프로필이 따로 정함.*profiles\.fast/);
});

test('with no record, off takes the keys away only when both hold this script\'s values; a missing config is created and its mode is kept', () => {
  const file = home('approval_policy = "never"\nsandbox_mode = "workspace-write"\n');
  turnOff({ file });
  assert.equal(readFileSync(file, 'utf8'), 'approval_policy = "never"\nsandbox_mode = "workspace-write"\n', 'a never the user set alone stays');
  const both = home('a = 1\napproval_policy = "never"\nsandbox_mode = "danger-full-access"\n');
  turnOff({ file: both });
  assert.equal(readFileSync(both, 'utf8'), 'a = 1\n');
  const fresh = home();
  turnOn({ file: fresh, policies: [] });
  if (process.platform !== 'win32') assert.equal(statSync(fresh).mode & 0o777, 0o600);
  turnOff({ file: fresh });
  assert.equal(readFileSync(fresh, 'utf8').trim(), '');
});

test('an organization policy that does not allow the values, a linked config, and a missing --yes change nothing', (t) => {
  const pol = join(root, 'requirements.toml');
  writeFileSync(pol, 'allowed_approval_policies = ["on-request", "untrusted"]\n');
  assert.match(policyBlock([pol]), /allowed_approval_policies/);
  const file = home(CONFIG);
  assert.equal(turnOn({ file, policies: [pol] }).code, 1);
  assert.equal(readFileSync(file, 'utf8'), CONFIG);
  const env = { ...process.env, CODEX_HOME: dirname(file) };
  assert.equal(spawnSync(process.execPath, [SCRIPT, 'on'], { env, encoding: 'utf8' }).status, 1);
  const linked = home();
  const real = join(root, `real${n++}`);
  writeFileSync(real, CONFIG);
  try {
    symlinkSync(real, linked);
  } catch {
    return t.skip('no file links');
  }
  const r = spawnSync(process.execPath, [SCRIPT, 'on', '--yes'], { env: { ...process.env, CODEX_HOME: dirname(linked) }, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.equal(readFileSync(real, 'utf8'), CONFIG);
});

test('a folder this account cannot write ends with 3', { skip: (process.platform === 'win32' || process.getuid?.() === 0) && 'POSIX modes as a non-root user' }, () => {
  const file = home(CONFIG);
  chmodSync(dirname(file), 0o500);
  try {
    const r = spawnSync(process.execPath, [SCRIPT, 'on', '--yes'], { env: { ...process.env, CODEX_HOME: dirname(file) }, encoding: 'utf8' });
    assert.equal(r.status, 3, r.stdout);
    assert.equal(readFileSync(file, 'utf8'), CONFIG);
  } finally {
    chmodSync(dirname(file), 0o700);
  }
});


test('lines inside multi-line strings and arrays are no table headers or keys; quoted keys, comments after values and CRLF are kept', () => {
  const tricky = 'note = """\n[tui]\napproval_policy = "x"\n"""\nlist = [\n  "a",\n  [1, 2],\n]\n"approval_policy" = "on-request" # mine\nname = "a # b"\n\r\n[real]\nk = 1\n';
  assert.equal(findKey(tricky, '', 'approval_policy').raw, '"on-request"', 'quoted key, comment cut');
  assert.equal(findKey(tricky, '', 'name').raw, '"a # b"', 'a # in a string is no comment');
  assert.equal(findKey(tricky, 'tui', 'approval_policy'), null, 'a [tui] line in a string is no table');
  assert.equal(findKey(tricky, 'real', 'k').raw, '1');
  const set = setKey(tricky, '', 'approval_policy', '"never"');
  assert.equal(set.match(/approval_policy/g).length, 2, 'the quoted key is replaced, not added again (one more in the string)');
  assert.ok(set.indexOf('approval_policy = "never"') < set.indexOf('[real]'));
  const crlf = setKey('a = 1\r\n', 'tui', 'k', '2');
  assert.equal(crlf, 'a = 1\r\n\r\n[tui]\r\nk = 2\r\n');
  assert.equal(definedInline('tui.theme = "x"\n', 'tui'), true);
  assert.equal(definedInline('tui = { theme = "x" }\n', 'tui'), true);
  assert.equal(definedInline('[tui]\ntheme = "x"\n', 'tui'), false);
});

test('a default profile that sets the keys makes on refuse instead of reporting a mode that does not apply; an unreadable policy refuses', () => {
  const text = 'profile = "work"\n[profiles.work]\napproval_policy = "on-request"\n';
  const file = home(text);
  const r = turnOn({ file, policies: [] });
  assert.equal(r.code, 1);
  assert.match(r.msg, /기본 프로필 profiles\.work/);
  assert.equal(readFileSync(file, 'utf8'), text);
  assert.equal(overridingProfile('profile = "work"\n[profiles.work]\nmodel = "x"\n'), '');
  assert.match(policyBlock([join(root, 'no-such-dir-file', 'x')]), /^$/);
  const pol = join(root, 'requirements2.toml');
  writeFileSync(pol, 'allowed_approval_policies = ["on-request"] # "never" is not here\n');
  assert.match(policyBlock([pol]), /allowed_approval_policies/, 'a "never" in a comment is not an allowed value');
});

test('a default profile named with a dot, or set by top-level dotted keys, is seen too', () => {
  for (const text of ["profile = 'a.b'\n[profiles.\"a.b\"]\nsandbox_mode = \"read-only\"\n", 'profile = "s"\nprofiles.s.approval_policy = "on-request"\n']) {
    assert.notEqual(overridingProfile(text), '', text);
    assert.equal(turnOn({ file: home(text), policies: [] }).code, 1, text);
  }
  assert.equal(findKey('[profiles."a.b"]\nk = 1\n', 'profiles."a.b"', 'k').raw, '1');
  assert.equal(findKey('[profiles.a.b]\nk = 1\n', 'profiles."a.b"', 'k'), null, 'a.b split by a dot is another table');
});

test('turning on again after a hand edit records the hand-edited values; a managed config forcing other values refuses; CRLF stays CRLF', () => {
  const file = home('approval_policy = "on-request"\n');
  turnOn({ file, policies: [] });
  writeFileSync(file, 'approval_policy = "untrusted"\n');
  turnOn({ file, policies: [] });
  turnOff({ file });
  assert.equal(readFileSync(file, 'utf8'), 'approval_policy = "untrusted"\n', 'off brings back what was there right before the last on');
  const managed = join(root, 'managed_config.toml');
  writeFileSync(managed, "sandbox_mode = 'workspace-write'\n");
  assert.match(policyBlock([managed]), /sandbox_mode/);
  writeFileSync(managed, "allowed_approval_policies = ['never', 'on-request']\n");
  assert.equal(policyBlock([managed]), '', 'single-quoted values count');
  const crlf = home('a = 1');
  writeFileSync(crlf, 'a = 1\r\nb = 2');
  turnOn({ file: crlf, policies: [] });
  assert.ok(!/[^\r]\n/.test(readFileSync(crlf, 'utf8')), 'no bare LF in a CRLF file');
});

test('a quoted table name holding ] is a table, and a new top-level key goes above the comment that belongs to the next table', () => {
  assert.equal(findKey('[projects."/a]b"]\nk = 1\n', 'projects."/a]b"', 'k').raw, '1');
  assert.equal(findKey('[projects."/a]b"]\nk = 1\n', '', 'k'), null);
  assert.equal(setKey('a = 1\n\n# MCP servers\n[mcp]\nx = 1\n', '', 'b', '2'), 'a = 1\nb = 2\n\n# MCP servers\n[mcp]\nx = 1\n');
});
