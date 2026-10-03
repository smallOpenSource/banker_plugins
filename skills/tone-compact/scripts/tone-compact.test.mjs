// Tests for tone-compact.mjs. Run from the repo root: node --test skills/tone-compact/scripts/*.test.mjs
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
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { parseArgs, rulesOf, status, turnOff, turnOn } from "./tone-compact.mjs";

const CLI = fileURLToPath(new URL("./tone-compact.mjs", import.meta.url));
const SKILL = fileURLToPath(new URL("../SKILL.md", import.meta.url));
const RULES = rulesOf(readFileSync(SKILL, "utf8"));
const root = mkdtempSync(join(tmpdir(), "tone-compact-test-"));
after(() => rmSync(root, { recursive: true, force: true }));

const OPEN = "<!-- banker:tone-compact:start -->";
const KEEP_OPEN = "<!-- USER:OMX:POLICY:START -->";
const KEEP_CLOSE = "<!-- USER:OMX:POLICY:END -->";

// Links made without privileges and mode bits are POSIX matters; root ignores mode bits.
const posixOnly = { skip: process.platform === "win32" && "Windows has no POSIX mode bits or plain symlinks" };
const asRoot = typeof process.getuid === "function" && process.getuid() === 0;
const permTest = { skip: process.platform === "win32" ? "Windows has no POSIX mode bits" : asRoot && "root ignores mode bits" };

let cases = 0;
// A Claude Code and a Codex config folder for one test; either can be left out.
function setup({ claude = true, codex = true } = {}) {
  const dir = join(root, `case-${cases++}`);
  mkdirSync(dir);
  const o = { claudeDir: join(dir, "claude"), codexDir: join(dir, "codex"), skillFile: SKILL };
  if (claude) mkdirSync(o.claudeDir);
  if (codex) mkdirSync(o.codexDir);
  return {
    dir,
    o,
    rulesFile: join(o.claudeDir, "rules", "banker-tone-compact.md"),
    agents: join(o.codexDir, "AGENTS.md"),
    override: join(o.codexDir, "AGENTS.override.md"),
  };
}

const read = (file) => readFileSync(file, "utf8");
const blocks = (text) => text.split(OPEN).length - 1;

// The command line, in a child process that does not look like Claude Code
// unless the test says so.
function cli(args, env = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, CLAUDECODE: "", ...env } });
  return { code: r.status, out: r.stdout };
}
const cliEnv = (s) => ({ CLAUDE_CONFIG_DIR: s.o.claudeDir, CODEX_HOME: s.o.codexDir });

// What `omx setup` does to a generated AGENTS.md (oh-my-codex dist/utils/agents-md.js,
// preserveUserOmxPolicyBlocks): the new managed text, then each USER:OMX:POLICY
// block of the old file that the new text does not already hold.
function omxRewrite(oldText, managed) {
  const kept = [];
  for (let from = 0; ; ) {
    const s = oldText.indexOf(KEEP_OPEN, from);
    if (s === -1) break;
    const e = oldText.indexOf(KEEP_CLOSE, s);
    if (e === -1) break;
    kept.push(oldText.slice(s, e + KEEP_CLOSE.length));
    from = e + KEEP_CLOSE.length;
  }
  const missing = kept.filter((b) => !managed.includes(b));
  if (missing.length === 0) return managed;
  return `${managed.trimEnd()}\n\n${missing.join("\n\n")}\n`;
}

test("the rules come from SKILL.md, once, with no management markers inside", () => {
  for (const phrase of ["ASD-STE100", "개조식", "하이픈", "원어의 한글 발음 표기", "뜻을 뒤집는 말", "우선순위"]) assert.ok(RULES.includes(phrase), phrase);
  assert.ok(!RULES.startsWith("\n") && !RULES.endsWith("\n"));
  const wrap = (body) => `a\n<!-- tone-compact:rules:start -->\n${body}\n<!-- tone-compact:rules:end -->\nb\n`;
  assert.equal(rulesOf(wrap("rule one\nrule two").replace(/\n/g, "\r\n")), "rule one\nrule two");
  assert.throws(() => rulesOf("no markers at all"), /찾지 못했습니다/);
  assert.throws(() => rulesOf(wrap("x") + wrap("y")), /찾지 못했습니다/);
  assert.throws(() => rulesOf(wrap("\n\n")), /비었거나/);
  assert.throws(() => rulesOf(wrap(`x\n${OPEN}`)), /관리 표시/);
});

