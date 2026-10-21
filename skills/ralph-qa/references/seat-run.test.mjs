// Tests for seat-run.mjs, the ralph-qa runner the skill's "외부 좌석 전송" calls: its folders, cleanup, the stops
// and the seats it sends to (the fake CLIs of scripts/test-fixtures/seat-stub.mjs; no real CLI starts).
// Every run gets a temp home, base folder and gemini home: nothing is written under the real ones.
// Run from the repo root: node --test skills/ralph-qa/references/seat-run.test.mjs
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { stubBin } from "../../../scripts/test-fixtures/seat-stub.mjs";
import { CLI_DEFAULT } from "./verifier-probe.mjs";
import { fromMsys, gathered, seatPlan, SEAT_WHY } from "./seat-run.mjs";

const RUNNER = fileURLToPath(new URL("./seat-run.mjs", import.meta.url));
const WIN = process.platform === "win32";
const MAC = process.platform === "darwin";
const GIT = spawnSync(WIN ? "where" : "sh", WIN ? ["git"] : ["-c", "command -v git"], { encoding: "utf8" }).stdout.split(/\r?\n/)[0].trim();
const SKIP = GIT ? false : "no git";
const asRoot = typeof process.getuid === "function" && process.getuid() === 0;

// The real bases the runner would use, looked at before and after: these tests never write there.
const REAL_BASES = [join(homedir(), ".cache"), process.env.XDG_RUNTIME_DIR, process.env.TMPDIR, tmpdir()].filter(Boolean);
const runFolders = () => REAL_BASES.flatMap((b) => {
  try {
    return readdirSync(b).filter((n) => /^ralph-qa(-out)?\./.test(n)).map((n) => join(b, n));
  } catch {
    return [];
  }
});
const before = new Set(runFolders());

// A world of its own: a home, the base the runner should pick on this OS, a gemini home, the stub CLIs and git alone on
// PATH (a real codex or opencode may sit beside node).
function world(t) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "rq-run-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, "home");
  const base = WIN ? join(home, "AppData", "Local", "Temp") : join(dir, "run");
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const log = join(dir, "log");
  mkdirSync(log);
  const bin = stubBin(join(dir, "bin"));
  const env = {
    PATH: [bin, dirname(GIT)].join(delimiter), HOME: home, USERPROFILE: home, GEMINI_CLI_HOME: home, CODEX_HOME: join(home, ".codex"),
    RQ_STUB_LOG: log, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
    ...(WIN ? { SystemRoot: process.env.SystemRoot, TEMP: base, TMP: base } : MAC ? { TMPDIR: base } : { XDG_RUNTIME_DIR: base, TMPDIR: dir }),
  };
  return { dir, home, base, log, bin, env };
}

function cli(w, args, { env = {}, input } = {}) {
  const r = spawnSync(process.execPath, [RUNNER, ...args], { encoding: "utf8", env: { ...w.env, ...env }, input, timeout: 120000 });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    /* not JSON: the test says so */
  }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

const init = (w, env) => {
  const r = cli(w, ["init"], { env });
  assert.equal(r.code, 0, r.stderr);
  return r.json;
};

const DAY_2 = (Date.now() - 2 * 86400 * 1000) / 1000;
// A base folder as a cut-short run and the user leave it: marked copies past a day (a bash name, a PowerShell name),
// unmarked folders of the user's under the same names, a marked copy of today, and a link to a marked copy elsewhere.
function leftovers(at, elsewhere) {
  const folder = (name, { marked = true, old = true } = {}, where = at) => {
    const p = join(where, name);
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, "prompt.md"), "payload\n");
    if (marked) writeFileSync(join(p, ".ralph-qa"), "");
    if (old) utimesSync(p, DAY_2, DAY_2);
    return p;
  };
  for (const n of ["ralph-qa.abc123", "ralph-qa-out.def456", `ralph-qa.${"a1".repeat(16)}`]) folder(n);
  for (const n of ["ralph-qa.backup", "ralph-qa-out.zzzzzz"]) folder(n, { marked: false });
  folder("ralph-qa.new123", { old: false });
  const target = folder("ralph-qa.tgt123", {}, elsewhere);
  if (!WIN) symlinkSync(target, join(at, "ralph-qa.lnk123"));
  return target;
}
function assertLeft(at, target) {
  const has = (name) => {
    try {
      lstatSync(join(at, name));
      return true;
    } catch {
      return false;
    }
  };
  for (const gone of ["ralph-qa.abc123", "ralph-qa-out.def456", `ralph-qa.${"a1".repeat(16)}`]) assert.equal(has(gone), false, `${gone} in ${at}`);
  for (const kept of ["ralph-qa.backup", "ralph-qa-out.zzzzzz", "ralph-qa.new123", ...(WIN ? [] : ["ralph-qa.lnk123"])]) assert.equal(has(kept), true, `${kept} in ${at}`);
  assert.ok(existsSync(join(target, "prompt.md")), "the folder a link points to stays");
}

after(() => {
  const made = runFolders().filter((p) => !before.has(p));
  assert.deepEqual(made, [], "these tests made run folders under a real base");
});

