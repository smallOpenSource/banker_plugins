#!/usr/bin/env python3
"""lineage — Export a Claude Code session as a single KakaoTalk-style HTML file.

Deterministic core. Claude summarizes one line per assistant turn (cached).
See SKILL.md for full design.
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

SCHEMA_VERSION = 2  # v2: cache stores redacted summary only (v1 plaintext)
DEFAULT_OUTPUT = "work/session-chat.html"


_TITLE_RE = re.compile(r'"customTitle"\s*:\s*"([^"]+)"')


def discover_session_name(path):
    """Best-effort scan a jsonl for `customTitle`. Returns slug-safe string or None."""
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                if '"customTitle"' not in line:
                    continue
                m = _TITLE_RE.search(line)
                if m:
                    name = m.group(1).strip()
                    # slugify: keep alnum + dash; collapse whitespace
                    name = re.sub(r"\s+", "-", name)
                    name = re.sub(r"[^\w가-힣.-]", "", name)
                    return name[:40] or None
    except (OSError, UnicodeDecodeError):
        return None
    return None


def _with_timestamp_suffix(path_str):
    """Append `_YYMMDD+HHMM` to the basename before the extension.

    Example: work/session-chat.html -> work/session-chat_260523+1846.html
    Already-stamped paths (matching `_YYMMDD+HHMM` immediately before suffix)
    are returned unchanged for idempotency.
    """
    import datetime as _dt
    p = pathlib.Path(path_str)
    stem = p.stem
    if re.search(r"_\d{6}\+\d{4}$", stem):
        return p
    stamp = _dt.datetime.now().strftime("_%y%m%d+%H%M")
    return p.with_name(f"{stem}{stamp}{p.suffix}")
CACHE_BASE = pathlib.Path.home() / ".cache" / "lineage"

# ---------------------------------------------------------------- HTML template
HTML_TEMPLATE = r"""<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{TITLE}}</title>
<style>
  :root{--bg:#abc1d1;--me:#fee500;--me-text:#3c1e1e;--bot:#fff;--bot-text:#222;
        --meta:#516680;--header:#3b5e7a;}
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo",
       "Malgun Gothic","Helvetica Neue",sans-serif;background:var(--bg);color:#222;
       font-size:14px;line-height:1.45}
  header{position:sticky;top:0;background:var(--header);color:#fff;padding:12px 16px;
         display:flex;justify-content:space-between;align-items:center;
         box-shadow:0 1px 4px rgba(0,0,0,.15);z-index:10}
  header h1{margin:0;font-size:15px;font-weight:600}
  header .sub{font-size:11px;opacity:.85}
  .room{padding:12px 8px 60px 8px;max-width:780px;margin:0 auto}
  .day{text-align:center;color:#fff;font-size:11px;margin:18px 0 10px;
       letter-spacing:.5px;text-shadow:0 1px 2px rgba(0,0,0,.2)}
  .row{display:flex;margin:6px 0;align-items:flex-end}
  .row.me{justify-content:flex-end}
  .row.bot{justify-content:flex-start}
  .avatar{width:32px;height:32px;border-radius:8px;background:#5a7fa3;color:#fff;
          display:flex;align-items:center;justify-content:center;font-size:12px;
          font-weight:600;margin-right:6px;flex-shrink:0}
  .bubble{max-width:78%;padding:8px 12px;border-radius:14px;word-break:break-word;
          white-space:pre-wrap;box-shadow:0 1px 1px rgba(0,0,0,.08)}
  .me .bubble{background:var(--me);color:var(--me-text);border-bottom-right-radius:4px}
  .bot .bubble{background:var(--bot);color:var(--bot-text);
               border-bottom-left-radius:4px;padding:0;overflow:hidden}
  .bot details{cursor:pointer}
  .bot summary{padding:8px 12px;list-style:none;outline:none;position:relative;font-weight:500}
  .bot summary::-webkit-details-marker{display:none}
  .bot summary::after{content:"\25BE";position:absolute;right:10px;top:8px;
                      color:#999;font-size:10px;transition:transform .15s}
  .bot details[open] summary::after{transform:rotate(180deg)}
  .bot details[open] summary{border-bottom:1px solid #eee;background:#fafbfc}
  .bot .detail{padding:8px 12px 10px;font-size:13px;color:#333}
  .bot .detail code{background:#f1f3f5;padding:1px 5px;border-radius:3px;
                    font-family:"SF Mono",Menlo,Consolas,monospace;font-size:12px}
  .bot .detail pre{background:#1e1e1e;color:#e0e0e0;padding:8px 10px;border-radius:6px;
                   overflow-x:auto;font-size:11.5px;line-height:1.4;margin:6px 0}
  .bot .detail .tools{background:#eef3f8;border-left:3px solid #5a7fa3;
                      padding:6px 10px;margin-top:6px;font-size:11.5px;color:#365675;
                      border-radius:4px}
  .time{font-size:10px;color:var(--meta);margin:0 4px;white-space:nowrap}
  .legend{position:fixed;bottom:8px;left:50%;transform:translateX(-50%);
          background:rgba(0,0,0,.65);color:#fff;font-size:10.5px;padding:5px 12px;
          border-radius:14px;backdrop-filter:blur(4px)}
  @media(max-width:480px){.bubble{max-width:85%;font-size:13px}.avatar{display:none}}
</style>
</head>
<body>
<header><div><h1>{{HEADER_TITLE}}</h1><div class="sub">메시지를 탭하여 상세 펼치기</div></div>
<div class="sub">{{DATE_RANGE}}</div></header>
<div class="room">
{{TURNS}}
</div>
<div class="legend">A: 전체 펼침 | Z: 전체 접기</div>
<script>
document.addEventListener('keydown',function(e){
  if(e.key==='a'||e.key==='A')document.querySelectorAll('details').forEach(function(d){d.open=true});
  if(e.key==='z'||e.key==='Z')document.querySelectorAll('details').forEach(function(d){d.open=false});
});
</script>
</body>
</html>
"""

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
    """Multi-layer redaction. Returns (redacted_text, count_by_kind).

    Layers, in order:
    1. Known patterns (AWS IAM, GitHub PAT, Slack, JWT, private key, password literals).
    2. Shannon entropy ≥ 4.5 on 32+ base64-like runs.
    3. detect-secrets (when installed) — additional pattern coverage.
    4. User keywords from --redact-extra.
    """
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


# ---------------------------------------------------------------- JSONL parse
def auto_discover_jsonl():
    encoded = str(pathlib.Path.cwd()).replace("/", "-")
    projdir = pathlib.Path.home() / ".claude" / "projects" / encoded
    if not projdir.exists():
        return None
    files = sorted(projdir.glob("*.jsonl"),
                   key=lambda p: p.stat().st_mtime, reverse=True)
    return files[0] if files else None


KNOWN_TYPES = {"user", "assistant", "agent-setting", "permission-mode", "summary"}
KNOWN_CONTENT_ITEMS = {"text", "tool_use", "tool_result", "thinking"}


def parse_turns(stream, unsafe_schema: bool = False):
    """Yield dicts: {role, text, ts, uuid, tools, line_no}.

    Schema-tolerant: unknown content item types graceful skip with WARN
    (or hard error if unsafe_schema=False AND a critical field missing).
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

        text = "\n".join(p for p in text_parts if p).strip()
        if not text and not tools:
            continue

        if role == "user":
            stripped = text.lstrip()
            if stripped.startswith("<system-reminder>"):
                continue
            if stripped.startswith("<teammate-message"):
                continue
            if stripped.startswith("<command-name>"):
                continue

        yield {"role": role, "text": text, "ts": ts, "uuid": uuid_,
               "tools": tools, "line_no": line_no}


# ---------------------------------------------------------------- Summary cache
def cache_dir(session_id: str):
    d = CACHE_BASE / str(SCHEMA_VERSION) / session_id
    d.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(d, 0o700)
        os.chmod(CACHE_BASE / str(SCHEMA_VERSION), 0o700)
        os.chmod(CACHE_BASE, 0o700)
    except OSError:
        pass
    return d


def naive_summary(text: str) -> str:
    """Heuristic 1-line summary: first sentence or 80 chars."""
    text = text.strip()
    if not text:
        return "(empty turn)"
    first = next((s for s in re.split(r"[\n.!?]", text) if s.strip()), text)
    s = first.strip()
    if len(s) > 120:
        s = s[:117] + "..."
    if len(s) < 8:
        s = (text[:120].replace("\n", " "))
    return s or "(empty)"


def read_or_summarize(turn: dict, session_id: str,
                      rebuild: bool = False,
                      redact_extra=None, redact_mode: str = "full"):
    """Return (summary, cache_hit).

    Cached text is ALWAYS redacted to prevent plaintext secret persistence
    on disk. The 0600 file mode is defence-in-depth; redaction is the primary
    safeguard.
    """
    p = cache_dir(session_id) / f"{turn['uuid']}.txt"
    if p.exists() and not rebuild:
        return p.read_text(encoding="utf-8").strip(), True
    raw_summary = naive_summary(turn["text"])
    redacted, _ = redact(raw_summary, extra=redact_extra, mode=redact_mode)
    fd = os.open(str(p), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(redacted)
    return redacted, False


# ---------------------------------------------------------------- Render
def render_rows(turns, session_id, redact_extra, redact_mode, rebuild,
                open_details=False):
    rows = []
    details_tag = "<details open>" if open_details else "<details>"
    last_date = None
    cache_hits = 0
    cache_total = 0
    redact_counts = {}

    for t in turns:
        ts = t["ts"] or ""
        if ts:
            d = ts[:10]
            if d != last_date:
                rows.append(f'<div class="day">━━ {html.escape(d)} ━━</div>')
                last_date = d
        time_hm = ts[11:16] if ts else ""

        red_text, c = redact(t["text"], extra=redact_extra, mode=redact_mode)
        for k, v in c.items():
            redact_counts[k] = redact_counts.get(k, 0) + v
        esc_text = html.escape(red_text)

        if t["role"] == "user":
            rows.append(
                f'<div class="row me">'
                f'<span class="time">{html.escape(time_hm)}</span>'
                f'<div class="bubble">{esc_text}</div></div>'
            )
        else:
            cache_total += 1
            summary, hit = read_or_summarize(
                t, session_id, rebuild=rebuild,
                redact_extra=redact_extra, redact_mode=redact_mode)
            if hit:
                cache_hits += 1
            # Already-redacted; final pass for any custom extras added later
            red_sum, c2 = redact(summary, extra=redact_extra, mode=redact_mode)
            for k, v in c2.items():
                redact_counts[k] = redact_counts.get(k, 0) + v
            esc_sum = html.escape(red_sum)
            tools_html = ""
            if t["tools"]:
                ts_list = ", ".join(f"{k}×{v}" for k, v in sorted(t["tools"].items()))
                total = sum(t["tools"].values())
                tools_html = (f'<div class="tools">🔧 도구 {total}건: '
                              f'{html.escape(ts_list)}</div>')
            rows.append(
                f'<div class="row bot"><div class="avatar">C</div>'
                f'<div class="bubble">{details_tag}'
                f'<summary>{esc_sum}</summary>'
                f'<div class="detail">{esc_text}{tools_html}</div>'
                f'</details></div>'
                f'<span class="time">{html.escape(time_hm)}</span></div>'
            )
    return rows, redact_counts, cache_hits, cache_total


# ---------------------------------------------------------------- Self-verify
def self_verify(html_text: str):
    errs = []
    try:
        HTMLParser().feed(html_text)
    except Exception as e:
        errs.append(f"HTMLParser: {e}")
    for tag in ("details", "div"):
        opens = len(re.findall(rf"<{tag}\b", html_text))
        closes = len(re.findall(rf"</{tag}>", html_text))
        if opens != closes:
            errs.append(f"<{tag}> open={opens} close={closes} mismatch")
    if re.search(r'<link rel="stylesheet', html_text):
        errs.append("external stylesheet link found")
    if re.search(r"<script src=", html_text):
        errs.append("external script src found")
    # Check substitution by looking for the template's wrapping context, not
    # the bare placeholder (which can appear in chat content as a literal).
    template_markers = [
        ("<title>{{TITLE}}</title>",          "{{TITLE}}"),
        ("<h1>{{HEADER_TITLE}}</h1>",         "{{HEADER_TITLE}}"),
        ('class="sub">{{DATE_RANGE}}</div>',  "{{DATE_RANGE}}"),
    ]
    for marker, ph in template_markers:
        if marker in html_text:
            errs.append(f"unsubstituted template placeholder: {ph}")
    return errs


# ---------------------------------------------------------------- Main
def build_arg_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        prog="lineage",
        description="Export Claude Code session as a KakaoTalk-style HTML file."
    )
    ap.add_argument("--last", type=int, help="keep last N turns")
    ap.add_argument("--from", dest="from_", help="ISO timestamp from (inclusive)")
    ap.add_argument("--to", help="ISO timestamp to (inclusive)")
    ap.add_argument("--turns", help='range like "10-50" (1-indexed inclusive)')
    ap.add_argument("--output", default=None,
                    help="output HTML path. Default: "
                         "work/lineage-{session-name}_YYMMDD+HHMM.html "
                         "(session-name = customTitle in jsonl, fallback session_id prefix)")
    ap.add_argument("--session", help="jsonl path (overrides auto-discover)")
    ap.add_argument("--from-transcript",
                    help="read transcript from PATH or '-' for stdin")
    ap.add_argument("--redact-extra",
                    help="comma-separated keywords to also redact")
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
                    help="path to Critic response JSON; if provided, parse + "
                         "enforce quality gate (PASS = all recoverable=true, "
                         "any failure → exit 2). Without this, only the "
                         "reviewer-input.json is written.")
    ap.add_argument("--reviewer-timeout", type=int, default=60,
                    help="seconds to wait for reviewer-output (default 60)")
    ap.add_argument("--title", default="Session Lineage",
                    help="HTML title")
    # Readability defaults (ON). Use the opt-out flags to restore raw output.
    ap.add_argument("--hide-tool-only", dest="hide_tool_only",
                    action="store_true",
                    help="(DEFAULT) omit assistant turns that contain only tool "
                         "calls (no prose) — reduces noise in tool-heavy sessions")
    ap.add_argument("--keep-tool-only", dest="hide_tool_only",
                    action="store_false",
                    help="keep tool-only assistant turns (override the default)")
    ap.add_argument("--open", dest="open_details", action="store_true",
                    help="(DEFAULT) render Claude bubbles expanded (<details open>)")
    ap.add_argument("--collapse", dest="open_details", action="store_false",
                    help="render Claude bubbles collapsed (override the default)")
    ap.set_defaults(hide_tool_only=True, open_details=True)
    return ap


def main(argv = None) -> int:
    args = build_arg_parser().parse_args(argv)

    # Default redaction keywords from env so project secrets need not be retyped
    # each call (e.g. export LINEAGE_REDACT_EXTRA="acme-corp,db-pass"). Merged
    # with any --redact-extra given on the CLI.
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

    # Resolve input
    session_id: str
    jsonl_path = None  # set when reading from a real file (not stdin)
    if args.from_transcript:
        if args.from_transcript == "-":
            stream = sys.stdin
            session_id = "stdin"
        else:
            jsonl_path = pathlib.Path(args.from_transcript)
            stream = open(jsonl_path, encoding="utf-8")
            session_id = "file-" + jsonl_path.stem
    elif args.session:
        jsonl_path = pathlib.Path(args.session)
        stream = open(jsonl_path, encoding="utf-8")
        session_id = jsonl_path.stem
    else:
        f = auto_discover_jsonl()
        if not f:
            print("[lineage] No jsonl found. Use one of:",
                  "\n  --session FILE         explicit jsonl path",
                  "\n  --from-transcript -    paste transcript via stdin",
                  "\n  --from-transcript FILE read transcript from file",
                  file=sys.stderr)
            return 2
        jsonl_path = f
        stream = open(f, encoding="utf-8")
        session_id = f.stem
        print(f"[lineage] auto-discovered session: {f.name}", file=sys.stderr)

    # Resolve default --output using session_name (customTitle in jsonl)
    if args.output is None:
        session_name = discover_session_name(jsonl_path) if jsonl_path else None
        slug = session_name or session_id[:8]
        args.output = f"work/lineage-{slug}.html"
        if session_name:
            print(f"[lineage] session name: {session_name}", file=sys.stderr)

    try:
        try:
            turns = list(parse_turns(stream, unsafe_schema=args.unsafe_schema))
        except SystemExit as e:
            return int(e.code) if isinstance(e.code, int) else 2
    finally:
        if stream is not sys.stdin:
            stream.close()

    # stdin mode → derive per-turn uuid from hash so cache works
    if args.from_transcript == "-":
        for t in turns:
            t["uuid"] = hashlib.sha256(t["text"].encode()).hexdigest()[:16]

    # Drop tool-only assistant turns (no prose) — these are already guaranteed
    # to carry tools (text-less + tool-less turns were skipped in parse_turns).
    if args.hide_tool_only:
        turns = [t for t in turns
                 if not (t["role"] == "assistant" and not t["text"].strip())]

    # Range filters
    if args.from_:
        turns = [t for t in turns if (t["ts"] or "") >= args.from_]
    if args.to:
        turns = [t for t in turns if (t["ts"] or "") <= args.to]
    if args.turns:
        m = re.match(r"^(\d+)-(\d+)$", args.turns)
        if m:
            lo, hi = int(m.group(1)), int(m.group(2))
            turns = turns[lo - 1:hi]
        else:
            print(f"[lineage] invalid --turns '{args.turns}'", file=sys.stderr)
            return 2
    if args.last:
        turns = turns[-args.last:]

    if len(turns) > 100:
        print(f"[lineage] WARN: {len(turns)} turns is large — render may be slow",
              file=sys.stderr)

    rows, redact_counts, hits, total = render_rows(
        turns, session_id, args.redact_extra, args.redact_mode,
        args.rebuild_summaries, open_details=args.open_details
    )

    date_range = ""
    if turns:
        first = (turns[0]["ts"] or "")[:10]
        last = (turns[-1]["ts"] or "")[:10]
        date_range = first if first == last else f"{first} ~ {last}"

    # count=1 → user-content literal {{X}} (e.g. SKILL.md citations) won't be
    # touched. Template placeholders appear exactly once each in HTML_TEMPLATE.
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

    # Reviewer samples (assistant turns only)
    bots = [t for t in turns if t["role"] == "assistant"]
    if not args.skip_reviewer and bots:
        import random
        sample = random.sample(bots, min(5, len(bots)))
        review_samples = []
        for i, t in enumerate(sample):
            s, _ = read_or_summarize(
                t, session_id, rebuild=False,
                redact_extra=args.redact_extra, redact_mode=args.redact_mode)
            red_s, _ = redact(s, extra=args.redact_extra, mode=args.redact_mode)
            red_d, _ = redact(t["text"][:500], extra=args.redact_extra,
                              mode=args.redact_mode)
            review_samples.append({
                "idx": i,
                "original_detail": red_d,
                "generated_summary": red_s,
            })
        review_path = out.parent / f".{out.stem}.reviewer-input.json"
        review_path.write_text(
            json.dumps(review_samples, ensure_ascii=False, indent=2),
            encoding="utf-8")
        print(f"[lineage] reviewer samples: {review_path}", file=sys.stderr)
        print("[lineage] next: invoke Skill('oh-my-claudecode:critic') with the "
              "JSON above; expected output [{idx, recoverable, reason}, ...] "
              "(timeout 60s; PASS = 5/5 recoverable)", file=sys.stderr)
    elif args.skip_reviewer:
        print("[lineage] WARN: --skip-reviewer — quality gate not enforced",
              file=sys.stderr)

    # Reviewer quality gate (active when --reviewer-output is provided)
    if (not args.skip_reviewer) and bots and args.reviewer_output:
        import time as _time
        rop = pathlib.Path(args.reviewer_output)
        deadline = _time.time() + max(1, args.reviewer_timeout)
        while not rop.exists() and _time.time() < deadline:
            _time.sleep(1)
        if not rop.exists():
            print(f"[lineage] ERROR: reviewer-output not found within "
                  f"{args.reviewer_timeout}s: {rop}", file=sys.stderr)
            return 2
        try:
            verdict = json.loads(rop.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            print(f"[lineage] ERROR: reviewer-output JSON parse failed: {e}",
                  file=sys.stderr)
            return 2
        if not isinstance(verdict, list) or not verdict:
            print("[lineage] ERROR: reviewer-output is not a non-empty array",
                  file=sys.stderr)
            return 2
        fails = [v for v in verdict
                 if not (isinstance(v, dict) and v.get("recoverable") is True)]
        if fails:
            print(f"[lineage] FAIL: quality gate {len(verdict) - len(fails)}/"
                  f"{len(verdict)} samples recoverable. Reasons:",
                  file=sys.stderr)
            for f in fails:
                if isinstance(f, dict):
                    print(f"  - idx={f.get('idx', '?')}: "
                          f"{f.get('reason', '(no reason)')}", file=sys.stderr)
            return 2
        print(f"[lineage] PASS: quality gate {len(verdict)}/{len(verdict)} "
              "samples recoverable", file=sys.stderr)

    tool_total = sum(sum(t["tools"].values()) for t in turns)
    summary_line = (
        f"[lineage] turns={len(turns)} redacted={sum(redact_counts.values())} "
        f"tool_calls={tool_total} (filtered) cache_hits={hits}/{total} "
        f"size={out.stat().st_size}B output={out}"
    )
    print(summary_line, file=sys.stderr)
    if redact_counts:
        details = ", ".join(f"{k}={v}" for k, v in sorted(redact_counts.items()))
        print(f"[lineage] redaction breakdown: {details}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
