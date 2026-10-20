---
name: motion-graphic-setup
description: "모션 그래픽을 만드는 hyperframes 의 전제 조건을 갖춤. Node 22 이상과 ffmpeg 를 설치(OS 패키지 먼저, 안 되면 프로젝트 안 ffmpeg-static). 이어서 `npx hyperframes` 의 `init`, `skills update`, `doctor` 를 차례로 실행. 'motion-graphic-setup'/'모션 그래픽 설치'/'hyperframes 설치' 또는 `/banker:setup` 시 사용."
---

# motion-graphic-setup — hyperframes(모션 그래픽 CLI) 설치

무료(free) 모션 그래픽 제작 도구 hyperframes 의 실행 전제조건을 설치한다.
hyperframes 는 Node.js CLI 로, HTML/CSS/GSAP 로 만든 애니메이션을 headless Chrome + ffmpeg 로 MP4/투명 오버레이 비디오로 렌더링한다.
실제 모션 그래픽 제작은 `motion-graphic-make` 스킬(hyperframes `/motion-graphics` 위임)이 담당하고, 이 스킬은 그 전제조건만 갖춘다.
**OS·arch·기존 설치 여부를 먼저 감지**해 알맞은 경로를 고른다.
설치는 **멱등**(이미 있으면 skip·검증만). 답변은 한글(기술 토큰 영문).

## 0. 감지 (먼저, 추정 금지)
```bash
echo "OS=$(uname -s)"
echo "ARCH=$(uname -m)"
echo "root=$([ "$(id -u)" = 0 ] && echo yes || echo no)"
[ -f /etc/os-release ] && . /etc/os-release && echo "distro=$ID ${VERSION_ID}"
command -v node   >/dev/null && echo "node=$(node -v)"        || echo "node=미설치"
command -v npx    >/dev/null && echo "npx=yes"                 || echo "npx=미설치"
command -v npm    >/dev/null && echo "npm=$(npm -v)"           || echo "npm=미설치"
command -v ffmpeg >/dev/null && ffmpeg -version 2>&1 | head -1 || echo "ffmpeg=미설치"
```
```powershell
$PSVersionTable.PSVersion
winget --version
if (Get-Command node -ErrorAction SilentlyContinue) { node -v } else { "node: 미설치" }
if (Get-Command ffmpeg -ErrorAction SilentlyContinue) { (ffmpeg -version)[0] } else { "ffmpeg: 미설치" }
```
**이미 설치 확인**: `node -v` 가 22 이상 **이고** `ffmpeg` 가 존재 **이고** hyperframes 진단이 통과하면, 아래 §1~§3 은 건너뛰고 §4 검증만 수행한다.
- 진단은 전역 설치가 있으면 `hyperframes doctor` 다. 없으면 아래 네트워크 확인이 통과한 뒤에만 `npx hyperframes doctor` 를 부른다. 깔린 것이 없는 `npx` 는 패키지를 받으려 해, 오프라인이면 약 70초 뒤 실패하고 그 실패가 "미설치" 로 읽힌다.
- 전역 설치가 없고 네트워크 확인이 실패하면 진단하지 않는다. hyperframes 는 "오프라인이라 확인하지 못함" 으로 둔다.

### 네트워크 확인 (내려받기 전)

이 스킬이 내려받는 원천에 10초 안에 닿는지 먼저 본다. 닿지 않으면 그 원천에서 받는 단계는 하지 않고, 이미 설치된 것의 확인만 한 뒤 "오프라인이라 설치하지 않음(필요한 것: <못 깐 것>)" 으로 보고한다.

```bash
(cd ~ && npm ping --fetch-retries=0 --fetch-timeout=10000)                            # hyperframes(npx), ffmpeg-static
curl -sSI -o /dev/null --connect-timeout 5 --max-time 10 https://deb.nodesource.com   # Ubuntu, Debian 의 NodeSource 저장소
```

