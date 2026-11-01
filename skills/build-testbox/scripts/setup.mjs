// setup: the only part of build-testbox that downloads. Without --yes it prints the plan (what, about how big) and
// exits 0. With --yes it checks each source within 15 seconds, pulls images and installs browsers from the sources
// it reached, then verifies with the same checks detect uses.
// Exit 0 everything got and verified, 1 a step failed, 4 nothing failed but a source was unreachable ("네트워크 필요").
import { homedir } from "node:os";
import { BROWSERS, DEFAULT_IMAGES, imageFor } from "./args.mjs";
import { probeBrowser } from "./browser-cell.mjs";
import { detectEngines, imageState, selectEngine } from "./containers.mjs";
import { loadPlaywright, playwrightImage } from "./detect.mjs";
import { firstLine, runProc } from "./proc.mjs";

export const NET_TIMEOUT_MS = 15000;
const SIZES = { rocky8: "약 200MB", rocky9: "약 180MB", chromium: "약 280MB(chromium 과 headless shell)", webkit: "약 100MB", playwright: "약 2GB" };

// The registry an image comes from, as the URL to check. A loopback registry is plain http (local registries are).
export function registryUrl(image) {
  const first = image.split("/")[0];
  const hasHost = image.includes("/") && (/[.:]/.test(first) || first === "localhost");
  const host = !hasHost || first === "docker.io" ? "registry-1.docker.io" : first;
  const plain = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
  return `${plain ? "http" : "https"}://${host}/v2/`;
}

const noUser = (url) => String(url).replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/@]*@/, "$1").replace(/\/$/, "");

export function downloadHosts(env = process.env) {
  const main = noUser(env.PLAYWRIGHT_DOWNLOAD_HOST || "https://cdn.playwright.dev");
  const chromium = noUser(env.PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST || main);
  return [...new Set([`${chromium}/`, `${main}/`])];
}

