/**
 * app-notes: how PageUp/PageDown and mouse drag behave per app state with the tune-tmux block, for `status`.
 * Same content as the "앱별 동작" tables in SKILL.md (sources there). Text only; nothing is read or written.
 */

const TMUX = [
  {
    state: "일반 화면(셸, Codex `--no-alt-screen` 이나 /tui Scrollback, Claude Code 옛 렌더러)",
    keys: "PageUp 은 tmux copy-mode 진입과 한 쪽 위로. copy-mode 안 PageDown 은 아래로, 바닥에 닿으면 copy-mode 를 빠짐",
    drag: "tmux copy-mode 선택. 놓으면 OS 클립보드(도구가 없으면 OSC 52 로 터미널 클립보드)",
  },
  {
    state: "Claude Code 전체 화면(alternate screen, 앱이 마우스를 잡음)",
    keys: "둘 다 앱이 받음(반 화면 스크롤). tune-tmux 는 가로채지 않음",
    drag: "앱 안 선택. 놓으면 클립보드와 tmux paste buffer. 앱 밖 선택은 Shift 드래그. 늘 tmux 선택을 원하면 `--force-drag`(앱 클릭을 빼앗음)",
  },
  {
    state: "Codex Fullscreen(alternate screen)",
    keys: "둘 다 앱이 받음(Codex 기록 스크롤). tmux copy-mode 로는 Codex 기록을 못 봄(tmux 설정으로 못 고침). tmux 스크롤이 필요하면 /tui 의 Scrollback, `codex --no-alt-screen`, `tui.alternate_screen = \"never\"`",
    drag: "Codex 가 선택하고 바로 복사(`tui.copy_on_select`). 늘 tmux 선택을 원하면 `--force-drag`",
  },
];

const PSMUX = [
  {
    state: "일반 화면(셸)",
    keys: "psmux 기본에는 루트 PageUp 바인딩이 없음. prefix 뒤 PageUp 이 copy-mode 진입과 한 쪽 위로. copy-mode 안 PageUp/PageDown 은 스크롤하지만 바닥에서 빠지지 않음(-e 미지원, Escape 로 빠짐)",
    drag: "psmux 기본(mouse on, mouse-selection on, set-clipboard on)의 내장 선택. OS 클립보드로 가는지는 미확인",
  },
  {
    state: "전체 화면 앱(Claude Code, Codex)",
    keys: "tune-tmux 는 블록을 넣지 않으므로 키를 가로채지 않음. 앱이 받는지는 미실측. Windows 10 에서 #{alternate_on} 이 늘 0 이라 tmux 식 PageUp 바인딩을 넣으면 앱이 PageUp 을 못 받음",
    drag: "앱의 선택 동작을 따름. psmux 3.3.8 은 SGR 마우스가 앱으로 안 가는 이슈(#597)가 열려 있음",
  },
];

/** The rows for target "tmux" or "psmux": { state, keys, drag }. */
export const appRows = (target) => (target === "psmux" ? PSMUX : TMUX);
