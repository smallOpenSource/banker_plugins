// Tests for codex-gate.mjs. Run from the repo root: node --test skills/smart-compact/scripts/*.test.mjs
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { decide, hookCommand, lastUsage, paths, status, turnOff, turnOn } from "./codex-gate.mjs";

const CLI = fileURLToPath(new URL("./codex-gate.mjs", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "codex-gate-test-"));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const home = () => {
  const d = join(root, `h${n++}`);
  mkdirSync(d);
  return paths({ CODEX_HOME: d });
};
const posix = { skip: process.platform === "win32" && "POSIX modes, FIFOs and shells" };
const asRoot = typeof process.getuid === "function" && process.getuid() === 0;

// Records the shape Codex 0.144.5 writes: a session_meta, then token_count events, the first with info null.
const meta = { timestamp: "t", type: "session_meta", payload: { id: "s" } };
const count = (used, win = 200000) => ({
  timestamp: "t", type: "event_msg",
  payload: { type: "token_count", info: { total_token_usage: { total_tokens: used * 3 },
    last_token_usage: { input_tokens: used - 5, output_tokens: 5, total_tokens: used }, model_context_window: win } },
});
const empty = { timestamp: "t", type: "event_msg", payload: { type: "token_count", info: null } };
function rollout(records) {
  const f = join(root, `r${n++}.jsonl`);
  writeFileSync(f, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
  return f;
}
const filler = (k, size) => Array.from({ length: k }, () => ({ type: "response_item", payload: { text: "y".repeat(size) } }));

test("the last token_count with usage counts, not the session total or an empty one", () => {
  assert.deepEqual(lastUsage(rollout([meta, empty, count(1000), count(30000), empty])), { used: 30000, window: 200000 });
  assert.equal(lastUsage(rollout([meta, empty])), null);
  assert.equal(lastUsage(rollout([meta, { type: "event_msg", payload: { type: "token_count", info: {} } }])), null);
});

test("a token_count far from the end is found after the first tail read", () => {
  assert.deepEqual(lastUsage(rollout([meta, count(7000), ...filler(2000, 600)])), { used: 7000, window: 200000 });
});

test("a record longer than the first tail read is read whole", () => {
  const long = { pad: "z".repeat(400000), ...count(12345) };
  assert.equal(lastUsage(rollout([meta, count(1000), long])).used, 12345);
});

// In a child with a time limit: a loop that never reaches the cap would block this process's timers too.
test("reading stops at the cap instead of the whole file", () => {
  const f = rollout([meta, count(7000), ...filler(3000, 1000)]);
  const probe = `import(${JSON.stringify(new URL("./codex-gate.mjs", import.meta.url).href)}).then((m) => `
    + `console.log(JSON.stringify([m.lastUsage(${JSON.stringify(f)}, 1 << 20), m.lastUsage(${JSON.stringify(f)})])))`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", probe], { encoding: "utf8", timeout: 10000 });
  assert.equal(r.error, undefined, "finished within 10 s");
  const [capped, full] = JSON.parse(r.stdout);
  assert.equal(capped, null, "3 MB without a token_count at the end, 1 MB cap");
  assert.equal(full.used, 7000, "the default cap reaches it");
});

test("a FIFO in place of the rollout is not opened", { ...posix, timeout: 10000 }, () => {
  const f = join(root, `fifo${n++}`);
  if (spawnSync("mkfifo", [f]).status !== 0) return;
  const t0 = Date.now();
  assert.equal(lastUsage(f), null);
  assert.ok(Date.now() - t0 < 2000);
});

test("the hook speaks once per session at the threshold and again after the use drops", () => {
  const cfg = { threshold: 50 };
  const high = { session_id: "a", transcript_path: rollout([meta, count(100000)]) };
  const low = { session_id: "a", transcript_path: rollout([meta, count(20000)]) };
  let state = {};
  let r = decide(high, cfg, state);
  assert.match(r.text, /컨텍스트 사용률 50% \(임계 50%\)/);
  assert.match(r.text, /\$banker-append_wiki/);
  assert.match(r.text, /\$banker-ready-compact/);
  state = r.state;
  assert.equal(decide(high, cfg, state).text, "", "said once while the use stays high");
  assert.equal(decide(low, cfg, state).text, "", "below the threshold: silent");
  assert.ok(!("a" in state), "and the session may be told again");
  assert.notEqual(decide(high, cfg, state).text, "");
});

test("the hook stays silent unarmed, on odd input, or with no usage yet", () => {
  const f = rollout([meta, count(190000)]);
  assert.equal(decide({ session_id: "a", transcript_path: f }, null, {}).text, "");
  assert.equal(decide({ transcript_path: f }, { threshold: 50 }, {}).text, "");
  assert.equal(decide({ session_id: "a", transcript_path: rollout([meta, empty]) }, { threshold: 50 }, {}).text, "");
});

test("the state keeps the latest 50 sessions", () => {
  const f = rollout([meta, count(150000)]);
  const state = {};
  for (let i = 0; i < 60; i++) state[`old${i}`] = i + 1;
  const r = decide({ session_id: "new", transcript_path: f }, { threshold: 50 }, state);
  assert.equal(Object.keys(r.state).length, 50);
  assert.ok("new" in r.state && !("old0" in r.state));
});

const omx = { type: "command", command: "\"/n/node\" \"/omx/codex-native-hook.js\"" };
function seed(p, extra = []) {
  writeFileSync(p.hooks, JSON.stringify({ hooks: { SessionStart: [{ hooks: [omx] }], UserPromptSubmit: [{ hooks: [omx] }, ...extra] } }));
}
const read = (f) => JSON.parse(readFileSync(f, "utf8"));
const ups = (p) => read(p.hooks).hooks.UserPromptSubmit;

test("on copies the hook into CODEX_HOME and appends one group pointing at the copy", () => {
  const p = home();
  seed(p);
  const before = readFileSync(p.hooks, "utf8");
  const r = turnOn(p, 40);
  assert.equal(r.code, 0);
  assert.match(r.msg, /Hooks need review/);
  const groups = ups(p);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].hooks[0], omx, "OMX keeps index 0, so its trust record still matches");
  assert.ok(groups[1].hooks[0].command.endsWith(`"${p.copy}" hook`));
  assert.equal(groups[1].hooks[0].timeout, 5);
  assert.deepEqual(readFileSync(p.copy), readFileSync(CLI), "the hook runs from a copy outside any workspace");
  assert.deepEqual(read(p.hooks).hooks.SessionStart, [{ hooks: [omx] }]);
  assert.equal(readFileSync(p.backup, "utf8"), before);
  assert.deepEqual(read(p.config), { threshold: 40 });
});

