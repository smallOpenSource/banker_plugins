---
name: 3d-intro-build
description: "스크롤 위치에 맞춰 3D 플라이스루 영상이 움직이는 브랜드 인트로를 만듦. Azure gpt-image 로 스틸을, WAN 키 풀(소진되면 Sora-2)로 영상을 만들며 비용 승인과 단계별 검토 페이지 판정 뒤에만 유료 생성을 진행. 결과는 엄격한 CSP 에서도 도는 페이지이고, 장면 단위 이동과 기존 사이트 통합은 선택. '3d-intro-build'/'3D 인트로'/'스크롤 fly-through'/'인트로 영상 사이트' 시 사용."
---

# 3d-intro-build - 스크롤-스크럽 3D 인트로 제작 (Azure 이미지 + WAN/Sora 영상)

스크롤에 맞춰 카메라가 장면 사이를 날아가는 브랜드 인트로를 만든다.
씬 스틸은 Azure 의 gpt-image 배포(`AZURE_GPT_IMAGE_DEPLOYMENT`, 예: `gpt-image-2.5-sunburst`)로 만든다.
영상은 Alibaba Model Studio 의 WAN(기본 `wan3.0-video-prime`)을 API 키 풀로 돌려 만들고, 풀의 키가 모두 소진되면 Azure `Sora-2` 로 폴백한다.
결과는 scroll-world 엔진으로 배선한 인트로 페이지다. 단독 페이지로 쓰거나 기존 사이트 위에 붙인다.

이 스킬은 **오케스트레이션**만 소유한다. 아래 파일은 재구현하지 말고 그대로 부른다.

| 파일 | 맡은 일 |
|---|---|
| `references/azure-adapter.mjs` | Azure 호출, ffmpeg 처리(`stillToClip` 포함), 비용 추정 |
| `references/video-pool.mjs` | 영상 provider 선택, WAN 키 풀, 폴백 |
| `references/curate.mjs` | 검토 페이지(스틸, 클립)와 판정 기록 |
| `references/serve.mjs`, `references/preview-lib.mjs` | 미리보기 서버(빈 포트, 상태 파일, 종료, CSP 헤더) |
| `references/assemble.mjs` | 인트로 페이지 조립(인라인 script, style 없음) |
| `references/intro-fixes.css`, `panel-glass.css`, `step-nav.js`, `step-nav.css` | 엔진 덧씌움(수정 파일은 항상, 나머지는 선택) |
| `references/verify-intro.mjs`, `references/verify.md` | 실제 브라우저 측정과 검증 목록 |

엔진(`references/scrub-engine.js`)과 템플릿(`references/index-template.html`)은 벤더링본이라 **수정하지 않는다**(출처는 `references/NOTICE.md`). 엔진의 결함은 사이트 CSS 와 JS 로 덧씌운다.
답변은 한글(기술 토큰, 경로, 명령은 영문).

## 원칙

- 유료 생성은 사용자 승인 뒤에만 시작한다.
- 모든 산출물은 그것을 만든 프롬프트 정보와 나란히 보여 준다. 결과만 보여 주지 않는다.
- 단계마다 멈추고 판정을 받는다. 판정 없이 다음 단계로 가지 않는다.
- 미리보기 서버는 쓰지 않는 포트를 그때그때 받아 띄우고, 끝나면 종료한다. 기본 바인드는 `127.0.0.1` 이다. 원격 머신이면 SSH 포트 포워딩으로 보게 한다.
- 키와 토큰은 화면, 로그, 검토 페이지 어디에도 표시하지 않는다.
- 커밋, push, 배포는 사용자가 요청할 때만 한다.

