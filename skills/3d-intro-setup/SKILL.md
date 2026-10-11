---
name: 3d-intro-setup
description: "`3d-intro-build` 에 필요한 Node 18 이상과 ffmpeg 를 갖추고 Azure 크레덴셜과 선택 항목인 WAN API 키 풀을 저장함. 엔드포인트와 배포명은 대화로 받고, 키는 사람이 비공개 키 파일에 직접 적거나 콘솔 샘플 파일에서 화면에 내지 않고 합쳐(채팅과 명령줄에 키를 싣지 않음), 무과금 프리플라이트로 확인. 'setup-3d-intro'/'3d-intro-setup'/'3D 인트로 설정'/'Azure Sora 크레덴셜' 또는 `/banker:setup` 시 사용."
---

# 3d-intro-setup — Azure Sora-2 / gpt-image-2 3D 인트로 제작 전제조건 설치

Azure Sora-2(영상 생성)·gpt-image-2(이미지 생성) 기반 3D 인트로 제작의 실행 전제조건을 설치·검증한다.
실제 인트로 제작(이미지·영상 생성, 과금 발생)은 `3d-intro-build` 스킬이 담당하고, 이 스킬은 Node/ffmpeg 확보와 크레덴셜 저장, **무과금** 연결 확인까지만 담당한다.
모든 Azure 호출은 이 스킬 디렉터리의 `references/azure-adapter.mjs`, WAN(Alibaba Model Studio) 호출은 `references/video-pool.mjs` 를 통해서만 수행한다.
두 파일 모두 수정 금지이며 `3d-intro-build` 와 byte-identical 공유 사본이다.
영상은 WAN 키 풀이 먼저 쓰이고, 풀의 키가 모두 소진되면 Sora-2 로 폴백한다. WAN 은 선택 항목이라 없으면 Sora 만 쓴다.
**OS·arch·기존 설치/크레덴셜 여부를 먼저 감지**해 알맞은 경로를 고른다.
설치는 **멱등**(이미 있으면 skip·검증만). 답변은 한글(기술 토큰 영문).

## 0. 감지 (먼저 — 추정 금지)
```bash
echo "OS=$(uname -s)"
echo "ARCH=$(uname -m)"
[ -f /etc/os-release ] && . /etc/os-release && echo "distro=$ID ${VERSION_ID}"
command -v node   >/dev/null && echo "node=$(node -v)"        || echo "node=미설치"
command -v npm    >/dev/null && echo "npm=$(npm -v)"           || echo "npm=미설치"
command -v ffmpeg >/dev/null && ffmpeg -version 2>&1 | head -1 || echo "ffmpeg=미설치"
```
```powershell
$PSVersionTable.PSVersion
if (Get-Command node -ErrorAction SilentlyContinue) { node -v } else { "node: 미설치" }
if (Get-Command ffmpeg -ErrorAction SilentlyContinue) { (ffmpeg -version)[0] } else { "ffmpeg: 미설치" }
```
이 스킬과 어댑터의 절대경로를 이후 모든 스니펫에서 재사용한다(치환 후 사용):
```bash
SKILL_DIR="<이 SKILL.md 가 위치한 디렉터리의 절대경로>"   # 예: .../skills/3d-intro-setup
ADAPTER="$SKILL_DIR/references/azure-adapter.mjs"
POOL="$SKILL_DIR/references/video-pool.mjs"
```
**이미 확보 확인**: `node -v` 가 18 이상이고 `ffmpeg` 가 있으면 §1~§2 는 건너뛴다.
크레덴셜도 이미 완전하면(§3 첫 단계) 프롬프트 없이 §4 프리플라이트로 직행한다.

## 1. Node ≥18 확보
어댑터가 global `fetch`/`FormData`/`Blob` 등 Node 18+ 내장 기능만 쓴다(추가 의존성 없음) — 18 미만이면 어댑터 자체가 동작하지 않는다.
이미 nvm 등으로 관리 중이면 `nvm install --lts && nvm alias default 'lts/*'` 로 충분하다.
OS별 상세 설치 절차(Ubuntu NodeSource·RHEL8/Rocky8 dnf 모듈·Windows winget·PATH 충돌 등)는 반복하지 않고 **`setup-node` 스킬로 위임**한다 — 이 스킬은 결과(`node -v` ≥18)만 확인한다.

