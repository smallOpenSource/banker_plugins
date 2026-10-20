// Tests for gen-skill-changes.js. Run from the repo root: node --test scripts/gen-skill-changes.test.mjs
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
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

// npm reaches no registry from this test: update_notifier=false stops the weekly update check, the one request
// npm pack made; offline keeps any other lookup off the network, and audit and fund are off for any npm that adds one.
// Its cache and logs go to this test's folder, not the real ~/.npm.
const NPM_OFFLINE = { npm_config_update_notifier: "false", npm_config_offline: "true", npm_config_audit: "false", npm_config_fund: "false",
  npm_config_cache: join(root, "npm-cache") };
// npm reads npm_config_* names whatever their case and the last spelling wins, so the caller's own NPM_CONFIG_OFFLINE
// (after our npm_config_offline in the environment's order) would undo it: drop every spelling of the keys set here.
function npmOfflineEnv(base) {
  const env = { ...base };
  for (const key of Object.keys(env)) if (Object.hasOwn(NPM_OFFLINE, key.toLowerCase())) delete env[key];
  return { ...env, ...NPM_OFFLINE };
}
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
    { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: npmOfflineEnv(process.env) });
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


test("npm stays offline whichever way the caller's environment spells the same settings", (t) => {
  const cli = npmCli();
  if (!cli) {
    t.skip("npm-cli.js not found beside node");
    return;
  }
  const callers = { npm_config_offline: "false", NPM_CONFIG_OFFLINE: "false", NPM_CONFIG_UPDATE_NOTIFIER: "true", Npm_Config_Audit: "true" };
  const env = npmOfflineEnv({ ...process.env, ...callers });
  const r = spawnSync(process.execPath, [cli, "config", "list", "--json"], { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout);
  assert.deepEqual([got.offline, got["update-notifier"], got.audit, got.fund], [true, false, false, false]);
});

// The command line: the tool runs from a copy inside a fixture repository (ROOT is the folder above scripts/).
const TOOL = fileURLToPath(new URL("./gen-skill-changes.js", import.meta.url));
const RELEASE_LINE = /^version=(\S+) from=([0-9a-f]{12}) to=(\S+) 바뀐 스킬\((\d+)\): (.*)$/;
// A repository whose last release commit (the last to touch plugin.json) is `base`, then one uncommitted edit to alpha.
function releasedFixture({ release = true, edit = true } = {}) {
  const { dir } = fixture();
  put(dir, "scripts/gen-skill-changes.js", readFileSync(TOOL, "utf8"));
  if (release) put(dir, ".claude-plugin/plugin.json", JSON.stringify({ version: "9.9.9" }));
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "release");
  const base = git(dir, "rev-parse", "HEAD");
  if (edit) put(dir, "skills/alpha/scripts/a.mjs", "export const a = 3;\n");
  return { dir, base };
}
const tool = (dir, ...args) => spawnSync(process.execPath, [join(dir, "scripts", "gen-skill-changes.js"), ...args],
  { cwd: dir, encoding: "utf8", env: process.env });
const manifestOf = (dir) => existsSync(join(dir, "skill-changes.json")) ? readFileSync(join(dir, "skill-changes.json"), "utf8") : null;

test("cli: by default compares the working tree with the last release commit and writes the plugin.json version", needGit, () => {
  const { dir, base } = releasedFixture();
  const r = tool(dir);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split("\n");
  assert.deepEqual(RELEASE_LINE.exec(lines[0]).slice(1), ["9.9.9", base.slice(0, 12), "작업트리", "1", "banker:alpha"]);
  assert.equal(lines[1], "skill-changes.json 갱신: [9.9.9] = banker:alpha");
  assert.equal(manifestOf(dir), JSON.stringify({ "9.9.9": ["banker:alpha"] }, null, 2) + "\n");
});

