---
name: tune-tmux
description: "tmux, psmux 설정 파일에 표지 블록을 넣고 빼서, tmux 안에서 Claude Code 나 Codex 를 쓸 때 마우스 드래그 복사와 PageUp/PageDown 스크롤이 동작하게 맞춤. 전체 화면 앱의 키와 마우스는 빼앗지 않음. 첫 원본 백업, `off` 로 블록만 뺌, `--reload` 로 떠 있는 서버에 반영. 'tune-tmux'/'tmux 설정'/'psmux 설정'/'tmux 마우스 복사'/'tmux 드래그 복사'/'tmux PageUp 스크롤' 시 사용."
argument-hint: "[status|on|off] [--target auto|tmux|psmux] [--conf <경로>] [--follow-symlink] [--force-drag] [--reload] [--dry-run] [--json]"
---

# tune-tmux: tmux, psmux 의 드래그 복사와 PageUp/PageDown 스크롤

tmux 설정 파일에 `# banker:tune-tmux:start` .. `# banker:tune-tmux:end` 블록 하나를 넣거나 뺀다.
블록 밖 줄은 건드리지 않는다.
답변은 한글.

| 하위 명령 | 동작 |
|---|---|
| `status`(기본) | 대상 도구와 판, 고른 설정 파일, 블록 상태, 넣을 줄과 빼는 줄의 이유, 상충 경고, 앱별 동작 표 |
| `on` | 블록이 없으면 끝에 덧붙이고, 있으면 블록 내용만 바꿈 |
| `off` | 블록만 뺌. 나머지 바이트는 그대로 |

## 언제 쓰나

- tmux 안의 셸에서 PageUp 으로 기록을 보고 싶을 때
- 마우스로 끌어 고른 글을 OS 클립보드로 바로 복사하고 싶을 때
- tmux 안에서 Claude Code, Codex 를 쓰면서 위 두 가지가 앱 동작과 부딪히지 않게 하고 싶을 때

## 쓰지 않을 때

| 할 일 | 쓸 스킬 |
|---|---|
| tmux, psmux 설치(Rocky8 소스 빌드, Windows psmux) | banker `setup-tmux` |
| Claude Code, Codex 설정 바꾸기(alternate screen 끄기 등) | 이 스킬은 하지 않음. 아래 앱별 표의 안내를 사용자에게 전함 |

- 역할 나눔: `setup-tmux` 는 도구를 설치하고, `tune-tmux` 는 설치된 도구의 설정 파일만 고친다
- tmux, psmux 가 없으면 `on`, `off` 는 종료 3 과 "setup-tmux 로 먼저 설치" 를 낸다

## 자리 표시

| 자리 | 뜻 |
|---|---|
| `<S>` | 이 스킬 디렉터리 절대경로(아래 런타임 표의 "스킬 디렉터리") |

- 셸 변수는 도구 호출 사이에 남지 않는다. 명령마다 실제 경로를 적는다

## 런타임 표

| 항목 | Claude Code | Codex |
|---|---|---|
| 스킬 디렉터리 | 스킬 맨 위 "Base directory for this skill:" 경로 | Codex 스킬 목록이 보이는 이 SKILL.md 경로(file)의 폴더. npm 설치는 `~/.codex/skills/banker-tune-tmux/`(프로젝트 범위 설치면 `./.codex/skills/banker-tune-tmux/`), 플러그인 설치(`codex plugin add`)는 `~/.codex/plugins/cache/<마켓플레이스>/banker/<판>/skills/tune-tmux/`. 절대경로로 씀 |
| `status` | 바로 실행 | 바로 실행(읽기와 사설 tmux 서버 하나) |
| `on`, `off` | 바로 실행 | 설정 파일(`~/.tmux.conf` 등)이 작업 폴더 밖이라 명령에 `sandbox_permissions: "require_escalated"` 로 승인 요청. `--add-dir` 로 설정 폴더를 넓히지 않음 |
| `--reload` | 바로 실행 | tmux 서버 소켓(`/tmp/tmux-<uid>/`)이 작업 폴더 밖이라 같은 승인 요청 |

## 실행

1. 인자 확인
   - 하위 명령은 `status`, `on`, `off`. 그 밖은 실행하지 않고 사용법 안내
   - 사용자 입력을 셸 명령에 그대로 붙이지 않음
