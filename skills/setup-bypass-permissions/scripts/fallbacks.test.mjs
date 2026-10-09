// Runs the shell fallbacks setup-bypass-permissions step 3 uses when node cannot run the main script:
// scripts/fallback/bypass-permissions.py (macOS, Linux; python3 3.6+) and bypass-permissions.ps1 (Windows
// PowerShell 5.1+, pwsh 7). Each case gets a throwaway config folder, HOME and USERPROFILE, so a broken
// fallback can never reach the real ~/.claude. Run: node --test skills/setup-bypass-permissions/scripts/fallbacks.test.mjs
// CI runs it in the structural job (ubuntu, pwsh 7) and in the macos and windows jobs (Windows PowerShell 5.1).
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PY = join(HERE, 'fallback', 'bypass-permissions.py');
const PS1 = join(HERE, 'fallback', 'bypass-permissions.ps1');
const root = mkdtempSync(join(tmpdir(), 'bypass-fallback-'));
after(() => rmSync(root, { recursive: true, force: true }));

const works = (bin, args) => spawnSync(bin, args, { encoding: 'utf8' }).status === 0;
const python = ['python3', 'python'].find((bin) => works(bin, ['-c', 'import sys; assert sys.version_info >= (3, 6)']));
const powershell = ['powershell', 'pwsh'].find((bin) => works(bin, ['-NoProfile', '-Command', 'exit 0']));
const asRoot = process.platform !== 'win32' && process.getuid?.() === 0;
const posix = process.platform !== 'win32';
// PowerShell sets a file mode on macOS and Linux only where .NET has SetUnixFileMode (PowerShell 7.3+).
const psModes = posix && powershell && works(powershell, ['-NoProfile', '-Command',
  "if ($null -eq [System.IO.File].GetMethod('SetUnixFileMode', [type[]]@([string], [System.IO.UnixFileMode]))) { exit 1 }"]);

// The two fallbacks behind one interface: run(c, ...args) as Claude, or a person, would run them.
const SHELLS = [
  { name: 'python', bin: python, args: (...a) => [PY, ...a], skip: (!posix && 'the python fallback is for macOS and Linux') || (!python && 'needs python3 3.6+'), modes: posix },
  { name: 'PowerShell', bin: powershell, args: (...a) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS1, ...a], skip: !powershell && 'needs powershell or pwsh', modes: psModes },
];

const BEFORE = { model: 'opus', env: { NOTE: '한글 값' }, permissions: { allow: ['Bash(ls:*)'], deny: ['Read(./.env)'] } };
let seq = 0;
function setup(settings = BEFORE, { name = `case ${++seq}` } = {}) {
  const dir = join(root, name);
  const config = join(dir, 'config');
  mkdirSync(config, { recursive: true });
  const settingsFile = join(config, 'settings.json');
  const text = settings === null ? null : typeof settings === 'string' ? settings : JSON.stringify(settings, null, 2) + '\n';
  if (text !== null) writeFileSync(settingsFile, text);
  const policyHome = join(dir, 'policy');
  return { dir, config, settingsFile, text, policyHome, bak: `${settingsFile}.bypass-permissions.bak` };
}
const env = (c, extra = {}) => ({
  ...process.env,
  CLAUDE_CONFIG_DIR: c.config,
  HOME: c.dir,
  USERPROFILE: c.dir,
  BANKER_BYPASS_TEST: '1',
  BANKER_BYPASS_POLICY_HOME: c.policyHome,
  IS_SANDBOX: '',
  ...extra,
});
const run = (shell, c, args, extra) => spawnSync(shell.bin, shell.args(...args), { encoding: 'utf8', env: env(c, extra) });
const read = (c) => JSON.parse(readFileSync(c.settingsFile, 'utf8').replace(/^﻿/, ''));
const raw = (c) => readFileSync(c.settingsFile, 'utf8');

test('the PowerShell fallback is ASCII only: Windows PowerShell 5.1 reads a script without a BOM in the ANSI code page', () => {
  const src = readFileSync(PS1, 'utf8');
  assert.equal(src.charCodeAt(0) === 0xfeff, false, 'no BOM either');
  assert.match(src, /^[\x00-\x7F]*$/);
});

