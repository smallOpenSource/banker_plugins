#!/usr/bin/env node
// build-testbox: a test bed each PC builds for itself. Browser matrix (Playwright Chromium and WebKit, desktop and
// mobile emulation) and container OS (Rocky Linux; macOS only as a Tart VM on Apple Silicon) run in parallel.
// run downloads nothing; setup downloads only after --yes. Pure Node 18+, no dependency.
import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { UsageError, parseArgs } from "./args.mjs";
import { runBrowserGroup } from "./browsers.mjs";
import { detectEngines, randomTag, removeAllSync, runOsGroup, selectEngine } from "./containers.mjs";
import { detect, hostInfo, loadPlaywright, renderDetect } from "./detect.mjs";
import { killAll } from "./proc.mjs";
import { buildResults, renderSummary, writeResults } from "./report.mjs";
import { applySetup, planSetup, renderPlan, renderSetup, setupExitCode } from "./setup.mjs";

const USAGE = `build-testbox: 브라우저 행렬과 컨테이너 OS 를 병렬로 돌리는 시험 환경(detect, run, setup)
usage:
  node testbox.mjs detect [--json] [--engine auto|docker|podman] [--os <os,...>] [--image <os>=<이미지>] [--playwright-from-project]
                          [--playwright-dir <폴더>]
  node testbox.mjs run [--url <loopback URL|파일>] [--browsers chromium,webkit] [--devices "<기기>,..."] [--browser-in-container]
                       [--os rocky8,rocky9,macos|none] [--image <os>=<이미지>] [--cmd "<명령>"] [--src <dir>]
                       [--engine auto|docker|podman] [--network bridge|none|host] [--jobs N] [--timeout <초>] [--out <dir>]
                       [--playwright-from-project] [--playwright-dir <폴더>] [--allow-remote] [--tart-vm <이름>] [--json]
  node testbox.mjs setup [--images <os,...>] [--browsers <이름,...>] [--playwright-image] [--yes] [--engine ...] [--image <os>=<이미지>]
                         [--playwright-dir <폴더>]
  detect  호스트, Playwright, 브라우저(실제 headless 실행), 엔진, 로컬 이미지, Tart. 내려받지 않음
  run     브라우저 묶음(--url 이 있을 때)과 컨테이너 묶음을 같은 순간에 시작. 내려받지 않음. 결과는 <out>/results.json, summary.md
  setup   --yes 가 없으면 받을 것과 크기만 보임. --yes 면 원천마다 15초 확인 뒤 받고 detect 와 같은 확인
Playwright 찾는 순서: --playwright-dir, BUILD_TESTBOX_PLAYWRIGHT_DIR(둘 다 node_modules 를 담은 폴더), --playwright-from-project 의 프로젝트, 전역 npm root
기본: --devices "Desktop Chrome,Pixel 7,Desktop Safari,iPhone 15", --os rocky8,rocky9, --cmd "cat /etc/os-release",
      --jobs min(4, CPU 수), --timeout 300, --out ./.testbox/<시각>
exit(run): 0 모든 칸 pass, 1 fail 1칸 이상, 4 fail 없이 unverified 나 unsupported, 2 사용 오류, 3 내부 오류나 결과 쓰기 실패,
           129, 130, 143 SIGHUP, SIGINT, SIGTERM(만든 컨테이너를 지운 뒤)
exit(setup): 0 받고 확인됨(또는 계획만), 1 일부 실패, 4 네트워크 필요, 2 사용 오류
`;

function defaultOut() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const dir = join(process.cwd(), ".testbox", stamp);
  return existsSync(dir) ? `${dir}-${randomTag().slice(0, 4)}` : dir;
}

function cleanup(tracker, engine) {
  killAll();
  if (engine) removeAllSync(engine, [...tracker.containers]);
  for (const dir of tracker.temps) rmSync(dir, { recursive: true, force: true });
  const n = tracker.containers.size;
  tracker.containers.clear();
  tracker.temps.clear();
  return n;
}

