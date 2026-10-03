// Tests for payload-mon.mjs. Run from the repo root: node --test skills/payload-mon/scripts/*.test.mjs
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { status, turnOff, turnOn } from "./payload-mon.mjs";
import { CACHE_DIR } from "./payload-size.mjs";

const CLI = fileURLToPath(new URL("./payload-mon.mjs", import.meta.url));
const MODULE = fileURLToPath(new URL("./payload-size.mjs", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "payload-mon-test-"));
after(() => rmSync(root, { recursive: true, force: true }));

// Ownership and mode-bit checks, and links made without privileges, are POSIX matters.
const posixOnly = { skip: process.platform === "win32" && "Windows has no uid or POSIX mode bits" };

// Runnable stand-ins for omc-hud-custom.mjs: the lines the block relies on, laid
// out and indented as in the two real wrappers around omc-hud.mjs.
//
// The older wrapper reads stdin into `let input` and runs the HUD with spawnSync.
const HUD = [
  'import { spawnSync } from "node:child_process";',
  'import { readFileSync } from "node:fs";',
  "",
  'let input = "";',
  "try {",
  '  input = readFileSync(0, "utf8");',
  "} catch {",
  "  /* no stdin */",
  "}",
  "",
  'const res = spawnSync(process.execPath, ["-e", ""], { input, encoding: "utf8" }); // runs omc-hud.mjs',
  "const colorRate = (seg) => `<${seg}>`;",
  "const colorCtx = (seg) => seg;",
  "try {",
  '  const f = { ctx: "ctx:21%", se: "se:1.0hr" };',
  "  const colored = [];",
  "  if (f.ctx) colored.push(colorCtx(f.ctx));",
  "  if (f.se) colored.push(f.se);",
  '  process.stdout.write(colored.join("|") + "\\n");',
  "} catch {",
  '  process.stdout.write("raw\\n");',
  "}",
  "",
].join("\n");

// The current omc_hud wrapper reads stdin into `const input` with a time limit
// and runs the HUD in-process; spawnSync survives only in a fallback branch, so
// anything placed before it would run only when the HUD fails.
const HUD_INPROC = [
  'import { spawnSync } from "node:child_process";',
  'import { readFileSync } from "node:fs";',
  "",
  "async function readStdinBounded() {",
  "  try {",
  '    return readFileSync(0, "utf8");',
  "  } catch {",
  '    return "";',
  "  }",
  "}",
  "const input = await readStdinBounded();",
  "",
  'let raw = "OMC#4.15.5"; // what omc-hud.mjs printed, rendered in-process',
  "if (!raw.trim()) {",
  '  const res = spawnSync(process.execPath, ["-e", ""], { input, encoding: "utf8" });',
  '  raw = res.stdout || "";',
  "}",
  "const colorRate = (seg) => `<${seg}>`;",
  "const colorCtx = (seg) => seg;",
  "try {",
  '  const f = { ctx: "ctx:21%", se: "se:1.0hr" };',
  "  const colored = [];",
  "  if (f.ctx) colored.push(colorCtx(f.ctx));",
  "  if (f.se) colored.push(f.se);",
  '  process.stdout.write(colored.join("|") + "\\n");',
  "} catch {",
  '  process.stdout.write("raw\\n");',
  "}",
  "",
].join("\n");

const LAYOUTS = [
  ["the older wrapper (spawnSync)", HUD],
  ["the current omc_hud wrapper (in-process)", HUD_INPROC],
];

// What another tool's patcher adds to the same wrapper, at the anchors such
// patchers use, with its own markers.
const withOtherBlocks = (src) =>
  src
    .replace("const res = spawnSync", '// >>> other-tool hud >>>\nlet otherModel = "";\n// <<< other-tool hud <<<\nconst res = spawnSync')
    .replace("  const colored = [];", "  // >>> other-tool hud >>>\n  void otherModel;\n  // <<< other-tool hud <<<\n  const colored = [];");
const OTHER_BLOCKS = /^[ \t]*\/\/ >>> other-tool hud >>>[\s\S]*?\/\/ <<< other-tool hud <<<[ \t]*\r?\n/gm;

