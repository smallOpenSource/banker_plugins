// Tests for step 2 of SKILL.md's "외부 좌석 전송": the bash chain that appends the review diff to an
// external seat's payload, taken from the skill as written and run in throwaway repositories.
// Run from the repo root: node --test skills/ralph-qa/references/step2-chain.test.mjs
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const SKILL = readFileSync(fileURLToPath(new URL("../SKILL.md", import.meta.url)), "utf8");
const BLOCK = ((SKILL.split("## 외부 좌석 전송")[1] || "").match(/```bash\n([\s\S]*?)```/) || [])[1] || "";
// From the line that finds the index to the line that counts the markers.
const CHAIN = (BLOCK.match(/^i=\$\(git [\s\S]*?grep -c 'review-data id="<id>"' "\$d\/prompt\.md"$/m) || [])[0] || "";
// The listing the author reads before choosing the new files to send.
const LISTING = (BLOCK.match(/^git -C '<저장소>' .*ls-files --others --exclude-standard$/m) || [])[0] || "";

const works = (cmd) => spawnSync(cmd, ["--version"], { encoding: "utf8" }).status === 0;
const SKIP = process.platform === "win32" ? "Git Bash path handling is not checked on Windows"
  : !works("bash") ? "no bash" : !works("git") ? "no git" : false;

// The user's git config (an excludes file, hooks, a default branch) stays out of the repos.
const isolated = (home) => ({
  PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
});

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
// payload folder $d.
function repo(t, { commit = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "rq-step2-"));
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

// Runs the chain with the placeholders filled, as a session would after writing the short part
// (here only the opening marker) and new-files.txt with its file tool.
function step2(ctx, { base = "HEAD", list = "", env = {}, prelude = "" } = {}) {
  writeFileSync(join(ctx.d, "prompt.md"), '<review-data id="t1">\n');
  writeFileSync(join(ctx.d, "new-files.txt"), list);
  writeFileSync(join(ctx.dir, "base.md"), "the base file\n");
  const script = CHAIN.replaceAll("<저장소>", ctx.repo).replaceAll("<기준 파일>", join(ctx.dir, "base.md"))
    .replaceAll("<기준>", base).replaceAll("<id>", "t1");
  const r = spawnSync("bash", ["-c", `${prelude}\nd='${ctx.d}'\n${script}`], { encoding: "utf8", env: { ...ctx.env, ...env } });
  const unsent = join(ctx.d, "unsent.txt");
  return {
    status: r.status, stderr: r.stderr, counted: r.stdout.trim().split("\n").pop(),
    prompt: readFileSync(join(ctx.d, "prompt.md"), "utf8"),
    unsent: existsSync(unsent) ? readFileSync(unsent, "utf8").split("\n").filter(Boolean) : null,
  };
}

// git ends the +++ line with a tab when the path holds a space.
const sent = (r, file) => r.prompt.split("\n").some((l) => l.replace(/\t$/, "") === `+++ b/${file}`);

test("the skill still holds the chain and the listing these tests run", { skip: SKIP }, () => {
  assert.ok(CHAIN, "no step 2 chain in the bash block");
  assert.ok(LISTING, "no new-file listing in the bash block");
});

test("the listing names each new file in a new folder, where status --short shows only the folder", { skip: SKIP }, (t) => {
  const ctx = repo(t);
  put(ctx, "scratch/deep/notes.txt", "n\n");
  put(ctx, "scratch/conn.json", "{}\n");
  const r = spawnSync("bash", ["-c", LISTING.replaceAll("<저장소>", ctx.repo)], { encoding: "utf8", env: ctx.env });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.split("\n").filter(Boolean).sort(), ["scratch/conn.json", "scratch/deep/notes.txt"]);
});

