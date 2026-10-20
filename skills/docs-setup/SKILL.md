---
name: docs-setup
description: "`arch-diagram` 과 `pdf-vision-extract` 의 의존성(python-pptx, pymupdf, plantuml)을 설치. Python 환경을 감지하거나 고른 뒤 그 환경에 설치. 'docs-setup'/'문서 툴 설치'/'pptx 설치'/'pymupdf 설치'/'plantuml 설치' 또는 `/banker:setup` 시 사용."
---

# docs-setup — 문서 생성 툴 설치 (python-pptx·pymupdf·plantuml)

arch-diagram(편집 가능 PPTX + PlantUML 렌더)과 pdf-vision-extract(PDF→PNG)가 쓰는 python/java 툴을
설치한다. **python 환경을 먼저 감지·선택**(질문 또는 자동)하고, system pip 의 sdist 빌드 실패(RHEL8
헤더 갭 등)를 피하려 **venv/conda 를 우선**한다. 설치는 **멱등**(이미 있으면 skip·검증만). 답변은 한글(기술 토큰 영문).

**런타임:** OS-레벨 설치라 **런타임 무관**(Claude Code·Codex 동일 동작). 선택 UI만 다르다 —
Claude=`AskUserQuestion`, Codex=후보 목록 제시 후 사용자 응답.

## 0. 감지 (먼저 — 추정 금지)
```bash
for t in python3 pip conda java dot; do command -v $t >/dev/null && echo "$t=yes" || echo "$t=no"; done
[ -f ~/bin/plantuml.jar ] && echo "plantuml.jar=yes" || echo "plantuml.jar=no"
[ -f /etc/os-release ] && . /etc/os-release && echo "distro=$ID ${VERSION_ID}"
(cd ~ && python3 -c "import pptx") 2>/dev/null && echo "python-pptx=yes" || echo "python-pptx=no"   # 홈에서: -c, -m, 표준 입력 스크립트는 지금 폴더의 모듈을 먼저 불러온다
(cd ~ && python3 -c "import fitz") 2>/dev/null && echo "pymupdf=yes" || echo "pymupdf=no"
# 후보 python 스캔 (⚠️ pymupdf/playwright 는 python 3.8+ 필요 — 3.6/3.7 은 휠 없음)
for v in 3.13 3.12 3.11 3.10 3.9 3.8; do command -v python$v >/dev/null && echo "python$v=$(python$v --version 2>&1)"; done
ls -d ~/.venvs/*/bin/python ~/miniconda3/envs/*/bin/python /usr/bin/python3* 2>/dev/null
conda env list 2>/dev/null
```

### 네트워크 확인 (내려받기 전)

이 스킬이 내려받는 원천에 10초 안에 닿는지 먼저 본다. 닿지 않으면 그 원천에서 받는 단계는 하지 않고, 이미 설치된 것의 확인만 한 뒤 "오프라인이라 설치하지 않음(필요한 것: <못 깐 것>)" 으로 보고한다.

```bash
# pip 이 읽는 설정 전부(PIP_CONFIG_FILE 포함)를 홈 폴더에서 읽는다. install 절이 global 절보다 앞선다
L=$( (cd ~ && { pip config list || pip3 config list || python3 -m pip config list; }) 2>/dev/null) || echo "pip 설정을 읽지 못함(pip 이 없거나 10 미만). 사내 미러를 쓰면 확인 주소를 그 미러로 바꿔 본다"
I="${PIP_INDEX_URL:-$(printf '%s\n' "$L" | sed -n "s/^install\.index-url='\(.*\)'$/\1/p")}"
I="${I:-$(printf '%s\n' "$L" | sed -n "s/^global\.index-url='\(.*\)'$/\1/p")}"
I=$(printf %s "${I:-https://pypi.org/simple}" | sed -E 's#^([A-Za-z][A-Za-z0-9+.-]*://)[^/]*@#\1#; s#/$##')   # 주소의 사용자 정보는 뗌
printf 'url = "%s"\n' "$I/pip/" | curl -K - -sSI -o /dev/null --connect-timeout 5 --max-time 10   # python-pptx, pymupdf
curl -sSI -o /dev/null --connect-timeout 5 --max-time 10 https://github.com   # plantuml.jar
```

- `curl -sSI` 는 머리만 받는다(본문을 받지 않음). 닿지 못하면 종료 코드가 0 이 아니다(HTTP 상태와 관계없음). `curl` 은 `HTTPS_PROXY` 를 따른다.
- PyPI 는 pip 이 쓰는 색인(`PIP_INDEX_URL`, `pip config list` 의 `install.index-url` 이나 `global.index-url`, 없으면 pypi.org)의 작은 쪽(`<색인>/pip/`)을 본다.
- `pip config get` 은 `PIP_CONFIG_FILE` 로 준 파일을 읽지 않아(pip 25.0 실측) `pip config list` 를 읽는다.
- 홈 폴더에서 읽는다. `python3 -m pip` 는 지금 폴더를 import 경로 맨 앞에 두어, 지금 폴더에 있는 남의 저장소의 `pip/` 가 실행될 수 있다.
- bash 블록은 주소를 명령 인자가 아니라 표준 입력의 curl 설정(`-K -`)으로 넘긴다. 명령 인자는 같은 PC 의 다른 사용자가 `ps` 로 볼 수 있어, 경로나 질의에 든 토큰도 거기 싣지 않는다. 사용자 정보(`사용자:토큰@`)는 떼고 묻는다. 닿는지만 보므로 인증은 필요 없다(401 도 닿은 것이다). Windows 에서도 뗀 주소를 쓴다.
- Windows PowerShell 에서는 같은 주소를 `curl.exe -sSI -o NUL --connect-timeout 5 --max-time 10 <주소>` 로 보고 `$LASTEXITCODE` 가 0 인지 본다(PowerShell 5.1 의 `curl` 은 `Invoke-WebRequest` 별칭이다). `curl.exe` 는 Windows 시스템 프록시를 따르지 않고 `HTTPS_PROXY` 만 따른다.
- 사내 미러만 열린 망이면 확인 주소를 그 미러로 바꿔 본다.

