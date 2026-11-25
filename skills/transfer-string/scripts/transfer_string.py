"""transfer_string.py - banker transfer-string: turn a long text (or any file) into one short line
of text, and turn that line back into the original file. The /banker:transfer-string skill and the
compress-string, decompress-string commands all run this one script through transfer-string.mjs,
which finds a Python 3.7 or later and runs it with -I. Standard library only, no network. The
string is the one airgap-harness's transfer-string writes and reads (same blob, same alphabets).

Usage
  python -I transfer_string.py compress   <file> [--hangul] [--no-clipboard]
  python -I transfer_string.py compress   --clipboard [--hangul] [--no-clipboard]
  python -I transfer_string.py decompress <file> [--keep-name]
  python -I transfer_string.py decompress --clipboard [--keep-name]

compress writes <name>.b64 (--hangul: <name>.hangul) next to the input, or clipboard.b64 /
clipboard.hangul in the current folder for --clipboard, and puts the string on the clipboard when
it can. decompress finds the string by its content, in a file of any extension or on the clipboard
(text around it and every space, line break and byte order mark inside it are ignored), checks it
and writes the original file under its original name next to the input (the current folder for
--clipboard). A file that exists is never overwritten: -1, -2 ... goes before the extension
(report.md-1.b64, report-1.md). Both result files open in Notepad: .b64 holds bytes 0x21-0x7E
only (no BOM, no line break); .hangul is UTF-8 with a BOM, then syllables U+AC00..U+CBFF only.
A restored name that runs or is read on its own (a program, a script, a macro file, a dot file, a
name a tool picks up from the folder) is written with .restored after it (setup.exe.restored,
.npmrc.restored), and the summary names the original to rename it to once it is checked;
--keep-name writes the original name and only warns.

THE STRING
  .b64     standard Base64 (RFC 4648 section 4, with = padding) of the blob, one line. The whole
           string is valid Base64; the blob's first bytes 4D 24 D1 make it start with "TSTR".
  .hangul  the same blob, 13 bits per precomposed Hangul syllable U+AC00..U+CBFF (all in cp949 and
           in the default Korean font): about 0.46 times the characters of Base64 (13 bits against 6), 3 UTF-8 bytes each.
  blob = [4D 24 D1] [version 1] [blob length, 4 bytes] [method << 4 | flags]
         [method parameter: LZMA2 only, log2 of the dictionary size] [original length, LEB128]
         [name length] [name, UTF-8] [sha256 of the original, 8 bytes] [data]
         [crc32 of everything before, 4 bytes]   (numbers big-endian)
  method 0 stored, 1 deflate (raw, level 9), 2 bzip2 (level 9), 3 LZMA2 (raw, preset 9 extreme);
  a new method takes a new id. flags bit 0: the original is valid UTF-8 text.
  compress tries all four and keeps the smallest. decompress checks the crc32 before it reads
  anything else, decodes with an output limit of the declared length (never above 64 MiB), and
  writes nothing unless the length and the sha256 match.

Counts are Unicode code points (the .hangul count leaves out its BOM). An input that is not valid
UTF-8 is counted in bytes, and the summary says so.

Clipboard: on Windows, Windows PowerShell's Get-Clipboard and Set-Clipboard (System32), the text
passed as base64 so no code page touches it. On macOS /usr/bin/pbpaste and pbcopy (UTF-8 locale).
On Linux and other POSIX systems wl-paste and wl-copy (WAYLAND_DISPLAY), else xclip or xsel
(DISPLAY), taken from PATH only by an absolute path. With no clipboard (an SSH session, a service,
none of these programs) the copy is skipped with a note. For tests: TRANSFER_STRING_CLIPBOARD_IN=<file> is read instead of the
clipboard, TRANSFER_STRING_CLIPBOARD_OUT=<file> is written instead of it (UTF-8).

Output: Korean summary lines, then "TSTR_RESULT op=... in=... unit=char|byte out=... method=...
alphabet=base64|hangul13 ... file=<full path>". Errors: "[transfer-string] 오류: ..." and
"TSTR_ERROR code=E_..." on stderr. Exit 0 done; 1 no string found, or the string is damaged or
cut; 2 usage, or the input cannot be read; 3 the output cannot be written.
"""