// 128 + the signal number, the shell's convention.
const SIGNAL_EXIT = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

function installSignals(tracker, engine) {
  const handler = (sig) => {
    const n = cleanup(tracker, engine);
    process.stderr.write(`${sig}: 만든 컨테이너 ${n}개를 지우고 멈춤\n`);
    process.exit(SIGNAL_EXIT[sig]);
  };
  for (const sig of Object.keys(SIGNAL_EXIT)) process.on(sig, handler);
  return () => { for (const sig of Object.keys(SIGNAL_EXIT)) process.off(sig, handler); };
}

function notesOf(o, engines, engine) {
  const notes = [];
  if (!o.url) notes.push("브라우저 묶음 요청 안 됨(--url 없음)");
  if (!o.os.length) notes.push("컨테이너 묶음 요청 안 됨(--os none)");
  if (o.os.some((x) => x !== "macos")) {
    const emu = engine && engine.name === "docker" && engines.docker.podmanEmulation ? "(podman 에뮬레이션)" : "";
    notes.push(`컨테이너 엔진: ${engine ? engine.name + emu : "없음"}`);
  }
  return notes;
}

async function browserGroup(ctx) {
  const loaded = await loadPlaywright(ctx.o.fromProject, ctx.o.playwrightDir);
  return runBrowserGroup({ ...ctx, pw: loaded.pw, pwInfo: loaded.info, pwError: loaded.error });
}

async function runCommand(o) {
  const startedAt = new Date().toISOString();
  const out = o.out || defaultOut();
  mkdirSync(out, { recursive: true });
  const host = hostInfo();
  const engines = await detectEngines();
  const engine = selectEngine(o.engine, engines);
  const tracker = { containers: new Set(), temps: new Set() };
  const off = installSignals(tracker, engine);
  const ctx = { o, out, engine, tracker, host, env: process.env };
  try {
    const [b, c] = await Promise.all([o.url ? browserGroup(ctx) : [], o.os.length ? runOsGroup(ctx) : []]);
    const results = buildResults({ cells: [...b, ...c], notes: notesOf(o, engines, engine), host, startedAt, out });
    writeResults(out, results);
    return results;
  } catch (e) {
    cleanup(tracker, engine);
    throw e;
  } finally {
    off();
  }
}

async function setupCommand(o) {
  const plan = await planSetup(o);
  if (!o.yes) {
    process.stdout.write(o.json ? `${JSON.stringify({ plan: plan.items })}\n` : renderPlan(plan.items));
    return 0;
  }
  const rows = await applySetup(plan);
  process.stdout.write(o.json ? `${JSON.stringify({ rows, exitCode: setupExitCode(rows) })}\n` : renderSetup(rows));
  return setupExitCode(rows);
}

async function dispatch(o) {
  if (o.command === "detect") {
    const d = await detect(o);
    process.stdout.write(o.json ? `${JSON.stringify(d)}\n` : renderDetect(d));
    return 0;
  }
  if (o.command === "setup") return setupCommand(o);
  const results = await runCommand(o);
  process.stdout.write(o.json ? `${JSON.stringify(results)}\n` : `${renderSummary(results)}결과: ${join(results.out, "results.json")}\n`);
  return results.exitCode;
}

const wantsHelp = (argv) => !argv.length || ["--help", "-h", "help"].includes(argv[0]) || argv.includes("--help");

export async function main(argv) {
  if (wantsHelp(argv)) {
    process.stdout.write(USAGE);
    return argv.length ? 0 : 2;
  }
  try {
    return await dispatch(parseArgs(argv));
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`build-testbox: ${e.message}\n(--help 로 사용법)\n`);
      return 2;
    }
    process.stderr.write(`build-testbox: 내부 오류: ${e && e.stack ? e.stack : e}\n`);
    return 3;
  }
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
if (isMain) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
