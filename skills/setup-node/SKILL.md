---
name: setup-node
description: "(banker) nvm + Node 22(LTS) 런타임 설치(Windows는 winget 또는 nvm-windows). Claude Code npm 설치·Codex/OMX·npx 기반 MCP 서버 전제. 'setup-node'/'Node 설치'/'nvm 설치' 또는 /banker:setup 시 사용."
---

# setup-node: nvm + Node 22(LTS) 런타임 설치

Claude Code·Codex/OMX 및 다수 npx 기반 MCP 서버가 딛고 서는 Node.js 런타임을 설치한다.
버전 고정 대신 **현재 LTS**를 설치하는 것이 원칙(2026-07 기준 최소 22 이상). 멱등(이미 있으면 확인만). 답변은 한글.

## 런타임 배선
- **Claude Code**: 네이티브 인스톨러 자체는 Node가 불필요하지만, npm 설치 경로(v2.1.198+)는 Node 22+를 요구한다. `context7`·`sequential-thinking`·`playwright` 등 다수 MCP 서버가 `npx -y ...`로 구동되어 Node에 의존한다.
- **Codex/OMX**: `npm install -g @openai/codex oh-my-codex` 자체가 npm(Node)을 전제. LSP 스택(`@vtsls/language-server`·`vscode-langservers-extracted`·`bash-language-server`)도 npm 전역 설치로 배포된다.
- 즉 이 스킬은 두 런타임 공통 하위 의존성이며, 다른 setup-* 스킬보다 먼저 실행되는 편이 안전하다.

## 0. 감지 (먼저, 추정 금지)
```bash
[ -f /etc/os-release ] && . /etc/os-release && echo "distro=$ID ${VERSION_ID}"
uname -s                                                     # Linux / Darwin
[ -s "$HOME/.nvm/nvm.sh" ] && echo "nvm=설치됨" || echo "nvm=미설치"
command -v node >/dev/null && echo "node=$(node -v)" || echo "node=미설치"
command -v npm  >/dev/null && echo "npm=$(npm -v)"
```
```powershell
$PSVersionTable.PSVersion
winget --version
if (Get-Command node -ErrorAction SilentlyContinue) { node -v } else { "node: 미설치" }
if (Get-Command nvm  -ErrorAction SilentlyContinue) { nvm version } else { "nvm-windows: 미설치" }
```

## 1. Rocky Linux 8
```bash
command -v curl >/dev/null && command -v git >/dev/null || sudo dnf install -y curl git
```
이후 아래 "nvm 공통 설치"를 그대로 실행.
> ⚠️ Rocky8/RHEL8 glibc는 정확히 2.28. Node 최신 메이저의 prebuilt 바이너리 glibc 최저요구치가 이보다 올라가면(예: 2.31+) 설치 실패 가능 → `ldd --version`으로 사전 확인, 실패 시 nvm이 소스빌드로 폴백하거나 에러를 낸다(정직 보고).

## 2. Ubuntu 20.04~24.04
```bash
command -v curl >/dev/null && command -v git >/dev/null || sudo apt install -y curl git
```
이후 "nvm 공통 설치" 그대로. 최소 서버 이미지가 아니면 대개 이미 충족.

## 3. Debian 12
```bash
command -v curl >/dev/null && command -v git >/dev/null || sudo apt install -y curl git
```
이후 "nvm 공통 설치" 그대로.

## nvm 공통 설치 (Rocky8·Ubuntu·Debian·macOS)
```bash
# 최신 nvm 릴리스 태그 자동확인(하드코딩 회피). 실패 시 수동 확인 안내
NVM_LATEST=$(curl -fsSL https://api.github.com/repos/nvm-sh/nvm/releases/latest \
  | grep -m1 '"tag_name":' | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')
if [ -z "$NVM_LATEST" ]; then
  echo "⚠️ 최신 태그 자동확인 실패. https://github.com/nvm-sh/nvm/releases 에서 수동 확인 후 <TAG> 치환"
  NVM_LATEST="<TAG>"
fi
curl -o- "https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_LATEST}/install.sh" | bash

# 설치 스크립트가 rc 파일을 자동 갱신하나, 컨테이너 등 미반영 환경 대비 idempotent 마커도 병행
RC_FILE="$HOME/.bashrc"    # macOS는 $HOME/.zshrc
grep -q '### BANKER_NODE_BEGIN ###' "$RC_FILE" || cat >> "$RC_FILE" <<'EOF'

### BANKER_NODE_BEGIN ###
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"
### BANKER_NODE_END ###
EOF
source "$RC_FILE"

nvm install --lts          # 2026-07 기준 22 이상의 현재 LTS 자동 설치
nvm alias default 'lts/*'
node -v && npm -v
```

## 4. macOS (Apple Silicon / Intel)
curl은 기본 내장. Apple Silicon/Intel 차이는 Homebrew prefix 정도로 nvm 자체엔 영향 없음. 위 "nvm 공통 설치"를 zsh(`~/.zshrc`)에 그대로 적용.
- Homebrew의 `nvm` formula도 존재하나 `NVM_DIR` 캐비어트가 있어 **공식 curl 스크립트를 우선** 권장(공식 문서 기준).

## 5. Windows 10/11
멀티버전 전환이 불필요하면 winget 단일 설치가 가장 단순:
```powershell
winget install --id OpenJS.NodeJS.LTS -e
node -v; npm -v
```
여러 Node 버전을 넘나들어야 하면 nvm-windows(별개 프로젝트, POSIX nvm과 무관):
```powershell
winget install --id CoreyButler.NVMforWindows -e
# 새 터미널에서
nvm install lts
nvm use <설치된 버전>
```
> ⚠️ **winget Node와 nvm-windows를 동시에 설치하지 않는다.** 두 경로가 PATH에 동시 등록되면 `node.exe`가 어느 쪽을 가리키는지 꼬인다. 하나만 선택.

## 검증 (보고 의무)
```bash
node -v      # v22.x.x 이상 기대(현재 LTS)
npm -v
corepack enable 2>/dev/null && corepack --version   # pnpm/yarn 필요 시만(선택, Node 버전에 따라 기본 포함 여부 상이)
```
4-field 보고: 변경(nvm 설치 경로·rc 마커·설치된 Node 버전) / Evidence(위 출력) / 검증(`node -v` ≥22 확인) / Unknown(관리자 권한 부재로 시스템 전역 설치 불가 등).

## 함정
- **새 셸에만 반영**: nvm은 현재 셸에 `source ~/.bashrc`(또는 `~/.zshrc`) 하지 않으면 안 보임.
- **Windows PATH 충돌**: winget Node와 nvm-windows 동시 설치 금지(위 참조).
- **corepack**: pnpm/yarn 격리 관리용. Node 메이저에 따라 기본 포함 여부가 바뀔 수 있어 `corepack --version` 미동작 시 `npm install -g corepack`.
- **EL8 glibc 2.28**: 향후 Node 메이저가 최저 glibc 요구치를 올리면 prebuilt 설치 실패 가능(사전 `ldd --version` 확인).
- **버전 기준 재확인**: "22 이상"은 2026-07 시점 기준선. `nvm install --lts`는 항상 그 시점 현재 LTS를 설치하므로 자연히 충족되지만, 특정 메이저 고정이 필요하면 `--version` 인자 사용.

ARGUMENTS: [--version <major>] (없으면 `nvm install --lts`로 현재 LTS 자동 설치)