test("SKILL.md keeps its own rules outside code: no decorative symbols, emoji or exclamation marks", () => {
  const text = read(SKILL);
  assert.match(text, /^---\nname: tone-compact\n/);
  const prose = text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`\n]*`/g, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  assert.doesNotMatch(prose, /[→⇒←↔·…※★☆✓✔✗✘●○■□▶◆—–]/u);
  assert.doesNotMatch(prose, /\p{Extended_Pictographic}/u);
  assert.ok(!prose.includes("!"), "no exclamation marks in prose");
});

test("the rules list three or more items vertically, never inline: at most one comma per line or table cell", () => {
  const prose = RULES.replace(/`[^`\n]*`/g, "");
  for (const line of prose.split("\n")) {
    const cells = line.trim().startsWith("|") ? line.split("|") : [line];
    for (const cell of cells) assert.ok(cell.split(",").length <= 2, `inline enumeration: ${line.trim()}`);
  }
});

test("Claude Code: on writes the rules file and a second on changes nothing", () => {
  const s = setup();
  const r = turnOn("claude", s.o);
  assert.ok(r.ok, r.message);
  const text = read(s.rulesFile);
  assert.ok(text.startsWith("<!-- banker tone-compact"));
  assert.ok(text.endsWith(`\n${RULES}\n`));
  assert.match(status(s.o).message, /Claude Code: 켜짐 \(/);
  const again = turnOn("claude", s.o);
  assert.ok(again.ok && /변경 없음/.test(again.message));
  assert.equal(read(s.rulesFile), text);
});

test("Claude Code: off deletes banker's file and leaves anyone else's alone", () => {
  const s = setup();
  turnOn("claude", s.o);
  assert.ok(turnOff("claude", s.o).ok);
  assert.ok(!existsSync(s.rulesFile));
  assert.match(turnOff("claude", s.o).message, /이미 꺼져 있습니다/);

  writeFileSync(s.rulesFile, "# my own rules\n");
  for (const r of [turnOn("claude", s.o), turnOff("claude", s.o)]) {
    assert.equal(r.ok, false);
    assert.match(r.message, /다른 파일/);
  }
  assert.equal(read(s.rulesFile), "# my own rules\n");
  assert.match(status(s.o).message, /Claude Code: 꺼짐, 같은 이름의 다른 파일/);
});

test("Claude Code: on replaces the rules of an earlier version", () => {
  const s = setup();
  mkdirSync(join(s.o.claudeDir, "rules"));
  writeFileSync(s.rulesFile, "<!-- banker tone-compact: older header -->\nold rules\n");
  assert.match(status(s.o).message, /Claude Code: 켜짐, 단 규칙이 이 버전과 다름/);
  const r = turnOn("claude", s.o);
  assert.ok(r.ok && /이 버전으로 바꿨습니다/.test(r.message), r.message);
  assert.ok(read(s.rulesFile).endsWith(`\n${RULES}\n`));
});

test("Claude Code: on refuses when there is no config folder", () => {
  const s = setup({ claude: false });
  const r = turnOn("claude", s.o);
  assert.equal(r.ok, false);
  assert.match(r.message, /설정 폴더가 없습니다/);
  assert.ok(!existsSync(s.o.claudeDir));
  assert.match(status(s.o).message, /Claude Code: 설정 폴더 없음/);
});

test("Codex: on adds one block and off gives back the bytes, whatever the file looked like", () => {
  const shapes = {
    "ends with a line break": "# my agents\nkeep me\n",
    "no final line break": "# my agents\nkeep me",
    "CRLF line breaks": "# my agents\r\nkeep me\r\n",
    "trailing blank line": "# my agents\n\n",
  };
  for (const [name, original] of Object.entries(shapes)) {
    const s = setup();
    writeFileSync(s.agents, original);
    assert.ok(turnOn("codex", s.o).ok, name);
    const on = read(s.agents);
    assert.equal(blocks(on), 1, name);
    assert.ok(on.startsWith(original), name);
    if (original.includes("\r\n")) assert.ok(!on.replace(/\r\n/g, "").includes("\n"), `${name}: block keeps CRLF`);
    assert.match(status(s.o).message, /Codex: 켜짐 \(/, name);
    assert.ok(turnOff("codex", s.o).ok, name);
    assert.equal(read(s.agents), original, name);
  }
});

test("Codex: on creates AGENTS.md when there is none, and off removes it again", () => {
  for (const original of [null, ""]) {
    const s = setup();
    if (original !== null) writeFileSync(s.agents, original);
    assert.ok(turnOn("codex", s.o).ok);
    assert.ok(read(s.agents).startsWith(KEEP_OPEN), "an empty file gets the block alone");
    assert.ok(turnOff("codex", s.o).ok);
    assert.ok(!existsSync(s.agents), "a file left empty is removed");
  }
});

test("Codex: a second on changes nothing", () => {
  const s = setup();
  writeFileSync(s.agents, "# a\n");
  turnOn("codex", s.o);
  const once = read(s.agents);
  const r = turnOn("codex", s.o);
  assert.ok(r.ok && /변경 없음/.test(r.message));
  assert.equal(read(s.agents), once);
  assert.equal(read(`${s.agents}.tone-compact.bak`), "# a\n", ".bak still holds the text from before on");
});

test("Codex: what other tools keep in the same file is left alone", () => {
  const s = setup();
  const original = [
    "<!-- omx:generated:agents-md -->",
    "# oh-my-codex - Intelligent Multi-Agent Orchestration",
    "<!-- OMX:GUIDANCE:OPERATING:START -->",
    "guidance",
    "<!-- OMX:GUIDANCE:OPERATING:END -->",
    KEEP_OPEN,
    "my own policy",
    KEEP_CLOSE,
    "<!-- wiki-pending-queue:start -->",
    "queue convention",
    "<!-- wiki-pending-queue:end -->",
    "",
  ].join("\n");
  writeFileSync(s.agents, original);
  turnOn("codex", s.o);
  const on = read(s.agents);
  assert.ok(on.startsWith(original));
  assert.equal(on.split(KEEP_OPEN).length - 1, 2, "the user's policy block plus ours");
  turnOff("codex", s.o);
  assert.equal(read(s.agents), original);
});

test("Codex: the block survives an omx setup --merge-agents rewrite, and off still takes it out cleanly", () => {
  const s = setup();
  const managed = "<!-- omx:generated:agents-md -->\n# oh-my-codex - Intelligent Multi-Agent Orchestration\nnew guidance\n";
  writeFileSync(s.agents, `<!-- omx:generated:agents-md -->\nold guidance\n${KEEP_OPEN}\nmy own policy\n${KEEP_CLOSE}\n`);
  turnOn("codex", s.o);
  writeFileSync(s.agents, omxRewrite(read(s.agents), managed));
  assert.equal(blocks(read(s.agents)), 1, "omx setup kept the block");
  assert.match(status(s.o).message, /Codex: 켜짐 \(/);
  turnOff("codex", s.o);
  assert.equal(read(s.agents), `${managed}\n${KEEP_OPEN}\nmy own policy\n${KEEP_CLOSE}\n`);
});

test("Codex: the block goes to AGENTS.override.md when it has content, to AGENTS.md otherwise", () => {
  const withOverride = setup();
  writeFileSync(withOverride.agents, "# base\n");
  writeFileSync(withOverride.override, "# override\n");
  turnOn("codex", withOverride.o);
  assert.equal(read(withOverride.agents), "# base\n");
  assert.equal(blocks(read(withOverride.override)), 1);
  assert.ok(status(withOverride.o).message.includes(`Codex: 켜짐 (${withOverride.override})`));

  const blank = setup();
  writeFileSync(blank.agents, "# base\n");
  writeFileSync(blank.override, "  \n");
  turnOn("codex", blank.o);
  assert.equal(blocks(read(blank.agents)), 1);
  assert.equal(read(blank.override), "  \n");
});

test("Codex: on moves the block when an override appears, and off cleans both files", () => {
  const s = setup();
  writeFileSync(s.agents, "# base\n");
  turnOn("codex", s.o);
  writeFileSync(s.override, "# new override\n");
  assert.match(status(s.o).message, /Codex: 꺼짐, 단 블록이 Codex 가 읽지 않는 AGENTS.md 에 있음/);
  const r = turnOn("codex", s.o);
  assert.ok(r.ok && /옮겼습니다/.test(r.message), r.message);
  assert.equal(read(s.agents), "# base\n");
  assert.equal(blocks(read(s.override)), 1);
  turnOff("codex", s.o);
  assert.equal(read(s.override), "# new override\n");
});

test("Codex: on replaces the rules of an earlier version", () => {
  const s = setup();
  const old = [KEEP_OPEN, OPEN, "old rules", "<!-- banker:tone-compact:end -->", KEEP_CLOSE, ""].join("\n");
  writeFileSync(s.agents, `# base\n\n${old}`);
  assert.match(status(s.o).message, /Codex: 켜짐, 단 규칙이 이 버전과 다름/);
  assert.ok(turnOn("codex", s.o).ok);
  const text = read(s.agents);
  assert.equal(blocks(text), 1);
  assert.ok(text.includes(RULES.split("\n")[0]) && !text.includes("old rules"));
  turnOff("codex", s.o);
  assert.equal(read(s.agents), "# base\n");
});

