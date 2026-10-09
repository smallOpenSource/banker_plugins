---
name: 3d-intro-build
description: "스크롤 위치에 맞춰 3D 플라이스루 영상이 움직이는 브랜드 인트로 사이트를 만듦. Azure 의 gpt-image 배포로 스틸을 만들고, 영상은 WAN 모델을 API 키 풀로 돌려 만들며 키가 모두 소진되면 Sora-2 로 넘어감. 인터뷰 뒤에 비용 승인 게이트에서 사용자가 승인해야만 유료 생성을 시작하고, 스틸, 영상, 로컬 프리뷰 순서로 진행. '3d-intro-build'/'3D 인트로'/'스크롤 fly-through'/'인트로 영상 사이트' 시 사용."
---

# 3d-intro-build — 스크롤-스크럽 3D 인트로 제작 (Azure 이미지 + WAN/Sora 영상)

스크롤에 맞춰 카메라가 미니어처 세계를 날아 들어가는 브랜드 인트로 사이트를 만든다.
씬 스틸은 Azure 의 gpt-image 배포(`AZURE_GPT_IMAGE_DEPLOYMENT`, 예: `gpt-image-2.5-sunburst`)로 만든다.
fly-through 영상은 Alibaba Model Studio 의 WAN(기본 `wan3.0-video-prime`)을 API 키 풀로 돌려 만들고, 풀의 키가 모두 소진되면 Azure `Sora-2` 로 폴백한다.
결과는 scroll-world 엔진으로 한 장의 자체완결 HTML 에 배선한다.

이 스킬은 **오케스트레이션**만 소유한다.
Azure 호출·ffmpeg 처리는 `references/azure-adapter.mjs`(정본), 영상 provider 선택·키 풀·폴백은 `references/video-pool.mjs`(정본)에 있으니 재구현하지 말고 그 export 를 부른다.
엔진(`references/scrub-engine.js`)과 템플릿(`references/index-template.html`)은 벤더링본이라 **수정하지 않는다**(출처는 `references/NOTICE.md`).
답변은 한글(기술 토큰·경로·명령은 영문).

**유료 호출은 일곱 개다:** `generateImage`, `generateImageFlux`, `editImage`, `generateClip`(영상의 기본 진입점), `wanCreateTask`, `createVideo`, `createVideoTwoImage`.
`resumeClip` 은 새로 제출하지 않고 이미 만든 task 를 마저 받기만 한다.
이 중 **어느 것도 Step 2 의 명시적 승인 이전에는 실행하지 않는다.**
Step 0~2 에서 쓰는 `resolveCreds`·`resolveFfmpeg`·`detectTwoImageSupport`·`estimateCost`·`poolSummary`·`probeWanPool` 은 전부 과금이 없다.
게다가 가장 비싼 영상 호출(`generateClip`·`createVideo`·`createVideoTwoImage`)은 **Step 3.5 에서 사용자가 스틸을 고르기 전에는 실행하지 않는다**(무료 큐레이션 게이트).

---

## Step 0 — 프리플라이트 (무료)

크리덴셜과 ffmpeg 가 준비됐는지 먼저 확인한다.
문제가 있으면 **설치부터 안내**하고 멈춘다(추정·임의 재설치 금지).

```js
import { resolveCreds, resolveFfmpeg } from './references/azure-adapter.mjs';
const creds = resolveCreds({ projectDir });     // _source === null 이면 미설정
// setup 이 ffmpeg 경로를 creds 에 FFMPEG_PATH 로 영속했으면 이 프로세스 env 에 적용(다른 세션/no-PATH 대비)
if (creds.FFMPEG_PATH && !process.env.FFMPEG_PATH) process.env.FFMPEG_PATH = creds.FFMPEG_PATH;
```

- `creds._source` 가 `null` 이면 크리덴셜이 없다 → `3d-intro-setup` 으로 보낸다.
  Claude Code: `/banker:setup` → 3d-intro-setup / Codex: `banker-3d-intro-setup`.