import base64
import binascii
import bz2
import hashlib
import heapq
import lzma
import os
import re
import subprocess
import sys
import time
import unicodedata
import zlib

MAGIC = b"\x4d\x24\xd1"  # Base64 "TSTR"
VERSION = 1
HEAD = 8  # magic, version, blob length
HANGUL_BASE = 0xAC00
CAP = 64 * 1024 * 1024  # largest input and largest restored file
MAX_BLOB = 32 * 1024 * 1024
METHODS = ("stored", "deflate", "bzip2", "lzma2")
LZMA_PRESET = 9 | lzma.PRESET_EXTREME
BOM = b"\xef\xbb\xbf"
EXT = {"base64": ".b64", "hangul13": ".hangul"}
B64_RUNS = re.compile(r"[A-Za-z0-9+/]{4,}")
HANGUL_RUNS = re.compile("[\uac00-\ucbff]{2,}")
MAX_TRIES = (
    256  # frame marks looked at, so a text of decoy marks cannot keep decompress busy
)
RESERVED = re.compile(
    "(?i)^(con|prn|aux|nul|conin\\$|conout\\$|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])$"
)
HIDDEN = (
    "Cc",
    "Cf",
    "Zl",
    "Zp",
    "Co",
    "Cs",
)  # control, format (bidi, zero width), separators, private, surrogate
RISKY_EXT = {
    ".exe",
    ".bat",
    ".cmd",
    ".com",
    ".ps1",
    ".lnk",
    ".url",
    ".scf",
    ".library-ms",
    ".hta",
    ".js",
    ".jse",
    ".vbs",
    ".vbe",
    ".wsf",
    ".msi",
    ".py",
    ".sh",
    ".command",
    ".app",
    ".jar",
    ".docm",
    ".scr",
    ".pif",
    ".cpl",
    ".msc",
    ".reg",
    ".chm",
    ".iso",
    ".vhd",
    ".vhdx",
    ".appref-ms",
    ".xll",
    ".xlsm",
    ".pptm",
}
RISKY_NAME = {
    "conftest.py",
    "sitecustomize.py",
    "usercustomize.py",
    "makefile",
    "package.json",
    "desktop.ini",
}
ALPHA_KO = {"base64": "Base64", "hangul13": "한글 음절"}


class TsError(Exception):
    def __init__(self, code, exit_code, msg):
        super().__init__(msg)
        self.code = code
        self.exit_code = exit_code


def damaged(why):
    return TsError(
        "E_DAMAGED", 1, "문자열이 손상되었습니다 (%s). 파일을 만들지 않았습니다." % why
    )


# ---------------------------------------------------------------- Hangul, 13 bits per syllable
def hangul_chars(n):
    return (8 * n + 12) // 13


def encode_hangul(buf):
    out = []
    for i in range(0, len(buf), 13):
        chunk = buf[i : i + 13]
        v = int.from_bytes(chunk.ljust(13, b"\0"), "big")
        for j in range(hangul_chars(len(chunk))):
            out.append(chr(HANGUL_BASE + ((v >> (91 - 13 * j)) & 0x1FFF)))
    return "".join(out)


def decode_hangul(s, n):
    out = bytearray()
    p = 0
    while len(out) < n:
        r = min(13, n - len(out))
        k = hangul_chars(r)
        v = 0
        for j, ch in enumerate(s[p : p + k]):
            x = ord(ch) - HANGUL_BASE
            if x < 0 or x > 0x1FFF:
                raise damaged("허용되지 않은 글자")
            v |= x << (91 - 13 * j)
        p += k
        out += v.to_bytes(13, "big")[:r]
    return bytes(out)


HANGUL_PREFIX = encode_hangul(MAGIC + bytes([VERSION]))[
    :2
]  # fixed by the first 26 bits


# ---------------------------------------------------------------- blob
def varint(n):
    b = bytearray()
    while True:
        x = n & 127
        n >>= 7
        b.append(x | (128 if n else 0))
        if not n:
            return bytes(b)


def is_utf8(buf):
    try:
        buf.decode("utf-8", "strict")
        return True
    except UnicodeDecodeError:
        return False


def code_points(buf):
    return len(buf.decode("utf-8"))