2. 상태 먼저 보기

   ```bash
   node "<S>/scripts/tune-tmux.mjs" status
   ```

3. 넣기와 빼기

   ```bash
   node "<S>/scripts/tune-tmux.mjs" on [--reload] [--force-drag]
   node "<S>/scripts/tune-tmux.mjs" off [--reload]
   ```

   - 계획만 보려면 `--dry-run`. 기계가 읽을 출력은 `--json`(JSON 한 줄)
   - `--force-drag` 는 사용자가 맞바꿈(아래 절)을 듣고 고를 때만 붙임
4. 결과 처리
   - `결과:` 줄, `넣지 않은 줄:` 의 이유, `경고:` 줄을 그대로 전함
   - psmux 의 `넣은 줄 0: psmux 기본값 유지. 미확인 n, 안 됨 n` 줄과 그 아래 세 목록(되는 것, 확인 못 한 것, 안 되는 것)을 그대로 전함. 종료 0 을 "원하는 동작이 다 됨" 으로 보고하지 않음
   - `status` 의 앱별 동작 표를 사용자에게 보이고, 쓰는 앱(Claude Code, Codex)의 행을 짚어 줌
5. 종료 코드

   | 코드 | 뜻 | 처리 |
   |---|---|---|
   | 0 | 완료. 바뀐 것 없음 포함. psmux 에 넣을 줄이 없는 경우 포함(파일 처리 성공일 뿐, 미확인과 안 되는 동작이 남음) | 결과 보고. psmux 는 미확인, 안 됨 수와 목록도 |
   | 1 | 거부(링크, 하드 링크, 소유자, 표지 손상, UTF-8 아님, 특수 파일), 쓰기 실패, `--reload` 반영 실패. 거부는 아무것도 바꾸지 않음 | 메시지 그대로 전하고 아래 "문제 해결" |
   | 2 | 사용 오류 | 인자를 고쳐 다시 실행 |
   | 3 | `on`, `off` 인데 tmux, psmux 둘 다 없음 | banker `setup-tmux` 안내. `status` 는 이때 종료 0 과 "미설치" |

   - 출력이 비어 있으면 실행 실패. 성공으로 보고하지 않음

## 인자

| 인자 | 뜻 | 기본 |
|---|---|---|
| `--target auto\|tmux\|psmux` | `auto` 는 Windows 에서 psmux(없고 tmux 가 있으면 tmux), 그 밖은 tmux. `tmux -V` 둘째 줄이 psmux 면 psmux 로 처리 | `auto` |
| `--conf <경로>` | 블록을 넣을 파일. tmux 가 스스로 읽지 않는 파일이면 경고 | 아래 고르기 규칙 |
| `--follow-symlink` | 설정 파일이 링크(dotfiles)일 때 가리키는 파일에 씀. 링크는 링크로 남음 | 꺼짐(링크면 종료 1) |
| `--force-drag` | 앱이 마우스를 잡아도 드래그를 tmux copy-mode 선택으로 바꿈 | 꺼짐 |
| `--reload` | 떠 있는 서버에 반영 | 꺼짐 |
| `--socket <이름>` | 기본 서버 대신 `tmux -L <이름>` 서버에 반영(시험과 사설 서버용) | 없음 |
| `--dry-run`, `--json` | 계획만, JSON 한 줄 | 꺼짐 |

## 블록 내용(tmux)

| 줄 | 효과 | 조건 |
|---|---|---|
| `set -g mouse on` | 마우스 사용 | 늘 |
| `set -s set-clipboard on` | OSC 52 로 터미널 클립보드에도 씀 | 늘 |
| `set -s copy-command '<클립보드 명령>'` | copy-mode 의 기본 `MouseDragEnd1Pane`(복사 후 끝냄)이 OS 클립보드로 보냄 | tmux 3.2 이상, 클립보드 도구 있음 |
| `bind -T copy-mode`(와 `copy-mode-vi`) `MouseDragEnd1Pane send -X copy-pipe-and-cancel '<클립보드 명령>'` | 같은 효과 | tmux 2.4 이상 3.2 미만, 클립보드 도구 있음 |
| `bind -n PPage if -F "#{\|\|:#{alternate_on},#{pane_in_mode}}" "send-keys PPage" "copy-mode -eu"` | 일반 화면에서 PageUp 은 copy-mode 진입과 한 쪽 위로. alternate screen 이나 모드 중이면 키를 그대로 넘김 | 사설 서버에서 `#{\|\|:0,1}#{\|\|:0,0}` 가 `10` 일 때 |
| `bind -n MouseDrag1Pane if -F "#{pane_in_mode}" "send-keys -M" "copy-mode -M"` | 앱이 마우스를 잡아도 tmux 선택 | `--force-drag` 일 때만 |

