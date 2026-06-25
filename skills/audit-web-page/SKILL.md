---
name: audit-web-page
description: >
  가동 중인 웹 페이지를 playwright(번들 chromium·Xvfb)로 라이브 점검한다. 버튼/내비
  동작·DOM 바인딩·콘솔 에러·그리고 ★Phaser/WebGL 캔버스 비주얼(렌더·글로우·애니메이션)을
  실제 브라우저에서 검증하고, 스크린샷을 직접 읽어 육안 판정한다. "audit-web-page",
  "라이브 웹 검증", "playwright로 페이지 점검", "화면 실제로 동작하는지 확인", "캔버스/WebGL
  렌더 확인" 류 요청에 사용. 검증된 playwright 구성(브라우저 경로·가상디스플레이·
  swiftshader·HTTPS 무시)을 제공한다. headless e2e PASS ≠ 픽셀 완성이므로 시각 판정은
  스크린샷 Read로 직접 한다.
---

# audit-web-page — 라이브 웹 페이지 점검 (playwright)

가동 중인 웹앱을 **실제 브라우저로** 점검한다: 버튼·내비·폼 동작, DOM 바인딩, 콘솔 에러,
그리고 jsdom이 못 보는 **WebGL/Canvas 비주얼**(Phaser 맵·스프라이트·글로우·애니메이션)을
스크린샷으로 캡처해 **직접 Read로 육안 판정**한다. unit/build 게이트로 대체 불가능한
"진짜 화면이 동작/렌더하는가"를 확증하는 마지막 검증 레인.

## 언제

- 사용자가 `audit-web-page` 또는 "라이브로 점검/검증", "playwright로 화면 확인" 요청.
- ralph/all-in-one 등 구현 후 **라이브 검증 단계**(빌드·unit 통과 ≠ 시각 완성).
- 캔버스/WebGL(Phaser·three.js·pixi) 렌더·애니메이션처럼 DOM 단언으로 못 잡는 비주얼 확인.

## 언제 쓰지 말 것

- 순수 로직/DOM은 unit(vitest/RTL)이 더 빠르고 결정론적 — 그걸 먼저.
- 앱이 가동 중이 아니면(서버 down) 먼저 기동하거나 fresh-context curl 프로브로 대체.

## ★검증된 실행 구성 (예시 — 대상 환경에 맞게 설정)

```
브라우저:   $PLAYWRIGHT_BROWSERS_PATH     (번들 chromium·재설치 금지)
가상디스플레이: DISPLAY=$DISPLAY           (Xvfb 등 가상 디스플레이, 예: 1920x1080x24 +GLX)
python:     playwright sync_api 설치된 python
실행 가드:  timeout/메모리 가드로 감싸 실행 (예: timeout <sec> env … python harness.py)  (hang 가드)
```

launch 옵션(★중요·시행착오로 확정):
- `headless=True` + `args=["--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader","--no-sandbox"]`
  → **WebGL 캔버스가 렌더된다.** Xvfb mesa(GLX)만으로 headed 실행하면 Phaser 렌더타깃에서
  `Framebuffer status: Incomplete Attachment`가 떠 **캔버스가 검정**으로 나온다(앱 버그 아님·소프트GL 한계).
  swiftshader(ANGLE)를 강제해야 프레임버퍼가 완성된다.
- context는 `ignore_https_errors=True`(자체서명/호스트 불일치 cert — 예: cert는 `app.example.com`인데
  127.0.0.1로 접속). wss(WebSocket TLS)도 이 옵션이 덮는다.
- ★**`wait_until="networkidle"` / `wait_for_load_state("networkidle")` 금지**: SSE(`/events/stream`)·
  WebSocket(`/ws`) 영속 연결 앱은 네트워크가 영원히 idle이 안 돼 타임아웃난다. `domcontentloaded`
  + 명시 `wait_for_selector`/`wait_for_timeout`로 안정화하라.

## 절차

0. **발견**: 대상 URL·가동 포트(`ss -ltnp`)·서빙 번들이 최신인지(curl로 index 해시 == 로컬 빌드)
   ·HTTPS/cert·이벤트 구동에 백엔드(worker 등)가 필요한지. "서버 진실" 프로브:
   `curl -ks <url>/assets/index-*.js | grep -F "<신규 기능 마커>"`로 배포가 변경을 담았는지 확인(브라우저 불요).