def safe_name(name):
    """A file name that is safe to write and to show: no folder part, no control, bidi or zero-width
    character (a name that reads as another), no Windows device name (nul .md would swallow the data)."""
    s = "".join(
        "_" if unicodedata.category(c) in HIDDEN else c for c in str(name or "")
    )
    s = re.sub(r'[<>:"/\\|?*]', "_", s).lstrip().rstrip(". ")
    while len(s.encode("utf-8")) > 200:
        s = s[:-1].rstrip(". ")
    if not s or set(s) == {"."}:
        s = "restored"
    if RESERVED.match(s.split(".", 1)[0].rstrip(" ")):
        s = "_" + s
    return s


def risky(name):
    """Whether a restored name runs or is read on its own (a program, a script, a macro file, a dot
    file, a name a tool picks up from the folder): it is written as <name>.restored unless --keep-name."""
    low = name.lower()
    return (
        name.startswith(".")
        or low in RISKY_NAME
        or os.path.splitext(low)[1] in RISKY_EXT
    )


def lzma_exp(n):
    return max(12, min(26, (max(1, n) - 1).bit_length()))


def candidates(buf):
    c = zlib.compressobj(9, zlib.DEFLATED, -15, 9)
    exp = lzma_exp(len(buf))
    lz = lzma.compress(
        buf,
        format=lzma.FORMAT_RAW,
        filters=[
            {"id": lzma.FILTER_LZMA2, "preset": LZMA_PRESET, "dict_size": 1 << exp}
        ],
    )
    return [
        (0, b"", buf),
        (1, b"", c.compress(buf) + c.flush()),
        (2, b"", bz2.compress(buf, 9)),
        (3, bytes([exp]), lz),
    ]


def build_blob(buf, name):
    if len(buf) > CAP:
        raise TsError("E_INPUT", 2, "입력이 64 MiB 를 넘습니다.")
    text = is_utf8(buf)
    best = min(candidates(buf), key=lambda m: (len(m[1]) + len(m[2]), m[0]))
    nb = safe_name(name).encode("utf-8")
    body = (
        bytes([(best[0] << 4) | (1 if text else 0)])
        + best[1]
        + varint(len(buf))
        + bytes([len(nb)])
        + nb
        + hashlib.sha256(buf).digest()[:8]
        + best[2]
    )
    total = HEAD + len(body) + 4
    if total > MAX_BLOB:
        raise TsError("E_INPUT", 2, "압축 결과가 32 MiB 를 넘습니다.")
    head = MAGIC + bytes([VERSION]) + total.to_bytes(4, "big") + body
    return head + zlib.crc32(head).to_bytes(4, "big"), METHODS[best[0]], text


def build_string(buf, name, hangul=False):
    blob, method, text = build_blob(buf, name)
    s = encode_hangul(blob) if hangul else base64.b64encode(blob).decode("ascii")
    return {
        "str": s,
        "method": method,
        "text": text,
        "blob": len(blob),
        "alphabet": "hangul13" if hangul else "base64",
    }


def check_head(head):
    """The blob length from the first 8 bytes, or an error."""
    if head[:3] != MAGIC:
        raise damaged("머리 표지")
    if head[3] != VERSION:
        raise damaged("알 수 없는 판 %d" % head[3])
    n = int.from_bytes(head[4:8], "big")
    if n < HEAD + 15 or n > MAX_BLOB:
        raise damaged("길이 칸")
    return n


def parse_blob(blob):
    if zlib.crc32(blob[:-4]) != int.from_bytes(blob[-4:], "big"):
        raise damaged("검사합 불일치")
    end = len(blob) - 4
    p = HEAD
    method, flags = blob[p] >> 4, blob[p] & 15
    p += 1
    param = b""
    if method == 3:
        param = blob[p : p + 1]
        p += 1
    orig, shift = 0, 0
    while True:
        if p >= end or shift > 35:
            raise damaged("머리 부분")
        b = blob[p]
        p += 1
        orig |= (b & 127) << shift
        shift += 7
        if not b & 128:
            break
    if p >= end:
        raise damaged("머리 부분")
    nl = blob[p]
    p += 1
    name = blob[p : p + nl].decode("utf-8", "replace")
    p += nl
    sha8 = blob[p : p + 8]
    p += 8
    if p > end:
        raise damaged("머리 부분이 잘림")
    return {
        "method": method,
        "text": bool(flags & 1),
        "param": param,
        "orig": orig,
        "name": name,
        "sha8": sha8,
        "data": blob[p:end],
    }


