// detect: host, Playwright, browsers (a real headless start, not a file check), container engines, local images and
// Tart. Downloads nothing.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, release } from "node:os";
import { dirname, join } from "node:path";
import { BROWSERS, DEFAULT_IMAGES, imageFor } from "./args.mjs";
import { importPlaywright, probeBrowser } from "./browser-cell.mjs";
import { detectEngines, imageState, selectEngine } from "./containers.mjs";
import { firstLine, runProc, which } from "./proc.mjs";

function sysctl(key) {
  const bin = existsSync("/usr/sbin/sysctl") ? "/usr/sbin/sysctl" : "sysctl";
  const r = spawnSync(bin, ["-n", key], { encoding: "utf8", timeout: 10000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

// appleSilicon: an arm64 Mac (also when this Node runs under Rosetta). hw.model is reported but not trusted.
export function hostInfo() {
  const host = { platform: process.platform, arch: process.arch, release: release(), node: process.version, appleSilicon: false, hwModel: null };
  if (host.platform === "darwin") {
    host.hwModel = sysctl("hw.model");
    host.appleSilicon = host.arch === "arm64" || sysctl("hw.optional.arm64") === "1";
  }
  return host;
}

function resolveFrom(base) {
  try { return createRequire(join(base, "noop.js")).resolve("playwright"); } catch { return null; }
}

// npm's global root, asked from the home folder so a project's npm.cmd or .npmrc is not used.
function globalRoot() {
  const opts = { encoding: "utf8", cwd: homedir(), timeout: 30000 };
  const r = process.platform === "win32" ? spawnSync("npm.cmd root -g", { ...opts, shell: true }) : spawnSync("npm", ["root", "-g"], opts);
  return String(r.stdout || "").trim();
}

function packageDir(entry, name) {
  let dir = dirname(entry);
  while (dir !== dirname(dir)) {
    const pj = join(dir, "package.json");
    if (existsSync(pj) && JSON.parse(readFileSync(pj, "utf8")).name === name) return dir;
    dir = dirname(dir);
  }
  return null;
}

function coreDirOf(pwDir) {
  try { return dirname(createRequire(join(pwDir, "package.json")).resolve("playwright-core/package.json")); } catch { return null; }
}

const PLAYWRIGHT_DIR_ENV = "BUILD_TESTBOX_PLAYWRIGHT_DIR";

// A folder given by --playwright-dir or BUILD_TESTBOX_PLAYWRIGHT_DIR (the folder that holds node_modules), or null.
const givenDir = (dir, env) => dir || env[PLAYWRIGHT_DIR_ENV] || null;

// { entry, from, base } or { missing } (where it looked). Order: a given folder (--playwright-dir, then
// BUILD_TESTBOX_PLAYWRIGHT_DIR; no fallback when it lacks Playwright), the project only with --playwright-from-project
// (loading it runs that project's code), then the global npm root. A bare import is not used.
function findEntry(fromProject, cwd, dir, env) {
  const base = givenDir(dir, env);
  if (base) {
    const entry = resolveFrom(base);
    return entry ? { entry, from: "dir", base } : { missing: `--playwright-dir 또는 ${PLAYWRIGHT_DIR_ENV}: ${base}` };
  }
  const projectEntry = fromProject ? resolveFrom(cwd) : null;
  if (projectEntry) return { entry: projectEntry, from: "project", base: cwd };
  const root = globalRoot();
  const entry = root ? resolveFrom(root) : null;
  return entry ? { entry, from: "global", base: null } : { missing: `${fromProject ? "프로젝트, " : ""}전역 npm root` };
}

// { info: { entry, dir, coreDir, version, from, base } } or { error }. from is dir, project or global; base is the
// folder npx runs in for that Playwright (null for global).
export function locatePlaywright(fromProject = false, cwd = process.cwd(), dir = null, env = process.env) {
  const found = findEntry(fromProject, cwd, dir, env);
  if (found.missing) return { error: `playwright 패키지가 없습니다(${found.missing})` };
  const pkg = packageDir(found.entry, "playwright");
  const at = { from: found.from, base: found.base };
  if (!pkg) return { info: { entry: found.entry, dir: null, coreDir: null, version: null, ...at } };
  const version = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).version;
  const entry = existsSync(join(pkg, "index.mjs")) ? join(pkg, "index.mjs") : found.entry;
  return { info: { entry, dir: pkg, coreDir: coreDirOf(pkg), version, ...at } };
}

export async function loadPlaywright(fromProject = false, dir = null) {
  const loc = locatePlaywright(fromProject, process.cwd(), dir);
  if (loc.error) return loc;
  try {
    return { ...loc, pw: await importPlaywright(loc.info.entry) };
  } catch (e) {
    return { info: loc.info, error: `playwright 를 불러오지 못했습니다: ${firstLine(e.message)}` };
  }
}

async function browsersOf(pw) {
  const out = {};
  for (const name of BROWSERS) out[name] = pw ? await probeBrowser(pw, name) : { runnable: false, reason: "needs-playwright", variants: {} };
  return out;
}

async function imagesOf(o, engine, pwVersion) {
  const names = [...new Set([...Object.keys(DEFAULT_IMAGES), ...(o.os || []).filter((x) => x !== "macos")])];
  const targets = names.map((os) => [os, imageFor(o, os)]).filter(([, img]) => img);
  if (pwVersion) targets.push(["playwright", o.images.playwright || playwrightImage(pwVersion)]);
  const images = {};
  for (const [key, image] of targets) images[key] = engine ? { image, ...(await imageState(engine, image)) } : { image, present: false, reason: "needs-engine" };
  return images;
}

export const playwrightImage = (version) => `mcr.microsoft.com/playwright:v${version}-noble`;

async function tartOf(host) {
  if (host.platform !== "darwin") return { present: false, reason: "apple-sla" };
  if (!host.appleSilicon) return { present: false, reason: "tart-needs-apple-silicon" };
  const tart = which("tart");
  if (!tart) return { present: false, reason: "needs-tart" };
  const r = await runProc(tart, ["list", "--format", "json"], { timeoutMs: 30000 });
  let vms = [];
  try { vms = JSON.parse(r.stdout).map((v) => v.Name || v.name).filter(Boolean); } catch { vms = []; }
  return { present: true, path: tart, vms };
}

export async function detect(o) {
  const host = hostInfo();
  const loaded = await loadPlaywright(o.fromProject, o.playwrightDir);
  const engines = await detectEngines();
  const engine = selectEngine(o.engine, engines);
  const playwright = loaded.info ? { found: !loaded.error, ...loaded.info, error: loaded.error } : { found: false, error: loaded.error };
  return {
    tool: "build-testbox",
    host,
    playwright,
    browsers: await browsersOf(loaded.pw),
    engines,
    engine: engine ? { name: engine.name, kind: engine.kind, path: engine.bin } : null,
    images: await imagesOf(o, engine, loaded.pw ? loaded.info.version : null),
    tart: await tartOf(host),
  };
}

function browserLine(name, b) {
  if (b.runnable) return `- ${name}: 실행 가능(${b.variant})`;
  return `- ${name}: 실행 불가(${b.reason})${b.detail ? ` ${b.detail.slice(0, 160)}` : ""}`;
}

function hostLine(h) {
  const mac = h.platform === "darwin" ? `, Apple Silicon ${h.appleSilicon ? "예" : "아니오"}, hw.model ${h.hwModel}` : "";
  return `호스트: ${h.platform} ${h.arch}${mac}`;
}

function playwrightLine(p) {
  return p.found ? `Playwright: ${p.version} (${p.from}, ${p.dir})` : `Playwright: 없음 (${p.error})`;
}

export function renderDetect(d) {
  const lines = [hostLine(d.host), playwrightLine(d.playwright)];
  for (const name of BROWSERS) lines.push(browserLine(name, d.browsers[name]));
  const emu = d.engines.docker.present && d.engines.docker.podmanEmulation ? ", docker 는 podman 에뮬레이션" : "";
  lines.push(`엔진: ${d.engine ? `${d.engine.name}${emu}` : "없음"}`);
  for (const [key, img] of Object.entries(d.images)) lines.push(`- 이미지 ${key}: ${img.image} ${img.present ? "있음" : `없음(${img.reason})`}`);
  lines.push(`Tart: ${d.tart.present ? `VM ${d.tart.vms.join(", ") || "없음"}` : d.tart.reason}`);
  return `${lines.join("\n")}\n`;
}
