---
name: setup-omc-hud
description: "Claude Code 상태표시줄 omc_hud 래퍼를 스킬에 든 파일로 설치. 내려받지 않고 오프라인에서 모든 OS 같은 명령으로 동작하며, PL 칸에 쓰는 payload-mon 모듈도 켬. Codex 는 OMX 의 `hud` 스킬을 씀. 'setup-omc-hud'/'omc_hud 설치'/'상태표시줄 설치' 또는 `/banker:setup` 시 사용."
argument-hint: "[off|status]"
---

# setup-omc-hud: omc_hud 상태표시줄 설치 (오프라인)

이 스킬 폴더의 `assets/` 에 든 파일로 상태표시줄 래퍼 v4 를 설치한다. 답변은 한글.

- 내려받는 것이 없다. 네트워크가 없어도 끝까지 된다.
- Windows, Linux, macOS 모두 `node` 명령 하나로 같은 절차를 밟는다.
- 설치 파일: `apply-hud.mjs`(설치 스크립트), `omc-hud-custom.mjs`(래퍼 v4), `hud-config.json`(HUD 설정), `LICENSE-omc_hud`(원본 omc_hud 의 MIT 라이선스)

**런타임:** Claude Code 상태표시줄(`<설정 폴더>/settings.json` 의 `statusLine`)이 대상이다. Codex 런타임에서는 oh-my-codex(OMX)가 자체 `hud` 스킬을 주므로 이 스킬 대신 OMX 의 `hud` 를 쓴다.

**인자가 `off` 또는 `status` 일 때:** 0~3단계를 건너뛰고 "인자 off, status" 절만 실행한다.

## 표시 형식

```
<model>/<effort>|5h:<pct>/<reset>|wk:<pct>/<reset>|<mm>:<pct>/<reset>|think|PL:<mb>M|se:<hours>h|ctx:<pct>%|🤖<agents>|🔧<tools>|⚡<skills>|<cwd>|<account>|<branch>|claude<cur>→<new>
<에이전트 목록, 경고 같은 상세 줄>
```

| 변수 | 뜻 | 예 | 나오는 조건 |
|---|---|---|---|
| `<model>` | 모델 이름 앞 2글자와 버전 | `Op5.5` | 항상 |
| `<effort>` | 추론 강도 | `high` | Claude Code 가 넘기거나 OMC 가 effort 칸을 낼 때 |
| `<pct>`, `<reset>` | 사용률과 초기화까지 남은 시간 | `96%`, `1h5m` | 사용량 정보가 있을 때 |
| `<mm>` | 모델별 사용량의 모델 이름 앞 2글자 | `Fa` | OMC 가 모델별 사용량을 낼 때 |
| `think` | 확장 사고 표시 | `think` | 확장 사고가 켜져 있을 때 |
| `<mb>` | 요청 크기 추정치(MB, 소수 1자리) | `0.5` | payload-mon 모듈이 있을 때 |
| `<hours>` | 세션 시간(시간, 소수 1자리) | `0.7` | 항상 |
| `ctx:<pct>%` | 대화 맥락 사용률 | `ctx:12%` | OMC 가 ctx 를 낼 때 |
| `<agents>` | 이 세션의 에이전트 호출 수 | `1` | 1 이상일 때 |
| `<tools>` | 도구 호출 수 | `14` | 1 이상일 때 |
| `<skills>` | 스킬 호출 수 | `3` | 1 이상일 때 |
| `<cwd>` | 작업 폴더 | `/home/user/project` | 항상 |
| `<account>` | 로그인 계정 이메일의 `@` 앞부분 | `user` | `.claude.json` 에 이메일이 있을 때 |
| `<branch>` | git 브랜치 | `main` | git 저장소 안일 때 |
| `<cur>`, `<new>` | 지금 Claude Code 판과 새 판 | `2.1.300`, `2.1.302` | 새 판이 있을 때. 지금 판을 모르면 `claude→<new>` |

- 조건이 맞지 않는 칸은 구분자 `|` 와 함께 빠진다.
- 색
  - `%` 는 70% 미만 초록, 85% 미만 노랑, 그 이상 분홍(256색 213)
  - `<mb>` 는 32MB 대비 같은 기준
