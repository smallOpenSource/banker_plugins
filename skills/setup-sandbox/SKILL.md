---
name: setup-sandbox
description: "(banker) 에이전트 샌드박스 공통 기반(Linux bubblewrap+socat+sysctl userns, macOS Seatbelt, Windows AppContainer)을 OS 감지 후 설치(+rust/cargo·git safe.directory 폴드인). 'setup-sandbox'/'샌드박스 설치'/'bubblewrap 설치' 또는 /banker:setup 시 사용."
---

# setup-sandbox: 에이전트 샌드박스 설치

Claude Code 의 sandboxed Bash 도구(`~/.claude/settings.json` 의 `sandbox` 설정)와 Codex/OMX 의 bwrap 기반 샌드박스는 **리눅스에서
동일한 하부 조건**(bubblewrap·socat·unprivileged user namespace)에 의존한다. 이 스킬이 그 공통 기반을
OS별로 설치·검증하고, 두 런타임 각각의 설정 계층(Claude=`settings.json`, Codex=`config.toml`)을 배선한다.
부수적으로 자주 같이 필요한 **rust/cargo**, **git safe.directory**(`$team`/worktree dubious-ownership
회피)도 폴드인한다. 설치는 **멱등**(이미 있으면 skip·검증만). 답변은 한글(기술 토큰 영문).

## 런타임 배선
- **Claude Code**: Bash 도구 샌드박스를 `~/.claude/settings.json` 의 `sandbox` 객체로 제어한다(정확한 키
  구성은 현재 Claude Code settings 문서로 확인). **네이티브 Windows 미지원**(WSL2 안에서 실행해야 함).
- **Codex/OMX**: `~/.codex/config.toml` 의 `sandbox_mode`/`[sandbox_workspace_write]`(Python
  replace-or-append + TOML 검증). Windows 는 네이티브 AppContainer 로 이미 지원.
- 리눅스 bwrap+socat 설치는 **1회로 두 런타임 모두** 혜택 - Claude·Codex 각자 따로 설치할 필요 없다.

## 0. 감지 (먼저, 추정 금지)
```bash
echo "OS=$(uname -s)"
[ -f /etc/os-release ] && . /etc/os-release && echo "distro=$ID ${VERSION_ID}"
for t in bwrap socat cargo; do command -v $t >/dev/null && echo "$t=yes" || echo "$t=no"; done
sysctl user.max_user_namespaces 2>/dev/null
sysctl kernel.unprivileged_userns_clone 2>/dev/null
sysctl kernel.apparmor_restrict_unprivileged_userns 2>/dev/null
git config --global --get-all safe.directory 2>/dev/null
[ -f ~/.codex/config.toml ] && grep -n 'sandbox_mode\|network_access' ~/.codex/config.toml
[ -f ~/.claude/settings.json ] && grep -A3 '"sandbox"' ~/.claude/settings.json
```

## 1. Linux - bubblewrap + socat + userns sysctl
### Rocky Linux 8 / RHEL8
```bash
sudo dnf -y install epel-release      # socat 등은 EPEL 필요(bubblewrap 은 보통 AppStream 에 존재)
sudo dnf -y install bubblewrap socat
echo 'user.max_user_namespaces=15000' | sudo tee /etc/sysctl.d/99-userns.conf
sudo sysctl -p /etc/sysctl.d/99-userns.conf
```
### Ubuntu 22.04/24.04
```bash
sudo apt-get install -y bubblewrap socat
echo 'kernel.unprivileged_userns_clone=1' | sudo tee /etc/sysctl.d/99-userns.conf
sudo sysctl -p /etc/sysctl.d/99-userns.conf
```
24.04+ 는 AppArmor 가 bwrap 의 userns 생성을 추가로 막을 수 있다 - 먼저 확인:
```bash
sysctl kernel.apparmor_restrict_unprivileged_userns   # 1 이면 아래 필요, 0/키없음이면 스킵
```
1 이면 **범위를 좁힌 공식 방법**(권장 - bwrap 에만 허용):
```bash
sudo tee /etc/apparmor.d/bwrap >/dev/null <<'EOF'
abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
  include if exists <local/bwrap>
}
EOF
sudo systemctl reload apparmor
```
또는 **더 넓게(구식 가이드 방식)**: `kernel.apparmor_restrict_unprivileged_userns=0` 을 같은 sysctl 파일에
추가 - 시스템 전역으로 완화되므로 가능하면 위 프로필 방식을 우선한다.