test("Codex: markers that do not pair up are refused by on and off", () => {
  const s = setup();
  const broken = `# base\n${OPEN}\nhalf a block\n`;
  writeFileSync(s.agents, broken);
  for (const r of [turnOn("codex", s.o), turnOff("codex", s.o)]) {
    assert.equal(r.ok, false);
    assert.match(r.message, /짝이 맞지 않아/);
  }
  assert.equal(read(s.agents), broken);
  assert.match(status(s.o).message, /Codex: 표시의 짝이 맞지 않음/);
});

test("Codex: without a Codex folder on refuses, off and status say so", () => {
  const s = setup({ codex: false });
  assert.equal(turnOn("codex", s.o).ok, false);
  assert.match(turnOff("codex", s.o).message, /끌 것이 없습니다/);
  assert.match(status(s.o).message, /Codex: 설정 폴더 없음/);
  assert.ok(!existsSync(s.o.codexDir));
});

test("off and status work when SKILL.md cannot be read", () => {
  const s = setup();
  writeFileSync(s.agents, "# base\n");
  turnOn("claude", s.o);
  turnOn("codex", s.o);
  const broken = { ...s.o, skillFile: join(s.dir, "missing-SKILL.md") };
  assert.match(status(broken).message, /규칙 원문을 읽지 못해/);
  assert.match(status(broken).message, /Claude Code: 켜짐 \(규칙 버전 확인 불가\)/);
  assert.ok(turnOff("claude", broken).ok);
  assert.ok(turnOff("codex", broken).ok);
  assert.ok(!existsSync(s.rulesFile));
  assert.equal(read(s.agents), "# base\n");
});

