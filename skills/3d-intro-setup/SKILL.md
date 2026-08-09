---
name: 3d-intro-setup
description: "(banker) Azure Sora-2/gpt-image-2 3D 인트로 제작용 크레덴셜·의존성 설치: Node≥18·ffmpeg 확보 + apikey/엔드포인트/배포명 직접입력 또는 콘솔 샘플 코드 붙여넣기로 크레덴셜 저장 + 무과금 프리플라이트(listVideos·images badreq)로 검증. 'setup-3d-intro'/'3d-intro-setup'/'3D 인트로 설정'/'Azure Sora 크레덴셜' 또는 /banker:setup 시 사용."
---

# 3d-intro-setup — Azure Sora-2 / gpt-image-2 3D 인트로 제작 전제조건 설치

Azure Sora-2(영상 생성)·gpt-image-2(이미지 생성) 기반 3D 인트로 제작의 실행 전제조건을 설치·검증한다.
실제 인트로 제작(이미지·영상 생성, 과금 발생)은 `3d-intro-build` 스킬이 담당하고, 이 스킬은 Node/ffmpeg 확보와 크레덴셜 저장, **무과금** 연결 확인까지만 담당한다.
모든 Azure 호출은 이 스킬 디렉터리의 `references/azure-adapter.mjs`(수정 금지, `3d-intro-build`와 byte-identical 공유 사본)를 통해서만 수행한다.
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
```
**이미 확보 확인**: `node -v` 가 18 이상이고 `ffmpeg` 가 있으면 §1~§2 는 건너뛴다.
크레덴셜도 이미 완전하면(§3 첫 단계) 프롬프트 없이 §4 프리플라이트로 직행한다.

## 1. Node ≥18 확보
어댑터가 global `fetch`/`FormData`/`Blob` 등 Node 18+ 내장 기능만 쓴다(추가 의존성 없음) — 18 미만이면 어댑터 자체가 동작하지 않는다.
이미 nvm 등으로 관리 중이면 `nvm install --lts && nvm alias default 'lts/*'` 로 충분하다.
OS별 상세 설치 절차(Ubuntu NodeSource·RHEL8/Rocky8 dnf 모듈·Windows winget·PATH 충돌 등)는 반복하지 않고 **`setup-node` 스킬로 위임**한다 — 이 스킬은 결과(`node -v` ≥18)만 확인한다.

## 2. ffmpeg 확보
어댑터의 프레임 추출·컬러 매치·크로스페이드·이어붙이기(`extractLastFrame`·`colorMatch`·`crossfade`·`concatClips`, forward-chaining 이음새 처리)가 `ffmpeg` 바이너리를 요구한다.
설치 절차는 `motion-graphic-setup` §2 와 완전히 동일하므로 반복하지 않고 요약만 남긴다(전체 함정·오프라인 폴백은 그 스킬 참조):
- macOS: `brew install ffmpeg`
- Ubuntu/Debian: `sudo apt-get install -y ffmpeg`
- RHEL8/Rocky8: BaseOS/AppStream 미포함(라이선스) → RPM Fusion 후 `dnf install -y ffmpeg`
- Windows: `winget install --id Gyan.FFmpeg -e`
- 전부 막히면(권한/오프라인) project-local 폴백: `npm install --no-save ffmpeg-static`

**★ banker 플러그인 자체(스킬 파일·npm 패키지 배포물)에는 ffmpeg 바이너리를 절대 번들하지 않는다** — 위 설치는 전부 사용자 프로젝트/시스템에만 적용된다(motion-graphic-setup과 동일 원칙).

검증은 `ffmpeg -version` 대신 **어댑터가 실제 쓰는 해석 로직**(`resolveFfmpeg`: `$FFMPEG_PATH` → `PATH` 스캔 → `ffmpeg-static` 순)으로 한다 — 이게 통과해야 3d-intro-build 가 실제로 ffmpeg 를 찾는다.
`FFMPEG_PATH`(export)는 셸 세션 한정이라, 해석된 경로를 **크레덴셜 env 파일에 `FFMPEG_PATH=` 로 영속**해 둔다 — 그래야 다른 세션/프로세스에서 도는 3d-intro-build 도 (`resolveCreds` 로 읽어) ffmpeg 를 찾는다. 시스템 `ffmpeg` 가 `PATH` 에 있으면 이 영속은 불필요하다(그래도 무해).
```bash
node -e "
(async () => {
  const { resolveFfmpeg, resolveCreds, persistCreds } = await import('$ADAPTER');
  const ff = await resolveFfmpeg().catch((e) => { console.log('ffmpeg 미확보:', e.message); process.exit(1); });
  console.log('ffmpeg 확보:', ff);
  const c = resolveCreds({ projectDir: process.cwd() });
  if (c._source && c.FFMPEG_PATH !== ff) { c.FFMPEG_PATH = ff; persistCreds(c, { target: c._source }); console.log('FFMPEG_PATH 영속 ->', c._source); }
})();
"
```

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

### 리소스는 최대 3개(Sora·Image·FLUX)
Sora(영상)와 gpt-image-2(이미지)는 **보통 서로 다른 Azure 리소스**(엔드포인트·키가 다를 수 있음) — 두 세트를 각각 받는다.
FLUX.2-pro(대체 이미지 생성)는 **opt-in**: 필요 없으면 완전히 건너뛴다(§3-FLUX 참조).

### 모드 (a) — 직접 입력
사용자에게 리소스별로 순서대로 질문한다: endpoint(예: `https://<resource>.openai.azure.com` 또는 `https://<resource>.cognitiveservices.azure.com`), API key, 배포명(deployment).
- **Sora**: endpoint + key (+ 배포명, 기본 `sora-2` — 콘솔에서 다른 이름으로 배포했으면 그 이름).
- **Image(gpt-image-2)**: endpoint + key + 배포명(예: `gpt-image-2`, 필수 — 생성 호출의 `model` 필드로 그대로 쓰인다).

