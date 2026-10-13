// Tests for probe-pm.mjs. Run from the repo root: node --test skills/omc-patch/scripts/probe-pm.test.mjs
// No network and no real home: each case builds a fake plugin folder whose project-memory-session.mjs
// stands in for OMC's hook.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { UsageError, findMemoryFiles, memoryProblem, parseArgs, probeEnv } from "./probe-pm.mjs";

const TOOL = fileURLToPath(new URL("./probe-pm.mjs", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "probe-pm-test-"));
after(() => rmSync(root, { recursive: true, force: true }));
let seq = 0;

// A stand-in hook. mode: good, silent (the misplaced-helper symptom), wrong, slow, crash.
const HOOK = (mode) => `import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const mode = ${JSON.stringify(mode)};
let input = "";
process.stdin.on("data", (c) => { input += c; });
process.stdin.on("end", async () => {
  const data = JSON.parse(input || "{}");
  const env = process.env;
  writeFileSync(join(env.OMC_STATE_DIR, "env.json"), JSON.stringify({ home: env.HOME, cfg: env.CLAUDE_CONFIG_DIR,
    plugin: env.CLAUDE_PLUGIN_ROOT, leak: env.CLAUDE_PROBE_LEAK ?? null, omc: env.OMC_PROBE_LEAK ?? null, notify: env.OMC_NOTIFY,
    gitdir: env.GIT_DIR ?? null, ceiling: env.GIT_CEILING_DIRECTORIES }));
  if (mode === "slow") await new Promise((r) => setTimeout(r, 5000));
  if (mode === "loud") process.stdout.write("x".repeat(17 * 1024 * 1024));
  if (mode === "crash") process.exit(3);
  if (mode !== "silent") {
    mkdirSync(join(data.cwd, ".omc"), { recursive: true });
    const build = mode === "wrong" ? "x" : "node build.js";
    writeFileSync(join(data.cwd, ".omc", "project-memory.json"), JSON.stringify({ projectRoot: data.cwd,
      techStack: { languages: [{ name: "JavaScript" }] }, build: { scripts: { build } }, lastScanned: 1 }));
  }
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
});
`;

function plugin(mode) {
  const p = join(root, `plugin${seq++}`);
  mkdirSync(join(p, "scripts"), { recursive: true });
  writeFileSync(join(p, "scripts", "project-memory-session.mjs"), HOOK(mode));
  return p;
}

function run(args, env = {}) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
  return { code: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
}
const scratchOf = (out) => (out.match(/^scratch\s+(.+)$/m) || [])[1];

test("green when the hook writes the scratch project's memory; the hook gets a scratch home and no session variables", () => {
  const scratch = join(root, `scratch${seq++}`);
  const r = run(["--plugin", plugin("good"), "--scratch", scratch], { CLAUDE_PROBE_LEAK: "x", OMC_PROBE_LEAK: "y", OMC_NOTIFY: "1", GIT_DIR: "/elsewhere/.git" });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /PROBE GREEN/);
  const env = JSON.parse(readFileSync(join(scratch, "state", "env.json"), "utf8"));
  assert.ok(env.home.startsWith(scratch) && env.cfg.startsWith(scratch), JSON.stringify(env));
  assert.equal(env.leak, null);
  assert.equal(env.omc, null);
  assert.equal(env.notify, "0");
  assert.equal(env.gitdir, null, "GIT_* of the session does not reach the hook");
  assert.equal(env.ceiling, scratch);
  assert.ok(existsSync(scratch), "a --scratch folder is left for inspection");
});

test("red when the hook ran but wrote nothing, which is what a helper stuck in a block looks like", () => {
  const r = run(["--plugin", plugin("silent")]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /PROBE RED: no project-memory\.json/);
});

