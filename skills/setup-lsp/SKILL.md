---
name: setup-lsp
description: "언어별 LSP 서버(vtsls, basedpyright, bash, jdtls, spring)와 lsp-mcp 브리지를 설치하고 연동. 'setup-lsp'/'LSP 설치'/'언어 서버' 또는 `/banker:setup` 시 사용."
---

# setup-lsp: 언어별 LSP 서버 + lsp-mcp 브리지

symbol/type/reference 기반 코드 탐색(grep 대체)을 위해 언어별 language server(TypeScript·Python·Bash·Java·Spring)와
이를 MCP 로 노출하는 `lsp-mcp` 브리지를 설치·연동한다. 설치는 **멱등**(이미 있으면 skip·검증만). 답변은 한글(기술 토큰·경로·명령은 영문).

## 런타임 배선

이 스킬은 두 가지를 설치한다 - (A) 표준 language server 바이너리, (B) `codex-lsp-bridge`(lsp-mcp). **소비 방식이 런타임마다 다르다**:

- **Claude Code (OMC)** - 네이티브 `lsp_*` MCP 도구(`lsp_servers`·`lsp_goto_definition`·`lsp_find_references`·`lsp_hover`·`lsp_document_symbols` 등) 또는 `typescript-lsp@claude-plugins-official` 플러그인이 **PATH 의 서버 바이너리를 직접 구동**한다. **브리지 불필요** → §6·§7-Codex 는 건너뛰고 §2~§5 설치 후 §7-Claude 만 수행.
- **Codex (OMX)** - `codex-lsp-bridge` 를 `~/.codex/config.toml` 의 `[mcp_servers.lsp_bridge]` 에 등록해 `lsp_bridge` tool 로 노출. §2~§7 전부 수행.

먼저 §0 에서 **어느 런타임인지 감지**하고 해당 경로만 실행한다(둘 다 있으면 둘 다).

## 0. 감지 (먼저, 추정 금지)
```bash
[ -f /etc/os-release ] && . /etc/os-release && echo "distro=$ID ${VERSION_ID}"; uname -m
# 런타임
command -v claude >/dev/null && echo "runtime: claude(OMC)" || echo "claude 없음"
command -v codex  >/dev/null && echo "runtime: codex(OMX)"  || echo "codex 없음"
# 선행 런타임 (§1 preflight 대상)
command -v npm  >/dev/null && echo "npm=$(npm -v)"           || echo "npm 없음 → setup-node"
command -v pipx >/dev/null && echo "pipx=$(pipx --version)"  || echo "pipx 없음 → setup-python"
command -v java >/dev/null && java -version 2>&1 | head -1   || echo "java 없음 → setup-java"
# 이미 설치된 서버
for c in vtsls basedpyright-langserver ruff bash-language-server jdtls codex-lsp-bridge; do
  command -v $c >/dev/null && echo "✓ $c" || echo "✗ $c"
done
# 프로젝트 언어 (--lang 미지정 시 이 결과로 선택)
ls tsconfig.json package.json >/dev/null 2>&1 && echo "lang: ts"
{ ls pyproject.toml setup.py >/dev/null 2>&1 || ls ./*.py >/dev/null 2>&1; } && echo "lang: py"
ls ./*.sh >/dev/null 2>&1 && echo "lang: bash"
ls pom.xml build.gradle build.gradle.kts >/dev/null 2>&1 && echo "lang: java"
ls src/main/resources/application.* >/dev/null 2>&1 && echo "lang: spring"
```
> Windows(PowerShell): `Get-Command claude,codex,npm,pipx,java`, `Test-Path tsconfig.json,pom.xml` 등으로 동일 감지. jdtls 는 `jdtls.bat`.

### 네트워크 확인 (내려받기 전)

이 스킬이 내려받는 원천에 닿는지 먼저 본다(curl 은 10초, npm 은 15초 안). 닿지 않으면 그 원천에서 받는 단계는 하지 않고, 이미 설치된 것의 확인만 한 뒤 "오프라인이라 설치하지 않음(필요한 것: <못 깐 것>)" 으로 보고한다.

