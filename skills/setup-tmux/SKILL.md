---
name: setup-tmux
description: "OMC 의 `team` 과 worktree 세션, OMX 의 `$team` 과 HUD 에 필요한 tmux 를 OS 에 맞춰 설치(Windows 는 psmux). Rocky8 은 3.6a 를 소스에서 빌드. 'setup-tmux'/'tmux 설치'/'psmux 설치' 또는 `/banker:setup` 시 사용."
---

# setup-tmux: tmux(Windows는 psmux) 설치

Claude Code 의 OMC `team`/worktree 병렬 세션과 Codex 의 OMX `$team`/HUD 는 전부 tmux(Windows 는
psmux) 세션 **안에서 실행되는 것을 전제**한다. 이 스킬은 OS 를 감지해 알맞은 경로로 tmux 를
설치·검증한다. 설치는 **멱등**(이미 충족하면 skip·검증만). 답변은 한글(기술 토큰 영문).

## 런타임 배선
- **Claude Code**: OMC 의 `team`/worktree 세션(패널 분할·병렬 워커)은 tmux 안에서 실행된다.
- **Codex**: OMX 의 `$team`/HUD 는 tmux(또는 psmux) 세션 **안에서 실행이 필수**다. 세션 밖에서
  실행하면 `outside-tmux` surface 로 표시되고 `$team`/HUD 가 동작하지 않는다 - 에러가 두드러지지
  않아 조용히 실패한 것처럼 보일 수 있다.
- **공통**: worker 의 작업 디렉터리가 dubious-ownership 으로 잡히면 worktree 생성 자체가 막힌다 →
  `git config --global --add safe.directory '*'` 를 함께 설정한다(§2).

## 0. 감지 (먼저 - 추정 금지)
```bash
command -v tmux >/dev/null && tmux -V || echo "tmux: 미설치"
[ -f /etc/os-release ] && . /etc/os-release && echo "distro=$ID ${VERSION_ID}"
type -a tmux 2>/dev/null   # Rocky8: PATH 상 여러 tmux 가 있을 수 있음 - 순서 확인
```
Windows(PowerShell):
```powershell
Get-Command tmux -ErrorAction SilentlyContinue
```

### 네트워크 확인 (내려받기 전)

이 스킬이 내려받는 원천에 10초 안에 닿는지 먼저 본다. 닿지 않으면 그 원천에서 받는 단계는 하지 않고, 이미 설치된 것의 확인만 한 뒤 "오프라인이라 설치하지 않음(필요한 것: <못 깐 것>)" 으로 보고한다.