## 2. ffmpeg 확보
어댑터의 프레임 추출·컬러 매치·크로스페이드·이어붙이기(`extractLastFrame`·`colorMatch`·`crossfade`·`concatClips`, forward-chaining 이음새 처리)가 `ffmpeg` 바이너리를 요구한다.
설치 절차는 `motion-graphic-setup` §2 와 같으므로 반복하지 않고 요약만 남긴다(전체 함정은 그 스킬 참조. 마지막 폴백의 설치 위치만 다르다):
- macOS: `brew install ffmpeg`
- Ubuntu/Debian: `sudo apt-get install -y ffmpeg`
- RHEL8/Rocky8: BaseOS/AppStream 미포함(라이선스) → RPM Fusion 후 `dnf install -y ffmpeg`
- Windows: `winget install --id Gyan.FFmpeg -e`
- 전부 막히면(권한/오프라인) 홈 폴더의 전용 폴더에 `ffmpeg-static` 을 받는다. 프로젝트 안에서 npm 을 돌리면 그 프로젝트의 `.npmrc` 와 스크립트가 끼어든다:
  `(cd ~ && npm install --prefix ~/.config/banker/3d-intro/tools ffmpeg-static)` 후 `export FFMPEG_PATH="$(cd ~ && node -p "require(require('path').resolve('.config/banker/3d-intro/tools/node_modules/ffmpeg-static'))")"`

**★ banker 플러그인 자체(스킬 파일·npm 패키지 배포물)에는 ffmpeg 바이너리를 절대 번들하지 않는다** — 위 설치는 전부 사용자 시스템(홈 폴더 포함)에만 적용된다(motion-graphic-setup과 동일 원칙).

검증은 `ffmpeg -version` 대신 **어댑터가 실제 쓰는 해석 로직**(`resolveFfmpeg`: 셸의 `$FFMPEG_PATH` → 홈 설정 파일 `~/.config/banker/3d-intro/settings.env` 의 `FFMPEG_PATH` → 예전 판이 홈 키 파일 `env` 에 남긴 `FFMPEG_PATH` → `PATH` 의 절대 경로 항목 → `ffmpeg-static` 순. 경로는 모두 절대 경로만)으로 한다 — 이게 통과해야 3d-intro-build 가 실제로 ffmpeg 를 찾는다.
셸의 `FFMPEG_PATH`(export, 절대 경로만 받는다)로만 찾았으면 셸 세션 한정이라, 그 경로를 **홈 설정 파일 `settings.env` 에 `FFMPEG_PATH=` 로 영속**해 다른 세션의 3d-intro-build 도 찾게 한다. 시스템 `ffmpeg` 가 `PATH` 에 있으면 영속은 필요 없다. 이 파일에는 키를 두지 않아, 키 파일을 어디에 만들지 정하는 §3 에 영향을 주지 않는다.
실행할 프로그램의 경로는 프로젝트 키 파일(`.env.3d-intro.local`)에 두지 않고, 거기 적힌 값은 읽지 않는다. 그 파일은 저장소와 함께 올 수 있어, 남이 만든 저장소가 이 기기에서 실행할 프로그램을 정하게 되기 때문이다.
```bash
node -e "
(async () => {
  const { resolveFfmpeg, resolveCreds, persistCreds, readSettings, homeSettingsPath } = await import('$ADAPTER');
  const proj = resolveCreds({ projectDir: process.cwd() });
  if (proj._ignored) console.log('프로젝트 키 파일에서 쓰지 않는 값:', Object.keys(proj._ignored).join(', '));   // 값은 출력하지 않는다
  const ff = await resolveFfmpeg().catch((e) => { console.log('ffmpeg 미확보:', e.message); process.exit(1); });
  console.log('ffmpeg 확보:', ff);
  const s = readSettings();   // 홈 설정 파일(키는 두지 않음)
  if (ff === process.env.FFMPEG_PATH && s.FFMPEG_PATH !== ff) { persistCreds({ ...s, FFMPEG_PATH: ff }, { target: homeSettingsPath() }); console.log('FFMPEG_PATH 영속 ->', homeSettingsPath()); }
})();
"
```
`프로젝트 키 파일에서 쓰지 않는 값` 이 보이면 예전 판이 그 파일에 남긴 ffmpeg 경로다. 값은 출력하지 않으니 사람이 파일을 열어 그 경로가 맞는지 확인하고, 맞으면 셸에서 `export FFMPEG_PATH=<그 경로>` 한 뒤 이 명령을 다시 돌려 홈 설정 파일에 남긴다.