### 모드 (b) — 콘솔 샘플 코드 붙여넣기
Azure AI Foundry/AI Hub 콘솔의 "Sample code"/"View code" 패널이 주는 curl 또는 Python 스니펫을 리소스별로 통째로 붙여넣게 한다.
붙여넣은 원문은 세션 스크래치 임시 파일에 저장 → `parseConsoleSample()` 로 파싱 → **파싱 직후 임시 파일 즉시 삭제**(원문에 raw key 가 그대로 들어있다).
```bash
node -e "
(async () => {
  const fs = require('fs');
  const { parseConsoleSample, redact } = await import('$ADAPTER');
  const text = fs.readFileSync(process.argv[1], 'utf8');
  const p = parseConsoleSample(text);
  console.log(JSON.stringify({ endpoint: p.endpoint, deployment: p.deployment, apiVersion: p.apiVersion, apiKey: redact(p.apiKey) }));
})();
" "<붙여넣은 샘플을 저장한 임시 파일 절대경로로 치환>"
```
파싱 결과(엔드포인트·배포명·apiVersion·redact 된 key)를 사용자에게 보여주고 확인받은 뒤 저장 단계로 넘어간다.
필드가 `null` 로 나오면(정규식 미매치) 모드(a) 직접 입력으로 그 필드만 보완한다.

### 저장
아래 필드로 합쳐 `persistCreds()` 로 저장한다(0600 자동 적용, 원문 재출력 안 함):
```
AZURE_SORA_ENDPOINT / AZURE_SORA_API_KEY / AZURE_SORA_DEPLOYMENT(기본 sora-2) / AZURE_SORA_API_VERSION(기본 preview)
AZURE_IMAGE_OPENAI_ENDPOINT / AZURE_IMAGE_API_KEY / AZURE_GPT_IMAGE_DEPLOYMENT / AZURE_GPT_IMAGE_API_VERSION(기본 preview)
```
```bash
node -e "
(async () => {
  const { persistCreds } = await import('$ADAPTER');
  const path = require('path');
  const target = path.join(process.cwd(), '.env.3d-intro.local');   // 프로젝트 전용(기본, 권장)
  const written = persistCreds({
    AZURE_SORA_ENDPOINT: '<입력값>', AZURE_SORA_API_KEY: '<입력값>',
    AZURE_SORA_DEPLOYMENT: '<입력값 또는 sora-2>', AZURE_SORA_API_VERSION: '<입력값 또는 preview>',
    AZURE_IMAGE_OPENAI_ENDPOINT: '<입력값>', AZURE_IMAGE_API_KEY: '<입력값>',
    AZURE_GPT_IMAGE_DEPLOYMENT: '<입력값>', AZURE_GPT_IMAGE_API_VERSION: '<입력값 또는 preview>',
  }, { target });
  console.log('저장:', written);
})();
"
```
여러 프로젝트에서 재사용하려면 대신 홈 폴더 fallback 에 저장한다 — `target` 을 `path.join(os.homedir(),'.config','banker','3d-intro','env')` 로 바꾼다(`resolveCreds` 가 project-local 다음으로 자동 탐색하는 바로 그 경로).
저장 후 대상 프로젝트의 `.gitignore` 에 무시 규칙이 있는지 확인하고 없으면 추가한다(이 저장소는 `.env.*.local` 로 이미 커버되지만, 다른 프로젝트에서 이 스킬을 쓸 때는 별도 확인이 필요하다):
```bash
grep -qE '^\.env\.3d-intro\.local$|^\.env\.\*\.local$' .gitignore 2>/dev/null || echo '.env.3d-intro.local' >> .gitignore
```

