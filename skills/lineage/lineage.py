#!/usr/bin/env python3
"""lineage — Export Claude Code session(s) as a single KakaoTalk-style HTML file.

Deterministic core. One-line summary per assistant turn (cached, redacted).
Renders assistant markdown, filters harness noise, folds long messages, and
self-verifies the output markup. See SKILL.md for the full design and the
`work/lineage-change-request.html` spec for the classification rules.

Runtime-agnostic: works from any transcript via --session / --from-transcript.
Auto-discovery assumes Claude Code's ~/.claude/projects/<encoded-cwd>/ layout.
"""
import argparse
import hashlib
import hmac
import html
import json
import math
import os
import pathlib
import re
import sys
import tempfile
from html.parser import HTMLParser

if sys.version_info < (3, 7):
    sys.stderr.write("lineage requires Python 3.7+ (found %s)\n"
                     % sys.version.split()[0])
    sys.exit(2)

SCHEMA_VERSION = 2          # cache dir schema (v2: redacted summaries only)
SUMMARIZER_VERSION = 3      # bump when summarize_turn logic changes (B-3 cache key); 3: cut from redacted text
USER_FOLD = 400             # collapse user messages longer than this (E-1)
ECHO_ASK = 40               # echo-exchange: user question length ceiling (A-4)
ECHO_REPLY = 5              # echo-exchange: assistant reply length ceiling (A-4)
_BLOCKQUOTE_MAX_DEPTH = 32  # blockquote recursion cap (C-2)
CACHE_BASE = pathlib.Path.home() / ".cache" / "lineage"
REVIEW_SCHEMA = "lineage-review/2"       # --emit-review pack, read back by --apply-review; 2: llm_key, pages redacted (3.0.2)
REVIEW_PART_SCHEMA = "lineage-review-part/1"
REVIEW_PART = 40            # turns per part file: one reviewer's share
PREVIEW_HEAD = 1500         # a long turn's preview: head + tail, where conclusions sit
PREVIEW_TAIL = 700
SUMMARY_MAX = 120           # a reviewer's summary is cut to this, after redaction
LLM_CACHE_VERSION = 1       # bump to drop every cached reviewer decision
REVIEWER_TIMEOUT = 60       # --reviewer-timeout default, seconds
DECISIONS_MAX = 1_000_000   # bytes in one decisions file (a 40-turn part answers in some 20 KB)
DECISIONS_TRIES = 200       # places a wrapped answer's list may start, tried at most

# ---------------------------------------------------------------- Noise / classify
# NOTE: JSONL records carry RAW `<...>` tags. Every regex below uses raw `<`/`>`
# (NOT the HTML-escaped `&lt;` seen in the display-only change-request document).
_NOISE_TAGS = ("system-reminder", "local-command-caveat", "local-command-stdout",
               "local-command-stderr", "teammate-message", "command-message",
               "command-args", "command-name", "task-notification")
_NOISE_BLOCK_RE = re.compile(r"<(%s)\b[^>]*>.*?</\1>" % "|".join(_NOISE_TAGS), re.S)
_NOISE_CLOSE_RE = re.compile(r"</(%s)>" % "|".join(_NOISE_TAGS))
_NOISE_OPEN_RE = re.compile(r"<(?:%s)\b" % "|".join(_NOISE_TAGS))   # leading orphan open (R7)

_SKILL_BODY_RE = re.compile(r"^\s*Base directory for this skill:")
_WORKFLOW_BODY_RE = re.compile(r'^\s*Run the "[^"\n]+" workflow\.')
_COMPACTION_RE = re.compile(
    r"^\s*This session is being continued from a previous conversation")
_HOOK_FEEDBACK_RE = re.compile(r"^\s*Stop hook feedback:")
_INTERRUPT_RE = re.compile(r"^\s*\[Request interrupted")
_IMAGE_NOTE_RE = re.compile(r"^\s*\[Image:\s*original\s+\d+x\d+")
_SYS_ERROR_RE = re.compile(r"^\s*(?:Login expired|Please run /login|API Error)")

# Manipulation commands: judged by NAME, not by "has no args" (A-4). Plugin
# commands (name contains ':') are never manipulation — always preserved.
_HARNESS_CMDS = {
    "agents", "bug", "clear", "compact", "config", "context", "copy", "cost",
    "doctor", "effort", "exit", "export", "help", "hooks", "ide",
    "install-github-app", "login", "logout", "mcp", "memory",
    "migrate-installer", "model", "output-style", "permissions",
    "privacy-settings", "quit", "release-notes", "resume", "status",
    "statusline", "terminal-setup", "todos", "upgrade", "usage", "vim",
}
# Deliberately NOT in the set: /add-dir (changes readable dirs), /init (writes
# CLAUDE.md) — these do real work and are kept.

_AGENT_WRAP_RE = re.compile(
    r"<(agent-message|teammate-message)\b([^>]*)>(.*?)</\1>", re.S)
_AGENT_FROM_RE = re.compile(r'(?:from|teammate_id)="([^"]+)"')
_PEER_LEAD_RE = re.compile(r"^\s*Another Claude session sent a message:\s*")
_BARE_CMD_RE = re.compile(r"^/([\w-]+)\s*$")
_CMD_NAME_RE = re.compile(r"<command-name>([\s\S]*?)</command-name>")
_CMD_ARGS_RE = re.compile(r"<command-args>([\s\S]*?)</command-args>")


def clean_user_text(text, drop_harness=True):
    """Return the genuine user text, or "" if the record is pure harness noise.

    Judgement is by FORM, not position:
    - wrapper blocks (`<system-reminder>...`) are always stripped;
    - a record that is ONLY a bare manipulation command (`/copy`) → dropped;
    - anything that survives stripping is a real message (possibly quoting a
      tag) and is kept — EXCEPT a leading orphan wrapper-open (truncated block);
    - a pure command record → the command name (+args), dropped if harness.
    """
    out = _NOISE_CLOSE_RE.sub("", _NOISE_BLOCK_RE.sub("", text)).strip()

    mb = _BARE_CMD_RE.match(out)                 # bare `/name` with no wrapper
    if mb and drop_harness and mb.group(1) in _HARNESS_CMDS:
        return ""

    if out:
        # Something survived stripping = a real message that QUOTED a tag.
        # Keep it, unless it starts with an orphan wrapper-open (R7: a block
        # truncated by the record boundary — not conversation).
        return "" if _NOISE_OPEN_RE.match(out) else out

    # Nothing survived: a pure command record. Recover the command name.
    m = _CMD_NAME_RE.search(text)
    if not m:
        return ""
    name = m.group(1).strip()
    if drop_harness and ":" not in name and name.lstrip("/") in _HARNESS_CMDS:
        return ""
    a = _CMD_ARGS_RE.search(text)
    args = a.group(1).strip() if a and a.group(1).strip() else ""
    return (name + (" " + args if args else "")).strip()


def split_agent_message(text):
    """(sender, body) if `text` IS an agent/teammate wrapper, else (None, None).

    Structural first-line match only (NOT substring): a user who merely quotes
    `<agent-message>` mid-sentence must not be reclassified. The harness note
    that trails the closing tag is auto-excluded because only the wrapper's
    inner text is taken. An idle-notification JSON body → dropped ("").
    """
    m = _AGENT_WRAP_RE.match(_PEER_LEAD_RE.sub("", text.lstrip()))
    if not m:
        return None, None
    who = _AGENT_FROM_RE.search(m.group(2) or "")
    body = m.group(3).strip()
    if body.startswith('{"type"'):               # idle/status notification
        return (who.group(1) if who else "agent"), ""
    return (who.group(1) if who else "agent"), body


