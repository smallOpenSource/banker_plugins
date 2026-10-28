// The link probe (can-symlink.mjs) decides whether the link tests run on Windows. A probe that always said no would
// hide them again without a failure, so this pins it: true off Windows, and on Windows the same answer a real link gives.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canSymlink, probeSymlink, symlinkSkip } from "./can-symlink.mjs";

test("off Windows the probe says yes without making anything", () => {
  assert.equal(probeSymlink("linux"), true);
  assert.equal(probeSymlink("darwin"), true);
});

test("the probe gives the answer a real link gives here, and the skip option follows it", () => {
  const dir = mkdtempSync(join(tmpdir(), "can-symlink-check-"));
  let made;
  try {
    writeFileSync(join(dir, "t"), "");
    symlinkSync(join(dir, "t"), join(dir, "l"), "file");
    made = true;
  } catch {
    made = false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(canSymlink, made);
  assert.equal(symlinkSkip === false, made);
});