**유료 호출은 일곱 개다:** `generateImage`, `generateImageFlux`, `editImage`, `generateClip`(영상의 기본 진입점), `wanCreateTask`, `createVideo`, `createVideoTwoImage`.
`resumeClip` 은 새로 제출하지 않고 이미 만든 task 를 마저 받기만 한다.
이 중 **어느 것도 Step 2 의 명시적 승인 이전에는 실행하지 않는다.**
`resolveCreds`, `resolveFfmpeg`, `detectTwoImageSupport`, `estimateCost`, `poolSummary`, `probeWanPool`, `stillToClip` 은 과금이 없다.
가장 비싼 영상 호출은 **Step 3 에서 모든 장면의 스틸이 승인되기 전에는 실행하지 않는다**.

---

## Step 0 - 프리플라이트 (무료)

크리덴셜과 ffmpeg 가 준비됐는지 먼저 확인한다.
문제가 있으면 **설치부터 안내**하고 멈춘다(추정, 임의 재설치 금지).

```js
import { resolveCreds, resolveFfmpeg } from './references/azure-adapter.mjs';
const creds = resolveCreds({ projectDir });     // _source === null 이면 미설정
// setup 이 ffmpeg 경로를 creds 에 FFMPEG_PATH 로 영속했으면 이 프로세스 env 에 적용(다른 세션/no-PATH 대비)
if (creds.FFMPEG_PATH && !process.env.FFMPEG_PATH) process.env.FFMPEG_PATH = creds.FFMPEG_PATH;
```

- `creds._source` 가 `null` 이면 크리덴셜이 없다. `3d-intro-setup` 으로 보낸다.
  Claude Code: `/banker:setup` 에서 3d-intro-setup / Codex: `banker-3d-intro-setup`.
- `resolveFfmpeg()` 가 throw 하면 ffmpeg 가 없다. 같은 `3d-intro-setup` 으로 보낸다.
- 둘 다 통과해야 다음 단계로 간다.
- 영상 provider 상태를 무료로 확인해 둔다.
  `poolSummary({ creds })` 는 WAN 키별 상태(`ok`, `cooldown`, `exhausted`, `invalid`, `malformed`)를 키 원문 없이 돌려준다.
  `malformed` 는 endpoint 가 http(s) URL 이 아니거나 모델이 한 id 가 아닌 항목이다(`reason` 이 `endpoint` 또는 `model`). 영상 단계는 이 항목을 건너뛰고, 모두 `malformed` 면 영상 단계에서 멈춘다. 그러니 유료 스틸을 만들기 전에 사용자에게 알리고 `3d-intro-setup` 으로 고친다.
  WAN 항목(`WAN_<n>_ENDPOINT`, `WAN_<n>_API_KEY`)이 하나도 없으면 영상은 처음부터 Sora 로 만든다. 이때 정지와 비행 모드(Step 4B)는 쓸 수 없다.
- 독립 검증(Step 6)에는 Playwright 와 Chromium 이 필요하다. 없으면 `setup-playwright` 를 안내해 둔다.

---

## Step 1 - 인터뷰 (무료)

`references/prompts.md` 의 인테이크 체크리스트를 따른다. 아래는 **반드시** 묻는다.

- **SUBJECT** - 대상 비즈니스/제품 + 한 줄 소개.
- **BRAND** - 화면에 표시할 브랜드명.
- **SCENES[] (순서 있는 씬 목록)** - 권장 5~7개. 이야기 순서는 문제 제기, 해법, 결론이고 CTA 는 결론 장면에만 둔다. 각 씬의 `id`, `label`, `subject`, `eyebrow`, `title`, `body`, `tags[]`.
- **ORIENTATION** - `720x1280`(세로) 또는 `1280x720`(가로). 스틸과 영상 크기가 이 값으로 통일된다.
- **BUDGET** - 상한 USD.
- **CLIP_MODE** - `chain`(기본) 또는 `holdFlight`(선택, WAN 필요). 차이는 Step 4 에 있다.
- **SITE** - 단독 인트로 페이지인지, 기존 사이트 위에 붙이는지. 붙인다면 그 사이트의 CSP, 본문 시작 요소의 선택자(`#main` 같은 것), 고정 헤더의 선택자, 지원 언어.

부수 항목(없으면 기본값)

