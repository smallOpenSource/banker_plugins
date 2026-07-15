---
name: setup-mcp
description: "(banker) context7·sequential-thinking·filesystem·git·fetch(+선택 tavily) 범용 MCP 서버를 Claude Code(claude mcp add)·Codex(codex mcp add+config.toml)에 배선(serena·lsp_bridge 제외). 'setup-mcp'/'MCP 서버 설치'/'context7·sequential-thinking 설치' 또는 /banker:setup 시 사용."
---

# setup-mcp: 범용 MCP 서버 설치

context7·sequential-thinking·filesystem·git·fetch - 특정 도구에 종속되지 않는 5종 표준 MCP 서버를
Claude Code·Codex 양쪽에 배선한다. **`setup-omc`(OMC/OMX 프레임워크 자체 설치, 자기 도구를 따로 들고 옴)와도,
`setup-lsp`(`lsp_bridge` 전용)와도 다르다** - 이 스킬은 그 외 범용 standalone 서버만 다룬다. Serena 는
프로젝트 스코프(`--project` 가 홈 디렉터리면 인덱싱 과부하)라 여기서 제외한다. 설치는 **멱등**(있으면
remove 후 재-add). 답변은 한글(기술 토큰 영문).

## 런타임 배선
- **Claude Code**: `claude mcp add <name> -s user -- <command> ...` - CLI 가 설정을 직접 관리.
- **Codex**: 현재 공식 CLI `codex mcp add <name> -- <command> ...` 로 등록(내부적으로 `~/.codex/config.toml`
  `[mcp_servers.<name>]` 에 기록) - 단 `startup_timeout_sec`(기본 10초, 첫 npx/uvx 다운로드 대비 300초로
  올려야 함)은 CLI 플래그로 노출되지 않는다 → **Python replace-or-append** 로 그 필드만 추가 패치한다.

## 0. 감지 (먼저, 추정 금지)
```bash
command -v npx >/dev/null && echo "npx=yes" || echo "npx=no (setup-node 먼저)"
command -v uvx >/dev/null && echo "uvx=yes" || echo "uvx=no (setup-python 먼저)"
command -v claude >/dev/null && claude mcp list 2>/dev/null
command -v codex >/dev/null && codex mcp list 2>/dev/null
[ -f ~/.codex/config.toml ] && grep -c 'startup_timeout_sec = 300' ~/.codex/config.toml
```

## 1. Preflight
- **npx 없음** → Node 미설치 → `setup-node` 스킬로 먼저 설치.
- **uvx 없음** → uv 미설치 → `setup-python` 스킬로 먼저 설치(uv 설치는 그 스킬 소관).
- 둘 다 있으면 2로 진행.

## 2. 서버 목록
| name | command | args |
|---|---|---|
| context7 | npx | `-y @upstash/context7-mcp` |
| sequential-thinking | npx | `-y @modelcontextprotocol/server-sequential-thinking` |
| filesystem | npx | `-y @modelcontextprotocol/server-filesystem <dir>` |
| git | uvx | `mcp-server-git` |
| fetch | uvx | `mcp-server-fetch` |
| tavily(선택) | npx | `-y tavily-mcp` (env `TAVILY_API_KEY`) |

`<dir>` = `--fs-dir` 인자 또는 기본 `$HOME/projects`. **홈 디렉터리 전체를 넘기지 않는다** - Serena
`--project` 경고와 같은 이유(파일 노출 범위 과다)로, 실제 프로젝트 경로만 지정한다.

## 3. Claude Code 배선
```bash
FS_DIR="${FS_DIR:-$HOME/projects}"

claude mcp remove context7 -s user 2>/dev/null
claude mcp add context7 -s user -- npx -y @upstash/context7-mcp

claude mcp remove sequential-thinking -s user 2>/dev/null
claude mcp add sequential-thinking -s user -- npx -y @modelcontextprotocol/server-sequential-thinking

claude mcp remove filesystem -s user 2>/dev/null
claude mcp add filesystem -s user -- npx -y @modelcontextprotocol/server-filesystem "$FS_DIR"

claude mcp remove git -s user 2>/dev/null
claude mcp add git -s user -- uvx mcp-server-git

claude mcp remove fetch -s user 2>/dev/null
claude mcp add fetch -s user -- uvx mcp-server-fetch

claude mcp list
```
선택(Tavily) - **실제 키를 채팅·로그에 남기지 말 것**, 사용자가 자기 터미널에서 직접 교체:
```bash
claude mcp remove tavily -s user 2>/dev/null
claude mcp add tavily -s user -e TAVILY_API_KEY=YOUR_TAVILY_API_KEY -- npx -y tavily-mcp
```