### Debian 12
```bash
sudo apt-get install -y bubblewrap socat
echo 'kernel.unprivileged_userns_clone=1' | sudo tee /etc/sysctl.d/99-userns.conf
sudo sysctl -p /etc/sysctl.d/99-userns.conf
```

## 2. macOS - Seatbelt(설치 불필요)
Claude Code·Codex 모두 macOS 내장 `sandbox-exec`(Seatbelt)를 그대로 쓴다. 확인만 한다:
```bash
command -v sandbox-exec >/dev/null && echo "Seatbelt 내장 OK"
```

## 3. Windows - 런타임별 격리 방식이 다르다(둘 다 설치 불필요, 개념 차이만 주의)
- **Codex**: 네이티브 AppContainer(restricted token) 로 이미 격리 지원.
- **Claude Code**: 샌드박스가 **네이티브 Windows 를 지원하지 않는다** - WSL2 안에서 실행해야 한다(공식
  정책). WSL2 안에서는 위 리눅스 절차(bwrap+socat)를 그대로 적용한다. WSL2 안에서도 `cmd.exe`·
  `powershell.exe`·`/mnt/c/` 하위 바이너리는 호출 불가(호스트로 넘어가는 유닉스 소켓을 샌드박스가 차단) -
  꼭 필요하면 `excludedCommands` 에 등록해 샌드박스 밖에서 실행한다.

## 4. 폴드인 - rust/cargo
```bash
command -v cargo >/dev/null || curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source "$HOME/.cargo/env" 2>/dev/null
cargo --version
```

## 5. 폴드인 - git safe.directory ($team/worktree)
공유 워크트리·컨테이너 등 소유자가 다른 repo 에서 git 이 "dubious ownership" 로 명령을 거부하는 문제를
미리 막는다(OMC/OMX `$team` 병렬 워커가 특히 걸린다):
```bash
git config --global --add safe.directory '*'
git config --global --get-all safe.directory
```
`'*'` 는 범위가 넓다 - 통제된 팀/컨테이너 환경을 전제한다(불특정 다중 사용자 공유 서버라면 특정 경로만
등록하는 편을 고려).

## 6. Claude Code 배선
Claude Code 의 Bash 도구 샌드박스는 `~/.claude/settings.json` 의 `sandbox` 객체로 설정한다(대화형 슬래시
커맨드가 아니라 설정·CLI 플래그 기반). 위 §1 에서 설치한 bubblewrap/socat 이 그 하부 조건이다:
```json
{
  "sandbox": {
    "enabled": true,
    "failIfUnavailable": false
  }
}
```
- `enabled`/`failIfUnavailable` 은 확인된 키다. `sandbox` 객체는 이 외에도 `network`·`excludedCommands`·
  `autoAllowBashIfSandboxed` 등 하위 키를 가진다 - **정확한 스키마·기본값은 반드시 현재 Claude Code
  settings 문서(`code.claude.com/docs`)로 확인**한 뒤 적용한다(버전에 따라 키가 바뀔 수 있어 추정 금지).
- `failIfUnavailable: true` 로 두면 의존성 누락 시 자동 폴백 없이 바로 실패한다 - 관리형 배포에만 권장.

## 7. Codex 배선
`tomllib` 는 Python **3.11+** 표준 라이브러리다 - RHEL8/Rocky8 등은 기본 `python3` 가 3.6 인 경우가
흔하므로(예: `docs-setup` 이 다루는 것과 같은 함정) 먼저 3.11+ 인터프리터를 고른다:
```bash
PY="$(command -v python3.12 || command -v python3.11 || command -v python3)"
"$PY" -c "import tomllib" 2>/dev/null || echo "⚠ tomllib 없음 - Python 3.11+ 설치 후 재시도(setup-python 참고)"
```
그 `$PY` 로 패치한다. `sandbox_mode` 치환은 **첫 `[` 테이블 헤더 이전(root 영역)만** 대상으로 삼아
`[profiles.*]` 하위의 같은 이름 override(예: 프로필별 `read-only` 강제)를 절대 건드리지 않는다(멱등):
```bash
"$PY" <<'EOF'
import re
from pathlib import Path
import tomllib

CFG = Path.home() / ".codex" / "config.toml"
CFG.parent.mkdir(parents=True, exist_ok=True)
text = CFG.read_text(encoding="utf-8") if CFG.exists() else ""
if text:
    tomllib.loads(text)  # 사전 검증

# root 영역 = 첫 '[' 테이블 헤더 이전까지만 - [profiles.*] 하위 동명 키는 손대지 않는다
m = re.search(r'(?m)^\[', text)
cut = m.start() if m else len(text)
head, tail = text[:cut], text[cut:]

if re.search(r'(?m)^sandbox_mode\s*=', head):
    head = re.sub(r'(?m)^sandbox_mode\s*=.*$', 'sandbox_mode = "workspace-write"', head, count=1)
else:
    head = 'sandbox_mode = "workspace-write"\n' + head

text = head + tail
if "[sandbox_workspace_write]" not in text:
    text += '\n[sandbox_workspace_write]\nnetwork_access = true\n'

tomllib.loads(text)  # 패치 후 재검증
CFG.write_text(text, encoding="utf-8")
print("✓ sandbox_mode=workspace-write, network_access=true")
EOF
```