```bash
[ "${CODEX_SANDBOX_NETWORK_DISABLED:-}" = 1 ] && echo "Codex sandbox 가 네트워크를 막음(아래 실패는 오프라인이 아님)"
in15() { "$@" & p=$!; ( sleep 15 && kill "$p" ) > /dev/null 2>&1 & k=$!; wait "$p" 2>/dev/null; r=$?; kill "$k" 2>/dev/null; wait "$k" 2>/dev/null; [ "$r" = 143 ] && echo "15초 안에 끝나지 않아 멈춤(패킷을 버리는 망일 수 있음)"; return "$r"; }
in15 sh -c 'cd ~ && exec npm ping --fetch-retries=0 --fetch-timeout=10000 --no-update-notifier'                              # ts, bash 서버(npm)
# pip 이 읽는 설정 전부(PIP_CONFIG_FILE 포함)를 홈 폴더에서 읽는다. install 절이 global 절보다 앞선다
L=$( (cd ~ && { pip config list || pip3 config list || python3.13 -m pip config list || python3.12 -m pip config list || python3.11 -m pip config list || python3 -m pip config list; }) 2>/dev/null) || echo "pip 설정을 읽지 못함(pip 이 없거나 10 미만). 사내 미러를 쓰면 확인 주소를 그 미러로 바꿔 본다"
I="${PIP_INDEX_URL:-$(printf '%s\n' "$L" | sed -n "s/^install\.index-url='\(.*\)'$/\1/p")}"
I="${I:-$(printf '%s\n' "$L" | sed -n "s/^global\.index-url='\(.*\)'$/\1/p")}"
I=$(printf %s "${I:-https://pypi.org/simple}" | sed -E 's#^([A-Za-z][A-Za-z0-9+.-]*://)[^/]*@#\1#; s#/$##')   # 주소의 사용자 정보는 뗌
printf 'url = "%s"\n' "$I/pip/" | curl --ssl-no-revoke -K - -sSI -o /dev/null --connect-timeout 5 --max-time 10   # py 서버(pipx)
curl --ssl-no-revoke -sSI -o /dev/null --connect-timeout 5 --max-time 10 https://download.eclipse.org   # jdtls
curl --ssl-no-revoke -sSI -o /dev/null --connect-timeout 5 --max-time 10 https://github.com             # lsp-mcp
curl --ssl-no-revoke -sSI -o /dev/null --connect-timeout 5 --max-time 10 https://vmware.gallery.vsassets.io   # Spring Boot LS(VSIX)
curl --ssl-no-revoke -sSI -o /dev/null --connect-timeout 5 --max-time 10 https://marketplace.visualstudio.com # Spring Boot LS(VSIX 대체 원천. 둘 중 하나만 닿아도 받을 수 있다)
```

- `npm ping` 은 홈 폴더에서 부른다. 지금 폴더에 있는 프로젝트의 `.npmrc` 가 정한 레지스트리와 토큰을 따르지 않게 하려는 것이다.
- `npm ping` 은 15초 감시(`in15`) 안에서 부른다. 패킷을 버리는 망에서 npm 은 연결에 시간 제한을 두지 않아(`--fetch-timeout` 은 받는 중의 쉼만 잰다) OS 의 연결 재시도가 끝날 때까지 기다린다(Rocky 8.10 실측 130초). 15초 안에 끝나지 않으면 `15초 안에 끝나지 않아 멈춤(패킷을 버리는 망일 수 있음)` 과 종료 143 이다. `--no-update-notifier` 는 npm 이 제 판을 묻는 요청을 하나 더 내지 않게 한다.
- `npm ping` 이 실패하면 ping 에 답하지 않는 사내 미러일 수 있다. `(cd ~ && T=$(mktemp -d) && { npm view bash-language-server version --fetch-retries=0 --fetch-timeout=10000 --cache "$T" --no-update-notifier; r=$?; rm -rf "$T"; exit $r; })` 도 실패해야 오프라인으로 본다. 이 스킬이 설치할 패키지(`bash-language-server`)를 빈 캐시로 물으므로 옛 값이 나올 수 없다. ping 이 15초 감시에 걸려 멈췄으면(종료 143) 이 확인은 하지 않는다. 같은 레지스트리라 같은 시간을 또 기다린다.
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

