---
name: audit-mock
description: "하드코딩·mock/stub·열거형을 read-only 정적 감사로 검출(DB/fetch/LLM 없이 하드코딩 값을 반환하는 stub 적발) — 'audit-mock'/'하드코딩 검출'/'mock·stub 감사'/'SQL 없이 하드코딩 반환' 시 사용."
---

# audit-mock — 하드코딩 / mock·stub / 열거형 read-only 정적 감사

프로젝트 전체(서브앱: backend/frontend/service 등)에서 **하드코딩·mock/stub·열거형(enum/taxonomy)**을 **코드·빌드 무변경(읽기 전용)**으로 검출.
최우선 타깃은 흔한 #1 재발 버그 — **"실 데이터소스(DB SQL / API fetch / DB·LLM await) 호출 없이 하드코딩된
값을 return하는 데이터경로"**(stub). 자격증명 스캔은 범위 제외(`audit-security`가 담당).

## When to use
- "audit-mock", "하드코딩/mock/stub/열거형 검출", "SQL 없이 하드코딩 반환하는 api 찾기", "fake/placeholder 데이터 감사"
- 데이터 경로가 **실 데이터에서 오는지 vs 하드코딩/canned인지** 전수 검증할 때
- 코드·빌드를 건드리지 않고(읽기 전용) **반복 가능하게** 스캔하고 싶을 때
- 이전 세션/에이전트의 "stub 없음" 주장을 **직접 재검증**할 때

## 불변 원칙
1. **read-only**: 소스·`pom.xml`/`.eslintrc`/`pyproject.toml`/CI **일절 무변경**. 규칙·러너·결과는 작업용 디렉터리(예: gitignored `.audit/`)에 격리. ast-grep은 search만(replace 금지).
2. **자격증명 스캔 제외** (audit-security가 담당 — gitleaks/secret 룰 넣지 말 것).
3. **verify-before-claim**: 모든 finding은 `file:LINE`+스니펫 동반. "0건 = clean 보증" **금지** — 구조규칙은 강한 규칙이라 데이터경로 분기 stub을 놓칠 수 있음 → 정밀감사(레인 B) 필수. 완료 전 4-field(① 변경 ② Evidence ③ 검증 ④ Unknown), ⏳=0일 때만 "완료".
4. **TP/FP·verdict 분류**: literal이 **화면코드/단위/컬럼키/SQL fragment/라벨/config**면 `legit-constant`(재flag 금지). **숫자/라벨이 응답 row의 DATA VALUE로** 주입되면 `hardcoded-stub`. 데이터 부재 시 **+0/dummy 발명**이면 `fabricated-fallback`. 순수연산은 `legit-computed`(flag 안 함).

## 환경 (도구 — 대상 박스에 맞게)
- **semgrep**: 격리 venv 권장(`$(command -v semgrep)`). 오래된 glibc 환경(예: RHEL8 glibc 2.28)에선 `manylinux2014` 기반 버전으로 핀(최신 wheel은 glibc 2.29+ 요구로 불가할 수 있음).
- **PMD**: github release `pmd-dist-*-bin.zip`(JVM → glibc 무관, java 필요)
- **ruff**: `$(command -v ruff)`, config 파일 없이 **CLI `--select`**
- **jscpd**: npm 글로벌 (⚠️ **동일언어 한정** — 교차언어 중복은 미탐)
- **ast-grep**: CLI가 `GLIBC_2.29 not found`로 불가하면 **ast-grep MCP** 사용

## 2개 레인

### 레인 A — 빠른 정적 스캔 (반복 가능, 전 앱)
- 규칙(예: `rules/semgrep/{mocking,hardcoding,enum}.yml` + `rules/pmd/ruleset.xml`)으로 스캔. 검증: `semgrep --validate --config <rules>`.
- semgrep(3언어): `mocking`(service-returns-stub-no-query / fe-returns-literal-no-fetch / returns-canned-no-io / msw-outside-tests / 마커), `hardcoding`(url·host·port / magic-number), `enum`(taxonomy naming / enum decl / string-literal union).
- PMD(java): `AvoidLiteralsInIfCondition`·`AvoidDuplicateLiterals`. ruff(py): `PLR2004,S105-107,F841,ERA,T20,B`. jscpd: 동일언어 복붙.
- 결과 집계: `semgrep.json`을 rule·app별 카운트 + 파일에서 실제 라인 read(semgrep `lines`는 미로그인 시 "requires login"으로 가려짐 → 직접 read 보강).