- 루트 `MouseDrag1Pane` 기본(앱이 마우스를 잡으면 앱으로, 아니면 copy-mode 선택)은 바꾸지 않는다
- PageDown 은 바인딩하지 않는다. copy-mode 안에서는 copy-mode 표가 받고(바닥에 닿으면 `-e` 로 빠짐), 밖에서는 앱이 받는다
- 클립보드 명령 고르기: macOS `pbcopy`, Wayland(`WAYLAND_DISPLAY`) `wl-copy`, X11(`DISPLAY`) `xclip -selection clipboard -in` 다음 `xsel -ib`, WSL `clip.exe`. 하나도 없으면 클립보드 줄을 넣지 않고 OSC 52 만 쓴다. 이때 터미널이 OSC 52 를 허용해야 한다
- 조건식 탐지는 `tmux -L banker-tune-<난수> -f /dev/null` 사설 서버를 띄워 묻고 바로 끈다. 사용자 서버는 건드리지 않는다

## 설정 파일 고르기

| 대상 | 순서 | 실측 |
|---|---|---|
| tmux 3.1 이상 | `--conf` > `~/.tmux.conf`(있으면) > `$XDG_CONFIG_HOME/tmux/tmux.conf` > `~/.config/tmux/tmux.conf`. 셋 다 없으면 `~/.tmux.conf` 를 새로 만듦 | tmux 3.6a 는 있는 파일을 모두 읽음(사용자 옵션 `@banker_a`, `@banker_b`, `@banker_c` 를 각 파일에 두고 `show -gv` 로 확인) |
| tmux 3.1 미만 | `--conf` > `~/.tmux.conf` | tmux 2.7 은 `~/.tmux.conf` 만 읽음(같은 방법) |
| psmux | `--conf` > `PSMUX_CONFIG_FILE` > `~/.psmux.conf`, `~/.psmuxrc`, `~/.tmux.conf`, `~/.config/psmux/psmux.conf` 중 먼저 있는 것. 없으면 `~/.psmux.conf` | psmux 3.3.8 은 처음 찾은 파일 하나만 읽음(`-f` 가 가장 앞) |

- 상충 점검: tmux 가 함께 읽는 다른 파일에 `mouse off`, `set-clipboard off`, 루트 `PPage` 바인딩이 있으면 `status`, `on` 이 파일과 줄 번호로 경고한다. tmux 2.7 처럼 그 파일을 읽지 않는 판에서는 경고하지 않는다

## 앱별 동작(tmux, 블록을 넣은 뒤)

| 앱 상태 | PageUp/PageDown | 드래그 | 출처 |
|---|---|---|---|
| 일반 화면(셸, Codex `--no-alt-screen` 이나 `/tui` 의 Scrollback, Claude Code 옛 렌더러) | PageUp 은 tmux copy-mode 진입과 한 쪽 위로. copy-mode 안 PageDown 은 아래로, 바닥에 닿으면 copy-mode 를 빠짐 | copy-mode 선택. 놓으면 OS 클립보드(도구가 없으면 OSC 52) | 이 스킬의 통합 시험(tmux 3.6a, 2.7) |
| Claude Code 전체 화면(alternate screen, 앱이 마우스를 잡음) | 둘 다 앱이 받음(반 화면 스크롤). "Keyboard scrolling with PgUp and PgDn works either way". 휠은 tmux `mouse on` 이 필요 | 앱 안 선택. 놓으면 클립보드와 tmux paste buffer. 앱 밖 선택은 Shift 드래그(Terminal.app 은 Fn, iTerm2 는 Option). 마우스를 끄려면 `CLAUDE_CODE_DISABLE_MOUSE=1` | https://code.claude.com/docs/en/fullscreen |
| Codex Fullscreen(기본, alternate screen) | 둘 다 앱이 받음(휠, PgUp/PgDn, Ctrl+Home/End 로 Codex 기록 스크롤) | Codex 가 선택하고 바로 복사(`[tui] copy_on_select` 기본 `auto`) | https://github.com/openai/codex/discussions/49129 |

