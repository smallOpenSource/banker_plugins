#!/usr/bin/env node
/**
 * motion-sites: the first-run setup and the lookup behind /motion-sites, a short name for MotionSites' own
 * motionsites-web-builder skill (https://github.com/Motionsites-AI/claude-skill). Nothing of that skill is copied
 * here: its examples and media may not be redistributed, so the user's own Claude Code or Codex installs it from
 * MotionSites' marketplace, as its README says.
 *
 *   status --runtime claude|codex   JSON: the plugin, its SKILL.md, a Python with Playwright, Chromium; ready or not
 *   setup  --runtime claude|codex   installs what is missing, in order, then answers as status
 *   path   --runtime claude|codex   the installed SKILL.md (exit 1 when not installed)
 *
 * setup runs, for Claude Code: claude plugin marketplace add Motionsites-AI/claude-skill, then claude plugin install
 * motionsites-web-builder@motionsites; for Codex: codex plugin marketplace add Motionsites-AI/claude-skill, then
 * codex plugin add motionsites-web-builder@motionsites. Then <python> -m pip install playwright and <python> -m
 * playwright install chromium. Where pip refuses the system Python (an externally managed environment), Playwright
 * goes into a virtual environment of its own under the cache folder (MOTION_SITES_HOME, else
 * ~/.cache/banker/motion-sites, %LOCALAPPDATA%\banker\motion-sites on Windows), and status names that Python.
 *
 * Every step has a time limit, so with no network a step fails with its reason instead of waiting. Exit status:
 * 0 ready (status, setup) or found (path), 1 not ready or a step failed, 2 usage.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = "Motionsites-AI/claude-skill";
export const PLUGIN = "motionsites-web-builder";
export const MARKET = "motionsites";
const ID = `${PLUGIN}@${MARKET}`;
const WIN = process.platform === "win32";
const STEP_MS = 10 * 60 * 1000; // a Chromium download can take minutes
const LOOK_MS = 60 * 1000;

const USAGE = `motion-sites: MotionSites 의 motionsites-web-builder 스킬 설치와 위치 확인
사용법: node motion-sites.mjs status|setup|path --runtime claude|codex`;

/**
 * Runs a program with fixed arguments: { ok, out, why }. On Windows claude and codex are .cmd shims, which Node runs
 * only through a shell; their arguments here are fixed words. Python gets no shell (its -c code holds quotes).
 */
export function run(cmd, args, { timeout = LOOK_MS, env = process.env } = {}) {
  const shell = WIN && (cmd === "claude" || cmd === "codex");
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout, env, shell, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (r.error) return { ok: false, out, why: r.error.code === "ETIMEDOUT" ? `시간 초과(${timeout / 1000}초)` : `${cmd} 실행 실패(${r.error.code})` };
  return { ok: r.status === 0, out, why: r.status === 0 ? null : `${cmd} ${args.join(" ")} 종료 ${r.status}: ${lastLine(out)}` };
}

const lastLine = (text) => text.trim().split(/\r?\n/).filter(Boolean).pop() ?? "";

/** The cache folder for the virtual environment. */
export function cacheHome(env = process.env) {
  if (env.MOTION_SITES_HOME) return env.MOTION_SITES_HOME;
  const base = WIN ? env.LOCALAPPDATA || join(homedir(), "AppData", "Local") : join(homedir(), ".cache");
  return join(base, "banker", "motion-sites");
}

const venvPython = (env) => join(cacheHome(env), "venv", WIN ? "Scripts" : "bin", WIN ? "python.exe" : "python");

/** The SKILL.md of the installed plugin for Claude Code, or null. */
export function claudeSkill(runner = run) {
  const r = runner("claude", ["plugin", "list", "--json"]);
  if (!r.ok) return null;
  let list;
  try {
    list = JSON.parse(r.out.slice(r.out.indexOf("[")));
  } catch {
    return null;
  }
  const p = Array.isArray(list) ? list.find((x) => x?.id === ID && x.enabled !== false) : null;
  const file = p?.installPath ? join(p.installPath, "skills", PLUGIN, "SKILL.md") : null;
  return file && existsSync(file) ? file : null;
}

