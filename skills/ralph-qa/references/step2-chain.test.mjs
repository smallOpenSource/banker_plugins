// Tests for step 2 of SKILL.md's "외부 좌석 전송": the bash chain that appends the review diff to an
// external seat's payload, taken from the skill as written and run in throwaway repositories.
// Run from the repo root: node --test skills/ralph-qa/references/step2-chain.test.mjs
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
function step2(ctx, { base = "HEAD", list = "", env = {} } = {}) {
  writeFileSync(join(ctx.d, "prompt.md"), '<review-data id="t1">\n');
  writeFileSync(join(ctx.d, "new-files.txt"), list);
  writeFileSync(join(ctx.dir, "base.md"), "the base file\n");
  const script = CHAIN.replaceAll("<저장소>", ctx.repo).replaceAll("<기준 파일>", join(ctx.dir, "base.md"))
    .replaceAll("<기준>", base).replaceAll("<id>", "t1");
  const r = spawnSync("bash", ["-c", `d='${ctx.d}'\n${script}`], { encoding: "utf8", env: { ...ctx.env, ...env } });
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
