---
name: build-testbox
description: "이 PC 가 스스로 구성하는 범용 시험 환경. 서비스 시험용 브라우저 행렬(Playwright Chromium 과 WebKit, 데스크톱과 모바일 기기 에뮬레이션)과 배포 시험용 컨테이너 OS(Rocky Linux 8, 9. macOS 는 Apple Silicon 의 Tart VM 만)를 병렬로 실행. run 은 내려받지 않고 못 돈 칸은 unverified 와 사유로 끝남. 받기는 확인 뒤 setup --yes 로만. 'build-testbox'/'테스트박스 구성'/'멀티 OS 브라우저 시험'/'컨테이너 OS 시험'/'사파리 크롬 모바일 시험' 시 사용."
---

# build-testbox: 브라우저 행렬과 컨테이너 OS 를 병렬로 돌리는 시험 환경

이 스킬을 쓰는 PC, 서버, 세션이 자기 자원으로 시험 환경을 꾸린다. 특정 테스트박스를 전제하지 않는다.
스크립트는 순수 Node 18+ 이고 의존성이 없다. Playwright 는 이 저장소의 의존성이 아니라 전역 설치(또는 `--playwright-from-project` 의 프로젝트 설치)를 찾아 불러온다.
답변은 한글.

| 묶음 | 칸 | 엔진 |
|---|---|---|
| 브라우저(서비스 시험) | 기기 하나가 칸 하나. 기본 `Desktop Chrome`, `Pixel 7`(chromium), `Desktop Safari`, `iPhone 15`(webkit) | 호스트의 Playwright, 또는 `--browser-in-container` 로 Playwright 공식 이미지 |
| 컨테이너 OS(배포 시험) | OS 하나가 칸 하나. 기본 `rocky8`, `rocky9` | docker 또는 podman |
| macOS | `--os macos` | Apple Silicon Mac 의 Tart VM |

- 두 묶음은 같은 순간에 시작한다. 묶음 안에서도 칸마다 `--jobs` 개까지 동시에 돈다
- Safari 는 WebKit 에뮬레이션, 모바일은 Playwright 기기 에뮬레이션이다. 실제 Safari, iOS 시뮬레이터는 범위 밖이다

## 언제 쓰나

- 로컬 서비스(127.0.0.1)를 Chrome 과 Safari 계열, PC 와 모바일 화면으로 한 번에 열어 보고 싶을 때
- 배포 스크립트나 설치 명령을 Rocky Linux 8, 9 컨테이너에서 같이 돌려 보고 싶을 때
- airgap 에서도 "무엇이 돌았고 무엇이 왜 못 돌았는지" 를 거짓 통과 없이 남기고 싶을 때

## 쓰지 않을 때

- Playwright 자체의 설치와 OS 라이브러리, Xvfb 준비. setup-playwright 를 쓴다
- 등록된 SSH 테스트박스에서 저장소 시험을 돌릴 때. remains 를 쓴다
- 비 Apple 호스트에서 macOS 를 띄우려 할 때. 라이선스상 하지 않는다(아래 "macOS" 절)

## setup-playwright 와 역할 나눔

| 일 | 맡는 스킬 |
|---|---|
| Playwright 패키지 설치, OS 라이브러리(dnf, apt), Xvfb, `PLAYWRIGHT_BROWSERS_PATH` | setup-playwright |
| 이미 있는 Playwright 로 브라우저 빌드 받기(`npx --no-install playwright install <이름>`) | build-testbox `setup` |
| 컨테이너 이미지 받기(Rocky, Playwright 공식 이미지) | build-testbox `setup` |
| 브라우저 행렬과 컨테이너 OS 실행, 판정, 결과 기록 | build-testbox `run` |

- Playwright 패키지가 없으면 브라우저 칸은 `unverified(needs-playwright)` 이고 안내는 setup-playwright 다

## 자리 표시

| 자리 | 뜻 |
|---|---|
| `<S>` | 이 스킬 디렉터리 절대경로(아래 런타임 표) |
| `<out>` | 결과 폴더. 기본 `./.testbox/<UTC 시각>` |

- 명령은 `node "<S>/scripts/testbox.mjs" <detect|run|setup> [인자]` 꼴로 실행한다
- 셸 변수는 도구 호출 사이에 남지 않는다. 명령마다 실제 경로를 적는다