- `npm ping` 은 홈 폴더에서 부른다. 지금 폴더에 있는 프로젝트의 `.npmrc` 가 정한 레지스트리와 토큰을 따르지 않게 하려는 것이다.
- `npm ping` 이 실패하면 ping 에 답하지 않는 사내 미러일 수 있다. `(cd ~ && T=$(mktemp -d) && { npm view hyperframes version --fetch-retries=0 --fetch-timeout=10000 --cache "$T"; r=$?; rm -rf "$T"; exit $r; })` 도 실패해야 오프라인으로 본다. 이 스킬이 설치할 패키지(`hyperframes`)를 빈 캐시로 물으므로 옛 값이 나올 수 없다.
- `npm` 이 없으면(명령 없음) 오프라인이 아니라 확인하지 못한 것이다. Node 를 먼저 갖춘다(`setup-node`).
- `npm ping` 은 npm 의 프록시 설정(`proxy`, `https-proxy`)을 따른다. 사내 미러만 열린 망이면 그 미러가 쓰이는지 npm 설정을 본다.
- `curl -sSI` 는 머리만 받는다(본문을 받지 않음). 닿지 못하면 종료 코드가 0 이 아니다(HTTP 상태와 관계없음). `curl` 은 `HTTPS_PROXY` 를 따른다.
- Windows PowerShell 에서는 같은 주소를 `curl.exe -sSI -o NUL --connect-timeout 5 --max-time 10 <주소>` 로 보고 `$LASTEXITCODE` 가 0 인지 본다(PowerShell 5.1 의 `curl` 은 `Invoke-WebRequest` 별칭이다). `curl.exe` 는 Windows 시스템 프록시를 따르지 않고 `HTTPS_PROXY` 만 따른다. `npm ping` 은 `Push-Location ~; npm ping --fetch-retries=0 --fetch-timeout=10000; Pop-Location` 처럼 홈에서 부르고 돌아온다(돌아오지 않으면 뒤 단계가 프로젝트가 아니라 홈에서 돈다).
- 사내 미러만 열린 망이면 확인 주소를 그 미러로 바꿔 본다.
- OS 패키지 관리자(dnf, apt, brew, winget)의 단계는 자기 설정의 미러를 쓰므로 이 확인과 관계없이 시도하고, 실패하면 그 단계를 실패로 보고한다.

## 1. Node ≥22 확보
목적은 Node>=22 확보이지 특정 설치 경로 강제가 아니다.
이미 nvm 등 버전 매니저로 관리 중이면 `nvm install --lts && nvm alias default 'lts/*'` 로 충분하다(멀티버전 관리·RHEL8 glibc 사전확인 등 상세 절차는 `setup-node` 스킬 참조).

### macOS (Apple Silicon / Intel)
```bash
brew install node
node -v
```
Apple Silicon(`/opt/homebrew`)·Intel(`/usr/local`) 차이는 `brew` 가 자동 흡수 — 스크립트는 두 아키텍처에 동일 적용.

### Linux — Ubuntu / Debian
```bash
T=$(mktemp -d)
curl -fsSL --connect-timeout 10 --max-time 120 -o "$T/nodesource.sh" https://deb.nodesource.com/setup_22.x \
  && sudo -E bash "$T/nodesource.sh" && sudo apt-get install -y nodejs
rm -rf "$T"
node -v
```
설치 스크립트는 파일로 받고, 받았을 때만 실행한다. 받기에 실패하면 그 뒤 단계는 돌지 않는다(셸에 바로 넘기면 받기가 실패해도 종료 0 이 된다).
배포 기본 apt 저장소의 `nodejs` 는 버전이 낮은 경우가 많아 NodeSource 22.x 저장소를 사용한다.

