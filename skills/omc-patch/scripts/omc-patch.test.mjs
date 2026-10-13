// Tests for omc-patch.mjs. Run from the repo root: node --test skills/omc-patch/scripts/omc-patch.test.mjs
// No network and no real home: every run uses a fake HOME in a temp dir.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const TOOL = fileURLToPath(new URL("./omc-patch.mjs", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "omc-patch-test-"));
after(() => rmSync(root, { recursive: true, force: true }));

const HAS_GIT = spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
const ORIGIN = "https://example.invalid/omc.git";

const HOOKS_JSON = JSON.stringify({
  hooks: {
    Stop: [{ hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/stopper.mjs"' }] }],
    PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/foo.mjs"' }] }],
  },
}, null, 2) + "\n";
const SCRIPT = (name) => `import { pathToFileURL } from "node:url";\nconst { x } = await import("./lib.mjs");\nconsole.log("${name}:" + typeof x);\n`;
const LIB = "export const x = () => 1;\n";

let seq = 0;
// versions: [{ v, active }]. Builds ~/.claude/plugins with installed_plugins.json, cache folders and a git marketplace.
function fakeHome(versions, { git = true } = {}) {
  const home = join(root, `home${seq++}`);
  const plugins = join(home, ".claude", "plugins");
  const cache = join(plugins, "cache", "omc", "oh-my-claudecode");
  for (const { v } of versions) {
    const r = join(cache, v);
    mkdirSync(join(r, "hooks"), { recursive: true });
    mkdirSync(join(r, "scripts"), { recursive: true });
    writeFileSync(join(r, "hooks", "hooks.json"), HOOKS_JSON);
    for (const n of ["foo", "stopper"]) writeFileSync(join(r, "scripts", `${n}.mjs`), SCRIPT(n));
    writeFileSync(join(r, "scripts", "lib.mjs"), LIB);
  }
  const active = versions.find((e) => e.active).v;
  writeFileSync(join(plugins, "installed_plugins.json"), JSON.stringify({
    version: 2,
    plugins: { "oh-my-claudecode@omc": [{ scope: "user", installPath: join(cache, active), version: active }] },
  }, null, 2) + "\n");
  if (git) {
    const m = join(plugins, "marketplaces", "omc");
    mkdirSync(m, { recursive: true });
    for (const a of [["init", "-q"], ["remote", "add", "origin", ORIGIN]]) {
      const r = spawnSync("git", a, { cwd: m, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
    }
  }
  return { home, plugins, cache, market: join(plugins, "marketplaces", "omc") };
}

function run(home, args) {
  const r = spawnSync(process.execPath, [TOOL, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  return { code: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
}
const origin = (market) => spawnSync("git", ["remote", "get-url", "origin"], { cwd: market, encoding: "utf8" }).stdout.trim();
const read = (p) => readFileSync(p, "utf8");
const omcbaks = (dir) => readdirSync(dir).filter((f) => f.endsWith(".omcbak"));

test("check reports the active version from installed_plugins.json, not the TARGET folder", () => {
  const f = fakeHome([{ v: "5.3.0" }, { v: "5.6.1", active: true }], { git: false });
  const r = run(f.home, ["--check", "--no-update"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /활성 버전: 5\.6\.1 \(installed_plugins\.json\)/);
  assert.doesNotMatch(r.out, /활성 버전: 5\.3\.0/);
  assert.match(r.out, /적용되지 않은 항목/);
  // check scans every installed version, so the count includes the idle folder: 2 files x 2 versions
  assert.match(r.out, /패치 필요 4건/);
  assert.match(r.out, /PostToolUse 남아있음: foo/);
  // check never writes
  assert.deepEqual(omcbaks(join(f.cache, "5.6.1", "scripts")), []);
});

test("--no-update apply patches only the active version, removes PostToolUse, pins origin; check then passes", { skip: !HAS_GIT && "git not found" }, () => {
  const f = fakeHome([{ v: "5.3.0" }, { v: "5.6.1", active: true }]);
  const r = run(f.home, ["--no-update"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /패치 2건 \/ 실패 0건/);
  assert.match(r.out, /제거: foo/);

  const act = join(f.cache, "5.6.1");
  for (const n of ["foo", "stopper"]) {
    const p = join(act, "scripts", `${n}.mjs`);
    assert.match(read(p), /__omcRaceImport\(import\(/);
    assert.equal(read(`${p}.omcbak`), SCRIPT(n));
    const c = spawnSync(process.execPath, ["--check", p], { encoding: "utf8" });
    assert.equal(c.status, 0, c.stderr);
    const e = spawnSync(process.execPath, [p], { encoding: "utf8" });
    assert.equal(e.status, 0, e.stderr);
    assert.equal(e.stdout.trim(), `${n}:function`);
  }
  assert.equal(JSON.parse(read(join(act, "hooks", "hooks.json"))).hooks.PostToolUse, undefined);
  assert.ok(JSON.parse(read(join(act, "hooks", "hooks.json"))).hooks.Stop);
  assert.equal(origin(f.market), `omc-pinned://${ORIGIN}`);

  const chk = run(f.home, ["--check", "--no-update"]);
  // the active version block lists nothing to patch; the idle 5.3.0 block still does
  const activeBlock = chk.out.split("— 5.6.1")[1].split("— 5.3.0")[0];
  assert.doesNotMatch(activeBlock, /패치 필요/);
  assert.match(chk.out, /결과: 모두 적용된 상태입니다\./);
});

test("--revert restores files, hooks.json and origin", { skip: !HAS_GIT && "git not found" }, () => {
  const f = fakeHome([{ v: "5.6.1", active: true }]);
  assert.equal(run(f.home, ["--no-update"]).code, 0);
  const r = run(f.home, ["--revert"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /되돌리기 완료/);
  const act = join(f.cache, "5.6.1");
  for (const n of ["foo", "stopper"]) assert.equal(read(join(act, "scripts", `${n}.mjs`)), SCRIPT(n));
  assert.equal(read(join(act, "hooks", "hooks.json")), HOOKS_JSON);
  assert.deepEqual(omcbaks(join(act, "scripts")), []);
  assert.equal(origin(f.market), ORIGIN);
  assert.equal(existsSync(join(f.home, ".claude", "omc-local-patches", "PINNED")), false);
});

test("negative control: a version folder that is not active stays untouched by apply", { skip: !HAS_GIT && "git not found" }, () => {
  const f = fakeHome([{ v: "5.3.0" }, { v: "5.6.1", active: true }]);
  const idle = join(f.cache, "5.3.0");
  const before = { hooks: read(join(idle, "hooks", "hooks.json")), foo: read(join(idle, "scripts", "foo.mjs")), stopper: read(join(idle, "scripts", "stopper.mjs")) };
  const r = run(f.home, ["--no-update"]);
  assert.equal(r.code, 0, r.out);
  assert.equal(read(join(idle, "hooks", "hooks.json")), before.hooks);
  assert.equal(read(join(idle, "scripts", "foo.mjs")), before.foo);
  assert.equal(read(join(idle, "scripts", "stopper.mjs")), before.stopper);
  assert.deepEqual(omcbaks(join(idle, "scripts")), []);
  assert.equal(existsSync(join(idle, "hooks", "hooks.json.omcbak")), false);
  // the verdict ignores the idle folder but names it as information
  const chk = run(f.home, ["--check", "--no-update"]);
  assert.match(chk.out, /결과: 모두 적용된 상태입니다\./);
  assert.match(chk.out, /참고: 비활성 버전 5\.3\.0/);
});

test("hooks with more than one top-level block keep every import working after apply", { skip: !HAS_GIT && "git not found" }, () => {
  // OMC 5.6.x project-memory-session.mjs has this shape: each top-level `await import(...)` sits in its own `try { }`.
  const f = fakeHome([{ v: "5.6.1", active: true }]);
  const p = join(f.cache, "5.6.1", "scripts", "stopper.mjs");
  writeFileSync(p, [
    "let a;",
    "try {",
    "  const m = await import(\"./lib.mjs\");",
    "  a = m.x;",
    "} catch (e) { console.log(\"first failed: \" + e.message); }",
    "let b;",
    "try {",
    "  const m = await import(\"node:path\");",
    "  b = m.join;",
    "} catch (e) { console.log(\"second failed: \" + e.message); }",
    "console.log(\"stopper:\" + typeof a + \",\" + typeof b);",
    "",
  ].join("\n"));
  const r = run(f.home, ["--no-update"]);
  assert.equal(r.code, 0, r.out);
  assert.match(read(p), /__omcRaceImport\(import\("node:path"\)\)/, "both sites are wrapped");
  const e = spawnSync(process.execPath, [p], { encoding: "utf8" });
  assert.equal(e.status, 0, e.stderr);
  assert.equal(e.stdout.trim(), "stopper:function,function");
});

// OMC 5.6.x project-memory-session.mjs shape: each top-level `await import(...)` sits in its own `try { }`.
const TWO_BLOCKS = [
  "let a;",
  "try {",
  "  const m = await import(\"./lib.mjs\");",
  "  a = m.x;",
  "} catch (e) { console.log(\"first failed: \" + e.message); }",
  "let b;",
  "try {",
  "  const m = await import(\"node:path\");",
  "  b = m.join;",
  "} catch (e) { console.log(\"second failed: \" + e.message); }",
  "console.log(\"stopper:\" + typeof a + \",\" + typeof b);",
  "",
].join("\n");
// What an old kit left: the helper declared at the line of the first wrapped site, inside the first block.
const MISPLACED = TWO_BLOCKS
  .replace("  const m = await import(\"./lib.mjs\");", "const __omcRaceImport = (p) => p;\n  const m = await __omcRaceImport(import(\"./lib.mjs\"));")
  .replace("await import(\"node:path\")", "await __omcRaceImport(import(\"node:path\"))");

test("an old kit's helper stuck in a block: check names it, apply leaves it, --revert --root then apply fixes it", { skip: !HAS_GIT && "git not found" }, () => {
  const f = fakeHome([{ v: "5.7.0", active: true }]);
  const act = join(f.cache, "5.7.0");
  const p = join(act, "scripts", "stopper.mjs");
  writeFileSync(`${p}.omcbak`, TWO_BLOCKS);
  writeFileSync(p, MISPLACED);
  assert.match(spawnSync(process.execPath, [p], { encoding: "utf8" }).stdout, /second failed: __omcRaceImport is not defined/);
  const chk = run(f.home, ["--check", "--no-update"]);
  assert.match(chk.out, /헬퍼 자리 결함: stopper \(헬퍼 선언 :3 이 블록 안, 깊이 1\)/);
  assert.match(chk.out, /결과: 헬퍼 자리 결함 1건이 있습니다\. --revert 로 되돌린 뒤 다시 적용하십시오\./);
  const apply = run(f.home, ["--no-update"]);
  assert.match(apply.out, /\[!\] 헬퍼 자리 결함 1건은 고치지 않았습니다\./);
  assert.equal(read(p), MISPLACED, "apply cannot fix an already wrapped file");
  const pinned = origin(f.market);
  const rev = run(f.home, ["--revert", "--root", act]);
  assert.equal(rev.code, 0, rev.out);
  assert.equal(read(p), TWO_BLOCKS);
  assert.equal(read(join(act, "hooks", "hooks.json")), HOOKS_JSON);
  assert.equal(origin(f.market), pinned, "--root leaves the marketplace pin alone");
  assert.equal(run(f.home, ["--no-update"]).code, 0);
  assert.equal(spawnSync(process.execPath, [p], { encoding: "utf8" }).stdout.trim(), "stopper:function,function");
  assert.match(run(f.home, ["--check", "--no-update"]).out, /결과: 모두 적용된 상태입니다\./);
});

test("--scan reports each helper's block depth and the wrapped sites as JSON without writing", { skip: !HAS_GIT && "git not found" }, () => {
  const f = fakeHome([{ v: "5.7.0", active: true }]);
  const p = join(f.cache, "5.7.0", "scripts", "stopper.mjs");
  writeFileSync(p, MISPLACED);
  const bad = JSON.parse(run(f.home, ["--scan", p]).out);
  assert.equal(bad[0].helperDecls[0].depth, 1);
  assert.equal(bad[0].wrapped.length, 2);
  assert.equal(read(p), MISPLACED);
  writeFileSync(p, TWO_BLOCKS);
  assert.equal(run(f.home, ["--no-update"]).code, 0);
  const good = JSON.parse(run(f.home, ["--scan", p]).out);
  assert.deepEqual(good[0].helperDecls.map((d) => d.depth), [0]);
  assert.deepEqual(good[0].unwrapped, []);
  const missing = run(f.home, ["--scan", join(f.cache, "nope.mjs")]);
  assert.equal(missing.code, 1);
  assert.ok(JSON.parse(missing.out)[0].error);
  assert.equal(run(f.home, ["--scan"]).code, 1);
});

test("--root patches a plugin folder with no installed_plugins.json, and skips the version and the pin", () => {
  const home = join(root, `bare${seq++}`);
  mkdirSync(home, { recursive: true });
  const plug = join(root, `bundle${seq++}`);
  mkdirSync(join(plug, "hooks"), { recursive: true });
  mkdirSync(join(plug, "scripts"), { recursive: true });
  writeFileSync(join(plug, "hooks", "hooks.json"), HOOKS_JSON);
  for (const n of ["foo", "stopper"]) writeFileSync(join(plug, "scripts", `${n}.mjs`), SCRIPT(n));
  writeFileSync(join(plug, "scripts", "lib.mjs"), LIB);
  const chk = run(home, ["--root", plug, "--check"]);
  assert.equal(chk.code, 0, chk.out);
  assert.match(chk.out, /건너뜀 \(--root 는 판을 바꾸지 않음\)/);
  assert.match(chk.out, /패치 필요 2건/);
  const r = run(home, ["--root", plug]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /패치 2건 \/ 실패 0건/);
  assert.match(r.out, /건너뜀 \(--root 는 마켓플레이스와 settings\.json 을 건드리지 않음\)/);
  assert.equal(existsSync(join(home, ".claude")), false, "nothing is written under the home");
  assert.match(run(home, ["--root", plug, "--check"]).out, /결과: 모두 적용된 상태입니다\./);
  assert.match(run(home, ["--root"]).out, /--root 뒤에 플러그인 폴더 경로가 필요합니다/);
  const notPlugin = run(home, ["--root", home]);
  assert.equal(notPlugin.code, 1);
  assert.match(notPlugin.out, /플러그인 폴더가 아님/);
});

test("a marketplace folder without its own .git is not pinned, and an enclosing repo keeps its origin", { skip: !HAS_GIT && "git not found" }, () => {
  const f = fakeHome([{ v: "5.6.1", active: true }], { git: false });
  mkdirSync(f.market, { recursive: true });
  const claude = join(f.home, ".claude");
  const dotfiles = "https://example.invalid/dotfiles.git";
  for (const a of [["init", "-q"], ["remote", "add", "origin", dotfiles]]) {
    const g = spawnSync("git", a, { cwd: claude, encoding: "utf8" });
    assert.equal(g.status, 0, g.stderr);
  }
  const r = run(f.home, ["--no-update"]);
  assert.equal(r.code, 0, r.out);
  assert.equal(origin(claude), dotfiles, "the ~/.claude repo origin is untouched");
  assert.equal(existsSync(join(claude, "omc-local-patches", "PINNED")), false);
  assert.match(r.out, /git 저장소가 아님/);
});

test("--revert --root leaves the other version folders and the pin alone; a defect without a backup stays and is named", { skip: !HAS_GIT && "git not found" }, () => {
  const f = fakeHome([{ v: "5.6.1" }, { v: "5.7.0", active: true }]);
  const idle = join(f.cache, "5.6.1");
  const act = join(f.cache, "5.7.0");
  assert.equal(run(f.home, ["--root", idle]).code, 0);
  assert.equal(run(f.home, ["--no-update"]).code, 0);
  const pinned = origin(f.market);
  // stopper: an old kit's helper two blocks deep, and its backup gone (a hand-restored or copied folder)
  const nested = TWO_BLOCKS.replace("  const m = await import(\"./lib.mjs\");", "  if (a === undefined) {\nconst __omcRaceImport = (p) => p;\n    const m = await __omcRaceImport(import(\"./lib.mjs\"));\n  }")
    .replace("await import(\"node:path\")", "await __omcRaceImport(import(\"node:path\"))");
  const stopper = join(act, "scripts", "stopper.mjs");
  rmSync(`${stopper}.omcbak`);
  writeFileSync(stopper, nested);
  const rev = run(f.home, ["--revert", "--root", act]);
  assert.equal(rev.code, 0, rev.out);
  assert.equal(read(join(act, "scripts", "foo.mjs")), SCRIPT("foo"));
  for (const n of ["foo", "stopper"]) assert.match(read(join(idle, "scripts", `${n}.mjs`)), /__omcRaceImport/, "the idle version stays patched");
  assert.equal(origin(f.market), pinned);
  assert.doesNotMatch(rev.out, /되돌림 +stopper/, "no backup, so nothing to restore");
  assert.equal(read(stopper), nested);
  assert.match(run(f.home, ["--check", "--no-update"]).out, /헬퍼 자리 결함: stopper \(헬퍼 선언 :\d+ 이 블록 안, 깊이 2\)/);
  assert.deepEqual(JSON.parse(run(f.home, ["--scan", stopper]).out)[0].helperDecls.map((d) => d.depth), [2]);
});