- `resolveFfmpeg()` 가 throw 하면 ffmpeg 가 없다 → 같은 `3d-intro-setup` 으로 보낸다.
- 둘 다 통과해야 다음 단계로 간다.
- 영상 provider 상태를 무료로 확인해 둔다.
  `poolSummary({ creds })` 는 WAN 키별 상태(`ok`·`cooldown`·`exhausted`·`invalid`·`malformed`)를 키 원문 없이 돌려준다.
  `malformed` 는 endpoint 가 http(s) URL 이 아니거나 모델이 한 id 가 아닌 항목이다(`reason` 이 `endpoint` 또는 `model`). 영상 단계는 이 항목을 건너뛰고, 모두 `malformed` 면 영상 단계에서 멈춘다. 그러니 유료 스틸을 만들기 전에 사용자에게 알리고 `3d-intro-setup` 으로 고친다.
  WAN 항목(`WAN_<n>_ENDPOINT`·`WAN_<n>_API_KEY`)이 하나도 없으면 영상은 처음부터 Sora 로 만든다.

---

## Step 1 — 인터뷰 (무료)

`references/prompts.md` 의 인테이크 체크리스트를 따른다.
아래 다섯 가지는 **반드시** 묻는다.

- **SUBJECT** — 대상 비즈니스/제품 + 한 줄 소개.
- **BRAND** — 화면에 표시할 브랜드명.
- **SCENES[] (순서 있는 씬 목록)** — 각 씬의 `id`·`label`·`subject`·`eyebrow`·`title`·`body`·`tags[]`. 마지막 씬 = 히어로 제품 + CTA.
- **ORIENTATION** — `720x1280`(세로) 또는 `1280x720`(가로). 스틸과 영상 크기가 이 값으로 통일된다.
- **BUDGET** — 상한 USD.

부수 항목(없으면 기본값): `PALETTE`(배경색 하나·accent 하나 지정), `TONE`, `STYLE`(기본 clay diorama), `CAMERA_FEEL`, `MOBILE`(yes 면 약 2배 비용), `STILLS_SOURCE`(기본 gpt-image-2, 코히전 강화 원하면 FLUX 옵트인).

---

## Step 2 — 비용 추정 + 승인 게이트 (무료 · 필수 · 유료 호출 차단선)

유료 생성 **이전에** 반드시 총액을 제시하고 명시적 승인을 받는다.
two-image 커넥터를 검토 중이면 여기서 무료 probe 로 지원 여부만 확인해 추정에 반영한다.

```js
import { estimateCost, detectTwoImageSupport } from './references/azure-adapter.mjs';
const twoImage = wantConnectors && await detectTwoImageSupport({ endpoint, key }); // 무료 GET probe
const cost = estimateCost({ nScenes, seconds, twoImage });  // { images, videos, usd }
```

- 사용자에게 `cost.images` / `cost.videos` / `cost.usd` 와 BUDGET 대비를 보여준다.
- `cost.videos` 는 **Sora 단가($0.10/초) 기준**이다.
  WAN 단가와 계정별 무료 할당량은 API 로 조회할 수 없다(Model Studio 에 할당량 조회 API 가 문서화돼 있지 않음).
  그러니 "WAN 이 먼저 쓰이고, 실제 WAN 비용은 Model Studio 콘솔에서 확인, 키가 소진되면 이 Sora 추정이 적용된다" 고 그대로 알린다.
- WAN 클립 길이는 정수 2~30초(기본 5초), Sora 는 4·8·12초뿐이다. 폴백되면 길이가 가장 가까운 Sora 값으로 바뀐다(5초 → 4초).
- MOBILE=yes 면 세로 체인이 추가돼 대략 2배임을 명시한다.
- **명시적 승인이 없으면 여기서 멈춘다.** 승인 전에는 Step 3·4 의 유료 호출로 진입하지 않는다.
- BUDGET 을 초과하면 씬 수·`seconds`·품질을 줄이는 선택지를 제시하고 다시 추정한다.

---

## Step 3 — 씬 스틸 (유료 · 승인 이후에만)

