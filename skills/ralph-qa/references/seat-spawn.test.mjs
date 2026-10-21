// Tests for seat-spawn.mjs: how the ralph-qa runner finds a seat CLI, quotes its words for cmd.exe
// and runs it inside its time limit with every process it started ended when it returns.
// The seats are the fake CLIs of scripts/test-fixtures/seat-stub.mjs; no real CLI starts.
// Run from the repo root: node --test skills/ralph-qa/references/seat-spawn.test.mjs
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { cmdLine, runLimited, stopAll, which } from "./seat-spawn.mjs";
import { stubBin } from "../../../scripts/test-fixtures/seat-stub.mjs";

const WIN = process.platform === "win32";
const SOURCE = fileURLToPath(new URL("./seat-spawn.mjs", import.meta.url));

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), "rq-spawn-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, "log");
  mkdirSync(log);
  return { dir, log, bin: stubBin(join(dir, "bin")), out: join(dir, "out.md"), err: join(dir, "err.md") };
}

// A seat's env here: the stub's folder alone on PATH, a temp home, the record folder.
const seatEnv = (ctx, extra = {}) => ({
  PATH: ctx.bin, HOME: join(ctx.dir, "home"), USERPROFILE: join(ctx.dir, "home"),
  ...(WIN ? { SystemRoot: process.env.SystemRoot } : {}), RQ_STUB_LOG: ctx.log, ...extra,
});
const stub = (ctx, name = "gemini") => which(name, { env: { PATH: ctx.bin } });

const recordOf = (ctx, name) => {
  const f = readdirSync(ctx.log).find((x) => new RegExp(`^${name}-\\d+\\.md$`).test(x));
  return f ? JSON.parse(readFileSync(join(ctx.log, f), "utf8")) : null;
};
const pidsOf = (ctx, name) => readdirSync(ctx.log).filter((f) => f.startsWith(`${name}-`) && f.endsWith("-pids.md"))
  .flatMap((f) => readFileSync(join(ctx.log, f), "utf8").split("\n").filter(Boolean).map(Number));

// Alive and not a zombie (one whose parent has not reaped it yet is gone for these tests).
function alive(pid) {
  try {
    process.kill(pid, 0);
  } catch (e) {
    return e.code === "EPERM";
  }
  if (process.platform !== "linux") return true;
  try {
    return !/^\d+ \(.*\) Z/s.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return false;
  }
}
async function gone(pids, ms = 3000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) {
    if (!pids.some(alive)) return true;
  }
  return !pids.some(alive);
}
const killAll = (pids) => pids.forEach((p) => {
  try {
    process.kill(p, "SIGKILL");
  } catch {
    /* gone */
  }
});

test("a seat reads its payload from the file it is given on stdin, byte for byte, with no shell in between", async (t) => {
  const ctx = scratch(t);
  const payload = join(ctx.dir, "prompt.md");
  const bytes = Buffer.from(`<review-data id="ab12">\nRALPHQA_ab12\n'@\n$(touch "${join(ctx.dir, "INJECTED")}")\n`
    + `\`touch "${join(ctx.dir, "INJECTED2")}"\`\n한글 줄\r\n%PATH% !x! ^& no newline at the end`);
  writeFileSync(payload, bytes);
  const r = await runLimited({ exe: stub(ctx), args: ["-p", "x"], cwd: ctx.dir, env: seatEnv(ctx), stdin: payload, stdout: ctx.out, stderr: ctx.err, limitMs: 60000 });
  assert.equal(r.exit, 0, readFileSync(ctx.err, "utf8"));
  const rec = recordOf(ctx, "gemini");
  assert.ok(readFileSync(join(ctx.log, `gemini-${rec.pid}-stdin.md`)).equals(bytes), "the seat got the file's bytes");
  assert.ok(!existsSync(join(ctx.dir, "INJECTED")) && !existsSync(join(ctx.dir, "INJECTED2")), "nothing in the payload ran");
});