- Codex 한계: Fullscreen 에서는 기록이 Codex 안에 있고 tmux 는 현재 화면만 본다. tmux copy-mode 로 Codex 기록을 스크롤하는 것은 tmux 설정으로 고칠 수 없다
  - 공식 우회: `/tui` 에서 Scrollback 을 고른 뒤 재시작, `codex --no-alt-screen`, 설정 `tui.alternate_screen = "never"`, 복사용 `tui.raw_output_mode`(`/raw`, `alt-r`)
  - `--no-alt-screen` 이어도 전체 다시 그리기 때문에 스크롤백이 덜 쌓인다는 보고가 있다(Zellij, tmux 미확인)
  - 이 스킬은 Codex 설정을 바꾸지 않는다. 우회는 사용자에게 안내만 한다
- Claude Code 의 옛 렌더러(`CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` 이나 `/tui default`)에서는 일반 화면 행대로 tmux copy-mode 를 쓴다
- tmux 의 검색과 copy-mode 는 Claude Code 전체 화면의 대화를 못 본다. Claude Code 의 `Ctrl+o` 뒤 `[` 가 대화를 네이티브 스크롤백에 쓴다

## psmux(Windows)

psmux 3.3.8 실측(Windows 10 22H2 박스, 2026-11-01) 결과 블록에 넣을 줄이 없다.
psmux 기본값으로 모든 요구가 채워지는 것은 아니다. 되는 것, 확인 못 한 것, 안 되는 것이 나뉜다.
`on` 은 종료 0 과 `넣은 줄 0: psmux 기본값 유지. 미확인 2, 안 됨 3` 줄, 그 아래 세 목록을 낸다(`--json` 은 `note` 와 `psmux`).
그 설정 파일에 옛 tune-tmux 블록이 있으면 `off` 처럼 블록만 뺀다(`넣을 줄이 0개라 옛 tune-tmux 블록을 뺌` 줄). 없으면 파일을 바꾸지 않는다.
판단 근거는 `scripts/psmux-caps.json` 의 표다. `verified: true` 이고 psmux 기본값이 아닌 줄만 넣는다. 세 목록은 같은 파일의 `behavior` 다.

| 구분 | 내용 |
|---|---|
| 기본값으로 되는 것 | 마우스(`mouse on`) |
| 기본값으로 되는 것 | `set-clipboard on` |
| 기본값으로 되는 것 | 휠로 copy-mode 진입(`scroll-enter-copy-mode on`) |
| 확인 못 한 것 | 드래그한 글이 Windows 클립보드로 가는지 |
| 확인 못 한 것 | 전체 화면 앱 안의 PageUp/PageDown 을 앱이 받는지 |
| 안 되는 것 | 앱 밖 PageUp 은 prefix 뒤에만 copy-mode 진입 |
| 안 되는 것 | PageDown 이 바닥에서 copy-mode 를 빠지지 않음 |
| 안 되는 것 | `#{alternate_on}` 이 늘 0 이라 전체 화면 앱을 구분하지 못함 |

| 사용자 요구 | psmux 기본값으로 되는 것 | 안 되거나 미확인 |
|---|---|---|
| 드래그 복사 | `mouse on`, `mouse-selection on`, `set-clipboard on` 이 기본이라 내장 선택이 동작 | 고른 글이 OS 클립보드로 가는지는 실제 마우스와 데스크톱이 필요해 미확인 |
| PageUp | prefix 뒤 PageUp 이 copy-mode 진입과 한 쪽 위로(기본 바인딩 `copy-mode -u`) | 루트 PageUp 바인딩은 넣지 않음. Windows 10 에서 `#{alternate_on}` 이 늘 0 이라 넣으면 전체 화면 앱이 PageUp 을 못 받음(실측: 앱 로그가 빔) |
| PageDown | copy-mode 안에서 아래로 스크롤 | 바닥에서 copy-mode 를 빠지지 않음(`-e` 미지원). Escape 로 빠짐 |
| 전체 화면 앱(Claude Code, Codex) | tune-tmux 가 키를 가로채지 않음 | 블록 없이 앱이 PageUp 을 받는지는 미실측. 휠은 psmux 이슈 #597, #598 |

