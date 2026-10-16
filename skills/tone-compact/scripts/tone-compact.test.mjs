// Tests for tone-compact.mjs. Run from the repo root: node --test skills/tone-compact/scripts/*.test.mjs
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import fs, {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  lutimesSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { parseArgs, rulesOf, status, turnOff, turnOn } from "./tone-compact.mjs";
import { count, done, lf, noBom, refuse, sameInode, where } from "./instruction-toggle.mjs";

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

// Throws a system error from the rename onto the backup of AGENTS.md, as Node gives it (path and dest set).
const backupRenameFails = (code) => [...FS_HOOK, "const real = fs.renameSync;",
  `fs.renameSync = (from, to) => { if (String(to).endsWith(".tone-compact.bak")) throw Object.assign(new Error(\`${code}: rename\`), { code: "${code}", syscall: "rename", path: String(from), dest: String(to) }); return real(from, to); };`,
  "syncBuiltinESMExports();"].join("\n");

// An error that is neither a refusal nor a denied write (EIO here; a folder at the backup's name gives EISDIR on
// POSIX and EPERM on Windows, so it is not used for this) ends the command with 2.
test("command line: an unexpected error exits 2 and leaves no temp file", () => {
  const s = setup();
  writeFileSync(s.agents, "# base\n");
  const r = cliWith(s, backupRenameFails("EIO"), ["on", "--runtime", "codex"]);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /예기치 못한 오류로 중단했습니다/);
  assert.deepEqual(readdirSync(s.o.codexDir).sort(), ["AGENTS.md"]);
  assert.equal(read(s.agents), "# base\n");
});

test("a write the system refuses is named where it was refused: an EPERM on the rename onto the backup names the backup", () => {
  const s = setup();
  writeFileSync(s.agents, "# base\n");
  const r = cliWith(s, backupRenameFails("EPERM"), ["on", "--runtime", "codex"]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /쓸 권한이 없어 그대로 두었습니다 \(EPERM\): .*AGENTS\.md\.tone-compact\.bak/);
  assert.equal(read(s.agents), "# base\n");
});

