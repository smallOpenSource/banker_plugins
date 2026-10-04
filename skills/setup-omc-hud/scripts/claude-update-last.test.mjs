// Tests for claude-update-last.mjs. Run from the repo root: node --test skills/setup-omc-hud/scripts/*.test.mjs
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
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { status, turnOff, turnOn } from "./claude-update-last.mjs";
import * as payloadMon from "../../payload-mon/scripts/payload-mon.mjs";
import { CACHE_DIR } from "../../payload-mon/scripts/payload-size.mjs";

const CLI = fileURLToPath(new URL("./claude-update-last.mjs", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "claude-update-last-test-"));
after(() => rmSync(root, { recursive: true, force: true }));

// Links made without privileges and mode bits are POSIX matters; root ignores mode bits.
const posixOnly = { skip: process.platform === "win32" && "Windows has no POSIX mode bits or plain symlinks" };
const asRoot = process.platform !== "win32" && process.getuid?.() === 0;

// Runnable stand-ins for omc-hud-custom.mjs: the lines the block relies on, laid
// out as in the two real wrappers. Instead of running omc-hud.mjs they take the
// line it would have printed from the "omc" field of the statusline JSON.
//
// The older wrapper drops every segment it does not know, so OMC's Claude Code
// update notice never shows.
const HUD_OLD = String.raw`#!/usr/bin/env node
// Older omc_hud wrapper: runs omc-hud.mjs through spawnSync.
import { readFileSync } from "node:fs";

let input = "";
try {
  input = readFileSync(0, "utf8");
} catch {
  /* no stdin */
}
const raw = JSON.parse(input || "{}").omc || ""; // what omc-hud.mjs printed

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const A = (c, s) => "\x1b[" + c + "m" + s + "\x1b[0m";
const SEP = "|";
const colorRate = (seg) => "<" + seg + ">";
const colorCtx = (seg) => seg;

try {
  const lines = stripAnsi(raw).split("\n").filter((l) => l.trim());
  const mainIdx = lines.findIndex((l) => l.includes("OMC#"));
  const below = lines.slice(mainIdx + 1);
  const rawSegs = lines[mainIdx].split("|").map((s) => s.trim()).filter(Boolean);
  // The 5h/wk/sn windows arrive in one space-separated segment; expand them.
  const segs = [];
  for (const s of rawSegs) {
    if (/\b(5h|wk|sn):/.test(s) && /\s/.test(s)) {
      for (const p of s.split(/\s+/)) if (p) segs.push(p);
    } else {
      segs.push(s);
    }
  }
  const f = { label: "", ctx: "" };
  const extra = [];
  for (const s of segs) {
    if (/^\[?OMC#/.test(s)) f.label = s.replace(/^\[|\]$/g, "");
    else if (/^ctx:/.test(s)) f.ctx = s;
    else extra.push(s);
  }

  const colored = [];
  if (f.ctx) colored.push(colorCtx(f.ctx));
  colored.push("/work");
  if (f.label) colored.push(f.label);

  let result = colored.join(SEP);
  if (below.length) result += "\n" + below.join("\n");
  process.stdout.write(result + "\n");
} catch {
  process.stdout.write("raw\n");
}
`;

// The current omc_hud wrapper renders the HUD in-process and shows the segments
// it does not know, dimmed, before the path: the notice lands mid-line.
const HUD_CURRENT = String.raw`#!/usr/bin/env node
// Current omc_hud wrapper: imports omc-hud.mjs in-process.
import { readFileSync } from "node:fs";

async function readStdinBounded() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}
const input = await readStdinBounded();
const raw = JSON.parse(input || "{}").omc || ""; // what omc-hud.mjs printed, rendered in-process

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const A = (c, s) => "\x1b[" + c + "m" + s + "\x1b[0m";
const SEP = "|";
const colorRate = (seg) => "<" + seg + ">";
const colorCtx = (seg) => seg;

try {
  const lines = stripAnsi(raw).split("\n").filter((l) => l.trim());
  const mainIdx = lines.findIndex((l) => l.includes("OMC#"));
  const below = lines.slice(mainIdx + 1);
  const rawSegs = lines[mainIdx].split("|").map((s) => s.trim()).filter(Boolean);
  // The 5h/wk/sn windows arrive in one space-separated segment; expand them.
  const segs = [];
  for (const s of rawSegs) {
    if (/\b(5h|wk|sn):/.test(s) && /\s/.test(s)) {
      for (const p of s.split(/\s+/)) if (p) segs.push(p);
    } else {
      segs.push(s);
    }
  }
  const f = { label: "", ctx: "" };
  const extra = [];
  for (const s of segs) {
    if (/^\[?OMC#/.test(s)) f.label = s.replace(/^\[|\]$/g, "");
    else if (/^ctx:/.test(s)) f.ctx = s;
    else extra.push(s);
  }

  const colored = [];
  if (f.ctx) colored.push(colorCtx(f.ctx));
  for (const e of extra) colored.push(A("2", e));
  colored.push("/work");
  if (f.label) colored.push(f.label);

  let result = colored.join(SEP);
  if (below.length) result += "\n" + below.join("\n");
  process.stdout.write(result + "\n");
} catch {
  process.stdout.write("raw\n");
}
`;

