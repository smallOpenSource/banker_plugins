// Tests for ../assets/omc-hud-custom.mjs (the statusline wrapper). Run from the repo root:
// node --test skills/setup-omc-hud/scripts/*.test.mjs
// Each render copies the wrapper into a temp hud/ folder next to a fake omc-hud.mjs that prints a fixed
// OMC output, the way OMC 5.7.4 lays it out (captured from a real render on 2026-10-19).
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { turnOn } from "../../payload-mon/scripts/payload-mon.mjs";

const ASSETS = fileURLToPath(new URL("../assets/", import.meta.url));
const WRAPPER = readFileSync(join(ASSETS, "omc-hud-custom.mjs"));
const root = mkdtempSync(join(tmpdir(), "omc-hud-custom-test-"));
after(() => rmSync(root, { recursive: true, force: true }));

// Stands in for omc-hud.mjs: like the real loader it prints on import, with no export.
const FAKE_OMC = 'import { readFileSync } from "node:fs";\n' +
  'process.stdout.write(readFileSync(new URL("./omc-out.txt", import.meta.url), "utf8"));\n';
// Stands in for payload-mon's module copy; the size comes from PL_BYTES.
const FAKE_PAYLOAD = [
  "export const REQUEST_LIMIT_BYTES = 32 * 1024 * 1024;",
  "export const estimatePayloadBytes = () => Number(process.env.PL_BYTES);",
  "export const payloadSegment = (b) => b >= 8 * 1024 * 1024 ?",
  "  `payload:${Math.floor((b / REQUEST_LIMIT_BYTES) * 100)}%/${(b / 1048576).toFixed(1)}MB` : '';",
  "",
].join("\n");

const PATH_LINE = "/home/u/proj | branch:main";
const AGENT_LINE = "└─ E Explore      28m  find files (t14)";
const HINTS = [
  "[!] omc 5.7.5 - paste: ! claude plugin marketplace update omc && claude plugin update oh-my-claudecode@omc",
  "[!] claude 2.1.302 - paste: ! claude update",
];
const PARTS = {
  notice: "\x1b[1m[Claude#2.1.300] -> 2.1.302 claude update\x1b[22m",
  model: "Model: Opus 5.5",
  effort: "effort:high",
  rates: "5h:8%(1h23m) wk:96%(1h23m) fable:0%(1h31m)",
  think: "think",
  session: "session:42m",
  ctx: "ctx:12%",
  agents: "agents:1",
  counts: "🔧14 🤖1 ⚡3",
};
// OMC's two lines, with some parts replaced (a string) or left out (null).
function omcOut(over = {}, below = [AGENT_LINE, ...HINTS]) {
  const parts = Object.entries({ ...PARTS, ...over }).filter(([, v]) => v !== null).map(([, v]) => v);
  return [PATH_LINE, ["\x1b[2m[OMC#5.7.4L]\x1b[0m", ...parts].join(" | "), ...below].join("\n") + "\n";
}

let seq = 0;
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
// Renders once. `stdin` is the statusline JSON; `env` adds to (or with null removes from) the base env.
function renderWith({ omc = omcOut(), stdin = { effort: { level: "high" } }, env = {}, payloadBytes, hud } = {}) {
  const dir = join(root, `r-${++seq}`);
  const hudDir = hud || join(dir, "hud");
  mkdirSync(hudDir, { recursive: true });
  if (!hud) writeFileSync(join(hudDir, "omc-hud-custom.mjs"), WRAPPER);
  writeFileSync(join(hudDir, "omc-hud.mjs"), FAKE_OMC);
  writeFileSync(join(hudDir, "omc-out.txt"), omc);
  const input = { ...stdin };
  if (payloadBytes !== undefined) {
    mkdirSync(join(hudDir, "payload-mon"), { recursive: true });
    if (!hud) writeFileSync(join(hudDir, "payload-mon", "payload-size.mjs"), FAKE_PAYLOAD);
    input.transcript_path = join(dir, "t.jsonl");
  }
  const cfg = join(dir, "cfg");
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "user@example.com" } }));
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(COLUMNS|CLAUDE_CONFIG_DIR)$/i.test(k)));
  const merged = { ...base, CLAUDE_CONFIG_DIR: cfg, PL_BYTES: String(payloadBytes ?? 0), ...env };
  for (const [k, v] of Object.entries(env)) if (v === null) delete merged[k];
  const r = spawnSync(process.execPath, [join(hudDir, "omc-hud-custom.mjs")], {
    input: JSON.stringify(input), env: merged, encoding: "utf8", timeout: 30000,
  });
  return r.stdout;
}
const firstLine = (out) => plain(out).split("\n")[0];