| 항목 | 기본 | 뜻 |
|---|---|---|
| `PALETTE` | 배경색 하나, accent 하나 | 엔진 테마 색 |
| `TONE`, `STYLE` | clay diorama | 화풍(prompts.md 2절) |
| `CAMERA_FEEL` | 잔잔한 전진 활공 | 카메라 움직임 |
| `MOBILE` | no | yes 면 약 2배 비용(세로 체인 추가) |
| `STILLS_SOURCE` | gpt-image-2 | 코히전 강화가 필요하면 FLUX 옵트인 |
| `STEP_NAV` | no | yes 면 휠 1칸, 키, 스와이프가 정확히 한 장면을 이동(`step-nav.js`). 스크롤 동작을 가로채므로 사이트 성격을 보고 고른다 |
| `PANEL` | 없음 | `glass` 면 흐린 유리 문구 패널(`panel-glass.css`) |

---

## Step 2 - 계획과 비용 승인 (무료, 필수, 유료 호출 차단선)

유료 생성 **이전에** 계획 전체와 총액을 보여 주고 명시적 승인을 받는다.

- 계획: 장면 목록, 장면별 프롬프트(스타일 서문 + subject), 모델, 생성 횟수(변형 수, 클립 수), 예상 비용.
- two-image 커넥터를 검토 중이면 여기서 무료 probe 로 지원 여부만 확인해 추정에 반영한다.

```js
import { estimateCost, detectTwoImageSupport } from './references/azure-adapter.mjs';
const twoImage = wantConnectors && await detectTwoImageSupport({ endpoint, key }); // 무료 GET probe
const cost = estimateCost({ nScenes, seconds, twoImage, mode: CLIP_MODE === 'holdFlight' ? 'holdFlight' : 'chain' });
```

- 사용자에게 `cost.images` / `cost.videos` / `cost.usd` 와 BUDGET 대비를 보여준다.
- `cost.videos` 는 **Sora 단가($0.10/초) 기준**이다.
  WAN 단가와 계정별 무료 할당량은 API 로 조회할 수 없다(Model Studio 에 할당량 조회 API 가 문서화돼 있지 않음).
  그러니 "WAN 이 먼저 쓰이고, 실제 WAN 비용은 Model Studio 콘솔에서 확인, 키가 소진되면 이 Sora 추정이 적용된다" 고 그대로 알린다.
- `holdFlight` 는 장면 사이 비행 클립만 과금한다(기본 5초 x 장면 수-1). 정지 클립은 스틸을 인코딩해 무료다.
- WAN 클립 길이는 정수 2~30초(기본 5초), Sora 는 4, 8, 12초뿐이다. 폴백되면 길이가 가장 가까운 Sora 값으로 바뀐다(5초에서 4초).
- MOBILE=yes 면 세로 체인이 추가돼 대략 2배임을 명시한다.
- **명시적 승인이 없으면 여기서 멈춘다.**
- BUDGET 을 초과하면 씬 수, `seconds`, 품질을 줄이는 선택지를 제시하고 다시 추정한다.
- 승인된 예산은 이후 단계의 상한이다. 재생성으로 넘게 되면 그때 다시 승인을 받는다.

---

## Step 3 - 스틸과 검토 (유료, 승인 이후에만)

기본은 `AZURE_GPT_IMAGE_DEPLOYMENT` 배포(`generateImage`). gpt-image-2 계열은 16의 배수 크기(예: `720x1280`)를 그대로 받는다.
씬마다 `references/prompts.md` 의 스타일 서문 + 씬 subject 로 프롬프트를 만들되, **스타일 서문은 모든 씬에 글자 그대로 동일**하게 넣어 코히전을 만든다.

```js
import { generateImage, generateImageFlux, probeDims } from './references/azure-adapter.mjs';
const png = await generateImage({ endpoint, key, deployment, prompt, size: ORIENTATION, quality });
```

- **429 처리** - 낮은 티어(S0) 이미지 배포는 연속 호출에 `429 RateLimitReached` 를 낸다.
  `generateImage` 는 서버의 `Retry-After` 만큼 기다렸다가 같은 경로로 다시 시도한다(기본 3회, `retry429`). 그래도 실패하면 씬 사이에 간격을 두고 다시 부른다.