test("init makes a payload and an answer folder, private and marked, outside git, under the account's base", { skip: SKIP }, (t) => {
  const w = world(t);
  const j = init(w);
  assert.equal(j.ok, true);
  assert.equal(realpathSync.native(dirname(j.dir)), realpathSync.native(w.base));
  const id = /^ralph-qa\.([A-Za-z0-9]{6})$/.exec(j.dir.split(/[\\/]/).pop())?.[1];
  assert.ok(id, j.dir);
  assert.equal(j.out, join(dirname(j.dir), `ralph-qa-out.${id}`));
  for (const p of [j.dir, j.out]) {
    assert.ok(statSync(p).isDirectory() && existsSync(join(p, ".ralph-qa")), p);
    if (!WIN) assert.equal(statSync(p).mode & 0o777, 0o700, p);
  }
  assert.deepEqual(JSON.parse(readFileSync(join(j.dir, "result-init.md"), "utf8")), j, "the same JSON in the folder");
});

test("init leaves an XDG_RUNTIME_DIR others can write for ~/.cache, and refuses a ~/.cache others can write", { skip: SKIP || ((WIN || MAC) && "Linux bases") || (asRoot && "root owns every folder here") }, (t) => {
  const w = world(t);
  const open = join(w.dir, "open");
  mkdirSync(open, { mode: 0o777 });
  spawnSync("chmod", ["777", open]);
  const j = init(w, { XDG_RUNTIME_DIR: open });
  assert.equal(dirname(j.dir), join(w.home, ".cache"));
  spawnSync("chmod", ["777", join(w.home, ".cache")]);
  const r = cli(w, ["init"], { env: { XDG_RUNTIME_DIR: open } });
  assert.equal(r.code, 3, r.stdout);
  assert.equal(r.json.stop, "base-not-private");
  assert.match(r.stderr, /^ralph-qa: /m);
});

test("init inside a git work tree refuses and leaves nothing", { skip: SKIP }, (t) => {
  const w = world(t);
  assert.equal(spawnSync(GIT, ["init", "-q", w.base], { env: w.env }).status, 0);
  const r = cli(w, ["init"]);
  assert.equal(r.code, 3, r.stdout);
  assert.equal(r.json.stop, "inside-repo");
  assert.deepEqual(readdirSync(w.base).filter((n) => n.startsWith("ralph-qa")), []);
});

test("cleanup's day rule removes only marked folders past a day, never a user's folder or a link, under every known base", { skip: SKIP }, (t) => {
  const w = world(t);
  const j = init(w);
  const elsewhere = join(w.dir, "elsewhere");
  // the old Git Bash and XDG-less runs used ~/.cache: it is swept too
  const cache = join(w.home, ".cache");
  mkdirSync(cache, { recursive: true });
  const targets = [leftovers(w.base, elsewhere), leftovers(cache, join(elsewhere, "2"))];
  const r = cli(w, ["cleanup", "--dir", j.dir]);
  assert.equal(r.code, 0, r.stderr);
  assertLeft(w.base, targets[0]);
  assertLeft(cache, targets[1]);
  assert.ok(!existsSync(j.dir) && !existsSync(j.out), "this run's folders are gone");
});

test("cleanup refuses while a send of the folder runs, and goes on past a lock that is stale or forced", { skip: SKIP }, (t) => {
  const w = world(t);
  const lock = (d, pid, old = false) => {
    const f = join(d, `.running-${pid}.md`);
    writeFileSync(f, `${pid}\n`);
    if (old) utimesSync(f, (Date.now() - 16 * 60 * 1000) / 1000, (Date.now() - 16 * 60 * 1000) / 1000);
  };
  let j = init(w);
  lock(j.dir, process.pid);
  let r = cli(w, ["cleanup", "--dir", j.dir]);
  assert.equal(r.code, 5, r.stdout);
  assert.equal(r.json.stop, "busy");
  assert.ok(existsSync(j.dir));
  assert.equal(cli(w, ["cleanup", "--dir", j.dir, "--force"]).code, 0);
  assert.ok(!existsSync(j.dir));
  for (const [pid, old] of [[process.pid, true], [2 ** 22 + 12345, false]]) {
    j = init(w);
    lock(j.dir, pid, old);
    r = cli(w, ["cleanup", "--dir", j.dir]);
    assert.equal(r.code, 0, `${pid} ${old}: ${r.stdout}`);
  }
});

