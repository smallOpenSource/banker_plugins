---
name: setup-mcp
description: "범용 MCP 서버(context7, sequential-thinking, filesystem, git, fetch, 선택 사항인 tavily)를 Claude Code(`claude mcp add`)와 Codex(`codex mcp add`, `config.toml`)에 등록. serena 와 `lsp_bridge` 는 제외. 'setup-mcp'/'MCP 서버 설치'/'context7 설치'/'sequential-thinking 설치' 또는 `/banker:setup` 시 사용."
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

### 네트워크 확인 (내려받기 전)

이 스킬이 내려받는 원천에 닿는지 먼저 본다(curl 은 10초, npm 은 15초 안). 닿지 않으면 그 원천에서 받는 단계는 하지 않고, 이미 설치된 것의 확인만 한 뒤 "오프라인이라 설치하지 않음(필요한 것: <못 깐 것>)" 으로 보고한다.

```bash
[ "${CODEX_SANDBOX_NETWORK_DISABLED:-}" = 1 ] && echo "Codex sandbox 가 네트워크를 막음(아래 실패는 오프라인이 아님)"
in15() { "$@" & p=$!; ( sleep 15 && kill "$p" ) 2>/dev/null & k=$!; wait "$p" 2>/dev/null; r=$?; kill "$k" 2>/dev/null; wait "$k" 2>/dev/null; [ "$r" = 143 ] && echo "15초 안에 끝나지 않아 멈춤(패킷을 버리는 망일 수 있음)"; return "$r"; }
in15 sh -c 'cd ~ && exec npm ping --fetch-retries=0 --fetch-timeout=10000 --no-update-notifier'   # npx 서버
# pip 이 읽는 설정 전부(PIP_CONFIG_FILE 포함)를 홈 폴더에서 읽는다. install 절이 global 절보다 앞선다
L=$( (cd ~ && { pip config list || pip3 config list || python3.13 -m pip config list || python3.12 -m pip config list || python3.11 -m pip config list || python3 -m pip config list; }) 2>/dev/null) || echo "pip 설정을 읽지 못함(pip 이 없거나 10 미만). 사내 미러를 쓰면 확인 주소를 그 미러로 바꿔 본다"
I="${PIP_INDEX_URL:-$(printf '%s\n' "$L" | sed -n "s/^install\.index-url='\(.*\)'$/\1/p")}"
I="${I:-$(printf '%s\n' "$L" | sed -n "s/^global\.index-url='\(.*\)'$/\1/p")}"
I=$(printf %s "${I:-https://pypi.org/simple}" | sed -E 's#^([A-Za-z][A-Za-z0-9+.-]*://)[^/]*@#\1#; s#/$##')   # 주소의 사용자 정보는 뗌
printf 'url = "%s"\n' "$I/pip/" | curl --ssl-no-revoke -K - -sSI -o /dev/null --connect-timeout 5 --max-time 10   # uvx 서버
```

