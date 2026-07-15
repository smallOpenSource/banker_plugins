---
name: setup-python
description: "(banker) Python 3.11+ 런타임 + pipx·uv 설치(OS별 PEP668·RHEL8 3.6 회피). 라이브러리(pptx·pymupdf)는 docs-setup 담당, 본 스킬은 런타임만. 'setup-python'/'Python 설치'/'pipx·uv 설치' 또는 /banker:setup 시 사용."
---

# setup-python: Python 3.11+ 런타임 + pipx·uv 설치

Claude Code·Codex 양쪽의 python 기반 도구가 딛고 서는 **인터프리터 런타임**과 `pipx`·`uv`를 설치한다.
**경계**: 이 스킬은 런타임 자체만 다룬다. python-pptx·pymupdf 같은 문서 라이브러리는 `docs-setup`이 이 런타임 위에서 담당(별도 venv). 멱등(이미 3.11+ 있으면 skip). 답변은 한글(명령·경로는 영문).

## 런타임 배선
- **Claude Code**: `docs-setup`(python-pptx·pymupdf) 및 `serena`·`mcp-server-git`·`mcp-server-fetch` 등 `uvx` 기반 MCP가 이 위에서 동작. 전부 python 3.8+ 요구.
- **Codex/OMX**: `basedpyright`·`ruff`(pipx 격리 설치), `lsp-mcp`(`pipx install --editable`)가 python 3.8+ 요구.
- 즉 이 스킬이 먼저 실행되어야 `docs-setup`이나 LSP 설치 스킬이 "어떤 python을 쓸지" 고민 없이 최신 버전을 찾을 수 있다.

## 0. 감지 (먼저, 추정 금지)
```bash
[ -f /etc/os-release ] && . /etc/os-release && echo "distro=$ID ${VERSION_ID}"
for v in 3.13 3.12 3.11; do command -v python$v >/dev/null && echo "python$v=$(python$v --version 2>&1)"; done
command -v python3 >/dev/null && echo "python3(default)=$(python3 --version 2>&1)" || echo "python3=미설치"
command -v pipx >/dev/null && echo "pipx=$(pipx --version)" || echo "pipx=미설치"
command -v uv   >/dev/null && echo "uv=$(uv --version)"     || echo "uv=미설치"
```
```powershell
$PSVersionTable.PSVersion
py -0p 2>$null                                                          # 설치된 버전 목록
if (Get-Command pipx -ErrorAction SilentlyContinue) { pipx --version } else { "pipx: 미설치" }
if (Get-Command uv   -ErrorAction SilentlyContinue) { uv --version }   else { "uv: 미설치" }
```

## 1. Rocky Linux 8
```bash
sudo dnf -y module install python311/common
python3.11 --version
```
- ⚠️ **RHEL8 기본 `python3`는 3.6.** `pymupdf`/`playwright` 등은 3.8+ 휠만 배포하므로 3.6/3.7에선 설치 자체가 실패한다(sdist 빌드 시도 → 헤더 부재로 재실패).
- 시스템 기본 `python3`를 3.11로 바꾸는 것은 **선택**이며 위험을 감수할 때만:
  ```bash
  # sudo alternatives --install /usr/bin/python3 python3 /usr/bin/python3.11 30
  # sudo alternatives --set python3 /usr/bin/python3.11
  ```
  실행하지 않아도 무방하다. `docs-setup` 등 소비 스킬은 `python3.11`처럼 버전 명시 커맨드를 직접 탐지해 쓰므로 시스템 기본을 바꿀 필요가 없다.

## 2. Ubuntu 20.04~24.04
```bash
. /etc/os-release
if [ "${VERSION_ID}" = "20.04" ] || [ "${VERSION_ID}" = "22.04" ]; then
  sudo add-apt-repository -y ppa:deadsnakes/ppa
  sudo apt update
  sudo apt install -y python3.11 python3.11-venv python3.11-dev
else
  echo "24.04+: 기본 python3(3.12)가 이미 3.11+ 충족. 별도 설치 불요"
fi
python3.11 --version 2>/dev/null || python3 --version
```

