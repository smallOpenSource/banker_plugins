// Container OS cells (docker or podman) and the macOS cell (Tart on Apple Silicon) of build-testbox.
// A container cell: image inspect (no pull), create, cp a copy of the source to /src, start -a the command, rm -f.
// No bind mount (SELinux relabel, Windows paths). Containers are named banker-testbox-<random>-<os> and removed on
// success, failure, time-out and signal.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { imageFor } from "./args.mjs";
import { pool } from "./browser-cell.mjs";
import { firstLine, runProc, which } from "./proc.mjs";
import { cellOf } from "./report.mjs";

// The folder programs start in: the home folder (Windows looks for a program in the working folder first, so a
// program planted in the folder worked on never runs), or the temp folder when there is no home folder.
const runDir = () => (existsSync(homedir()) ? homedir() : tmpdir());

export const NAME_PREFIX = "banker-testbox";
const iso = () => new Date().toISOString();
export const randomTag = () => Math.random().toString(16).slice(2, 10).padEnd(8, "0");

export async function detectEngines(env = process.env) {
  const engines = {};
  for (const name of ["docker", "podman"]) {
    const path = which(name, env);
    if (!path) { engines[name] = { present: false }; continue; }
    const r = await runProc(path, ["--version"], { timeoutMs: 15000, env });
    engines[name] = { present: true, path, version: firstLine(r.stdout) || firstLine(r.stderr) };
    if (name === "docker") engines.docker.podmanEmulation = /podman/i.test(`${r.stdout}\n${r.stderr}`);
  }
  return engines;
}

// auto: a real docker first, then podman, then a docker that is podman's emulation.
function autoEngine(engines) {
  if (engines.docker.present && !engines.docker.podmanEmulation) return "docker";
  if (engines.podman.present) return "podman";
  return engines.docker.present ? "docker" : null;
}

export function selectEngine(pref, engines) {
  const name = pref && pref !== "auto" ? pref : autoEngine(engines);
  const e = name ? engines[name] : null;
  if (!e || !e.present) return null;
  return { name, bin: e.path, kind: name === "podman" || e.podmanEmulation ? "podman" : "docker" };
}

// Engine errors: a permission error (a sandbox, a socket without access) or an engine that cannot be reached.
export function engineReason(text) {
  const t = String(text || "");
  if (/permission denied|operation not permitted|\bEACCES\b|\bEPERM\b/i.test(t)) return "sandbox";
  if (/cannot connect to|daemon running|connection refused/i.test(t)) return "needs-engine";
  return null;
}

export async function imageState(engine, image, env = process.env) {
  const r = await runProc(engine.bin, ["image", "inspect", "--format", "{{.Id}}", image], { timeoutMs: 60000, env });
  if (r.code === 0) return { present: true };
  const text = `${r.stderr}\n${r.stdout}\n${r.error || ""}`;
  return { present: false, reason: engineReason(text) || (r.timedOut ? "timeout" : "needs-image"), detail: firstLine(r.stderr) };
}

export const rmArgs = (engine, name) => (engine.kind === "podman" ? ["rm", "-f", "-t", "0", name] : ["rm", "-f", name]);

export function removeAllSync(engine, names) {
  for (const name of names) spawnSync(engine.bin, rmArgs(engine, name), { stdio: "ignore", timeout: 30000 });
}

// ── source copy ────────────────────────────────────────────────────────────

function gitFiles(src) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k)));
  // from the home folder: Windows looks for git.exe in the working folder first
  const r = spawnSync("git", ["-C", src, "ls-files", "-z", "-co", "--exclude-standard"], { cwd: runDir(), encoding: "utf8", env, maxBuffer: 256 * 1024 * 1024 });
  return r.status === 0 ? r.stdout.split("\0").filter(Boolean) : null;
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".testbox"]);

function walkFiles(root, rel = "", acc = []) {
  for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walkFiles(root, r, acc);
    else acc.push(r);
  }
  return acc;
}