// What the standalone version of payload-mon wrote: a block before spawnSync
// and one after ctx.
const withStandaloneBlocks = (src) =>
  src
    .replace(
      "const res = spawnSync",
      [
        "// >>> payload-mon >>>",
        'let payloadMon = "";',
        "try {",
        "  const transcript = JSON.parse(input)?.transcript_path;",
        "  if (transcript) {",
        '    const { estimatePayloadBytes, payloadSegment } = await import("file:///old/skills/payload-mon/scripts/payload-size.mjs");',
        "    payloadMon = payloadSegment(estimatePayloadBytes(transcript));",
        "  }",
        "} catch {",
        "  /* no stdin JSON, unreadable transcript or module error */",
        "}",
        "// <<< payload-mon <<<",
        "const res = spawnSync",
      ].join("\n"),
    )
    .replace(
      "  if (f.ctx) colored.push(colorCtx(f.ctx));\n",
      "  if (f.ctx) colored.push(colorCtx(f.ctx));\n  // >>> payload-mon >>>\n  if (payloadMon) colored.push(colorRate(payloadMon));\n  // <<< payload-mon <<<\n",
    );

let seq = 0;
function setup(hudText = HUD) {
  const dir = join(root, `case-${++seq}`);
  mkdirSync(dir);
  const hudFile = join(dir, "omc-hud-custom.mjs");
  writeFileSync(hudFile, hudText);
  // render() points TMPDIR here, so this is where the wrapper's cache lands. The
  // rest keeps status() off the live session, its settings and its transcripts.
  return {
    dir,
    hudFile,
    cacheDir: join(dir, basename(CACHE_DIR)),
    settingsFile: join(dir, "settings.json"),
    projectsDir: join(dir, "projects"),
    sessionId: "",
  };
}

const copyOf = (c) => join(c.dir, "payload-mon", "payload-size.mjs");

function transcriptOf(dir, chars) {
  const path = join(dir, "session.jsonl");
  writeFileSync(path, JSON.stringify({ type: "user", message: { role: "user", content: "x".repeat(chars) } }) + "\n");
  return path;
}

// Renders the wrapper the way Claude Code does: statusline JSON on stdin. The
// temp variables keep the estimate cache inside the case folder on every OS.
const render = (c, transcriptPath) =>
  spawnSync(process.execPath, [c.hudFile], {
    input: JSON.stringify({ transcript_path: transcriptPath }),
    encoding: "utf8",
    env: { ...process.env, TMPDIR: c.dir, TEMP: c.dir, TMP: c.dir },
  }).stdout;

const markers = (text) => text.split("// <<< payload-mon <<<").length - 1;
const NINE_MB = 9 * 1024 * 1024;

for (const [layout, hud] of LAYOUTS) {
  test(`on adds one block to ${layout}, which then shows payload after ctx from 8MB`, () => {
    const c = setup(hud);
    const res = turnOn(c);
    assert.equal(res.ok, true, res.message);
    assert.equal(markers(readFileSync(c.hudFile, "utf8")), 1);
    assert.equal(render(c, transcriptOf(c.dir, NINE_MB)), "ctx:21%|<payload:28%/9.0MB>|se:1.0hr\n");
  });

  test(`below 8MB, or with no transcript, ${layout} prints what it printed before`, () => {
    const c = setup(hud);
    turnOn(c);
    assert.equal(render(c, transcriptOf(c.dir, 1000)), "ctx:21%|se:1.0hr\n");
    assert.equal(render(c, join(c.dir, "missing.jsonl")), "ctx:21%|se:1.0hr\n");
  });

  test(`off restores ${layout} byte for byte and deletes the module copy and the cache`, () => {
    const c = setup(hud);
    turnOn(c);
    render(c, transcriptOf(c.dir, 1000)); // leaves a cache entry behind
    assert.ok(existsSync(c.cacheDir));
    assert.ok(existsSync(copyOf(c)));
    const res = turnOff(c);
    assert.equal(res.ok, true, res.message);
    assert.equal(readFileSync(c.hudFile, "utf8"), hud);
    assert.equal(existsSync(c.cacheDir), false);
    assert.equal(existsSync(dirname(copyOf(c))), false);
  });
}

