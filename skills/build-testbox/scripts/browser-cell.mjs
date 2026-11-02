#!/usr/bin/env node
// Browser cells of build-testbox. Runs on the host (a child of testbox.mjs) or inside the Playwright image
// (--browser-in-container), so it imports no other file of this skill. Each browser type starts once; each device
// gets its own context. A cell passes when the response is 2xx or 3xx (a file URL has none) and the page threw nothing.
//
//   node browser-cell.mjs --playwright <playwright entry file> --spec <spec.json>
//
// spec: { url, jobs, timeoutMs, settleMs, outDir, cells: [{ id, device, browser, png }] }
// Prints one line "BANKER_TESTBOX_RESULT <json>": { cells: [...] } or { fatal, detail }.
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const RESULT_TAG = "BANKER_TESTBOX_RESULT ";

const firstLine = (e) => String((e && e.message) || e || "").split(/\r?\n/).map((l) => l.trim()).find(Boolean) || "";

export function classifyLaunchError(message) {
  const m = String(message || "");
  if (/Executable doesn't exist/i.test(m)) return "needs-browser";
  if (/missing dependencies|error while loading shared libraries|cannot open shared object file/i.test(m)) return "host-deps";
  if (/\bEPERM\b|\bEACCES\b|Operation not permitted|Permission denied/i.test(m)) return "sandbox";
  if (/Timeout \d+ms exceeded|timed out/i.test(m)) return "timeout";
  return "launch-failed";
}

// chromium: Playwright's headless shell first, then the full Chromium (channel "chromium"); webkit has one build.
const VARIANTS = {
  chromium: [["headless-shell", {}], ["chromium", { channel: "chromium" }]],
  webkit: [["webkit", {}]],
};

async function tryLaunch(pw, name, options, timeoutMs) {
  try {
    return { browser: await pw[name].launch({ ...options, timeout: timeoutMs }) };
  } catch (e) {
    const message = String((e && e.message) || e);
    return { reason: classifyLaunchError(message), detail: firstLine(message).slice(0, 300) };
  }
}

// The reason to report when no variant starts: a missing executable says less than a missing library.
// No variant at all means the browser name is unknown.
function worstReason(failures, name) {
  if (!failures.length) return { reason: "launch-failed", detail: `모르는 브라우저 ${name}` };
  const telling = failures.find((f) => f.reason !== "needs-browser");
  return telling || failures[0];
}

// { browser, variant } or { reason, detail }.
async function launchBest(pw, name, timeoutMs = 30000) {
  const failures = [];
  for (const [variant, options] of VARIANTS[name] || []) {
    const r = await tryLaunch(pw, name, options, timeoutMs);
    if (r.browser) return { browser: r.browser, variant };
    failures.push({ ...r, variant });
  }
  return worstReason(failures, name);
}

// detect: each variant started and closed. { runnable, variant, reason, detail, variants: { <v>: { ok, reason?, detail? } } }
export async function probeBrowser(pw, name, timeoutMs = 30000) {
  const variants = {};
  for (const [variant, options] of VARIANTS[name] || []) {
    const r = await tryLaunch(pw, name, options, timeoutMs);
    if (r.browser) await r.browser.close().catch(() => {});
    variants[variant] = r.browser ? { ok: true } : { ok: false, reason: r.reason, detail: r.detail };
  }
  const ok = Object.entries(variants).find(([, v]) => v.ok);
  if (ok) return { runnable: true, variant: ok[0], variants };
  const worst = worstReason(Object.values(variants), name);
  return { runnable: false, reason: worst.reason, detail: worst.detail, variants };
}

export function judge(httpStatus, pageErrors) {
  if (httpStatus !== null && (httpStatus < 200 || httpStatus >= 400)) return ["fail", `http-${httpStatus}`];
  if (pageErrors > 0) return ["fail", "page-error"];
  return ["pass", ""];
}

async function visit(browser, pw, cell, spec) {
  const context = await browser.newContext({ ...pw.devices[cell.device] });
  const pageErrors = [];
  const consoleErrors = [];
  try {
    const page = await context.newPage();
    page.on("pageerror", (e) => pageErrors.push(firstLine(e).slice(0, 300)));
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300)); });
    const response = await page.goto(spec.url, { waitUntil: "load", timeout: spec.timeoutMs });
    if (spec.settleMs) await page.waitForTimeout(spec.settleMs);
    const title = await page.title();
    await page.screenshot({ path: join(spec.outDir, cell.png) });
    const httpStatus = response ? response.status() : null;
    const [status, reason] = judge(httpStatus, pageErrors.length);
    return { status, reason, httpStatus, title, pageErrors, consoleErrors, screenshot: cell.png };
  } finally {
    await context.close().catch(() => {});
  }
}