test("stdout and stderr go to their files and the runner's own output stays clean", (t) => {
  const ctx = scratch(t);
  const opts = { exe: stub(ctx), args: ["-p", "x"], cwd: ctx.dir, env: seatEnv(ctx, { RQ_STUB_MODE: "policy-error" }), stdin: "ignore", stdout: ctx.out, stderr: ctx.err, limitMs: 60000 };
  const code = `import { runLimited } from ${JSON.stringify(new URL("./seat-spawn.mjs", import.meta.url).href)};
const r = await runLimited(${JSON.stringify(opts)}); process.stdout.write("done " + r.exit + "\\n");`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", timeout: 90000 });
  assert.equal(r.stdout, "done 0\n", r.stderr);
  assert.equal(r.stderr, "");
  assert.match(readFileSync(ctx.out, "utf8"), /^VERDICT: APPROVE$/m);
  assert.match(readFileSync(ctx.err, "utf8"), /Policy file error/);
});

test("the limit ends the seat and every process it started, a child and a chain of two", async (t) => {
  const ctx = scratch(t);
  const r = await runLimited({ exe: stub(ctx), args: [], cwd: ctx.dir, env: seatEnv(ctx, { RQ_STUB_MODE: "chain" }), stdin: "ignore", stdout: ctx.out, stderr: ctx.err, limitMs: 2000, graceMs: 500 });
  const pids = [...pidsOf(ctx, "gemini"), recordOf(ctx, "gemini").pid];
  t.after(() => killAll(pids));
  assert.equal(r.timedOut, true);
  assert.equal(pids.length, 3, "the seat, its child and its grandchild started");
  assert.ok(r.secs >= 2 && r.secs < 30, `took ${r.secs} s`);
  assert.ok(await gone(pids), `left running: ${pids.filter(alive)}`);
});

test("the limit ends a worker that outlives TERM after its entry point exits", { skip: WIN && "Windows has no TERM: taskkill /F ends the tree at once" }, async (t) => {
  const ctx = scratch(t);
  const r = await runLimited({ exe: stub(ctx), args: [], cwd: ctx.dir, env: seatEnv(ctx, { RQ_STUB_MODE: "term-proof" }), stdin: "ignore", stdout: ctx.out, stderr: ctx.err, limitMs: 1500, graceMs: 1000 });
  const pids = pidsOf(ctx, "gemini");
  t.after(() => killAll(pids));
  assert.equal(r.timedOut, true);
  assert.equal(pids.length, 1);
  assert.ok(await gone(pids), "the worker outlived the limit");
});

test("the limit sends TERM to the whole group first, so a child can end on its own before the KILL", { skip: WIN && "Windows has no TERM: taskkill /F ends the tree at once" }, async (t) => {
  const ctx = scratch(t);
  const r = await runLimited({ exe: stub(ctx), args: [], cwd: ctx.dir, env: seatEnv(ctx, { RQ_STUB_MODE: "term-note" }), stdin: "ignore", stdout: ctx.out, stderr: ctx.err, limitMs: 1500, graceMs: 3000 });
  const pids = pidsOf(ctx, "gemini");
  t.after(() => killAll(pids));
  assert.equal(r.timedOut, true);
  assert.equal(pids.length, 1);
  assert.ok(existsSync(join(ctx.log, `term-${pids[0]}.md`)), "the child got no TERM of its own");
});

test("what a seat leaves running in its group after it exits on its own is ended", { skip: WIN && "Windows keeps no group: taskkill /T needs the seat alive" }, async (t) => {
  const ctx = scratch(t);
  const r = await runLimited({ exe: stub(ctx), args: ["-p", "x"], cwd: ctx.dir, env: seatEnv(ctx, { RQ_STUB_MODE: "linger" }), stdin: "ignore", stdout: ctx.out, stderr: ctx.err, limitMs: 60000 });
  const pids = pidsOf(ctx, "gemini");
  t.after(() => killAll(pids));
  assert.equal(r.exit, 0);
  assert.equal(r.timedOut, false);
  assert.equal(pids.length, 1);
  assert.ok(await gone(pids), "the child the seat left is still running");
});

test("a seat that cannot start reports its error code and never throws", async (t) => {
  const ctx = scratch(t);
  const base = { args: [], cwd: ctx.dir, env: seatEnv(ctx), stdin: "ignore", stdout: ctx.out, stderr: ctx.err, limitMs: 60000 };
  let r = await runLimited({ ...base, exe: join(ctx.dir, "no-such-cli") });
  assert.equal(r.error, "ENOENT");
  assert.equal(r.exit, null);
  r = await runLimited({ ...base, exe: stub(ctx), stdin: join(ctx.dir, "no-such-payload.md") });
  assert.equal(r.error, "ENOENT", "a missing payload file is no seat run");
  assert.equal(recordOf(ctx, "gemini"), null, "the seat did not start");
  if (!WIN) {
    const plain = join(ctx.dir, "not-executable");
    writeFileSync(plain, "#!/bin/sh\necho ran\n", { mode: 0o644 });
    r = await runLimited({ ...base, exe: plain });
    assert.equal(r.error, "EACCES");
  }
});