function copyEntry(src, dest, rel) {
  const from = join(src, rel);
  const to = join(dest, rel);
  let st;
  try { st = lstatSync(from); } catch { return false; }
  mkdirSync(dirname(to), { recursive: true });
  if (st.isSymbolicLink()) symlinkSync(readlinkSync(from), to);
  else if (st.isFile()) copyFileSync(from, to);
  else return false;
  return true;
}

// The files to put in /src: a git checkout gives its tracked and untracked-not-ignored files (working tree
// contents); any other folder gives everything but node_modules, .git and .testbox. The result folder is left out.
export function sourceFiles(src, out) {
  const outRel = out ? relative(src, out).split(sep).join("/") : "";
  const skipOut = outRel && !outRel.startsWith("..") && !isAbsolute(outRel);
  const files = gitFiles(src) || walkFiles(src);
  return files.filter((f) => !f.startsWith(".testbox/") && !(skipOut && (f === outRel || f.startsWith(`${outRel}/`))));
}

function stageSource(src, out) {
  const dir = mkdtempSync(join(tmpdir(), `${NAME_PREFIX}-src-`));
  try {
    let count = 0;
    for (const rel of sourceFiles(src, out)) if (copyEntry(src, dir, rel)) count += 1;
    return { dir, count };
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    return { error: firstLine(e.message) };
  }
}

// ── one container cell ─────────────────────────────────────────────────────

export function startOutcome(r) {
  if (r.timedOut) return ["unverified", "timeout"];
  if (r.code === 0) return ["pass", ""];
  if (r.code === 127) return ["unverified", "needs-tool"];
  if (r.code === null) return ["unverified", "launch-failed"];
  if (r.code === 125 && engineReason(r.out)) return ["unverified", engineReason(r.out)];
  return ["fail", `exit-${r.code}`];
}

async function engineStep(ctx, args, timeoutMs) {
  const r = await runProc(ctx.engine.bin, args, { timeoutMs, env: ctx.env });
  if (r.code === 0) return { r };
  const text = `${r.stderr}\n${r.stdout}\n${r.error || ""}`;
  return { r, reason: engineReason(text) || (r.timedOut ? "timeout" : "launch-failed"), detail: firstLine(r.stderr) || r.error };
}

async function networkMode(ctx, name) {
  const r = await runProc(ctx.engine.bin, ["inspect", "--format", "{{.HostConfig.NetworkMode}}", name], { timeoutMs: 30000, env: ctx.env });
  return (r.code === 0 && r.stdout.trim()) || ctx.o.network || "default";
}