// Any HTTP answer (401 and 404 too) means reached. No answer within the limit is unreachable.
export async function reachable(url, timeoutMs = NET_TIMEOUT_MS) {
  try {
    await fetch(url, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    return { ok: true };
  } catch (e) {
    const cause = e && e.cause ? e.cause.code || e.cause.message : "";
    return { ok: false, detail: `${e.name === "TimeoutError" ? `${timeoutMs / 1000}초 안에 답 없음` : firstLine(e.message)}${cause ? ` (${cause})` : ""}` };
  }
}

function itemsFromArgs(o, pwVersion) {
  const items = (o.setupImages || []).map((os) => ({ kind: "image", key: os, image: imageFor(o, os) }));
  if (o.playwrightImage) items.push({ kind: "image", key: "playwright", image: o.images.playwright || (pwVersion ? playwrightImage(pwVersion) : null) });
  if (o.browsersGiven) for (const b of o.browsers) items.push({ kind: "browser", key: b });
  return items;
}

// No item named: the default images missing locally and the browsers whose build is missing.
async function defaultItems(o, engine, pw) {
  const items = [];
  for (const os of Object.keys(DEFAULT_IMAGES)) {
    const image = imageFor(o, os);
    if (!engine || !(await imageState(engine, image)).present) items.push({ kind: "image", key: os, image });
  }
  for (const b of BROWSERS) if (!pw || (await probeBrowser(pw, b)).reason === "needs-browser") items.push({ kind: "browser", key: b });
  return items;
}

export async function planSetup(o) {
  const loaded = await loadPlaywright(o.fromProject, o.playwrightDir);
  const engine = selectEngine(o.engine, await detectEngines());
  const named = Boolean(o.setupImages || o.playwrightImage || o.browsersGiven);
  const items = named ? itemsFromArgs(o, loaded.info && loaded.info.version) : await defaultItems(o, engine, loaded.pw);
  return { items, engine, loaded };
}

const label = (it) => (it.kind === "image" ? `이미지 ${it.key}: ${it.image || "(Playwright 판을 모름)"}` : `브라우저 ${it.key}`);

export function renderPlan(items) {
  if (!items.length) return "받을 것 없음\n";
  const lines = ["받을 것(--yes 를 주면 받음):"];
  for (const it of items) lines.push(`- ${label(it)}, ${SIZES[it.key] || "크기 모름"}`);
  lines.push("받으려면 확인을 받은 뒤 같은 인자에 --yes 를 붙여 다시 실행");
  return `${lines.join("\n")}\n`;
}

async function checkSources(items, env) {
  const urls = new Set();
  for (const it of items) {
    if (it.kind === "image" && it.image) urls.add(registryUrl(it.image));
    if (it.kind === "browser") for (const u of downloadHosts(env)) urls.add(u);
  }
  const results = await Promise.all([...urls].map(async (u) => [u, await reachable(u)]));
  return new Map(results);
}

function sourcesOf(it, env) {
  if (it.kind === "image") return it.image ? [registryUrl(it.image)] : [];
  return downloadHosts(env);
}

async function getImage(it, engine) {
  if (!it.image) return { status: "failed", detail: "Playwright 패키지가 없어 이미지 판을 정하지 못함(setup-playwright)" };
  if (!engine) return { status: "failed", detail: "docker, podman 없음" };
  const r = await runProc(engine.bin, ["pull", it.image], { timeoutMs: 60 * 60 * 1000 });
  if (r.code !== 0) return { status: "failed", detail: firstLine(r.stderr) || r.error };
  const v = await imageState(engine, it.image);
  return v.present ? { status: "ok" } : { status: "failed", detail: `받은 뒤 확인 실패: ${v.reason}` };
}

async function getBrowser(it, loaded) {
  if (!loaded.info) return { status: "failed", detail: `${loaded.error}. setup-playwright 스킬로 설치하거나 --playwright-dir 로 위치를 줌` };
  // npx runs where that Playwright is: the given folder, the project, or (global) the home folder.
  const cwd = loaded.info.base || homedir();
  const r = await runProc("npx", ["--no-install", "playwright", "install", it.key], { cwd, timeoutMs: 60 * 60 * 1000 });
  if (r.code !== 0) return { status: "failed", detail: firstLine(r.stderr) || r.error };
  const again = await loadPlaywright(loaded.info.from === "project", loaded.info.from === "dir" ? loaded.info.base : null);
  const p = again.pw ? await probeBrowser(again.pw, it.key) : { runnable: false, reason: "needs-playwright" };
  return p.runnable ? { status: "ok" } : { status: "failed", detail: `설치 뒤 실행 확인 실패: ${p.reason}` };
}

function blockedBy(it, net, env) {
  const bad = sourcesOf(it, env).filter((u) => !net.get(u).ok);
  return bad.length ? bad.map((u) => `${u} ${net.get(u).detail}`).join("; ") : null;
}

// Images first in the order given, then browsers; one at a time.
export async function applySetup(plan, env = process.env) {
  const net = await checkSources(plan.items, env);
  const rows = [];
  for (const it of plan.items) {
    const blocked = blockedBy(it, net, env);
    if (blocked) { rows.push({ ...it, status: "needs-network", detail: blocked }); continue; }
    const got = it.kind === "image" ? await getImage(it, plan.engine) : await getBrowser(it, plan.loaded);
    rows.push({ ...it, ...got });
  }
  return rows;
}

export function setupExitCode(rows) {
  if (rows.some((r) => r.status === "failed")) return 1;
  if (rows.some((r) => r.status === "needs-network")) return 4;
  return 0;
}

export function renderSetup(rows, env = process.env) {
  const n = (s) => rows.filter((r) => r.status === s).length;
  const lines = [`setup: ok ${n("ok")}, failed ${n("failed")}, needs-network ${n("needs-network")}`];
  if (n("needs-network")) lines.push(env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? "네트워크 필요: Codex 샌드박스가 네트워크를 막음(승인 뒤 다시 실행)" : "네트워크 필요: 닿지 못한 원천은 받지 않음");
  for (const r of rows) lines.push(`- ${label(r)}: ${r.status}${r.detail ? ` (${r.detail})` : ""}`);
  return `${lines.join("\n")}\n`;
}
