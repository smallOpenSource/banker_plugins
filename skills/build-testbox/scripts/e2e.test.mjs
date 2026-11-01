// End-to-end: real browsers (what runs here) against a 127.0.0.1 server, real containers on the local engine with a
// local Rocky image, both groups at once, SIGINT and SIGHUP clean-up. Expected values come from this environment: a browser
// that cannot start here must end with detect's reason, no engine must end needs-engine. Nothing is downloaded.
// Containers are named banker-testbox-*; none may remain at the end.
import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { probeBrowser } from "./browser-cell.mjs";
import { detectEngines, randomTag, selectEngine } from "./containers.mjs";
import { loadPlaywright, playwrightImage } from "./detect.mjs";
import { tempDir } from "../../../scripts/test-fixtures/testbox-fakes.mjs";

const TESTBOX = fileURLToPath(new URL("./testbox.mjs", import.meta.url));
const PAGES = {
  "/ok": [200, "<!doctype html><title>ok page</title><p>ok</p>"],
  "/throw": [200, "<!doctype html><title>bad</title><script>throw new Error('boom')</script>"],
  "/missing": [404, "<!doctype html><title>404</title>"],
};
const env = {};
let server;
let base;

function rockyImage(engine) {
  const r = spawnSync(engine.bin, ["images", "--format", "{{.Repository}}:{{.Tag}}"], { encoding: "utf8" });
  const names = r.stdout.split("\n").filter((n) => /rockylinux/i.test(n) && !n.includes("<none>"));
  return names.find((n) => n.endsWith(":8")) || names[0] || null;
}

