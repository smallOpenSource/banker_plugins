// The pwsh fixture (pwsh-env.mjs) is what keeps every pwsh a test starts out of the real home and quiet. A change that
// dropped an opt-out or the home override would still pass every pwsh test, so this pins the fixture itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
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
    for (const k of ["XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "PSModuleAnalysisCachePath"]) assert.ok(inside(home, env[k]), `${k}=${env[k]}`);
    assert.deepEqual(PWSH_OPTOUT, { POWERSHELL_TELEMETRY_OPTOUT: "1", POWERSHELL_UPDATECHECK: "Off", DOTNET_CLI_TELEMETRY_OPTOUT: "1" });
    for (const [k, v] of Object.entries(PWSH_OPTOUT)) assert.equal(env[k], v, k);
    assert.equal(env.PATH, "/bin", "the rest of the base is kept");
    assert.equal(base.HOME, "/real/home", "the base is not changed");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// 0.20.5 (final batch deferred row 14): every pwsh or Windows PowerShell a test starts gets an env, the fixture's or one
// built on it. A call that passes none runs PowerShell with the real home: its caches land there.
// The text inside the parentheses of each call `name(...)`, nested parentheses kept.
function callArgs(src, name) {
  return [...src.matchAll(new RegExp(`\\b${name}\\(`, "g"))].map((m) => {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < src.length && depth; i++) depth += src[i] === "(" ? 1 : src[i] === ")" ? -1 : 0;
    return { at: src.slice(0, m.index).split("\n").length, args: src.slice(m.index + m[0].length, i - 1) };
  });
}
test("every test that starts pwsh or Windows PowerShell gives it an env", () => {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if ([".git", "node_modules", ".omc"].includes(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".test.mjs")) files.push(p);
    }
  };
  walk(root);
  assert.ok(files.length > 20, `${files.length} test files`);
  // the first argument names PowerShell: a literal name or the variables the tests keep it in
  const PS = /^\s*(?:"pwsh"|'pwsh'|"powershell(?:\.exe)?"|'powershell(?:\.exe)?'|POWERSHELL|PWSH|powershell|pwshBin|ps)\b/;
  const bare = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const name of ["spawnSync", "spawn", "execFileSync", "execFile"]) {
      for (const c of callArgs(src, name)) if (PS.test(c.args) && !/\benv\s*:/.test(c.args)) bare.push(`${relative(root, f)}:${c.at}`);
    }
  }
  assert.deepEqual(bare, []);
});