## 런타임 표

| 항목 | Claude Code | Codex |
|---|---|---|
| 스킬 디렉터리 | 스킬 맨 위 "Base directory for this skill:" 경로 | Codex 스킬 목록이 보이는 이 SKILL.md 경로의 폴더. npm 설치는 `~/.codex/skills/banker-build-testbox/`, 플러그인 설치는 `~/.codex/plugins/cache/<마켓플레이스>/banker/<판>/skills/build-testbox/`. 절대경로로 씀 |
| `detect` | 바로 실행 | 엔진 소켓과 브라우저 실행 때문에 승인 요청(아래 승인 표) |
| `run` | 바로 실행 | 승인 요청 |
| `setup` 확인 | `AskUserQuestion` | `request_user_input` |
| `setup --yes` | 확인 뒤 실행 | 확인 뒤 네트워크 승인 요청 |

## 하위 명령

| 명령 | 내용 |
|---|---|
| `detect [--json] [--engine ...] [--os ...] [--image <os>=<이미지>] [--playwright-from-project]` | 호스트 OS, 아키텍처, Apple Silicon 여부, Playwright 위치와 판, 브라우저별 실제 headless 실행 결과(chromium 은 headless shell 과 전체 chromium 을 따로), 엔진(docker 가 podman 에뮬레이션인지), 로컬 이미지 유무(`image inspect`), Tart 와 VM 목록. 내려받지 않음 |
| `run [옵션]` | 브라우저 묶음과 컨테이너 묶음을 병렬 실행. 내려받지 않음 |
| `setup [--images <os,...>] [--browsers <이름,...>] [--playwright-image] [--yes]` | `--yes` 가 없으면 받을 것과 대략 크기만 보이고 종료 0. 이름을 주지 않으면 로컬에 없는 기본 이미지와 빌드가 없는 브라우저가 대상 |

`run` 옵션

| 옵션 | 뜻 | 기본 |
|---|---|---|
| `--url <loopback URL\|파일>` | 브라우저 묶음 대상. 없으면 브라우저 묶음은 요청 안 됨 | 없음 |
| `--browsers chromium,webkit` | 브라우저 거름 | 둘 다 |
| `--devices "<이름>,..."` | Playwright 기기 이름. 기기의 `defaultBrowserType` 으로 돎 | 위 4개 |
| `--browser-in-container` | 브라우저 칸을 `mcr.microsoft.com/playwright:v<호스트 Playwright 판>-noble` 안에서 돌림. http, https URL 만 | 꺼짐 |
| `--os rocky8,rocky9,macos` | 컨테이너와 VM 대상. `none` 이면 컨테이너 묶음을 빼고, 다른 이름은 `--image` 와 함께 | `rocky8,rocky9` |
| `--image <os>=<이미지>` | 이미지 바꾸기. `playwright=<이미지>` 는 `--browser-in-container` 이미지 | rocky8 `docker.io/rockylinux/rockylinux:8`, rocky9 `:9` |
| `--cmd "<명령>"` | 컨테이너 안 `/src` 에서 `sh -c` 로 실행 | `cat /etc/os-release` |
| `--src <dir>` | 컨테이너로 넣을 소스 | 작업 폴더 |
| `--engine auto\|docker\|podman` | `auto` 는 실제 docker, podman, podman 에뮬레이션 docker 순 | `auto` |
| `--network bridge\|none\|host` | 컨테이너 네트워크 | 엔진 기본 |
| `--jobs N`, `--timeout <초>` | 묶음마다 동시 칸 수, 칸마다 시간 제한 | `min(4, CPU 수)`, 300 |
| `--out <dir>` | 결과 폴더 | `./.testbox/<시각>` |
| `--playwright-from-project` | 프로젝트 `node_modules` 의 Playwright(그 프로젝트 코드가 돎) | 꺼짐 |
| `--allow-remote` | loopback 이 아닌 URL 도 엶 | 꺼짐 |
| `--tart-vm <이름>`, `--json` | Tart VM 이름(없으면 첫 로컬 VM), 결과 JSON 한 줄 출력 | 꺼짐 |

