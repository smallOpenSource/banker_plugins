// The pwsh fixture (pwsh-env.mjs) is what keeps every pwsh a test starts out of the real home and quiet. A change that
// dropped an opt-out or the home override would still pass every pwsh test, so this pins the fixture itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, relative } from "node:path";
import { PWSH_OPTOUT, pwshEnv } from "./pwsh-env.mjs";

const inside = (dir, p) => {
  const r = relative(dir, p);
  return r !== "" && !r.startsWith("..") && !isAbsolute(r);
};

test("pwshEnv gives a new temp home, the XDG folders under it and the three opt-outs over the base", () => {
  const base = { HOME: "/real/home", USERPROFILE: "/real/profile", XDG_CACHE_HOME: "/real/cache", POWERSHELL_TELEMETRY_OPTOUT: "0", PATH: "/bin" };
  const { home, env } = pwshEnv(base);
  try {
    assert.ok(inside(tmpdir(), home), home);
    assert.equal(env.HOME, home);
    assert.equal(env.USERPROFILE, home);
    for (const k of ["XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME"]) assert.ok(inside(home, env[k]), `${k}=${env[k]}`);
    assert.deepEqual(PWSH_OPTOUT, { POWERSHELL_TELEMETRY_OPTOUT: "1", POWERSHELL_UPDATECHECK: "Off", DOTNET_CLI_TELEMETRY_OPTOUT: "1" });
    for (const [k, v] of Object.entries(PWSH_OPTOUT)) assert.equal(env[k], v, k);
    assert.equal(env.PATH, "/bin", "the rest of the base is kept");
    assert.equal(base.HOME, "/real/home", "the base is not changed");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