- **변형(권장)** - 씬마다 테이크를 2개 만들면 사용자가 비교해 고를 수 있다. 스틸 비용이 대략 씬당 2배이니 Step 2 추정에 미리 넣는다.
- **FLUX 옵트인** - 씬 간 톤, 질감 일관성을 더 원하면 `generateImageFlux({ width, height })`(ORIENTATION 을 나눠 전달).
  FLUX 크리덴셜을 요청했는데 미수집이면 조용히 실패하지 말고 `gpt-image-2` 로 **정직하게 폴백**한다("FLUX 미수집, gpt-image-2 로 진행").
- **N3 주의(씨앗 스틸 크기)** - `generateImage` 의 classic 폴백이 뜨면 반환 크기가 `1024x1536`(2:3)라 `720x1280` 이 아니다.
  체인 씨앗이 되는 스틸은 `probeDims` 로 확인해 ORIENTATION 과 다르면 영상 전에 리사이즈(ffmpeg `scale`)하거나 재생성한다.

**검토 페이지**(스틸 단계). 프로젝트 dir 에 `curate-input.json` 을 적는다. 테이크마다 만든 조건을 함께 적는다.

```json
{ "title": "Acme", "stage": "stills", "budgetUsd": 12, "spentUsd": 0.28,
  "scenes": [
    { "id": "s1", "label": "문제 제기", "takes": [
      { "file": "stills/s1-t1.png", "take": 1, "prompt": "…", "negativePrompt": "…", "model": "gpt-image-2",
        "size": "1280x720", "createdAt": "2026-10-10T09:00:00Z", "costUsd": 0.02 } ] } ] }
```

```bash
node references/curate.mjs <projectDir>          # CURATE http://localhost:<port>/ (백그라운드), 상태 <projectDir>/curate.server.json
node references/curate.mjs --stop <projectDir>   # 끝나면 종료
```

- 페이지는 산출물마다 카드 하나다. 미리보기, 장면과 테이크 번호, 프롬프트 전문, 제외 프롬프트, 모델, 크기, 생성 시각, 비용, 파일 경로, sha256 이 함께 보인다. 같은 장면의 테이크는 가로로 나란히 놓인다.
- 맨 위에 단계 이름, 승인된 장면 수와 전체 수, 누적 비용과 승인 예산이 보인다.
- 사용자는 페이지에서 테이크를 골라 승인하거나, 재생성 메모를 쓰거나, 테이크를 탈락시킨 뒤 "판정 저장" 을 누른다. 결과는 `decisions.json` 의 `stills` 에 남는다.
- 판정을 대화로 받으면 장면 번호와 테이크 번호로 기록한다.

  ```bash
  node references/curate.mjs --record <projectDir> --scene 2 --verdict approve --take 1
  node references/curate.mjs --record <projectDir> --scene 3 --verdict regenerate --note "글자가 깨짐"
  node references/curate.mjs --record <projectDir> --scene 3 --verdict reject --take 2
  ```

- `regenerate` 인 장면만 다시 만든다. 메모를 스타일 서문 뒤 subject 에 반영하고, 새 테이크를 `curate-input.json` 에 더한 뒤 페이지를 다시 보여 준다.
- 탈락한 테이크는 지우지 않고 날짜 폴더로 옮긴다: `node references/curate.mjs --archive <projectDir>`(`rejected-YYYYMMDD/`).
- **모든 장면이 `approve` 일 때만** Step 4 로 간다. 각 장면의 영상 씨앗은 그 장면의 `chosen` 이다. 승인되지 않은 테이크에는 영상비를 쓰지 않는다.

---

## Step 4 - 영상과 클립 검토 (유료)

모드는 Step 1 의 CLIP_MODE 다. 어느 모드든 모든 leg 는 `generateClip` 한 함수로 만든다. provider 순서(`VIDEO_PROVIDER_ORDER`, 기본 `wan,sora`)와 키 풀은 이 함수가 처리한다.

