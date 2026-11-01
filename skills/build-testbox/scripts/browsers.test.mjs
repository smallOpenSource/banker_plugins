// Unit tests: launch error reasons, pass rule, result merge, --browser-in-container steps with a fake engine.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { classifyLaunchError, judge, pool } from "./browser-cell.mjs";
import { containerUrl, copySteps, mergeResults, parseResult } from "./browsers.mjs";
import { locatePlaywright } from "./detect.mjs";
import { calls, fakeBin, fakeEnv, tempDir } from "../../../scripts/test-fixtures/testbox-fakes.mjs";

const TESTBOX = fileURLToPath(new URL("./testbox.mjs", import.meta.url));

test("launch error reasons", () => {
  assert.equal(classifyLaunchError("browserType.launch: Executable doesn't exist at /x/webkit-2248/pw_run.sh"), "needs-browser");
  assert.equal(classifyLaunchError("browserType.launch: Host system is missing dependencies to run browsers."), "host-deps");
  assert.equal(classifyLaunchError("error while loading shared libraries: libgstreamer-1.0.so.0: cannot open shared object file"), "host-deps");
  assert.equal(classifyLaunchError("spawn /x/chrome EACCES"), "sandbox");
  assert.equal(classifyLaunchError("browserType.launch: Timeout 30000ms exceeded."), "timeout");
  assert.equal(classifyLaunchError("Target page, context or browser has been closed"), "launch-failed");
});

test("pass rule: 2xx or 3xx (or a file URL without response) and no page error", () => {
  assert.deepEqual(judge(200, 0), ["pass", ""]);
  assert.deepEqual(judge(304, 0), ["pass", ""]);
  assert.deepEqual(judge(null, 0), ["pass", ""]);
  assert.deepEqual(judge(404, 0), ["fail", "http-404"]);
  assert.deepEqual(judge(500, 2), ["fail", "http-500"]);
  assert.deepEqual(judge(200, 1), ["fail", "page-error"]);
});

test("pool runs at most jobs at once and keeps order", async () => {
  let live = 0;
  let peak = 0;
  const out = await pool([1, 2, 3, 4, 5], 2, async (n) => {
    live += 1; peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 20));
    live -= 1;
    return n * 10;
  });
  assert.deepEqual(out, [10, 20, 30, 40, 50]);
  assert.equal(peak, 2);
});

test("result merge: a cell the child never reported is timeout or launch-failed", () => {
  const cells = [{ id: "browser:A", group: "browser", target: "A", device: "A", browser: "chromium", png: "a.png" }, { id: "browser:B", group: "browser", target: "B", device: "B", browser: "chromium", png: "b.png" }];
  const now = new Date().toISOString();
  const stdout = `noise\nBANKER_TESTBOX_RESULT ${JSON.stringify({ cells: [{ id: "browser:A", status: "pass", reason: "", startedAt: now, endedAt: now, screenshot: "a.png" }] })}\n`;
  assert.ok(parseResult(stdout).cells);
  const merged = mergeResults(cells, { stdout, timedOut: true }, { out: "/o", log: "/o/browser.log" });
  assert.deepEqual(merged.map((c) => [c.status, c.reason]), [["pass", ""], ["unverified", "timeout"]]);
  assert.equal(merged[0].screenshot, join("/o", "a.png"));
  const crashed = mergeResults(cells, { stdout: "", stderr: "boom", timedOut: false }, { out: "/o" });
  assert.ok(crashed.every((c) => c.reason === "launch-failed"));
  const fatal = mergeResults(cells, { stdout: `BANKER_TESTBOX_RESULT ${JSON.stringify({ fatal: "needs-playwright", detail: "x" })}` }, { out: "/o" });
  assert.ok(fatal.every((c) => c.reason === "needs-playwright"));
});

test("container URL: Linux keeps loopback (--network host), others use the engine's host name", () => {
  assert.equal(containerUrl("http://127.0.0.1:8080/a", { kind: "podman" }, "linux"), "http://127.0.0.1:8080/a");
  assert.equal(containerUrl("http://127.0.0.1:8080/a", { kind: "podman" }, "darwin"), "http://host.containers.internal:8080/a");
  assert.equal(containerUrl("http://localhost:8080/a", { kind: "docker" }, "win32"), "http://host.docker.internal:8080/a");
  assert.equal(containerUrl("https://example.com/", { kind: "docker" }, "darwin"), "https://example.com/");
});

test("copy steps put both playwright and playwright-core", () => {
  const steps = copySteps("/stage", { dir: "/g/playwright", coreDir: "/g/playwright/node_modules/playwright-core" }, "n");
  assert.deepEqual(steps.map((s) => s[2]), ["n:/tb", "n:/tb/node_modules/playwright", "n:/tb/node_modules/playwright-core"]);
});

function runInFakeContainer(mode) {
  const fake = fakeBin(["podman"]);
  const out = tempDir();
  const argv = [TESTBOX, "run", "--url", "http://127.0.0.1:9/", "--browser-in-container", "--os", "none", "--engine", "podman", "--image", "playwright=localhost/fake-playwright:1", "--out", out];
  const r = spawnSync(process.execPath, argv, { env: fakeEnv(fake, { FAKE_MODE: mode }), encoding: "utf8" });
  return { fake, out, r, res: JSON.parse(readFileSync(join(out, "results.json"), "utf8")) };
}

test("--browser-in-container (fake engine): cp puts playwright and playwright-core, cells run in the container", (t) => {
  const loc = locatePlaywright();
  const { fake, r, res } = runInFakeContainer("ok");
  if (loc.error) {
    assert.ok(res.cells.every((c) => c.reason === "needs-playwright"), "no Playwright here: every cell needs-playwright");
    return t.skip("Playwright 없음. needs-playwright 사유만 확인");
  }
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const log = calls(fake).filter((c) => c.tool === "podman");
  const cps = log.filter((c) => c.args[0] === "cp" && c.args[2] && c.args[2].includes(":/tb"));
  assert.ok(cps.some((c) => c.args[1] === loc.info.dir && c.args[2].endsWith(":/tb/node_modules/playwright")));
  assert.ok(cps.some((c) => c.args[1] === loc.info.coreDir && c.args[2].endsWith(":/tb/node_modules/playwright-core")));
  const create = log.find((c) => c.args[0] === "create").args;
  assert.ok(create.includes("localhost/fake-playwright:1"));
  if (process.platform === "linux") assert.deepEqual(create.slice(create.indexOf("--network"), create.indexOf("--network") + 2), ["--network", "host"]);
  assert.ok(log.some((c) => c.args[0] === "rm"), "the container is removed");
  assert.ok(res.cells.length >= 1 && res.cells.every((c) => c.status === "pass" && c.where === "container"));
});

test("--browser-in-container (fake engine): missing image is needs-image with the setup --playwright-image hint", (t) => {
  const { fake, r, res } = runInFakeContainer("missing");
  if (locatePlaywright().error) {
    assert.ok(res.cells.every((c) => c.reason === "needs-playwright"));
    return t.skip("Playwright 없음. needs-playwright 사유만 확인");
  }
  assert.equal(r.status, 4);
  assert.ok(res.cells.every((c) => c.reason === "needs-image" && /--playwright-image/.test(c.hint)));
  assert.ok(!calls(fake).some((c) => ["pull", "create"].includes(c.args[0])));
});
