#!/usr/bin/env node
// Screenshots for /banker:ultra-chain's visual review. Renders each target (a local HTML file or an http(s)
// URL) in headless Chromium and writes <out>/<name>.png, so the mock and the real result are captured the
// same way on Claude Code and Codex. Playwright comes from the global npm root; a project's own node_modules
// only with --playwright-from-project, because loading it runs that project's code. A bare import is not used:
// it would climb from this script's folder into a project that installed banker inside itself.
// URLs are loopback-only (localhost, 127.0.0.1, [::1]) unless --allow-remote; network paths (\\host, //host)
// are refused.
//
//   node capture.mjs --out <folder> [--viewport 1280x800] [--full] [--wait <ms>] [--playwright-from-project]
//                    [--allow-remote] <name>=<file or URL>...
//   node capture.mjs --check [--playwright-from-project]     Playwright and Chromium start, nothing captured
//
// Prints one JSON line: [{ name, target, png, ok, error? }] (with --check: { playwright: true, browser: true }).
// Exit 0 all written, 1 a target failed, 2 usage, 3 Playwright or its browser is missing.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export class UsageError extends Error {}
export class NoBrowserError extends Error {}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const VIEWPORT = /^(\d{2,5})x(\d{2,5})$/;

function viewportOf(v) {
  const m = VIEWPORT.exec(String(v));
  const [w, h] = m ? [Number(m[1]), Number(m[2])] : [0, 0];
  if (!(w >= 100 && w <= 10000 && h >= 100 && h <= 10000)) throw new UsageError(`--viewport 는 <폭>x<높이>, 각 100~10000 입니다(예: 1280x800): ${v}`);
  return { width: w, height: h };
}

// <name>=<target>. The name becomes <name>.png, so it may not hold a path separator.
function targetOf(arg) {
  const at = arg.indexOf("=");
  const name = at > 0 ? arg.slice(0, at) : "";
  if (!NAME.test(name)) throw new UsageError(`대상은 <이름>=<파일 또는 URL> 이고 이름은 영문, 숫자, ., _, - 입니다: ${arg}`);
  return { name, target: arg.slice(at + 1) };
}

const FLAGS = {
  "--out": (o, v) => { o.out = v; },
  "--viewport": (o, v) => { o.viewport = viewportOf(v); },
  "--wait": (o, v) => {
    o.wait = Number(v);
    if (!Number.isInteger(o.wait) || o.wait < 0 || o.wait > 60000) throw new UsageError("--wait 은 0~60000 ms 입니다");
  },
};

const SWITCHES = { "--full": "full", "--check": "check", "--playwright-from-project": "fromProject", "--allow-remote": "allowRemote" };

function readArgs(argv) {
  const o = { out: null, viewport: { width: 1280, height: 800 }, full: false, wait: 300, fromProject: false, check: false, allowRemote: false, targets: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (SWITCHES[a]) o[SWITCHES[a]] = true;
    else if (FLAGS[a]) {
      if (argv[i + 1] === undefined) throw new UsageError(`${a} 뒤에 값이 필요합니다`);
      FLAGS[a](o, argv[++i]);
    } else if (a.startsWith("--")) throw new UsageError(`모르는 옵션 ${a}`);
    else o.targets.push(targetOf(a));
  }
  return o;
}

function validate(o) {
  if (o.check) {
    if (o.targets.length || o.out) throw new UsageError("--check 는 --out 과 대상 없이 씁니다");
    return o;
  }
  if (!o.out) throw new UsageError("--out <폴더> 가 필요합니다");
  if (!o.targets.length) throw new UsageError("찍을 대상이 없습니다");
  if (new Set(o.targets.map((t) => t.name)).size !== o.targets.length) throw new UsageError("같은 이름의 대상이 둘 이상입니다");
  return o;
}

export const parseArgs = (argv) => validate(readArgs(argv));

// An http(s) URL as given, or an existing local file as a file:// URL. Nothing else (no javascript:, data:).
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function httpUrl(target, allowRemote) {
  let url;
  try {
    url = new URL(target);
  } catch {
    throw new UsageError(`URL 이 아닙니다: ${target}`);
  }
  if (!allowRemote && !LOOPBACK_HOSTS.has(url.hostname)) throw new UsageError(`loopback 이 아닌 주소는 --allow-remote 를 줄 때만 찍습니다: ${target}`);
  return url.href;
}