test("cleanup and the other commands refuse a folder init did not make, and remove nothing", { skip: SKIP }, (t) => {
  const w = world(t);
  const plain = join(w.dir, "ralph-qa.plain1");
  mkdirSync(plain);
  writeFileSync(join(plain, "keep.md"), "a user's file\n");
  const named = join(w.dir, "notes");
  mkdirSync(named);
  writeFileSync(join(named, ".ralph-qa"), "");
  const cases = [plain, named, join(w.dir, "ralph-qa.none00")];
  if (!WIN) {
    const real = init(w);
    symlinkSync(real.dir, join(w.dir, "ralph-qa.link00"));
    cases.push(join(w.dir, "ralph-qa.link00"));
  }
  for (const dir of cases) {
    for (const args of [["cleanup", "--dir", dir], ["check", "--dir", dir], ["put", "--dir", dir, "--name", "short.md"]]) {
      const r = cli(w, args, { input: "x" });
      assert.equal(r.code, 3, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
      assert.equal(r.json.stop, "not-a-run-folder", args.join(" "));
    }
  }
  assert.ok(existsSync(join(plain, "keep.md")) && existsSync(join(named, ".ralph-qa")));
});

test("cleanup deletes this run's opencode session and those of seat folders that are gone, by the base as written and resolved", { skip: SKIP || (WIN && "the base link is a POSIX case; Windows runs the rest in the next test") }, (t) => {
  const w = world(t);
  // the base reached through a link, as macOS's TMPDIR under /var is: opencode records the resolved folder
  const via = join(w.dir, "via");
  symlinkSync(w.base, via);
  const env = MAC ? { TMPDIR: via } : { XDG_RUNTIME_DIR: via };
  const j = init(w, env);
  assert.equal(dirname(j.dir), via);
  writeFileSync(join(j.dir, "run.md"), "id a1b2c3d4\n");
  const live = init(w, env);
  mkdirSync(join(live.dir, "opencode"));
  const real = realpathSync.native(w.base);
  const sessions = [
    { id: "ses_this", title: "ralph-qa-review-a1b2c3d4", directory: join(real, "ralph-qa.zzzzzz", "opencode") },
    { id: "ses_gone", title: "ralph-qa-review-0ld0ld00", directory: join(real, "ralph-qa.gone12", "opencode") },
    { id: "ses_live", title: "ralph-qa-review-11ve11ve", directory: join(realpathSync.native(live.dir), "opencode") },
    { id: "ses_user", title: "my own session", directory: join(w.dir, "project") },
    { id: "ses_else", title: "ralph-qa-review-e1se0000", directory: join(w.dir, "other", "ralph-qa.gone34", "opencode") },
  ];
  const file = join(w.dir, "sessions.md");
  writeFileSync(file, JSON.stringify(sessions));
  const r = cli(w, ["cleanup", "--dir", j.dir], { env: { ...env, RQ_STUB_SESSIONS: file } });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).map((s) => s.id).sort(), ["ses_else", "ses_live", "ses_user"]);
  assert.equal(r.json.opencode.deleted, 2);
});

test("cleanup removes this seat folder's gemini records and sweeps those of seat folders gone from the base", { skip: SKIP }, (t) => {
  const w = world(t);
  const j = init(w);
  const record = (name, owner) => {
    const p = join(w.home, ".gemini", "tmp", name);
    mkdirSync(join(p, "chats"), { recursive: true });
    writeFileSync(join(p, ".project_root"), owner);
    return p;
  };
  // the seat folder is there while its run cleans up, so only clean (not sweep) takes its record
  mkdirSync(join(j.dir, "gemini"));
  const mine = record("mine", join(j.dir, "gemini"));
  const stale = record("stale", join(dirname(j.dir), "ralph-qa.gone99", "gemini"));
  const other = record("other", join(w.dir, "project"));
  const r = cli(w, ["cleanup", "--dir", j.dir]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!existsSync(mine) && !existsSync(stale) && existsSync(other));
  assert.deepEqual(r.json.gemini.skipped, []);
});

// Git Bash gives a session's paths as /c/...; it turns them into C:\... for a Windows program only some of the time
// (not one with Korean and brackets, as the Windows box showed), and git cannot go to /c/...
test("on Windows a Git Bash path /c/... is read as C:\\...; any other path, and every path elsewhere, stays", () => {
  assert.equal(fromMsys("/c/Users/김 [b]/저장소 [r]", "win32"), "C:\\Users\\김 [b]\\저장소 [r]");
  assert.equal(fromMsys("/d", "win32"), "D:\\");
  assert.equal(fromMsys("/d/", "win32"), "D:\\");
  for (const p of ["C:\\Users\\x", "C:/Users/x", "/tmp/x", "/cc/x", "//server/share", "rel/x", "\\\\?\\C:\\x"]) assert.equal(fromMsys(p, "win32"), p);
  assert.equal(fromMsys("/c/Users/x", "linux"), "/c/Users/x");
  assert.equal(fromMsys("/c/Users/x", "darwin"), "/c/Users/x");
});

test("on Windows untracked and prepare take the repo and the folder as Git Bash writes them", { skip: SKIP || (!WIN && "Windows only") }, (t) => {
  const w = world(t);
  const repo = join(w.dir, "한글 [b]", "저장소 [r]");
  mkdirSync(repo, { recursive: true });
  const g = (...a) => spawnSync(GIT, ["-C", repo, ...a], { encoding: "utf8", env: w.env });
  g("-c", "init.defaultBranch=main", "init", "-q");
  writeFileSync(join(repo, "a.txt"), "one\n");
  g("add", ".");
  g("commit", "-qm", "base");
  writeFileSync(join(repo, "a.txt"), "two\n");
  writeFileSync(join(repo, "새 [n].txt"), "new\n");
  const posix = (p) => p.replace(/^([A-Za-z]):[\\/]/, (m, l) => `/${l.toLowerCase()}/`).replace(/\\/g, "/");
  const listed = cli(w, ["untracked", "--repo", posix(repo)]);
  assert.equal(listed.code, 0, listed.stdout);
  assert.deepEqual(listed.json.files, ["새 [n].txt"]);
  const j = init(w);
  writeFileSync(join(j.dir, "short.md"), '<review-data id="a1b2c3d4">\nreview\n');
  writeFileSync(join(j.dir, "spec.md"), "new 새 [n].txt\n");
  const prep = cli(w, ["prepare", "--dir", posix(j.dir), "--repo", posix(repo), "--base", "HEAD", "--id", "a1b2c3d4"]);
  assert.equal(prep.code, 0, prep.stdout);
  assert.ok(readFileSync(join(j.dir, "prompt.md"), "utf8").includes("+++ b/새 [n].txt"));
  cli(w, ["cleanup", "--dir", j.dir]);
});

