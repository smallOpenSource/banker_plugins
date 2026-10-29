// Whether this account can make a symbolic link. macOS and Linux always can. Windows needs SeCreateSymbolicLinkPrivilege
// (an elevated administrator, or Developer Mode), so a link test asks this instead of skipping every Windows box.
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function probeSymlink(platform = process.platform) {
  if (platform !== "win32") return true;
  let dir;
  try {
    dir = mkdtempSync(join(tmpdir(), "can-symlink-"));
    writeFileSync(join(dir, "target"), "");
    symlinkSync(join(dir, "target"), join(dir, "link"), "file");
    return true;
  } catch {
    return false;
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

export const canSymlink = probeSymlink();
// The skip option for a test that makes a link: false where links can be made, else the reason.
export const symlinkSkip = !canSymlink && "this Windows account cannot make symbolic links (needs an elevated administrator or Developer Mode)";
