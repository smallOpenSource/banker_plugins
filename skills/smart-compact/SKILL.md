---
name: smart-compact
description: "컨텍스트 사용률이 임계(기본 50%)를 넘으면 `append_wiki` 와 `ready-compact` 를 자동 실행해 마지막 메시지에 resume 프롬프트만 남김. `/copy`, `/compact`, 붙여 넣기는 사용자가 직접 함. 'smart-compact' 로 켜고 `--cancel` 로 끔."
---

# smart-compact — 컨텍스트 위생 자동 게이트

긴 세션에서 컨텍스트가 임계(기본 **50%**)를 넘으면, compaction 전에 상태를 안전하게 보존하는
리추얼을 **자동 발동**한다: `append-wiki` → `ready-compact` → *(유저)* `/copy`
→ `/compact` → paste. `smart-compact` 로 무장, `smart-compact --cancel` 로 해제한다.
`ready-compact` 는 0.14.0 부터 마지막 메시지를 resume 프롬프트만으로 내므로, 예전처럼 `compact-copy` 를 거치지 않는다.

## ⚠️ 정직한 실현 한계 (Claude Code, Codex 실측)
"컨텍스트 50%에서 완전 무인 자동"은 **부분만 가능**하다 — 근거:
- **감지**: Claude Code 는 컨텍스트 사용률을 **statusLine stdin** 의 `context_window.used_percentage` 로만 실시간
  노출한다(hook은 이 값을 못 받음; auto-compact은 ~95%에서만, 50% 이벤트 없음). → statusLine으로
  **정확히 50% 감지 가능**. Codex 는 훅이 받는 세션 기록에서 계산한다(아래 Codex 절).
- **자동 실행 가능(어시스턴트)**: `append-wiki` · `ready-compact` — 스킬/도구
  작업이라 어시스턴트가 수행.
- **자동 불가(TUI 전용)**: `/copy` · `/compact` · **paste** 는 인터랙티브 TUI 동작이라 hook·스킬이
  구동할 수 없다(hook은 슬래시명령 호출 불가, `additionalContext` 주입만 가능). → **이 3단은 유저가
  실행**한다.

따라서 smart-compact의 자동화 천장 = **감지(정확) + 준비 자동 실행 + TUI 3단 유저 핸드오프**.
완전 hands-off를 약속하지 않는다(그건 별도 외부 데몬이 새 세션을 스폰해야 하고, 메인 세션이 idle일
때만·클립보드 보장 없이 취약). smart-compact은 **가장 신뢰 가능한 최대 자동화**를 택한다.

## 메커니즘 (무장 시 설치)
런타임 인식 — Claude Code 는 statusLine 래퍼, Codex 는 세션 기록을 읽는 훅으로 둘 다 임계를 정확히 잰다.

**Claude Code (OMC):**
1. **statusLine 래퍼(compose-safe)**: 기존 `statusLine.command`(예: OMC HUD)를 **보존**하고, 그것을
   호출해 출력을 그대로 통과시킨 뒤, stdin의 `context_window.used_percentage` 를 파싱한다. 임계 이상이면
   신호 파일 `~/.claude/.smart-compact-signal`(uid별; `id -u`)에 timestamp를 쓰고 statusLine에
   `⚠ smart-compact ARMED (NN%)` 를 덧붙인다. **기존 statusLine을 덮어쓰지 말고 감싼다.**
2. **hook 브리지**: `UserPromptSubmit`(또는 `PreToolUse`) hook이 신호 파일을 읽어 무장·미처리 상태면
   `additionalContext` 로 "smart-compact: 컨텍스트 ≥임계 — 위생 체인 실행" 을 주입한다(hook은 명령을
   못 부르므로 어시스턴트에게 **지시만** 한다).
3. **게이트 동작(어시스턴트)**: 주입을 받으면 자동파트를 실행한다. TUI 3단 안내는 `ready-compact` **전에** 한 줄로 하고, 마지막 메시지는 `ready-compact` 의 프롬프트로 끝낸다(안내를 뒤에 붙이면 `/copy` 가 안내문을 복사한다).

**Codex (OMX):**
- Codex 는 훅 입력에 사용률 칸을 주지 않는다. 대신 모든 훅 입력의 `transcript_path`(세션 기록, rollout)에 요청마다
  `token_count` 가 남는다. 마지막 `last_token_usage.total_tokens` 를 `model_context_window` 로 나눈 값이 사용률이다
  (Codex 0.144.5 실측). Codex 화면의 `context-remaining` 과는 몇 %p 다를 수 있다.
