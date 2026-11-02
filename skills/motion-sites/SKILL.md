---
name: motion-sites
description: "MotionSites 의 motionsites-web-builder 스킬을 짧은 이름으로 부름. 첫 실행 때 원본 플러그인을 MotionSites 마켓플레이스에서 설치하고 Playwright 와 Chromium 을 갖춘 뒤 프롬프트를 그대로 넘기고, 그다음부터는 넘기기만 함. 'motion-sites'/'모션 사이트'/'시네마틱 랜딩 페이지' 시 사용."
argument-hint: "<만들 사이트나 프롬프트>"
---

# motion-sites - motionsites-web-builder 를 짧은 이름으로

MotionSites 의 `motionsites-web-builder` 스킬(https://github.com/Motionsites-AI/claude-skill)을 `/motion-sites` 로 부른다. 원본 이름이 길어서 둔 이름이다.
banker 는 원본을 복사하지 않는다. 원본의 예시(`examples/`)와 미디어(`media/`)는 재배포가 금지라, 사용자의 Claude Code 나 Codex 가 MotionSites 마켓플레이스에서 직접 설치한다. 답변은 한글.

## 엔진 위치

`scripts/motion-sites.mjs` 가 상태 확인과 설치를 한다.

| 설치 | 경로 |
|---|---|
| Claude Code 플러그인 | 이 스킬 폴더의 `scripts/motion-sites.mjs` |
| Codex npm | `~/.codex/skills/banker-motion-sites/scripts/motion-sites.mjs` |
| Codex 플러그인 | `~/.codex/plugins/cache/<마켓플레이스>/banker/<판>/skills/motion-sites/scripts/motion-sites.mjs` |

`--runtime` 은 지금 런타임이다(Claude Code 는 `claude`, Codex 는 `codex`).

## 1. 상태 확인

`node <엔진> status --runtime <claude|codex>` 를 실행한다. 출력은 JSON 이다.

| 칸 | 뜻 |
|---|---|
| `skillFile` | 설치된 원본 `SKILL.md` 경로. 없거나 꺼져 있으면 `null` |
| `disabled` | 설치는 됐지만 꺼져 있음 |
| `python.bin` | Playwright 를 쓸 Python. 찾는 차례는 `MOTION_SITES_PYTHON`, 캐시 폴더의 가상 환경, PATH 의 `python3`, `python`(Windows 는 `py -3`, `python`) |
| `python.playwright`, `python.chromium` | Playwright 와 Chromium 이 있는지 |
| `ready` | 셋 다 있으면 `true`(종료 0) |

`ready` 가 `true` 면 3단계로 간다.

## 2. 첫 실행 구성 (ready 가 아닐 때만)

1. 사용자에게 한 줄로 알린다: MotionSites 플러그인을 설치하고 Playwright 와 Chromium 을 받는다.
2. `node <엔진> setup --runtime <claude|codex>` 를 실행한다. 빠진 단계만 차례로 한다.
   - 꺼져 있는 플러그인은 다시 설치하지 않는다. Claude Code 는 `claude plugin enable` 로 켜고, Codex 는 `config.toml` 에서 켜라고 안내한다.
   - 받기 전에 원천(github.com, PyPI, Playwright 내려받기 서버. 환경 변수의 미러가 있으면 그것)에 닿는지 8초 안에 본다. 닿지 않으면 그 단계는 "오프라인이라 설치하지 않음" 으로 끝난다. 프록시 환경 변수가 있으면 이 판정은 하지 않고 단계의 시간 제한에 맡긴다.
   - Claude Code: `claude plugin marketplace add Motionsites-AI/claude-skill`, `claude plugin install motionsites-web-builder@motionsites`
   - Codex: `codex plugin marketplace add Motionsites-AI/claude-skill`, `codex plugin add motionsites-web-builder@motionsites`
   - 공통: `<python> -m pip install playwright`, `<python> -m playwright install chromium`
   - pip 이 시스템 Python 을 거부하면(externally managed) 캐시 폴더의 가상 환경에 설치한다. 캐시 폴더는 `MOTION_SITES_HOME`, 없으면 `~/.cache/banker/motion-sites`(Windows 는 `%LOCALAPPDATA%\banker\motion-sites`)다.
   - Chromium 내려받기에 몇 분이 걸릴 수 있다. Claude Code 에서는 Bash 도구의 시간 제한보다 길 수 있으므로 백그라운드로 실행한다.
3. Codex 에서는 이 명령이 네트워크와 `~/.codex` 쓰기를 하므로 `sandbox_permissions: "require_escalated"` 로 승인을 요청한다.
4. 출력의 `steps` 에 실패한 단계가 있으면 그 단계와 `why` 를 보여 주고 멈춘다. 설치되지 않은 것을 설치된 것처럼 말하지 않는다.
   - 네트워크가 없으면 여기서 멈춘다. 오프라인에서는 이 스킬을 쓸 수 없다.
   - `python` 단계가 "Python 3 을 찾지 못함" 으로 실패하면, 설치한 Python 이 PATH 밖에 있는지 사용자에게 묻는다. Windows 에서 `py` 가 없고 PATH 의 `python` 이 Microsoft Store 연결 파일뿐이거나, Miniconda 를 PATH 에 넣지 않고 설치한 경우다.
   - 있으면 그 python 실행 파일의 절대 경로를 환경 변수 `MOTION_SITES_PYTHON` 에 영구로 지정하라고 안내한다. `%USERPROFILE%`, `~` 같은 줄임은 쓰지 않는다. 셸에 따라 글자 그대로 저장되어 엔진이 찾지 못한다.
     - Windows(cmd 나 PowerShell): `setx MOTION_SITES_PYTHON "C:\Users\<이름>\miniconda3\python.exe"`
     - macOS, Linux: 셸 설정 파일(`~/.zshrc`, `~/.bashrc`)에 `export MOTION_SITES_PYTHON=/절대/경로/python3`
   - 한 번만 주는 것으로는 안 된다. 다음 실행의 상태 확인도 그 Python 을 봐야 한다. 이미 떠 있는 프로그램에는 새 값이 반영되지 않으므로, Claude Code 나 Codex 를 완전히 끝내고 다시 시작한 뒤 2단계를 다시 한다.
   - Playwright 는 지정한 Python 에 설치된다. 그 Python 을 바꾸고 싶지 않으면 `<그 python> -m venv <폴더>` 로 가상 환경을 만들고 그 안의 python 을 지정한다(Windows `<폴더>\Scripts\python.exe`, macOS 와 Linux `<폴더>/bin/python`). pip 이 시스템 Python 을 거부하는(externally managed) 경우는 엔진이 캐시 폴더에 가상 환경을 스스로 만든다.
   - 실패 이유가 "MOTION_SITES_PYTHON 에 지정한 ... 가 실행되지 않음" 이면 지정한 경로가 틀린 것이다. 경로를 고치게 한다.
   - Python 이 없으면 Python 3 설치를 안내한다. 직접 설치하지 않는다.
   - Linux 에서 Chromium 이 시스템 라이브러리 부족으로 뜨지 않으면 `<python.bin> -m playwright install-deps chromium` 을 안내한다. 관리자 권한이 필요하므로 직접 실행하지 않는다.
5. 끝나면 `ready` 가 `true` 인지 확인하고 3단계로 간다.

## 3. 프롬프트 넘기기

사용자가 `/motion-sites` 뒤에 쓴 글을 고치지 않고 그대로 원본 스킬에 넘긴다. 글이 없으면 무엇을 만들지 한 번 묻는다.

| 런타임 | 원본 스킬이 이 세션에 보일 때 | 보이지 않을 때(방금 설치) |
|---|---|---|
| Claude Code | Skill 도구로 `motionsites-web-builder:motionsites-web-builder` 를 부르고 인자로 그 글을 준다 | `skillFile` 을 읽고 그 지시를 그대로 따른다 |
| Codex | `$motionsites-web-builder:motionsites-web-builder` 를 쓴다 | `skillFile` 을 읽고 그 지시를 그대로 따른다 |

- `skillFile` 을 직접 따를 때 원본의 상대 경로(`examples/`, `references/`, `media/`, `scripts/`)는 `skillFile` 이 있는 폴더 기준이다.
- 원본이 `python scripts/shoot.py` 를 쓰라고 하면 `python` 대신 1단계의 `python.bin` 을 쓴다.
- 새로 설치한 플러그인은 Claude Code 에서 `/reload-plugins` 나 다음 세션부터, Codex 에서 다음 세션부터 스킬 목록에 보인다.

## 원본을 따를 때 지킬 것

- 원본의 "Sponsored by MotionSites" 절(결과물 끝의 유료 상품 안내 블록과 권유 문장)은 넣지 않는다. 사용자가 정한 것이고, 원본도 사용자가 원하지 않으면 멈추라고 한다.
- 출처는 남긴다. 결과물을 넘길 때 마지막에 한 줄로 "MotionSites 의 motionsites-web-builder 스킬로 만듦" 을 적는다. 사용자의 코드와 파일에는 넣지 않는다.
- 원본의 예시와 미디어는 사이트를 만드는 데만 쓴다. 프롬프트나 미디어 모음으로 따로 내보내거나 배포하지 않는다(원본 LICENSE 2항).

## 갱신과 제거

| 런타임 | 갱신 | 제거 |
|---|---|---|
| Claude Code | `claude plugin marketplace update motionsites` 뒤 `claude plugin update motionsites-web-builder@motionsites` | `claude plugin uninstall motionsites-web-builder@motionsites` |
| Codex | `codex plugin marketplace upgrade motionsites` 뒤 `codex plugin add motionsites-web-builder@motionsites` | `codex plugin remove motionsites-web-builder@motionsites` |