test("the block imports a copy kept beside the wrapper, so it outlives the plugin folder it came from", () => {
  const c = setup();
  const moved = join(c.dir, "plugin-0.0.1");
  mkdirSync(moved);
  writeFileSync(join(moved, "payload-size.mjs"), readFileSync(MODULE));
  turnOn({ ...c, moduleSource: join(moved, "payload-size.mjs") });
  rmSync(moved, { recursive: true }); // what a plugin update does to the old version
  assert.doesNotMatch(readFileSync(c.hudFile, "utf8"), /plugin-0\.0\.1/);
  assert.equal(render(c, transcriptOf(c.dir, NINE_MB)), "ctx:21%|<payload:28%/9.0MB>|se:1.0hr\n");
});

test("on twice changes nothing the second time", () => {
  const c = setup();
  turnOn(c);
  const once = readFileSync(c.hudFile, "utf8");
  const res = turnOn(c);
  assert.equal(res.ok, true);
  assert.match(res.message, /이미 켜져/);
  assert.equal(readFileSync(c.hudFile, "utf8"), once);
});

test("off when already off changes nothing", () => {
  const c = setup();
  const res = turnOff(c);
  assert.equal(res.ok, true);
  assert.match(res.message, /이미 꺼져/);
  assert.equal(readFileSync(c.hudFile, "utf8"), HUD);
});

test("off leaves a folder beside the wrapper alone when it holds more than the copy", () => {
  const c = setup();
  turnOn(c);
  writeFileSync(join(dirname(copyOf(c)), "notes.txt"), "not ours");
  assert.equal(turnOff(c).ok, true);
  assert.equal(existsSync(copyOf(c)), false);
  assert.equal(readFileSync(join(dirname(copyOf(c)), "notes.txt"), "utf8"), "not ours");
});

test("keeps the text from before each change in <wrapper>.payload-mon.bak", () => {
  const c = setup();
  turnOn(c);
  assert.equal(readFileSync(`${c.hudFile}.payload-mon.bak`, "utf8"), HUD);
});

