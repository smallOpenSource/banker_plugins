// Unit tests with fake executables: engine choice, error reasons, an engine permission error (sandbox), the macOS
// judgment (non-Apple, Intel Mac, fake tart), source copy selection.
import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parseArgs } from "./args.mjs";
import { engineReason, macosCell, rmArgs, runContainerCell, selectEngine, sourceFiles, startOutcome } from "./containers.mjs";
import { calls, fakeBin, fakeEnv, tempDir } from "../../../scripts/test-fixtures/testbox-fakes.mjs";

const TESTBOX = fileURLToPath(new URL("./testbox.mjs", import.meta.url));

const ENGINES = {
  none: { docker: { present: false }, podman: { present: false } },
  emu: { docker: { present: true, path: "/d", podmanEmulation: true }, podman: { present: true, path: "/p" } },
  real: { docker: { present: true, path: "/d", podmanEmulation: false }, podman: { present: true, path: "/p" } },
  emuOnly: { docker: { present: true, path: "/d", podmanEmulation: true }, podman: { present: false } },
};

test("engine choice: real docker, then podman, then emulated docker", () => {
  assert.equal(selectEngine("auto", ENGINES.none), null);
  assert.deepEqual(selectEngine("auto", ENGINES.emu), { name: "podman", bin: "/p", kind: "podman" });
  assert.deepEqual(selectEngine("auto", ENGINES.real), { name: "docker", bin: "/d", kind: "docker" });
  assert.deepEqual(selectEngine("auto", ENGINES.emuOnly), { name: "docker", bin: "/d", kind: "podman" });
  assert.deepEqual(selectEngine("docker", ENGINES.emu), { name: "docker", bin: "/d", kind: "podman" });
  assert.equal(selectEngine("podman", ENGINES.emuOnly), null);
  assert.deepEqual(rmArgs({ kind: "podman" }, "n"), ["rm", "-f", "-t", "0", "n"]);
  assert.deepEqual(rmArgs({ kind: "docker" }, "n"), ["rm", "-f", "n"]);
});

test("engine error reasons and start outcomes", () => {
  assert.equal(engineReason("Got permission denied while trying to connect to the Docker daemon socket"), "sandbox");
  assert.equal(engineReason("Error: operation not permitted"), "sandbox");
  assert.equal(engineReason("Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?"), "needs-engine");
  assert.equal(engineReason("Error: x: image not known"), null);
  assert.deepEqual(startOutcome({ code: 0 }), ["pass", ""]);
  assert.deepEqual(startOutcome({ code: 3, out: "" }), ["fail", "exit-3"]);
  assert.deepEqual(startOutcome({ code: 127, out: "" }), ["unverified", "needs-tool"]);
  assert.deepEqual(startOutcome({ code: null, timedOut: true }), ["unverified", "timeout"]);
  assert.deepEqual(startOutcome({ code: null, error: "ENOENT" }), ["unverified", "launch-failed"]);
  assert.deepEqual(startOutcome({ code: 125, out: "Error: permission denied" }), ["unverified", "sandbox"]);
});

test("no engine: needs-engine", async () => {
  const ctx = { o: parseArgs(["run", "--os", "rocky8"]), engine: null, env: process.env, out: tempDir(), tracker: { containers: new Set(), temps: new Set() } };
  const c = await runContainerCell(ctx, "rocky8");
  assert.equal(c.status, "unverified");
  assert.equal(c.reason, "needs-engine");
});

test("engine permission error (fake engine): unverified(sandbox) with the approval hint, exit 4", () => {
  const fake = fakeBin(["podman"]);
  const out = tempDir();
  const r = spawnSync(process.execPath, [TESTBOX, "run", "--engine", "podman", "--os", "rocky8", "--out", out, "--src", tempDir()], { env: fakeEnv(fake, { FAKE_MODE: "denied" }), encoding: "utf8" });
  assert.equal(r.status, 4, r.stderr);
  const res = JSON.parse(readFileSync(join(out, "results.json"), "utf8"));
  assert.equal(res.cells[0].status, "unverified");
  assert.equal(res.cells[0].reason, "sandbox");
  assert.match(res.cells[0].hint, /승인/);
  assert.match(r.stdout, /^pass 0, fail 0, unverified 1, unsupported 0/);
});

test("missing image (fake engine): needs-image and no pull, no create", () => {
  const fake = fakeBin(["podman"]);
  const out = tempDir();
  const r = spawnSync(process.execPath, [TESTBOX, "run", "--engine", "podman", "--os", "rocky9", "--out", out, "--src", tempDir()], { env: fakeEnv(fake, { FAKE_MODE: "missing" }), encoding: "utf8" });
  assert.equal(r.status, 4, r.stderr);
  const res = JSON.parse(readFileSync(join(out, "results.json"), "utf8"));
  assert.equal(res.cells[0].reason, "needs-image");
  const verbs = calls(fake).map((c) => c.args[0]);
  assert.ok(!verbs.includes("pull") && !verbs.includes("create"), verbs.join(","));
});