test("the .bak keeps the text from before each change, readable by this account only", posixOnly, () => {
  for (const mode of [0o600, 0o644]) {
    const s = setup();
    writeFileSync(s.agents, "# private\n");
    chmodSync(s.agents, mode);
    turnOn("codex", s.o);
    const bak = `${s.agents}.tone-compact.bak`;
    assert.equal(read(bak), "# private\n");
    assert.equal(statSync(bak).mode & 0o777, 0o600, `bak of a ${mode.toString(8)} file`);
    assert.equal(statSync(s.agents).mode & 0o777, mode, "AGENTS.md keeps its mode");
  }
});

test("files and folders on creates are not group or world writable, even under umask 002", posixOnly, () => {
  const s = setup();
  const sh = (args) =>
    spawnSync("sh", ["-c", `umask 002 && "${process.execPath}" "${CLI}" ${args}`], {
      encoding: "utf8",
      env: { ...process.env, CLAUDECODE: "", ...cliEnv(s) },
    });
  assert.equal(sh("on --runtime claude").status, 0);
  assert.equal(sh("on --runtime codex").status, 0);
  for (const path of [join(s.o.claudeDir, "rules"), s.rulesFile, s.agents]) {
    assert.equal(statSync(path).mode & 0o022, 0, path);
  }
});

test("a marker quoted inside a sentence makes on and off refuse instead of cutting the user's text", () => {
  const block = [KEEP_OPEN, OPEN, "rules", "<!-- banker:tone-compact:end -->", KEEP_CLOSE, ""].join("\n");
  const shapes = {
    "end marker quoted before a real block": `# Safety\nThe block ends at <!-- banker:tone-compact:end -->.\nNEVER force-push.\n\n${block}`,
    "both markers explained on separate lines": `Start line: <!-- banker:tone-compact:start -->\nNEVER force-push.\nEnd line: <!-- banker:tone-compact:end -->\n`,
    "a whole-line end before any start": `<!-- banker:tone-compact:end -->\nNEVER force-push.\n${OPEN}\n`,
  };
  for (const [name, text] of Object.entries(shapes)) {
    const s = setup();
    writeFileSync(s.agents, text);
    for (const r of [turnOn("codex", s.o), turnOff("codex", s.o)]) {
      assert.equal(r.ok, false, name);
      assert.match(r.message, /짝이 맞지 않아/, name);
    }
    assert.equal(read(s.agents), text, `${name}: file untouched`);
    assert.match(status(s.o).message, /Codex: 표시의 짝이 맞지 않음/, name);
  }
});

