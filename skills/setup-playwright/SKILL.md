---
name: setup-playwright
description: "Playwright + headless 브라우저를 OS·권한·conda 감지 후 설치 — RHEL8/Rocky8 비공식·non-root·no-conda venv·xvfb 폴백 지원. 'setup-playwright'/'playwright 설치' 또는 /banker:setup 시 사용."
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
  python3 -m venv ~/.venvs/playwright
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
  ~/.venvs/playwright/bin/python -c "from playwright.sync_api import sync_playwright as s; p=s().start(); b=p.chromium.launch(headless=True); print('launch OK'); b.close(); p.stop()"
```
4-field 보고: 변경(설치 항목·env 파일) / Evidence(위 출력) / 검증(launch OK) / Unknown(관리자 권한 라이브러리 미설치 등).

## 함정
- **RHEL8 `npx playwright install` 경고**: ubuntu24.04 폴백 빌드라 라이브러리 불일치 가능 → dnf 라이브러리(§3) + 별도 브라우저(§2)가 안전.
- **non-root 라이브러리 벽**: 시스템 `.so` 부재는 user-space로 못 넘기도 함 → 정직히 "관리자 dnf 필요" 보고(가짜 성공 금지).
- **DISPLAY 미설정 headless**: Linux에서 `DISPLAY` 없거나 Xvfb 죽으면 launch 실패 → §3 확인.
- **env 미적용**: `/etc/profile.d`·`~/.bashrc` 는 새 셸에만 적용 → 현재 셸엔 `source` 하거나 명령에 인라인 `DISPLAY=:99 PLAYWRIGHT_BROWSERS_PATH=… ` export.
- **MCP 공유**: `@playwright/mcp` 등은 같은 `PLAYWRIGHT_BROWSERS_PATH` env 면 동일 브라우저를 공유 → 중복 설치 불필요.
