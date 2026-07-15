---
name: smart-compact
description: "(banker) 컨텍스트 임계(기본 50%) 초과 시 append-wiki→ready-compact→compact-copy 자동 실행 + /copy·/compact·paste 유저 핸드오프 게이트. 'smart-compact' 활성화 / '--cancel' 해제."
---

# smart-compact — 컨텍스트 위생 자동 게이트

긴 세션에서 컨텍스트가 임계(기본 **50%**)를 넘으면, compaction 전에 상태를 안전하게 보존하는
리추얼을 **자동 발동**한다: `append-wiki` → `ready-compact` → `compact-copy` → *(유저)* `/copy`
→ `/compact` → paste. `smart-compact` 로 무장, `smart-compact --cancel` 로 해제한다.

## ⚠️ 정직한 실현 한계 (Claude Code 실측)
"컨텍스트 50%에서 완전 무인 자동"은 **부분만 가능**하다 — 근거:
- **감지**: 컨텍스트 사용률은 **statusLine stdin** 의 `context_window.used_percentage` 로만 실시간
  노출된다(hook은 이 값을 못 받음; auto-compact은 ~95%에서만, 50% 이벤트 없음). → statusLine으로
  **정확히 50% 감지 가능**.
- **자동 실행 가능(어시스턴트)**: `append-wiki` · `ready-compact` · `compact-copy` — 스킬/도구
  작업이라 어시스턴트가 수행.
- **자동 불가(TUI 전용)**: `/copy` · `/compact` · **paste** 는 인터랙티브 TUI 동작이라 hook·스킬이
  구동할 수 없다(hook은 슬래시명령 호출 불가, `additionalContext` 주입만 가능). → **이 3단은 유저가
  실행**한다.

따라서 smart-compact의 자동화 천장 = **감지(정확) + 준비 자동 실행 + TUI 3단 유저 핸드오프**.
완전 hands-off를 약속하지 않는다(그건 별도 외부 데몬이 새 세션을 스폰해야 하고, 메인 세션이 idle일
때만·클립보드 보장 없이 취약). smart-compact은 **가장 신뢰 가능한 최대 자동화**를 택한다.

## 메커니즘 (무장 시 설치)
런타임 인식 — Claude Code 경로가 정밀, Codex는 신호 노출이 불확실(아래 참조).

**Claude Code (OMC):**
1. **statusLine 래퍼(compose-safe)**: 기존 `statusLine.command`(예: OMC HUD)를 **보존**하고, 그것을
   호출해 출력을 그대로 통과시킨 뒤, stdin의 `context_window.used_percentage` 를 파싱한다. 임계 이상이면
   신호 파일 `~/.claude/.smart-compact-signal`(uid별; `id -u`)에 timestamp를 쓰고 statusLine에
   `⚠ smart-compact ARMED (NN%)` 를 덧붙인다. **기존 statusLine을 덮어쓰지 말고 감싼다.**
2. **hook 브리지**: `UserPromptSubmit`(또는 `PreToolUse`) hook이 신호 파일을 읽어 무장·미처리 상태면
   `additionalContext` 로 "smart-compact: 컨텍스트 ≥임계 — 위생 체인 실행" 을 주입한다(hook은 명령을
   못 부르므로 어시스턴트에게 **지시만** 한다).
3. **게이트 동작(어시스턴트)**: 주입을 받으면 자동파트 실행 → 이어 유저에게 TUI 3단을 정확한 명령으로 안내.

**Codex (OMX):**
- Codex가 statusline/hook에 컨텍스트%를 노출하는지 **미확인**(문서 부재). 노출되면 위와 동형으로 구성
  (`~/.codex` 경로·OMX hook). 미노출이면 **휴리스틱 폴백**: 어시스턴트가 스스로 컨텍스트 압박을 감지해
  체인을 제안하고, 유저가 트리거. 준비 스킬은 banker 것이 양 런타임 동일(아래).

## 게이트 체인
무장 후 임계 초과가 감지되면 순서대로:

1. **`append-wiki`** — 이번 작업의 비자명 지식을 wiki에 적재(휘발 방지). *(banker `append_wiki`, both)*
2. **`ready-compact`** — resume 프롬프트 + 내구 메모리 기록. *(banker `ready-compact`, both)*
3. **`compact-copy`** — resume 프롬프트-only 로 최종 메시지 셰이핑(response.md). *(banker `compact-copy`, both)*
4. *(유저 · TUI)* **`/copy`** → **`/compact`** → **paste**(복사된 resume 프롬프트 입력).

1~3은 어시스턴트가 자동 수행. 4는 어시스턴트가 **정확한 명령을 제시**하고 유저가 실행한다.
(Claude=`/banker:append_wiki`·`/banker:ready-compact`·`/banker:compact-copy`,
Codex=`$banker-append_wiki`·`$banker-ready-compact`·`$banker-compact-copy`; `/copy`·compaction은 양쪽 TUI 내장.)

## 활성화 (idempotent · compose-safe)
`smart-compact [--threshold N]` (기본 N=50):
1. `~/.claude/settings.json`(Codex는 `~/.codex/`)의 기존 `statusLine`·hook 설정을 **읽어 백업**
   (`~/.claude/.smart-compact-prev.json`).
2. statusLine 래퍼 스크립트를 설치하고 `statusLine.command` 를 래퍼로 교체(래퍼가 이전 command를 위임 호출).
3. `UserPromptSubmit` hook 항목을 **추가**(기존 hook 보존, 중복 방지 — 이미 있으면 skip).
4. 임계값을 래퍼에 기록. 무장 완료를 보고.

**멱등·안전 불변식**: 두 번 활성화해도 중복 설치 안 됨. 기존 statusLine/hook을 절대 삭제·덮어쓰지
않고 **감싸거나 추가만** 한다(uid는 `id -u` 로 계산, 하드코딩 금지).

## 해제
`smart-compact --cancel`:
1. 백업(`~/.claude/.smart-compact-prev.json`)에서 원래 `statusLine`·hook 설정 **복원**.
2. 래퍼 스크립트·신호 파일·백업 제거.
3. 무장 해제를 보고. (백업이 없으면 smart-compact가 추가한 항목만 안전 제거.)

## 함정
- **statusLine 덮어쓰기 금지** — OMC HUD 등 기존 statusLine을 감싸라(복원 가능하게 백업).
- **완전 자동 과대약속 금지** — `/copy`·`/compact`·paste는 TUI 전용, 유저 핸드오프임을 항상 명시.
- **uid 하드코딩 금지** — 신호/경로는 `id -u` 로.
- **hook은 명령을 못 부른다** — `additionalContext` 로 어시스턴트에게 지시할 뿐, 스스로 체인을 실행하지 못함.
- **Codex 신호 미확인** — 노출 안 되면 휴리스틱 폴백으로 정직히 degrade(50% 정밀 트리거 미보장).

ARGUMENTS: [--threshold N] | --cancel   (없으면 기본 임계 50%로 무장)