def clean(text):
    return re.sub(r"[\s\u200b-\u200d\u2060\ufeff]+", "", text)


def head_at(s, i, hangul, run):
    """The blob length of the frame that starts at i, run characters of its alphabet long; an error
    here means it is no frame of ours."""
    if hangul:
        if run < 5:
            raise TsError("E_CUT", 1, "문자열이 잘렸습니다. 파일을 만들지 않았습니다.")
        return check_head(decode_hangul(s[i : i + 5], HEAD))
    if run < 12:
        raise TsError("E_CUT", 1, "문자열이 잘렸습니다. 파일을 만들지 않았습니다.")
    return check_head(base64.b64decode(s[i : i + 12]))


def body_at(s, i, hangul, run, n):
    need = hangul_chars(n) if hangul else (4 * n + 2) // 3
    if run < need:
        raise TsError(
            "E_CUT",
            1,
            "문자열이 잘렸습니다 (%d자 중 %d자). 파일을 만들지 않았습니다."
            % (need, run),
        )
    if hangul:
        return decode_hangul(s[i : i + need], n), need
    part = s[i : i + need]
    pad = (-len(part)) % 4
    chars = need + (pad if s[i + need : i + need + pad] == "=" * pad else 0)
    try:
        blob = base64.b64decode(part + "=" * pad, validate=True)
    except binascii.Error:
        raise damaged("Base64")
    if len(blob) != n:
        raise damaged("길이 불일치")
    return blob, chars


def mark_starts(s, runs, mark, hangul):
    """(start, hangul, run) of each frame mark in one alphabet's runs, in text order. One pass: the
    run is where its match ends, so a text of repeated marks is not scanned again per mark."""
    for m in runs.finditer(s):
        at = s.find(mark, m.start(), m.end())
        while at >= 0:
            yield at, hangul, m.end() - at
            at = s.find(mark, at + 1, m.end())


def read_string(text):
    """The first frame in the text that checks out; whitespace and BOMs are removed first. When none
    does, the error of the first one whose head was ours (else of the first candidate). Only the
    first MAX_TRIES marks are looked at."""
    s = clean(text)
    shallow = deep = None
    marks = heapq.merge(
        mark_starts(s, B64_RUNS, "TSTR", False),
        mark_starts(s, HANGUL_RUNS, HANGUL_PREFIX, True),
    )
    skip_to = (
        -1
    )  # a mark inside a frame whose body was decoded and failed is not tried again
    for tries, (i, hangul, run) in enumerate(marks):
        if tries >= MAX_TRIES:
            break
        if i < skip_to:
            continue
        try:
            n = head_at(s, i, hangul, run)
        except TsError as e:
            shallow = shallow or e
            continue
        need = hangul_chars(n) if hangul else (4 * n + 2) // 3
        try:
            blob, chars = body_at(s, i, hangul, run, n)
            frame = parse_blob(blob)
        except TsError as e:
            deep = deep or e
            if run >= need:  # decoded: the characters it covered are not read again
                skip_to = i + need
            continue
        frame["alphabet"] = "hangul13" if hangul else "base64"
        frame["chars"] = chars
        return frame
    if deep or shallow:
        raise deep or shallow
    raise TsError(
        "E_NOTFOUND",
        1,
        "입력에 transfer-string 문자열이 없습니다 (Base64 는 TSTR 로 시작).",
    )


def restore(frame):
    n, m, data = frame["orig"], frame["method"], frame["data"]
    if n > CAP:
        raise damaged("원본 길이가 64 MiB 를 넘음")
    limit = n + 1
    try:
        if m == 0:
            out, done = bytes(data), True
        elif m == 1:
            d = zlib.decompressobj(-15)
            out = d.decompress(data, limit)
            done = d.eof and not d.unconsumed_tail and not d.unused_data
        elif m == 2:
            d = bz2.BZ2Decompressor()
            out = d.decompress(data, max_length=limit)
            done = d.eof and not d.unused_data
        elif m == 3:
            exp = frame["param"][0] if frame["param"] else 0
            if not 12 <= exp <= 26:
                raise damaged("사전 크기")
            d = lzma.LZMADecompressor(
                format=lzma.FORMAT_RAW,
                filters=[{"id": lzma.FILTER_LZMA2, "dict_size": 1 << exp}],
            )
            out = d.decompress(data, max_length=limit)
            done = d.eof and not d.unused_data
        else:
            raise damaged("알 수 없는 압축 방식 %d" % m)
    except TsError:
        raise
    except (zlib.error, OSError, lzma.LZMAError, EOFError, ValueError, MemoryError):
        raise damaged("압축 해제 실패")
    if len(out) != n or not done:
        raise damaged("길이 불일치")
    if hashlib.sha256(out).digest()[:8] != frame["sha8"]:
        raise damaged("원본 sha256 불일치")
    return out


