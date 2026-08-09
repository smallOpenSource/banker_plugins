---
name: lineage
description: "(banker) 현재 세션(들) 대화를 카카오톡 스타일 단일 HTML로 export. Claude 답변=1줄 요약+클릭 펼침(마크다운 렌더), 하네스 노이즈 자동 필터, 다중 세션 병합. 'lineage'/'대화 export'/'카톡 스타일 html' 시 사용."
invocation: /lineage
version: 2.0.0
schema_version: 1
---

# lineage — Session Conversation → KakaoTalk HTML

## Purpose

Claude Code 세션의 `.jsonl` 기록을 단일 HTML 1 파일로 변환한다. 외부 자원 0 (인라인 CSS+JS).
사용자 메시지는 카카오 노란 버블(우측), Claude 답변은 1줄 요약 + `<details>` 토글 펼침(좌측 흰 버블),
서브에이전트·동료 보고는 별도 회색 버블(좌측).
Claude 본문은 **마크다운으로 렌더**(헤딩·리스트·표·코드·인용·강조·링크)되고, 하네스가 주입한
노이즈(스킬 본문·compaction 요약·조작 명령·에코 교환)는 **기본으로 걸러진다**.
Secret 자동 redaction + turn uuid·요약기버전 캐시로 결정론 확보.

> **🔴 2.0.0 BREAKING — 기본 동작이 바뀌었습니다.**
> - **기본 접힘**: 첫 로드 시 Claude 버블이 접힌 상태. 요약이 곧 목차. 펼치려면 `--open`.
> - **마크다운 렌더 기본 ON**: 원문 그대로 보려면 `--no-markdown`.
> - **하네스 노이즈 필터 기본 ON**: 조작 명령·주입 본문·에코 교환·하네스 오류를 남기려면 `--keep-trivia`.
> 1.x 사용자가 이전 동작을 원하면 `--open --no-markdown --keep-trivia` 를 함께 준다.

## When to Use

- 세션 작업 회고/공유 — Slack/Email/Wiki 에 보낼 채팅 형태 산출물 필요.
- 회의 후 작업 흐름 정리 — Claude 답변은 1줄 요약이라 접힌 채로 빠르게 훑는다.
- 여러 세션에 걸친 작업을 한 줄기로 — `--all-sessions`.
- 사용자가 "세션을 카카오톡 형태로", "대화를 단일 HTML로", "/lineage" 명시.

## Invocation

```bash
/lineage                                # 자동: 최근 jsonl → 접힌 채팅(권장 기본)
/lineage --open                         # 처음부터 전부 펼침 (기본은 접힘)
/lineage --all-sessions                 # 프로젝트 폴더의 모든 세션을 시간순 한 줄기로
/lineage --last 50                      # 최근 50 turn
/lineage --turns "10-50"                # turn 10..50 (1-indexed)
/lineage --from 2026-08-01 --to 2026-08-09
/lineage --output session-chat.html     # 출력 경로 (실제: session-chat_YYMMDD+HHMM.html)
/lineage --session ~/.claude/projects/-foo/abc.jsonl
echo "..." | /lineage --from-transcript -   # stdin paste
/lineage --no-markdown                  # 마크다운 렌더 끄고 원문 표시 (기본 ON)
/lineage --keep-trivia                  # 조작 명령·주입 본문·에코도 남김 (기본 필터 ON)
/lineage --keep-tool-only               # 도구 전용 turn 도 남김 (기본 ON=제거)
/lineage --redact-extra "acme-corp,db-pass"
/lineage --redact-mode mask             # abcd**** 부분 마스킹
/lineage --rebuild-summaries            # 캐시 무시하고 재요약
/lineage --purge-cache                  # 캐시 전부 삭제 후 종료
/lineage --skip-reviewer                # 품질 게이트 끔 (경고)
/lineage --title "My Session"           # 헤더 타이틀 (기본: Session Lineage)
```

### 권장 동작이 기본값 (no flags = 읽히는 채팅)

- **접힘 기본** — 요약 줄이 목차가 된다. 붙여넣은 긴 사용자 메시지(`400자` 초과)도 접힌다.
- **마크다운 기본** — Claude 본문의 표·코드·리스트가 실제로 렌더된다.
- **노이즈 필터 기본** — 스킬 본문·compaction·조작 명령·에코 교환 제거.
- **도구 전용 turn 제거 기본** — prose 없이 도구만 있는 turn 제거(단, 병합 후 `🔧 도구 N건`은 표시).
- **`LINEAGE_REDACT_EXTRA` 환경변수** — 프로젝트 비밀 키워드를 매번 치지 않도록 기본 주입(쉼표구분). CLI `--redact-extra`와 병합.

> 대부분 옵션 없이 `/lineage` 만 호출하면 된다. 비밀 키워드만 셸 프로필에 한 번 등록해 둔다.

## Workflow

### 1. Read jsonl (입력 소스 결정)

```
--all-sessions          → 프로젝트 폴더의 모든 *.jsonl (레코드단위 시간순 병합)
  또는 단일 세션:
auto-discover (~/.claude/projects/<encoded-cwd>/*.jsonl most-recent)
  → --session FILE 명시
  → --from-transcript - stdin paste
  → 모두 실패 시 exit 2 + 옵션 안내
```

