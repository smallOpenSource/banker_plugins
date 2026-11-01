// setup tests with a fake engine and a fake npx. Nothing is downloaded: sources are local servers or closed ports.
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { probeBrowser } from "./browser-cell.mjs";
import { loadPlaywright } from "./detect.mjs";
import { calls, fakeBin, fakeEnv } from "../../../scripts/test-fixtures/testbox-fakes.mjs";
import { downloadHosts, registryUrl, setupExitCode } from "./setup.mjs";

const TESTBOX = fileURLToPath(new URL("./testbox.mjs", import.meta.url));

function run(argv, env) {
  return new Promise((resolveRun) => {
    const started = Date.now();
    const child = spawn(process.execPath, [TESTBOX, ...argv], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (status) => resolveRun({ status, stdout, stderr, ms: Date.now() - started }));
  });
}

const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));

test("registry and download source URLs", () => {
  assert.equal(registryUrl("docker.io/rockylinux/rockylinux:9"), "https://registry-1.docker.io/v2/");
  assert.equal(registryUrl("alpine:3"), "https://registry-1.docker.io/v2/");
  assert.equal(registryUrl("mcr.microsoft.com/playwright:v1.58.2-noble"), "https://mcr.microsoft.com/v2/");
  assert.equal(registryUrl("127.0.0.1:5000/r:1"), "http://127.0.0.1:5000/v2/");
  assert.equal(registryUrl("localhost/r:1"), "http://localhost/v2/");
  assert.deepEqual(downloadHosts({}), ["https://cdn.playwright.dev/"]);
  assert.deepEqual(downloadHosts({ PLAYWRIGHT_DOWNLOAD_HOST: "https://user:pw@mirror.example/" }), ["https://mirror.example/"]);
  assert.deepEqual(downloadHosts({ PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST: "https://c.example", PLAYWRIGHT_DOWNLOAD_HOST: "https://m.example" }), ["https://c.example/", "https://m.example/"]);
  assert.equal(setupExitCode([{ status: "ok" }]), 0);
  assert.equal(setupExitCode([{ status: "ok" }, { status: "needs-network" }]), 4);
  assert.equal(setupExitCode([{ status: "failed" }, { status: "needs-network" }]), 1);
});

test("without --yes: plan only, exit 0, nothing pulled or installed", async () => {
  const fake = fakeBin(["podman", "npx"]);
  const named = await run(["setup", "--images", "rocky8,rocky9", "--browsers", "webkit", "--playwright-image", "--engine", "podman"], fakeEnv(fake));
  assert.equal(named.status, 0, named.stderr);
  assert.match(named.stdout, /이미지 rocky8: docker\.io\/rockylinux\/rockylinux:8, 약 200MB/);
  assert.match(named.stdout, /브라우저 webkit/);
  assert.match(named.stdout, /--yes/);
  const auto = await run(["setup", "--engine", "podman"], fakeEnv(fake, { FAKE_MODE: "missing" }));
  assert.equal(auto.status, 0, auto.stderr);
  assert.match(auto.stdout, /이미지 rocky8/);
  const verbs = calls(fake).map((c) => `${c.tool} ${c.args[0]}`);
  assert.ok(!verbs.some((v) => /^podman pull|^npx/.test(v)), verbs.join(","));
});

test("--yes with an unreachable source: exit 4 and 네트워크 필요, nothing pulled", async () => {
  const fake = fakeBin(["podman", "npx"]);
  const r = await run(["setup", "--yes", "--images", "x", "--image", "x=127.0.0.1:1/rocky:8", "--browsers", "chromium", "--engine", "podman"],
    fakeEnv(fake, { PLAYWRIGHT_DOWNLOAD_HOST: "http://127.0.0.1:1" }));
  assert.equal(r.status, 4, r.stdout + r.stderr);
  assert.match(r.stdout, /네트워크 필요/);
  assert.match(r.stdout, /needs-network 2/);
  assert.ok(!calls(fake).some((c) => c.args[0] === "pull" || c.tool === "npx"));
});

test("--yes with a source that never answers: ends within 15 seconds of checking, exit 4", async () => {
  const sockets = [];
  const tcp = createTcpServer((s) => sockets.push(s));
  const port = await listen(tcp);
  const fake = fakeBin(["podman"]);
  try {
    const r = await run(["setup", "--yes", "--images", "x", "--image", `x=127.0.0.1:${port}/rocky:8`, "--engine", "podman"], fakeEnv(fake));
    assert.equal(r.status, 4, r.stdout + r.stderr);
    assert.match(r.stdout, /15초 안에 답 없음/);
    assert.ok(r.ms < 20000, `took ${r.ms} ms`);
  } finally {
    for (const s of sockets) s.destroy();
    tcp.close();
  }
});

test("--yes with reachable sources: pull and verify each image in order, then install the browser and verify", async () => {
  const server = createServer((q, s) => s.end());
  const port = await listen(server);
  const fake = fakeBin(["podman", "npx"]);
  try {
    const argv = ["setup", "--yes", "--images", "a,b", "--image", `a=127.0.0.1:${port}/a:1`, "--image", `b=127.0.0.1:${port}/b:1`, "--browsers", "chromium", "--engine", "podman"];
    const r = await run(argv, fakeEnv(fake, { PLAYWRIGHT_DOWNLOAD_HOST: `http://127.0.0.1:${port}` }));
    const seq = calls(fake).map((c) => `${c.tool} ${c.args.join(" ")}`).filter((s) => !s.endsWith("--version"));
    assert.deepEqual(seq, [
      `podman pull 127.0.0.1:${port}/a:1`, `podman image inspect --format {{.Id}} 127.0.0.1:${port}/a:1`,
      `podman pull 127.0.0.1:${port}/b:1`, `podman image inspect --format {{.Id}} 127.0.0.1:${port}/b:1`,
      "npx --no-install playwright install chromium",
    ]);
    const loaded = await loadPlaywright();
    const chromiumRuns = Boolean(loaded.pw) && (await probeBrowser(loaded.pw, "chromium")).runnable;
    assert.equal(r.status, chromiumRuns ? 0 : 1, r.stdout + r.stderr);
    assert.match(r.stdout, chromiumRuns ? /ok 3, failed 0/ : /failed 1/);
  } finally {
    server.close();
  }
});