for (const shell of SHELLS) {
  const t = (title, opts, fn) => test(`${shell.name}: ${title}`, { ...opts, skip: shell.skip || opts.skip }, fn);

  t('on sets the mode and keeps every other key, non-ASCII values included', {}, () => {
    const c = setup();
    const res = run(shell, c, ['on', '--yes']);
    assert.equal(res.status, 0, res.stderr + res.stdout);
    assert.match(res.stdout, /defaultMode = bypassPermissions/);
    assert.deepEqual(read(c), { ...BEFORE, permissions: { ...BEFORE.permissions, defaultMode: 'bypassPermissions' } });
    assert.equal(readFileSync(c.bak, 'utf8'), c.text, 'the text from before is kept');
    if (posix) assert.equal(statSync(c.bak).mode & 0o777, 0o600, 'readable by this account alone');
  });

  t('on without --yes changes nothing', {}, () => {
    const c = setup();
    const res = run(shell, c, ['on']);
    assert.equal(res.status, 1, res.stdout);
    assert.equal(raw(c), c.text);
    assert.equal(existsSync(c.bak), false);
  });

  t('a second on changes nothing and keeps the first backup', {}, () => {
    const c = setup();
    run(shell, c, ['on', '--yes']);
    const after1 = raw(c);
    const res = run(shell, c, ['on', '--yes']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /already/);
    assert.equal(raw(c), after1);
    assert.equal(readFileSync(c.bak, 'utf8'), c.text);
  });

  t('off removes the mode and leaves the rest', {}, () => {
    const c = setup();
    run(shell, c, ['on', '--yes']);
    const res = run(shell, c, ['off']);
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(read(c), BEFORE);
    assert.equal(readFileSync(c.bak, 'utf8'), c.text, 'off keeps the backup from before on');
  });

  t('off on settings that are not in the mode changes nothing', {}, () => {
    const c = setup({ permissions: { defaultMode: 'acceptEdits' } });
    const res = run(shell, c, ['off']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(raw(c), c.text);
  });

  const refusals = [
    ['settings that are not valid JSON', '{ "model": "opus",\n'],
    ['settings that are not a JSON object', '[1, 2]\n'],
    ['a permissions entry that is not an object', JSON.stringify({ permissions: ['x'] })],
    ['settings that forbid the mode themselves', JSON.stringify({ permissions: { disableBypassPermissionsMode: 'disable' } })],
  ];
  for (const [what, settings] of refusals) {
    t(`on refuses ${what} and leaves the file as it was`, {}, () => {
      const c = setup(settings);
      const res = run(shell, c, ['on', '--yes']);
      assert.equal(res.status, 1, res.stdout + res.stderr);
      assert.match(res.stderr, /refused/);
      assert.equal(raw(c), c.text);
      assert.equal(existsSync(c.bak), false);
    });
  }

  t('managed policy, in the file or a drop-in, stops on; a hidden drop-in is not policy', {}, () => {
    const c = setup();
    mkdirSync(join(c.policyHome, 'managed-settings.d'), { recursive: true });
    writeFileSync(join(c.policyHome, 'managed-settings.d', '.draft.json'), JSON.stringify({ permissions: { disableBypassPermissionsMode: true } }));
    assert.equal(run(shell, c, ['on', '--yes']).status, 0, 'a hidden file is ignored');
    run(shell, c, ['off']);
    writeFileSync(join(c.policyHome, 'managed-settings.d', '20-lock.json'), JSON.stringify({ permissions: { disableBypassPermissionsMode: 'disable' } }));
    const res = run(shell, c, ['on', '--yes']);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /20-lock\.json/);
    rmSync(join(c.policyHome, 'managed-settings.d'), { recursive: true });
    writeFileSync(join(c.policyHome, 'managed-settings.json'), '﻿' + JSON.stringify({ permissions: { disableBypassPermissionsMode: true } }));
    assert.equal(run(shell, c, ['on', '--yes']).status, 1, 'a BOM before the policy JSON does not hide it');
  });

  t('without a Claude Code config folder, on refuses rather than make one', {}, () => {
    const c = setup(null);
    rmSync(c.config, { recursive: true });
    const res = run(shell, c, ['on', '--yes']);
    assert.equal(res.status, 1, res.stdout);
    assert.equal(existsSync(c.config), false);
  });

  t('a folder with no settings file yet gets one with the mode', {}, () => {
    const c = setup(null);
    assert.equal(run(shell, c, ['on', '--yes']).status, 0);
    assert.deepEqual(read(c), { permissions: { defaultMode: 'bypassPermissions' } });
  });

  t('a BOM before the settings JSON is read and kept', {}, () => {
    const c = setup('﻿' + JSON.stringify({ model: 'opus' }));
    assert.equal(run(shell, c, ['on', '--yes']).status, 0);
    assert.ok(raw(c).startsWith('﻿'));
    assert.deepEqual(read(c), { model: 'opus', permissions: { defaultMode: 'bypassPermissions' } });
  });

  t('a config folder with a non-ASCII name is named exactly in the settings file line', {}, () => {
    const c = setup(BEFORE, { name: `설정 폴더 ${++seq}` });
    const res = run(shell, c, ['on', '--yes']);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.equal(res.stdout.trimEnd().split(/\r?\n/).pop(), `settings file: ${c.settingsFile}`);
    assert.equal(read(c).permissions.defaultMode, 'bypassPermissions');
  });

  t('a config folder whose name has brackets is still found', {}, () => {
    const c = setup(BEFORE, { name: `dotfiles [work] ${++seq}` });
    assert.equal(run(shell, c, ['on', '--yes']).status, 0);
    assert.equal(read(c).permissions.defaultMode, 'bypassPermissions');
    assert.equal(read(c).env.NOTE, '한글 값');
  });

  t('a settings file this account cannot write exits 3 and stays as it was', { skip: (!posix || asRoot) && 'needs POSIX mode bits and a non-root account' }, () => {
    const c = setup();
    chmodSync(c.settingsFile, 0o444);
    try {
      const res = run(shell, c, ['on', '--yes']);
      assert.equal(res.status, 3, res.stdout + res.stderr);
      assert.match(res.stderr, /write blocked/);
    } finally {
      chmodSync(c.settingsFile, 0o644);
    }
    assert.equal(raw(c), c.text);
  });

  t('off on a settings file this account cannot write exits 3 and stays as it was', { skip: asRoot && 'root writes past mode bits' }, () => {
    const c = setup({ ...BEFORE, permissions: { ...BEFORE.permissions, defaultMode: 'bypassPermissions' } });
    chmodSync(c.settingsFile, 0o444); // on Windows this sets the read-only attribute
    try {
      const res = run(shell, c, ['off']);
      assert.equal(res.status, 3, res.stdout + res.stderr);
      assert.match(res.stderr, /write blocked/);
    } finally {
      chmodSync(c.settingsFile, 0o644);
    }
    assert.equal(raw(c), c.text);
  });

  t('a settings file reached through a link is changed where it lives, and the link stays', { skip: !posix && 'plain symlinks need POSIX' }, () => {
    const c = setup(null);
    const real = join(c.dir, 'dotfiles-settings.json');
    writeFileSync(real, JSON.stringify({ model: 'opus' }));
    symlinkSync(real, c.settingsFile);
    assert.equal(run(shell, c, ['on', '--yes']).status, 0);
    assert.ok(lstatSync(c.settingsFile).isSymbolicLink());
    assert.deepEqual(JSON.parse(readFileSync(real, 'utf8')), { model: 'opus', permissions: { defaultMode: 'bypassPermissions' } });
  });

  t('a link planted at the backup name is replaced, not written through', { skip: !posix && 'plain symlinks need POSIX' }, () => {
    const c = setup();
    const victim = join(c.dir, 'victim.txt');
    writeFileSync(victim, 'keep me\n');
    symlinkSync(victim, c.bak);
    assert.equal(run(shell, c, ['on', '--yes']).status, 0);
    assert.equal(readFileSync(victim, 'utf8'), 'keep me\n');
    assert.equal(lstatSync(c.bak).isSymbolicLink(), false);
  });

  t('anything but on or off is refused', {}, () => {
    const c = setup();
    for (const args of [[], ['toggle'], ['on', '--yes', 'extra']]) {
      const res = run(shell, c, args);
      assert.equal(res.status, 1, `${args.join(' ')}: ${res.stdout}`);
    }
    assert.equal(raw(c), c.text);
  });

  t('every result ends with the settings file it acted on', {}, () => {
    const lastLine = (res) => res.stdout.trimEnd().split(/\r?\n/).pop();
    const done = setup();
    const refused = setup('{ "model": "opus",\n');
    for (const [what, c, args, code] of [['done', done, ['on', '--yes'], 0], ['already', done, ['on', '--yes'], 0],
      ['off', done, ['off'], 0], ['refused', refused, ['on', '--yes'], 1], ['not a command', refused, ['toggle'], 1]]) {
      const res = run(shell, c, args);
      assert.equal(res.status, code, `${what}: ${res.stdout}${res.stderr}`);
      assert.equal(lastLine(res), `settings file: ${c.settingsFile}`, what);
    }
  });

  t('on and off keep the mode of the settings file', { skip: !shell.modes && 'needs POSIX mode bits (PowerShell: 7.3+)' }, () => {
    const c = setup();
    chmodSync(c.settingsFile, 0o640);
    assert.equal(run(shell, c, ['on', '--yes']).status, 0);
    assert.equal(statSync(c.settingsFile).mode & 0o777, 0o640, 'after on');
    assert.equal(run(shell, c, ['off']).status, 0);
    assert.equal(statSync(c.settingsFile).mode & 0o777, 0o640, 'after off');
  });

  t('a policy file or folder this account cannot read stops on', { skip: (!posix || asRoot) && 'needs POSIX mode bits and a non-root account' }, () => {
    for (const which of ['file', 'folder']) {
      const c = setup();
      mkdirSync(c.policyHome, { recursive: true });
      const target = join(c.policyHome, which === 'file' ? 'managed-settings.json' : 'managed-settings.d');
      if (which === 'file') writeFileSync(target, JSON.stringify({ permissions: {} }));
      else mkdirSync(target);
      chmodSync(target, 0o000);
      try {
        const res = run(shell, c, ['on', '--yes']);
        assert.equal(res.status, 1, `${which}: ${res.stdout}${res.stderr}`);
        assert.match(res.stderr, /cannot be read/, which);
      } finally {
        chmodSync(target, 0o755);
      }
      assert.equal(raw(c), c.text, which);
    }
  });

  t('a policy folder that cannot be searched stops on too: the files inside it cannot be seen to be absent', { skip: (!posix || asRoot) && 'needs POSIX mode bits and a non-root account' }, () => {
    const c = setup();
    mkdirSync(join(c.policyHome, 'managed-settings.d'), { recursive: true });
    writeFileSync(join(c.policyHome, 'managed-settings.json'), JSON.stringify({ permissions: { disableBypassPermissionsMode: 'disable' } }));
    chmodSync(c.policyHome, 0o000);
    try {
      const res = run(shell, c, ['on', '--yes']);
      assert.equal(res.status, 1, `${res.stdout}${res.stderr}`);
      assert.match(res.stderr, /cannot be read/);
    } finally {
      chmodSync(c.policyHome, 0o755);
    }
    assert.equal(raw(c), c.text);
  });

  t('a file at the drop-in folder name, or a folder at the policy file name, is no policy', {}, () => {
    for (const [what, make] of [
      ['a file named managed-settings.d', (home) => writeFileSync(join(home, 'managed-settings.d'), '{}')],
      ['a folder named managed-settings.json', (home) => mkdirSync(join(home, 'managed-settings.json'))],
    ]) {
      const c = setup();
      mkdirSync(c.policyHome, { recursive: true });
      make(c.policyHome);
      const res = run(shell, c, ['on', '--yes']);
      assert.equal(res.status, 0, `${what}: ${res.stdout}${res.stderr}`);
      assert.equal(read(c).permissions.defaultMode, 'bypassPermissions', what);
    }
  });

  t('settings nested too deep for the parser stop it with nothing changed, and the result still names the file', {}, () => {
    const c = setup('['.repeat(100000) + ']'.repeat(100000));
    const res = run(shell, c, ['on', '--yes']);
    assert.ok([1, 2].includes(res.status), `exit ${res.status}: ${res.stdout}${res.stderr}`.slice(0, 600));
    assert.equal(res.stdout.trimEnd().split(/\r?\n/).pop(), `settings file: ${c.settingsFile}`);
    assert.equal(raw(c), c.text);
    assert.equal(existsSync(c.bak), false);
  });

  t('settings that are not UTF-8 are refused as such and keep their bytes', {}, () => {
    const c = setup(null);
    const bytes = Buffer.from([0x7b, 0x22, 0x6e, 0x22, 0x3a, 0x22, 0xc7, 0xd1, 0x22, 0x7d]); // {"n":"<EUC-KR>"}
    writeFileSync(c.settingsFile, bytes);
    const res = run(shell, c, ['on', '--yes']);
    assert.equal(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stderr, /not valid UTF-8/);
    assert.deepEqual(readFileSync(c.settingsFile), bytes);
    assert.equal(existsSync(c.bak), false);
  });
}