test("off on a symlinked AGENTS.md that held only the block keeps the link and empties the target", posixOnly, () => {
  const s = setup();
  const real = join(s.dir, "dotfiles-AGENTS.md");
  writeFileSync(real, "");
  symlinkSync(real, s.agents);
  turnOn("codex", s.o);
  assert.equal(blocks(read(real)), 1);
  turnOff("codex", s.o);
  assert.ok(lstatSync(s.agents).isSymbolicLink(), "the link is still there");
  assert.equal(read(real), "", "the target no longer holds the block");
});

test("a symlinked AGENTS.md stays a link and its target gets the block", posixOnly, () => {
  const s = setup();
  const real = join(s.dir, "dotfiles-AGENTS.md");
  writeFileSync(real, "# linked\n");
  symlinkSync(real, s.agents);
  turnOn("codex", s.o);
  assert.ok(lstatSync(s.agents).isSymbolicLink());
  assert.equal(blocks(read(real)), 1);
  turnOff("codex", s.o);
  assert.ok(lstatSync(s.agents).isSymbolicLink());
  assert.equal(read(real), "# linked\n");
});

test("an AGENTS.md this account cannot write is left alone", permTest, () => {
  const s = setup();
  writeFileSync(s.agents, "# read only\n");
  chmodSync(s.agents, 0o444);
  const r = turnOn("codex", s.o);
  assert.equal(r.ok, false);
  assert.match(r.message, /쓸 권한이 없어/);
  assert.equal(read(s.agents), "# read only\n");
});

test("an unreadable AGENTS.md: status reports it, on and off stop with exit 2", permTest, () => {
  const s = setup();
  writeFileSync(s.agents, "# secret\n");
  chmodSync(s.agents, 0o000);
  try {
    const st = cli(["status"], cliEnv(s));
    assert.equal(st.code, 0);
    assert.match(st.out, /Codex: 읽을 수 없음 \(EACCES\)/);
    for (const command of ["on", "off"]) {
      const r = cli([command, "--runtime", "codex"], cliEnv(s));
      assert.equal(r.code, 2, command);
      assert.match(r.out, /status 로 상태를 확인하세요/);
    }
  } finally {
    chmodSync(s.agents, 0o644);
  }
  assert.equal(read(s.agents), "# secret\n");
});

test("command line: status by default, usage for anything else", () => {
  const s = setup();
  const st = cli([], cliEnv(s));
  assert.equal(st.code, 0);
  assert.match(st.out, /^tone-compact 상태\n- Claude Code: 꺼짐/);
  for (const args of [["bogus"], ["on", "extra"], ["status", "now"]]) {
    const r = cli(args, cliEnv(s));
    assert.equal(r.code, 1, args.join(" "));
    assert.match(r.out, /사용법/);
  }
  assert.deepEqual(parseArgs(["ON", "--runtime=Codex"]), { command: "on", runtime: "codex", extra: [] });
});

test("command line: on and off need a runtime unless Claude Code runs them", () => {
  const s = setup();
  const missing = cli(["on"], cliEnv(s));
  assert.equal(missing.code, 1);
  assert.match(missing.out, /런타임을 정할 수 없습니다/);
  for (const args of [["on", "--runtime", "toString"], ["on", "--runtime"], ["--runtime", "off"], ["status", "--runtime", "bogus"]]) {
    const r = cli(args, cliEnv(s));
    assert.equal(r.code, 1, args.join(" "));
    assert.match(r.out, /사용법/, args.join(" "));
  }
  const claude = cli(["on"], { ...cliEnv(s), CLAUDECODE: "1" });
  assert.equal(claude.code, 0, claude.out);
  assert.ok(existsSync(s.rulesFile), "CLAUDE_CONFIG_DIR decides where the rules file goes");
});

test("command line: --runtime=codex follows CODEX_HOME, and off gives the file back", () => {
  const s = setup();
  writeFileSync(s.agents, "# base\n");
  assert.equal(cli(["on", "--runtime=codex"], cliEnv(s)).code, 0);
  assert.equal(blocks(read(s.agents)), 1);
  assert.equal(cli(["off", "--runtime", "codex"], cliEnv(s)).code, 0);
  assert.equal(read(s.agents), "# base\n");
});