- `npm ping` 은 홈 폴더에서 부른다. 지금 폴더에 있는 프로젝트의 `.npmrc` 가 정한 레지스트리와 토큰을 따르지 않게 하려는 것이다.
- `npm ping` 은 15초 감시(`in15`) 안에서 부른다. 패킷을 버리는 망에서 npm 은 연결에 시간 제한을 두지 않아(`--fetch-timeout` 은 받는 중의 쉼만 잰다) OS 의 연결 재시도가 끝날 때까지 기다린다(Rocky 8.10 실측 130초). 15초 안에 끝나지 않으면 `15초 안에 끝나지 않아 멈춤(패킷을 버리는 망일 수 있음)` 과 종료 143 이다. `--no-update-notifier` 는 npm 이 제 판을 묻는 요청을 하나 더 내지 않게 한다.
- `npm ping` 이 실패하면 ping 에 답하지 않는 사내 미러일 수 있다. `(cd ~ && T=$(mktemp -d) && { npm view @modelcontextprotocol/server-sequential-thinking version --fetch-retries=0 --fetch-timeout=10000 --cache "$T" --no-update-notifier; r=$?; rm -rf "$T"; exit $r; })` 도 실패해야 오프라인으로 본다. 이 스킬이 설치할 패키지(`@modelcontextprotocol/server-sequential-thinking`)를 빈 캐시로 물으므로 옛 값이 나올 수 없다. ping 이 15초 감시에 걸려 멈췄으면(종료 143) 이 확인은 하지 않는다. 같은 레지스트리라 같은 시간을 또 기다린다.
- `npm` 이 없으면(명령 없음) 오프라인이 아니라 확인하지 못한 것이다. Node 를 먼저 갖춘다(`setup-node`).
- `npm ping` 은 npm 의 프록시 설정(`proxy`, `https-proxy`)을 따른다. 사내 미러만 열린 망이면 그 미러가 쓰이는지 npm 설정을 본다.
- `curl -sSI` 는 머리만 받는다(본문을 받지 않음). 닿지 못하면 종료 코드가 0 이 아니다(HTTP 상태와 관계없음). `curl` 은 `HTTPS_PROXY` 를 따른다. 확인 줄은 `--ssl-no-revoke` 를 준다. Windows 의 Git Bash curl 도 Schannel 이라, 폐지 목록 서버에 닿지 못하는 망에서 폐지 확인이 실패하면 종료 60 이다(Windows 박스 실측). 다른 curl 은 이 깃발을 받고 무시한다(macOS curl 8.7.1, Rocky 8.10 curl 7.61.1 실측).
- PyPI 는 pip 이 쓰는 색인(`PIP_INDEX_URL`, `pip config list` 의 `install.index-url` 이나 `global.index-url`, 없으면 pypi.org)의 작은 쪽(`<색인>/pip/`)을 본다.
- `pip config get` 은 `PIP_CONFIG_FILE` 로 준 파일을 읽지 않아(pip 25.0 실측) `pip config list` 를 읽는다.
- Rocky 8 의 기본 pip(9.0.3, `pip3`)은 `config` 명령이 없고 `pip` 이름은 없다(Rocky 8.10 실측). 그래서 판 붙은 python(3.13, 3.12, 3.11)의 pip 도 차례로 본다.
- 홈 폴더에서 읽는다. `python3 -m pip` 는 지금 폴더를 import 경로 맨 앞에 두어, 지금 폴더에 있는 남의 저장소의 `pip/` 가 실행될 수 있다.
- bash 블록은 주소를 명령 인자가 아니라 표준 입력의 curl 설정(`-K -`)으로 넘긴다. 명령 인자는 같은 PC 의 다른 사용자가 `ps` 로 볼 수 있어, 경로나 질의에 든 토큰도 거기 싣지 않는다. 사용자 정보(`사용자:토큰@`)는 떼고 묻는다. 닿는지만 보므로 인증은 필요 없다(401 도 닿은 것이다). Windows 에서도 뗀 주소를 쓴다.
- Windows PowerShell 에서는 같은 주소를 `curl.exe --ssl-no-revoke -sSI -o NUL --connect-timeout 5 --max-time 10 <주소>` 로 보고 `$LASTEXITCODE` 가 0 인지 본다(PowerShell 5.1 의 `curl` 은 `Invoke-WebRequest` 별칭이다). `curl.exe` 는 Windows 시스템 프록시를 따르지 않고 `HTTPS_PROXY` 만 따른다. `--ssl-no-revoke` 는 폐지 목록 서버에 닿지 못하는 망에서 Schannel 의 폐지 확인 실패를 오프라인으로 읽지 않게 한다. 닿는지만 보고 받은 내용은 쓰지 않으므로 이 확인에만 준다. `curl.exe` 가 없으면 `$LASTEXITCODE` 에 앞 명령의 값이 남으므로 `Get-Command curl.exe -ErrorAction SilentlyContinue` 로 먼저 보고, 없으면 확인하지 못한 것으로 적는다. `npm ping` 은 `Push-Location ~; npm ping --fetch-retries=0 --fetch-timeout=10000 --no-update-notifier; Pop-Location` 처럼 홈에서 부르고 돌아온다(돌아오지 않으면 뒤 단계가 프로젝트가 아니라 홈에서 돈다). PowerShell 에는 15초 감시를 두지 않는다(Windows 의 연결 시간 제한은 약 21초로 알려져 있다. 미실측).
- 사내 미러만 열린 망이면 확인 주소를 그 미러로 바꿔 본다.
- Codex sandbox 가 네트워크를 막는 모드(기본 `workspace-write`, `read-only`)에서는 `CODEX_SANDBOX_NETWORK_DISABLED=1` 이 서고 확인이 모두 실패한다(curl 종료 7, npm `EPERM`). 블록의 첫 줄이 그렇다고 알린다. 그때는 '오프라인' 이 아니라 'sandbox 가 네트워크를 막음' 으로 보고하고, 승인을 받아 sandbox 밖에서 확인부터 다시 한다. Claude Code sandbox 안(`SANDBOX_RUNTIME=1`)에서는 허용 목록 밖 주소를 sandbox 프록시가 막는다. Windows PowerShell 에서는 `$env:CODEX_SANDBOX_NETWORK_DISABLED -eq '1'` 로 본다.
- 확인이 실패하면 보고에 그 명령, 종료 코드, stderr 첫 줄을 붙인다(예: `npm error code ETIMEDOUT`, `curl: (28) ...`). 원인을 '오프라인' 하나로 짐작하지 않는다.
- curl 의 종료 60(인증서 검증 실패)도 오프라인이 아니다. 망은 열려 있고, TLS 를 가로채는 사내 프록시의 인증서를 OS 가 믿지 않는 것이다. '인증서 문제로 설치하지 않음' 으로 보고한다.
- curl 은 닿는데 npm 만 인증서 오류(`UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `SELF_SIGNED_CERT_IN_CHAIN`, `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`)로 실패하면 망은 열려 있고 npm 이 사내 인증서를 믿지 않는 것이다(npm 은 OS 인증서 저장소를 쓰지 않는다). '인증서 문제로 설치하지 않음' 으로 보고하고 `NODE_EXTRA_CA_CERTS=<사내 CA 파일>` 을 안내한다. Node 24 는 `NODE_OPTIONS=--use-system-ca` 도 된다.

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

### 네트워크가 없는 곳 (오프라인 경로)

`npx -y <패키지>` 는 서버를 띄울 때마다 레지스트리에서 판을 정한다. 네트워크가 없으면 이미 받은 패키지가 있어도 세션마다 약 70초 뒤 실패한다(실측. Codex 는 아래 `startup_timeout_sec = 300` 까지 기다릴 수 있다). `uvx <패키지>` 가 오프라인에서 어떻게 끝나는지는 재지 못했다(미실측). 그래서 오프라인 경로는 두 경우 모두 설치한 실행 파일을 직접 등록한다.
0단계 확인이 실패하면 3절, 4절 대신 이렇게 한다.

- 네트워크가 필요한 서버(context7, fetch, tavily)는 등록하지 않고 "네트워크가 필요한 서버라 등록하지 않음" 으로 보고한다. 서비스 자체가 원격이라 깔아 두어도 쓸 수 없다.
  - 온라인에서 등록해 둔 것이 있으면 세션마다 실패한다. 그대로 둘지 지울지 사용자에게 묻는다. 지우기로 하면 `claude mcp remove <이름> -s user`(Codex 는 `codex mcp remove <이름>`)로 지운다.
- 로컬에서 도는 서버(sequential-thinking, filesystem, git)는 판을 고정해 설치하고, 그 실행 파일을 직접 등록한다. 설치는 네트워크가 되는 곳(또는 사내 npm, PyPI 미러)에서 한 번 한다. 깔린 뒤에는 실행 파일을 바로 부르므로 레지스트리를 묻지 않는다.
- `<판>` 은 패키지마다 따로 정한다(두 npm 패키지의 판은 서로 다르다). npm 패키지는 네트워크가 되는 곳에서 `(cd ~ && npm view <패키지> version)` 으로 본다.
- 이미 같은 이름으로 등록돼 있으면(온라인에서 `npx` 로 등록해 둔 것) `claude mcp add` 가 "already exists" 로 실패한다. 3절처럼 먼저 지우고 등록한다.

```bash
npm i -g @modelcontextprotocol/server-sequential-thinking@<판> @modelcontextprotocol/server-filesystem@<판>
uv tool install mcp-server-git==<판>       # uv 가 없으면 pipx install mcp-server-git==<판>

FS_DIR="${FS_DIR:-$HOME/projects}"
ST=$(command -v mcp-server-sequential-thinking); FB=$(command -v mcp-server-filesystem); GT=$(command -v mcp-server-git)
[ -n "$ST" ] && [ -n "$FB" ] && [ -n "$GT" ] || echo "설치한 실행 파일을 찾지 못함(PATH 확인). 찾은 것만 등록"
[ -n "$ST" ] && { claude mcp remove sequential-thinking -s user 2>/dev/null; claude mcp add sequential-thinking -s user -- "$ST"; }
[ -n "$FB" ] && { claude mcp remove filesystem -s user 2>/dev/null; claude mcp add filesystem -s user -- "$FB" "$FS_DIR"; }
[ -n "$GT" ] && { claude mcp remove git -s user 2>/dev/null; claude mcp add git -s user -- "$GT"; }
```
Codex 는 같은 실행 파일로 등록한다. 다운로드가 없으므로 `startup_timeout_sec` 패치는 필요 없다.
```bash
FS_DIR="${FS_DIR:-$HOME/projects}"
ST=$(command -v mcp-server-sequential-thinking); FB=$(command -v mcp-server-filesystem); GT=$(command -v mcp-server-git)
[ -n "$ST" ] && { codex mcp remove sequential-thinking 2>/dev/null; codex mcp add sequential-thinking -- "$ST"; }
[ -n "$FB" ] && { codex mcp remove filesystem 2>/dev/null;          codex mcp add filesystem -- "$FB" "$FS_DIR"; }
[ -n "$GT" ] && { codex mcp remove git 2>/dev/null;                 codex mcp add git -- "$GT"; }
```
- macOS, Linux 는 설치한 실행 파일을 절대 경로로 등록한다. 서버를 띄우는 런타임의 PATH(GUI 나 IDE 에서 띄우면 nvm 의 PATH 가 없을 수 있다)와 PATH 앞쪽의 같은 이름이 등록에 끼어들지 못한다. 그 Node 판을 nvm 으로 지우면 경로가 끊기므로 다시 등록한다.
- Windows 는 이름으로 등록하고 `cmd /c` 를 앞에 둔다(npm 전역 설치는 `.cmd` 를 만든다). 예: `claude mcp add sequential-thinking -s user -- cmd /c mcp-server-sequential-thinking`. Git Bash 의 `command -v` 는 Windows 런타임이 실행하지 못하는 `/c/Users/...` 꼴의 셸 스크립트 경로를 낸다.

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
(cd ~ && "$PY" -c "import tomllib") 2>/dev/null || echo "⚠ tomllib 없음 - Python 3.11+ 설치 후 재시도(setup-python 참고)"   # 홈에서: -c, -m, 표준 입력 스크립트는 지금 폴더의 모듈을 먼저 불러온다
```
```bash
(cd ~ && "$PY" <<'EOF'   # 홈에서: 표준 입력 스크립트는 지금 폴더의 모듈을 먼저 불러온다
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
)
```

## 검증 (보고 의무)
```bash
claude mcp list                                # 각 서버가 ✔ Connected 인지 확인
codex mcp list --json | (cd ~ && python3 -m json.tool)   # 각 서버 등록 확인(json.tool 은 아무 python3 로 충분)
PY="$(command -v python3.12 || command -v python3.11 || command -v python3)"   # tomllib=3.11+
(cd ~ && "$PY" -c "import tomllib; tomllib.loads(open('$HOME/.codex/config.toml', encoding='utf-8').read()); print('✓ TOML 유효')")
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
