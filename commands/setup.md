---
description: banker 플러그인 구성요소·의존성 설치 (multi-select). playwright·omc-hud·insane-search·stitch-proxy 중 골라 설치.
argument-hint: "[설치할 컴포넌트명 — 비우면 multi-select 표시]"
---

# /banker:setup — 구성요소 설치 오케스트레이터

banker 플러그인이 제공하는 설치 스킬들을 **multi-select**로 골라 실행한다.
기존 스킬들의 OS 의존성(playwright 등)을 해결하기 위함. 답변은 한글(기술 토큰 영문).

## 절차

1. **선택 받기**: `$ARGUMENTS` 에 컴포넌트명이 명시돼 있으면 그것만 실행(질문 생략).
   비어 있으면 아래 4개를 `AskUserQuestion`(**multiSelect: true**)으로 제시한다:
   - **setup-playwright** — Playwright + 브라우저 + headless 디스플레이(Xvfb). RHEL8/Rocky8 등 비공식 지원·non-root·no-conda 폴백 포함. (`ultra-ui-qa`·`audit-web-page`·`game-qa` 의존성)
   - **setup-omc-hud** — omc_hud 상태표시줄 설치(OS별).
   - **setup-insane-search** — insane-search 플러그인(차단 사이트 우회) 설치.
   - **setup-stitch-proxy** — Stitch(디자인 생성) MCP 프록시 등록(API key 필요).

2. **실행**: 선택된 각 항목의 스킬을 `Skill` 도구로 호출한다(미선택은 건드리지 않음):
   - setup-playwright → `Skill("banker:setup-playwright")`
   - setup-omc-hud → `Skill("banker:setup-omc-hud")`
   - setup-insane-search → `Skill("banker:setup-insane-search")`
   - setup-stitch-proxy → `Skill("banker:setup-stitch-proxy")`
   각 스킬이 OS를 감지해 알맞은 절차로 설치하고 끝에 검증한다. 한 항목이 실패해도 정직히 보고하고 다음 항목 진행.

3. **마무리 보고(한글)**: 설치된 항목·검증 결과·**재시작/reload 필요 여부**.
   - 플러그인 설치(insane-search)는 `/reload-plugins` 또는 재시작 후 반영.
   - MCP 추가(stitch)는 세션 갱신 후 `claude mcp list` 로 연결 확인.

## 원칙
- 각 설치는 **비파괴·멱등**(이미 설치면 skip).
- 시크릿(API key 등)은 사용자 입력/환경변수로만 — 출력·커밋 금지.
- root 불가/conda 부재 등은 각 스킬의 폴백 경로로 처리(추정 금지, 감지 기반).
