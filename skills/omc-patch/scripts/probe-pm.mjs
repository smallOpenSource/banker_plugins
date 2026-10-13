#!/usr/bin/env node
// project-memory probe for /banker:omc-patch. Runs one OMC plugin folder's project-memory-session.mjs the
// way Claude Code runs it at SessionStart, in a scratch project with its own home and state folder, then
// checks that the hook really wrote project-memory.json. A hook whose patched import died inside a block
// still exits 0 and prints {"continue":true}; only the file shows whether it did its work.
// The user's ~/.claude and the current project's .omc are not touched. Pure Node, no dependencies.
//
//   node probe-pm.mjs --plugin <OMC plugin folder> [--scratch <new folder>] [--keep] [--timeout <seconds>]
//
// Without --scratch the probe works in a new temp folder and removes it at the end (--keep leaves it).
// A --scratch folder is never reused and is left for inspection.
// Prints PROBE GREEN or PROBE RED with the reason. Exit 0 green, 1 red, 2 usage (no hook script, the
// scratch folder already exists, a bad option).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = join("scripts", "project-memory-session.mjs");
const PACKAGE = { name: "omc-pm-probe", version: "0.0.0", scripts: { build: "node build.js", test: "node test.js" } };
const MAX_OUTPUT = 16 * 1024 * 1024;

export class UsageError extends Error {}

export function parseArgs(argv) {
  const o = { plugin: null, scratch: null, keep: false, timeout: 30 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--keep") o.keep = true;
    else if (["--plugin", "--scratch", "--timeout"].includes(a)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new UsageError(`${a} 뒤에 값이 필요합니다`);
      o[a.slice(2)] = a === "--timeout" ? Number(v) : v;
    } else throw new UsageError(`모르는 인자 ${a}`);
  }
  if (!o.plugin) throw new UsageError("--plugin <OMC 플러그인 폴더> 가 필요합니다");
  if (!(o.timeout > 0)) throw new UsageError("--timeout 은 0 보다 큰 초입니다");
  return o;
}

// Variables of this session the hook must not see. GIT_* goes too: GIT_DIR and its kin would point git
// past the ceiling below.
const dropped = (u) => u.startsWith("CLAUDE_") || u.startsWith("OMC_") || u.startsWith("GIT_") || u === "DISABLE_OMC";

// The hook sees only what Claude Code would give it, pointed at the scratch tree: no CLAUDE_*, OMC_* or GIT_*
// variable of this session leaks in, and git stops at the scratch folder. Keys compare in upper case
// because Windows treats them so.
export function probeEnv(base, scratch, plugin) {
  const env = {};
  for (const [k, v] of Object.entries(base)) if (!dropped(k.toUpperCase())) env[k] = v;
  const home = join(scratch, "home");
  Object.assign(env, {
    HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), CLAUDE_PLUGIN_ROOT: plugin,
    OMC_STATE_DIR: join(scratch, "state"), OMC_NOTIFY: "0", GIT_CEILING_DIRECTORIES: scratch,
  });
  return env;
}

function makeScratch(scratch) {
  const project = join(scratch, "project");
  for (const d of [project, join(scratch, "home", ".claude"), join(scratch, "state")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(project, "package.json"), JSON.stringify(PACKAGE));
  return project;
}

// Every project-memory.json under the scratch folder, wherever the hook chose to put it.
export function findMemoryFiles(dir, depth = 0) {
  if (depth > 8) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return findMemoryFiles(p, depth + 1);
    return e.isFile() && e.name === "project-memory.json" ? [p] : [];
  });
}

const samePath = (a, b) => {
  const norm = (p) => resolve(String(p)).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
};

const languagesOf = (mem) => (Array.isArray(mem.techStack?.languages) ? mem.techStack.languages : []);

// Each check: [passes(mem, project), what failed]. Checked in order; the first failure is the reason.
const MEMORY_CHECKS = [
  [(mem, project) => samePath(mem.projectRoot, project), (mem) => `projectRoot 가 스크래치 프로젝트가 아님(${mem.projectRoot})`],
  [(mem) => languagesOf(mem).length > 0, () => "techStack.languages 가 비어 있음"],
  [(mem) => mem.build?.scripts?.build === PACKAGE.scripts.build, () => "build.scripts.build 가 package.json 과 다름"],
  [(mem) => mem.lastScanned !== undefined && mem.lastScanned !== null, () => "lastScanned 가 없음"],
];

