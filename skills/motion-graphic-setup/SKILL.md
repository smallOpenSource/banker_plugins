---
name: motion-graphic-setup
description: "(banker) 모션 그래픽 제작 도구 hyperframes 설치 전제조건 확보: Node>=22 + ffmpeg(OS 패키지 우선, project-local ffmpeg-static 폴백) 후 npx hyperframes init/skills update/doctor. 'motion-graphic-setup'/'모션 그래픽 설치'/'hyperframes 설치' 또는 /banker:setup 시 사용."
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
**이미 설치 확인**: `node -v` 가 22 이상 **이고** `ffmpeg` 가 존재 **이고** `npx hyperframes doctor` 가 통과하면, 아래 §1~§3 은 건너뛰고 §4 검증만 수행한다.

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
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v
```
배포 기본 apt 저장소의 `nodejs` 는 버전이 낮은 경우가 많아 NodeSource 22.x 저장소를 사용한다.

### Linux — RHEL8 / Rocky8
⚠️ dnf AppStream 모듈의 `nodejs` 스트림은 미러 구성에 따라 22 미만일 수 있다 — 사전 확인: `dnf module list nodejs`.
```bash
sudo dnf module reset -y nodejs
sudo dnf module enable -y nodejs:22 2>/dev/null || \
  curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo -E bash -
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
1순위는 시스템 패키지, 2순위(권한 없음/오프라인/저장소 미제공)는 프로젝트-로컬 `ffmpeg-static` npm 폴백이다.

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
- hyperframes 가 이 바이너리를 인식하는지는 §3 의 `npx hyperframes doctor` 로 확인한다.
- 재강조: 이 폴백은 사용자 프로젝트에 설치되는 npm 의존성일 뿐, banker 플러그인 저장소(`skills/`)나 배포 아티팩트에는 어떤 ffmpeg 바이너리도 포함되지 않는다.

## 3. hyperframes 설치 · 최신화
```bash
npx hyperframes init
npx hyperframes skills update
npx hyperframes doctor
```
- `init`: 최초 실행 시 스캐폴딩과 함께 전역 스킬셋(라우터 `/hyperframes` + `hyperframes-*` 도메인 스킬 + `media-use`)을 설치하고, 이미 있으면 최신 여부만 GitHub 기준으로 확인한다.
- `skills update`: 코어 스킬만 골라 최신화한다(비대화형 환경 권장 경로) — 이미 최신이면 no-op.
- `doctor`: Node·ffmpeg·설치된 스킬 등 실행 환경을 종합 진단한다.

## 4. 검증 (보고 의무)
```bash
node -v                                                    # v22.x.x 이상 기대
command -v ffmpeg >/dev/null && ffmpeg -version | head -1 || echo "시스템 ffmpeg 없음 — ffmpeg-static 폴백 확인"
npx hyperframes doctor                                     # 종합 진단(node/ffmpeg/스킬셋)
```
4-field 보고: 변경(설치 경로·ffmpeg 확보 방식) / Evidence(위 출력) / 검증(`node -v`≥22 + `hyperframes doctor` 통과) / Unknown(권한·네트워크 제약으로 시스템 ffmpeg 불가 등, 가짜 성공 금지).

## 함정
- **RHEL8/Rocky8 dnf 모듈 nodejs 버전**: AppStream 스트림이 22 미만일 수 있음(사전 `dnf module list nodejs` 확인) → NodeSource 저장소 또는 `setup-node`(nvm) 로 위임.
- **RHEL8/Rocky8 ffmpeg 미제공**: BaseOS/AppStream 에 없음(라이선스) → RPM Fusion 필요, 접근 막히면 `ffmpeg-static` 폴백.
- **ffmpeg 바이너리 미번들 원칙**: `ffmpeg-static` 폴백은 사용자 프로젝트 `node_modules` 한정 — banker 플러그인 배포물에는 절대 포함하지 않는다(라이선스·배포 크기·플랫폼별 바이너리 불일치 회피).
- **GEMINI_API_KEY 는 선택**: AI 이미지 생성이 필요한 카테고리에서만 쓰이고, 무료 폼 카테고리(kinetic-type·stat·charts·logo-reveal·lower-thirds·maps)는 키 없이 전부 동작한다 — 이 스킬은 어떤 API 키도 요구하지 않는다.
- **Windows PATH 충돌**: winget Node 와 nvm-windows 동시 설치 금지(상세는 `setup-node` 함정 참조).
- **새 셸에만 반영**: NodeSource/dnf 모듈 설치 직후 PATH 갱신은 새 터미널이 필요할 수 있다.
- **hyperframes 스킬 갱신은 네트워크 필요**: `hyperframes init`/`skills update` 는 GitHub 에서 최신 스킬을 당겨온다 — 오프라인/에어갭 환경이면 실패를 정직히 보고(가짜 성공 금지).