# ---------------------------------------------------------------- files, clipboard
def write_free(folder, stem, ext, data):
    for i in range(10000):
        p = os.path.join(folder, stem + ("-%d" % i if i else "") + ext)
        try:
            with open(p, "xb") as f:
                f.write(data)
            return p
        except FileExistsError:
            continue
        except OSError as e:
            raise TsError(
                "E_WRITE", 3, "파일을 쓰지 못했습니다: %s (%s)" % (p, e.strerror or e)
            )
    raise TsError(
        "E_WRITE",
        3,
        "빈 파일 이름을 찾지 못했습니다: " + os.path.join(folder, stem + ext),
    )


def powershell(script, stdin=""):
    exe = os.path.join(
        os.environ.get("SystemRoot", r"C:\Windows"),
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
    )
    if os.name != "nt" or not os.path.isfile(exe):
        return False, "Windows PowerShell 이 없습니다"
    enc = base64.b64encode(script.encode("utf-16-le")).decode("ascii")
    try:
        r = subprocess.run(
            [exe, "-NoProfile", "-NonInteractive", "-Sta", "-EncodedCommand", enc],
            input=stdin.encode("ascii"),
            capture_output=True,
            timeout=60,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.SubprocessError) as e:
        return False, type(e).__name__
    if r.returncode != 0:
        line = (r.stderr.decode("ascii", "replace").strip().splitlines() or [""])[0][
            :160
        ]
        return False, "exit %d%s" % (r.returncode, ": " + line if line else "")
    return True, r.stdout.decode("ascii", "replace")


def on_path(name):
    """The program's absolute path from the absolute PATH entries only, or None: a relative entry such
    as '.' or an empty one would pick a program from the working folder."""
    for d in os.environ.get("PATH", "").split(os.pathsep):
        p = os.path.join(d, name)
        if os.path.isabs(d) and os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    return None


def posix_clipboard():
    """([(paste argv, copy argv, env), ...], why) for macOS and the other POSIX systems: every tool
    that is there, in order, so a stale WAYLAND_DISPLAY falls through to xclip. wl-paste asks for
    text, so an image on the clipboard is an error, not a damaged text."""
    if sys.platform == "darwin":
        paste, copy = "/usr/bin/pbpaste", "/usr/bin/pbcopy"
        if os.path.isfile(paste) and os.path.isfile(copy):
            return [([paste], [copy], dict(os.environ, LC_ALL="en_US.UTF-8"))], ""
        return [], "pbcopy, pbpaste 가 없습니다"
    wanted = []
    if os.environ.get("WAYLAND_DISPLAY"):
        wanted.append((["wl-paste", "--no-newline", "--type", "text"], ["wl-copy"]))
    if os.environ.get("DISPLAY"):
        wanted.append(
            (
                ["xclip", "-selection", "clipboard", "-o"],
                ["xclip", "-selection", "clipboard", "-i"],
            )
        )
        wanted.append(
            (["xsel", "--clipboard", "--output"], ["xsel", "--clipboard", "--input"])
        )
    if not wanted:
        return [], "화면 세션이 없습니다 (DISPLAY, WAYLAND_DISPLAY 없음)"
    tools = []
    for paste, copy in wanted:
        a, b = on_path(paste[0]), on_path(copy[0])
        if a and b:
            tools.append(([a] + paste[1:], [b] + copy[1:], dict(os.environ)))
    return tools, "" if tools else "wl-copy, xclip, xsel 이 없습니다"