async function runCell(browser, pw, cell, spec, variant) {
  const startedAt = new Date().toISOString();
  let timer;
  const limit = new Promise((r) => { timer = setTimeout(() => r({ status: "unverified", reason: "timeout" }), spec.timeoutMs + 5000); });
  let result;
  try {
    result = await Promise.race([visit(browser, pw, cell, spec), limit]);
  } catch (e) {
    const timeout = /Timeout \d+ms exceeded/i.test(String(e && e.message));
    result = { status: timeout ? "unverified" : "fail", reason: timeout ? "timeout" : "page-error", detail: firstLine(e).slice(0, 300) };
  } finally {
    clearTimeout(timer);
  }
  return { id: cell.id, variant, ...result, startedAt, endedAt: new Date().toISOString() };
}

export async function pool(items, jobs, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(jobs, items.length)) }, worker));
  return results;
}

async function runBrowser(pw, name, cells, spec) {
  const startedAt = new Date().toISOString();
  const launched = await launchBest(pw, name, Math.min(spec.timeoutMs, 60000));
  if (!launched.browser) {
    const endedAt = new Date().toISOString();
    return cells.map((c) => ({ id: c.id, status: "unverified", reason: launched.reason, detail: launched.detail, startedAt, endedAt }));
  }
  try {
    return await pool(cells, spec.jobs || 1, (c) => runCell(launched.browser, pw, c, spec, launched.variant));
  } finally {
    await launched.browser.close().catch(() => {});
  }
}

// All browser types at once; the cells of one type share its jobs.
async function runGroup(pw, spec) {
  mkdirSync(spec.outDir, { recursive: true });
  const byBrowser = new Map();
  for (const c of spec.cells) byBrowser.set(c.browser, [...(byBrowser.get(c.browser) || []), c]);
  const groups = await Promise.all([...byBrowser].map(([name, cells]) => runBrowser(pw, name, cells, spec)));
  return groups.flat();
}

export async function importPlaywright(entry) {
  const mod = await import(pathToFileURL(entry).href);
  return mod.chromium ? mod : mod.default;
}

function argOf(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(argv) {
  const entry = argOf(argv, "--playwright");
  const specFile = argOf(argv, "--spec");
  let pw;
  try {
    pw = await importPlaywright(entry);
  } catch (e) {
    return { fatal: "needs-playwright", detail: firstLine(e) };
  }
  const spec = JSON.parse(readFileSync(specFile, "utf8"));
  return { cells: await runGroup(pw, spec) };
}

// Run directly, also through a linked path or another spelling: both sides as real paths.
const realOr = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};
const isMain = process.argv[1] && realOr(process.argv[1]) === realOr(fileURLToPath(import.meta.url));
if (isMain) {
  main(process.argv.slice(2))
    .then((r) => { process.stdout.write(`${RESULT_TAG}${JSON.stringify(r)}\n`); process.exit(0); })
    .catch((e) => { process.stdout.write(`${RESULT_TAG}${JSON.stringify({ fatal: "launch-failed", detail: firstLine(e) })}\n`); process.exit(0); });
}
