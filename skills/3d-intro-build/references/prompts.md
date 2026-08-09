# 프롬프트 템플릿 & 인테이크 (Azure 파이프라인)

이 문서는 **채워 넣는 슬롯** 모음이다.
scroll-world 의 씬/아트디렉션 **구조**를 따르되, 문구는 이 스킬의 Azure 파이프라인(`gpt-image-2` 스틸 + `Sora-2` fly-through)에 맞게 새로 썼다.
Higgsfield·Monid 같은 외부 CLI 플래그는 쓰지 않는다 — 크기·길이·품질은 어댑터 인자(`size`, `seconds`, `quality`)로만 넘긴다.

모델에 실제로 보내는 프롬프트 문자열은 **영어**로 둔다(이미지·영상 모델이 영어에 맞춰져 있고, 스모크로 검증한 문구도 영어다).
설명·가이드는 한글이다.

**핵심 원칙 — 코히전은 반복에서 온다.**
아래 **스타일 서문(style preamble)** 을 모든 씬 스틸 프롬프트에 **글자 그대로 동일하게** 넣어라.
그 동일한 텍스트가 여러 씬을 "한 세계"로 묶는다.

---

## 1. 인테이크 체크리스트 (SKILL Step 1)

진행 전 아래를 받아 적는다. 굵은 다섯 항목은 **반드시** 묻는다.

- **`SUBJECT`** — 대상 비즈니스/제품 + 한 줄 소개.
- **`BRAND`** — 화면에 표시할 브랜드명.
- **`SCENES[]` (순서 있는 씬 목록)** — 각 씬마다 `id`, `label`, `subject`(디오라마에 뭐가 있는지), `eyebrow`, `title`, `body`(1문장), `tags[]`(0~3). 마지막 씬 = 히어로 제품 + CTA.
- **`ORIENTATION`** — `720x1280`(세로) 또는 `1280x720`(가로). 스틸과 영상 크기가 이 값으로 통일된다. 세로는 모바일/스토리, 가로는 데스크톱/랜딩에 맞는다.
- **`BUDGET`** — 상한 USD. 씬 수 × (이미지 1장 + 영상 클립)로 추정하며, 어떤 유료 호출보다 먼저 승인 게이트에서 총액을 제시한다.

부수 항목(없으면 기본값 사용):

- `PALETTE` — 4~6개 명명 hex. 예: `taro #9B7EBD, cream #F5EDE0, caramel #C88A5A, matcha #8FB98A, plum #3A2E48`. 하나를 씬 **배경색**(보통 가장 밝은 색), 하나를 기본 **accent** 로 고른다. 이 배경색을 페이지 테마(`--sw-bg`)에도 그대로 쓴다.
- `TONE` — 한두 단어(cozy/premium, playful, industrial…).
- `STYLE` — 아트디렉션(기본은 아래 clay diorama).
- `CAMERA_FEEL` — fly-through(디오라마를 내려다보다 안으로 급강하) | walkthrough(한 번에 쭉 전진) | locked-iso(고정 아이소메트릭 활공). 느낌으로 제시하고 트레이드오프 한 줄씩 곁들인다.
- `MOBILE` — yes/no. yes 면 세로 9:16 렌더를 별도로 만들어 `clipMobile`/`stillMobile` 로 배선한다(대략 2배 비용, 승인 게이트에 반영).
- `STILLS_SOURCE` — 기본 `gpt-image-2`(`generateImage`). 씬 간 코히전을 더 강하게 원하면 `FLUX.2-pro`(`generateImageFlux`) 옵트인.

---

## 2. 스타일 서문 (기본: clay diorama)

모든 씬 프롬프트에 **글자 그대로 재사용**한다. 대괄호만 브랜드 팔레트/배경으로 치환한다.

```
Isometric low-poly 3D diorama floating as a small rounded island on a plain solid
[BG_HEX] background with a soft contact shadow beneath it. Soft matte clay 3D render,
rounded toy-model shapes, gentle warm studio lighting, soft long shadows, tilt-shift
miniature look. Cohesive color palette of [PALETTE]. Highly detailed, centered
composition, absolutely no text, no letters, no numbers, no logos.
```

대체 방향(첫 두 문장만 바꾸고 팔레트/no-text 꼬리는 유지):

