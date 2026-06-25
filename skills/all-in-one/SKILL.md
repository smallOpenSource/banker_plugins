---
name: all-in-one
description: >-
  하나의 작업을 계획→구현→검증 끝까지 자동으로 흘려보내는 오케스트레이션 스킬.
  (1) /oh-my-claudecode:ralplan --deliberate 로 Planner→Architect→Critic 합의 계획을
  수립하고, (2) /oh-my-claudecode:ralph 로 PRD 기반 구현·아키텍트 승인·deslop·회귀까지
  돌린 뒤, (3) playwright로 실제 구동 중인 앱을 라이브 검증한다. "/all-in-one",
  "올인원", "계획부터 검증까지", "ralplan하고 ralph로 구현하고 playwright로 검사",
  "처음부터 끝까지 알아서" 류의 end-to-end 위임 요청에 사용. /all-in-one 호출 자체가
  실행 승인(execution opt-in)이라 계획 단계가 pending에서 멈추지 않고 구현으로 이어진다.
  GLOBAL — playwright 환경·커밋 규약을 하드코딩하지 않고 repo에서 발견한다. 단순 계획만
  원하면 /ralplan, 구현만 원하면 /ralph 를 직접 쓸 것.
---

# all-in-one — 계획→구현→검증 end-to-end 오케스트레이터

> **한 줄**: `/all-in-one <작업>` = `/ralplan --deliberate`(합의 계획) → `/ralph`(PRD 구현+승인+deslop+회귀)
> → **playwright 라이브 검증** 을, 단계 사이의 핸드오프와 실패 루프까지 포함해 끊김 없이 연결한다.

## 언제

- 사용자가 `/all-in-one <작업 설명>` 으로 호출.
- "계획 세우고 구현하고 검증까지 알아서", "ralplan부터 playwright까지" 류 end-to-end 위임.

## 언제 쓰지 말 것

- 계획만 원함 → `/oh-my-claudecode:ralplan` 직접.
- 구현만 원함(계획 이미 있음) → `/oh-my-claudecode:ralph` 직접.
- 일회성 사소한 수정 → 직접 처리(이 무거운 3단 루프 불필요).
- playwright로 검증할 수 없는 작업(런타임/UI 없음) → 3단계를 빌드/테스트 검증으로 대체하고 그렇게 보고.

## 실행 승인 (중요)

`/all-in-one` 호출 자체가 **이번 턴의 명시적 실행 승인**이다. 따라서 1단계 ralplan이 합의(APPROVE)에
도달하면 `pending approval`에서 멈추지 말고 **그대로 2단계 ralph로 진입**한다. 계획과 구현 사이에 사용자
확인을 끼우고 싶을 때만 `--confirm` 을 쓴다.

## 인자

- `/all-in-one <작업 설명>` — 작업 설명이 1단계 ralplan으로 들어간다. 비어 있으면 사용법만 출력하고 정지.
- `--confirm` — 계획 승인 직후 진행/수정/중단을 한 번 묻고 멈출 수 있게 함(기본: 자동 연결).
- `--no-deslop` — ralph의 deslop 패스를 건너뜀(ralph로 그대로 전달).

## 워크플로우

### 0. 파싱 + 컨텍스트 발견
- 인자에서 작업 설명과 플래그를 분리. 설명이 없으면 `/all-in-one <작업 설명>` 사용법만 출력하고 정지.
- repo 규약을 **발견**한다(하드코딩 금지): `CLAUDE.md`·`AGENTS.md`·auto-memory·`scripts/`·기존
  e2e/playwright 스펙·`package.json` 테스트 스크립트. 여기서 **검증 환경**(base URL·테스트 계정·headless
  display·tls 옵션)과 **커밋/브랜치 규약**을 읽어 둔다. 이후 단계에서 이 발견값을 쓴다.

### 1. 계획 — `/ralplan --deliberate`
- `Skill("oh-my-claudecode:ralplan")` 를 `--deliberate <작업 설명>` 인자로 호출.
- Planner→Architect→Critic 합의 루프가 `APPROVE`까지 돈다(deliberate: pre-mortem 3 + 확장 테스트 계획 포함).
- 산출: **테스트 가능한 acceptance criteria를 가진 승인 계획**. 이 AC가 2단계 PRD와 3단계 playwright
  시나리오의 공통 출처가 된다.
- `--confirm` 이면 여기서 AskUserQuestion으로 진행/수정/중단을 한 번 확인. 아니면 곧장 2단계로.