// Root outside a sandbox: Claude Code refuses to start in the mode, so the python fallback refuses to set
// it. A user namespace maps this account to uid 0 without privileges; skipped where there is none.
const unshare = posix && python && works('unshare', ['-r', 'true']);
test('python: on refuses under root unless IS_SANDBOX=1 says this is a sandbox', { skip: !unshare && 'needs unshare -r (user namespaces) and python3' }, () => {
  const c = setup();
  const res = spawnSync('unshare', ['-r', python, PY, 'on', '--yes'], { encoding: 'utf8', env: env(c) });
  assert.equal(res.status, 1, res.stdout + res.stderr);
  assert.match(res.stderr, /root/);
  assert.equal(raw(c), c.text);
  const ok = spawnSync('unshare', ['-r', python, PY, 'on', '--yes'], { encoding: 'utf8', env: env(c, { IS_SANDBOX: '1' }) });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  spawnSync(python, [PY, 'off'], { encoding: 'utf8', env: env(c) });
  const bwrap = spawnSync('unshare', ['-r', python, PY, 'on', '--yes'], { encoding: 'utf8', env: env(c, { CLAUDE_CODE_BUBBLEWRAP: '1' }) });
  assert.equal(bwrap.status, 0, 'Claude Code counts its bubblewrap sandbox too: ' + bwrap.stdout + bwrap.stderr);
  spawnSync(python, [PY, 'off'], { encoding: 'utf8', env: env(c) });
  const zero = spawnSync('unshare', ['-r', python, PY, 'on', '--yes'], { encoding: 'utf8', env: env(c, { CLAUDE_CODE_BUBBLEWRAP: '0' }) });
  assert.equal(zero.status, 1, 'CLAUDE_CODE_BUBBLEWRAP=0 is no sandbox to Claude Code: ' + zero.stdout + zero.stderr);
});

