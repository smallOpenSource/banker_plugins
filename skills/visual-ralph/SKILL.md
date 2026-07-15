---
name: visual-ralph
description: "(banker) 프론트엔드 UI를 레퍼런스(생성/정적/라이브 URL) 기준으로 측정 빌드: ralph 구현→Visual Verdict(≥90)+픽셀 diff 반복→재사용 디자인 시스템. 'visual-ralph'/'비주얼 랄프'/'UI 클론'/'레퍼런스대로 구현' 시 사용."
---

# visual-ralph — 측정 기반 비주얼 빌드 루프

사용자가 프론트엔드 UI를 **주관적 서술이 아니라 측정된 반복**으로 구현/리스타일하려 할 때 쓴다:
승인된 레퍼런스(생성 이미지 / 정적 이미지 / 라이브 URL 파생)를 타깃으로 삼아 `ralph` 가 구현하고,
**Visual Verdict** 점수가 이터레이션을 이끈다. (OMX `visual-ralph` 를 banker 로 이식 — 양 런타임 제공.)

이건 **오케스트레이션 스킬**이다. 기존 스킬을 조합할 뿐, 자체 런타임 명령·의존·앱 가정을 더하지 않는다.

**런타임 매핑 (Claude Code ↔ Codex).** 흐름은 동일하나 호출 대상이 런타임별로 다르다:

| 단계 | Claude Code (OMC) | Codex (OMX) |
|---|---|---|
| 구현 루프 | `Skill("oh-my-claudecode:ralph")` | OMX `$ralph` |
| 비주얼 판정 | `Skill("oh-my-claudecode:visual-verdict")` | OMX Visual Verdict |
| 이미지 이해 | **Read 툴 네이티브**(이미지 직접 판독) | `vision` 에이전트 |
| UI 레퍼런스 생성 | **Stitch**(`/banker:setup-stitch` MCP UI-gen); 없으면 **정적/라이브 URL 레퍼런스**로 폴백(생성 불요) | `$imagegen` + `omx imagegen continuation`(Stop-hook 큐) |
| 아티팩트/상태 경로 | `.omc/artifacts/visual-ralph/<slug>/` | `.omx/artifacts/visual-ralph/<slug>/` · `.omx/state/sessions/` |

생성 레퍼런스 경로가 양쪽 다 없으면(imagegen 부재) → **정적 레퍼런스 이미지나 라이브 URL을 요구**한다
(생성 없이도 루프는 성립한다). 라이브 URL 클론은 이 스킬이 흡수한다(구 `$web-clone` 미사용).

## Purpose

`사용자 서술 / 라이브 URL → 승인된 비주얼 레퍼런스 → ralph 구현 → Visual Verdict + 픽셀 diff → 재사용 디자인 시스템`.

## 언제 쓰나
- 원하는 web/app UI를 서술하고 **조언이 아니라 구현**을 원할 때.
- 라이브 URL을 주고 측정된 Visual Verdict 반복으로 구현/클론하려 할 때.
- 픽셀 수준 반복 + pass/fail 임계(≥90)가 필요할 때.
- 결과가 일회성 스샷 매치가 아니라 **재사용 토큰/컴포넌트**를 남겨야 할 때.

## 쓰지 않을 때
- repo 전반 디자인 가이드/`DESIGN.md` 소스만 원할 때 → designer 레인.
- UI 레퍼런스 타깃이 없는 비주얼-무관 백엔드/API.
- 최종 정적 레퍼런스를 이미 갖고 비교·수정만 필요 → 바로 `ralph` 에 Visual Verdict 지침과 함께 위임.

## 워크플로

### 1. 대상 repo 그라운딩
스택 선택 전 로컬 증거 확인: 패키지 매니저·스크립트, 프론트 프레임워크·라우팅, 스타일 시스템·디자인
토큰 규약, 스샷/테스트 툴링, 재사용할 기존 컴포넌트. **React/Vue/Tailwind/Playwright 등을 repo 증거
없이 하드코딩 금지.**

### 2. 비주얼 레퍼런스 확립
- **라이브 URL**: URL 파생 레퍼런스를 아티팩트에 기록 + viewport·콘텐츠 상태·인터랙션 제약 반영.
  포함: 소스 URL·권한/범위 노트, viewport·route/state·seed/login 가정, 캡처 스샷 경로/명령,
  가시 컨트롤 인터랙션 패리티, 알려진 제외(백엔드/auth·개인화 데이터·멀티페이지 크롤·서드파티 위젯).
- **생성 레퍼런스**: 위 런타임 매핑의 imagegen 경로로 UI 서술에서 생성. 프롬프트 요건: `ui-mockup`
  분류, viewport/종횡비·대상 표면, 레이아웃·계층·타이포·컬러 무드·정확한 텍스트, 로고/워터마크 금지,
  불가능한 UI 디테일·판독불가 텍스트 회피.
  - Codex 런타임에서 활성 Ralph 루프 중 내장 이미지 툴 호출 전엔 continuation 체크포인트를 큐잉:
    `omx imagegen continuation <session> --artifact <slug> --generated-dir "$CODEX_HOME/generated_images/<session>" --work-dir ".omx/artifacts/visual-ralph/<slug>"`
    (내장 이미지 생성이 턴을 즉시 종료할 수 있어, 다음 Stop 체크포인트가 아티팩트 회수·QA를 재개.)
