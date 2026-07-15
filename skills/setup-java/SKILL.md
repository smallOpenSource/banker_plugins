---
name: setup-java
description: "(banker) JDK 21 + JAVA_HOME 설치(alternatives로 java·javac 비대칭 방지, Debian은 Adoptium 전용). jdtls 등 Java LSP 전제. 'setup-java'/'JDK 설치'/'Java 21 설치' 또는 /banker:setup 시 사용."
---

# setup-java: JDK 21 + JAVA_HOME 설치

Java LSP(`jdtls`) 등 Java 도구가 요구하는 JDK 21과 `JAVA_HOME`을 설치·구성한다.
멱등(이미 21이면 skip·검증만). 답변은 한글(명령·경로는 영문).

## 런타임 배선
- **Claude Code**: `docs-setup`의 PlantUML 렌더(`java -jar plantuml.jar`)가 java 존재를 전제로 동작.
- **Codex/OMX**: `jdtls`(Java LSP)와 Spring Boot Language Server(`java -jar ...`)가 JDK 21을 요구한다. 이를 실제로 내려받아 구동하는 별도 LSP 설치 스킬(예: setup-lsp)의 전제조건이 이 스킬이다.
- 이 스킬은 JDK 설치·`JAVA_HOME` 확정까지만 담당하고, jdtls 자체 배포·`JDTLS_JVM_ARGS` 같은 힙 튜닝은 LSP 설치 스킬의 영역이다.

## 0. 감지 (먼저, 추정 금지)
```bash
[ -f /etc/os-release ] && . /etc/os-release && echo "distro=$ID ${VERSION_ID}"
command -v java  >/dev/null && java -version 2>&1 | head -1 || echo "java=미설치"
command -v javac >/dev/null && javac -version 2>&1          || echo "javac=미설치"
echo "JAVA_HOME=${JAVA_HOME:-미설정}"
```
```powershell
$PSVersionTable.PSVersion
if (Get-Command java -ErrorAction SilentlyContinue) { java -version } else { "java: 미설치" }
[Environment]::GetEnvironmentVariable('JAVA_HOME','User')
```

## 1. Rocky Linux 8
```bash
sudo dnf install -y java-21-openjdk-devel
JAVA21_HOME=$(dirname "$(dirname "$(readlink -f /usr/lib/jvm/java-21-openjdk*/bin/java)")")
sudo alternatives --install /usr/bin/java  java  "$JAVA21_HOME/bin/java"  21 \
  --slave /usr/bin/javac javac "$JAVA21_HOME/bin/javac" \
  --slave /usr/bin/jar   jar   "$JAVA21_HOME/bin/jar"
sudo alternatives --set java "$JAVA21_HOME/bin/java"
export JAVA_HOME="$JAVA21_HOME"   # 아래 "rc 마커 공통"이 참조
```
- `--slave`로 `java`·`javac`·`jar`를 한 그룹으로 묶는 이유: 나중에 `alternatives --config java`로 버전을 바꿀 때 `javac`가 따로 놀면(비대칭) 컴파일이 엉뚱한 버전으로 실행된다.

## 2. Ubuntu 20.04~24.04
```bash
sudo apt update
sudo apt install -y openjdk-21-jdk || echo "openjdk-21-jdk 미제공. 아래 3. Debian의 Adoptium 블록을 그대로 적용"
sudo update-alternatives --config java     # 여러 버전 중 21 선택(javac도 slave로 동반 전환)
javac -version   # java와 버전 일치 확인(비대칭 점검)
export JAVA_HOME="$(dirname "$(dirname "$(readlink -f "$(command -v javac)")")")"   # 아래 "rc 마커 공통"이 참조
```

## 3. Debian 12 (bookworm): Adoptium Temurin 전용
⚠️ **default·backports 저장소 모두 JDK 21을 제공하지 않는다.** Adoptium 레포 추가가 유일한 경로(재확인: 배포판이 이후 21을 backport하면 이 단계는 생략 가능).
```bash
sudo apt-get install -y wget gnupg
wget -qO - https://packages.adoptium.net/artifactory/api/gpg/key/public | \
  sudo gpg --dearmor -o /usr/share/keyrings/adoptium.gpg
echo "deb [signed-by=/usr/share/keyrings/adoptium.gpg] https://packages.adoptium.net/artifactory/deb bookworm main" | \
  sudo tee /etc/apt/sources.list.d/adoptium.list
sudo apt-get update
sudo apt-get install -y temurin-21-jdk
sudo update-alternatives --config java
export JAVA_HOME="/usr/lib/jvm/temurin-21-jdk-$(dpkg --print-architecture)"   # amd64/arm64 자동
```
(Ubuntu에서 `openjdk-21-jdk`가 없을 때도 이 블록을 그대로 재사용한다.)

