---
name: motion-graphic-make
description: "(banker) 10초 내외 내레이션 없는 무료 모션 그래픽(킨네틱 타이포·통계·차트·로고·하단자막·지도)을 hyperframes motion-graphics 워크플로에 위임 제작 — 렌더링 로직은 소유하지 않는 얇은 래퍼. 'motion-graphic-make'/'모션 그래픽 만들어줘'/'모션 그래픽 제작'/'motion graphics' 시 사용."
---

# motion-graphic-make — 무료 모션 그래픽 제작 (hyperframes 위임)

짧고(약 10초 내외, 최대 ~30초) 내레이션 없는 디자인-주도 모션 그래픽을 만든다.
이 스킬은 **얇은 래퍼(thin wrapper)** 다 — 실제 창작·렌더링 로직을 전혀 소유하지 않고, hyperframes(Apache-2.0, HeyGen 오픈소스)의 `/motion-graphics` 워크플로에 그대로 위임한다.
전제조건(Node≥22·ffmpeg) 설치는 `motion-graphic-setup` 스킬이 담당한다.
답변은 한글(기술 토큰 영문).

## 0. 전제조건: hyperframes (없으면 설치부터)
이 스킬은 hyperframes CLI 가 설치·정상 동작해야 한다.
**진행 전 가용성을 먼저 확인**하고, 문제가 있으면 **설치부터 안내**한다(추정·임의 재설치 금지):
- 확인: `npx hyperframes doctor`
- 실패/미설치면 먼저 `motion-graphic-setup` 스킬로 설치(Claude Code: `/banker:setup` → motion-graphic-setup / Codex: `banker-motion-graphic-setup`). 설치·검증 후 이 스킬을 이어서 진행한다.

## hyperframes 란 (요약)
hyperframes 는 HTML/CSS + 시크(seek) 가능한 애니메이션(GSAP·CSS·Lottie·Three.js 등)을 결정론적 MP4/투명 오버레이 비디오로 렌더링하는 오픈소스 프레임워크다.
진입점은 `/hyperframes` 라우터다 — 모든 "영상/애니메이션 만들어줘" 요청을 적절한 창작 워크플로로 분기하는 역량 지도다.
이 스킬이 다루는 대상은 그 창작 워크플로 중 하나인 `/motion-graphics` — 짧고 내레이션 없는 디자인-주도 모션 그래픽 하나로 한정된다.
더 길거나·내레이션이 있거나·멀티씬이면 hyperframes 자신이 `/general-video` 등 다른 워크플로로 재라우팅한다(이 스킬이 판단하지 않는다).

## 무료 폼 카테고리 (검색 불필요 · 유료 API 없음)
`asset_needs` 가 비어 있어 사용자가 콘텐츠를 직접 제공하는 6개 카테고리 — 전부 무료로 동작한다.

| 카테고리 | 내용 |
|---|---|
| `kinetic-type` | 문구/제목의 모션 타이포그래피 |
| `stat` | 히어로 숫자 카운트업 + 링 |
| `charts` | 막대/선/원형/레이스 차트 |
| `logo-reveal` | 로고 스팅 / 브랜드 락업 |
| `lower-thirds` | 이름/직함 바, 콜아웃, 소셜 오버레이 |
| `maps` | 지역 하이라이트 · 지점 연결 · 위치 줌 |

검색이 필요한 카테고리(웹페이지/뉴스/트윗/이미지 합성)도 hyperframes 안에 존재하지만, 검색 프로바이더가 없으면 자동으로 asset-free 로 성능이 저하(degrade)한다 — 이 스킬의 초점은 위 6개 무료 폼 카테고리다.
이미지 생성이 필요한 경우에 한해 `GEMINI_API_KEY`/`GOOGLE_API_KEY` 를 선택적으로 쓰며, 없으면 생성 단계를 건너뛸 뿐 실패하지 않는다.

## 이 스킬이 소유하지 않는 것
**GSAP 애니메이션 작성, HTML 컴포지션 코딩, ffmpeg 인코딩, headless Chrome 캡처 — 이 중 어느 것도 이 스킬이 직접 구현하지 않는다.**
전부 hyperframes 자체 서브에이전트(director/builder)와 CLI(`lint`/`check`/`snapshot`/`render`)가 수행한다.
이 규칙을 여기서 재서술하면 hyperframes 본체와 어긋나는 사본이 생긴다 — 정본은 항상 hyperframes 쪽이다.
이 스킬의 역할은 **호출 · 전제조건 확인 · 렌더 승인 게이트 강제**뿐이다.

## 흐름
1. **plan** — 사용자 요청(브리프)을 그대로 hyperframes `/motion-graphics`(필요시 `/hyperframes` 라우터 경유)에 전달한다. 카테고리 자동 분류와 초안 계획은 hyperframes 가 수행한다.
2. **build** — hyperframes 가 카탈로그 블록을 재사용해 컴포지션 HTML 을 만든다(이 스킬의 직접 코드 작성 없음).
3. **lint / check / snapshot** — hyperframes CLI 가 결함을 사전 검출하고, 필요하면 자체 리페어 패스를 한 번 더 돈다.
4. **사용자 승인 게이트** — "미리보기 먼저 볼지, 바로 렌더할지" 하나만 묻는다. 미리보기를 고르면 hyperframes Studio 로 보여주고 다시 같은 질문으로 돌아온다.
5. **render** — **명시적 렌더 승인 이후에만** 실행한다. 불투명 결과는 MP4, 오버레이가 필요하면 투명 webm/mov 로 렌더한다.

**렌더는 사용자의 명시적 승인 없이는 절대 실행하지 않는다** — 승인 전에는 미리보기 단계에서 멈추는 것이 기본값이다.

## 완료 보고
렌더가 끝나면 산출물 경로, 실제 길이(duration), 사용된 컴포지션/프레임 id, 확인에 쓴 스냅샷 시점을 함께 보고한다.
렌더 없이 미리보기에서 멈췄다면, 어디까지 진행됐고 다음에 무엇을 승인하면 렌더로 이어지는지만 짧게 보고한다.
