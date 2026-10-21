---
name: setup-playwright
description: "Playwright 와 헤드리스 브라우저를 OS, 권한, conda 유무에 맞춰 설치. RHEL8, Rocky8, root 권한이 없는 환경도 지원하고 필요하면 xvfb 를 씀. 'setup-playwright'/'playwright 설치' 또는 `/banker:setup` 시 사용."
---

# setup-playwright — Playwright + headless 브라우저 설치 (OS·권한 적응형)

Playwright 브라우저와 headless 실행 환경을 설치한다. **OS·distro·root여부·conda여부를 먼저 감지**해
알맞은 경로를 고른다. macOS/Windows는 단순, Linux(특히 RHEL8/Rocky8 = Playwright 공식 미지원)는 분기·폴백이 핵심.
설치는 **멱등**(이미 있으면 skip·검증만). 답변은 한글(기술 토큰 영문).

## 0. 감지 (먼저 — 추정 금지)
```bash
echo "OS=$(uname -s)"
echo "root=$([ "$(id -u)" = 0 ] && echo yes || echo no)"
command -v sudo >/dev/null && sudo -n true 2>/dev/null && echo "sudo=yes" || echo "sudo=no"
[ -f /etc/os-release ] && . /etc/os-release && echo "distro=$ID ${VERSION_ID}"
for t in conda node npx python3 Xvfb xvfb-run; do command -v $t >/dev/null && echo "$t=yes" || echo "$t=no"; done
```
**이미 설치 확인**: `ls "${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}" 2>/dev/null | grep -i chromium` 가 있으면 브라우저 설치는 skip(검증만).

### 네트워크 확인 (내려받기 전)

이 스킬이 내려받는 원천에 닿는지 먼저 본다(curl 은 10초, npm 은 15초 안). 닿지 않으면 그 원천에서 받는 단계는 하지 않고, 이미 설치된 것의 확인만 한 뒤 "오프라인이라 설치하지 않음(필요한 것: <못 깐 것>)" 으로 보고한다.

```bash
[ "${CODEX_SANDBOX_NETWORK_DISABLED:-}" = 1 ] && echo "Codex sandbox 가 네트워크를 막음(아래 실패는 오프라인이 아님)"
in15() { "$@" & p=$!; ( sleep 15 && kill "$p" ) 2>/dev/null & k=$!; wait "$p" 2>/dev/null; r=$?; kill "$k" 2>/dev/null; wait "$k" 2>/dev/null; [ "$r" = 143 ] && echo "15초 안에 끝나지 않아 멈춤(패킷을 버리는 망일 수 있음)"; return "$r"; }
in15 sh -c 'cd ~ && exec npm ping --fetch-retries=0 --fetch-timeout=10000 --no-update-notifier'   # npx playwright
# pip 이 읽는 설정 전부(PIP_CONFIG_FILE 포함)를 홈 폴더에서 읽는다. install 절이 global 절보다 앞선다
L=$( (cd ~ && { pip config list || pip3 config list || python3.13 -m pip config list || python3.12 -m pip config list || python3.11 -m pip config list || python3 -m pip config list; }) 2>/dev/null) || echo "pip 설정을 읽지 못함(pip 이 없거나 10 미만). 사내 미러를 쓰면 확인 주소를 그 미러로 바꿔 본다"
I="${PIP_INDEX_URL:-$(printf '%s\n' "$L" | sed -n "s/^install\.index-url='\(.*\)'$/\1/p")}"
I="${I:-$(printf '%s\n' "$L" | sed -n "s/^global\.index-url='\(.*\)'$/\1/p")}"
I=$(printf %s "${I:-https://pypi.org/simple}" | sed -E 's#^([A-Za-z][A-Za-z0-9+.-]*://)[^/]*@#\1#; s#/$##')   # 주소의 사용자 정보는 뗌
printf 'url = "%s"\n' "$I/pip/" | curl --ssl-no-revoke -K - -sSI -o /dev/null --connect-timeout 5 --max-time 10   # Python playwright
H="${PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST:-${PLAYWRIGHT_DOWNLOAD_HOST:-https://cdn.playwright.dev}}"   # 브라우저 내려받기 서버(설치본 playwright-core 1.58.2~1.64 의 기본값)
H=$(printf %s "$H" | sed -E 's#^([A-Za-z][A-Za-z0-9+.-]*://)[^/]*@#\1#; s#/$##')   # 주소의 사용자 정보는 뗌
printf 'url = "%s/"\n' "$H" | curl --ssl-no-revoke -K - -sSI -o /dev/null --connect-timeout 5 --max-time 10   # 브라우저(chromium, headless shell, ffmpeg)
```