test("on again moves only the threshold; a stale command is fixed in place", () => {
  const p = home();
  seed(p);
  turnOn(p, 40);
  const r = turnOn(p, 60);
  assert.match(r.msg, /훅은 이미 있음/);
  assert.equal(ups(p).length, 2, "no second group");
  assert.deepEqual(read(p.config), { threshold: 60 });
  assert.match(status(p).msg, /켜짐\(임계 60%\)/);
  const doc = read(p.hooks);
  doc.hooks.UserPromptSubmit[1].hooks[0].command = `"/old/node" "${p.copy}" hook`;
  writeFileSync(p.hooks, JSON.stringify(doc));
  assert.match(status(p).msg, /이 판과 다름.*on 을 다시 실행/);
  assert.match(turnOn(p, 60).msg, /훅 명령을 고쳤습니다/);
  assert.equal(ups(p).length, 2, "fixed at the same index");
  assert.ok(ups(p)[1].hooks[0].command.endsWith(`"${p.copy}" hook`));
  writeFileSync(p.copy, "// an older copy\n");
  assert.match(status(p).msg, /이 판과 다름/);
  turnOn(p, 60);
  assert.deepEqual(readFileSync(p.copy), readFileSync(CLI), "on refreshes the copy");
});

test("off takes out only its own handler, keeps a shared group, and backs up first", () => {
  const p = home();
  seed(p);
  turnOn(p, 50);
  const doc = read(p.hooks);
  doc.hooks.UserPromptSubmit[1].hooks.push({ type: "command", command: "/usr/bin/other-hook" });
  writeFileSync(p.hooks, JSON.stringify(doc));
  writeFileSync(p.state, "{}");
  const before = readFileSync(p.hooks, "utf8");
  assert.equal(turnOff(p).msg, "껐습니다");
  assert.deepEqual(ups(p), [{ hooks: [omx] }, { hooks: [{ type: "command", command: "/usr/bin/other-hook" }] }]);
  assert.equal(readFileSync(p.backup, "utf8"), before);
  assert.ok(![p.config, p.state, p.copy].some(existsSync));
  assert.equal(status(p).msg, "꺼짐");
});