# ---------------------------------------------------------------- Redaction
SECRET_PATTERNS = [
    ("AKIA", re.compile(r"AKIA[0-9A-Z]{16}")),
    ("ASIA", re.compile(r"ASIA[0-9A-Z]{16}")),
    ("GitHubPAT", re.compile(r"gh[posru]_[A-Za-z0-9]{36}")),
    ("Slack", re.compile(r"xox[bpars]-[A-Za-z0-9-]{10,}")),
    ("JWT", re.compile(r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+")),
    ("PrivateKey", re.compile(
        r"-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]+?-----END [A-Z ]+PRIVATE KEY-----")),
    ("Password", re.compile(
        r"(?i)(?:password|암호|비번|패스워드)\s*[:=]\s*['\"]([^'\"\n]{4,})['\"]")),
]
ENTROPY_LONG = re.compile(r"[A-Za-z0-9+/=]{32,}")


def shannon_entropy(s: str) -> float:
    if not s:
        return 0.0
    freq = {}
    for c in s:
        freq[c] = freq.get(c, 0) + 1
    L = len(s)
    return -sum((v / L) * math.log2(v / L) for v in freq.values())


def _mask(s: str) -> str:
    return (s[:4] + "****" + s[-4:]) if len(s) > 8 else "[REDACTED]"


def redact(text: str, extra: "str | None" = None, mode: str = "full"):
    """Multi-layer redaction. Returns (redacted_text, count_by_kind)."""
    counts = {}
    out = text
    for name, pat in SECRET_PATTERNS:
        def repl(m, n=name):
            counts[n] = counts.get(n, 0) + 1
            return _mask(m.group(0)) if mode == "mask" else f"[REDACTED:{n}]"
        out = pat.sub(repl, out)

    def ent_repl(m):
        s = m.group(0)
        if shannon_entropy(s) >= 4.5:
            counts["entropy"] = counts.get("entropy", 0) + 1
            return _mask(s) if mode == "mask" else "[REDACTED:entropy]"
        return s
    out = ENTROPY_LONG.sub(ent_repl, out)

    try:
        from detect_secrets import SecretsCollection
        from detect_secrets.settings import default_settings
        import tempfile
        with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False,
                                         encoding="utf-8") as tf:
            tf.write(out)
            tmp = tf.name
        try:
            col = SecretsCollection()
            with default_settings():
                col.scan_file(tmp)
            for fname in col.files:
                for s in col[fname]:
                    sv = s.secret_value
                    if sv and sv in out:
                        out = out.replace(sv, "[REDACTED:ds]")
                        counts["ds:detect-secrets"] = counts.get(
                            "ds:detect-secrets", 0) + 1
        finally:
            try:
                os.unlink(tmp)
            except OSError:
                pass
    except ImportError:
        if not getattr(redact, "_ds_warned", False):
            print("[lineage] WARN: detect-secrets unavailable, using fallback "
                  "(pip install 'detect-secrets>=1.5')", file=sys.stderr)
            redact._ds_warned = True
    except Exception as e:
        if not getattr(redact, "_ds_err_warned", False):
            print(f"[lineage] WARN: detect-secrets error ({e}), continuing "
                  "with fallback", file=sys.stderr)
            redact._ds_err_warned = True

    if extra:
        for kw in [k.strip() for k in extra.split(",") if k.strip()]:
            # a marker an earlier pass left stays whole: a keyword inside its name is no secret
            pat = re.compile(r"\[REDACTED(?::[^\]\s]*)?\]|" + re.escape(kw), re.IGNORECASE)
            hits = []
            out = pat.sub(lambda m: m.group(0) if m.group(0).upper().startswith("[REDACTED")
                          else hits.append(1) or "[REDACTED]", out)
            if hits:
                counts[f"custom:{kw}"] = len(hits)
    return out, counts


# A character of curl's user before the colon: no space, : or =, and a quote, backtick or ( only
# where no flag follows (-u, -Xu or --user, as either branch below starts) and no comma and quote
# follow (the end of an item in an argument list written without spaces). A match starts only
# there, so no user runs past the place where the next match may start: a long run stays linear,
# and a user joined to a variable by a - ("$USER"-bot) is read whole.
_CU_USER = (r"(?:[^\s:=\"'`(]|[\"'`(](?!-(?:u|[A-Za-z0-9]{1,6}u[\s\"']|-user[\s=\"'])"
            r"|,\\{0,7}[\"']))")
# The quotes that may open the value, bare or escaped (\" and \\\" in a quoted command, '\'' and
# '"'"' from bash and shlex.quote, ^" in cmd, `" in PowerShell, $' in bash): up to six in a row,
# none that closes an item of an argument list.
_CU_LEAD = r"(?:[\\^`$]{0,7}[\"'](?!,\\{0,7}[\"'])){0,6}"
# Values read as a whole token, past the quotes that open them, that hold no user and password: a
# uid:gid (docker), a date format (date -u +%H:%M), two references ($UID:$GID, ${UID}:${GID},
# %USER%:%PASS%, $(id -u):$(id -g), whose inner `-u)` is a match of its own) and a path default
# (mktemp -u "${TMPDIR:-/tmp}/x"). A literal password, or a default that is no path or holds a
# colon, is hidden.
_CU_REF = r"(?:\$\{?\w+\}?|%\w+%|\$\([^\s()]*(?:\s+[^\s()]+)*\))"
_CU_SKIP = (r"(?!" + _CU_LEAD + r"(?:\+[\"']?%[-_0^#]?[A-Za-z%]|(?:\d+:\d+|(?:" + _CU_REF
            + r"|[^\s:=\"'`(]*\)):" + _CU_REF + r")(?![^\s\"'`;|&)\\^])"
            r"|\$\{\w+:[-=?+]?[/~.][^\s}\"'`(:]*\}[^\s:]*(?!\S)))")

# Extra patterns for text a reviewer model reads (part files) and nothing else: the page
# and --rulebase keep the patterns above, so their output stays as it was.
# A value a redaction already replaced: a marker ([REDACTED...]) or a value that is only a mask
# (abcd****wxyz: up to 4 characters, a whole run of *, up to 4 characters, then the value ends; a
# closing `, |, * or ) may stand between, as in **password: ****h12**). The
# reviewer patterns leave it, so a second pass over redacted text changes nothing. The check reads
# those few characters, not the rest of the token, so a long run of keywords stays linear.
_NOT_REDACTED = r"(?!\[REDACTED|[^\s'\"*]{0,4}\*{4,}(?!\*)[^\s'\"*]{0,4}(?=[`|*)]*(?:[\s'\"]|$)))"
# After a colon: not the colon of a marker an earlier pass left ([REDACTED:GitHubPAT]), which
# splits no user from a password. A whole marker is one piece of a user: a key an earlier pattern
# of this pass hid ([REDACTED:OpenAIKey]:pw) still has its password hidden.
_NOT_MARKED = r"(?<!\[REDACTED:)"
_MARKER_UNIT = r"\[REDACTED:\w+\]"

REVIEW_SECRET_PATTERNS = [
    ("AnthropicKey", re.compile(r"(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{20,}")),
    ("OpenAIKey", re.compile(r"(?<![A-Za-z0-9-])sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}")),
    ("GoogleKey", re.compile(r"(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}")),
    # bounded repeats: a long run of `key` or `a.` would otherwise take quadratic time
    ("HexKey", re.compile(r"(?i)(?:key|token|secret)[\w-]{0,100}\s*[:=]\s*['\"]?[0-9a-f]{32,}")),
    # a value, not a path, a variable or a redaction ($PWD is a variable, PGPASSWORD a name);
    # markdown, a table cell or a bracket that closes after the value stays outside the match
    ("PasswordBare", re.compile(
        r"(?i)(?<!\$)(?:password|passwd|passcode|pwd|암호|비번|비밀\s?번호|패스워드)\s*[:=]\s*"
        r"(?![/~$])" + _NOT_REDACTED + r"(?=[^\s'\"]{6})[^\s'\"]*[^\s'\"`|*)]")),
    # the password runs to the last @ before the host: it may hold an @ of its own. A marker is
    # no user or password, so a second pass leaves a token-only URL (https://[REDACTED:...]@host).
    ("UrlCredential", re.compile(r"(?i)[a-z][a-z0-9+.-]{0,30}://(?:" + _MARKER_UNIT + r"|[^\s:@/])*:" + _NOT_MARKED
                                 + r"(?!\[REDACTED)[^\s/]{3,}@")),
    ("Bearer", re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]{16,}")),
    # Authorization then `:`, `=`, `=>` or headers["Authorization"] =, a call's ("Authorization",
    # "...") and a HAR name/value pair, or a space before a quote (nginx, Apache)
    ("BasicAuth", re.compile(
        r"(?i)\bauthorization"
        r"(?:[\"']?\]?\s*(?:=>|[:=])"
        r"|[\"']\s*,\s*(?:[\"']value[\"']\s*:\s*)?(?=[\"'])"
        r"|\s+(?=[\"']))"
        r"\s*[\"']?basic\s+[A-Za-z0-9+/]{8,}={0,2}")),
    # curl's -u and --user flags, alone or last in a bundle (-su, -4u), with a user and password
    # after a space, an = or nothing, quoted together or apart ("user":"pw"), with quotes bare,
    # escaped or nested (_CU_LEAD) or none, in inline code or parentheses, or as two items of an
    # argument list (quotes bare or escaped, with or without spaces; a host:/path is left). An
    # empty user with a token, and a
    # long key as the user with no password, count too. The separators share no character with
    # the user name, so a long run of them stays linear. The values _CU_SKIP names and a
    # host:/path (rsync) are left, and so is a marker an earlier pass left (-u [REDACTED:JWT]).
    ("CurlUser", re.compile(
        r"(?<![^\s\"'`(])(?:-u\s*|-[A-Za-z0-9]{1,6}u\s+|--user(?:\s+|=))" + _CU_SKIP + _CU_LEAD
        + r"(?:(?:" + _MARKER_UNIT + r"|" + _CU_USER + r")*:" + _NOT_MARKED + r"(?!/|\[REDACTED)\S{3,}|" + _CU_USER
        + r"{15,}:" + _NOT_MARKED
        + r"(?=[\s\"'`).,;\\]|$))"
        r"|(\\{0,7}[\"'])(?:-[A-Za-z0-9]{0,6}u|--user)\1\s*,\s*(\\{0,7}[\"'])" + _CU_SKIP
        + r"(?:(?:" + _MARKER_UNIT + r"|" + _CU_USER + r")*:" + _NOT_MARKED + r"(?!/|\[REDACTED)[^\s\"']{3,}|"
        + _CU_USER + r"{15,}:"
        + _NOT_MARKED + r")\2")),
]


def _reviewer_patterns(text):
    """`text` with what the reviewer patterns find replaced whole by [REDACTED:<name>], and the
    count by name."""
    counts = {}
    for name, pat in REVIEW_SECRET_PATTERNS:
        text, k = pat.subn(f"[REDACTED:{name}]", text)
        if k:
            counts[name] = k
    return text, counts


def review_redact(text, extra=None):
    """Text as a reviewer model reads it: the reviewer-only patterns first, while the keys
    are whole (the entropy rule would otherwise cut a key and leave the rest), then fully
    redacted (never masked, whatever --redact-mode says). Returns (text, count)."""
    pre, counts = _reviewer_patterns(text)
    red, found = redact(pre, extra=extra, mode="full")
    return red, sum(counts.values()) + sum(found.values())


def page_redact(text, extra=None, mode="full"):
    """Text as every page shows it (3.0.2): the reviewer patterns first, while keys are whole,
    each hit replaced whole whatever --redact-mode says (a mask keeps 4+4 characters, most of
    a short password); then the page's redaction with this run's mode and keywords. Returns
    (text, count_by_kind); a second pass over its output finds nothing."""
    pre, counts = _reviewer_patterns(text)
    red, found = redact(pre, extra=extra, mode=mode)
    for k, v in found.items():
        counts[k] = counts.get(k, 0) + v
    return red, counts


# ---------------------------------------------------------------- Discovery
_TITLE_RE = re.compile(r'"customTitle"\s*:\s*"([^"]+)"')


def discover_session_name(path):
    """Best-effort scan a jsonl for `customTitle`. Slug-safe string or None."""
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                if '"customTitle"' not in line:
                    continue
                m = _TITLE_RE.search(line)
                if m:
                    name = m.group(1).strip()
                    name = re.sub(r"\s+", "-", name)
                    name = re.sub(r"[^\w가-힣.-]", "", name)
                    return name[:40] or None
    except (OSError, UnicodeDecodeError):
        return None
    return None


def encode_cwd(cwd) -> str:
    """Encode a path the way Claude Code names its project dirs.

    Every non-alphanumeric byte maps to '-' (verified: `/` AND `_` both become
    '-', with no separator collapsing). The spec's `[\\/:.]` fix omitted `_`
    and failed on this very repo (`build_plugin` → dir uses `build-plugin`).
    Non-ASCII (e.g. Hangul) also maps to '-'; if that mis-encodes, the caller
    falls back to the explicit --session / --from-transcript options.
    """
    return re.sub(r"[^A-Za-z0-9]", "-", str(cwd))


def auto_discover_jsonl():
    projdir = pathlib.Path.home() / ".claude" / "projects" / encode_cwd(
        pathlib.Path.cwd())
    if not projdir.exists():
        return None
    try:
        files = sorted(projdir.glob("*.jsonl"),
                       key=lambda p: p.stat().st_mtime, reverse=True)
    except OSError:
        return None
    return files[0] if files else None


def project_jsonl_files():
    """All *.jsonl in the encoded project dir, for --all-sessions."""
    projdir = pathlib.Path.home() / ".claude" / "projects" / encode_cwd(
        pathlib.Path.cwd())
    if not projdir.exists():
        return []
    try:
        return sorted(projdir.glob("*.jsonl"), key=lambda p: p.stat().st_mtime)
    except OSError:
        return []


def session_start(path):
    """First timestamp in a jsonl (for chronological session ordering)."""
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                if '"timestamp"' not in line:
                    continue
                m = re.search(r'"timestamp"\s*:\s*"([^"]+)"', line)
                if m:
                    return m.group(1)
    except (OSError, UnicodeDecodeError):
        return None
    return None


# ---------------------------------------------------------------- JSONL parse
KNOWN_TYPES = {"user", "assistant", "agent-setting", "permission-mode", "summary"}
KNOWN_CONTENT_ITEMS = {"text", "tool_use", "tool_result", "thinking"}
_CTRL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")   # strip control chars (keeps \t\n)


def parse_turns(stream, unsafe_schema: bool = False, session_id=None,
                session_name=None):
    """Yield dicts: {role, text, ts, uuid, tools, line_no, parts, session,
    session_name}.

    Raw turns only — harness classification (noise/agent/command) happens later
    in classify_turns(). Every turn carries `parts` (R1: merge_assistant_runs
    needs it) and `session` (session guards for merge/echo).
    """
    seen_unknown_type = set()
    for line_no, raw in enumerate(stream, 1):
        raw = raw.strip()
        if not raw:
            continue
        try:
            obj = json.loads(raw)
        except json.JSONDecodeError:
            print(f"[WARN] line {line_no}: invalid JSON skipped", file=sys.stderr)
            continue
        if obj.get("isSidechain"):
            continue
        if obj.get("teamName") or obj.get("agentName"):
            continue
        t = obj.get("type")
        if t not in ("user", "assistant"):
            if t and t not in KNOWN_TYPES and t not in seen_unknown_type:
                seen_unknown_type.add(t)
                print(f"[WARN] unknown record type '{t}' skipped", file=sys.stderr)
                if not unsafe_schema and t and t.startswith("v"):
                    print(f"[ERROR] schema marker '{t}' unrecognized — "
                          "rerun with --unsafe-schema to proceed",
                          file=sys.stderr)
                    raise SystemExit(2)
            continue

        msg = obj.get("message") or {}
        role = msg.get("role") or t
        content = msg.get("content")
        ts = obj.get("timestamp")
        uuid_ = obj.get("uuid") or hashlib.sha256(
            f"{line_no}:{ts}".encode()).hexdigest()[:16]

        text_parts = []
        tools = {}
        if isinstance(content, str):
            text_parts.append(content)
        elif isinstance(content, list):
            for item in content:
                if not isinstance(item, dict):
                    continue
                it = item.get("type")
                if it == "text":
                    text_parts.append(item.get("text") or "")
                elif it == "tool_use":
                    tools[item.get("name", "?")] = tools.get(
                        item.get("name", "?"), 0) + 1
                elif it in ("tool_result", "thinking"):
                    continue
                elif it not in KNOWN_CONTENT_ITEMS:
                    print(f"[WARN] line {line_no}: unknown content type "
                          f"'{it}' skipped", file=sys.stderr)
        else:
            if content is not None:
                print(f"[WARN] line {line_no}: unknown content shape "
                      f"({type(content).__name__})", file=sys.stderr)
            continue

        text = _CTRL_RE.sub("", "\n".join(p for p in text_parts if p).strip())
        if not text and not tools:
            continue

        yield {"role": role, "text": text, "ts": ts, "uuid": uuid_,
               "tools": tools, "line_no": line_no,
               "parts": [text] if text else [],       # R1: always seed parts
               "session": session_id, "session_name": session_name,
               "meta": bool(obj.get("isMeta"))}       # a harness-injected body


# ---------------------------------------------------------------- Classify (A-1..A-4)
def classify_turns(turns, drop_trivia=True):
    """Transform raw turns per the 6-step user-record judgement order.

    Returns a new list. Roles produced: user, assistant, agent, mark.
    `drop_trivia` (= not --keep-trivia) gates injected bodies, harness commands,
    echo exchanges and harness errors; wrapper blocks / hook-feedback /
    interrupts / agent wrappers / compaction are ALWAYS handled (never restored).
    """
    out = []
    for t in turns:
        if t["role"] != "user":
            out.append(t)
            continue
        text = t["text"]
        # 1. hook feedback / interrupt → always drop
        if _HOOK_FEEDBACK_RE.match(text) or _INTERRUPT_RE.match(text):
            continue
        # 2. injected skill/workflow body & harness errors → drop if trivia
        if drop_trivia and (_SKILL_BODY_RE.match(text)
                            or _WORKFLOW_BODY_RE.match(text)
                            or _SYS_ERROR_RE.match(text)):
            continue
        # 3. image note → replace with attachment marker
        if _IMAGE_NOTE_RE.match(text):
            out.append(dict(t, text="🖼 이미지 첨부"))
            continue
        # 4. compaction → divider mark
        if _COMPACTION_RE.match(text):
            out.append(dict(t, role="mark", text="compaction"))
            continue
        # 5. agent / teammate wrapper → agent bubble
        who, body = split_agent_message(text)
        if who is not None:
            if not body:                              # idle notification
                continue
            out.append(dict(t, role="agent", text=body, agent_from=who))
            continue
        # 6. clean user text → drop if empty
        cleaned = clean_user_text(text, drop_harness=drop_trivia)
        if not cleaned:
            continue
        out.append(dict(t, text=cleaned))
    return out


# ---------------------------------------------------------------- Merge / echo
def merge_assistant_runs(turns):
    """Merge consecutive assistant records (body + tool_use records) into one
    turn. PURE — never mutates input (so calling twice can't double-count tools).
    Merged turn keeps the FIRST record's timestamp. Same-session only (D-1).
    Must run BEFORE --hide-tool-only so tool counts aren't lost (B-1).
    """
    merged = []
    for t in turns:
        p = merged[-1] if merged else None
        if (p and t["role"] == "assistant" and p["role"] == "assistant"
                and t.get("session") == p.get("session")):
            if t["text"]:
                p["text"] = (p["text"] + "\n\n" + t["text"]).strip()
                p["parts"].append(t["text"])
            for k, v in t["tools"].items():
                p["tools"][k] = p["tools"].get(k, 0) + v
            continue
        merged.append(dict(t, tools=dict(t["tools"]), parts=list(t["parts"])))
    return merged


def echo_indices(turns):
    """Indices of no-op exchanges: a short user question + a tool-less token reply.
    Structural, not keyword-based (A-4). Same-session only. A reply's question is
    included with it (else the question is orphaned).
    """
    drop = set()
    for i, t in enumerate(turns):
        if t["role"] != "user" or len(t["text"]) > ECHO_ASK:
            continue
        n = turns[i + 1] if i + 1 < len(turns) else None
        if (n and n["role"] == "assistant" and not n["tools"]
                and len(n["text"].strip()) <= ECHO_REPLY
                and n.get("session") == t.get("session")):
            drop |= {i, i + 1}
    return drop


def drop_echo_exchanges(turns):
    """Drop the no-op exchanges echo_indices finds."""
    drop = echo_indices(turns)
    return [t for i, t in enumerate(turns) if i not in drop]


def fill_missing_ts(turns):
    """Carry the previous timestamp forward to records that lack one, so a
    record with no ts sorts right after its predecessor (D-1 stable ordering)
    rather than jumping to the session start."""
    last = None
    for t in turns:
        if t.get("ts"):
            last = t["ts"]
        elif last is not None:
            t["ts"] = last
    return turns


# ---------------------------------------------------------------- Summary
# Sentence boundary: terminator followed by whitespace/end, NOT preceded by a
# digit (guards "5.3", "2024. 08. 31.", "EOS.xlsx"). Lookbehind width 2.
_SENT_SPLIT = re.compile(r"(?<=[.!?…])(?<![0-9][.!?…])(?=\s|$)\s*|\n+")
_INTENT_ONLY_RE = re.compile(
    r"^.{0,30}(?:하겠습니다|합니다|해보겠습니다|확인합니다|봅니다|"
    r"보겠습니다|시작합니다|진행합니다)\.?$")
SHORT_DETAIL = 160
SINGLE_SPLIT_MIN = SHORT_DETAIL


_OPEN_MARKER_RE = re.compile(r"\[REDACTED[^\]]*$")


def _cut(s, n):
    s = s.strip()
    if len(s) <= n:
        return s
    head = _OPEN_MARKER_RE.sub("", s[:max(1, n - 1)])   # a marker cut in two goes whole
    return head.rstrip() + "…"


def naive_summary(text: str) -> str:
    """First sentence or ~120 chars."""
    text = text.strip()
    if not text:
        return "(empty turn)"
    parts = [s for s in _SENT_SPLIT.split(text) if s and s.strip()]
    first = parts[0].strip() if parts else text
    s = first.strip()
    if len(s) > 120:
        s = s[:117] + "…"
    if len(s) < 8:
        s = text[:120].replace("\n", " ")
    return s or "(empty)"


def _tail_block(blocks):
    """Last block that reads as prose (skip tables/headings/fences/<15 chars)."""
    for b in reversed(blocks):
        s = b.strip()
        if len(s) < 15 or s.startswith(("|", "```")) or re.match(r"^#{1,6}\s", s):
            continue
        return b
    return blocks[-1] if blocks else ""


def _summary_from(text, from_end=False):
    parts = [s for s in _SENT_SPLIT.split(text) if s and s.strip()]
    if not parts:
        return ""
    return (parts[-1] if from_end else parts[0]).strip()


def summarize_turn(turn):
    """One-line summary that carries the CONCLUSION, not just the intent (B-2).

    Reads head + tail: the conclusion clause of an execution turn lives at the
    end. If the opener is a pure intent sentence, the tail takes over entirely.
    """
    parts = [p for p in (turn.get("parts") or []) if p.strip()]
    if len(parts) < 2:
        if len(turn["text"]) < SINGLE_SPLIT_MIN:
            return naive_summary(turn["text"])
        parts = [b for b in re.split(r"\n\s*\n", turn["text"]) if b.strip()] or parts
        if len(parts) < 2:
            return naive_summary(turn["text"])
    head = _summary_from(parts[0]) or naive_summary(parts[0])
    if _INTENT_ONLY_RE.match(head):
        only = _summary_from(_tail_block(parts), from_end=True)
        if only and only != "(empty turn)":
            return _cut(only, 120)
    tail = _summary_from(_tail_block(parts), from_end=True)
    if not tail or tail == head:
        return _cut(head, 120)
    head = _cut(head, 58)
    return head + " … " + _cut(tail, max(1, 120 - len(head) - 3))


# ---------------------------------------------------------------- Summary cache
def _stdin_id_key():
    """The key that turns a pasted turn's text into its id: random, kept 0600 in the cache folder,
    so ids (and the caches keyed on them) stay the same on this machine. Part files carry the id
    to a model that never sees the key, so an id gives no way to test a guessed password. With no
    cache folder to keep it in, the key lasts one run."""
    path = CACHE_BASE / "stdin-id.key"
    try:
        key = path.read_bytes()
        if len(key) == 32:
            return key
    except OSError:
        pass
    key = os.urandom(32)
    tmp = path.with_name("%s.%d" % (path.name, os.getpid()))
    try:
        CACHE_BASE.mkdir(parents=True, exist_ok=True)
        os.chmod(str(CACHE_BASE), 0o700)
        fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "wb") as f:
            f.write(key)
        os.replace(str(tmp), str(path))           # whole or not at all
    except OSError:
        try:
            os.unlink(str(tmp))
        except OSError:
            pass
    return key