기본은 `AZURE_GPT_IMAGE_DEPLOYMENT` 배포(`generateImage`). gpt-image-2 계열은 16의 배수 크기(예: `720x1280`)를 그대로 받는다.
씬마다 `references/prompts.md` 의 스타일 서문 + 씬 subject 로 프롬프트를 만들되, **스타일 서문은 모든 씬에 글자 그대로 동일**하게 넣어 코히전을 만든다.

```js
import { generateImage, generateImageFlux, probeDims } from './references/azure-adapter.mjs';
const png = await generateImage({ endpoint, key, deployment, prompt, size: ORIENTATION, quality });
```

- **429 처리** — 낮은 티어(S0) 이미지 배포는 연속 호출에 `429 RateLimitReached` 를 낸다.
  `generateImage` 는 서버의 `Retry-After` 만큼 기다렸다가 같은 경로로 다시 시도한다(기본 3회, `retry429`). classic 경로도 같은 한도를 쓰므로 429 에서는 classic 으로 넘어가지 않는다.
  그래도 실패하면 씬 사이에 간격을 두고 다시 부른다.

- **큐레이션용 변형(권장)** — 다음 Step 3.5 에서 사용자가 실제로 고를 수 있게, 씬마다 `generateImage` 를 한 번 더 불러 변형 스틸을 하나 더 만든다(스틸은 싼 티어라 부담이 작다).
  변형을 넣으면 스틸 비용이 대략 씬당 2배이니 **Step 2 추정에 미리 반영**한다. 변형 없이 씬당 1장만 만들어도 Step 3.5 의 "이 스틸로 승인 / 다시 만들기" 결정은 그대로 받는다.
- **FLUX 옵트인** — 씬 간 톤·질감 일관성을 더 원하면 `generateImageFlux({ width, height })`(ORIENTATION 을 나눠 전달).
  FLUX 크리덴셜을 요청했는데 미수집이면 조용히 실패하지 말고 `gpt-image-2` 로 **정직하게 폴백**한다("FLUX 미수집 → gpt-image-2 로 진행").
- **N3 주의(씨앗 스틸 크기)** — `generateImage` 의 classic 폴백이 뜨면 반환 크기가 `1024x1536`(2:3)라 `720x1280` 이 아니다.
  체인 씨앗이 되는 **씬 1 스틸**은 `probeDims` 로 확인해 ORIENTATION 과 다르면 `createVideo` 전에 Sora 크기로 리사이즈(`resolveFfmpeg` + ffmpeg `scale`)하거나 재생성한다.
  v1 경로(`720x1280`)가 검증된 happy path 다.

---

## Step 3.5 — 스틸 큐레이션 (무료 · 사용자 선택 · 영상 차단선)

스틸은 값싼 유료 티어지만, fly-through(Step 4)는 이 파이프라인에서 **가장 비싼** 단계다.
그러니 비싼 영상 호출을 쓰기 전에, 방금 만든 스틸을 사용자가 직접 브라우저에서 보고 씬별로 고르게 한다.
이 단계는 전부 **무료**이며, Step 2 의 비용 게이트에 더해 "사용자가 고른 스틸에만 영상비를 쓴다" 는 **두 번째 게이트**를 만든다.

**1) 큐레이션 입력을 쓴다.** 프로젝트 dir 에 `curate-input.json` 을 적는다.

```json
{
  "scenes": [
    { "id": "sceneA", "label": "Scene A — 로비",
      "variants": [ { "file": "still-A-1.png", "prompt": "…" }, { "file": "still-A-2.png", "prompt": "…" } ] },
    { "id": "sceneB", "label": "Scene B — 히어로 제품",
      "variants": [ { "file": "still-B-1.png" } ] }
  ]
}
```

- `file` 은 프로젝트 dir 기준 상대 png 경로다(서버가 path-traversal 가드로 그 안에서만 서빙한다).
- `label`·`prompt` 는 화면 표시용일 뿐 선택 결과에 영향을 주지 않는다.

**2) 큐레이션 서버를 백그라운드로 띄우고 로컬 URL 을 출력한다.**

```bash
node references/curate.mjs <projectDir>     # → curate-port.txt + CURATE http://localhost:<port>/  (백그라운드)
```