### FLUX.2-pro (opt-in)
필요할 때만: endpoint 하나 추가(`AZURE_IMAGE_SERVICES_ENDPOINT`) — 같은 리소스에 배포된 경우가 많아 키는 기본적으로 `AZURE_IMAGE_API_KEY` 를 재사용하고, 다른 리소스면 별도 key 를 물어본다.
FLUX 는 이 스킬의 §4 프리플라이트 대상이 아니다(무과금으로 확인할 별도 엔드포인트가 없음).
저장만 하고 실제 연결 확인은 생략한다(graceful skip) — 첫 실제 사용 시점(3d-intro-build)으로 미룬다.

## 4. 프리플라이트 (무과금)
**여기서는 어떤 유료 생성도 실행하지 않는다** — gpt-image-2 이미지 생성, Sora-2 영상 생성 어느 쪽도 호출하지 않는다.
아래 두 호출만 수행한다: (1) Sora `listVideos` GET(목록 조회는 무료) (2) Image 는 `azFetch` 로 **body `{model:<배포명>}` (프롬프트 누락) POST** — 배포로 라우팅된 뒤 프롬프트 누락으로 생성 전 `400 missing_required_parameter` 로 거부되므로 과금 0이고, 엔드포인트·인증에 더해 **배포명까지** 무료로 검증된다. (빈 `{}` 는 model 이 없어 `404 DeploymentNotFound` 로 갈려 배포명을 확인하지 못한다.)
```bash
node -e "
(async () => {
  const { resolveCreds, listVideos, azFetch, redact } = await import('$ADAPTER');
  const c = resolveCreds({ projectDir: process.cwd() });
  if (!c._source) { console.log('크레덴셜 없음 -- §3 먼저 실행'); process.exit(2); }
  const sora = await listVideos({ endpoint: c.AZURE_SORA_ENDPOINT, key: c.AZURE_SORA_API_KEY, apiVersion: c.AZURE_SORA_API_VERSION || 'preview' });
  console.log('sora.listVideos ->', sora.status, '(' + sora.authStyle + ')');
  const imgv = c.AZURE_GPT_IMAGE_API_VERSION || 'preview';
  const imgUrl = c.AZURE_IMAGE_OPENAI_ENDPOINT + '/openai/v1/images/generations?api-version=' + imgv;
  const img = await azFetch(imgUrl, { key: c.AZURE_IMAGE_API_KEY, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: c.AZURE_GPT_IMAGE_DEPLOYMENT }) });
  console.log('images.badreq ->', img.status, '(' + img.authStyle + ')');
  const pass = sora.status === 200 && img.status === 400;
  console.log(pass ? 'PREFLIGHT PASS -- \$0 과금' : 'PREFLIGHT FAIL');
  console.log('source:', c._source, '| Sora key', redact(c.AZURE_SORA_API_KEY), '| Image key', redact(c.AZURE_IMAGE_API_KEY));
  process.exit(pass ? 0 : 1);
})();
"
```
**판정 기준(둘 다 충족해야 PASS)**:
| 체크 | 기대 | 의미 |
|---|---|---|
| `sora.listVideos` | HTTP 200 | Sora 엔드포인트 살아있음 + 키 인증됨 |
| `images.badreq` | HTTP 400 (`missing_required_parameter`) | Image 엔드포인트 살아있음 + 키 인증됨 + **배포명 라우팅됨**(프롬프트 누락이라 생성 전 거부) |
| `images.badreq` 가 404 (`DeploymentNotFound`) | - | 엔드포인트·인증은 OK 지만 **배포명이 틀림** — §3 에서 `AZURE_GPT_IMAGE_DEPLOYMENT` 를 콘솔의 실제 배포명으로 재확인 |
| 둘 중 하나라도 401/403 | - | 인증 실패 — `azFetch` 가 `api-key`→`Bearer` 두 헤더 스타일을 이미 자동 재시도하므로, 그래도 401/403 이면 헤더 스타일이 아니라 키·엔드포인트 자체가 틀린 것(§3 재입력) |
| `images.badreq` 가 200 | - | 있을 수 없음(프롬프트 없이 생성이 성공할 리 없다) — 어댑터·API 버전 불일치 의심, 정직히 보고 |
| status 0 | - | 네트워크 오류(엔드포인트 오타·오프라인) |

