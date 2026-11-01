// Argument parsing for build-testbox (detect, run, setup). A bad argument throws UsageError (exit 2).
import { existsSync, statSync } from "node:fs";
import { cpus } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export class UsageError extends Error {}

export const BROWSERS = ["chromium", "webkit"];
export const DEFAULT_IMAGES = { rocky8: "docker.io/rockylinux/rockylinux:8", rocky9: "docker.io/rockylinux/rockylinux:9" };
const OS_NAME = /^[a-z][a-z0-9-]{0,30}$/;
const IMAGE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/;
const VM_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

const list = (v) => String(v).split(",").map((s) => s.trim()).filter(Boolean);

function intIn(flag, v, lo, hi) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) throw new UsageError(`${flag} 는 ${lo}~${hi} 정수입니다: ${v}`);
  return n;
}

function oneOf(flag, v, allowed) {
  if (!allowed.includes(v)) throw new UsageError(`${flag} 는 ${allowed.join(", ")} 중 하나입니다: ${v}`);
  return v;
}

function browsersOf(v) {
  const names = list(v);
  for (const n of names) oneOf("--browsers", n, BROWSERS);
  if (!names.length) throw new UsageError("--browsers 가 비었습니다");
  return [...new Set(names)];
}

function osOf(v) {
  if (v === "none") return [];
  const names = list(v);
  for (const n of names) if (!OS_NAME.test(n)) throw new UsageError(`--os 이름은 영문 소문자, 숫자, - 입니다: ${n}`);
  if (!names.length) throw new UsageError("--os 가 비었습니다(컨테이너 묶음을 빼려면 --os none)");
  return [...new Set(names)];
}

function imageOf(o, v) {
  const at = String(v).indexOf("=");
  const name = at > 0 ? v.slice(0, at) : "";
  const image = at > 0 ? v.slice(at + 1) : "";
  if (!OS_NAME.test(name) || !IMAGE.test(image)) throw new UsageError(`--image 는 <os>=<이미지> 입니다: ${v}`);
  o.images[name] = image;
}

function devicesOf(v) {
  const names = list(v);
  if (!names.length) throw new UsageError("--devices 가 비었습니다");
  if (new Set(names).size !== names.length) throw new UsageError("--devices 에 같은 기기가 둘 이상입니다");
  return names;
}

function httpUrl(target, allowRemote) {
  let url;
  try { url = new URL(target); } catch { throw new UsageError(`URL 이 아닙니다: ${target}`); }
  if (!allowRemote && !LOOPBACK.has(url.hostname)) throw new UsageError(`loopback 이 아닌 주소는 --allow-remote 를 줄 때만 엽니다: ${target}`);
  return url.href;
}

