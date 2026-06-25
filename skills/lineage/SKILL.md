---
name: lineage
description: "현재 세션 대화를 카카오톡 스타일 단일 HTML 파일로 export(답변=1줄 요약+클릭 펼침) — 'lineage'/'대화 export'/'카톡 스타일 html' 시 사용."
invocation: /lineage
version: 1.0.0
schema_version: 1
---

# lineage — Session Conversation → KakaoTalk HTML

## Purpose

Claude Code 세션의 `.jsonl` 기록을 단일 HTML 1 파일로 변환한다. 외부 자원 0 (인라인 CSS+JS), 사용자 메시지는 카카오 노란 버블 (우측), Claude 답변은 1줄 요약 + `<details>` 토글 펼침 (좌측 흰 버블). Secret 자동 redaction + turn uuid 캐시로 결정론 확보.

## When to Use

- 세션 작업 회고/공유 — Slack/Email/Wiki 에 보낼 채팅 형태 산출물 필요
- 회의 후 작업 흐름 정리 — Claude 답변은 1줄 요약이라 빠르게 훑어볼 수 있음
- 사용자가 "세션을 카카오톡 형태로", "대화를 단일 HTML로", "/lineage" 명시

## Invocation

```bash
/lineage                                # 자동: 가장 최근 jsonl → 읽히는 채팅(권장 동작 기본 적용)
/lineage --last 50                      # 최근 50 turn
/lineage --turns "10-50"                # turn 10..50 (1-indexed)
/lineage --from 2026-05-23 --to 2026-05-24
/lineage --output session-chat.html     # 출력 경로 (실제: session-chat_YYMMDD+HHMM.html)
/lineage --session ~/.claude/projects/-foo/abc.jsonl
echo "..." | /lineage --from-transcript -   # stdin paste
/lineage --redact-extra "acme-corp,acme-token"
/lineage --redact-mode mask              # abcd**** 부분 마스킹
/lineage --unsafe-schema                 # 미지 schema 강제 진행
/lineage --rebuild-summaries             # 캐시 무시하고 재요약
/lineage --purge-cache                   # 캐시 전부 삭제 후 종료
/lineage --skip-reviewer                 # 품질 게이트 끔 (경고)
/lineage --keep-tool-only                # (opt-out) 도구 전용 turn 도 남김 — 원본 동작
/lineage --collapse                      # (opt-out) Claude 버블 접힌 상태로 출력
/lineage --title "My Session"            # 헤더 타이틀 (기본: Session Lineage)
```

### 권장 동작이 기본값 (no flags = 읽히는 채팅)

- **`--hide-tool-only` 기본 ON** — prose 없이 `🔧 도구 N건` 마커만 있는 turn 제거. tool-heavy 세션이 "비어 보이는" 문제를 기본 차단. 원본 보려면 `--keep-tool-only`.
- **`--open` 기본 ON** — Claude 버블을 `<details open>`로 펼쳐 클릭 없이 본문 표시. 접으려면 `--collapse`.
- **`--title` 기본값 `Session Lineage`** (이전 `Claude Code Session`).
- **`LINEAGE_REDACT_EXTRA` 환경변수** — 프로젝트 비밀 키워드를 매번 `--redact-extra`로 치지 않도록 기본 주입(쉼표구분). CLI `--redact-extra`와 병합. 예: `export LINEAGE_REDACT_EXTRA="acme-corp,db-pass"`.

> 즉 대부분의 경우 옵션 없이 `/lineage`만 호출하면 된다. 비밀 키워드만 셸 프로필에 `LINEAGE_REDACT_EXTRA`로 한 번 등록해 두면 추가 옵션이 거의 필요 없다.

## Workflow (5 단계)

### 1. Read jsonl (입력 소스 결정 — 3 단계 fallback)

```
auto-discover (~/.claude/projects/<encoded-cwd>/*.jsonl most-recent mtime)
  → --session FILE 명시
  → --from-transcript - stdin paste
  → 모두 실패 시 exit 2 + 3 옵션 안내
```

Schema-tolerant 파서: 미지 record type 만나면 stderr WARN + 다음 line. `v1`/`v2` 같은 schema marker 발견 시 `--unsafe-schema` 명시 없으면 exit 2.

### 2. Filter + Summarize