### 레인 B — 정밀 데이터-경로 감사 (멀티에이전트, stub 정조준)
진입점(controller/component/endpoint) → resolver/service/hook → **실 데이터소스 도달 여부** 추적. 각 value-emit을 `data_source × verdict`로 분류. 서브앱별 "실 데이터소스"(예):
| 서브앱 | real-source = | stub = | fabricated-fallback = |
|---|---|---|---|
| **backend** | DB 쿼리(예: `JdbcTemplate.query*`) | @Service가 쿼리 없이 `List.of/Map.of/literal` 반환 | 데이터 부재 시 `NVL(...,상수)` / `+0` 발명 |
| **frontend** | `fetch/axios/useQuery`(BE) | hook/컴포넌트가 인라인 배열·객체를 DATA로 반환·렌더 | API 실패 시 dummy 응답 발명 |
| **service/llm** | `await <db_handler>.*` / `await <api>.*` | 함수가 await 없이 canned dict/list 반환 | 부재 시 그럴듯한 가짜 답변 합성(honest "unavailable"은 OK) |

판정 기준은 **불변 원칙 4**와 동일. 산출물은 `git diff`가 아니라 **source read 기반 정적 감사** — "code가 쿼리를 친다 ≠ 런타임에 non-empty 데이터를 낸다"는 **라이브 검증(예: `ultra-ui-qa`)** 영역으로 분리 명시.

## verdict taxonomy (재flag 금지 경계)
- `real-data`(실 소스 결과) · `legit-computed`(caller 공급값 순수연산, DB-free 정당) · `legit-constant`(화면코드·단위·컬럼키·SQL fragment·축/라벨·error code·infra config) — **모두 정상, stub으로 오인 금지**.
- `hardcoded-stub`(가짜 데이터 행) · `fabricated-fallback`(가짜 +0/dummy/순위 발명) — **실제 결함**.
- `needs-review` — literal이 row value로 흐르나 상수/데이터가용성으로 추정되는 경계 케이스. 사람/런타임 확인.

## 산출물 / 리포트 컨벤션
- 리포트 구조: TL;DR 분류표 → 🔴 확정 결함(없으면 영역별 clean evidence 명시) → 🟡 needs-review → 🟢 정당(재flag 금지 목록) → 커버리지(read/미read honest scope) → 재현 → 한계/Unknown.

## 함정 (학습됨 — 반드시 확인)
- **"구조규칙 0건 ≠ clean"**: 구조 stub 규칙은 엄격해 0건이어도 데이터경로 특정 분기 stub은 레인 B로만 잡힘.
- **FP 경계**: url/host가 **주석**이면 코드 하드코딩 아님(FP). input `placeholder=`(UI)·가드 주석은 오히려 anti-stub(FP). `default="dummy"`(키 자리표시) 저위험.
- **legit vs stub**: 문자열 union(`type X='a'|'b'`)·`List.of(라벨)`·단위 스케일(`1e8`)·SQL fragment는 `legit-constant`. 같은 라벨이 여러 서브앱에 **교차언어 중복**이면 jscpd 미탐 → semgrep enum 인벤토리 cross-ref.
- **fabricated-fallback**: SQL `NVL(컬럼, 2)`처럼 부재 시 그럴듯한 상수를 발명하면 honest-gap(`NULL`)보다 위험.
- **에이전트 cd 잔재**: 워크플로우 에이전트가 서브폴더로 `cd`하면 그 폴더에 state 디렉터리가 생길 수 있음 → 감사 후 정리(소스트리 clean 유지).
- **정적 한계**: "쿼리가 런타임에 실제 데이터를 반환"은 미검증 → 라이브 QA로 보완.

## 원칙
verify-before-claim · Unknown 정직 표기.