// What OMC 5.6.1 prints when Claude Code 2.1.289 is out and 2.1.288 runs: the
// notice in bold, between the label and the rest.
const LINE = "[OMC#5.6.1] | \x1b[1m[Claude#2.1.288] -> 2.1.289 claude update\x1b[22m | ctx:21% | fable:0%";
const LINE_NO_NOTICE = "[OMC#5.6.1] | ctx:21% | fable:0%";

const LAYOUTS = [
  {
    name: "the older wrapper",
    hud: HUD_OLD,
    before: "ctx:21%|/work|OMC#5.6.1\n",
    after: "ctx:21%|/work|OMC#5.6.1|\x1b[2m[Claude#2.1.288] -> 2.1.289 claude update\x1b[0m\n",
    noNotice: "ctx:21%|/work|OMC#5.6.1\n",
  },
  {
    name: "the current omc_hud wrapper",
    hud: HUD_CURRENT,
    before: "ctx:21%|\x1b[2m[Claude#2.1.288] -> 2.1.289 claude update\x1b[0m|\x1b[2mfable:0%\x1b[0m|/work|OMC#5.6.1\n",
    after: "ctx:21%|\x1b[2mfable:0%\x1b[0m|/work|OMC#5.6.1|\x1b[2m[Claude#2.1.288] -> 2.1.289 claude update\x1b[0m\n",
    noNotice: "ctx:21%|\x1b[2mfable:0%\x1b[0m|/work|OMC#5.6.1\n",
  },
];

let seq = 0;
function setup(hudText = HUD_OLD) {
  const dir = join(root, `case-${++seq}`);
  mkdirSync(dir);
  const hudFile = join(dir, "omc-hud-custom.mjs");
  writeFileSync(hudFile, hudText);
  return { dir, hudFile };
}

// Renders the wrapper the way Claude Code does: statusline JSON on stdin.
const render = (c, line) =>
  spawnSync(process.execPath, [c.hudFile], { input: JSON.stringify({ omc: line }), encoding: "utf8" }).stdout;

const markers = (text) => text.split("// <<< claude-update-last <<<").length - 1;
const bakOf = (c) => `${c.hudFile}.claude-update-last.bak`;

for (const l of LAYOUTS) {
  test(`on puts the Claude Code update notice at the very end of ${l.name}`, () => {
    const c = setup(l.hud);
    assert.equal(render(c, LINE), l.before, "the stand-in renders as the real wrapper does");
    const res = turnOn(c);
    assert.equal(res.ok, true, res.message);
    assert.equal(markers(readFileSync(c.hudFile, "utf8")), 1);
    assert.equal(render(c, LINE), l.after);
  });

  test(`with no update notice, ${l.name} prints what it printed before`, () => {
    const c = setup(l.hud);
    assert.equal(turnOn(c).ok, true);
    assert.equal(render(c, LINE_NO_NOTICE), l.noNotice);
  });

  test(`off restores ${l.name} byte for byte`, () => {
    const c = setup(l.hud);
    turnOn(c);
    const res = turnOff(c);
    assert.equal(res.ok, true, res.message);
    assert.equal(readFileSync(c.hudFile, "utf8"), l.hud);
    assert.equal(render(c, LINE), l.before);
  });
}

test("a notice without the version tag goes last too", () => {
  const c = setup();
  turnOn(c);
  assert.equal(
    render(c, "[OMC#5.6.1] | [Claude] -> 2.1.289 claude update | ctx:21%"),
    "ctx:21%|/work|OMC#5.6.1|\x1b[2m[Claude] -> 2.1.289 claude update\x1b[0m\n",
  );
});