/** The SKILL.md of the installed plugin for Codex (on in config.toml, newest version in the cache), or null. */
export function codexSkill(env = process.env) {
  const home = env.CODEX_HOME || join(homedir(), ".codex");
  let toml = "";
  try {
    toml = readFileSync(join(home, "config.toml"), "utf8");
  } catch {
    return null;
  }
  const table = new RegExp(`^\\[plugins\\."${ID.replace(/[.]/g, "\\.")}"\\]\\s*\\n([^\\[]*)`, "m").exec(toml);
  if (!table || /^\s*enabled\s*=\s*false/m.test(table[1])) return null;
  const dir = join(home, "plugins", "cache", MARKET, PLUGIN);
  let versions = [];
  try {
    versions = readdirSync(dir).sort(byVersion);
  } catch {
    return null;
  }
  const file = versions.map((v) => join(dir, v, "skills", PLUGIN, "SKILL.md")).reverse().find((f) => existsSync(f));
  return file ?? null;
}

export function byVersion(a, b) {
  const pa = a.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const pb = b.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (pa[i] === pb[i]) continue;
    // 2.0.0-rc1 comes before 2.0.0 (a pre-release tail), 2.0.0.1 after it
    if (pa[i] === undefined) return typeof pb[i] === "string" ? 1 : -1;
    if (pb[i] === undefined) return typeof pa[i] === "string" ? -1 : 1;
    return typeof pa[i] === "number" && typeof pb[i] === "number" ? pa[i] - pb[i] : String(pa[i]).localeCompare(String(pb[i]));
  }
  return 0;
}

/** Python programs to try, in order: MOTION_SITES_PYTHON, the cache's virtual environment, then the system's. */
export function pythons(env = process.env) {
  const list = [];
  if (env.MOTION_SITES_PYTHON) list.push([env.MOTION_SITES_PYTHON]);
  list.push([venvPython(env)]);
  if (WIN) list.push(["py", "-3"], ["python"]);
  else list.push(["python3"], ["python"]);
  return list;
}

const CHROMIUM = "from playwright.sync_api import sync_playwright as s\np=s().start()\nprint(p.chromium.executable_path)\np.stop()";

/** What one Python has: { bin, playwright, chromium } or null when it does not run. */
export function lookPython(py, runner = run) {
  const [cmd, ...pre] = py;
  if (/[\\/]/.test(cmd) && !existsSync(cmd)) return null;
  const v = runner(cmd, [...pre, "-c", "import sys;print(sys.executable)"]);
  if (!v.ok) return null;
  const bin = lastLine(v.out);
  const pw = runner(cmd, [...pre, "-c", "import playwright"]).ok;
  const exe = pw ? runner(cmd, [...pre, "-c", CHROMIUM]) : { ok: false, out: "" };
  return { bin, cmd: py, playwright: pw, chromium: exe.ok && existsSync(lastLine(exe.out)) };
}

/** The first Python with Playwright (and Chromium, when one has both), else the first that runs. */
export function pickPython(env = process.env, runner = run) {
  const seen = pythons(env).map((p) => lookPython(p, runner)).filter(Boolean);
  return seen.find((p) => p.playwright && p.chromium) ?? seen.find((p) => p.playwright) ?? seen[0] ?? null;
}

/** status: the plugin and the Python, and whether /motion-sites can hand over now. */
export function status(runtime, { env = process.env, runner = run } = {}) {
  const skill = runtime === "claude" ? claudeSkill(runner) : codexSkill(env);
  const py = pickPython(env, runner);
  const python = py ? { bin: py.bin, playwright: py.playwright, chromium: py.chromium } : null;
  return { runtime, plugin: ID, skillFile: skill, python, ready: Boolean(skill && py?.playwright && py?.chromium) };
}

/**
 * The plugin steps of one runtime: marketplace add, then install. An add that fails (the marketplace may be there
 * already) is reported only when the install fails too.
 */