before(async () => {
  server = createServer((q, s) => {
    const [code, body] = PAGES[q.url] || PAGES["/missing"];
    s.writeHead(code, { "content-type": "text/html" }).end(body);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  const loaded = await loadPlaywright();
  env.playwright = loaded.info && !loaded.error ? loaded.info : null;
  env.browsers = {};
  for (const b of ["chromium", "webkit"]) env.browsers[b] = loaded.pw ? await probeBrowser(loaded.pw, b) : { runnable: false, reason: "needs-playwright" };
  env.engine = selectEngine("auto", await detectEngines());
  env.image = env.engine ? rockyImage(env.engine) : null;
});

after(() => server.close());

function run(argv, onChild) {
  return new Promise((resolveRun) => {
    const out = tempDir();
    const child = spawn(process.execPath, [TESTBOX, "run", "--out", out, "--src", tempDir(), ...argv]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    if (onChild) onChild(child);
    child.on("close", (status) => {
      const file = join(out, "results.json");
      resolveRun({ status, stdout, stderr, out, res: existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null });
    });
  });
}

// Why the real-container tests cannot run here, or null: they skip with this reason so the count shows it.
const noContainers = () => (!env.engine ? "컨테이너 엔진 없음(docker, podman)" : !env.image ? "로컬 Rocky 이미지 없음(rockylinux 이미지를 setup --images 로 마련)" : null);
const leftovers = (filter = "banker-testbox") => (env.engine ? spawnSync(env.engine.bin, ["ps", "-a", "--filter", `name=${filter}`, "--format", "{{.Names}}"], { encoding: "utf8" }).stdout.trim() : "");
const isPng = (file) => existsSync(file) && readFileSync(file).subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

test("browsers: runnable browsers pass with PNGs, the rest end with detect's reason, exit is not 0 then", async (t) => {
  const r = await run(["--url", `${base}/ok`, "--os", "none"]);
  assert.equal(r.res.cells.length, 4);
  const allRun = r.res.cells.every((c) => env.browsers[c.browser].runnable);
  assert.equal(r.status, allRun ? 0 : 4, r.stdout);
  // One subtest per browser, so a browser this PC cannot start shows as a skip with its reason.
  for (const browser of ["chromium", "webkit"]) {
    const probe = env.browsers[browser];
    await t.test(browser, (s) => {
      const cells = r.res.cells.filter((c) => c.browser === browser);
      assert.ok(cells.length > 0);
      if (!probe.runnable) {
        for (const c of cells) assert.deepEqual([c.status, c.reason], ["unverified", probe.reason]);
        return s.skip(`${browser} 를 이 PC 에서 못 띄움(${probe.reason}). 그 칸은 사유만 확인`);
      }
      for (const c of cells) {
        assert.equal(c.status, "pass", JSON.stringify(c));
        assert.ok(isPng(c.screenshot), c.screenshot);
        assert.equal(c.title, "ok page");
      }
    });
  }
});

test("browsers: a page that throws is fail(page-error), a 404 is fail(http-404)", async (t) => {
  const runnable = ["chromium", "webkit"].filter((b) => env.browsers[b].runnable);
  if (!runnable.length) return t.skip(`띄울 수 있는 브라우저 없음(chromium ${env.browsers.chromium.reason}, webkit ${env.browsers.webkit.reason})`);
  const thrown = await run(["--url", `${base}/throw`, "--os", "none"]);
  for (const c of thrown.res.cells.filter((x) => runnable.includes(x.browser))) assert.deepEqual([c.status, c.reason], ["fail", "page-error"]);
  assert.equal(thrown.status, runnable.length ? 1 : 4);
  const missing = await run(["--url", `${base}/missing`, "--os", "none", "--devices", "Desktop Chrome"]);
  if (env.browsers.chromium.runnable) assert.deepEqual([missing.res.cells[0].status, missing.res.cells[0].reason], ["fail", "http-404"]);
  else assert.equal(missing.res.cells[0].reason, env.browsers.chromium.reason);
});

function engineDefaultNetwork() {
  const name = `banker-testbox-probe-${randomTag()}`;
  spawnSync(env.engine.bin, ["create", "--name", name, env.image, "true"], { stdio: "ignore" });
  const mode = spawnSync(env.engine.bin, ["inspect", "--format", "{{.HostConfig.NetworkMode}}", name], { encoding: "utf8" }).stdout.trim();
  spawnSync(env.engine.bin, ["rm", "-f", name], { stdio: "ignore" });
  return mode;
}

test("containers: a local Rocky image passes, the screen table equals summary.md, no --url says so", async (t) => {
  const r = await run(["--os", "r", "--image", `r=${env.image || "docker.io/rockylinux/rockylinux:8"}`]);
  const c = r.res.cells[0];
  if (noContainers()) {
    assert.equal(c.reason, env.engine ? "needs-image" : "needs-engine");
    return t.skip(`${noContainers()}. ${c.reason} 사유만 확인`);
  }
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(c.status, "pass");
  assert.match(readFileSync(c.log, "utf8"), /Rocky Linux/);
  assert.equal(c.network, engineDefaultNetwork());
  const md = readFileSync(join(r.out, "summary.md"), "utf8");
  const tableOf = (s) => s.split("\n").filter((l) => l.startsWith("|"));
  assert.deepEqual(tableOf(r.stdout), tableOf(md));
  assert.match(md, /브라우저 묶음 요청 안 됨/);
  assert.equal(r.stdout.split("\n")[0], "pass 1, fail 0, unverified 0, unsupported 0");
});

test("containers: exit 3 is fail(exit-3), an image not here is needs-image (not pulled), a missing command is needs-tool", async (t) => {
  if (noContainers()) return t.skip(noContainers());
  const imagesBefore = spawnSync(env.engine.bin, ["images", "-q"], { encoding: "utf8" }).stdout;
  const ghost = `docker.io/rockylinux/rockylinux:banker-testbox-none-${randomTag()}`;
  const r = await run(["--os", "r,ghost", "--image", `r=${env.image}`, "--image", `ghost=${ghost}`, "--cmd", "exit 3"]);
  assert.equal(r.status, 1);
  assert.deepEqual(r.res.cells.map((c) => [c.status, c.reason]), [["fail", "exit-3"], ["unverified", "needs-image"]]);
  assert.equal(spawnSync(env.engine.bin, ["images", "-q"], { encoding: "utf8" }).stdout, imagesBefore);
  const tool = await run(["--os", "r", "--image", `r=${env.image}`, "--cmd", "no-such-tool-x"]);
  assert.deepEqual([tool.res.cells[0].status, tool.res.cells[0].reason], ["unverified", "needs-tool"]);
  assert.equal(tool.status, 4);
});

test("containers: --timeout 5 with sleep 60 is unverified(timeout) and leaves no container", async (t) => {
  if (noContainers()) return t.skip(noContainers());
  const tag = `to${randomTag()}`;
  const started = Date.now();
  const r = await run(["--os", tag, "--image", `${tag}=${env.image}`, "--timeout", "5", "--cmd", "sleep 60"]);
  assert.deepEqual([r.res.cells[0].status, r.res.cells[0].reason], ["unverified", "timeout"]);
  assert.ok(Date.now() - started < 45000);
  assert.equal(leftovers(tag), "");
});

test("containers: --network none makes name lookup fail and is recorded", async (t) => {
  if (noContainers()) return t.skip(noContainers());
  const r = await run(["--os", "r", "--image", `r=${env.image}`, "--network", "none", "--cmd", "getent hosts example.com"]);
  const c = r.res.cells[0];
  assert.equal(c.status, "fail", JSON.stringify(c));
  assert.match(c.reason, /^exit-\d+$/);
  assert.equal(c.network, "none");
});

test("parallel: two browser cells and two container cells in one run overlap in time", async (t) => {
  const missing = [noContainers(), env.browsers.chromium.runnable ? null : `chromium 못 띄움(${env.browsers.chromium.reason})`].filter(Boolean);
  if (missing.length) return t.skip(missing.join(", "));
  const img = env.image;
  const r = await run(["--url", `${base}/ok`, "--browsers", "chromium", "--devices", "Desktop Chrome,Pixel 7", "--os", "a,b", "--image", `a=${img}`, "--image", `b=${img}`, "--cmd", "sleep 3; cat /etc/os-release"]);
  assert.equal(r.res.cells.length, 4);
  const span = (g) => {
    const cs = r.res.cells.filter((c) => c.group === g);
    return [Math.min(...cs.map((c) => Date.parse(c.startedAt))), Math.max(...cs.map((c) => Date.parse(c.endedAt)))];
  };
  const [bs, be] = span("browser");
  const [os, oe] = span("os");
  assert.ok(bs < oe && os < be, `browser ${bs}-${be}, os ${os}-${oe}`);
  assert.equal(r.status, 0, r.stdout);
});

for (const [sig, code] of [["SIGINT", 130], ["SIGHUP", 129]]) {
  test(`${sig} during a run removes the containers it made`, async (t) => {
    if (noContainers()) return t.skip(noContainers());
    if (sig === "SIGHUP" && process.platform === "win32") return t.skip("Windows: 프로세스에 SIGHUP 을 보낼 수 없음(OS 고유)");
    const tag = `sig${randomTag()}`;
    let seen = false;
    const r = await run(["--os", tag, "--image", `${tag}=${env.image}`, "--cmd", "sleep 60"], (child) => {
      const poll = setInterval(() => {
        if (leftovers(tag)) { seen = true; clearInterval(poll); setTimeout(() => child.kill(sig), 500); }
      }, 300);
      child.on("close", () => clearInterval(poll));
    });
    assert.ok(seen, "the container appeared");
    assert.equal(r.status, code, r.stderr);
    assert.match(r.stderr, /지우고 멈춤/);
    assert.equal(leftovers(tag), "");
  });
}

test("--browser-in-container on the real engine: without the official image it is needs-image", async (t) => {
  const r = await run(["--url", `${base}/ok`, "--browser-in-container", "--os", "none", "--devices", "Desktop Chrome"]);
  const c = r.res.cells[0];
  if (!env.playwright) {
    assert.equal(c.reason, "needs-playwright");
    return t.skip("Playwright 없음. needs-playwright 사유만 확인");
  }
  if (!env.engine) {
    assert.equal(c.reason, "needs-engine");
    return t.skip("컨테이너 엔진 없음(docker, podman). needs-engine 사유만 확인");
  }
  const image = playwrightImage(env.playwright.version);
  const present = spawnSync(env.engine.bin, ["image", "inspect", image], { stdio: "ignore" }).status === 0;
  if (present) return assert.equal(c.status, "pass", JSON.stringify(c));
  assert.deepEqual([c.status, c.reason], ["unverified", "needs-image"]);
  assert.match(c.hint, /setup --playwright-image/);
});

test("no banker-testbox container remains", () => {
  assert.equal(leftovers(), "");
});