test("only the new files the author lists go out; the rest are left in unsent.txt", { skip: SKIP }, (t) => {
  const ctx = repo(t);
  put(ctx, "a.txt", "two\n");
  put(ctx, "newfeat/f.mjs", "export const f = 1;\n");
  put(ctx, "scratch/conn.json", "{}\n");
  put(ctx, "scratch/deep/notes.txt", "n\n");
  const r = step2(ctx, { list: "newfeat/f.mjs\n" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.counted, "2");
  assert.ok(sent(r, "a.txt") && sent(r, "newfeat/f.mjs"), r.prompt);
  assert.ok(!r.prompt.includes("scratch/"), r.prompt);
  assert.deepEqual(r.unsent.sort(), ["scratch/conn.json", "scratch/deep/notes.txt"]);
  assert.equal(git(ctx, "diff", "--cached", "--name-only"), "", "the repo's own index is not touched");
});

test("an empty list sends the tracked changes and no new file", { skip: SKIP }, (t) => {
  const ctx = repo(t);
  put(ctx, "a.txt", "two\n");
  put(ctx, "x.txt", "new\n");
  const r = step2(ctx);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.counted, "2");
  assert.ok(sent(r, "a.txt") && !r.prompt.includes("x.txt"), r.prompt);
  assert.deepEqual(r.unsent, ["x.txt"]);
});

test("a listed ignored file stops the chain before the closing marker", { skip: SKIP }, (t) => {
  const ctx = repo(t);
  put(ctx, "a.txt", "two\n");
  put(ctx, "debug.log", "secret-ish\n");
  const r = step2(ctx, { list: "debug.log\n" });
  assert.notEqual(r.status, 0);
  assert.notEqual(r.counted, "2");
  assert.ok(!r.prompt.includes("</review-data"), r.prompt);
});