test("on converts the standalone version's two blocks into the one block, and off restores the wrapper", () => {
  const c = setup(withStandaloneBlocks(HUD));
  const res = turnOn(c);
  assert.equal(res.ok, true, res.message);
  const on = readFileSync(c.hudFile, "utf8");
  assert.equal(markers(on), 1);
  assert.doesNotMatch(on, /payloadMon|file:\/\/\/old/);
  assert.match(status(c).message, /payload-mon: 켜짐 \(/);
  assert.equal(render(c, transcriptOf(c.dir, NINE_MB)), "ctx:21%|<payload:28%/9.0MB>|se:1.0hr\n");
  assert.equal(turnOff(c).ok, true);
  assert.equal(readFileSync(c.hudFile, "utf8"), HUD);
});

test("lives alongside another tool's blocks: neither patcher removes the other's", () => {
  const c = setup(withOtherBlocks(HUD));
  turnOn(c);
  const on = readFileSync(c.hudFile, "utf8");
  assert.equal(on.split("// <<< other-tool hud <<<").length - 1, 2);
  const otherRemoved = on.replace(OTHER_BLOCKS, ""); // what that patcher's unpatch does
  assert.equal(markers(otherRemoved), 1);
  const check = join(c.dir, "other-removed.mjs");
  writeFileSync(check, otherRemoved);
  assert.equal(spawnSync(process.execPath, ["--check", check]).status, 0);
  turnOff(c);
  assert.equal(readFileSync(c.hudFile, "utf8"), withOtherBlocks(HUD));
});

test("on after another tool re-patched around our block is still a no-op", () => {
  const c = setup(withOtherBlocks(HUD));
  turnOn(c);
  // Its unpatch, then patch again.
  writeFileSync(c.hudFile, withOtherBlocks(readFileSync(c.hudFile, "utf8").replace(OTHER_BLOCKS, "")));
  const repatched = readFileSync(c.hudFile, "utf8");
  const res = turnOn(c);
  assert.match(res.message, /이미 켜져/);
  assert.equal(readFileSync(c.hudFile, "utf8"), repatched);
  assert.match(status(c).message, /payload-mon: 켜짐 \(/);
});

test("a CRLF wrapper goes on and comes off byte for byte", () => {
  const crlf = HUD.replace(/\n/g, "\r\n");
  const c = setup(crlf);
  assert.equal(turnOn(c).ok, true);
  assert.equal(render(c, transcriptOf(c.dir, NINE_MB)), "ctx:21%|<payload:28%/9.0MB>|se:1.0hr\n");
  assert.equal(turnOff(c).ok, true);
  assert.equal(readFileSync(c.hudFile, "utf8"), crlf);
});

test("markers that do not pair up are refused by on and off, which leave the wrapper alone", () => {
  const stray = HUD + "// >>> payload-mon >>>\n";
  const c = setup(stray);
  for (const res of [turnOn(c), turnOff(c)]) {
    assert.equal(res.ok, false);
    assert.match(res.message, /짝이 맞지 않습니다/);
  }
  assert.equal(readFileSync(c.hudFile, "utf8"), stray);
});

test("off still turns the segment off when the cache cannot be deleted", () => {
  const c = setup();
  turnOn(c);
  const locked = join(c.dir, "locked");
  const cache = join(locked, "cache");
  mkdirSync(cache, { recursive: true });
  chmodSync(cache, 0o700); // a folder this account controls, whatever the umask, so off tries it
  writeFileSync(join(cache, "entry.json"), "{}");
  chmodSync(locked, 0o500); // the cache folder's own entry can no longer be removed
  try {
    const res = turnOff({ ...c, cacheDir: cache });
    assert.equal(res.ok, true, res.message);
    assert.equal(readFileSync(c.hudFile, "utf8"), HUD);
    // Where the lock holds (not Windows, not root), the folder itself really stayed and off stood anyway.
    if (process.platform !== "win32" && process.getuid?.() !== 0) assert.ok(existsSync(cache));
  } finally {
    chmodSync(locked, 0o700);
  }
});

test("status flags a module copy that differs from this version, and on brings it up to date", () => {
  const c = setup();
  turnOn(c);
  writeFileSync(copyOf(c), "// an older version's module\n");
  const before = readFileSync(c.hudFile, "utf8");
  assert.match(status(c).message, /모듈 사본이 이 버전과 다름/);
  const res = turnOn(c);
  assert.equal(res.ok, true, res.message);
  assert.match(res.message, /모듈 사본을 이 버전으로 맞췄습니다/);
  assert.deepEqual(readFileSync(copyOf(c)), readFileSync(MODULE));
  assert.equal(readFileSync(c.hudFile, "utf8"), before);
  assert.match(status(c).message, /payload-mon: 켜짐 \(/);
});

test("status flags a missing module copy, and on puts it back", () => {
  const c = setup();
  turnOn(c);
  rmSync(copyOf(c));
  assert.match(status(c).message, /모듈 사본이 없어 표시되지 않음/);
  assert.equal(turnOn(c).ok, true);
  assert.equal(render(c, transcriptOf(c.dir, NINE_MB)), "ctx:21%|<payload:28%/9.0MB>|se:1.0hr\n");
});

test("on moves a block that no longer sits right after the ctx line back into place", () => {
  const c = setup();
  turnOn(c);
  const whole = readFileSync(c.hudFile, "utf8");
  const block = /^ {2}\/\/ >>> payload-mon >>>[\s\S]*?\/\/ <<< payload-mon <<<\n/m;
  const seLine = "  if (f.se) colored.push(f.se);\n";
  writeFileSync(c.hudFile, whole.replace(block, "").replace(seLine, (m) => m + whole.match(block)[0]));
  assert.match(status(c).message, /불완전하거나 오래됨/);
  assert.equal(turnOn(c).ok, true);
  assert.equal(readFileSync(c.hudFile, "utf8"), whole);
});

test("on refuses a file that is not the OMC custom HUD and leaves it untouched", () => {
  const other = 'console.log("my own statusline");\n';
  const c = setup(other);
  const res = turnOn(c);
  assert.equal(res.ok, false);
  assert.match(res.message, /OMC 커스텀 HUD/);
  assert.equal(readFileSync(c.hudFile, "utf8"), other);
  assert.equal(existsSync(copyOf(c)), false);
});

test("on refuses when the ctx line it anchors on is gone", () => {
  const noCtx = HUD.replace("  if (f.ctx) colored.push(colorCtx(f.ctx));\n", "");
  const c = setup(noCtx);
  const res = turnOn(c);
  assert.equal(res.ok, false);
  assert.match(res.message, /삽입 위치/);
  assert.equal(readFileSync(c.hudFile, "utf8"), noCtx);
});

test("on refuses when no input variable holds the statusline JSON", () => {
  const renamed = HUD.replace('let input = "";', 'let stdin = "";')
    .replace("  input = readFileSync", "  stdin = readFileSync")
    .replace("{ input, encoding", "{ input: stdin, encoding");
  const c = setup(renamed);
  const res = turnOn(c);
  assert.equal(res.ok, false);
  assert.match(res.message, /input 변수/);
  assert.equal(readFileSync(c.hudFile, "utf8"), renamed);
});

test("on refuses a result that would not parse and leaves the wrapper and the copy alone", () => {
  // The ctx line moved into a plain function, where the block's await is not allowed.
  const inFunction = HUD.replace("try {\n  const f =", "function format() {\ntry {\n  const f =").replace(
    '  process.stdout.write("raw\\n");\n}\n',
    '  process.stdout.write("raw\\n");\n}\n}\nformat();\n',
  );
  const c = setup(inFunction);
  assert.equal(spawnSync(process.execPath, ["--check", c.hudFile]).status, 0, "the stand-in itself parses");
  const res = turnOn(c);
  assert.equal(res.ok, false);
  assert.match(res.message, /node --check/);
  assert.equal(readFileSync(c.hudFile, "utf8"), inFunction);
  assert.equal(existsSync(copyOf(c)), false);
});

test("on leaves the wrapper alone when the module copy cannot be written", () => {
  const c = setup();
  writeFileSync(join(c.dir, "payload-mon"), "a file where the copy's folder would go");
  const res = turnOn(c);
  assert.equal(res.ok, false);
  assert.match(res.message, /모듈 사본을 쓰지 못했습니다/);
  assert.equal(readFileSync(c.hudFile, "utf8"), HUD);
});

test("on says so when the wrapper is missing", () => {
  const c = setup();
  rmSync(c.hudFile);
  const res = turnOn(c);
  assert.equal(res.ok, false);
  assert.match(res.message, /래퍼가 없습니다/);
});

test("status reports on/off, whether the statusline uses the wrapper, and this session's estimate", () => {
  const c = setup();
  const projectsDir = join(c.dir, "projects");
  mkdirSync(join(projectsDir, "-work"), { recursive: true });
  writeFileSync(
    join(projectsDir, "-work", "s1.jsonl"),
    JSON.stringify({ type: "user", message: { role: "user", content: "x".repeat(1024 * 1024) } }) + "\n",
  );
  const settingsFile = join(c.dir, "settings.json");
  writeFileSync(settingsFile, JSON.stringify({ statusLine: { type: "command", command: `node ${c.hudFile}` } }));
  const opts = { ...c, settingsFile, projectsDir, sessionId: "s1" };

  assert.match(status(opts).message, /꺼짐/);
  turnOn(c);
  const on = status(opts).message;
  assert.match(on, /payload-mon: 켜짐 \(/);
  assert.match(on, /현재 세션: 1\.0MB \/ 32MB \(3%\)/);
  assert.doesNotMatch(on, /주의/);

  // Another wrapper around the HUD hides its name from the command; say what that means.
  writeFileSync(settingsFile, JSON.stringify({ statusLine: { type: "command", command: "node ~/.claude/wrap.mjs" } }));
  assert.match(status(opts).message, /주의: statusLine 명령에 omc-hud-custom\.mjs가 보이지 않습니다\. 다른 래퍼/);
});

// The CLI as Claude runs it, kept off the real config folder and the live session.
const cliEnv = (c, extra = {}) => ({
  ...process.env,
  PAYLOAD_MON_HUD_FILE: c.hudFile,
  CLAUDE_CONFIG_DIR: join(c.dir, "config"),
  TMPDIR: c.dir,
  TEMP: c.dir,
  TMP: c.dir,
  HOME: c.dir,
  USERPROFILE: c.dir,
  CLAUDE_CODE_SESSION_ID: "",
  ...extra,
});
const cli = (c, script, ...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: cliEnv(c) });

test("the command runs when reached through a symlinked folder", () => {
  const c = setup();
  const linked = join(c.dir, "linked-scripts");
  // A junction is the folder link Windows lets any account make; elsewhere the type is ignored.
  symlinkSync(dirname(CLI), linked, "junction");
  const res = cli(c, join(linked, "payload-mon.mjs"), "status");
  assert.equal(res.status, 0);
  assert.match(res.stdout, /payload-mon: 꺼짐/);
});

test("the command line takes on/off/status, defaults to status and rejects anything else", () => {
  const c = setup();
  const run = (...args) => cli(c, CLI, ...args);
  assert.equal(run("on").status, 0);
  assert.match(run().stdout, /payload-mon: 켜짐 \(/);
  assert.match(run("STATUS").stdout, /payload-mon: 켜짐 \(/);
  const bad = run("toggle");
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /사용법/);
  const inherited = run("constructor"); // a name every plain object answers to
  assert.equal(inherited.status, 1);
  assert.match(inherited.stdout, /사용법/);
  assert.equal(run("off").status, 0);
  assert.equal(readFileSync(c.hudFile, "utf8"), HUD);
});

test("without an explicit wrapper path the command follows CLAUDE_CONFIG_DIR", () => {
  const c = setup();
  const config = join(c.dir, "config");
  const hudFile = join(config, "hud", "omc-hud-custom.mjs");
  mkdirSync(dirname(hudFile), { recursive: true });
  writeFileSync(hudFile, HUD);
  writeFileSync(join(config, "settings.json"), JSON.stringify({ statusLine: { command: `node ${hudFile}` } }));
  const env = cliEnv(c, { PAYLOAD_MON_HUD_FILE: "" });
  const on = spawnSync(process.execPath, [CLI, "on"], { encoding: "utf8", env });
  assert.equal(on.status, 0, on.stdout);
  assert.doesNotMatch(on.stdout, /주의/);
  assert.equal(markers(readFileSync(hudFile, "utf8")), 1);
  assert.ok(existsSync(join(config, "hud", "payload-mon", "payload-size.mjs")));
  assert.equal(readFileSync(c.hudFile, "utf8"), HUD, "the wrapper outside CLAUDE_CONFIG_DIR is untouched");
});

const asRoot = process.platform !== "win32" && process.getuid?.() === 0;
test("a wrapper this account cannot write is refused up front, with nothing changed", { skip: asRoot && "root writes read-only files" }, () => {
  const c = setup();
  chmodSync(c.hudFile, 0o444);
  try {
    const res = cli(c, CLI, "on");
    assert.equal(res.status, 1, res.stdout);
    assert.match(res.stdout, /래퍼에 쓸 권한이 없습니다/);
    assert.equal(existsSync(copyOf(c)), false);
    assert.equal(existsSync(`${c.hudFile}.payload-mon.bak`), false);
  } finally {
    chmodSync(c.hudFile, 0o644);
  }
  assert.equal(readFileSync(c.hudFile, "utf8"), HUD);
});

test("an unexpected failure partway exits 2, points at status and keeps the wrapper", () => {
  const c = setup();
  mkdirSync(`${c.hudFile}.payload-mon.bak`); // the backup cannot be written over a folder
  const res = cli(c, CLI, "on");
  assert.equal(res.status, 2, res.stdout);
  assert.match(res.stdout, /예기치 못한 오류.*\n.*status/);
  assert.equal(readFileSync(c.hudFile, "utf8"), HUD);
  assert.deepEqual(readdirSync(c.dir).filter((name) => name.endsWith(".tmp")), [], "the failed write's temp file is gone");
});

test("off leaves alone a cache folder this account does not control", posixOnly, () => {
  const c = setup();
  turnOn(c);
  mkdirSync(c.cacheDir);
  chmodSync(c.cacheDir, 0o777); // as if another account had made it first
  writeFileSync(join(c.cacheDir, "theirs.json"), "{}");
  assert.equal(turnOff(c).ok, true);
  assert.ok(existsSync(join(c.cacheDir, "theirs.json")));
  assert.equal(readFileSync(c.hudFile, "utf8"), HUD);
});

test("no other account can change the module copy the statusline imports", posixOnly, () => {
  const c = setup();
  turnOn(c);
  assert.equal(statSync(copyOf(c)).mode & 0o022, 0, "copy writable by group or others");
  assert.equal(statSync(dirname(copyOf(c))).mode & 0o022, 0, "copy's folder writable by group or others");
});

test("on replaces a link planted at the copy's name instead of writing through it", posixOnly, () => {
  const c = setup();
  mkdirSync(dirname(copyOf(c)), { mode: 0o700 });
  const victim = join(c.dir, "victim.txt");
  writeFileSync(victim, "keep me");
  symlinkSync(victim, copyOf(c));
  assert.equal(turnOn(c).ok, true);
  assert.equal(readFileSync(victim, "utf8"), "keep me");
  assert.ok(lstatSync(copyOf(c)).isFile());
  assert.deepEqual(readFileSync(copyOf(c)), readFileSync(MODULE));
});

test("the backup is written fresh, never through a link planted at its name", posixOnly, () => {
  const c = setup();
  const victim = join(c.dir, "victim.txt");
  writeFileSync(victim, "keep me");
  symlinkSync(victim, `${c.hudFile}.payload-mon.bak`);
  assert.equal(turnOn(c).ok, true);
  assert.equal(readFileSync(victim, "utf8"), "keep me");
  assert.ok(lstatSync(`${c.hudFile}.payload-mon.bak`).isFile());
  assert.equal(readFileSync(`${c.hudFile}.payload-mon.bak`, "utf8"), HUD);
});

for (const [layout, hud] of LAYOUTS) {
  test(`a missing or broken module copy costs ${layout} only the segment, never the statusline`, () => {
    const c = setup(hud);
    turnOn(c);
    const big = transcriptOf(c.dir, NINE_MB);
    const intact = "ctx:21%|se:1.0hr\n";
    rmSync(copyOf(c));
    assert.equal(render(c, big), intact, "copy deleted");
    writeFileSync(copyOf(c), "export default 1;\n");
    assert.equal(render(c, big), intact, "copy without the functions the block calls");
    writeFileSync(copyOf(c), 'throw new Error("broken module");\n');
    assert.equal(render(c, big), intact, "copy that throws while loading");
  });
}

test("status points at a reinstall, not at on, when the markers do not pair up", () => {
  const c = setup(HUD + "  // <<< payload-mon <<<\n");
  const state = status(c).message;
  assert.match(state, /짝이 맞지 않습니다/);
  assert.doesNotMatch(state, /on 으로 복구/);
  assert.equal(turnOn(c).ok, false);
});

const readLockSkip =
  (asRoot && "root reads any file") || (process.platform === "win32" && "mode bits do not lock reads on Windows");
test("a wrapper that exists but cannot be read is not taken for a missing one", { skip: readLockSkip }, () => {
  const c = setup();
  assert.equal(turnOn(c).ok, true);
  chmodSync(c.hudFile, 0o000);
  try {
    const shown = cli(c, CLI, "status"); // where an exit 2 sends the user, so it must answer
    assert.equal(shown.status, 0, shown.stdout);
    assert.match(shown.stdout, /HUD 래퍼를 읽을 수 없음 \(EACCES\)/);
    for (const command of ["on", "off"]) {
      const res = cli(c, CLI, command);
      assert.equal(res.status, 2, `${command}: ${res.stdout}`);
      assert.doesNotMatch(res.stdout, /래퍼가 없/);
    }
  } finally {
    chmodSync(c.hudFile, 0o644);
  }
  assert.ok(existsSync(copyOf(c)), "off did not clear up behind a block it could not see");
});

test("a failed refresh keeps the module copy that worked", () => {
  const c = setup();
  turnOn(c);
  writeFileSync(copyOf(c), "// an older version's module\n");
  mkdirSync(`${copyOf(c)}.${process.pid}.tmp`); // the temp name is taken, so the refresh cannot write
  const res = turnOn(c);
  assert.equal(res.ok, false);
  assert.match(res.message, /모듈 사본을 쓰지 못했습니다/);
  assert.equal(readFileSync(copyOf(c), "utf8"), "// an older version's module\n");
});

test("a folder made for the copy is taken away again when the copy cannot be written", () => {
  const c = setup();
  const res = turnOn({ ...c, moduleSource: join(c.dir, "no-such-module.mjs") });
  assert.equal(res.ok, false);
  assert.match(res.message, /모듈 사본을 쓰지 못했습니다/);
  assert.equal(existsSync(dirname(copyOf(c))), false);
  assert.equal(readFileSync(c.hudFile, "utf8"), HUD);
});