## 1. 사전요구(preflight)

각 서버는 선행 런타임이 필요하다 - **없으면 먼저 해당 setup 스킬을 실행**(추정·강행 금지):

| 대상 | 필요 런타임 | 없을 때 |
|---|---|---|
| vtsls·vscode-langservers-extracted·bash-language-server | **Node/npm** | `setup-node` 먼저 |
| basedpyright·ruff (+ lsp-mcp 브리지도 pipx) | **Python/pipx** (3.8+) | `setup-python` 먼저 |
| jdtls·Spring Boot LS | **JDK 21** (jdtls 는 21 필수) | `setup-java` 먼저 |

```bash
command -v npm  >/dev/null || echo "npm 필요 → setup-node 실행 후 재시도"
command -v pipx >/dev/null || echo "pipx 필요 → setup-python 실행 후 재시도"
# jdtls 는 Java 21+ 필수 - 미만이면 조용히 실패
java -version 2>&1 | grep -qE '"(2[1-9]|[3-9][0-9])' || echo "Java 21+ 아님 → setup-java 먼저(java/spring 스킵 가능)"
```

## 2. 언어 선택

`--lang ts,py,bash,java,spring` 로 명시. 없으면 §0 감지(프로젝트 언어), 그것도 없으면 **전체**.
매핑: `ts`→§3(npm), `bash`→§3(npm), `py`→§4(pipx), `java`→§5(jdtls), `spring`→§5(jdtls+Spring LS).

## 3. npm 서버 (ts·bash - Node 필요)
```bash
npm install -g \
  @vtsls/language-server \
  vscode-langservers-extracted \
  bash-language-server
for c in vtsls bash-language-server; do command -v $c >/dev/null && echo "✓ $c" || echo "✗ $c"; done
```
- `@vtsls/language-server`→`vtsls`(TS/JS), `vscode-langservers-extracted`→JSON/CSS/HTML/ESLint 서버, `bash-language-server`→shell.
- 전역 설치 권한 필요 - **`sudo npm -g` 금지**(nvm/prefix 는 `setup-node` 참조).

## 4. pipx 서버 (py - Python 필요)
```bash
pipx install basedpyright     # → basedpyright-langserver (타입체커 LSP)
pipx install ruff             # → ruff (formatter/linter + `ruff server` LSP)
for c in basedpyright-langserver ruff; do command -v $c >/dev/null && echo "✓ $c" || echo "✗ $c"; done
```
- pipx 격리 설치 → shebang 고정이라 시스템 Python 변경에 영향 없음.

## 5. jdtls + Spring Boot LS (java·spring - JDK 21 필요)

**jdtls (Java LSP)** - Eclipse 최신 스냅샷:
```bash
mkdir -p ~/.local/jdtls
T=$(mktemp -d) \
  && curl -fL --connect-timeout 10 --speed-limit 1000 --speed-time 30 -o "$T/jdtls.tar.gz" \
       "https://download.eclipse.org/jdtls/snapshots/jdt-language-server-latest.tar.gz" \
  && tar -xzf "$T/jdtls.tar.gz" -C ~/.local/jdtls
rm -rf "$T"
chmod +x ~/.local/jdtls/bin/jdtls
which jdtls        # PATH 에 ~/.local/jdtls/bin 필요
```
> jdtls 는 **Java 21 미만이면 무증상으로 죽는다** → §1 preflight 필수. Windows 는 `~/.local/jdtls\bin` 을 PATH 에 넣고 `jdtls.bat` 로 호출.

