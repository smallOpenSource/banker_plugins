---
name: motion-graphic-make
description: "10초 안팎의 내레이션 없는 모션 그래픽(키네틱 타이포, 차트, 로고, 지도 등)을 hyperframes 워크플로로 유료 API 없이 만듦. 계획 승인, 스냅숏과 렌더의 검토 페이지 판정, 독립 검증을 거치며 사이트 배치는 선택. 렌더링은 hyperframes 가 하고 이 스킬은 얇은 래퍼. 'motion-graphic-make'/'모션 그래픽 만들어줘'/'모션 그래픽 제작'/'motion graphics' 시 사용."
---

# motion-graphic-make - 무료 모션 그래픽 제작 (hyperframes 위임)

짧고(약 10초 내외, 최대 ~30초) 내레이션 없는 디자인 주도 모션 그래픽을 만든다.
이 스킬은 **얇은 래퍼(thin wrapper)** 다. 실제 창작, 렌더링 로직을 소유하지 않고, hyperframes(Apache-2.0, HeyGen 오픈소스)의 `/motion-graphics` 워크플로에 그대로 위임한다.
전제조건(Node>=22, ffmpeg) 설치는 `motion-graphic-setup` 스킬이 담당한다.
답변은 한글(기술 토큰 영문).

## 0. 전제조건: hyperframes (없으면 설치부터)
이 스킬은 hyperframes CLI 가 설치, 정상 동작해야 한다.
**진행 전 가용성을 먼저 확인**하고, 문제가 있으면 **설치부터 안내**한다(추정, 임의 재설치 금지):
- 확인: `npx hyperframes doctor`
- 실패/미설치면 먼저 `motion-graphic-setup` 스킬로 설치(Claude Code: `/banker:setup` 에서 motion-graphic-setup / Codex: `banker-motion-graphic-setup`). 설치, 검증 후 이 스킬을 이어서 진행한다.
- 독립 검증에서 배치한 페이지를 잴 때는 Playwright 가 필요하다(`setup-playwright`).

## hyperframes 란 (요약)
hyperframes 는 HTML/CSS + 시크(seek) 가능한 애니메이션(GSAP, CSS, Lottie, Three.js 등)을 결정론적 MP4/투명 오버레이 비디오로 렌더링하는 오픈소스 프레임워크다.
진입점은 `/hyperframes` 라우터다. 모든 "영상/애니메이션 만들어줘" 요청을 적절한 창작 워크플로로 분기하는 역량 지도다.
이 스킬이 다루는 대상은 그 창작 워크플로 중 하나인 `/motion-graphics` 로 한정된다. 짧고 내레이션 없는 디자인 주도 모션 그래픽 하나다.
더 길거나, 내레이션이 있거나, 멀티씬이면 hyperframes 자신이 `/general-video` 등 다른 워크플로로 재라우팅한다(이 스킬이 판단하지 않는다).

## 무료 폼 카테고리 (검색 불필요, 유료 API 없음)
`asset_needs` 가 비어 있어 사용자가 콘텐츠를 직접 제공하는 6개 카테고리다. 전부 무료로 동작한다.

| 카테고리 | 내용 |
|---|---|
| `kinetic-type` | 문구/제목의 모션 타이포그래피 |
| `stat` | 히어로 숫자 카운트업 + 링 |
| `charts` | 막대/선/원형/레이스 차트 |
| `logo-reveal` | 로고 스팅 / 브랜드 락업 |
| `lower-thirds` | 이름/직함 바, 콜아웃, 소셜 오버레이 |
| `maps` | 지역 하이라이트, 지점 연결, 위치 줌 |

검색이 필요한 카테고리(웹페이지/뉴스/트윗/이미지 합성)도 hyperframes 안에 존재하지만, 검색 프로바이더가 없으면 자동으로 asset-free 로 성능이 저하(degrade)한다. 이 스킬의 초점은 위 6개 무료 폼 카테고리다.
이미지 생성이 필요한 경우에 한해 `GEMINI_API_KEY`/`GOOGLE_API_KEY` 를 선택적으로 쓰며, 없으면 생성 단계를 건너뛸 뿐 실패하지 않는다.

## 이 스킬이 소유하는 것과 소유하지 않는 것
**GSAP 애니메이션 작성, HTML 컴포지션 코딩, ffmpeg 인코딩, headless Chrome 캡처는 이 스킬이 직접 구현하지 않는다.**
전부 hyperframes 자체 서브에이전트(director/builder)와 CLI(`lint`/`check`/`snapshot`/`render`)가 수행한다.
그 규칙을 여기서 재서술하면 hyperframes 본체와 어긋나는 사본이 생긴다. 정본은 항상 hyperframes 쪽이다.

이 스킬이 소유하는 것은 다음뿐이다.

| 소유 | 내용 |
|---|---|
| 호출과 전제조건 확인 | hyperframes 실행 전 점검 |
| 단계 관문 | 계획 승인, 스냅숏 판정, 렌더 승인과 판정, 독립 검증 |
| 검토 페이지 | `references/curate.mjs`. 산출물마다 카드 하나, 그 옆에 구성 지시문 |
| 미리보기 서버 | `references/serve.mjs`, `references/preview-lib.mjs`. 빈 포트, 127.0.0.1, 상태 파일, `--stop`, CSP 헤더 |