## 3. 크레덴셜 입력
**★시크릿(API key)은 사용자만 입력 — 채팅 로그·커밋·리포트에 원문 노출 금지, 항상 `redact()` 결과만 표기한다.**

### 이미 있으면(멱등) — 재입력 금지
```bash
node -e "
(async () => {
  const { resolveCreds, redact } = await import('$ADAPTER');
  const c = resolveCreds({ projectDir: process.cwd() });
  const need = ['AZURE_SORA_ENDPOINT','AZURE_SORA_API_KEY','AZURE_IMAGE_OPENAI_ENDPOINT','AZURE_IMAGE_API_KEY','AZURE_GPT_IMAGE_DEPLOYMENT'];
  const missing = need.filter(k => !c[k]);
  if (c._source && missing.length === 0) {
    console.log('기존 크레덴셜 발견:', c._source, '| Sora key', redact(c.AZURE_SORA_API_KEY), '| Image key', redact(c.AZURE_IMAGE_API_KEY));
    process.exit(0);
  }
  console.log(c._source ? ('불완전한 크레덴셜(' + c._source + ') -- 누락: ' + missing.join(',')) : '크레덴셜 없음 -- 아래 모드(a)/(b)로 입력 필요');
  process.exit(1);
})();
"
```
exit 0(완전한 크레덴셜 발견)이면 아래 입력 단계를 건너뛰고 **§4 프리플라이트로 직행**(검증만, 재프롬프트 금지).
프리플라이트가 401/403 으로 실패할 때만 아래로 돌아와 재입력(로테이션)한다.

### 리소스 구성(Sora·Image 필수, WAN 풀·FLUX 선택)
Sora(영상)와 gpt-image(이미지)는 **보통 서로 다른 Azure 리소스**(엔드포인트·키가 다를 수 있음) — 두 세트를 각각 받는다.
WAN 영상 풀(§3-WAN)은 선택이지만, 있으면 영상이 WAN 으로 먼저 만들어진다.
FLUX.2-pro(대체 이미지 생성)는 **opt-in**: 필요 없으면 완전히 건너뛴다(§3-FLUX 참조).

### 키는 사람이 파일에 적는다
**API key 는 채팅으로 받지 않고, 에이전트가 실행하는 명령에도 넣지 않는다.** `node -e "..."` 인자는 `ps` 출력과 대화 기록에 그대로 남는다.
키는 사람이 아래 비공개 키 파일에 편집기로 직접 적거나(모드 a), 콘솔 샘플을 파일로 저장해 에이전트가 화면에 내지 않고 합친다(모드 b).
엔드포인트, 배포명, API 버전은 비밀이 아니라 대화로 받아도 된다.

키 파일은 먼저 비공개로 만든다(이미 있으면 그대로 둔다). `echo >>` 로 새 파일을 만들면 0644 로 남는다.
홈 키 파일(아래 fallback)이 이미 있으면 프로젝트 파일을 만들지 않는다. 빈 프로젝트 파일이 먼저 읽혀 홈의 키가 가려진다.
```bash
[ -e ~/.config/banker/3d-intro/env ] || (umask 077 && touch .env.3d-intro.local)
ls -l .env.3d-intro.local ~/.config/banker/3d-intro/env 2>/dev/null || true   # 있는 파일이 -rw------- 면 된다
```
여러 프로젝트에서 재사용하려면 프로젝트 파일 대신 홈 폴더 fallback 을 쓴다. `resolveCreds` 가 project-local 다음으로 찾는 경로다.
```bash
mkdir -p ~/.config/banker/3d-intro && chmod 700 ~/.config/banker/3d-intro && (umask 077 && touch ~/.config/banker/3d-intro/env)
```
그 프로젝트의 `.gitignore` 에 무시 규칙이 있는지 확인하고 없으면 추가한다(이 저장소는 `.env.*.local` 로 이미 커버된다):
```bash
grep -qE '^\.env\.3d-intro\.local$|^\.env\.\*\.local$' .gitignore 2>/dev/null || echo '.env.3d-intro.local' >> .gitignore
```

