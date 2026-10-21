---
name: setup-node
description: "nvm 과 Node 22(LTS)를 설치(Windows 는 winget 이나 nvm-windows). Claude Code 의 npm 설치, Codex 와 OMX, npx 로 도는 MCP 서버의 전제. 'setup-node'/'Node 설치'/'nvm 설치' 또는 `/banker:setup` 시 사용."
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

### 네트워크 확인 (내려받기 전)

이 스킬이 내려받는 원천에 10초 안에 닿는지 먼저 본다. 닿지 않으면 그 원천에서 받는 단계는 하지 않고, 이미 설치된 것의 확인만 한 뒤 "오프라인이라 설치하지 않음(필요한 것: <못 깐 것>)" 으로 보고한다.

```bash
[ "${CODEX_SANDBOX_NETWORK_DISABLED:-}" = 1 ] && echo "Codex sandbox 가 네트워크를 막음(아래 실패는 오프라인이 아님)"
curl --ssl-no-revoke -sSI -o /dev/null --connect-timeout 5 --max-time 10 https://api.github.com              # nvm 최신 판 조회(GitHub API)
curl --ssl-no-revoke -sSI -o /dev/null --connect-timeout 5 --max-time 10 https://raw.githubusercontent.com   # nvm 설치 스크립트(GitHub)
curl --ssl-no-revoke -sSI -o /dev/null --connect-timeout 5 --max-time 10 https://github.com                 # nvm 의 install.sh 는 git 이 있으면 github.com 에서 clone 한다
curl --ssl-no-revoke -sSI -o /dev/null --connect-timeout 5 --max-time 10 https://nodejs.org/dist/            # nvm 이 받는 Node
```

- `curl -sSI` 는 머리만 받는다(본문을 받지 않음). 닿지 못하면 종료 코드가 0 이 아니다(HTTP 상태와 관계없음). `curl` 은 `HTTPS_PROXY` 를 따른다. 확인 줄은 `--ssl-no-revoke` 를 준다. Windows 의 Git Bash curl 도 Schannel 이라, 폐지 목록 서버에 닿지 못하는 망에서 폐지 확인이 실패하면 종료 60 이다(Windows 박스 실측). 다른 curl 은 이 깃발을 받고 무시한다(macOS curl 8.7.1, Rocky 8.10 curl 7.61.1 실측).
- Windows PowerShell 에서는 같은 주소를 `curl.exe --ssl-no-revoke -sSI -o NUL --connect-timeout 5 --max-time 10 <주소>` 로 보고 `$LASTEXITCODE` 가 0 인지 본다(PowerShell 5.1 의 `curl` 은 `Invoke-WebRequest` 별칭이다). `curl.exe` 는 Windows 시스템 프록시를 따르지 않고 `HTTPS_PROXY` 만 따른다. `--ssl-no-revoke` 는 폐지 목록 서버에 닿지 못하는 망에서 Schannel 의 폐지 확인 실패를 오프라인으로 읽지 않게 한다. 닿는지만 보고 받은 내용은 쓰지 않으므로 이 확인에만 준다. `curl.exe` 가 없으면 `$LASTEXITCODE` 에 앞 명령의 값이 남으므로 `Get-Command curl.exe -ErrorAction SilentlyContinue` 로 먼저 보고, 없으면 확인하지 못한 것으로 적는다.
- 사내 미러만 열린 망이면 확인 주소를 그 미러로 바꿔 본다.
- OS 패키지 관리자(dnf, apt, brew, winget)의 단계는 자기 설정의 미러를 쓰므로 이 확인과 관계없이 시도하고, 실패하면 그 단계를 실패로 보고한다.
  - 패킷을 버리거나 답하지 않는 망에서 dnf 는 저장소마다 약 2분(SYN 을 버리는 망 실측 121초), apt 는 원천마다 약 4분(답하지 않는 원천 실측 247초) 기다린 뒤 실패로 끝난다. 시간 제한은 관리자 설정을 따르므로 이 스킬이 바꾸지 않는다.
  - `apt-get update` 는 받지 못해도 종료 0 이다. 출력의 `W: Failed to fetch` 가 있으면 그 단계를 실패로 보고한다.
- Codex sandbox 가 네트워크를 막는 모드(기본 `workspace-write`, `read-only`)에서는 `CODEX_SANDBOX_NETWORK_DISABLED=1` 이 서고 확인이 모두 실패한다(curl 종료 7, npm `EPERM`). 블록의 첫 줄이 그렇다고 알린다. 그때는 '오프라인' 이 아니라 'sandbox 가 네트워크를 막음' 으로 보고하고, 승인을 받아 sandbox 밖에서 확인부터 다시 한다. Claude Code sandbox 안(`SANDBOX_RUNTIME=1`)에서는 허용 목록 밖 주소를 sandbox 프록시가 막는다. Windows PowerShell 에서는 `$env:CODEX_SANDBOX_NETWORK_DISABLED -eq '1'` 로 본다.
- 확인이 실패하면 보고에 그 명령, 종료 코드, stderr 첫 줄을 붙인다(예: `npm error code ETIMEDOUT`, `curl: (28) ...`). 원인을 '오프라인' 하나로 짐작하지 않는다.
- curl 의 종료 60(인증서 검증 실패)도 오프라인이 아니다. 망은 열려 있고, TLS 를 가로채는 사내 프록시의 인증서를 OS 가 믿지 않는 것이다. '인증서 문제로 설치하지 않음' 으로 보고한다.

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
NVM_LATEST=$(curl -fsSL --connect-timeout 10 --max-time 30 https://api.github.com/repos/nvm-sh/nvm/releases/latest \
  | grep -m1 '"tag_name":' | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')
if [ -z "$NVM_LATEST" ]; then
  echo "nvm 최신 태그를 받지 못했습니다. 설치하지 않습니다(https://github.com/nvm-sh/nvm/releases 에서 태그를 확인해 다시 실행)."
else
  T=$(mktemp -d)
  curl -fsSL --connect-timeout 10 --max-time 120 -o "$T/install.sh" \
    "https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_LATEST}/install.sh" && bash "$T/install.sh"
  rm -rf "$T"
fi

# 설치 스크립트가 rc 파일을 자동 갱신하나, 컨테이너 등 미반영 환경 대비 idempotent 마커도 병행(nvm 이 깔렸을 때만)
RC_FILE="$HOME/.bashrc"    # macOS는 $HOME/.zshrc
[ -s "$HOME/.nvm/nvm.sh" ] && { grep -q '### BANKER_NODE_BEGIN ###' "$RC_FILE" || cat >> "$RC_FILE"; } <<'EOF'

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