def cache_dir(session_id: str):
    d = CACHE_BASE / str(SCHEMA_VERSION) / (session_id or "default")
    d.mkdir(parents=True, exist_ok=True)
    for p in (d, CACHE_BASE / str(SCHEMA_VERSION), CACHE_BASE):
        try:
            os.chmod(p, 0o700)
        except OSError:
            pass
    return d


def _page_clean_turn(t, extra, mode):
    """`t` with its text and parts as a page shows them, so a summary cut from it cannot cut a
    secret in two and keep the half no pattern recognises."""
    def clean(s):
        return page_redact(s, extra, mode)[0]
    return dict(t, text=clean(t["text"]), parts=[clean(p) for p in t.get("parts") or []])


def read_or_summarize(turn: dict, session_id: str, rebuild: bool = False,
                      redact_extra=None, redact_mode: str = "full"):
    """Return (summary, cache_hit). Cache key includes the content hash AND the
    summarizer version (B-3), so changing the summarizer invalidates old entries.
    Cached text is always redacted (secret hygiene). It is cut from the redacted text (3.0.2).
    """
    digest = hashlib.sha256(
        (turn["text"] + "\x00s" + str(SUMMARIZER_VERSION)).encode()
    ).hexdigest()[:8]
    try:                                          # ids come from the transcript: keep them in the cache
        p = (cache_dir(_safe_name(turn.get("session") or session_id))
             / f"{_safe_name(turn['uuid'])}-{digest}.txt")
    except OSError as e:                          # no writable cache: summarize anyway
        _warn_once("_no_cache", f"cache unavailable ({e}); summaries are not cached")
        p = None
    if p is not None and p.exists() and not rebuild:
        try:
            return p.read_text(encoding="utf-8").strip(), True
        except (OSError, UnicodeDecodeError):
            pass
    redacted = summarize_turn(_page_clean_turn(turn, redact_extra, redact_mode))
    if p is not None:
        try:
            fd = os.open(str(p), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(redacted)
        except OSError:
            pass
    return redacted, False


def _warn_once(key, message):
    if not getattr(_warn_once, key, False):
        print(f"[lineage] WARN: {message}", file=sys.stderr)
        setattr(_warn_once, key, True)


# ---------------------------------------------------------------- Markdown (C-1..C-3)
# Carve code spans and https-only links to opaque sentinels BEFORE emphasis, so
# no emphasis rule ever runs over emitted markup (C-2). Sentinel chars exclude
# every markdown metachar. Operates on ALREADY-ESCAPED text.
_SENTINEL = "\x00%d\x00"
_SENTINEL_RE = re.compile(r"\x00(\d+)\x00")
_MD_CARVE = re.compile(
    r"`(?P<code>[^`\n]+)`"
    r"|\[(?P<label>[^\]\n]+)\]\((?P<url>https?://[^\s)]+)\)")
_MD_BOLD = re.compile(r"\*\*(?=\S)(.+?)(?<=\S)\*\*", re.S)
_MD_DEL = re.compile(r"~~(?=\S)([^<]+?)(?<=\S)~~")
_MD_ITAL = re.compile(r"(?<![*\w])\*(?=\S)([^*<\n]+?)(?<=\S)\*(?![*\w])")
_FENCE_RE = re.compile(r"^\s*(`{3,})(\S*)\s*$")
_FENCE_CLOSE_RE = re.compile(r"^\s*(`{3,})\s*$")
_HEAD_RE = re.compile(r"^(#{1,6})\s+(.*)$")
_HR_RE = re.compile(r"^\s*([-*_])(?:\s*\1){2,}\s*$")
_QUOTE_RE = re.compile(r"^\s*>")
_LIST_RE = re.compile(r"^(\s*)([-*+]|\d+[.)])\s+(.*)$")
_TABLE_DELIM_RE = re.compile(r"^\s*\|?[\s:|-]+\|[\s:|-]*$")


def _md_inline(escaped):
    """Inline markdown on an already-html.escaped string (carve → emphasis → restore)."""
    stash = []

    def carve(m):
        if m.group("code") is not None:
            stash.append("<code>%s</code>" % m.group("code"))
        else:
            stash.append(
                '<a href="%s" target="_blank" rel="noopener noreferrer">%s</a>'
                % (m.group("url"), m.group("label")))
        return _SENTINEL % (len(stash) - 1)

    s = _MD_CARVE.sub(carve, escaped)
    s = _MD_BOLD.sub(r"<strong>\1</strong>", s)
    s = _MD_DEL.sub(r"<del>\1</del>", s)
    s = _MD_ITAL.sub(r"<em>\1</em>", s)
    return _SENTINEL_RE.sub(lambda m: stash[int(m.group(1))], s)


def _is_block_start(lines, i):
    line = lines[i]
    if (_FENCE_RE.match(line) or _HEAD_RE.match(line) or _HR_RE.match(line)
            or _QUOTE_RE.match(line) or _LIST_RE.match(line)):
        return True
    # table: this line has a pipe AND the next line is a delimiter row
    if ("|" in line and i + 1 < len(lines)
            and "-" in lines[i + 1] and _TABLE_DELIM_RE.match(lines[i + 1])):
        return True
    return False


def _render_table(lines, i):
    header = [c.strip() for c in lines[i].strip().strip("|").split("|")]
    i += 2  # skip header + delimiter
    rows = []
    while i < len(lines) and "|" in lines[i] and lines[i].strip():
        rows.append([c.strip() for c in lines[i].strip().strip("|").split("|")])
        i += 1
    thead = "".join("<th>%s</th>" % _md_inline(html.escape(c)) for c in header)
    body = "".join(
        "<tr>%s</tr>" % "".join("<td>%s</td>" % _md_inline(html.escape(c))
                                for c in r)
        for r in rows)
    return ("<table><thead><tr>%s</tr></thead><tbody>%s</tbody></table>"
            % (thead, body)), i


def render_markdown(text, depth=0):
    """Block-level markdown → HTML. External deps: none. Escapes first; no stage
    re-runs over prior markup. Nested lists flatten; footnotes unsupported.
    """
    if depth > _BLOCKQUOTE_MAX_DEPTH:
        return "<p>%s</p>" % _md_inline(html.escape(text))
    text = _CTRL_RE.sub("", text)
    lines = text.split("\n")
    out = []
    i, n = 0, len(lines)
    while i < n:
        line = lines[i]
        mf = _FENCE_RE.match(line)
        if mf:
            fence = mf.group(1)
            i += 1
            buf = []
            while i < n:
                mc = _FENCE_CLOSE_RE.match(lines[i])
                if mc and len(mc.group(1)) >= len(fence):
                    i += 1
                    break
                buf.append(lines[i])
                i += 1
            out.append("<pre><code>%s</code></pre>"
                       % html.escape("\n".join(buf)))
            continue
        mh = _HEAD_RE.match(line)
        if mh:
            hl = max(3, min(6, len(mh.group(1))))     # h3..h6 (avoid page-header clash)
            out.append("<h%d>%s</h%d>"
                       % (hl, _md_inline(html.escape(mh.group(2).strip())), hl))
            i += 1
            continue
        if _HR_RE.match(line):
            out.append("<hr>")
            i += 1
            continue
        if _QUOTE_RE.match(line):
            buf = []
            while i < n and _QUOTE_RE.match(lines[i]):
                buf.append(re.sub(r"^\s*>\s?", "", lines[i]))
                i += 1
            out.append("<blockquote>%s</blockquote>"
                       % render_markdown("\n".join(buf), depth + 1))
            continue
        if ("|" in line and i + 1 < n and "-" in lines[i + 1]
                and _TABLE_DELIM_RE.match(lines[i + 1])):
            tbl, i = _render_table(lines, i)
            out.append(tbl)
            continue
        ml = _LIST_RE.match(line)
        if ml:
            ordered = bool(re.match(r"^\s*\d+[.)]", line))
            tag = "ol" if ordered else "ul"
            items = []
            while i < n:
                mli = _LIST_RE.match(lines[i])
                if not mli:
                    break
                items.append(_md_inline(html.escape(mli.group(3))))
                i += 1
            out.append("<%s>%s</%s>"
                       % (tag, "".join("<li>%s</li>" % it for it in items), tag))
            continue
        if not line.strip():
            i += 1
            continue
        # paragraph: force-consume at least this line (C-2: no infinite loop)
        buf = [line]
        i += 1
        while i < n and lines[i].strip() and not _is_block_start(lines, i):
            buf.append(lines[i])
            i += 1
        # source newlines within a paragraph become <br> (N5). pre-wrap on the
        # container preserves leading/aligned spaces without double-breaking,
        # because we join with <br> and emit no literal newline between lines.
        out.append("<p>%s</p>"
                   % "<br>".join(_md_inline(html.escape(b)) for b in buf))
    return "\n".join(out)


def render_body(text, markdown=True):
    """Render a message body: markdown HTML, or escaped pre-wrap text."""
    if markdown:
        return render_markdown(text)
    return html.escape(text)


# ---------------------------------------------------------------- HTML template
HTML_TEMPLATE = r"""<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{TITLE}}</title>
<style>
  :root{--bg:#abc1d1;--me:#fee500;--me-text:#3c1e1e;--bot:#fff;--bot-text:#222;
        --meta:#516680;--header:#3b5e7a;--agent:#e8eef4;--agent-text:#2a3b4d;
        --agent-bar:#6b7f95;--pill-date-bg:#1c3a52;--pill-date-fg:#fff;
        --pill-sess-bg:#fff;--pill-sess-fg:#284b66;--pill-cmp-fg:#eaf1f7;}
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo",
       "Malgun Gothic","Helvetica Neue",sans-serif;background:var(--bg);color:#222;
       font-size:14px;line-height:1.45}
  header{position:sticky;top:0;background:var(--header);color:#fff;padding:12px 16px;
         display:flex;justify-content:space-between;align-items:center;gap:10px;
         box-shadow:0 1px 4px rgba(0,0,0,.15);z-index:10}
  header h1{margin:0;font-size:15px;font-weight:600}
  header .sub{font-size:11px;opacity:.85}
  header .now{font-size:11px;opacity:.95;text-align:right;white-space:nowrap;
              font-variant-numeric:tabular-nums}
  .room{padding:12px 8px 60px 8px;max-width:820px;margin:0 auto}
  .day{text-align:center;margin:18px 0 10px}
  .pill{display:inline-block;padding:3px 12px;border-radius:12px;font-size:11.5px;
        font-weight:600;letter-spacing:.3px}
  .pill-date{background:var(--pill-date-bg);color:var(--pill-date-fg)}
  .pill-session{background:var(--pill-sess-bg);color:var(--pill-sess-fg);
                border:1px solid #b6c6d4}
  .pill-compact{background:transparent;color:var(--pill-cmp-fg);border:1px dashed
                rgba(255,255,255,.7);font-weight:500}
  .row{display:flex;margin:6px 0;align-items:flex-end}
  .row.me{justify-content:flex-end}
  .row.bot{justify-content:flex-start}
  .avatar{width:32px;height:32px;border-radius:8px;background:#5a7fa3;color:#fff;
          display:flex;align-items:center;justify-content:center;font-size:12px;
          font-weight:600;margin-right:6px;flex-shrink:0}
  .avatar.agent{background:var(--agent-bar)}
  .bubble{max-width:78%;padding:8px 12px;border-radius:14px;word-break:break-word;
          box-shadow:0 1px 1px rgba(0,0,0,.08)}
  .me .bubble{background:var(--me);color:var(--me-text);border-bottom-right-radius:4px}
  .bot .bubble{background:var(--bot);color:var(--bot-text);
               border-bottom-left-radius:4px}
  .row.agent .bubble{background:var(--agent);color:var(--agent-text);
                     border-left:3px solid var(--agent-bar)}
  .me .bubble,.bot .bubble{overflow:hidden}
  .me .bubble>details,.bot .bubble>details{margin:-8px -12px}
  details{cursor:pointer}
  summary{padding:8px 12px;list-style:none;outline:none;position:relative;
          font-weight:500}
  summary::-webkit-details-marker{display:none}
  summary::after{content:"\25BE";position:absolute;right:10px;top:8px;
                 color:#999;font-size:10px;transition:transform .15s}
  details[open]>summary::after{transform:rotate(180deg)}
  details[open]>summary{border-bottom:1px solid #eee;background:#fafbfc}
  details[open]>summary .sum{display:none}          /* hide summary when open (both speakers) */
  .me details[open]>summary{background:rgba(0,0,0,.05)}
  .detail{padding:8px 12px 10px;font-size:13px}
  .bot .detail,.row.agent .detail{color:#333}
  .from{font-size:11px;color:var(--agent-bar);font-weight:600;margin-bottom:4px}
  .detail p,.detail li,.detail blockquote{white-space:pre-wrap;margin:4px 0}
  .detail h3,.detail h4,.detail h5,.detail h6{margin:8px 0 4px;font-size:13.5px}
  .detail ul,.detail ol{margin:4px 0;padding-left:20px}
  .detail code{background:#f1f3f5;padding:1px 5px;border-radius:3px;
               font-family:"SF Mono",Menlo,Consolas,monospace;font-size:12px}
  .detail pre{background:#1e1e1e;color:#e0e0e0;padding:8px 10px;border-radius:6px;
              overflow-x:auto;font-size:11.5px;line-height:1.4;margin:6px 0}
  .detail pre code{background:none;padding:0;color:inherit}
  .detail table{border-collapse:collapse;margin:6px 0;font-size:12px}
  .detail th,.detail td{border:1px solid #d4dde5;padding:3px 8px;text-align:left}
  .detail blockquote{border-left:3px solid #c6d1dc;padding-left:8px;color:#556}
  .detail a{color:#0e6b6b}
  .me .plain{white-space:pre-wrap}
  .tools{background:#eef3f8;border-left:3px solid #5a7fa3;padding:6px 10px;
         margin-top:6px;font-size:11.5px;color:#365675;border-radius:4px}
  .time{font-size:10px;color:var(--meta);margin:0 4px;white-space:nowrap}
  .helpbtn{position:fixed;right:14px;bottom:14px;width:34px;height:34px;
           border-radius:50%;background:var(--header);color:#fff;border:none;
           font-size:16px;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,.3);z-index:20}
  .overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);display:none;
           align-items:center;justify-content:center;z-index:30}
  .overlay.on{display:flex}
  .card{background:#fff;color:#222;border-radius:10px;padding:18px 20px;
        max-width:420px;width:90%;box-shadow:0 8px 30px rgba(0,0,0,.3);font-size:13px}
  .card h2{margin:0 0 10px;font-size:15px}
  .card dl{margin:0;display:grid;grid-template-columns:auto 1fr;gap:4px 12px}
  .card dt{font-family:"SF Mono",Menlo,Consolas,monospace;font-weight:600;color:#0e6b6b}
  @media(max-width:480px){.bubble{max-width:86%;font-size:13px}.avatar{display:none}}
</style>
</head>
<body>
<header><div><h1>{{HEADER_TITLE}}</h1><div class="sub">메시지를 탭하여 펼치기 · ? 도움말</div></div>
<div class="now" id="now">{{DATE_RANGE}}</div></header>
<div class="room" id="room">
{{TURNS}}
</div>
<button class="helpbtn" id="helpbtn" aria-label="도움말" title="도움말 (?)">?</button>
<div class="overlay" id="overlay" role="dialog" aria-modal="true" aria-label="도움말">
  <div class="card">
    <h2>키보드 · 범례</h2>
    <dl>
      <dt>A</dt><dd>전체 펼치기</dd>
      <dt>Z</dt><dd>전체 접기</dd>
      <dt>J / K</dt><dd>다음 / 이전 내 메시지</dd>
      <dt>T / B</dt><dd>맨 위 / 맨 아래</dd>
      <dt>?</dt><dd>이 도움말</dd>
      <dt>Esc</dt><dd>닫기</dd>
    </dl>
    <p style="margin:10px 0 0;color:#667">노랑=나 · 흰색=Claude · 회색=에이전트 보고.
    날짜/세션/compaction 은 알약 형태로 구분됩니다.</p>
  </div>
</div>
<script>
(function(){
  var room=document.getElementById('room');
  var overlay=document.getElementById('overlay');
  var helpbtn=document.getElementById('helpbtn');
  var nowEl=document.getElementById('now');
  var lastFocus=null;
  function all(open){var ds=room.querySelectorAll('details');for(var i=0;i<ds.length;i++)ds[i].open=open;}
  function setHelp(on){
    overlay.classList.toggle('on',on);
    if(on){lastFocus=document.activeElement;overlay.focus&&overlay.focus();}
    else if(lastFocus&&lastFocus.focus){lastFocus.focus();}
  }
  helpbtn.addEventListener('click',function(){setHelp(true);});
  // overlay closes on BACKDROP click only (so the card text stays selectable)
  overlay.addEventListener('click',function(e){if(e.target===overlay)setHelp(false);});
  // J/K navigation anchored to the header height (top anchor), highlight cleared
  var mine=[],curIdx=-1,anchor=0;
  function measure(){
    var h=document.querySelector('header');anchor=h?h.offsetHeight+6:56;
    mine=[].slice.call(room.querySelectorAll('.row.me'));
  }
  function step(dir){
    if(!mine.length)measure();if(!mine.length)return;
    curIdx=Math.max(0,Math.min(mine.length-1,curIdx+dir));
    var el=mine[curIdx];
    for(var i=0;i<mine.length;i++)mine[i].style.outline='';
    el.style.outline='2px solid #fee500';
    var y=el.getBoundingClientRect().top+window.pageYOffset-anchor;
    window.scrollTo(0,y);
  }
  // header shows the current date/session while scrolling
  var marks=[].slice.call(room.querySelectorAll('[data-mark]'));
  function updateNow(){
    if(!marks.length)return;var y=window.pageYOffset+80,cur=null;
    for(var i=0;i<marks.length;i++){if(marks[i].offsetTop<=y)cur=marks[i];}
    if(cur&&nowEl)nowEl.textContent=cur.getAttribute('data-mark');
  }
  window.addEventListener('scroll',updateNow,{passive:true});
  window.addEventListener('resize',measure);measure();updateNow();
  document.addEventListener('keydown',function(e){
    // never hijack browser shortcuts; die-safe under Korean IME (e.key='ㅁ')
    if(e.ctrlKey||e.metaKey||e.altKey||e.isComposing)return;
    var t=e.target;
    if(t&&(t.isContentEditable||/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName||'')))return;
    if(overlay.classList.contains('on')){if(e.key==='Escape'){setHelp(false);e.preventDefault();}return;}
    var c=e.code||'',k=(e.key||'').toLowerCase();
    if(c==='KeyA'||k==='a')all(true);
    else if(c==='KeyZ'||k==='z')all(false);
    else if(c==='KeyJ'||k==='j')step(1);
    else if(c==='KeyK'||k==='k')step(-1);
    else if(c==='KeyT'||k==='t')window.scrollTo(0,0);
    else if(c==='KeyB'||k==='b')window.scrollTo(0,document.body.scrollHeight);
    else if(e.key==='?'||(c==='Slash'&&e.shiftKey))setHelp(true);
    else return;
    e.preventDefault();
  });
})();
</script>
</body>
</html>
"""


# ---------------------------------------------------------------- Render rows
def user_fold_summary(redacted_text):
    """The summary line of a user turn long enough to fold (USER_FOLD)."""
    return _cut(redacted_text.replace("\n", " "), 90)


def _page_summary(t, summaries, session_id, rebuild, redact_extra, redact_mode):
    """(summary, cache_hit) of a bot turn as the page shows it: the reviewer's when
    `summaries` has one (cache_hit None: no rule summary was looked up), else the
    rules' (cached)."""
    if summaries is not None and t.get("uuid") in summaries:
        return summaries[t["uuid"]], None
    return read_or_summarize(t, session_id, rebuild=rebuild,
                             redact_extra=redact_extra, redact_mode=redact_mode)


def _reviewed_fold(t, summaries):
    """A reviewer's summary for a folded user turn, or None."""
    return summaries.get(t.get("uuid")) if summaries is not None else None


def _fmt_time(ts):
    return ts[11:16] if ts and len(ts) >= 16 else ""


def render_rows(turns, session_id, redact_extra, redact_mode, rebuild,
                open_details=False, markdown=True, all_sessions=False, summaries=None):
    rows = []
    last_date = None
    last_session = None
    cache_hits = 0
    cache_total = 0
    redact_counts = {}
    open_attr = " open" if open_details else ""

    def _red(text):
        r, c = page_redact(text, extra=redact_extra, mode=redact_mode)
        for k, v in c.items():
            redact_counts[k] = redact_counts.get(k, 0) + v
        return r

    for t in turns:
        ts = t.get("ts") or ""
        # session-transition divider (--all-sessions)
        if all_sessions and t.get("session") != last_session:
            last_session = t.get("session")
            name = html.escape(_red(t.get("session_name") or last_session or "session"))
            rows.append('<div class="day" data-mark="%s">'
                        '<span class="pill pill-session">%s</span></div>'
                        % (name, name))
            last_date = None
        if ts:
            d = ts[:10]
            if d != last_date:
                rows.append('<div class="day" data-mark="%s">'
                            '<span class="pill pill-date">%s</span></div>'
                            % (html.escape(d), html.escape(d)))
                last_date = d
        time_hm = html.escape(_fmt_time(ts))
        role = t["role"]

        if role == "mark":
            rows.append('<div class="day"><span class="pill pill-compact">'
                        '⋯ 이전 대화 요약(compaction) ⋯</span></div>')
            continue

        if role == "user":
            red = _red(t["text"])
            if len(red) > USER_FOLD:
                reviewed = _reviewed_fold(t, summaries)
                summary = html.escape(_red(reviewed) if reviewed else user_fold_summary(red))
                body = render_body(red, markdown=markdown)
                rows.append(
                    '<div class="row me"><span class="time">%s</span>'
                    '<div class="bubble"><details%s>'
                    '<summary><span class="sum">%s</span></summary>'
                    '<div class="detail">%s</div></details></div></div>'
                    % (time_hm, open_attr, summary, body))
            else:
                rows.append(
                    '<div class="row me"><span class="time">%s</span>'
                    '<div class="bubble"><div class="plain">%s</div></div></div>'
                    % (time_hm, render_body(red, markdown=markdown)))
            continue

        # assistant or agent bubble
        summary, hit = _page_summary(t, summaries, session_id, rebuild,
                                     redact_extra, redact_mode)
        if hit is not None:
            cache_total += 1
            cache_hits += bool(hit)
        esc_sum = html.escape(_red(summary))
        detail_body = render_body(_red(t["text"]), markdown=markdown)

        tools_html = ""
        if t.get("tools"):
            ts_list = ", ".join(f"{_hide_keywords(k, redact_extra)}×{v}"
                                for k, v in sorted(t["tools"].items()))
            total = sum(t["tools"].values())
            tools_html = ('<div class="tools">🔧 도구 %d건: %s</div>'
                          % (total, html.escape(ts_list)))

        if role == "agent":
            who = html.escape(_red(t.get("agent_from") or "agent"))
            avatar = "🤝"
            from_line = '<div class="from">%s</div>' % who
            row_cls = "row bot agent"
        else:
            avatar = "C"
            from_line = ""
            row_cls = "row bot"

        rows.append(
            '<div class="%s"><div class="avatar%s">%s</div>'
            '<div class="bubble"><details%s>'
            '<summary><span class="sum">%s</span></summary>'
            '<div class="detail">%s%s%s</div></details></div>'
            '<span class="time">%s</span></div>'
            % (row_cls, " agent" if role == "agent" else "", avatar,
               open_attr, esc_sum, from_line, detail_body, tools_html, time_hm))
    return rows, redact_counts, cache_hits, cache_total


_TAG_RE = re.compile(r"<[^>]*>")


def _residual_secrets(rows_html):
    """What the reviewer patterns still find in a page's text (tags dropped, entities decoded),
    by pattern name: a field the page forgot to redact."""
    text = html.unescape(_TAG_RE.sub(" ", rows_html))
    left = {}
    for name, pat in REVIEW_SECRET_PATTERNS:
        n = len(pat.findall(text))
        if n:
            left[name] = n
    return left


# ---------------------------------------------------------------- Self-verify (F-1)
_VOID = frozenset(
    "area base br col embed hr img input link meta param source track wbr".split())
_VERIFY_TAGS = ("details", "div", "p", "ul", "ol", "li", "table", "thead",
                "tbody", "tr", "th", "td", "blockquote", "pre", "code",
                "strong", "em", "del", "a", "summary", "h3", "h4", "h5", "h6")


class _BalanceParser(HTMLParser):
    """Stack-based misnest detector, void-aware. Counts alone miss
    `<strong>a<em>b</strong>c</em>` (balanced but misnested)."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack = []
        self.errs = []

    def _check_attrs(self, tag, attrs):
        for k, _ in attrs:
            if k and k.lower().startswith("on"):
                self.errs.append("event-handler attr %s on <%s>" % (k, tag))

    def handle_starttag(self, tag, attrs):
        self._check_attrs(tag, attrs)
        if tag not in _VOID:
            self.stack.append(tag)

    def handle_startendtag(self, tag, attrs):
        self._check_attrs(tag, attrs)

    def handle_endtag(self, tag):
        if tag in _VOID:
            return
        if not self.stack:
            self.errs.append("stray </%s>" % tag)
            return
        if self.stack[-1] == tag:
            self.stack.pop()
        elif tag in self.stack:
            self.errs.append("misnest </%s> (top=%s)" % (tag, self.stack[-1]))
            while self.stack and self.stack.pop() != tag:
                pass
        else:
            self.errs.append("stray </%s>" % tag)


def self_verify(html_text: str):
    errs = []
    # strip script/style so their bodies aren't parsed as markup (avoids
    # false <a> counts from inline JS like `top<a-8`)
    markup = re.sub(r"<script\b[\s\S]*?</script>|<style\b[\s\S]*?</style>",
                    "", html_text, flags=re.I)
    try:
        HTMLParser().feed(html_text)
    except Exception as e:
        errs.append(f"HTMLParser: {e}")
    for tag in _VERIFY_TAGS:
        opens = len(re.findall(rf"<{tag}\b", markup))
        closes = len(re.findall(rf"</{tag}>", markup))
        if opens != closes:
            errs.append(f"<{tag}> open={opens} close={closes} mismatch")
    bp = _BalanceParser()
    try:
        bp.feed(markup)
    except Exception as e:
        errs.append(f"BalanceParser: {e}")
    errs.extend(bp.errs[:10])
    if bp.stack:
        errs.append("unclosed tags: %s" % bp.stack[:10])
    if re.search(r'<link rel="stylesheet', html_text):
        errs.append("external stylesheet link found")
    if re.search(r"<script src=", html_text):
        errs.append("external script src found")
    # Event-handler attributes are detected via the parser (real tag attrs),
    # NOT a text regex — escaped content like `&lt;img onerror=` is inert text.
    for marker, ph in (("<title>{{TITLE}}</title>", "{{TITLE}}"),
                       ("<h1>{{HEADER_TITLE}}</h1>", "{{HEADER_TITLE}}"),
                       ('id="now">{{DATE_RANGE}}</div>', "{{DATE_RANGE}}")):
        if marker in html_text:
            errs.append(f"unsubstituted template placeholder: {ph}")
    return errs


# ---------------------------------------------------------------- CLI
# ---------------------------------------------------------------- Review pack
# The default /lineage flow: --emit-review packs the turns for the session's model,
# its reviewers write keep/summary decisions, --apply-review renders from them. The
# pack holds redacted text only. Noise the rules are certain of (wrapper blocks, hook
# feedback, injected bodies) is gone before the pack; the rules' judgement calls (echo
# exchanges, tool-only turns) stay in it, marked, for the reviewers to confirm or undo.
def _is_keep(v):
    return v is None or isinstance(v, bool)


def _is_summary(v):
    return v is None or isinstance(v, str)


def _first(*values):
    for v in values:
        if v is not None:
            return v
    return None


def _bad(message):
    print(f"[lineage] ERROR: {message}", file=sys.stderr)
    return None


def _write_private(path, text):
    """Write `text` to `path` as a fresh 0600 file, replaced whole. The temporary file
    comes from mkstemp (created exclusively, 0600), so a link planted at a guessable name
    is never followed, and it is removed when the write fails."""
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, str(path))
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _safe_name(s):
    """A file-name-safe form of an id read from a transcript or a pack."""
    s = re.sub(r"[^A-Za-z0-9_.-]", "_", str(s or "default"))[:80]
    return s if s.strip(".") else "_"


def _decision_context(why, keeps):
    """What a cached decision rests on beside the text: the rules' call on the turn (a
    `keep: null` defers to it) and the keep flags the reviewer was told to honour."""
    return "|".join([why or "", str(keeps.get("keep_trivia") is True),
                     str(keeps.get("keep_tool_only") is True)])


def _llm_digest(redacted_text, context):
    """The decision cache key: the text with the page's patterns only (as 3.0.1 keyed it, so
    no turn is reviewed again for 3.0.2), the cache version and what the decision rests on."""
    return hashlib.sha256((redacted_text + "\x00llm" + str(LLM_CACHE_VERSION)
                           + "\x00" + context).encode()).hexdigest()[:12]


def _llm_cache_path(turn_id, session, digest):
    return cache_dir(_safe_name(session)) / f"{_safe_name(turn_id)}-{_safe_name(digest)}-llm.json"


def read_llm_cache(turn_id, session, digest):
    """A reviewer's earlier {keep, summary} for this exact (redacted) text under the same
    rule call and keep flags (`context`), or None when no reviewer saw it so. Both values
    null: the reviewer left the turn to the rules."""
    try:
        path = _llm_cache_path(turn_id, session, digest)
    except OSError as e:                          # no cache folder (a read-only HOME, say)
        _warn_once("_no_llm_cache", f"reviewer decision cache unavailable ({e}); "
                   "every turn is reviewed")
        return None
    try:
        got = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, UnicodeDecodeError):
        return None
    if not isinstance(got, dict):
        return None
    keep, summary = got.get("keep"), got.get("summary")
    if not (_is_keep(keep) and _is_summary(summary)):
        return None
    return {"keep": keep, "summary": summary}


def write_llm_cache(turn_id, session, digest, keep, summary):
    try:
        _write_private(_llm_cache_path(turn_id, session, digest),
                       json.dumps({"keep": keep, "summary": summary}, ensure_ascii=False))
    except OSError as e:
        _warn_once("_no_llm_cache_write", f"reviewer decisions not cached ({e}); the next "
                   "run reviews this run's turns again (decisions cached before still apply)")


def heuristic_drops(turns, args):
    """{index: why} for the rules' judgement calls: echo exchanges, tool-only turns."""
    drops = {}
    if args.drop_trivia:
        drops.update((i, "echo") for i in echo_indices(turns))
    if args.hide_tool_only:
        for i, t in enumerate(turns):
            if i not in drops and t["role"] == "assistant" and not t["text"].strip():
                drops[i] = "tool-only"
    return drops