### 모드 (a) — 직접 입력
엔드포인트와 배포명을 리소스별로 대화로 묻는다: endpoint(예: `https://<resource>.openai.azure.com` 또는 `https://<resource>.cognitiveservices.azure.com`), 배포명(deployment).
- **Sora**: endpoint (+ 배포명, 기본 `sora-2` — 콘솔에서 다른 이름으로 배포했으면 그 이름).
- **Image(gpt-image 계열)**: endpoint + 배포명(예: `gpt-image-2`, `gpt-image-2.5-sunburst`. 필수 — 생성 호출의 `model` 필드로 그대로 쓰인다).
  AI Foundry 리소스(`https://<resource>.services.ai.azure.com`)도 그대로 쓴다. 콘솔이 `.../models` 를 붙여 보여줘도 저장은 origin 까지만 한다(이미지 경로는 `/openai/v1/images/...` 이고 `/models/images/...` 는 404).

비밀이 아닌 값은 에이전트가 `persistCreds()` 로 합친다(파일 전체를 새로 쓰되 기존 값, 사람이 적은 키 포함, 은 그대로 둔다. 0600 자동 적용). 키 칸은 이 명령에 넣지 않는다.
쓰는 곳은 `resolveCreds` 가 이미 읽는 키 파일(홈 fallback 포함)이고, 없을 때만 프로젝트 파일이다. 홈 파일을 쓰는 사람에게 프로젝트 파일을 새로 만들면 그 파일이 먼저 읽혀 홈의 키가 가려진다:
```bash
node -e "
(async () => {
  const { persistCreds, resolveCreds } = await import('$ADAPTER');
  const path = require('path');
  const prev = resolveCreds({ projectDir: process.cwd() });
  const target = prev._source || path.join(process.cwd(), '.env.3d-intro.local');
  const written = persistCreds({ ...prev,
    AZURE_SORA_ENDPOINT: '<입력값>', AZURE_SORA_DEPLOYMENT: '<입력값 또는 sora-2>', AZURE_SORA_API_VERSION: '<입력값 또는 preview>',
    AZURE_IMAGE_OPENAI_ENDPOINT: '<입력값>', AZURE_GPT_IMAGE_DEPLOYMENT: '<입력값>', AZURE_GPT_IMAGE_API_VERSION: '<입력값 또는 preview>',
  }, { target });
  console.log('저장:', written);
})();
"
```
그다음 사람에게 키 파일을 편집기로 열어 키 줄을 직접 적어 달라고 한다(값은 대화에 붙이지 않는다):
```
AZURE_SORA_API_KEY=<Sora 리소스 키>
AZURE_IMAGE_API_KEY=<Image 리소스 키>
```
적었다고 하면 위 "이미 있으면" 확인을 다시 돌린다. 키는 길이로만 표시된다.

