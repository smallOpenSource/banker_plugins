#!/usr/bin/env python3
"""setup-bypass-permissions step 3 on macOS and Linux, for when node cannot run the main script.

    python3 bypass-permissions.py on --yes   set permissions.defaultMode = "bypassPermissions"
    python3 bypass-permissions.py off        remove that key (Claude Code's default start mode)

The file is <config>/settings.json, <config> being $CLAUDE_CONFIG_DIR or ~/.claude. Every other
key stays, and so does a BOM. `on` keeps the text from before in settings.json.bypass-permissions.bak,
readable by this account alone; a second `on` finds the mode set and writes nothing. Both files are
replaced whole through a temp file and a rename, so a stop partway leaves the old text, and a link at
the settings name stays a link. Only the node script's `off` knows what `on` replaced; this `off`
removes the key.

`on` refuses (exit 1, nothing written) where Claude Code would not honour the mode or not start with
it: managed policy (managed-settings.json or its managed-settings.d drop-ins) or the settings file
itself sets permissions.disableBypassPermissionsMode, or the account is root outside a sandbox Claude
Code recognises (IS_SANDBOX=1, or its bubblewrap one). It also refuses a file that is not a JSON object,
a policy file or folder this account cannot read, and a machine with no Claude Code config folder.

Exit status: 0 done, or nothing to do. 1 refused. 2 unexpected error. 3 this account may not write
the file or its folder. Every result ends with the line `settings file: <path>` on stdout.
Python 3.6 or later.
"""
import errno
import json
import os
import sys
import tempfile

MODE = "bypassPermissions"
BOM = b"\xef\xbb\xbf"
POLICY_HOMES = {"darwin": "/Library/Application Support/ClaudeCode"}


class Refused(Exception):
    pass


def settings_path():
    config = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")
    return os.path.join(config, "settings.json")


def policy_home():
    # The override exists for this skill's tests alone.
    if os.environ.get("BANKER_BYPASS_TEST") == "1" and os.environ.get("BANKER_BYPASS_POLICY_HOME"):
        return os.environ["BANKER_BYPASS_POLICY_HOME"]
    return POLICY_HOMES.get(sys.platform, "/etc/claude-code")


def forbids(data):
    perm = data.get("permissions") if isinstance(data, dict) else None
    value = perm.get("disableBypassPermissionsMode") if isinstance(perm, dict) else None
    return value is True or value == "disable"


# A policy path that is not there, or is not a file of that kind: no policy, not a failure.
ABSENT = (errno.ENOENT, errno.ENOTDIR, errno.EISDIR)


def unreadable_policy(path):
    return Refused("this machine's managed policy cannot be read (" + path + "); ask the administrator whether it allows the mode")


def policy_files():
    """The managed settings file and its drop-ins, in the order Claude Code reads them."""
    home = policy_home()
    files = [os.path.join(home, "managed-settings.json")]
    drop = os.path.join(home, "managed-settings.d")
    try:
        names = os.listdir(drop)
    except OSError as e:
        if e.errno not in ABSENT:
            raise unreadable_policy(drop)
        names = []
    files += [os.path.join(drop, n) for n in sorted(n for n in names if n.endswith(".json") and not n.startswith("."))]
    return files


def policy_block():
    """The policy file that forbids the mode, or ""; Refused for a policy this account cannot read."""
    for path in policy_files():
        try:
            with open(path, "rb") as handle:
                raw = handle.read()
        except OSError as e:
            if e.errno in ABSENT:
                continue
            raise unreadable_policy(path)
        try:
            if forbids(json.loads(raw.decode("utf-8-sig"))):
                return path
        except ValueError:
            pass  # not JSON: nothing this fallback can see forbids it
    return ""


def load(path):
    """(data, raw bytes or None when there is no file) for a JSON object; Refused otherwise."""
    try:
        with open(path, "rb") as handle:
            raw = handle.read()
    except FileNotFoundError:
        return {}, None
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise Refused("settings.json is not valid UTF-8")
    if not text.strip():
        return {}, raw
    def reject(token):
        raise ValueError("the constant " + token + " is not JSON")

    try:
        data = json.loads(text, parse_constant=reject)
    except ValueError as e:
        raise Refused("settings.json is not valid JSON (" + str(e) + ")")
    if not isinstance(data, dict):
        raise Refused("settings.json is not a JSON object")
    if not isinstance(data.get("permissions", {}), dict):
        raise Refused("the permissions entry of settings.json is not an object")
    return data, raw


