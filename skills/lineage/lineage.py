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
import html
import json
import math
import os
import pathlib
import re
import sys
from html.parser import HTMLParser

if sys.version_info < (3, 7):
    sys.stderr.write("lineage requires Python 3.7+ (found %s)\n"
                     % sys.version.split()[0])
    sys.exit(2)

SCHEMA_VERSION = 2          # cache dir schema (v2: redacted summaries only)
SUMMARIZER_VERSION = 2      # bump when summarize_turn logic changes (B-3 cache key)
USER_FOLD = 400             # collapse user messages longer than this (E-1)
ECHO_ASK = 40               # echo-exchange: user question length ceiling (A-4)
ECHO_REPLY = 5              # echo-exchange: assistant reply length ceiling (A-4)
_BLOCKQUOTE_MAX_DEPTH = 32  # blockquote recursion cap (C-2)
CACHE_BASE = pathlib.Path.home() / ".cache" / "lineage"

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


def redact(text: str, extra: str = None, mode: str = "full"):
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
            pat = re.compile(re.escape(kw), re.IGNORECASE)
            n = len(pat.findall(out))
            if n:
                counts[f"custom:{kw}"] = n
                out = pat.sub("[REDACTED]", out)
    return out, counts


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
               "session": session_id, "session_name": session_name}


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