- OMC 는 ctx 가 80% 를 넘으면 뒤에 `COMPRESS?`, `CRITICAL` 을 붙인다. 래퍼는 이 글자를 빼고 색으로만 보인다.
- ralph, autopilot, `agents:<n>`(실행 중인 에이전트) 같은 OMC 상태 칸은 활성일 때만 `⚡<skills>` 와 `<cwd>` 사이에 흐리게 나온다.
- 화면 폭을 넘으면 칸 사이에서 다음 줄로 넘어간다.
- 둘째 줄부터는 OMC 의 상세 줄(에이전트 목록, todo, 경고)이다. OMC 와 Claude Code 의 갱신 안내 줄은 뺀다.
- 첨부 HUD 설정은 OMC 출력을 8줄까지 둔다. 넘으면 OMC 가 상세 줄을 `... (+N lines)` 한 줄로 접는다.

## 0. 감지

- `node -v` 로 Node 18 이상인지 본다. OMC 5.7.4 는 Node 20 이상을 적는다.
- 설정 폴더는 `$CLAUDE_CONFIG_DIR`, 없으면 `~/.claude` 다.
- OMC 가 설치돼 있어야 한다. 없으면 1단계가 멈추고 알린다.

## 1. 적용

모든 OS 에서 같은 명령이다.

bash, zsh:
```bash
node "<이 스킬 디렉터리 절대경로>/assets/apply-hud.mjs"
```

PowerShell:
```powershell
node "<이 스킬 디렉터리 절대경로>\assets\apply-hud.mjs"
```

- `[ok] statusLine -> node "<설정 폴더>/hud/omc-hud-custom.mjs"` 줄을 확인한다.
- 기존 statusLine 이 다른 명령이었으면 `[..] statusLine ran ...` 줄이 나온다. 보고에 그대로 넣는다.
- 종료 코드 1 이면 출력의 `[x]` 줄을 그대로 보고하고 멈춘다. 이때 바뀐 파일은 없다.
  - `settings.json` 이 JSON 문법에 맞지 않거나(주석, 끝 쉼표 포함) 객체가 아니면 사용자가 고친 뒤 다시 실행한다. 빈 파일은 Claude Code 처럼 `{}` 로 읽는다.
  - OMC 가 없으면 OMC 를 먼저 설치한다(`setup-omc` 스킬). 이 스킬은 OMC 를 설치하지 않는다.
  - 설정 폴더 경로에 셸이 해석하는 글자가 있으면 그 글자가 없는 폴더를 쓰게 안내한다.
  - 쓸 수 없는 파일이나 폴더가 있으면 권한을 고친 뒤 다시 실행한다.
- 종료 코드 2 면 예기치 못한 오류로 중간에 멈춘 것이다. 출력을 그대로 보고하고, 바뀐 파일의 이전 판은 `<파일>.backup.<시각>` 에 있다고 알린다.

## 2. payload-mon 켜기

이전 상태와 상관없이 늘 실행한다.

```bash
node "<이 스킬 디렉터리 절대경로>/../payload-mon/scripts/payload-mon.mjs" on
```

- Codex 사본에서 실행할 때 경로는 `<이 스킬 디렉터리 절대경로>/../banker-payload-mon/scripts/payload-mon.mjs` 다.
- 이유: `PL:` 칸은 payload-mon 이 래퍼 옆(`hud/payload-mon/`)에 두는 크기 계산 모듈을 쓴다. 모듈이 없으면 `PL:` 이 나오지 않는다.
- 출력 `켰습니다. 다음 statusline 갱신부터 PL 칸에 요청 크기가 늘 표시됩니다.` 를 확인한다. `이미 켜져 있습니다`, `모듈 사본을 이 버전으로 맞췄습니다` 도 정상이다.

## 3. 보고

- 1단계 출력의 statusLine 줄과 백업 경로
- 2단계 결과
- statusLine 이 바뀌었으면 Claude Code 재시작 안내

## 인자 off, status

옛 래퍼(v3)에 넣었던 Claude 갱신 안내 블록(`claude-update-last`)을 다룬다. v4 래퍼는 갱신 안내를 직접 줄 맨 끝에 두므로 새 설치에는 이 블록이 필요 없다.

```bash
node "<이 스킬 디렉터리 절대경로>/scripts/claude-update-last.mjs" off
```