### 4A. chain (기본, 검증된 경로)

연속성은 **forward-chaining** 으로 만든다. 직전 클립의 **실제 마지막 프레임을 톤 변형 없이 그대로** 다음 클립의 첫 프레임으로 넣는다.
(시드 프레임에 histeq 톤 정합을 걸면 시작 톤이 바뀌어 연속성이 **오히려 나빠진다**. e2e 실측 raw-시드 SSIM ~0.59 대 histeq-시드 0.46. 톤 정합은 조립, 재생 계층에서 처리한다.)

```js
import { extractLastFrame, extractFirstFrame } from './references/azure-adapter.mjs';
import { generateClip, poolSummary } from './references/video-pool.mjs';
const log = (e) => console.log(JSON.stringify(e));   // submit / fail / wait / fallback / done 이벤트 (키 없음)

// Leg 0 - 씬 1 스틸에서 dive-in
let r = await generateClip({ creds, prompt: leg0, size: ORIENTATION, seconds, firstFramePng: scene1Still, onEvent: log });
fs.writeFileSync('dive-1.mp4', r.mp4);              // r.provider = 'wan' | 'sora', r.label = 'WAN_2' 등

// Leg i (i >= 1) - 직전 클립의 RAW 마지막 프레임을 그대로 다음 첫 프레임으로 (톤 변형 금지)
await extractLastFrame('dive-i.mp4', 'last-i.png');
r = await generateClip({ creds, prompt: legi, size: ORIENTATION, seconds, firstFramePng: fs.readFileSync('last-i.png'), onEvent: log });
```

- 각 leg 렌더 직후, 다음 leg 전에 마지막 프레임을 확인한다. 잔잔한 전진 활공 컷이 아니면 그 leg 를 재생성한다(나쁜 핸드오프 프레임이 뒤 leg 를 오염시킨다).
- 포스터: 씬 1 = 씬 1 스틸, 씬 i>=2 = `extractFirstFrame(clip_i)`(로딩 시 플래시 없음).
- `intro.json` 의 `connectors` 를 전부 `null` 로 두면 엔진이 인접 dive 를 직접 crossfade 한다.

### 4B. holdFlight (선택, 이 스킬에서 미검증)

장면마다 짧은 정지 클립을 두고, 장면 사이를 비행 클립으로 잇는다. 비행 클립은 첫 프레임과 끝 프레임을 모두 지정해, 앞뒤 장면과 프레임이 맞는다.
다른 프로젝트의 운영 사례에서 온 구성이다. 이 스킬의 WAN 첫, 끝 프레임 경로는 유료 스모크로 아직 확인하지 않았다. 사용자에게 그 사실을 알리고, 첫 비행 클립을 검토 페이지에서 먼저 확인받은 뒤 나머지를 만든다.

```js
import { stillToClip } from './references/azure-adapter.mjs';
import { generateClip } from './references/video-pool.mjs';
// 정지 클립: 승인된 스틸을 1초 영상으로 (무료, 모든 프레임이 그 스틸)
await stillToClip(`stills/${id}.png`, `clips/hold-${i}.mp4`, { size: ORIENTATION });
// 비행 클립: 앞 장면 스틸에서 뒤 장면 스틸로. Sora 는 끝 프레임을 받지 못하므로 WAN 만 쓴다.
const r = await generateClip({ creds, prompt: flight, size: ORIENTATION, seconds: 5, order: ['wan'],
  firstFramePng: fs.readFileSync(stillA), lastFramePng: fs.readFileSync(stillB), onEvent: log });
```

- 쓸 수 있는 WAN 키가 없으면 비행 클립을 만들지 않고 멈춘다. Sora 로 넘기면 끝 프레임이 무시돼 다음 장면과 이어지지 않는다. chain 모드로 바꿀지 사용자에게 묻는다.
- `intro.json`: `sections[i].clip` 은 정지 클립, `connectors[i]` 는 비행 클립이다. 권장 간격은 `diveScroll: 0.6`, `connScroll: 1.4` 다.
- 비행 프롬프트는 `references/prompts.md` 5절을 쓴다.