// --url: an http(s) URL (loopback unless --allow-remote) or an existing local file.
export function toUrl(target, allowRemote = false, cwd = process.cwd()) {
  if (/^https?:\/\//i.test(target)) return httpUrl(target, allowRemote);
  if (/^[\\/]{2}/.test(target)) throw new UsageError(`네트워크 경로는 열지 않습니다: ${target}`);
  if (/^[A-Za-z][A-Za-z0-9+.-]+:/.test(target) && !/^[A-Za-z]:[\\/]/.test(target)) throw new UsageError(`http, https URL 이나 로컬 파일만 엽니다: ${target}`);
  const file = resolve(cwd, target);
  if (!existsSync(file) || !statSync(file).isFile()) throw new UsageError(`파일이 없습니다: ${file}`);
  return pathToFileURL(file).href;
}

const VALUES = {
  "--url": (o, v) => { o.urlArg = v; },
  "--browsers": (o, v) => { o.browsers = browsersOf(v); o.browsersGiven = true; },
  "--devices": (o, v) => { o.devices = devicesOf(v); },
  "--os": (o, v) => { o.os = osOf(v); },
  "--image": imageOf,
  "--cmd": (o, v) => { if (!String(v).trim()) throw new UsageError("--cmd 가 비었습니다"); o.cmd = v; },
  "--src": (o, v) => { o.src = resolve(v); },
  "--engine": (o, v) => { o.engine = oneOf("--engine", v, ["auto", "docker", "podman"]); },
  "--network": (o, v) => { o.network = oneOf("--network", v, ["bridge", "none", "host"]); },
  "--jobs": (o, v) => { o.jobs = intIn("--jobs", v, 1, 64); },
  "--timeout": (o, v) => { o.timeout = intIn("--timeout", v, 1, 86400); },
  "--out": (o, v) => { o.out = resolve(v); },
  "--tart-vm": (o, v) => { if (!VM_NAME.test(v)) throw new UsageError(`--tart-vm 이름이 맞지 않습니다: ${v}`); o.tartVm = v; },
  "--images": (o, v) => { o.setupImages = osOf(v); },
  "--playwright-dir": (o, v) => { if (!String(v).trim()) throw new UsageError("--playwright-dir 가 비었습니다"); o.playwrightDir = resolve(v); },
};

const SWITCHES = {
  "--json": "json", "--yes": "yes", "--browser-in-container": "browserInContainer", "--playwright-image": "playwrightImage",
  "--playwright-from-project": "fromProject", "--allow-remote": "allowRemote",
};

const ALLOWED = {
  detect: ["--json", "--engine", "--image", "--os", "--playwright-from-project", "--playwright-dir"],
  run: ["--url", "--browsers", "--devices", "--browser-in-container", "--os", "--image", "--cmd", "--src", "--engine",
    "--network", "--jobs", "--timeout", "--out", "--playwright-from-project", "--playwright-dir", "--allow-remote", "--tart-vm", "--json"],
  setup: ["--images", "--browsers", "--playwright-image", "--yes", "--engine", "--image", "--playwright-from-project", "--playwright-dir", "--json"],
};

function defaults(command) {
  return {
    command, json: false, yes: false, browserInContainer: false, playwrightImage: false, fromProject: false, playwrightDir: null, allowRemote: false,
    urlArg: null, url: null, browsers: [...BROWSERS], browsersGiven: false, devices: null, os: ["rocky8", "rocky9"], images: {},
    cmd: "cat /etc/os-release", src: process.cwd(), engine: "auto", network: null,
    jobs: Math.max(1, Math.min(4, cpus().length || 1)), timeout: 300, out: null, tartVm: null, setupImages: null,
  };
}

function readFlags(command, argv) {
  const o = defaults(command);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!ALLOWED[command].includes(a)) throw new UsageError(`${command} 에 쓸 수 없는 인자입니다: ${a}`);
    if (SWITCHES[a]) { o[SWITCHES[a]] = true; continue; }
    if (argv[i + 1] === undefined) throw new UsageError(`${a} 뒤에 값이 필요합니다`);
    VALUES[a](o, argv[++i]);
  }
  return o;
}

export const imageFor = (o, os) => o.images[os] || DEFAULT_IMAGES[os] || null;

function validateBrowserArgs(o) {
  const browserOnly = o.devices || o.browsersGiven || o.browserInContainer;
  if (!o.urlArg && browserOnly) throw new UsageError("--devices, --browsers, --browser-in-container 는 --url 과 함께 씁니다");
  if (o.urlArg) o.url = toUrl(o.urlArg, o.allowRemote);
  if (o.browserInContainer && !/^https?:/.test(o.url)) throw new UsageError("--browser-in-container 는 http, https URL 만 엽니다");
}

function validateRun(o) {
  validateBrowserArgs(o);
  const noImage = o.os.find((os) => os !== "macos" && !imageFor(o, os));
  if (noImage) throw new UsageError(`--os ${noImage} 의 이미지를 --image ${noImage}=<이미지> 로 주십시오`);
  if (!o.url && !o.os.length) throw new UsageError("돌릴 칸이 없습니다(--url 과 --os 가 모두 비었음)");
  return o;
}

function validateSetup(o) {
  for (const os of o.setupImages || []) if (os === "macos" || !imageFor(o, os)) throw new UsageError(`--images ${os} 는 받을 이미지가 없습니다(macOS 는 Tart 로 따로)`);
  return o;
}

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!ALLOWED[command]) throw new UsageError(`하위 명령은 detect, run, setup 중 하나입니다: ${command ?? "(없음)"}`);
  const o = readFlags(command, rest);
  if (command === "run") return validateRun(o);
  if (command === "setup") return validateSetup(o);
  return o;
}
