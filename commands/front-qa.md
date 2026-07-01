---
description: "스펙(note 파일) 기반 프론트엔드 구현 + 레퍼런스 구현 대비 엄격 parity QA 워크플로(ralplan→ralph→loop)."
argument-hint: "[스펙/note 파일 경로 — 생략 시 docs/note.txt]"
---

# /front-qa — 스펙 기반 프론트엔드 구현 + 엄격 QA

`$1`(없으면 `docs/note.txt`)의 요구사항을 React 프론트엔드(`$FRONTEND_DIR`, 예: `apps/web`)에 구현하고,
**레퍼런스 구현(reference implementation — 예: 이전 Streamlit/타 빌드)과 엄격 비교 + 스펙 지시 정확 준수**를 검증한다. 모든 항목 해결까지 진행.

## 0. 전제조건: OMC (없으면 설치부터)

이 커맨드는 `/ralplan`·`/ralph` 등 oh-my-claudecode(OMC)에 의존한다. **진행 전 먼저 확인**하고, 없으면 **설치부터 안내**한다:
- 확인: `command -v omc` + `/oh-my-claudecode:*` 사용 가능 여부.
- 미설치면 `/banker:setup` → oh-my-claudecode(또는 `setup-omc` 스킬 / `omc update`)로 먼저 구성한 뒤 이어서 진행.

## 절차 (CLAUDE.md: 계획 없는 즉시실행 금지)

1. **스펙 정독**: 대상 파일을 읽어 요구사항을 항목화. 코드베이스 정찰(병렬 explore/general-purpose 에이전트로
   각 항목의 현재 React 상태 ↔ 레퍼런스 구현 갭을 file:line 증거로 매핑).
2. **`/ralplan --deliberate`**: Planner(정찰 종합)→Architect→Critic consensus(ITERATE 폐루프). Principles/Drivers/
   Options(기각 사유)/pre-mortem/확장 테스트계획(unit·integration·e2e선택·observability)/ADR. 항목을 충돌-안전 순서의
   스테이지로 분해(파일 경합 시 순차, 독립 시 병렬 가능). 계획을 `.omc/plans/`에 저장.
3. **`/ralph --critic=critic`**: 새 feature 브랜치(현 HEAD off). 스테이지별:
   - executor(opus) 위임 구현 + 테스트 작성/수정.
   - 🔴 **orchestrator fresh 재검증**(executor 완료보고 신뢰 금지 — 과거 오보고 사례): typecheck + 관련/전체 vitest.
   - critic(opus) APPROVE까지 ITERATE.
   - 로컬 커밋 + `scripts/parity-gate.sh:TEST_FLOOR` 실측 상향(같은 커밋). dead-code 제거 시 floor 하향도 정당(문서화).
   - 위험 스테이지(env·deps·build·CSS토큰·스키마)는 **전체 parity-gate** 실행.
4. **홀리스틱 리뷰(Step7)**: critic(opus)이 **스펙 N항목 逐条 충족 + 레퍼런스 parity + 교차충돌 0 + 불변 보존**을 검증(충족표).
5. **필수 deslop(Step7.5)**: `ai-slop-cleaner` 변경 파일 범위. dead-code/중복/과추상/장황주석만(맥락 주석 보존). 무변경이면 무변경.
6. **regression(Step7.6)** + `/oh-my-claudecode:cancel`.

## 루프/중단 (사용자 directive)
- **/loop**: 모든 문제 해결까지 진행. credit/llm/token 비용 비고려.
- **중단 조건**: 컨텍스트 85% 도달 OR 작업 완료 → 작업·loop 중단(체크포인트: prd.json·progress.txt·메모리).

## 🔴 불변 제약
- 보안모델: 비밀 서버사이드 주입·VITE_ 비밀 금지·`client.ts` onResponse 인터셉터 금지(openapi-fetch body 1회 소비)·
  `.env`는 gitignore 유지(dist 실토큰 0).
- FSD 단방향(app→pages→widgets→features→entities→shared)·feature↔feature import 0.
- No-mock/하드코딩 금지·env 기반. **백엔드 무수정**(프론트 전용; server/auth BFF는 프론트 코드라 가능).
- 비배포 로컬도구(배포·엔드포인트 RBAC 서버강제 = 비목표). push/머지 = **사용자 통제**(원격 origin은 사용자 설정).
- 답변·문서 한글(기술 토큰 영문).

## 완료 보고
- 스펙 항목별 결과를 **표**(항목/상태/근거 file:line)로 간결히.
- 테스트 수 변화(기준 floor→최종)·각 스테이지 critic 판정·게이트 결과.
- 미충족/수용-범위한정/후속분리 항목 정직 명시.
