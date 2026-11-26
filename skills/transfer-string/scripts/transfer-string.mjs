#!/usr/bin/env node
/**
 * transfer-string.mjs - finds a Python 3.7 or later and runs transfer_string.py (next to this file) with -I, in the
 * caller's folder, with the caller's arguments. The /banker:transfer-string skill and the compress-string,
 * decompress-string commands (bin/) all come through here, so one Python choice serves all three.
 *
 *   node transfer-string.mjs compress   <file> [--hangul] [--no-clipboard]
 *   node transfer-string.mjs compress   --clipboard [--hangul] [--no-clipboard]
 *   node transfer-string.mjs decompress <file> | --clipboard [--keep-name]
 *
 * Which Python: TRANSFER_STRING_PYTHON when it is set (only that one, and only an absolute path: a bare name or a
 * relative path would be the working folder's file), else the names found in PATH's absolute folders (POSIX:
 * python3, python3.14 ... python3.7, python; Windows: py -3, python3, python), then the usual install folders off
 * PATH (python.org, uv, Miniconda, Anaconda, Homebrew). Every candidate is an absolute path before it runs, so a
 * python planted in the working folder is never started (Windows looks there first for a bare name). On macOS a
 * /usr/bin python is tried only when the Command Line Tools are there: without them it opens an install dialog.
 * Every match in PATH is a candidate, not only the first. On Windows the Microsoft Store Python's python3.exe in
 * WindowsApps is an App Execution Alias that stat cannot open (lstat can): aliases are taken, but after every regular
 * file (PATH's and the install folders'), so with a real install no alias runs; the App Installer stub of the same
 * name fails the probe (exit 9009). Python install manager's (PyManager's) py, python and python3 are never run, since
 * with no runtime they download and install one: the runtimes its local list names take their place.
 * Each is asked for its version and sys.executable from the home folder; the script then runs on that absolute
 * sys.executable with -I, which keeps the user site, PYTHON* variables and the script's and working folder off the
 * import path.
 *
 * Exit: the script's own (0 done; 1 no string, damaged or cut; 2 usage or input; 3 write; 4 internal error), 4 too
 * when Python is killed by a signal (E_SIGNAL: memory, not the string), or 9 when no Python 3.7 or later runs
 * (E_PYTHON). Errors are "[transfer-string] 오류: ..." and "TSTR_ERROR code=..." on stderr. Node standard modules only.
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve, win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const WIN = process.platform === "win32";
const HERE = dirname(fileURLToPath(import.meta.url));
export const SCRIPT = join(HERE, "transfer_string.py");
export const EXIT_NO_PYTHON = 9;
export const EXIT_INTERNAL = 4;
const PROBE = "import sys;print(sys.executable);sys.exit(0 if sys.version_info >= (3, 7) else 3)";
const PROBE_MS = 15000;
const runDir = () => (existsSync(homedir()) ? homedir() : tmpdir());

/** Folder entries matching re, the highest version number first (python3.13 before python3.9). */
function byVersion(base, re) {
  const ver = (d) => (d.match(/\d+/g) || []).map(Number);
  try {
    return readdirSync(base)
      .filter((d) => re.test(d))
      .sort((a, b) => {
        const x = ver(a), y = ver(b);
        for (let k = 0; k < Math.max(x.length, y.length); k++) if ((y[k] ?? -1) !== (x[k] ?? -1)) return (y[k] ?? -1) - (x[k] ?? -1);
        return 0;
      })
      .map((d) => join(base, d));
  } catch {
    return [];
  }
}

/** Python install folders off PATH: python(.exe) itself, the newest version first. */
function installDirs(env) {
  const home = homedir();
  if (WIN) {
    const local = env.LOCALAPPDATA || join(home, "AppData", "Local");
    return [
      ...byVersion(join(local, "Programs", "Python"), /^Python3\d+$/i).map((d) => join(d, "python.exe")),
      ...byVersion(join(home, ".local", "bin"), /^python3\.\d+\.exe$/i),
      ...["miniconda3", "anaconda3", "Miniconda3", "Anaconda3"].map((d) => join(home, d, "python.exe")),
    ];
  }
  return [
    "/opt/homebrew/bin/python3",
    "/usr/local/bin/python3",
    ...byVersion("/Library/Frameworks/Python.framework/Versions", /^3\.\d+$/).map((d) => join(d, "bin", "python3")),
    ...byVersion(join(home, ".local", "bin"), /^python3\.\d+$/),
    ...["miniconda3", "anaconda3"].map((d) => join(home, d, "bin", "python3")),
  ];
}

// The stat errors of a Windows App Execution Alias (the Microsoft Store Python's python3.exe in WindowsApps): a
// reparse point stat cannot open while lstat can. ENOENT (not there, or a broken link) is not one of them.
const ALIAS_ERRORS = new Set(["EACCES", "EPERM", "UNKNOWN"]);

/** What p is to run: "file" (a regular file), "alias" (on Windows an App Execution Alias: stat fails with an access
 * error and lstat shows a file or a link, never a folder) or null. A junction or folder link to a folder that can be
 * reached stats as a folder, so it is null too. */
