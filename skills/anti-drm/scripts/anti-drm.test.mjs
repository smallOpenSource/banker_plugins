// Tests for anti-drm.mjs. Run from anywhere: node --test <repo>/skills/anti-drm/scripts/anti-drm.test.mjs
import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import {
  checkConfig,
  configure,
  ownerTrusted,
  priorBytes,
  parseArgs,
  readConfig,
  renderRules,
  replacementFor,
  splitList,
  status,
  templateOf,
  turnOff,
  turnOn,
} from "./anti-drm.mjs";
import { where } from "./instruction-toggle.mjs";
import { status as tcStatus, turnOff as tcOff, turnOn as tcOn } from "../../tone-compact/scripts/tone-compact.mjs";

const CLI = fileURLToPath(new URL("./anti-drm.mjs", import.meta.url));
const SKILL = fileURLToPath(new URL("../SKILL.md", import.meta.url));
const TEMPLATE = templateOf(readFileSync(SKILL, "utf8"));
const root = mkdtempSync(join(tmpdir(), "anti-drm-test-"));
after(() => rmSync(root, { recursive: true, force: true }));

const BOM = String.fromCharCode(0xfeff);
const KEEP_OPEN = "<!-- USER:OMX:POLICY:START -->";
const KEEP_CLOSE = "<!-- USER:OMX:POLICY:END -->";
const OPEN = "<!-- banker:anti-drm:start -->";
const TC_OPEN = "<!-- banker:tone-compact:start -->";
const DENY = ".txt,.pdf,.ppt,.pptx,.doc,.docx,.hwp,.hwpx,.xls,.xlsx,.csv";
const FLAGS = { deny: DENY, alt: ".md,.html,.tsv" };
const CONFIG = checkConfig({ deny: splitList(DENY), alt: splitList(FLAGS.alt) }).config;
const RULES = renderRules(TEMPLATE, CONFIG);

const posixOnly = { skip: process.platform === "win32" && "Windows has no POSIX mode bits or plain symlinks" };
const asRoot = typeof process.getuid === "function" && process.getuid() === 0;
const permTest = { skip: process.platform === "win32" ? "Windows has no POSIX mode bits" : asRoot && "root ignores mode bits" };

let cases = 0;
// Config folders for one test, and a settings path whose folders do not exist yet.
function setup({ claude = true, codex = true } = {}) {
  const dir = join(root, `case-${cases++}`);
  mkdirSync(dir);
  const o = {
    claudeDir: join(dir, "claude"),
    codexDir: join(dir, "codex"),
    configFile: join(dir, "config", "banker", "anti-drm.json"),
    skillFile: SKILL,
  };
  if (claude) mkdirSync(o.claudeDir);
  if (codex) mkdirSync(o.codexDir);
  return {
    dir,
    o,
    tc: { claudeDir: o.claudeDir, codexDir: o.codexDir },
    rulesFile: join(o.claudeDir, "rules", "banker-anti-drm.md"),
    agents: join(o.codexDir, "AGENTS.md"),
    override: join(o.codexDir, "AGENTS.override.md"),
  };
}

const read = (file) => readFileSync(file, "utf8");
const blocks = (text, open = OPEN) => text.split(open).length - 1;

// The command line, in a child process that does not look like Claude Code unless the test says so.
function cli(args, env = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, CLAUDECODE: "", ...env } });
  return { code: r.status, out: r.stdout };
}
const cliEnv = (s) => ({ CLAUDE_CONFIG_DIR: s.o.claudeDir, CODEX_HOME: s.o.codexDir, BANKER_ANTI_DRM_CONFIG: s.o.configFile });

// What `omx setup --merge-agents` does to a generated AGENTS.md (oh-my-codex
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

test("settings: extensions are lower-cased, dotted and kept once, in the order given", () => {
  const r = checkConfig({ deny: ["TXT", ".Pdf", "txt", " csv "], alt: ["md", ".HTML"] });
  assert.deepEqual(r.config, { version: 1, deny: [".txt", ".pdf", ".csv"], alt: [".md", ".html"], tsvDelimiter: "tab" });
  assert.deepEqual(splitList(" .txt, .pdf  .csv,,"), [".txt", ".pdf", ".csv"]);
  assert.deepEqual(splitList(undefined), []);
});

test("settings: empty lists, odd words, shared or reserved extensions and unknown delimiters are refused", () => {
  const refused = [
    [{ deny: [], alt: [".md"] }, /금지 확장자가 비어 있습니다/],
    [{ deny: ".txt", alt: [".md"] }, /금지 확장자가 목록이 아닙니다/],
    [{ deny: [".txt"], alt: [] }, /대체 확장자가 비어 있습니다/],
    [{ deny: [".t-xt"], alt: [".md"] }, /금지 확장자로 쓸 수 없는 값입니다: \.t-xt/],
    [{ deny: ["../x"], alt: [".md"] }, /쓸 수 없는 값/],
    [{ deny: [".abcdefghijklmnop"], alt: [".md"] }, /쓸 수 없는 값/],
    [{ deny: [".txt"], alt: [".TXT"] }, /함께 있습니다: \.txt/],
    [{ deny: [".md", ".json"], alt: [".html"] }, /anti-drm 이 쓰는 형식이라 금지할 수 없습니다: \.md \.json/],
    [{ deny: [".txt"], alt: [".md"], tsvDelimiter: "pipe" }, /TSV 구분자는 tab 이나 comma 여야 합니다/],
  ];
  for (const [input, error] of refused) assert.match(checkConfig(input).error ?? "", error, JSON.stringify(input));
  const forged = checkConfig({ deny: ["a\n[x] 완료"], alt: [".md"] }).error;
  assert.ok(!forged.includes("\n"), "a value shown in a message cannot start a line of its own");
});

test("settings file: none, not JSON, not an object, a byte order mark and unknown keys", () => {
  const s = setup();
  assert.equal(readConfig(s.o.configFile), null);
  mkdirSync(join(s.dir, "config", "banker"), { recursive: true });
  writeFileSync(s.o.configFile, "{");
  assert.match(readConfig(s.o.configFile).error, /JSON 이 아닙니다/);
  writeFileSync(s.o.configFile, "[]");
  assert.match(readConfig(s.o.configFile).error, /JSON 객체가 아닙니다/);
  writeFileSync(s.o.configFile, `${BOM}{"deny":["TXT"],"alt":[".md"],"note":"edited by hand"}\r\n`);
  assert.deepEqual(readConfig(s.o.configFile).config, { version: 1, deny: [".txt"], alt: [".md"], tsvDelimiter: "tab" });
});

test("rules: the default settings give one row per denied extension", () => {
  const rows = RULES.split("\n").filter((l) => /^\| `\.[a-z]+` \| `\.[a-z]+` \|$/.test(l));
  assert.equal(rows.length, 11);
  for (const row of ["| `.txt` | `.md` |", "| `.hwpx` | `.md` |", "| `.pdf` | `.html` |", "| `.pptx` | `.html` |", "| `.csv` | `.tsv` |", "| `.xlsx` | `.tsv` |"]) {
    assert.ok(RULES.includes(row), row);
  }
  assert.ok(RULES.includes("| `.tsv` | 표 데이터. 탭으로 구분하고 첫 줄은 머리글 |"));
  assert.ok(RULES.startsWith("# 파일 확장자 규칙 (banker anti-drm)"));
  assert.ok(!RULES.includes("{{") && !RULES.includes("<!--"), "no placeholder or marker left");
});