- 배포 시험 명령은 사용자가 준다. Rocky 기본 이미지에는 node, npm 이 없다
  - 온라인 예: `--cmd "dnf -y install nodejs && node -v"`(bridge 네트워크와 저장소 미러 필요)
  - 오프라인 예: `--cmd "cat /etc/os-release && rpm -q bash"`
- 컨테이너 칸: `image inspect`(받지 않음), `create`, 소스 사본을 `cp` 로 `/src` 에, `start -a`, 끝나면 `rm -f`. 바인드 마운트는 쓰지 않는다(SELinux 재라벨, Windows 경로 문제)
  - 소스 사본: git 저장소면 추적 파일과 무시되지 않은 새 파일(작업 트리 내용), 아니면 `node_modules`, `.git`, `.testbox` 를 뺀 전부. 결과 폴더는 뺀다
  - 이름은 `banker-testbox-<난수>-<os>`. 시간 초과, SIGINT, SIGTERM, SIGHUP 에서도 지운다
- 브라우저 칸: 브라우저 종류마다 한 번 띄우고 기기마다 새 컨텍스트. 응답 상태, 페이지 오류 수, 콘솔 오류 수, 제목, 스크린숏(`<out>/browser-<기기>.png`). 통과는 응답 2xx 나 3xx(파일 URL 은 응답 없음)이고 페이지 오류 0

## 칸 상태와 사유

| 상태 | 사유 | 뜻과 안내 |
|---|---|---|
| `pass` | | 통과 |
| `fail` | `exit-<n>` | 컨테이너나 VM 안 명령이 0 이 아닌 값으로 끝남 |
| `fail` | `http-<n>` | 응답이 2xx, 3xx 가 아님 |
| `fail` | `page-error` | 페이지가 예외를 던짐, 또는 페이지를 열지 못함 |
| `unverified` | `needs-playwright` | Playwright 패키지 없음. setup-playwright |
| `unverified` | `needs-browser` | 브라우저 빌드 없음. `setup --browsers <이름>` |
| `unverified` | `needs-image` | 로컬 이미지 없음. `setup --images <os>` 또는 `setup --playwright-image` |
| `unverified` | `needs-engine` | docker, podman 없음이나 엔진에 연결 못 함 |
| `unverified` | `needs-network` | `setup` 의 원천에 닿지 못함 |
| `unverified` | `needs-tool` | 컨테이너 안 명령 종료 127(명령 없음). 이미지에 도구를 넣거나 `--cmd` 를 바꿈 |
| `unverified` | `needs-tart` | Apple Silicon Mac 에 Tart 없음 |
| `unverified` | `needs-vm` | Tart VM 없음이나 꺼짐(VM 이미지 약 25GB) |
| `unverified` | `tart-exec-unsupported` | `tart exec --help` 실패. Tart 를 올림 |
| `unverified` | `host-deps` | 브라우저 실행에 필요한 OS 라이브러리 없음(Rocky 8 의 WebKit 등). `--browser-in-container` |
| `unverified` | `launch-failed` | 그 밖의 실행 실패. 로그 확인 |
| `unverified` | `unknown-device` | 이 Playwright 판에 없는 기기 이름 |
| `unverified` | `timeout` | 시간 초과 |
| `unverified` | `sandbox` | 엔진이나 브라우저의 권한 오류(Codex 샌드박스, 소켓 권한). 승인 뒤 다시 |
| `unsupported` | `apple-sla` | 비 Apple 호스트의 macOS. 요구 축소 항목 |
| `unsupported` | `tart-needs-apple-silicon` | Intel Mac 이나 x86_64 macOS 가상 머신. Tart 는 Apple Silicon 전용 |

- `--url` 이 없으면 브라우저 칸은 만들지 않고 요약에 "브라우저 묶음 요청 안 됨" 한 줄을 쓴다(판정에 넣지 않음). `--os none` 도 같은 꼴
- Firefox 기기(`Desktop Firefox`)는 사용 오류다(범위 밖)

## 종료 코드

| 명령 | 코드 |
|---|---|
| `run` | 0 요청한 모든 칸 `pass`, 1 `fail` 1칸 이상, 4 `fail` 없이 `unverified` 나 `unsupported` 1칸 이상, 2 사용 오류, 3 내부 오류나 결과 폴더 쓰기 실패, 129, 130, 143 SIGHUP, SIGINT, SIGTERM(만든 컨테이너를 지운 뒤) |
| `setup` | 0 받고 확인됨(또는 계획만 보임), 1 일부 실패, 4 실패 없이 닿지 못한 원천이 있음("네트워크 필요"), 2 사용 오류 |
| `detect` | 0, 사용 오류 2 |