- `off` 는 블록을 뺀다. `status` 는 상태만 본다.
- 출력을 그대로 보고한다. 종료 코드 1(거부)이면 래퍼는 바뀌지 않았으니 이유만 보고한다.
- 종료 코드 2(예기치 못한 오류로 중간에 멈춤)면 `status` 결과를 함께 보고한다.

## 함정

- 다시 설치하면 래퍼와 `hud-config.json` 을 첨부 파일로 덮어쓴다. 손으로 고친 내용은 `.backup.<시각>` 에만 남는다.
- payload-mon, claude-update-last 블록만 다른 래퍼와 바뀌는 내용이 없는 `settings.json` 은 백업하지 않는다.
- `settings.json` 의 `omcHud` 값은 `hud-config.json` 의 같은 키를 덮어쓴다. 래퍼가 기대는 아래 키를 바꾸면 칸이 달라지거나 OMC 원문이 그대로 나온다.
  - `omcLabel`, `useBars`
  - `maxWidth`, `maxOutputLines`
  - `showCallCounts`, `callCountsFormat`
  - `contextBar`, `gitBranch`
- `payload-mon off` 를 실행하면 크기 계산 모듈이 지워져 `PL:` 칸도 사라진다. 다시 보려면 `payload-mon on`.
- v4 에서 payload-mon 블록은 모듈을 깔기 위해서만 남는다. 갱신마다 크기 추정이 두 번 돌지만 두 번째는 캐시를 쓴다.
- 래퍼를 손으로 고칠 때 `if (f.ctx) colored.push(colorCtx(f.ctx));` 줄을 지우지 않는다. 실행상 비어 있지만 `payload-mon on` 이 이 줄 바로 뒤에 블록을 넣는다.
- 래퍼는 statusLine 프로세스가 받은 터미널 폭(stderr, stdout 의 `columns`, 그다음 `COLUMNS`)으로 줄을 접는다. 폭을 받지 못하면 한 줄로 나오고 Claude Code 가 끝을 자른다.
- Claude Code 는 자기 화면이 터미널이면 그 폭과 높이를 `COLUMNS`, `LINES` 로 넘긴다(2.1.303 에서 확인). 그래서 보통은 접힌다.
- 분홍은 256색 코드다. 256색을 못 쓰는 터미널에서는 기본 색으로 보인다.
- statusLine 은 PATH 의 `node` 를 쓴다. GUI 로 띄운 Claude Code(macOS Dock, VS Code 확장)는 PATH 에 `/opt/homebrew/bin` 같은 폴더가 빠질 수 있다(추정). 상태표시줄이 안 나오면 PATH 를 확인한다.
- 설정 폴더 경로에 `"`, 백틱, `$`, `%`, `\`, 줄바꿈이 있으면 설치 스크립트가 거부한다. statusLine 명령의 큰따옴표 안에서도 셸이 이 글자를 해석해, 명령이 깨지거나 경로 속 명령이 실행되기 때문이다.
- 기존 statusLine 의 다른 필드(`padding`, `refreshInterval` 등)는 그대로 둔다. 다른 래퍼(smart-compact 등)가 감싼 명령은 이 래퍼의 명령으로 바뀐다. 이전 값은 `settings.json` 백업에 있다.
- 갱신 안내는 OMC 의 문구 `[Claude#<cur>] -> <new> claude update` 로 찾는다. OMC 가 문구를 바꾸면 줄이지 못하고 원문이 경로 앞 칸에 남는다. 상태표시줄은 깨지지 않는다.
- `[!] omc <ver> - paste: ` 와 `[!] claude <new> - paste: ` 로 시작하는 갱신 안내 줄은 뺀다. OMC 가 이 문구를 바꾸면 다시 보인다.
- 설치는 네트워크를 쓰지 않는다. 다만 OMC 가 렌더할 때 네트워크로 얻는 정보(새 Claude Code 판 같은)는 오프라인에서 빠질 수 있다.
- 래퍼, HUD 설정, 모듈 사본은 플러그인 밖(`<설정 폴더>/hud/`, `<설정 폴더>/.omc/`)에 있다. 플러그인을 지워도 상태표시줄은 남는다.
- OMC 를 지울 때는 statusLine 도 지운다. OMC 로더는 플러그인을 못 찾으면 작업 폴더의 `node_modules` 에서 OMC HUD 를 찾아 불러오기 때문이다.