test("command line: an unexpected error exits 2 and leaves no temp file", () => {
  const s = setup();
  mkdirSync(s.rulesFile, { recursive: true }); // a folder where the rules file should be
  const r = cli(["on", "--runtime", "claude"], cliEnv(s));
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /예기치 못한 오류로 중단했습니다/);
  assert.deepEqual(readdirSync(join(s.o.claudeDir, "rules")), ["banker-tone-compact.md"]);
});

test("off keeps the lines on either side apart when text follows the block", () => {
  const noFinalBreak = setup();
  writeFileSync(noFinalBreak.agents, "# notes\nlast line");
  turnOn("codex", noFinalBreak.o);
  writeFileSync(noFinalBreak.agents, `${read(noFinalBreak.agents)}added later\n`);
  turnOff("codex", noFinalBreak.o);
  assert.equal(read(noFinalBreak.agents), "# notes\nlast line\nadded later\n");

  const insideWrapper = setup();
  writeFileSync(insideWrapper.agents, "# base\n");
  turnOn("codex", insideWrapper.o);
  const withLine = read(insideWrapper.agents).replace(`<!-- banker:tone-compact:end -->\n${KEEP_CLOSE}`, `<!-- banker:tone-compact:end -->\nmy own policy line\n${KEEP_CLOSE}`);
  writeFileSync(insideWrapper.agents, withLine);
  turnOff("codex", insideWrapper.o);
  assert.equal(read(insideWrapper.agents), `# base\n\n${KEEP_OPEN}\nmy own policy line\n${KEEP_CLOSE}\n`);
});

test("an override holding only our block does not hide AGENTS.md: on moves the block back", () => {
  const s = setup();
  writeFileSync(s.agents, "# omx contract\n");
  writeFileSync(s.override, "# override\n");
  turnOn("codex", s.o);
  writeFileSync(s.override, read(s.override).replace("# override\n", ""));
  assert.match(status(s.o).message, /Codex: 켜짐, 단 AGENTS.override.md 에 블록만 있어 AGENTS.md 가 가려짐/);
  assert.ok(turnOn("codex", s.o).ok);
  assert.ok(!existsSync(s.override), "the override left empty is removed");
  assert.equal(blocks(read(s.agents)), 1);
  turnOff("codex", s.o);
  assert.equal(read(s.agents), "# omx contract\n");
});

test("an override holding only a byte order mark still counts as the file Codex reads", () => {
  const s = setup();
  writeFileSync(s.agents, "# base\n");
  writeFileSync(s.override, "\uFEFF");
  turnOn("codex", s.o);
  assert.equal(blocks(read(s.override)), 1, "Rust's trim keeps U+FEFF, so Codex reads the override");
  assert.equal(read(s.agents), "# base\n");
});

test("duplicate blocks, or blocks in both files, are stale until on leaves exactly one", () => {
  const block = [KEEP_OPEN, OPEN, "old", "<!-- banker:tone-compact:end -->", KEEP_CLOSE, ""].join("\n");
  const dup = setup();
  writeFileSync(dup.agents, `# base\n\n${block}\n${block}`);
  assert.match(status(dup.o).message, /Codex: 켜짐, 단 규칙이 이 버전과 다름/);
  turnOn("codex", dup.o);
  assert.equal(blocks(read(dup.agents)), 1);
  const current = read(dup.agents).slice(read(dup.agents).indexOf(KEEP_OPEN));
  writeFileSync(dup.agents, `${read(dup.agents)}${current}`);
  assert.equal(blocks(read(dup.agents)), 2);
  assert.match(status(dup.o).message, /Codex: 켜짐, 단 규칙이 이 버전과 다름/, "two current blocks are not on");
  turnOn("codex", dup.o);
  assert.equal(blocks(read(dup.agents)), 1);

  const both = setup();
  writeFileSync(both.override, "# override\n");
  writeFileSync(both.agents, `# base\n\n${block}`);
  turnOn("codex", both.o);
  writeFileSync(both.agents, `# base\n\n${block}`);
  assert.match(status(both.o).message, /Codex: 켜짐, 단 규칙이 이 버전과 다름/);
  assert.ok(turnOff("codex", both.o).ok);
  assert.equal(read(both.agents), "# base\n", "off cleans the file Codex does not read too");
  assert.equal(read(both.override), "# override\n");
});