- 승인된 레퍼런스는 **워크스페이스로 복사**한다(예: `.omc/artifacts/visual-ralph/<slug>/reference.png`).
  생성 디렉터리에만 두지 말 것.

### 3. 명시적 사용자 승인 (필수 게이트)
레퍼런스 생성/캡처 후 **멈추고** 한 장의 레퍼런스 이미지/상태를 승인받거나 재생성/조정 요청을 받는다.
승인 전: 구현 시작 금지·`ralph` 호출 금지·러프 이미지를 최종 취급 금지. 승인 후 그 이미지/URL 파생
베이스라인이 **비주얼 진실원본**이 된다(방향 전환·레퍼런스 교체는 명시 요청 필요).

### 4. `ralph` 에 구현 위임
승인 레퍼런스 경로/URL 베이스라인, (URL 태스크면)소스 URL·viewport·상태·인터랙션 패리티, 사용자 서술,
탐지한 repo/프론트 컨텍스트, 정확한 스샷 명령/viewport, 아래 완료 체크리스트를 넘긴다. ralph 는 승인 후
자율 반복(코드 편집→앱 실행→스샷→개선)한다.

### 5. 매 편집 전 Visual Verdict
이터레이션마다: (1) 현재 스샷을 기록된 viewport/state로 캡처 → (2) 승인 레퍼런스 vs 생성 스샷을
**Visual Verdict**(Claude=`visual-verdict` 스킬, Codex=OMX Visual Verdict; 이미지 이해는 위 매핑)로
비교 → (3) JSON 판정을 권위로 취급 → (4) `score < 90` 이면 `differences[]`·`suggestions[]` 를 다음
편집 계획으로 → (5) 다음 편집 전 재실행. 판정 형태: `score·verdict·category_match·differences[]·suggestions[]·reasoning`.

### 6. 픽셀 diff는 2차 증거로만
매치 진단이 어려울 때만 픽셀 diff/오버레이로 핫스팟 국소화. Verdict를 대체하지 않는다. 최종 diff 증거는
레퍼런스/스샷 아티팩트와 함께 감사 가능하게 기록.

### 7. 재사용 디자인 시스템 구축
비주얼 매치를 **repo 네이티브 재사용 아티팩트**(CSS 변수·테마 토큰·Tailwind config·컴포넌트 variant·
Storybook·DESIGN.md 정렬 등)로 인코딩해야 완료다. 최소 캡처: 컬러·간격 스케일·타이포 스케일/웨이트·
radii·shadow/elevation·핵심 컴포넌트 variant/state. 기존 토큰/컴포넌트 패턴 우선(새 디자인 레이어 신설 금지).

## 완료 체크리스트
- [ ] 승인 레퍼런스(이미지/URL 파생 아티팩트)가 워크스페이스에 저장됨.
- [ ] 스샷 재현 명령·viewport·route·seed/state·출력 경로 문서화.
- [ ] Visual Verdict 최종 score `≥ 90`(승인 레퍼런스 대비).
- [ ] 픽셀 diff/오버레이 2차 증거 기록.
- [ ] 디자인 시스템 토큰/컴포넌트가 repo 네이티브·재사용 가능.
- [ ] build/lint/test(또는 repo 등가 검증) 통과.
- [ ] 레퍼런스 승인 후 미승인 방향전환 없음.
- [ ] 남은 비주얼 차이는 근거와 함께 명시.

## 핸드오프 템플릿
```text
ralph "승인된 프론트 레퍼런스를 구현하라.
Reference: <워크스페이스 레퍼런스 이미지/URL 파생 아티팩트>
Source URL(URL 파생 시): <url·권한/범위 노트>
Viewport/콘텐츠 상태: <viewport·route/state·seed/login 가정>
인터랙션 패리티: <가시 컨트롤·제외 항목>
Route/표면: <route 또는 컴포넌트>
스샷 명령: <명령·viewport>
매 편집 전 Visual Verdict 사용; pass 임계 score ≥ 90.
픽셀 diff는 2차 디버그 증거로만.
컬러·간격·타이포·radii·shadow·핵심 variant 재사용 토큰/컴포넌트 추출.
완료 전 build/lint/test 실행.
명시 요청 없인 방향전환 금지."
```
(Claude=`Skill("oh-my-claudecode:ralph")`, Codex=`$ralph` 에 위 지침 전달.)

## 함정
- **승인 게이트 스킵 금지** — 러프 이미지를 진실원본으로 굳히면 방향이 틀어진다.
- Visual Verdict를 픽셀 diff로 대체하지 말 것(diff는 국소화 보조).
- 생성 레퍼런스를 워크스페이스로 복사 안 하면 유실(생성 디렉터리 휘발).
- imagegen 경로 부재를 무시하고 진행 금지 — 정적 레퍼런스/라이브 URL로 폴백하라.

ARGUMENTS: [UI 서술 / 라이브 URL / 레퍼런스 경로]