test("rules: a replacement the user did not choose falls back in order", () => {
  assert.equal(replacementFor(".pdf", [".md"]), ".md");
  assert.equal(replacementFor(".csv", [".md", ".html"]), ".md");
  assert.equal(replacementFor(".csv", [".html"]), ".html");
  assert.equal(replacementFor(".log", [".html", ".md"]), ".md");
  assert.equal(replacementFor(".txt", [".adoc"]), ".adoc");
});

test("rules: the wording follows the replacements and the TSV delimiter", () => {
  const noTsv = renderRules(TEMPLATE, checkConfig({ deny: [".csv"], alt: [".md", ".html"] }).config);
  assert.ok(noTsv.includes("| `.md` | 글과 메모. 표 데이터는 마크다운 표 |"));
  assert.ok(noTsv.includes("| `.csv` | `.md` |"));
  const comma = renderRules(TEMPLATE, checkConfig({ deny: [".csv"], alt: [".tsv", ".md"], tsvDelimiter: "comma" }).config);
  assert.ok(comma.includes("| `.tsv` | 표 데이터. CSV 내용을 그대로 쓰고 확장자만 .tsv. 읽고 쓰는 코드에 구분자 쉼표를 명시 |"));
  assert.ok(comma.includes("| `.md` | 글과 메모 |"));
  const own = renderRules(TEMPLATE, checkConfig({ deny: [".log"], alt: [".adoc", ".md"] }).config);
  assert.ok(own.includes("| `.adoc` | 사용자가 정한 대체 확장자 |"));
  assert.ok(own.includes("| `.log` | `.md` |"));
});

test("the rules never ask for a plaintext copy, say a replacement copy is not protected, and put the organization's rules first", () => {
  assert.ok(!RULES.includes("평문 사본을 요청함"), "no request for a plaintext copy of a protected file");
  assert.ok(RULES.includes("평문 사본을 요청하거나 권하지 않음"));
  assert.ok(RULES.includes("함께 둘 대체 확장자 원본은 DRM 이 보호하지 않음"));
  assert.ok(RULES.includes("조직의 보안 규정이 이 규칙보다 우선함"));
  assert.ok(RULES.includes("이미 DRM 이 걸린 파일을 풀거나 다른 형식으로 바꾸지 않음"));
  assert.doesNotMatch(RULES, /DRM 을 피하/, "the rules do not claim to avoid DRM while steering away from it");
  assert.doesNotMatch(read(SKILL), /DRM 을 피하/);
});

test("the template is in SKILL.md once, with each placeholder once and no management marker", () => {
  const wrap = (body) => `a\n<!-- anti-drm:rules:start -->\n${body}\n<!-- anti-drm:rules:end -->\nb\n`;
  assert.equal(templateOf(wrap("x {{map}} y {{alts}}").replace(/\n/g, "\r\n")), "x {{map}} y {{alts}}");
  assert.throws(() => templateOf("no markers"), /찾지 못했습니다/);
  assert.throws(() => templateOf(wrap("{{map}}") + wrap("{{alts}}")), /찾지 못했습니다/);
  assert.throws(() => templateOf(wrap("{{map}} only")), /자리 표시/);
  assert.throws(() => templateOf(wrap("{{map}} {{map}} {{alts}}")), /자리 표시/);
  assert.throws(() => templateOf(wrap(`{{map}} {{alts}}\n${OPEN}`)), /관리 표시/);
});

test("SKILL.md keeps its own rules outside code: no decorative symbols, emoji or exclamation marks", () => {
  const text = read(SKILL);
  assert.match(text, /^---\nname: anti-drm\n/);
  const prose = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "").replace(/<!--[\s\S]*?-->/g, "");
  assert.doesNotMatch(prose, /[→⇒←↔·…※★☆✓✔✗✘●○■□▶◆—–]/u);
  assert.doesNotMatch(prose, /\p{Extended_Pictographic}/u);
  assert.ok(!prose.includes("!"), "no exclamation marks in prose");
});

test("the rules list three or more items vertically, never inline: at most one comma per line or table cell", () => {
  const comma = renderRules(TEMPLATE, checkConfig({ deny: [".csv"], alt: [".tsv"], tsvDelimiter: "comma" }).config);
  for (const rules of [RULES, comma]) {
    const prose = rules.replace(/`[^`\n]*`/g, "");
    for (const line of prose.split("\n")) {
      const cells = line.trim().startsWith("|") ? line.split("|") : [line];
      for (const cell of cells) assert.ok(cell.split(",").length <= 2, `inline enumeration: ${line.trim()}`);
    }
  }
});

test("Claude Code: on with settings saves them, writes the rules file, and a second on changes nothing", () => {
  const s = setup();
  const r = turnOn("claude", s.o, FLAGS);
  assert.ok(r.ok, r.message);
  assert.match(r.message, /설정을 저장했습니다/);
  assert.ok(r.message.endsWith(`적용할 규칙:\n${RULES}`), "the rules follow, for this session");
  assert.deepEqual(readConfig(s.o.configFile).config, CONFIG);
  const text = read(s.rulesFile);
  assert.ok(text.startsWith("<!-- banker anti-drm"));
  assert.ok(text.endsWith(`\n${RULES}\n`));
  const again = turnOn("claude", s.o);
  assert.ok(again.ok && /변경 없음/.test(again.message), again.message);
  assert.equal(read(s.rulesFile), text);
});

test("on without settings, with one list only, or with a reserved extension refuses and writes nothing", () => {
  const s = setup();
  const none = turnOn("claude", s.o);
  assert.equal(none.ok, false);
  assert.match(none.message, /설정이 없습니다/);
  const half = turnOn("claude", s.o, { deny: ".txt" });
  assert.equal(half.ok, false);
  assert.match(half.message, /사용법/);
  const bad = turnOn("claude", s.o, { deny: ".md", alt: ".html" });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /설정을 저장하지 않았습니다: anti-drm 이 쓰는 형식/);
  assert.ok(!existsSync(s.rulesFile) && !existsSync(s.o.configFile));
});

test("Claude Code: off deletes the rules file and keeps the settings", () => {
  const s = setup();
  turnOn("claude", s.o, FLAGS);
  const r = turnOff("claude", s.o);
  assert.ok(r.ok, r.message);
  assert.match(r.message, /설정은 남겨 두었습니다/);
  assert.ok(!existsSync(s.rulesFile));
  assert.deepEqual(readConfig(s.o.configFile).config, CONFIG);
  assert.match(turnOff("claude", s.o).message, /이미 꺼져 있습니다/);
  assert.ok(turnOn("claude", s.o).ok, "on again asks nothing: the settings are there");
});

test("Claude Code: a file at the name that is not banker's is left alone", () => {
  const s = setup();
  mkdirSync(join(s.o.claudeDir, "rules"));
  writeFileSync(s.rulesFile, "# my own rules\n");
  for (const r of [turnOn("claude", s.o, FLAGS), turnOff("claude", s.o)]) {
    assert.equal(r.ok, false);
    assert.match(r.message, /다른 파일/);
  }
  assert.equal(read(s.rulesFile), "# my own rules\n");
});

test("Codex: on adds one block and off gives back the bytes", () => {
  const shapes = { lf: "# my agents\nkeep me\n", "no final break": "# my agents\nkeep me", crlf: "# my agents\r\nkeep me\r\n" };
  for (const [name, original] of Object.entries(shapes)) {
    const s = setup();
    writeFileSync(s.agents, original);
    assert.ok(turnOn("codex", s.o, FLAGS).ok, name);
    const on = read(s.agents);
    assert.equal(blocks(on), 1, name);
    assert.ok(on.startsWith(original), name);
    assert.ok(on.includes("# 파일 확장자 규칙 (banker anti-drm)"), name);
    assert.match(status(s.o).message, /- Codex: 켜짐 \(/, name);
    assert.ok(turnOff("codex", s.o).ok, name);
    assert.equal(read(s.agents), original, name);
    assert.ok(existsSync(`${s.agents}.anti-drm.bak`), name);
  }
});

test("tone-compact's block and ours share AGENTS.md: either goes first, and off takes out only its own", () => {
  for (const first of ["tone", "anti"]) {
    for (const eol of ["\n", "\r\n"]) {
      const s = setup();
      const original = `# base${eol}`;
      writeFileSync(s.agents, original);
      const on = { tone: () => tcOn("codex", s.tc), anti: () => turnOn("codex", s.o, FLAGS) };
      const off = { tone: () => tcOff("codex", s.tc), anti: () => turnOff("codex", s.o) };
      const second = first === "tone" ? "anti" : "tone";
      const label = `${first} first, ${JSON.stringify(eol)}`;
      assert.ok(on[first]().ok && on[second]().ok, label);
      assert.equal(blocks(read(s.agents)) + blocks(read(s.agents), TC_OPEN), 2, label);
      assert.ok(off[first]().ok, label);
      assert.equal(blocks(read(s.agents), first === "tone" ? TC_OPEN : OPEN), 0, `${label}: the first block is gone`);
      assert.equal(blocks(read(s.agents), first === "tone" ? OPEN : TC_OPEN), 1, `${label}: the second block stays`);
      assert.ok(off[second]().ok, label);
      assert.equal(read(s.agents), original, `${label}: the bytes from before`);
    }
  }
});

