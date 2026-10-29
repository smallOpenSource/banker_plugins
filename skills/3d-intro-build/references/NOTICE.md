# NOTICE — 서드파티 출처 (3d-intro-build)

이 스킬의 `references/` 는 서드파티 코드 일부를 재사용한다.
아래는 그 출처와 라이선스를 실제 재사용 범위에 한정해 밝힌 것이다.

## 그대로 벤더링한 파일 (VERBATIM)

- **`scrub-engine.js`**
- **`index-template.html`**

두 파일 모두 **scroll-world**(https://github.com/oso95/scroll-world)에서 **글자 그대로** 가져왔다.
라이선스: MIT, Copyright (c) 2026 cyw.
전문은 이 디렉터리의 `LICENSE` 파일에 있으며, MIT 조건에 따라 그 저작권·허가 고지를 함께 배포한다.
두 파일은 이 스킬에서 **수정하지 않는다**(정본은 상류 scroll-world 다). 예외는 아래 변경 기록 한 건뿐이다.

### 변경 기록 (scrub-engine.js)

- 2026-10-29: 커넥터 구간 포스터를 고를 수 있는 선택 설정 `connectorStills` 를 한 줄 더함(`// banker: opt-in connector poster` 줄).
  - 동작: `config.connectorStills[i]` 가 있으면 커넥터 `i` 의 포스터를 그 이미지로 둔다. 없으면 상류와 같다(다음 장면 스틸).
  - 까닭: dive 모드의 나가기 클립은 장면 `i` 실내에서 시작한다. 상류처럼 다음 장면 스틸을 포스터로 두면, 클립 적재가 늦을 때 다음 섬이 잠깐 보였다가 장면 `i` 로 돌아가는 튐이 생긴다. `assemble.mjs` 가 매니페스트의 `connectorStills`(그 클립의 실제 첫 프레임)를 이 설정으로 넘긴다.
  - 사용자 승인 아래의 예외다(2026-10-29). 그 밖의 상류 코드는 그대로다.

## 접근을 각색한 것 (ADAPTED, 코드 아님)

- **`prompts.md`**

scroll-world 의 씬/아트디렉션 **구조**(스타일 서문을 씬마다 동일하게 두어 코히전을 만드는 방식, forward-chaining leg 프롬프트의 모션-핸드오프 계약)를 참고해 각색했다.
문구 자체는 이 스킬의 Azure 파이프라인(`gpt-image-2` + `Sora-2`)에 맞춰 새로 썼고, scroll-world 의 외부 CLI(Higgsfield·Monid) 플래그는 옮기지 않았다.
구조적 아이디어의 출처로서 위 MIT 저작자에게 귀속을 표한다.

## 벤더링/번들하지 않은 것

- **ffmpeg** — 번들하지 않는다. `azure-adapter.mjs` 의 `resolveFfmpeg()` 가 런타임에 시스템 바이너리(또는 선택적 `ffmpeg-static`)를 찾고, 설치는 `3d-intro-setup` 스킬이 담당한다.
- **hyperframes** — 이 스킬은 쓰지 않는다(형제 스킬 `motion-graphic-make` 가 `npx` 로 호출할 뿐이며, 어느 경우에도 벤더링하지 않는다).

## 이 스킬의 자작 파일 (서드파티 아님)

`azure-adapter.mjs`, `video-pool.mjs`, `clip-post.mjs`, `dive-mode.mjs`, `preview-lib.mjs`, `serve.mjs`, `curate.mjs`, `assemble.mjs`, `intro-fixes.css`, `panel-glass.css`, `step-nav.js`, `step-nav.css`, `verify-intro.mjs`, `verify.md`, `prompts.md`, `SKILL.md` 는 이 스킬의 창작물이다.
이 중 재사용에 해당하는 것은 위에 밝힌 `prompts.md` 의 **구조 각색**뿐이다.
`intro-fixes.css`, `panel-glass.css`, `step-nav.js` 는 벤더링한 엔진을 고치지 않고 페이지 쪽에서 덧씌우는 파일이다. `assemble.mjs` 가 만드는 `scrub-engine.css` 는 엔진 파일 안의 CSS 를 글자 그대로 옮긴 것이라 엔진과 같은 MIT 고지를 따른다.