## 5. 검증 (보고 의무)
```bash
node -v                      # 18 이상 기대
command -v ffmpeg >/dev/null && ffmpeg -version | head -1 || echo "시스템 ffmpeg 없음 -- resolveFfmpeg() 폴백 확인(§2)"
# 위 §4 프리플라이트를 재실행해 PASS 문자열 + 두 status 코드를 그대로 증거로 남긴다
```
4-field 보고: 변경(Node/ffmpeg 확보 방식 · 크레덴셜 저장 경로 — 파일 내용 아님) / Evidence(§0 감지 출력 · §4 두 status 코드) / 검증(`listVideos`=200 **AND** `images.badreq`=400 모두 충족해야 PASS) / Unknown(FLUX 미검증 · 배포명이 실제 존재하는지는 이 무과금 프리플라이트로 확인 불가하며 첫 실제 생성 시점에만 드러남 · 관리자 권한 제약으로 ffmpeg 시스템 설치 불가 등, 가짜 성공 금지).
크레덴셜은 어떤 필드도 원문으로 보고하지 않고 항상 `redact()` 출력만 남긴다.

## 함정
- **키·엔드포인트가 진짜 다른 이유**: Sora 와 gpt-image-2 는 같은 Azure OpenAI 리소스에 함께 배포될 수도, 완전히 별도 리소스일 수도 있다 — 하나로 퉁치지 말고 두 세트를 각각 확인한다.
- **`azFetch` 는 이미 이중 인증을 시도한다**: `api-key` 헤더로 먼저 시도하고 401/403 이면 자동으로 `Authorization: Bearer` 로 재시도한다 — 그래도 실패하면 헤더 스타일 문제가 아니라 키·엔드포인트 자체가 틀린 것이다.
- **콘솔 샘플 붙여넣기의 스크롤백 잔존**: 터미널 히스토리·세션 로그에 원문 키가 남을 수 있다(플러그인 통제 밖) — 공유 터미널이거나 로깅되는 환경이면 붙여넣기 후 Azure 콘솔에서 키 로테이션을 권한다.
- **RHEL8/Rocky8 ffmpeg 미제공**: BaseOS/AppStream 에 없음(라이선스) → motion-graphic-setup 과 동일하게 RPM Fusion 또는 `ffmpeg-static` 폴백.
- **ffmpeg 바이너리 미번들 원칙**: 위 폴백은 사용자 프로젝트 `node_modules` 한정 — banker 플러그인 배포물에는 절대 포함하지 않는다.
- **프리플라이트는 배포명 실존까지는 증명 못 한다**: `images.badreq` 400 은 "리소스가 살아있고 키가 맞다"는 뜻이지 `AZURE_GPT_IMAGE_DEPLOYMENT` 로 지정한 배포가 실제 존재·활성 상태인지는 증명하지 않는다 — 무과금으로는 확인할 방법이 없어 첫 실제 생성(3d-intro-build)에서만 드러난다.
- **`.env.3d-intro.local` 자동 gitignore 는 이 저장소 한정**: 이 저장소는 `.env.*.local` 패턴으로 이미 커버되지만, 다른 프로젝트에 이 스킬을 쓸 때는 그 프로젝트의 `.gitignore` 를 §3 저장 단계에서 별도로 확인·추가해야 한다.