test("files without a final line break come back byte for byte after two blocks, whichever goes off first", () => {
  const orders = [
    ["tone", "anti", "tone", "anti"],
    ["tone", "anti", "anti", "tone"],
    ["anti", "tone", "anti", "tone"],
    ["anti", "tone", "tone", "anti"],
  ];
  const shapes = [
    { name: "AGENTS.md", agents: "# base", override: null },
    { name: "AGENTS.md with CRLF", agents: "# base\r\nmine", override: null },
    { name: "override with text of its own", agents: "# base\n", override: "# mine\n  " },
  ];
  for (const shape of shapes) {
    for (const [on1, on2, off1, off2] of orders) {
      const s = setup();
      writeFileSync(s.agents, shape.agents);
      if (shape.override !== null) writeFileSync(s.override, shape.override);
      const on = { tone: () => tcOn("codex", s.tc), anti: () => turnOn("codex", s.o, FLAGS) };
      const off = { tone: () => tcOff("codex", s.tc), anti: () => turnOff("codex", s.o) };
      const label = `${shape.name}: on ${on1} ${on2}, off ${off1} ${off2}`;
      assert.ok(on[on1]().ok && on[on2]().ok, label);
      assert.ok(off[off1]().ok && off[off2]().ok, label);
      assert.equal(read(s.agents), shape.agents, label);
      if (shape.override !== null) assert.equal(read(s.override), shape.override, label);
    }
  }
});