### 모드 (b) — 콘솔 샘플 파일
Azure AI Foundry/AI Hub 콘솔의 "Sample code"/"View code" 패널이 주는 curl 또는 Python 스니펫에는 원문 키가 들어 있다. 사람이 이것을 **채팅에 붙이지 않고** 비공개 파일에 저장한다:
```bash
mkdir -p ~/.config/banker/3d-intro && (umask 077 && touch ~/.config/banker/3d-intro/sample.txt)   # 사람이 이 파일에 샘플을 붙여 저장
```
에이전트는 그 파일을 읽어 키를 화면에 내지 않고 키 파일에 바로 합친 뒤 샘플 파일을 지운다. 리소스마다 마지막 인자를 `sora`, `image`, `wan:<n>` 중 하나로 준다:
```bash
node -e "
(async () => {
  const fs = require('fs'), path = require('path');
  const { parseConsoleSample, persistCreds, resolveCreds, redact } = await import('$ADAPTER');
  const [file, kind] = process.argv.slice(1);
  const p = parseConsoleSample(fs.readFileSync(file, 'utf8'));
  const names = kind === 'sora' ? { endpoint: 'AZURE_SORA_ENDPOINT', apiKey: 'AZURE_SORA_API_KEY', deployment: 'AZURE_SORA_DEPLOYMENT', apiVersion: 'AZURE_SORA_API_VERSION' }
    : kind === 'image' ? { endpoint: 'AZURE_IMAGE_OPENAI_ENDPOINT', apiKey: 'AZURE_IMAGE_API_KEY', deployment: 'AZURE_GPT_IMAGE_DEPLOYMENT', apiVersion: 'AZURE_GPT_IMAGE_API_VERSION' }
    : { endpoint: 'WAN_' + kind.slice(4) + '_ENDPOINT', apiKey: 'WAN_' + kind.slice(4) + '_API_KEY' };
  const prev = resolveCreds({ projectDir: process.cwd() });
  const target = prev._source || path.join(process.cwd(), '.env.3d-intro.local');
  const add = Object.fromEntries(Object.entries(names).filter(([f]) => p[f]).map(([f, name]) => [name, p[f]]));
  const was = (() => { try { return new URL(prev[names.endpoint]).origin; } catch { return null; } })();
  if (p.endpoint && was && p.endpoint !== was && add[names.apiKey] === undefined) {   // 다른 리소스인데 키가 없음
    console.log(JSON.stringify({ file: target, endpointChanged: { from: was, to: p.endpoint } }));
    process.exit(3);
  }
  const old = prev[names.apiKey];
  persistCreds({ ...prev, ...add }, { target });
  const replaced = old && add[names.apiKey] && old !== add[names.apiKey] ? redact(old) : null;
  console.log(JSON.stringify({ file: target, endpoint: p.endpoint, deployment: p.deployment, apiVersion: p.apiVersion, apiKey: redact(p.apiKey), replaced }));
})();
" "$HOME/.config/banker/3d-intro/sample.txt" sora
rm -f "$HOME/.config/banker/3d-intro/sample.txt"
```
파싱 결과(저장한 파일, 엔드포인트, 배포명, apiVersion, 길이만 보이는 key)를 사람에게 보여 주고 확인받는다.
`replaced` 에 길이가 보이면 파일에 있던 다른 키를 이 샘플의 키로 바꾼 것이다. 교체(로테이션)가 아니었다면 사람이 키 파일의 키 줄을 다시 적는다.
출력에 `endpointChanged` 가 있으면(node 는 exit 3, 블록은 다음 `rm -f` 때문에 0) 샘플의 endpoint 가 키 파일의 것과 다른데 샘플에 키가 없다는 뜻이다. 기존 키가 새 host 로 가지 않도록 아무것도 저장하지 않았다. 다른 리소스로 바꾸는 것이면 사람이 키 파일의 endpoint 와 키 줄을 함께 고친다.
샘플의 SDK 코드에서 키는 따옴표 안의 값만 읽는다. `api_key=subscription_key` 처럼 변수 이름이면 키로 보지 않아 기존 키를 덮지 않는다.
필드가 `null` 이면(정규식 미매치, 또는 URL 이 아닌 endpoint) 그 필드만 모드 (a) 로 보완한다. 키가 샘플에 변수(`$AZURE_API_KEY` 등)로만 있으면 키 파일에 사람이 직접 적는다.