1. **하니스 작성**: `harness.py`(이 스킬 디렉터리)를 복사/수정. ★모든 `wait_*`에 timeout, 모든 루프에
   deadline 바운드(hang 가드). 구조화 PASS/FAIL 출력. 스크린샷은 `OUT` 디렉터리에 저장.
2. **콘솔/네트워크 수집**: `page.on("console")`·`page.on("pageerror")`. 단, **favicon.ico 404는 무해**
   (앱 미동봉 자동요청). `Framebuffer Incomplete`는 위 swiftshader로 해소.
3. **DOM 점검**: testid/role/text로 버튼 클릭→상태 전환·바인딩 단언(playwright 동기 API).
4. **★캔버스 비주얼 점검**(WebGL): `canvas` 요소 스크린샷(`locator("canvas").screenshot`)으로 고해상 캡처.
   - 색/글로우/애니메이션은 **PIL로 정량 분석**(PIL 설치된 별도 python 환경 —
     playwright env엔 PIL 없을 수 있음). `Image.get_flattened_data()`로 픽셀 스캔.
   - **틴트 글로우 검출**: Phaser `setTint(0xRRGGBB)`는 곱연산(텍스처색×틴트)이라 순수색이 아니라
     "해당 채널 우세"(예 green 틴트=g가 r·b보다 우세). idle vs 활성 프레임의 해당-색-우세 픽셀 수 비교.
   - **줌/배경 혼입 주의**: 줌 레벨이 다르면 비교 무효(배경 화분 등 자연색 혼입). **동일 줌 프레임 간
     `ImageChops.difference`로 변화영역(bbox)을 격리** → 그 영역만 크롭(NEAREST ×4~5 확대)해서 Read로 육안 확인.
5. **★육안 판정**: 핵심 스크린샷(전체·크롭)을 **Read 도구로 직접 본다**. headless PASS는 픽셀 완성을 보장
   안 함 — 레이아웃/색/감성은 사람(또는 이 단계의 모델 Read) 판정. 변화 격리 크롭이 가장 확실.
6. **라이브 이벤트 비주얼**(글로우/실시간): 이벤트 구동 UI는 백엔드가 실제로 일을 해야 보인다.
   - 워커/잡이 멈춰 있으면(승인 인터럽트 등) **풀어준다**: 외부발작용 없는 방향으로(예 이메일 승인은
     **reject**=발송0). `ctx.request.post(.../reject)`로 큐를 돌려 연속 캡처.
   - ★swiftshader는 `display:none`→재표시 시 프레임버퍼가 다시 incomplete해진다 → **캡처 중 캔버스를
     숨기는 섹션 전환 금지**(맵이 계속 보이는 화면에 머문 채 캡처).

## 하드 제약 (안전)

- 무거운/장시간 실행은 timeout/메모리 가드 경유. 모든 wait timeout·모든 루프 deadline 바운드.
- **`pkill -f` 금지**(자기매칭 자해)·타 프로세스 불침해. 브라우저는 스크립트 끝에서 `browser.close()`.
- 브라우저/패키지 **재설치 금지**(이미 설치된 playwright env·브라우저 사용). `playwright install` 호출 금지.
- 비밀값(.env·cert 키) READ만·출력 금지. 검증용 throwaway 스크립트/스크린샷은 커밋 대상 아님(`/tmp`).
- 라이브 상태를 바꾸는 액션(잡 트리거·인터럽트 resolve)은 **되돌릴 수 있고 외부발작용 없는 방향**으로만.

## 산출/보고

- AC별 PASS/FAIL + 증거(셀렉터 단언·콘솔·스크린샷 경로). 캔버스 비주얼은 정량(픽셀) + 육안(Read) 둘 다.
- 시각/감성은 사용자 실기기 확인 몫임을 명시(단 fresh-context·diff 격리는 "서버/렌더 진실"엔 신뢰 가능).

참고 하니스: 이 디렉터리의 `harness.py`(파라미터: 환경변수 `AUDIT_URL`·`AUDIT_OUT`).