// Windows answers a rename onto a folder with EPERM, which counts as a denied write; POSIX answers EISDIR, an error
// the tool does not expect. Either way nothing is changed and the backup's name is in the message.
test("a folder at the backup's name stops on with the backup named and AGENTS.md as it was", () => {
  const s = setup();
  writeFileSync(s.agents, "# base\n");
  mkdirSync(join(`${s.agents}.tone-compact.bak`, "x"), { recursive: true });
  const r = cli(["on", "--runtime", "codex"], cliEnv(s));
  assert.equal(r.code, process.platform === "win32" ? 1 : 2, r.out);
  assert.match(r.out, /AGENTS\.md\.tone-compact\.bak/);
  assert.deepEqual(readdirSync(s.o.codexDir).sort(), ["AGENTS.md", "AGENTS.md.tone-compact.bak"]);
  assert.equal(read(s.agents), "# base\n");
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
    const off = cli(["off", "--runtime", "codex"], cliEnv(s));
    assert.equal(off.code, 0, `already off answers as before: ${off.out}`);
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

test("another banker skill's block alone in the override: ours goes to AGENTS.md, and on and status say Codex reads the override", () => {
  const s = setup();
  writeFileSync(s.agents, "# base\n");
  const other = [KEEP_OPEN, "<!-- banker:anti-drm:start -->", "other rules", "<!-- banker:anti-drm:end -->", KEEP_CLOSE, ""].join("\n");
  writeFileSync(s.override, other);
  const r = turnOn("codex", s.o);
  assert.ok(r.ok, r.message);
  assert.match(r.message, /다른 banker 블록\(anti-drm\)만 있어 Codex 가 AGENTS.md 를 읽지 않습니다/);
  assert.equal(blocks(read(s.agents)), 1, "our block goes to AGENTS.md");
  assert.equal(read(s.override), other, "the other skill's block is left where it is");
  assert.match(status(s.o).message, /Codex: 꺼짐, 단 AGENTS.override.md 에 다른 banker 블록\(anti-drm\)만 있어/);
  assert.ok(turnOff("codex", s.o).ok);
  assert.equal(read(s.agents), "# base\n");
});

test("the rules may not quote any banker or OMX management marker", () => {
  const wrap = (body) => `a\n<!-- tone-compact:rules:start -->\n${body}\n<!-- tone-compact:rules:end -->\nb\n`;
  assert.throws(() => rulesOf(wrap("x\nsee <!-- banker:anti-drm:start --> there")), /관리 표시/);
});

test("the shared module gives both skills its small helpers", () => {
  assert.equal(count("a,b,c", ","), 2);
  assert.equal(lf("a\r\nb\r\n"), "a\nb\n");
  assert.equal(noBom(`${String.fromCharCode(0xfeff)}x`), "x");
  assert.equal(noBom("x"), "x");
  assert.deepEqual(done("m"), { ok: true, message: "m" });
  assert.deepEqual(refuse("m"), { ok: false, message: "m" });
});

// A FIFO where an instructions file goes used to hang status and off (reading waits for a writer); a folder there
// made them stop with exit 2.
test("a FIFO where AGENTS.md goes: status returns, on and off refuse with exit 1 and change nothing", posixOnly, () => {
  const s = setup();
  assert.equal(spawnSync("mkfifo", [s.agents]).status, 0);
  const opts = { encoding: "utf8", timeout: 5000, env: { ...process.env, CLAUDECODE: "", ...cliEnv(s) } };
  const st = spawnSync(process.execPath, [CLI, "status"], opts);
  assert.equal(st.status, 0, `status hung or failed (signal ${st.signal})`);
  assert.match(st.stdout, /- Codex: 일반 파일이 아닌 지침 파일이 있어 손대지 않음 \(on, off 모두 거부\)/);
  for (const command of ["on", "off"]) {
    const r = spawnSync(process.execPath, [CLI, command, "--runtime", "codex"], opts);
    assert.equal(r.status, 1, `${command}: ${r.stdout} (signal ${r.signal})`);
    assert.match(r.stdout, /일반 파일이 아니라 그대로 두었습니다: .*AGENTS\.md/);
  }
  assert.deepEqual(readdirSync(s.o.codexDir), ["AGENTS.md"]);
});

test("a folder where AGENTS.override.md goes: status says so, on and off refuse with exit 1", () => {
  const s = setup();
  writeFileSync(s.agents, "# base\n");
  mkdirSync(s.override);
  const st = cli(["status"], cliEnv(s));
  assert.equal(st.code, 0, st.out);
  assert.match(st.out, /- Codex: 일반 파일이 아닌 지침 파일이 있어 손대지 않음/);
  for (const command of ["on", "off"]) {
    const r = cli([command, "--runtime", "codex"], cliEnv(s));
    assert.equal(r.code, 1, `${command}: ${r.out}`);
    assert.match(r.out, /일반 파일이 아니라 그대로 두었습니다: .*AGENTS\.override\.md/);
  }
  assert.equal(read(s.agents), "# base\n");
});

test("a folder where the rules file goes is someone else's file: on and off refuse, status says so", () => {
  const s = setup();
  mkdirSync(s.rulesFile, { recursive: true });
  const on = cli(["on", "--runtime", "claude"], cliEnv(s));
  assert.equal(on.code, 1, on.out);
  assert.match(on.out, /같은 이름의 다른 파일이 있어 그대로 두었습니다/);
  assert.equal(cli(["off", "--runtime", "claude"], cliEnv(s)).code, 1);
  assert.match(cli(["status"], cliEnv(s)).out, /- Claude Code: 꺼짐, 같은 이름의 다른 파일이 있음/);
});

test("a FIFO where the rules file goes: status returns and on refuses", posixOnly, () => {
  const s = setup();
  mkdirSync(join(s.o.claudeDir, "rules"));
  assert.equal(spawnSync("mkfifo", [s.rulesFile]).status, 0);
  const opts = { encoding: "utf8", timeout: 5000, env: { ...process.env, CLAUDECODE: "", ...cliEnv(s) } };
  const st = spawnSync(process.execPath, [CLI, "status"], opts);
  assert.equal(st.status, 0, `status hung or failed (signal ${st.signal})`);
  const on = spawnSync(process.execPath, [CLI, "on", "--runtime", "claude"], opts);
  assert.equal(on.status, 1, `${on.stdout} (signal ${on.signal})`);
});

test("paths lose blank-looking letters, the braille blank and spaces other than the ASCII one", () => {
  for (const c of [0x3164, 0x115f, 0xffa0, 0x2800, 0x3000, 0x00a0, 0x2060, 0xe0041]) {
    assert.equal(where(`a${String.fromCodePoint(c)}b`), "a?b", c.toString(16));
  }
  const nfd = "/home/사용자/가が".normalize("NFD");
  assert.equal(where(`${nfd}/My Files`), `${nfd}/My Files`);
});

test("an override that is a link or a hard link to AGENTS.md is one file: on twice, status and off agree", (t) => {
  let made = 0;
  for (const kind of ["symlink", "hardlink"]) {
    const s = setup();
    writeFileSync(s.agents, "# shared\n");
    try {
      if (kind === "symlink") symlinkSync("AGENTS.md", s.override);
      else linkSync(s.agents, s.override);
    } catch (e) {
      t.diagnostic(`${kind} not made here: ${e.code}`);
      continue;
    }
    made += 1;
    assert.ok(turnOn("codex", s.o).ok, kind);
    const again = turnOn("codex", s.o);
    assert.match(again.message, /이미 켜져 있습니다/, `${kind}: ${again.message}`);
    assert.equal(blocks(read(s.agents)), 1, kind);
    assert.match(status(s.o).message, /- Codex: 켜짐 \(/, kind);
    assert.ok(turnOff("codex", s.o).ok, kind);
    assert.equal(read(s.agents), "# shared\n", kind);
  }
  if (made === 0) t.skip("neither a symlink nor a hard link can be made here");
});

test("same-file checks trust an inode only where the file system gives one", () => {
  const st = (dev, ino) => ({ dev: BigInt(dev), ino: BigInt(ino) });
  assert.equal(sameInode(st(1, 5), st(1, 5)), true);
  assert.equal(sameInode(st(1, 5), st(1, 6)), false);
  assert.equal(sameInode(st(1, 5), st(2, 5)), false);
  assert.equal(sameInode(st(1, 0), st(1, 0)), false, "inode 0 says nothing");
});

test("an override that is a link to nothing counts as no override", posixOnly, () => {
  const s = setup();
  writeFileSync(s.agents, "# base\n");
  symlinkSync("gone.md", s.override);
  const r = turnOn("codex", s.o);
  assert.ok(r.ok, r.message);
  assert.equal(blocks(read(s.agents)), 1);
  assert.ok(turnOff("codex", s.o).ok);
  assert.equal(read(s.agents), "# base\n");
  assert.equal(lstatSync(s.override).isSymbolicLink(), true, "the link is left alone");
});

test("Codex off names the backup that keeps the file from before", () => {
  const s = setup();
  writeFileSync(s.agents, "# base\n");
  assert.ok(turnOn("codex", s.o).ok);
  const before = readFileSync(s.agents);
  const r = turnOff("codex", s.o);
  assert.ok(r.ok, r.message);
  assert.match(r.message, /\n지우기 전 파일: .*AGENTS\.md\.tone-compact\.bak$/);
  assert.ok(readFileSync(`${s.agents}.tone-compact.bak`).equals(before));
});

test("off empties a hard-linked AGENTS.md rather than removing one name, so no copy of the block stays", (t) => {
  for (const linkFirst of [true, false]) {
    const s = setup();
    if (linkFirst) writeFileSync(s.agents, "");
    else assert.ok(turnOn("codex", s.o).ok);
    try {
      linkSync(s.agents, s.override);
    } catch (e) {
      t.skip(`no hard links here: ${e.code}`);
      return;
    }
    if (linkFirst) assert.ok(turnOn("codex", s.o).ok);
    const r = turnOff("codex", s.o);
    assert.ok(r.ok, r.message);
    for (const f of [s.agents, s.override]) assert.equal(existsSync(f) ? blocks(read(f)) : 0, 0, `${linkFirst} ${f}`);
    assert.match(status(s.o).message, /- Codex: 꺼짐 \(/, String(linkFirst));
  }
});

test("the troubleshooting row for a folder or FIFO at an instructions file says not to delete it and to ask first", () => {
  const row = readFileSync(SKILL, "utf8").split("\n").find((l) => l.startsWith("| 일반 파일이 아님 |"));
  assert.ok(row, "the row exists");
  assert.match(row, /지우지 않음/);
  assert.match(row, /물은 뒤/);
  assert.doesNotMatch(row, /치운/);
});

test("status names the file a refused state is about, not the file the block would go to", () => {
  const s = setup();
  const codex = () => status(s.o).message.split("\n").find((l) => l.startsWith("- Codex:"));
  writeFileSync(s.agents, "# base\n");
  mkdirSync(s.override);
  assert.match(codex(), /일반 파일이 아닌 지침 파일이 있어 손대지 않음 .*\(.*AGENTS\.override\.md\)$/);
  rmSync(s.override, { recursive: true });
  writeFileSync(s.override, "# mine\n");
  writeFileSync(s.agents, Buffer.from([0x23, 0x20, 0xff, 0x0a]));
  assert.match(codex(), /UTF-8 이 아닌 지침 파일이 있어 손대지 않음 .*\(.*AGENTS\.md\)$/);
  writeFileSync(s.agents, `# base\n${OPEN}\nhalf a block\n`);
  assert.match(codex(), /표시의 짝이 맞지 않음 .*\(.*AGENTS\.md\)$/);
});

// status, on and off where no regular file can be at AGENTS.md.
function refusesNotRegular(s, what) {
  assert.match(cli(["status"], cliEnv(s)).out, /- Codex: 일반 파일이 아닌 지침 파일이 있어 손대지 않음/, what);
  for (const command of ["on", "off"]) {
    const r = cli([command, "--runtime", "codex"], cliEnv(s));
    assert.equal(r.code, 1, `${what} ${command}: ${r.out}`);
    assert.match(r.out, /일반 파일이 아니라 그대로 두었습니다: .*AGENTS\.md/, `${what} ${command}`);
  }
}

test("a link loop where AGENTS.md goes is no regular file: status says so, on and off refuse with exit 1", posixOnly, () => {
  const s = setup();
  symlinkSync("loop-b", s.agents);
  symlinkSync("AGENTS.md", join(s.o.codexDir, "loop-b"));
  refusesNotRegular(s, "link loop");
});

// A socket path past about 100 bytes is refused by some systems (macOS allows 104), so such a run says it skipped.
test("a socket where AGENTS.md goes is no regular file: status says so, on and off refuse with exit 1", posixOnly, async (t) => {
  const s = setup();
  const bytes = Buffer.byteLength(s.agents);
  if (bytes >= 100) return t.skip(`the socket path is ${bytes} bytes, past what some systems allow`);
  const server = createServer();
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(s.agents, resolve); });
  } catch (e) {
    return t.skip(`no socket here: ${e.code}`);
  }
  try {
    refusesNotRegular(s, "socket");
  } finally {
    server.close();
  }
});

test("AGENTS.md that is a link to nothing: on refuses and makes no file where it points; an override with text still works", posixOnly, () => {
  const s = setup();
  symlinkSync("gone.md", s.agents);
  const on = cli(["on", "--runtime", "codex"], cliEnv(s));
  assert.equal(on.code, 1, on.out);
  assert.match(on.out, /끊어진 링크라 그대로 두었습니다: .*AGENTS\.md/);
  assert.equal(existsSync(join(s.o.codexDir, "gone.md")), false, "nothing was made where the link points");
  assert.equal(lstatSync(s.agents).isSymbolicLink(), true);
  assert.match(cli(["status"], cliEnv(s)).out, /- Codex: 꺼짐, 단 AGENTS\.md 가 끊어진 링크라 on 이 거부함/);
  assert.equal(cli(["off", "--runtime", "codex"], cliEnv(s)).code, 0);
  writeFileSync(s.override, "# mine\n");
  assert.equal(cli(["on", "--runtime", "codex"], cliEnv(s)).code, 0, "the block goes to the override Codex reads");
  assert.equal(blocks(read(s.override)), 1);
  assert.equal(cli(["off", "--runtime", "codex"], cliEnv(s)).code, 0);
  assert.equal(read(s.override), "# mine\n");
});

test("Claude Code: a link to nothing where the rules file goes is replaced by on, never written through", posixOnly, () => {
  const s = setup();
  mkdirSync(join(s.o.claudeDir, "rules"));
  symlinkSync("gone.md", s.rulesFile);
  const r = turnOn("claude", s.o);
  assert.ok(r.ok, r.message);
  assert.equal(lstatSync(s.rulesFile).isSymbolicLink(), false);
  assert.equal(existsSync(join(s.o.claudeDir, "rules", "gone.md")), false);
});

test("Codex on and off wait for another banker skill's lock, and take over one a dead run left", () => {
  const s = setup();
  writeFileSync(s.agents, "# base\n");
  const lock = join(s.o.codexDir, ".banker-agents.lock");
  writeFileSync(lock, "4242 0 held");
  const started = Date.now();
  const held = turnOn("codex", { ...s.o, lockWaitMs: 200 });
  assert.equal(held.ok, false, held.message);
  assert.match(held.message, /다른 banker 지침 작업이 끝나지 않아 그대로 두었습니다: .*\.banker-agents\.lock/);
  assert.ok(Date.now() - started >= 200, "it waited");
  assert.equal(read(s.agents), "# base\n");
  assert.equal(turnOff("codex", { ...s.o, lockWaitMs: 200 }).ok, false);
  const old = new Date(Date.now() - 120_000);
  utimesSync(lock, old, old);
  const r = turnOn("codex", { ...s.o, lockWaitMs: 200 });
  assert.ok(r.ok, r.message);
  assert.equal(blocks(read(s.agents)), 1);
  assert.equal(existsSync(lock), false, "the lock is given back");
});

test("Codex: a folder where the lock goes is never removed and the wait ends in a refusal; a lock dated a day ahead is taken over", () => {
  const s = setup();
  writeFileSync(s.agents, "# base\n");
  const lock = join(s.o.codexDir, ".banker-agents.lock");
  mkdirSync(lock);
  const old = new Date(Date.now() - 120_000);
  utimesSync(lock, old, old);
  const r = turnOn("codex", { ...s.o, lockWaitMs: 200 });
  assert.equal(r.ok, false, r.message);
  assert.match(r.message, /다른 banker 지침 작업이 끝나지 않아 그대로 두었습니다/);
  assert.equal(statSync(lock).isDirectory(), true, "the folder stays");
  rmSync(lock, { recursive: true });
  writeFileSync(lock, "4242 0 held");
  const ahead = new Date(Date.now() + 24 * 3600_000);
  utimesSync(lock, ahead, ahead);
  const t = turnOn("codex", { ...s.o, lockWaitMs: 200 });
  assert.ok(t.ok, t.message);
  assert.equal(blocks(read(s.agents)), 1);
  assert.equal(existsSync(lock), false, "the lock is given back");
});

// Runs code (an ES module reading its arguments from process.argv.slice(1)) in a child with a deadline, so a run
// that never ends fails the test instead of holding it, and returns the JSON the code printed.
function inChild(code, ...args) {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code, ...args], { encoding: "utf8", timeout: 15_000 });
  assert.equal(r.error?.code, undefined, "the child ended before its deadline");
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}
const lexists = (p) => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

