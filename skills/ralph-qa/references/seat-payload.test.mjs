// Tests for seat-payload.mjs: the payload the ralph-qa runner builds for an external seat (step 2 of
// the skill's "외부 좌석 전송"), run in throwaway repositories. Most are ported from
// step2-chain.test.mjs, which ran the 0.20.4 bash chain the runner replaces.
// Run from the repo root: node --test skills/ralph-qa/references/seat-payload.test.mjs
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { MAX_BYTES, Stop, buildPayload, checkPayload, markerCount, sha256, splitPayload, untracked } from "./seat-payload.mjs";

const WIN = process.platform === "win32";
const SKIP = spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0 ? false : "no git";

// The user's git config (an excludes file, attributes, hooks, a default branch) stays out of the repos:
// no GIT_* from this process, a temp home and XDG_CONFIG_HOME, no system config.
function isolated(home) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GIT_|XDG_CONFIG_HOME$|HOME$|USERPROFILE$)/i.test(k)));
  return {
    ...env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
  };
}

function git(ctx, ...args) {
  const r = spawnSync("git", ["-C", ctx.repo, ...args], { encoding: "utf8", env: ctx.env });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

function put(ctx, file, text) {
  const path = join(ctx.repo, file);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

// A repo with a committed a.txt and *.log ignored (no commit when commit is false), and an empty
// payload folder ctx.d.
function repo(t, { commit = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "rq-payload-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ctx = { dir, repo: join(dir, "repo"), d: join(dir, "d"), env: isolated(join(dir, "home")) };
  for (const p of [ctx.repo, ctx.d, join(dir, "home")]) mkdirSync(p);
  git(ctx, "-c", "init.defaultBranch=main", "init", "-q");
  put(ctx, ".gitignore", "*.log\n");
  put(ctx, "a.txt", "one\n");
  if (commit) {
    git(ctx, "add", ".");
    git(ctx, "commit", "-qm", "base");
  }
  return ctx;
}

const lines = (file) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : null);

// Writes short.md (the opening marker and a request line) and spec.md as a session would with its
// file tool, then builds. A stop comes back as { stop, message, detail } with what prompt.md holds.
function prep(ctx, { spec = "", base = "HEAD", env = {}, short = '<review-data id="a1b2c3d4">\nreview this\n' } = {}) {
  writeFileSync(join(ctx.d, "short.md"), short);
  writeFileSync(join(ctx.d, "spec.md"), spec);
  const prompt = () => (existsSync(join(ctx.d, "prompt.md")) ? readFileSync(join(ctx.d, "prompt.md"), "utf8") : null);
  try {
    const r = buildPayload({ dir: ctx.d, repo: ctx.repo, base, id: "a1b2c3d4", env: { ...ctx.env, ...env } });
    return { ...r, prompt: prompt(), unsent: lines(join(ctx.d, "unsent.md")) };
  } catch (e) {
    if (!(e instanceof Stop)) throw e;
    return { stop: e.code, message: e.message, detail: e.detail.join("\n"), prompt: prompt() };
  }
}

// git ends the +++ line with a tab when the path holds a space.
const sent = (r, file) => r.prompt.split("\n").some((l) => l.replace(/\t$/, "") === `+++ b/${file}`);

test("the listing names each new file in a new folder, where status --short shows only the folder", { skip: SKIP }, (t) => {
  const ctx = repo(t);
  put(ctx, "scratch/deep/notes.txt", "n\n");
  put(ctx, "scratch/conn.json", "{}\n");
  const r = untracked({ repo: ctx.repo, env: ctx.env });
  assert.deepEqual(r.files.sort(), ["scratch/conn.json", "scratch/deep/notes.txt"]);
  assert.equal(r.folded, false);
});

test("only the new files the author lists go out; the rest are left in unsent.md", { skip: SKIP }, (t) => {
  const ctx = repo(t);
  put(ctx, "a.txt", "two\n");
  put(ctx, "newfeat/f.mjs", "export const f = 1;\n");
  put(ctx, "scratch/conn.json", "{}\n");
  put(ctx, "scratch/deep/notes.txt", "n\n");
  const r = prep(ctx, { spec: "new newfeat/f.mjs\n" });
  assert.equal(r.stop, undefined, r.message);
  assert.equal(r.markers, 2);
  assert.ok(sent(r, "a.txt") && sent(r, "newfeat/f.mjs"), r.prompt);
  assert.ok(!r.prompt.includes("scratch/"), r.prompt);
  assert.deepEqual(r.unsent.sort(), ["scratch/conn.json", "scratch/deep/notes.txt"]);
  assert.equal(git(ctx, "diff", "--cached", "--name-only"), "", "the repo's own index is not touched");
  assert.ok(!existsSync(join(ctx.d, "idx.md")) && readdirSync(ctx.d).every((f) => f.endsWith(".md")), readdirSync(ctx.d).join(" "));
});

test("an empty list sends the tracked changes and no new file", { skip: SKIP }, (t) => {
  const ctx = repo(t);
  put(ctx, "a.txt", "two\n");
  put(ctx, "x.txt", "new\n");
  const r = prep(ctx);
  assert.equal(r.stop, undefined, r.message);
  assert.equal(r.markers, 2);
  assert.ok(sent(r, "a.txt") && !r.prompt.includes("x.txt"), r.prompt);
  assert.deepEqual(r.unsent, ["x.txt"]);
});

test("a listed ignored file stops with list before prompt.md is written", { skip: SKIP }, (t) => {
  const ctx = repo(t);
  put(ctx, "a.txt", "two\n");
  put(ctx, "debug.log", "secret-ish\n");
  const r = prep(ctx, { spec: "new debug.log\n" });
  assert.equal(r.stop, "list");
  assert.match(r.message, /^ralph-qa: 목록의 줄이 새 파일 하나가 아니다/);
  assert.match(r.detail, /debug\.log: 무시되는 파일이다/);
  assert.equal(r.prompt, null);
});

test("a listed path is read as written, not as a glob", { skip: SKIP }, (t) => {
  const ctx = repo(t);
  put(ctx, "a[1].txt", "bracket\n");
  put(ctx, "a1.txt", "plain\n");
  const r = prep(ctx, { spec: "new a[1].txt\n" });
  assert.equal(r.stop, undefined, r.message);
  assert.ok(sent(r, "a[1].txt") && !sent(r, "a1.txt"), r.prompt);
  assert.deepEqual(r.unsent, ["a1.txt"]);
});

test("base auto in a repo without a commit sends against the empty tree", { skip: SKIP }, (t) => {
  const ctx = repo(t, { commit: false });
  const r = prep(ctx, { base: "auto", spec: "new a.txt\nnew .gitignore\n" });
  assert.equal(r.stop, undefined, r.message);
  assert.ok(sent(r, "a.txt") && sent(r, ".gitignore"), r.prompt);
  const empty = spawnSync("git", ["-C", ctx.repo, "hash-object", "-t", "tree", "--stdin"], { input: "", encoding: "utf8", env: ctx.env }).stdout.trim();
  const named = prep(ctx, { base: empty, spec: "new a.txt\n" });
  assert.ok(sent(named, "a.txt"), named.prompt);
});

test("a repo with a commit and no index file at the path found stops with index-missing", { skip: SKIP }, (t) => {
  const ctx = repo(t);
  put(ctx, "a.txt", "two\n");
  const r = prep(ctx, { env: { GIT_INDEX_FILE: join(ctx.dir, "no-such-index") } });
  assert.equal(r.stop, "index-missing");
  assert.match(r.message, /커밋이 있는데 인덱스 파일이 없다/);
  assert.equal(r.prompt, null);
});

test("nothing to send stops with no-diff", { skip: SKIP }, (t) => {
  const ctx = repo(t);
  const r = prep(ctx);
  assert.equal(r.stop, "no-diff");
  assert.match(r.message, /보낼 diff 가 없다/);
  assert.equal(r.prompt, null);
});

test("a staged ignored file, a non-ASCII path with a space and a CRLF spec all go out as they are", { skip: SKIP }, (t) => {
  const ctx = repo(t);
  put(ctx, "forced.log", "kept on purpose\n");
  git(ctx, "add", "-f", "forced.log");
  put(ctx, "한글 폴더/새 파일.txt", "내용\n");
  const r = prep(ctx, { spec: "new 한글 폴더/새 파일.txt\r\n" });
  assert.equal(r.stop, undefined, r.message);
  assert.ok(sent(r, "forced.log"), r.prompt);
  assert.ok(sent(r, "한글 폴더/새 파일.txt"), "the path reaches the reviewer unescaped:\n" + r.prompt);
});

test("a change git sees only by its content (same size, as old as the index) still goes out", { skip: SKIP }, (t) => {
  // git trusts an entry's size and time unless the entry is as new as the index file it read: a
  // copy of the index stamped now would turn such a racily clean entry into a clean one.
  const ctx = repo(t);
  const then = new Date(Date.now() - 100000);
  utimesSync(join(ctx.repo, "a.txt"), then, then);
  git(ctx, "add", "a.txt");
  utimesSync(join(ctx.repo, ".git", "index"), then, then);
  put(ctx, "a.txt", "two\n");
  utimesSync(join(ctx.repo, "a.txt"), then, then);
  assert.match(git(ctx, "diff", "--name-only", "HEAD"), /a\.txt/, "the repo's own index sees the change");
  const r = prep(ctx);
  assert.equal(r.stop, undefined, r.message);
  assert.ok(sent(r, "a.txt"), r.prompt);
  put(ctx, "n.txt", "new\n"); // a listed new file: add -N writes the copy, which must keep the entry suspect
  const listed = prep(ctx, { spec: "new n.txt\n" });
  assert.equal(listed.stop, undefined, listed.message);
  assert.ok(sent(listed, "a.txt") && sent(listed, "n.txt"), listed.prompt);
});

test("a nested repo stays out, and a file listed inside it stops with the reason", { skip: SKIP }, (t) => {
  const ctx = repo(t);
  put(ctx, "a.txt", "two\n");
  put(ctx, "vendor/lib/x.txt", "v\n");
  const sub = spawnSync("git", ["-C", join(ctx.repo, "vendor", "lib"), "init", "-q"], { encoding: "utf8", env: ctx.env });
  assert.equal(sub.status, 0, sub.stderr);
  const r = prep(ctx);
  assert.equal(r.stop, undefined, r.message);
  assert.ok(sent(r, "a.txt") && !r.prompt.includes("vendor/"), r.prompt);
  assert.deepEqual(r.unsent, ["vendor/lib/"]);
  const inside = prep(ctx, { spec: "new vendor/lib/x.txt\n" });
  assert.equal(inside.stop, "list");
  assert.match(inside.detail, /vendor\/lib\/x\.txt: 하위 저장소 안이다/);
});

test("a folder line or a dot stops with list and names the new files under it", { skip: SKIP }, (t) => {
  for (const spec of ["new newfeat/f.mjs\nnew scratch\n", "new .\n", "new scratch/\n"]) {
    const ctx = repo(t);
    put(ctx, "a.txt", "two\n");
    put(ctx, "newfeat/f.mjs", "export const f = 1;\n");
    put(ctx, "scratch/conn.json", "{}\n");
    put(ctx, "scratch/deep/notes.txt", "n\n");
    const r = prep(ctx, { spec });
    assert.equal(r.stop, "list", JSON.stringify(spec));
    assert.match(r.detail, /폴더 줄이다/);
    assert.match(r.detail, /scratch\/conn\.json/, "the stop names a file that would go out");
    assert.equal(r.prompt, null);
  }
});

test("a textconv or an external diff driver in the repo's config does not change what goes out", { skip: SKIP }, (t) => {
  // git-crypt and the like decode files for git diff: the raw bytes go out, as the index holds them
  const ctx = repo(t);
  put(ctx, ".gitattributes", "*.enc diff=dec\n");
  put(ctx, "s.enc", "plain-1\n");
  git(ctx, "add", ".");
  git(ctx, "commit", "-qm", "enc");
  git(ctx, "config", "diff.dec.textconv", "sed s/plain/DECODED/");
  put(ctx, "s.enc", "plain-2\n");
  let r = prep(ctx);
  assert.equal(r.stop, undefined, r.message);
  assert.ok(r.prompt.includes("+plain-2") && !r.prompt.includes("DECODED"), r.prompt);
  const driver = join(ctx.dir, WIN ? "ext.cmd" : "ext.sh");
  writeFileSync(driver, WIN ? "@echo EXTERNAL-DRIVER-RAN\r\n" : "#!/bin/sh\necho EXTERNAL-DRIVER-RAN\n", { mode: 0o755 });
  git(ctx, "config", "diff.external", driver);
  r = prep(ctx);
  assert.equal(r.stop, undefined, r.message);
  assert.ok(r.prompt.includes("+plain-2") && !r.prompt.includes("EXTERNAL-DRIVER-RAN"), r.prompt);
});

test("a list where a file and its folder overlap, or a line repeats beside a folder, still stops", { skip: SKIP }, (t) => {
  for (const spec of ["new scratch/conn.json\nnew scratch\n", "new newfeat/f.mjs\nnew newfeat/f.mjs\nnew scratch\n"]) {
    const ctx = repo(t);
    put(ctx, "a.txt", "two\n");
    put(ctx, "newfeat/f.mjs", "export const f = 1;\n");
    put(ctx, "scratch/conn.json", "{}\n");
    put(ctx, "scratch/secret.env", "K=v\n");
    const r = prep(ctx, { spec });
    assert.equal(r.stop, "list", JSON.stringify(spec));
    assert.match(r.detail, /scratch\/secret\.env/);
    assert.equal(r.prompt, null);
  }
  const ctx = repo(t);
  put(ctx, "newfeat/f.mjs", "export const f = 1;\n");
  const r = prep(ctx, { spec: "new newfeat/f.mjs\nnew newfeat/f.mjs\n" });
  assert.equal(r.stop, undefined, r.message);
  assert.ok(sent(r, "newfeat/f.mjs"), "a repeated line alone adds nothing more");
});

test("a tracked file with bytes that are not UTF-8 goes out and the markers are still counted", { skip: SKIP }, (t) => {
  // 0.20.4 counted with the system grep: the Claude Code Bash tool's grep skips files that are not UTF-8
  const ctx = repo(t);
  put(ctx, "a.txt", "two\n");
  writeFileSync(join(ctx.repo, "euc.txt"), Buffer.from([0x61, 0x0a]));
  git(ctx, "add", "euc.txt");
  git(ctx, "commit", "-qm", "euc");
  writeFileSync(join(ctx.repo, "euc.txt"), Buffer.from([0xb0, 0xa1, 0x0a]));
  const r = prep(ctx);
  assert.equal(r.stop, undefined, r.message);
  assert.equal(r.markers, 2);
  assert.ok(readFileSync(join(ctx.d, "prompt.md")).includes(Buffer.from([0x2b, 0xb0, 0xa1, 0x0a])), "the raw bytes went out");
});

test("the user's color and submodule diff settings change nothing that goes out", { skip: SKIP }, (t) => {
  const ctx = repo(t);
  const lib = join(ctx.repo, "vendor", "lib");
  mkdirSync(lib, { recursive: true });
  const sub = (...args) => {
    const r = spawnSync("git", ["-C", lib, ...args], { encoding: "utf8", env: ctx.env });
    assert.equal(r.status, 0, r.stderr);
  };
  sub("init", "-q");
  writeFileSync(join(lib, "x.txt"), "one\n");
  sub("add", "x.txt");
  sub("commit", "-qm", "x");
  git(ctx, "add", "vendor/lib");
  git(ctx, "commit", "-qm", "lib");
  writeFileSync(join(lib, "x.txt"), "NESTED-CONTENT\n");
  sub("commit", "-qam", "y");
  git(ctx, "config", "color.ui", "always");
  git(ctx, "config", "diff.submodule", "diff");
  put(ctx, "a.txt", "two\n");
  const r = prep(ctx);
  assert.equal(r.stop, undefined, r.message);
  assert.ok(sent(r, "a.txt"), r.prompt);
  assert.ok(!r.prompt.includes("\u001b"), "no color codes before the lines the scanner anchors on");
  assert.ok(!r.prompt.includes("NESTED-CONTENT") && r.prompt.includes("Subproject commit"), r.prompt);
});

const lines200 = (changed = []) => Array.from({ length: 200 }, (_, i) => `line ${i + 1}${changed.includes(i + 1) ? " CHANGED" : ""}\n`).join("");
const contextLines = (r) => r.prompt.split("\n").filter((l) => /^ line \d+$/.test(l)).length;

test("the user's diff.context, diff.interHunkContext and GIT_DIFF_OPTS send no more than three lines around a change", { skip: SKIP }, (t) => {
  const ctx = repo(t);
  put(ctx, "big.txt", lines200());
  git(ctx, "add", "big.txt");
  git(ctx, "commit", "-qm", "big");
  put(ctx, "big.txt", lines200([100, 110]));
  assert.equal(contextLines(prep(ctx)), 12, "two hunks of 3 + 3");
  git(ctx, "config", "--global", "diff.context", "40");
  git(ctx, "config", "--global", "diff.interHunkContext", "20");
  const r = prep(ctx, { env: { GIT_DIFF_OPTS: "--unified=15" } });
  assert.equal(r.stop, undefined, r.message);
  assert.equal(contextLines(r), 12, r.prompt);
});

test("a diff attribute that spells a binary file out as text stops with binary-diff and names the file", { skip: SKIP }, (t) => {
  for (const where of ["global", "repo"]) {
    const ctx = repo(t);
    writeFileSync(join(ctx.repo, "blob.bin"), Buffer.from("BIN\0ONE\nRAW-1\n"));
    git(ctx, "add", "blob.bin");
    git(ctx, "commit", "-qm", "bin");
    writeFileSync(join(ctx.repo, "blob.bin"), Buffer.from("BIN\0TWO\nRAW-2\n"));
    if (where === "global") {
      mkdirSync(join(ctx.dir, "home", ".config", "git"), { recursive: true });
      writeFileSync(join(ctx.dir, "home", ".config", "git", "attributes"), "*.bin diff\n");
    } else {
      writeFileSync(join(ctx.repo, ".git", "info", "attributes"), "*.bin diff\n");
    }
    const r = prep(ctx);
    assert.equal(r.stop, "binary-diff", where);
    assert.match(r.message, /diff 에 바이너리 바이트가 있다/, where);
    assert.match(r.detail, /blob\.bin/, where);
    assert.equal(r.prompt, null, where);
  }
});

test("a file the user's global attributes hide from diffs with -diff stays hidden", { skip: SKIP }, (t) => {
  const ctx = repo(t);
  put(ctx, "creds.dat", "value=ONE\n");
  git(ctx, "add", "creds.dat");
  git(ctx, "commit", "-qm", "creds");
  put(ctx, "creds.dat", "value=TWO\n");
  mkdirSync(join(ctx.dir, "home", ".config", "git"), { recursive: true });
  writeFileSync(join(ctx.dir, "home", ".config", "git", "attributes"), "*.dat -diff\n");
  const r = prep(ctx);
  assert.equal(r.stop, undefined, r.message);
  assert.ok(/^Binary files /m.test(r.prompt) && !r.prompt.includes("value=TWO"), r.prompt);
});

const shared = (ctx) => readdirSync(join(ctx.repo, ".git")).filter((f) => f.startsWith("sharedindex.")).sort();

test("a split index repo keeps its .git as it was: the add -N on the copy writes no shared index there", { skip: SKIP }, (t) => {
  const ctx = repo(t);
  git(ctx, "config", "core.splitIndex", "true");
  git(ctx, "update-index", "--split-index");
  put(ctx, "a.txt", "two\n");
  put(ctx, "n.txt", "new\n");
  const before = shared(ctx);
  const r = prep(ctx, { spec: "new n.txt\n" });
  assert.equal(r.stop, undefined, r.message);
  assert.ok(sent(r, "a.txt") && sent(r, "n.txt"), r.prompt);
  assert.deepEqual(shared(ctx), before, "no new sharedindex.<hash> in the repo's .git");
});

test("a split index repo with a file whose stat alone changed keeps its .git as it was", { skip: SKIP }, (t) => {
  // git diff writes the copy back as a split index when a tracked file's stat changed: every command on the copy
  // must keep it whole, not only add -N
  const ctx = repo(t);
  for (let k = 0; k < 6; k += 1) put(ctx, `f${k}.txt`, `${k}\n`);
  git(ctx, "add", ".");
  git(ctx, "commit", "-qm", "more");
  git(ctx, "config", "core.splitIndex", "true");
  git(ctx, "update-index", "--split-index");
  const old = new Date(Date.now() - 3600 * 1000);
  utimesSync(join(ctx.repo, "f1.txt"), old, old);
  put(ctx, "a.txt", "two\n");
  put(ctx, "n.txt", "new\n");
  const before = shared(ctx);
  const r = prep(ctx, { spec: "new n.txt\n" });
  assert.equal(r.stop, undefined, r.message);
  assert.ok(sent(r, "a.txt") && sent(r, "n.txt"), r.prompt);
  assert.deepEqual(shared(ctx), before, "no new sharedindex.<hash> in the repo's .git");
});

test("a new name with a newline never goes out and does not stop prepare", { skip: SKIP }, (t) => {
  // 0.20.4 stopped: its list check read such a name as two lines, and with a folder line the two halves
  // matched two listed files. The runner compares exact names, so the name can be neither listed nor sent.
  const ctx = repo(t);
  put(ctx, "a.txt", "two\n");
  put(ctx, "scratch/p", "intended\n");
  put(ctx, "q", "intended q\n");
  try {
    put(ctx, "scratch/p\nq", "NOT-LISTED\n");
  } catch (e) {
    t.skip(`this file system takes no newline in a name (${e.code})`);
    return;
  }
  const r = prep(ctx, { spec: "new scratch/p\nnew q\n" });
  assert.equal(r.stop, undefined, r.message);
  assert.ok(sent(r, "scratch/p") && sent(r, "q"), r.prompt);
  assert.ok(!r.prompt.includes("NOT-LISTED"), r.prompt);
  assert.deepEqual(r.unsent, ['"scratch/p\\nq"'], "left in unsent.md, quoted the way git lists it");
});

test("a related range names its file and lines, reads any name, and comes only from a tracked or listed file", { skip: SKIP }, (t) => {
  const ctx = repo(t);
  for (const name of ["-x.txt", "it's.txt"]) put(ctx, name, "l1\nl2\nl3\nl4\n");
  git(ctx, "add", "--", "-x.txt", "it's.txt");
  git(ctx, "commit", "-qm", "names");
  put(ctx, "a.txt", "two\n");
  put(ctx, "listed.mjs", "n1\nn2\n");
  put(ctx, "-listed.mjs", "d1\nd2\n");
  put(ctx, "-x-unsent.txt", "UNSENT\n");
  put(ctx, "unsent.mjs", "u1\nUNSENT\n");
  put(ctx, "debug.log", "IGNORED\n");
  const spec = "new listed.mjs\r\nnew -listed.mjs\nrange 2 3 -x.txt\nrange 1 1 it's.txt\nrange 2 2 listed.mjs\nrange 1 1 -listed.mjs\n";
  const r = prep(ctx, { spec });
  assert.equal(r.stop, undefined, r.message);
  assert.ok(r.prompt.includes("=== -x.txt:2-3\nl2\nl3\n=== it's.txt:1-1\nl1\n=== listed.mjs:2-2\nn2\n=== -listed.mjs:1-1\nd1\n"), r.prompt);
  for (const name of ["unsent.mjs", "debug.log", "-x-unsent.txt", "no-such.txt"]) {
    const s = prep(ctx, { spec: `range 1 2 ${name}\n` });
    assert.equal(s.stop, "range-source", name);
    assert.match(s.message, /관련 범위의 파일이 추적 파일도 목록의 새 파일도 아니다/, name);
    assert.equal(s.prompt, null);
  }
  const outside = prep(ctx, { spec: "range 1 2 ../outside.txt\n" });
  assert.equal(outside.stop, "spec");
  assert.match(outside.message, /spec 1:/);
});

test("a related range outside its file stops with range-outside, and an end past the file takes the lines there are", { skip: SKIP }, (t) => {
  const ctx = repo(t);
  put(ctx, "three.txt", "l1\nl2\nl3\n");
  git(ctx, "add", "--", "three.txt");
  git(ctx, "commit", "-qm", "three");
  put(ctx, "a.txt", "two\n");
  const ok = prep(ctx, { spec: "range 2 5 three.txt\n" });
  assert.equal(ok.stop, undefined, ok.message);
  assert.ok(ok.prompt.includes("=== three.txt:2-5\nl2\nl3\n</review-data"), ok.prompt);
  for (const [from, to] of [[5, 9], [0, 2], [3, 2]]) {
    const r = prep(ctx, { spec: `range ${from} ${to} three.txt\n` });
    assert.equal(r.stop, "range-outside", `${from}-${to}`);
    assert.match(r.message, /관련 범위가 파일 밖이다: three\.txt/, `${from}-${to}: ${r.message}`);
  }
});

test("a long listing folds each wholly new folder to one line and opens the one asked for", { skip: SKIP }, (t) => {
  const ctx = repo(t);
  for (let k = 0; k < 300; k += 1) put(ctx, `node_modules/p${k}/i.js`, "x\n");
  put(ctx, "src/feature.mjs", "export const f = 1;\n");
  const r = untracked({ repo: ctx.repo, env: ctx.env });
  assert.equal(r.folded, true);
  assert.equal(r.count, 301);
  assert.deepEqual(r.files.sort(), ["node_modules/", "src/"]);
  assert.deepEqual(untracked({ repo: ctx.repo, env: ctx.env, folder: "src" }).files, ["src/feature.mjs"]);
});

test("a name the listing quotes is written as itself; the quoted line stops and gives the name to write", { skip: SKIP }, (t) => {
  const ctx = repo(t);
  try {
    put(ctx, 'q"uote.txt', "q\n");
  } catch (e) {
    t.skip(`this file system takes no " in a name (${e.code})`);
    return;
  }
  put(ctx, "plain.txt", "p\n");
  assert.ok(untracked({ repo: ctx.repo, env: ctx.env }).files.includes('q"uote.txt'), "the listing gives the name as it is");
  let r = prep(ctx, { spec: 'new "q\\"uote.txt"\n' });
  assert.equal(r.stop, "list");
  assert.match(r.detail, /따옴표를 풀지 않은 줄이다/);
  assert.ok(r.detail.includes('new q"uote.txt'), r.detail);
  r = prep(ctx, { spec: 'new q"uote.txt\nnew ./plain.txt\n' });
  assert.equal(r.stop, undefined, r.message);
  assert.ok(r.prompt.includes('+++ "b/q\\"uote.txt"') && sent(r, "plain.txt"), r.prompt);
});

test("a second prepare in the same folder starts from a fresh index copy, so a file taken off the list stays out", { skip: SKIP }, (t) => {
  // A run cut short can leave its index copy behind: the next prepare must not build on it.
  const ctx = repo(t, { commit: false });
  put(ctx, "secret.txt", "K=v\n");
  const stale = join(ctx.d, "idx.md");
  const add = spawnSync("git", ["-C", ctx.repo, "add", "-N", "--", "secret.txt", "a.txt"], { encoding: "utf8", env: { ...ctx.env, GIT_INDEX_FILE: stale } });
  assert.equal(add.status, 0, add.stderr);
  const r = prep(ctx, { base: "auto", spec: "new a.txt\n" });
  assert.equal(r.stop, undefined, r.message);
  assert.ok(sent(r, "a.txt") && !r.prompt.includes("secret.txt"), r.prompt);
  assert.ok(r.unsent.includes("secret.txt"), `left in unsent.md: ${r.unsent}`);
  assert.ok(!existsSync(stale), "the index copy is gone after prepare");
});

test("with no diff to send, review lines take the file to review and file lines the base file", { skip: SKIP }, (t) => {
  const ctx = repo(t);
  put(ctx, ".gitignore", "*.log\n.omc/\n");
  git(ctx, "add", ".gitignore");
  git(ctx, "commit", "-qm", "ignore .omc");
  put(ctx, ".omc/plans/p.md", "the plan\n");
  writeFileSync(join(ctx.dir, "base.md"), "the base file\n");
  assert.equal(prep(ctx).stop, "no-diff");
  const r = prep(ctx, { spec: `review ${join(ctx.repo, ".omc", "plans", "p.md")}\nfile ${join(ctx.dir, "base.md")}\n` });
  assert.equal(r.stop, undefined, r.message);
  assert.equal(r.markers, 2);
  assert.ok(r.prompt.includes("=== review .omc/plans/p.md\nthe plan\n=== file base.md\nthe base file\n</review-data"), r.prompt);
});

const canLink = (() => {
  const dir = mkdtempSync(join(tmpdir(), "rq-link-"));
  try {
    symlinkSync(join(dir, "x"), join(dir, "l"));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

test("a related range is not read through a link: a tracked or listed link, or a file in a linked folder, stops", { skip: SKIP || (!canLink && "no symlinks here") }, (t) => {
  const ctx = repo(t);
  const outside = join(ctx.dir, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), "OUTSIDE-1\nOUTSIDE-2\n");
  symlinkSync(join(outside, "secret.txt"), join(ctx.repo, "link.txt"));
  put(ctx, "sub/y.txt", "inside\n");
  git(ctx, "add", "link.txt", "sub/y.txt");
  git(ctx, "commit", "-qm", "a link and a folder");
  symlinkSync(join(outside, "secret.txt"), join(ctx.repo, "new-link.txt"));
  put(ctx, "a.txt", "two\n");
  // the folder of a tracked file turned into a link outside git (an archive that came with its .git)
  rmSync(join(ctx.repo, "sub"), { recursive: true });
  writeFileSync(join(outside, "y.txt"), "OUTSIDE-SUB\n");
  symlinkSync(outside, join(ctx.repo, "sub"), "dir");
  for (const name of ["link.txt", "new-link.txt", "sub/y.txt"]) {
    const r = prep(ctx, { spec: `new new-link.txt\nrange 1 2 ${name}\n` });
    assert.equal(r.stop, "range-link", name);
    assert.match(r.message, /링크이거나 링크 폴더 아래/, name);
    assert.equal(r.prompt, null);
  }
});

// macOS gives the temp folder as /var/... where git gives the repo as /private/var/...: a review or file line
// that reaches the repo by another spelling (a link above it) is a file in the repo all the same.
test("a review line that reaches the repo through a link above it names the file from the repo root and stops at a link inside", { skip: SKIP || (!canLink && "no symlinks here") }, (t) => {
  const ctx = repo(t);
  put(ctx, ".gitignore", "*.log\n.omc/\n");
  git(ctx, "add", ".gitignore");
  git(ctx, "commit", "-qm", "ignore .omc");
  put(ctx, ".omc/plans/p.md", "the plan\n");
  const other = mkdtempSync(join(tmpdir(), "rq-alias-"));
  t.after(() => rmSync(other, { recursive: true, force: true }));
  const alias = join(other, "to");
  symlinkSync(ctx.dir, alias, "dir");
  let r = prep(ctx, { spec: `review ${join(alias, "repo", ".omc", "plans", "p.md")}\n` });
  assert.equal(r.stop, undefined, r.message);
  assert.ok(r.prompt.includes("=== review .omc/plans/p.md\nthe plan\n"), r.prompt);
  const outside = join(ctx.dir, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "x.md"), "OUTSIDE\n");
  symlinkSync(outside, join(ctx.repo, ".omc", "inner"), "dir");
  r = prep(ctx, { spec: `review ${join(alias, "repo", ".omc", "inner", "x.md")}\n` });
  assert.equal(r.stop, "file", r.prompt);
  assert.match(r.message, /링크이거나 링크 폴더 아래에 있다/);
  assert.equal(r.prompt, null);
});

test("a ./ line in spec names its file, for the list and for a related range", { skip: SKIP }, (t) => {
  const ctx = repo(t);
  put(ctx, "plain.txt", "p1\np2\n");
  const r = prep(ctx, { spec: "new ./plain.txt\nrange 2 2 ./plain.txt\n" });
  assert.equal(r.stop, undefined, r.message);
  assert.ok(sent(r, "plain.txt"), r.prompt);
  assert.ok(r.prompt.includes("=== plain.txt:2-2\np2\n"), r.prompt);
});

test("a fsmonitor hook in the repo's config never runs while the payload is built", { skip: SKIP || (WIN && "the hook is a sh script") }, (t) => {
  // git runs core.fsmonitor as a command whenever it refreshes an index: a repo that came with its .git
  // (an archive) would run its own program in the author's session
  const ctx = repo(t);
  const ran = join(ctx.dir, "fsmonitor-ran");
  const hook = join(ctx.dir, "fsmonitor.sh");
  writeFileSync(hook, `#!/bin/sh\necho ran > '${ran}'\nexit 1\n`, { mode: 0o755 });
  git(ctx, "config", "core.fsmonitor", hook);
  put(ctx, "a.txt", "two\n");
  put(ctx, "n.txt", "new\n");
  const r = prep(ctx, { spec: "new n.txt\n" });
  assert.equal(r.stop, undefined, r.message);
  assert.ok(sent(r, "a.txt") && sent(r, "n.txt"), r.prompt);
  assert.ok(!existsSync(ran), "the repo's fsmonitor hook ran");
});

// 0.20.5 security review: a repo that came with its .git (an archive) can name programs in its own hooks and filter
// drivers, and in a submodule's own .git; none of them runs while the payload is built.
const marker = (ctx, name) => join(ctx.dir, "marks", name);
const markerCmd = (ctx, name) => `sh -c 'echo ran >> "${marker(ctx, name).replace(/\\/g, "/")}"; cat'`;
const hookScript = (ctx, name) => `#!/bin/sh\necho ran >> "${marker(ctx, name).replace(/\\/g, "/")}"\n`;

test("a repo's own hooks and filter drivers never run while the payload is built, and its files go out as they are", { skip: SKIP }, (t) => {
  const ctx = repo(t);
  mkdirSync(join(ctx.dir, "marks"));
  put(ctx, ".gitattributes", "*.txt filter=pwn\n");
  git(ctx, "add", ".gitattributes");
  git(ctx, "commit", "-qm", "attributes");
  writeFileSync(join(ctx.repo, ".git", "hooks", "post-index-change"), hookScript(ctx, "hook"), { mode: 0o755 });
  git(ctx, "config", "filter.pwn.clean", markerCmd(ctx, "clean"));
  git(ctx, "config", "filter.pwn.smudge", markerCmd(ctx, "smudge"));
  git(ctx, "config", "filter.pwn.required", "true");
  put(ctx, "a.txt", "two\n");
  put(ctx, "n.txt", "new\n");
  const r = prep(ctx, { spec: "new n.txt\n" });
  assert.equal(r.stop, undefined, r.message);
  assert.ok(sent(r, "a.txt") && sent(r, "n.txt") && r.prompt.includes("+two\n"), r.prompt);
  assert.deepEqual(readdirSync(join(ctx.dir, "marks")), [], "a hook or a filter of the repo ran");
});

test("a filter the user's own config defines stays, when the repo's config names it too", { skip: SKIP }, (t) => {
  const ctx = repo(t);
  mkdirSync(join(ctx.dir, "marks"));
  git(ctx, "config", "--global", "filter.keep.clean", markerCmd(ctx, "user"));
  put(ctx, ".gitattributes", "*.txt filter=keep\n");
  git(ctx, "add", ".gitattributes");
  git(ctx, "commit", "-qm", "attributes");
  rmSync(marker(ctx, "user"), { force: true });
  git(ctx, "config", "filter.keep.clean", markerCmd(ctx, "repo"));
  put(ctx, "a.txt", "two\n");
  const r = prep(ctx);
  assert.equal(r.stop, undefined, r.message);
  assert.ok(existsSync(marker(ctx, "user")), "the user's filter ran");
  assert.ok(!existsSync(marker(ctx, "repo")), "the repo's filter ran");
});

test("a filter name the runner cannot turn off stops before anything runs", { skip: SKIP }, (t) => {
  const ctx = repo(t);
  mkdirSync(join(ctx.dir, "marks"));
  git(ctx, "config", "filter.a=b.clean", markerCmd(ctx, "eq"));
  put(ctx, "a.txt", "two\n");
  const r = prep(ctx);
  assert.equal(r.stop, "git-failed", r.prompt);
  assert.match(r.message, /filter/);
  assert.equal(r.prompt, null);
  assert.ok(!existsSync(marker(ctx, "eq")));
});

test("a submodule's own hooks and filters never run: its dirt is not looked into", { skip: SKIP }, (t) => {
  const ctx = repo(t);
  mkdirSync(join(ctx.dir, "marks"));
  const sub = join(ctx.dir, "sub-src");
  mkdirSync(sub);
  const sg = (...a) => assert.equal(spawnSync("git", ["-C", sub, ...a], { encoding: "utf8", env: ctx.env }).status, 0, a.join(" "));
  sg("-c", "init.defaultBranch=main", "init", "-q");
  writeFileSync(join(sub, "s.txt"), "x\n");
  writeFileSync(join(sub, ".gitattributes"), "* filter=zzz\n");
  sg("add", ".");
  sg("commit", "-qm", "s");
  git(ctx, "-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "sub");
  git(ctx, "commit", "-qm", "add sub");
  const modules = join(ctx.repo, ".git", "modules", "sub");
  assert.equal(spawnSync("git", ["config", "-f", join(modules, "config"), "filter.zzz.clean", markerCmd(ctx, "sub-filter")], { env: ctx.env }).status, 0);
  mkdirSync(join(modules, "hooks"), { recursive: true });
  writeFileSync(join(modules, "hooks", "post-index-change"), hookScript(ctx, "sub-hook"), { mode: 0o755 });
  writeFileSync(join(ctx.repo, "sub", "s.txt"), "x2\n");
  put(ctx, "a.txt", "two\n");
  const r = prep(ctx);
  assert.equal(r.stop, undefined, r.message);
  assert.ok(sent(r, "a.txt"), r.prompt);
  assert.deepEqual(readdirSync(join(ctx.dir, "marks")), [], "a submodule's hook or filter ran");
});

// A .git file, a link or core.worktree in the repo can make git read another repo: its files would go out as
// deleted lines. Git's own layouts (a linked worktree, a submodule) still work.
test("a repo whose git folder or work tree is another repo's stops, and git's linked worktree and submodule still go", { skip: SKIP }, (t) => {
  const ctx = repo(t);
  const other = join(ctx.dir, "other");
  mkdirSync(other);
  const og = (...a) => assert.equal(spawnSync("git", ["-C", other, ...a], { encoding: "utf8", env: ctx.env }).status, 0, a.join(" "));
  og("-c", "init.defaultBranch=main", "init", "-q");
  writeFileSync(join(other, "private.txt"), "PRIVATE-ONE\n");
  og("add", ".");
  og("commit", "-qm", "private");
  const archive = join(ctx.dir, "archive");
  mkdirSync(archive);
  writeFileSync(join(archive, ".git"), `gitdir: ${join(other, ".git")}\n`);
  writeFileSync(join(archive, "x.txt"), "x\n");
  const at = (dir) => prep({ ...ctx, repo: dir });
  let r = at(archive);
  assert.equal(r.stop, "not-a-repo", r.prompt);
  assert.equal(r.prompt, null);
  git(ctx, "config", "core.worktree", other);
  r = prep(ctx);
  assert.equal(r.stop, "not-a-repo", r.prompt);
  git(ctx, "config", "--unset", "core.worktree");
  // a .git file naming another repo's linked worktree folder: its gitdir file names that worktree, not this folder
  const otherWt = join(ctx.dir, "other-wt");
  og("worktree", "add", "-q", "-b", "o-side", otherWt);
  writeFileSync(join(archive, ".git"), `gitdir: ${join(other, ".git", "worktrees", "other-wt")}\n`);
  r = at(archive);
  assert.equal(r.stop, "not-a-repo", r.prompt);
  const wt = join(ctx.dir, "wt");
  git(ctx, "worktree", "add", "-q", "-b", "side", wt);
  writeFileSync(join(wt, "a.txt"), "three\n");
  r = at(wt);
  assert.equal(r.stop, undefined, r.message);
  assert.ok(r.prompt.includes("+three\n"), r.prompt);
  for (const x of [r.prompt || "", readFileSync(join(ctx.d, "raw.md"), "utf8")]) assert.ok(!x.includes("PRIVATE"), x);
});

test("a submodule given as the repo goes: its git folder in the superproject points back to it", { skip: SKIP }, (t) => {
  const ctx = repo(t);
  const sub = join(ctx.dir, "sub-src");
  mkdirSync(sub);
  const sg = (...a) => assert.equal(spawnSync("git", ["-C", sub, ...a], { encoding: "utf8", env: ctx.env }).status, 0, a.join(" "));
  sg("-c", "init.defaultBranch=main", "init", "-q");
  writeFileSync(join(sub, "s.txt"), "x\n");
  sg("add", ".");
  sg("commit", "-qm", "s");
  git(ctx, "-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "sub");
  writeFileSync(join(ctx.repo, "sub", "s.txt"), "x2\n");
  const r = prep({ ...ctx, repo: join(ctx.repo, "sub") });
  assert.equal(r.stop, undefined, r.message);
  assert.ok(sent(r, "s.txt") && r.prompt.includes("+x2\n"), r.prompt);
});

// The same class through git's other ways of reading a folder elsewhere: a commondir file, core.worktree set above
// the folder given, a refs or objects folder that is a link. The other repo's HEAD names its files.
test("a git folder that reads another repo's refs (commondir, linked refs and objects) or a work tree above the folder given stops", { skip: SKIP }, (t) => {
  const ctx = repo(t);
  const other = join(ctx.dir, "other");
  mkdirSync(other);
  const og = (...a) => assert.equal(spawnSync("git", ["-C", other, ...a], { encoding: "utf8", env: ctx.env }).status, 0, a.join(" "));
  og("-c", "init.defaultBranch=main", "init", "-q");
  writeFileSync(join(other, "private.txt"), "PRIVATE-TWO\n");
  og("add", ".");
  og("commit", "-qm", "private");
  // commondir: an archive's own .git that takes refs, objects and config from the other repo
  const archive = join(ctx.dir, "archive");
  mkdirSync(join(archive, ".git"), { recursive: true });
  writeFileSync(join(archive, ".git", "commondir"), `${join(other, ".git")}\n`);
  writeFileSync(join(archive, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(archive, "x.txt"), "x\n");
  let r = prep({ ...ctx, repo: archive });
  assert.equal(r.stop, "not-a-repo", r.prompt);
  // core.worktree above the folder given: git's work tree would be the folder holding the repo
  put(ctx, "sub/s.txt", "s\n");
  git(ctx, "config", "core.worktree", ctx.dir);
  r = prep({ ...ctx, repo: join(ctx.repo, "sub") });
  assert.equal(r.stop, "not-a-repo", r.prompt);
  git(ctx, "config", "--unset", "core.worktree");
  // an archive inside another repo whose core.worktree is that repo: git from the top would find the other repo
  const inner = join(other, "inner");
  mkdirSync(inner);
  assert.equal(spawnSync("git", ["-C", inner, "-c", "init.defaultBranch=main", "init", "-q"], { env: ctx.env }).status, 0);
  assert.equal(spawnSync("git", ["-C", inner, "config", "core.worktree", "../.."], { env: ctx.env }).status, 0);
  writeFileSync(join(other, "private.txt"), "PRIVATE-TWO changed\n");
  r = prep({ ...ctx, repo: inner });
  assert.equal(r.stop, "not-a-repo", r.prompt);
  if (canLink) {
    const linked = join(ctx.dir, "linked");
    mkdirSync(join(linked, ".git"), { recursive: true });
    for (const n of ["refs", "objects"]) symlinkSync(join(other, ".git", n), join(linked, ".git", n), "dir");
    writeFileSync(join(linked, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(linked, "x.txt"), "x\n");
    r = prep({ ...ctx, repo: linked });
    assert.equal(r.stop, "not-a-repo", r.prompt);
    assert.match(r.detail, /refs/);
  }
  for (const x of [r.prompt || "", existsSync(join(ctx.d, "raw.md")) ? readFileSync(join(ctx.d, "raw.md"), "utf8") : ""]) assert.ok(!x.includes("PRIVATE"), x);
});

// The second security review: a real .git that borrows another repo's objects (objects/info/alternates, a plain
// file) and its refs below the top folders (refs/heads a link) names that repo's tip without its sha.
test("a git folder that borrows another repo's objects (alternates) or links below refs or objects stops", { skip: SKIP }, (t) => {
  const ctx = repo(t);
  const victim = join(ctx.dir, "victim");
  mkdirSync(victim);
  const vg = (...a) => assert.equal(spawnSync("git", ["-C", victim, ...a], { encoding: "utf8", env: ctx.env }).status, 0, a.join(" "));
  vg("-c", "init.defaultBranch=main", "init", "-q");
  writeFileSync(join(victim, "secret.c"), "VICTIM-SECRET\n");
  vg("add", ".");
  vg("commit", "-qm", "v");
  const sha = spawnSync("git", ["-C", victim, "rev-parse", "HEAD"], { encoding: "utf8", env: ctx.env }).stdout.trim();
  // alternates and a packed-refs line naming the victim's commit
  writeFileSync(join(ctx.repo, ".git", "objects", "info", "alternates"), `${join(victim, ".git", "objects")}\n`);
  writeFileSync(join(ctx.repo, ".git", "packed-refs"), `${sha} refs/heads/borrowed\n`);
  let r = prep(ctx, { base: "borrowed" });
  assert.equal(r.stop, "not-a-repo", r.prompt);
  assert.match(r.detail, /alternates/);
  rmSync(join(ctx.repo, ".git", "objects", "info", "alternates"));
  rmSync(join(ctx.repo, ".git", "packed-refs"));
  if (canLink) {
    // refs/heads a link to the victim's: HEAD names the victim's tip; objects/pack a link the same way
    const own = git(ctx, "rev-parse", "HEAD").trim();
    const heads = join(ctx.repo, ".git", "refs", "heads");
    rmSync(heads, { recursive: true });
    symlinkSync(join(victim, ".git", "refs", "heads"), heads, "dir");
    r = prep(ctx);
    assert.equal(r.stop, "not-a-repo", r.prompt);
    assert.match(r.detail, /refs/);
    rmSync(heads);
    mkdirSync(heads);
    git(ctx, "update-ref", "refs/heads/main", own);
    // a linked worktree's own refs folder (worktree refs such as refs/bisect) as a link
    const wt = join(ctx.dir, "wt-refs");
    git(ctx, "worktree", "add", "-q", "--detach", wt);
    // newer gits (2.50 on macOS, 2.55 on Windows) make that folder at worktree add; 2.43 does not
    const wtRefs = join(ctx.repo, ".git", "worktrees", "wt-refs", "refs");
    rmSync(wtRefs, { recursive: true, force: true });
    symlinkSync(join(victim, ".git", "refs"), wtRefs, "dir");
    r = prep({ ...ctx, repo: wt });
    assert.equal(r.stop, "not-a-repo", r.prompt);
  }
  for (const x of [r.prompt || "", existsSync(join(ctx.d, "raw.md")) ? readFileSync(join(ctx.d, "raw.md"), "utf8") : ""]) assert.ok(!x.includes("VICTIM"), x);
});

// A partial clone fetches a missing object from its promisor remote when the diff needs it; the runner's git reaches
// no remote at all (here a local file:// one, which a real archive would make an https or ssh one).
test("git never fetches while the payload is built: a partial clone's missing object stops instead", { skip: SKIP }, (t) => {
  const ctx = repo(t);
  git(ctx, "config", "uploadpack.allowFilter", "true");
  const client = join(ctx.dir, "client");
  const url = `file://${ctx.repo.replace(/\\/g, "/").replace(/^([A-Za-z]):/, "/$1:")}`;
  const c = spawnSync("git", ["-c", "protocol.file.allow=always", "clone", "-q", "--no-checkout", "--filter=blob:none", url, client], { encoding: "utf8", env: ctx.env });
  assert.equal(c.status, 0, c.stderr);
  // an index from HEAD's trees (they came with the clone) and no files: the diff needs the blobs it never fetched
  assert.equal(spawnSync("git", ["-C", client, "read-tree", "HEAD"], { env: ctx.env }).status, 0);
  let r = prep({ ...ctx, repo: client });
  assert.equal(r.stop, "git-failed", r.prompt);
  assert.equal(r.prompt, null);
  // code review: the repo's own protocol.<name>.allow outranks -c protocol.allow=never
  assert.equal(spawnSync("git", ["-C", client, "config", "protocol.file.allow", "always"], { env: ctx.env }).status, 0);
  r = prep({ ...ctx, repo: client });
  assert.equal(r.stop, "git-failed", r.prompt);
  assert.equal(r.prompt, null);
});

test("a .git link to another repo's git folder stops", { skip: SKIP || (!canLink && "no symlinks here") }, (t) => {
  const ctx = repo(t);
  const archive = join(ctx.dir, "archive");
  mkdirSync(archive);
  symlinkSync(join(ctx.repo, ".git"), join(archive, ".git"), "dir");
  writeFileSync(join(archive, "x.txt"), "x\n");
  const r = prep({ ...ctx, repo: archive });
  assert.equal(r.stop, "not-a-repo", r.prompt);
  assert.equal(r.prompt, null);
});

// ---- new with the runner: the checks of what goes out, spec.md errors, the author's encodings, the raw parts, split
const MARK = '<review-data id="a1b2c3d4">';
const CLOSE = '</review-data id="a1b2c3d4">';

test("prepare writes prompt.md, raw.md and run.md only when it completes: a stop late in the build leaves none", { skip: SKIP }, (t) => {
  const ctx = repo(t);
  put(ctx, "a.txt", "two\n");
  put(ctx, "three.txt", "l1\nl2\nl3\n");
  git(ctx, "add", "three.txt");
  git(ctx, "commit", "-qm", "three");
  put(ctx, "a.txt", "three\n");
  assert.equal(prep(ctx).stop, undefined);
  const r = prep(ctx, { spec: "range 9 9 three.txt\n" });
  assert.equal(r.stop, "range-outside");
  for (const f of ["prompt.md", "raw.md", "run.md", "unsent.md"]) assert.ok(!existsSync(join(ctx.d, f)), `${f} of the last prepare is gone`);
});

test("the short part holds its opening marker once; the marker of the id in a raw part stops with markers", { skip: SKIP }, (t) => {
  const ctx = repo(t);
  put(ctx, "a.txt", "two\n");
  // a closing marker alone in the short part would make two lines with the one prepare adds, and no data block opens
  for (const short of ["no marker\n", `${MARK}\n${MARK}\n`, `${MARK}\n${CLOSE}\n`, `${CLOSE}\nreview this\n`]) {
    assert.equal(prep(ctx, { short }).stop, "markers", JSON.stringify(short));
  }
  put(ctx, "a.txt", `quoting ${CLOSE} in a file\n`);
  const r = prep(ctx);
  assert.equal(r.stop, "markers");
  assert.match(r.message, /표지가 두 줄이 아니다\(3줄\)/);
  assert.equal(r.prompt, null);
});

test("secret-like lines come back with their numbers, and check passes once they are masked", { skip: SKIP }, (t) => {
  const ctx = repo(t);
  const value = ["s3", "cr3t", "V4lue"].join("");
  put(ctx, "a.txt", `password = ${value}\n`);
  const r = prep(ctx);
  assert.equal(r.stop, undefined, r.message);
  assert.equal(r.scan.count, 1);
  const line = r.scan.hits[0].line;
  assert.ok(readFileSync(join(ctx.d, "prompt.md"), "utf8").split("\n")[line - 1].includes(value), "the number names the line");
  assert.deepEqual(checkPayload({ dir: ctx.d }).scan.hits.map((h) => h.line), [line], "check finds it too before the mask");
  writeFileSync(join(ctx.d, "prompt.md"), readFileSync(join(ctx.d, "prompt.md"), "utf8").replace(value, "[REDACTED]"));
  const c = checkPayload({ dir: ctx.d });
  assert.deepEqual([c.scan.count, c.markers, c.tooLarge], [0, 2, false]);
});

test("a payload over 512 KiB is reported as too large on the whole, before any part is split off", { skip: SKIP }, (t) => {
  const ctx = repo(t);
  put(ctx, "big.txt", "x".repeat(100) + "\n");
  git(ctx, "add", "big.txt");
  git(ctx, "commit", "-qm", "big");
  put(ctx, "big.txt", Array.from({ length: 6000 }, (_, i) => `line ${i} ${"y".repeat(90)}`).join("\n") + "\n");
  const r = prep(ctx);
  assert.equal(r.stop, undefined, r.message);
  assert.ok(r.bytes > MAX_BYTES, `${r.bytes}`);
  assert.equal(checkPayload({ dir: ctx.d }).tooLarge, true);
  assert.equal(MAX_BYTES, 524288);
});

test("spec.md errors stop with the line number: an unknown word, bad numbers, an absolute, .. or empty path", { skip: SKIP }, (t) => {
  const ctx = repo(t);
  put(ctx, "a.txt", "two\n");
  for (const [spec, line] of [["new a.txt\nadd b.txt\n", 2], ["range one 2 a.txt\n", 1], ["# a note\n\nrange -1 2 a.txt\n", 3], ["new /etc/passwd\n", 1],
    ["new ../outside.txt\n", 1], ["new sub/../../x\n", 1], ["new ./\n", 1], ["range 1 2\n", 1]]) {
    const r = prep(ctx, { spec });
    assert.equal(r.stop, "spec", JSON.stringify(spec));
    assert.match(r.message, new RegExp(`^ralph-qa: spec ${line}:`), `${JSON.stringify(spec)}: ${r.message}`);
  }
});

test("a BOM is dropped from short.md and spec.md, UTF-16 is read as text, and spec.md that is not UTF-8 stops", { skip: SKIP }, (t) => {
  const ctx = repo(t);
  put(ctx, "a.txt", "two\n");
  put(ctx, "n.txt", "new\n");
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  writeFileSync(join(ctx.d, "short.md"), Buffer.concat([bom, Buffer.from(`${MARK}\n요청\n`)]));
  writeFileSync(join(ctx.d, "spec.md"), Buffer.concat([bom, Buffer.from("new n.txt\n")]));
  buildPayload({ dir: ctx.d, repo: ctx.repo, base: "HEAD", id: "a1b2c3d4", env: ctx.env });
  let prompt = readFileSync(join(ctx.d, "prompt.md"));
  assert.ok(prompt.slice(0, MARK.length).equals(Buffer.from(MARK)), "prompt.md starts with the marker, no BOM");
  assert.ok(prompt.includes(Buffer.from("+++ b/n.txt")));
  // PowerShell 5.1's Out-File writes UTF-16 with a BOM
  const utf16 = (s) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, "utf16le")]);
  writeFileSync(join(ctx.d, "short.md"), utf16(`${MARK}\n한글 요청\n`));
  writeFileSync(join(ctx.d, "spec.md"), utf16("new n.txt\r\n"));
  buildPayload({ dir: ctx.d, repo: ctx.repo, base: "HEAD", id: "a1b2c3d4", env: ctx.env });
  prompt = readFileSync(join(ctx.d, "prompt.md"), "utf8");
  assert.ok(prompt.startsWith(`${MARK}\n한글 요청\n`) && prompt.includes("+++ b/n.txt"), prompt);
  writeFileSync(join(ctx.d, "spec.md"), Buffer.from([0x6e, 0x65, 0x77, 0x20, 0xb0, 0xa1, 0x0a]));
  assert.throws(() => buildPayload({ dir: ctx.d, repo: ctx.repo, base: "HEAD", id: "a1b2c3d4", env: ctx.env }), (e) => e.code === "spec" && /UTF-8/.test(e.message));
});

test("a FIFO or a folder named by a file, gate or review line stops without blocking", { skip: SKIP || (WIN && "no FIFO") }, (t) => {
  const ctx = repo(t);
  put(ctx, "a.txt", "two\n");
  const fifo = join(ctx.dir, "gate.md");
  if (spawnSync("mkfifo", [fifo]).status !== 0) return t.skip("no mkfifo");
  for (const spec of [`gate ${fifo}\n`, `file ${ctx.dir}\n`, `review ${fifo}\n`]) {
    const r = prep(ctx, { spec });
    assert.equal(r.stop, "file", spec);
    assert.match(r.message, /일반 파일이 아니다/, spec);
  }
});

test("raw.md holds the diff and the parts alone, for the source-independent seat", { skip: SKIP }, (t) => {
  const ctx = repo(t);
  put(ctx, "a.txt", "two\n");
  writeFileSync(join(ctx.dir, "rules.md"), "the rules\n");
  const r = prep(ctx, { spec: `file ${join(ctx.dir, "rules.md")}\n` });
  assert.equal(r.stop, undefined, r.message);
  const raw = readFileSync(join(ctx.d, "raw.md"), "utf8");
  assert.ok(!raw.includes("review-data") && !raw.includes("review this"), raw);
  assert.ok(raw.includes("+++ b/a.txt") && raw.endsWith("=== file rules.md\nthe rules\n"), raw);
  assert.equal(r.prompt, `${MARK}\nreview this\n${raw}${CLOSE}\n`);
  assert.equal(readFileSync(join(ctx.d, "run.md"), "utf8").split("\n")[0], "id a1b2c3d4");
  assert.match(readFileSync(join(ctx.d, "run.md"), "utf8"), new RegExp(`^shortsha ${sha256(Buffer.from(`${MARK}\nreview this\n`))}$`, "m"));
});

// --split: parts cut where a part starts (a file's diff, a `=== ` line), each with the short part, a part line and the
// closing marker; the parts together hold every part once, in order.
test("split cuts at part starts and gives every part the short part, its part line and the closing marker", () => {
  const units = ["diff --git a/x b/x\n+x1\n", "diff --git a/y b/y\n+y1\n+y2\n", "=== file rules.md\nthe rules\n", "=== z.mjs:1-2\nz1\nz2\n"];
  const text = Buffer.from(`${MARK}\nreview this\n${units.join("")}${CLOSE}\n`);
  const parts = splitPayload(text, 2, "a1b2c3d4", Buffer.byteLength(`${MARK}\nreview this\n`)).map(String);
  assert.equal(parts.length, 2);
  for (const [k, p] of parts.entries()) {
    assert.ok(p.startsWith(`${MARK}\nreview this\n부분 ${k + 1}/2\n`), p);
    assert.ok(p.endsWith(`${CLOSE}\n`), p);
    assert.equal(markerCount(Buffer.from(p), "a1b2c3d4"), 2);
  }
  const body = (p) => p.slice(`${MARK}\nreview this\n부분 1/2\n`.length, p.length - CLOSE.length - 1);
  assert.equal(parts.map(body).join(""), units.join(""), "every part once, in order");
  assert.ok(parts.every((p) => body(p).length > 0));
  const short = Buffer.byteLength(`${MARK}\nreview this\n`);
  assert.throws(() => splitPayload(text, 5, "a1b2c3d4", short), (e) => e.code === "split" && /4/.test(e.message));
  assert.throws(() => splitPayload(text, 1, "a1b2c3d4", short), (e) => e.code === "split");
  assert.throws(() => splitPayload(Buffer.from(`${MARK}\nno close\n`), 2, "a1b2c3d4", Buffer.byteLength(`${MARK}\n`)), (e) => e.code === "split");
});

// Code review: a `=== ` or `diff --git ` line in the author's short part (a heading of the criteria, a pasted hunk)
// was taken for a part start, and the parts after the first went out without the rest of the short part.
test("split never cuts inside the short part: its `=== ` and `diff --git ` lines stay in every part", () => {
  const short = `${MARK}\n요청: x 를 고친다\n=== 수용 기준\n- 기준 1\ndiff --git a/q b/q 는 예시\n`;
  const units = ["diff --git a/x b/x\n+x1\n", "=== file rules.md\nthe rules\n"];
  const text = Buffer.from(`${short}${units.join("")}${CLOSE}\n`);
  const parts = splitPayload(text, 2, "a1b2c3d4", Buffer.byteLength(short)).map(String);
  for (const p of parts) assert.ok(p.startsWith(short), p);
  assert.ok(parts[0].includes("+x1") && parts[1].includes("the rules"), parts.join("\n---\n"));
  // a short length that is no line start any more (prompt.md edited inside the short part) stops
  assert.throws(() => splitPayload(text, 2, "a1b2c3d4", Buffer.byteLength(short) - 3), (e) => e.code === "split");
  assert.throws(() => splitPayload(text, 2, "a1b2c3d4", undefined), (e) => e.code === "split");
});

test("the runner's own SHA-256 gives node:crypto's digest, across the padding edges and for UTF-8", () => {
  for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000]) {
    const buf = Buffer.from(Array.from({ length: n }, (_, i) => (i * 31 + 7) & 0xff));
    assert.equal(sha256(buf), createHash("sha256").update(buf).digest("hex"), `length ${n}`);
  }
  assert.equal(sha256(Buffer.from("짧은 부분\n")), createHash("sha256").update("짧은 부분\n").digest("hex"));
});

// remains 8-5: the short part's sha256 from run.md is compared, so a change that keeps its length stops too; a run.md
// of an older prepare (no hash) is read as before.
test("split compares the short part with its sha256 from prepare: one character of the same length stops", () => {
  const short = `${MARK}\nreview this\n`;
  const units = ["diff --git a/x b/x\n+x1\n", "=== file rules.md\nthe rules\n"];
  const text = Buffer.from(`${short}${units.join("")}${CLOSE}\n`);
  const sha = sha256(Buffer.from(short));
  assert.equal(splitPayload(text, 2, "a1b2c3d4", Buffer.byteLength(short), sha).length, 2);
  const changed = Buffer.from(text.toString("utf8").replace("review this", "review thiz"));
  assert.throws(() => splitPayload(changed, 2, "a1b2c3d4", Buffer.byteLength(short), sha), (e) => e.code === "split");
  assert.equal(splitPayload(changed, 2, "a1b2c3d4", Buffer.byteLength(short), null).length, 2, "no hash: as before");
});

// Each guard alone stops the lazy fetch above on a git that knows GIT_NO_LAZY_FETCH (2.45, and backports such as
// 2.43.4): this pins every guard on every git call, for gits that know only some of them.
test("every git call of prepare carries every guard: no hooks, no fsmonitor, no protocol, no lazy fetch", { skip: SKIP || (WIN && "the stand-in git is a sh script") }, (t) => {
  const ctx = repo(t);
  const real = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  const bin = join(ctx.dir, "bin");
  mkdirSync(bin);
  const log = join(ctx.dir, "git-calls.md");
  writeFileSync(join(bin, "git"), `#!/bin/sh\necho "$GIT_ALLOW_PROTOCOL|$GIT_NO_LAZY_FETCH|$*" >> '${log}'\nexec '${real}' "$@"\n`, { mode: 0o755 });
  put(ctx, "a.txt", "two\n");
  put(ctx, "n.txt", "new\n");
  const r = prep(ctx, { spec: "new n.txt\n", env: { PATH: `${bin}${delimiter}${process.env.PATH}` } });
  assert.equal(r.stop, undefined, r.message);
  const calls = readFileSync(log, "utf8").split("\n").filter(Boolean);
  assert.ok(calls.length >= 8, calls.join("\n"));
  for (const c of calls) {
    assert.ok(c.startsWith("ralph-qa-no-protocol|1|"), c);
    for (const g of ["core.fsmonitor=false", "core.hooksPath=", "protocol.allow=never"]) assert.ok(c.includes(g), `${g}: ${c}`);
  }
});

// S19: the two first-try mistakes a Codex author made, each with a stop that says what to write instead.
test("short.md with the closing marker, without any marker, and a spec line of prose each stop with how to fix it", { skip: SKIP }, (t) => {
  const ctx = repo(t);
  put(ctx, "a.txt", "two\n");
  const both = prep(ctx, { short: '<review-data id="a1b2c3d4">\nreview this\n</review-data id="a1b2c3d4">\n' });
  assert.equal(both.stop, "markers", both.message);
  assert.match(both.message, /표지 2줄\)\. 닫는 표지와 원문은 실행기가 붙이므로 short\.md 에는 여는 표지 한 줄만 둔다/);
  const none = prep(ctx, { short: "review this\n" });
  assert.equal(none.stop, "markers", none.message);
  assert.match(none.message, /표지 0줄\)\. 고정 앞머리 다음에 여는 표지 한 줄/);
  const prose = prep(ctx, { spec: "User request: add sub\n" });
  assert.equal(prose.stop, "spec", prose.message);
  assert.match(prose.message, /요청 문장과 수용 기준은 spec\.md 가 아니라 short\.md 에 쓴다/);
});