경로 인코딩: cwd 의 **모든 비영숫자 문자**(`/` `_` `.` `:` `\` 등)를 `-` 로 바꾼다
(Claude Code 의 실제 project-dir 명명과 일치 — `_` 도 `-` 로). 비-ASCII cwd(한글 등)는
자동탐색이 빗나갈 수 있으니 `--session` 을 쓴다.

Schema-tolerant 파서: 미지 record type → stderr WARN + 다음 line. `v1`/`v2` 같은 schema marker
발견 시 `--unsafe-schema` 명시 없으면 exit 2. UTF-8 디코드 실패 파일은 그 파일만 건너뛴다(전체 실패 X).

### 2. Classify + Merge + Filter (파이프라인 순서 고정)

`parse → classify → merge_assistant_runs → drop_echo_exchanges → hide-tool-only → range/last`

**레코드 분류** — 위치가 아니라 **형태**로 판정(사용자 정정·인용 질문을 지우지 않기 위해):
- 래퍼 블록(`<system-reminder>` 등) → 항상 제거. 남은 게 있으면 태그를 **인용한 진짜 메시지**로 보존.
- Stop hook feedback / `[Request interrupted` → 항상 폐기(`--keep-trivia` 로도 안 살림).
- 스킬 본문(`Base directory for this skill:`) / 워크플로 본문 / 하네스 오류 → 폐기(`--keep-trivia` 시 보존).
- 이미지 노트(`[Image: original …]`) → `🖼 이미지 첨부` 로 치환(첨부 사실 보존).
- compaction 요약 → 구분선(pill)으로 표시.
- `<agent-message>`/`<teammate-message>` → **회색 에이전트 버블**(발신자명 표시, idle JSON은 폐기).
- 조작 명령(`/copy` 등 이름 기반; 플러그인 명령 `ns:name` 은 항상 보존) → 폐기(`--keep-trivia` 시 보존).
- 에코 교환(짧은 질문 + 도구 없는 토큰 답변) → 구조로 폐기(`--keep-trivia` 시 보존).

**턴 병합**: Claude 한 응답이 본문+tool_use 레코드로 쪼개져 기록되므로, `--hide-tool-only` **전에**
연속 assistant 레코드를 병합(도구 합산·첫 레코드 타임스탬프). 그래야 `🔧 도구 N건`이 표시된다.

### 3. Summarize (한 turn 당 한 줄)

- 캐시 hit(`~/.cache/lineage/<schema>/<sid>/<uuid>-<digest>.txt`) → 그대로. digest 는 본문+요약기버전
  해시라 **요약기를 고치면 자동 무효화**된다.
- miss → head+tail 추출(도입이 순수 의도문이면 결론절을 끝에서 읽어 승격) + 0600 캐시 쓰기.
- 요약 저장은 항상 **redact 적용 후**(평문 secret 이 디스크에 남지 않음).

### 4. Redact (다층)

1차 `detect-secrets>=1.5`(pip 설치 시), 미설치 → 내장 fallback + WARN.
내장: AWS IAM(AKIA/ASIA)·GitHub PAT·Slack·JWT·private key·한/영 평문 password·Shannon entropy≥4.5.
확장 `--redact-extra "k1,k2"`. 부분 마스킹 `--redact-mode mask`.

### 5. Render

- 사용자=노란 우측 버블(400자 초과면 접힘), Claude=흰 좌측(요약+`<details>` 상세), 에이전트=회색 좌측.
- Claude/에이전트/긴 사용자 상세는 **마크다운 렌더**(외부 라이브러리 0): 헤딩·불릿·번호·표·코드펜스·
  인용·굵게·기울임·취소선·인라인코드·링크(`https?://` 만). `html.escape` **후에만** 변환하므로 어떤
  입력도 마크업을 주입할 수 없다. (중첩 리스트는 평탄화, 각주 미지원.)
- 날짜/세션전환/compaction 은 **형태가 다른 알약**으로 구분. 헤더 우측은 스크롤에 따라 현재 날짜/세션 갱신.
- 단축키: `A` 전체펼침 · `Z` 전체접기 · `J/K` 다음/이전 내 메시지 · `T/B` 맨위/맨아래 · `?` 도움말 · `Esc` 닫기.
  (Ctrl/Cmd/Alt·한글 IME 안전 — `e.code` 우선이라 브라우저 기본 동작을 가로채지 않음.)
- 우하단 `?` 버튼으로 범례/단축키 오버레이(배경 클릭으로만 닫힘).

**출력 파일명**: 기본 `work/lineage-{session-name}.html`(`customTitle` 슬러그, 없으면 sid 앞 8자;
`--all-sessions` 는 `all-sessions`). basename 끝에 `_YYMMDD+HHMM` 자동 부착(이미 있으면 그대로 — idempotent).

### 6. Verify (self-test)

`self_verify()` 가 출력 HTML 에 대해:
1. `HTMLParser().feed()` 예외 없음.
2. 나열된 모든 태그(details/div/p/ul/ol/li/table/… /strong/em/del/a/summary/h3-6) 열림==닫힘.
3. **HTMLParser 스택으로 오배치 검출**(void 요소 14종 제외) — `<strong>a<em>b</strong>c</em>` 같은
   개수는 맞지만 어긋난 마크업을 잡는다(브라우저가 조용히 복구해 증상을 감추므로 소스에서 검증).
4. 실제 태그 속성에 이벤트 핸들러(`on*`) 없음 · 외부 stylesheet/script 없음 · placeholder 미치환 없음.

WARN 발견 시 stderr 보고, 출력은 그대로 작성(인간 검토 가능).

## Reviewer Quality Gate (Critic agent 분리 호출)

자동 호출 X — `lineage.py` 가 5 sample JSON(`work/.<output>.reviewer-input.json`)을 출력.
새 요약기(head+tail)를 쓰되 입출력 계약은 그대로:

**Critic input** (JSON array): `[{"idx":0,"original_detail":"…","generated_summary":"…"}, …]`
**Critic output** (JSON array): `[{"idx":0,"recoverable":true,"reason":"…"}, …]`
**판정**: 5/5 `recoverable=true` → PASS. `--reviewer-output FILE` 주면 lineage.py 가 폴링·판정
(`--reviewer-timeout` 기본 60s; FAIL/Timeout/parse실패 → exit 2). `--skip-reviewer` 로 끔.

## Cache & Secret Hygiene

캐시에 저장되는 텍스트는 redact() 적용 후의 redacted summary 만이다(평문 secret 미저장).
캐시키에 요약기 버전이 포함돼 알고리즘 변경 시 자동 무효화. 스키마 bump 시 옛 디렉토리는 참조 안 됨 —
`--purge-cache` 로 정리 권장.

## Testing

`skills/lineage/test_lineage.py`(표준 unittest, 외부 의존 0). 실행:

```bash
python3 -m unittest test_lineage        # (Python 3.7+; EL8 기본 3.6은 python3.11/3.12 사용)
```

`scripts/smoke-test.js` 가 CI에서 인터프리터 ≥3.7 을 탐지해 자동 실행(≥3.7 부재 시 skip).
테스트 파일은 npm 패키지에서 제외된다(`files[]` `!**/test_*.py`).

### 브라우저 수동 체크리스트 (JS/CSS — 자동 검증 밖)

산출 HTML 을 브라우저로 열어 확인:
- 첫 로드 시 접혀 있는가 / `--open` 시 펼쳐지는가.
- `A`/`Z`/`J`/`K`/`T`/`B`/`?`/`Esc` 동작, 한글 IME 켠 상태에서도 죽지 않는가, `Ctrl+A`/`Ctrl+Z` 가로채지 않는가.
- 날짜/세션/compaction 알약이 형태로 구분되고 대비가 충분한가, 헤더 우측이 스크롤에 따라 갱신되는가.
- `?` 오버레이가 배경 클릭으로만 닫히고 포커스가 되돌아오는가, 가로 넘침 없는가.

## Installation

```bash
mkdir -p ~/.claude/skills/lineage
cp /path/to/lineage/SKILL.md   ~/.claude/skills/lineage/
cp /path/to/lineage/lineage.py ~/.claude/skills/lineage/
chmod +x ~/.claude/skills/lineage/lineage.py
pip install 'detect-secrets>=1.5'   # (선택) 강한 redaction
/lineage
```

## Tool / Subagent 의존성

- `lineage.py` (Python 3.7+) — 결정론 본체. Claude 호출 없음.
- `Skill("oh-my-claudecode:critic")` — reviewer 분리 호출(사용자/후속 turn 트리거).
- `detect-secrets>=1.5` (pip, 선택) — 1차 redaction. 미설치 → fallback.
- 자동 호출 금지: `lineage.py` 가 다른 스킬을 직접 invoke 하지 않음(회로 분리).

## 한계

- 자동탐색은 Claude Code 의 `~/.claude/projects/` 레이아웃을 가정 — 다른 런타임/비-ASCII cwd 는
  `--session` / `--from-transcript` 로 쓴다.
- 요약은 추출식(head+tail) — 말미 정리 문장을 결론 대신 고르는 경우가 있다(의미 판단 필요).
- 마크다운의 **중첩 리스트는 평탄화**되고 각주는 미지원.
- 사용자가 질문에 래퍼 블록(`<task-notification>…`)을 **인용**하면 문장은 남고 그 블록만 사라진다.
- 에코/의도문 판정 문턱은 단일 코퍼스 튜닝값 — 과삭제는 stderr 의 유형별 카운트로 가시화된다.
- 500+ turn 출력은 브라우저 렌더가 느릴 수 있음 — `--last N` 권장.

## File Layout

```
~/.claude/skills/lineage/
├── SKILL.md          (이 파일)
├── lineage.py        (실행 본체, Python 3.7+)
└── test_lineage.py   (회귀 테스트, repo 전용 · npm 미포함)

~/.cache/lineage/
└── <schema_version>/<session_id>/<turn_uuid>-<digest>.txt   (0700/0600)
```
