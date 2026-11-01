// The browser group of build-testbox: plans one cell per device and runs browser-cell.mjs on the host (a child
// process) or inside the Playwright image (--browser-in-container). Downloads nothing.
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { BROWSERS, UsageError } from "./args.mjs";
import { RESULT_TAG } from "./browser-cell.mjs";
import { NAME_PREFIX, engineReason, imageState, randomTag, rmArgs } from "./containers.mjs";
import { playwrightImage } from "./detect.mjs";
import { firstLine, runProc } from "./proc.mjs";
import { cellOf } from "./report.mjs";

const CELL_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "browser-cell.mjs");
export const DEFAULT_DEVICES = ["Desktop Chrome", "Pixel 7", "Desktop Safari", "iPhone 15"];
const KNOWN = { "Desktop Chrome": "chromium", "Pixel 7": "chromium", "Desktop Safari": "webkit", "iPhone 15": "webkit" };
const iso = () => new Date().toISOString();

export const slug = (device) => device.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "device";

function cellBase(device, browser) {
  return { id: `browser:${device}`, group: "browser", target: device, device, browser, png: `browser-${slug(device)}.png` };
}

// One cell per device; the browser is the device's defaultBrowserType. devices is playwright.devices, or null when
// Playwright is missing (then the four default names map by a fixed table and every cell is needs-playwright).
// A cell with a preset reason does not run.
function deviceCell(o, name, devices) {
  if (!devices) {
    const browser = KNOWN[name] || "?";
    return browser !== "?" && !o.browsers.includes(browser) ? null : { ...cellBase(name, browser), preset: "needs-playwright" };
  }
  const d = devices[name];
  if (!d) return { ...cellBase(name, KNOWN[name] || "?"), preset: "unknown-device" };
  const browser = d.defaultBrowserType;
  if (!BROWSERS.includes(browser)) throw new UsageError(`기기 ${name} 의 브라우저 ${browser} 는 지원하지 않습니다(chromium, webkit 만)`);
  return o.browsers.includes(browser) ? cellBase(name, browser) : null;
}

export function planBrowserCells(o, devices) {
  const cells = (o.devices || DEFAULT_DEVICES).map((name) => deviceCell(o, name, devices)).filter(Boolean);
  if (!cells.length) throw new UsageError("--browsers 로 거르고 나니 브라우저 칸이 없습니다");
  return cells;
}

const strip = ({ preset, ...rest }) => rest;

function presetCell(c, detail) {
  return cellOf({ ...strip(c), startedAt: iso() }, "unverified", c.preset, detail ? { detail } : {});
}

export function parseResult(text) {
  const line = String(text).split(/\r?\n/).reverse().find((l) => l.startsWith(RESULT_TAG));
  if (!line) return null;
  try { return JSON.parse(line.slice(RESULT_TAG.length)); } catch { return null; }
}

// Child results joined to the planned cells. A cell the child never reported is timeout (child killed) or
// launch-failed.
export function mergeResults(cells, r, extra) {
  const parsed = parseResult(r.stdout);
  const byId = new Map(((parsed && parsed.cells) || []).map((c) => [c.id, c]));
  return cells.map((c) => {
    const got = byId.get(c.id);
    const base = { ...strip(c), ...extra };
    if (got) return cellOf({ ...base, ...got, screenshot: got.screenshot ? join(extra.out, got.screenshot) : undefined }, got.status, got.reason);
    if (parsed && parsed.fatal) return cellOf({ ...base, startedAt: iso() }, "unverified", parsed.fatal, { detail: parsed.detail });
    return cellOf({ ...base, startedAt: iso() }, "unverified", r.timedOut ? "timeout" : "launch-failed", { detail: (r.stderr || r.error || "").slice(0, 300) });
  });
}

const groupLimit = (o, n) => (o.timeout * Math.ceil(n / o.jobs) + 90) * 1000;

function specOf(o, cells, outDir, url) {
  return { url, jobs: o.jobs, timeoutMs: o.timeout * 1000, settleMs: 300, outDir, cells: cells.map(({ id, device, browser, png }) => ({ id, device, browser, png })) };
}

async function runOnHost(ctx, cells) {
  const { o, out } = ctx;
  const specFile = join(out, "browser-spec.json");
  writeFileSync(specFile, JSON.stringify(specOf(o, cells, out, o.url)));
  const r = await runProc(process.execPath, [CELL_SCRIPT, "--playwright", ctx.pwInfo.entry, "--spec", specFile], { cwd: out, timeoutMs: groupLimit(o, cells.length) });
  const log = join(out, "browser.log");
  writeFileSync(log, r.out);
  return mergeResults(cells, r, { out, log, where: "host" });
}