test("Codex: a link to nothing or a link loop where the lock goes ends the wait at its deadline, and one a minute old is taken over", posixOnly, () => {
  const on = `const { turnOn } = await import(${JSON.stringify(new URL("./tone-compact.mjs", import.meta.url).href)});
console.log(JSON.stringify(turnOn("codex", JSON.parse(process.argv[1]))));`;
  for (const [name, target] of [["link to nothing", "gone"], ["link loop", ".banker-agents.lock"]]) {
    const s = setup();
    writeFileSync(s.agents, "# base\n");
    const lock = join(s.o.codexDir, ".banker-agents.lock");
    symlinkSync(target, lock);
    const o = JSON.stringify({ ...s.o, lockWaitMs: 200 });
    const held = inChild(on, o);
    assert.equal(held.ok, false, `${name}: ${held.message}`);
    assert.match(held.message, /다른 banker 지침 작업이 끝나지 않아 그대로 두었습니다/, name);
    assert.equal(read(s.agents), "# base\n", name);
    const old = new Date(Date.now() - 120_000);
    lutimesSync(lock, old, old);
    const r = inChild(on, o);
    assert.ok(r.ok, `${name}: ${r.message}`);
    assert.equal(blocks(read(s.agents)), 1, name);
    assert.equal(lexists(lock), false, `${name}: the old link is gone and the lock given back`);
    assert.equal(existsSync(join(s.o.codexDir, "gone")), false, `${name}: nothing was made where the link pointed`);
  }
});