- 페이지는 씬마다 변형 카드를 보여주고, 클릭으로 하나를 고른다(선택된 카드가 하이라이트된다).
- 각 씬엔 "재생성 메모"(수정 프롬프트) 입력이 있다 — 비우면 그 스틸로 승인, 채우면 그 씬을 다시 만들라는 뜻이다.
- 사용자가 "선택 확정" 을 누르면 서버가 `selection.json` 을 쓰고, 페이지에 "선택 저장됨 — 에이전트로 돌아가세요" 가 뜬다.

**3) 사용자가 확정할 때까지 기다린다.** 프로젝트 dir 에 `selection.json` 이 나타나면 진행한다.
파일이 아직 없으면 사용자가 고르는 중이니 Step 4 로 넘어가지 않는다.

```json
{ "scenes": [
    { "id": "sceneA", "chosen": "still-A-2.png" },
    { "id": "sceneB", "chosen": "still-B-1.png", "regenerate": "배경 더 어둡게, 캐릭터 2명 추가" }
] }
```

- `chosen` = 그 씬에 대해 사용자가 고른 스틸 파일(= 이후 영상의 씨앗/포스터로 쓸 파일).
- `regenerate` = 있으면 그 씬을 이 메모대로 다시 만들라는 요청이고, 없으면 승인이다.

**4) 재생성 요청이 있으면 3.5 안에서 루프한다.**
`regenerate` 가 달린 씬은 그 메모를 스타일 서문 뒤 subject 에 반영해 `generateImage` 로 그 씬만 다시 만든다.
새 스틸로 `curate-input.json` 을 갱신하고, 헷갈리지 않게 오래된 `selection.json` 을 지운 뒤 다시 서빙해 재확인을 받는다.
모든 씬이 `regenerate` 없이 확정될 때까지 반복한다.

**5) 확정된 스틸만 Step 4 로 넘긴다.**
각 씬의 씨앗 스틸 = 그 씬의 `chosen` 이다.
승인되지 않은/버려진 변형에는 **영상비를 한 푼도 쓰지 않는다.**

---

## Step 4 — Fly-through (유료 · forward-chaining)

**이 단계는 Step 3.5 에서 사용자가 확정한 스틸에만 돈을 쓴다** — 각 씬의 씨앗은 `selection.json` 의 `chosen` 이고, 승인되지 않은/버려진 변형으로는 영상을 만들지 않는다.

연속성은 **forward-chaining** 으로 만든다.
직전 클립의 **실제 마지막 프레임을 톤 변형 없이 그대로** 다음 클립의 첫 프레임으로 넣는다.
모든 leg 는 `generateClip` 한 함수로 만든다. provider 순서(`VIDEO_PROVIDER_ORDER`, 기본 `wan,sora`)와 키 풀은 이 함수가 처리한다.
(시드 프레임에 histeq 톤 정합을 걸면 시작 톤이 바뀌어 연속성이 **오히려 나빠진다** — e2e 실측 raw-시드 SSIM ~0.59 vs histeq-시드 0.46. 톤 정합은 시드가 아니라 조립/재생 계층에서 처리한다.)

```js
import { extractLastFrame, extractFirstFrame } from './references/azure-adapter.mjs';
import { generateClip, poolSummary } from './references/video-pool.mjs';
const log = (e) => console.log(JSON.stringify(e));   // submit / fail / wait / fallback / done 이벤트 (키 없음)

// Leg 0 — 씬 1 스틸에서 dive-in
let r = await generateClip({ creds, prompt: leg0, size: ORIENTATION, seconds, firstFramePng: scene1Still, onEvent: log });
fs.writeFileSync('dive-1.mp4', r.mp4);              // r.provider = 'wan' | 'sora', r.label = 'WAN_2' 등

// Leg i (i ≥ 1) — 직전 클립의 RAW 마지막 프레임을 그대로 다음 첫 프레임으로 (톤 변형 금지)
await extractLastFrame('dive-i.mp4', 'last-i.png');
r = await generateClip({ creds, prompt: legi, size: ORIENTATION, seconds, firstFramePng: fs.readFileSync('last-i.png'), onEvent: log });
// → dive-(i+1).mp4
```