function installPlugin(runtime, runner) {
  const cli = runtime === "claude" ? "claude" : "codex";
  const add = runner(cli, ["plugin", "marketplace", "add", REPO], { timeout: STEP_MS });
  const verb = runtime === "claude" ? "install" : "add";
  const inst = runner(cli, ["plugin", verb, ID], { timeout: STEP_MS });
  if (inst.ok) return [{ step: "marketplace add", ok: true }, { step: `plugin ${verb}`, ok: true }];
  return [{ step: "marketplace add", ok: add.ok, why: add.why }, { step: `plugin ${verb}`, ok: false, why: inst.why }];
}

/** pip install playwright with this Python, or in a virtual environment when pip refuses the system Python. */
function installPlaywright(py, env, runner) {
  const [cmd, ...pre] = py.cmd;
  const pip = runner(cmd, [...pre, "-m", "pip", "install", "playwright"], { timeout: STEP_MS });
  if (pip.ok) return { ok: true, py: py.cmd };
  if (!/externally.managed|No module named pip/i.test(pip.out)) return { ok: false, why: pip.why };
  const venv = runner(cmd, [...pre, "-m", "venv", join(cacheHome(env), "venv")], { timeout: STEP_MS });
  if (!venv.ok) return { ok: false, why: `${pip.why}. 가상 환경도 만들지 못함: ${venv.why}` };
  const inVenv = runner(venvPython(env), ["-m", "pip", "install", "playwright"], { timeout: STEP_MS });
  return inVenv.ok ? { ok: true, py: [venvPython(env)] } : { ok: false, why: inVenv.why };
}

/** The Python steps: Playwright, then Chromium. */
function installBrowser(env, runner) {
  let py = pickPython(env, runner);
  if (!py) return [{ step: "python", ok: false, why: "Python 3 을 찾지 못함(python3, python, Windows 는 py)" }];
  const steps = [];
  let cmd = py.cmd;
  if (!py.playwright) {
    const pw = installPlaywright(py, env, runner);
    steps.push({ step: "pip install playwright", ok: pw.ok, why: pw.why ?? null });
    if (!pw.ok) return steps;
    cmd = pw.py;
  }
  if (!py.chromium) {
    const [c, ...pre] = cmd;
    const ch = runner(c, [...pre, "-m", "playwright", "install", "chromium"], { timeout: STEP_MS });
    steps.push({ step: "playwright install chromium", ok: ch.ok, why: ch.why });
  }
  return steps;
}

/** setup: the missing steps in order, stopping at the first that fails; then status. */
export function setup(runtime, { env = process.env, runner = run } = {}) {
  const before = status(runtime, { env, runner });
  const steps = [];
  if (!before.skillFile) steps.push(...installPlugin(runtime, runner));
  if (steps.every((s) => s.ok) && !(before.python?.playwright && before.python?.chromium)) steps.push(...installBrowser(env, runner));
  return { steps, ...status(runtime, { env, runner }) };
}

function parse(argv) {
  const [cmd, ...rest] = argv;
  const i = rest.indexOf("--runtime");
  const runtime = i >= 0 ? rest[i + 1] : undefined;
  if (!["status", "setup", "path"].includes(cmd)) return { error: USAGE };
  if (runtime !== "claude" && runtime !== "codex") return { error: `--runtime claude|codex 가 필요함\n${USAGE}` };
  return { cmd, runtime };
}

export function main(argv, out = console.log, err = console.error) {
  if (argv.includes("--help") || argv.includes("-h")) return out(USAGE), 0;
  const o = parse(argv);
  if (o.error) return err(o.error), 2;
  if (o.cmd === "path") {
    const f = o.runtime === "claude" ? claudeSkill() : codexSkill();
    if (!f) return err(`설치되지 않음: ${ID}. setup --runtime ${o.runtime} 로 설치`), 1;
    return out(f), 0;
  }
  const r = o.cmd === "setup" ? setup(o.runtime) : status(o.runtime);
  out(JSON.stringify(r, null, 2));
  return r.ready ? 0 : 1;
}

// Run directly (also through a linked path: both sides as real paths).
const realOf = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};
if (process.argv[1] && realOf(process.argv[1]) === realOf(fileURLToPath(import.meta.url))) process.exitCode = main(process.argv.slice(2));