test("Codex: a lock that turned into a pipe while held is left there, never opened to be read", posixOnly, () => {
  const s = setup();
  writeFileSync(s.agents, "# base\n");
  const lock = join(s.o.codexDir, ".banker-agents.lock");
  const code = `const { toggleSpec, turnOn } = await import(${JSON.stringify(new URL("./instruction-toggle.mjs", import.meta.url).href)});
const { rmSync } = await import("node:fs");
const { spawnSync } = await import("node:child_process");
const [o, lock] = [JSON.parse(process.argv[1]), process.argv[2]];
const t = toggleSpec({ slug: "tone-compact", staleText: "old", updatedText: "updated" });
console.log(JSON.stringify(turnOn(t, "codex", o, () => { rmSync(lock); spawnSync("mkfifo", [lock]); return "rules"; })));`;
  const r = inChild(code, JSON.stringify(s.o), lock);
  assert.ok(r.ok, r.message);
  assert.equal(blocks(read(s.agents)), 1);
  assert.equal(lstatSync(lock).isFIFO(), true, "a lock that is no longer this run's stays");
});

// "Show" in the troubleshooting table means ls -l first: a row cannot name every place a planted link may sit.
test("the troubleshooting section says to show a file with ls -l first and to open only a regular file that is not a link", () => {
  const section = readFileSync(SKILL, "utf8").split("## 문제 해결")[1].split("\n| 메시지 |")[0];
  assert.match(section, /`ls -l` 로 그 이름의 종류와 링크 대상 경로를 보이는 것/);
  assert.match(section, /링크가 아닌 일반 파일임을 본 뒤에만 내용을 연다/);
});