test("both blocks survive an omx setup --merge-agents rewrite, and off still takes each out cleanly", () => {
  const s = setup();
  const managed = "<!-- omx:generated:agents-md -->\n# oh-my-codex\nnew guidance\n";
  writeFileSync(s.agents, "<!-- omx:generated:agents-md -->\nold guidance\n");
  assert.ok(tcOn("codex", s.tc).ok && turnOn("codex", s.o, FLAGS).ok);
  writeFileSync(s.agents, omxRewrite(read(s.agents), managed));
  assert.equal(blocks(read(s.agents)), 1);
  assert.equal(blocks(read(s.agents), TC_OPEN), 1);
  assert.match(status(s.o).message, /- Codex: 켜짐 \(/);
  assert.ok(turnOff("codex", s.o).ok && tcOff("codex", s.tc).ok);
  assert.equal(read(s.agents), managed);
});

test("an override holding only tone-compact's block: ours goes to AGENTS.md and says so, until tone-compact's on moves its block", () => {
  const s = setup();
  writeFileSync(s.agents, "# base\n");
  writeFileSync(s.override, "# mine\n");
  assert.ok(tcOn("codex", s.tc).ok);
  writeFileSync(s.override, read(s.override).replace("# mine\n", ""));
  const r = turnOn("codex", s.o, FLAGS);
  assert.ok(r.ok, r.message);
  assert.match(r.message, /다른 banker 블록\(tone-compact\)만 있어 Codex 가 AGENTS.md 를 읽지 않습니다/);
  assert.equal(blocks(read(s.agents)), 1, "ours went to AGENTS.md");
  assert.match(status(s.o).message, /- Codex: 꺼짐, 단 AGENTS.override.md 에 다른 banker 블록\(tone-compact\)만 있어/);
  assert.match(tcStatus(s.tc).message, /- Codex: 켜짐, 단 AGENTS.override.md 에 블록만 있어 AGENTS.md 가 가려짐/);
  assert.ok(tcOn("codex", s.tc).ok, "tone-compact's on moves its block");
  assert.ok(!existsSync(s.override), "the override left empty is removed");
  assert.match(status(s.o).message, /- Codex: 켜짐 \(/);
  assert.ok(turnOff("codex", s.o).ok && tcOff("codex", s.tc).ok);
  assert.equal(read(s.agents), "# base\n");
});

test("config saves the settings and refreshes only the runtimes that hold the rules", () => {
  const s = setup();
  writeFileSync(s.agents, "# base\n");
  turnOn("claude", s.o, FLAGS);
  const r = configure(s.o, { deny: ".txt,.csv", alt: ".md,.tsv", tsv: "comma" });
  assert.ok(r.ok, r.message);
  assert.match(r.message, /설정을 저장했습니다/);
  assert.match(r.message, /Claude Code: 규칙을 지금 설정으로 바꿨습니다/);
  assert.doesNotMatch(r.message, /Codex:/, "Codex held no rules");
  const rules = read(s.rulesFile);
  assert.ok(rules.includes("| `.csv` | `.tsv` |") && !rules.includes("| `.pdf` |"));
  assert.ok(rules.includes("CSV 내용을 그대로 쓰고 확장자만 .tsv"));
  assert.equal(read(s.agents), "# base\n");
  assert.match(status(s.o).message, /TSV 구분자: 쉼표/);
});

test("config with no runtime on only saves, and on later uses the saved settings", () => {
  const s = setup();
  const r = configure(s.o, { deny: ".txt", alt: ".md" });
  assert.ok(r.ok, r.message);
  assert.match(r.message, /켜진 런타임이 없어 규칙은 바꾸지 않았습니다/);
  assert.doesNotMatch(r.message, /적용할 규칙/);
  assert.ok(!existsSync(s.rulesFile));
  assert.ok(turnOn("claude", s.o).ok);
  assert.ok(read(s.rulesFile).includes("| `.txt` | `.md` |"));
});

test("config reports a runtime it could not refresh and fails, with the settings saved", () => {
  const s = setup();
  turnOn("claude", s.o, FLAGS);
  writeFileSync(s.agents, `# base\n${OPEN}\nhalf a block\n`);
  const r = configure(s.o, { deny: ".txt", alt: ".md" });
  assert.equal(r.ok, false);
  assert.match(r.message, /설정을 저장했습니다/);
  assert.match(r.message, /Claude Code: 규칙을 지금 설정으로 바꿨습니다/);
  assert.match(r.message, /짝이 맞지 않아/);
  assert.deepEqual(readConfig(s.o.configFile).config.deny, [".txt"]);
});

test("on with new settings refreshes the other runtime too", () => {
  const s = setup();
  writeFileSync(s.agents, "# base\n");
  turnOn("claude", s.o, FLAGS);
  turnOn("codex", s.o);
  const r = turnOn("claude", s.o, { deny: ".txt", alt: ".md" });
  assert.ok(r.ok, r.message);
  assert.match(r.message, /Codex: 규칙을 지금 설정으로 바꿨습니다/);
  const agents = read(s.agents);
  assert.ok(agents.includes("| `.txt` | `.md` |") && !agents.includes("| `.pdf` |"));
});

test("status: the settings, then both runtimes; settings changed behind its back show as different", () => {
  const s = setup();
  assert.match(status(s.o).message, /^anti-drm 상태\n- 설정: 없음 \(on 이나 config 로 만듦\)\n- Claude Code: 꺼짐/);
  turnOn("claude", s.o, FLAGS);
  const st = status(s.o).message;
  assert.match(st, /- 설정: .*anti-drm\.json\n {2}- 금지 확장자 11개: \.txt \.pdf/);
  assert.match(st, / {2}- 대체 확장자 3개: \.md \.html \.tsv\n {2}- TSV 구분자: 탭/);
  assert.match(st, /- Claude Code: 켜짐 \(/);
  assert.match(st, /- Codex: 꺼짐 \(/);
  writeFileSync(s.o.configFile, JSON.stringify({ deny: [".txt"], alt: [".md"] }));
  assert.match(status(s.o).message, /- Claude Code: 켜짐, 단 규칙이 지금 설정이나 이 버전과 다름 \(on 으로 갱신\)/);
  const r = turnOn("claude", s.o);
  assert.ok(r.ok && /규칙을 지금 설정으로 바꿨습니다/.test(r.message), r.message);
});

test("a broken settings file: status says so, on refuses, config writes a new one", () => {
  const s = setup();
  mkdirSync(join(s.dir, "config", "banker"), { recursive: true });
  writeFileSync(s.o.configFile, "{");
  assert.match(status(s.o).message, /- 설정: 올바르지 않음 \(JSON 이 아닙니다\)/);
  const r = turnOn("claude", s.o);
  assert.equal(r.ok, false);
  assert.match(r.message, /설정 파일이 올바르지 않습니다/);
  assert.ok(configure(s.o, FLAGS).ok);
  assert.deepEqual(readConfig(s.o.configFile).config, CONFIG);
});

test("a settings folder this account cannot write is refused with nothing changed", permTest, () => {
  const s = setup();
  const folder = join(s.dir, "config", "banker");
  mkdirSync(folder, { recursive: true });
  chmodSync(folder, 0o555);
  try {
    const r = configure(s.o, FLAGS);
    assert.equal(r.ok, false);
    assert.match(r.message, /쓸 권한이 없어 설정을 저장하지 못했습니다/);
  } finally {
    chmodSync(folder, 0o755);
  }
  assert.ok(!existsSync(s.o.configFile));
});

test("command line: status by default, usage for anything else", () => {
  const s = setup();
  const st = cli([], cliEnv(s));
  assert.equal(st.code, 0);
  assert.match(st.out, /^anti-drm 상태\n- 설정: 없음/);
  const misuse = [
    ["bogus"],
    ["on", "extra"],
    ["off", "--runtime", "claude", "--deny", ".txt"],
    ["status", "--alt", ".md"],
    ["config", "--deny", ".txt"],
    ["status", "--runtime", "bogus"],
  ];
  for (const args of misuse) {
    const r = cli(args, cliEnv(s));
    assert.equal(r.code, 1, args.join(" "));
    assert.match(r.out, /사용법/, args.join(" "));
  }
  assert.deepEqual(parseArgs(["ON", "--runtime=Codex", "--deny", ".TXT,.csv", "--alt=.md"]), {
    command: "on",
    runtime: "codex",
    flags: { deny: ".TXT,.csv", alt: ".md" },
    extra: [],
    stdin: false,
  });
  assert.equal(parseArgs(["config", "--stdin"]).stdin, true);
});

test("command line: on and off need a runtime unless Claude Code runs them", () => {
  const s = setup();
  const missing = cli(["on", "--deny", ".txt", "--alt", ".md"], cliEnv(s));
  assert.equal(missing.code, 1);
  assert.match(missing.out, /런타임을 정할 수 없습니다/);
  assert.ok(!existsSync(s.o.configFile), "nothing saved before the runtime is known");
  const claude = cli(["on", "--deny", ".txt", "--alt", ".md"], { ...cliEnv(s), CLAUDECODE: "1" });
  assert.equal(claude.code, 0, claude.out);
  assert.ok(existsSync(s.rulesFile), "CLAUDE_CONFIG_DIR decides where the rules file goes");
  assert.ok(existsSync(s.o.configFile), "BANKER_ANTI_DRM_CONFIG decides where the settings go");
});

test("command line: a refusal exits 1, an unexpected error exits 2", () => {
  const s = setup();
  const refused = cli(["on", "--runtime", "codex"], cliEnv(s));
  assert.equal(refused.code, 1);
  assert.match(refused.out, /설정이 없습니다/);
  writeFileSync(s.agents, "# base\n");
  // a folder with something in it where the backup of AGENTS.md goes: renaming the temp file onto it fails
  mkdirSync(join(`${s.agents}.anti-drm.bak`, "x"), { recursive: true });
  const broken = cli(["on", "--runtime", "codex", "--deny", ".txt", "--alt", ".md"], cliEnv(s));
  assert.equal(broken.code, 2, broken.out);
  assert.match(broken.out, /예기치 못한 오류로 중단했습니다/);
});

test("command line: config needs no runtime and prints the rules only when a runtime holds them", () => {
  const s = setup();
  const quiet = cli(["config", "--deny", ".txt", "--alt", ".md"], cliEnv(s));
  assert.equal(quiet.code, 0, quiet.out);
  assert.doesNotMatch(quiet.out, /적용할 규칙/);
  assert.equal(cli(["on", "--runtime", "codex"], cliEnv(s)).code, 0);
  const loud = cli(["config", "--deny", ".csv", "--alt", ".tsv", "--tsv", "comma"], cliEnv(s));
  assert.equal(loud.code, 0, loud.out);
  assert.match(loud.out, /Codex: 규칙을 지금 설정으로 바꿨습니다/);
  assert.match(loud.out, /적용할 규칙:\n# 파일 확장자 규칙/);
});

test("files and folders on creates are not group or world writable, even under umask 002", posixOnly, () => {
  const s = setup();
  const sh = (args) =>
    spawnSync("sh", ["-c", `umask 002 && "${process.execPath}" "${CLI}" ${args}`], {
      encoding: "utf8",
      env: { ...process.env, CLAUDECODE: "", ...cliEnv(s) },
    });
  assert.equal(sh("on --runtime claude --deny .txt --alt .md").status, 0);
  assert.equal(sh("on --runtime codex").status, 0);
  const made = [join(s.o.claudeDir, "rules"), s.rulesFile, s.agents, join(s.dir, "config"), join(s.dir, "config", "banker"), s.o.configFile];
  for (const path of made) assert.equal(statSync(path).mode & 0o022, 0, path);
});

test("hardening: each extension list takes at most 64 entries", () => {
  const many = (n) => Array.from({ length: n }, (_, i) => `.x${i}`);
  assert.ok(checkConfig({ deny: many(64), alt: [".md"] }).config);
  assert.match(checkConfig({ deny: many(65), alt: [".md"] }).error, /금지 확장자는 64개까지 쓸 수 있습니다/);
  assert.match(checkConfig({ deny: [".txt"], alt: many(65) }).error, /대체 확장자는 64개까지 쓸 수 있습니다/);
});

test("hardening: entries that are not strings are refused, and odd values are shown without throwing", () => {
  assert.match(checkConfig({ deny: [".txt", 1], alt: [".md"] }).error, /쓸 수 없는 값입니다: \(number\)/);
  assert.match(checkConfig({ deny: [null], alt: [".md"] }).error, /쓸 수 없는 값입니다: \(object\)/);
  assert.match(checkConfig({ deny: [[".txt"]], alt: [".md"] }).error, /쓸 수 없는 값입니다: \(object\)/);
  assert.match(checkConfig({ deny: [".txt"], alt: [".md"], tsvDelimiter: { toString: 1 } }).error, /TSV 구분자는 tab 이나 comma 여야 합니다: \(object\)/);
  const rlo = String.fromCharCode(0x202e);
  assert.match(checkConfig({ deny: [`.t${rlo}xt`], alt: [".md"] }).error, /쓸 수 없는 값입니다: \.t\?xt$/);
});

test("hardening: the settings path must be a regular file of at most 64 KiB", () => {
  const s = setup();
  mkdirSync(s.o.configFile, { recursive: true }); // a folder where the settings file should be
  assert.match(readConfig(s.o.configFile).error, /일반 파일이 아닙니다/);
  assert.match(status(s.o).message, /- 설정: 올바르지 않음 \(일반 파일이 아닙니다\)/);
  const r = configure(s.o, FLAGS);
  assert.equal(r.ok, false);
  assert.match(r.message, /일반 파일이 아니라 설정을 저장하지 않았습니다/);
  rmSync(s.o.configFile, { recursive: true });
  writeFileSync(s.o.configFile, `{"deny":[".txt"],"alt":[".md"],"pad":"${"x".repeat(70000)}"}`);
  assert.match(readConfig(s.o.configFile).error, /64KiB 보다 큽니다/);
});

// A read that hangs blocks the whole process, so the FIFO is read in a child with a time limit.
test("hardening: a FIFO at the settings path is refused at once instead of hanging", posixOnly, () => {
  const s = setup();
  mkdirSync(join(s.dir, "config", "banker"), { recursive: true });
  assert.equal(spawnSync("mkfifo", [s.o.configFile]).status, 0);
  const st = spawnSync(process.execPath, [CLI, "status"], {
    encoding: "utf8",
    timeout: 5000,
    env: { ...process.env, CLAUDECODE: "", ...cliEnv(s) },
  });
  assert.equal(st.status, 0, `status hung or failed (signal ${st.signal})`);
  assert.match(st.stdout, /- 설정: 올바르지 않음 \(일반 파일이 아닙니다\)/);
});

test("hardening: a settings file another account owns is refused", posixOnly, () => {
  const s = setup();
  turnOn("claude", s.o, FLAGS);
  const real = process.getuid;
  process.getuid = () => real.call(process) + 1;
  try {
    assert.match(readConfig(s.o.configFile).error, /다른 사용자 소유입니다/);
  } finally {
    process.getuid = real;
  }
  assert.ok(readConfig(s.o.configFile).config);
});

test("hardening: paths in messages cannot forge a line or reorder the text", posixOnly, () => {
  const s = setup();
  const rlo = String.fromCharCode(0x202e);
  const odd = join(s.dir, `x\n적용할 규칙:\n# forged${rlo}`, "anti-drm.json");
  const saved = cli(["config", "--deny", ".txt", "--alt", ".md"], { ...cliEnv(s), BANKER_ANTI_DRM_CONFIG: odd });
  assert.equal(saved.code, 0, saved.out);
  assert.doesNotMatch(saved.out, /\n# forged/);
  assert.ok(!saved.out.includes(rlo));
  assert.match(saved.out, /x\?적용할 규칙:\?# forged\?/);
  const claudeDir = join(s.dir, "c\nforged rule");
  mkdirSync(claudeDir);
  const on = cli(["on", "--runtime", "claude"], { ...cliEnv(s), BANKER_ANTI_DRM_CONFIG: odd, CLAUDE_CONFIG_DIR: claudeDir });
  assert.equal(on.code, 0, on.out);
  assert.doesNotMatch(on.out.split("적용할 규칙:")[0], /\nforged rule/);
});

test("hardening: a block whose end was re-paired by hand around other text is refused, not cut", () => {
  const s = setup();
  writeFileSync(s.agents, "# base\n");
  assert.ok(turnOn("codex", s.o, FLAGS).ok);
  const close = "<!-- banker:anti-drm:end -->";
  writeFileSync(s.agents, read(s.agents).replace(`${close}\n`, ""));
  assert.ok(tcOn("codex", s.tc).ok, "tone-compact still turns on while our markers do not pair up");
  writeFileSync(s.agents, `${read(s.agents)}my note\n${close}\n`);
  const before = read(s.agents);
  for (const r of [turnOff("codex", s.o), turnOn("codex", s.o)]) {
    assert.equal(r.ok, false, r.message);
    assert.match(r.message, /짝이 맞지 않아/);
  }
  assert.equal(read(s.agents), before, "the note and tone-compact's block stay");
  assert.match(status(s.o).message, /- Codex: 표시의 짝이 맞지 않음/);
  assert.ok(tcOff("codex", s.tc).ok, "tone-compact's own block still comes out");
  assert.ok(read(s.agents).includes("my note"));
});

test("hardening: a settings folder this account cannot enter is a refusal, not an unexpected error", permTest, () => {
  const s = setup();
  turnOn("claude", s.o, FLAGS);
  const folder = join(s.dir, "config", "banker");
  chmodSync(folder, 0o000);
  try {
    const r = configure(s.o, { deny: ".txt", alt: ".md" });
    assert.equal(r.ok, false);
    assert.match(r.message, /쓸 권한이 없어 설정을 저장하지 못했습니다 \(EACCES\)/);
    const c = cli(["config", "--deny", ".txt", "--alt", ".md"], cliEnv(s));
    assert.equal(c.code, 1, c.out);
  } finally {
    chmodSync(folder, 0o755);
  }
});

test("hardening: a file anti-drm did not write is kept once in .bak, and later saves do not overwrite it", () => {
  const s = setup();
  mkdirSync(join(s.dir, "config", "banker"), { recursive: true });
  writeFileSync(s.o.configFile, '{"theme":"dark"}\n');
  assert.ok(configure(s.o, FLAGS).ok);
  assert.equal(read(`${s.o.configFile}.bak`), '{"theme":"dark"}\n');
  if (process.platform !== "win32") assert.equal(statSync(`${s.o.configFile}.bak`).mode & 0o777, 0o600);
  assert.ok(configure(s.o, { deny: ".txt", alt: ".md" }).ok);
  assert.equal(read(`${s.o.configFile}.bak`), '{"theme":"dark"}\n', "the file from before anti-drm is still there");
  const own = setup();
  assert.ok(turnOn("claude", own.o, FLAGS).ok);
  assert.ok(configure(own.o, { deny: ".txt", alt: ".md" }).ok);
  assert.ok(!existsSync(`${own.o.configFile}.bak`), "anti-drm's own settings need no .bak");
});

test("hardening: a file over 64 KiB at the settings path is not overwritten or copied", () => {
  const s = setup();
  mkdirSync(join(s.dir, "config", "banker"), { recursive: true });
  const big = "x".repeat(70000);
  writeFileSync(s.o.configFile, big);
  const r = configure(s.o, FLAGS);
  assert.equal(r.ok, false);
  assert.match(r.message, /64KiB 보다 큰 파일이라 설정을 저장하지 않았습니다/);
  assert.equal(read(s.o.configFile), big);
  assert.ok(!existsSync(`${s.o.configFile}.bak`));
});

test("hardening: an unreadable settings file is refused with the right words, on exits 1", permTest, () => {
  const s = setup();
  turnOn("claude", s.o, FLAGS);
  chmodSync(s.o.configFile, 0o000);
  try {
    const r = configure(s.o, { deny: ".txt", alt: ".md" });
    assert.equal(r.ok, false);
    assert.match(r.message, /읽을 수 없는 파일이라 설정을 저장하지 않았습니다/);
    assert.match(status(s.o).message, /- 설정: 올바르지 않음 \(읽을 권한이 없습니다\)/);
    const on = cli(["on", "--runtime", "claude"], cliEnv(s));
    assert.equal(on.code, 1, on.out);
  } finally {
    chmodSync(s.o.configFile, 0o644);
  }
});

test("hardening: a settings link that loops is replaced by config, and on refuses it with exit 1", posixOnly, () => {
  const s = setup();
  const folder = join(s.dir, "config", "banker");
  mkdirSync(folder, { recursive: true });
  symlinkSync(join(folder, "loop-b"), s.o.configFile);
  symlinkSync(s.o.configFile, join(folder, "loop-b"));
  assert.match(readConfig(s.o.configFile).error, /일반 파일이 아닙니다/);
  assert.equal(cli(["on", "--runtime", "claude"], cliEnv(s)).code, 1);
  assert.ok(configure(s.o, FLAGS).ok);
  assert.ok(!lstatSync(s.o.configFile).isSymbolicLink());
  assert.deepEqual(readConfig(s.o.configFile).config, CONFIG);
});

test("hardening: root may own the settings when only root can write them", () => {
  assert.equal(ownerTrusted({ uid: 1001, mode: 0o100664 }, 1001), true);
  assert.equal(ownerTrusted({ uid: 0, mode: 0o100644 }, 1001), true);
  assert.equal(ownerTrusted({ uid: 0, mode: 0o100664 }, 1001), false);
  assert.equal(ownerTrusted({ uid: 0, mode: 0o100646 }, 1001), false);
  assert.equal(ownerTrusted({ uid: 2002, mode: 0o100644 }, 1001), false);
});

test("hardening: rules that quote any management marker are refused before they are written", () => {
  const wrap = (body) => `a\n<!-- anti-drm:rules:start -->\n${body}\n<!-- anti-drm:rules:end -->\nb\n`;
  assert.throws(() => templateOf(wrap("{{map}} {{alts}}\nsee <!-- banker:tone-compact:end --> here")), /관리 표시/);
  assert.throws(() => templateOf(wrap("{{map}} {{alts}}\n<!-- USER:OMX:POLICY:START -->")), /관리 표시/);
});

test("hardening: paths lose variation selectors too", () => {
  assert.equal(where(`a${String.fromCharCode(0xfe0f)}b${String.fromCharCode(0x202e)}c`), "a?b?c");
  assert.equal(where("/home/사용자/.config"), "/home/사용자/.config");
});

test("hardening: a settings file that vanishes before it is read leaves nothing to keep", () => {
  const s = setup();
  assert.deepEqual(priorBytes(join(s.dir, "gone", "anti-drm.json")), { bytes: null });
});

test("hardening: settings with a key anti-drm does not write are kept in .bak", () => {
  const s = setup();
  mkdirSync(join(s.dir, "config", "banker"), { recursive: true });
  const mine = '{"deny":[".txt"],"alt":[".md"],"note":"my reminder"}\n';
  writeFileSync(s.o.configFile, mine);
  assert.ok(configure(s.o, FLAGS).ok);
  assert.equal(read(`${s.o.configFile}.bak`), mine);
});

test("hardening: the first file anti-drm did not write stays in .bak, a later one does not replace it", () => {
  const s = setup();
  mkdirSync(join(s.dir, "config", "banker"), { recursive: true });
  writeFileSync(s.o.configFile, '{"theme":"dark"}\n');
  assert.ok(configure(s.o, FLAGS).ok);
  writeFileSync(s.o.configFile, "{\n");
  assert.ok(configure(s.o, FLAGS).ok);
  assert.equal(read(`${s.o.configFile}.bak`), '{"theme":"dark"}\n');
});

test("instruction-toggle.mjs is the same file in tone-compact and anti-drm", () => {
  const here = readFileSync(fileURLToPath(new URL("./instruction-toggle.mjs", import.meta.url)));
  const there = readFileSync(fileURLToPath(new URL("../../tone-compact/scripts/instruction-toggle.mjs", import.meta.url)));
  assert.ok(here.equals(there), "run node scripts/sync-adapter.js");
});

test("while other banker blocks alone fill the override, on says first that Codex does not read ours", () => {
  const s = setup();
  writeFileSync(s.agents, "# base\n");
  writeFileSync(s.override, "# mine\n");
  assert.ok(tcOn("codex", s.tc).ok);
  writeFileSync(s.override, read(s.override).replace("# mine\n", ""));
  const codexLine = (r) => r.message.split("\n").find((l) => l.startsWith("Codex:"));
  const first = turnOn("codex", s.o, FLAGS);
  assert.ok(first.ok, first.message);
  assert.match(codexLine(first), /^Codex: AGENTS\.md 에 넣었지만 지금은 적용되지 않습니다\. /);
  const again = turnOn("codex", s.o);
  assert.match(codexLine(again), /^Codex: 이미 AGENTS\.md 에 있지만 지금은 적용되지 않습니다 \(변경 없음\)\. /);
  assert.match(again.message, /주의: AGENTS\.override\.md 에 다른 banker 블록\(tone-compact\)만 있어/);
});

test("settings file: the TSV delimiter is read in any letter case; other types are refused, null is the default", () => {
  const s = setup();
  mkdirSync(join(s.dir, "config", "banker"), { recursive: true });
  const put = (tsv) => writeFileSync(s.o.configFile, JSON.stringify({ deny: [".txt"], alt: [".md", ".tsv"], tsvDelimiter: tsv }));
  for (const [given, want] of [["Tab", "tab"], ["COMMA", "comma"], [null, "tab"]]) {
    put(given);
    assert.equal(readConfig(s.o.configFile).config?.tsvDelimiter, want, String(given));
  }
  for (const odd of [5, ["tab"]]) {
    put(odd);
    assert.match(readConfig(s.o.configFile).error, /TSV 구분자는 tab 이나 comma 여야 합니다/, JSON.stringify(odd));
  }
  assert.equal(checkConfig({ deny: [".txt"], alt: [".md"], tsvDelimiter: "Comma" }).config.tsvDelimiter, "comma");
});

test("rules: a placeholder left after filling is an error", () => {
  assert.throws(() => renderRules(`${TEMPLATE}\n{{extra}}`, CONFIG), /자리 표시\(\{\{\)가 남았습니다/);
  assert.doesNotThrow(() => renderRules(TEMPLATE, CONFIG));
});

// The command line with something on standard input, in a child process that does not look like Claude Code.
function cliIn(args, input, s) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", input, env: { ...process.env, CLAUDECODE: "", ...cliEnv(s) } });
  return { code: r.status, out: r.stdout };
}

test("--stdin: settings lines from standard input, the way the skill passes them in a quoted heredoc", () => {
  const s = setup();
  const r = cliIn(["config", "--stdin"], `${String.fromCharCode(0xfeff)}deny=.txt, .PDF\r\nalt=.md .tsv\r\n\r\ntsv=Comma`, s);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(readConfig(s.o.configFile).config, { version: 1, deny: [".txt", ".pdf"], alt: [".md", ".tsv"], tsvDelimiter: "comma" });
  const on = cliIn(["on", "--runtime", "claude", "--stdin"], "deny=.hwp\nalt=.md\n", s);
  assert.equal(on.code, 0, on.out);
  assert.deepEqual(readConfig(s.o.configFile).config.deny, [".hwp"]);
  assert.ok(existsSync(s.rulesFile));
});

test("--stdin: unreadable lines, a key twice, too much input, bytes that are not UTF-8 or mixing with flags are refused", () => {
  const s = setup();
  const cases = [
    [["config", "--stdin"], "deny=.txt\nalt=.md\nmode=x\n", /표준 입력의 설정 줄을 읽을 수 없습니다: mode=x/],
    [["config", "--stdin"], "deny=.txt\ndeny=.pdf\nalt=.md\n", /표준 입력의 설정 줄을 읽을 수 없습니다: deny=\.pdf/],
    [["config", "--stdin"], `deny=${".txt,".repeat(20000)}\nalt=.md\n`, /표준 입력이 64KiB 보다 큽니다/],
    [["config", "--stdin"], Buffer.from([0x64, 0x65, 0x6e, 0x79, 0x3d, 0xff, 0x0a]), /표준 입력이 UTF-8 이 아닙니다/],
    [["config", "--stdin"], "", /사용법/],
    [["config", "--stdin", "--deny", ".txt"], "alt=.md\n", /사용법/],
    [["status", "--stdin"], "", /사용법/],
    [["off", "--runtime", "claude", "--stdin"], "", /사용법/],
  ];
  for (const [args, input, want] of cases) {
    const r = cliIn(args, input, s);
    assert.equal(r.code, 1, `${args.join(" ")}: ${r.out}`);
    assert.match(r.out, want, args.join(" "));
  }
  assert.equal(readConfig(s.o.configFile), null, "nothing was saved");
});

test("--stdin: a value with shell syntax is refused as an extension and runs nothing", () => {
  const s = setup();
  const marker = join(s.dir, "ran");
  const r = cliIn(["config", "--stdin"], `deny=.txt,$(touch ${marker})\nalt=.md\n`, s);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /금지 확장자로 쓸 수 없는 값입니다/);
  assert.equal(existsSync(marker), false);
});

test("on with settings that this runtime refuses: the settings stay saved, the result says both, exit 1", () => {
  const s = setup();
  mkdirSync(join(s.o.claudeDir, "rules"), { recursive: true });
  writeFileSync(s.rulesFile, "# someone else's rules\n");
  const r = cli(["on", "--runtime", "claude", "--deny", ".txt", "--alt", ".md"], cliEnv(s));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /설정을 저장했습니다/);
  assert.match(r.out, /같은 이름의 다른 파일이 있어 그대로 두었습니다/);
  assert.deepEqual(readConfig(s.o.configFile).config.deny, [".txt"]);
  assert.equal(read(s.rulesFile), "# someone else's rules\n");
});

test("command line: config exits 1 when a runtime that holds the rules could not be refreshed", () => {
  const s = setup();
  assert.ok(turnOn("claude", s.o, FLAGS).ok);
  writeFileSync(s.agents, `# base\n${OPEN}\nhalf a block\n`);
  const r = cli(["config", "--deny", ".txt", "--alt", ".md"], cliEnv(s));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /설정을 저장했습니다/);
  assert.match(r.out, /짝이 맞지 않아/);
});

test("an override with another skill's start marker but no end counts as the user's text: our block goes there", () => {
  const s = setup();
  writeFileSync(s.agents, "# base\n");
  writeFileSync(s.override, `${TC_OPEN}\nleft by hand\n`);
  const r = turnOn("codex", s.o, FLAGS);
  assert.ok(r.ok, r.message);
  assert.equal(blocks(read(s.override)), 1, "ours went to the override Codex reads");
  assert.equal(blocks(read(s.agents)), 0);
  assert.ok(turnOff("codex", s.o).ok);
  assert.equal(read(s.override), `${TC_OPEN}\nleft by hand\n`);
});

test("the troubleshooting row for a folder or FIFO at an instructions file says not to delete it and to ask first", () => {
  const row = read(SKILL).split("\n").find((l) => l.startsWith("| 일반 파일이 아님 |"));
  assert.ok(row, "the row exists");
  assert.match(row, /지우지 않음/);
  assert.match(row, /물은 뒤/);
  assert.doesNotMatch(row, /치운/);
});

// --stdin used to read all of standard input before checking its size, so input that never ends never ended it.
test("--stdin stops reading once the input passes 64 KiB, so endless input ends at once", async () => {
  const s = setup();
  const child = spawn(process.execPath, [CLI, "config", "--stdin"], { env: { ...process.env, CLAUDECODE: "", ...cliEnv(s) } });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stdin.on("error", () => {});
  const chunk = Buffer.alloc(16 * 1024, "a");
  const feed = setInterval(() => { if (!child.stdin.destroyed) child.stdin.write(chunk); }, 5);
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill(); resolve("timeout"); }, 10000);
    child.on("exit", (c) => { clearTimeout(timer); resolve(c); });
  });
  clearInterval(feed);
  child.stdin.destroy();
  assert.equal(code, 1, out);
  assert.match(out, /표준 입력이 64KiB 보다 큽니다/);
  assert.equal(readConfig(s.o.configFile), null);
});

test("--stdin with no settings line refuses on and config alike instead of falling back to saved settings", () => {
  const s = setup();
  assert.equal(cli(["config", "--deny", ".txt", "--alt", ".md"], cliEnv(s)).code, 0);
  for (const args of [["on", "--runtime", "claude", "--stdin"], ["config", "--stdin"]]) {
    for (const input of ["", "\n \r\n"]) {
      const r = cliIn(args, input, s);
      assert.equal(r.code, 1, `${args.join(" ")}: ${r.out}`);
      assert.match(r.out, /표준 입력에 설정 줄이 없습니다/, args.join(" "));
    }
  }
  assert.equal(existsSync(s.rulesFile), false, "on did not fall back to the saved settings");
  assert.deepEqual(readConfig(s.o.configFile).config.deny, [".txt"]);
});

test("--stdin: spaces around a value are dropped, and the usage says --stdin waits for its input", () => {
  const s = setup();
  const r = cliIn(["config", "--stdin"], "deny= .txt \nalt= .md , .tsv \ntsv= comma  \n", s);
  assert.equal(r.code, 0, r.out);
  assert.equal(readConfig(s.o.configFile).config.tsvDelimiter, "comma");
  assert.match(cli(["bogus"], cliEnv(s)).out, /--stdin 은 표준 입력이 끝날 때까지 기다립니다/);
});

test("tone-compact and anti-drm turned on at the same moment keep both blocks", async () => {
  const TC_CLI = fileURLToPath(new URL("../../tone-compact/scripts/tone-compact.mjs", import.meta.url));
  for (let round = 0; round < 20; round++) {
    const s = setup();
    writeFileSync(s.agents, "# base\n");
    const env = { ...process.env, CLAUDECODE: "", ...cliEnv(s) };
    const runs = [
      [TC_CLI, "on", "--runtime", "codex"],
      [CLI, "on", "--runtime", "codex", "--deny", ".txt", "--alt", ".md"],
    ].map((args) => new Promise((resolve) => spawn(process.execPath, args, { env }).on("exit", resolve)));
    assert.deepEqual(await Promise.all(runs), [0, 0], `round ${round}`);
    const text = read(s.agents);
    assert.equal(blocks(text, TC_OPEN), 1, `round ${round}: tone-compact`);
    assert.equal(blocks(text), 1, `round ${round}: anti-drm`);
  }
});

test("SKILL.md checks each heredoc line before it runs, and no end word can pass that check", () => {
  const text = read(SKILL);
  assert.ok(text.includes("`^(deny|alt|tsv)=[a-z0-9., ]*$`"), "the line check is in SKILL.md");
  const line = /^(deny|alt|tsv)=[a-z0-9., ]*$/;
  for (const end of ["ANTI_DRM_SETTINGS", "'@"]) assert.equal(line.test(end), false, end);
  const doc = /<<'ANTI_DRM_SETTINGS'\n([\s\S]*?)\n\s*ANTI_DRM_SETTINGS\n/.exec(text);
  assert.ok(doc, "the heredoc example is there");
  for (const l of doc[1].split("\n").map((x) => x.trim())) assert.match(l, line, l);
});

// Rows that send the agent at a user's file must ask first; none may tell it to clear one away.
const ASK_FIRST = ["설정 파일이 올바르지 않습니다", "일반 파일이 아니라 설정을 저장하지 않았습니다", "64KiB 보다 큰 파일이라",
  "같은 이름의 다른 파일이 있음", "표시의 짝이 맞지 않음", "끊어진 링크라", "일반 파일이 아님"];
test("troubleshooting rows never tell the agent to clear, delete, move or rename a user's file without asking first", () => {
  const table = read(SKILL).split("## 문제 해결")[1].split("\n## ")[0];
  const rows = table.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| 메시지"));
  for (const row of rows) assert.doesNotMatch(row, /치우|치운|치움|이름 변경 또는 삭제|지운 뒤 다시|옮긴 뒤 다시/, row);
  for (const head of ASK_FIRST) {
    const row = rows.find((l) => l.startsWith(`| ${head}`));
    assert.ok(row, head);
    assert.match(row, /물은 뒤/, row);
  }
});

test("while other banker blocks alone fill the override, the stale and moved cases also say first that Codex does not read ours", () => {
  const codexLine = (r) => r.message.split("\n").find((l) => l.startsWith("Codex:"));
  const stale = setup();
  writeFileSync(stale.agents, "# base\n");
  writeFileSync(stale.override, "# mine\n");
  assert.ok(tcOn("codex", stale.tc).ok);
  writeFileSync(stale.override, read(stale.override).replace("# mine\n", ""));
  assert.ok(turnOn("codex", stale.o, FLAGS).ok);
  writeFileSync(stale.agents, read(stale.agents).replace("`.pdf`", "`.pdx`"));
  const r1 = turnOn("codex", stale.o);
  assert.match(codexLine(r1), /^Codex: AGENTS\.md 에 넣었지만 지금은 적용되지 않습니다\. /, r1.message);
  const moved = setup();
  writeFileSync(moved.agents, "# base\n");
  writeFileSync(moved.override, "# mine\n");
  assert.ok(tcOn("codex", moved.tc).ok);
  assert.ok(turnOn("codex", moved.o, FLAGS).ok);
  writeFileSync(moved.override, read(moved.override).replace("# mine\n", ""));
  const r2 = turnOn("codex", moved.o);
  assert.match(codexLine(r2), /^Codex: AGENTS\.md 에 넣었지만 지금은 적용되지 않습니다\. /, r2.message);
  assert.equal(blocks(read(moved.agents)), 1, "ours moved to AGENTS.md");
  assert.equal(blocks(read(moved.override)), 0);
});