test("cli: --print reports and writes nothing; --from, --to and --version pick the range and the key", needGit, () => {
  const { dir, base } = releasedFixture();
  const printed = tool(dir, "--print", "--version", "8.8.8");
  assert.equal(printed.status, 0, printed.stderr);
  assert.equal(RELEASE_LINE.exec(printed.stdout.trim())[1], "8.8.8");
  assert.equal(manifestOf(dir), null);
  const head = commit(dir);
  const ranged = tool(dir, "--from", base, "--to", head, "--version", "8.8.8");
  assert.equal(ranged.status, 0, ranged.stderr);
  assert.deepEqual(RELEASE_LINE.exec(ranged.stdout.split("\n")[0]).slice(1), ["8.8.8", base.slice(0, 12), head, "1", "banker:alpha"]);
  assert.deepEqual(Object.keys(JSON.parse(manifestOf(dir))), ["8.8.8"]);
});

test("cli: no shipped change adds no entry; the manifest keeps older entries in version order", needGit, () => {
  const none = releasedFixture({ edit: false });
  const r = tool(none.dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /바뀐 스킬\(0\): 없음\n바뀐 스킬이 없어 항목을 추가하지 않습니다/);
  assert.equal(manifestOf(none.dir), null);
  const some = releasedFixture();
  put(some.dir, "skill-changes.json", JSON.stringify({ "9.10.0": ["banker:beta"], "9.2.0": ["banker:old"] }));
  assert.equal(tool(some.dir).status, 0);
  assert.deepEqual(JSON.parse(manifestOf(some.dir)), { "9.2.0": ["banker:old"], "9.9.9": ["banker:alpha"], "9.10.0": ["banker:beta"] });
  assert.deepEqual(Object.keys(JSON.parse(manifestOf(some.dir))), ["9.2.0", "9.9.9", "9.10.0"]);
});

test("cli: a version, a base or a ref it cannot settle ends with exit 1, a message, and no file", needGit, () => {
  const { dir } = releasedFixture();
  const badVersion = tool(dir, "--version", "9.9");
  assert.equal(badVersion.status, 1);
  assert.match(badVersion.stderr, /버전을 확정할 수 없습니다/);
  const badRef = tool(dir, "--from", "no-such-ref");
  assert.equal(badRef.status, 1);
  assert.match(badRef.stderr, /git diff 실패/);
  const noPlugin = releasedFixture({ release: false });
  const noVersion = tool(noPlugin.dir);
  assert.equal(noVersion.status, 1);
  assert.match(noVersion.stderr, /버전을 확정할 수 없습니다/);
  const noBase = tool(noPlugin.dir, "--version", "9.9.9");
  assert.equal(noBase.status, 1);
  assert.match(noBase.stderr, /비교 기준\(from\)을 찾지 못했습니다/);
  for (const d of [dir, noPlugin.dir]) assert.equal(manifestOf(d), null);
});

test("cli: by default the base is the last commit that touched plugin.json, not the first", needGit, () => {
  const { dir } = releasedFixture({ edit: false });
  put(dir, "skills/alpha/scripts/a.mjs", "export const a = 7;\n");          // shipped in the release after the first one
  put(dir, ".claude-plugin/plugin.json", JSON.stringify({ version: "9.9.10" }));
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "release 9.9.10");
  put(dir, "skills/beta/notes.md", "newer notes\n");                         // edited since that release
  const r = tool(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(RELEASE_LINE.exec(r.stdout.split("\n")[0])[5], "banker:beta");
});

test("a skill deleted whole is not named, though its files changed", needGit, () => {
  const { dir, base } = fixture();
  git(dir, "rm", "-rq", "skills/beta");
  assert.deepEqual(changedSkills(base, commit(dir), dir), []);
});

test("npm's environment drops every spelling of the keys it sets, keeps a name an object inherits, and keeps npm's cache in this test's folder", () => {
  const env = npmOfflineEnv({ constructor: "kept", NPM_CONFIG_OFFLINE: "false", Npm_Config_Cache: "/elsewhere", PATH: "/bin" });
  assert.equal(env.constructor, "kept", "a variable named like an inherited property is not dropped");
  assert.equal(env.NPM_CONFIG_OFFLINE, undefined);
  assert.equal(env.Npm_Config_Cache, undefined);
  assert.equal(env.npm_config_offline, "true");
  assert.ok(env.npm_config_cache?.startsWith(root), `npm_config_cache ${env.npm_config_cache} is under the test folder`);
});
