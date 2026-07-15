---
name: setup-lsp
description: "(banker) 언어별 LSP 서버(vtsls·basedpyright·bash·jdtls·spring)와 lsp-mcp 브리지 설치·연동. 'setup-lsp'/'LSP 설치'/'언어 서버' 또는 /banker:setup 시 사용."
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
curl -fLo /tmp/jdtls.tar.gz \
  "https://download.eclipse.org/jdtls/snapshots/jdt-language-server-latest.tar.gz"
tar -xzf /tmp/jdtls.tar.gz -C ~/.local/jdtls
rm /tmp/jdtls.tar.gz
chmod +x ~/.local/jdtls/bin/jdtls
which jdtls        # PATH 에 ~/.local/jdtls/bin 필요
```
> jdtls 는 **Java 21 미만이면 무증상으로 죽는다** → §1 preflight 필수. Windows 는 `~/.local/jdtls\bin` 을 PATH 에 넣고 `jdtls.bat` 로 호출.

**Spring Boot Language Server** - VSIX(=ZIP) 다운로드. vsassets.io/marketplace 가 **HTML 에러페이지**를 반환할 수 있어 **ZIP 매직바이트(`504b0304`) 검증** 후 `find` 로 `*-exec.jar` 탐색 + 심볼릭 링크:
```bash
set -euo pipefail
TARGET="$HOME/.local/spring-boot-ls"; VSIX=/tmp/sbls.vsix; LINK=spring-boot-language-server.jar
mkdir -p "$TARGET"
VSIX_URL="https://vmware.gallery.vsassets.io/_apis/public/gallery/publisher/vmware/extension/vscode-spring-boot/latest/assetbyname/Microsoft.VisualStudio.Services.VSIXPackage"
FALLBACK="https://marketplace.visualstudio.com/_apis/public/gallery/publishers/vmware/vsextensions/vscode-spring-boot/latest/vspackage"
curl -fL --connect-timeout 30 --retry 2 -H "User-Agent: Mozilla/5.0" -o "$VSIX" "$VSIX_URL" 2>/dev/null \
  || curl -fL --connect-timeout 30 --retry 2 -H "User-Agent: Mozilla/5.0" -o "$VSIX" "$FALLBACK"
# ZIP 매직 검증 (HTML 에러페이지면 즉시 중단)
[ "$(xxd -l 4 "$VSIX" | awk 'NR==1{print $2$3}')" = "504b0304" ] \
  || { echo "✗ ZIP 아님(HTML 에러페이지?)"; rm -f "$VSIX"; exit 1; }
rm -rf "${TARGET:?}"/*; unzip -o -q "$VSIX" -d "$TARGET"
JAR=$(find "$TARGET" -name "spring-boot-language-server-*-exec.jar" | sort -V | tail -1)
[ -n "$JAR" ] || { echo "✗ exec.jar 미발견"; rm -f "$VSIX"; exit 1; }
ln -sf "$(basename "$JAR")" "$(dirname "$JAR")/$LINK"     # 디렉토리 이동에도 유효한 상대 링크
rm -f "$VSIX"; find ~/.local/spring-boot-ls -name "$LINK" -ls
```
> Windows: 심볼릭 링크는 **개발자 모드/관리자 권한** 필요 → 없으면 `Copy-Item` 복사 fallback(둘 다 동작). 매직검증·find 는 PowerShell 로 동일 수행, JAR 경로는 `.Replace('\','/')`. RHEL8 에 `xxd` 없으면 `dnf install -y vim-common` 또는 `od -An -tx1 -N4`.

## 6. lsp-mcp 브리지 설치 (Codex 경로 - Claude Code 는 건너뜀)
```bash
mkdir -p ~/.local/src
git clone https://github.com/CesarPetrescu/lsp-mcp.git ~/.local/src/lsp-mcp
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
"$PY" -c "import tomllib; tomllib.loads(open('config/default.toml',encoding='utf-8').read()); print('OK lsp-mcp TOML')" 2>/dev/null \
  || echo "⚠ tomllib(3.11+) 미가용 - append 는 위 grep guard 로 이미 적용됨, setup-python 설치 후 재검증"
cd - >/dev/null
```
> Spring JAR 경로는 §5 `find` 실제 결과와 일치해야 함(환경마다 디렉토리 상이). 깨졌으면 `cp config/default.toml.bak config/default.toml` 복구.
> Windows: `Get-Content -Raw` 로 읽어 `-match '\[servers\.java\]'` guard 후 `[System.IO.File]::WriteAllText(path, text, [System.Text.UTF8Encoding]::new($false))` 로만 append(CP949/BOM 회피).

## 7. 배선 (Codex config.toml · Claude 네이티브)

### 7-Codex - `[mcp_servers.lsp_bridge]` 등록
OMX 가 배포한 기존 엔트리를 보존하려 **Python replace-or-append** 로 patch(전체 덮어쓰기 금지):
```bash
python3 - << 'PY'
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
PY="$(command -v python3.12 || command -v python3.11 || command -v python3)"   # tomllib=3.11+
"$PY" -c "import tomllib; tomllib.loads(open('$HOME/.codex/config.toml',encoding='utf-8').read()); print('OK config.toml valid')" 2>/dev/null \
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
basedpyright-langserver --version
vtsls --version 2>/dev/null || vtsls --help | head -1
bash-language-server --version
ruff --version
jdtls --version 2>/dev/null || which jdtls           # Windows: jdtls.bat
# Codex 만:
codex-lsp-bridge --help | head -3
grep -q 'lsp_bridge' ~/.codex/config.toml && echo "✓ config.toml lsp_bridge" || echo "✗ 미등록"
PY="$(command -v python3.12 || command -v python3.11 || command -v python3)"   # tomllib=3.11+
"$PY" -c "import tomllib; tomllib.loads(open('$HOME/.codex/config.toml',encoding='utf-8').read()); print('✓ config.toml valid')" 2>/dev/null || echo "⚠ tomllib(3.11+) 미가용 - setup-python 후 재검증"
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
