---
name: ultra-ui-qa
description: "웹 UI를 playwright로 실제 렌더해 디자인 SoT(PDF/스펙)와 1:1 대조 + 내부개념 텍스트 누출 점검(데이터·소스까지 검증, HTTP 200만으로 PASS 금지). 'ultra ui qa'/'UI 대조'/'디자인 PDF와 대조'/'어색한 내용 점검' 시 사용."
---

# ultra-ui-qa — 라이브 UI ↔ SoT 엄격 대조 + 내부개념 누출 점검

웹 앱 프론트엔드를 **실제 브라우저로 렌더링**(playwright)해 디자인 SoT(PDF/스펙)와 1:1 대조하고,
사용자/임원이 볼 필요 없는 **내부개념 텍스트 누출**을 잡아 debug 토글로 게이트하는 UI QA 워크플로우.

## When to use
- "ultra ui qa", "UI 대조", "디자인 PDF와 대조", "내부개념/어색한 내용 점검", "표 title·차트 크기 비교"
- 화면/버튼/기능이 SoT(PDF + spec)대로 구현됐는지 **렌더만이 아니라 데이터·소스까지** 엄격 검사할 때
- 이전 세션/에이전트의 "완료" 주장을 **불신하고 직접 재검증**해야 할 때

## 핵심 원칙 (불변)
1. **렌더만 보지 말고 데이터·소스까지**: HTTP 200·페이지 로드 ≠ 정상. empty/all-zero/fake/stub·백엔드 stub 소스·element-click까지 확인.
2. **넘겨짚기 금지**: 모든 PASS/FAIL은 `file:LINE` 또는 라이브 DOM/스크린샷 증거 동반. 에이전트·이전 세션·commit message 주장도 **직접 재검증**.
3. **verify-before-claim**: "완료" 단어 전 4-field — ① 변경(git diff --stat) ② Evidence(test/exit/output/screenshot) ③ 검증 layer ④ Unknown 명시. ⏳ 검증 task 0개일 때만 "완료".
4. **커밋/푸시는 사용자 "push" 명시 시만.**

## 환경 (대상 앱에 맞게 설정)
- 라이브 FE: `$APP_BASE_URL` (self-signed면 `ignore_https_errors=True`) · 헬스 체크: `$API_BASE/health` 등
- playwright (헤드리스 또는 가상 디스플레이):
  ```
  # 가상 디스플레이가 필요한 환경 예시:
  PLAYWRIGHT_BROWSERS_PATH=$BROWSERS_PATH DISPLAY=$DISPLAY python <script.py>
  ```
  headless=True OK · self-signed면 `new_context(ignore_https_errors=True)` · viewport는 디자인 기준(예: 1680×1050)
- ★**인증 seed (인증 게이트가 있으면 필수)**: 무토큰 navigation → 로그인 월이라 **모든 화면 누출 0·title 0 = false-green**(렌더 0인데 PASS처럼 보임). 반드시 **대상 앱의 인증 방식대로 세션을 seed**한 뒤 probe한다:
  - 앱이 세션/토큰을 localStorage·쿠키 등에 저장한다면, playwright `add_init_script`로 **boot 전 주입**해 인증 상태를 재사용:
    ```
    ctx.add_init_script("localStorage.setItem('<your-session-key>', JSON.stringify(session))")
    ```
  - 실제 토큰 발급/세션 생성 절차는 **대상 앱 문서를 따른다**(이 스킬은 인증 우회 절차를 규정하지 않음).
  - 검산: `body_len`(인증 렌더면 수백자+) & 가시 콘텐츠 존재 → 인증됨 / 매우 짧으면(로그인 월) 미인증.
- 골든: 프로젝트 빌드·테스트(예: `npm run build && npx vitest run`) · 리빌드 시 정적 서버가 새 dist 픽업(해시 변경 → 하드 리프레시)

## SoT 디자인 (PDF/스펙)
- 디자인 SoT가 PDF/이미지면 페이지를 Read(이미지)로 직접 판독. **인용 권위 = 도면에 인쇄된 식별자(헤더/캡션)** — 파일 순번이 아님(순번은 off-by-one 흔함).
- 화면 인벤토리/매핑(스펙·registry)이 있으면 표 title 등 권위값 출처로 사용.

## 워크플로우

### 1. 서비스 + 인증 확인
헬스 엔드포인트 200 + (가상 디스플레이 쓰면) 디스플레이 살아있는지 확인. **그 다음 인증 세션 seed 확보**(환경 §인증 seed) — 미인증이면 전 화면 로그인 월 false-green.