test("put writes short.md or spec.md from its standard input and refuses any other name", { skip: SKIP }, (t) => {
  const w = world(t);
  const j = init(w);
  const text = "<review-data id=\"a1b2c3d4\">\nRALPHQA_a1b2c3d4\n'@\n$(touch x)\n";
  for (const name of ["short.md", "spec.md"]) {
    const r = cli(w, ["put", "--dir", j.dir, "--name", name], { input: text });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(readFileSync(join(j.dir, name), "utf8"), text);
  }
  for (const name of ["prompt.md", "../short.md", "short.txt"]) {
    const r = cli(w, ["put", "--dir", j.dir, "--name", name], { input: text });
    assert.equal(r.code, 2, `${name}: ${r.stdout}`);
  }
});

test("each command prints one JSON object, Korean lines on stderr for a stop, and the same JSON in result-<command>.md", { skip: SKIP }, (t) => {
  const w = world(t);
  const j = init(w);
  const notRepo = join(w.dir, "not-a-repo");
  mkdirSync(notRepo);
  writeFileSync(join(j.dir, "short.md"), '<review-data id="a1b2c3d4">\n');
  writeFileSync(join(j.dir, "spec.md"), "");
  const r = cli(w, ["prepare", "--dir", j.dir, "--repo", notRepo, "--base", "HEAD", "--id", "a1b2c3d4"]);
  assert.equal(r.code, 3, r.stdout);
  assert.deepEqual([r.json.ok, r.json.command, r.json.stop], [false, "prepare", "not-a-repo"]);
  assert.match(r.stderr, /^ralph-qa: git 저장소가 아니다/m);
  assert.deepEqual(JSON.parse(readFileSync(join(j.dir, "result-prepare.md"), "utf8")), r.json);
  for (const args of [["nothing"], ["init", "--what"], ["check"], ["send", "--dir", j.dir]]) {
    const u = cli(w, args);
    assert.equal(u.code, 2, `${args.join(" ")}: ${u.stdout}`);
    assert.match(u.stderr, /^ralph-qa: /m);
  }
});

// ---- send: the seats, their guards and limit, what is learned from their answers, and the cleanup of their records

const ID = "a1b2c3d4";
function repoIn(w) {
  const repo = join(w.dir, "repo");
  mkdirSync(repo);
  const g = (...a) => assert.equal(spawnSync(GIT, ["-C", repo, ...a], { env: w.env }).status, 0, a.join(" "));
  g("-c", "init.defaultBranch=main", "init", "-q");
  writeFileSync(join(repo, "a.txt"), "one\n");
  g("add", ".");
  g("commit", "-qm", "base");
  writeFileSync(join(repo, "a.txt"), "two\n");
  return repo;
}
function prepared(w, { spec = "", text } = {}) {
  const repo = repoIn(w);
  if (text) writeFileSync(join(repo, "a.txt"), text);
  const j = init(w);
  writeFileSync(join(j.dir, "short.md"), `<review-data id="${ID}">\nreview this\n`);
  writeFileSync(join(j.dir, "spec.md"), spec);
  const p = cli(w, ["prepare", "--dir", j.dir, "--repo", repo, "--base", "HEAD", "--id", ID]);
  assert.ok([0, 1, 4].includes(p.code), p.stderr);
  return { ...j, repo };
}
const send = (w, j, seats, extra = [], env = {}) => cli(w, ["send", "--dir", j.dir, "--runtime", "claude", ...seats.flatMap((s) => ["--seat", s]), ...extra], { env });
const records = (w, name) => readdirSync(w.log).filter((f) => new RegExp(`^${name}-\\d+\\.md$`).test(f)).map((f) => JSON.parse(readFileSync(join(w.log, f), "utf8")));
const runs = (w, name) => records(w, name).filter((r) => r.stdinBytes > 0 || (name === "codex" ? r.args[0] === "exec" : name === "opencode" ? r.args[0] === "run" : true));
const seatOf = (r, cli) => r.json.seats.find((s) => s.seat === cli);

test("send refuses a folder prepare did not finish, a folder already sent, and a payload it must not send as it is", { skip: SKIP }, (t) => {
  const w = world(t);
  const j = init(w);
  let r = send(w, j, ["gemini=pro"]);
  assert.deepEqual([r.code, r.json.stop], [3, "not-prepared"]);
  const p = prepared(w);
  writeFileSync(join(p.dir, "prompt.md"), readFileSync(join(p.dir, "prompt.md"), "utf8").replace(`</review-data id="${ID}">`, ""));
  r = send(w, p, ["gemini=pro"]);
  assert.deepEqual([r.code, r.json.stop], [3, "markers"]);
  assert.equal(runs(w, "gemini").length, 0, "no seat ran");
  writeFileSync(join(j.dir, "result-send.md"), "{}");
  writeFileSync(join(j.dir, "run.md"), `id ${ID}\n`);
  r = send(w, j, ["gemini=pro"]);
  assert.deepEqual([r.code, r.json.stop], [3, "sent"]);
});