### 클립 공통

- **클립 검토**: `curate-input.json` 을 `"stage": "clips"` 로 다시 쓴다. 테이크마다 클립 파일, 프롬프트, 모델, 길이(`seconds`), 비행이면 `firstFrame`, `lastFrame`, 비용을 적고 같은 검토 페이지로 판정받는다(클립은 무음 반복 재생된다). 재생성은 지적받은 클립만 한다.
- **키 풀 동작** - WAN 키는 가장 오래전에 쓴 것부터 고른다. 할당량 소진(`AllocationQuota.*`, `Arrearage`, `BudgetLimitExceeded` 등)과 모델 권한 없음(`*AccessDenied`)은 그 키를 24시간 쉬게 하고 다음 키로 다시 제출한다.
  요청 속도 429(`Throttling.RateQuota` 등)는 `Retry-After` 만큼 그 키만 쉬게 할 뿐 퇴출하지 않는다. `Throttling.AllocationQuota` 만 연속 3회면 1시간 쉬게 한다. `InvalidApiKey` 키는 키를 바꿀 때까지 제외한다.
  상태는 `~/.config/banker/3d-intro/video-pool-state.json` 에 지문(엔드포인트, 키, 모델)으로만 남는다.
- **같은 leg 를 두 번 과금하지 않는다** - 다른 키로 다시 제출하는 것은 첫 제출이 task 를 만들지 않은 게 확실할 때뿐이다(서버가 거절, 요청을 보내기 전 연결 실패, task 가 키 할당량이나 알려진 일시 오류로 FAILED/CANCELED).
- **폴백(chain 모드)** - 쓸 수 있는 WAN 키가 없으면 그 leg 부터 Sora 로 만든다. 체인 도중에 provider 가 바뀌면 화풍이 달라질 수 있으니 leg 마다 `r.provider` 를 기록하고 바뀐 지점을 알린다.
- **멈추는 경우(재제출, 폴백 안 함)** - 아래 오류에서 같은 leg 를 `generateClip` 으로 다시 부르지 않는다.

  | 오류 | 뜻 | 다음 행동 |
  |---|---|---|
  | `ContentRejectedError` | 검열(`DataInspectionFailed` 등) | 프롬프트나 프레임을 고쳐 다시 부름 |
  | `kind: 'invalid_request'` | 요청 형식 오류, `ModelNotFound`, 모든 WAN 항목의 형식 오류, Sora 크레덴셜 없이 Sora resume | 설정을 고침(task 는 생기지 않음) |
  | `kind: 'timeout'` / `'download'` | task 는 있음(과금됐을 수 있음) | `resumeClip({ creds, provider: err.provider, label: err.label, taskId: err.taskId, seconds: err.seconds })` |
  | `kind: 'submit_unknown'` / `'task_lost'` / `'no_video'` / `'failed'` | 결과를 알 수 없음 | Model Studio 콘솔(또는 Azure)에서 task 를 확인한 뒤 사용자와 정함 |
  | `kind: 'unreachable'` | Sora 연결 거부(아무것도 보내지 않음) | 네트워크를 확인한 뒤 다시 부름 |
  | `kind` 가 없는 오류 | 예상하지 못한 실패 | 원인을 확인하기 전에는 다시 부르지 않음 |

- 클립 해상도는 WAN 과 Sora 가 조금 다를 수 있다. `concatClips` 와 엔진이 크기를 맞춘다.

---

## Step 5 - 조립과 미리보기 (무료)

씬, 커넥터, 테마를 `intro.json` 매니페스트로 적고(`assemble.mjs` 헤더에 형식), 조립한 뒤 서빙한다.
카피(`eyebrow`, `title`, `body`, `tags`)와 `theme`, 그리고 선택 항목을 채운다.