def review_window(turns, drops, args):
    """Indices for the pack: the turns the range flags pick among those the rules keep
    (what a --rulebase run shows), the rule-dropped turns between them, and those past
    either end the pick reaches. None on an invalid --turns."""
    cand = [i for i, t in enumerate(turns) if _in_time(t, args)]
    kept = [i for i in cand if i not in drops]
    pool = kept or cand
    sl = _count_slice(len(pool), args)
    if sl is None:
        return None
    picked = pool[sl]
    if not kept or not picked:
        return picked
    lo = cand[0] if picked[0] == kept[0] else picked[0]
    hi = cand[-1] if picked[-1] == kept[-1] else picked[-1]
    chosen = set(picked)
    return [i for i in cand if lo <= i <= hi and (i in chosen or i in drops)]


def _preview(text):
    """The reviewer's view of a turn: whole when short, else head + tail."""
    if len(text) <= PREVIEW_HEAD + PREVIEW_TAIL + 200:
        return text, False
    cut = len(text) - PREVIEW_HEAD - PREVIEW_TAIL
    return (text[:PREVIEW_HEAD].rstrip() + f"\n\n[중간 {cut}자 생략]\n\n"
            + text[-PREVIEW_TAIL:].lstrip()), True


def _public_counts(counts):
    """Redaction counts by kind with the --redact-extra keywords folded into `custom`:
    the keywords themselves stay out of the files lineage writes."""
    out = {}
    for k, v in counts.items():
        key = "custom" if k.startswith("custom:") else k
        out[key] = out.get(key, 0) + v
    return out