def posix_run(argv, data, env, want_out):
    """(True, stdout bytes) or (False, why). wl-copy and xclip stay behind to serve the clipboard, holding
    whatever pipes they got: only a reader gets a stdout pipe, and stderr never gets one."""
    try:
        r = subprocess.run(
            argv,
            input=data,
            stdout=subprocess.PIPE if want_out else subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=20,
            env=env,
        )
    except (OSError, subprocess.SubprocessError) as e:
        return False, type(e).__name__
    if r.returncode != 0:
        return False, "%s exit %d" % (os.path.basename(argv[0]), r.returncode)
    return True, r.stdout or b""


def read_clipboard():
    f = os.environ.get("TRANSFER_STRING_CLIPBOARD_IN")
    if f:
        with open(f, "rb") as h:
            return h.read().decode("utf-8", "replace")
    if os.name != "nt":
        tools, why = posix_clipboard()
        for paste, _, env in tools:
            ok, out = posix_run(paste, b"", env, True)
            if ok:
                return out.decode("utf-8", "replace")
            why = out
        raise TsError("E_CLIPBOARD", 2, "클립보드를 읽지 못했습니다 (%s)." % why)
    ok, out = powershell(
        "$ErrorActionPreference='Stop'; $t = Get-Clipboard -Raw; if ($null -eq $t) { $t = '' }; "
        "[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$t)))"
    )
    if not ok:
        raise TsError("E_CLIPBOARD", 2, "클립보드를 읽지 못했습니다 (%s)." % out)
    return base64.b64decode(out.strip()).decode("utf-8", "replace")


def write_clipboard(text):
    f = os.environ.get("TRANSFER_STRING_CLIPBOARD_OUT")
    if f:
        with open(f, "wb") as h:
            h.write(text.encode("utf-8"))
        return True, ""
    if os.name != "nt":
        tools, why = posix_clipboard()
        for _, copy, env in tools:
            ok, out = posix_run(copy, text.encode("utf-8"), env, False)
            if ok:
                return True, ""
            why = out
        return False, why
    return powershell(
        "$ErrorActionPreference='Stop'; $b = [Console]::In.ReadToEnd().Trim(); "
        "Set-Clipboard -Value ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b)))",
        base64.b64encode(text.encode("utf-8")).decode("ascii"),
    )


def mark_untrusted(src, dst):
    """Gives the restored file the download mark its string came with, so Windows SmartScreen and
    Office's Protected View, or macOS Gatekeeper, still look at a restored program or macro file:
    the input file's mark when it has one, else the Internet zone (the string came from someone
    else). Returns zone, quarantine, none (no such mark on this system) or failed."""
    if os.name == "nt":
        zone = b"[ZoneTransfer]\r\nZoneId=3\r\n"
        if src:
            try:
                with open(src + ":Zone.Identifier", "rb") as h:
                    got = h.read(4096)
                if b"ZoneId=" in got:
                    zone = got
            except OSError:
                pass
        try:
            with open(dst + ":Zone.Identifier", "wb") as h:
                h.write(zone)
            return "zone"
        except OSError:
            return "failed"
    if sys.platform != "darwin":
        return "none"
    xattr = "/usr/bin/xattr"
    value = "0081;%08x;transfer-string;" % int(time.time())
    try:
        if src:
            r = subprocess.run(
                [xattr, "-p", "com.apple.quarantine", src],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                timeout=20,
            )
            got = r.stdout.decode("utf-8", "replace").strip()
            if r.returncode == 0 and got:
                value = got
        r = subprocess.run(
            [xattr, "-w", "com.apple.quarantine", value, dst],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=20,
        )
    except (OSError, subprocess.SubprocessError):
        return "failed"
    return "quarantine" if r.returncode == 0 else "failed"


MARK_KO = {
    "zone": "인터넷에서 받은 파일로 표시함 (Zone.Identifier)",
    "quarantine": "인터넷에서 받은 파일로 표시함 (com.apple.quarantine)",
    "none": "이 OS 에는 없음",
    "failed": "표시하지 못함",
}


def read_input(name):
    full = os.path.abspath(name)
    if not os.path.exists(full):
        raise TsError("E_INPUT", 2, "파일이 없습니다: " + full)
    if not os.path.isfile(full):
        raise TsError("E_INPUT", 2, "파일이 아닙니다: " + full)
    if os.path.getsize(full) > CAP:
        raise TsError("E_INPUT", 2, "입력이 64 MiB 를 넘습니다: " + full)
    try:
        with open(full, "rb") as h:
            return full, h.read()
    except OSError as e:
        raise TsError(
            "E_INPUT", 2, "파일을 읽지 못했습니다: %s (%s)" % (full, e.strerror or e)
        )


