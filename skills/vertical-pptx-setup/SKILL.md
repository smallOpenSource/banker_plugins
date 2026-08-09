---
name: vertical-pptx-setup
description: "(banker) vertical-pptx 의존성(pptxgenjs·python-pptx)과 시각 검증용 LibreOffice 를 OS·권한 감지 후 설치(root 없으면 홈 프리픽스 추출). 'vertical-pptx-setup'/'LibreOffice 설치'/'pptx 렌더 검증 준비' 또는 /banker:setup 시 사용."
---

# vertical-pptx-setup — vertical-pptx 실행·검증 환경 설치

`vertical-pptx` 가 쓰는 것들을 OS 와 권한을 **먼저 재고** 설치한다.
추정으로 설치 명령을 고르지 않는다. root 유무·아키텍처·기존 설치 여부가 전부 분기 조건이다.

## 무엇을 왜 설치하는가 (세 층은 성격이 다르다)

| 층 | 대상 | 없으면 | 필수인가 |
|---|---|---|---|
| 검증 | **node** | `verify_a4p.mjs` 가 아예 못 돈다 | **필수** |
| 생성 | **pptxgenjs**(node) 또는 **python-pptx** | 덱을 못 만든다. 둘 중 하나면 된다 | 둘 중 하나 |
| 시각 | **LibreOffice** | PDF·이미지 렌더 확인만 못 한다 | **선택** |

**LibreOffice 는 선택이다.** `vertical-pptx` 의 생성·검증 경로는 LibreOffice 없이 완결된다.
그럼에도 설치할 이유는 하나뿐이고 그게 크다.
구조 검증(sldSz·좌표·CRC·폰트 메트릭)은 "규격에 맞는가" 만 답한다.
**"열었을 때 실제로 그렇게 보이는가" 는 렌더해야만 답이 나온다.**
그 한 구멍을 메우는 것이 LibreOffice 의 역할이고, 그 외의 목적은 없다.

## 0. 감지 (먼저 — 추정 금지)

```bash
uname -sm                                             # OS + 아키텍처
sudo -n true 2>/dev/null && echo "sudo=yes" || echo "sudo=no"
command -v node >/dev/null && node -v || echo "node=없음"
command -v soffice libreoffice 2>/dev/null | head -1 || echo "soffice=없음"
command -v dnf apt-get brew winget 2>/dev/null | tr '\n' ' '
for v in 3.13 3.12 3.11 3.10 3.9; do command -v python$v >/dev/null && echo "python$v ok"; done
```

**python 버전 주의.** `python3` 이 3.6 이나 3.7 인 배포판이 있다(RHEL8/Rocky8 계열의 기본이 3.6.8 이다).
python-pptx 는 그보다 높은 버전을 요구하므로 `python3` 을 그대로 쓰지 말고 위 스캔에서 고른 인터프리터를 쓴다.

## 1. 빌더 설치 (둘 중 하나면 충분하다)

**node 경로(권장).** `fontFace` 하나로 한글 3슬롯(`a:latin`·`a:ea`·`a:cs`)이 전부 채워져 한글 깨짐 위험이 구조적으로 낮다.

```bash
npm i -g pptxgenjs@4          # 전역이 막히면 프로젝트 지역 설치 후 NODE_PATH 로 가리킨다
node -e "require('pptxgenjs')" && echo "pptxgenjs ok"
```

`require('pptxgenjs')` 로 확인한다.
`require('pptxgenjs/package.json')` 은 패키지의 `exports` 필드가 서브경로를 막아 `ERR_PACKAGE_PATH_NOT_EXPORTED` 로 실패한다.
설치가 멀쩡한데 확인 명령만 틀려서 "설치 실패" 로 오판하기 쉬운 자리다.

**python 경로.** npm 이 막힌 환경이나 python-pptx 가 이미 있는 환경을 위한 것이다.

```bash
PY=<위 스캔에서 고른 3.9+ 인터프리터>
$PY -m pip install --user python-pptx
$PY -c "import pptx; print('python-pptx', pptx.__version__)"
```

`fonttools` 는 필수가 아니다.
폭 예측 정확도를 직접 대조하고 싶을 때만 넣는다(`$PY -m pip install --user fonttools`).

## 2. LibreOffice 설치 — OS x 권한 분기

### 2-a. Linux, root 있음

```bash
sudo dnf install -y libreoffice-impress libreoffice-writer     # RHEL/Rocky/Fedora
sudo apt-get install -y libreoffice-impress libreoffice-writer # Debian/Ubuntu
```

### 2-b. Linux, root 없음 (홈 프리픽스로 추출)

**먼저 glibc 를 재라. 이 한 줄이 어느 경로를 쓸지 정한다.**

```bash
ldd --version | head -1
```

업스트림 최신판(26.x)은 **glibc 2.29 이상**을 요구한다.
RHEL8/Rocky8 계열은 **2.28** 이라 업스트림 tarball 을 받아 풀면 추출은 되지만 실행이 이렇게 죽는다:

```
oosplash: /lib64/libm.so.6: version `GLIBC_2.29' not found
oosplash: /lib64/libc.so.6: version `GLIBC_2.33' not found
```

이건 설치 실패가 아니라 **호환 실패**라서 재시도해도 같다. 경로를 바꿔야 한다.

**glibc 2.28 (RHEL8/Rocky8): 배포판 RPM 을 받아 푼다.**
배포판 빌드는 그 배포판의 glibc 에 맞춰져 있으므로 이게 정답이다. `dnf download` 는 root 가 필요 없다.

```bash
SP=/tmp/lo-distro; PREFIX=$HOME/.local/lo-distro
mkdir -p $SP $PREFIX
dnf -q -y --disablerepo='*' --enablerepo='appstream,baseos,powertools' \
  download --resolve --alldeps --destdir=$SP libreoffice-impress libreoffice-writer
cd $PREFIX
for r in $SP/*.rpm; do
  rpm2cpio "$r" | cpio -idmu --quiet 2>/dev/null
  chmod -R u+rwX $PREFIX/usr 2>/dev/null    # ★ 이 줄이 없으면 중간부터 전부 실패한다
done
export LD_LIBRARY_PATH=$PREFIX/usr/lib64:$PREFIX/usr/lib64/libreoffice/program:$LD_LIBRARY_PATH
SOFFICE=$PREFIX/usr/lib64/libreoffice/program/soffice
$SOFFICE --version          # 6.4.7.2 처럼 배포판 버전이 찍히면 성공이다
```

★ **`LD_LIBRARY_PATH` 를 반드시 걸어라.** 추출본은 시스템 경로에 없으므로 링커가 자기 라이브러리를 못 찾는다.
증상이 `libgpgmepp.so.6: cannot open shared object file` 처럼 **특정 라이브러리 이름**으로 나와서
"그 패키지가 안 받아졌다" 로 오진하기 쉽다. 파일은 `$PREFIX/usr/lib64/` 에 이미 있다.
`ldd $PREFIX/usr/lib64/libreoffice/program/soffice.bin | grep 'not found'` 가 비면 경로 문제이지 누락이 아니다.

★ **`chmod -R u+rwX` 를 RPM 마다 돌려야 한다.** 일부 RPM 이 `usr/lib64` 를 쓰기 불가 모드로 만들고,
그 뒤 RPM 의 `cpio` 가 `cannot make directory: Permission denied` 로 조용히 실패한다.
`2>/dev/null` 로 에러를 가려 두면 **추출이 수백 MB 진행돼도 정작 바이너리가 하나도 안 나온다.**
증상이 "용량은 늘었는데 `soffice` 가 없다" 이므로 디스크만 보고 성공으로 오판하기 쉽다.

**glibc 2.29 이상: 업스트림 tarball 도 쓸 수 있다.** 자체 라이브러리를 번들해 배포판과 안 싸운다.

```bash
V=$(curl -s https://download.documentfoundation.org/libreoffice/stable/ \
    | grep -oE '[0-9]+\.[0-9]+\.[0-9]+/' | sort -V | tail -1 | tr -d '/')
A=$(uname -m)          # x86_64 또는 aarch64. 업스트림이 둘 다 제공한다
curl -sL -o /tmp/lo.tar.gz \
  "https://download.documentfoundation.org/libreoffice/stable/$V/rpm/$A/LibreOffice_${V}_Linux_${A/x86_64/x86-64}_rpm.tar.gz"
```

이후는 위와 같은 추출 절차이고 `chmod` 주의도 동일하다.
deb 계열은 `rpm/` 대신 `deb/` 를 받아 `dpkg-deb -x` 로 편다.
`rpm2cpio` 와 `cpio` 가 없으면 이 경로는 못 쓴다. 그때는 root 를 얻거나 시각 검증을 건너뛴다.

다운로드가 250~320MB 다. 느린 회선에서는 백그라운드로 돌린다.

### 2-c. macOS

```bash
brew install --cask libreoffice        # brew 가 있으면 이게 가장 단순하다
```

brew 가 없으면 업스트림 dmg 를 받는다. 아키텍처 이름이 `aarch64` 다(`arm64` 는 404 다).

```bash
V=<위와 동일하게 조회>
curl -sL -o /tmp/lo.dmg "https://download.documentfoundation.org/libreoffice/stable/$V/mac/aarch64/LibreOffice_${V}_MacOS_aarch64.dmg"
hdiutil attach /tmp/lo.dmg -nobrowse -quiet
cp -R "/Volumes/LibreOffice/LibreOffice.app" /Applications/     # root 또는 쓰기 권한 필요
hdiutil detach "/Volumes/LibreOffice" -quiet
/Applications/LibreOffice.app/Contents/MacOS/soffice --version
```

macOS 의 `soffice` 는 `PATH` 에 없다. 위 전체 경로를 그대로 쓴다.

### 2-d. Windows

```cmd
winget install --id TheDocumentFoundation.LibreOffice -e --scope user
```