**Spring Boot Language Server** - VSIX(=ZIP) 다운로드. vsassets.io/marketplace 가 **HTML 에러페이지**를 반환할 수 있어 **ZIP 매직바이트(`504b0304`) 검증** 후 `find` 로 `*-exec.jar` 탐색 + 심볼릭 링크:
```bash
(
set -euo pipefail
TARGET="$HOME/.local/spring-boot-ls"; T=$(mktemp -d); trap 'rm -rf "$T"' EXIT; VSIX="$T/sbls.vsix"; LINK=spring-boot-language-server.jar
mkdir -p "$TARGET"
VSIX_URL="https://vmware.gallery.vsassets.io/_apis/public/gallery/publisher/vmware/extension/vscode-spring-boot/latest/assetbyname/Microsoft.VisualStudio.Services.VSIXPackage"
FALLBACK="https://marketplace.visualstudio.com/_apis/public/gallery/publishers/vmware/vsextensions/vscode-spring-boot/latest/vspackage"
curl -fL --connect-timeout 30 --speed-limit 1000 --speed-time 30 --retry 2 -H "User-Agent: Mozilla/5.0" -o "$VSIX" "$VSIX_URL" 2>/dev/null \
  || curl -fL --connect-timeout 30 --speed-limit 1000 --speed-time 30 --retry 2 -H "User-Agent: Mozilla/5.0" -o "$VSIX" "$FALLBACK"
# ZIP 매직 검증 (HTML 에러페이지면 즉시 중단)
[ "$(xxd -l 4 "$VSIX" | awk 'NR==1{print $2$3}')" = "504b0304" ] \
  || { echo "✗ ZIP 아님(HTML 에러페이지?)"; rm -f "$VSIX"; exit 1; }
find "${TARGET:?}" -mindepth 1 -delete; unzip -o -q "$VSIX" -d "$TARGET"   # 글롭 없이 비움(zsh 는 빈 폴더의 * 에서 멈춤)
JAR=$(find "$TARGET" -name "spring-boot-language-server-*-exec.jar" | sort -V | tail -1)
[ -n "$JAR" ] || { echo "✗ exec.jar 미발견"; rm -f "$VSIX"; exit 1; }
ln -sf "$(basename "$JAR")" "$(dirname "$JAR")/$LINK"     # 디렉토리 이동에도 유효한 상대 링크
rm -f "$VSIX"; find ~/.local/spring-boot-ls -name "$LINK" -ls
)
```
블록 전체가 괄호 안의 서브셸에서 돈다. `set -e`, EXIT trap, `exit 1` 이 이 블록 안에만 머물러, 같은 셸의 다음 명령을 끝내거나 그 셸이 끝날 때 다른 `T` 를 지우지 않는다.
> Windows: 심볼릭 링크는 **개발자 모드/관리자 권한** 필요 → 없으면 `Copy-Item` 복사 fallback(둘 다 동작). 매직검증·find 는 PowerShell 로 동일 수행, JAR 경로는 `.Replace('\','/')`. RHEL8 에 `xxd` 없으면 `dnf install -y vim-common` 또는 `od -An -tx1 -N4`.

## 6. lsp-mcp 브리지 설치 (Codex 경로 - Claude Code 는 건너뜀)
```bash
mkdir -p ~/.local/src
git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=30 clone https://github.com/CesarPetrescu/lsp-mcp.git ~/.local/src/lsp-mcp
pipx install --editable ~/.local/src/lsp-mcp     # → ~/.local/bin/codex-lsp-bridge (Windows: .exe)
which codex-lsp-bridge && codex-lsp-bridge --help | head -5
```