test("only the notice moves: a segment that merely mentions claude keeps its place", () => {
  const c = setup(HUD_CURRENT);
  turnOn(c);
  assert.equal(
    render(c, "[OMC#5.6.1] | [Claude#2.1.288] -> 2.1.289 claude update | ctx:21% | skill:claude-api"),
    "ctx:21%|\x1b[2mskill:claude-api\x1b[0m|/work|OMC#5.6.1|\x1b[2m[Claude#2.1.288] -> 2.1.289 claude update\x1b[0m\n",
  );
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
  assert.equal(readFileSync(c.hudFile, "utf8"), HUD_OLD);
});

test("keeps the text from before each change in <wrapper>.claude-update-last.bak", () => {
  const c = setup();
  turnOn(c);
  assert.equal(readFileSync(bakOf(c), "utf8"), HUD_OLD);
  const on = readFileSync(c.hudFile, "utf8");
  turnOff(c);
  assert.equal(readFileSync(bakOf(c), "utf8"), on);
});

test("lives alongside payload-mon's block: either one turns off without touching the other", () => {
  const c = setup(HUD_CURRENT);
  // payload-mon kept off the live config: its cache, settings and transcripts stay in the case folder.
  const pm = {
    hudFile: c.hudFile,
    cacheDir: join(c.dir, basename(CACHE_DIR)),
    settingsFile: join(c.dir, "settings.json"),
    projectsDir: join(c.dir, "projects"),
    sessionId: "",
  };
  const after = LAYOUTS[1].after;
  assert.equal(payloadMon.turnOn(pm).ok, true);
  assert.equal(turnOn(c).ok, true);
  assert.equal(render(c, LINE), after);
  assert.equal(payloadMon.turnOff(pm).ok, true);
  assert.equal(markers(readFileSync(c.hudFile, "utf8")), 1, "payload-mon off kept this block");
  assert.equal(render(c, LINE), after);
  assert.equal(payloadMon.turnOn(pm).ok, true, "payload-mon goes back on around this block");
  assert.equal(turnOff(c).ok, true);
  assert.equal(readFileSync(c.hudFile, "utf8").split("// <<< payload-mon <<<").length - 1, 1, "this off kept payload-mon's block");
  assert.equal(payloadMon.turnOff(pm).ok, true);
  assert.equal(readFileSync(c.hudFile, "utf8"), HUD_CURRENT);
});