필터 규칙:
- `isSidechain=true` 또는 `teamName`/`agentName` 있는 line → skip (sub-agent / worker)
- `type=user` 의 텍스트가 `<system-reminder>`/`<teammate-message>`/`<command-name>` 으로 시작 → skip
- `content.type=tool_result` → skip (raw 출력 노이즈)
- `content.type=tool_use` → 카운트만 누적 (`Bash×3, Read×2` 인디케이터)
- 미지 `content.type` → WARN + skip
- prose(text) 없이 tool_use 만 있는 assistant turn → **기본 제거**(range/last 필터보다 먼저 적용). `--keep-tool-only` 로 남길 수 있음

요약 생성 (한 turn 당 한 줄):
- 캐시 hit (`~/.cache/lineage/<schema_version>/<sid>/<turn_uuid>.txt`) → 그대로
- miss → naive heuristic (첫 문장 또는 80자) + 캐시에 0600 쓰기
- **품질 가이드**: 동사 시작 / 30-120자 / 핵심 수치 / 이모지 1개 허용

### 3. Redact (다층)

1차: `detect-secrets>=1.5` (pip 설치 시). 미설치 → 내장 fallback + stderr WARN.

내장 7-pattern:
- `AKIA[0-9A-Z]{16}`, `ASIA[0-9A-Z]{16}` (AWS IAM key)
- `gh[posru]_[A-Za-z0-9]{36}` (GitHub PAT)
- `xox[bpars]-...` (Slack token)
- `eyJ...\..\..` (JWT)
- `-----BEGIN [A-Z ]+PRIVATE KEY-----...END...` (private key block)
- `(?i)(?:password|암호|비번|패스워드)\s*[:=]\s*['"]...['"]` (한글/영문 평문)

보조: Shannon entropy ≥ 4.5 인 32+ 자리 base64-like 문자열 → `[REDACTED:entropy]`.

확장: `--redact-extra "k1,k2"` 사용자 keyword substring match.

부분 마스킹: `--redact-mode mask` 시 `abcd****wxyz` (8자+ 한정).

### 4. Render

**HTML 템플릿** (lineage.py 내 인라인) — KakaoTalk 톤 CSS 변수:

```css
:root {
  --bg:       #abc1d1;   /* 채팅 배경 (청회색) */
  --me:       #fee500;   /* 사용자 버블 (카카오 노랑) */
  --me-text:  #3c1e1e;
  --bot:      #ffffff;   /* Claude 버블 (흰색) */
  --bot-text: #222222;
  --meta:     #516680;   /* 시간 스탬프 */
  --header:   #3b5e7a;   /* 상단 헤더 */
}
```

4 placeholder 를 `str.replace()` 로 치환:
- `{{TITLE}}` → `--title` 인자 (HTML escape 적용)
- `{{HEADER_TITLE}}` → 동일
- `{{DATE_RANGE}}` → 첫/마지막 turn 의 날짜 범위
- `{{TURNS}}` → user/bot row HTML 결합

사용자 메시지 = 노란 우측 버블 (`<div class="row me">`), Claude 메시지 = 흰 좌측 + `<details><summary>요약</summary><div class="detail">상세</div></details>`. 날짜 변경 시 `<div class="day">━━ YYYY-MM-DD ━━</div>` 삽입.

**출력 파일명 규칙**:
- **기본 (no `--output`)**: `work/lineage-{session-name}.html` — session-name 은 jsonl 의 `customTitle` 레코드에서 추출 (slug 화: 영숫자·한글·`-`·`.`만 유지, 최대 40자). 없으면 session_id 앞 8자.
- **사용자 지정 (`--output PATH`)**: PATH 그대로 사용.
- **타임스탬프 suffix (양쪽 공통)**: basename 끝(확장자 직전) 에 `_YYMMDD+HHMM` 자동 부착. 예시:
  - default + customTitle "init" → `work/lineage-init_260523+1846.html`
  - `--output work/report.html` → `work/report_260523+1846.html`
- 이미 같은 패턴이 붙어있으면(`_\d{6}\+\d{4}$`) 추가 안 함 (idempotent).

### 5. Verify (self-test)

`lineage.py` 의 `self_verify()` 가 출력 HTML 에 대해:
1. `HTMLParser().feed(...)` 예외 없음
2. `<details>` 열림 == 닫힘, `<div>` 열림 == 닫힘
3. `<link rel="stylesheet"` 부재 (외부 자원 0)
4. `<script src=` 부재
5. 알려진 template placeholder (`{{TITLE}}` 등 4개) 미치환 없음

WARN 발견 시 stderr 로 보고, 출력은 그대로 작성 (인간 검토 가능).

## Reviewer Quality Gate (Critic agent 분리 호출)