test("off removes an emptied group and says when later groups move up", () => {
  const p = home();
  seed(p);
  turnOn(p, 50);
  const doc = read(p.hooks);
  doc.hooks.UserPromptSubmit.push({ hooks: [{ type: "command", command: "/usr/bin/later" }] });
  writeFileSync(p.hooks, JSON.stringify(doc));
  assert.match(turnOff(p).msg, /다시 신뢰해야 할 수 있습니다/);
  assert.equal(ups(p).length, 2);
  const q = home();
  turnOn(q, 50);
  turnOff(q);
  assert.equal(read(q.hooks).hooks.UserPromptSubmit, undefined, "an event left empty is removed");
});

test("status tells a hook that another tool dropped, and why hooks.json cannot be read", () => {
  const p = home();
  seed(p);
  turnOn(p, 50);
  seed(p);
  assert.match(status(p).msg, /훅이 없음/);
  writeFileSync(p.hooks, "not json");
  assert.match(status(p).msg, /hooks\.json 을 읽지 못함: .*JSON 객체가 아님/);
});

test("bad thresholds and hooks files of the wrong shape change nothing", () => {
  const p = home();
  for (const t of [0, 96, 50.5, NaN]) assert.equal(turnOn(p, t).code, 1, String(t));
  for (const body of ["[]", "{\"hooks\":[]}", "{\"hooks\":{\"UserPromptSubmit\":{\"a\":1}}}"]) {
    writeFileSync(p.hooks, body);
    assert.equal(turnOn(p, 50).code, 1, body);
    assert.equal(readFileSync(p.hooks, "utf8"), body);
  }
  assert.ok(!existsSync(p.config) && !existsSync(p.copy));
});

test("a hooks.json that cannot be checked is not taken for a missing one", posix, (t) => {
  if (asRoot) return t.skip("root reads past mode bits");
  const p = home();
  seed(p);
  chmodSync(p.home, 0o000);
  try {
    assert.match(turnOn(p, 50).msg, /확인하지 못함\(EACCES\)/);
  } finally {
    chmodSync(p.home, 0o755);
  }
  assert.equal(ups(p).length, 1);
});

function canLink() {
  const a = join(root, `la${n++}`);
  writeFileSync(a, "");
  try {
    symlinkSync(a, `${a}-l`);
    return true;
  } catch {
    return false;
  }
}

test("links in place of hooks.json or its backup are not written through", (t) => {
  if (!canLink()) return t.skip("this account cannot make file links");
  const p = home();
  const real = join(root, `real${n++}.json`);
  writeFileSync(real, "{\"hooks\":{}}");
  symlinkSync(real, p.hooks);
  assert.equal(turnOn(p, 50).code, 1);
  assert.equal(readFileSync(real, "utf8"), "{\"hooks\":{}}");
  const q = home();
  seed(q);
  const victim = join(root, `victim${n++}`);
  writeFileSync(victim, "keep");
  symlinkSync(victim, q.backup);
  assert.equal(turnOn(q, 50).code, 0);
  assert.equal(readFileSync(victim, "utf8"), "keep");
  assert.ok(lstatSync(q.backup).isFile());
});