test("OMC 출력이 다 있으면 첫 줄이 요청한 순서", () => {
  const out = renderWith({ payloadBytes: 0.5 * 1024 * 1024 });
  assert.equal(
    firstLine(out),
    "Op5.5/high|5h:8%/1h23m|wk:96%/1h23m|Fa:0%/1h31m|think|PL:0.5M|se:0.7h|ctx:12%|🤖1|🔧14|⚡3|agents:1|/home/u/proj|user|main|claude2.1.300→2.1.302",
  );
});

test("횟수 칸은 에이전트, 툴, 스킬 순서이고 0 인 칸은 없음", () => {
  const counts = (c) => firstLine(renderWith({ omc: omcOut({ counts: c, agents: null }) })).split("|ctx:12%|")[1].split("|/home")[0];
  assert.equal(counts("🔧14 🤖1 ⚡3"), "🤖1|🔧14|⚡3");
  assert.equal(counts("🔧14 ⚡3"), "🔧14|⚡3");
  assert.equal(counts("🔧14"), "🔧14");
  assert.equal(counts("T:14 A:1 S:3"), "A:1|T:14|S:3");
});

test("ctx 는 se 와 횟수 사이에 두고 COMPRESS?, CRITICAL 글자를 뺌", () => {
  const ctxOf = (c) => {
    const out = renderWith({ omc: omcOut({ ctx: c }) });
    assert.match(plain(out).split("\n")[0], /\|se:0\.7h\|ctx:\d+%\|🤖1\|/);
    return out.split("\n")[0].split("\x1b[2m|\x1b[0m").find((s) => plain(s).startsWith("ctx:"));
  };
  assert.equal(ctxOf("ctx:82% COMPRESS?"), "ctx:\x1b[33m82%\x1b[0m");
  assert.equal(ctxOf("ctx:90% CRITICAL"), "ctx:\x1b[38;5;213m90%\x1b[0m");
  assert.equal(ctxOf("ctx:69%"), "ctx:\x1b[32m69%\x1b[0m");
  assert.equal(ctxOf("ctx:70%"), "ctx:\x1b[33m70%\x1b[0m");
  assert.equal(ctxOf("ctx:85%"), "ctx:\x1b[38;5;213m85%\x1b[0m");
  assert.ok(renderWith().includes("wk:\x1b[38;5;213m96%\x1b[0m"), "rates use the same scale");
});

test("ctx 가 없으면 칸도 없음", () => {
  assert.doesNotMatch(firstLine(renderWith({ omc: omcOut({ ctx: null }) })), /ctx:/);
});

// Columns a terminal gives the text: ANSI none, the emoji and CJK here two.
const width = (s) => [...plain(s)].reduce((w, ch) => {
  const c = ch.codePointAt(0);
  return w + (c >= 0x1f300 || c === 0x26a1 || (c >= 0xac00 && c <= 0xd7a3) ? 2 : 1);
}, 0);