- `npm ping` 은 홈 폴더에서 부른다. 지금 폴더에 있는 프로젝트의 `.npmrc` 가 정한 레지스트리와 토큰을 따르지 않게 하려는 것이다.
- `npm ping` 은 15초 감시(`in15`) 안에서 부른다. 패킷을 버리는 망에서 npm 은 연결에 시간 제한을 두지 않아(`--fetch-timeout` 은 받는 중의 쉼만 잰다) OS 의 연결 재시도가 끝날 때까지 기다린다(Rocky 8.10 실측 130초). 15초 안에 끝나지 않으면 `15초 안에 끝나지 않아 멈춤(패킷을 버리는 망일 수 있음)` 과 종료 143 이다. `--no-update-notifier` 는 npm 이 제 판을 묻는 요청을 하나 더 내지 않게 한다.
- `npm ping` 이 실패하면 ping 에 답하지 않는 사내 미러일 수 있다. `(cd ~ && T=$(mktemp -d) && { npm view playwright version --fetch-retries=0 --fetch-timeout=10000 --cache "$T" --no-update-notifier; r=$?; rm -rf "$T"; exit $r; })` 도 실패해야 오프라인으로 본다. 이 스킬이 설치할 패키지(`playwright`)를 빈 캐시로 물으므로 옛 값이 나올 수 없다. ping 이 15초 감시에 걸려 멈췄으면(종료 143) 이 확인은 하지 않는다. 같은 레지스트리라 같은 시간을 또 기다린다.
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
- OS 패키지 관리자(dnf, apt, brew, winget)의 단계는 자기 설정의 미러를 쓰므로 이 확인과 관계없이 시도하고, 실패하면 그 단계를 실패로 보고한다.
  - 패킷을 버리거나 답하지 않는 망에서 dnf 는 저장소마다 약 2분(SYN 을 버리는 망 실측 121초), apt 는 원천마다 약 4분(답하지 않는 원천 실측 247초) 기다린 뒤 실패로 끝난다. 시간 제한은 관리자 설정을 따르므로 이 스킬이 바꾸지 않는다.
  - `apt-get update` 는 받지 못해도 종료 0 이다. 출력의 `W: Failed to fetch` 가 있으면 그 단계를 실패로 보고한다.
