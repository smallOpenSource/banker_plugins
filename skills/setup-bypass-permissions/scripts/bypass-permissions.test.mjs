// Tests for bypass-permissions.mjs. Run from the repo root: node --test skills/setup-bypass-permissions/scripts/*.test.mjs
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import fs, { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const CLI = fileURLToPath(new URL("./bypass-permissions.mjs", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "bypass-permissions-test-"));
// The module reads its defaults at import: point them into the scratch folder first, so a call
// that forgets its path can never reach the real ~/.claude/settings.json or machine policy.
process.env.BANKER_BYPASS_TEST = "1";
process.env.CLAUDE_CONFIG_DIR = join(root, "default-config"); // the only way to place the settings
process.env.BANKER_BYPASS_POLICY_FILES = join(root, "no-policy.json");
process.env.BANKER_BYPASS_POLICY_DIRS = join(root, "no-policy.d");
const { status, turnOff, turnOn } = await import("./bypass-permissions.mjs");
after(() => rmSync(root, { recursive: true, force: true }));

const posixOnly = { skip: process.platform === "win32" && "Windows has no POSIX mode bits or plain symlinks" };
const asRoot = process.platform !== "win32" && process.getuid?.() === 0;

let seq = 0;
// A config folder with settings.json holding `settings` (a string is written as is, null writes nothing).
function setup(settings = { model: "opus", env: { FOO: "1" } }, policy = null) {
  const dir = join(root, `case-${++seq}`);
  mkdirSync(dir);
  const settingsFile = join(dir, "settings.json");
  if (settings !== null) writeFileSync(settingsFile, typeof settings === "string" ? settings : JSON.stringify(settings, null, 2) + "\n");
  const policyFile = join(dir, "managed-settings.json");
  if (policy !== null) writeFileSync(policyFile, JSON.stringify(policy));
  return { dir, settingsFile, policyFiles: [policyFile], policyDirs: [join(dir, "managed-settings.d")], uid: 1000, sandbox: undefined };
}

const read = (c) => JSON.parse(readFileSync(c.settingsFile, "utf8"));
const bakOf = (c) => `${c.settingsFile}.bypass-permissions.bak`;
const recordOf = (c) => `${c.settingsFile}.bypass-permissions.json`;

test("on sets the default mode to bypassPermissions and keeps every other key", () => {
  const c = setup();
  const res = turnOn(c);
  assert.equal(res.ok, true, res.message);
  assert.deepEqual(read(c), { model: "opus", env: { FOO: "1" }, permissions: { defaultMode: "bypassPermissions" } });
});

test("on keeps the other permission rules beside the mode", () => {
  const c = setup({ permissions: { allow: ["Bash(ls:*)"], defaultMode: "acceptEdits" } });
  turnOn(c);
  assert.deepEqual(read(c), { permissions: { allow: ["Bash(ls:*)"], defaultMode: "bypassPermissions" } });
});

test("the file is written as two-space JSON with a final newline", () => {
  const c = setup({ a: 1 });
  turnOn(c);
  assert.equal(readFileSync(c.settingsFile, "utf8"), '{\n  "a": 1,\n  "permissions": {\n    "defaultMode": "bypassPermissions"\n  }\n}\n');
});

test("on creates the settings file in an existing config folder", () => {
  const c = setup(null);
  assert.equal(turnOn(c).ok, true);
  assert.deepEqual(read(c), { permissions: { defaultMode: "bypassPermissions" } });
});

test("without a Claude Code config folder, on refuses rather than make one", () => {
  const c = setup(null);
  const settingsFile = join(c.dir, "no-claude-here", "settings.json");
  const res = turnOn({ ...c, settingsFile });
  assert.equal(res.ok, false);
  assert.match(res.message, /설정 폴더가 없습니다/);
  assert.equal(existsSync(dirname(settingsFile)), false);
});

test("an empty or blank settings file reads as no settings", () => {
  for (const blank of ["", "  \n"]) {
    const c = setup(blank);
    assert.equal(turnOn(c).ok, true, JSON.stringify(blank));
    assert.deepEqual(read(c), { permissions: { defaultMode: "bypassPermissions" } });
  }
});

test("the settings file is replaced whole, keeping its mode", posixOnly, () => {
  const c = setup();
  chmodSync(c.settingsFile, 0o640);
  const ino = statSync(c.settingsFile).ino;
  const umask = process.umask(0o077); // a strict umask must not narrow the mode the file had
  try {
    assert.equal(turnOn(c).ok, true);
  } finally {
    process.umask(umask);
  }
  assert.notEqual(statSync(c.settingsFile).ino, ino, "a new file renamed into place, never a half-written one");
  assert.equal(statSync(c.settingsFile).mode & 0o777, 0o640);
  assert.equal(readdirSync(c.dir).filter((f) => f.endsWith(".tmp")).length, 0, "no temp file left");
});

test("off writes no backup: the one from before on stays", () => {
  const c = setup();
  const before = readFileSync(c.settingsFile, "utf8");
  turnOn(c);
  turnOff(c);
  assert.equal(readFileSync(bakOf(c), "utf8"), before);
});

test("a record that names bypassPermissions as the earlier mode is not trusted", () => {
  const c = setup({ permissions: { defaultMode: "bypassPermissions" } });
  writeFileSync(recordOf(c), JSON.stringify({ hadPermissions: true, previous: "bypassPermissions" }));
  const res = turnOff(c);
  assert.equal(res.ok, true, res.message);
  assert.deepEqual(read(c), { permissions: {} });
  assert.match(res.message, /기록이 없거나 그 기록을 믿을 수 없어/);
});

test("off when the mode is already off takes back a stale record", () => {
  const c = setup({ permissions: { defaultMode: "acceptEdits" } });
  writeFileSync(recordOf(c), JSON.stringify({ hadPermissions: true, previous: "plan" }));
  turnOff(c);
  assert.equal(existsSync(recordOf(c)), false);
  assert.deepEqual(read(c), { permissions: { defaultMode: "acceptEdits" } });
});

test("off takes back the warning skip Claude Code wrote after on, and keeps one that was there before", () => {
  const fresh = setup({ model: "opus" });
  turnOn(fresh);
  writeFileSync(fresh.settingsFile, JSON.stringify({ ...read(fresh), skipDangerousModePermissionPrompt: true }));
  turnOff(fresh);
  assert.deepEqual(read(fresh), { model: "opus" });
  const kept = setup({ model: "opus", skipDangerousModePermissionPrompt: true });
  turnOn(kept);
  turnOff(kept);
  assert.deepEqual(read(kept), { model: "opus", skipDangerousModePermissionPrompt: true });
});

test("on twice changes nothing the second time", () => {
  const c = setup();
  turnOn(c);
  const once = readFileSync(c.settingsFile, "utf8");
  const res = turnOn(c);
  assert.equal(res.ok, true);
  assert.match(res.message, /이미 켜져/);
  assert.equal(readFileSync(c.settingsFile, "utf8"), once);
});

test("off puts back the mode that was there before on", () => {
  const c = setup({ permissions: { defaultMode: "acceptEdits" }, x: true });
  turnOn(c);
  const res = turnOff(c);
  assert.equal(res.ok, true, res.message);
  assert.deepEqual(read(c), { permissions: { defaultMode: "acceptEdits" }, x: true });
});

test("off removes the mode, and the permissions object on made, when neither was there before", () => {
  const c = setup({ model: "opus" });
  turnOn(c);
  turnOff(c);
  assert.deepEqual(read(c), { model: "opus" });
});

test("off when the mode is not bypassPermissions changes nothing", () => {
  const c = setup({ permissions: { defaultMode: "plan" } });
  const before = readFileSync(c.settingsFile, "utf8");
  const res = turnOff(c);
  assert.equal(res.ok, true);
  assert.match(res.message, /이미 꺼져/);
  assert.equal(readFileSync(c.settingsFile, "utf8"), before);
});

test("off of a mode set by hand, with nothing remembered, removes the key (Claude Code's default start mode)", () => {
  const c = setup({ permissions: { defaultMode: "bypassPermissions", deny: ["Read(./.env)"] } });
  const res = turnOff(c);
  assert.equal(res.ok, true, res.message);
  assert.match(res.message, /기본 시작 모드/);
  assert.deepEqual(read(c), { permissions: { deny: ["Read(./.env)"] } });
});

for (const value of [true, "disable"]) {
  test(`on refuses when this machine's policy forbids the mode (disableBypassPermissionsMode: ${JSON.stringify(value)})`, () => {
    const c = setup(undefined, { permissions: { disableBypassPermissionsMode: value } });
    const before = readFileSync(c.settingsFile, "utf8");
    const res = turnOn(c);
    assert.equal(res.ok, false);
    assert.match(res.message, /관리 정책/);
    assert.equal(readFileSync(c.settingsFile, "utf8"), before);
    assert.match(status(c).message, /관리 정책/);
  });
}

const refusals = [
  ["a settings file that is not valid JSON", "{ \"model\": \"opus\",\n", /JSON/],
  ["settings whose permissions entry is not an object", { permissions: ["bypassPermissions"] }, /permissions/],
  ["settings that are not a JSON object", "[1, 2]\n", /객체/],
];
for (const [what, settings, why] of refusals) {
  test(`on refuses ${what} and leaves it untouched`, () => {
    const c = setup(settings);
    const before = readFileSync(c.settingsFile, "utf8");
    const res = turnOn(c);
    assert.equal(res.ok, false);
    assert.match(res.message, why);
    assert.equal(readFileSync(c.settingsFile, "utf8"), before);
    assert.equal(existsSync(bakOf(c)), false);
  });
}

test("the text from before each change is kept in a backup only this account can read", () => {
  const c = setup();
  const before = readFileSync(c.settingsFile, "utf8");
  turnOn(c);
  assert.equal(readFileSync(bakOf(c), "utf8"), before);
  if (process.platform !== "win32") assert.equal(statSync(bakOf(c)).mode & 0o777, 0o600);
});

test("a settings file reached through a link is changed where it lives, and the link stays", posixOnly, () => {
  const c = setup(null);
  const real = join(c.dir, "dotfiles-settings.json");
  writeFileSync(real, JSON.stringify({ model: "opus" }));
  symlinkSync(real, c.settingsFile);
  assert.equal(turnOn(c).ok, true);
  assert.ok(lstatSync(c.settingsFile).isSymbolicLink());
  assert.deepEqual(JSON.parse(readFileSync(real, "utf8")), { model: "opus", permissions: { defaultMode: "bypassPermissions" } });
});

test("status reports the mode, whether banker set it, and the policy", () => {
  const c = setup();
  assert.match(status(c).message, /bypass-permissions: 꺼짐 \(defaultMode: 없음\)/);
  turnOn(c);
  assert.match(status(c).message, /bypass-permissions: 켜짐 \(defaultMode: bypassPermissions, banker 가 설정\)/);
});

// The CLI as Claude runs it, kept off the real config folder.
const cliEnv = (c, extra = {}) => ({
  ...process.env,
  BANKER_BYPASS_TEST: "1",
  BANKER_BYPASS_POLICY_FILES: c.policyFiles.join("\n"),
  BANKER_BYPASS_POLICY_DIRS: c.policyDirs.join("\n"),
  CLAUDE_CONFIG_DIR: c.dir,
  HOME: c.dir,
  USERPROFILE: c.dir,
  ...extra,
});
const cli = (c, ...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: cliEnv(c) });