// The Codex instructions file is copied to .bak through its link, so a .bak may hold what a planted link led to (a key,
// say). It is named by its path, never opened.
test("the troubleshooting section says a .bak file is named by its path and its content is never opened", () => {
  const section = readFileSync(SKILL, "utf8").split("## 문제 해결")[1].split("\n| 메시지 |")[0];
  assert.match(section, /`<파일>\.tone-compact\.bak` 은 내용을 열지 않고 경로만 알린다/);
});

// A name that may be a link someone planted is shown by its path: opening it would put the file it leads to (a key,
// say) into the session.
test("the rows that show a file that may be a link say to show only the link and where it leads, not its content", () => {
  const rows = readFileSync(SKILL, "utf8").split("\n").filter((l) => /^\| (쓰는 사이에 같은 이름이 생겨|같은 이름의 다른 파일이 있음)/.test(l));
  assert.equal(rows.length, 2);
  for (const row of rows) assert.match(row, /링크면 `ls -l` 로 링크와 대상 경로만 보이고 대상 내용은 열지 않음/, row);
});

test("troubleshooting rows never tell the agent to clear, delete or rename a user's file without asking first", () => {
  const table = readFileSync(SKILL, "utf8").split("## 문제 해결")[1].split("\n## ")[0];
  const rows = table.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| 메시지"));
  for (const row of rows) assert.doesNotMatch(row, /치우|치운|치움|이름 변경 또는 삭제|지운 뒤 다시|옮긴 뒤 다시/, row);
  for (const head of ["같은 이름의 다른 파일이 있음", "표시의 짝이 맞지 않음", "끊어진 링크라", "일반 파일이 아님", "UTF-8 이 아닌 파일",
    "다른 banker 지침 작업이 끝나지 않아", "쓰는 사이에 같은 이름이 생겨", "AGENTS.md 가 끊어진 링크라 on 이 블록을 옮기지 못함"]) {
    const row = rows.find((l) => l.startsWith(`| ${head}`));
    assert.ok(row, head);
    assert.match(row, /물은 뒤/, row);
  }
});

