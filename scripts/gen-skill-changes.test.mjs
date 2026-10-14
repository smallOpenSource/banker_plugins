// Tests for gen-skill-changes.js. Run from the repo root: node --test scripts/gen-skill-changes.test.mjs
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const require = createRequire(import.meta.url);
const { changedSkills, excludedPatterns, isShipped } = require("./gen-skill-changes.js");
const REPO = fileURLToPath(new URL("..", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "gen-skill-changes-test-"));
after(() => rmSync(root, { recursive: true, force: true }));

const HAS_GIT = spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
const needGit = { skip: !HAS_GIT && "git not found" };

// The git these tests and the tool run reads neither the developer's global or system config, template hooks,
// nor a repository the calling shell chose (GIT_DIR and the rest of `git rev-parse --local-env-vars`).
const NO_GITCONFIG = join(root, "empty.gitconfig");
const NO_TEMPLATES = join(root, "empty-templates");
writeFileSync(NO_GITCONFIG, "");
mkdirSync(NO_TEMPLATES);
const REPO_VARS = /^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|CEILING_DIRECTORIES|CONFIG|CONFIG_PARAMETERS|CONFIG_COUNT|PREFIX|NAMESPACE|NO_REPLACE_OBJECTS|REPLACE_REF_BASE|GRAFT_FILE|SHALLOW_FILE|IMPLICIT_WORK_TREE)$/i;
for (const k of Object.keys(process.env)) if (REPO_VARS.test(k)) delete process.env[k];
Object.assign(process.env, { GIT_CONFIG_GLOBAL: NO_GITCONFIG, GIT_CONFIG_NOSYSTEM: "1", GIT_TEMPLATE_DIR: NO_TEMPLATES, XDG_CONFIG_HOME: root });

const PACKAGE = {
  files: ["skills", "!**/*.test.mjs", "!**/test_*.py", "!**/__pycache__", "!**/__pycache__/**", "!**/.omc", "!**/.omc/**",
    "!skills/ultra-init-workspace", "!skills/ultra-init-workspace/**"],
};

function git(cwd, ...args) {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "core.autocrlf=false", ...args],
    { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}
function put(dir, rel, text) {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
}
let seq = 0;
// A repository with skills alpha and beta, committed once: { dir, base }.
function fixture() {
  const dir = join(root, `repo${seq++}`);
  mkdirSync(dir);
  put(dir, "package.json", JSON.stringify(PACKAGE));
  put(dir, "skills/alpha/SKILL.md", "# alpha\n");
  put(dir, "skills/alpha/scripts/a.mjs", "export const a = 1;\n");
  put(dir, "skills/alpha/scripts/a.test.mjs", "// test\n");
  put(dir, "skills/beta/SKILL.md", "# beta\n");
  put(dir, "skills/beta/test_beta.py", "# test\n");
  put(dir, "skills/beta/notes.md", "notes\n");
  git(dir, "init", "-q");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  return { dir, base: git(dir, "rev-parse", "HEAD") };
}
function commit(dir) {
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "change");
  return git(dir, "rev-parse", "HEAD");
}

test("the negated files entries of package.json decide what is shipped", () => {
  const patterns = excludedPatterns(REPO);
  const out = ["skills/x/a.test.mjs", "skills/x/scripts/b.test.ts", "skills/x/test_y.py", "skills/x/__pycache__/z.pyc",
    "skills/x/.omc/state.json", "skills/ultra-init-workspace/a.md"];
  for (const rel of out) assert.equal(isShipped(rel, patterns), false, rel);
  const kept = ["skills/x/SKILL.md", "skills/x/scripts/a.mjs", "skills/x/testdata.md", "skills/x/test_notes.md", "skills/x/참고 자료.md"];
  for (const rel of kept) assert.equal(isShipped(rel, patterns), true, rel);
});