export function fileKind(p, { stat = statSync, lstat = lstatSync, win = WIN } = {}) {
  try {
    return stat(p).isFile() ? "file" : null;
  } catch (e) {
    if (!win || !ALIAS_ERRORS.has(e && e.code)) return null;
    try {
      const l = lstat(p);
      return !l.isDirectory() && (l.isFile() || l.isSymbolicLink()) ? "alias" : null;
    } catch {
      return null;
    }
  }
}

/** Whether p is a file to run (fileKind is not null). The probe then tells a real Python from the App Installer stub,
 * which exits 9009. */
export const runnable = (p, opts) => fileKind(p, opts) !== null;

/** Every match of name in PATH's absolute folders (with .exe on Windows): [{ path, kind }]. A relative or empty entry
 * is skipped. opts: fileKind's (stat, lstat, win), for tests. */
export function whichAll(name, env = process.env, opts = {}) {
  const win = opts.win ?? WIN;
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const out = [];
  for (const d of String(env[key] ?? "").split(delimiter)) {
    if (!d || !isAbsolute(d)) continue;
    const p = join(d, win ? `${name}.exe` : name);
    const kind = fileKind(p, opts);
    if (kind) out.push({ path: p, kind });
  }
  return out;
}

/** name in PATH: the first regular file, else the first alias, or null. */
export function which(name, env = process.env, opts = {}) {
  const all = whichAll(name, env, opts);
  return (all.find((m) => m.kind === "file") ?? all[0])?.path ?? null;
}

/** macOS: whether /usr/bin/python3 is a real Python (Command Line Tools) and not the stub that opens a dialog. */
function appleToolsReady() {
  const r = spawnSync("/usr/bin/xcode-select", ["-p"], { cwd: runDir(), stdio: "ignore", timeout: PROBE_MS });
  return !r.error && r.status === 0;
}

// Python install manager (PyManager): its py, python and python3 launchers install the latest Python from the network
// when they run with no runtime yet (measured: about 3 to 9 s, then Python 3.15 in %LOCALAPPDATA%\Python). So a
// launcher is never run here: its runtimes (regular python.exe files) take its place, from its own local list, and
// with no runtime it is left out. Its settings, last one wins (PyManager src/manage/config.py, measured on 26.4): the
// variable PYTHON_MANAGER_AUTOMATIC_INSTALL, the user file %AppData%\Python\PyManager.json, the file that
// PYTHON_MANAGER_CONFIG names, then the policy key HKLM\Software\Policies\Python\PyManager; so the variables below
// beat the user file, not the policy. They stay as a second guard for a launcher not recognised as PyManager's.
const PYMANAGER_PKG = /^PythonSoftwareFoundation\.PythonManager_/i;
const PYMANAGER_LIST = ["list", "-f=exe", "-q"]; // local: list never installs or downloads, whatever the settings
const PROBE_ENV = {
  PYTHON_MANAGER_AUTOMATIC_INSTALL: "false",
  PYTHON_MANAGER_CONFIG: join(HERE, "pymanager-no-install.json"),
};

/** Whether p (of kind) is PyManager's: an App Execution Alias that points into its package, or (its MSI install) a
 * regular file with a regular pymanager.exe beside it. opts: readlink, and fileKind's. */
export function isPyManager(p, kind, { readlink = readlinkSync, ...opts } = {}) {
  if (kind === "alias") {
    try {
      return PYMANAGER_PKG.test(win32.basename(win32.dirname(readlink(p)))); // a Windows path on any OS (tests)
    } catch {
      return false;
    }
  }
  return kind === "file" && fileKind(join(dirname(p), "pymanager.exe"), opts) === "file";
}

/** The runtimes PyManager p lists, as regular python.exe files: [] with none (or when its pymanager.exe beside it is
 * not PyManager's too). opts: spawn, and isPyManager's. */
export function pyManagerRuntimes(p, env = process.env, { spawn = spawnSync, ...opts } = {}) {
  const mgr = join(dirname(p), "pymanager.exe");
  if (!isPyManager(mgr, fileKind(mgr, opts), opts)) return [];
  const r = spawn(mgr, PYMANAGER_LIST, { cwd: runDir(), encoding: "utf8", env: quietEnv(env), timeout: PROBE_MS, windowsHide: true });
  if (r.error || r.status !== 0) return [];
  return String(r.stdout || "").split(/\r?\n/).map((l) => l.trim()).filter((l) => isAbsolute(l) && fileKind(l, opts) === "file");
}

/** One PATH match as candidates: a PyManager launcher becomes its runtimes, anything else itself. */
function expand(p, kind, pre, env, opts, lists) {
  if (!(opts.win ?? WIN) || !isPyManager(p, kind, opts)) return [[p, ...pre]];
  const mgr = join(dirname(p), "pymanager.exe").toLowerCase();
  if (!lists.has(mgr)) lists.set(mgr, pyManagerRuntimes(p, env, opts));
  return lists.get(mgr).map((x) => [x]);
}