// S19 (2): a git that cannot be started (in the Codex sandbox, node's pipes gave EPERM) is a named stop, not a guess;
// git runs on files, so a git that did run gives prepare its output whole.
test("a git that cannot start is the git-failed stop with the start error, and git's output arrives through files", { skip: SKIP || (WIN && "the stand-in git is a sh script") }, (t) => {
  const ctx = repo(t);
  const bin = join(ctx.dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "git"), "#!/nonexistent/interpreter\n", { mode: 0o755 });
  put(ctx, "a.txt", "two\n");
  const r = prep(ctx, { env: { PATH: `${bin}${delimiter}${process.env.PATH}` } });
  assert.equal(r.stop, "git-failed", r.message);
  assert.match(r.message, /git rev-parse[^\n]*를 띄우지 못했다\((?:ENOENT|EACCES|ENOEXEC)\)/);
  const ok = prep(ctx, {});
  assert.equal(ok.stop, undefined, ok.message);
  assert.match(ok.prompt, /two/);
});

// libuv on Windows looks for a bare program name in the child's working folder before PATH: git starts by the absolute
// path which() gives, from the payload folder, so a git.exe the repo ships never runs.
test("git starts by its absolute path: no git by name anywhere in the runner", () => {
  const src = ["seat-payload.mjs", "seat-run.mjs"].map((f) => readFileSync(new URL(`./${f}`, import.meta.url), "utf8")).join("\n");
  assert.ok(!/spawn(?:Sync)?\(\s*["'`]git["'`]/.test(src), "git by name");
  assert.match(readFileSync(new URL("./seat-payload.mjs", import.meta.url), "utf8"), /const exe = which\("git", \{ env \}\);/);
});

test("a git.exe in the repo never runs on Windows, even with the repo as the working folder", { skip: SKIP || (!WIN && "Windows looks in the working folder first") }, (t) => {
  const ctx = repo(t);
  put(ctx, "a.txt", "two\n");
  writeFileSync(join(ctx.repo, "git.exe"), readFileSync(join(process.env.SystemRoot || "C:\\Windows", "System32", "whoami.exe")));
  const prev = process.cwd();
  process.chdir(ctx.repo);
  try {
    const r = prep(ctx);
    assert.equal(r.stop, undefined, r.message);
    assert.ok(sent(r, "a.txt"), r.prompt);
  } finally {
    process.chdir(prev);
  }
});