- 이 스킬 폴더의 `scripts/codex-gate.mjs` 가 계산과 훅을 맡는다. statusLine 래퍼는 쓰지 않는다(Codex 상태표시줄은
  OMX 가 `config.toml` 의 `[tui]` `status_line` 으로 관리한다). 이 SKILL.md 가 있는 디렉터리의 절대경로로 실행한다.
  ```bash
  node "<이 스킬 디렉터리 절대경로>/scripts/codex-gate.mjs" on --threshold <N>   # 무장(N 은 1~95 정수, 기본 50)
  node "<이 스킬 디렉터리 절대경로>/scripts/codex-gate.mjs" off                   # 해제
  node "<이 스킬 디렉터리 절대경로>/scripts/codex-gate.mjs" status
  node "<이 스킬 디렉터리 절대경로>/scripts/codex-gate.mjs" usage <rollout 경로>  # 수동 확인
  ```
  - 파일은 모두 `$CODEX_HOME`(없으면 `~/.codex`)에 둔다.

    | 파일 | 내용 |
    |---|---|
    | `hooks-custom/banker-smart-compact-gate.mjs` | 훅 사본. 훅은 이 사본을 돌린다 |
    | `hooks.json` | `UserPromptSubmit` 맨 뒤에 훅 묶음 하나 |
    | `smart-compact.json` | 임계값 |
    | `smart-compact-state.json` | 이미 알린 세션 |
    | `hooks.json.smart-compact.bak` | `on`, `off` 가 `hooks.json` 을 바꿀 때마다 그 직전 내용 |

  - 사본을 두는 까닭: Codex 는 신뢰한 훅을 샌드박스 밖에서 돌린다. 스킬 폴더가 작업 폴더 안에 있으면(프로젝트 범위 설치)
    샌드박스 안의 세션이 그 스크립트를 고쳐 샌드박스 밖에서 돌릴 수 있다. 사본은 샌드박스가 쓸 수 없는 곳에 있다.
  - 같은 까닭으로 `on` 은 임시 폴더의 node 를 거부하고, Codex 안에서 실행될 때는 작업 폴더 안의 node 나 스크립트도 거부한다.
    Codex 를 홈 폴더에서 열었으면 거부된다(그 세션은 홈 전체를 쓸 수 있다). Codex 밖 터미널에서 실행한다.
    PowerShell 명령은 작은따옴표(`'` 와 U+2018~U+201B)를 두 번 써서 인용한다.
  - 맨 뒤에 더하는 까닭: Codex 는 훅 신뢰를 묶음 번호와 함께 기록한다. 앞에 끼우면 OMX 훅의 번호가 밀려 다시 신뢰해야 한다.
    임계값을 명령이 아니라 파일에 두는 것도 같은 까닭이다(명령이 바뀌면 다시 신뢰해야 한다).
  - Windows 의 Codex 는 훅 명령을 PowerShell 로 돌린다(Codex 0.160.1 실측). 그래서 명령은 `& '<node>' '<사본>' hook` 꼴이다.
  - Codex 는 신뢰하지 않은 새 훅을 돌리지 않는다. `on` 뒤 Codex 를 다시 열면 "Hooks need review" 창이 뜬다.
    거기서 Review hooks 나 Trust all 을 고르거나, 나중에 `/hooks` 에서 이 훅을 신뢰하라고 사용자에게 알린다.
    "Continue without trusting" 을 고르면 무장되지 않은 것과 같다.
  - 다시 `on` 하면 임계값만 바꾼다. node 경로가 바뀌었거나 banker 를 갱신해 훅 명령이나 사본이 낡았으면, 같은 자리에서 명령과
    사본을 고친다. 그때는 이 훅만 다시 신뢰하면 된다. `status` 가 "이 판과 다름" 이면 `on` 을 다시 실행한다.
  - `off` 는 이 훅 항목과 사본, 설정, 세션 상태만 지운다. 같은 묶음의 다른 훅은 남긴다. 이 묶음 뒤에 다른 묶음이 있었으면
    그 훅들의 번호가 당겨져 다시 신뢰해야 할 수 있다고 알린다.
  - 훅은 사용률이 임계 이상이면 세션마다 한 번 `additionalContext` 로 체인 실행을 지시한다. `/compact` 로 내려갔다가
    다시 넘으면 또 알린다. 오류가 나도 프롬프트를 막지 않는다. 세션 상태 기록에는 잠금이 없어, 두 세션이 같은 순간에
    프롬프트를 보내면 한 세션이 한 번 더 알림을 받을 수 있다.
  - `on`, `off` 는 `~/.codex` 에 쓴다. Codex 의 `workspace-write` 샌드박스가 막으므로 그 명령을 샌드박스 밖 실행으로
    승인을 요청해 돌린다. 승인을 요청할 수 없거나(승인 정책 `never`) 거부되면, 같은 명령을 Codex 입력창에서 `!` 를 붙여 사용자가 직접 실행하게 안내한다(예: `!node "<경로>" on --threshold <N>`). 사용자가 친 `!` 명령은 샌드박스 밖에서 돈다(Codex 0.144.5, `-a never` 에서 실측). `codex exec` 처럼 사람이 없는 실행이면 그 명령을 보고하고 멈춘다.
    `--add-dir ~/.codex` 로 설정 폴더를 통째로 여는 방법은 쓰지 않는다. 그 세션이 훅과 신뢰 기록을
    고칠 수 있게 되어 샌드박스가 무력해진다. `status`, `usage` 는 읽기만 한다.
  - 훅 묶음이 사라졌으면(다른 도구나 손 편집) `status` 가 "훅이 없음" 으로 알린다. `on` 을 다시 실행한다.
  - banker 나 OMX 를 지우기 전에 `off` 를 실행한다. banker 를 지워도 사본과 훅은 남아 계속 돈다. OMX 의 훅 제거는
    뒤에 다른 묶음이 있으면 번호가 밀린다며 멈출 수 있다.