**브리지에 Java/Spring 서버 등록** - `config/default.toml` 에 `[servers.java]`/`[servers.spring-boot-properties]` append. **idempotent guard 필수**: 두 번 실행하면 중복 선언 → TOML 파싱 실패 → `codex-lsp-bridge` 즉사 → `MCP client for 'lsp_bridge' failed to start`. 기본 default.toml 에 이미 있는 서버(ts/py/bash 등)는 그대로 두고 java/spring 만 추가:
```bash
cd ~/.local/src/lsp-mcp
cp -n config/default.toml config/default.toml.bak    # 최초 1회만 백업
# guard: 이미 있으면 skip. unquoted heredoc - $HOME 를 셸이 절대경로로 확장
grep -q '\[servers.java\]' config/default.toml || cat >> config/default.toml << EOF

[servers.java]
command = "jdtls"
args = []
file_extensions = ["java"]
language_id = "java"

[servers.spring-boot-properties]
command = "java"
args = ["-jar", "$HOME/.local/spring-boot-ls/extension/jars/spring-boot-language-server.jar"]
file_extensions = ["properties", "yml", "yaml"]
language_id = "spring-boot-properties"
EOF
# TOML 유효성 (중복/문법오류 즉시 감지). tomllib 는 Python 3.11+ - RHEL8/Rocky8 기본 python3(3.6)면 setup-python 의 3.11 을 쓴다:
PY="$(command -v python3.12 || command -v python3.11 || command -v python3)"
(cd ~ && "$PY" -c "import tomllib; tomllib.loads(open('$HOME/.local/src/lsp-mcp/config/default.toml',encoding='utf-8').read()); print('OK lsp-mcp TOML')") 2>/dev/null \
  || echo "⚠ tomllib(3.11+) 미가용 - append 는 위 grep guard 로 이미 적용됨, setup-python 설치 후 재검증"
cd - >/dev/null
```
> Spring JAR 경로는 §5 `find` 실제 결과와 일치해야 함(환경마다 디렉토리 상이). 깨졌으면 `cp config/default.toml.bak config/default.toml` 복구.
> Windows: `Get-Content -Raw` 로 읽어 `-match '\[servers\.java\]'` guard 후 `[System.IO.File]::WriteAllText(path, text, [System.Text.UTF8Encoding]::new($false))` 로만 append(CP949/BOM 회피).

## 7. 배선 (Codex config.toml · Claude 네이티브)

### 7-Codex - `[mcp_servers.lsp_bridge]` 등록
OMX 가 배포한 기존 엔트리를 보존하려 **Python replace-or-append** 로 patch(전체 덮어쓰기 금지):
```bash
(cd ~ && python3 - << 'PY'   # 홈에서: -c, -m, 표준 입력 스크립트는 지금 폴더의 모듈을 먼저 불러온다
import re
from pathlib import Path
home = str(Path.home())                        # Windows: str(Path.home()).replace("\\","/")
p = Path.home() / ".codex" / "config.toml"
txt = p.read_text(encoding="utf-8") if p.exists() else ""
def rep(body, header, block):
    pat = rf'\[{re.escape(header)}\].*?(?=\n\[|\Z)'
    if re.search(pat, body, flags=re.DOTALL):
        return re.sub(pat, block.strip() + '\n', body, flags=re.DOTALL, count=1)
    return body.rstrip() + '\n\n' + block.strip() + '\n'
binname = "codex-lsp-bridge"                   # Windows: codex-lsp-bridge.exe
block = "\n".join([
    "[mcp_servers.lsp_bridge]",
    f'command = "{home}/.local/bin/{binname}"',
    f'args = ["serve", "--transport", "stdio", "--config", "{home}/.local/src/lsp-mcp/config/default.toml"]',
    "startup_timeout_sec = 300",               # 첫 기동/다운로드 대비
])
txt = rep(txt, "mcp_servers.lsp_bridge", block + "\n")
p.write_text(txt, encoding="utf-8")            # Windows: encoding 필수(CP949 회피)
print("patched")
PY
)
PY="$(command -v python3.12 || command -v python3.11 || command -v python3)"   # tomllib=3.11+
(cd ~ && "$PY" -c "import tomllib; tomllib.loads(open('$HOME/.codex/config.toml',encoding='utf-8').read()); print('OK config.toml valid')") 2>/dev/null \
  || echo "⚠ tomllib(3.11+) 미가용 - patch 는 적용됨, setup-python 후 재검증"
```

### 7-Claude - 네이티브 lsp_* / 플러그인
브리지·config.toml patch **불필요**. PATH 의 서버 바이너리가 OMC `lsp_*` 도구를 뒷받침한다:
- 설치 후 `/reload-plugins`(또는 Claude 재시작) → `lsp_servers` 로 인식된 서버 확인.
- TypeScript 전용은 `typescript-lsp@claude-plugins-official` 플러그인도 가능(`/plugin install typescript-lsp@claude-plugins-official`).
- 서버가 `lsp_servers` 에 안 뜨면 PATH(§0)·재시작 확인.

**OS 경로 차이 (요약)**

