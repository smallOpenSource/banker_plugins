// me-run's --shell: the program that runs the command line. Pure function, no process started.
// Run: node --test skills/make-evidence/scripts/me-run.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { spawnArgs } from "./me-run.mjs";

// 0.16.2 rule: no file in the project folder picks the program. The command runs there, and Windows looks for a bare
// powershell.exe in the working folder first, so --shell names System32's Windows PowerShell by full path.
test("--shell on Windows runs System32's powershell.exe by full path (SystemRoot), elsewhere /bin/sh", () => {
  const [exe, args] = spawnArgs(["echo", "hi"], true, "win32", { SystemRoot: "D:\\Win" });
  assert.equal(exe, "D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.deepEqual(args, ["-NoProfile", "-NonInteractive", "-Command", "echo hi"]);
  assert.equal(spawnArgs(["echo"], true, "win32", {})[0], "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.deepEqual(spawnArgs(["echo", "hi"], true, "linux", {}), ["/bin/sh", ["-c", "echo hi"]]);
  assert.deepEqual(spawnArgs(["node", "-v"], false, "win32", {}), ["node", ["-v"]], "without --shell the command is the user's");
});