// Controls with no case of their own so far: link chains, hard links, a bind-mounted file, NaN.
for (const shell of SHELLS) {
  const t = (title, opts, fn) => test(`${shell.name}: ${title}`, { ...opts, skip: shell.skip || opts.skip }, fn);

  t('a chain of links is followed to the file at its end, and every link stays', { skip: !posix && 'plain symlinks need POSIX' }, () => {
    const c = setup(null);
    const real = join(c.dir, 'real.json');
    const mid = join(c.dir, 'mid.json');
    writeFileSync(real, JSON.stringify({ model: 'opus' }));
    symlinkSync(real, mid);
    symlinkSync(mid, c.settingsFile);
    assert.equal(run(shell, c, ['on', '--yes']).status, 0);
    assert.ok(lstatSync(c.settingsFile).isSymbolicLink());
    assert.ok(lstatSync(mid).isSymbolicLink(), 'the middle link was not turned into a file');
    assert.deepEqual(JSON.parse(readFileSync(real, 'utf8')), { model: 'opus', permissions: { defaultMode: 'bypassPermissions' } });
  });

  t('a settings file that is one of two hard links is still changed under its own name', { skip: !posix && 'hard links are checked on POSIX' }, () => {
    const c = setup({ permissions: { defaultMode: 'bypassPermissions' }, model: 'opus' });
    linkSync(c.settingsFile, join(c.config, 'other-name.json'));
    const res = run(shell, c, ['off']);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.equal(read(c).permissions.defaultMode, undefined, 'the name Claude Code reads is the one that was changed');
  });
}

