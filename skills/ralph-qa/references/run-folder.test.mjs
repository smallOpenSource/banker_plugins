// Tests for run-folder.mjs. Run: node --test skills/ralph-qa/references/run-folder.test.mjs
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { Stop, bases, hashFile, makeRunFolder, sharedAbove, removeMarked, removeRunFolder, runFolder, snapshot, spawnFiles } from "./run-folder.mjs";

const WIN = process.platform === "win32";
const MAC = process.platform === "darwin";
const asRoot = typeof process.getuid === "function" && process.getuid() === 0;
const HAS_GIT = spawnSync("git", ["--version"]).status === 0;

// A home of its own and the base this OS picks there; never a real base.
function world(t) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "rq-rf-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, "home");
  const base = WIN ? join(home, "AppData", "Local", "Temp") : join(dir, "run");
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const env = { HOME: home, USERPROFILE: home, ...(WIN ? { TEMP: base } : MAC ? { TMPDIR: base } : { XDG_RUNTIME_DIR: base }) };
  return { dir, home, base, ctx: { env, platform: process.platform } };
}

test("bases: XDG_RUNTIME_DIR only when private, macOS TMPDIR, Windows TEMP only inside the home, ~/.cache always known", () => {
  const home = WIN ? "C:\\Users\\u" : "/home/u";
  const mac = bases({ platform: "darwin", env: { HOME: home, TMPDIR: join(tmpdir(), "rq-no-such-folder") } });
  assert.equal(mac.base, join(home, ".cache"), "a TMPDIR that is not this account's private folder");
  assert.ok(mac.known.includes(resolve(join(tmpdir(), "rq-no-such-folder"))), "the TMPDIR stays known for the day rule");
  const win = bases({ platform: "win32", env: { USERPROFILE: "C:\\Users\\u", TEMP: "D:\\temp" } });
  assert.equal(win.base, join("C:\\Users\\u", ".cache"), "a TEMP outside the home is not used");
  const linux = bases({ platform: "linux", env: { HOME: home, XDG_RUNTIME_DIR: join(tmpdir(), "rq-no-such-folder") } });
  assert.equal(linux.base, join(home, ".cache"), "an XDG_RUNTIME_DIR that is not this account's private folder");
  assert.ok(linux.known.includes(join(home, ".cache")) && linux.known.length === 2, "the XDG folder stays known for the day rule");
});

test("makeRunFolder makes a private marked folder right under the base; runFolder takes it by either path form", (t) => {
  const w = world(t);
  const { dir } = makeRunFolder(w.ctx, "ultraqa");
  assert.match(dir, /[\\/]ultraqa\.[A-Za-z0-9]{6}$/);
  assert.ok(existsSync(join(dir, ".ultraqa")));
  if (!WIN) assert.equal(statSync(dir).mode & 0o077, 0);
  assert.equal(runFolder(dir, w.ctx, ["ultraqa"]).kind, "ultraqa");
  assert.equal(runFolder(dir, w.ctx, ["ralph-qa", "ultraqa"]).kind, "ultraqa");
  assert.throws(() => runFolder(dir, w.ctx, ["ralph-qa"]), (e) => e instanceof Stop && e.code === "not-a-run-folder");
  if (!WIN) {
    const via = join(w.dir, "via");
    symlinkSync(w.base, via);
    const ctx = { ...w.ctx, env: { ...w.ctx.env, ...(MAC ? { TMPDIR: via } : { XDG_RUNTIME_DIR: via }) } };
    const made = makeRunFolder(ctx, "ultraqa").dir;
    assert.equal(runFolder(made, ctx, ["ultraqa"]).d, made);
    assert.equal(runFolder(join(w.base, made.split("/").pop()), ctx, ["ultraqa"]).kind, "ultraqa", "the real path names the same base");
  }
});

test("runFolder refuses a marked folder moved out of the base, one nested below it, one without its marker, and a link", (t) => {
  const w = world(t);
  const { dir } = makeRunFolder(w.ctx, "ultraqa");
  const moved = join(w.dir, dir.split(/[\\/]/).pop());
  cpSync(dir, moved, { recursive: true });
  const nested = join(w.base, "deeper", "ultraqa.abc123");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, ".ultraqa"), "");
  const bare = join(w.base, "ultraqa.bare12");
  mkdirSync(bare);
  const cases = [moved, nested, bare];
  if (!WIN) {
    symlinkSync(dir, join(w.base, "ultraqa.link12"));
    cases.push(join(w.base, "ultraqa.link12"));
  }
  for (const c of cases) assert.throws(() => runFolder(c, w.ctx, ["ultraqa"]), (e) => e.code === "not-a-run-folder", c);
});