### 2. 구현 — `/ralph`
- 승인된 계획을 ralph에 넘긴다: `Skill("oh-my-claudecode:ralph")`, 인자는 **승인 계획 요약 + "PRD를 이
  계획의 acceptance criteria로 refine하라"** (`--no-deslop` 받았으면 함께 전달).
- ralph가 PRD를 계획 AC로 구체화 → 스토리별 구현·검증 → Step-7 아키텍트 APPROVE → 7.5 deslop →
  7.6 회귀 → Step-8 `/oh-my-claudecode:cancel` 까지 자체 완주.
- ralph의 회귀(7.6)는 보통 unit/build/lint다. **라이브 playwright 검증은 3단계에서 별도로** 한다(사용자 명시).

### 3. 검증 — playwright 라이브
- 0단계에서 발견한 검증 환경으로 **실제 구동 중인 앱**을 검사한다. 계획 AC를 playwright 시나리오로 옮긴다.
- **실제 모델 + 대표 입력으로 재현**한다(편의 모델·빈약 픽스처로 결론 내지 말 것).
- 변경이 화면에 닿았는지 헷갈리면 **fresh-context(서비스워커 없는) 프로브**로 "서버가 고쳐졌나 vs 사용자
  캐시"를 가른다.
- 판정: AC별로 PASS/FAIL을 **증거(셀렉터 단언·콘솔·스크린샷·네트워크)** 와 함께 보고.
- **FAIL이면** 그 결함을 픽스 패스(필요 시 ralph/executor)로 돌리고 재검증 — 유한 횟수 루프 후에도 막히면
  정직하게 보고한다.
- 검증용 throwaway 스펙·`test-results/`·`playwright-report/` 는 **커밋 전에 제거**. 테스트 계정은 새로
  만들지 말고 기존 프로브를 재사용, 만든 대화는 정리.

### 4. 마무리 보고 + 정리
- 무엇을 계획/구현/검증했는지 + 증거를 압축 보고.
- repo 커밋/브랜치 규약대로 마감(0단계 발견값). 규약이 명확하거나 사용자가 요청한 경우에만 커밋/push.
  변경 로그가 있으면 1행 추가.
- 활성 모드 정리: ralph가 Step-8에서 cancel을 돌리지만, 끝에 활성 OMC 모드가 남아 있지 않은지 확인.

## 핵심 핸드오프 (이 스킬의 본질)
- **계획 AC → ralph PRD 스토리 → playwright 시나리오**가 같은 acceptance criteria를 관통해야 한다. 세
  단계가 서로 다른 걸 검증하면 all-in-one이 아니라 분리된 세 작업이 된다.
- 각 단계의 실패 루프를 살려 둔다: 1단계 합의 루프 · 2단계 스토리 루프 · 3단계 fix→reverify 루프.

## 하드 제약
- **검증 신뢰**: headless e2e PASS ≠ 시각/UX 완료. 픽셀·레이아웃·감성은 사용자 실기기 확인 몫임을 보고에
  명시. 단 fresh-context 프로브는 "서버 진실"엔 신뢰 가능.
- **비밀값 금지**: `.env*`·키·DSN·계정 비번은 READ만, 출력·커밋 절대 금지. 검증 env는 발견하되 값은 인용하지 않음.
- **범위 고정**: 작업 설명의 범위만. 3단계가 새 결함을 발견해도 원래 AC 밖이면 별도 follow-up으로 보고(스코프 크리프 금지).
- `/tmp` 하네스·빌드 산출물·throwaway 스펙은 커밋 대상 아님.

## 완료 체크리스트
- [ ] 1단계 ralplan이 APPROVE 도달(합의 계획 + 테스트 가능 AC)
- [ ] 2단계 ralph 완주(스토리 전부 passes · 아키텍트 APPROVE · deslop · 회귀 green · cancel)
- [ ] 3단계 playwright 라이브 검증을 실제 모델+대표 입력으로 수행, AC별 증거 확보
- [ ] throwaway 스펙·test-results·playwright-report 제거, 테스트 계정/대화 정리
- [ ] 시각/UX는 사용자 실기기 확인 몫임을 보고에 명시
- [ ] 활성 OMC 모드 없음

## 프로젝트 오버라이드
특정 repo가 고정 검증 환경/커밋 규약을 가지면 project-level `.claude/skills/all-in-one/SKILL.md` 로 이 global
버전을 덮어쓸 수 있다(예: repo별 변경 로그 위치 + 커밋/브랜치 규약 + base URL·e2e 프로브·headless display 등
검증 env 를 프로젝트 값으로 고정).