test("SIGHUP during a run (fake engine) removes the container it made and exits 129", { skip: process.platform === "win32" && "Windows: 프로세스에 SIGHUP 을 보낼 수 없음(OS 고유)" }, async () => {
  const fake = fakeBin(["podman"]);
  const argv = [TESTBOX, "run", "--engine", "podman", "--os", "rocky8", "--out", tempDir(), "--src", tempDir()];
  const child = spawn(process.execPath, argv, { env: fakeEnv(fake, { FAKE_MODE: "hang" }) });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  const status = await new Promise((done) => {
    const poll = setInterval(() => {
      if (calls(fake).some((c) => c.args[0] === "start")) { clearInterval(poll); setTimeout(() => child.kill("SIGHUP"), 300); }
    }, 100);
    child.on("close", (code) => { clearInterval(poll); done(code); });
  });
  assert.equal(status, 129, stderr);
  assert.match(stderr, /^SIGHUP: 만든 컨테이너 1개를 지우고 멈춤$/m);
  const log = calls(fake);
  const name = log.find((c) => c.args[0] === "create").args[2];
  assert.ok(log.some((c) => c.args[0] === "rm" && c.args.includes(name)), JSON.stringify(log.map((c) => c.args.slice(0, 2))));
});

function macCtx(host, args = [], extra = {}) {
  const fake = fakeBin(["tart"]);
  const env = { ...fakeEnv(fake, extra), PATH: fake.dir, Path: fake.dir };
  return { fake, ctx: { host, o: parseArgs(["run", "--os", "macos", ...args]), env, out: tempDir() } };
}

test("macOS: non-Apple host is unsupported(apple-sla), an Intel Mac is unsupported(tart-needs-apple-silicon)", async () => {
  for (const platform of ["linux", "win32"]) {
    const { ctx, fake } = macCtx({ platform, arch: "x64" });
    const c = await macosCell(ctx);
    assert.deepEqual([c.status, c.reason], ["unsupported", "apple-sla"]);
    assert.equal(calls(fake).length, 0);
  }
  const { ctx, fake } = macCtx({ platform: "darwin", arch: "x64", appleSilicon: false, hwModel: "MacPro7,1" });
  const c = await macosCell(ctx);
  assert.deepEqual([c.status, c.reason], ["unsupported", "tart-needs-apple-silicon"]);
  assert.equal(calls(fake).length, 0, "Tart is not tried on an Intel Mac");
});

test("macOS on Apple Silicon: needs-tart, needs-vm, tart-exec-unsupported, a run", async () => {
  const host = { platform: "darwin", arch: "arm64", appleSilicon: true };
  const none = macCtx(host);
  none.ctx.env = { ...none.ctx.env, PATH: tempDir(), Path: undefined };
  assert.equal((await macosCell(none.ctx)).reason, "needs-tart");
  assert.equal((await macosCell(macCtx(host).ctx)).reason, "needs-vm");
  assert.equal((await macosCell(macCtx(host, ["--tart-vm", "other"], { FAKE_TART_VMS: "sequoia" }).ctx)).reason, "needs-vm");
  assert.equal((await macosCell(macCtx(host, [], { FAKE_TART_VMS: "sequoia", FAKE_MODE: "noexec" }).ctx)).reason, "tart-exec-unsupported");
  const ok = macCtx(host, ["--cmd", "sw_vers"], { FAKE_TART_VMS: "sequoia" });
  const c = await macosCell(ok.ctx);
  assert.deepEqual([c.status, c.vm], ["pass", "sequoia"]);
  assert.deepEqual(calls(ok.fake).at(-1).args, ["exec", "sequoia", "--", "sh", "-c", "sw_vers"]);
  assert.match(readFileSync(c.log, "utf8"), /tart ran/);
  const bad = await macosCell(macCtx(host, [], { FAKE_TART_VMS: "sequoia", FAKE_EXIT: "3" }).ctx);
  assert.deepEqual([bad.status, bad.reason], ["fail", "exit-3"]);
});

function git(dir, ...args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k)));
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
}

test("source copy: a git checkout gives tracked and untracked-not-ignored files", () => {
  const dir = tempDir();
  git(dir, "init", "-q");
  writeFileSync(join(dir, ".gitignore"), "ignored.txt\nnode_modules/\n");
  writeFileSync(join(dir, "tracked.txt"), "t");
  writeFileSync(join(dir, "ignored.txt"), "i");
  writeFileSync(join(dir, "new.txt"), "n");
  mkdirSync(join(dir, "node_modules"));
  writeFileSync(join(dir, "node_modules", "m.js"), "m");
  mkdirSync(join(dir, ".testbox", "run1"), { recursive: true });
  writeFileSync(join(dir, ".testbox", "run1", "results.json"), "{}");
  git(dir, "add", "tracked.txt", ".gitignore");
  assert.deepEqual(sourceFiles(dir, join(dir, ".testbox", "run1")).sort(), [".gitignore", "new.txt", "tracked.txt"]);
});

test("source copy: a plain folder gives all but node_modules, .git, .testbox and the result folder", () => {
  const dir = tempDir();
  for (const d of ["src", "node_modules/x", ".git", ".testbox", "out"]) mkdirSync(join(dir, d), { recursive: true });
  for (const f of ["a.txt", "src/b.txt", "node_modules/x/c.js", ".git/HEAD", ".testbox/r.json", "out/o.txt"]) writeFileSync(join(dir, f), "x");
  assert.deepEqual(sourceFiles(dir, join(dir, "out")).sort(), ["a.txt", "src/b.txt"]);
});

test("a result folder that cannot be made is exit 3", () => {
  const fake = fakeBin(["podman"]);
  const file = join(tempDir(), "not-a-dir");
  writeFileSync(file, "x");
  const r = spawnSync(process.execPath, [TESTBOX, "run", "--engine", "podman", "--os", "rocky8", "--out", join(file, "sub")], { env: fakeEnv(fake, { FAKE_MODE: "missing" }), encoding: "utf8" });
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stderr, /내부 오류/);
});
