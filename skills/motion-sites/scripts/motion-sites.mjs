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
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The folder programs start in: the home folder (Windows looks for a program in the working folder first, so a
// program planted in the folder worked on never runs), or the temp folder when there is no home folder.
const runDir = () => (existsSync(homedir()) ? homedir() : tmpdir());

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
 * Runs a program with fixed arguments: { ok, stdout, out (stdout and stderr), why }. Data (JSON, paths) is read from
 * stdout only, so a warning on stderr never spoils it. On Windows claude and codex are .cmd shims, which Node runs only
 * through a shell: they go as one command line (their arguments here are fixed words). Python gets no shell.
 */
export function run(cmd, args, { timeout = LOOK_MS, env = process.env } = {}) {
  const shim = WIN && (cmd === "claude" || cmd === "codex");
  // From the home folder: python -c and -m put the working folder first on the import path (a pip/ or playwright/ in
  // the project would run), and Windows looks for a program there first.
  const opts = { cwd: runDir(), encoding: "utf8", timeout, env, windowsHide: true, maxBuffer: 64 * 1024 * 1024 };
  const r = shim ? spawnSync([cmd, ...args].join(" "), { ...opts, shell: true }) : spawnSync(cmd, args, opts);
  const stdout = r.stdout ?? "";
  const out = `${stdout}${r.stderr ?? ""}`;
  if (r.error) return { ok: false, stdout, out, why: r.error.code === "ETIMEDOUT" ? `시간 초과(${timeout / 1000}초)` : `${cmd} 실행 실패(${r.error.code})` };
  return { ok: r.status === 0, stdout, out, why: r.status === 0 ? null : `${cmd} ${args.join(" ")} 종료 ${r.status}: ${lastLine(out)}` };
}

const PROXY_KEYS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"];
const PROBE = "const s=require('net').connect({host:process.argv[1],port:443,timeout:8000});s.on('connect',()=>process.exit(0));s.on('timeout',()=>process.exit(1));s.on('error',()=>process.exit(1))";

/**
 * Whether a web source answers on port 443 within 8 seconds: true, false, or null (not judged: behind a proxy a
 * direct look says nothing, so the step's own time limit decides).
 */
export function reachable(host, { env = process.env, runner = run } = {}) {
  if (PROXY_KEYS.some((k) => env[k])) return null;
  return runner(process.execPath, ["-e", PROBE, host], { timeout: 15000 }).ok;
}

const hostOf = (url, fallback) => {
  try {
    return new URL(url).hostname || fallback;
  } catch {
    return fallback;
  }
};

/** The hosts each install step downloads from, any one answering being enough (a mirror named in the environment first). */
export function sources(env = process.env) {
  return {
    plugin: ["github.com"],
    pip: [hostOf(env.PIP_INDEX_URL, "pypi.org")],
    chromium: env.PLAYWRIGHT_DOWNLOAD_HOST ? [hostOf(env.PLAYWRIGHT_DOWNLOAD_HOST, "cdn.playwright.dev")] : ["cdn.playwright.dev", "playwright.download.prss.microsoft.com"],
  };
}

const GIT_MIRROR = "^(https?\\..*proxy|url\\..*insteadof)$";

/**
 * Whether a step's tool is set to a mirror or a proxy in its own configuration, where a direct look at the public
 * host says nothing: git (http.proxy, url.<base>.insteadOf) for the plugin, pip config (index-url) for Playwright.
 */
export function mirrorSet(kind, { py = null, runner = run } = {}) {
  if (kind === "plugin") {
    const r = runner("git", ["config", "--get-regexp", GIT_MIRROR]);
    return r.ok && (r.stdout ?? "").trim() !== "";
  }
  if (kind === "pip" && py) {
    const [cmd, ...pre] = py;
    const r = runner(cmd, [...pre, "-m", "pip", "config", "list"]);
    return r.ok && /index-url/i.test(r.stdout ?? "");
  }
  return false;
}

// A failed step when none of its sources answers, or null when one answers (or it cannot be judged: a proxy, or a
// mirror set in the tool's own configuration).
function offline(step, kind, { env, runner, py = null }) {
  const hosts = sources(env)[kind];
  if (mirrorSet(kind, { py, runner })) return null;
  const seen = hosts.map((h) => reachable(h, { env, runner }));
  if (!seen.every((x) => x === false)) return null;
  return { step, ok: false, why: `오프라인이라 설치하지 않음(${hosts.join(", ")} 에 닿지 않음)` };
}

const lastLine = (text) => text.trim().split(/\r?\n/).filter(Boolean).pop() ?? "";

/** The cache folder for the virtual environment. */
export function cacheHome(env = process.env) {
  if (env.MOTION_SITES_HOME) return env.MOTION_SITES_HOME;
  const base = WIN ? env.LOCALAPPDATA || join(homedir(), "AppData", "Local") : join(homedir(), ".cache");
  return join(base, "banker", "motion-sites");
}

const venvPython = (env) => join(cacheHome(env), "venv", WIN ? "Scripts" : "bin", WIN ? "python.exe" : "python");

/** The plugin for Claude Code: { file (its SKILL.md, or null), disabled (installed but turned off) }. */
export function claudePlugin(runner = run) {
  const none = { file: null, disabled: false };
  const r = runner("claude", ["plugin", "list", "--json"]);
  if (!r.ok) return none;
  let list;
  try {
    list = JSON.parse(r.stdout);
  } catch {
    return none;
  }
  const p = Array.isArray(list) ? list.find((x) => x?.id === ID) : null;
  const file = p?.installPath ? join(p.installPath, "skills", PLUGIN, "SKILL.md") : null;
  if (!file || !existsSync(file)) return none;
  return p.enabled === false ? { file: null, disabled: true } : { file, disabled: false };
}

export const claudeSkill = (runner = run) => claudePlugin(runner).file;

/**
 * The plugin for Codex: { file, disabled }. Installed means its table in config.toml (the body runs to the next table
 * header, so an array value holding "[" does not cut it short) and a version in the cache; the newest version's
 * SKILL.md is the file. enabled = false is disabled.
 */
export function codexPlugin(env = process.env) {
  const none = { file: null, disabled: false };
  const home = env.CODEX_HOME || join(homedir(), ".codex");
  let toml = "";
  try {
    toml = readFileSync(join(home, "config.toml"), "utf8");
  } catch {
    return none;
  }
  const head = `[plugins."${ID}"]`.replace(/[.[\]"]/g, "\\$&");
  const table = new RegExp(`^${head}[ \\t]*\\r?\\n([\\s\\S]*?)(?=^[ \\t]*\\[|(?![\\s\\S]))`, "m").exec(toml);
  if (!table) return none;
  const dir = join(home, "plugins", "cache", MARKET, PLUGIN);
  let versions = [];
  try {
    versions = readdirSync(dir).sort(byVersion);
  } catch {
    return none;
  }
  const file = versions.map((v) => join(dir, v, "skills", PLUGIN, "SKILL.md")).reverse().find((f) => existsSync(f));
  if (!file) return none;
  return /^[ \t]*enabled[ \t]*=[ \t]*false\b/m.test(table[1]) ? { file: null, disabled: true } : { file, disabled: false };
}

export const codexSkill = (env = process.env) => codexPlugin(env).file;

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
  // a relative path is made absolute here, as programs start in the home folder
  if (env.MOTION_SITES_PYTHON) list.push([isAbsolute(env.MOTION_SITES_PYTHON) ? env.MOTION_SITES_PYTHON : resolve(env.MOTION_SITES_PYTHON)]);
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
  const bin = lastLine(v.stdout ?? "");
  const pw = runner(cmd, [...pre, "-c", "import playwright"]).ok;
  const exe = pw ? runner(cmd, [...pre, "-c", CHROMIUM]) : { ok: false, stdout: "" };
  const chrome = lastLine(exe.stdout ?? "");
  return { bin, cmd: py, playwright: pw, chromium: exe.ok && chrome !== "" && existsSync(chrome) };
}

/** The first Python with Playwright (and Chromium, when one has both), else the first that runs. */
export function pickPython(env = process.env, runner = run) {
  const seen = pythons(env).map((p) => lookPython(p, runner)).filter(Boolean);
  return seen.find((p) => p.playwright && p.chromium) ?? seen.find((p) => p.playwright) ?? seen[0] ?? null;
}

/** status: the plugin and the Python, and whether /motion-sites can hand over now. */
export function status(runtime, { env = process.env, runner = run } = {}) {
  const p = runtime === "claude" ? claudePlugin(runner) : codexPlugin(env);
  const py = pickPython(env, runner);
  const python = py ? { bin: py.bin, playwright: py.playwright, chromium: py.chromium } : null;
  return { runtime, plugin: ID, skillFile: p.file, disabled: p.disabled, python, ready: Boolean(p.file && py?.playwright && py?.chromium) };
}

/**
 * The plugin steps of one runtime: marketplace add, then install. An add that fails (the marketplace may be there
 * already) is reported only when the install fails too.
 */
function installPlugin(runtime, env, runner) {
  const down = offline("marketplace add", "plugin", { env, runner });
  if (down) return [down];
  const cli = runtime === "claude" ? "claude" : "codex";
  const add = runner(cli, ["plugin", "marketplace", "add", REPO], { timeout: STEP_MS });
  const verb = runtime === "claude" ? "install" : "add";
  const inst = runner(cli, ["plugin", verb, ID], { timeout: STEP_MS });
  if (inst.ok) return [{ step: "marketplace add", ok: true }, { step: `plugin ${verb}`, ok: true }];
  return [{ step: "marketplace add", ok: add.ok, why: add.why }, { step: `plugin ${verb}`, ok: false, why: inst.why }];
}

/** pip install playwright with this Python, or in a virtual environment when pip refuses the system Python. */
function installPlaywright(py, env, runner) {
  const down = offline("pip install playwright", "pip", { env, runner, py: py.cmd });
  if (down) return { ok: false, why: down.why };
  const [cmd, ...pre] = py.cmd;
  const pip = runner(cmd, [...pre, "-m", "pip", "install", "playwright"], { timeout: STEP_MS });
  if (pip.ok) return { ok: true, py: py.cmd };
  if (!/externally.managed|No module named pip/i.test(pip.out)) return { ok: false, why: pip.why };
  const venv = runner(cmd, [...pre, "-m", "venv", join(cacheHome(env), "venv")], { timeout: STEP_MS });
  if (!venv.ok) return { ok: false, why: `${pip.why}. 가상 환경도 만들지 못함: ${venv.why}` };
  const inVenv = runner(venvPython(env), ["-m", "pip", "install", "playwright"], { timeout: STEP_MS });
  return inVenv.ok ? { ok: true, py: [venvPython(env)] } : { ok: false, why: inVenv.why };
}

/** A plugin installed but turned off: Claude Code turns it on; Codex has no command for it, so it says where. */
function enablePlugin(runtime, runner) {
  if (runtime === "codex") return { step: "plugin enable", ok: false, why: `Codex 설정에서 꺼져 있음: config.toml 의 [plugins."${ID}"] 를 enabled = true 로` };
  const r = runner("claude", ["plugin", "enable", ID]);
  return { step: "plugin enable", ok: r.ok, why: r.why };
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
    const down = offline("playwright install chromium", "chromium", { env, runner });
    if (down) return [...steps, down];
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
  if (before.disabled) steps.push(enablePlugin(runtime, runner));
  else if (!before.skillFile) steps.push(...installPlugin(runtime, env, runner));
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