def _rule_summary(t, red, args):
    """The rules' summary for the page, made afresh and redacted with THIS run's settings.
    The summary cache is keyed on the text alone, so a cached one may predate a
    --redact-extra keyword or carry another --redact-mode."""
    if t["role"] in ("assistant", "agent"):
        return summarize_turn(_page_clean_turn(t, args.redact_extra, args.redact_mode))
    if t["role"] == "user" and len(red) > USER_FOLD:
        return user_fold_summary(red)
    return None


def _redacted_turn(t, extra):
    """`t` with its text and parts fully redacted, so a summary cut from it cannot cut a
    secret in two and keep the half no pattern recognises."""
    def clean(s):
        return review_redact(s, extra)[0]
    return dict(t, text=clean(t["text"]), parts=[clean(p) for p in t.get("parts") or []])


def _review_view(t, red, args):
    """What a reviewer reads beside the preview: the rules' summary and the agent's
    name, fully redacted (the page's copies may be masked)."""
    if t["role"] in ("assistant", "agent"):
        summary = review_redact(summarize_turn(_redacted_turn(t, args.redact_extra)),
                                args.redact_extra)[0]
    elif t["role"] == "user" and len(red) > USER_FOLD:
        summary = user_fold_summary(review_redact(t["text"], args.redact_extra)[0])
    else:
        summary = None
    who = review_redact(t["agent_from"], args.redact_extra)[0] if t.get("agent_from") else None
    return {"summary": summary, "agent_from": who}


def _pack_turn(n, t, tid, why, session_id, args, counts):
    """One turn of the pack under its final id `tid` (the text as the page shows it, the rules'
    decision, the reviewer's slot), and the reviewer's view of it. The cached decision keys on
    the text with the page's patterns only (`llm_key`), as 3.0.1 did."""
    red, found = page_redact(t["text"], extra=args.redact_extra, mode=args.redact_mode)
    for k, v in found.items():
        counts[k] = counts.get(k, 0) + v
    hit = any(name in found for name, _ in REVIEW_SECRET_PATTERNS)
    key_text = redact(t["text"], extra=args.redact_extra, mode=args.redact_mode)[0] if hit else red
    preview, clipped = _preview(review_redact(t["text"], args.redact_extra)[0])
    session = t.get("session") or session_id
    context = _decision_context(why, _keeps(args))
    llm_key = _llm_digest(key_text, context)
    cached = None if args.rebuild_summaries else read_llm_cache(tid, session, llm_key)
    view = _review_view(t, red, args)
    turn = {"id": tid, "n": n, "role": t["role"], "ts": t.get("ts") or "",
            "tools": dict(t.get("tools") or {}), "text": red, "llm_key": llm_key,
            "redactions": _public_counts(found), "preview": preview, "clipped": clipped,
            "rule": {"keep": why is None, "why": why,
                     "summary": _rule_summary(t, red, args),
                     "review_summary": view["summary"]},
            "llm": dict(cached, cached=True) if cached else {"keep": None, "summary": None}}
    if t.get("meta"):
        turn["meta"] = True
    for k in ("session", "session_name", "agent_from"):
        if t.get(k):
            turn[k] = t[k] if k == "session" else page_redact(t[k], args.redact_extra, args.redact_mode)[0]
    return turn, view


def _final_ids(turns, window):
    """Pack ids, fixed before anything reads the decision cache: the turn uuid, with #N
    on a repeat (stdin uuids are content hashes, so equal texts share one). Counted over
    every turn, not the window, so a turn keeps its id whichever range is picked."""
    seen, ids = {}, {}
    for i, t in enumerate(turns):
        u = t["uuid"]
        seen[u] = seen.get(u, 0) + 1
        ids[i] = u if seen[u] == 1 else f"{u}#{seen[u]}"
    return [ids[i] for i in window]


def _split_even(items, size):
    """Parts of at most `size` items, as even as possible (41: 21 + 20, not 40 + 1)."""
    if not items:
        return []
    step = -(-len(items) // -(-len(items) // size))
    return [items[k:k + step] for k in range(0, len(items), step)]


def _decisions_name(part_path):
    return part_path.with_name(part_path.stem + ".decisions.json").name


def _clear_parts(pack_path):
    """Remove the part and decisions files an earlier --emit-review left beside the
    pack, and an earlier gate's samples: that run's decisions must not be applied to this
    one, and its samples would stop this pack's rerun. Returns the files it could not
    remove."""
    prefix = pack_path.stem + ".part-"
    samples = f"{pack_path.stem}.reviewer-input.json"
    try:
        olds = [p for p in pack_path.parent.iterdir()
                if (p.name.startswith(prefix) and p.name.endswith(".json")) or p.name == samples]
    except OSError:
        return []
    failed = []
    for p in olds:
        try:
            p.unlink()
        except OSError:
            failed.append(p)
    return failed


def _hide_keywords(s, extra):
    """`s` with each --redact-extra keyword replaced (for short names such as tool names)."""
    for kw in [k.strip() for k in (extra or "").split(",") if k.strip()]:
        s = re.sub(re.escape(kw), "[REDACTED]", s, flags=re.IGNORECASE)
    return s


def _keeps(args):
    """The keep flags the reviewers must honour: with them, the rules keep those turns."""
    return {"keep_trivia": not args.drop_trivia, "keep_tool_only": not args.hide_tool_only}


def _sheet(k, of, part_path, group, args):
    """Part file `k`: the turns one reviewer reads, without the page-only fields."""
    turns = []
    for x, view in group:
        y = {key: v for key, v in x.items()
             if key not in ("text", "session", "session_name", "agent_from", "redactions", "llm_key")}
        y["rule"] = {k: v for k, v in x["rule"].items() if k != "review_summary"}
        y["rule"]["summary"] = view["summary"]
        y["tools"] = {_hide_keywords(name, args.redact_extra): n for name, n in x["tools"].items()}
        if x["llm"].get("summary"):               # cached: redacted for the page, maybe masked
            s = _MASKED.sub("[REDACTED]", x["llm"]["summary"])
            y["llm"] = dict(x["llm"], summary=review_redact(s, args.redact_extra)[0])
        if view["agent_from"]:
            y["agent_from"] = view["agent_from"]
        turns.append(y)
    return {"schema": REVIEW_PART_SCHEMA, "part": k, "of": of, **_keeps(args),
            "decisions": _decisions_name(part_path), "turns": turns}


def _pack_header(session_id, output, args, counts):
    """The pack's settings: what --apply-review renders with and the quality gate it runs."""
    return {"schema": REVIEW_SCHEMA, "source": session_id, "output": str(output),
            "title": args.title, "markdown": args.markdown, "open": args.open_details,
            "redact_mode": args.redact_mode, "redact_extra": bool(args.redact_extra),
            "all_sessions": bool(args.all_sessions), "redactions": _public_counts(counts),
            **_keeps(args),
            "gate": {"skip_reviewer": bool(args.skip_reviewer),
                     "reviewer_output": args.reviewer_output,
                     "reviewer_timeout": args.reviewer_timeout}}


def _report_emit(pack_path, items, paths, groups):
    dropped = sum(1 for x in items if not x["rule"]["keep"])
    cached = sum(1 for x in items if x["llm"].get("cached"))
    print(f"[lineage] review pack: {pack_path} (turns={len(items)} "
          f"rule-dropped={dropped} cached={cached})", file=sys.stderr)
    for k, (p, g) in enumerate(zip(paths, groups), 1):
        todo = sum(1 for x, _ in g if not x["llm"].get("cached"))
        print(f"[lineage] part {k}/{len(groups)}: {p} (to review: {todo}) "
              f"-> {p.with_name(_decisions_name(p))}", file=sys.stderr)
    print(f"[lineage] next: write each part's decisions, then "
          f"--apply-review {pack_path}", file=sys.stderr)


def emit_review(turns, drops, window, session_id, output, args):
    """Write the pack and one part file per reviewer; print them and the next step. A
    --reviewer-output that holds something other than a verdict list stops it here, before
    any reviewer runs: the gate would refuse it only after them."""
    rop = pathlib.Path(args.reviewer_output) if args.reviewer_output and not args.skip_reviewer else None
    if rop is not None and rop.exists() and not _is_verdict_file(rop):
        _bad(f"{rop} is there and is not a verdict list; give a --reviewer-output that does not exist yet")
        return 2
    pack_path = pathlib.Path(args.emit_review)
    counts, pairs = {}, []
    for n, (i, tid) in enumerate(zip(window, _final_ids(turns, window)), 1):
        pairs.append(_pack_turn(n, turns[i], tid, drops.get(i), session_id, args, counts))
    groups = _split_even(pairs, REVIEW_PART)
    paths = [pack_path.with_name(f"{pack_path.stem}.part-{k}.json")
             for k in range(1, len(groups) + 1)]
    pack = _pack_header(session_id, _with_timestamp_suffix(output), args, counts)
    pack["parts"] = [{"part": k, "file": p.name, "decisions": _decisions_name(p),
                      "ids": [x["id"] for x, _ in g]}
                     for k, (p, g) in enumerate(zip(paths, groups), 1)]
    pack["turns"] = [x for x, _ in pairs]
    stuck = _clear_parts(pack_path)
    if stuck:
        _bad(f"cannot remove an earlier run's files: {', '.join(map(str, stuck))}")
        return 2
    try:
        _write_private(pack_path, json.dumps(pack, ensure_ascii=False, indent=1))
        for k, (p, g) in enumerate(zip(paths, groups), 1):
            _write_private(p, json.dumps(_sheet(k, len(groups), p, g, args),
                                         ensure_ascii=False, indent=1))
    except OSError as e:
        _bad(f"cannot write the review pack: {e}")
        return 2
    _report_emit(pack_path, pack["turns"], paths, groups)
    return 0


def _is_pack_turn(x):
    return (isinstance(x, dict) and isinstance(x.get("id"), str)
            and x.get("role") in ("user", "assistant", "agent", "mark")
            and isinstance(x.get("text"), str) and isinstance(x.get("llm_key"), str)
            and isinstance(x.get("rule"), dict) and isinstance(x["rule"].get("keep"), bool)
            and _is_summary(x["rule"].get("summary"))
            and isinstance(x.get("llm"), dict) and _is_keep(x["llm"].get("keep"))
            and _is_summary(x["llm"].get("summary")))


def _load_pack(path):
    try:
        pack = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, UnicodeDecodeError) as e:
        return _bad(f"cannot read review pack {path}: {e}")
    if not isinstance(pack, dict) or pack.get("schema") != REVIEW_SCHEMA:
        return _bad(f"{path} is not a {REVIEW_SCHEMA} pack (made by another lineage version? "
                    "run --emit-review again)")
    if not isinstance(pack.get("turns"), list) or not all(map(_is_pack_turn, pack["turns"])):
        return _bad(f"{path}: malformed turns")
    return pack