| 요소 | Linux(rocky/rhel/ubuntu/debian) | Windows | macOS |
|---|---|---|---|
| bridge 바이너리 | `$HOME/.local/bin/codex-lsp-bridge` | `...\codex-lsp-bridge.exe` | Linux 동일 |
| jdtls 실행 | `jdtls` | `jdtls.bat` | `jdtls` |
| config patch home | `str(Path.home())` | `.replace("\\","/")` | `str(Path.home())` |
| TOML read/write | 기본 | `encoding='utf-8'` 필수(CP949) | 기본 |
| Spring JAR 링크 | `ln -sf` | SymbolicLink→권한없으면 `Copy-Item` | `ln -sf` |

## 검증 (보고 의무)

**존재 ≠ 동작** - 각 서버가 실제 응답하는지까지 확인:
```bash
basedpyright --version                               # CLI 로 버전 확인(langserver 는 stdio 서버라 --version 없음)
command -v basedpyright-langserver >/dev/null && echo "✓ basedpyright-langserver"
vtsls --version
bash-language-server --version
ruff --version
jdtls --version 2>/dev/null || which jdtls           # Windows: jdtls.bat
# Codex 만:
codex-lsp-bridge --help | head -3
grep -q 'lsp_bridge' ~/.codex/config.toml && echo "✓ config.toml lsp_bridge" || echo "✗ 미등록"
PY="$(command -v python3.12 || command -v python3.11 || command -v python3)"   # tomllib=3.11+
(cd ~ && "$PY" -c "import tomllib; tomllib.loads(open('$HOME/.codex/config.toml',encoding='utf-8').read()); print('✓ config.toml valid')") 2>/dev/null || echo "⚠ tomllib(3.11+) 미가용 - setup-python 후 재검증"
# Claude 만: lsp_servers 도구로 인식 서버 나열
```
4-field 보고: **변경**(설치 서버·브리지·config 배선) / **Evidence**(위 --version·valid 출력) / **검증**(각 서버 응답 + 브리지·config TOML valid + 런타임 인식) / **Unknown**(네트워크 차단으로 미설치·JDK 21 부재로 java/spring 스킵 등).

## 함정

- **Spring VSIX = HTML 에러페이지** - vsassets.io/marketplace 가 ZIP 대신 에러페이지를 반환 → **매직바이트 `504b0304` 검증 필수**(안 하면 깨진 JAR 로 진행). fallback URL 자동 전환.
- **`[servers.java]` 중복 → 브리지 즉사** - §6 append 를 guard 없이 두 번 → TOML 파싱 실패 → `MCP client for 'lsp_bridge' failed to start`. **grep/`-match` guard 필수**, 깨졌으면 `.bak` 복구.
- **jdtls Java 21 미만 → 무증상 실패** - preflight(§1)로 `java -version` 21+ 확인. 아니면 `setup-java` 먼저.
- **Windows CP949/BOM** - 모든 Python `open(...,encoding='utf-8')`, PowerShell append 는 `WriteAllText`+`UTF8Encoding($false)` 만(`Add-Content`/`Out-File -Encoding UTF8` 금지). config patch home 은 forward-slash(`.replace("\\","/")`).
- **Windows 심볼릭 링크 권한** - 개발자 모드/관리자 아니면 `Copy-Item` 복사 fallback. `.exe`(bridge)·`.bat`(jdtls) 확장자 주의.
- **첫 실행 timeout** - 브리지/npx 최초 기동은 느림 → `startup_timeout_sec = 300`. 첫 회만 느리면 정상(캐싱 후 빠름).
- **PATH 미반영** - `~/.local/bin`·`~/.local/jdtls/bin` 이 PATH 에 없으면 서버 미인식 → 새 셸/`source ~/.bashrc` 또는 절대경로(Claude 는 `lsp_servers` 로 재확인).
- **config 전체 덮어쓰기 금지** - Codex `config.toml` 은 반드시 replace-or-append(§7-Codex)로 patch - OMX 가 배포한 다른 MCP/agents 엔트리를 보존.

ARGUMENTS: [--lang ts,py,bash,java,spring] (없으면 프로젝트 언어 감지 또는 전체)