## 4. macOS (Apple Silicon / Intel)
```zsh
brew install openjdk@21
sudo ln -sfn "$(brew --prefix openjdk@21)/libexec/openjdk.jdk" \
  /Library/Java/JavaVirtualMachines/openjdk-21.jdk   # 유일한 sudo, 1회성
export JAVA_HOME="$(brew --prefix openjdk@21)"        # 아래 공통 rc 블록 참고
/usr/libexec/java_home -v 21
```
Apple Silicon(`/opt/homebrew`)·Intel(`/usr/local`) 차이는 `brew --prefix`가 자동 흡수하므로 이 스크립트는 두 아키텍처에 동일 적용.

## 5. Windows 10/11
```powershell
winget install --id Microsoft.OpenJDK.21 -e
$jdk = (Get-ChildItem "$env:ProgramFiles\Microsoft\jdk-21*" -Directory | Select-Object -First 1).FullName
[Environment]::SetEnvironmentVariable('JAVA_HOME', $jdk, 'User')
[Environment]::SetEnvironmentVariable('PATH', "$jdk\bin;" + [Environment]::GetEnvironmentVariable('PATH','User'), 'User')
```
User-scope로 지정하면 Machine-scope에 남아있을 수 있는 구버전(Java 8 등)보다 PATH 우선순위가 앞선다. 새 터미널에서 반영 확인.

## rc 마커 공통 (Linux/macOS, Windows 제외)
```bash
RC_FILE="$HOME/.bashrc"    # macOS는 $HOME/.zshrc
grep -q '### BANKER_JAVA_BEGIN ###' "$RC_FILE" || cat >> "$RC_FILE" <<EOF

### BANKER_JAVA_BEGIN ###
export JAVA_HOME="$JAVA_HOME"
export PATH="\$JAVA_HOME/bin:\$PATH"
### BANKER_JAVA_END ###
EOF
source "$RC_FILE"
```

## 검증 (보고 의무)
```bash
java -version    # openjdk 21.x 기대
javac -version   # java와 동일 21.x(다르면 alternatives 비대칭)
echo "$JAVA_HOME"
```
4-field 보고: 변경(설치 패키지·alternatives 전환·JAVA_HOME 값) / Evidence(위 출력) / 검증(java·javac 버전 일치) / Unknown(관리자 권한 부재로 alternatives 미실행 등, 가짜 성공 금지).

## 함정
- **java/javac 비대칭**: `alternatives`(RHEL 계열)·`update-alternatives`(Debian 계열)에서 `java`만 바꾸고 `javac`를 안 바꾸면 "실행은 21, 컴파일은 8" 같은 사고 발생 → `--slave`로 묶거나 전환 직후 `javac -version` 대조.
- **Debian 12 저장소 공백**: default·backports 모두 21 없음 → Adoptium 필수(버전 상황은 실행 전 재확인).
- **Adoptium GPG/네트워크 차단**: 사내 프록시 환경이면 `packages.adoptium.net` 접근이 막힐 수 있음 → 정직 보고, 프록시 예외 요청.
- **macOS symlink**: 1회성 sudo. `brew upgrade`로 21 내 패치 버전이 올라가도 재실행 불요하나, 메이저가 바뀌면(예: 21→25) 재실행 필요.
- **Windows JAVA_HOME 누락**: 설정 안 하면 jdtls 등이 엉뚱한(또는 없는) JRE를 찾아 조용히 실패 → User-scope로 명시 설정 후 새 터미널에서 확인.
- **버전 기준 재확인**: JDK 21 고정은 jdtls 호환 기준(2026-07 시점). 이후 jdtls·Spring Boot LS가 더 최신 LTS(예: 25)를 요구하게 되면 이 스킬의 버전 인자를 올려 재실행.

ARGUMENTS: [--version <n>] (없으면 21 자동 설치)