`--scope user` 가 요점이다.
기본(machine) 스코프는 관리자를 요구하므로 비관리자 계정에서 실패한다.
설치 후 `soffice.com` 은 보통 `%LOCALAPPDATA%\Programs\LibreOffice\program\` 아래에 있다.
**cmd 에서 `;` 는 구분자가 아니다.** 여러 명령을 이을 때는 `&&` 를 쓴다.

## 3. PDF 렌더 확인 (이 설치의 존재 이유)

```bash
SOFFICE=<위에서 확인한 경로>
$SOFFICE --headless --convert-to pdf --outdir <출력디렉터리> <입력.pptx>
```

**렌더 결과의 페이지 크기를 반드시 재라.** 변환이 성공했다는 것과 A4 로 나왔다는 것은 다른 말이다.

```bash
python -c "
import re,zlib,sys
d=open(sys.argv[1],'rb').read()
m=re.search(rb'/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)', d)
if m:
    w=float(m.group(3))-float(m.group(1)); h=float(m.group(4))-float(m.group(2))
    print('MediaBox %.1f x %.1f pt = %.1f x %.1f mm' % (w,h,w*25.4/72,h*25.4/72))
    print('A4 세로 판정:', abs(w*25.4/72-210)<1 and abs(h*25.4/72-297)<1)
" <출력.pdf>
```

A4 세로는 **210 x 297 mm = 595 x 842 pt** 다.
1mm 안쪽이면 통과로 본다(PDF 포인트 반올림 때문이다).

`soffice` 가 이미 떠 있으면 두 번째 호출이 조용히 아무것도 안 하고 끝날 수 있다.
자동화에서는 프로파일을 분리한다: `-env:UserInstallation=file:///tmp/lo-profile-$$`.

## 4. 검증 (보고 의무)

설치했다고 말하기 전에 아래를 실제로 돌리고 출력을 보고한다.

```bash
node -v                                             # 검증기 전제
node -e "require('pptxgenjs')" && echo builder-node-ok
$PY -c "import pptx" && echo builder-python-ok       # 둘 중 하나면 충분
$SOFFICE --version                                   # 선택
```

보고에는 **고른 경로와 그 이유**를 함께 적는다.
"설치했다" 만으로는 다음 사람이 같은 결정을 재현할 수 없다.
root 가 없어서 홈 프리픽스로 갔다면 그 사실이 곧 다음 사람에게 필요한 정보다.

## 함정

- **`python3` 이 3.6 인 배포판이 있다.** RHEL8/Rocky8 기본이 3.6.8 이다. python-pptx 가 안 들어간다. 버전 스캔에서 고른 인터프리터를 쓴다.
- **`require('pptxgenjs/package.json')` 로 설치를 확인하지 마라.** `exports` 필드에 막혀 실패한다. 패키지는 멀쩡한데 확인 명령이 틀린 것이다.
- **macOS 업스트림 경로는 `aarch64` 다.** `arm64` 로 요청하면 404 다.
- **macOS 의 soffice 는 PATH 에 없다.** `/Applications/LibreOffice.app/Contents/MacOS/soffice` 를 그대로 쓴다.
- **Windows 는 `--scope user` 를 붙여야 비관리자에서 설치된다.** 그리고 cmd 에서 `;` 는 구분자가 아니다.
- **변환 성공 != A4.** MediaBox 를 반드시 재라. 슬라이드 크기가 틀린 채로도 PDF 는 잘 나온다.
- **soffice 중복 실행.** 이미 떠 있으면 두 번째 호출이 조용히 종료된다. `-env:UserInstallation` 으로 프로파일을 분리한다.
- **LibreOffice 는 참조 렌더러이지 PowerPoint 가 아니다.** 여기서 통과해도 PowerPoint 에서 다르게 보일 수 있다. 이 설치가 메우는 구멍은 "규격은 맞는데 렌더가 깨지는" 부류이지 "PowerPoint 호환성 전부" 가 아니다.
- **렌더의 한글 자간을 산출물 결함으로 오해하지 마라.** LibreOffice 는 한글과 라틴·숫자·문장부호 사이에 자간을 자동으로 넣는다. 그래서 `갱신이었다. 특히 2분기` 가 화면에서 `갱신이었다 . 특히 2 분기` 처럼 보인다. **실측으로 확인한 렌더러 동작이다.** 의심되면 `unzip -p out.pptx ppt/slides/slide1.xml | grep -o '<a:t>[^<]*'` 로 실제 텍스트를 보라. 거기에 공백이 없으면 산출물은 멀쩡하고 화면만 그렇게 그려진 것이다.
- **디스크.** 추출 설치가 약 1.5GB 를 쓴다. 홈 디렉터리 할당량이 빠듯하면 먼저 확인한다.

## 관련

- `vertical-pptx` — 이 설치가 지원하는 대상 스킬
- `docs-setup` — `arch-diagram`·`pdf-vision-extract` 용 python 툴(python-pptx 가 겹친다)
- `setup-node` / `setup-python` — 런타임 자체가 없을 때 먼저