def decode_text_file(buf):
    """Notepad saves UTF-8 (with or without a BOM), ANSI (cp949 here) or "Unicode" (UTF-16 with a BOM)."""
    if buf[:2] == b"\xff\xfe":
        return buf[2:].decode("utf-16-le", "replace")
    if buf[:2] == b"\xfe\xff":
        return buf[2:].decode("utf-16-be", "replace")
    try:
        return buf.decode("utf-8")
    except UnicodeDecodeError:
        return buf.decode("cp949", "replace")


# ---------------------------------------------------------------- commands
def say(s):
    sys.stdout.write(s + "\n")


def do_compress(o):
    if o["clipboard"]:
        t = read_clipboard().lstrip("\ufeff")
        if not t:
            raise TsError("E_CLIPBOARD", 2, "클립보드가 비어 있습니다.")
        buf, name, folder, stem = (
            t.encode("utf-8"),
            "clipboard.md",
            os.getcwd(),
            "clipboard",
        )
    else:
        full, buf = read_input(o["file"])
        name, folder = os.path.basename(full), os.path.dirname(full)
        stem = safe_name(name)
    r = build_string(buf, name, o["hangul"])
    data = (BOM + r["str"].encode("utf-8")) if o["hangul"] else r["str"].encode("ascii")
    out = write_free(folder, stem, EXT[r["alphabet"]], data)
    if o["copy"]:
        ok, why = write_clipboard(r["str"])
        clip, note = (
            ("copied", "결과 문자열을 복사했습니다")
            if ok
            else ("failed", "복사하지 못했습니다 (%s). 결과 파일을 여십시오" % why)
        )
    else:
        clip, note = "off", "복사하지 않음 (--no-clipboard)"
    n_in = code_points(buf) if r["text"] else len(buf)
    n_out = len(r["str"])
    say("[transfer-string] 압축 완료 (%s, %s)" % (r["method"], ALPHA_KO[r["alphabet"]]))
    say(
        "원본 글자 수: {:,}자".format(n_in)
        if r["text"]
        else "원본 크기: {:,}바이트 (UTF-8 텍스트가 아니라 바이트로 셈)".format(n_in)
    )
    say("결과 글자 수: {:,}자".format(n_out))
    say("결과 파일: %s (메모장으로 열 수 있음)" % out)
    say("클립보드: " + note)
    say(
        "TSTR_RESULT op=compress in=%d unit=%s out=%d method=%s alphabet=%s clipboard=%s file=%s"
        % (
            n_in,
            "char" if r["text"] else "byte",
            n_out,
            r["method"],
            r["alphabet"],
            clip,
            out,
        )
    )


RESTORED = ".restored"


def restore_name(name, keep):
    """(name to write, risky, renamed): a risky name gets .restored after it unless keep."""
    warn = risky(name)
    renamed = warn and not keep
    return (name + RESTORED if renamed else name), warn, renamed


def say_risky(name, renamed):
    if renamed:
        say("원래 이름: " + name)
        say(
            "주의: 실행되거나 자동으로 읽힐 수 있는 이름이라 뒤에 %s 를 붙여 썼습니다. "
            "보낸 사람과 내용을 확인한 뒤 파일 이름을 원래 이름(%s)으로 바꾸십시오. "
            "처음부터 원래 이름으로 쓰려면 --keep-name 을 주십시오." % (RESTORED, name)
        )
    else:
        say(
            "주의: 실행되거나 자동으로 읽힐 수 있는 이름입니다. 보낸 사람과 내용을 확인한 뒤 여십시오."
        )