- **키 풀 동작** — WAN 키는 가장 오래전에 쓴 것부터 고른다(요청이 한 키에 몰리지 않음).
  할당량 소진(`AllocationQuota.*`·`Arrearage`·`BudgetLimitExceeded` 등)과 모델 권한 없음(`*AccessDenied`)은 그 키를 24시간 쉬게 하고 다음 키로 다시 제출한다.
  요청 속도 429(`Throttling.RateQuota` 등)는 `Retry-After` 만큼 그 키만 쉬게 할 뿐 퇴출하지 않는다. `Throttling.AllocationQuota` 만 연속 3회면 1시간 쉬게 한다. `InvalidApiKey` 키는 키를 바꿀 때까지 제외한다.
  상태는 `~/.config/banker/3d-intro/video-pool-state.json` 에 지문(엔드포인트, 키, 모델)으로만 남아 다음 실행에도 이어진다. 상태 파일을 못 써도 클립은 그대로 돌려준다.
- **같은 leg 를 두 번 과금하지 않는다** — 다른 키로 다시 제출하는 것은 첫 제출이 task 를 만들지 않은 게 확실할 때뿐이다(서버가 거절, 요청을 보내기 전 연결 실패, task 가 키 할당량이나 알려진 일시 오류로 FAILED/CANCELED).
  코드가 없거나 처음 보는 코드로 FAILED/CANCELED 된 task 는 입력 탓이거나 과금됐을 수 있어 다시 내지 않고 `kind: 'failed'` 로 멈춘다.
- **폴백** — 쓸 수 있는 WAN 키가 없으면 그 leg 부터 Sora 로 만든다. 체인 도중에 provider 가 바뀌면 화풍이 달라질 수 있으니, leg 마다 `r.provider` 를 기록하고 바뀐 지점을 사용자에게 알린다.
  WAN 항목의 endpoint 나 모델이 형식에 맞지 않으면(URL 이 아닌 endpoint, 공백이 든 모델, 모델 칸에 붙인 키 등) 그 항목만 건너뛴다(`skip` 이벤트). 모든 항목이 그렇다면 Sora 로 넘기지 않고 `invalid_request` 로 멈춘다.
- **멈추는 경우(재제출·폴백 안 함)** — 아래 오류에서 같은 leg 를 `generateClip` 으로 다시 부르지 않는다.

  | 오류 | 뜻 | 다음 행동 |
  |---|---|---|
  | `ContentRejectedError` | 검열(`DataInspectionFailed` 등) | 프롬프트나 프레임을 고쳐 다시 부름 |
  | `kind: 'invalid_request'` | 요청 형식 오류, `ModelNotFound`(모델명 오타·미활성), 모든 WAN 항목의 형식 오류, Sora 크레덴셜 없이 Sora resume | 설정을 고침(task 는 생기지 않음) |
  | `kind: 'timeout'` / `'download'` | task 는 있음(과금됐을 수 있음) | `resumeClip({ creds, provider: err.provider, label: err.label, taskId: err.taskId, seconds: err.seconds })` |
  | `kind: 'submit_unknown'` / `'task_lost'` / `'no_video'` / `'failed'` | 결과를 알 수 없음(`'failed'` 는 처음 보는 이유로 끝난 task, `'task_lost'` 는 폴링이 4xx 나 UNKNOWN 으로 끝난 task) | Model Studio 콘솔(또는 Azure)에서 task 를 확인한 뒤 사용자와 정함 |
  | `kind: 'unreachable'` | Sora 연결 거부(아무것도 보내지 않음) | 네트워크를 확인한 뒤 다시 부름 |
  | `kind` 가 없는 오류 | 예상하지 못한 실패 | 원인을 확인하기 전에는 다시 부르지 않음 |

- 클립 해상도는 WAN 과 Sora 가 조금 다를 수 있다. `concatClips` 와 엔진이 크기를 맞춘다.