- psmux 함정(실측)
  - 붙인 짧은 플래그를 풀지 못한다. `copy-mode -eu` 는 `-u` 가 사라지므로 `copy-mode -e -u` 처럼 따로 쓴다
  - `copy-pipe-and-cancel` 바인딩과 루트 `MouseDrag1Pane` 바인딩은 경고 없이 버려진다. 그래서 `--force-drag` 줄도 넣지 않는다
  - CLI 의 `bind` 는 따옴표 묶음을 잃는다. 바인딩은 설정 파일로만 넣는다
  - 줄 끝 주석은 3.3.8 에서 값으로 읽히지 않는다

## `--force-drag` 맞바꿈

- 얻는 것: Claude Code 전체 화면이나 Codex 처럼 마우스를 잡는 앱 위에서도 드래그가 늘 tmux 선택이 되어, 놓으면 tmux 의 복사 경로로 간다
- 잃는 것: 앱의 마우스 클릭, 드래그 처리를 tmux 가 빼앗는다. Claude Code 전체 화면의 앱 안 선택과 클릭이 안 된다
- 기본은 꺼짐이다. 사용자가 이 맞바꿈을 듣고 고를 때만 붙인다. 되돌리려면 `--force-drag` 없이 `on --reload`

## `--reload`

- 기본 서버(`tmux ls` 성공)가 떠 있을 때만 반영한다. 없으면 "떠 있는 서버 없음. 다음 시작 때 적용" 으로 종료 0
- 예전 블록에만 있던 줄의 효과를 먼저 되돌린다
  - 옵션은 `set -gu`, `set -su`
  - 키는 설정 없이 띄운 사설 서버의 기본 바인딩을 그대로 다시 넣고, 기본이 없으면 `unbind`
- 그 뒤 설정 파일 전체를 `source-file` 해 블록 밖 사용자 줄을 되살린다. 사용자 파일의 다른 명령도 다시 실행된다
- `off --reload` 뒤 루트 `PPage` 는 비고, 사용자가 둔 `set -g mouse on` 같은 줄은 다시 살아 있다(통합 시험)

## 오프라인

- 네트워크를 쓰지 않는다

## 함정

- tmux 3.1 이상은 `~/.tmux.conf` 와 `~/.config/tmux/tmux.conf` 를 모두 읽는다. 뒤 파일의 `mouse off` 가 블록을 덮을 수 있어 경고한다
- 블록을 손으로 고치면 다음 `on` 이 다시 쓴다. 손으로 쓸 줄은 블록 밖에 둔다
- 표지 줄 하나만 지우거나 문장 안에 표지를 옮기면 거부(종료 1)한다. 짝을 임의로 맞추지 않는다
- `off` 로 블록만 있던 파일(이 스킬이 만든 파일)은 빈 파일로 남는다. 지우지 않는다
- `source-file` 은 지운 바인딩을 되돌리지 않는다. 그래서 `--reload` 가 되돌리기 명령을 먼저 보낸다
- tmux 3.6a 의 `send-keys -K` 는 바인딩 없는 PageDown 을 `k` 로 보냈다(실측). 키 시험은 바깥 서버 창에 키를 보내 실제 터미널 입력 경로로 한다

## 문제 해결

- 아래 표에서 파일을 보인다는 것은 `ls -l` 로 그 이름의 종류와 링크 대상 경로를 보이는 것이다. 링크가 아닌 일반 파일임을 본 뒤에만 내용을 연다