### Linux — RHEL8 / Rocky8
⚠️ dnf AppStream 모듈의 `nodejs` 스트림은 미러 구성에 따라 22 미만일 수 있다 — 사전 확인: `dnf module list nodejs`.
```bash
sudo dnf module reset -y nodejs
sudo dnf module enable -y nodejs:22 2>/dev/null || {
  T=$(mktemp -d)
  curl -fsSL --connect-timeout 10 --max-time 120 -o "$T/nodesource.sh" https://rpm.nodesource.com/setup_22.x \
    && sudo -E bash "$T/nodesource.sh"
  rm -rf "$T"
}
sudo dnf install -y nodejs
node -v
```
22 스트림이 없거나 sudo 가 불가하면 **`setup-node` 스킬로 위임**(nvm 경로, RHEL8 glibc 2.28 사전확인 포함) — 이쪽이 더 안전하다.

### Windows
```powershell
winget install --id OpenJS.NodeJS.LTS -e
node -v
```
여러 Node 버전을 넘나들어야 하면 nvm-windows: `winget install --id CoreyButler.NVMforWindows -e` 후 `nvm install lts && nvm use <설치된 버전>`.
> ⚠️ winget Node 와 nvm-windows 를 동시에 설치하지 않는다(PATH 충돌 — 상세는 `setup-node` 함정 참조).

**위 경로가 모두 막히면(권한 없음·미러 문제 등) → `setup-node` 스킬로 위임한다.**

## 2. ffmpeg 확보
hyperframes 렌더러(headless Chrome 캡처 + ffmpeg 인코딩)가 요구하는 `ffmpeg` 실행 파일을 확보한다.
1순위는 시스템 패키지, 2순위(권한 없음, 저장소 미제공)는 프로젝트-로컬 `ffmpeg-static` npm 폴백이다.
오프라인이면 `ffmpeg-static` 도 받을 수 없다(npm 설치에 네트워크가 필요하다). 미리 받아 둔 ffmpeg 실행 파일의 절대 경로를 `export FFMPEG_PATH=<절대 경로>` 로 준다.

**★ banker 플러그인 자체(스킬 파일·npm 패키지 배포물)에는 ffmpeg 바이너리를 절대 번들하지 않는다.** 아래 폴백은 사용자 프로젝트의 `node_modules` 에만 설치된다.

### macOS
```bash
brew install ffmpeg
ffmpeg -version | head -1
```

### Linux — Ubuntu / Debian
```bash
sudo apt-get install -y ffmpeg
ffmpeg -version | head -1
```

### Linux — RHEL8 / Rocky8
⚠️ 기본 BaseOS/AppStream 저장소에는 `ffmpeg` 가 없다(라이선스 문제로 RPM Fusion 필요).
```bash
sudo dnf install -y https://download1.rpmfusion.org/free/el/rpmfusion-free-release-8.noarch.rpm
sudo dnf install -y ffmpeg
ffmpeg -version | head -1
```
사내망/에어갭 등으로 RPM Fusion 접근이 막히면 dnf 를 포기하고 바로 아래 폴백으로 진행한다.

### Windows
```powershell
winget install --id Gyan.FFmpeg -e
ffmpeg -version
```

### 폴백 — project-local `ffmpeg-static` (시스템 패키지 설치가 불가할 때만)
```bash
npm install --no-save ffmpeg-static
export FFMPEG_PATH="$(node -e "console.log(require('ffmpeg-static'))")"
"$FFMPEG_PATH" -version | head -1
```
- `--no-save`: 전역이 아니라 **현재 프로젝트의 `node_modules`** 에만 받는다 — 사용자 워크스페이스 소관이며 banker 플러그인 소관이 아니다.
- hyperframes 가 이 바이너리를 인식하는지는 §3 의 `doctor` 로 확인한다.
- 재강조: 이 폴백은 사용자 프로젝트에 설치되는 npm 의존성일 뿐, banker 플러그인 저장소(`skills/`)나 배포 아티팩트에는 어떤 ffmpeg 바이너리도 포함되지 않는다.