## 검증 (보고 의무)
```bash
bwrap --version 2>/dev/null || echo "bwrap 없음"
command -v socat >/dev/null && echo "socat OK" || echo "socat 없음(Claude sandbox 네트워크 프록시 실패 가능)"
# 존재만이 아니라 실제 userns 동작까지 확인
bwrap --unshare-user --ro-bind / / true && echo "✓ bwrap userns 동작" || echo "✗ 실패 - sysctl 재확인"
cargo --version 2>/dev/null || echo "cargo 없음"
git config --global --get-all safe.directory

grep -n 'sandbox_mode\|network_access' ~/.codex/config.toml
PY="$(command -v python3.12 || command -v python3.11 || command -v python3)"   # tomllib=3.11+
"$PY" -c "import tomllib; tomllib.loads(open('$HOME/.codex/config.toml', encoding='utf-8').read()); print('✓ TOML 유효')"
timeout 30 codex sandbox -- echo sandbox-ok    # Codex 자체 샌드박스 러너로 실제 실행 확인

python3 -m json.tool ~/.claude/settings.json >/dev/null && echo "settings.json 유효"
# Claude Code sandbox 설정은 settings.json 로 확인(위 json.tool). 실제 동작은 세션에서 Bash 도구 실행으로 관찰
```
4-field 보고: 변경(설치 패키지·sysctl 파일·config.toml/settings.json 변경분) / Evidence(위 출력) /
검증(bwrap 실제 동작·`codex sandbox` 성공) / Unknown(root 권한 없어 sysctl 미적용, Claude settings.json
`sandbox` 스키마는 문서 재확인 필요 등).

## 함정
- **sysctl 은 root 필요**: sudo 불가 환경이면 현재 값 보고 후 관리자에게 요청한다(가짜 성공 금지).
- **EL8 커널이 오래됨**(4.18): 기본 `user.max_user_namespaces` 가 낮거나 0 인 경우가 흔하다 - 감지 없이
  이미 충분하다고 가정하지 않는다.
- **Ubuntu 24.04+ AppArmor**: bwrap 프로필(좁음) 또는 sysctl 전역 해제(넓음) 중 하나가 필요하다 - 프로필
  방식을 우선한다.
- **Windows 비대칭**: Codex 는 네이티브 AppContainer 로 되지만 **Claude Code 샌드박스는 WSL2 없이 안
  된다** - 둘을 같은 것으로 안내하지 않는다.
- **socat 누락**: bwrap 만 있고 socat 이 없으면 Claude 샌드박스의 네트워크 프록시 릴레이가 동작하지
  않을 수 있다(socat 이 그 릴레이를 담당).
- **tomllib 는 Python 3.11+ 전용**: RHEL8/Rocky8 기본 `python3`(3.6)로 그대로 돌리면
  `ModuleNotFoundError` - 위 `$PY` 선택 스니펫을 반드시 거친다.
- **config.toml 패치 범위**: `sandbox_mode` 치환은 첫 `[` 헤더 이전(root)만 대상이라 `[profiles.*]`
  하위 override 는 건드리지 않는다 - 그래도 패치 후 `grep -n sandbox_mode ~/.codex/config.toml` 로
  한 번 눈으로 확인하는 습관을 권장한다.
- **git safe.directory `'*'` 범위**: 통제된 팀/컨테이너 환경을 전제한다 - 불특정 다중 사용자 공유 서버엔
  과하다.
- **rustup 은 셸 rc 를 건드린다**: 새 셸을 열거나 `source ~/.cargo/env` 해야 `cargo` 가 바로 잡힌다.

ARGUMENTS: [--skip-cargo] [--skip-git-safe] (없으면 OS 감지 기반 bwrap/socat+sysctl 설치부터 Codex config 패치까지 전부 수행)