## 4. Codex 배선
```bash
codex mcp remove context7 2>/dev/null
codex mcp add context7 -- npx -y @upstash/context7-mcp

codex mcp remove sequential-thinking 2>/dev/null
codex mcp add sequential-thinking -- npx -y @modelcontextprotocol/server-sequential-thinking

codex mcp remove filesystem 2>/dev/null
codex mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem "${FS_DIR:-$HOME/projects}"

codex mcp remove git 2>/dev/null
codex mcp add git -- uvx mcp-server-git

codex mcp remove fetch 2>/dev/null
codex mcp add fetch -- uvx mcp-server-fetch

codex mcp list
```
선택(Tavily, 실제 키 미노출):
```bash
codex mcp remove tavily 2>/dev/null
codex mcp add tavily --env TAVILY_API_KEY=YOUR_TAVILY_API_KEY -- npx -y tavily-mcp
```

`startup_timeout_sec` 패치(기본 10초는 첫 npx/uvx 다운로드엔 부족) - **Python replace-or-append** 로 방금
등록한 테이블에만 삽입하고 그 외(OMX 가 배포한 엔트리 등)는 건드리지 않는다(멱등: 이미 있으면 스킵).
`tomllib` 는 Python **3.11+** 전용이라(RHEL8/Rocky8 기본 `python3` 는 3.6 인 경우가 흔함) 먼저 인터프리터를
고른다:
```bash
PY="$(command -v python3.12 || command -v python3.11 || command -v python3)"
"$PY" -c "import tomllib" 2>/dev/null || echo "⚠ tomllib 없음 - Python 3.11+ 설치 후 재시도(setup-python 참고)"
```
```bash
"$PY" <<'EOF'
import re
from pathlib import Path
import tomllib

CFG = Path.home() / ".codex" / "config.toml"
NAMES = ["context7", "sequential-thinking", "filesystem", "git", "fetch"]  # tavily 추가했으면 여기도 추가

text = CFG.read_text(encoding="utf-8")
tomllib.loads(text)  # 사전 검증 - 깨진 TOML이면 여기서 예외

parts = re.split(r"(?=^\[)", text, flags=re.MULTILINE)
out = []
for part in parts:
    m = re.match(r"\[mcp_servers\.([^\]]+)\]", part)
    if m and m.group(1) in NAMES and "startup_timeout_sec" not in part:
        head, _, rest = part.partition("\n")
        part = f"{head}\nstartup_timeout_sec = 300\n{rest}"
    out.append(part)

new_text = "".join(out)
tomllib.loads(new_text)  # 패치 후 재검증
CFG.write_text(new_text, encoding="utf-8")
print("patched:", [n for n in NAMES if f"[mcp_servers.{n}]" in new_text])
EOF
```

## 검증 (보고 의무)
```bash
claude mcp list                                # 각 서버가 ✔ Connected 인지 확인
codex mcp list --json | python3 -m json.tool   # 각 서버 등록 확인(json.tool 은 아무 python3 로 충분)
PY="$(command -v python3.12 || command -v python3.11 || command -v python3)"   # tomllib=3.11+
"$PY" -c "import tomllib; tomllib.loads(open('$HOME/.codex/config.toml', encoding='utf-8').read()); print('✓ TOML 유효')"
grep -c 'startup_timeout_sec = 300' ~/.codex/config.toml   # 5(+tavily)건 이상 기대
```
4-field 보고: 변경(등록한 서버 목록·config.toml 패치분) / Evidence(위 출력) / 검증(Connected·TOML 유효) /
Unknown(네트워크 차단으로 첫 다운로드 실패 등).

## 함정
- **첫 실행 지연**: npx/uvx 첫 다운로드는 수십 초 걸릴 수 있다 - Codex 는 `startup_timeout_sec=300` 로
  여유를 두지만, Claude Code 쪽은 최초 1회 재시도가 필요할 수 있다(정직 안내).
- **Tavily 키**: 플레이스홀더 `YOUR_TAVILY_API_KEY` 를 실제 키로 교체하기 전엔 연결 실패 - 채팅·로그·커밋에
  실키를 노출하지 않는다.
- **uvx 전제**: uv 미설치 시 git·fetch 서버가 실패 → `setup-python` 선행.
- **filesystem 디렉터리 범위**: 홈 전체를 넘기면 과다 노출 - 프로젝트 디렉터리로 한정한다.
- **`codex mcp add` 는 timeout 플래그가 없다**: 위 Python 패치를 별도로 수행해야 300초가 실제로 반영된다.
- **Windows 인코딩**: config.toml 을 다루는 Python 은 `encoding='utf-8'` 명시(CP949 회피).

ARGUMENTS: [--fs-dir <path>] [--tavily] [--server <name>,...] (없으면 context7·sequential-thinking·filesystem·git·fetch 5종 전부, tavily 는 --tavily 명시 시에만)