test("a block with LF line breaks inside a CRLF file still counts as current", () => {
  const s = setup();
  writeFileSync(s.agents, "# base\r\n");
  turnOn("codex", s.o);
  writeFileSync(s.agents, read(s.agents).replace(/\r\n/g, "\n").replace("# base\n", "# base\r\n"));
  assert.match(status(s.o).message, /Codex: 켜짐 \(/);
});

test("Claude Code: a body that differs under the current header is stale, and a BOM does not make the file foreign", () => {
  const s = setup();
  turnOn("claude", s.o);
  const header = read(s.rulesFile).split("\n")[0];
  writeFileSync(s.rulesFile, `${header}\nolder rules\n`);
  assert.match(status(s.o).message, /Claude Code: 켜짐, 단 규칙이 이 버전과 다름/);
  assert.ok(turnOn("claude", s.o).ok);
  writeFileSync(s.rulesFile, `\uFEFF${read(s.rulesFile)}`);
  assert.match(status(s.o).message, /Claude Code: 켜짐 \(/);
  assert.ok(turnOff("claude", s.o).ok);
  assert.ok(!existsSync(s.rulesFile));
});

test("nothing is written when the second of two files cannot be written", permTest, () => {
  const s = setup();
  writeFileSync(s.agents, "# base\n");
  turnOn("codex", s.o);
  writeFileSync(s.override, "# override\n");
  const agentsBefore = read(s.agents);
  chmodSync(s.agents, 0o444);
  try {
    const r = turnOn("codex", s.o);
    assert.equal(r.ok, false);
    assert.match(r.message, /쓸 권한이 없어/);
  } finally {
    chmodSync(s.agents, 0o644);
  }
  assert.equal(read(s.override), "# override\n", "the target was not touched either");
  assert.equal(read(s.agents), agentsBefore);
});

test("a read-only Codex folder is refused up front instead of failing halfway", permTest, () => {
  const s = setup();
  writeFileSync(s.agents, "# base\n");
  chmodSync(s.o.codexDir, 0o555);
  try {
    const r = cli(["on", "--runtime", "codex"], cliEnv(s));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /쓸 권한이 없어/);
  } finally {
    chmodSync(s.o.codexDir, 0o755);
  }
  assert.equal(read(s.agents), "# base\n");
});

test("command line: a refusal exits 1", () => {
  const s = setup();
  mkdirSync(join(s.o.claudeDir, "rules"));
  writeFileSync(s.rulesFile, "# my own rules\n");
  const r = cli(["on", "--runtime", "claude"], cliEnv(s));
  assert.equal(r.code, 1);
  assert.match(r.out, /다른 파일/);
});

test("a file that is not UTF-8 is refused byte for byte, with no .bak", () => {
  const encodings = {
    "CP949": Buffer.from([0x23, 0x20, 0xc7, 0xd1, 0xb1, 0xdb, 0x0a]),
    "UTF-16LE": Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("# 한글\n", "utf16le")]),
  };
  for (const [name, bytes] of Object.entries(encodings)) {
    const s = setup();
    writeFileSync(s.agents, bytes);
    for (const r of [turnOn("codex", s.o), turnOff("codex", s.o)]) {
      assert.equal(r.ok, false, name);
      assert.match(r.message, /UTF-8 이 아닌 파일/, name);
    }
    assert.ok(readFileSync(s.agents).equals(bytes), `${name}: bytes untouched`);
    assert.ok(!existsSync(`${s.agents}.tone-compact.bak`), `${name}: no .bak`);
    assert.match(status(s.o).message, /Codex: UTF-8 이 아닌 지침 파일이 있어 손대지 않음/, name);
  }
});

test("the .bak holds the exact bytes from before, BOM included", () => {
  const s = setup();
  const bytes = Buffer.from("\uFEFF# with bom\r\n", "utf8");
  writeFileSync(s.agents, bytes);
  turnOn("codex", s.o);
  assert.ok(readFileSync(`${s.agents}.tone-compact.bak`).equals(bytes));
  turnOff("codex", s.o);
  assert.ok(readFileSync(s.agents).equals(bytes));
});

test("marker order is checked strictly in both files", () => {
  const block = [KEEP_OPEN, OPEN, "rules", "<!-- banker:tone-compact:end -->", KEEP_CLOSE, ""].join("\n");
  const shapes = {
    "a lone end line before a complete block": `<!-- banker:tone-compact:end -->\nkeep me\n${block}`,
    "a second start before the end": `${OPEN}\n${OPEN}\nrules\n<!-- banker:tone-compact:end -->\n`,
  };
  for (const [name, text] of Object.entries(shapes)) {
    const s = setup();
    writeFileSync(s.agents, text);
    assert.equal(turnOn("codex", s.o).ok, false, name);
    assert.equal(turnOff("codex", s.o).ok, false, name);
    assert.equal(read(s.agents), text, name);
  }
  const other = setup();
  writeFileSync(other.override, "# override\n");
  writeFileSync(other.agents, `# base\n${OPEN}\n`);
  assert.equal(turnOn("codex", other.o).ok, false, "unpaired markers in the file Codex does not read");
  assert.equal(turnOff("codex", other.o).ok, false);
  assert.equal(read(other.override), "# override\n");
});

