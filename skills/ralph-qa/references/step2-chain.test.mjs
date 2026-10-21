// Tests for step 2 of SKILL.md's "외부 좌석 전송": the bash chain that appends the review diff to an
// external seat's payload, taken from the skill as written and run in throwaway repositories.
// Run from the repo root: node --test skills/ralph-qa/references/step2-chain.test.mjs
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { pwshEnv } from "../../../scripts/test-fixtures/pwsh-env.mjs";

const SKILL = readFileSync(fileURLToPath(new URL("../SKILL.md", import.meta.url)), "utf8");
const BLOCK = ((SKILL.split("## 외부 좌석 전송")[1] || "").match(/```bash\n([\s\S]*?)```/) || [])[1] || "";
// From the line that finds the index to the line that counts the markers.
const CHAIN = (BLOCK.match(/^i=\$\(git [\s\S]*?grep -c 'review-data id="<id>"' "\$d\/prompt\.md"$/m) || [])[0] || "";
// The listing the author reads before choosing the new files to send.
const LISTING = (BLOCK.match(/^git -C '<저장소>' .*ls-files --others --exclude-standard$/m) || [])[0] || "";
// The folded listing for a long one.
const FOLDED = (BLOCK.match(/^git -C '<저장소>' .*ls-files --others --exclude-standard --directory$/m) || [])[0] || "";
// The chain for a review with no diff to send.
const NO_DIFF = (BLOCK.match(/^rm -f "\$d\/idx" "\$d\/added\.md" "\$d\/listed\.md" && cat '<검토 대상 파일>'[\s\S]*?grep -c 'review-data id="<id>"' "\$d\/prompt\.md"$/m) || [])[0] || "";

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
// (here only the opening marker) and new-files.md with its file tool.
function step2(ctx, { base = "HEAD", list = "", env = {}, prelude = "" } = {}) {
  writeFileSync(join(ctx.d, "prompt.md"), '<review-data id="t1">\n');
  writeFileSync(join(ctx.d, "new-files.md"), list);
  writeFileSync(join(ctx.dir, "base.md"), "the base file\n");
  const script = CHAIN.replaceAll("<저장소>", ctx.repo).replaceAll("<기준 파일>", join(ctx.dir, "base.md"))
    .replaceAll("<기준>", base).replaceAll("<id>", "t1");
  const r = spawnSync("bash", ["-c", `${prelude}\nd='${ctx.d}'\n${script}`], { encoding: "utf8", env: { ...ctx.env, ...env } });
  const unsent = join(ctx.d, "unsent.md");
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

test("only the new files the author lists go out; the rest are left in unsent.md", { skip: SKIP }, (t) => {
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

// 0.20.4 B3: the diff's own context and attributes, a split index, names with a newline or a quote, the
// related-range command, a long listing, and a second try in the same folder
// B3-08, B3-18, B3-23 (research): settings outside the chain's own flags
const lines200 = (changed = []) => Array.from({ length: 200 }, (_, i) => `line ${i + 1}${changed.includes(i + 1) ? " CHANGED" : ""}\n`).join("");
const contextLines = (r) => r.prompt.split("\n").filter((l) => /^ line \d+$/.test(l)).length;

test("the user's diff.context, diff.interHunkContext and GIT_DIFF_OPTS send no more than three lines around a change", { skip: SKIP }, (t) => {
  const ctx = repo(t);
  put(ctx, "big.txt", lines200());
  git(ctx, "add", "big.txt");
  git(ctx, "commit", "-qm", "big");
  put(ctx, "big.txt", lines200([100, 110]));
  assert.equal(contextLines(step2(ctx)), 12, "two hunks of 3 + 3");
  git(ctx, "config", "--global", "diff.context", "40");
  git(ctx, "config", "--global", "diff.interHunkContext", "20");
  const r = step2(ctx, { env: { GIT_DIFF_OPTS: "--unified=15" } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(contextLines(r), 12, r.prompt);
});

test("a diff attribute that spells a binary file out as text stops the chain before anything goes out", { skip: SKIP }, (t) => {
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
    const r = step2(ctx);
    assert.notEqual(r.status, 0, where);
    assert.match(r.stderr, /바이너리 바이트/, where);
    assert.ok(!r.prompt.includes("RAW-") && !r.prompt.includes("</review-data"), `${where}: ${r.prompt}`);
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
  const r = step2(ctx);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(/^Binary files /m.test(r.prompt) && !r.prompt.includes("value=TWO"), r.prompt);
});

test("a split index repo keeps its .git as it was: the add -N on the copy writes no shared index there", { skip: SKIP }, (t) => {
  const ctx = repo(t);
  git(ctx, "config", "core.splitIndex", "true");
  git(ctx, "update-index", "--split-index");
  put(ctx, "a.txt", "two\n");
  put(ctx, "n.txt", "new\n");
  const shared = () => readdirSync(join(ctx.repo, ".git")).filter((f) => f.startsWith("sharedindex.")).sort();
  const before = shared();
  const r = step2(ctx, { list: "n.txt\n" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(sent(r, "a.txt") && sent(r, "n.txt"), r.prompt);
  assert.deepEqual(shared(), before, "no new sharedindex.<hash> in the repo's .git");
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
  const shared = () => readdirSync(join(ctx.repo, ".git")).filter((f) => f.startsWith("sharedindex.")).sort();
  const before = shared();
  const r = step2(ctx, { list: "n.txt\n" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(sent(r, "a.txt") && sent(r, "n.txt"), r.prompt);
  assert.deepEqual(shared(), before, "no new sharedindex.<hash> in the repo's .git");
});

test("a new file whose name holds a newline stops the chain, since the list check would read the name as two lines", { skip: SKIP }, (t) => {
  // with a folder line by mistake, the two halves of the name match two listed lines and the check passed
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
  const r = step2(ctx, { list: "scratch/p\nq\nscratch\n" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /줄바꿈/);
  assert.ok(!r.prompt.includes("NOT-LISTED") && !r.prompt.includes("</review-data"), r.prompt);
});

// The related-range command of step 2, as SKILL.md writes it in prose.
const RANGE = (SKILL.match(/`(\{ git -C '<저장소>' --literal-pathspecs ls-files --error-unmatch [^`]+? &&)`/) || [])[1] || "";
const range = (ctx, file, from, to) => {
  const q = file.replaceAll("'", "'\\''");
  const cmd = RANGE.replaceAll("<저장소>", ctx.repo).replaceAll("<파일>", q).replaceAll("<시작>", String(from)).replaceAll("<끝>", String(to));
  return spawnSync("bash", ["-c", `d='${ctx.d}'\n${cmd} echo appended`], { encoding: "utf8", env: ctx.env });
};

test("a related range names its file and lines, reads any name, and comes only from a tracked or listed file", { skip: SKIP }, (t) => {
  assert.ok(RANGE, "no related-range command in step 2");
  const ctx = repo(t);
  for (const name of ["-x.txt", "it's.txt"]) put(ctx, name, "l1\nl2\nl3\nl4\n");
  git(ctx, "add", "--", "-x.txt", "it's.txt");
  git(ctx, "commit", "-qm", "names");
  put(ctx, "listed.mjs", "n1\nn2\n");
  put(ctx, "-listed.mjs", "d1\nd2\n");
  put(ctx, "-x-unsent.txt", "UNSENT\n");
  put(ctx, "unsent.mjs", "u1\nUNSENT\n");
  put(ctx, "debug.log", "IGNORED\n");
  writeFileSync(join(ctx.d, "new-files.md"), "listed.mjs\r\n-listed.mjs\n");
  writeFileSync(join(ctx.d, "prompt.md"), "");
  for (const [name, from, to] of [["-x.txt", 2, 3], ["it's.txt", 1, 1], ["listed.mjs", 2, 2], ["-listed.mjs", 1, 1]]) {
    const r = range(ctx, name, from, to);
    assert.equal(r.status, 0, r.stderr);
  }
  assert.equal(readFileSync(join(ctx.d, "prompt.md"), "utf8"), "=== -x.txt:2-3\nl2\nl3\n=== it's.txt:1-1\nl1\n=== listed.mjs:2-2\nn2\n=== -listed.mjs:1-1\nd1\n");
  for (const name of ["unsent.mjs", "debug.log", "../outside.txt", "-x-unsent.txt"]) {
    const r = range(ctx, name, 1, 2);
    assert.notEqual(r.status, 0, name);
    assert.match(r.stderr, /추적 파일도 목록의 새 파일도 아니다/);
  }
  assert.ok(!/UNSENT|IGNORED/.test(readFileSync(join(ctx.d, "prompt.md"), "utf8")));
});

// 0.20.5: a related range outside its file (a start past the last line, a start of 0, an end before the start) stops;
// an end past the file takes the lines there are, as sed does. The PowerShell step does the same (test further down).
test("a related range outside its file stops, and an end past the file takes the lines there are", { skip: SKIP }, (t) => {
  assert.ok(RANGE, "no related-range command in step 2");
  const ctx = repo(t);
  put(ctx, "three.txt", "l1\nl2\nl3\n");
  git(ctx, "add", "--", "three.txt");
  git(ctx, "commit", "-qm", "three");
  writeFileSync(join(ctx.d, "new-files.md"), "");
  writeFileSync(join(ctx.d, "prompt.md"), "");
  const ok = range(ctx, "three.txt", 2, 5);
  assert.equal(ok.status, 0, ok.stderr);
  for (const [from, to] of [[5, 9], [0, 2], [3, 2]]) {
    const r = range(ctx, "three.txt", from, to);
    assert.notEqual(r.status, 0, `${from}-${to}`);
    assert.match(r.stderr, /관련 범위가 파일 밖이다: three\.txt/, `${from}-${to}: ${r.stderr}`);
  }
  assert.equal(readFileSync(join(ctx.d, "prompt.md"), "utf8"), "=== three.txt:2-5\nl2\nl3\n");
});

test("a long listing folds each wholly new folder to one line and opens the one asked for", { skip: SKIP }, (t) => {
  assert.ok(FOLDED, "no folded listing in the bash block");
  const ctx = repo(t);
  for (let k = 0; k < 300; k += 1) put(ctx, `node_modules/p${k}/i.js`, "x\n");
  put(ctx, "src/feature.mjs", "export const f = 1;\n");
  const r = spawnSync("bash", ["-c", FOLDED.replaceAll("<저장소>", ctx.repo)], { encoding: "utf8", env: ctx.env });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.split("\n").filter(Boolean).sort(), ["node_modules/", "src/"]);
});

test("a name the listing quotes goes out written as itself; the quoted line or a ./ line is no stop for a folder", { skip: SKIP }, (t) => {
  const ctx = repo(t);
  try {
    put(ctx, 'q"uote.txt', "q\n");
  } catch (e) {
    t.skip(`this file system takes no " in a name (${e.code})`);
    return;
  }
  put(ctx, "plain.txt", "p\n");
  const listed = spawnSync("bash", ["-c", LISTING.replaceAll("<저장소>", ctx.repo)], { encoding: "utf8", env: ctx.env }).stdout;
  assert.ok(listed.split("\n").includes('"q\\"uote.txt"'), listed);
  let r = step2(ctx, { list: '"q\\"uote.txt"\n' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /^q"uote\.txt$/m, "the stop prints the name to write");
  assert.match(r.stderr, /따옴표를 풀지 않은 줄/);
  r = step2(ctx, { list: 'q"uote.txt\n./plain.txt\n' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.prompt.includes('+++ "b/q\\"uote.txt"') && sent(r, "plain.txt"), r.prompt);
});

test("a second try in the same folder starts from a fresh index copy, so a file taken off the list stays out", { skip: SKIP }, (t) => {
  // A repo without a commit has no index file to copy over the last try's $d/idx: the chain removes that copy first.
  const ctx = repo(t, { commit: false });
  put(ctx, "secret.txt", "K=v\n");
  const first = step2(ctx, { base: "HEAD", list: "a.txt\nsecret.txt\n" }); // no HEAD yet: stops after add -N
  assert.notEqual(first.status, 0);
  assert.ok(existsSync(join(ctx.d, "idx")), "the stopped try left its index copy behind");
  const empty = git(ctx, "hash-object", "-t", "tree", "/dev/null").trim();
  const r = step2(ctx, { base: empty, list: "a.txt\n" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(sent(r, "a.txt") && !r.prompt.includes("secret.txt"), r.prompt);
  assert.ok(r.unsent.includes("secret.txt"), `left in unsent.md: ${r.unsent}`);
});

// 0.20.4 B3: the no-diff branch
test("with no diff to send, the same folder takes the review file, the base file and the closing marker", { skip: SKIP }, (t) => {
  assert.ok(NO_DIFF, "no chain for a review with no diff in the bash block");
  const ctx = repo(t);
  put(ctx, ".gitignore", "*.log\n.omc/\n");
  git(ctx, "add", ".gitignore");
  git(ctx, "commit", "-qm", "ignore .omc");
  put(ctx, ".omc/plans/p.md", "the plan\n");
  const stop = step2(ctx);
  assert.match(stop.stderr, /보낼 diff 가 없다/);
  writeFileSync(join(ctx.d, "prompt.md"), '<review-data id="t1">\n');
  const script = NO_DIFF.replaceAll("<검토 대상 파일>", join(ctx.repo, ".omc/plans/p.md"))
    .replaceAll("<기준 파일>", join(ctx.dir, "base.md")).replaceAll("<id>", "t1");
  const r = spawnSync("bash", ["-c", `d='${ctx.d}'\n${script}`], { encoding: "utf8", env: ctx.env });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "2");
  const prompt = readFileSync(join(ctx.d, "prompt.md"), "utf8");
  assert.ok(prompt.includes("the plan\nthe base file\n</review-data"), prompt);
  for (const f of ["idx", "added.md", "listed.md"]) assert.ok(!existsSync(join(ctx.d, f)), `${f} is left`);
});

// 0.20.4 last cleanup: a related range is never read through a link, and a ./ line names its file
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
  writeFileSync(join(ctx.d, "new-files.md"), "new-link.txt\n");
  writeFileSync(join(ctx.d, "prompt.md"), "");
  // the folder of a tracked file turned into a link outside git (an archive that came with its .git)
  rmSync(join(ctx.repo, "sub"), { recursive: true });
  writeFileSync(join(outside, "y.txt"), "OUTSIDE-SUB\n");
  symlinkSync(outside, join(ctx.repo, "sub"));
  for (const name of ["link.txt", "new-link.txt", "sub/y.txt"]) {
    const r = range(ctx, name, 1, 2);
    assert.notEqual(r.status, 0, name);
    assert.match(r.stderr, /링크이거나 링크 폴더 아래/, name);
  }
  assert.equal(readFileSync(join(ctx.d, "prompt.md"), "utf8"), "", "nothing from outside the repo");
});

test("a listed ./ line names its file for the related range too, as the chain reads the list", { skip: SKIP }, (t) => {
  const ctx = repo(t);
  put(ctx, "plain.txt", "p1\np2\n");
  writeFileSync(join(ctx.d, "new-files.md"), "./plain.txt\n");
  writeFileSync(join(ctx.d, "prompt.md"), "");
  const r = range(ctx, "plain.txt", 2, 2);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(ctx.d, "prompt.md"), "utf8"), "=== plain.txt:2-2\np2\n");
});

// The PowerShell step 2 is prose: its spans run in pwsh where there is one (Windows paths take / off Windows).
// pwsh runs with a temp home and the telemetry and update-check opt-outs (scripts/test-fixtures/pwsh-env.mjs).
const PSE = pwshEnv();
after(() => rmSync(PSE.home, { recursive: true, force: true }));
const PS = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], { encoding: "utf8", env: PSE.env }).status === 0;
const PS_LINE = SKILL.split("\n").find((l) => l.startsWith("  - 2단계 원문 붙이기:")) || "";
const psSpan = (re) => (PS_LINE.match(re) || [])[1] || "";
const posixPs = (s) => (process.platform === "win32" ? s : s.replaceAll("$d\\", "$d/").replaceAll("<저장소>\\<파일>", "<저장소>/<파일>"));
const pwsh = (script) => spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", env: PSE.env });
const psq = (s) => s.replaceAll("'", "''");

test("the PowerShell list check takes a ./ line as the file it names, as the bash chain does", { skip: !PS && "no pwsh" }, (t) => {
  const listed = psSpan(/`(\$listed = @\(Get-Content [^`]+)`/);
  const extra = psSpan(/`(\$added \| Where-Object \{ \$listed -cnotcontains \$_ \})`/);
  assert.ok(listed && extra, "no $listed or list check in the PowerShell step 2");
  const dir = mkdtempSync(join(tmpdir(), "rq-ps-list-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "new-files.md"), "./plain.txt\r\nq.txt\n");
  const r = pwsh(`$d = '${psq(dir)}'; $added = @('plain.txt', 'q.txt'); ${posixPs(listed)}; @(${extra}).Count`);
  assert.equal(r.stdout.trim(), "0", r.stderr);
});

test("the PowerShell related range finds a link at the file or at a folder above it", { skip: (!PS && "no pwsh") || (!canLink && "no symlinks here") }, (t) => {
  const loop = psSpan(/`(\$link = \$false; for [^`]+)`/);
  assert.ok(loop, "no link check for the related range in the PowerShell step 2");
  const dir = mkdtempSync(join(tmpdir(), "rq-ps-link-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repoDir = join(dir, "repo");
  const outside = join(dir, "outside");
  mkdirSync(join(repoDir, "real"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(repoDir, "a.txt"), "a\n");
  writeFileSync(join(repoDir, "real", "b.txt"), "b\n");
  writeFileSync(join(outside, "s.txt"), "s\n");
  symlinkSync(join(outside, "s.txt"), join(repoDir, "link.txt"));
  symlinkSync(outside, join(repoDir, "sub"), "dir");
  const link = (file) => pwsh(`${posixPs(loop).replaceAll("<저장소>", psq(repoDir)).replaceAll("<파일>", psq(file))}; [string]$link`).stdout.trim();
  assert.deepEqual(["a.txt", "real/b.txt", "link.txt", "sub/s.txt"].map(link), ["False", "False", "True", "True"]);
});

// 0.20.5: the PowerShell related range reads the file once, stops a range outside it (the bash chain does too) and cuts an
// end past the file at its last line; an index past the array would add empty lines, a 0 start the last line.
test("the PowerShell related range stops a range outside its file and cuts an end past it", { skip: !PS && "no pwsh" }, (t) => {
  const read = psSpan(/`(\$a = \[IO\.File\]::ReadAllLines\('<저장소>\\<파일>'\))`/);
  const outside = psSpan(/`(<시작> -lt 1 -or <끝> -lt <시작> -or <시작> -gt \$a\.Count)`/);
  const append = psSpan(/떼는 명령은 `(\[IO\.File\]::AppendAllText\("\$d\\prompt\.md", '=== <파일>:<시작>-<끝>'[^`]+)`/);
  assert.ok(read && outside && append, "no read, range check and append for the related range in the PowerShell step 2");
  const dir = mkdtempSync(join(tmpdir(), "rq-ps-range-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "three.txt"), "l1\nl2\nl3\n");
  const run = (from, to) => {
    const sub = (span) => posixPs(span).replaceAll("<저장소>", psq(dir)).replaceAll("<파일>", "three.txt").replaceAll("<시작>", String(from)).replaceAll("<끝>", String(to));
    return pwsh(`$d = '${psq(dir)}'; ${sub(read)}; if (${sub(outside)}) { 'outside' } else { ${sub(append)}; 'appended' }`).stdout.trim();
  };
  assert.equal(run(2, 5), "appended");
  for (const [from, to] of [[5, 9], [0, 2], [3, 2]]) assert.equal(run(from, to), "outside", `${from}-${to}`);
  assert.equal(readFileSync(join(dir, "prompt.md"), "utf8"), "=== three.txt:2-5\nl2\nl3\n");
});
