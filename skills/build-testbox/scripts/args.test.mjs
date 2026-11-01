// Unit tests: argument parsing, loopback rule, device planning against a fake playwright.devices.
import { strict as assert } from "node:assert";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_IMAGES, UsageError, imageFor, parseArgs, toUrl } from "./args.mjs";
import { DEFAULT_DEVICES, planBrowserCells, slug } from "./browsers.mjs";
import { tempDir } from "../../../scripts/test-fixtures/testbox-fakes.mjs";

const usage = (argv, re) => assert.throws(() => parseArgs(argv), (e) => e instanceof UsageError && (!re || re.test(e.message)));

test("run defaults", () => {
  const o = parseArgs(["run"]);
  assert.deepEqual(o.os, ["rocky8", "rocky9"]);
  assert.deepEqual(o.browsers, ["chromium", "webkit"]);
  assert.equal(o.cmd, "cat /etc/os-release");
  assert.equal(o.engine, "auto");
  assert.equal(o.network, null);
  assert.equal(o.timeout, 300);
  assert.ok(o.jobs >= 1 && o.jobs <= 4);
  assert.equal(o.url, null);
  assert.equal(imageFor(o, "rocky8"), DEFAULT_IMAGES.rocky8);
  assert.equal(imageFor(o, "rocky9"), "docker.io/rockylinux/rockylinux:9");
});

test("run options parse", () => {
  const o = parseArgs(["run", "--url", "http://127.0.0.1:8080/x", "--browsers", "chromium", "--devices", "Desktop Chrome,Pixel 7",
    "--os", "rocky8,mine", "--image", "mine=localhost/mine:1", "--cmd", "exit 3", "--network", "none", "--jobs", "2", "--timeout", "5",
    "--engine", "podman", "--json", "--tart-vm", "vm-1"]);
  assert.equal(o.url, "http://127.0.0.1:8080/x");
  assert.deepEqual(o.browsers, ["chromium"]);
  assert.deepEqual(o.devices, ["Desktop Chrome", "Pixel 7"]);
  assert.equal(imageFor(o, "mine"), "localhost/mine:1");
  assert.equal(o.network, "none");
  assert.equal(o.jobs, 2);
  assert.equal(o.timeout, 5);
  assert.equal(o.engine, "podman");
  assert.equal(o.json, true);
  assert.equal(o.tartVm, "vm-1");
  assert.deepEqual(parseArgs(["run", "--url", "http://localhost:1/", "--os", "none"]).os, []);
});

test("usage errors", () => {
  usage([], /하위 명령/);
  usage(["nope"], /하위 명령/);
  usage(["run", "--jobs", "0"], /--jobs/);
  usage(["run", "--timeout", "x"], /--timeout/);
  usage(["run", "--network", "macvlan"], /--network/);
  usage(["run", "--engine", "lxc"], /--engine/);
  usage(["run", "--browsers", "firefox", "--url", "http://127.0.0.1/"], /--browsers/);
  usage(["run", "--os", "Rocky"], /--os/);
  usage(["run", "--os", "custom"], /--image custom=/);
  usage(["run", "--image", "rocky8"], /--image/);
  usage(["run", "--image", "rocky8=-bad"], /--image/);
  usage(["run", "--cmd"], /값이 필요/);
  usage(["run", "--devices", "Pixel 7"], /--url/);
  usage(["run", "--os", "none"], /돌릴 칸이 없습니다/);
  usage(["run", "--devices", "Pixel 7,Pixel 7", "--url", "http://127.0.0.1/"], /같은 기기/);
  usage(["detect", "--cmd", "x"], /쓸 수 없는/);
  usage(["setup", "--images", "macos"], /macOS/);
  usage(["run", "--tart-vm", "a b"], /--tart-vm/);
  usage(["run", "--browser-in-container", "--url", "./missing-file.html"], /파일이 없습니다/);
});

test("loopback rule and local files", () => {
  assert.equal(toUrl("http://localhost:3000/a"), "http://localhost:3000/a");
  assert.equal(toUrl("http://[::1]:3000/"), "http://[::1]:3000/");
  assert.throws(() => toUrl("http://example.com/"), /--allow-remote/);
  assert.equal(toUrl("https://example.com/", true), "https://example.com/");
  assert.throws(() => toUrl("http://10.0.0.1/"), /--allow-remote/);
  assert.throws(() => toUrl("javascript:alert(1)"), /로컬 파일만/);
  assert.throws(() => toUrl("//host/share/x.html"), /네트워크 경로/);
  const dir = tempDir();
  writeFileSync(join(dir, "p.html"), "<title>p</title>");
  assert.match(toUrl("p.html", false, dir), /^file:\/\//);
  usage(["run", "--browser-in-container", "--url", join(dir, "p.html")], /http, https URL 만/);
});

const FAKE_DEVICES = {
  "Desktop Chrome": { defaultBrowserType: "chromium" },
  "Pixel 7": { defaultBrowserType: "chromium" },
  "Desktop Safari": { defaultBrowserType: "webkit" },
  "iPhone 15": { defaultBrowserType: "webkit" },
  "Desktop Firefox": { defaultBrowserType: "firefox" },
};

test("device planning: defaults follow defaultBrowserType", () => {
  const cells = planBrowserCells(parseArgs(["run", "--url", "http://127.0.0.1/"]), FAKE_DEVICES);
  assert.deepEqual(cells.map((c) => c.device), DEFAULT_DEVICES);
  assert.deepEqual(cells.map((c) => c.browser), ["chromium", "chromium", "webkit", "webkit"]);
  assert.ok(cells.every((c) => !c.preset));
  assert.equal(cells[0].png, "browser-desktop-chrome.png");
  assert.equal(slug("iPhone 15 Pro Max"), "iphone-15-pro-max");
});

test("device planning: --browsers filters, unknown device is unknown-device, firefox is refused", () => {
  const only = planBrowserCells(parseArgs(["run", "--url", "http://127.0.0.1/", "--browsers", "webkit"]), FAKE_DEVICES);
  assert.deepEqual(only.map((c) => c.device), ["Desktop Safari", "iPhone 15"]);
  const unknown = planBrowserCells(parseArgs(["run", "--url", "http://127.0.0.1/", "--devices", "Pixel 7,Nokia 3310"]), FAKE_DEVICES);
  assert.equal(unknown[1].preset, "unknown-device");
  assert.equal(unknown[1].id, "browser:Nokia 3310");
  assert.throws(() => planBrowserCells(parseArgs(["run", "--url", "http://127.0.0.1/", "--devices", "Desktop Firefox"]), FAKE_DEVICES), UsageError);
  assert.throws(() => planBrowserCells(parseArgs(["run", "--url", "http://127.0.0.1/", "--devices", "iPhone 15", "--browsers", "chromium"]), FAKE_DEVICES), /칸이 없습니다/);
});

test("device planning without Playwright: every cell needs-playwright", () => {
  const cells = planBrowserCells(parseArgs(["run", "--url", "http://127.0.0.1/"]), null);
  assert.equal(cells.length, 4);
  assert.ok(cells.every((c) => c.preset === "needs-playwright"));
  assert.deepEqual(cells.map((c) => c.browser), ["chromium", "chromium", "webkit", "webkit"]);
});