test("the command line takes on --yes, off and status, defaults to status and rejects anything else", () => {
  const c = setup();
  assert.equal(cli(c, "on", "--yes").status, 0);
  assert.match(cli(c).stdout, /bypass-permissions: 켜짐/);
  for (const bad of ["toggle", "constructor", "on --yes"]) {
    const res = cli(c, bad);
    assert.equal(res.status, 1, bad);
    assert.match(res.stdout, /사용법/);
  }
  assert.equal(cli(c, "off").status, 0);
  assert.deepEqual(read(c), { model: "opus", env: { FOO: "1" } });
});

test("on from the command line without --yes changes nothing", () => {
  const c = setup();
  const before = readFileSync(c.settingsFile, "utf8");
  const res = spawnSync(process.execPath, [CLI, "on"], { encoding: "utf8", env: cliEnv(c) });
  assert.equal(res.status, 1, res.stdout);
  assert.match(res.stdout, /--yes/);
  assert.equal(readFileSync(c.settingsFile, "utf8"), before);
});

test("no environment variable moves the settings: a repository's env block (BANKER_BYPASS_TEST included) cannot decoy off", () => {
  const c = setup({ permissions: { defaultMode: "bypassPermissions" } });
  const decoy = join(c.dir, "decoy", "settings.json");
  mkdirSync(dirname(decoy));
  writeFileSync(decoy, "{}\n");
  const res = spawnSync(process.execPath, [CLI, "off"], { encoding: "utf8", env: cliEnv(c, { BANKER_BYPASS_TEST: "1", BANKER_BYPASS_SETTINGS_FILE: decoy }) });
  assert.equal(res.status, 0, res.stdout);
  assert.equal(existsSync(`${decoy}.bypass-permissions.json`), false);
  assert.deepEqual(read(c), { permissions: {} }, "the file CLAUDE_CONFIG_DIR names was the one changed");
  assert.match(res.stdout, new RegExp(c.settingsFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "every answer names the file it acted on");
});

test("the policy overrides count only with BANKER_BYPASS_TEST=1", () => {
  const c = setup(undefined, { permissions: { disableBypassPermissionsMode: "disable" } });
  const on = (extra) => spawnSync(process.execPath, [CLI, "on", "--yes"], { encoding: "utf8", env: cliEnv(c, extra) });
  assert.equal(on({}).status, 1, "with the test switch the policy file is read");
  const off = on({ BANKER_BYPASS_TEST: "" });
  assert.equal(off.status, 0, "without it the real machine policy paths are used, not this one");
});

test("a refusal exits 1", () => {
  const c = setup("not json\n");
  const res = cli(c, "on", "--yes");
  assert.equal(res.status, 1, res.stdout);
});

test("the command follows CLAUDE_CONFIG_DIR", () => {
  const c = setup();
  const config = join(c.dir, "elsewhere");
  mkdirSync(config);
  writeFileSync(join(config, "settings.json"), "{}\n");
  const res = spawnSync(process.execPath, [CLI, "on", "--yes"], { encoding: "utf8", env: cliEnv(c, { CLAUDE_CONFIG_DIR: config }) });
  assert.equal(res.status, 0, res.stdout);
  assert.deepEqual(JSON.parse(readFileSync(join(config, "settings.json"), "utf8")), { permissions: { defaultMode: "bypassPermissions" } });
  assert.deepEqual(read(c), { model: "opus", env: { FOO: "1" } }, "the file outside CLAUDE_CONFIG_DIR is untouched");
});

test("a settings file this account cannot write exits 3, with nothing changed", { skip: (asRoot || process.platform === "win32") && "needs POSIX mode bits and a non-root account" }, () => {
  const c = setup();
  const before = readFileSync(c.settingsFile, "utf8");
  chmodSync(c.settingsFile, 0o444);
  try {
    const res = cli(c, "on", "--yes");
    assert.equal(res.status, 3, res.stdout);
    assert.match(res.stdout, /쓸 권한이 없습니다/);
    assert.equal(existsSync(bakOf(c)), false);
  } finally {
    chmodSync(c.settingsFile, 0o644);
  }
  assert.equal(readFileSync(c.settingsFile, "utf8"), before);
});

test("an unexpected failure partway exits 2 and points at status", () => {
  const c = setup();
  mkdirSync(bakOf(c)); // the backup cannot be written over a folder
  const res = cli(c, "on", "--yes");
  assert.equal(res.status, 2, res.stdout);
  assert.match(res.stdout, /예기치 못한 오류.*\n.*status/);
  assert.deepEqual(read(c), { model: "opus", env: { FOO: "1" } });
  assert.equal(existsSync(recordOf(c)), false, "the record written first is taken back");
});

test("the record of what on replaced is written before the settings: if it cannot be, nothing changes", () => {
  const c = setup();
  const before = readFileSync(c.settingsFile, "utf8");
  mkdirSync(recordOf(c)); // the record cannot be written over a folder
  const res = cli(c, "on", "--yes");
  assert.equal(res.status, 2, res.stdout);
  assert.equal(readFileSync(c.settingsFile, "utf8"), before);
  assert.equal(existsSync(bakOf(c)), false);
});

test("a folder this account cannot write exits 3 when the settings file is still to be made", { skip: (asRoot || process.platform === "win32") && "needs POSIX mode bits and a non-root account" }, () => {
  const c = setup(null);
  chmodSync(c.dir, 0o555);
  try {
    const res = cli(c, "on", "--yes");
    assert.equal(res.status, 3, res.stdout);
    assert.match(res.stdout, /쓸 권한이 없습니다/);
  } finally {
    chmodSync(c.dir, 0o755);
  }
  assert.equal(existsSync(c.settingsFile), false);
});

test("on refuses under root outside a sandbox, where Claude Code would then refuse to start", () => {
  const c = setup();
  const before = readFileSync(c.settingsFile, "utf8");
  const res = turnOn({ ...c, uid: 0, sandbox: undefined });
  assert.equal(res.ok, false);
  assert.match(res.message, /root/);
  assert.match(res.message, /IS_SANDBOX=1/);
  assert.equal(readFileSync(c.settingsFile, "utf8"), before);
  assert.equal(turnOn({ ...c, uid: 0, sandbox: "1" }).ok, true, "a sandbox that says so is fine");
  turnOff(c);
  assert.equal(turnOn({ ...c, uid: 0, sandbox: undefined, bubblewrap: "1" }).ok, true, "Claude Code's bubblewrap sandbox counts too");
  turnOff(c);
  for (const bubblewrap of ["0", "false", "", " "]) {
    assert.equal(turnOn({ ...c, uid: 0, sandbox: undefined, bubblewrap }).ok, false, `CLAUDE_CODE_BUBBLEWRAP=${JSON.stringify(bubblewrap)} is no sandbox to Claude Code`);
  }
  assert.equal(turnOn({ ...c, uid: 0, sandbox: "true" }).ok, false, 'IS_SANDBOX must be exactly "1"');
  assert.match(status({ ...c, uid: 0, sandbox: undefined }).message, /root/);
});

test("a BOM before the JSON is read the way Claude Code reads it, and kept", () => {
  const c = setup("\uFEFF" + JSON.stringify({ model: "opus" }));
  const res = turnOn(c);
  assert.equal(res.ok, true, res.message);
  const text = readFileSync(c.settingsFile, "utf8");
  assert.ok(text.startsWith("\uFEFF"), "the BOM stays");
  assert.deepEqual(JSON.parse(text.slice(1)), { model: "opus", permissions: { defaultMode: "bypassPermissions" } });
});

test("on refuses when the settings file itself forbids the mode", () => {
  const c = setup({ permissions: { disableBypassPermissionsMode: "disable" } });
  const before = readFileSync(c.settingsFile, "utf8");
  const res = turnOn(c);
  assert.equal(res.ok, false);
  assert.match(res.message, /disableBypassPermissionsMode/);
  assert.equal(readFileSync(c.settingsFile, "utf8"), before);
  assert.match(status(c).message, /disableBypassPermissionsMode/);
});

test("a policy drop-in file forbids the mode too; hidden files in the folder are not policy", () => {
  const c = setup();
  mkdirSync(c.policyDirs[0]);
  writeFileSync(join(c.policyDirs[0], ".draft.json"), JSON.stringify({ permissions: { disableBypassPermissionsMode: true } }));
  assert.equal(turnOn(c).ok, true, "a hidden file is ignored");
  turnOff(c);
  writeFileSync(join(c.policyDirs[0], "10-security.json"), JSON.stringify({ permissions: { disableBypassPermissionsMode: true } }));
  const res = turnOn(c);
  assert.equal(res.ok, false);
  assert.match(res.message, /10-security\.json/);
});

test("an empty permissions object survives on and off as it was", () => {
  const c = setup({ permissions: {} });
  const before = readFileSync(c.settingsFile, "utf8");
  turnOn(c);
  turnOff(c);
  assert.equal(readFileSync(c.settingsFile, "utf8"), before);
});

test("off takes back the record on wrote", () => {
  const c = setup();
  turnOn(c);
  assert.ok(existsSync(recordOf(c)));
  turnOff(c);
  assert.equal(existsSync(recordOf(c)), false);
});

test("a link planted at the backup's name is replaced, not written through", posixOnly, () => {
  const c = setup();
  const target = join(c.dir, "elsewhere.txt");
  writeFileSync(target, "keep me\n");
  symlinkSync(target, bakOf(c));
  assert.equal(turnOn(c).ok, true);
  assert.equal(readFileSync(target, "utf8"), "keep me\n");
  assert.equal(lstatSync(bakOf(c)).isSymbolicLink(), false);
});

test("a settings file that is not UTF-8 is refused and untouched, never rewritten with U+FFFD", () => {
  const c = setup(null);
  const bytes = Buffer.concat([Buffer.from('{"env":{"NOTE":"'), Buffer.from([0xc7, 0xd1, 0xb1, 0xdb]), Buffer.from('"}}')]);
  writeFileSync(c.settingsFile, bytes);
  const res = turnOn(c);
  assert.equal(res.ok, false);
  assert.match(res.message, /UTF-8/);
  assert.deepEqual(readFileSync(c.settingsFile), bytes);
  assert.equal(existsSync(bakOf(c)), false);
});

test("the backup is the original bytes, a BOM and CRLF included", () => {
  const c = setup(null);
  const bytes = Buffer.from("\uFEFF{\r\n  \"model\": \"opus\"\r\n}\r\n");
  writeFileSync(c.settingsFile, bytes);
  turnOn(c);
  turnOff(c);
  assert.deepEqual(readFileSync(bakOf(c)), bytes);
});

test("a record naming a mode Claude Code does not know is not trusted", () => {
  for (const previous of ["x", "", "BypassPermissions", "bypassPermissions ", 5]) {
    const c = setup({ permissions: { defaultMode: "bypassPermissions" } });
    writeFileSync(recordOf(c), JSON.stringify({ hadPermissions: true, previous }));
    assert.equal(turnOff(c).ok, true);
    assert.deepEqual(read(c), { permissions: {} }, JSON.stringify(previous));
  }
});

test("off puts the warning skip back to the value it had, not only to present or absent", () => {
  const c = setup({ model: "opus", skipDangerousModePermissionPrompt: false });
  turnOn(c);
  writeFileSync(c.settingsFile, JSON.stringify({ ...read(c), skipDangerousModePermissionPrompt: true }));
  turnOff(c);
  assert.deepEqual(read(c), { model: "opus", skipDangerousModePermissionPrompt: false });
});

test("every answer of the command line ends with the settings file it acted on", () => {
  const lastLine = (res) => res.stdout.trimEnd().split("\n").pop();
  const cases = [
    ["done", setup(), ["on", "--yes"], 0],
    ["refused", setup("not json\n"), ["on", "--yes"], 1],
    ["not a command", setup(), ["toggle"], 1],
    ["stopped partway", setup(), ["on", "--yes"], 2],
  ];
  mkdirSync(bakOf(cases[3][1])); // the backup cannot be written over a folder
  if (!asRoot && process.platform !== "win32") {
    const c = setup();
    chmodSync(c.settingsFile, 0o444);
    cases.push(["may not write", c, ["on", "--yes"], 3]);
  }
  for (const [what, c, args, code] of cases) {
    const res = cli(c, ...args);
    assert.equal(res.status, code, `${what}: ${res.stdout}`);
    assert.equal(lastLine(res), `설정 파일: ${c.settingsFile}`, what);
  }
});

test("once the settings are written, a read-back that fails keeps the record off needs", () => {
  const c = setup({ permissions: { defaultMode: "plan" } });
  const real = fs.readFileSync;
  let reads = 0;
  // The second read of the settings is the read-back after the write: make it fail.
  fs.readFileSync = function (file, ...rest) {
    if (file === c.settingsFile && ++reads === 2) throw Object.assign(new Error("simulated read failure"), { code: "EIO" });
    return real.call(this, file, ...rest);
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => turnOn(c), /simulated read failure/);
  } finally {
    fs.readFileSync = real;
    syncBuiltinESMExports();
  }
  assert.equal(read(c).permissions.defaultMode, "bypassPermissions", "the write itself landed");
  assert.equal(existsSync(recordOf(c)), true, "the record is still there");
  assert.equal(turnOff(c).ok, true);
  assert.deepEqual(read(c), { permissions: { defaultMode: "plan" } }, "off puts back the earlier mode");
});