### WAN 영상 풀 (선택, 권장)
Alibaba Cloud Model Studio 의 WAN 영상 모델(기본 `wan3.0-video-prime`)을 여러 API 키로 돌린다. 키(workspace)마다 할당량이 따로라 키가 많을수록 오래 쓴다.
키마다 아래 두 줄을 번호를 붙여, 위 비공개 키 파일에 사람이 직접 적는다(콘솔 샘플 파일이 있으면 모드 (b) 를 `wan:<n>` 으로 돌린다). 번호 개수 제한은 없다.
```
# endpoint 는 origin 만 (경로 제외)
WAN_1_ENDPOINT=https://ws-<workspace-id>.<region>.maas.aliyuncs.com
WAN_1_API_KEY=sk-ws-...
WAN_2_ENDPOINT=...
WAN_2_API_KEY=...
# 선택. 키 하나만 모델이 다르면 WAN_<n>_MODEL
WAN_MODEL=wan3.0-video-prime
```
- 콘솔 샘플(curl)은 모드 (b) 로 파일에서 읽는다. 키는 샘플에 실제 값(`Bearer sk-ws-...`)이 있을 때만 뽑히고, `$DASHSCOPE_API_KEY` 같은 변수면 사람이 키 파일에 직접 적는다. JSON 본문의 `"model"` 은 뽑히지 않으니 `WAN_MODEL` 로 따로 넣는다.
- 엔드포인트, 키, 모델의 리전이 같아야 한다. 다르면 `401 InvalidApiKey` 가 난다.
- 값 뒤의 주석은 `#` 앞에 공백이 있어야 주석으로 읽힌다(`값  # 메모`). 공백 없이 붙은 `#` 는 값의 일부다. 값에 ` #` 이 들어가야 하면 따옴표로 감싼다.
- endpoint 가 https URL 이 아니거나(`http://` 는 키가 평문으로 가므로 막는다. 이 기기의 localhost 만 예외) 모델이 한 id 가 아닌 항목은 build 가 건너뛴다. 모든 WAN 항목이 그렇다면 build 는 Sora 로 넘어가지 않고 멈춘다.
- 선택 설정(모두 기본값이 있음): `VIDEO_PROVIDER_ORDER`(기본 `wan,sora`), `WAN_RESOLUTION`(기본은 출력 크기에서 계산), `WAN_PROMPT_EXTEND`(기본 `false`), `WAN_MAX_CONCURRENT`(기본 5), `WAN_EXHAUSTED_TTL_HOURS`(기본 24).
- 소진·쿨다운 기록은 `~/.config/banker/3d-intro/video-pool-state.json` 에 지문(엔드포인트, 키, 모델)으로만 남는다. 키나 모델을 바꾸면 지문이 바뀌어 기록이 새로 시작된다.

### FLUX.2-pro (opt-in)
필요할 때만: endpoint 하나 추가(`AZURE_IMAGE_SERVICES_ENDPOINT`) — 같은 리소스에 배포된 경우가 많아 키는 기본적으로 `AZURE_IMAGE_API_KEY` 를 재사용한다. 다른 리소스면 그 키를 `AZURE_IMAGE_SERVICES_API_KEY=` 줄로 사람이 키 파일에 직접 적는다(채팅으로 받지 않는다).
FLUX 는 이 스킬의 §4 프리플라이트 대상이 아니다(무과금으로 확인할 별도 엔드포인트가 없음).
저장만 하고 실제 연결 확인은 생략한다(graceful skip) — 첫 실제 사용 시점(3d-intro-build)으로 미룬다.