test("off removes the blank line on put in front when text follows the block", () => {
  for (const eol of ["\n", "\r\n"]) {
    const s = setup();
    writeFileSync(s.agents, `# a${eol}`);
    turnOn("codex", s.o);
    writeFileSync(s.agents, `${read(s.agents)}x${eol}`);
    turnOff("codex", s.o);
    assert.equal(read(s.agents), `# a${eol}x${eol}`, JSON.stringify(eol));
  }
});

test("a .bak already there, or a link planted at its name, is replaced", posixOnly, () => {
  const old = setup();
  writeFileSync(old.agents, "# base\n");
  writeFileSync(`${old.agents}.tone-compact.bak`, "older backup\n", { mode: 0o644 });
  chmodSync(`${old.agents}.tone-compact.bak`, 0o644);
  turnOn("codex", old.o);
  assert.equal(statSync(`${old.agents}.tone-compact.bak`).mode & 0o777, 0o600);
  assert.equal(read(`${old.agents}.tone-compact.bak`), "# base\n");

  const planted = setup();
  const victim = join(planted.dir, "victim.txt");
  writeFileSync(victim, "do not touch\n");
  writeFileSync(planted.agents, "# base\n");
  symlinkSync(victim, `${planted.agents}.tone-compact.bak`);
  turnOn("codex", planted.o);
  assert.equal(read(victim), "do not touch\n", "the link target is untouched");
  assert.ok(!lstatSync(`${planted.agents}.tone-compact.bak`).isSymbolicLink());
});

test("Claude Code: a rules folder this account cannot write is refused with exit 1", permTest, () => {
  const s = setup();
  mkdirSync(join(s.o.claudeDir, "rules"));
  chmodSync(join(s.o.claudeDir, "rules"), 0o555);
  try {
    const r = cli(["on", "--runtime", "claude"], cliEnv(s));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /쓸 권한이 없어/);
  } finally {
    chmodSync(join(s.o.claudeDir, "rules"), 0o755);
  }
});

test("command line: --runtime without a value is a usage error even inside Claude Code", () => {
  const s = setup();
  const r = cli(["on", "--runtime"], { ...cliEnv(s), CLAUDECODE: "1" });
  assert.equal(r.code, 1);
  assert.match(r.out, /사용법/);
  assert.ok(!existsSync(s.rulesFile));
});

test("the omx setup note comes with a block in AGENTS.md, not with one in the override", () => {
  const main = setup();
  writeFileSync(main.agents, "# base\n");
  assert.match(turnOn("codex", main.o).message, /omx setup/);
  const override = setup();
  writeFileSync(override.override, "# override\n");
  assert.doesNotMatch(turnOn("codex", override.o).message, /omx setup/);
});

test("an override of only no-break and ideographic spaces does not count as content", () => {
  const s = setup();
  writeFileSync(s.agents, "# base\n");
  writeFileSync(s.override, "\u00a0\u3000\n");
  turnOn("codex", s.o);
  assert.equal(blocks(read(s.agents)), 1);
  assert.equal(read(s.override), "\u00a0\u3000\n");
});

test("line-ending and BOM changes by an editor do not make a block or rules file stale", () => {
  const claude = setup();
  turnOn("claude", claude.o);
  writeFileSync(claude.rulesFile, read(claude.rulesFile).replace(/\n/g, "\r\n"));
  assert.match(status(claude.o).message, /Claude Code: 켜짐 \(/);

  const noFinalBreak = setup();
  writeFileSync(noFinalBreak.agents, "# base\n");
  turnOn("codex", noFinalBreak.o);
  writeFileSync(noFinalBreak.agents, read(noFinalBreak.agents).replace(/\n$/, ""));
  assert.match(status(noFinalBreak.o).message, /Codex: 켜짐 \(/);

  const bom = setup();
  turnOn("codex", bom.o);
  writeFileSync(bom.agents, `\uFEFF${read(bom.agents)}`);
  assert.match(status(bom.o).message, /Codex: 켜짐 \(/);
  turnOff("codex", bom.o);
  assert.ok(!existsSync(bom.agents), "nothing is left of a file on created");
});