test("a change to test files only names no skill", needGit, () => {
  const { dir, base } = fixture();
  put(dir, "skills/alpha/scripts/a.test.mjs", "// test changed\n");
  put(dir, "skills/beta/test_beta.py", "# test changed\n");
  assert.deepEqual(changedSkills(base, commit(dir), dir), []);
});

test("__pycache__ and .omc below a skill are not shipped and name no skill", needGit, () => {
  const { dir, base } = fixture();
  put(dir, "skills/alpha/__pycache__/a.cpython-311.pyc", "x");
  put(dir, "skills/beta/.omc/state.json", "{}");
  assert.deepEqual(changedSkills(base, commit(dir), dir), []);
});

test("shipped changes name their skill: an edit, a deletion, and a name with spaces and Korean", needGit, () => {
  const one = fixture();
  put(one.dir, "skills/alpha/scripts/a.mjs", "export const a = 2;\n");
  unlinkSync(join(one.dir, "skills/beta/notes.md"));
  assert.deepEqual(changedSkills(one.base, commit(one.dir), one.dir), ["banker:alpha", "banker:beta"]);
  const two = fixture();
  put(two.dir, "skills/beta/참고 자료.md", "새 글\n");
  assert.deepEqual(changedSkills(two.base, commit(two.dir), two.dir), ["banker:beta"]);
});

test("without --to the working tree is compared, uncommitted edits included", needGit, () => {
  const { dir, base } = fixture();
  put(dir, "skills/alpha/SKILL.md", "# alpha changed\n");
  put(dir, "skills/beta/test_beta.py", "# test changed\n");
  assert.deepEqual(changedSkills(base, null, dir), ["banker:alpha"]);
});

// npm decides what the tarball holds; isShipped must agree with it for every file git tracks under skills/.
function npmCli() {
  const bin = dirname(realpathSync(process.execPath));
  return [join(bin, "node_modules", "npm", "bin", "npm-cli.js"), join(bin, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")]
    .find((p) => existsSync(p));
}
test("the judgment matches npm pack for every file git tracks under skills/", { ...needGit, timeout: 180000 }, (t) => {
  const cli = npmCli();
  if (!cli) {
    t.skip("npm-cli.js not found beside node");
    return;
  }
  // The test boxes run an archive copy of the repository, which is no git checkout: nothing to list.
  const inside = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: REPO, encoding: "utf8" });
  if (inside.status !== 0 || inside.stdout.trim() !== "true") {
    t.skip("not a git checkout (an archive copy of the repository)");
    return;
  }
  const r = spawnSync(process.execPath, [cli, "pack", "--dry-run", "--json", "--ignore-scripts"],
    { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  assert.equal(r.status, 0, r.stderr);
  const packed = new Set(JSON.parse(r.stdout)[0].files.map((f) => f.path.split("\\").join("/")));
  const tracked = git(REPO, "ls-files", "-z", "--", "skills").split("\0").filter(Boolean);
  const patterns = excludedPatterns(REPO);
  assert.deepEqual(tracked.filter((rel) => isShipped(rel, patterns) !== packed.has(rel)), []);
});

test("a renamed or moved shipped file names the skill it left as well", needGit, () => {
  const one = fixture();
  git(one.dir, "mv", "skills/alpha/scripts/a.mjs", "skills/alpha/scripts/a2.test.mjs");
  assert.deepEqual(changedSkills(one.base, commit(one.dir), one.dir), ["banker:alpha"]);
  const two = fixture();
  git(two.dir, "mv", "skills/beta/notes.md", "skills/alpha/notes.md");
  assert.deepEqual(changedSkills(two.base, commit(two.dir), two.dir), ["banker:alpha", "banker:beta"]);
});

test("a ref that looks like a git option is refused as a revision, never read as an option", needGit, () => {
  const { dir } = fixture();
  const out = join(dir, "written-by-git");
  assert.throws(() => changedSkills(`--output=${out}`, null, dir));
  assert.equal(existsSync(out), false);
});