- 브라우저(chromium, chromium headless shell, ffmpeg)는 Playwright 의 내려받기 서버에서 받는다(이 PC 의 설치본 playwright-core 1.58.2 에서 1.64 까지 기본값 `https://cdn.playwright.dev`). 막힌 망에서는 `PLAYWRIGHT_DOWNLOAD_HOST` 로 사내 미러를 준다. chromium 만 사내 미러(`PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST`)로 바꾸면 ffmpeg 는 기본 서버에서 받는다. 둘 다 바꾸려면 `PLAYWRIGHT_DOWNLOAD_HOST` 를 준다. 확인 없이 받으면 패킷을 버리는 망에서 약 11분(실측 658초) 뒤에 실패한다. Windows 에서도 같은 주소(사용자 정보를 뗀 것)를 본다.
- Codex sandbox 가 네트워크를 막는 모드(기본 `workspace-write`, `read-only`)에서는 `CODEX_SANDBOX_NETWORK_DISABLED=1` 이 서고 확인이 모두 실패한다(curl 종료 7, npm `EPERM`). 블록의 첫 줄이 그렇다고 알린다. 그때는 '오프라인' 이 아니라 'sandbox 가 네트워크를 막음' 으로 보고하고, 승인을 받아 sandbox 밖에서 확인부터 다시 한다. Claude Code sandbox 안(`SANDBOX_RUNTIME=1`)에서는 허용 목록 밖 주소를 sandbox 프록시가 막는다. Windows PowerShell 에서는 `$env:CODEX_SANDBOX_NETWORK_DISABLED -eq '1'` 로 본다.
- 확인이 실패하면 보고에 그 명령, 종료 코드, stderr 첫 줄을 붙인다(예: `npm error code ETIMEDOUT`, `curl: (28) ...`). 원인을 '오프라인' 하나로 짐작하지 않는다.
- curl 의 종료 60(인증서 검증 실패)도 오프라인이 아니다. 망은 열려 있고, TLS 를 가로채는 사내 프록시의 인증서를 OS 가 믿지 않는 것이다. '인증서 문제로 설치하지 않음' 으로 보고한다.
- curl 은 닿는데 npm 만 인증서 오류(`UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `SELF_SIGNED_CERT_IN_CHAIN`, `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`)로 실패하면 망은 열려 있고 npm 이 사내 인증서를 믿지 않는 것이다(npm 은 OS 인증서 저장소를 쓰지 않는다). '인증서 문제로 설치하지 않음' 으로 보고하고 `NODE_EXTRA_CA_CERTS=<사내 CA 파일>` 을 안내한다. Node 24 는 `NODE_OPTIONS=--use-system-ca` 도 된다.

## 1. 공유 브라우저 경로 + 환경 (모든 OS 공통)
브라우저를 한 곳에 두고 MCP·스크립트가 `PLAYWRIGHT_BROWSERS_PATH` 로 공유한다.
- **root/sudo 가능**: 공용 경로(예 `/app/playwright-browsers`) + `/etc/profile.d/playwright.sh`.
- **non-root**: 사용자 경로 `~/.cache/ms-playwright`(기본) 또는 `~/playwright-browsers`, env 는 `~/.bashrc`/`~/.zshrc` 에 export.
```bash
# non-root 예
export PLAYWRIGHT_BROWSERS_PATH="$HOME/.cache/ms-playwright"
grep -q PLAYWRIGHT_BROWSERS_PATH ~/.bashrc 2>/dev/null || echo 'export PLAYWRIGHT_BROWSERS_PATH=$HOME/.cache/ms-playwright' >> ~/.bashrc
```

## 2. 브라우저 설치 (Node vs Python · conda 없으면 venv)
- **Node 경로(권장·간단)**: `npx playwright install chromium` (root면 `--with-deps` 로 OS 라이브러리까지). Node 없으면 distro 패키지/nvm 로 Node 먼저.
- **Python venv(conda 없을 때)**:
  ```bash
  (cd ~ && python3 -m venv ~/.venvs/playwright)   # 홈에서: -c, -m, 표준 입력 스크립트는 지금 폴더의 모듈을 먼저 불러온다
  ~/.venvs/playwright/bin/pip install -U pip playwright
  ~/.venvs/playwright/bin/playwright install chromium
  ```
- **conda 있으면(원 레시피)**:
  ```bash
  conda create -y -n playwright python=3.11
  conda run -n playwright pip install playwright
  conda run -n playwright playwright install chromium
  ```

## 3. OS별 분기

### macOS (Darwin)
GUI 라이브러리·headless 모두 OS 내장 → `npx playwright install chromium` 만으로 동작(Xvfb 불필요).

### Windows
native: `npx playwright install chromium` (headless Chromium 동작, Xvfb 불필요). 가상 디스플레이를 가정하는 일부 스킬은 **WSL2** 권장. `wget` 부재 시 `curl`/`git clone` 사용.

### Debian / Ubuntu
- root/sudo: `npx playwright install --with-deps chromium` (apt 의존성 자동) — 가장 쉬움.
- non-root: 시스템 라이브러리 설치 불가 → 라이브러리가 이미 있으면 브라우저만 설치(§2). 없으면 `xvfb-run` + libs 가 깔린 환경/컨테이너 필요(정직 안내).

### RHEL8 / Rocky8 / CentOS8 (Playwright 공식 미지원)
`npx playwright install` 은 ubuntu24.04 폴백 빌드 + 경고가 뜬다 → **라이브러리는 dnf로, 브라우저는 §2(conda/venv)로** 분리.
- **root/sudo (검증된 레시피)**:
  ```bash
  sudo mkdir -p /app/playwright-browsers && sudo chmod -R 777 /app/playwright-browsers
  sudo tee /etc/profile.d/playwright.sh >/dev/null <<'PW'
export PLAYWRIGHT_BROWSERS_PATH=/app/playwright-browsers
export DISPLAY=:99
PW
  sudo chmod 644 /etc/profile.d/playwright.sh

  # X11/GTK 런타임 라이브러리
  sudo dnf install -y alsa-lib atk at-spi2-atk at-spi2-core cairo cups-libs \
    dbus-glib fontconfig freetype gdk-pixbuf2 glib2 gtk3 libdrm libX11 \
    libXcomposite libXcursor libXdamage libXext libXfixes libXi libXrandr \
    libXrender libXScrnSaver libXtst libxkbcommon mesa-libgbm pango nss nspr \
    xorg-x11-server-Xvfb liberation-fonts dejavu-sans-fonts
  ```
  Xvfb 가상 디스플레이 = **systemd 서비스**:
  ```bash
  id xvfb &>/dev/null || sudo useradd -r -s /sbin/nologin -c "Xvfb service" xvfb
  sudo tee /etc/systemd/system/xvfb.service >/dev/null <<'XVFB'
[Unit]
Description=X Virtual Framebuffer Service
After=network.target
[Service]
Type=simple
User=xvfb
Group=xvfb
ExecStart=/usr/bin/Xvfb :99 -screen 0 1920x1080x24 -ac +extension GLX +render -noreset
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
XVFB
  sudo systemctl daemon-reload && sudo systemctl enable --now xvfb.service
  systemctl is-active xvfb.service   # active
  ```
  그다음 §8(conda) 또는 §2(venv)로 브라우저 설치 후 `ls /app/playwright-browsers | grep -i chromium`.
- **non-root 폴백 (sudo 불가)**:
  - 라이브러리: 시스템에 이미 있으면 OK. 없으면 dnf 불가 → **관리자에게 위 dnf 목록 요청**(정직 보고; 가짜 성공 금지). conda/venv 가 일부 libs 를 가져오기도 함.
  - Xvfb: systemd 대신 **`xvfb-run` / 백그라운드 Xvfb / `systemctl --user`**:
    ```bash
    # (a) 명령을 가상 디스플레이로 감싸기
    command -v xvfb-run >/dev/null && xvfb-run -a -s "-screen 0 1920x1080x24" <명령>
    # (b) 백그라운드 Xvfb + DISPLAY
    (command -v Xvfb >/dev/null && Xvfb :99 -screen 0 1920x1080x24 -ac +extension GLX +render -noreset >/dev/null 2>&1 &) ; export DISPLAY=:99
    # (c) user systemd: ~/.config/systemd/user/xvfb.service 에 동일 ExecStart 후
    #     systemctl --user daemon-reload && systemctl --user enable --now xvfb
    ```
  - env: `/etc/profile.d` 대신 `~/.bashrc` 에 `PLAYWRIGHT_BROWSERS_PATH`·`DISPLAY=:99` export.

## 4. 검증 (보고 의무)
```bash
ls "${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}" | grep -i chromium     # 브라우저 존재
[ "$(uname -s)" = Linux ] && { ps -ef | grep -q "[X]vfb.*:99" && echo "Xvfb :99 up" || echo "Xvfb down (headless면 §3)"; }
# launch smoke test (Node 또는 venv)
DISPLAY=${DISPLAY:-:99} npx playwright --version 2>/dev/null || \
  (cd ~ && ~/.venvs/playwright/bin/python -c "from playwright.sync_api import sync_playwright as s; p=s().start(); b=p.chromium.launch(headless=True); print('launch OK'); b.close(); p.stop()")
```
4-field 보고: 변경(설치 항목·env 파일) / Evidence(위 출력) / 검증(launch OK) / Unknown(관리자 권한 라이브러리 미설치 등).

## 함정
- **RHEL8 `npx playwright install` 경고**: ubuntu24.04 폴백 빌드라 라이브러리 불일치 가능 → dnf 라이브러리(§3) + 별도 브라우저(§2)가 안전.
- **non-root 라이브러리 벽**: 시스템 `.so` 부재는 user-space로 못 넘기도 함 → 정직히 "관리자 dnf 필요" 보고(가짜 성공 금지).
- **DISPLAY 미설정 headless**: Linux에서 `DISPLAY` 없거나 Xvfb 죽으면 launch 실패 → §3 확인.
- **env 미적용**: `/etc/profile.d`·`~/.bashrc` 는 새 셸에만 적용 → 현재 셸엔 `source` 하거나 명령에 인라인 `DISPLAY=:99 PLAYWRIGHT_BROWSERS_PATH=… ` export.
- **MCP 공유**: `@playwright/mcp` 등은 같은 `PLAYWRIGHT_BROWSERS_PATH` env 면 동일 브라우저를 공유 → 중복 설치 불필요.
