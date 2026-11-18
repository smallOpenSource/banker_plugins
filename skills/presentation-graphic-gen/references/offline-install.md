# 인터넷이 없는 PC 에 준비하기

이 스킬은 아무것도 내려받지 않는다. 필요한 것은 둘이다: Node 22 이상, Chromium 계열 브라우저(Chrome, Edge, Chromium). 인터넷이 없는 PC 라면 사람이 아래 순서로 준비한다. 에이전트는 이 순서를 안내만 하고, 내려받기 명령을 대신 돌리지 않는다.

인터넷이 되는 PC 가 있으면 banker 의 `setup-node`, `setup-playwright` 스킬이 같은 일을 더 쉽게 한다.

## 1. 인터넷 PC 에서 받기(공식 출처만)

| 무엇 | 출처 | 받을 파일 |
|---|---|---|
| Node.js 22 LTS | `https://nodejs.org/dist/` 의 `latest-v22.x/` | OS 에 맞는 설치 파일(Windows `.msi`, macOS `.pkg`, Linux `.tar.xz`)과 같은 폴더의 해시 목록 파일 `SHASUMS256` |
| Chrome for Testing | `https://googlechromelabs.github.io/chrome-for-testing/` 의 JSON 끝점(`last-known-good-versions-with-downloads.json`) | `chrome` 항목에서 OS 에 맞는 zip 주소(Stable 채널) |
| Microsoft Edge(Windows) | Microsoft Edge for Business 내려받기 페이지 | 기업용 설치 파일(`.msi`) |
| Playwright 의 chromium | 인터넷 PC 에서 Playwright 로 받은 브라우저 폴더(`ms-playwright/chromium-<번호>/`) | 폴더째 |

- Playwright 의 chromium 과 일반 Chromium 은 H.264 를 풀지 못할 수 있다. 그때 PPTX 영상 연속성 게이트는 SKIP 이 된다. Chrome for Testing 의 H.264 디코딩은 이 스킬에서 시험하지 않았다. 설치형 Chrome 이나 Edge 를 권한다.
- 주소는 사람이 브라우저로 연다. 받은 파일을 셸에 바로 넘겨 실행하지 않는다.

## 2. 받은 파일 확인

- Node: 받은 설치 파일의 sha256 을 해시 목록 파일 `SHASUMS256` 의 같은 이름 줄과 비교한다.
- Chrome for Testing, Edge: 출처 페이지가 해시를 주면 같은 방법으로 비교한다. 주지 않으면 받은 PC 에서 낸 sha256 을 적어 두고 옮긴 뒤 다시 낸 값과 비교한다(옮기는 동안 바뀌지 않았는지).

| OS | sha256 내는 명령 |
|---|---|
| Windows(PowerShell) | `Get-FileHash -Algorithm SHA256 <파일>` |
| Windows(cmd) | `certutil -hashfile <파일> SHA256` |
| macOS | `shasum -a 256 <파일>` |
| Linux | `sha256sum <파일>` |

## 3. 옮기기와 설치

- 회사 규정이 정한 매체나 망 연계로 옮긴다.
- Node: 설치 파일을 실행하거나(Windows, macOS), 압축을 풀어 `bin` 을 `PATH` 에 넣는다(Linux). `node --version` 이 v22 이상인지 본다.
- Chrome for Testing: 압축을 푼 폴더의 실행 파일 경로를 환경 변수 `CHROME` 에 넣는다.

| OS | 실행 파일 |
|---|---|
| Windows | `chrome-win64\chrome.exe` |
| macOS(Apple silicon) | `chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing` |
| macOS(Intel) | `chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing` |
| Linux | `chrome-linux64/chrome` |

- Playwright 의 chromium 폴더(`chromium-<번호>/`) 안도 같은 이름이다. 도우미는 이 표의 경로를 모두 찾는다.

- Edge: 기업용 설치 파일을 실행한다. 기본 경로에 설치되면 따로 지정하지 않아도 찾는다.
- Playwright 의 chromium: 받은 폴더를 Windows `%LOCALAPPDATA%\ms-playwright\`, macOS `~/Library/Caches/ms-playwright/`, Linux `~/.cache/ms-playwright/` 아래에 두거나, 그 위 폴더를 환경 변수 `PLAYWRIGHT_BROWSERS_PATH` 에 넣는다.
- Linux 를 root 로 쓰면 브라우저가 `--no-sandbox` 로 뜬다(도우미가 알아서 붙임).

### Linux 의 snap Chromium

Ubuntu 의 `chromium`, `chromium-browser` 명령은 보통 snap 으로 설치된 Chromium 을 띄운다. snap 브라우저는 갇혀서 돈다.

| 제약 | 도우미의 대처 |
|---|---|
| 자기 전용 `/tmp` 를 써서 호스트의 `/tmp` 를 보지 못함 | 프로필 폴더를 `/tmp` 대신 `~/snap/chromium/common/` 에 만든다. 그 폴더가 없으면 `~/.cache/presentation-graphic-gen/` 에 만든다 |
| 홈 폴더 아래의 숨김이 아닌 폴더만 읽음 | 덱 파일이 그 밖(`/tmp`, 숨김 폴더 등)에 있으면 브라우저를 그 파일로 보내기 전에 `snap Chromium cannot read <파일>` 문장과 종료 코드 2 로 끝난다 |

- snap 인지는 브라우저 경로, 실제 경로(`/snap/` 이 들어 있거나 `/usr/bin/snap`), `/snap/bin/` 을 부르는 스크립트인지로 판단한다.
- 덱과 출력 폴더를 홈 아래(예: `~/talks/`)에 둔다. 그래도 안 되면 snap 이 아닌 브라우저(Chrome, Edge, Playwright 의 chromium)의 실행 파일 경로를 `CHROME` 에 넣는다.
- 스킬의 시험(`*.test.mjs`)은 OS 임시 폴더를 쓴다. snap Chromium 만 있는 PC 에서는 `CHROME` 으로 다른 브라우저를 지정해 돌린다.
- 이 대처는 판단 함수의 단위 시험으로만 확인했다. 실제 snap Chromium 으로 돌려 보지 않았다.

## 4. 확인

- `node "<S>/scripts/cdp.mjs"` 가 `browser <경로>` 를 내면 준비가 끝났다.
- `node "<S>/scripts/make.mjs" --sample --format html --dir <빈 폴더>` 가 게이트를 모두 통과하면 이 PC 에서 스킬이 돈다.