def replace(path, data, mode):
    """Write bytes to path through a temp file in the same folder and a rename."""
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".bypass-permissions.")
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
        os.chmod(tmp, mode)
        try:
            os.replace(tmp, path)
        except OSError as e:
            if e.errno not in (errno.EBUSY, errno.EXDEV):
                raise
            with open(path, "wb") as target:  # a bind-mounted single file refuses the rename: write in place
                target.write(data)
            os.remove(tmp)
    except BaseException:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise


def save(path, data, raw):
    """Replace the real file behind path (a link stays a link), keeping its mode and BOM."""
    real = os.path.realpath(path)
    mode = os.stat(real).st_mode & 0o777 if os.path.exists(real) else 0o600
    bom = BOM if raw is not None and raw.startswith(BOM) else b""
    replace(real, bom + (json.dumps(data, indent=2, ensure_ascii=False) + "\n").encode("utf-8"), mode)


def check_on(path, data):
    # Claude Code lets root use the mode inside a sandbox it recognises: IS_SANDBOX exactly "1", or
    # CLAUDE_CODE_BUBBLEWRAP set to a true value (2.1.289 reads 1, true, yes, on; 0 or false is not one).
    bubblewrap = os.environ.get("CLAUDE_CODE_BUBBLEWRAP", "").strip().lower() in ("1", "true", "yes", "on")
    sandboxed = os.environ.get("IS_SANDBOX") == "1" or bubblewrap
    if hasattr(os, "geteuid") and os.geteuid() == 0 and not sandboxed:
        raise Refused("Claude Code will not start in bypassPermissions as root; IS_SANDBOX=1 marks a real sandbox")
    blocked = policy_block()
    if blocked:
        raise Refused("managed policy forbids bypassPermissions: " + blocked)
    if forbids(data):
        raise Refused("settings.json itself sets permissions.disableBypassPermissionsMode")


def forget_record(path):
    """Drop the node script's record of what `on` replaced. This fallback keeps no record, so one left by an
    earlier node `on` is stale: the mode is no longer what it describes, and a later node `off` would restore it."""
    try:
        os.remove(path + ".bypass-permissions.json")
    except FileNotFoundError:
        pass


def turn_on(path):
    if not os.path.isdir(os.path.dirname(path)):
        raise Refused("there is no Claude Code config folder at " + os.path.dirname(path))
    data, raw = load(path)
    check_on(path, data)
    if data.get("permissions", {}).get("defaultMode") == MODE:
        print("defaultMode = " + MODE + " (already, nothing changed)")
        return 0
    if raw is not None and not os.access(path, os.W_OK):
        raise PermissionError(errno.EACCES, "this account may not write", path)
    if raw is not None:
        replace(path + ".bypass-permissions.bak", raw, 0o600)
    forget_record(path)  # the mode is not on, so any record is stale
    data.setdefault("permissions", {})["defaultMode"] = MODE
    save(path, data, raw)
    print("defaultMode = " + MODE)
    return 0


def turn_off(path):
    data, raw = load(path)
    current = data.get("permissions", {}).get("defaultMode")
    if current != MODE:
        print("defaultMode = " + str(current) + " (not bypassPermissions, nothing changed)")
        return 0
    if not os.access(path, os.W_OK):  # a read-only settings file is a lock: off honours it as on does
        raise PermissionError(errno.EACCES, "this account may not write", path)
    del data["permissions"]["defaultMode"]
    save(path, data, raw)
    forget_record(path)  # only after the write: if it failed, the record is still the way back
    print("defaultMode removed (Claude Code's default start mode)")
    return 0


def outcome(argv, path):
    actions = {("on", "--yes"): turn_on, ("off",): turn_off}
    action = actions.get(tuple(argv[1:]))
    if action is None:
        print("refused: usage is `bypass-permissions.py on --yes` or `bypass-permissions.py off`", file=sys.stderr)
        return 1
    try:
        return action(path)
    except Refused as e:
        print("refused: " + str(e) + "; settings.json left as it was", file=sys.stderr)
        return 1
    except OSError as e:
        if e.errno in (errno.EACCES, errno.EPERM, errno.EROFS):
            print("write blocked: " + str(e) + "; settings.json left as it was", file=sys.stderr)
            return 3
        print("unexpected error: " + str(e) + "; check settings.json", file=sys.stderr)
        return 2
    except Exception as e:  # anything else stopped it partway too
        print("unexpected error: " + type(e).__name__ + ": " + str(e) + "; check settings.json", file=sys.stderr)
        return 2


def main(argv):
    path = settings_path()
    code = outcome(argv, path)
    print("settings file: " + path)
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv))