def _decision_files(pack_path, pack, explicit):
    """The parts' decisions files that exist beside the pack, then each --decisions.
    Those beside the pack are made 0600: the session wrote them with its own umask."""
    beside = [pack_path.with_name(p["decisions"]) for p in pack.get("parts") or []
              if isinstance(p, dict) and isinstance(p.get("decisions"), str)]
    files, seen = [], set()
    for f in [f for f in beside if f.exists()] + [pathlib.Path(f) for f in explicit]:
        if os.path.realpath(str(f)) not in seen:
            seen.add(os.path.realpath(str(f)))
            files.append(f)
    for f in beside:
        try:
            os.chmod(str(f), 0o600)
        except OSError:
            pass
    return files


# Keys of a part file's turns: a list of objects carrying one is the reviewer quoting its
# input, not its answer.
_PART_TURN_KEYS = frozenset({"n", "role", "ts", "tools", "text", "preview", "clipped",
                             "rule", "llm", "meta", "agent_from"})


def _is_answer(d):
    """A decision, extra keys and all; a part turn quoted back (its keep and summary sit
    under rule and llm, not on top) is not one."""
    return (isinstance(d, dict) and "id" in d
            and ("keep" in d or "summary" in d or not _PART_TURN_KEYS & d.keys()))


def _decisions_text(text):
    """The JSON list in a reviewer's answer: the whole text, or, when the answer came
    wrapped (a code fence, a sentence with brackets of its own, a list of files or a quote
    of the part's turns around it), the longest list of {id, ...} objects in it that is
    not such a quote (the last of equal ones: an example quoted before the answer loses),
    else an empty list it holds."""
    try:
        return json.loads(text)
    except (ValueError, RecursionError):
        pass
    lists, empty = [], False
    decoder = json.JSONDecoder()
    # only where a list of objects or an empty list can start: a run of `[` is tried once,
    # and only so many starts (each failed try parses up to the nesting limit)
    for k, m in enumerate(re.finditer(r"\[(?=\s*[{\]])", text)):
        if k == DECISIONS_TRIES:
            raise ValueError(f"more than {DECISIONS_TRIES} places a list may start; "
                             "write the bare JSON array")
        try:
            got, _ = decoder.raw_decode(text, m.start())
        except (ValueError, RecursionError):
            continue
        if got == []:
            empty = True
        elif isinstance(got, list) and all(_is_answer(d) for d in got):
            lists.append(got)
    if lists:
        return max(reversed(lists), key=len)
    if empty:
        return []
    raise ValueError("no JSON list of {id, keep, summary} objects in it")


def _decision_problem(d):
    """Why item `d` of a decisions file is not a decision, or ""."""
    if not (isinstance(d, dict) and isinstance(d.get("id"), str)
            and _is_keep(d.get("keep")) and _is_summary(d.get("summary"))):
        return 'want {"id": str, "keep": true|false|null, "summary": str|null}'
    if not _is_answer(d):
        return "a turn of the part file, not a decision"
    return ""


def _load_decisions(files):
    """{id: {keep, summary}} from the files in order, a later value winning; None when a
    file is not a JSON list of {id, keep, summary}. A file whose every decision is null
    is read, with a WARN: the rules then decide all its turns."""
    merged = {}
    for f in files:
        try:
            if f.stat().st_size > DECISIONS_MAX:
                raise ValueError(f"larger than {DECISIONS_MAX} bytes")
            items = _decisions_text(f.read_text(encoding="utf-8"))
        except (OSError, ValueError, UnicodeDecodeError, RecursionError) as e:
            return _bad(f"cannot read decisions {f}: {e}")
        if not isinstance(items, list):
            return _bad(f"{f}: decisions must be a JSON list of {{id, keep, summary}}")
        for k, d in enumerate(items):
            why = _decision_problem(d)
            if why:
                return _bad(f"{f}[{k}]: {why}")
            cur = merged.setdefault(d["id"], {})
            for key in ("keep", "summary"):
                if d.get(key) is not None:
                    cur[key] = d[key]
        if items and all(d.get("keep") is None and d.get("summary") is None for d in items):
            print(f"[lineage] WARN: {f}: all {len(items)} decisions are null; the rules "
                  "decide those turns", file=sys.stderr)
    return merged


def _clean_summary(s, extra, mode):
    """A reviewer's summary as the page shows it (one line, redacted, then cut), and how
    many secret-like strings that redaction hid. The reviewer patterns go first and hide
    a key whole, whatever --redact-mode says: the summary is cached and goes back to the
    next reviewer and the gate's critic, so no part of a key may stay in it."""
    pre, n = review_redact(" ".join(s.split()), extra)
    red, found = redact(pre, extra=extra, mode=mode)
    return (_cut(red, SUMMARY_MAX) or None), n + sum(found.values())


def _warn_coverage(pack, decided):
    """Name the parts that left turns undecided: the rules decide those, and since only
    decided turns are cached, they are reviewed again next time."""
    for p in pack.get("parts") or []:
        ids = p.get("ids") if isinstance(p, dict) else None
        if not isinstance(ids, list):
            continue
        todo = [i for i in ids if i not in decided]
        if todo:
            more = ", ..." if len(todo) > 3 else ""
            print(f"[lineage] WARN: part {p.get('part')}: {len(todo)}/{len(ids)} turns "
                  f"undecided ({', '.join(map(str, todo[:3]))}{more}); the rules decide them",
                  file=sys.stderr)


def _reviewer_summary(x, d, args, stats):
    """The reviewer's summary for pack turn `x` (this run's decision `d`, else the cached
    one), cleaned; secret-like strings in it are counted and the turn is named."""
    raw = _first(d.get("summary"), x["llm"].get("summary"))
    if not raw:
        return None
    s, n = _clean_summary(raw, args.redact_extra, args.redact_mode)
    if n:
        stats["hidden"] += n
        print(f"[lineage] WARN: the reviewer summary for {x['id']} held {n} "
              "secret-like string(s); redacted", file=sys.stderr)
    return s


def _show(x, llm_summary, turns, summaries, stats, prior):
    """Put kept pack turn `x` on the page with the summary it shows; `prior` adds up what
    --emit-review redacted."""
    shows = x["role"] in ("assistant", "agent") or (
        x["role"] == "user" and len(x["text"]) > USER_FOLD)
    if llm_summary and not shows:
        stats["ignored"] += 1
    summary = (llm_summary if shows else None) or x["rule"].get("summary")
    if summary:
        summaries[x["id"]] = summary
    stats["reviewer" if llm_summary and shows else "rule"] += bool(summary)
    for k, v in (x.get("redactions") or {}).items():
        if isinstance(v, int):
            prior[k] = prior.get(k, 0) + v
    # what the gate's critic reads: the reviewer's summary, else the rules' cut from the
    # fully redacted text (the page's is cut first and may keep half a secret)
    sample = (llm_summary if shows else None) or x["rule"].get("review_summary")
    turns.append({"uuid": x["id"], "role": x["role"], "text": x["text"],
                  "ts": x.get("ts") or None, "tools": dict(x.get("tools") or {}),
                  "parts": [], "session": x.get("session"),
                  "session_name": x.get("session_name"),
                  "agent_from": x.get("agent_from"), "preview": x.get("preview"),
                  "sample_summary": sample})


def _kept_by_flag(pack, x):
    """True when a keep flag given at --emit-review keeps pack turn `x` whatever the
    reviewer says: --keep-trivia keeps every turn the rules keep, --keep-tool-only the
    tool-only ones (the rules keep those only with that flag)."""
    if not x["rule"]["keep"]:
        return False
    if pack.get("keep_trivia") is True:
        return True
    tool_only = x["role"] == "assistant" and not x["text"].strip()
    return pack.get("keep_tool_only") is True and tool_only


def _review_result(pack, merged, args):
    """(turns to render, their summaries, cache writes, counts, prior redactions, the ids of
    turns the user typed that the reviewers dropped) from the pack and the decisions: a
    reviewer's value first, then the pack's cached one, then the rules'. A keep flag outranks
    a reviewer's `false`; the cache still gets what was said."""
    turns, summaries, writes, prior, typed = [], {}, [], {}, []
    stats = {"restored": 0, "dropped": 0, "reviewer": 0, "rule": 0, "ignored": 0,
             "hidden": 0, "flag-kept": 0}
    for x in pack["turns"]:
        d = merged.get(x["id"], {})
        llm_keep = _first(d.get("keep"), x["llm"].get("keep"))
        held = llm_keep is False and _kept_by_flag(pack, x)
        stats["flag-kept"] += held
        keep = bool(_first(None if held else llm_keep, x["rule"]["keep"]))
        if not keep and x["role"] == "user" and x["rule"]["keep"] and not x.get("meta"):
            typed.append(x["id"])               # typed by the user: the rules keep these
        llm_summary = _reviewer_summary(x, d, args, stats)
        if x["id"] in merged:                    # reviewed, even if left to the rules
            writes.append((x["id"], x.get("session") or pack.get("source"), x["llm_key"],
                           llm_keep, llm_summary))
        stats["restored"] += keep and not x["rule"]["keep"]
        stats["dropped"] += x["rule"]["keep"] and not keep
        if keep:
            _show(x, llm_summary, turns, summaries, stats, prior)
    return turns, summaries, writes, stats, prior, typed


def _gate_from_pack(args, pack):
    """The quality-gate flags given at --emit-review, unless this run gives its own."""
    gate = pack.get("gate") if isinstance(pack.get("gate"), dict) else {}
    args.skip_reviewer = bool(args.skip_reviewer or gate.get("skip_reviewer") is True)
    if args.reviewer_output is None and isinstance(gate.get("reviewer_output"), str):
        args.reviewer_output = gate["reviewer_output"]
    if args.reviewer_timeout is None and isinstance(gate.get("reviewer_timeout"), int):
        args.reviewer_timeout = gate["reviewer_timeout"]


def _check_pack(pack, merged, args):
    """Warnings before the render, and the settings the pack carries from --emit-review."""
    ids = {x["id"] for x in pack["turns"]}
    unknown = [i for i in merged if i not in ids]
    if unknown:
        print(f"[lineage] WARN: decisions name {len(unknown)} turn(s) not in the pack, "
              f"ignored: {', '.join(unknown[:5])}", file=sys.stderr)
    _warn_coverage(pack, set(merged) | {x["id"] for x in pack["turns"]
                                        if x["llm"].get("cached")})
    if pack.get("redact_mode") in ("full", "mask"):
        args.redact_mode = pack["redact_mode"]
    if pack.get("redact_extra") is True and not args.redact_extra:
        print("[lineage] WARN: --emit-review had --redact-extra; give the same keywords "
              "here too, or reviewer summaries miss that redaction", file=sys.stderr)
    _gate_from_pack(args, pack)


def _remove_review_files(pack_path, pack):
    """After a good render the pack, its parts and the decisions beside it go: they hold
    the redacted session."""
    samples = f"{pack_path.stem}.reviewer-input.json"      # a failed gate's, beside the pack
    names = [pack_path.name, samples]
    for p in pack.get("parts") or []:
        if isinstance(p, dict):
            names += [p.get(k) for k in ("file", "decisions") if isinstance(p.get(k), str)]
    prefix = pack_path.stem + ".part-"
    left = []
    for name in names:
        if name not in (pack_path.name, samples) and not name.startswith(prefix):
            continue                              # only what --emit-review named
        try:
            pack_path.with_name(name).unlink()
        except FileNotFoundError:
            pass
        except (OSError, ValueError):
            left.append(name)
    if left:
        print(f"[lineage] WARN: could not remove review files: {', '.join(left)}",
              file=sys.stderr)


def _samples_left_unread(pack_path, args):
    """True, with the reason, when a gated run left its samples beside the pack and this run
    gives neither a verdict path nor --skip-reviewer: it would pass over that run's verdict."""
    left = pack_path.with_name(f"{pack_path.stem}.reviewer-input.json")
    if left.exists() and not (args.reviewer_output or args.skip_reviewer):
        _bad(f"{left} was left by a gated run; give its --reviewer-output again, or --skip-reviewer")
        return True
    return False


def _review_output(args, pack):
    """The page path: the pack's when this run gives none, else the given one with the pack's
    stamp, so the gate's runs write one page."""
    if args.output is None:
        return pack.get("output") or "work/lineage-review.html"
    return _with_pack_stamp(args.output, pack.get("output"))


