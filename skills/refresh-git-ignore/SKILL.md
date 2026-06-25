---
name: refresh-git-ignore
description: "현재 repo의 .gitignore 를 비파괴·반복가능하게 갱신. 미추적 파일을 분류해 '진짜 런타임/빌드 아티팩트'(lock/cache/dump/대용량)만 ignore 규칙에 추가하고, 이미 추적 중인 서브트리와 의도적 tracked 파일(예: 추적 중인 .env·인증서)은 절대 건드리지 않는다(git rm --cached 금지=비파괴). 주석처리된 폐기 blanket 규칙은 정책변경이라 사용자 명시 없이 부활 금지. git check-ignore 로 아티팩트 매치 + 의도적-tracked not-ignored 안전가드 검증. tracked 여부는 'git ls-files <dir>'로 판정(미커밋 콘텐츠 vs 아티팩트 구분). 커밋/푸시는 사용자 'push' 명시 시만. 'refresh-git-ignore' / '.gitignore 갱신·정리' / 'git status 잡음 줄여' / 'gitignore 업데이트' 시 사용."
---

# refresh-git-ignore — .gitignore 안전 갱신

**현재 repo**(cwd, `git rev-parse --show-toplevel`)의 `.gitignore`를 **비파괴·반복가능**하게 갱신하는 워크플로우. 미추적 파일을 분류해 **"진짜 런타임/빌드 아티팩트"만** ignore 규칙에 추가하고, **이미 추적 중인 서브트리·의도적 tracked 파일은 절대 건드리지 않는다**. CLAUDE.md/memory가 "규칙"이라면 이 스킬은 ".gitignore를 깨지 않게 갱신하는 절차".

## When to use
- 사용자가 "/refresh-git-ignore", ".gitignore 갱신/정리", "git status 잡음 줄여줘"를 요청할 때
- 새 도구/세션이 런타임 아티팩트(lock·cache·dump 등)를 남겨 `git status`가 지저분해질 때

## When NOT to use
- 추적 중인 파일을 **추적 해제**(`git rm --cached`)하려는 destructive migration → 이 스킬 아님(사용자 명시 별도 지시 필요)
- 추적 중인 서브트리의 미커밋 콘텐츠를 "치우려는" 목적 → 그건 ignore가 아니라 **커밋** 대상(소유 세션이 커밋). ignore하면 콘텐츠 추적이 끊김

## 고정 정책 (최소·안전)
- 대상: **현재 repo 루트의 `.gitignore` 단독** (`git rev-parse --show-toplevel`로 확인)
- **비파괴**: ignore 규칙 추가만. `git rm --cached` 금지(추적 파일은 ignore해도 안 빠짐 — 추적 해제는 별도 destructive 작업)
- **추가 대상 = tracked 서브트리 밖의 명백한 아티팩트만**(런타임 lock/cache/dump, 빌드 산물, 대용량 바이너리)
- **절대 ignore 금지 = 의도적 tracked 파일**: 일부 repo는 시크릿 `.env*`·인증서 `*.pem` 등을 **의도적으로 git-tracked**로 운영한다. 광역 패턴이 이걸 잡으면 추적이 깨진다 → 먼저 `git ls-files`로 확인.
- 커밋/푸시는 사용자 "push" 명시 시만

## Workflow

### 1. 스캔
- repo 루트 확인: `ROOT=$(git rev-parse --show-toplevel)`
- `git status --porcelain | awk '$1=="??"{print $2}'` → 미추적 전수
- `git status --porcelain --ignored | awk '$1=="!!"{print $2}'` → 이미 ignore된 것(중복 추가 방지)

### 2. 분류 (각 미추적 경로마다 — ★핵심 판정)
- **tracked 서브트리 콘텐츠?** `git ls-files <dir> | wc -l` > 0 이면 그 디렉터리는 **추적 중** → 미커밋분은 **ignore 아님, 커밋 대상**(건너뜀). (예: 상태/계획/스크린샷 디렉터리, QA 노트, 설정/훅 디렉터리)
- **의도적 tracked?** 추적 중인 `.env*`·`*.pem` 등 → **절대 ignore 금지**
- **명백한 아티팩트?**(tracked 서브트리 밖 + 런타임/빌드/대용량) → ignore 후보. 예: `*.lock`, `*.pid`, cache dir, crash dump, `*.zip`, 회전 로그 백업
- 애매하면 ignore 안 함(보수적). 소스/문서일 가능성 있으면 제외하고 리포트에 surface

### 3. 제안 → 적용
- ignore 후보를 패턴으로 묶어(과도한 개별 경로 금지) `.gitignore` 말미에 **날짜+사유 주석과 함께 append**(기존 행 무수정)
- ★append-only: 기존 규칙(특히 주석처리된 blanket 규칙 같은 **폐기된 과거 의도**)을 **되살리지 말 것** — 그건 정책 변경이라 사용자 명시 필요

### 4. 검증 (보고 의무)
- 후보 패턴이 의도대로: `git check-ignore -v <artifact>` = 매치
- ★**안전 가드**: `git check-ignore -q <의도적-tracked>` 가 **전부 not-ignored**여야 함(추적 중인 `.env*`·인증서·대표 tracked 서브트리 파일 1~2건) — 하나라도 ignored면 패턴 과광역 → 즉시 정정
- `git status` 미추적 카운트 감소(해당 아티팩트만; 동시 세션 churn으로 총수 변동은 무시)
- tracked 파일이 새로 ignored 상태로 바뀌지 않음(`git status` M 목록 불변)

### 5. 리포트 (4-field)
변경 파일(.gitignore) / evidence(check-ignore 매치+가드 not-ignored) / 검증(status 비교) / Unknown(애매해서 제외한 항목·정책 분기 필요 항목). 커밋은 "push" 대기 명시.

## ★함정 (실측 기반)
- **tracked vs 미커밋-콘텐츠 혼동**: 추적 중인 서브트리(상태/노트/설정 디렉터리 등)는 git status에 미커밋 파일이 떠도 "ignore할 잡음"이 아니라 "다른 세션의 미커밋 콘텐츠" — ignore하면 추적이 끊겨 콘텐츠 유실 위험. **`git ls-files <dir>`로 tracked 여부 먼저 판정**.
- **폐기 주석 부활 금지**: `.gitignore`에 **주석처리된 blanket 규칙**(예: `#**/state/**`·`#notes/`)은 과거에 시도했다 **의도적으로 비활성**한 정책일 수 있다. 활성화하면 현재 커밋 중인 콘텐츠 추적이 중단됨 → 사용자 명시 없이 부활 금지.
- **의도적 tracked 시크릿/인증서**: 일부 repo는 `.env*`(시크릿 포함)·`*.pem`을 **git-tracked**로 운영(private repo). `*.env*` 광역 패턴은 이걸 잡아 **추적 깨짐** → 확인 없이 금지.
- **ignore ≠ untrack**: 이미 tracked인 파일은 `.gitignore`에 추가해도 계속 추적됨(추적 해제는 `git rm --cached`=destructive, 이 스킬 범위 밖).
- **동시 세션 churn**: 미추적 총수는 다른 세션이 파일 생성/삭제로 실시간 변동 — "내 패턴이 잡은 아티팩트만" 기준으로 검증(총수 delta 신뢰 금지).
- **`git check-ignore` exit code**: 매치=0, 무매치=1 → `&&` 체인에서 무매치가 silent 중단 유발. 가드 루프는 `if git check-ignore -q … ; then BAD; else OK; fi` 형태로.

## 원칙
verify-before-claim · Unknown은 정직하게 표기 · 옵션엔 추천+확신도 동반.