검토 페이지와 서버는 `3d-intro-build` 와 같은 파일이다(`scripts/sync-adapter.js` 가 바이트 단위로 같게 유지).

## 원칙
- 산출물(스냅숏, 렌더)은 그것을 만든 구성 지시문과 나란히 보여 준다. 결과만 보여 주지 않는다.
- 단계마다 멈추고 판정을 받는다. 판정 없이 다음 단계로 가지 않는다.
- 미리보기 서버는 그때그때 빈 포트로 띄우고, 끝나면 `--stop` 으로 끈다. 기본 바인드는 `127.0.0.1` 이다. 원격 머신이면 SSH 포트 포워딩으로 보게 한다.
- 키와 토큰은 화면, 로그, 검토 페이지 어디에도 표시하지 않는다.
- 커밋, push, 배포는 사용자가 요청할 때만 한다.

## 흐름
1. **계획** - 사용자 브리프를 hyperframes `/motion-graphics`(필요시 `/hyperframes` 라우터 경유)에 전달한다. 카테고리 분류와 초안 계획은 hyperframes 가 만든다.
   계획(전할 메시지, 길이, 장면 구성, 색과 글꼴)을 사용자에게 보여 주고 승인받는다. 승인 전에는 build 로 가지 않는다.
2. **build** - hyperframes 가 카탈로그 블록을 재사용해 컴포지션 HTML 을 만든다(이 스킬의 직접 코드 작성 없음).
3. **lint, check, snapshot 과 스냅숏 검토** - hyperframes CLI 가 결함을 사전 검출하고, 필요하면 자체 리페어 패스를 한 번 더 돈다.
   snapshot 이 만든 주요 시점의 정지 화면을 검토 페이지에 올린다. 프로젝트 dir 의 `curate-input.json` 에 장면마다 그 정지 화면과 구성 지시문(장면별 문구, 타이밍, 강조 요소)을 적는다.

   ```json
   { "title": "Q3 성장", "stage": "snapshots",
     "scenes": [ { "id": "s1", "label": "숫자 등장", "takes": [
       { "file": "snapshots/s1.png", "take": 1, "prompt": "0.0~1.2초: '42%' 카운트업, 강조색 링", "size": "1920x1080" } ] } ] }
   ```

   ```bash
   node references/curate.mjs <projectDir>          # CURATE http://localhost:<port>/ (백그라운드)
   node references/curate.mjs --record <projectDir> --scene 1 --verdict regenerate --note "링을 더 굵게"
   ```

   페이지는 프롬프트 칸을 "구성 지시문" 으로 보인다. 판정은 페이지의 "판정 저장" 이나 대화(`--record`)로 받아 `decisions.json` 에 남긴다.
   재생성 요청이 있는 장면만 hyperframes 로 고치고 다시 올린다. 전부 승인돼야 렌더로 간다.
4. **render** - **명시적 렌더 승인 이후에만** 실행한다. 불투명 결과는 MP4, 오버레이가 필요하면 투명 webm/mov 로 렌더한다.
   렌더 파일을 `"stage": "render"` 로 검토 페이지에 올려(무음 반복 재생, `seconds` 에 실제 길이) 판정받는다.
5. **배치 (선택)** - 사이트에 넣을 때만 한다. 영상을 사이트의 자리에 넣고 조립 미리보기를 띄워 검토받는다.

   ```bash
   node references/serve.mjs <siteDir> [--csp strict|"<운영 정책>"]   # 사이트에 CSP 가 있으면 같은 헤더로
   node references/serve.mjs --stop <siteDir>
   ```

6. **독립 검증** - 작성자와 다른 검증 주체가 판정한다(Claude Code: 쓰기 도구 없는 별도 에이전트, Codex: `spawn_agent`).
   실제 길이, 주요 시점 정지 화면의 글자 깨짐과 가독성, 계획과의 일치를 본다. 배치했다면 화면 크기별 자리, 겹침, 가로 넘침, 콘솔 오류도 본다. APPROVE 해야 완료로 간다.
7. **정리** - 서버를 모두 `--stop` 으로 끄고 포트가 닫혔는지 확인한다. 검토 입력과 임시 캡처는 목록을 보이고 지운다. `decisions.json` 은 기록이라 남긴다.
   배포는 요청받았을 때만 하고, 백업은 프로젝트의 `backup/` 아래에 둔다(`/tmp` 금지).

**렌더는 사용자의 명시적 승인 없이는 절대 실행하지 않는다.** 승인 전에는 스냅숏 검토에서 멈추는 것이 기본값이다.

## 완료 보고
렌더가 끝나면 산출물 경로, 실제 길이(duration), 사용된 컴포지션/프레임 id, 확인에 쓴 스냅숏 시점, 검토 판정과 독립 검증 결과를 함께 보고한다.
렌더 없이 멈췄다면, 어디까지 진행됐고 다음에 무엇을 승인하면 렌더로 이어지는지만 짧게 보고한다.
