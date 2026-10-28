---
description: "구성요소와 의존성을 여러 개 골라 설치하는 오케스트레이터. 런타임(Node, Python, Java), LSP, tmux, MCP, 샌드박스, OMC, Playwright 등. 권한 확인 끄기는 따로 묻고 기본으로 고르지 않으며, 골라도 실행하지 않고 직접 입력할 명령만 안내."
argument-hint: "[설치할 구성요소 이름. 비우면 여러 개 고르는 목록 표시]"
---

# /banker:setup — 구성요소 설치 오케스트레이터

banker 플러그인이 제공하는 설치 스킬들을 **multi-select**로 골라 실행한다.
기존 스킬들의 OS 의존성(playwright 등)을 해결하기 위함. 답변은 한글(기술 토큰 영문).

## 절차

0. **네트워크 확인**: 항목을 고르기 전에 원천에 닿는지 한 번 본다(curl 은 10초, npm 은 15초 안). 결과는 알림으로만 쓰고, 이것만으로 항목을 건너뛰지 않는다.
   ```bash
   [ "${CODEX_SANDBOX_NETWORK_DISABLED:-}" = 1 ] && echo "Codex sandbox 가 네트워크를 막음(아래 실패는 오프라인이 아님)"
   in15() { "$@" & p=$!; ( sleep 15 && kill "$p" ) > /dev/null 2>&1 & k=$!; wait "$p" 2>/dev/null; r=$?; kill "$k" 2>/dev/null; wait "$k" 2>/dev/null; [ "$r" = 143 ] && echo "15초 안에 끝나지 않아 멈춤(패킷을 버리는 망일 수 있음)"; return "$r"; }
   if command -v npm >/dev/null; then in15 sh -c 'cd ~ && exec npm ping --fetch-retries=0 --fetch-timeout=10000 --no-update-notifier'; else echo "npm 없음(확인하지 못함)"; fi
   curl --ssl-no-revoke -sSI -o /dev/null --connect-timeout 5 --max-time 10 https://github.com
   ```
   - `curl -sSI` 는 머리만 받는다. 확인 줄은 `--ssl-no-revoke` 를 준다. Windows 의 Git Bash curl 도 Schannel 이라, 폐지 목록 서버에 닿지 못하는 망에서 폐지 확인이 실패하면 종료 60 이다(Windows 박스 실측). 다른 curl 은 이 깃발을 받고 무시한다(macOS curl 8.7.1, Rocky 8.10 curl 7.61.1 실측).
   - 둘 다 실패하면 "네트워크가 없거나 막힌 것으로 보임. 항목마다 자기 원천을 다시 확인하고, 닿지 않는 원천에서 받는 단계는 하지 않음" 으로 먼저 알린다.
   - 항목을 건너뛸지는 각 스킬의 0단계가 그 스킬의 원천으로 정한다. 사내 미러만 열린 망(`npm ping` 에 답하지 않는 npm 미러, PyPI 미러)에서도 그 원천을 쓰는 항목은 진행된다. 닿지 않는 원천에서 받는 단계만 "오프라인이라 설치하지 않음(필요한 것: <항목>)" 으로 보고된다.
   - `npm` 이 아직 없으면(새 PC) npm 쪽은 오프라인이 아니라 확인하지 못한 것이다. `setup-node` 가 npm 을 깐 뒤 각 스킬의 0단계가 다시 확인한다.
   - `npm ping` 은 홈 폴더에서 부른다. 지금 폴더에 있는 프로젝트의 `.npmrc` 가 정한 레지스트리와 토큰을 따르지 않게 하려는 것이다.
   - `npm ping` 은 15초 감시(`in15`) 안에서 부른다. 패킷을 버리는 망에서 npm 은 연결에 시간 제한을 두지 않아(`--fetch-timeout` 은 받는 중의 쉼만 잰다) OS 의 연결 재시도가 끝날 때까지 기다린다(Rocky 8.10 실측 130초). 15초 안에 끝나지 않으면 `15초 안에 끝나지 않아 멈춤(패킷을 버리는 망일 수 있음)` 과 종료 143 이다. `--no-update-notifier` 는 npm 이 제 판을 묻는 요청을 하나 더 내지 않게 한다.
   - OS 패키지 관리자(dnf, apt, brew, winget)만 쓰는 단계는 자기 설정의 미러를 쓰므로 이 확인과 관계없이 각 스킬의 규칙대로 시도한다.
     - 패킷을 버리거나 답하지 않는 망에서 dnf 는 저장소마다 약 2분(SYN 을 버리는 망 실측 121초), apt 는 원천마다 약 4분(답하지 않는 원천 실측 247초) 기다린 뒤 실패로 끝난다. 시간 제한은 관리자 설정을 따르므로 이 스킬이 바꾸지 않는다.
     - `apt-get update` 는 받지 못해도 종료 0 이다. 출력의 `W: Failed to fetch` 가 있으면 그 단계를 실패로 보고한다.
   - 내려받기가 없는 항목(`setup-omc-hud`)과 이미 설치된 것의 확인은 그대로 진행한다.
   - Windows PowerShell 에서는 `curl.exe --ssl-no-revoke -sSI -o NUL --connect-timeout 5 --max-time 10 https://github.com` 의 `$LASTEXITCODE` 로 본다. `curl.exe` 는 Windows 시스템 프록시를 따르지 않고 `HTTPS_PROXY` 만 따른다. `--ssl-no-revoke` 는 폐지 목록 서버에 닿지 못하는 망에서 Schannel 의 폐지 확인 실패를 오프라인으로 읽지 않게 한다. 닿는지만 보고 받은 내용은 쓰지 않으므로 이 확인에만 준다. `curl.exe` 가 없으면 `$LASTEXITCODE` 에 앞 명령의 값이 남으므로 `Get-Command curl.exe -ErrorAction SilentlyContinue` 로 먼저 보고, 없으면 확인하지 못한 것으로 적는다. `npm ping` 은 `Push-Location ~; npm ping --fetch-retries=0 --fetch-timeout=10000 --no-update-notifier; Pop-Location` 처럼 홈에서 부르고 돌아온다(돌아오지 않으면 뒤 단계가 프로젝트가 아니라 홈에서 돈다). PowerShell 에는 15초 감시를 두지 않는다(Windows 의 연결 시간 제한은 약 21초로 알려져 있다. 미실측).
   - Codex sandbox 가 네트워크를 막는 모드(기본 `workspace-write`, `read-only`)에서는 `CODEX_SANDBOX_NETWORK_DISABLED=1` 이 서고 확인이 모두 실패한다(curl 종료 7, npm `EPERM`). 블록의 첫 줄이 그렇다고 알린다. 그때는 '오프라인' 이 아니라 'sandbox 가 네트워크를 막음' 으로 보고하고, 승인을 받아 sandbox 밖에서 확인부터 다시 한다. Claude Code sandbox 안(`SANDBOX_RUNTIME=1`)에서는 허용 목록 밖 주소를 sandbox 프록시가 막는다. Windows PowerShell 에서는 `$env:CODEX_SANDBOX_NETWORK_DISABLED -eq '1'` 로 본다.
   - 확인이 실패하면 보고에 그 명령, 종료 코드, stderr 첫 줄을 붙인다(예: `npm error code ETIMEDOUT`, `curl: (28) ...`). 원인을 '오프라인' 하나로 짐작하지 않는다.
   - curl 의 종료 60(인증서 검증 실패)도 오프라인이 아니다. 망은 열려 있고, TLS 를 가로채는 사내 프록시의 인증서를 OS 가 믿지 않는 것이다. '인증서 문제로 설치하지 않음' 으로 보고한다.
   - curl 은 닿는데 npm 만 인증서 오류(`UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `SELF_SIGNED_CERT_IN_CHAIN`, `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`)로 실패하면 망은 열려 있고 npm 이 사내 인증서를 믿지 않는 것이다(npm 은 OS 인증서 저장소를 쓰지 않는다). '인증서 문제로 설치하지 않음' 으로 보고하고 `NODE_EXTRA_CA_CERTS=<사내 CA 파일>` 을 안내한다. Node 24 는 `NODE_OPTIONS=--use-system-ca` 도 된다.
   - 이 실행에서 부르는 스킬의 0단계는 /banker:setup 0단계와 앞 스킬이 이미 돌린 같은 확인 줄(같은 명령과 같은 주소)의 결과를 쓰고 다시 돌리지 않는다. 처음 보는 원천만 새로 본다. 결과는 이 실행 안에서만 쓴다(그 사이 망이 바뀌면 옛 결과일 수 있다). 막힌 망에서 항목마다 같은 확인을 다시 기다리지 않게 하려는 것이다.
1. **선택 받기**: `$ARGUMENTS` 에 컴포넌트명이 명시돼 있으면 그것만 실행(질문 생략).
   비어 있으면 아래를 `AskUserQuestion`(**multiSelect: true**)으로 제시한다(**Codex 런타임엔 AskUserQuestion 이 없으므로 목록을 제시하고 설치할 항목을 사용자에게 물어 받는다**). 항목은 **계층/의존 순서**로 묶여 있으니, 뒤 계층을 고르면 앞 계층 전제를 먼저 채운다:
   - 질문 하나에 선택지는 4개까지다. 5개 이상인 묶음은 두 질문으로 나눈다.
   - 맨 아래 **권한** 항목은 이 다중 선택에 넣지 않고, 그 항목의 규칙대로 따로 묻는다.

   **런타임 (기반 — 먼저)**
   - **setup-node** — nvm + Node 22(winget/nvm-windows). npx 기반 MCP·CLI 전제.
   - **setup-python** — Python 3.11 + pipx + uv(PEP668). `setup-lsp`·`setup-mcp`·`docs-setup` 전제.
   - **setup-java** — JDK 21 + JAVA_HOME(Debian=Adoptium). `setup-lsp` 의 jdtls 요구.

   **개발도구**
   - **setup-lsp** — 언어별 LSP(vtsls·basedpyright·bash·jdtls·spring) + lsp-mcp 브리지. (의존: node·python·java)
   - **setup-tmux** — tmux(Rocky8 3.6a 소스빌드)/psmux(Windows). OMC team·OMX `$team`/HUD 전제.
   - **setup-pwsh** — Windows PowerShell 7 환경($PROFILE UTF-8·Terminal·Git). 비-Windows는 no-op.
   - **setup-mcp** — 공통 MCP 서버(context7·seq-thinking·filesystem·git·fetch). (의존: node·python)
   - **setup-sandbox** — OS별 샌드박스(bubblewrap+userns / AppContainer / Seatbelt) + rust + git safe.directory.

   **프레임워크·플러그인**
   - **setup-omc** — oh-my-claudecode(OMC) 설치/갱신(Codex는 OMX). `all-in-one`·`ultra-chain`·`ultra-init`·`/banker:front-qa` 의존성.
   - **setup-harness-factory** — revfactory/harness(팀 아키텍처 팩토리) 설치+구성+안내(Codex=meta-harness).
   - **setup-insane-search** — insane-search 플러그인(차단 사이트 우회, Claude/Codex 양쪽).
   - **setup-omc-hud** — omc_hud 상태표시줄(래퍼 v4, 스킬에 든 파일로 오프라인 설치).
   - **setup-stitch** — Stitch(디자인 생성) MCP 프록시 등록(RockyLinux8 proxy-script, API key 필요).

   **의존성 라이브러리**
   - **setup-playwright** — Playwright + 브라우저 + Xvfb(RHEL8/Rocky8 폴백). (`ultra-ui-qa`·`audit-web-page`·`play-qa`·`ultra-chain` 의존성)
   - **docs-setup** — arch-diagram·pdf-vision-extract 의존성(python-pptx·pymupdf·plantuml). (의존: python)
   - **motion-graphic-setup** — hyperframes(무료 모션 그래픽 CLI) 전제조건(Node≥22 + ffmpeg → `npx hyperframes`). (`motion-graphic-make` 의존성)
   - **3d-intro-setup** — 3D 인트로용 크레덴셜(Azure gpt-image·Sora-2, 선택 WAN 영상 키 풀)·의존성(Node/ffmpeg) + 무과금 프리플라이트. (`3d-intro-build` 의존성)

   **권한 (주의, 기본 미선택)**
   - **setup-bypass-permissions** — Claude Code 의 기본 권한 모드를 `bypassPermissions` 로 바꿔 모든 세션에서 도구 실행 확인을 끔.
     - 위 묶음과 섞지 않고 단일 선택 질문 하나로 따로 묻는다(`multiSelect: false`). 선택지는 `넣지 않음 (권장)`, `넣기 (위험)` 순서다.
     - 사용자가 이 항목을 직접 고를 때만 넣는다. "전부" 같은 묶음 선택이나 번호 범위에는 들어가지 않는다.
     - 이 스킬은 모델이 호출할 수 없다(`disable-model-invocation`). `넣기` 를 고르면 실행하지 말고, 사용자에게 `/banker:setup-bypass-permissions on` 을 직접 입력하라고 안내한다. Codex 는 `$banker-setup-bypass-permissions`(플러그인 설치면 `$banker:setup-bypass-permissions`)를 직접 부르라고 안내한다.
     - 입력하면 그 스킬이 위험 경고를 보여 주고 한 번 더 확인받는다. 되돌리기는 `off`.

2. **실행**: 선택된 각 항목을 호출한다(미선택은 건드리지 않음). 단 `setup-bypass-permissions` 는 호출하지 않는다(위 권한 항목의 안내만). Claude Code는 `Skill("banker:<name>")`, **Codex 런타임에선 설치된 `banker-<name>` 스킬(플러그인 설치면 `banker:<name>`)을 적용**한다(예: `Skill("banker:setup-node")`).
   - **의존 순서 강제**: 뒤 계층을 고르면 전제 스킬을 먼저 실행한다 — `setup-lsp` 전에 setup-node·setup-python·setup-java; `setup-mcp` 전에 setup-node·setup-python; `docs-setup` 전에 setup-python. 이미 설치돼 있으면 각 스킬이 감지해 skip(멱등).
   - 각 스킬이 OS를 감지해 알맞은 절차로 설치하고 끝에 검증한다. 한 항목이 실패해도 정직히 보고하고 다음 항목 진행.

3. **마무리 보고(한글)**: 설치된 항목·검증 결과·**재시작/reload 필요 여부**.
   - 플러그인 설치(insane-search)는 `/reload-plugins`(Claude) 또는 재시작 후 반영(Codex는 재시작).
   - MCP 추가(stitch)는 세션 갱신 후 연결 확인 — Claude `claude mcp list`, Codex `codex mcp list`.

## 원칙
- 각 설치는 **비파괴·멱등**(이미 설치면 skip).
- 시크릿(API key 등)은 사용자 입력/환경변수로만 — 출력·커밋 금지.
- root 불가/conda 부재 등은 각 스킬의 폴백 경로로 처리(추정 금지, 감지 기반).