test("a base others may write in holds no run folder", { skip: (WIN && "POSIX mode bits") || (asRoot && "root owns every folder") }, (t) => {
  const w = world(t);
  const { dir } = makeRunFolder(w.ctx, "ultraqa");
  chmodSync(w.base, 0o777);
  try {
    assert.throws(() => runFolder(dir, w.ctx, ["ultraqa"]), (e) => e.code === "not-a-run-folder");
  } finally {
    chmodSync(w.base, 0o700);
  }
});

test("removeRunFolder removes that one folder and no target a link inside it points to", { skip: WIN && "links need a privilege" }, (t) => {
  const w = world(t);
  const { dir } = makeRunFolder(w.ctx, "ultraqa");
  const outside = join(w.dir, "user-work");
  mkdirSync(outside);
  writeFileSync(join(outside, "keep.md"), "the user's\n");
  symlinkSync(outside, join(dir, "harness-link"));
  const other = makeRunFolder(w.ctx, "ultraqa").dir;
  assert.deepEqual(removeRunFolder(dir, w.ctx, ["ultraqa"]), { removed: dir });
  assert.ok(!existsSync(dir) && existsSync(join(outside, "keep.md")) && existsSync(other));
});

test("removeMarked takes the marker last: a removal that stops part way keeps the same marker", { skip: (WIN && "the no-write bit does not stop a delete on Windows") || (asRoot && "root removes it anyway") }, (t) => {
  const w = world(t);
  const { dir } = makeRunFolder(w.ctx, "ultraqa");
  const held = join(dir, "held");
  mkdirSync(held);
  writeFileSync(join(held, "x.md"), "x\n");
  chmodSync(held, 0o500);
  const ino = statSync(join(dir, ".ultraqa")).ino;
  try {
    assert.throws(() => removeMarked(dir, ".ultraqa"));
    assert.equal(statSync(join(dir, ".ultraqa")).ino, ino);
    assert.throws(() => removeRunFolder(dir, w.ctx, ["ultraqa"]), (e) => e.code === "cleanup-left" && e.detail[0].includes(dir));
  } finally {
    chmodSync(held, 0o700);
  }
  removeRunFolder(dir, w.ctx, ["ultraqa"]);
  assert.ok(!existsSync(dir));
});

const git = (repo, ...a) => assert.equal(spawnSync("git", ["-C", repo, ...a], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).status, 0, a.join(" "));

test("snapshot's fingerprint holds still on an unchanged tree and moves with an edit, a staged change, an untracked file's content and HEAD", { skip: !HAS_GIT && "no git" }, async (t) => {
  const w = world(t);
  const repo = join(w.dir, "repo");
  mkdirSync(repo);
  git(repo, "-c", "init.defaultBranch=main", "init", "-q");
  writeFileSync(join(repo, "a.txt"), "one\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "base");
  const fp = async () => (await snapshot(repo)).fingerprint;
  const seen = [await fp()];
  assert.equal(await fp(), seen[0], "unchanged");
  writeFileSync(join(repo, "a.txt"), "two\n");
  seen.push(await fp());
  git(repo, "add", "a.txt");
  seen.push(await fp());
  writeFileSync(join(repo, "new.txt"), "first\n");
  seen.push(await fp());
  writeFileSync(join(repo, "new.txt"), "secnd\n");
  seen.push(await fp());
  const snap = await snapshot(repo);
  assert.deepEqual(snap.untracked.map((u) => u.path), ["new.txt"]);
  git(repo, "commit", "-qm", "two");
  seen.push(await fp());
  assert.equal(new Set(seen).size, seen.length, "every change moved the fingerprint");
  const plain = join(w.dir, "plain");
  mkdirSync(plain);
  assert.equal((await snapshot(plain)).git, false);
});

test("spawnFiles gives the child files, not pipes: input, stdout and stderr arrive whole, the status holds and no file stays", (t) => {
  const own = mkdtempSync(join(tmpdir(), "rq-rf-io-"));
  const keys = ["TMPDIR", "TEMP", "TMP"];
  const saved = keys.map((k) => process.env[k]);
  for (const k of keys) process.env[k] = own;
  t.after(() => {
    keys.forEach((k, i) => (saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i])));
    rmSync(own, { recursive: true, force: true });
  });
  const big = "x".repeat(300000);
  const code = "let s='';process.stdin.on('data',(b)=>s+=b).on('end',()=>{process.stdout.write(s.toUpperCase());process.stderr.write('e:'+s.length);process.exit(3)})";
  const r = spawnFiles(process.execPath, ["-e", code], { input: big, windowsHide: true });
  assert.equal(r.error, undefined);
  assert.deepEqual([r.status, String(r.stdout), String(r.stderr)], [3, big.toUpperCase(), `e:${big.length}`]);
  const none = spawnFiles(process.execPath, ["-e", "process.stdin.on('data',()=>process.exit(9)).on('end',()=>process.exit(0))"]);
  assert.deepEqual([none.status, none.stdout.length], [0, 0]);
  assert.deepEqual(readdirSync(own), []);
});

