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
