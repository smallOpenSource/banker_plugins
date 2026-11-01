// detect --json against values this test finds on its own: the Playwright package.json, a real headless start, the
// engine rule, `<engine> image inspect`. The local image list is the same before and after (nothing downloaded).
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { which } from "./proc.mjs";

const TESTBOX = fileURLToPath(new URL("./testbox.mjs", import.meta.url));

function npmRoot() {
  const opts = { encoding: "utf8", cwd: homedir() };
  const r = process.platform === "win32" ? spawnSync("npm.cmd root -g", { ...opts, shell: true }) : spawnSync("npm", ["root", "-g"], opts);
  return String(r.stdout || "").trim();
}

function ownPlaywright() {
  const dir = join(npmRoot(), "playwright");
  try {
    return { dir, version: JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version };
  } catch {
    return null;
  }
}

async function startsHeadless(dir, name) {
  const mod = await import(pathToFileURL(join(dir, "index.mjs")).href);
  const pw = mod.chromium ? mod : mod.default;
  for (const opts of name === "chromium" ? [{}, { channel: "chromium" }] : [{}]) {
    try {
      const b = await pw[name].launch({ ...opts, timeout: 30000 });
      await b.close();
      return true;
    } catch { /* next build */ }
  }
  return false;
}

function ownEngine() {
  const docker = which("docker");
  const podman = which("podman");
  const emu = docker ? /podman/i.test(`${spawnSync(docker, ["--version"], { encoding: "utf8" }).stdout}`) : false;
  if (docker && !emu) return { name: "docker", bin: docker };
  if (podman) return { name: "podman", bin: podman };
  return docker ? { name: "docker", bin: docker } : null;
}

const imageList = (engine) => (engine ? spawnSync(engine.bin, ["images", "-q", "--no-trunc"], { encoding: "utf8" }).stdout.split("\n").filter(Boolean).sort() : []);

test("detect --json matches independently found values and downloads nothing", async () => {
  const engine = ownEngine();
  const before = imageList(engine);
  const r = spawnSync(process.execPath, [TESTBOX, "detect", "--json"], { encoding: "utf8", cwd: homedir() });
  assert.equal(r.status, 0, r.stderr);
  const d = JSON.parse(r.stdout);
  const pw = ownPlaywright();
  assert.equal(d.playwright.found, Boolean(pw));
  if (pw) assert.equal(d.playwright.version, pw.version);
  for (const name of ["chromium", "webkit"]) {
    const expected = pw ? await startsHeadless(pw.dir, name) : false;
    assert.equal(d.browsers[name].runnable, expected, `${name}: ${d.browsers[name].reason || ""}`);
    if (!expected) assert.match(d.browsers[name].reason, /^(needs-playwright|needs-browser|host-deps|launch-failed|sandbox|timeout)$/);
  }
  assert.equal(d.engine ? d.engine.name : null, engine ? engine.name : null);
  for (const [key, img] of Object.entries(d.images)) {
    const present = engine ? spawnSync(engine.bin, ["image", "inspect", img.image], { stdio: "ignore" }).status === 0 : false;
    assert.equal(img.present, present, `${key} ${img.image}`);
  }
  if (process.platform !== "darwin") assert.equal(d.tart.reason, "apple-sla");
  assert.deepEqual(imageList(engine), before, "no image was pulled");
});

test("detect text output and --help first line", () => {
  const help = spawnSync(process.execPath, [TESTBOX, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout.split("\n")[0], /^build-testbox: /);
  const none = spawnSync(process.execPath, [TESTBOX], { encoding: "utf8" });
  assert.equal(none.status, 2);
  const bad = spawnSync(process.execPath, [TESTBOX, "run", "--jobs", "0"], { encoding: "utf8" });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /--jobs/);
  const text = spawnSync(process.execPath, [TESTBOX, "detect"], { encoding: "utf8", cwd: homedir() });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /^호스트: /);
  assert.match(text.stdout, /- chromium: /);
  assert.match(text.stdout, /엔진: /);
});