def drop_echo_exchanges(turns):
    """Drop no-op exchanges: a short user question + a tool-less token reply.
    Structural, not keyword-based (A-4). Same-session only. Dropping a reply
    also drops its question (else the question is orphaned).
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


def _cut(s, n):
    s = s.strip()
    return s if len(s) <= n else s[:max(1, n - 1)].rstrip() + "…"


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
def cache_dir(session_id: str):
    d = CACHE_BASE / str(SCHEMA_VERSION) / (session_id or "default")
    d.mkdir(parents=True, exist_ok=True)
    for p in (d, CACHE_BASE / str(SCHEMA_VERSION), CACHE_BASE):
        try:
            os.chmod(p, 0o700)
        except OSError:
            pass
    return d


def read_or_summarize(turn: dict, session_id: str, rebuild: bool = False,
                      redact_extra=None, redact_mode: str = "full"):
    """Return (summary, cache_hit). Cache key includes the content hash AND the
    summarizer version (B-3), so changing the summarizer invalidates old entries.
    Cached text is always redacted (secret hygiene).
    """
    digest = hashlib.sha256(
        (turn["text"] + "\x00s" + str(SUMMARIZER_VERSION)).encode()
    ).hexdigest()[:8]
    p = cache_dir(turn.get("session") or session_id) / f"{turn['uuid']}-{digest}.txt"
    if p.exists() and not rebuild:
        try:
            return p.read_text(encoding="utf-8").strip(), True
        except (OSError, UnicodeDecodeError):
            pass
    raw_summary = summarize_turn(turn)
    redacted, _ = redact(raw_summary, extra=redact_extra, mode=redact_mode)
    try:
        fd = os.open(str(p), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(redacted)
    except OSError:
        pass
    return redacted, False


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
def _fmt_time(ts):
    return ts[11:16] if ts and len(ts) >= 16 else ""


def render_rows(turns, session_id, redact_extra, redact_mode, rebuild,
                open_details=False, markdown=True, all_sessions=False):
    rows = []
    last_date = None
    last_session = None
    cache_hits = 0
    cache_total = 0
    redact_counts = {}
    open_attr = " open" if open_details else ""

    def _red(text):
        r, c = redact(text, extra=redact_extra, mode=redact_mode)
        for k, v in c.items():
            redact_counts[k] = redact_counts.get(k, 0) + v
        return r

    for t in turns:
        ts = t.get("ts") or ""
        # session-transition divider (--all-sessions)
        if all_sessions and t.get("session") != last_session:
            last_session = t.get("session")
            name = html.escape(t.get("session_name") or last_session or "session")
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
                summary = html.escape(_cut(red.replace("\n", " "), 90))
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
        cache_total += 1
        summary, hit = read_or_summarize(
            t, session_id, rebuild=rebuild,
            redact_extra=redact_extra, redact_mode=redact_mode)
        if hit:
            cache_hits += 1
        esc_sum = html.escape(_red(summary))
        detail_body = render_body(_red(t["text"]), markdown=markdown)

        tools_html = ""
        if t.get("tools"):
            ts_list = ", ".join(f"{k}×{v}" for k, v in sorted(t["tools"].items()))
            total = sum(t["tools"].values())
            tools_html = ('<div class="tools">🔧 도구 %d건: %s</div>'
                          % (total, html.escape(ts_list)))

        if role == "agent":
            who = html.escape(t.get("agent_from") or "agent")
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
    ap.add_argument("--reviewer-timeout", type=int, default=60,
                    help="seconds to wait for reviewer-output (default 60)")
    ap.add_argument("--title", default="Session Lineage", help="HTML title")
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


def main(argv=None) -> int:
    args = build_arg_parser().parse_args(argv)

    env_extra = os.environ.get("LINEAGE_REDACT_EXTRA", "").strip()
    if env_extra:
        args.redact_extra = ",".join(
            p for p in (args.redact_extra, env_extra) if p)

    if args.purge_cache:
        import shutil
        if CACHE_BASE.exists():
            shutil.rmtree(CACHE_BASE)
            print(f"[lineage] cache purged: {CACHE_BASE}", file=sys.stderr)
        else:
            print("[lineage] no cache to purge", file=sys.stderr)
        return 0

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

    # stdin → derive per-turn uuid from content hash so cache works
    if args.from_transcript == "-":
        for t in turns:
            t["uuid"] = hashlib.sha256(t["text"].encode()).hexdigest()[:16]

    # ---- Pipeline order (R6): classify → merge → echo → hide-tool-only → range ----
    turns = classify_turns(turns, drop_trivia=args.drop_trivia)
    turns = merge_assistant_runs(turns)
    if args.drop_trivia:
        turns = drop_echo_exchanges(turns)
    if args.hide_tool_only:
        turns = [t for t in turns
                 if not (t["role"] == "assistant" and not t["text"].strip())]
    if args.from_:
        turns = [t for t in turns if (t["ts"] or "") >= args.from_]
    if args.to:
        # A bare date bound is inclusive of the WHOLE end day: a full ISO
        # timestamp sorts AFTER the date string ("...T10:..." <= "2026-08-09"
        # is False), so append a high sentinel for date-only input.
        to_bound = args.to if "T" in args.to else args.to + "T99"
        turns = [t for t in turns if (t["ts"] or "") <= to_bound]
    if args.turns:
        m = re.match(r"^(\d+)-(\d+)$", args.turns)
        if not m:
            print(f"[lineage] invalid --turns '{args.turns}'", file=sys.stderr)
            return 2
        lo, hi = max(1, int(m.group(1))), int(m.group(2))
        turns = turns[lo - 1:hi]
    if args.last and args.last > 0:
        turns = turns[-args.last:]

    if len(turns) > 100:
        print(f"[lineage] WARN: {len(turns)} turns is large — render may be slow",
              file=sys.stderr)

    # ---- Resolve default output path ----
    if args.output is None:
        session_name = discover_session_name(jsonl_path) if jsonl_path else None
        slug = ("all-sessions" if args.all_sessions
                else (session_name or session_id[:8]))
        args.output = f"work/lineage-{slug}.html"
        if session_name:
            print(f"[lineage] session name: {session_name}", file=sys.stderr)

    rows, redact_counts, hits, total = render_rows(
        turns, session_id, args.redact_extra, args.redact_mode,
        args.rebuild_summaries, open_details=args.open_details,
        markdown=args.markdown, all_sessions=args.all_sessions)

    date_range = ""
    dated = [t for t in turns if t.get("ts")]
    if dated:
        first = (dated[0]["ts"] or "")[:10]
        last = (dated[-1]["ts"] or "")[:10]
        date_range = first if first == last else f"{first} ~ {last}"

    html_doc = HTML_TEMPLATE
    html_doc = html_doc.replace("{{TITLE}}", html.escape(args.title), 1)
    html_doc = html_doc.replace("{{HEADER_TITLE}}", html.escape(args.title), 1)
    html_doc = html_doc.replace("{{DATE_RANGE}}", html.escape(date_range), 1)
    html_doc = html_doc.replace("{{TURNS}}", "\n".join(rows), 1)

    errs = self_verify(html_doc)
    if errs:
        print(f"[lineage] WARN: self-verify issues: {errs}", file=sys.stderr)

    out = _with_timestamp_suffix(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html_doc, encoding="utf-8")

    _run_reviewer_gate(turns, out, session_id, args)

    tool_total = sum(sum(t.get("tools", {}).values()) for t in turns)
    print(f"[lineage] turns={len(turns)} redacted={sum(redact_counts.values())} "
          f"tool_calls={tool_total} cache_hits={hits}/{total} "
          f"size={out.stat().st_size}B output={out}", file=sys.stderr)
    if redact_counts:
        details = ", ".join(f"{k}={v}" for k, v in sorted(redact_counts.items()))
        print(f"[lineage] redaction breakdown: {details}", file=sys.stderr)
    return 0


def _with_timestamp_suffix(path_str):
    """Append `_YYMMDD+HHMM` before the extension (idempotent)."""
    import datetime as _dt
    p = pathlib.Path(path_str)
    if re.search(r"_\d{6}\+\d{4}$", p.stem):
        return p
    stamp = _dt.datetime.now().strftime("_%y%m%d+%H%M")
    return p.with_name(f"{p.stem}{stamp}{p.suffix}")


def _run_reviewer_gate(turns, out, session_id, args):
    """Write reviewer samples and (if --reviewer-output) enforce the gate.
    Uses the new summarizer; the input/output contract is unchanged (N3)."""
    bots = [t for t in turns if t["role"] in ("assistant", "agent")]
    if not args.skip_reviewer and bots:
        import random
        sample = random.sample(bots, min(5, len(bots)))
        review_samples = []
        for i, t in enumerate(sample):
            s, _ = read_or_summarize(t, session_id, rebuild=False,
                                     redact_extra=args.redact_extra,
                                     redact_mode=args.redact_mode)
            red_s, _ = redact(s, extra=args.redact_extra, mode=args.redact_mode)
            red_d, _ = redact(t["text"][:500], extra=args.redact_extra,
                              mode=args.redact_mode)
            review_samples.append({"idx": i, "original_detail": red_d,
                                   "generated_summary": red_s})
        review_path = out.parent / f".{out.stem}.reviewer-input.json"
        try:
            review_path.write_text(
                json.dumps(review_samples, ensure_ascii=False, indent=2),
                encoding="utf-8")
            print(f"[lineage] reviewer samples: {review_path}", file=sys.stderr)
            print("[lineage] next: invoke Skill('oh-my-claudecode:critic') with "
                  "the JSON above; expected [{idx, recoverable, reason}, ...] "
                  "(PASS = 5/5 recoverable)", file=sys.stderr)
        except OSError:
            pass
    elif args.skip_reviewer:
        print("[lineage] WARN: --skip-reviewer — quality gate not enforced",
              file=sys.stderr)

    if (not args.skip_reviewer) and bots and args.reviewer_output:
        import time as _time
        rop = pathlib.Path(args.reviewer_output)
        deadline = _time.time() + max(1, args.reviewer_timeout)
        while not rop.exists() and _time.time() < deadline:
            _time.sleep(1)
        if not rop.exists():
            print(f"[lineage] ERROR: reviewer-output not found within "
                  f"{args.reviewer_timeout}s: {rop}", file=sys.stderr)
            raise SystemExit(2)
        try:
            verdict = json.loads(rop.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError, UnicodeDecodeError) as e:
            print(f"[lineage] ERROR: reviewer-output parse failed: {e}",
                  file=sys.stderr)
            raise SystemExit(2)
        if not isinstance(verdict, list) or not verdict:
            print("[lineage] ERROR: reviewer-output is not a non-empty array",
                  file=sys.stderr)
            raise SystemExit(2)
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


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit as _e:
        sys.exit(int(_e.code) if isinstance(_e.code, int) else 0)