## 3. Debian 12 (bookworm)
```bash
python3 --version   # 기본 3.11.2(이미 충족)·별도 설치 불요(검증만)
```

## 4. macOS (Apple Silicon / Intel)
```zsh
brew install python@3.11
```
- **keg-only라 PATH 자동 미등록.** `brew --prefix python@3.11`로 실제 경로를 확인해 아래 공통 rc 블록에 추가해야 `python3.11` 커맨드가 잡힌다.

## 5. Windows 10/11
```powershell
winget install --id Python.Python.3.11 -e
py -3.11 --version
```
> ⚠️ **MS Store 실행 별칭**: PATH에 winget 설치본보다 `WindowsApps` 스텁이 먼저 걸리면 `python`/`python3`가 스토어로 튄다 → 설정 > 앱 > 고급 앱 설정 > 앱 실행 별칭에서 `python.exe`/`python3.exe` 끄기.

## pipx·uv 공통 설치 (런타임 확보 후)
```bash
PY=$(command -v python3.11 || command -v python3.12 || command -v python3)
# pipx: Debian/Ubuntu 는 apt 가 1순위. 신선 Debian12·deadsnakes python3.11·Ubuntu24.04 는 인터프리터에
#   pip 가 미번들이라 `$PY -m pip` 가 "No module named pip" 로 실패하고 --break-system-packages 로도 안 된다.
[ -f /etc/os-release ] && . /etc/os-release
case "${ID:-}${ID_LIKE:-}" in
  *debian*|*ubuntu*) sudo apt-get install -y pipx ;;                                  # python3-pip 동반, PEP668 무충돌
  *)                 "$PY" -m pip install --user pipx \
                       || "$PY" -m pip install --user pipx --break-system-packages ;; # RHEL8/macOS: 인터프리터에 pip 번들
esac
command -v pipx >/dev/null && pipx ensurepath || "$PY" -m pipx ensurepath
# macOS 대안: brew install pipx && pipx ensurepath

curl -LsSf https://astral.sh/uv/install.sh | sh     # macOS/Linux 공통, 항상 최신 fetch(버전 고정 불필요)

RC_FILE="$HOME/.bashrc"   # macOS는 $HOME/.zshrc
grep -q '### BANKER_PYTHON_BEGIN ###' "$RC_FILE" || cat >> "$RC_FILE" <<'EOF'

### BANKER_PYTHON_BEGIN ###
export PATH="$HOME/.local/bin:$PATH"
### BANKER_PYTHON_END ###
EOF
source "$RC_FILE"
```
```powershell
python -m pip install --user pipx
python -m pipx ensurepath
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
```

## 검증 (보고 의무)
```bash
python3.11 --version 2>/dev/null || python3 --version
pipx --version
uv --version
```
4-field 보고: 변경(설치한 python 버전·pipx/uv·rc 마커) / Evidence(위 출력) / 검증(`--version` 전부 OK) / Unknown(PEP668·권한 문제로 일부 미설치 등, 가짜 성공 금지).

## 함정
- **PEP668 externally-managed-environment**(Ubuntu 24.04·Debian 12): 직접 `pip install`이 거부됨 → apt `pipx` 패키지 또는 `--break-system-packages`.
- **macOS PATH 자동 미등록**: `python@3.11`은 keg-only → `brew --prefix`로 경로 확인 후 수동 추가하지 않으면 "command not found".
- **Windows MS Store 스텁**: 앱 실행 별칭을 꺼두지 않으면 `python`이 스토어 설치 페이지로 리다이렉트.
- **RHEL8 python3.6 잔존**: 시스템 기본을 바꾸지 않아도 소비 스킬들이 버전 명시 커맨드로 우회하므로 문제 없음.
- **pipx vs uv 역할 혼동**: pipx=CLI 도구 격리 설치(`basedpyright`·`ruff` 등), uv=venv/패키지 고속 관리. 상호 대체가 아니라 병행 사용.

ARGUMENTS: [--version <x.y>] (없으면 3.11 자동 설치)