// The first check that fails, or null when the memory describes the scratch project.
export function memoryProblem(mem, project) {
  if (!mem || typeof mem !== "object") return "project-memory.json 을 JSON 으로 읽지 못함";
  const failed = MEMORY_CHECKS.find(([passes]) => !passes(mem, project));
  return failed ? failed[1](mem) : null;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function verdict(run, files, project) {
  if (run.error?.code === "ENOBUFS") return "PROBE RED: 훅 출력이 16MB 를 넘음";
  if (run.error?.code === "ETIMEDOUT" || run.signal) return "PROBE RED: 훅이 시간 안에 끝나지 않음";
  if (run.status !== 0) return `PROBE RED: 훅 종료 코드 ${run.status}`;
  if (!files.length) return "PROBE RED: no project-memory.json (훅이 돌았지만 아무 일도 하지 않음)";
  if (files.length > 1) return `PROBE RED: project-memory.json 이 ${files.length}개`;
  const problem = memoryProblem(readJson(files[0]), project);
  return problem ? `PROBE RED: ${problem}` : "PROBE GREEN: 스크래치 프로젝트의 project-memory.json 이 만들어짐";
}

export function probe({ plugin, scratch, timeout }) {
  const script = join(plugin, HOOK);
  const project = makeScratch(scratch);
  const payload = JSON.stringify({ session_id: "omc-patch-probe", transcript_path: join(scratch, "transcript.jsonl"),
    cwd: project, hook_event_name: "SessionStart", source: "startup" });
  const run = spawnSync(process.execPath, [script], { cwd: project, input: payload, env: probeEnv(process.env, scratch, plugin),
    encoding: "utf8", timeout: Math.max(1, Math.ceil(timeout * 1000)), maxBuffer: MAX_OUTPUT, windowsHide: true });
  const files = findMemoryFiles(scratch);
  return { script, run, files, line: verdict(run, files, project) };
}

const one = (s) => String(s || "").replace(/\s+/g, " ").trim().slice(0, 300);

// The parsed options with the plugin folder resolved, or a UsageError for what cannot run.
function prepare(argv) {
  const o = parseArgs(argv);
  const plugin = resolve(o.plugin);
  if (!existsSync(join(plugin, HOOK))) throw new UsageError(`훅 스크립트가 없습니다: ${join(plugin, HOOK)}`);
  return { ...o, plugin };
}

// A --scratch folder is made here and must not exist yet. A plain mkdir fails on anything already at that
// path, a symlink included, so the probe never writes through a folder it did not create.
function claimScratch(dir) {
  mkdirSync(dirname(dir), { recursive: true });
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (e) {
    if (e.code === "EEXIST") throw new UsageError(`스크래치 폴더가 이미 있습니다(다시 쓰지 않음): ${dir}`);
    throw e;
  }
  return dir;
}

function removeTemp(scratch, out) {
  try {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  } catch (e) {
    out.write(`probe-pm: 임시 폴더를 지우지 못함(${e.code || e.message}): ${scratch}\n`);
  }
}

const reportLines = (r, scratch) => [`node      ${process.execPath}`, `script    ${r.script}`, `scratch   ${scratch}`,
  `exit      ${r.run.status}${r.run.signal ? ` (signal ${r.run.signal})` : ""}`, `stdout    ${one(r.run.stdout)}`,
  `stderr    ${one(r.run.stderr)}`, `memfiles  ${r.files.length}`, r.line].join("\n");

export function main(argv, out = process.stdout) {
  let o;
  let scratch;
  try {
    o = prepare(argv);
    scratch = o.scratch ? claimScratch(resolve(o.scratch)) : mkdtempSync(join(tmpdir(), "omc-pm-probe-"));
  } catch (e) {
    out.write(`probe-pm: ${e.message}\n`);
    return 2;
  }
  try {
    const r = probe({ plugin: o.plugin, scratch, timeout: o.timeout });
    out.write(`${reportLines(r, scratch)}\n`);
    return r.line.startsWith("PROBE GREEN") ? 0 : 1;
  } finally {
    if (!o.scratch && !o.keep) removeTemp(scratch, out);
  }
}

// Run as a command, also when reached through a symlinked path: Node resolves
// symlinks for import.meta.url but not for process.argv[1].
const invokedDirectly = () => {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
};

if (invokedDirectly()) process.exitCode = main(process.argv.slice(2));