export function toUrl(target, cwd = process.cwd(), allowRemote = false) {
  if (/^https?:\/\//i.test(target)) return httpUrl(target, allowRemote);
  if (/^[\\/]{2}/.test(target)) throw new UsageError(`네트워크 경로는 찍지 않습니다: ${target}`);
  if (/^[A-Za-z][A-Za-z0-9+.-]+:/.test(target) && !/^[A-Za-z]:[\\/]/.test(target)) {
    throw new UsageError(`http, https URL 이나 로컬 파일만 찍습니다: ${target}`);
  }
  const file = resolve(cwd, target);
  if (!existsSync(file) || !statSync(file).isFile()) throw new UsageError(`파일이 없습니다: ${file}`);
  return pathToFileURL(file).href;
}

// ── Playwright (same rule as 3d-intro-build/references/verify-intro.mjs) ──────

function resolveFrom(base) {
  try { return createRequire(join(base, "noop.js")).resolve("playwright"); } catch { return null; }
}

// npm's global root, asked from the home folder: from the project, cmd.exe on Windows would take an
// npm.cmd from that folder first. On Windows the command goes as one string (no argument list with
// shell: true, which Node 24 deprecates).
function globalRoot() {
  const opts = { encoding: "utf8", cwd: homedir() };
  const r = process.platform === "win32" ? spawnSync("npm.cmd root -g", { ...opts, shell: true }) : spawnSync("npm", ["root", "-g"], opts);
  return String(r.stdout || "").trim();
}

// A broken install reads as missing Playwright (exit 3), not as a failed capture.
async function importPlaywright(entry) {
  try {
    const mod = await import(pathToFileURL(entry).href);
    return mod.chromium ? mod : mod.default;
  } catch (e) {
    throw new NoBrowserError(`playwright 패키지를 불러오지 못했습니다(${entry}): ${String(e.message || e).split("\n")[0]}`);
  }
}

export async function loadPlaywright({ fromProject = false } = {}) {
  const fromHere = fromProject ? resolveFrom(process.cwd()) : null;
  const root = fromHere ? null : globalRoot();
  const entry = fromHere || (root && resolveFrom(root));
  if (entry) return importPlaywright(entry);
  throw new NoBrowserError("playwright 패키지가 없습니다. setup-playwright 스킬로 설치하거나 `npm i -g playwright && npx playwright install chromium` 을 실행하십시오.");
}

async function launch(load, fromProject) {
  const pw = await load({ fromProject });
  try {
    return await pw.chromium.launch();
  } catch (e) {
    throw new NoBrowserError(`Chromium 을 띄우지 못했습니다(브라우저 미설치일 수 있음: npx playwright install chromium): ${String(e.message || e).split("\n")[0]}`);
  }
}

async function shoot(browser, o, t) {
  const png = join(o.out, `${t.name}.png`);
  const page = await browser.newPage({ viewport: o.viewport });
  try {
    await page.goto(t.url, { waitUntil: "load", timeout: 30000 });
    if (o.wait) await page.waitForTimeout(o.wait);
    await page.screenshot({ path: png, fullPage: o.full });
    return { name: t.name, target: t.target, png, ok: true };
  } catch (e) {
    return { name: t.name, target: t.target, png, ok: false, error: String(e.message || e).split("\n")[0] };
  } finally {
    await page.close();
  }
}

export async function capture(o, load = loadPlaywright) {
  const targets = o.targets.map((t) => ({ ...t, url: toUrl(t.target, process.cwd(), o.allowRemote) }));
  mkdirSync(o.out, { recursive: true });
  const browser = await launch(load, o.fromProject);
  try {
    const results = [];
    for (const t of targets) results.push(await shoot(browser, o, t));
    return results;
  } finally {
    await browser.close();
  }
}

// Playwright loads and Chromium starts and closes: the check 0. preflight runs on every OS.
async function check(o, load) {
  const browser = await launch(load, o.fromProject);
  await browser.close();
  return { playwright: true, browser: true };
}

export async function main(argv, out = process.stdout, err = process.stderr, load = loadPlaywright) {
  try {
    const o = parseArgs(argv);
    if (o.check) {
      out.write(`${JSON.stringify(await check(o, load))}\n`);
      return 0;
    }
    const results = await capture(o, load);
    out.write(`${JSON.stringify(results)}\n`);
    return results.every((r) => r.ok) ? 0 : 1;
  } catch (e) {
    err.write(`capture: ${e.message}\n`);
    if (e instanceof UsageError) return 2;
    return e instanceof NoBrowserError ? 3 : 1;
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

if (invokedDirectly()) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