- 요약 첫 줄: `pass <n>, fail <n>, unverified <n>, unsupported <n>`
- 결과: `<out>/results.json`(칸마다 상태, 사유, 시작과 끝 시각, 로그 경로, 컨테이너 칸은 네트워크 모드), `<out>/summary.md`. 화면에도 같은 표를 낸다

## setup 확인 절차

1. `node "<S>/scripts/testbox.mjs" setup [이름들]` 로 계획을 본다(아무것도 받지 않음)
2. 계획(무엇을, 대략 크기)을 사용자에게 보이고 확인을 받는다. Claude Code `AskUserQuestion`, Codex `request_user_input`
3. 확인을 받으면 같은 인자에 `--yes` 를 붙여 실행한다. Codex 는 네트워크 승인을 요청한다
4. 출력의 `needs-network` 줄과 실패 줄을 그대로 보고한다

| 대상 | 대략 크기 |
|---|---|
| rocky8, rocky9 이미지 | 약 200MB, 약 180MB |
| chromium(headless shell 포함) | 약 280MB |
| webkit | 약 100MB |
| Playwright 공식 이미지(`--playwright-image`) | 약 2GB |

- `--yes` 는 받기 전에 원천마다 15초 안의 확인을 한다. 레지스트리는 `https://<호스트>/v2/`(docker.io 는 `registry-1.docker.io`, loopback 레지스트리는 http), 브라우저는 `PLAYWRIGHT_DOWNLOAD_HOST`(chromium 은 `PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST` 도) 또는 `https://cdn.playwright.dev`. 주소의 사용자 정보는 뗀다. HTTP 답이면 401, 404 도 닿은 것이다
- 닿지 못한 원천의 항목은 받지 않고 `needs-network` 로 남긴다. `CODEX_SANDBOX_NETWORK_DISABLED=1` 이면 "Codex 샌드박스가 네트워크를 막음" 으로 구분한다
- 받는 순서: 이미지(준 순서), 그다음 브라우저. 하나씩 받고, 받을 때마다 `image inspect` 나 실제 headless 실행으로 확인한다
- 브라우저 설치는 `npx --no-install playwright install <이름>` 을 홈 폴더에서 실행한다(`--playwright-from-project` 면 작업 폴더)

## macOS

- 비 Apple 호스트: `unsupported(apple-sla)`. Apple macOS 사용권 계약(SLA)은 이미 macOS 가 도는 Apple 하드웨어에서만 가상 사본(최대 2개)을 허용한다. 비 Apple 호스트용 macOS 컨테이너(dockur/macos 등)는 그 프로젝트 스스로 EULA 위반을 밝히므로 안내하지 않는다
- macOS 지만 Apple Silicon 이 아님: `unsupported(tart-needs-apple-silicon)`. `sysctl hw.model` 은 믿지 않는다. QEMU 위 OpenCore 가상 머신(x86_64)도 `MacPro7,1` 같은 값을 낸다(실측). Apple Silicon 판정은 `process.arch` 가 `arm64` 이거나 `sysctl -n hw.optional.arm64` 가 1(Rosetta 아래 Node)
- Apple Silicon Mac: Tart 없음 `needs-tart`, VM 없음이나 꺼짐 `needs-vm`, `tart exec --help` 실패 `tart-exec-unsupported`, 그 밖은 `tart exec <vm> -- sh -c "<cmd>"`
  - VM 은 사용자가 `tart clone` 으로 받고(약 25GB) `tart run` 으로 켠다. 이 스킬은 VM 을 받거나 켜지 않는다
  - macOS 칸에는 소스 사본을 넣지 않는다. 명령만 돈다
- 사용자 보고(요구 축소): macOS 는 Apple Silicon 호스트의 Tart VM 만 지원하고, 비 Apple 호스트는 라이선스 사유로 `unsupported`. 실제 Safari, iOS 시뮬레이터는 WebKit 에뮬레이션으로 대신한다

## Codex 샌드박스 승인