자동 호출 X — `lineage.py` 가 5 sample JSON 을 출력 (`work/.<output>.reviewer-input.json`), 사용자 또는 후속 turn 에서:

```
Skill("oh-my-claudecode:critic")
```

**Critic 호출 input contract** (JSON array):
```json
[
  {"idx": 0, "original_detail": "원문 text 일부 (≤500자)", "generated_summary": "1줄 요약"},
  ...
]
```

**Critic 출력 contract** (JSON array):
```json
[
  {"idx": 0, "recoverable": true,  "reason": "summary 가 detail 의 동사+산출물을 보존"},
  {"idx": 1, "recoverable": false, "reason": "summary 가 동사로 시작 안 함, 핵심 수치 누락"},
  ...
]
```

**판정**: 5/5 `recoverable=true` → PASS. 미달 → ITERATE (필요 시 `--rebuild-summaries` + Summarization 가이드 재학습).

**Timeout**: 60s. Critic 출력이 JSON parse 실패 → stderr WARN + exit 2 (혹은 `--skip-reviewer` 면 warn 후 진행).

**`--skip-reviewer`**: 빠른 export 가 필요할 때만. quality gate 미통과 명시 (stderr `WARN: quality gate not enforced`).

**`--reviewer-output FILE` (게이트 실효화)**: 이 옵션이 주어지면 lineage.py 가 critic 응답 JSON 파일을 폴링 (`--reviewer-timeout`, 기본 60s) 후 자동 파싱·판정한다.
- PASS (모든 `recoverable=true`) → exit 0 + `[lineage] PASS: quality gate N/N`
- FAIL (1건 이상 `recoverable=false`) → exit 2 + 각 sample 의 reason 출력
- Timeout (파일 부재) → exit 2 + `reviewer-output not found within Ns`
- Parse 실패 (잘못된 JSON) → exit 2 + 파서 에러

이로써 "generator ≠ verifier" 회로 분리가 명목상이 아닌 실제 차단 게이트로 동작한다.

## Cache & Secret Hygiene

**v2 부터 캐시에 저장되는 텍스트는 redact() 적용 후의 redacted summary 만이다.** 캐시 파일 자체에 평문 secret 이 남지 않음 — 0600 권한은 defence-in-depth 이고 redaction 이 primary safeguard. 캐시 schema 가 v1 → v2 로 bump 되었으므로 `~/.cache/lineage/1/` 디렉토리는 자동으로 무효화 (참조 안 됨). 수동 삭제 권장: `--purge-cache` 또는 `rm -rf ~/.cache/lineage/1`.

## Installation

```bash
mkdir -p ~/.claude/skills/lineage
cp /path/to/lineage/SKILL.md   ~/.claude/skills/lineage/
cp /path/to/lineage/lineage.py ~/.claude/skills/lineage/
chmod +x ~/.claude/skills/lineage/lineage.py

# (선택) 강한 redaction
pip install 'detect-secrets>=1.5'

# 호출
/lineage
```

## Tool / Subagent 의존성

- `lineage.py` (Python 3.7+) — script 자체. Claude 호출 없이 결정론 영역 처리.
- `Skill("oh-my-claudecode:critic")` — reviewer 분리 호출 (사용자 또는 후속 turn 트리거).
- `detect-secrets>=1.5` (pip, 선택) — 1차 redaction. 미설치 → 자동 fallback.
- 자동 호출 금지: `lineage.py` 가 다른 OMC 스킬을 직접 invoke 하지 않음 (회로 분리).

## 한계

- jsonl 포맷 변경에 취약 — Claude Code 업데이트 시 schema-tolerant 가 흡수하나, 새 record type 이 본문 데이터를 담으면 누락 가능
- 요약은 heuristic (첫 문장 80자) 으로 시작 — 의미상 더 나은 요약은 사용자가 캐시 파일을 직접 편집하면 다음 호출부터 반영됨
- detect-secrets 가 없으면 internal 한국어 secret 패턴 누락 가능 — `--redact-extra` 로 보완
- 500+ turn 출력은 브라우저 렌더 느림 — `--last N` 권장
- 비 Claude Code 환경 (web claude.ai / Desktop / API) 은 `--from-transcript -` stdin 모드로만 동작

## File Layout

```
~/.claude/skills/lineage/
├── SKILL.md          (이 파일)
└── lineage.py        (실행 본체, Python 3.7+)

~/.cache/lineage/
└── <schema_version>/<session_id>/<turn_uuid>.txt    (0700/0600)
```