test("폭을 받으면 칸 사이에서 접고 말줄임으로 자르지 않음", () => {
  const whole = firstLine(renderWith());
  const out = renderWith({ env: { COLUMNS: "60" } });
  const rows = out.split("\n").filter(Boolean);
  const wrapped = rows.slice(0, rows.length - 1); // the agent line comes last
  assert.ok(wrapped.length > 1, out);
  for (const row of wrapped) {
    const single = !plain(row).includes("|");
    assert.ok(single || width(row) <= 56, `${width(row)} > 56: ${plain(row)}`);
  }
  assert.equal(wrapped.map(plain).join("|"), whole);
  assert.doesNotMatch(out, /…/);
  assert.equal(plain(rows[rows.length - 1]), AGENT_LINE);
});

test("상세 줄은 남기고 OMC 갱신 안내 두 줄은 뺌", () => {
  const lines = plain(renderWith()).split("\n").filter(Boolean);
  assert.deepEqual(lines.slice(1), [AGENT_LINE]);
});

test("OMC 출력이 없으면 [OMC HUD] no output 한 줄", () => {
  assert.equal(renderWith({ omc: "\n" }), "[OMC HUD] no output\n");
});

test("OMC 줄이 없으면 원문을 그대로 냄", () => {
  assert.equal(renderWith({ omc: "something else\n" }), "something else\n");
});

test("모르는 칸은 흐리게 횟수와 경로 사이에 남음", () => {
  const out = renderWith({ omc: omcOut({ agents: "todo:2/5" }) });
  assert.match(firstLine(out), /\|⚡3\|todo:2\/5\|\/home\/u\/proj\|/);
  assert.ok(out.includes("\x1b[2mtodo:2/5\x1b[0m"));
});

test("payload-mon 블록이 있어도 PL 하나만 나옴", () => {
  const hud = join(root, `pm-${++seq}`, "hud");
  mkdirSync(hud, { recursive: true });
  writeFileSync(join(hud, "omc-hud-custom.mjs"), WRAPPER);
  const source = join(root, `pm-src-${seq}.mjs`);
  writeFileSync(source, FAKE_PAYLOAD);
  const on = turnOn({ hudFile: join(hud, "omc-hud-custom.mjs"), moduleSource: source, settingsFile: join(hud, "none.json") });
  assert.ok(on.ok, on.message);
  assert.ok(readFileSync(join(hud, "omc-hud-custom.mjs"), "utf8").includes("// >>> payload-mon >>>"));
  const line = firstLine(renderWith({ hud, payloadBytes: 9 * 1024 * 1024 }));
  assert.match(line, /\|PL:9\.0M\|se:0\.7h\|/);
  assert.doesNotMatch(line, /payload:/);
});

test("계정은 CLAUDE_CONFIG_DIR 의 .claude.json, 없으면 홈의 .claude.json", () => {
  assert.match(firstLine(renderWith()), /\|user\|main\|/);
  const home = join(root, `home-${++seq}`);
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "home@example.com" } }));
  const line = firstLine(renderWith({ env: { CLAUDE_CONFIG_DIR: null, HOME: home, USERPROFILE: home } }));
  assert.match(line, /\|home\|main\|/);
});

test("모르는 모델 id 에도 effort 를 붙임", () => {
  assert.match(firstLine(renderWith({ omc: omcOut({ model: "Model: claude-x-5" }) })), /^claude-x-5\/high\|/);
});

test("버전 태그 없는 갱신 안내는 claude→<new>", () => {
  const line = firstLine(renderWith({ omc: omcOut({ notice: "[Claude] -> 2.1.302 claude update" }) }));
  assert.match(line, /\|claude→2\.1\.302$/);
});

test("stdin 에 effort 가 없으면 OMC 의 effort 칸에서 가져옴", () => {
  const line = firstLine(renderWith({ omc: omcOut({ effort: "effort:max" }), stdin: {} }));
  assert.match(line, /^Op5\.5\/max\|/);
  assert.doesNotMatch(line, /effort:/);
});

test("래퍼에 절대경로가 없음", () => {
  // A drive letter stands alone: "Model:/" in a regex is not one.
  assert.doesNotMatch(WRAPPER.toString("utf8"), /\/home\/|\/Users\/|(?<![A-Za-z0-9])[A-Za-z]:[\\/]/);
});