- **Flat papercraft:** "Isometric layered paper-craft diorama, matte cardstock, clean die-cut edges, subtle drop shadows between layers."
- **Glossy toy:** "Isometric glossy vinyl-toy diorama, smooth plastic shading, soft rim light, collectible figurine look."
- **Claymation:** "Isometric stop-motion clay set, visible thumbprints, handmade plasticine texture, soft studio softbox light."
- **Neon night:** "Isometric miniature at night, warm interior glow and neon signage, moody rim light, wet reflective ground."
- **Photoreal architectural**(부동산·호스피탈리티·프리미엄): "Ultra-photorealistic architectural photography of a single cohesive [subject], cinematic wide-angle, warm golden-hour light, natural materials, restrained designer furnishings, editorial magazine quality, shallow depth of field, no people." 포토리얼은 floating-island 프레이밍을 버리고 full-bleed 로 가며(어두운 페이지 배경이 프리미엄하게 읽힌다), dive 는 지붕을 여는 대신 문/유리를 통과한다.

---

## 3. 씬 스틸 프롬프트 (stills, `gpt-image-2`)

각 씬마다: **[스타일 서문]** 다음에 그 씬의 subject 한 단락을 붙인다.

```
[STYLE PREAMBLE]
Subject: [SCENE.subject — 미니어처 장면을 묘사: 건물/공간, 일하는 캐릭터 몇, 이 단계의
비즈니스를 드러내는 소품들].
```

팁:

- 구체적인 소품을 이름으로 지정한다(장면을 고정한다): tanks, cauldrons, conveyor, crates, awning, string lights, benches, scooters, map pins.
- 마지막 "히어로 제품" 씬은 디오라마-섬 프레이밍을 버리고, 같은 배경 위에 떠 있는 **하나의 큼직한 제품**을 중심에 두고 작은 소품 몇 개만 궤도처럼 두른다.
- **중앙으로 구성한다.** 페이지는 모든 클립을 `object-fit:cover` 로 그린다. 초점 대상을 가로 중앙에 약간의 헤드룸과 함께 두고, 가장자리에 중요한 것을 두지 않는다.

어댑터 인자(플래그 아님):

- `size` = `ORIENTATION` (`720x1280` 세로 / `1280x720` 가로). Sora 크기와 반드시 일치시킨다.
- `quality` = `low`(미리보기·저렴) 또는 `high`(최종).
- **N3 주의:** v1 경로가 실패해 classic 폴백이 뜨면 반환 크기가 `1024x1536`(2:3)라 `720x1280` 이 아니다. `createVideo` 에 넣기 전에 Sora 크기로 리사이즈(ffmpeg `scale`)하거나 재생성한다. v1 경로(`720x1280`)가 검증된 happy path 다.

### FLUX 코히전 옵트인 (`generateImageFlux` / FLUX.2-pro)

씬 사이 톤·질감 일관성을 더 강하게 원할 때만 쓴다.
동일한 스타일 서문을 넣되 어댑터에는 `width`/`height` 를 `ORIENTATION` 에 맞춰 나눠 넘긴다(`720x1280` → `width:720, height:1280`).
크리덴셜이 없으면 조용히 실패하지 말고 `gpt-image-2` 로 정직하게 폴백한다("FLUX 미수집 → gpt-image-2 로 진행").

---

## 4. Fly-through — forward-chaining leg 프롬프트 (`Sora-2`, `createVideo`)

Azure `/videos` 는 `input_reference` 를 **딱 하나만** 받는다(두-이미지는 400).
그래서 연속성은 **forward-chaining** 으로 만든다: 이전 클립의 **실제 마지막 프레임**을 다음 클립의 `input_reference` 로 넣는다.
아래 굵은 절이 **모션 핸드오프 계약**이다 — 글자 그대로 유지하고, 씬별 표현은 가운데 MOVE 슬롯에 넣는다.

**Leg 0 (씨앗) — 씬 1 스틸에서 dive-in:**
`input_reference = 씬 1 스틸`.

```
Single continuous cinematic camera move, no cuts. Begin high and far, looking down at the
whole [SCENE 1 subject] from outside like a tiny model. The camera slowly glides forward and
descends toward it, sweeping in toward [FOCAL POINT], as if flying inside. As the camera pushes
in, the roof and upper structure gently lift and open away to reveal the warm interior.
[STYLE tail + PALETTE]. Smooth, graceful, slow motion, subtle parallax. No text, no captions.
```

여닫을 건물이 없는 씬(들판·광장·도로)이면 지붕 절을 "the camera flies low across [the scene] toward [focal point]." 로 바꾼다.