test("stopAll ends every seat still running and each run says it was stopped", async (t) => {
  const ctx = scratch(t);
  const run = (out) => runLimited({ exe: stub(ctx), args: [], cwd: ctx.dir, env: seatEnv(ctx, { RQ_STUB_MODE: "hang" }), stdin: "ignore", stdout: out, stderr: ctx.err, limitMs: 60000 });
  const runs = [run(ctx.out), run(join(ctx.dir, "out2.md"))];
  await new Promise((r) => setTimeout(r, 1500));
  const t0 = Date.now();
  await stopAll();
  const results = await Promise.all(runs);
  const pids = [...pidsOf(ctx, "gemini"), ...readdirSync(ctx.log).filter((f) => /^gemini-\d+\.md$/.test(f)).map((f) => JSON.parse(readFileSync(join(ctx.log, f), "utf8")).pid)];
  t.after(() => killAll(pids));
  assert.ok(Date.now() - t0 < 15000);
  assert.deepEqual(results.map((x) => x.stopped), [true, true]);
  assert.equal(pids.length, 4, "two seats and a child each");
  assert.ok(await gone(pids), `left running: ${pids.filter(alive)}`);
});

test("which takes a command only from absolute PATH folders and skips folders and files it cannot run", { skip: WIN && "the POSIX lookup; the Windows one is the next test" }, (t) => {
  const ctx = scratch(t);
  const early = join(ctx.dir, "early");
  mkdirSync(join(early, "gemini"), { recursive: true }); // a folder by the name
  const plain = join(ctx.dir, "plain");
  mkdirSync(plain);
  writeFileSync(join(plain, "gemini"), "#!/bin/sh\n", { mode: 0o644 }); // a file without the execute bit
  mkdirSync(join(ctx.dir, "rel"));
  writeFileSync(join(ctx.dir, "rel", "gemini"), "#!/bin/sh\n", { mode: 0o755 });
  const rel = relative(process.cwd(), join(ctx.dir, "rel")); // a relative entry that names a real folder from here
  const PATH = [rel, "", early, plain, ctx.bin].join(":");
  assert.equal(which("gemini", { env: { PATH } }), join(ctx.bin, "gemini"));
  assert.equal(which("gemini", { env: { PATH: rel } }), null, "a relative entry is never searched");
  assert.equal(which("gemini", { env: {} }), null);
});

test("which on Windows tries .exe, then .cmd and .bat in each absolute folder, never an extensionless file", () => {
  const files = new Set(["C:\\a\\codex", "C:\\b\\codex.cmd", "C:\\b\\codex.bat", "rel\\codex.exe", "C:\\c\\codex.exe", "C:\\c\\codex.cmd"]);
  const w = (PATH, key = "PATH") => which("codex", { env: { [key]: PATH }, platform: "win32", isFile: (f) => files.has(f) });
  assert.equal(w("rel;C:\\a;C:\\b;C:\\c"), "C:\\b\\codex.cmd");
  assert.equal(w("C:\\c;C:\\b"), "C:\\c\\codex.exe");
  assert.equal(w("C:\\a"), null);
  assert.equal(w("C:foo;C:\\b", "Path"), "C:\\b\\codex.cmd", "the Path key in any case; a drive-relative entry is skipped");
});

test("a word cmd.exe would read itself keeps a .cmd seat from starting", () => {
  for (const w of ["100%", "a!b", "x^y", "a&b", "a|b", "<x>", "a\nb", "a\rb", "a\0b", '"(x)"', 'a"b)']) {
    assert.equal(cmdLine("C:\\npm\\codex.cmd", ["exec", w]), null, JSON.stringify(w));
  }
  assert.equal(cmdLine("C:\\Users\\A&B\\npm\\codex.cmd", ["exec"]), null, "the path of the CLI too");
  assert.notEqual(cmdLine("C:\\Program Files (x86)\\npm\\codex.cmd", ["(x)"]), null, "parentheses with no quote stay inside the quotes");
});