test("rewriting hooks.json keeps its mode", posix, () => {
  const p = home();
  seed(p);
  chmodSync(p.hooks, 0o600);
  turnOn(p, 50);
  assert.equal(statSync(p.hooks).mode & 0o777, 0o600);
});

test("the hook command quotes for the platform shell and refuses unsafe paths", () => {
  const cwd = "/work/repo";
  assert.equal(hookCommand("/n/node", "/h/.codex/hooks-custom/g.mjs", false, cwd), "\"/n/node\" \"/h/.codex/hooks-custom/g.mjs\" hook");
  for (const bad of ["/a$HOME/x.mjs", "/a`x`/x.mjs", "/a\"b/x.mjs", "/a\\b/x.mjs", "/a\nb/x.mjs"]) {
    assert.equal(hookCommand("/n/node", bad, false, cwd), null, JSON.stringify(bad));
  }
  assert.equal(hookCommand("/work/repo/bin/node", "/h/g.mjs", false, cwd), null, "a node inside the workspace");
  assert.equal(hookCommand(join(tmpdir(), "node"), "/h/g.mjs", false, cwd), null, "a node in the temp folder");
  assert.equal(hookCommand("C:\\Program Files\\nodejs\\node.exe", "C:\\Users\\o'k\\.codex\\g.mjs", true, "D:\\w"),
    "& 'C:\\Program Files\\nodejs\\node.exe' 'C:\\Users\\o''k\\.codex\\g.mjs' hook", "PowerShell call operator, a quote doubled");
});

function cli(p, args, input) {
  return spawnSync(process.execPath, [CLI, ...args], {
    input, encoding: "utf8", env: { ...process.env, CODEX_HOME: p.home },
  });
}

test("the hook command prints the Codex hook output once, then nothing", () => {
  const p = home();
  assert.equal(cli(p, ["on", "--threshold=30"]).status, 0);
  assert.deepEqual(read(p.config), { threshold: 30 });
  const input = JSON.stringify({ session_id: "s1", transcript_path: rollout([meta, count(90000)]), hook_event_name: "UserPromptSubmit" });
  const first = spawnSync(process.execPath, [p.copy, "hook"], { input, encoding: "utf8", env: { ...process.env, CODEX_HOME: p.home } });
  assert.equal(first.status, 0);
  const out = JSON.parse(first.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(out.hookSpecificOutput.additionalContext, /사용률 45% \(임계 30%\)/);
  const second = cli(p, ["hook"], input);
  assert.deepEqual([second.status, second.stdout], [0, ""]);
});

test("the hook exits 0 silently on input it cannot use", () => {
  const p = home();
  cli(p, ["on"]);
  for (const input of ["", "not json", "{}", JSON.stringify({ session_id: "s", transcript_path: join(root, "missing") })]) {
    const r = cli(p, ["hook"], input);
    assert.deepEqual([r.status, r.stdout], [0, ""], input);
  }
});

test("usage and the command line answer with exit codes", () => {
  const p = home();
  const u = cli(p, ["usage", rollout([meta, count(50000)])]);
  assert.equal(u.status, 0);
  assert.match(u.stdout, /25% \(50000 \/ 200000 토큰\)/);
  assert.equal(cli(p, ["usage", rollout([meta])]).status, 1);
  for (const args of [["bogus"], ["on", "--threshold", "x"], ["on", "--treshold", "40"], ["on", "40"], ["off", "now"]]) {
    assert.equal(cli(p, args).status, 1, args.join(" "));
  }
  assert.ok(!existsSync(p.config), "a mistyped on arms nothing");
  assert.match(cli(p, []).stdout, /꺼짐/);
});
