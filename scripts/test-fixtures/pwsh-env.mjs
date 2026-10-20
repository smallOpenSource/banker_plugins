// The environment a test gives the pwsh it starts. pwsh keeps a start-up cache, a module folder and a telemetry id
// under HOME and the XDG folders, and on start it can send telemetry and check for a new version unless told not to.
// So each pwsh a test starts gets a temp home and the opt-outs: nothing in the real home, no request out.
// The caller removes `home` when it is done (an after() hook).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const PWSH_OPTOUT = { POWERSHELL_TELEMETRY_OPTOUT: "1", POWERSHELL_UPDATECHECK: "Off", DOTNET_CLI_TELEMETRY_OPTOUT: "1" };

// The XDG folders and the opt-outs for a pwsh whose HOME is `home`.
export const pwshVars = (home) => ({
  XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local", "share"), XDG_CONFIG_HOME: join(home, ".config"),
  ...PWSH_OPTOUT,
});

export function pwshEnv(base = process.env) {
  const home = mkdtempSync(join(tmpdir(), "pwsh-home-"));
  return { home, env: { ...base, HOME: home, USERPROFILE: home, ...pwshVars(home) } };
}