## 4. 프리플라이트 (무과금)
**여기서는 어떤 유료 생성도 실행하지 않는다** — 이미지 생성, Sora-2·WAN 영상 생성 어느 쪽도 호출하지 않는다.
아래 세 가지만 수행한다: (1) Sora `listVideos` GET(목록 조회는 무료) (2) Image 는 `azFetch` 로 **body `{model:<배포명>}` (프롬프트 누락) POST** — 배포로 라우팅된 뒤 프롬프트 누락으로 생성 전 `400 missing_required_parameter` 로 거부되므로 과금 0이고, 엔드포인트·인증에 더해 **배포명까지** 무료로 검증된다. (빈 `{}` 는 model 이 없어 `404 DeploymentNotFound` 로 갈려 배포명을 확인하지 못한다.) (3) WAN 은 키마다 존재하지 않는 task 를 GET(`probeWanPool`) — 맞는 키는 200(`task_status: UNKNOWN`), 틀린 키는 `401 InvalidApiKey` 다(2026-10-09 실측).
```bash
node -e "
(async () => {
  const { resolveCreds, listVideos, azFetch, redact } = await import('$ADAPTER');
  const c = resolveCreds({ projectDir: process.cwd() });
  if (!c._source) { console.log('크레덴셜 없음 -- §3 먼저 실행'); process.exit(2); }
  const how = (r) => (r.error ? r.error.cause?.code || r.error.code || r.error.name : r.authStyle);   // status 0 이면 이유
  const sora = await listVideos({ endpoint: c.AZURE_SORA_ENDPOINT, key: c.AZURE_SORA_API_KEY, apiVersion: c.AZURE_SORA_API_VERSION || 'preview' });
  console.log('sora.listVideos ->', sora.status, '(' + how(sora) + ')');
  const imgv = c.AZURE_GPT_IMAGE_API_VERSION || 'preview';
  const imgUrl = c.AZURE_IMAGE_OPENAI_ENDPOINT + '/openai/v1/images/generations?api-version=' + imgv;
  const img = await azFetch(imgUrl, { key: c.AZURE_IMAGE_API_KEY, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: c.AZURE_GPT_IMAGE_DEPLOYMENT }) });
  console.log('images.badreq ->', img.status, '(' + how(img) + ')');
  const { probeWanPool } = await import('$POOL');
  const wan = await probeWanPool({ creds: c });
  for (const w of wan) console.log('wan.probe', w.label, w.host, w.model, '->', w.status, w.code || '', '| key', w.key);
  if (!wan.length) console.log('wan.probe -> WAN 항목 없음 (영상은 Sora 만 사용)');
  const pass = sora.status === 200 && img.status === 400 && wan.every((w) => w.authOk);
  console.log(pass ? 'PREFLIGHT PASS -- \$0 과금' : 'PREFLIGHT FAIL');
  console.log('source:', c._source, '| Sora key', redact(c.AZURE_SORA_API_KEY), '| Image key', redact(c.AZURE_IMAGE_API_KEY));
  process.exit(pass ? 0 : 1);
})();
"
```
**판정 기준(모두 충족해야 PASS)**:
| 체크 | 기대 | 의미 |
|---|---|---|
| `sora.listVideos` | HTTP 200 | Sora 엔드포인트 살아있음 + 키 인증됨 |
| `images.badreq` | HTTP 400 (`missing_required_parameter`) | Image 엔드포인트 살아있음 + 키 인증됨 + **배포명 라우팅됨**(프롬프트 누락이라 생성 전 거부) |
| `wan.probe` (항목마다) | HTTP 200 | WAN workspace 엔드포인트 + 키 인증됨. 남은 할당량은 이 방법으로 알 수 없다 |
| `wan.probe` 가 401 `InvalidApiKey` | - | 키가 틀렸거나 엔드포인트와 리전이 다름 — 그 `WAN_<n>` 을 재입력 |
| `wan.probe` 가 `BadEndpoint` / `BadModel` | - | 값이 URL 이나 모델 id 형식이 아님(URL 이 아닌 endpoint, 공백이 든 모델, 모델 칸에 붙인 키 등). 원래 값 대신 `(invalid endpoint)`, `(invalid model)` 로 표시된다 — 그 줄을 고침 |
| `images.badreq` 가 404 (`DeploymentNotFound`) | - | 엔드포인트·인증은 OK 지만 **배포명이 틀림** — §3 에서 `AZURE_GPT_IMAGE_DEPLOYMENT` 를 콘솔의 실제 배포명으로 재확인 |
| 둘 중 하나라도 401/403 | - | 인증 실패 — `azFetch` 가 `api-key`→`Bearer` 두 헤더 스타일을 이미 자동 재시도하므로, 그래도 401/403 이면 헤더 스타일이 아니라 키·엔드포인트 자체가 틀린 것(§3 재입력) |
| `images.badreq` 가 200 | - | 있을 수 없음(프롬프트 없이 생성이 성공할 리 없다) — 어댑터·API 버전 불일치 의심, 정직히 보고 |
| status 0 | - | 네트워크 오류(엔드포인트 오타·오프라인) |
| status 0 (`EINSECURE`) | - | endpoint 가 `http://` 다. 키를 평문으로 보내지 않으려고 보내기 전에 막았다 — `https://` 로 고침(이 기기의 localhost 만 http 허용) |