// A dev container that bind-mounts settings.json alone makes the rename fail with EBUSY: the python fallback
// writes in place then, as the node script does. A user namespace with its own mounts reproduces it without privileges.
const bindable = posix && python && (() => {
  const probe = join(root, 'bind-probe');
  writeFileSync(probe, 'x');
  return works('unshare', ['-rm', 'sh', '-c', `mount --bind "${probe}" "${probe}"`]);
})();
test('python: a bind-mounted single settings file is written in place', { skip: !bindable && 'needs unshare -rm (user and mount namespaces) and python3' }, () => {
  const c = setup();
  const res = spawnSync('unshare', ['-rm', 'sh', '-c', 'mount --bind "$TARGET" "$TARGET" && exec "$0" "$@"', python, PY, 'on', '--yes'], {
    encoding: 'utf8',
    env: env(c, { TARGET: c.settingsFile, IS_SANDBOX: '1' }),
  });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.equal(read(c).permissions.defaultMode, 'bypassPermissions');
  assert.deepEqual(read(c).env, BEFORE.env);
});

// Python's json module reads NaN and Infinity, which Claude Code's parser does not: writing them back would hand it
// a file it ignores whole. (Windows PowerShell 5.1 refuses them in ConvertFrom-Json; PowerShell 7 turns them into strings.)
test('python: NaN and Infinity are not JSON to Claude Code, so they are refused rather than written back', { skip: SHELLS[0].skip }, () => {
  const c = setup('{"a": NaN}');
  const res = run(SHELLS[0], c, ['on', '--yes']);
  assert.equal(res.status, 1, res.stdout + res.stderr);
  assert.match(res.stderr, /not valid JSON/);
  assert.equal(raw(c), c.text);
});