function writeLog(file, header, body) {
  writeFileSync(file, `${header.map((h) => `# ${h}`).join("\n")}\n${body}`);
}

async function execContainer(ctx, base, stageDir) {
  const { o, engine } = ctx;
  const name = `${NAME_PREFIX}-${randomTag()}-${base.target}`;
  ctx.tracker.containers.add(name);
  try {
    const net = o.network ? ["--network", o.network] : [];
    const created = await engineStep(ctx, ["create", "--name", name, "-w", "/src", ...net, base.image, "sh", "-c", o.cmd], 120000);
    if (created.reason) return cellOf(base, "unverified", created.reason, { detail: created.detail });
    const network = await networkMode(ctx, name);
    const copied = await engineStep(ctx, ["cp", `${stageDir}${sep}.`, `${name}:/src`], 600000);
    if (copied.reason) return cellOf({ ...base, network }, "unverified", copied.reason, { detail: copied.detail });
    const r = await runProc(engine.bin, ["start", "-a", name], { timeoutMs: o.timeout * 1000, env: ctx.env });
    const log = join(ctx.out, `os-${base.target}.log`);
    writeLog(log, [`image ${base.image}`, `engine ${engine.name}`, `network ${network}`, `cmd ${o.cmd}`, `exit ${r.timedOut ? "timeout" : r.code}`], r.out);
    const [status, reason] = startOutcome(r);
    return cellOf({ ...base, container: name, network, log, exitCode: r.code }, status, reason);
  } finally {
    await runProc(engine.bin, rmArgs(engine, name), { timeoutMs: 60000, env: ctx.env });
    ctx.tracker.containers.delete(name);
  }
}

export async function runContainerCell(ctx, os) {
  const base = { id: `os:${os}`, group: "os", target: os, image: imageFor(ctx.o, os), engine: ctx.engine ? ctx.engine.name : null, startedAt: iso() };
  if (!ctx.engine) return cellOf(base, "unverified", "needs-engine");
  const img = await imageState(ctx.engine, base.image, ctx.env);
  if (!img.present) return cellOf(base, "unverified", img.reason, { detail: img.detail });
  const stage = await ctx.stage();
  if (stage.error) return cellOf(base, "unverified", "launch-failed", { detail: `소스 사본 실패: ${stage.error}` });
  return execContainer(ctx, base, stage.dir);
}

// ── macOS (Tart) ───────────────────────────────────────────────────────────

async function tartVms(tart, env) {
  const r = await runProc(tart, ["list", "--format", "json"], { timeoutMs: 30000, env });
  if (r.code !== 0) return [];
  try {
    return JSON.parse(r.stdout).map((v) => v.Name || v.name).filter(Boolean);
  } catch {
    return [];
  }
}

// Tart runs only on Apple Silicon Macs (the Apple SLA allows macOS VMs on Apple hardware). hw.model alone is not
// trusted: an x86_64 macOS VM on QEMU reports a Mac model too.
// The tart binary and VM to use: { tart, vm }, or { cell } that says why there is none.
async function macosVm(ctx, base) {
  const { host, o, env } = ctx;
  if (host.platform !== "darwin") return { cell: cellOf(base, "unsupported", "apple-sla") };
  if (!host.appleSilicon) return { cell: cellOf(base, "unsupported", "tart-needs-apple-silicon") };
  const tart = which("tart", env);
  if (!tart) return { cell: cellOf(base, "unverified", "needs-tart") };
  const vms = await tartVms(tart, env);
  const vm = o.tartVm ? vms.find((v) => v === o.tartVm) : vms[0];
  if (!vm) return { cell: cellOf(base, "unverified", "needs-vm", { detail: `로컬 VM: ${vms.join(", ") || "없음"}` }) };
  return { tart, vm };
}

export async function macosCell(ctx) {
  const { o, env } = ctx;
  const base = { id: "os:macos", group: "os", target: "macos", engine: "tart", startedAt: iso() };
  const found = await macosVm(ctx, base);
  if (found.cell) return found.cell;
  const { tart, vm } = found;
  const help = await runProc(tart, ["exec", "--help"], { timeoutMs: 15000, env });
  if (help.code !== 0) return cellOf({ ...base, vm }, "unverified", "tart-exec-unsupported", { detail: firstLine(help.stderr) });
  const r = await runProc(tart, ["exec", vm, "--", "sh", "-c", o.cmd], { timeoutMs: o.timeout * 1000, env });
  const log = join(ctx.out, "os-macos.log");
  writeLog(log, [`tart vm ${vm}`, `cmd ${o.cmd}`, `exit ${r.timedOut ? "timeout" : r.code}`], r.out);
  if (r.code !== 0 && !r.timedOut && /not running/i.test(r.out)) return cellOf({ ...base, vm, log }, "unverified", "needs-vm");
  const [status, reason] = startOutcome(r);
  return cellOf({ ...base, vm, log, exitCode: r.code }, status, reason);
}

// All requested OS cells, --jobs at a time. The source copy is made once, on first need, and removed at the end.
export async function runOsGroup(ctx) {
  let staged = null;
  const stage = async () => {
    if (!staged) staged = stageSource(ctx.o.src, ctx.out);
    if (staged.dir) ctx.tracker.temps.add(staged.dir);
    return staged;
  };
  const c = { ...ctx, stage };
  try {
    return await pool(ctx.o.os, ctx.o.jobs, (os) => (os === "macos" ? macosCell(c) : runContainerCell(c, os)));
  } finally {
    if (staged && staged.dir) {
      rmSync(staged.dir, { recursive: true, force: true });
      ctx.tracker.temps.delete(staged.dir);
    }
  }
}