test("a policy file or folder this account cannot read stops on: nothing says the policy allows the mode", { skip: (asRoot || process.platform === "win32") && "needs POSIX mode bits and a non-root account" }, () => {
  for (const which of ["file", "folder"]) {
    const c = setup(undefined, which === "file" ? { permissions: {} } : null);
    const target = which === "file" ? c.policyFiles[0] : c.policyDirs[0];
    if (which === "folder") mkdirSync(target);
    chmodSync(target, 0o000);
    try {
      const res = turnOn(c);
      assert.equal(res.ok, false, which);
      assert.match(res.message, /관리 정책을 읽을 수 없습니다/, which);
      assert.match(status(c).message, /관리 정책을 읽을 수 없습니다/, `${which}: status says so too`);
    } finally {
      chmodSync(target, 0o755);
    }
    assert.deepEqual(read(c), { model: "opus", env: { FOO: "1" } }, which);
  }
});

test("a folder at a policy file's name is no policy", () => {
  const c = setup();
  mkdirSync(c.policyFiles[0]);
  assert.equal(turnOn(c).ok, true);
});

test("off on a settings file this account cannot write exits 3, with nothing changed", { skip: asRoot && "root writes past mode bits" }, () => {
  const c = setup({ permissions: { defaultMode: "bypassPermissions" } });
  const before = readFileSync(c.settingsFile, "utf8");
  chmodSync(c.settingsFile, 0o444); // on Windows this sets the read-only attribute
  try {
    const res = cli(c, "off");
    assert.equal(res.status, 3, res.stdout);
    assert.match(res.stdout, /쓸 권한이 없습니다/);
  } finally {
    chmodSync(c.settingsFile, 0o644);
  }
  assert.equal(readFileSync(c.settingsFile, "utf8"), before);
});

test("once off has written the settings, a read-back that still shows the mode fails the command and keeps the record", () => {
  const c = setup({ permissions: { defaultMode: "plan" } });
  turnOn(c);
  const onText = readFileSync(c.settingsFile);
  const real = fs.readFileSync;
  let reads = 0;
  // off reads the settings first, then reads them back after the write: the second read shows the mode still on.
  fs.readFileSync = function (file, ...rest) {
    if (file === c.settingsFile && ++reads === 2) return onText;
    return real.call(this, file, ...rest);
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => turnOff(c), /다시 읽은 설정/);
  } finally {
    fs.readFileSync = real;
    syncBuiltinESMExports();
  }
  assert.equal(existsSync(recordOf(c)), true, "the record that off needs is still there");
});