test("red when the memory is wrong, the hook fails or it does not finish in time", () => {
  const wrong = run(["--plugin", plugin("wrong")]);
  assert.equal(wrong.code, 1, wrong.out);
  assert.match(wrong.out, /PROBE RED: build\.scripts\.build/);
  const crash = run(["--plugin", plugin("crash")]);
  assert.equal(crash.code, 1, crash.out);
  assert.match(crash.out, /PROBE RED: 훅 종료 코드 3/);
  const slow = run(["--plugin", plugin("slow"), "--timeout", "1"]);
  assert.equal(slow.code, 1, slow.out);
  assert.match(slow.out, /PROBE RED: 훅이 시간 안에 끝나지 않음/);
});

test("usage errors exit 2; the temp scratch goes away unless --keep", () => {
  assert.equal(run(["--plugin", join(root, "nowhere")]).code, 2);
  const taken = join(root, `taken${seq++}`);
  mkdirSync(taken);
  const reuse = run(["--plugin", plugin("good"), "--scratch", taken]);
  assert.equal(reuse.code, 2);
  assert.match(reuse.out, /이미 있습니다/);
  assert.equal(run([]).code, 2);
  assert.equal(run(["--plugin"]).code, 2);
  assert.equal(run(["--plugin", plugin("good"), "--timeout", "0"]).code, 2);
  assert.equal(run(["--plugin", plugin("good"), "--what"]).code, 2);
  const gone = run(["--plugin", plugin("good")]);
  assert.equal(gone.code, 0, gone.out);
  assert.equal(existsSync(scratchOf(gone.out)), false);
  const kept = run(["--plugin", plugin("good"), "--keep"]);
  assert.equal(existsSync(scratchOf(kept.out)), true);
  rmSync(scratchOf(kept.out), { recursive: true, force: true });
});

test("helpers: memory checks, file search, argument parsing and the cleaned environment", () => {
  const project = join(root, "p");
  const good = { projectRoot: project, techStack: { languages: [{ name: "JS" }] }, build: { scripts: { build: "node build.js" } }, lastScanned: 0 };
  assert.equal(memoryProblem(good, project), null);
  assert.match(memoryProblem({ ...good, projectRoot: join(root, "q") }, project), /projectRoot/);
  assert.match(memoryProblem({ ...good, techStack: {} }, project), /languages/);
  assert.match(memoryProblem({ ...good, lastScanned: null }, project), /lastScanned/);
  assert.match(memoryProblem(null, project), /JSON/);
  const deep = join(root, `deep${seq++}`, "a", "b");
  mkdirSync(deep, { recursive: true });
  writeFileSync(join(deep, "project-memory.json"), "{}");
  assert.equal(findMemoryFiles(join(deep, "..", "..")).length, 1);
  assert.throws(() => parseArgs(["--scratch", "x"]), UsageError);
  assert.deepEqual(parseArgs(["--plugin", "p", "--keep"]), { plugin: "p", scratch: null, keep: true, timeout: 30 });
  const env = probeEnv({ PATH: "/bin", claude_lower: "1", Omc_Mixed: "2", DISABLE_OMC: "1" }, "/s", "/plug");
  assert.equal(env.PATH, "/bin");
  for (const k of ["claude_lower", "Omc_Mixed", "DISABLE_OMC"]) assert.equal(env[k], undefined, k);
  assert.equal(env.CLAUDE_PLUGIN_ROOT, "/plug");
  assert.equal(env.GIT_CEILING_DIRECTORIES, "/s");
});

test("runs when reached through a symlinked path, takes a fractional timeout and reports oversized output", (t) => {
  const link = join(root, `link${seq++}.mjs`);
  try {
    symlinkSync(TOOL, link);
  } catch {
    t.skip("symlinks not allowed here");
    return;
  }
  const r = spawnSync(process.execPath, [link, "--plugin", plugin("good"), "--timeout", "1.5"], { encoding: "utf8" });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /PROBE GREEN/);
  const loud = run(["--plugin", plugin("loud")]);
  assert.equal(loud.code, 1, loud.out.slice(0, 300));
  assert.match(loud.out, /PROBE RED: 훅 출력이 16MB 를 넘음/);
});