test("a FIFO where AGENTS.override.md goes: status returns and names it, on and off refuse with exit 1", posixOnly, () => {
  const s = setup();
  writeFileSync(s.agents, "# base\n");
  assert.equal(spawnSync("mkfifo", [s.override]).status, 0);
  const opts = { encoding: "utf8", timeout: 5000, env: { ...process.env, CLAUDECODE: "", ...cliEnv(s) } };
  const st = spawnSync(process.execPath, [CLI, "status"], opts);
  assert.equal(st.status, 0, `status hung or failed (signal ${st.signal})`);
  assert.match(st.stdout, /- Codex: 일반 파일이 아닌 지침 파일이 있어 손대지 않음 .*AGENTS\.override\.md/);
  for (const command of ["on", "off"]) {
    const r = spawnSync(process.execPath, [CLI, command, "--runtime", "codex"], opts);
    assert.equal(r.status, 1, `${command}: ${r.stdout} (signal ${r.signal})`);
    assert.match(r.stdout, /일반 파일이 아니라 그대로 두었습니다: .*AGENTS\.override\.md/);
  }
  assert.equal(read(s.agents), "# base\n");
});

// ---- what changed between a look and a write, and what a sandbox refuses ----

// Runs the command line with a module loaded first that changes what node:fs does for this run only.
function cliWith(s, pre, args) {
  const file = join(s.dir, `pre-${cases++}.mjs`);
  writeFileSync(file, `${pre}\n`);
  const r = spawnSync(process.execPath, ["--import", pathToFileURL(file).href, CLI, ...args],
    { encoding: "utf8", timeout: 15_000, env: { ...process.env, CLAUDECODE: "", ...cliEnv(s) } });
  assert.equal(r.error?.code, undefined, "the run ended before its deadline");
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
const FS_HOOK = ['import fs from "node:fs";', 'import { syncBuiltinESMExports } from "node:module";'];

test("Codex: a link planted where a new AGENTS.md goes, after on looked, is refused and the file it leads to is untouched", posixOnly, () => {
  const s = setup();
  const victim = join(s.dir, "victim.md");
  writeFileSync(victim, "someone's notes\n");
  const pre = [...FS_HOOK, "const real = fs.accessSync;", "let done = false;",
    `fs.accessSync = (p, ...a) => { if (!done && String(p) === ${JSON.stringify(s.o.codexDir)}) { done = true; fs.symlinkSync(${JSON.stringify(victim)}, ${JSON.stringify(s.agents)}); } return real(p, ...a); };`,
    "syncBuiltinESMExports();"].join("\n");
  const r = cliWith(s, pre, ["on", "--runtime", "codex"]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /쓰는 사이에 같은 이름이 생겨 그대로 두었습니다: .*AGENTS\.md/);
  assert.equal(read(victim), "someone's notes\n", "the file the link leads to is untouched");
  assert.ok(lstatSync(s.agents).isSymbolicLink(), "the planted link stays");
});

test("Codex: a write a sandbox refuses after access() allowed it is a refusal with exit 1, for on and off", () => {
  const s = setup();
  writeFileSync(s.agents, "# base\n");
  const pre = [...FS_HOOK, "const real = fs.writeFileSync;",
    `fs.writeFileSync = (p, ...a) => { if (String(p) === ${JSON.stringify(s.agents)}) throw Object.assign(new Error("EACCES: permission denied, open"), { code: "EACCES" }); return real(p, ...a); };`,
    "syncBuiltinESMExports();"].join("\n");
  const on = cliWith(s, pre, ["on", "--runtime", "codex"]);
  assert.equal(on.code, 1, on.out);
  assert.match(on.out, /쓸 권한이 없어 그대로 두었습니다 \(EACCES\): .*AGENTS\.md/);
  assert.doesNotMatch(on.out, /예기치 못한 오류/);
  assert.equal(read(s.agents), "# base\n");
  assert.equal(cli(["on", "--runtime", "codex"], cliEnv(s)).code, 0);
  const off = cliWith(s, pre, ["off", "--runtime", "codex"]);
  assert.equal(off.code, 1, off.out);
  assert.match(off.out, /쓸 권한이 없어 그대로 두었습니다 \(EACCES\): .*AGENTS\.md/);
  assert.equal(blocks(read(s.agents)), 1, "the block is still there");
});

// A move of the block between two files adds it to the new file first and takes it out of the old one after, so a
// refusal partway leaves the rules on: the message names the file changed before the refusal, and on again ends the move.
test("Codex: a refusal partway through a move names the file it changed first, and on again finishes the move", () => {
  const s = setup();
  writeFileSync(s.agents, "# base\n");
  writeFileSync(s.override, "# override\n");
  assert.equal(cli(["on", "--runtime", "codex"], cliEnv(s)).code, 0);
  writeFileSync(s.override, read(s.override).replace("# override\n", ""));
  const pre = [...FS_HOOK, "const real = fs.rmSync;",
    `fs.rmSync = (p, ...a) => { if (String(p) === ${JSON.stringify(s.override)}) throw Object.assign(new Error("EACCES: permission denied, unlink"), { code: "EACCES" }); return real(p, ...a); };`,
    "syncBuiltinESMExports();"].join("\n");
  const r = cliWith(s, pre, ["on", "--runtime", "codex"]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /쓸 권한이 없어 그대로 두었습니다 \(EACCES\): .*AGENTS\.override\.md/);
  assert.match(r.out, /\n앞서 바꾼 파일: .*AGENTS\.md/);
  assert.equal(blocks(read(s.agents)), 1, "the block went to AGENTS.md first");
  assert.equal(blocks(read(s.override)), 1, "the override still holds its block");
  assert.equal(cli(["on", "--runtime", "codex"], cliEnv(s)).code, 0);
  assert.equal(blocks(read(s.agents)), 1);
  assert.ok(!existsSync(s.override), "on again ends the move");
});

test("the exit status table says a refusal that names a file changed before it left that file changed", () => {
  const row = readFileSync(SKILL, "utf8").split("\n").find((l) => /^\s*\| 1 \|/.test(l));
  assert.match(row, /`앞서 바꾼 파일:`/);
  assert.match(row, /이미 바뀜/);
});

test("Codex: a stale file handle while a dead run's lock is looked at counts as no lock", () => {
  const s = setup();
  writeFileSync(s.agents, "# base\n");
  const lock = join(s.o.codexDir, ".banker-agents.lock");
  writeFileSync(lock, "a dead run");
  const old = new Date(Date.now() - 10 * 60_000);
  utimesSync(lock, old, old);
  const pre = [...FS_HOOK, "const real = fs.lstatSync;", "let done = false;",
    `fs.lstatSync = (p, ...a) => { if (!done && String(p) === ${JSON.stringify(lock)}) { done = true; throw Object.assign(new Error("ESTALE: stale file handle, lstat"), { code: "ESTALE" }); } return real(p, ...a); };`,
    "syncBuiltinESMExports();"].join("\n");
  const r = cliWith(s, pre, ["on", "--runtime", "codex"]);
  assert.equal(r.code, 0, r.out);
  assert.equal(blocks(read(s.agents)), 1);
});

// A network share that keeps answering ESTALE for the lock: the wait rests between looks and ends in the usual
// refusal, instead of calling lstat as fast as it can until the deadline.
test("Codex: a lock spot that keeps answering ESTALE is waited on with rests, then refused", () => {
  const s = setup();
  writeFileSync(s.agents, "# base\n");
  const lock = join(s.o.codexDir, ".banker-agents.lock");
  writeFileSync(lock, "another run");
  const real = fs.lstatSync;
  let looks = 0;
  fs.lstatSync = (p, ...a) => {
    if (String(p) !== lock) return real(p, ...a);
    looks++;
    throw Object.assign(new Error("ESTALE: stale file handle, lstat"), { code: "ESTALE" });
  };
  syncBuiltinESMExports();
  let r;
  try {
    r = turnOn("codex", { ...s.o, lockWaitMs: 300 });
  } finally {
    fs.lstatSync = real;
    syncBuiltinESMExports();
  }
  assert.equal(r.ok, false);
  assert.match(r.message, /다른 banker 지침 작업이 끝나지 않아 그대로 두었습니다/);
  assert.ok(looks < 50, `the wait rested between looks (${looks} looks in 300 ms)`);
  assert.equal(read(s.agents), "# base\n");
});

test("an override holding only our block over AGENTS.md that is a link to nothing: status says on cannot move it, as on refuses", posixOnly, () => {
  const s = setup();
  writeFileSync(s.override, "# override\n");
  assert.ok(turnOn("codex", s.o).ok);
  writeFileSync(s.override, read(s.override).replace("# override\n", ""));
  symlinkSync("gone.md", s.agents);
  assert.match(status(s.o).message, /- Codex: 켜짐, 단 AGENTS\.override\.md 에 블록만 있고 AGENTS\.md 가 끊어진 링크라 on 이 블록을 옮기지 못함/);
  const r = turnOn("codex", s.o);
  assert.equal(r.ok, false);
  assert.match(r.message, /끊어진 링크라 그대로 두었습니다/);
});

test("Claude Code: on says so when the rules file was a link it replaced, and leaves where the link led as it was", posixOnly, () => {
  const s = setup();
  mkdirSync(join(s.o.claudeDir, "rules"));
  symlinkSync("gone.md", s.rulesFile);
  const gone = turnOn("claude", s.o);
  assert.ok(gone.ok, gone.message);
  assert.match(gone.message, /참고: 링크였던 자리를 일반 파일로 바꿨습니다\. 링크가 가리키던 곳은 건드리지 않았습니다\./);
  const t = setup();
  mkdirSync(join(t.o.claudeDir, "rules"));
  const copy = join(t.dir, "dotfiles-rules.md");
  writeFileSync(copy, "<!-- banker tone-compact: an older copy -->\nold rules\n");
  symlinkSync(copy, t.rulesFile);
  const older = turnOn("claude", t.o);
  assert.ok(older.ok, older.message);
  assert.match(older.message, /참고: 링크였던 자리를 일반 파일로 바꿨습니다/);
  assert.equal(lstatSync(t.rulesFile).isSymbolicLink(), false);
  assert.equal(read(copy), "<!-- banker tone-compact: an older copy -->\nold rules\n", "the copy the link led to is as it was");
  const again = turnOn("claude", t.o);
  assert.doesNotMatch(again.message, /링크였던 자리/, "a plain file says nothing about links");
});