## 5. 검증 (보고 의무)
```bash
node -v                      # 18 이상 기대
command -v ffmpeg >/dev/null && ffmpeg -version | head -1 || echo "시스템 ffmpeg 없음 -- resolveFfmpeg() 폴백 확인(§2)"
# 위 §4 프리플라이트를 재실행해 PASS 문자열 + 두 status 코드를 그대로 증거로 남긴다
```
4-field 보고: 변경(Node/ffmpeg 확보 방식 · 크레덴셜 저장 경로 — 파일 내용 아님) / Evidence(§0 감지 출력 · §4 status 코드 전부) / 검증(`listVideos`=200 **AND** `images.badreq`=400 **AND** WAN 항목 전부 200 이어야 PASS) / Unknown(FLUX 미검증 · WAN 키별 남은 할당량(조회 API 없음 — 소진은 첫 생성에서 드러나고 풀이 자동으로 다음 키·Sora 로 넘어감) · 배포명이 실제 존재하는지는 이 무과금 프리플라이트로 확인 불가하며 첫 실제 생성 시점에만 드러남 · 관리자 권한 제약으로 ffmpeg 시스템 설치 불가 등, 가짜 성공 금지).
크레덴셜은 어떤 필드도 원문으로 보고하지 않고 항상 `redact()` 출력(길이만)만 남긴다.

## 함정
- **키·엔드포인트가 진짜 다른 이유**: Sora 와 gpt-image-2 는 같은 Azure OpenAI 리소스에 함께 배포될 수도, 완전히 별도 리소스일 수도 있다 — 하나로 퉁치지 말고 두 세트를 각각 확인한다.
- **`azFetch` 는 이미 이중 인증을 시도한다**: `api-key` 헤더로 먼저 시도하고 401/403 이면 자동으로 `Authorization: Bearer` 로 재시도한다 — 그래도 실패하면 헤더 스타일 문제가 아니라 키·엔드포인트 자체가 틀린 것이다.
- **키가 드러났으면 교체한다**: 키가 대화, 터미널 기록, 출력에 한 번이라도 드러났으면(예: 샘플을 채팅에 붙임) 그 키를 바꾼다. Azure 는 리소스의 Keys and Endpoint 에서 Regenerate 로 교체한다.
  WAN 키는 Model Studio 콘솔의 API Key 관리에서 그 키를 지우고 새로 만들어 교체한다.
- **WAN 키 검증은 GET task 로만**: 존재하지 않는 task 조회는 과금이 없고 키 유효성(200 vs 401)을 가른다. 생성 요청(POST)은 과금될 수 있으니 점검용으로 쓰지 않는다.
- **이미지 배포 429**: 낮은 티어(S0) 이미지 배포는 연속 호출에 `429 RateLimitReached` 를 낸다. 프리플라이트를 짧은 간격으로 반복하지 않는다.
- **RHEL8/Rocky8 ffmpeg 미제공**: BaseOS/AppStream 에 없음(라이선스) → motion-graphic-setup 과 동일하게 RPM Fusion 또는 `ffmpeg-static` 폴백.
- **ffmpeg 바이너리 미번들 원칙**: 위 폴백은 사용자 프로젝트 `node_modules` 한정 — banker 플러그인 배포물에는 절대 포함하지 않는다.
- **프리플라이트는 배포명 실존까지는 증명 못 한다**: `images.badreq` 400 은 "리소스가 살아있고 키가 맞다"는 뜻이지 `AZURE_GPT_IMAGE_DEPLOYMENT` 로 지정한 배포가 실제 존재·활성 상태인지는 증명하지 않는다 — 무과금으로는 확인할 방법이 없어 첫 실제 생성(3d-intro-build)에서만 드러난다.
- **`.env.3d-intro.local` 자동 gitignore 는 이 저장소 한정**: 이 저장소는 `.env.*.local` 패턴으로 이미 커버되지만, 다른 프로젝트에 이 스킬을 쓸 때는 그 프로젝트의 `.gitignore` 를 §3 저장 단계에서 별도로 확인·추가해야 한다.