// CommandLineToArgvW and the MSVC runtime (2008 and later): how a program reads its command line.
// Backslashes before a quote give half their number, and the quote itself when they were odd.
function backslashes(line, i) {
  let n = 0;
  while (line[i + n] === "\\") n += 1;
  if (line[i + n] !== '"') return { text: "\\".repeat(n), next: i + n };
  return n % 2 ? { text: "\\".repeat(n >> 1) + '"', next: i + n + 1 } : { text: "\\".repeat(n >> 1), next: i + n };
}
function crtWord(line, start) {
  let arg = "";
  let quoted = false;
  let i = start;
  while (i < line.length && (quoted || (line[i] !== " " && line[i] !== "\t"))) {
    if (line[i] === "\\") {
      const b = backslashes(line, i);
      [arg, i] = [arg + b.text, b.next];
    } else if (line[i] === '"' && quoted && line[i + 1] === '"') {
      [arg, i] = [arg + '"', i + 2];
    } else if (line[i] === '"') {
      [quoted, i] = [!quoted, i + 1];
    } else {
      [arg, i] = [arg + line[i], i + 1];
    }
  }
  return { arg, next: i };
}
function crtArgv(line) {
  const out = [];
  for (let i = 0; ; ) {
    while (line[i] === " " || line[i] === "\t") i += 1;
    if (i >= line.length) return out;
    const word = crtWord(line, i);
    out.push(word.arg);
    i = word.next;
  }
}

const WORDS = ["exec", "-C", "C:\\Users\\Kim Dev\\AppData\\Local\\Temp\\ralph-qa.Ab12Cd\\codex", "--ephemeral", "-c", "notify=[]",
  "-c", 'otel.exporter="none"', "-c", "mcp_servers.my-server_2.enabled=false", "-m", "gpt-5.5", "-o", "C:\\T\\ralph-qa-out.Ab12Cd\\out-codex.md",
  "-", "첨부한 검토 지시를 따르라", "C:\\Users\\Kim Dev\\", "a\\\\\"b", "", "x y\\", '{"*":"deny"}', "(x)", "tab\there"];

test("every word of a .cmd seat reaches the program as it was, by the MSVC rules", () => {
  const line = cmdLine("C:\\Users\\kim\\AppData\\Roaming\\npm\\codex.cmd", WORDS);
  assert.ok(line);
  assert.deepEqual(crtArgv(line), ["C:\\Users\\kim\\AppData\\Roaming\\npm\\codex.cmd", ...WORDS]);
});

test("on Windows a .cmd seat gets its words as planned and the limit ends its tree", { skip: !WIN && "Windows only" }, async (t) => {
  const ctx = scratch(t);
  const exe = stub(ctx, "codex");
  assert.match(exe, /\.cmd$/);
  const words = WORDS;
  let r = await runLimited({ exe, args: words, cwd: ctx.dir, env: seatEnv(ctx), stdin: "ignore", stdout: ctx.out, stderr: ctx.err, limitMs: 60000 });
  assert.equal(r.exit, 0, readFileSync(ctx.err, "utf8"));
  assert.deepEqual(recordOf(ctx, "codex").args, words);
  rmSync(ctx.log, { recursive: true });
  mkdirSync(ctx.log);
  r = await runLimited({ exe, args: ["exec"], cwd: ctx.dir, env: seatEnv(ctx, { RQ_STUB_MODE: "chain" }), stdin: "ignore", stdout: ctx.out, stderr: ctx.err, limitMs: 3000 });
  const pids = [...pidsOf(ctx, "codex"), recordOf(ctx, "codex").pid];
  t.after(() => killAll(pids));
  assert.equal(r.timedOut, true);
  assert.equal(pids.length, 3);
  assert.ok(await gone(pids, 10000), `left running: ${pids.filter(alive)}`);
});

test("seat-spawn runs no shell, no timeout program, and takes taskkill and cmd.exe from System32", () => {
  const src = readFileSync(SOURCE, "utf8");
  assert.ok(!/shell:\s*true/.test(src), "no shell: true");
  assert.ok(!/\bexec(Sync)?\(/.test(src) && !/execFile/.test(src), "no exec");
  assert.ok(!/["'`](\/usr\/bin\/)?timeout["'`]/.test(src) && !/\bperl\b/.test(src), "no timeout program");
  assert.match(src, /System32/);
  assert.match(src, /taskkill\.exe/);
  assert.match(src, /cmd\.exe/);
});