- 훅을 쓸 수 없으면(훅 기능 꺼짐, 신뢰 거부) **휴리스틱 폴백**: 어시스턴트가 스스로 컨텍스트 압박을 감지해 체인을
  제안하고, 유저가 트리거. 이때는 50% 정밀 트리거를 보장하지 않는다고 알린다. 준비 스킬은 banker 것이 양 런타임 동일(아래).

## 게이트 체인
무장 후 임계 초과가 감지되면 순서대로:

1. **`append-wiki`** — 이번 작업의 비자명 지식을 wiki에 적재(휘발 방지). *(banker `append_wiki`, both)*
2. *(한 줄 안내)* 다음 메시지가 resume 프롬프트이며, 그 뒤 `/copy` → `/compact` → 붙여넣기 순서임을 알린다.
3. **`ready-compact`** — 내구 메모리 기록 + resume 프롬프트. 마지막 메시지가 프롬프트뿐이다. *(banker `ready-compact`, both)*
4. *(유저 · TUI)* **`/copy`** → **`/compact`** → **paste**(복사된 resume 프롬프트 입력).

1~3은 어시스턴트가 자동 수행. 4는 유저가 실행한다. 안내는 2에서 끝내고 3 뒤에는 아무것도 붙이지 않는다.
(Claude=`/banker:append_wiki`·`/banker:ready-compact`,
Codex=`$banker-append_wiki`·`$banker-ready-compact`; `/copy`·compaction은 양쪽 TUI 내장.)

## 활성화 (idempotent · compose-safe)
`smart-compact [--threshold N]` (기본 N=50). 아래는 Claude Code 절차이고, Codex 는 위 Codex 절의 `codex-gate.mjs on` 으로 대신한다:
1. `~/.claude/settings.json` 의 기존 `statusLine`·hook 설정을 **읽어 백업**
   (`~/.claude/.smart-compact-prev.json`).
2. statusLine 래퍼 스크립트를 설치하고 `statusLine.command` 를 래퍼로 교체(래퍼가 이전 command를 위임 호출).
3. `UserPromptSubmit` hook 항목을 **추가**(기존 hook 보존, 중복 방지 — 이미 있으면 skip).
4. 임계값을 래퍼에 기록. 무장 완료를 보고.

**멱등·안전 불변식**: 두 번 활성화해도 중복 설치 안 됨. 기존 statusLine/hook을 절대 삭제·덮어쓰지
않고 **감싸거나 추가만** 한다(uid는 `id -u` 로 계산, 하드코딩 금지).

## 해제
`smart-compact --cancel` (Codex 는 `codex-gate.mjs off`):
1. 백업(`~/.claude/.smart-compact-prev.json`)에서 원래 `statusLine`·hook 설정 **복원**.
2. 래퍼 스크립트·신호 파일·백업 제거.
3. 무장 해제를 보고. (백업이 없으면 smart-compact가 추가한 항목만 안전 제거.)

## 함정
- **statusLine 덮어쓰기 금지** — OMC HUD 등 기존 statusLine을 감싸라(복원 가능하게 백업).
- **완전 자동 과대약속 금지** — `/copy`·`/compact`·paste는 TUI 전용, 유저 핸드오프임을 항상 명시.
- **uid 하드코딩 금지** — 신호/경로는 `id -u` 로.
- **hook은 명령을 못 부른다** — `additionalContext` 로 어시스턴트에게 지시할 뿐, 스스로 체인을 실행하지 못함.
- **Codex 훅은 신뢰해야 돈다** — 설치 뒤 "Hooks need review" 창이나 `/hooks` 에서 신뢰하라고 반드시 알린다.
- **Codex 훅 묶음은 맨 뒤에** — 앞에 끼우면 OMX 훅의 신뢰가 풀린다. `hooks.json` 을 손으로 고치지 말고 `codex-gate.mjs` 를 쓴다.

ARGUMENTS: [--threshold N] | --cancel   (없으면 기본 임계 50%로 무장)