**Leg i (i ≥ 1) — 체이닝된 프레임에서 다음 씬으로:**
`input_reference = colorMatch(extractLastFrame(clip[i-1]))` (직전 클립의 마지막 프레임을 톤 정합 1차 처리한 것).

```
Single continuous cinematic camera move, no cuts. Continue the same continuous camera flight
forward into the next area of the world, smooth dolly, one continuous shot. [MID-LEG MOVE —
아래 라이브러리에서 선택, 없으면 생략.] The camera moves into [SCENE i] toward [FOCAL POINT].
In the final second, settle back into a slow, steady forward glide toward [the doorway / opening
/ direction of the next scene]. [STYLE tail + PALETTE]. Smooth, graceful, slow motion, subtle
parallax. No text, no captions.
```

### Mid-leg MOVE 라이브러리 (컨셉으로 고른다; 밋밋한 활공이면 생략)

leg **안쪽**에서는 되감기·역방향 카메라가 안전하다(한 번에 렌더되는 연속 샷). 절대 안 되는 건 **씨앗(seam) 프레임의 역방향**뿐이다.

- **Half-orbit**(제품·럭셔리): "sweeping in a slow half-orbit around [the hero object], keeping it centered, then continuing past it"
- **Crane-up reveal**(스케일·아트리움): "rising smoothly as the full scale of [the space] reveals below"
- **Low lateral track**(생산 라인·카운터·선반): "tracking low and level alongside [the line], foreground objects sliding past in parallax"
- **Push-in + ease back**(디테일·공예): "pushing in close to [the craft moment] until it nearly fills the frame, then easing gently back out"
- **Rise-and-swoop**(여행·야외): "climbing in a gentle arc over [the terrain], then swooping down toward [the next focal point]"

**locked-iso 절**(`CAMERA_FEEL = locked-iso`): 위 라이브러리를 통째로 건너뛰고 아래를 모든 leg 의 MOVE 슬롯에 글자 그대로 넣는다.

```
The camera keeps exactly the same high isometric angle throughout — no rotation, no orbit, no
tilt. It only travels straight and level, the world sliding past beneath the same view.
```

**각 leg 렌더 직후, 다음 leg 를 만들기 전에 마지막 프레임을 확인한다.**
잔잔한 전진 활공의 한 컷으로 읽혀야 한다(옆으로 흐르는 모션블러·완결 안 된 오빗 금지).
아니면 그 leg 를 재생성한다 — 나쁜 핸드오프 프레임 하나가 뒤의 모든 leg 를 오염시킨다.

어댑터 인자: `model: 'sora-2'`, `size: ORIENTATION`, `seconds`(기본 4; 예산·길이에 따라 조정).

---

## 5. 두-이미지 커넥터 프롬프트 (옵트인 · **UNVALIDATED**)

`detectTwoImageSupport()` 가 참일 때만, 그리고 사용자가 명시적으로 선택할 때만 쓴다.
두 씬 사이에 **진짜 커넥터**(첫 프레임 → 마지막 프레임 보간)를 만들어 aerial hop 을 넣는다.
`createVideoTwoImage({ firstPng: dive_i 마지막 프레임, lastPng: dive_{i+1} 첫 프레임 })`.
스모크로 검증되지 않은 경로다 — **어떤 실패에도 forward-chaining 으로 폴백**한다.

```
Single continuous cinematic camera move, no cuts. The camera smoothly pulls up and back out of
[SCENE i], rising into the sky, then glides forward across the connected miniature world and
arrives above [SCENE i+1], beginning to descend toward it. One connected miniature clay world,
seamless flowing aerial transition. [STYLE tail + PALETTE]. Smooth graceful slow motion. No text,
no captions.
```

히어로-제품 피날레로 들어가는 마지막 커넥터: "…glides forward and the world dissolves toward a single giant [PRODUCT] floating in soft [BG] space, arriving in front of it."

---

## 6. 씬별 카피 (엔진 config 용)

- `eyebrow` — 2~4단어, 대문자 느낌(가치 제안 라벨).
- `title` — 3~6단어, 그 비트의 헤드라인. 첫 씬 = 사이트 히어로 라인, 마지막 = 페이오프 + CTA 를 얹는다.
- `body` — 한 문장, 방문자 입장에서 평이하게.
- `tags` — 0~3개 짧은 증거 칩(예: "Fresh-cooked", "30-min delivery").

이 값들은 `assemble.mjs` 가 읽는 `intro.json` 의 각 섹션에 그대로 들어가고, `mountScrollWorld` 가 화면 카피로 렌더한다.