def _report_review(stats, turns, pack, typed):
    """What the render took from the reviewers, and the turns typed by the user they dropped."""
    print(f"[lineage] review applied: shown={len(turns)}/{len(pack['turns'])} "
          f"restored={stats['restored']} dropped={stats['dropped']} "
          f"summaries reviewer={stats['reviewer']} rule={stats['rule']}", file=sys.stderr)
    if stats["ignored"]:
        print(f"[lineage] note: {stats['ignored']} summaries for turns the page shows "
              "in full were ignored", file=sys.stderr)
    if stats["flag-kept"]:
        print(f"[lineage] note: {stats['flag-kept']} turn(s) a reviewer marked keep: false "
              "stay, as --keep-trivia or --keep-tool-only asked", file=sys.stderr)
    if typed:
        print(f"[lineage] WARN: reviewers dropped {len(typed)} typed user turn(s): {', '.join(typed[:10])}"
              f"{' ...' if len(typed) > 10 else ''}; tell the user", file=sys.stderr)


def apply_review(args):
    """Render from a review pack and its decisions; cache the reviewers' values and, after
    a good render, remove the review files."""
    pack_path = pathlib.Path(args.apply_review)
    pack = _load_pack(pack_path)
    if pack is None:
        return 2
    merged = _load_decisions(_decision_files(pack_path, pack, args.decisions))
    if merged is None:
        return 2
    _check_pack(pack, merged, args)
    if _samples_left_unread(pack_path, args):
        return 2
    turns, summaries, writes, stats, prior, typed = _review_result(pack, merged, args)
    args.output = _review_output(args, pack)
    if stats["hidden"]:
        prior["reviewer-summary"] = stats["hidden"]
    try:
        rc = render_and_write(turns, pack.get("source") or "session", args,
                              all_sessions=bool(pack.get("all_sessions")),
                              markdown=pack.get("markdown") is not False,
                              open_details=bool(pack.get("open")),
                              title=str(pack.get("title") or "Session Lineage"),
                              summaries=summaries, prior_redactions=prior)
    except SystemExit as e:                       # the quality gate failed
        rc = int(e.code) if isinstance(e.code, int) else 2
    if rc == 0:
        for w in writes:
            write_llm_cache(*w)
        _remove_review_files(pack_path, pack)
    _report_review(stats, turns, pack, typed)
    return rc


def build_arg_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        prog="lineage",
        description="Export Claude Code session(s) as a KakaoTalk-style HTML file.")
    ap.add_argument("--last", type=int, help="keep last N turns")
    ap.add_argument("--from", dest="from_", help="ISO timestamp from (inclusive)")
    ap.add_argument("--to", help="ISO timestamp to (inclusive)")
    ap.add_argument("--turns", help='range like "10-50" (1-indexed inclusive)')
    ap.add_argument("--output", default=None,
                    help="output HTML path (default: work/lineage-{name}_YYMMDD+HHMM.html)")
    ap.add_argument("--session", help="jsonl path (overrides auto-discover)")
    ap.add_argument("--all-sessions", action="store_true",
                    help="merge ALL sessions in the project dir, chronologically")
    ap.add_argument("--from-transcript",
                    help="read transcript from PATH or '-' for stdin")
    ap.add_argument("--redact-extra", help="comma-separated keywords to also redact")
    ap.add_argument("--redact-mode", choices=["full", "mask"], default="full",
                    help="redaction mode (full=[REDACTED], mask=abcd****wxyz)")
    ap.add_argument("--unsafe-schema", action="store_true",
                    help="proceed even on unknown schema markers")
    ap.add_argument("--rebuild-summaries", action="store_true",
                    help="ignore summary cache and re-summarize")
    ap.add_argument("--purge-cache", action="store_true",
                    help="purge ~/.cache/lineage then exit")
    ap.add_argument("--skip-reviewer", action="store_true",
                    help="skip reviewer quality gate (warn-only)")
    ap.add_argument("--reviewer-output",
                    help="path to Critic response JSON; enforces the quality gate")
    ap.add_argument("--reviewer-timeout", type=int, default=None,
                    help="seconds to wait for reviewer-output (default 60 with --rulebase; "
                         "the reviewed flow waits only when this is given)")
    ap.add_argument("--title", default="Session Lineage", help="HTML title")
    _add_review_args(ap)
    # Readability defaults are ON. Opt-out flags restore raw/older behavior.
    ap.add_argument("--hide-tool-only", dest="hide_tool_only", action="store_true",
                    help="(DEFAULT) drop assistant turns that are only tool calls")
    ap.add_argument("--keep-tool-only", dest="hide_tool_only", action="store_false",
                    help="keep tool-only assistant turns (override default)")
    ap.add_argument("--no-markdown", dest="markdown", action="store_false",
                    help="disable markdown rendering (default: render ON)")
    ap.add_argument("--keep-trivia", dest="drop_trivia", action="store_false",
                    help="keep manipulation commands / injected bodies / echo / "
                         "harness errors (default: filter ON)")
    ap.add_argument("--open", dest="open_details", action="store_true",
                    help="render bubbles expanded (default: collapsed)")
    ap.add_argument("--collapse", dest="open_details", action="store_false",
                    help="(DEFAULT) render bubbles collapsed")
    ap.set_defaults(hide_tool_only=True, open_details=False,
                    markdown=True, drop_trivia=True)
    return ap


def _add_review_args(ap):
    """The flags of the reviewed flow (3.0.0): --emit-review, the session's reviewers,
    then --apply-review."""
    ap.add_argument("--rulebase", action="store_true",
                    help="one pass, rules only (the default when no review flag is given)")
    ap.add_argument("--emit-review", metavar="PACK",
                    help="write the turns for the session model to review (JSON) and stop")
    ap.add_argument("--apply-review", metavar="PACK",
                    help="render from a review pack and the reviewer's decisions")
    ap.add_argument("--decisions", action="append", default=[], metavar="FILE",
                    help="reviewer decisions [{id, keep, summary}] for --apply-review (repeatable)")


def _open_stream(path):
    return open(path, encoding="utf-8", errors="strict")


def _load_turns_from(path, unsafe_schema, session_id, session_name):
    """Parse one jsonl file, isolating per-file decode errors (D-3)."""
    try:
        with _open_stream(path) as stream:
            return list(parse_turns(stream, unsafe_schema=unsafe_schema,
                                    session_id=session_id,
                                    session_name=session_name))
    except (OSError, UnicodeDecodeError) as e:
        print(f"[lineage] WARN: skipping unreadable session {path}: {e}",
              file=sys.stderr)
        return []


def _flag_clash(args):
    """The review flags that cannot go together, as one message; None when they can."""
    if args.emit_review == "" or args.apply_review == "":
        return "--emit-review and --apply-review need a file path"
    if args.purge_cache and (args.emit_review or args.apply_review):
        return "--purge-cache is its own run: it takes no review pack"
    if args.emit_review and args.apply_review:
        return "--emit-review and --apply-review are two separate runs"
    if args.rulebase and (args.emit_review or args.apply_review):
        return "--rulebase is the one-pass run: it takes no review pack"
    if args.decisions and not args.apply_review:
        return "--decisions goes with --apply-review"
    return None


def main(argv=None) -> int:
    args = build_arg_parser().parse_args(argv)

    env_extra = os.environ.get("LINEAGE_REDACT_EXTRA", "").strip()
    if env_extra:
        args.redact_extra = ",".join(
            p for p in (args.redact_extra, env_extra) if p)

    clash = _flag_clash(args)
    if clash:
        print(f"[lineage] ERROR: {clash}", file=sys.stderr)
        return 2

    if args.purge_cache:
        import shutil
        if CACHE_BASE.exists():
            shutil.rmtree(CACHE_BASE)
            print(f"[lineage] cache purged: {CACHE_BASE}", file=sys.stderr)
        else:
            print("[lineage] no cache to purge", file=sys.stderr)
        return 0

    if args.apply_review:
        if any((args.last, args.from_, args.to, args.turns, args.session,
                args.all_sessions, args.from_transcript)):
            print("[lineage] note: --apply-review renders the pack; source and range "
                  "flags were applied at --emit-review", file=sys.stderr)
        return apply_review(args)

    # ---- Resolve input → raw turns (parse + parts + session) ----
    turns = []
    session_id = "session"
    jsonl_path = None
    try:
        if args.all_sessions:
            files = project_jsonl_files()
            if not files:
                print("[lineage] --all-sessions: no jsonl found in project dir",
                      file=sys.stderr)
                return 2
            starts = {p: session_start(p) for p in files}
            for p in files:
                name = discover_session_name(p) or p.stem[:8]
                part = _load_turns_from(p, args.unsafe_schema, p.stem, name)
                fill_missing_ts(part)
                for t in part:
                    t["session_ts"] = starts[p] or "9999"
                turns.extend(part)
            # record-level chronological sort (stable → same-ts keeps file order)
            turns.sort(key=lambda t: t.get("ts") or t.get("session_ts") or "9999")
            session_id = "all-sessions"
            print(f"[lineage] --all-sessions: merged {len(files)} sessions",
                  file=sys.stderr)
        elif args.from_transcript:
            if args.from_transcript == "-":
                turns = list(parse_turns(sys.stdin, unsafe_schema=args.unsafe_schema,
                                         session_id="stdin"))
                session_id = "stdin"
            else:
                jsonl_path = pathlib.Path(args.from_transcript)
                session_id = "file-" + jsonl_path.stem
                turns = _load_turns_from(jsonl_path, args.unsafe_schema,
                                         session_id, None)
        elif args.session:
            jsonl_path = pathlib.Path(args.session)
            session_id = jsonl_path.stem
            turns = _load_turns_from(jsonl_path, args.unsafe_schema,
                                     session_id, None)
        else:
            f = auto_discover_jsonl()
            if not f:
                print("[lineage] No jsonl found. Use one of:",
                      "\n  --session FILE         explicit jsonl path",
                      "\n  --all-sessions         merge all project sessions",
                      "\n  --from-transcript -    paste transcript via stdin",
                      "\n  --from-transcript FILE read transcript from file",
                      "\n(non-ASCII cwd may not auto-encode — use --session)",
                      file=sys.stderr)
                return 2
            jsonl_path = f
            session_id = f.stem
            turns = _load_turns_from(f, args.unsafe_schema, session_id, None)
            print(f"[lineage] auto-discovered session: {f.name}", file=sys.stderr)
    except SystemExit as e:
        return int(e.code) if isinstance(e.code, int) else 2

    # stdin → derive per-turn uuid from the content so the caches work (keyed: see _stdin_id_key)
    if args.from_transcript == "-":
        key = _stdin_id_key()
        for t in turns:
            t["uuid"] = hmac.new(key, str(t["text"]).encode(), hashlib.sha256).hexdigest()[:16]

    # ---- Pipeline order (R6): classify → merge → echo → hide-tool-only → range ----
    turns = classify_turns(turns, drop_trivia=args.drop_trivia)
    turns = merge_assistant_runs(turns)
    if args.emit_review:
        drops = heuristic_drops(turns, args)
        window = review_window(turns, drops, args)
        if window is None:
            return 2
        return emit_review(turns, drops, window, session_id,
                           default_output(args, jsonl_path, session_id), args)
    if args.drop_trivia:
        turns = drop_echo_exchanges(turns)
    if args.hide_tool_only:
        turns = [t for t in turns
                 if not (t["role"] == "assistant" and not t["text"].strip())]
    turns = select_range(turns, args)
    if turns is None:
        return 2
    if args.output is None:
        args.output = default_output(args, jsonl_path, session_id)
    return render_and_write(turns, session_id, args, all_sessions=args.all_sessions,
                            markdown=args.markdown, open_details=args.open_details,
                            title=args.title)


def _in_time(t, args):
    """--from / --to on one turn. A bare date bound is inclusive of the WHOLE end
    day: a full ISO timestamp sorts AFTER the date string ("...T10:..." <=
    "2026-08-09" is False), so a high sentinel is appended for date-only input."""
    ts = t["ts"] or ""
    if args.from_ and ts < args.from_:
        return False
    if args.to and ts > (args.to if "T" in args.to else args.to + "T99"):
        return False
    return True


def _count_slice(n, args):
    """--turns then --last over n items, as a slice; None on an invalid --turns."""
    lo, hi = 0, n
    if args.turns:
        m = re.match(r"^(\d+)-(\d+)$", args.turns)
        if not m:
            print(f"[lineage] invalid --turns '{args.turns}'", file=sys.stderr)
            return None
        lo, hi = max(1, int(m.group(1))) - 1, min(int(m.group(2)), n)
    if args.last and args.last > 0:
        lo = max(lo, hi - args.last)
    return slice(lo, hi)


def select_range(turns, args):
    """--from / --to / --turns / --last, in that order; None on an invalid --turns."""
    turns = [t for t in turns if _in_time(t, args)]
    sl = _count_slice(len(turns), args)
    if sl is None:
        return None
    turns = turns[sl]
    if len(turns) > 100:
        print(f"[lineage] WARN: {len(turns)} turns is large — render may be slow",
              file=sys.stderr)
    return turns


def default_output(args, jsonl_path, session_id):
    """work/lineage-<session name or id>.html, or args.output when given. A name that holds a
    secret-like string gives way to the session id."""
    if args.output is not None:
        return args.output
    session_name = discover_session_name(jsonl_path) if jsonl_path else None
    if session_name and page_redact(session_name)[0] != session_name:
        print(f"[lineage] session name: {page_redact(session_name)[0]} "
              "(holds a secret-like string; the file is named by the session id)", file=sys.stderr)
        session_name = None
    slug = ("all-sessions" if args.all_sessions
            else (session_name or session_id[:8]))
    if session_name:
        print(f"[lineage] session name: {session_name}", file=sys.stderr)
    return f"work/lineage-{slug}.html"