## 3. hyperframes 설치 · 최신화
```bash
hf() { if command -v hyperframes >/dev/null; then hyperframes "$@"; else npx hyperframes "$@"; fi; }   # 전역 설치가 있으면 그것을 부른다
hf init
hf skills update
hf doctor
```
- `init`: 최초 실행 시 스캐폴딩과 함께 전역 스킬셋(라우터 `/hyperframes` + `hyperframes-*` 도메인 스킬 + `media-use`)을 설치하고, 이미 있으면 최신 여부만 GitHub 기준으로 확인한다.
- `skills update`: 코어 스킬만 골라 최신화한다(비대화형 환경 권장 경로) — 이미 최신이면 no-op.
- `doctor`: Node·ffmpeg·설치된 스킬 등 실행 환경을 종합 진단한다.
- 오프라인에서 쓰려면: 전역이나 프로젝트에 깔린 것이 없으면 `npx hyperframes` 는 패키지를 받으려 해, 네트워크가 없으면 약 70초 뒤 실패한다. 네트워크가 되는 곳에서 `npm i -g hyperframes@<판>` 으로 깔아 두고 `hyperframes <명령>` 을 직접 부른다. 0단계 확인이 오프라인이면 `npx` 를 쓰지 않고, 네트워크가 필요한 `init` 의 최신 확인과 `skills update` 는 "오프라인이라 설치하지 않음" 으로 보고한다.

## 4. 검증 (보고 의무)
```bash
node -v                                                    # v22.x.x 이상 기대
command -v ffmpeg >/dev/null && ffmpeg -version | head -1 || echo "시스템 ffmpeg 없음 — ffmpeg-static 폴백 확인"
if command -v hyperframes >/dev/null; then hyperframes doctor; else npx hyperframes doctor; fi   # 종합 진단(node/ffmpeg/스킬셋)
```
- 전역 설치가 없고 0단계 확인이 오프라인이면 진단을 부르지 않는다. Unknown 에 "오프라인이라 hyperframes 진단을 하지 못함" 으로 적는다.
4-field 보고: 변경(설치 경로·ffmpeg 확보 방식) / Evidence(위 출력) / 검증(`node -v`≥22 + `hyperframes doctor` 통과) / Unknown(권한·네트워크 제약으로 시스템 ffmpeg 불가 등, 가짜 성공 금지).

## 함정
- **RHEL8/Rocky8 dnf 모듈 nodejs 버전**: AppStream 스트림이 22 미만일 수 있음(사전 `dnf module list nodejs` 확인) → NodeSource 저장소 또는 `setup-node`(nvm) 로 위임.
- **RHEL8/Rocky8 ffmpeg 미제공**: BaseOS/AppStream 에 없음(라이선스) → RPM Fusion 필요, 저장소에만 닿지 못하면 `ffmpeg-static` 폴백(오프라인이면 미리 받은 실행 파일을 `FFMPEG_PATH` 로).
- **ffmpeg 바이너리 미번들 원칙**: `ffmpeg-static` 폴백은 사용자 프로젝트 `node_modules` 한정 — banker 플러그인 배포물에는 절대 포함하지 않는다(라이선스·배포 크기·플랫폼별 바이너리 불일치 회피).
- **GEMINI_API_KEY 는 선택**: AI 이미지 생성이 필요한 카테고리에서만 쓰이고, 무료 폼 카테고리(kinetic-type·stat·charts·logo-reveal·lower-thirds·maps)는 키 없이 전부 동작한다 — 이 스킬은 어떤 API 키도 요구하지 않는다.
- **Windows PATH 충돌**: winget Node 와 nvm-windows 동시 설치 금지(상세는 `setup-node` 함정 참조).
- **새 셸에만 반영**: NodeSource/dnf 모듈 설치 직후 PATH 갱신은 새 터미널이 필요할 수 있다.
- **hyperframes 스킬 갱신은 네트워크 필요**: `hyperframes init`/`skills update` 는 GitHub 에서 최신 스킬을 당겨온다 — 오프라인/에어갭 환경이면 실패를 정직히 보고(가짜 성공 금지).