test("macOS: a private TMPDIR is the base, one below a shared folder (TMPDIR=/tmp or under it) is not and ~/.cache is", { skip: WIN && "POSIX mode bits" }, (t) => {
  const w = world(t);
  assert.equal(bases({ platform: "darwin", env: { HOME: w.home, TMPDIR: w.base } }).base, resolve(w.base));
  const dir = realpathSync.native(mkdtempSync(join("/tmp", "rq-rf-mac-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  chmodSync(dir, 0o700);
  const away = "/rq-no-such-home";
  assert.equal(bases({ platform: "darwin", env: { HOME: away, TMPDIR: dir } }).base, join(away, ".cache"), "a private folder under /tmp");
  assert.equal(bases({ platform: "darwin", env: { HOME: away, TMPDIR: "/tmp" } }).base, join(away, ".cache"), "TMPDIR=/tmp itself");
});

test("hashFile hashes in pieces what createHash gives for the whole; snapshot hashes an untracked file past 2 GiB", { skip: !HAS_GIT && "no git" }, async (t) => {
  const w = world(t);
  const p = join(w.dir, "x.md");
  const body = "abc\n".repeat(700000);
  writeFileSync(p, body);
  assert.equal(hashFile(createHash, p), createHash("sha256").update(body).digest("hex"));
  const r = spawnFiles(process.execPath, ["-e", "process.stdout.write('digest me')"], { digest: (src) => (Buffer.isBuffer(src) ? "buffer" : hashFile(createHash, src)) });
  assert.equal(r.stdout, createHash("sha256").update("digest me").digest("hex"), "with digest, stdout is what it gives for the output file");
  if (WIN) return;
  const repo = join(w.dir, "repo");
  mkdirSync(repo);
  git(repo, "-c", "init.defaultBranch=main", "init", "-q");
  git(repo, "commit", "-q", "--allow-empty", "-m", "base");
  writeFileSync(join(repo, "huge.bin"), "");
  truncateSync(join(repo, "huge.bin"), 2254857830);
  const snap = await snapshot(repo);
  assert.deepEqual(snap.untracked.map((u) => u.path), ["huge.bin"], "no ERR_FS_FILE_TOO_LARGE");
});

test("the fingerprint is the value earlier versions gave: hashing in pieces changed no fingerprint", { skip: !HAS_GIT && "no git" }, async (t) => {
  const w = world(t);
  const repo = join(w.dir, "repo");
  mkdirSync(repo);
  git(repo, "-c", "init.defaultBranch=main", "init", "-q");
  writeFileSync(join(repo, "a.txt"), "one\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "base");
  writeFileSync(join(repo, "a.txt"), "two\n");
  writeFileSync(join(repo, "new.txt"), "new\n");
  const h = (b) => createHash("sha256").update(b).digest("hex");
  const out = (...a) => spawnSync("git", ["-c", "core.fsmonitor=false", "-C", repo, ...a]).stdout;
  const head = String(out("rev-parse", "--verify", "-q", "HEAD")).trim();
  const parts = [`head\0${head}`, `status\0${h(out("status", "--porcelain=v1", "-z", "--untracked-files=all"))}`,
    `diff\0${h(out("diff", "HEAD", "--binary", "--no-ext-diff", "--no-textconv"))}`, `new\0new.txt\0${h("new\n")}`];
  assert.equal((await snapshot(repo)).fingerprint, h(parts.join("\n")));
});

test("an XDG_RUNTIME_DIR below a shared folder (/tmp) is no base unless the home is below one too", { skip: WIN && "POSIX mode bits" }, (t) => {
  const dir = realpathSync.native(mkdtempSync(join("/tmp", "rq-rf-shared-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  chmodSync(dir, 0o700);
  assert.equal(sharedAbove(dir), realpathSync.native("/tmp"));
  assert.equal(sharedAbove("/rq-no-such-home"), null);
  const away = bases({ platform: "linux", env: { HOME: "/rq-no-such-home", XDG_RUNTIME_DIR: dir } });
  assert.equal(away.base, join("/rq-no-such-home", ".cache"), "a private folder under /tmp is still under /tmp");
  const along = bases({ platform: "linux", env: { HOME: join(dir, "home"), XDG_RUNTIME_DIR: dir } });
  assert.equal(along.base, dir, "the home is under the same shared folder: ~/.cache is no better");
});