test("lives alongside another tool's block sitting right before the same line", () => {
  const theirs = (src) =>
    src.replace("  let result = colored.join(SEP);", "  // >>> other-tool hud >>>\n  void 0;\n  // <<< other-tool hud <<<\n  let result = colored.join(SEP);");
  const OTHER = /^[ \t]*\/\/ >>> other-tool hud >>>[\s\S]*?\/\/ <<< other-tool hud <<<[ \t]*\r?\n/gm;
  const c = setup(theirs(HUD_OLD));
  assert.equal(turnOn(c).ok, true);
  const on = readFileSync(c.hudFile, "utf8");
  assert.equal(on.split("// <<< other-tool hud <<<").length - 1, 1);
  writeFileSync(c.hudFile, on.replace(OTHER, "")); // what that tool's unpatch does
  assert.equal(markers(readFileSync(c.hudFile, "utf8")), 1);
  assert.equal(render(c, LINE), LAYOUTS[0].after);
  assert.match(status(c).message, /claude-update-last: 켜짐 \(/);
  writeFileSync(c.hudFile, on);
  assert.equal(turnOff(c).ok, true);
  assert.equal(readFileSync(c.hudFile, "utf8"), theirs(HUD_OLD));
});

test("a CRLF wrapper goes on and comes off byte for byte", () => {
  const crlf = HUD_OLD.replace(/\n/g, "\r\n");
  const c = setup(crlf);
  assert.equal(turnOn(c).ok, true);
  assert.doesNotMatch(readFileSync(c.hudFile, "utf8"), /[^\r]\n/, "the block keeps the wrapper's line endings");
  assert.equal(render(c, LINE), LAYOUTS[0].after);
  assert.equal(turnOff(c).ok, true);
  assert.equal(readFileSync(c.hudFile, "utf8"), crlf);
});

test("markers that do not pair up are refused by on and off, which leave the wrapper alone", () => {
  const stray = HUD_OLD + "// >>> claude-update-last >>>\n";
  const c = setup(stray);
  for (const res of [turnOn(c), turnOff(c)]) {
    assert.equal(res.ok, false);
    assert.match(res.message, /짝이 맞지 않습니다/);
  }
  assert.equal(readFileSync(c.hudFile, "utf8"), stray);
  const state = status(c).message;
  assert.match(state, /짝이 맞지 않습니다/);
  assert.doesNotMatch(state, /on 으로 복구/);
});

const refusals = [
  ["a file that is not the OMC custom HUD", 'console.log("my own statusline");\n', /OMC 커스텀 HUD/],
  ["a wrapper without the line that joins the segments", HUD_OLD.replace("  let result = colored.join(SEP);\n", "  let result = colored.join(\" | \");\n"), /삽입 위치를 찾지 못했습니다/],
  ["a wrapper that joins the segments in two places", HUD_OLD.replace("} catch {\n  process.stdout.write(\"raw", "  if (false) {\n  let result = colored.join(SEP);\n  }\n} catch {\n  process.stdout.write(\"raw"), /두 곳 이상/],
  ["a wrapper without the names the block reads", HUD_OLD.replace(/\bsegs\b/g, "parts"), /블록이 쓰는 이름/],
  ["a wrapper that would not parse", HUD_OLD + "const broken = ;\n", /node --check/],
];
for (const [what, text, why] of refusals) {
  test(`on refuses ${what} and leaves it untouched`, () => {
    const c = setup(text);
    const res = turnOn(c);
    assert.equal(res.ok, false);
    assert.match(res.message, why);
    assert.equal(readFileSync(c.hudFile, "utf8"), text);
    assert.equal(existsSync(bakOf(c)), false);
  });
}

test("on and off say so when the wrapper is missing", () => {
  const c = setup();
  rmSync(c.hudFile);
  const on = turnOn(c);
  assert.equal(on.ok, false);
  assert.match(on.message, /래퍼가 없습니다/);
  const off = turnOff(c);
  assert.equal(off.ok, true);
  assert.match(off.message, /끌 것이 없습니다/);
  assert.match(status(c).message, /HUD 래퍼 없음/);
});

test("status tells off, on and a block out of place apart, and on puts the block back", () => {
  const c = setup();
  assert.match(status(c).message, /claude-update-last: 꺼짐 \(/);
  turnOn(c);
  assert.match(status(c).message, /claude-update-last: 켜짐 \(/);
  const on = readFileSync(c.hudFile, "utf8");
  const block = on.match(/^[ \t]*\/\/ >>> claude-update-last >>>[\s\S]*?\/\/ <<< claude-update-last <<<[ \t]*\n/m)[0];
  writeFileSync(c.hudFile, on.replace(block, "") + block); // the block moved to the end of the file
  assert.match(status(c).message, /불완전하거나 오래됨 \(on 으로 복구\)/);
  assert.equal(turnOn(c).ok, true);
  assert.equal(readFileSync(c.hudFile, "utf8"), on);
  assert.equal(render(c, LINE), LAYOUTS[0].after);
});

test("a notice whose spaces OMC turned into no-break spaces (safeMode off) goes last too", () => {
  const c = setup();
  turnOn(c);
  assert.equal(
    render(c, "[OMC#5.6.1] | [Claude#2.1.288]\u00a0->\u00a02.1.289\u00a0claude\u00a0update | ctx:21%"),
    "ctx:21%|/work|OMC#5.6.1|\x1b[2m[Claude#2.1.288]\u00a0->\u00a02.1.289\u00a0claude\u00a0update\x1b[0m\n",
  );
});

// What OMC prints in full: the path above the main line, the model and the rate
// windows on it, and its own update hint on a line below.
const LINE_FULL =
  "/work\n" +
  "[OMC#5.6.1L] | Model: Opus 4.8 | \x1b[1m[Claude#2.1.288] -> 2.1.289 claude update\x1b[22m | 5h:6%(0h33m) wk:81%(3h3m) fable:0%(3h3m) | session:0m | ctx:0%\n" +
  "\x1b[33m[!] claude 2.1.289 - paste: ! claude update\x1b[0m";
const FULL_AFTER = [
  "ctx:0%|/work|OMC#5.6.1L|\x1b[2m[Claude#2.1.288] -> 2.1.289 claude update\x1b[0m\n[!] claude 2.1.289 - paste: ! claude update\n",
  "ctx:0%|\x1b[2mModel: Opus 4.8\x1b[0m|\x1b[2m5h:6%(0h33m)\x1b[0m|\x1b[2mwk:81%(3h3m)\x1b[0m|\x1b[2mfable:0%(3h3m)\x1b[0m|\x1b[2msession:0m\x1b[0m|/work|OMC#5.6.1L|\x1b[2m[Claude#2.1.288] -> 2.1.289 claude update\x1b[0m\n[!] claude 2.1.289 - paste: ! claude update\n",
];
LAYOUTS.forEach((l, i) => {
  test(`with OMC's full output, ${l.name} ends line 1 with the notice and keeps the line below`, () => {
    const c = setup(l.hud);
    turnOn(c);
    assert.equal(render(c, LINE_FULL), FULL_AFTER[i]);
  });

  test(`an error inside the block leaves ${l.name}'s line as it was`, () => {
    // `segs` exists only inside a function, so the block's lookup throws at the joining line.
    const broken = l.hud.replace(/\bsegs\b/g, "parts") + "function unused() {\n  const segs = [];\n  return segs;\n}\n";
    const c = setup(broken);
    assert.equal(render(c, LINE), l.before);
    assert.equal(turnOn(c).ok, true);
    assert.equal(render(c, LINE), l.before);
  });
});

test("a failure while moving the notice keeps it where the wrapper put it", () => {
  // The current wrapper dims the notice itself; this A then fails the block's second dimming.
  const failing = HUD_CURRENT.replace(
    'const A = (c, s) => "\\x1b[" + c + "m" + s + "\\x1b[0m";',
    'let dimmed = 0;\nconst A = (c, s) => {\n  if (String(s).includes("claude update") && ++dimmed > 1) throw new Error("second dim");\n  return "\\x1b[" + c + "m" + s + "\\x1b[0m";\n};',
  );
  assert.notEqual(failing, HUD_CURRENT, "the stand-in's A was replaced");
  const c = setup(failing);
  assert.equal(turnOn(c).ok, true);
  assert.equal(render(c, LINE), LAYOUTS[1].before);
});

test("markers out of order are refused by on and off, which leave the wrapper alone", () => {
  const stray = HUD_OLD.replace("import { readFileSync }", "// <<< claude-update-last <<<\nimport { readFileSync }").replace(
    "  const colored = [];",
    "  // >>> claude-update-last >>>\n  const colored = [];",
  );
  const c = setup(stray);
  for (const res of [turnOn(c), turnOff(c)]) {
    assert.equal(res.ok, false);
    assert.match(res.message, /짝이 맞지 않습니다/);
  }
  assert.equal(readFileSync(c.hudFile, "utf8"), stray);
  const state = status(c).message;
  assert.match(state, /짝이 맞지 않습니다/);
  assert.doesNotMatch(state, /on 으로 복구/);
});

test("a stray opening marker above a complete block is refused, and no wrapper code is cut", () => {
  const c = setup();
  turnOn(c);
  const stray = readFileSync(c.hudFile, "utf8").replace("  const colored = [];", "  // >>> claude-update-last >>>\n  const colored = [];");
  writeFileSync(c.hudFile, stray);
  for (const res of [turnOn(c), turnOff(c)]) {
    assert.equal(res.ok, false);
    assert.match(res.message, /짝이 맞지 않습니다/);
  }
  assert.equal(readFileSync(c.hudFile, "utf8"), stray);
  assert.match(status(c).message, /짝이 맞지 않습니다/);
});

test("a lone closing marker is refused by on and off", () => {
  const stray = HUD_OLD + "// <<< claude-update-last <<<\n";
  const c = setup(stray);
  for (const res of [turnOn(c), turnOff(c)]) {
    assert.equal(res.ok, false);
    assert.match(res.message, /짝이 맞지 않습니다/);
  }
  assert.equal(readFileSync(c.hudFile, "utf8"), stray);
});

test("off takes out a block left at the very end of a file with no final newline", () => {
  const c = setup();
  turnOn(c);
  const on = readFileSync(c.hudFile, "utf8");
  const block = on.match(/^[ \t]*\/\/ >>> claude-update-last >>>[\s\S]*?\/\/ <<< claude-update-last <<<[ \t]*\n/m)[0];
  writeFileSync(c.hudFile, on.replace(block, "") + block.replace(/\n$/, ""));
  const res = turnOff(c);
  assert.equal(res.ok, true, res.message);
  assert.equal(readFileSync(c.hudFile, "utf8"), HUD_OLD);
});

// The CLI as Claude runs it, kept off the real config folder.
const cliEnv = (c, extra = {}) => ({
  ...process.env,
  CLAUDE_UPDATE_LAST_HUD_FILE: c.hudFile,
  CLAUDE_CONFIG_DIR: join(c.dir, "config"),
  HOME: c.dir,
  USERPROFILE: c.dir,
  ...extra,
});
const cli = (c, script, ...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: cliEnv(c) });

test("the command line takes on/off/status, defaults to status and rejects anything else", () => {
  const c = setup();
  const run = (...args) => cli(c, CLI, ...args);
  assert.equal(run("on").status, 0);
  assert.match(run().stdout, /claude-update-last: 켜짐 \(/);
  assert.match(run("STATUS").stdout, /claude-update-last: 켜짐 \(/);
  for (const bad of ["toggle", "constructor"]) {
    const res = run(bad);
    assert.equal(res.status, 1, bad);
    assert.match(res.stdout, /사용법/);
  }
  assert.equal(run("off").status, 0);
  assert.equal(readFileSync(c.hudFile, "utf8"), HUD_OLD);
});

test("a refusal exits 1", () => {
  const c = setup('console.log("my own statusline");\n');
  const res = cli(c, CLI, "on");
  assert.equal(res.status, 1, res.stdout);
  assert.match(res.stdout, /OMC 커스텀 HUD/);
});

test("without an explicit wrapper path the command follows CLAUDE_CONFIG_DIR", () => {
  const c = setup();
  const hudFile = join(c.dir, "config", "hud", "omc-hud-custom.mjs");
  mkdirSync(dirname(hudFile), { recursive: true });
  writeFileSync(hudFile, HUD_OLD);
  const env = cliEnv(c, { CLAUDE_UPDATE_LAST_HUD_FILE: "" });
  const on = spawnSync(process.execPath, [CLI, "on"], { encoding: "utf8", env });
  assert.equal(on.status, 0, on.stdout);
  assert.equal(markers(readFileSync(hudFile, "utf8")), 1);
  assert.equal(readFileSync(c.hudFile, "utf8"), HUD_OLD, "the wrapper outside CLAUDE_CONFIG_DIR is untouched");
});

test("the command runs when reached through a symlinked folder", () => {
  const c = setup();
  const linked = join(c.dir, "linked-scripts");
  // A junction is the folder link Windows lets any account make; elsewhere the type is ignored.
  symlinkSync(dirname(CLI), linked, "junction");
  const res = cli(c, join(linked, "claude-update-last.mjs"), "status");
  assert.equal(res.status, 0);
  assert.match(res.stdout, /claude-update-last: 꺼짐/);
});

test("a wrapper this account cannot write is refused up front, with nothing changed", { skip: asRoot && "root writes read-only files" }, () => {
  const c = setup();
  chmodSync(c.hudFile, 0o444);
  try {
    const res = cli(c, CLI, "on");
    assert.equal(res.status, 1, res.stdout);
    assert.match(res.stdout, /래퍼에 쓸 권한이 없습니다/);
    assert.equal(existsSync(bakOf(c)), false);
  } finally {
    chmodSync(c.hudFile, 0o644);
  }
  assert.equal(readFileSync(c.hudFile, "utf8"), HUD_OLD);
});

test("an unexpected failure partway exits 2, points at status and keeps the wrapper", () => {
  const c = setup();
  mkdirSync(bakOf(c)); // the backup cannot be written over a folder
  const res = cli(c, CLI, "on");
  assert.equal(res.status, 2, res.stdout);
  assert.match(res.stdout, /예기치 못한 오류.*\n.*status/);
  assert.equal(readFileSync(c.hudFile, "utf8"), HUD_OLD);
  assert.deepEqual(readdirSync(c.dir).filter((name) => name.endsWith(".tmp")), [], "the failed write's temp file is gone");
});

test("the backup is written fresh, never through a link planted at its name", posixOnly, () => {
  const c = setup();
  const victim = join(c.dir, "victim.txt");
  writeFileSync(victim, "keep me");
  symlinkSync(victim, bakOf(c));
  assert.equal(turnOn(c).ok, true);
  assert.equal(readFileSync(victim, "utf8"), "keep me");
  assert.ok(lstatSync(bakOf(c)).isFile());
  assert.equal(readFileSync(bakOf(c), "utf8"), HUD_OLD);
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
});
