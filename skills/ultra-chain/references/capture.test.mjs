// Tests for capture.mjs. Run from the repo root: node --test skills/ultra-chain/references/capture.test.mjs
// No browser: a fake Playwright records what the script asks for and writes a dummy PNG.
import { test, after } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { UsageError, main, parseArgs, toUrl } from "./capture.mjs";

const tmp = mkdtempSync(join(tmpdir(), "capture-test-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
const page = join(tmp, "mock.html");
writeFileSync(page, "<!doctype html><title>mock</title>");
const sink = () => ({ text: "", write(s) { this.text += s; } });

// A fake playwright module. failOn: a URL substring whose goto throws. launchFails: chromium.launch throws.
function fakePlaywright({ failOn = null, launchFails = false } = {}) {
  const seen = { viewports: [], gotos: [], closed: 0 };
  const newPage = async ({ viewport }) => {
    seen.viewports.push(viewport);
    return {
      goto: async (url) => { seen.gotos.push(url); if (failOn && url.includes(failOn)) throw new Error("net::ERR_CONNECTION_REFUSED\nmore"); },
      waitForTimeout: async () => {},
      screenshot: async ({ path }) => writeFileSync(path, "PNG"),
      close: async () => {},
    };
  };
  const chromium = { launch: async () => {
    if (launchFails) throw new Error("Executable doesn't exist at /x/chrome\nhint");
    return { newPage, close: async () => { seen.closed++; } };
  } };
  return { seen, load: async () => ({ chromium }) };
}

test("parseArgs reads options and named targets, and refuses what it cannot write safely", () => {
  const o = parseArgs(["--out", "v", "--viewport", "390x844", "--full", "--wait", "0", "mock-home=a.html", "actual-home=http://127.0.0.1:5/"]);
  assert.deepEqual(o.viewport, { width: 390, height: 844 });
  assert.equal(o.full, true);
  assert.equal(o.wait, 0);
  assert.deepEqual(o.targets.map((t) => t.name), ["mock-home", "actual-home"]);
  const bad = [[], ["--out", "v"], ["a=b.html"], ["--out", "v", "../x=b.html"], ["--out", "v", "a/b=c.html"], ["--out", "v", "=c.html"],
    ["--out", "v", "--viewport", "big", "a=b"], ["--out", "v", "--wait", "-1", "a=b"], ["--out", "v", "a=b", "a=c"], ["--out", "v", "--x", "a=b"], ["--out"]];
  for (const argv of bad) assert.throws(() => parseArgs(argv), UsageError, JSON.stringify(argv));
});

test("toUrl takes http(s) URLs and existing local files only", () => {
  assert.equal(toUrl("http://127.0.0.1:8080/mock/"), "http://127.0.0.1:8080/mock/");
  assert.equal(toUrl(page), pathToFileURL(page).href);
  for (const bad of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", join(tmp, "missing.html"), tmp]) {
    assert.throws(() => toUrl(bad), UsageError, bad);
  }
});

test("main writes one PNG per target with the viewport asked for, and closes the browser", async () => {
  const out = join(tmp, "shots");
  const fake = fakePlaywright();
  const o = sink();
  const code = await main(["--out", out, "--viewport", "640x480", `mock=${page}`, "app=http://127.0.0.1:9/"], o, sink(), fake.load);
  assert.equal(code, 0);
  const results = JSON.parse(o.text);
  assert.deepEqual(results.map((r) => [r.name, r.ok]), [["mock", true], ["app", true]]);
  assert.ok(existsSync(join(out, "mock.png")) && readFileSync(join(out, "app.png"), "utf8") === "PNG");
  assert.deepEqual(fake.seen.viewports, [{ width: 640, height: 480 }, { width: 640, height: 480 }]);
  assert.equal(fake.seen.gotos[0], pathToFileURL(page).href);
  assert.equal(fake.seen.closed, 1);
});

test("a target that fails is reported and the others still run; exit 1", async () => {
  const fake = fakePlaywright({ failOn: "127.0.0.1:9" });
  const o = sink();
  const code = await main(["--out", join(tmp, "partial"), "down=http://127.0.0.1:9/", `mock=${page}`], o, sink(), fake.load);
  assert.equal(code, 1);
  const [down, mock] = JSON.parse(o.text);
  assert.equal(down.ok, false);
  assert.equal(down.error, "net::ERR_CONNECTION_REFUSED");
  assert.equal(mock.ok, true);
});

test("missing Playwright or browser exits 3 with an install hint; usage errors exit 2", async () => {
  const err = sink();
  const missing = async () => { throw new (await import("./capture.mjs")).NoBrowserError("playwright 패키지가 없습니다."); };
  assert.equal(await main(["--out", join(tmp, "x"), `m=${page}`], sink(), err, missing), 3);
  assert.match(err.text, /playwright/);
  const err2 = sink();
  assert.equal(await main(["--out", join(tmp, "y"), `m=${page}`], sink(), err2, fakePlaywright({ launchFails: true }).load), 3);
  assert.match(err2.text, /npx playwright install chromium/);
  assert.equal(await main(["--out", join(tmp, "z")], sink(), sink(), fakePlaywright().load), 2);
  assert.equal(await main(["--out", join(tmp, "z"), "m=javascript:alert(1)"], sink(), sink(), fakePlaywright().load), 2);
});

test("--check starts and closes the browser without capturing; exit 3 when it cannot", async () => {
  const fake = fakePlaywright();
  const o = sink();
  assert.equal(await main(["--check"], o, sink(), fake.load), 0);
  assert.deepEqual(JSON.parse(o.text), { playwright: true, browser: true });
  assert.equal(fake.seen.closed, 1);
  assert.deepEqual(fake.seen.gotos, []);
  assert.equal(await main(["--check"], sink(), sink(), fakePlaywright({ launchFails: true }).load), 3);
  assert.equal(await main(["--check", "--out", "x"], sink(), sink(), fake.load), 2);
  assert.equal(await main(["--check", `m=${page}`], sink(), sink(), fake.load), 2);
});

test("URLs are loopback-only unless --allow-remote; network paths, bad URLs and tiny viewports are refused", async () => {
  assert.equal(toUrl("http://localhost:5173/login"), "http://localhost:5173/login");
  assert.equal(toUrl("http://[::1]:8080/"), "http://[::1]:8080/");
  assert.throws(() => toUrl("https://example.com/"), /--allow-remote/);
  assert.equal(toUrl("https://example.com/", process.cwd(), true), "https://example.com/");
  for (const bad of ["\\\\server\\share\\a.html", "//server/share/a.html", "http://"]) assert.throws(() => toUrl(bad), UsageError, bad);
  for (const mixed of [String.raw`\/server/share/a.html`, String.raw`/\server\share\a.html`]) assert.throws(() => toUrl(mixed), /네트워크 경로/, mixed);
  for (const v of ["00x00", "99x800", "1280x10001"]) assert.throws(() => parseArgs(["--out", "o", "--viewport", v, "a=b"]), UsageError, v);
  const fake = fakePlaywright();
  assert.equal(await main(["--out", join(tmp, "r"), "--allow-remote", "app=https://example.com/"], sink(), sink(), fake.load), 0);
  assert.equal(await main(["--out", join(tmp, "r2"), "app=https://example.com/"], sink(), sink(), fake.load), 2);
});