## 1. python 환경 선택 (질문 또는 자동)
- **`--python <path>`**: 주어진 인터프리터 사용.
- **`--ask`**: 위 스캔 후보를 제시하고 사용자가 택함(Claude=`AskUserQuestion`, Codex=목록 제시).
- **자동(기본)**: **python 3.8+** 인터프리터로 전용 venv 를 만든다. ⚠️ **system `python3` 가 3.6/3.7 이면 pymupdf/playwright 휠이 없어 실패**(실측: RHEL8 기본 `python3`=3.6 → `No matching distribution`/sdist 빌드 실패) → 위 스캔의 `python3.12`/`python3.11` 등 최신을 우선. 우선순위 = 활성 conda 환경 > 기존 `~/.venvs/banker-docs` > **최신 python3.x 신규 venv**:
  ```bash
  PY_BASE="$(command -v python3.12 || command -v python3.11 || command -v python3)"   # 3.8+ 우선
  (cd ~ && "$PY_BASE" -m venv ~/.venvs/banker-docs)
  ~/.venvs/banker-docs/bin/pip install -U pip        # 최신 pip = wheel 우선(빌드 회피)
  PY=~/.venvs/banker-docs/bin/python
  ```
  conda 선호 시: `conda create -y -n banker-docs python=3.11 && PY=$(conda run -n banker-docs which python)`.

## 2. python 라이브러리 설치
```bash
(cd ~ && "$PY" -m pip install -U python-pptx pymupdf)     # 최신 pip 면 wheel 로 설치(빌드 없음)
```
- 그래도 빌드 실패(휠 부재·헤더 부재)면 **정직 보고**: root 면 `dnf install -y gcc zlib-devel libjpeg-turbo-devel`(Pillow 빌드용) 후 재시도, 아니면 conda 경로 권장(가짜 성공 금지).

## 3. plantuml (arch-diagram 의 PlantUML 렌더)
java 필요(`java -version`). plantuml.jar + 래퍼:
```bash
mkdir -p ~/bin
[ -f ~/bin/plantuml.jar ] || { curl -fsSL --connect-timeout 10 --speed-limit 1000 --speed-time 30 -o ~/bin/plantuml.jar.part \
  https://github.com/plantuml/plantuml/releases/latest/download/plantuml.jar && mv ~/bin/plantuml.jar.part ~/bin/plantuml.jar; }
rm -f ~/bin/plantuml.jar.part     # 받다가 끊긴 조각(완성본만 plantuml.jar 이름을 얻는다)
cat > ~/bin/plantuml <<'EOF'
#!/bin/bash
exec java -jar "$HOME/bin/plantuml.jar" "$@"
EOF
chmod +x ~/bin/plantuml
grep -q 'HOME/bin' <<<"$PATH" || echo 'export PATH="$HOME/bin:$PATH"' >> ~/.bashrc
```
- **graphviz(dot)**: PlantUML 의 일부 다이어그램(시퀀스 외)이 요구. `dnf install -y graphviz`(root) / `brew install graphviz`(mac). 없으면 시퀀스·컴포넌트류는 dot 없이 렌더됨(정직 안내).
- java 부재: `dnf install -y java-21-openjdk`(root) / `brew install openjdk` / 관리자 요청.

## 4. 소비 스킬 연결
- **arch-diagram**: `build_pptx_template.py` 를 위 `$PY`(python-pptx)로 실행. PlantUML 은 `~/bin/plantuml`.
- **pdf-vision-extract**: pymupdf(`import fitz`)를 `$PY` 로 실행.
- 선택한 인터프리터 경로를 **보고**하고, 소비 스킬 실행 시 그 python 을 쓰도록 안내(예: `~/.venvs/banker-docs/bin/python`). 설치 python 과 소비 python 이 달라지면 `ModuleNotFoundError`.

## 5. 검증 (보고 의무)
```bash
(cd ~ && "$PY" -c "import pptx, fitz; print('pptx', pptx.__version__, '| pymupdf OK')")
~/bin/plantuml -version 2>/dev/null | head -1 || java -jar ~/bin/plantuml.jar -version 2>/dev/null | head -1
command -v dot >/dev/null && dot -V 2>&1 | head -1 || echo "graphviz(dot) 없음(시퀀스류는 OK)"
```
4-field 보고: 변경(설치 항목·venv 경로·env 파일) / Evidence(위 출력) / 검증(import·-version OK) / Unknown(관리자 권한 라이브러리 미설치 등).

## 함정
- **system pip 빌드 벽**: RHEL8 등에서 Pillow sdist 빌드 실패 → 최신 pip + venv 로 **wheel** 설치가 안전. 안 되면 dnf dev 헤더 or conda(정직 보고).
- **python 경로 혼선**: 설치 python 과 소비 스킬 python 이 다르면 `ModuleNotFoundError` → 선택한 `$PY` 명시·재사용.
- **plantuml java/dot 의존**: java 없으면 렌더 불가, dot 없으면 일부 다이어그램만 제한 → 정직 안내.
- **PATH 미적용**: `~/.bashrc` 는 새 셸에만 → 현재 셸엔 `source ~/.bashrc` 또는 절대경로.

ARGUMENTS: [--python <path>] [--ask] (없으면 자동 감지 — 전용 venv 우선)