- **각 leg 렌더 직후, 다음 leg 전에 마지막 프레임을 확인**한다. 잔잔한 전진 활공 컷이 아니면 그 leg 를 재생성한다(나쁜 핸드오프 프레임이 뒤 leg 를 오염시킨다).
- **포스터(스틸) 배선** — 씬 1 포스터 = 씬 1 스틸. 씬 i≥2 포스터 = `extractFirstFrame(clip_i)` (클립 첫 프레임과 정확히 일치 → 로딩 시 플래시 없음).
- **Seam 처리** — `intro.json` 의 `connectors` 를 전부 `null` 로 두면 엔진이 인접 dive 를 **직접 crossfade** 한다. forward-chaining 으로 첫/끝 프레임이 같은 구도로 이어져 있어(e2e 실측 raw-시드 SSIM ~0.59, 구성 연속·경미한 톤 drift) 엔진의 짧은 crossfade 가 잔여 drift 를 덮는다. (`colorMatch` 는 **시드엔 걸지 않는다** — 필요하면 조립 전 클립 전체 톤 그레이드용 선택 유틸일 뿐이다.)
- **two-image 커넥터(옵트인 · UNVALIDATED)** — 사용자가 명시적으로 원할 때만 만든다.
  WAN 은 `generateClip({ firstFramePng, lastFramePng })` 로 첫+끝 프레임을 받는다(`media` 의 `first_frame`·`last_frame`). Sora 로 폴백되면 끝 프레임은 무시되고 forward-chaining 이 된다.
  Azure 경로는 `detectTwoImageSupport()` 가 참일 때만 `createVideoTwoImage({ firstPng, lastPng })` 를 쓴다.
  둘 다 스모크로 검증되지 않은 경로다 → **어떤 실패에도 forward-chaining 으로 폴백**한다.

---

## Step 5 — 조립 & 로컬 프리뷰 (무료)

씬·커넥터·테마를 `intro.json` 매니페스트로 적고(`assemble.mjs` 헤더에 형식), 조립한 뒤 사용하지 않는 포트로 서빙한다.
`intro.json` 의 각 섹션 카피(`eyebrow`/`title`/`body`/`tags`)와 `theme.bg`(= 씬 배경색)를 채운다.

```bash
node references/assemble.mjs <projectDir>          # → <projectDir>/site (index.html + scrub-engine.js + assets/)
node references/serve.mjs <projectDir>/site        # → port.txt + PREVIEW http://localhost:<port>/  (백그라운드)
```

- 결과는 **한 장의 자체완결 HTML** 이다(엔진·에셋을 옆에 복사).
- 프로젝트 관례상 **claude.ai 아티팩트를 만들지 않는다** — 로컬 HTML 을 포트로 서빙해 사용자가 브라우저로 확인한다.
- `serve.mjs` 는 mp4 를 HTTP Range(206)로 내보내 스크럽이 매끄럽고, 포트를 자동으로 잡아 `port.txt` 에 적는다.

---

## Step 6 — Seam 품질 보고 (정직 · 조건부)

이음매 품질은 경로에 따라 **정직하게** 표현한다. 과장하지 않는다.

- **무료 forward-chain(기본):** 이음매가 **near-seamless** 하되 **경미한 톤/디테일 drift** 가 있을 수 있다.
- **two-image(옵트인):** 지원되면 **seamless**(단 UNVALIDATED — 미지원/실패 시 forward-chain 으로 떨어진다).
- **수용 기준은 조립·서빙된 페이지**다 — raw 프레임 SSIM 이 아니다.
  참고로 forward-chain 의 pre-composite raw SSIM 은 ~0.59(가시 drift 대역)로 측정됐지만, 최종 판정은 crossfade·colorMatch 가 적용된 **서빙 페이지의 실제 스크럽 경험**으로 한다.

---

## 완료 보고

- 산출물 경로(`site/index.html`)와 프리뷰 URL(포트).
- 씬 수·`seconds`·ORIENTATION·사용 모델(이미지 배포명 / FLUX, 커넥터 경로).
- leg 별 영상 provider 와 키 라벨(`WAN_2`·`AZURE_SORA` 등), 폴백이 일어난 leg, 끝난 뒤의 `poolSummary`.
- **실제 소요 비용**(추정 대비).
- seam 판정(위 조건부 표현으로) + 재생성한 leg 가 있으면 그 사유.