| 메시지 | 조치 |
|---|---|
| 심볼릭 링크라 그대로 둠 | 설정 파일이 링크(dotfiles). 링크와 대상 경로를 보이고, 대상에 쓸지 물은 뒤 `--follow-symlink` 로 다시 실행 |
| 끊어진 링크라 그대로 둠 | 링크가 가리키는 파일이 없음. 링크를 지우거나 바꾸지 않음. 어떻게 할지 물음 |
| 하드 링크가 n개라 그대로 둠 | 같은 파일에 이름이 여럿. 쓰면 링크가 갈라짐. 어느 이름을 쓸지 물음 |
| 다른 사용자 소유라 그대로 둠 | 파일 소유자가 실행 사용자와 다름. 소유자 확인을 안내 |
| 표지 손상이라 그대로 둠 | 표지 줄이 한쪽만 있거나 문장 안에 있거나 블록이 둘 이상. 남은 표지 줄을 보이고 지울지 물은 뒤 다시 실행 |
| UTF-8 이 아니라 그대로 둠 | 인코딩을 보이고 UTF-8 로 바꿀지 물음 |
| 이 tmux 는 #{\|\|:} 조건식을 읽지 못함 | PageUp 줄을 넣지 않은 이유. 새 tmux 는 banker `setup-tmux` |
| 외부 클립보드 도구 없음 | 터미널 설정에서 OSC 52 클립보드 쓰기를 허용하거나 `xclip`, `wl-copy` 등을 설치한 뒤 `on` 다시 실행 |
| 떠 있는 서버 반영 실패 | 파일은 바뀌었음. 메시지의 `source-file` 오류 줄을 보이고 사용자 설정의 해당 줄을 확인 |

## 수동 확인 항목(자동 시험 아님)

- 실제 Claude Code 전체 화면을 tmux 안에서 띄워 드래그와 PageUp/PageDown 이 앱별 표대로인지
- 실제 Codex Fullscreen 을 tmux 안에서 띄워 같은 확인
- psmux 에서 드래그한 글이 Windows 클립보드로 가는지, 블록 없이 전체 화면 앱이 PageUp 을 받는지

## 출처(조사한 것)

| 주제 | 확인한 사실 | 출처 |
|---|---|---|
| Claude Code 전체 화면 | PgUp/PgDn 과 휠을 앱이 처리, 앱 안 선택은 클립보드와 tmux paste buffer, 앱 밖은 Shift 드래그, 끄는 환경 변수 | https://code.claude.com/docs/en/fullscreen |
| Codex Fullscreen | 기본 Fullscreen, 기록은 Codex 안, 선택 즉시 복사, `/tui` 로 Scrollback | https://github.com/openai/codex/discussions/49129, https://github.com/openai/codex/issues/48057 |
| Codex tmux 스크롤 | tmux `Ctrl+B [` 가 스크롤 안 됨, 공식 답은 Scrollback 이나 `--no-alt-screen` | https://community.openai.com/t/umm-looks-like-recent-versions-may-prevent-scrolling-up-for-more-information-in-tmux-session-via-ctrl-b/1402100 |
| Codex 설정 | `tui.alternate_screen = auto \| always \| never`, `tui.raw_output_mode` | https://learn.chatgpt.com/docs/config-file/config-reference |
| Codex `--no-alt-screen` 한계 | Zellij 에서 스크롤백이 거의 안 쌓임 | https://github.com/openai/codex/issues/10331 |
| tmux 관용구와 판 | PageUp `if -F` 관용구, `copy-mode -e` 2.1, `copy-command` 3.2 | https://raw.githubusercontent.com/tmux/tmux/master/CHANGES |
| tmux 기본 바인딩 | 3.6a 루트 `MouseDrag1Pane` 은 `#{\|\|:#{pane_in_mode},#{mouse_any_flag}}` 면 앱으로, copy-mode `MouseDragEnd1Pane` 은 `copy-pipe-and-cancel`. 2.7 은 `copy-selection-and-cancel` | `tmux -f /dev/null` 사설 서버의 `list-keys`(실측) |
| tmux 2.7 조건식 | `#{\|\|:0,1}` 은 `1`, `#{\|\|:0,0}` 은 `0`. 2.7 도 조건식을 읽음 | Rocky 8 의 `/usr/bin/tmux` 2.7 사설 서버(실측) |
| psmux | 설정 파일 순서, 기본값, 플래그와 바인딩 동작, `alternate_on` | psmux 3.3.8 Windows 10 박스 실측, https://github.com/psmux/psmux |
| psmux 이슈 | SGR 마우스가 앱으로 안 감(#597), Codex 휠(#598) | https://github.com/psmux/psmux/issues/597, https://github.com/psmux/psmux/issues/598 |