def render_and_write(turns, session_id, args, all_sessions=False, markdown=True,
                     open_details=False, title="Session Lineage", summaries=None,
                     prior_redactions=None):
    """Render the rows, fill the template, self-verify, write, run the reviewer gate.
    `prior_redactions`: what --emit-review redacted before the text reached the pack."""
    rows, redact_counts, hits, total = render_rows(
        turns, session_id, args.redact_extra, args.redact_mode,
        args.rebuild_summaries, open_details=open_details,
        markdown=markdown, all_sessions=all_sessions, summaries=summaries)
    for k, v in (prior_redactions or {}).items():
        redact_counts[k] = redact_counts.get(k, 0) + v
    left = _residual_secrets("\n".join(rows))
    if left:
        print("[lineage] WARN: the page still holds secret-like text ("
              + ", ".join(f"{k}={v}" for k, v in sorted(left.items()))
              + "); check the page before sharing it, or run again with the value in LINEAGE_REDACT_EXTRA"
              " (with --rulebase, add --rebuild-summaries)",
              file=sys.stderr)

    date_range = ""
    dated = [t for t in turns if t.get("ts")]
    if dated:
        first = (dated[0]["ts"] or "")[:10]
        last = (dated[-1]["ts"] or "")[:10]
        date_range = first if first == last else f"{first} ~ {last}"

    html_doc = HTML_TEMPLATE
    html_doc = html_doc.replace("{{TITLE}}", html.escape(title), 1)
    html_doc = html_doc.replace("{{HEADER_TITLE}}", html.escape(title), 1)
    html_doc = html_doc.replace("{{DATE_RANGE}}", html.escape(date_range), 1)
    html_doc = html_doc.replace("{{TURNS}}", "\n".join(rows), 1)

    errs = self_verify(html_doc)
    if errs:
        print(f"[lineage] WARN: self-verify issues: {errs}", file=sys.stderr)

    out = _with_timestamp_suffix(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html_doc, encoding="utf-8")

    _run_reviewer_gate(turns, out, session_id, args, summaries=summaries)

    tool_total = sum(sum(t.get("tools", {}).values()) for t in turns)
    print(f"[lineage] turns={len(turns)} redacted={sum(redact_counts.values())} "
          f"tool_calls={tool_total} cache_hits={hits}/{total} "
          f"size={out.stat().st_size}B output={out}", file=sys.stderr)
    if redact_counts:
        details = ", ".join(f"{k}={v}" for k, v in sorted(redact_counts.items()))
        print(f"[lineage] redaction breakdown: {details}", file=sys.stderr)
    return 0


def _with_pack_stamp(output, pack_output):
    """`output` with the `_YYMMDD+HHMM` stamp of the pack's own output, so the gate's runs
    minutes apart write one page; as given when it has a stamp or the pack's output has none."""
    stamp = re.search(r"_\d{6}\+\d{4}$", pathlib.Path(str(pack_output or "")).stem)
    out = pathlib.Path(output)
    if stamp and not re.search(r"_\d{6}\+\d{4}$", out.stem):
        return str(out.with_name(f"{out.stem}{stamp.group(0)}{out.suffix}"))
    return output


def _with_timestamp_suffix(path_str):
    """Append `_YYMMDD+HHMM` before the extension (idempotent)."""
    import datetime as _dt
    p = pathlib.Path(path_str)
    if re.search(r"_\d{6}\+\d{4}$", p.stem):
        return p
    stamp = _dt.datetime.now().strftime("_%y%m%d+%H%M")
    return p.with_name(f"{p.stem}{stamp}{p.suffix}")


def _gate_samples(bots, summaries, session_id, args):
    """Up to 5 bot turns as the gate's critic reads them. --rulebase keeps the 2.x shape
    (random turns); a model reads the samples, so every value is hidden whole before the cut,
    as in part files (3.0.2). With reviewer summaries (the default flow) the pick is
    seeded by the turns, so a rerun on the same turns samples the same ones, and a sample
    names its turn and shows the head and tail the reviewer saw, fully redacted."""
    import random
    if summaries is None:
        out = []
        for i, t in enumerate(random.sample(bots, min(5, len(bots)))):
            s, _ = _page_summary(t, summaries, session_id, False,
                                 args.redact_extra, args.redact_mode)
            red_s = review_redact(_MASKED.sub("[REDACTED]", s), args.redact_extra)[0]
            red_d = review_redact(t["text"], args.redact_extra)[0][:500]
            out.append({"idx": i, "original_detail": red_d, "generated_summary": red_s})
        return out
    seed = hashlib.sha256("\x00".join(t["uuid"] for t in bots).encode()).hexdigest()
    out = []
    for i, t in enumerate(random.Random(seed).sample(bots, min(5, len(bots)))):
        s = t.get("sample_summary") or _page_summary(t, summaries, session_id, False,
                                                     args.redact_extra, args.redact_mode)[0]
        detail = t.get("preview") or _preview(review_redact(t["text"], args.redact_extra)[0])[0]
        gen = review_redact(_MASKED.sub("[REDACTED]", s), args.redact_extra)[0]
        key = hashlib.sha256("\x00".join([t["uuid"], detail, gen]).encode()).hexdigest()[:12]
        out.append({"idx": i, "id": t["uuid"], "key": key, "original_detail": detail,
                    "generated_summary": gen})
    return out


# What --redact-mode mask leaves of a secret (4 characters, ****, 4 characters): the page
# keeps it, a model reading the gate samples gets none of it.
_MASKED = re.compile(r"[^\s*]{4}\*{4}[^\s*]{4}")


def _renew_samples(path, text, rop):
    """Write the reviewed flow's samples unless they are there as they are. New samples set
    aside a verdict list already at `rop` (_refuse_non_verdict has stopped on anything
    else): no critic judged them in it (a --rulebase gate or an earlier sample set left
    it). The same samples keep a verdict: a critic answered an earlier run, and this run
    reads that answer."""
    try:
        if path.read_text(encoding="utf-8") == text:
            return
    except (OSError, UnicodeDecodeError):
        pass
    _write_private(path, text)
    old = pathlib.Path(rop) if rop else None
    if old is not None and _is_verdict_file(old):
        print(f"[lineage] WARN: {rop} predates these samples; it is not read",
              file=sys.stderr)
        _set_aside(old)


def _refuse_non_verdict(rop):
    """Stop (exit 2) before any sample or instruction when the reviewed flow's verdict path
    holds something other than a verdict list: whoever put it there, nothing printed here
    may lead the session to write over it."""
    p = pathlib.Path(rop) if rop else None
    if p is None or not p.exists() or _is_verdict_file(p):
        return
    if _json_list(p):   # step 8: written again, the same answer fails the same way
        why = ("it is a JSON array where no entry names idx; if the session wrote the critic's "
               "answer, have the critic judge the samples again (a failed gate run)")
    else:
        why = ("if the session wrote it, write it again as a bare JSON array of "
               "{idx, id, key, recoverable, reason}")
    print(f"[lineage] ERROR: {rop} is not a verdict list; {why}, else give a --reviewer-output "
          "that does not exist yet", file=sys.stderr)
    raise SystemExit(2)


def _json_list(p):
    """True when `p` is a file holding a JSON array, whatever its entries."""
    try:
        return p.is_file() and isinstance(json.loads(p.read_text(encoding="utf-8")), list)
    except (OSError, ValueError, UnicodeDecodeError, RecursionError):
        return False


def _is_verdict_file(p, every=False):
    """True when `p` is a file holding a critic's verdict: a JSON list with at least one
    object that names an `idx`. A list of anything else (a user's data file) is not one; a
    verdict with an entry short of its idx is one, and the coverage check says what it
    misses. With `every`, each entry must be such an object: only that file may be written
    over, so a user's list holding one such object among other data stays."""
    if not p.is_file():
        return False
    try:
        got = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError, UnicodeDecodeError, RecursionError):
        return False
    if not isinstance(got, list):
        return False
    named = [isinstance(v, dict) and "idx" in v for v in got]
    return bool(named) and all(named) if every else any(named)


def _write_gate_samples(bots, out, summaries, session_id, args):
    """Write the samples for the critic and say what to do with them; their path, or None.
    The reviewed flow writes them beside the pack, under one name across its reruns, and
    stops (exit 2) when it cannot: no critic could judge them."""
    if summaries is not None:
        _refuse_non_verdict(args.reviewer_output)
    path = out.parent / f".{out.stem}.reviewer-input.json"
    if summaries is not None and getattr(args, "apply_review", None):
        pack = pathlib.Path(args.apply_review)
        path = pack.with_name(f"{pack.stem}.reviewer-input.json")
    text = json.dumps(_gate_samples(bots, summaries, session_id, args),
                      ensure_ascii=False, indent=2)
    try:
        if summaries is None:
            _write_private(path, text)
        else:
            _renew_samples(path, text, args.reviewer_output)
    except OSError as e:
        if summaries is not None:
            print(f"[lineage] ERROR: cannot write the gate samples {path}: {e}", file=sys.stderr)
            raise SystemExit(2)
        return None
    print(f"[lineage] reviewer samples: {path}", file=sys.stderr, flush=True)
    if summaries is None:
        print("[lineage] next: invoke Skill('oh-my-claudecode:critic') with "
              "the JSON above; expected [{idx, recoverable, reason}, ...] "
              "(PASS = 5/5 recoverable)", file=sys.stderr, flush=True)
    elif pathlib.Path(args.reviewer_output).exists():
        print(f"[lineage] reading the verdict at {args.reviewer_output}", file=sys.stderr, flush=True)
    else:
        print(f"[lineage] next: have a critic agent judge the JSON above and write its "
              f"[{{idx, id, key, recoverable, reason}}, ...] to {args.reviewer_output} "
              "(one per sample; PASS = all recoverable)", file=sys.stderr, flush=True)
    return path


def _read_verdict(rop, timeout, set_aside):
    """The critic's verdict list from `rop`, waited for up to `timeout` seconds (None: not
    waited for, the next run reads it). With `set_aside` a verdict list is renamed once read,
    so a rerun waits for a fresh one instead of reusing it; anything else stays where it is.
    Exits 2 when it is missing, unreadable or not a non-empty list."""
    import time as _time
    deadline = _time.time() + (0 if timeout is None else max(1, timeout))
    while not rop.exists() and _time.time() < deadline:
        _time.sleep(1)
    if not rop.exists():
        if timeout is None:
            print(f"[lineage] ERROR: no verdict at {rop} yet; have a critic judge the samples, "
                  "write its answer there and run this again", file=sys.stderr)
        else:
            print(f"[lineage] ERROR: reviewer-output not found within "
                  f"{timeout}s: {rop}", file=sys.stderr)
        raise SystemExit(2)
    try:
        verdict = json.loads(rop.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError, UnicodeDecodeError, RecursionError) as e:
        print(f"[lineage] ERROR: reviewer-output parse failed: {e}",
              file=sys.stderr)
        raise SystemExit(2)
    if not isinstance(verdict, list) or not verdict:
        print("[lineage] ERROR: reviewer-output is not a non-empty array",
              file=sys.stderr)
        raise SystemExit(2)
    if set_aside:
        _set_aside(rop)
    return verdict


def _set_aside(rop):
    """Rename the verdict file to `<name>.used` and say so; a folder or other non-file at
    that path is left alone. Something other than an earlier verdict at `<name>.used` is
    kept too: the verdict then goes to the first `<name>.used.N` that is free or holds an
    earlier verdict."""
    if not rop.is_file():
        print(f"[lineage] WARN: {rop} is not a file; left in place", file=sys.stderr)
        return
    dest = rop.with_name(rop.name + ".used")
    k = 0
    while dest.exists() and not _is_verdict_file(dest, every=True):
        k += 1
        dest = rop.with_name(f"{rop.name}.used.{k}")
    try:
        os.replace(str(rop), str(dest))
    except OSError as e:
        print(f"[lineage] WARN: could not set the verdict aside ({e}); remove {rop} "
              "before the next run", file=sys.stderr)
        return
    print(f"[lineage] note: verdict moved to {dest}", file=sys.stderr)


def _verdict_gaps(verdict, samples):
    """Why a verdict does not answer these samples, or "": it needs one entry per sample
    idx and no other, each carrying the `id` and `key` of that sample (its turn and its
    content: an answer to the samples from before a fix carries an old key)."""
    want = {s["idx"]: s for s in samples if isinstance(s, dict) and type(s.get("idx")) is int}
    seen, stray = set(), []
    for v in verdict:
        idx = v.get("idx") if isinstance(v, dict) else None
        if (type(idx) is not int or idx not in want or idx in seen
                or any(v.get(k) != want[idx][k] for k in ("id", "key") if k in want[idx])):
            stray.append(idx)
        else:
            seen.add(idx)
    missing = sorted(set(want) - seen)
    if not (missing or stray):
        return ""
    return f"missing idx {missing}, entries that match no sample {stray}"


def _check_coverage(verdict, samples):
    """Exit 2 unless the verdict answers each of the samples in file `samples`."""
    try:
        gaps = _verdict_gaps(verdict, json.loads(samples.read_text(encoding="utf-8")))
    except (OSError, ValueError, UnicodeDecodeError, AttributeError) as e:
        gaps = f"cannot read the samples: {e}"
    if gaps:
        print(f"[lineage] ERROR: the verdict does not answer {samples} ({gaps}); have the "
              "critic judge every sample again", file=sys.stderr)
        for v in verdict:
            if isinstance(v, dict) and v.get("recoverable") is not True:
                print(f"  - not recoverable in it: idx={v.get('idx', '?')}: "
                      f"{v.get('reason', '(no reason)')}", file=sys.stderr)
        raise SystemExit(2)


def _enforce_gate(rop, timeout, samples=None, reviewed=False):
    """PASS when every verdict entry is recoverable, else exit 2 with the reasons. In the
    reviewed flow the verdict is set aside once read, it must answer each sample, and the
    samples go after a PASS."""
    verdict = _read_verdict(rop, timeout, set_aside=reviewed)
    if reviewed and samples is not None:
        _check_coverage(verdict, samples)
    fails = [v for v in verdict
             if not (isinstance(v, dict) and v.get("recoverable") is True)]
    if fails:
        print(f"[lineage] FAIL: quality gate {len(verdict) - len(fails)}/"
              f"{len(verdict)} recoverable. Reasons:", file=sys.stderr)
        for f in fails:
            if isinstance(f, dict):
                print(f"  - idx={f.get('idx', '?')}: "
                      f"{f.get('reason', '(no reason)')}", file=sys.stderr)
        raise SystemExit(2)
    print(f"[lineage] PASS: quality gate {len(verdict)}/{len(verdict)} "
          "recoverable", file=sys.stderr)
    if reviewed and samples is not None:
        try:
            samples.unlink()
        except OSError:
            pass


def _run_reviewer_gate(turns, out, session_id, args, summaries=None):
    """Write reviewer samples and (if --reviewer-output) enforce the gate. Samples the
    summaries the page shows (`summaries` overrides, as in render_rows); the input/output
    contract is unchanged (N3). The reviewed flow (`summaries` given) already had a model
    review every turn, so it samples only for a gate it enforces."""
    bots = [t for t in turns if t["role"] in ("assistant", "agent")]
    reviewed = summaries is not None
    if args.skip_reviewer:
        print("[lineage] WARN: --skip-reviewer — quality gate not enforced",
              file=sys.stderr)
        return
    if not bots or (reviewed and not args.reviewer_output):
        return
    samples = _write_gate_samples(bots, out, summaries, session_id, args)
    if args.reviewer_output:
        if reviewed and args.reviewer_timeout is None:
            timeout = None      # the run after the critic reads the verdict; this one does not wait
        else:
            timeout = REVIEWER_TIMEOUT if args.reviewer_timeout is None else args.reviewer_timeout
        _enforce_gate(pathlib.Path(args.reviewer_output), timeout, samples, reviewed)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit as _e:
        sys.exit(int(_e.code) if isinstance(_e.code, int) else 0)