```bash
[ "${CODEX_SANDBOX_NETWORK_DISABLED:-}" = 1 ] && echo "Codex sandbox 가 네트워크를 막음(아래 실패는 오프라인이 아님)"
curl --ssl-no-revoke -sSI -o /dev/null --connect-timeout 5 --max-time 10 https://github.com   # tmux 소스(Rocky8 빌드)
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

## 1. OS별 설치

### Rocky Linux 8 / RHEL8 - 소스빌드 필수
시스템 기본 `tmux` 는 2.7 이며 OMX `--madmax` 모드에서 **hang** 한다(실측). EPEL 도 3.x 를 제공하지
않는다 → **3.6a 를 소스에서 빌드**한다.
```bash
# 이미 3.6a+ 면 재빌드 불필요(멱등)
/usr/local/bin/tmux -V 2>/dev/null | grep -qE '3\.[6-9]|[4-9]\.' && echo "이미 충족 - skip" || {
  sudo dnf install -y libevent-devel ncurses-devel gcc make byacc
  T=$(mktemp -d) && cd "$T" \
    && curl -fL --connect-timeout 10 --max-time 300 -o tmux-3.6a.tar.gz https://github.com/tmux/tmux/releases/download/3.6a/tmux-3.6a.tar.gz \
    && tar xzf tmux-3.6a.tar.gz && cd tmux-3.6a \
    && ./configure && make && sudo make install     # /usr/local/bin/tmux 로 설치됨
  cd ~; rm -rf "$T"
}
```
> **`/usr/bin/tmux`(2.7)를 지우지 않는다** - PATH 상 `/usr/local/bin` 이 먼저 오는지만 확인해
> 우회한다(`type -a tmux` 첫 줄이 `/usr/local/bin/tmux` 인지 확인).
> ⚠️ 3.6a 는 이 시점의 버전 고정값이다. 최신 안정판은 https://github.com/tmux/tmux/releases 에서
> 재확인 후 필요하면 `TMUX_VER` 를 바꿔 교체한다.

### Ubuntu / Debian - apt 기본으로 충분
```bash
sudo apt-get update && sudo apt-get install -y tmux
tmux -V
```
Ubuntu 22.04(3.2a)·24.04(3.4)·Debian 12(3.3a) 모두 OMX 요구 버전을 충족한다 - 소스빌드 불필요.

### macOS
```bash
brew install tmux
```

### Windows - psmux
Windows 에는 tmux 가 없어 호환 레이어인 psmux 를 쓴다.
```powershell
winget install --id marlocarlo.psmux -e
tmux -V      # psmux 가 tmux 커맨드 alias 를 자동 등록
```
- psmux 는 tmux 명령을 상당 부분 흉내내지만 **100% 호환은 아니다** - 이상 동작 시 psmux 자체
  버전과 재현 여부를 먼저 의심한다.
- `$team`/HUD 를 쓰려면 psmux 세션 **안에서** `omx` 를 실행해야 한다: `tmux new-session -s codex`
  로 세션을 연 뒤 그 안에서 `omx --madmax --xhigh`.

## 2. 공통 - dubious-ownership 가드
```bash
git config --global --add safe.directory '*'
```
worker 가 `/tmp` 등 소유권이 모호한 경로에서 실행되면 이 설정 없이는 worktree 생성이 막힌다.

## 검증 (보고 의무)
```bash
tmux -V                                             # 존재 확인 (>=3.2; Rocky8 은 3.6a)
type -a tmux 2>/dev/null | head -1                   # Rocky8: 첫 줄이 /usr/local/bin/tmux 여야 함
tmux new-session -d -s _t && tmux kill-session -t _t && echo "tmux 실동작 OK"
git config --global --get safe.directory
```
Windows: `tmux -V`(psmux 버전) + `Get-Command tmux`.

4-field 보고: 변경(설치 방법·버전·safe.directory 여부) / Evidence(위 출력) / 검증(new-session→
kill-session 성공) / Unknown(sudo 권한 없어 소스빌드 불가 등).

## 함정
- **Rocky8 빌드 의존성 누락**: `libevent-devel`/`ncurses-devel`/`byacc` 없이 `./configure` 하면
  실패 → 위 dnf 목록을 먼저 설치.
- **PATH 우선순위**: `/usr/local/bin/tmux`(3.6a)가 `/usr/bin/tmux`(2.7)보다 먼저 잡히지 않으면
  여전히 구버전이 실행된다 → `type -a tmux` 로 순서 확인, 필요하면 `~/.bashrc` PATH 앞쪽에 추가.
- **psmux 비호환**: 일부 tmux 전용 스크립트·키바인딩이 psmux 에서 다르게 동작할 수 있다 - 완전한
  대체품이 아니라는 전제로 접근.
- **세션 밖 실행**: tmux/psmux 세션 밖에서 `omx --madmax`/`$team`/HUD 를 실행하면 `outside-tmux`
  로 표시되고 기능이 동작하지 않는다 - 실패가 눈에 띄지 않을 수 있으므로 항상 세션 안에서
  실행했는지 먼저 확인한다.
- **dubious-ownership 누락**: `safe.directory` 미설정 시 worker 가 조용히 worktree 를 못 만들고
  idle 상태로만 보일 수 있다.

ARGUMENTS: 없음 (OS 자동감지 후 설치 - Rocky8 은 소스빌드, 그 외는 패키지매니저)