| 매니페스트 항목 | 쓰임 |
|---|---|
| `lang` | `<html lang>` |
| `panel: "glass"` | 흐린 유리 문구 패널 |
| `stepNav: { "end": "#main" }` | 장면 단위 이동. `end` 는 기존 사이트의 본문 시작(단독 페이지면 생략). 나머지 옵션은 `step-nav.js` 머리말 |

```bash
node references/assemble.mjs <projectDir>                    # <projectDir>/site 에 페이지를 만들고 styleHash 를 알린다
node references/serve.mjs <projectDir>/site                  # PREVIEW http://localhost:<port>/ (백그라운드)
node references/serve.mjs <projectDir>/site --csp strict     # 사이트에 CSP 가 있으면: 그 정책 문자열이나 strict
node references/serve.mjs --stop <projectDir>/site           # 끝나면 종료
```

- 페이지에는 인라인 script, style 이 없다. 설정은 `intro.js`, 테마는 `theme.css`, 엔진 CSS 는 `scrub-engine.css` 다.
  엔진은 여전히 `<style>` 하나를 주입하려 한다. CSP 가 있는 사이트는 조립이 알려 준 `styleHash` 를 `style-src` 에 더하면 콘솔 오류가 남지 않는다(더하지 않아도 같은 규칙이 `scrub-engine.css` 로 적용된다).
- 엔진은 클립을 `fetch` 로 받아 `blob:` 으로 재생한다. CSP 에 `media-src 'self' blob:` 이 필요하다.
- `intro-fixes.css` 는 항상 붙는다. 엔진의 인라인 transform 이 덮는 패널 세로 가운데 맞춤(`translate`), 860px 이하에서 장면 점과 겹치지 않는 오른쪽 여백, 고정 헤더를 깨는 `overflow-x: hidden` 대신 `clip` 을 담는다.
- 기존 사이트에 붙이는 미리보기는 반드시 운영과 같은 CSP 헤더로 서빙한다. 일반 정적 서버에서는 CSP 오류가 보이지 않는다.
- 상태 파일(`<site>.server.json`)은 서빙 폴더 밖에 생긴다. 종료는 `--stop` 으로 한다. 명령줄 패턴으로 `pkill -f` 하지 않는다.
- 휴대폰 실기기로 볼 때만 `PREVIEW_HOST=0.0.0.0` 을 쓴다. 같은 네트워크에 미공개 산출물이 보인다는 경고가 나온다.
- 프로젝트 관례상 **claude.ai 아티팩트를 만들지 않는다** - 로컬 페이지를 포트로 서빙해 사용자가 브라우저로 확인한다.
- 사용자 검토를 받는다. 지적이 있으면 카피, 매니페스트, 해당 클립만 고치고 다시 조립한다.

---

## Step 6 - 독립 검증 (무료, 필수)

작성자와 다른 주체가 측정해 판정한다. Claude Code 는 쓰기 도구 없는 별도 에이전트, Codex 는 `spawn_agent` 로 띄운 검증자가 맡는다.

```bash
node references/verify-intro.mjs http://localhost:<port>/ --out <projectDir>/verify.json [--header "<사이트 헤더 선택자>"]
```

- 화면 크기마다 새 브라우저 컨텍스트로 잰다(재빌드 뒤 재사용 컨텍스트는 예전 CSS 를 캐시에서 준다). 기본 화면은 1280x800, 1920x1080, 860x900, 390x844 터치, 375x667 터치다. 지원 언어마다 그 언어 페이지 주소로 다시 돌린다.
- 장면마다 패널이 화면 안, 헤더 아래에 있는지, 안내, 건너뛰기, 버튼, 장면 점과 겹치지 않는지, 가로 넘침, 콘솔 오류, 글자 줄 단위 대비(글자를 숨긴 채 가장 나쁜 배경 픽셀 기준, 4.5 이상)를 잰다.
- 장면 단위 이동이면 입력도 잰다: 직전 장면에서 휠 1칸과 관성 1회가 마지막 장면에 멈추는지, 마지막 장면에서 입력 방식별 본문 도착과 위 입력 복귀, 메인화면 버튼과 건너뛰기 링크. 움직임 줄이기 설정은 `--viewports 1280x800r` 로 따로 잰다.
- 눈으로 볼 항목은 `references/verify.md` 에 있다.
- 실패가 0 이고 검증자가 APPROVE 해야 Step 7 이나 완료 보고로 간다. 실패가 있으면 고친 뒤 같은 검증자로 다시 잰다.