test("a listed path is read as written, not as a glob", { skip: SKIP }, (t) => {
  const ctx = repo(t);
  put(ctx, "a[1].txt", "bracket\n");
  put(ctx, "a1.txt", "plain\n");
  const r = step2(ctx, { list: "a[1].txt\n" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(sent(r, "a[1].txt") && !sent(r, "a1.txt"), r.prompt);
  assert.deepEqual(r.unsent, ["a1.txt"]);
});

test("a repo without a commit sends against the empty tree", { skip: SKIP }, (t) => {
  const ctx = repo(t, { commit: false });
  const empty = git(ctx, "hash-object", "-t", "tree", "/dev/null").trim();
  const r = step2(ctx, { base: empty, list: "a.txt\n.gitignore\n" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(sent(r, "a.txt"), r.prompt);
});

test("a repo with a commit and no index file at the path found stops and says why", { skip: SKIP }, (t) => {
  const ctx = repo(t);
  put(ctx, "a.txt", "two\n");
  const r = step2(ctx, { env: { GIT_INDEX_FILE: join(ctx.dir, "no-such-index") } });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /커밋이 있는데 인덱스 파일이 없다/);
  assert.ok(!r.prompt.includes("</review-data"), r.prompt);
});

test("nothing to send stops the chain and says why", { skip: SKIP }, (t) => {
  const ctx = repo(t);
  const r = step2(ctx);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /보낼 diff 가 없다/);
  assert.ok(!r.prompt.includes("</review-data"), r.prompt);
});

test("a staged ignored file, a non-ASCII path with a space and a CRLF list all go out as they are", { skip: SKIP }, (t) => {
  const ctx = repo(t);
  put(ctx, "forced.log", "kept on purpose\n");
  git(ctx, "add", "-f", "forced.log");
  put(ctx, "한글 폴더/새 파일.txt", "내용\n");
  const r = step2(ctx, { list: "한글 폴더/새 파일.txt\r\n" });
  assert.equal(r.status, 0, r.stderr);
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
  const r = step2(ctx);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(sent(r, "a.txt"), r.prompt);
  put(ctx, "n.txt", "new\n"); // a listed new file: add -N writes the copy, which must keep the entry suspect
  const listed = step2(ctx, { list: "n.txt\n" });
  assert.equal(listed.status, 0, listed.stderr);
  assert.ok(sent(listed, "a.txt") && sent(listed, "n.txt"), listed.prompt);
});

test("a nested repo without a commit stays out and does not break the chain", { skip: SKIP }, (t) => {
  const ctx = repo(t);
  put(ctx, "a.txt", "two\n");
  put(ctx, "vendor/lib/x.txt", "v\n");
  const sub = spawnSync("git", ["-C", join(ctx.repo, "vendor", "lib"), "init", "-q"], { encoding: "utf8", env: ctx.env });
  assert.equal(sub.status, 0, sub.stderr);
  const r = step2(ctx);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(sent(r, "a.txt") && !r.prompt.includes("vendor/"), r.prompt);
  assert.deepEqual(r.unsent, ["vendor/lib/"]);
});

test("a folder line or a dot in the list stops the chain and says why, since it would add every new file under it", { skip: SKIP }, (t) => {
  for (const list of ["newfeat/f.mjs\nscratch\n", ".\n"]) {
    const ctx = repo(t);
    put(ctx, "a.txt", "two\n");
    put(ctx, "newfeat/f.mjs", "export const f = 1;\n");
    put(ctx, "scratch/conn.json", "{}\n");
    put(ctx, "scratch/deep/notes.txt", "n\n");
    const r = step2(ctx, { list });
    assert.notEqual(r.status, 0, JSON.stringify(list));
    assert.match(r.stderr, /목록에 없는 새 파일이 올라간다/);
    assert.match(r.stderr, /scratch\/conn\.json/, "the stop names the file that would go out");
    assert.ok(!r.prompt.includes("scratch/") && !r.prompt.includes("</review-data"), r.prompt);
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
  let r = step2(ctx);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.prompt.includes("+plain-2") && !r.prompt.includes("DECODED"), r.prompt);
  const driver = join(ctx.dir, "ext.sh");
  writeFileSync(driver, "#!/bin/sh\necho EXTERNAL-DRIVER-RAN\n", { mode: 0o755 });
  git(ctx, "config", "diff.external", driver);
  r = step2(ctx);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.prompt.includes("+plain-2") && !r.prompt.includes("EXTERNAL-DRIVER-RAN"), r.prompt);
});

test("a list where a file and its folder overlap, or a line repeats beside a folder, still stops", { skip: SKIP }, (t) => {
  for (const list of ["scratch/conn.json\nscratch\n", "newfeat/f.mjs\nnewfeat/f.mjs\nscratch\n"]) {
    const ctx = repo(t);
    put(ctx, "a.txt", "two\n");
    put(ctx, "newfeat/f.mjs", "export const f = 1;\n");
    put(ctx, "scratch/conn.json", "{}\n");
    put(ctx, "scratch/secret.env", "K=v\n");
    const r = step2(ctx, { list });
    assert.notEqual(r.status, 0, JSON.stringify(list));
    assert.match(r.stderr, /scratch\/secret\.env/);
    assert.ok(!r.prompt.includes("secret.env") && !r.prompt.includes("</review-data"), r.prompt);
  }
  const ctx = repo(t);
  put(ctx, "newfeat/f.mjs", "export const f = 1;\n");
  const r = step2(ctx, { list: "newfeat/f.mjs\nnewfeat/f.mjs\n" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(sent(r, "newfeat/f.mjs"), "a repeated line alone adds nothing more");
});

test("the chain counts with the system grep, not a session function that skips non-UTF-8 files", { skip: SKIP }, (t) => {
  // Claude Code's Bash tool defines grep as a function (an embedded ugrep with -I) that prints no
  // count for a file holding bytes that are not UTF-8
  const ctx = repo(t);
  put(ctx, "a.txt", "two\n");
  writeFileSync(join(ctx.repo, "euc.txt"), Buffer.from([0x61, 0x0a]));
  git(ctx, "add", "euc.txt");
  git(ctx, "commit", "-qm", "euc");
  writeFileSync(join(ctx.repo, "euc.txt"), Buffer.from([0xb0, 0xa1, 0x0a]));
  const r = step2(ctx, { prelude: "grep() { return 1; }" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.counted, "2");
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
  const r = step2(ctx);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(sent(r, "a.txt"), r.prompt);
  assert.ok(!r.prompt.includes("\u001b"), "no color codes before the lines the scanner anchors on");
  assert.ok(!r.prompt.includes("NESTED-CONTENT") && r.prompt.includes("Subproject commit"), r.prompt);
});
