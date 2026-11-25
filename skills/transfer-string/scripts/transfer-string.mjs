#!/usr/bin/env node
/**
 * transfer-string.mjs - finds a Python 3.7 or later and runs transfer_string.py (next to this file) with -I, in the
 * caller's folder, with the caller's arguments. The /banker:transfer-string skill and the compress-string,
 * decompress-string commands (bin/) all come through here, so one Python choice serves all three.
 *
 *   node transfer-string.mjs compress   <file> [--hangul] [--no-clipboard]
 *   node transfer-string.mjs compress   --clipboard [--hangul] [--no-clipboard]
 *   node transfer-string.mjs decompress <file> | --clipboard
 *
 * Which Python: TRANSFER_STRING_PYTHON when it is set (only that one, and only an absolute path: a bare name or a
 * relative path would be the working folder's file), else the names found in PATH's absolute folders (POSIX:
 * python3, python3.14 ... python3.7, python; Windows: py -3, python3, python), then the usual install folders off
 * PATH (python.org, uv, Miniconda, Anaconda, Homebrew). Every candidate is an absolute path before it runs, so a
 * python planted in the working folder is never started (Windows looks there first for a bare name). On macOS a
 * /usr/bin python is tried only when the Command Line Tools are there: without them it opens an install dialog.
 * Each is asked for its version and sys.executable from the home folder; the script then runs on that absolute
 * sys.executable with -I, which keeps the user site, PYTHON* variables and the script's and working folder off the
 * import path.
 *
 * Exit: the script's own (0 done; 1 no string, damaged or cut; 2 usage or input; 3 write; 4 internal error), 4 too
 * when Python is killed by a signal (E_SIGNAL: memory, not the string), or 9 when no Python 3.7 or later runs
 * (E_PYTHON). Errors are "[transfer-string] 오류: ..." and "TSTR_ERROR code=..." on stderr. Node standard modules only.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
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

/** name in PATH's absolute folders (with .exe on Windows), or null. A relative or empty entry is skipped. */
export function which(name, env = process.env) {
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  for (const d of String(env[key] ?? "").split(delimiter)) {
    if (!d || !isAbsolute(d)) continue;
    const p = join(d, WIN ? `${name}.exe` : name);
    try {
      if (statSync(p).isFile()) return p;
    } catch {
      // not here (a Microsoft Store alias cannot be stat-ed either; py or an install folder finds the real one)
    }
  }
  return null;
}

/** macOS: whether /usr/bin/python3 is a real Python (Command Line Tools) and not the stub that opens a dialog. */
function appleToolsReady() {
  const r = spawnSync("/usr/bin/xcode-select", ["-p"], { cwd: runDir(), stdio: "ignore", timeout: PROBE_MS });
  return !r.error && r.status === 0;
}

/** The Pythons to try, in order: [absolute command, ...leading arguments]. */
export function pythons(env = process.env, { darwin = process.platform === "darwin" } = {}) {
  const named = env.TRANSFER_STRING_PYTHON;
  if (named) return isAbsolute(named) ? [[named]] : [];
  const names = WIN
    ? [["py", "-3"], ["python3"], ["python"]]
    : [["python3"], ...[14, 13, 12, 11, 10, 9, 8, 7].map((v) => [`python3.${v}`]), ["python"]];
  let apple;
  const list = [];
  for (const [name, ...pre] of names) {
    const p = which(name, env);
    if (!p) continue;
    if (darwin && p.startsWith("/usr/bin/") && !(apple ??= appleToolsReady())) continue;
    list.push([p, ...pre]);
  }
  const seen = new Set(list.map((c) => c.join("\0")));
  return [...list, ...installDirs(env).filter((p) => !seen.has(p)).map((p) => [p])];
}

/** What one Python is: { exe } (absolute, 3.7 or later) or null. */
export function probe([cmd, ...pre], env = process.env) {
  if (!isAbsolute(cmd) || !existsSync(cmd)) return null;
  const r = spawnSync(cmd, [...pre, "-I", "-c", PROBE], {
    cwd: runDir(), encoding: "utf8", env, timeout: PROBE_MS, windowsHide: true,
  });
  if (r.error || r.status !== 0) return null;
  const exe = (r.stdout || "").trim().split(/\r?\n/).pop();
  return exe && isAbsolute(exe) && existsSync(exe) ? { exe } : null;
}

/** The first Python 3.7 or later, or null. */
export function findPython(env = process.env) {
  for (const p of pythons(env)) {
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
    : "Python 3.7 이상을 찾지 못했습니다(PATH 의 python3, python, Windows 의 py). PATH 밖에 설치했으면 환경 변수 TRANSFER_STRING_PYTHON 에 그 python 실행 파일의 절대 경로를 지정한 뒤 다시 실행하십시오.";
  process.stderr.write(`[transfer-string] 오류: ${why}\nTSTR_ERROR code=E_PYTHON\n`);
  return EXIT_NO_PYTHON;
}

/** Runs transfer_string.py with op and args in the caller's folder; returns the exit code. */
export function run(op, args, env = process.env) {
  const py = findPython(env);
  if (!py) return noPython(env);
  const r = spawnSync(py.exe, ["-I", SCRIPT, op, ...args], { stdio: "inherit", env, windowsHide: true });
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