// The fallbacks keep no record of what `on` replaced. A record the node script left earlier is stale once they
// change the mode, and a later node `off` would restore the mode it names instead of the one just before.
for (const shell of SHELLS) {
  const t = (title, opts, fn) => test(`${shell.name}: ${title}`, { ...opts, skip: shell.skip || opts.skip }, fn);
  const recordOf = (c) => `${c.settingsFile}.bypass-permissions.json`;
  const stale = JSON.stringify({ hadPermissions: true, previous: 'acceptEdits', warningSkip: null });

  t('on drops a record the node script left, and off does too', {}, () => {
    const c = setup({ permissions: { defaultMode: 'plan' } });
    writeFileSync(recordOf(c), stale);
    assert.equal(run(shell, c, ['on', '--yes']).status, 0);
    assert.equal(existsSync(recordOf(c)), false, 'after on');
    writeFileSync(recordOf(c), stale);
    assert.equal(run(shell, c, ['off']).status, 0);
    assert.equal(existsSync(recordOf(c)), false, 'after off');
  });

  t('on when the mode is already on keeps the record: it is still the way back', {}, () => {
    const c = setup({ permissions: { defaultMode: 'bypassPermissions' } });
    writeFileSync(recordOf(c), stale);
    assert.equal(run(shell, c, ['on', '--yes']).status, 0);
    assert.equal(readFileSync(recordOf(c), 'utf8'), stale);
  });

  t('off that cannot write keeps the record', { skip: (!posix || asRoot) && 'needs POSIX mode bits and a non-root account' }, () => {
    // The link target is writable, so the check before the write passes; its folder is not, so the write fails.
    const c = setup(null);
    const locked = join(c.dir, 'locked');
    mkdirSync(locked);
    const real = join(locked, 'settings.json');
    writeFileSync(real, JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } }));
    symlinkSync(real, c.settingsFile);
    writeFileSync(recordOf(c), stale);
    chmodSync(locked, 0o555);
    try {
      const res = run(shell, c, ['off']);
      assert.equal(res.status, 3, res.stdout + res.stderr);
    } finally {
      chmodSync(locked, 0o755);
    }
    assert.equal(readFileSync(recordOf(c), 'utf8'), stale);
    assert.equal(JSON.parse(readFileSync(real, 'utf8')).permissions.defaultMode, 'bypassPermissions');
  });

  t('a refusal leaves the record alone: it may still be the way back', {}, () => {
    const c = setup('{ "model": "opus",\n');
    writeFileSync(recordOf(c), stale);
    assert.equal(run(shell, c, ['on', '--yes']).status, 1);
    assert.equal(readFileSync(recordOf(c), 'utf8'), stale);
  });
}

// Windows PowerShell 5.1 writes the console code page into a pipe (949 on Korean Windows), garbling a non-ASCII path
// for a reader that expects UTF-8. PowerShell can be told to use such a code page on any OS, so the fix for it is
// checked here without Windows (the Windows job checks the real thing). Not run on Windows: setting the encoding
// there fails when no console is attached.
test('PowerShell: a non-ASCII path survives a console whose code page is not UTF-8', { skip: (!posix && 'run on the Windows job by the test above') || (!powershell && 'needs powershell or pwsh') }, () => {
  const c = setup(BEFORE, { name: `설정 폴더 ${++seq}` });
  const command = `[Console]::OutputEncoding = [System.Text.Encoding]::GetEncoding(949); & '${PS1}' on --yes`;
  const res = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], { encoding: 'utf8', env: env(c) });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.equal(res.stdout.trimEnd().split(/\r?\n/).pop(), `settings file: ${c.settingsFile}`);
  // the error stream too: a refusal names the folder it did not find
  const gone = join(c.dir, `없는 폴더 ${++seq}`);
  const refused = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], { encoding: 'utf8', env: env(c, { CLAUDE_CONFIG_DIR: gone }) });
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.ok(refused.stderr.includes(gone), `the folder is named in the refusal: ${refused.stderr}`);
});
