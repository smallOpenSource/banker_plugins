---
name: docs-setup
description: "(banker) arch-diagram·pdf-vision-extract 의존성(python-pptx·pymupdf·plantuml)을 python 환경 감지/선택 후 설치. 'docs-setup'/'문서 툴 설치'/'pptx·pymupdf·plantuml 설치' 또는 /banker:setup 시 사용."
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
python3 -c "import pptx" 2>/dev/null && echo "python-pptx=yes" || echo "python-pptx=no"
python3 -c "import fitz" 2>/dev/null && echo "pymupdf=yes" || echo "pymupdf=no"
# 후보 python 스캔 (⚠️ pymupdf/playwright 는 python 3.8+ 필요 — 3.6/3.7 은 휠 없음)
for v in 3.13 3.12 3.11 3.10 3.9 3.8; do command -v python$v >/dev/null && echo "python$v=$(python$v --version 2>&1)"; done
ls -d ~/.venvs/*/bin/python ~/miniconda3/envs/*/bin/python /usr/bin/python3* 2>/dev/null
conda env list 2>/dev/null
```

## 1. python 환경 선택 (질문 또는 자동)
- **`--python <path>`**: 주어진 인터프리터 사용.
- **`--ask`**: 위 스캔 후보를 제시하고 사용자가 택함(Claude=`AskUserQuestion`, Codex=목록 제시).
- **자동(기본)**: **python 3.8+** 인터프리터로 전용 venv 를 만든다. ⚠️ **system `python3` 가 3.6/3.7 이면 pymupdf/playwright 휠이 없어 실패**(실측: RHEL8 기본 `python3`=3.6 → `No matching distribution`/sdist 빌드 실패) → 위 스캔의 `python3.12`/`python3.11` 등 최신을 우선. 우선순위 = 활성 conda 환경 > 기존 `~/.venvs/banker-docs` > **최신 python3.x 신규 venv**:
  ```bash
  PY_BASE="$(command -v python3.12 || command -v python3.11 || command -v python3)"   # 3.8+ 우선
  "$PY_BASE" -m venv ~/.venvs/banker-docs
  ~/.venvs/banker-docs/bin/pip install -U pip        # 최신 pip = wheel 우선(빌드 회피)
  PY=~/.venvs/banker-docs/bin/python
  ```
  conda 선호 시: `conda create -y -n banker-docs python=3.11 && PY=$(conda run -n banker-docs which python)`.

## 2. python 라이브러리 설치
```bash
"$PY" -m pip install -U python-pptx pymupdf     # 최신 pip 면 wheel 로 설치(빌드 없음)
```
- 그래도 빌드 실패(휠 부재·헤더 부재)면 **정직 보고**: root 면 `dnf install -y gcc zlib-devel libjpeg-turbo-devel`(Pillow 빌드용) 후 재시도, 아니면 conda 경로 권장(가짜 성공 금지).

## 3. plantuml (arch-diagram 의 PlantUML 렌더)
java 필요(`java -version`). plantuml.jar + 래퍼:
```bash
mkdir -p ~/bin
[ -f ~/bin/plantuml.jar ] || curl -fsSL -o ~/bin/plantuml.jar \
  https://github.com/plantuml/plantuml/releases/latest/download/plantuml.jar
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
"$PY" -c "import pptx, fitz; print('pptx', pptx.__version__, '| pymupdf OK')"
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