// Inside a container the host's loopback is the container's on Linux with --network host; elsewhere the engine's
// host name stands in for it.
export function containerUrl(url, engine, platform = process.platform) {
  if (platform === "linux") return url;
  const u = new URL(url);
  if (["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) u.hostname = engine.kind === "podman" ? "host.containers.internal" : "host.docker.internal";
  return u.href;
}

function stageRunner(o, cells, url) {
  const dir = mkdtempSync(join(tmpdir(), `${NAME_PREFIX}-pw-`));
  mkdirSync(join(dir, "node_modules"));
  copyFileSync(CELL_SCRIPT, join(dir, "browser-cell.mjs"));
  writeFileSync(join(dir, "spec.json"), JSON.stringify(specOf(o, cells, "/tb/out", url)));
  return dir;
}

// The cp steps: the runner and spec, then the host's playwright package and the playwright-core it depends on.
export function copySteps(stageDir, pwInfo, name) {
  return [
    ["cp", `${stageDir}${sep}.`, `${name}:/tb`],
    ["cp", pwInfo.dir, `${name}:/tb/node_modules/playwright`],
    ["cp", pwInfo.coreDir, `${name}:/tb/node_modules/playwright-core`],
  ];
}

async function containerSteps(ctx, cells, name, stageDir) {
  const { o, engine, out } = ctx;
  const linux = process.platform === "linux";
  const runner = ["node", "/tb/browser-cell.mjs", "--playwright", "/tb/node_modules/playwright/index.mjs", "--spec", "/tb/spec.json"];
  const create = ["create", "--name", name, "--ipc=host", ...(linux ? ["--network", "host"] : []), ctx.image, ...runner];
  for (const args of [create, ...copySteps(stageDir, ctx.pwInfo, name)]) {
    const r = await runProc(engine.bin, args, { timeoutMs: 600000 });
    if (r.code !== 0) return { failed: r };
  }
  const r = await runProc(engine.bin, ["start", "-a", name], { timeoutMs: groupLimit(o, cells.length) });
  await runProc(engine.bin, ["cp", `${name}:/tb/out/.`, out], { timeoutMs: 600000 });
  return { r, network: linux ? "host" : "default" };
}

async function runInContainer(ctx, cells) {
  const { engine, out } = ctx;
  if (!engine) return cells.map((c) => presetCell({ ...c, preset: "needs-engine" }));
  ctx.image = ctx.o.images.playwright || playwrightImage(ctx.pwInfo.version);
  const img = await imageState(engine, ctx.image);
  if (!img.present) return cells.map((c) => presetCell({ ...c, preset: img.reason, image: ctx.image }, img.detail));
  const name = `${NAME_PREFIX}-${randomTag()}-browser`;
  const stageDir = stageRunner(ctx.o, cells, containerUrl(ctx.o.url, engine));
  ctx.tracker.containers.add(name);
  ctx.tracker.temps.add(stageDir);
  try {
    const s = await containerSteps(ctx, cells, name, stageDir);
    const log = join(out, "browser.log");
    writeFileSync(log, (s.failed || s.r).out);
    if (s.failed) {
      const reason = engineReason(`${s.failed.out}\n${s.failed.error || ""}`) || "launch-failed";
      return cells.map((c) => presetCell({ ...c, preset: reason, image: ctx.image, log }, firstLine(s.failed.stderr) || s.failed.error));
    }
    return mergeResults(cells, s.r, { out, log, where: "container", image: ctx.image, network: s.network, engine: engine.name });
  } finally {
    await runProc(engine.bin, rmArgs(engine, name), { timeoutMs: 60000 });
    rmSync(stageDir, { recursive: true, force: true });
    ctx.tracker.containers.delete(name);
    ctx.tracker.temps.delete(stageDir);
  }
}

// ctx: { o, out, engine, tracker, pw, pwInfo, pwError }
export async function runBrowserGroup(ctx) {
  const cells = planBrowserCells(ctx.o, ctx.pw ? ctx.pw.devices : null);
  const preset = cells.filter((c) => c.preset).map((c) => presetCell(c, c.preset === "needs-playwright" ? ctx.pwError : null));
  const live = cells.filter((c) => !c.preset);
  if (!live.length) return preset;
  const ran = ctx.o.browserInContainer ? await runInContainer(ctx, live) : await runOnHost(ctx, live);
  const order = new Map(cells.map((c, i) => [c.id, i]));
  return [...preset, ...ran].sort((a, b) => order.get(a.id) - order.get(b.id));
}