/** The Pythons to try, in order: [absolute command, ...leading arguments]. Every match in PATH counts (an App Installer
 * stub early in PATH must not hide a real Python later in it). Regular files come first (PATH's, then the install
 * folders), Windows aliases last: with a real install there, no alias is run at all. A PyManager launcher is replaced
 * by its runtimes (see above), TRANSFER_STRING_PYTHON too. opts: darwin, and expand's (fileKind's, readlink, spawn). */
export function pythons(env = process.env, { darwin = process.platform === "darwin", ...opts } = {}) {
  const lists = new Map();
  const named = env.TRANSFER_STRING_PYTHON;
  if (named) return isAbsolute(named) ? expand(named, fileKind(named, opts), [], env, opts, lists) : [];
  const win = opts.win ?? WIN;
  const names = win
    ? [["py", "-3"], ["python3"], ["python"]]
    : [["python3"], ...[14, 13, 12, 11, 10, 9, 8, 7].map((v) => [`python3.${v}`]), ["python"]];
  let apple;
  const files = [];
  const aliases = [];
  for (const [name, ...pre] of names) {
    for (const { path: p, kind } of whichAll(name, env, opts)) {
      if (darwin && p.startsWith("/usr/bin/") && !(apple ??= appleToolsReady())) continue;
      (kind === "alias" ? aliases : files).push(...expand(p, kind, pre, env, opts, lists));
    }
  }
  const seen = new Set();
  const key = (c) => (win ? c.join("\0").toLowerCase() : c.join("\0"));
  return [...files, ...installDirs(env).map((p) => [p]), ...aliases].filter((c) => !seen.has(key(c)) && seen.add(key(c)));
}

/** env with PROBE_ENV's keys set, any spelling of them removed first (Windows names are case-insensitive, so a
 * python_manager_automatic_install=true left in would make two keys, and either could win). Used for the probe, the
 * run and PyManager's list alike, so nothing started here installs anything. */
export function quietEnv(env = process.env) {
  const drop = new Set(Object.keys(PROBE_ENV).map((k) => k.toUpperCase()));
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!drop.has(k.toUpperCase())) out[k] = v;
  return { ...out, ...PROBE_ENV };
}

/** What one Python is: { exe } (absolute, 3.7 or later) or null. */
export function probe([cmd, ...pre], env = process.env) {
  if (!isAbsolute(cmd) || !runnable(cmd)) return null;
  const r = spawnSync(cmd, [...pre, "-I", "-c", PROBE], {
    cwd: runDir(), encoding: "utf8", env: quietEnv(env), timeout: PROBE_MS, windowsHide: true,
  });
  if (r.error || r.status !== 0) return null;
  const exe = (r.stdout || "").trim().split(/\r?\n/).pop();
  return exe && isAbsolute(exe) && runnable(exe) ? { exe } : null; // the Store Python's sys.executable is an alias too
}

/** The first Python 3.7 or later, or null. opts: pythons'. */
export function findPython(env = process.env, opts = {}) {
  for (const p of pythons(env, opts)) {
    const found = probe(p, env);
    if (found) return found;
  }
  return null;
}

function noPython(env) {
  const named = env.TRANSFER_STRING_PYTHON;
  const why = named && !isAbsolute(named)
    ? `TRANSFER_STRING_PYTHON 의 ${named} 는 절대경로가 아닙니다. 지금 폴더의 파일을 실행하지 않도록 python 실행 파일의 절대경로만 받습니다.`
    : named
    ? `TRANSFER_STRING_PYTHON 에 지정한 ${named} 가 Python 3.7 이상으로 실행되지 않습니다. 경로를 고친 뒤 다시 실행하십시오.`
    : "Python 3.7 이상을 찾지 못했습니다(PATH 의 python3, python, Windows 의 py 와 Microsoft Store 판). PATH 밖에 설치했으면 환경 변수 TRANSFER_STRING_PYTHON 에 그 python 실행 파일의 절대 경로를 지정한 뒤 다시 실행하십시오.";
  process.stderr.write(`[transfer-string] 오류: ${why}\nTSTR_ERROR code=E_PYTHON\n`);
  return EXIT_NO_PYTHON;
}

/** Runs transfer_string.py with op and args in the caller's folder; returns the exit code. */
export function run(op, args, env = process.env) {
  const py = findPython(env);
  if (!py) return noPython(env);
  const r = spawnSync(py.exe, ["-I", SCRIPT, op, ...args], { stdio: "inherit", env: quietEnv(env), windowsHide: true });
  if (r.error) {
    process.stderr.write(`[transfer-string] 오류: ${py.exe} 를 실행하지 못했습니다 (${r.error.code || r.error.message}).\nTSTR_ERROR code=E_PYTHON\n`);
    return EXIT_NO_PYTHON;
  }
  if (r.status === null) {
    process.stderr.write(`[transfer-string] 오류: Python 이 신호 ${r.signal} 로 끝났습니다(메모리 부족이나 강제 종료). 문자열 문제가 아닙니다.\nTSTR_ERROR code=E_SIGNAL\n`);
    return EXIT_INTERNAL;
  }
  return r.status;
}

const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(real(process.argv[1])).href) {
  const [op = "", ...rest] = process.argv.slice(2);
  process.exitCode = run(op, rest);
}
