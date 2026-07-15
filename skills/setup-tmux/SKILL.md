---
name: setup-tmux
description: "(banker) OMC team·worktree 세션과 Codex OMX $team·HUD 가 요구하는 tmux(Windows는 psmux)를 OS 감지 후 설치·소스빌드(Rocky8 3.6a). 'setup-tmux'/'tmux 설치'/'psmux 설치' 또는 /banker:setup 시 사용."
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

## 1. OS별 설치

### Rocky Linux 8 / RHEL8 - 소스빌드 필수
시스템 기본 `tmux` 는 2.7 이며 OMX `--madmax` 모드에서 **hang** 한다(실측). EPEL 도 3.x 를 제공하지
않는다 → **3.6a 를 소스에서 빌드**한다.
```bash
# 이미 3.6a+ 면 재빌드 불필요(멱등)
/usr/local/bin/tmux -V 2>/dev/null | grep -qE '3\.[6-9]|[4-9]\.' && echo "이미 충족 - skip" || {
  sudo dnf install -y libevent-devel ncurses-devel gcc make byacc
  cd /tmp
  curl -fLO https://github.com/tmux/tmux/releases/download/3.6a/tmux-3.6a.tar.gz
  tar xzf tmux-3.6a.tar.gz && cd tmux-3.6a
  ./configure && make && sudo make install     # /usr/local/bin/tmux 로 설치됨
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