def do_decompress(o):
    full = None
    if o["clipboard"]:
        text, folder = read_clipboard(), os.getcwd()
        if not clean(text):
            raise TsError("E_CLIPBOARD", 2, "클립보드가 비어 있습니다.")
    else:
        full, buf = read_input(o["file"])
        text, folder = decode_text_file(buf), os.path.dirname(full)
    frame = read_string(text)
    data = restore(frame)
    name = safe_name(frame["name"])
    put, warn, renamed = restore_name(name, o["keep"])
    stem, ext = os.path.splitext(put)
    out = write_free(folder, stem or put, ext if stem else "", data)
    mark = mark_untrusted(full, out)
    text_out = frame["text"] and is_utf8(data)
    n_out = code_points(data) if text_out else len(data)
    say(
        "[transfer-string] 복원 완료 (%s, %s, 원본 sha256 일치)"
        % (METHODS[frame["method"]], ALPHA_KO[frame["alphabet"]])
    )
    say("압축 문자열 글자 수: {:,}자".format(frame["chars"]))
    say(
        "복원 글자 수: {:,}자".format(n_out)
        if text_out
        else "복원 크기: {:,}바이트 (UTF-8 텍스트가 아니라 바이트로 셈)".format(n_out)
    )
    say("복원 파일: " + out)
    say("다운로드 표시: " + MARK_KO[mark])
    if warn:
        say_risky(name, renamed)
    say(
        "TSTR_RESULT op=decompress in=%d unit=%s out=%d method=%s alphabet=%s mark=%s risky=%d renamed=%d file=%s"
        % (
            frame["chars"],
            "char" if text_out else "byte",
            n_out,
            METHODS[frame["method"]],
            frame["alphabet"],
            mark,
            1 if warn else 0,
            1 if renamed else 0,
            out,
        )
    )


USAGE = "\n".join(
    [
        "사용법:",
        "  compress-string <파일> [--hangul] [--no-clipboard]   긴 글을 한 줄 문자열로 (<파일>.b64, --hangul 이면 <파일>.hangul)",
        "  compress-string --clipboard [--hangul]              클립보드의 글을 압축 (clipboard.b64)",
        "  decompress-string <파일> [--keep-name]              문자열이 든 파일(확장자 무관)을 원래 파일로",
        "  decompress-string --clipboard [--keep-name]         클립보드의 문자열을 원래 파일로",
        "  --hangul: 한글 음절 문자 집합(Base64 의 약 0.46배 글자 수, 글자당 3바이트). 기본은 Base64.",
        "  --keep-name: 실행되거나 자동으로 읽힐 이름도 .restored 를 붙이지 않고 원래 이름으로 씀.",
    ]
)


def parse_options(op, args):
    o = {"file": "", "clipboard": False, "hangul": False, "copy": True, "keep": False}
    for a in args:
        if a == "--clipboard":
            o["clipboard"] = True
        elif a == "--hangul" and op == "compress":
            o["hangul"] = True
        elif a == "--no-clipboard" and op == "compress":
            o["copy"] = False
        elif a == "--keep-name" and op == "decompress":
            o["keep"] = True
        elif a.startswith("--"):
            raise TsError("E_USAGE", 2, "알 수 없는 옵션: " + a)
        elif not o["file"]:
            o["file"] = a
        else:
            raise TsError("E_USAGE", 2, "파일은 하나만 줍니다: " + a)
    if o["clipboard"] and o["file"]:
        raise TsError("E_USAGE", 2, "파일과 --clipboard 를 함께 줄 수 없습니다.")
    if not o["clipboard"] and not o["file"]:
        raise TsError("E_USAGE", 2, "파일이나 --clipboard 를 주십시오.")
    return o


def main(argv):
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    op = argv[0] if argv else ""
    try:
        if op not in ("compress", "decompress"):
            raise TsError(
                "E_USAGE", 2, ("알 수 없는 명령: " + op) if op else "명령이 없습니다."
            )
        o = parse_options(op, argv[1:])
        if op == "compress":
            do_compress(o)
        else:
            do_decompress(o)
        return 0
    except TsError as e:
        sys.stderr.write("[transfer-string] 오류: %s\n" % e)
        if e.code == "E_USAGE":
            sys.stderr.write(USAGE + "\n")
        sys.stderr.write("TSTR_ERROR code=%s\n" % e.code)
        return e.exit_code
    except (
        Exception
    ) as e:  # a bug or the machine (memory, a removed folder), never the string: exit 4
        sys.stderr.write(
            "[transfer-string] 오류: 도우미 내부 오류 (%s: %s).\n"
            % (type(e).__name__, e)
        )
        sys.stderr.write("TSTR_ERROR code=E_INTERNAL\n")
        return 4


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