### 2. 내부개념 누출 점검 (사용자가 알 필요 없는 것)
대상 예: 내부 화면코드·`row/case` 태그·breadcrumb 내부경로·유형 코드·dev 주석/라벨 등 **구현 내부용 토큰**.
- 토글 메커니즘(예): 디버그 플래그(localStorage 등)로 `.debug-label` 가시성을 토글하는 CSS 게이트 + 토글 버튼.
- 누출 요소에 `debug-label` 류 클래스 부여(줄 전체) 또는 내부토큰만 `<span class="debug-label">…</span>`. **줄 전체 vs 토큰만은 UI 영향이 크므로 `AskUserQuestion`으로 사용자 확인**(previews 활용).
- 라이브 검증(★세션 seed 선주입 필수): 토글 OFF/ON으로 각각 `inner_text("body")`에 누출 문자열 포함여부 확인(display:none은 inner_text 제외). 화면 전수면 **구조 카운트**(`.debug-label` total/visible)가 needle보다 robust.

### 3. SoT ↔ 라이브 대조 (표 title + 차트 크기)
playwright로 화면별 측정 후, 대응 SoT 페이지(식별자 직접판독)를 Read해 비교:
- **표마다 title**: 패널 heading / 표별 title을 SoT 표 제목과 1:1. registry/spec의 권위값과 대조.
- **꺾은선(line chart)**: viewBox + 렌더 height. **렌더 px height 불변식**이 코드에 리터럴로 강제돼 있으면 그 값을 anomaly로 오판 말 것. 폭 확장에도 렌더 px height 고정이 정상이면 letterbox 없음 확인.
- **세로막대(bar chart)**: **rendered px는 반드시 `getBoundingClientRect`로 측정** — `rect.getAttribute('height')`는 viewBox 좌표라 CSS 스케일과 무관(함정). 막대가 플롯을 채우는지 vs letterbox 축소.
- proportion(aspect)·title 텍스트를 SoT와 대조. SoT가 애매하면 **"확인불가" 정직 표기**(MATCH 단정 금지).

### 4. 결함 처리 분기
- **SoT drift**(틀린 title 등) → 정정.
- **scope-dependent**(특정 조회조건에서만 나타나는 표/요소 — by-design) → **by-design 기록, 수정 X**.
- **geometry trade-off**(차트 크기 vs 무스크롤/라벨겹침 등 이전 사용자 튜닝과 충돌) → **사용자 결정 요청**(AskUserQuestion, 옵션별 preview).

### 5. 함정 (학습됨 — 반드시 확인)
- `preserveAspectRatio` 속성 제거 ≠ meet 제거: **기본값이 `xMidYMid meet`** → 와이드 viewBox는 여전히 스케일다운. 1:1 원하면 box를 viewBox와 동일비율로.
- flex 컨테이너의 **flex-shrink:1**이 svg inline `width:Wpx`를 컨테이너 폭으로 수축 → `flexShrink:0` 필요(가로 스크롤 원할 때).
- 코드만 보고 단정 금지: **수정 후 반드시 라이브 probe로 rendered px 재측정**(코드 수정이 무효였던 것을 probe가 적발한 사례 다수).
- ★**미인증 false-green**: 세션 seed 없이 navigation 하면 로그인 월이라 누출·title·geometry 검사가 전부 0/부재=PASS처럼 보임 — probe 전 세션 seed 필수(환경 §인증 seed). 검산 = `body_len`(수백자)·가시 콘텐츠.
- ★**needle 기반 toggle 검증 stale 주의**: aria-label/문구가 바뀌면 고정 needle이 항상 부재→False라 회귀로 오인. **구조 검증 권장**(`.debug-label` 가시성 카운트: OFF=0 / ON=total).

### 6. 골든 + 완료 보고
프로젝트 빌드·테스트 통과 → 변경 시 FE 리빌드. 4-field self-evidence 첨부 + ⏳=0일 때만 "완료". 사용자 하드 리프레시 확인 요청.

## false-positive 경계 (직접 재검증으로 반증하는 패턴 — 예)
- "라우트 깨짐" 주장 → 실제로는 **미존재 코드**(정상 랜딩으로 리다이렉트)일 수 있음. 라우터 정의 확인.
- "표 누락" 주장 → **scope by-design**(특정 조회조건에서만 표시)일 수 있음.
- "title 틀림" 주장 → 주 heading은 일치하고 **부제**를 오인했을 수 있음(registry 권위값 확인).

## 원칙
verify-before-claim · Unknown 정직 표기 · 렌더 ≠ 데이터.