| 동작 | 이유 | 요청 |
|---|---|---|
| 컨테이너 실행(`detect`, `run`) | 엔진 소켓, rootless podman 의 사용자 네임스페이스 | `sandbox_permissions: "require_escalated"` |
| 브라우저 실행(`detect`, `run`) | 브라우저 프로세스와 네임스페이스 | 같음 |
| 포트 | 시험 대상 서버는 사용자가 띄운 127.0.0.1 포트. 이 스킬은 포트를 열지 않음 | 서버 실행 쪽 승인 |
| 네트워크(`setup --yes`, `--network bridge` 의 명령) | 레지스트리, 브라우저 서버, 컨테이너 안 `dnf` | 같음 |
| 작업 폴더 밖 쓰기 | 소스 사본과 실행기 사본을 OS 임시 폴더에 만듦 | 같음 |
| `--network host` | 그 칸의 네트워크 격리가 풀림. `--browser-in-container` 는 Linux 에서 호스트 loopback 에 닿으려고 이것을 씀 | 같음, 사용자에게 알림 |

- Codex 는 명령 하나씩 승인을 요청한다. `&&` 로 묶지 않는다
- 권한 오류로 끝난 칸은 `unverified(sandbox)` 다. 승인 뒤 다시 실행한다

## 오프라인 동작

- `run`, `detect` 는 내려받지 않는다. 없는 이미지, 브라우저, 엔진은 `unverified` 와 "무엇을 setup 하면 되는지" 로 끝난다
- `setup --yes` 는 원천마다 15초 안에 확인하고, 닿지 못하면 받지 않고 종료 4 와 "네트워크 필요" 로 끝난다

## 함정

- Rocky 8, RHEL 8 은 Playwright 공식 지원 OS 가 아니다. WebKit 은 OS 라이브러리 부족으로 `host-deps` 가 되기 쉽다. `--browser-in-container`(공식 이미지 약 2GB, `setup --playwright-image`)로 돌린다
- `--browser-in-container` 는 호스트 Playwright 패키지와 그것이 의존하는 `playwright-core` 를 `cp` 로 넣는다. 공식 이미지 판은 호스트 Playwright 판과 같아야 한다. Linux 밖에서는 loopback URL 을 `host.containers.internal`(podman)이나 `host.docker.internal`(docker)로 바꿔 연다. 이 경로는 Linux 밖에서 실측하지 않았다
- `--network host` 는 칸의 네트워크 격리를 푼다. `results.json` 의 칸에 네트워크 모드가 남는다
- rootless podman 의 엔진 기본 네트워크는 `bridge` 가 아니라 `slirp4netns` 나 `pasta` 일 수 있다. `results.json` 에는 엔진이 실제로 쓴 모드를 적는다
- docker 명령이 podman 에뮬레이션이면 엔진 이름은 docker 여도 지우기는 `rm -f -t 0`(즉시 종료)를 쓴다
- Node 의 fetch 는 `HTTPS_PROXY` 를 따르지 않는다(Node 24 는 `NODE_USE_ENV_PROXY=1` 일 때만). 프록시만 열린 망에서 `setup` 의 확인이 실패하면 `needs-network` 로 보인다
- `run` 의 기본 결과 폴더 `./.testbox/` 는 작업 폴더 안에 생긴다. git 저장소면 `.gitignore` 에 넣는다

## 출처

- Playwright 브라우저 위치와 `PLAYWRIGHT_BROWSERS_PATH`: https://playwright.dev/docs/browsers
- Playwright 기기 에뮬레이션과 `devices`: https://playwright.dev/docs/emulation
- Playwright 지원 OS: https://playwright.dev/docs/intro , Rocky 8 의 WebKit 라이브러리 부족 보고: https://github.com/microsoft/playwright/issues/11122
- Playwright 공식 이미지: https://playwright.dev/docs/docker
- Rocky Linux 이미지(`docker.io/rockylinux/rockylinux`): https://hub.docker.com/r/rockylinux/rockylinux
- Apple macOS 사용권 계약: https://www.apple.com/legal/sla/ , 비 Apple 호스트 macOS 컨테이너의 EULA 위반 명시: https://github.com/dockur/macos
- Tart 요구 조건(Apple Silicon, macOS 13 이상)과 라이선스: https://tart.run/quick-start/ , https://tart.run/licensing/