---

## Step 7 - 통합과 배포 (요청 시에만)

사용자가 기존 사이트 통합이나 배포를 요청했을 때만 한다.

- 백업을 먼저 한다. 백업은 프로젝트의 `backup/` 아래에 둔다. `/tmp` 는 쓰지 않는다.
- `site/` 의 파일을 사이트의 정적 폴더로 옮긴다. `#world` 를 본문 위에 두고, `stepNav.end` 는 본문 시작 요소를 가리킨다.
- 사이트 CSP 에 `media-src 'self' blob:` 과 `styleHash` 를 더한다. 인라인을 허용하지 않아도 된다.
- 배포 뒤 운영 주소에 `verify-intro.mjs` 를 다시 돌려 결과를 대조해 보고한다.

---

## Step 8 - 정리와 완료 보고

- 서버를 모두 끈다: `curate.mjs --stop <projectDir>`, `serve.mjs --stop <projectDir>/site`. 상태 파일이 남지 않았는지, 포트가 닫혔는지 확인한다.
- 검토 페이지 입력, 임시 캡처처럼 산출물이 아닌 파일은 사용자에게 목록을 보이고 지운다. `decisions.json` 과 탈락 폴더는 기록이라 남긴다.

보고 항목

- 산출물 경로(`site/index.html`)와 프리뷰 URL(포트, 이미 종료했으면 그 사실).
- 씬 수, CLIP_MODE, `seconds`, ORIENTATION, 사용 모델(이미지 배포명 / FLUX, 커넥터 경로).
- leg 별 영상 provider 와 키 라벨(`WAN_2`, `AZURE_SORA` 등), 폴백이 일어난 leg, 끝난 뒤의 `poolSummary`.
- **실제 소요 비용**(추정 대비, 승인 예산 대비).
- 독립 검증 결과(화면 크기별 실패 수, 판정).
- 이음매 품질은 경로에 따라 **정직하게** 쓴다. 과장하지 않는다.
  - chain: **near-seamless** 하되 **경미한 톤/디테일 drift** 가 있을 수 있다(pre-composite raw SSIM ~0.59).
  - holdFlight: 비행 클립의 첫과 끝 프레임이 장면 스틸과 맞으면 이음매가 없다. 이 스킬에서는 미검증 경로이므로 실제로 확인한 결과만 쓴다.
  - 수용 기준은 조립, 서빙된 페이지의 실제 스크럽 경험이다.
- 재생성한 스틸이나 클립이 있으면 그 사유.

## 흔한 함정

- 엄격한 CSP: 엔진이 `<style>` 을 주입하고 `blob:` 영상을 재생한다. 조립 결과와 `styleHash`, `media-src 'self' blob:` 로 해결한다.
- 로컬 검증은 운영과 같은 CSP 헤더를 붙인 서버로 한다.
- 재빌드 뒤 브라우저 자동화는 새 컨텍스트로 한다.
- 엔진의 `html,body{overflow-x:hidden}` 이 고정 헤더를 깬다. `intro-fixes.css` 가 `clip` 으로 바꾼다.
- 위치 비교는 소수점이 어긋난다(81.3 대 81). 1px 여유를 둔다.
- 움직임 줄이기 설정에서는 엔진이 클립을 받지 않는다. 클립 재생 완료에 기대는 표시(메인화면 버튼 등)는 이때도 나타나야 한다.
- 가로로 돌린 휴대폰(예: 844x390)에서는 마지막 장면의 버튼이 잘릴 수 있다. 지원한다면 그 크기를 검증에 더한다.
