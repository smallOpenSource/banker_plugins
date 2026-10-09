---
description: "구성요소와 의존성을 여러 개 골라 설치하는 오케스트레이터. 런타임(Node, Python, Java), LSP, tmux, MCP, 샌드박스, OMC, Playwright 등. 권한 확인 끄기는 따로 묻고 기본으로 고르지 않으며, 골라도 실행하지 않고 직접 입력할 명령만 안내."
argument-hint: "[설치할 구성요소 이름. 비우면 여러 개 고르는 목록 표시]"
---

# /banker:setup — 구성요소 설치 오케스트레이터

banker 플러그인이 제공하는 설치 스킬들을 **multi-select**로 골라 실행한다.
기존 스킬들의 OS 의존성(playwright 등)을 해결하기 위함. 답변은 한글(기술 토큰 영문).

## 절차

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
   - **setup-omc** — oh-my-claudecode(OMC) 설치/갱신(Codex는 OMX). `all-in-one`·`ultra-init`·`/banker:front-qa` 의존성.
   - **setup-harness-factory** — revfactory/harness(팀 아키텍처 팩토리) 설치+구성+안내(Codex=meta-harness).
   - **setup-insane-search** — insane-search 플러그인(차단 사이트 우회, Claude/Codex 양쪽).
   - **setup-omc-hud** — omc_hud 상태표시줄(OS별).
   - **setup-stitch** — Stitch(디자인 생성) MCP 프록시 등록(RockyLinux8 proxy-script, API key 필요).

   **의존성 라이브러리**
   - **setup-playwright** — Playwright + 브라우저 + Xvfb(RHEL8/Rocky8 폴백). (`ultra-ui-qa`·`audit-web-page`·`play-qa` 의존성)
   - **docs-setup** — arch-diagram·pdf-vision-extract 의존성(python-pptx·pymupdf·plantuml). (의존: python)
   - **motion-graphic-setup** — hyperframes(무료 모션 그래픽 CLI) 전제조건(Node≥22 + ffmpeg → `npx hyperframes`). (`motion-graphic-make` 의존성)
   - **3d-intro-setup** — 3D 인트로용 크레덴셜(Azure gpt-image·Sora-2, 선택 WAN 영상 키 풀)·의존성(Node/ffmpeg) + 무과금 프리플라이트. (`3d-intro-build` 의존성)

   **권한 (주의, 기본 미선택)**
   - **setup-bypass-permissions** — Claude Code 의 기본 권한 모드를 `bypassPermissions` 로 바꿔 모든 세션에서 도구 실행 확인을 끔.
     - 위 묶음과 섞지 않고 단일 선택 질문 하나로 따로 묻는다(`multiSelect: false`). 선택지는 `넣지 않음 (권장)`, `넣기 (위험)` 순서다.
     - 사용자가 이 항목을 직접 고를 때만 넣는다. "전부" 같은 묶음 선택이나 번호 범위에는 들어가지 않는다.
     - 이 스킬은 모델이 호출할 수 없다(`disable-model-invocation`). `넣기` 를 고르면 실행하지 말고, 사용자에게 `/banker:setup-bypass-permissions on` 을 직접 입력하라고 안내한다. Codex 는 `$banker-setup-bypass-permissions` 를 직접 부르라고 안내한다.
     - 입력하면 그 스킬이 위험 경고를 보여 주고 한 번 더 확인받는다. 되돌리기는 `off`.

2. **실행**: 선택된 각 항목을 호출한다(미선택은 건드리지 않음). 단 `setup-bypass-permissions` 는 호출하지 않는다(위 권한 항목의 안내만). Claude Code는 `Skill("banker:<name>")`, **Codex 런타임에선 설치된 `banker-<name>` 스킬을 적용**한다(예: `Skill("banker:setup-node")`).
   - **의존 순서 강제**: 뒤 계층을 고르면 전제 스킬을 먼저 실행한다 — `setup-lsp` 전에 setup-node·setup-python·setup-java; `setup-mcp` 전에 setup-node·setup-python; `docs-setup` 전에 setup-python. 이미 설치돼 있으면 각 스킬이 감지해 skip(멱등).
   - 각 스킬이 OS를 감지해 알맞은 절차로 설치하고 끝에 검증한다. 한 항목이 실패해도 정직히 보고하고 다음 항목 진행.

3. **마무리 보고(한글)**: 설치된 항목·검증 결과·**재시작/reload 필요 여부**.
   - 플러그인 설치(insane-search)는 `/reload-plugins`(Claude) 또는 재시작 후 반영(Codex는 재시작).
   - MCP 추가(stitch)는 세션 갱신 후 연결 확인 — Claude `claude mcp list`, Codex `codex mcp list`.

## 원칙
- 각 설치는 **비파괴·멱등**(이미 설치면 skip).
- 시크릿(API key 등)은 사용자 입력/환경변수로만 — 출력·커밋 금지.
- root 불가/conda 부재 등은 각 스킬의 폴백 경로로 처리(추정 금지, 감지 기반).