test("a payload with secret-like lines or past 512 KiB goes to no seat; --allow-large lets the size through", { skip: SKIP }, (t) => {
  const w = world(t);
  const secret = ["s3", "cr3t", "V4lue"].join("");
  const p = prepared(w, { text: `password = ${secret}\n` });
  let r = send(w, p, ["gemini=pro"]);
  assert.deepEqual([r.code, r.json.stop], [1, "scan"]);
  const w2 = world(t);
  const big = prepared(w2, { text: Array.from({ length: 6000 }, (_, i) => `line ${i} ${"y".repeat(90)}`).join("\n") + "\n" });
  r = send(w2, big, ["gemini=pro"]);
  assert.deepEqual([r.code, r.json.stop], [4, "too-large"]);
  assert.ok(!existsSync(join(big.dir, "result-send.md")) && existsSync(join(big.dir, "result-send-stop.md")), "a stopped send leaves the folder unsent");
  assert.equal(runs(w2, "gemini").length, 0);
  r = send(w2, big, ["gemini=pro"], ["--allow-large"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(seatOf(r, "gemini").status, "answered");
  assert.equal(runs(w, "gemini").length, 0, "the seat with hits never ran");
});

test("send runs each seat from its own copy in its own folder, with the answers in the answer folder", { skip: SKIP }, (t) => {
  const w = world(t);
  const p = prepared(w);
  const r = send(w, p, ["codex=gpt-5.5", "gemini=pro", "opencode=prov/model-x"]);
  assert.equal(r.code, 0, r.stderr);
  const prompt = readFileSync(join(p.dir, "prompt.md"));
  for (const cli of ["codex", "gemini", "opencode"]) {
    const s = seatOf(r, cli);
    assert.equal(s.status, "answered", `${cli}: ${JSON.stringify(s)}`);
    assert.equal(s.facts.verdict, "APPROVE", cli);
    assert.equal(dirname(s.answer), p.out, cli);
    const rec = runs(w, cli)[0];
    assert.equal(rec.cwd, join(realpathSync.native(p.dir), cli), cli);
    assert.ok(readFileSync(join(w.log, `${cli}-${rec.pid}-stdin.md`)).equals(prompt), `${cli} got prompt.md as it is`);
    assert.ok(!existsSync(join(p.dir, cli)), `${cli}'s copy is gone after the send`);
  }
  assert.ok(existsSync(join(p.dir, "result-send.md")));
  assert.ok(!readdirSync(p.dir).some((f) => f.startsWith(".running-")), "the lock is gone");
  assert.match(r.json.declared, /^외부 전송\(선언\): .*codex.*gemini.*opencode.*prov.*페이로드 \d+B, 비밀 검사 0건, 보내지 않은 새 파일 0/);
});

// The 0.20.4 commands of the skill's bash block, word for word: the read-only guards the mock-server checks proved.
const D = "/d/ralph-qa.abc123";
const O = "/d/ralph-qa-out.abc123";
test("the codex plan is the 0.20.4 command word for word, with one -c per MCP server, -m unless @cli-default and effort only when given", () => {
  const plan = seatPlan({ cli: "codex", model: "gpt-5.5", mcpServers: ["alpha", "beta-2"], d: D, o: O, id: ID });
  assert.deepEqual(plan.args, ["exec", "-C", join(D, "codex"), "--ephemeral", "--ignore-rules",
    "--disable", "multi_agent", "--disable", "hooks", "--disable", "plugins", "--disable", "apps", "--disable", "shell_tool",
    "-c", "notify=[]", "-c", "analytics.enabled=false", "-c", "web_search=disabled", "-c", "mcp_servers.alpha.enabled=false", "-c", "mcp_servers.beta-2.enabled=false",
    "-c", 'otel.exporter="none"', "-c", 'otel.trace_exporter="none"', "-c", 'otel.metrics_exporter="none"',
    "-m", "gpt-5.5", "-s", "read-only", "--skip-git-repo-check", "-o", join(O, "out-codex.md"), "-"]);
  assert.deepEqual([plan.cwd, plan.stdin, plan.stderr], [join(D, "codex"), join(D, "codex", "prompt.md"), join(O, "err-codex.md")]);
  const plain = seatPlan({ cli: "codex", model: CLI_DEFAULT, mcpServers: [], d: D, o: O, id: ID, effort: "high" });
  assert.ok(!plain.args.includes("-m") && !plain.args.some((a) => a.startsWith("mcp_servers.")));
  assert.deepEqual(plain.args.slice(plain.args.indexOf('otel.metrics_exporter="none"') + 1, plain.args.indexOf("-s")), ["-c", "model_reasoning_effort=high"]);
  assert.deepEqual(plan.set, {});
});

test("the gemini plan gives the helper's policy, TMPDIR TEMP TMP in the answer folder, its sandbox and prompt telemetry off and no IDE path", () => {
  const plan = seatPlan({ cli: "gemini", model: "pro", d: D, o: O, id: ID, policy: "/p/gemini-read-only.toml" });
  assert.deepEqual(plan.args, ["--skip-trust", "--approval-mode", "default", "--admin-policy", "/p/gemini-read-only.toml",
    "--allowed-mcp-server-names", "ralph-qa-none", "-e", "none", "-m", "pro", "-p", "첨부한 검토 지시를 따르라"]);
  assert.deepEqual(plan.set, { TMPDIR: O, TEMP: O, TMP: O, GEMINI_SANDBOX: "false", GEMINI_TELEMETRY_LOG_PROMPTS: "false" });
  assert.deepEqual(plan.unset, ["GEMINI_CLI_IDE_WORKSPACE_PATH"]);
  assert.deepEqual([plan.stdout, plan.stderr], [join(O, "out-gemini.md"), join(O, "err-gemini.md")]);
});

test("the opencode plan checks its per-run deny-all agent first, with the env of its run", () => {
  const plan = seatPlan({ cli: "opencode", model: "prov/model-x", d: D, o: O, id: ID });
  const A = `ralph-qa-review-${ID}`;
  assert.deepEqual(plan.check, ["debug", "agent", A, "--pure"]);
  assert.deepEqual(plan.args, ["run", "--pure", "--agent", A, "--title", A, "-m", "prov/model-x", "아래 검토 지시를 따르라"]);
  assert.deepEqual(plan.set, {
    OPENCODE_PERMISSION: '{"*":"deny"}',
    OPENCODE_CONFIG_CONTENT: `{"share":"disabled","agent":{"compaction":{"disable":true},"${A}":{"mode":"primary","description":"ralph-qa reviewer","permission":{"*":"deny"}}}}`,
    OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_SHARE: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1",
  });
});

test("the seats get the plans' words and env: MCP servers off by name, gemini's env set and its IDE path gone, a missing opencode agent sends nothing", { skip: SKIP }, (t) => {
  const w = world(t);
  mkdirSync(join(w.home, ".codex"), { recursive: true });
  writeFileSync(join(w.home, ".codex", "config.toml"), '[mcp_servers.alpha]\ncommand = "x"\n\n[mcp_servers.beta-2]\ncommand = "y"\n');
  const p = prepared(w);
  let r = send(w, p, ["codex=gpt-5.5", "gemini=pro"], [], { GEMINI_CLI_IDE_WORKSPACE_PATH: "/w" });
  assert.equal(r.code, 0, r.stderr);
  const cx = runs(w, "codex")[0];
  for (const n of ["alpha", "beta-2"]) assert.ok(cx.args.includes(`mcp_servers.${n}.enabled=false`), cx.args.join(" "));
  const gm = runs(w, "gemini")[0];
  assert.deepEqual([gm.env.TMPDIR, gm.env.GEMINI_SANDBOX, gm.env.GEMINI_TELEMETRY_LOG_PROMPTS, gm.env.GEMINI_CLI_IDE_WORKSPACE_PATH], [p.out, "false", "false", undefined]);
  const w2 = world(t);
  const p2 = prepared(w2);
  r = send(w2, p2, ["opencode=prov/model-x"], [], { RQ_STUB_MODE: "no-agent" });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual([seatOf(r, "opencode").status, seatOf(r, "opencode").why], ["not-sent", "opencode-agent"]);
  assert.equal(records(w2, "opencode").filter((x) => x.args[0] === "run").length, 0, "nothing was sent");
});

test("a seat the probe unseats at send time, an unsafe model name or a missing CLI is not sent and says why", { skip: SKIP }, (t) => {
  const w = world(t);
  const p = prepared(w);
  let r = cli(w, ["send", "--dir", p.dir, "--runtime", "codex", "--seat", "codex=gpt-5.5", "--dry-run"]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual([seatOf(r, "codex").status, seatOf(r, "codex").why], ["not-sent", "probe:self-runtime"]);
  r = send(w, p, ["codex=claude-sonnet-4-5", "gemini=$(touch x)"], ["--dry-run"]);
  assert.deepEqual([seatOf(r, "codex").why, seatOf(r, "gemini").why], ["probe:self-family", "unsafe-model"]);
  rmSync(join(w.bin, WIN ? "opencode.cmd" : "opencode"));
  r = send(w, p, ["opencode=prov/model-x"], ["--dry-run"]);
  assert.equal(seatOf(r, "opencode").why, "cli-absent");
  // a seat that passes its guards is planned, not run
  r = send(w, p, ["gemini=pro"], ["--dry-run"]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual([seatOf(r, "gemini").status, seatOf(r, "gemini").plan.args.slice(-2)], ["planned", ["-p", "첨부한 검토 지시를 따르라"]]);
  assert.equal(runs(w, "gemini").length, 0, "a dry run starts no seat");
  assert.ok(!existsSync(join(p.dir, "result-send.md")), "a dry run does not mark the folder sent");
});

test("a changed gemini policy or a .env above the seat outside the home sends nothing to gemini", { skip: SKIP }, (t) => {
  const w = world(t);
  // a copy of the references with a changed policy
  const refs = join(w.dir, "refs");
  mkdirSync(refs);
  const here = dirname(RUNNER);
  for (const f of readdirSync(here).filter((x) => /\.(mjs|toml)$/.test(x) && !x.endsWith(".test.mjs"))) writeFileSync(join(refs, f), readFileSync(join(here, f)));
  writeFileSync(join(refs, "gemini-read-only.toml"), readFileSync(join(refs, "gemini-read-only.toml"), "utf8").replace('decision = "deny"', 'decision = "allow"'));
  const p = prepared(w);
  const r1 = spawnSync(process.execPath, [join(refs, "seat-run.mjs"), "send", "--dir", p.dir, "--runtime", "claude", "--seat", "gemini=pro"], { encoding: "utf8", env: w.env });
  assert.equal(r1.status, 0, r1.stderr);
  assert.equal(JSON.parse(r1.stdout).seats[0].why, "gemini-policy");
  const w2 = world(t);
  writeFileSync(join(w2.dir, ".env"), "GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:9\n"); // above the base, outside the home
  const p2 = prepared(w2);
  const r2 = send(w2, p2, ["gemini=pro"]);
  assert.equal(seatOf(r2, "gemini").why, "gemini-env-file");
  assert.equal(runs(w, "gemini").length + runs(w2, "gemini").length, 0);
});

const alive = (pid) => {
  try {
    process.kill(pid, 0);
  } catch (e) {
    return e.code === "EPERM";
  }
  try {
    return !/^\d+ \(.*\) Z/s.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return process.platform !== "linux";
  }
};
const pidsIn = (w) => readdirSync(w.log).filter((f) => f.endsWith("-pids.md")).flatMap((f) => readFileSync(join(w.log, f), "utf8").split("\n").filter(Boolean).map(Number));
async function gone(pids, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((res) => setTimeout(res, 50))) if (!pids.some(alive)) return true;
  return !pids.some(alive);
}

test("a seat past the limit fails with timeout and its whole tree is gone when send returns", { skip: SKIP }, async (t) => {
  const w = world(t);
  const p = prepared(w);
  const r = send(w, p, ["gemini=pro"], ["--limit", "2"], { RQ_STUB_MODE: "chain" });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual([seatOf(r, "gemini").status, seatOf(r, "gemini").why], ["failed", "timeout"]);
  const pids = [...pidsIn(w), ...records(w, "gemini").map((x) => x.pid)];
  assert.equal(pids.length, 3);
  assert.ok(await gone(pids), `left: ${pids.filter(alive)}`);
});

test("a gemini seat that would write its record late is ended with its group, and its record is cleaned", { skip: SKIP || (WIN && "Windows keeps no group") }, async (t) => {
  const w = world(t);
  const p = prepared(w);
  const r = send(w, p, ["gemini=pro"], [], { RQ_STUB_MODE: "late-write" });
  assert.equal(seatOf(r, "gemini").status, "answered", r.stdout);
  await new Promise((res) => setTimeout(res, 2500));
  const tmp = join(w.home, ".gemini", "tmp");
  const left = existsSync(tmp) ? readdirSync(tmp) : [];
  assert.deepEqual(left, [], "no record is left, not even one written after the run");
});

test("what the answers say: the codex model line, gemini's policy error and report, opencode's fallback, an empty answer, the VERDICT count", { skip: SKIP }, (t) => {
  const cases = [
    ["codex=gpt-5.5", "model-line=o4-mini", "failed", "model-mismatch"], ["gemini=pro", "policy-error", "failed", "policy-file-error"],
    ["gemini=pro", "full-report", "failed", "exit"], ["gemini=pro", "rejected", "failed", "rejected"], ["opencode=prov/model-x", "fallback", "failed", "fallback-agent"],
    ["gemini=pro", "empty", "failed", "empty"], ["gemini=pro", "two-verdicts", "failed", "verdict"], ["gemini=pro", "no-verdict", "failed", "verdict"],
    ["gemini=pro", "exit3", "failed", "exit"], ["codex=gpt-5.5", "answer", "answered", null],
  ];
  for (const [seat, mode, status, why] of cases) {
    const w = world(t);
    const p = prepared(w);
    const r = send(w, p, [seat], [], { RQ_STUB_MODE: mode });
    const s = r.json.seats[0];
    assert.deepEqual([s.status, s.why], [status, why], `${seat} ${mode}: ${JSON.stringify(s)}`);
    if (mode === "full-report") assert.equal(s.facts.apiError, true);
    if (mode === "rejected") assert.match(s.facts.rejectHint, /model_not_found/);
    if (mode === "model-line=o4-mini") assert.equal(s.facts.ranModel, "o4-mini");
  }
});

test("a split seat gets every part in order, each with its part line, and one gathered verdict", { skip: SKIP }, (t) => {
  const w = world(t);
  writeFileSync(join(w.dir, "rules.md"), "the rules\n");
  const p = prepared(w, { spec: `file ${join(w.dir, "rules.md")}\n` });
  const r = send(w, p, ["gemini=pro"], ["--split", "gemini=2"]);
  assert.equal(r.code, 0, r.stderr);
  const s = seatOf(r, "gemini");
  assert.deepEqual([s.status, s.facts.verdict, s.parts.length], ["answered", "APPROVE", 2]);
  const got = runs(w, "gemini").sort((a, b) => a.at - b.at).map((x) => readFileSync(join(w.log, `gemini-${x.pid}-stdin.md`), "utf8"));
  assert.ok(got[0].includes("부분 1/2") && got[1].includes("부분 2/2"), got.join("\n---\n"));
  assert.ok(got[0].includes("+++ b/a.txt") && got[1].includes("=== file rules.md"), "the parts in order");
  assert.deepEqual([gathered(["APPROVE", "APPROVE"]), gathered(["APPROVE", "ITERATE"]), gathered(["ITERATE", "REJECT"]), gathered(["REJECT", "ERROR"])], ["APPROVE", "ITERATE", "REJECT", "ERROR"]);
  const bad = send(world(t), p, ["gemini=pro"], ["--split", "codex=2"]);
  assert.equal(bad.code, 2, "a split for a seat not sent to is a usage error");
});

// What a send test that fails leaves running (the runner, its send's node, hung seats) ends with the test. Made before
// the world, so it runs before the world's folder (with the seats' pid records) is removed.
function endAfter(t) {
  const it = { w: null, c: null, more: [] };
  t.after(() => {
    if (!it.w) return;
    let pids = [];
    try {
      pids = [...pidsIn(it.w), ...["gemini", "opencode", "codex"].flatMap((n) => records(it.w, n).map((x) => x.pid))];
    } catch {
      /* no records */
    }
    const runner = it.c && it.c.exitCode === null && it.c.signalCode === null ? [it.c.pid] : [];
    for (const pid of [...runner, ...[...pids, ...it.more].filter(alive)]) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
  });
  return it;
}

test("SIGTERM to send ends every seat's group, still cleans their records and copies, and exits 143", { skip: SKIP || (WIN && "POSIX signals"), timeout: 90000 }, async (t) => {
  const left = endAfter(t);
  const w = world(t);
  const p = prepared(w);
  const { spawn } = await import("node:child_process");
  const c = spawn(process.execPath, [RUNNER, "send", "--dir", p.dir, "--runtime", "claude", "--seat", "gemini=pro", "--seat", "opencode=prov/model-x", "--limit", "60"],
    { env: { ...w.env, RQ_STUB_MODE: "hang" }, stdio: ["ignore", "pipe", "pipe"] });
  Object.assign(left, { w, c });
  let out = "";
  c.stdout.on("data", (b) => { out += b; });
  const closed = new Promise((res) => c.on("close", (x) => res(x)));
  for (let k = 0; k < 200 && pidsIn(w).length < 2; k += 1) await new Promise((res) => setTimeout(res, 50));
  c.kill("SIGTERM");
  const code = await closed;
  assert.equal(code, 143, out);
  const pids = [...pidsIn(w), ...records(w, "gemini").map((x) => x.pid), ...records(w, "opencode").map((x) => x.pid)];
  assert.ok(await gone(pids), `left: ${pids.filter(alive)}`);
  assert.ok(!existsSync(join(p.dir, "gemini")) && !existsSync(join(p.dir, "opencode")), "the copies are gone");
  const json = JSON.parse(out);
  assert.ok(json.seats.every((s) => s.status === "failed" && s.why === "signal"), out);
});

// A kill of the runner alone (kill -9, the OOM killer) runs none of its handlers: the node that does the send sees
// the runner gone and ends the seats itself. The Windows box measures the same with a taskkill of the runner alone.
test("a SIGKILL to the runner alone still ends every seat, cleans their records and copies, and leaves no lock", { skip: SKIP || (WIN && "POSIX signals"), timeout: 90000 }, async (t) => {
  const left = endAfter(t);
  const w = world(t);
  const p = prepared(w);
  const { spawn } = await import("node:child_process");
  const c = spawn(process.execPath, [RUNNER, "send", "--dir", p.dir, "--runtime", "claude", "--seat", "gemini=pro", "--seat", "opencode=prov/model-x", "--limit", "60"],
    { env: { ...w.env, RQ_STUB_MODE: "hang" }, stdio: ["ignore", "pipe", "pipe"] });
  Object.assign(left, { w, c });
  c.stdout.resume();
  c.stderr.resume();
  const exited = new Promise((res) => c.on("exit", (...end) => res(end[1])));
  for (let k = 0; k < 200 && pidsIn(w).length < 2; k += 1) await new Promise((res) => setTimeout(res, 50));
  const pids = [...pidsIn(w), ...records(w, "gemini").map((x) => x.pid), ...records(w, "opencode").map((x) => x.pid)];
  assert.ok(pids.length >= 4, `the seats started: ${pids}`);
  const lock = readdirSync(p.dir).find((n) => /^\.running-\d+\.md$/.test(n));
  assert.ok(lock, "the send's node holds the lock");
  const worker = Number(lock.match(/\d+/)[0]);
  left.more.push(worker);
  c.kill("SIGKILL");
  assert.equal(await exited, "SIGKILL");
  assert.ok(await gone(pids, 10000), `left: ${pids.filter(alive)}`);
  assert.ok(await gone([worker], 40000), "the send's node ended too");
  assert.ok(!existsSync(join(p.dir, "gemini")) && !existsSync(join(p.dir, "opencode")), "the copies are gone");
  assert.deepEqual(readdirSync(p.dir).filter((n) => n.startsWith(".running-")), [], "no lock is left");
});

// The send's node killed alone (the runner lives): no result comes, so the runner says so and ends with 2. Its seats
// are left running, as the skill says (the test ends them).
test("a send whose own node is killed ends with 2 and says it gave no result", { skip: SKIP || (WIN && "POSIX signals"), timeout: 90000 }, async (t) => {
  const left = endAfter(t);
  const w = world(t);
  const p = prepared(w);
  const { spawn } = await import("node:child_process");
  const c = spawn(process.execPath, [RUNNER, "send", "--dir", p.dir, "--runtime", "claude", "--seat", "gemini=pro", "--limit", "60"],
    { env: { ...w.env, RQ_STUB_MODE: "hang" }, stdio: ["ignore", "pipe", "pipe"] });
  Object.assign(left, { w, c });
  let err = "";
  c.stderr.on("data", (b) => { err += b; });
  c.stdout.resume();
  const closed = new Promise((res) => c.on("close", (code) => res(code)));
  for (let k = 0; k < 200 && pidsIn(w).length < 1; k += 1) await new Promise((res) => setTimeout(res, 50));
  const lock = readdirSync(p.dir).find((n) => /^\.running-\d+\.md$/.test(n));
  assert.ok(lock, "the send's node holds the lock");
  assert.notEqual(Number(lock.match(/\d+/)[0]), c.pid, "the lock is the send's node's, not the runner's");
  process.kill(Number(lock.match(/\d+/)[0]), "SIGKILL");
  assert.equal(await closed, 2, err);
  assert.match(err, /send 를 맡은 node 가 결과 없이 끝났다\(SIGKILL\)/);
});

test("the seat result reasons are the set the skill's table holds", () => {
  for (const why of ["rejected", "timeout", "exit", "signal", "spawn", "empty", "verdict", "policy-file-error", "fallback-agent", "model-mismatch",
    "default-model-family", "probe", "unsafe-model", "cli-absent", "unsafe-word", "gemini-policy", "gemini-env-file", "opencode-agent", "split"]) {
    assert.ok(SEAT_WHY.includes(why), why);
  }
});
