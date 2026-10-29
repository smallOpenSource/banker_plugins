# banker-plugins

> Claude Code와 Codex CLI를 위한 QA·감사·문서·아키텍처·위키·미디어 스킬 모음.

[![npm](https://img.shields.io/npm/v/@kaydash9999/banker-plugins)](https://www.npmjs.com/package/@kaydash9999/banker-plugins)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![npm downloads](https://img.shields.io/npm/dm/@kaydash9999/banker-plugins)](https://www.npmjs.com/package/@kaydash9999/banker-plugins) [![GitHub stars](https://img.shields.io/github/stars/smallOpenSource/banker_plugins)](https://github.com/smallOpenSource/banker_plugins)

[빠른 시작](#빠른-시작) · [워크플로 예시](#워크플로-사용-예시) · [구성](#구성) · [설치 상세](#설치-상세-npm--codex) · [설정 변경 지점](#설정-변경-지점-claude-code--codex) · [요구사항](#요구사항) · [업데이트 / 제거](#업데이트--제거) · [업데이트 확인](#업데이트-확인-및-사용량-카운팅) · [오프라인](#오프라인에서-쓰기) · [라이선스 / 서드파티](#라이선스--서드파티)

□ banker는 다음을 포함하는 Claude Code 및 Codex CLI 플러그인입니다.
- QA·보안 감사·문서·아키텍처·위키·미디어 작업과 의존성·개발환경(OS별) 설치를 아우르는 **스킬 65개 + 커맨드 2개**(총 67개 구성요소. Codex 는 Claude Code 전용 `ultraqa` 를 뺀 스킬 64개와 Codex 전용 스킬 3개)
- Claude Code 즉시 명령 `/graceful-pause`, `/progress`

□ 설치하면 스킬과 커맨드가 `/banker:<이름>` 네임스페이스로 노출됩니다.

□ 이 저장소 자체가 Claude Code 마켓플레이스(`.claude-plugin/marketplace.json`)이자,\
플러그인(`.claude-plugin/plugin.json`, name `banker`)이며,\
스킬과 커맨드는 Codex CLI에도 모두 구성됩니다.\
도구 의존성이 있는 스킬은 실행할 때 그 도구가 필요합니다.

> npm 패키지(`@kaydash9999/banker-plugins`)와 GitHub 저장소(`smallOpenSource/banker_plugins`)는 같은 메인테이너가 관리

## 빠른 시작

**Claude Code:** 실행 중인 세션에서 `/plugin` 으로 설치 (권장)

Claude Code 세션 안에서 입력합니다.

```
/plugin marketplace add smallOpenSource/banker_plugins
/plugin install banker@banker-plugins
```

설치 후 `Plugin is now active.` 면 바로 쓸 수 있고, `Run /reload-plugins to activate.` 가 뜨면 `/reload-plugins` 를 실행합니다.\
터미널 셸을 선호하면 `claude plugin marketplace add smallOpenSource/banker_plugins` 후 `claude plugin install banker@banker-plugins` 로도 됩니다(다음 실행 또는 `/reload-plugins` 후 적용).

스킬과 커맨드를 `/banker:audit-security` 처럼 `/banker:` 로 호출합니다.

**Codex CLI:** 두 방법 중 하나를 고릅니다.

1) Codex 플러그인 마켓플레이스로 설치 (권장, npm 불필요)

터미널 셸에서 입력합니다. 첫 줄은 이 GitHub 저장소를 Codex 의 플러그인 마켓플레이스 `banker-plugins` 로 등록하고, 둘째 줄은 그 마켓플레이스에서 banker 플러그인을 설치합니다.

```bash
codex plugin marketplace add smallOpenSource/banker_plugins
codex plugin add banker@banker-plugins
```

스킬을 `$banker:audit-security` 처럼 `$banker:<name>` 으로 호출합니다.\
훅(업데이트 알림, 사용량 카운팅)은 Codex 를 다시 열 때 뜨는 Hooks need review 창이나 `/hooks` 에서 신뢰해야 돕니다.\
Codex 는 세션을 시작할 때 마켓플레이스를 스스로 올려 새 판을 받습니다. 바로 올리려면 `codex plugin marketplace upgrade banker-plugins` 를 실행합니다.

2) npm 전역 설치 후 `banker setup`

```bash
npm i -g @kaydash9999/banker-plugins
banker setup --codex
```

스킬을 `$banker-audit-security` 처럼 `$banker-<name>` 으로 호출합니다.

두 방법을 함께 쓰지 않습니다. 함께 두면 스킬과 훅이 두 벌이 되고, banker 가 세션 시작과 `banker doctor` 에서 알립니다.

playwright(브라우저 QA)나 oh-my-claudecode(OMC/OMX)처럼 별도 의존성이 필요한 스킬은 실행 전에 설치부터 안내합니다(Claude Code는 `/banker:setup`).

## 워크플로 사용 예시

무엇부터 써야 할지 막막할 때, 상황별로 골라 쓰는 대표 워크플로입니다.\
Claude Code는 `/banker:<이름>`, Codex는 `$banker-<이름>`(플러그인 설치면 `$banker:<이름>`)으로 호출합니다.

| 워크플로 | 언제 쓰나 | 하는 일 |
|---|---|---|
| `ultra-interview` | 처음 프로젝트 아이디어를 구체화할 때 | 최신 정보를 반영한 소크라테스식 인터뷰 |
| `ultra-init` | 프로젝트 기획이 충분히 구체적일 때 | 데모를 구현 |
| `curation` | 질문에 답하기 어렵거나 의사결정이 어려울 때 | 합리적 선택지 제공 (`--perf` = 품질 우선, `--deep` = 확신 0.80 초과까지 추가 조사) |
| `all-in-one` | 요건이 명확한 단계에서 | 계획 → 구현 → `ralph-qa` 검증 |
| `ralph-qa` | 검증이 충분하지 않을 때 | 세션 모델로 띄운 독립 검토 에이전트 3개 이상의 합의 루프 (+ 플래그로 고른 CLI 좌석) |
| `smart-compact` | 컨텍스트 임계 초과로 맥락 단절이 걱정될 때 | 맥락을 더 잘 이어서 진행 |
| `refresh-readme` | 프로젝트 배포 전 | README 최신화 |
| `summary-wiki` | Agent가 아는 정보를 확인하고 싶을 때 | 요약 리포트 |
| `cleansing-memory` | 프로젝트가 장기화될 때 | 메모리 최적화 |
| `ready-compact` | 컨텍스트를 compact 하거나 새 세션을 대비할 때 | 이어갈 프롬프트만 출력(`/copy` 한 번이면 복사), `--hand-off` = 새 세션에서 이어가기 |
| `/graceful-pause` | 작업 도중 방향을 바꾸거나 끼어들고 싶을 때 | 작업 중에 입력해도 바로 전달. 실행 중인 도구 호출이 끝나면 그 단계까지만 마무리하고 멈춘 뒤 지시를 기다림 (Claude Code) |
| `/progress` | 지금 작업이 어디까지 왔는지 보고 싶을 때 | 진행 상황 패널을 켜고 끔. 세션이 쓰거나 읽은 계획 파일 전체가 위에 접고 펴는 목록으로, 할 일 목록(없으면 요청)과 그 도구 호출이 아래에 보임. 화살표나 제목을 누르면 펼쳐짐 (Claude Code) |
| `tone-compact` | 답변을 짧은 한글 개조식으로 받고 싶을 때 | 문체 규칙을 켜 두면 끌 때까지 모든 세션에 적용 |
| `anti-drm` | 망분리 PC 의 DRM 이 `.txt`, `.csv` 같은 파일을 암호화해 에이전트가 읽지 못할 때 | 금지 확장자 대신 `.md`, `.html`, `.tsv` 로 만들게 하는 규칙을 켜 두면 끌 때까지 모든 세션에 적용 |
| `omc-patch` | OMC 자동 업데이트 뒤 훅이 느려지거나 훅 프로세스가 쌓일 때, project-memory 가 안 될 때 | 사라진 훅 패치를 다시 적용하고 OMC 자동 업데이트를 고정 |
| `remains` | 작업 뒤에 남은 버그, 하자, 미검증 항목을 한눈에 보고 싶을 때 | 남은 항목을 표로 정리하고, 등록한 테스트박스에서 시험까지 돌림 |
| `trouble-shooting` | 문제가 생겨 원인과 해결방법을 정리해야 할 때 | 현상, 문제점, 원인, 해결방법, 조치계획을 표로 간결히 보고(`--no-plan` 은 해결방법까지) |
| `ultra-chain` | 조사부터 결과 공유까지 한 번에, 여러 OS 에서 돌아야 하는 기능을 만들 때 | 조사 → 인터뷰 → 검토자 3명 이상의 합의 계획 → 목업 승인 → 구현 → OS 박스 시험과 합의 검증 → 시각 검토 → 과정 보고서 |

## 구성

### 커맨드

| 커맨드 | 설명 |
|---|---|
| `/banker:front-qa` | 스펙(note) 기반 프론트엔드 구현 + parity QA |
| `/banker:setup` | 구성요소·의존성 설치 오케스트레이터 (multi-select) |
| `/graceful-pause` | 작업 중에도 바로 실행되는 정지 요청. 지금 단계만 끝내고 멈춘 뒤 보고하고 지시를 기다림 (Claude Code 2.1.289 이상, mod. Codex 는 작업 중에 `$banker-graceful-pause` 를 보내면 실행 중인 도구 호출이 끝난 뒤 멈춤) |
| `$banker-teamwork` (Codex 전용 스킬) | 같은 기기의 Codex CLI 세션끼리 피어 협업을 켜고 끔(`on` 기본, `off`, `status`). 켜면 열린 세션과 새 세션이 모두 팀으로 동작하고, 역할은 각 세션에 말로 주며, 요청과 결과는 Codex 내장 `codex queue` 로 오감. 플러그인 길은 `$banker:teamwork` |
| `/progress` | 진행 상황 패널을 켜고 끔(`show` 기본 토글, `on`, `off`). 맨 위는 이 세션이 쓰거나 읽은 마지막 계획 파일(`.omc/plans/*.md`, `docs/superpowers/plans/*.md`, `~/.claude/plans/*.md`, ralph `prd.json`, ultragoal `goals.json`) 전체. Notion 토글 목록처럼 제목이 그 아래 내용을, 목록 항목이 하위 항목을, 표와 코드 블록이 행과 줄을 품고, 처음에는 큰 제목만 접힌 채 보임. 체크박스는 완료와 대기, 제목은 그 아래 체크 수(`2/5`). 그 아래 단계는 할 일 목록(Claude 의 작업 목록이나 `mcp__banker__todo`), 없으면 이 세션의 요청이고, 하위 목록은 그 단계가 진행 중일 때 한 도구 호출 한 단계까지. 작업 중에도 바로 실행됨(2.1.289 이상에서 확인) (mod. Codex 는 `$banker-progress` 스킬이 지금 세션의 계획 트리, `update_plan` 단계, 최근 도구 호출을 텍스트로 보이고, tmux 안이면 `--pane` 으로 오른쪽 칸에 갱신) |

Claude Code 2.1.296 은 Claude 5 모델(Opus 5.5 등)에 작업 목록 도구(TaskCreate, TodoWrite)를 주지 않습니다. 그래서 `/progress` 를 켜면 모델에게 할 일 도구 `mcp__banker__todo` 를 줍니다(다음 요청부터). 모델이 여러 단계 작업을 시작할 때 할 일 목록을 보내면 그 목록이 단계가 됩니다. 한 단계로 끝나는 일에는 쓰지 않으므로 그때는 요청이 단계입니다. 내장 작업 목록 도구가 있는 세션(옛 모델, `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`)에는 이 도구를 더하지 않습니다. 도구는 `/progress off` 뒤에도 세션이 끝날 때까지 남고, 그동안 부르면 패널이 꺼져 있다고 답합니다.

`/graceful-pause` 와 `/progress` 는 Claude Code 의 mod(Claude Mods, 얼리 액세스 이름 function hooks, `hooks/register.mjs`)로 등록되는 명령이라 구성요소 수에 넣지 않습니다. `commands/progress.md` 도 넣지 않습니다. 이 파일은 mod 가 없는 Claude Code 에서 `/progress` 를 받아 "mod 를 지원하지않는 claude code 버전입니다" 만 보여 주는 대체 명령이고, mod 가 있으면 mod 가 대신 처리합니다.

### 스킬: QA · 감사

| 스킬 | 설명 |
|---|---|
| `audit-security` | 보안 취약점(CVE·SAST·시크릿) 진단 (read-only) |
| `audit-mock` | 하드코딩·mock/stub·열거형 정적 검출 (read-only) |
| `audit-web-page` | 라이브 웹 페이지 점검 (playwright·WebGL 캔버스) |
| `play-qa` | 웹 기반 동작 컨텐츠를 실제 브라우저에서 직접 플레이하는 QA |
| `ultra-ui-qa` | UI를 기준(디자인 PDF/스펙)과 1:1 대조 QA |
| `visual-ralph` | 레퍼런스(생성/정적/URL) 기준 프론트 UI를 Visual Verdict(≥90)로 측정 빌드 |

### 스킬: 문서 · 디자인 · 위키

| 스킬 | 설명 |
|---|---|
| `arch-diagram` | 시스템 아키텍처 구성도 (PlantUML + 편집가능 PPTX) |
| `vertical-pptx` | A4 세로(210x297mm) 규격 PPTX 생성·점검·수리, 16:9 덱의 A4 세로 변환 |
| `make-notion-guide` | API 호출 가이드를 노션 양식 문서로 작성 |
| `pdf-vision-extract` | 비주얼 PDF를 고해상도 PNG로 변환(비전 입력) |
| `nothing-design` | Nothing 스타일 UI 디자인 적용 |
| `theme-selection` | 테마 74종을 라이트와 다크 CSS 변수로 입힘(대비 보정 포함). 테마 고르개와 대비 감사도 냄 |
| `rfp-author` | 외주 제안요청서(RFP) 저작 (범용 프레임워크) |
| `humanizer` | AI 글 흔적 제거(자연스러운 문체로 윤문) |
| `lineage` | 세션 대화를 카카오톡 스타일 단일 HTML로 export. 세션 모델이 턴마다 1줄 요약을 쓰고 남길 턴을 고름(`--rulebase` 는 규칙만), 마크다운 렌더, 다중 세션 병합 |
| `append_wiki` | 프로젝트 위키 문서 추가/보강 |
| `compact-wiki` | 위키 중복 제거·supersede·병합 (무손실) |
| `obsidizer` | AI 위키를 의미보존 Obsidian 그래프로 정규화·상호링크·백링크 |
| `deep-init` | 코드베이스 전체에 계층형 AGENTS.md 문서 생성/갱신 |

> `obsidizer` 는 banker 최초의 플러그인 선언 hook(`hooks/hooks.json`)을 함께 설치합니다.\
> banker가 활성화되어 있으면 이 hook은 **항상 등록**되어 위키 쓰기(`wiki_ingest`/`wiki_add`)마다 node 프로세스를 띄웁니다(플래그 확인이 그 안에서 일어나므로 `--enable` 전에도 쓰기당 약 30ms).\
> `--enable` 전에는 아무것도 쓰지 않는 순수 no-op입니다.\
> Codex 에는 위키 MCP 가 없어 `--enable` 이 `omx_wiki/.obsidizer` 를 쓰고 Codex 사용자 범위에 `PostToolUse`(matcher `Bash`) 훅을 설치합니다(`banker hooks enable obsidize`, 샌드박스 밖 실행 승인 필요). 이 훅은 `--enable` 한 때만 설치되고, 설치된 동안 셸 호출마다 node 프로세스를 띄워 `omx wiki` 의 ingest, add 일 때만 정규화합니다.

### 스킬: 워크플로 · 유틸

| 스킬 | 설명 |
|---|---|
| `all-in-one` | 계획→구현→검증 end-to-end 오케스트레이터. 마지막 QA 는 두 런타임 모두 `ralph-qa` |
| `ultra-init` | 아이디어→빌드→테스트 원샷 자동 실행. 마지막 QA 는 두 런타임 모두 `ralph-qa` |
| `ready-compact` | 이어가기 상태 저장 + resume 프롬프트만 출력(`--hand-off` = 새 세션용 자급식 노트·프롬프트) |
| `compact-copy` | 설명·코드펜스가 섞인 resume 프롬프트 출력에서 본문만 추출(지금의 ready-compact 는 처음부터 프롬프트만 출력) |
| `refresh-git-ignore` | `.gitignore` 비파괴·반복가능 갱신 |
| `omc-reference` | OMC/OMX 에이전트·툴·스킬 레퍼런스(양 런타임 병기) |
| `curation` | 의사결정을 선택지·권고·확신수준으로 큐레이션(--perf=품질 우선, --deep=확신 0.80 이하는 추가 조사·검토 후 제시) |
| `ralph-qa` | 세션 모델로 띄운 독립 검토 에이전트 3개 이상이 합의할 때까지 검증 반복. `--codex`·`--gemini`·`--opencode` 를 주면 그 CLI 에서 가장 뛰어난 모델이 좌석으로 합류 |
| `ultraqa` | Claude Code 전용(`/banker:ultraqa`). OMX ultraqa 를 본뜬 적대적 동적 e2e QA 순환. 9분류 시나리오 행렬과 실행기가 돌린 게이트 증거로 최대 5회 진단, 고침, 재시험. Codex 는 OMX `$ultraqa` 를 그대로 씀 |
| `smart-compact` | 컨텍스트 임계 초과 시 위키·resume 저장 게이트 자동 무장 |
| `deep-research` | 다중 소스 팬아웃 + 적대적 검증 인용 리서치 |
| `lfm` | learn from master. 그 분야 최고 전문가 그룹이 일하는 방식을 1차 자료로 조사해 계획 적용 항목으로 정리(ultra-interview, ultra-chain, deep-research, rfp-author 의 리서치에서도 씀) |
| `ultra-interview` | 리서치 선행으로 사람 질문 최소화, 모호성 3% 이하까지 인터뷰 |
| `interval-report` | 장기 수행 중간 보고를 `docs/intermission.md` 로 갱신(경과·잔여·단일 표) |
| `summary-wiki` | 위키를 `docs/` 단일 파일 개조식으로 요약(지식 동기화 검토용, 읽기 전용) |
| `update-banker` | 설치된 banker 를 3채널(Claude·npm·Codex) 순서 게이트로 최신화 |
| `refresh-readme` | 코드와 어긋난 README 를 현재 상태에 맞게 갱신(드리프트 해소) |
| `cleansing-memory` | 메모리 파일을 문서화된 threshold 내로 정리(중복 최신본화·무손실 압축) |
| `payload-mon` | 상태표시줄에 요청 payload 추정치(32MB 한도 대비) 표시 켜기·끄기. 래퍼 v4 는 `PL:` 칸에 늘, 옛 래퍼는 8MB부터 ctx 옆에 |
| `tone-compact` | 답변과 새 문서를 ASD-STE100 기반 한글 개조식(표·목록·원어 발음 표기·장식 기호 금지)으로 쓰는 문체 규칙 켜기·끄기(on 기본, 끌 때까지 유지) |
| `anti-drm` | DRM 이 암호화하는 확장자(기본 11개: 텍스트·오피스·한글·PDF·CSV) 대신 대체 확장자(`.md`·`.html`·`.tsv`)로 파일을 만들게 하는 규칙 켜기·끄기(on 기본, 처음 켤 때 금지 확장자와 대체 확장자를 물음, `config` 로 변경, 끌 때까지 유지) |
| `omc-patch` | OMC 자동 업데이트 뒤 사라진 훅 패치를 재적용하고 OMC 마켓플레이스 자동 업데이트를 고정(진단·확인·적용·검증·되돌리기). 옛 킷이 블록 안에 넣은 헬퍼(project-memory 꺼짐)를 찾아 고치고, project-memory 훅이 실제로 일하는지 임시 폴더에서 확인 |
| `remains` | 남은 버그, 하자, 미검증 항목을 찾아 표로 보여 줌. 테스트박스(`~/.config/banker/test-boxes.json`)가 등록돼 있으면 각 OS 에서 시험을 돌려 확인(읽기와 시험만, 고치지 않음) |
| `trouble-shooting` | 문제를 조사해 현상, 문제점, 원인, 해결방법, 조치계획을 표 하나로 간결히 보고(문제마다 한 행, `--no-plan` 은 해결방법까지, 고치지 않고 보고만) |
| `ultra-chain` | 자료 조사, 모호성 제거, 검토자 3명 이상의 합의 계획, 목업 승인, 비판 검증 구현, 실제 OS 테스트박스 시험과 합의 검증, 시각 검토, 과정 시각화, 결과 공유를 한 명령으로 잇는 9단계 연쇄. 사람이 볼 곳은 인터뷰의 취향 질문과 목업 승인으로 줄임. 실행 기록과 단일 HTML 보고서를 남기고, push 나 외부 게시는 요청할 때만 |

### 스킬: 미디어 (모션 그래픽 · 3D 인트로)

| 스킬 | 설명 |
|---|---|
| `motion-graphic-make` | 10초 내외 내레이션 없는 무료 모션 그래픽 제작 (hyperframes 위임). 계획 승인, 스냅숏과 렌더 검토 페이지, 독립 검증, 사이트 배치는 선택 |
| `3d-intro-build` | 스크롤-스크럽 3D 인트로 사이트 제작 (Azure gpt-image 스틸 + WAN 키 풀 영상, 소진 시 Sora-2 폴백, 유료). 단계별 검토 페이지, 엄격한 CSP 에서 도는 페이지, 실제 브라우저 독립 검증. 장면 단위 이동과 기존 사이트 통합은 선택 |

### 스킬: 개발환경 setup (OS별 · 런타임별)

USER_RESOURCES 가이드의 공통 요소를 OS별·런타임별(Claude Code/Codex)로 구성하는 얇은 실행 유닛.\
`/banker:setup` 오케스트레이터가 의존 순서(런타임 먼저)로 조합한다.

| 스킬 | 설명 |
|---|---|
| `setup-node` | nvm + Node 22 (winget/nvm-windows) |
| `setup-python` | Python 3.11 + pipx + uv (PEP668) |
| `setup-java` | JDK 21 + JAVA_HOME (Debian=Adoptium Temurin) |
| `setup-lsp` | 언어별 LSP(vtsls·basedpyright·bash·jdtls·spring) + lsp-mcp 브리지 (node·python·java 의존) |
| `setup-tmux` | tmux(Rocky8 3.6a 소스빌드) / psmux(Windows) |
| `setup-pwsh` | Windows PowerShell 7 환경(비-Windows no-op) |
| `setup-mcp` | 공통 MCP 서버(context7·seq-thinking·filesystem·git·fetch) |
| `setup-sandbox` | OS별 샌드박스(bubblewrap+userns / Seatbelt) + rust + git safe.directory |

### 스킬: 설치 (`/banker:setup` 가 호출)

| 스킬 | 설명 |
|---|---|
| `setup-omc` | oh-my-claudecode(OMC) 설치·갱신 (Codex는 OMX) |
| `setup-harness-factory` | revfactory/harness 팀 아키텍처 팩토리 설치·구성·사용안내 (Codex=meta-harness) |
| `setup-playwright` | Playwright + headless 브라우저 (RHEL8/Rocky8·non-root·no-conda 폴백) |
| `setup-omc-hud` | omc_hud 상태표시줄(래퍼 v4). 스킬에 든 파일로 오프라인 설치, 모든 OS 같은 명령, 설치 직후 렌더 확인 |
| `setup-insane-search` | insane-search 플러그인 설치 (Claude·Codex) |
| `setup-stitch` | Stitch 디자인 MCP 프록시 등록(RockyLinux8 proxy) |
| `docs-setup` | arch-diagram·pdf-vision-extract 의존성(pptx·pymupdf·plantuml) 설치 |
| `vertical-pptx-setup` | vertical-pptx 의존성(pptxgenjs·python-pptx) + 시각 검증용 LibreOffice (OS·권한 적응형) |
| `motion-graphic-setup` | hyperframes(무료 모션 그래픽 CLI) 전제조건 설치 (Node≥22 + ffmpeg) |
| `3d-intro-setup` | 3D 인트로용 Azure·WAN 크레덴셜·의존성 설치 + 무과금 프리플라이트 (Node/ffmpeg) |
| `setup-bypass-permissions` | Claude Code 기본 권한 모드를 `bypassPermissions` 로 바꿔 모든 세션에서 도구 실행 확인을 끔. 사용자가 직접 입력해야 실행(모델은 호출 불가), 위험 경고와 확인 뒤 적용, `off` 로 원복. `/banker:setup` 에서는 기본 미선택 |

## 설치 상세 (npm · Codex)

마켓플레이스 대신 npm으로 전역 설치할 수 있고, Codex CLI에도 스킬을 설치할 수 있습니다.\
Codex CLI 에는 두 길이 있습니다. Codex 플러그인 마켓플레이스 길(`codex plugin marketplace add` 뒤 `codex plugin add`, npm 불필요, 아래 목록의 Codex 플러그인 항목)과 npm 길(`banker setup --codex`, npm 전역 설치가 먼저)입니다. 둘 중 하나만 씁니다.

```bash
npm i -g @kaydash9999/banker-plugins
banker setup            # 대상 플래그가 없으면 Claude Code와 Codex 둘 다
banker setup --claude   # Claude Code만 (마켓플레이스 등록 후 /banker:*)
banker setup --codex    # Codex CLI만 (~/.codex/skills/banker-*)
banker doctor           # 설치 상태 점검
banker uninstall        # 제거
```

- `--scope project` 로 프로젝트 로컬(`./.codex`)에 설치하고, `--dry-run` 으로 미리 볼 수 있습니다.
- non-root 전용입니다(전역 sudo 설치 시 root 소유 파일을 방지). postinstall이 없으므로 `banker setup` 을 직접 실행합니다.
- Codex에는 스킬 64개와 Codex 전용 스킬 3개(`graceful-pause`, `progress`, `teamwork`)가 `~/.codex/skills/banker-<name>/` 에, 커맨드 2개가 `~/.codex/prompts/banker-<name>.md` 에 설치됩니다(`codex/manifest.json`). \
  `CODEX_HOME` 을 설정했으면 `~/.codex` 대신 그 폴더에 설치합니다(Codex 가 읽는 곳). \
  `lineage`, `progress`, 사용량 카운팅은 Codex 의 대화 기록(rollout)을 읽습니다. Codex 는 이 형식을 공개 약속으로 내놓지 않아 업데이트로 바뀔 수 있습니다. \
  Codex 를 업데이트한 뒤에는 `banker doctor` 로 형식을 점검합니다. 읽지 못하면 lineage 는 빈 페이지 대신 오류로 멈추고, progress 는 경고 줄을 보이며, 카운팅은 다음 세션 시작 때 경고를 한 번 보입니다. \
  Codex 0.144 이상에는 사용자 프롬프트가 없으므로 커맨드 2개는 스킬로도 설치되어 `$banker-front-qa`, `$banker-setup` 으로 부릅니다. \
  디렉터리명과 일치하도록 프론트매터 `name:` 이 `banker-<name>` 으로 재작성되어 Codex가 `banker-<name>` 으로 인식합니다.
- Codex 플러그인 설치(`codex plugin add banker@banker-plugins`)는 저장소를 `~/.codex/plugins/cache/banker-plugins/banker/<판>/` 에 두고 `.codex-plugin/plugin.json` 을 읽습니다. \
  스킬 64개, Codex 전용 스킬 3개, 커맨드 2개(스킬로)가 `$banker:<name>` 으로 보이고, 업데이트 알림과 사용량 카운팅 훅은 `codex/hooks.json` 에서 옵니다. \
  Codex 는 세션을 시작할 때 마켓플레이스를 스스로 올려 새 판을 설치합니다. 훅 명령 앞에는 훅이 실행하는 파일의 해시가 붙어 있어, 훅 코드가 바뀐 판에서는 `/hooks` 가 다시 신뢰를 묻고 신뢰하기 전에는 훅이 돌지 않습니다. 훅 코드가 그대로인 판은 신뢰도 그대로입니다. 스킬 파일은 신뢰 확인 없이 새 판으로 바뀝니다. \
  obsidizer 훅은 npm 설치와 같이 `obsidizer --enable` 할 때만 사용자 범위에 설치됩니다(셸 호출마다 node 를 띄우므로). \
  훅은 Codex 샌드박스 밖에서 돌므로, PATH 의 node 가 임시 폴더나 작업 폴더 안에 있으면(샌드박스가 바꿀 수 있는 곳) 아무것도 돌리지 않고 그 이유를 세션 시작 알림으로 보입니다. 작업 폴더가 홈 폴더 자체이면 홈 아래의 node(nvm 등)는 그대로 씁니다. 훅 스크립트, 플러그인 폴더, node 가 `config.toml` 의 `[sandbox_workspace_write] writable_roots` 아래(그 항목 맨 위 `.codex` 제외)면 훅은 다른 일을 하지 않고 그 이유를 한 줄로 알립니다. 이 검사는 훅 파일 안에서 하므로, 샌드박스가 이미 그 파일을 고친 뒤에는 막지 못합니다. writable_roots 에 Codex 홈이나 node 가 든 폴더를 넣지 마십시오. \
  node 를 찾은 뒤에는 PATH 에서 임시 폴더와 작업 폴더 아래 항목을 빼므로, 프로젝트의 `.venv/bin` 이나 `node_modules/.bin` 에 있는 프로그램은 훅에서 돌지 않습니다(작업 폴더가 홈 폴더 자체이면 홈 아래 항목은 남깁니다). Windows 는 네트워크 드라이브와 UNC 경로의 PATH 항목을 읽지 않습니다. macOS 데스크톱에서 연 Codex 처럼 PATH 에 node 가 없으면 Homebrew(`/opt/homebrew/bin`)와 공식 설치(`/usr/local/bin`)의 node 를 씁니다. \
  Volta, mise, snap 처럼 이름을 보고 동작하는 node 와 Windows 의 `node.cmd` shim(mise)은 그 도구가 고른 node 를 씁니다. 훅은 플러그인 폴더에서 돌므로 asdf, nodenv 는 전역 버전(`asdf set -u nodejs <판>`, asdf 0.16 미만은 `asdf global nodejs <판>`, `nodenv global <판>`)이 있어야 합니다. \
  이 설치에는 `banker` 명령이 없습니다. `banker doctor`, `banker telemetry` 가 필요하면 npm 으로도 설치하되 `banker setup`(인자 없음)과 `banker setup --codex` 는 돌리지 않습니다(Codex 에 npm 길이 함께 설치됨). Claude Code 에 넣으려면 `banker setup --claude` 만 씁니다.
- Codex 에서는 OMC 를 OMX 로 바꿔 부르거나 설명하는 스킬이 있습니다. npm 길과 플러그인 길의 이름이 같습니다.

  | Claude Code 이름 | Codex 이름 | Codex 에서 바뀐 것 |
  |---|---|---|
  | `setup-omc` | `setup-omx` | 이름, 설명 |
  | `omc-reference` | `omx-reference` | 이름, 설명 |
  | `setup-omc-hud` | `setup-omx-hud` | 이름, 설명 |
  | `append_wiki` | `append_wiki` | 설명 |
  | `compact-wiki` | `compact-wiki` | 설명 |
  | `setup-tmux` | `setup-tmux` | 설명 |
  | 커맨드 `setup` | `setup` | 설명 |

  Codex 에서는 npm 길이 `$banker-setup-omx`, 플러그인 길이 `$banker:setup-omx` 처럼 부릅니다. `omc-patch`, `payload-mon` 은 Codex 에서도 이름이 같습니다. 둘 다 Claude Code 의 OMC 를 다룹니다. `ultraqa` 는 Claude Code 전용이라 Codex 에는 없습니다(Codex 는 OMX `$ultraqa`). \
  npm 길은 갱신할 때 옛 폴더(`banker-setup-omc` 등)를 지우고 새 이름으로 설치한 뒤 `이름 바뀜:` 줄로 알립니다. 플러그인 길은 새 판으로 바뀔 때 옛 이름이 사라집니다. \
  `config.toml` 의 `[[skills.config]]` 로 옛 이름을 꺼 두었다면 그 설정은 새 이름에 닿지 않습니다. 새 이름으로 다시 적습니다. \
  플러그인 길의 스킬 목록(`.codex-plugin/plugin.json` 의 `skills`)은 스킬마다 경로를 적습니다. 이 형식은 Codex 0.160.1 이상에서 확인했습니다(0.160.1 Windows, 0.165.0 Linux). 0.144.5 같은 낮은 판은 재지 않았고, banker 스킬이 거의 다 안 보일 수 있습니다. \
  플러그인 길이고 Codex 가 0.160.1 보다 낮으면 `banker doctor` 와 세션 시작 알림이 한 줄로 알립니다. 세션 시작 알림은 `/hooks` 에서 훅을 신뢰한 뒤에만 나옵니다.
- OMC/Claude 에 결합됐던 오케스트레이터·설치·유틸 표면(all-in-one·ultra-chain·ultra-init·front-qa·setup·setup-omc·setup-omc-hud·setup-stitch·omc-reference·compact-copy)은 본문이 **런타임 인식**이라 Codex에서도 동작합니다.
- `payload-mon` 은 Codex에서 실행해도 같은 머신의 Claude Code HUD 래퍼만 켜고 끕니다. \
  32MB 요청 한도는 Claude Code 의 것이라 Codex 자신의 요청 크기는 재지 않습니다.
- `omc-patch` 도 Codex에서 실행하면 같은 머신의 Claude Code OMC 플러그인 캐시(`~/.claude/plugins/`)만 다룹니다. Codex 의 OMX 는 건드리지 않습니다.
- Codex에선 OMC 대신 **oh-my-codex(OMX)** 의 동명 스킬(ralplan·ralph·hud 등)과 `codex mcp`·내장 `/copy` 를 사용합니다(Codex는 `omx setup` 전제).
- `all-in-one`·`ultra-init` 의 마지막 QA 게이트는 두 런타임 모두 banker `ralph-qa` 입니다. 독립 검토자 3명 이상이 실행기가 돌린 `--qa` 목표의 게이트 기록으로 판정합니다.
- 설치기는 `~/.codex/AGENTS.md` 를 건드리지 않습니다(omx가 재생성하므로 `~/.codex/skills/` 자동 검색에 의존). \
  예외는 사용자가 켠 `tone-compact` 와 `anti-drm` 입니다. 각각 그 파일 끝에 `USER:OMX:POLICY` 로 감싼 블록 1개를 넣고, `off` 로 뺍니다. \
  `omx setup --merge-agents` 와 기본 `omx setup` 은 이 블록을 남깁니다. `--force` 나 team 모드를 끈 `omx setup` 처럼 AGENTS.md 를 새로 만들면 사라지므로, 그 뒤 `on` 을 다시 실행합니다.

## 설정 변경 지점 (Claude Code · Codex)

이 플러그인이 두 런타임의 설정·설치 상태를 건드리는 지점을 한눈에 정리했습니다.\
아래 파일 패치는 모두 기존 키를 병합·래핑·백업만 하며 덮어쓰지 않습니다.

**설치·제거 — `banker` CLI (결정론적)**

| 런타임 | 대상 | 동작 |
|---|---|---|
| Claude Code | 플러그인 레지스트리 | `claude plugin marketplace add` + 설치 → `/banker:*` (`settings.json` 직접수정 없음) |
| Codex CLI | `~/.codex/skills/banker-*/`, `~/.codex/prompts/banker-*.md` | 기존 `banker-*` 정리 후 복사(멱등). `AGENTS.md`·`config.toml` 미변경 |
| Codex CLI | `~/.codex/hooks.json`, `~/.codex/hooks-custom/banker/` | 업데이트 알림(`SessionStart`)과 사용량 카운팅(`Stop`) 훅. 사본은 작업 폴더 밖에 두고, 이벤트마다 맨 뒤에 묶음 1개를 더하며, 쓰기 전 `hooks.json.banker.bak` 백업. `banker hooks status`, `banker hooks enable <이름>`, `banker hooks disable <이름>` 으로 확인하고 켜고 끔. Codex 를 다시 열 때 Hooks need review 창이나 `/hooks` 에서 신뢰해야 돎. Codex 홈(`CODEX_HOME`)이 지금 폴더나 그 저장소 안이면 샌드박스가 고칠 수 있어 훅을 설치하지 않음 |

**플러그인 자체 훅 — `hooks/hooks.json` (설치 시 Claude Code에서 자동 발화)**

사용자 `settings.json` 을 고치는 게 아니라 플러그인이 자기 훅을 선언한 것입니다.

| 이벤트 | 훅 | 역할 |
|---|---|---|
| PostToolUse | `obsidize-hook` · `telemetry-count-skill` | 위키 정규화 · 스킬 사용 카운트 |
| UserPromptExpansion | `telemetry-count` | `/banker:*` 직접호출 카운트 |
| SessionStart | `update-notify` | 업데이트 알림 |

**setup 스킬이 사용자 설정 파일을 패치 (해당 스킬 실행 시)**

| 스킬 | Claude Code (`~/.claude/settings.json` 등) | Codex CLI (`~/.codex/config.toml` 등) |
|---|---|---|
| `setup-sandbox` | `sandbox` 객체 | `sandbox_mode` · `[sandbox_workspace_write]` |
| `setup-mcp` | `claude mcp add` (context7·seq-thinking·filesystem·git·fetch) | `[mcp_servers.*]` |
| `setup-lsp` | LSP MCP 등록 | `[mcp_servers.lsp_bridge]` |
| `setup-stitch` | `claude mcp add stitch` | `codex mcp add stitch` |
| `setup-omc-hud` | `statusLine`(바뀔 때 `settings.json` 백업) + `hud/omc-hud-custom.mjs`, `hud/omc-hud.mjs`, `.omc/hud-config.json`(바뀐 파일은 `.backup.<시각>` 백업) + payload-mon 켜기. 옛 판이 넣은 갱신 안내 블록은 `off` 로 원복 | 대상이 Codex 면 `~/.codex/config.toml` 의 `[tui] status_line` 이 없을 때만 OMX 프리셋으로 넣고 `# banker:status-line` 표시(`config.toml.banker-hud.bak` 백업). OMX 나 사용자가 둔 줄은 그대로, `off` 는 banker 줄만 뺌. Claude Code 쪽을 고르면 왼쪽과 같음 |
| `setup-pwsh` | `env.CLAUDE_CODE_GIT_BASH_PATH` (병합) | — (네이티브 셸, 배선 불필요) |
| `setup-harness-factory` | `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` (env 영속) | — |
| `smart-compact` | `statusLine.command` 래핑 + `UserPromptSubmit` 훅 추가 (백업·멱등) | `hooks.json` 의 `UserPromptSubmit` 맨 뒤에 훅 묶음 1개 + `smart-compact.json`(임계값), `smart-compact-state.json`(세션 상태). 훅 사본 `hooks-custom/banker-smart-compact-gate.mjs`. `hooks.json` 을 바꿀 때마다 직전 내용을 `hooks.json.smart-compact.bak` 에 백업, 멱등. `off` 는 이 훅과 사본, 설정만 지움. 새 훅은 `/hooks` 에서 신뢰해야 돎 |
| `payload-mon` | `hud/omc-hud-custom.mjs` 에 표시 블록 1개 삽입(`.payload-mon.bak` 백업·멱등·`node --check` 검증) + 래퍼 옆 `hud/payload-mon/` 에 모듈 사본 (`off` 로 원복) | — (Codex에서 실행해도 Claude Code HUD 만 다룸) |
| `tone-compact` | `rules/banker-tone-compact.md` 생성 (`off` 로 삭제) | `AGENTS.md`(내용이 있는 `AGENTS.override.md` 우선) 끝에 `USER:OMX:POLICY` 로 감싼 블록 1개(`.tone-compact.bak` 백업·멱등, `off` 로 원복) |
| `anti-drm` | `rules/banker-anti-drm.md` 생성 (`off` 로 삭제) + 설정 `~/.config/banker/anti-drm.json`(두 런타임 공용, `off` 뒤에도 남음, anti-drm 이 쓰지 않은 파일이 있었으면 `.bak`) | `AGENTS.md`(내용이 있는 `AGENTS.override.md` 우선) 끝에 `USER:OMX:POLICY` 로 감싼 블록 1개(`.anti-drm.bak` 백업·멱등, `off` 로 원복) |
| `omc-patch` | 활성 OMC 버전의 `scripts/*.mjs` 와 `hooks/hooks.json` 수정(`.omcbak` 백업, `PostToolUse` 훅 제거) + OMC 마켓플레이스 `origin` 을 `omc-pinned://` 로 고정(기록 `~/.claude/omc-local-patches/PINNED`, `revert` 로 원복). 헬퍼 자리 결함은 활성 폴더만 되돌린 뒤 다시 패치. project-memory 확인은 임시 폴더에서만 하고 끝나면 지움 | — (Codex에서 실행해도 Claude Code 의 OMC 캐시만 다룸) |
| `remains` | 설정 파일 미변경. `~/.config/banker/test-boxes.json` 은 읽기만 함(사용자가 만들거나, 사용자가 준 정보로 확인받고 만듦). 처음 접속하는 박스의 호스트 키가 `~/.ssh/known_hosts` 에 더해짐. 테스트박스에는 임시 폴더를 만들고 끝나면 지움(시간 초과나 중단 때는 시작한 프로세스를 먼저 끝냄, 못 지우면 결과에 표시) | 동일 |
| `motion-graphic-setup` | 설정 파일 미패치 (Node/ffmpeg 확보 + `npx hyperframes` 설치만) | 동일 (`config.toml` 미변경) |
| `3d-intro-setup` | `settings.json` 미패치 — 크레덴셜을 untracked env 파일에 기록(`.env.3d-intro.local` 또는 `~/.config/banker/3d-intro/env`) | 동일 (`config.toml` 미변경) |
| `setup-bypass-permissions` | `permissions.defaultMode` = `bypassPermissions` (켜기 전 내용은 `settings.json.bypass-permissions.bak`, 되돌리기 기록은 `settings.json.bypass-permissions.json`, `off` 로 원복. 관리 정책, 설정 파일의 금지 키, root 계정이면 거부) | 대상 `codex` 면 `~/.codex/config.toml` 최상위의 `approval_policy` = `"never"`, `sandbox_mode` = `"danger-full-access"` (켜기 전 원본 `config.toml.bypass-permissions.bak`, 되돌리기 기록 `config.toml.bypass-permissions.json`, `off` 로 원복. 조직 정책이 막으면 거부). 대상 `claude` 면 Codex 에서 실행해도 Claude Code 설정을 바꿈 |

`obsidizer` 는 `settings.json` 대신 `<위키디렉터리>/.obsidizer` 플래그 파일로만 켜고 끕니다. Codex 는 `omx_wiki/.obsidizer` 플래그에 더해 `~/.codex/hooks.json` 에 훅 묶음 1개를 더합니다.

## 요구사항

- Claude Code (마켓플레이스 경로): 스킬이 `/banker:*` 로 동작.
- 또는 Node.js ≥ 16.7 (npm 전역 설치 경로): `banker` CLI 제공.
- 일부 스킬은 별도 의존성이 필요하며 `/banker:setup` 으로 설치합니다. 의존성이 없으면 각 스킬이 실행 전에 설치부터 안내합니다.
  - `all-in-one`, `ultra-chain`, `ultra-init`, `/banker:front-qa`: oh-my-claudecode(OMC) 5 와 같은 버전대의 `omc` CLI(`ralph` 가 `omc ralph verify` 를 부르므로 4.x CLI 로는 멈춤). Codex에서는 OMX. 마지막 QA 의 `ralph-qa` 는 banker 에 들어 있습니다.
  - `audit-web-page`, `play-qa`, `ultra-ui-qa`: playwright. `3d-intro-build` 의 독립 검증(`verify-intro.mjs`)도 Node 용 playwright 패키지와 Chromium 을 씁니다(`npm i -g playwright && npx playwright install chromium`).
  - `payload-mon`: OMC 커스텀 HUD 래퍼(`setup-omc-hud` 로 설치).
  - `omc-patch`: Node 18 이상과 `git`(OMC 마켓플레이스 고정과 확인에 사용).
  - `remains`: 테스트박스를 쓰려면 이 머신에 `ssh`, `scp`, `git`, 박스에 `tar` 와 시험에 필요한 런타임(예: Node)이 있어야 하고, SSH 키로 암호 없이 접속돼야 합니다.
  - `ultra-chain`: 위 OMC(Codex 는 OMX), 웹 조사 수단, 시각 검토의 캡처에는 Node 용 playwright 패키지와 Chromium, OS 시험에는 `remains` 와 같은 테스트박스 조건.
  - `/graceful-pause`: Claude Code 2.1.289 이상(mod). 그보다 오래된 Claude Code 는 명령을 등록하지 않고 한 줄로 알립니다. Codex 는 스킬 `$banker-graceful-pause` 입니다(0.144.5 에서 확인).
  - `/progress`: mod 를 지원하는 Claude Code(2.1.286 과 2.1.296 에서 확인). 작업 중 즉시 실행은 2.1.289 이상에서 확인했습니다. mod 가 없는 Claude Code(2.1.250 에서 확인)에서는 "mod 를 지원하지않는 claude code 버전입니다" 만 보이고 모델은 호출되지 않습니다. Codex 는 스킬 `$banker-progress` 입니다(상시 패널이 아니라 부를 때마다 보임, tmux 칸은 선택).
  - `teamwork`(Codex 전용): Node 18 이상, Codex 0.149.0 이상(`codex queue`), Linux 와 macOS. Windows 는 `on` 이 까닭을 밝히고 끝납니다. Codex 0.160.1 Windows 에서 승인 규칙 판정(`codex execpolicy check`)이 PowerShell 로 부르는 래퍼에는 맞지 않아(래퍼를 바로 부르는 꼴만 맞음) 쓸 때마다 승인을 물어야 하기 때문입니다. \
    처음 `on` 뒤 새 세션에서 훅을 한 번 신뢰합니다(Hooks need review). 엔진 판이 오르면 훅 명령의 해시가 바뀌어 한 번 다시 묻습니다. 설치 전부터 열려 있던 세션(`on` 을 돌린 세션 포함)은 다시 열어야 훅과 승인 규칙이 적용되고(그 전에는 `role`, `send`, `reply` 마다 승인을 물음), 훅을 신뢰하기 전에는 `codex exec` 가 멈출 수 있습니다. \
    승인 규칙은 래퍼의 `peers`, `role`, `send`, `reply`, `status`, `version` 만 허용하고 `on`, `off`, `uninstall` 은 승인을 받습니다. 래퍼와 훅은 샌드박스 밖에서 돌므로 `node`, `codex`, `ps`, `sh` 는 `on` 때 찾은 절대 경로만 쓰고, 임시 폴더, 작업 폴더와 그 git 저장소, `writable_roots` 아래의 프로그램과 Codex 홈은 거부합니다. `hooks.json` 은 banker 훅 설치와 같은 잠금과 같은 규칙(링크이거나 꼴이 다르면 바꾸지 않음)으로 고칩니다. 기록한 프로그램은 훅과 `send` 때마다 그 세션 기준으로 다시 봅니다. 피어 목록의 폴더는 훅이 기록한 세션 폴더만 제어 문자를 바꿔 보여 주고, `send --file` 은 그 세션 폴더와 임시 폴더 안의 파일만 읽습니다. `codex queue` 는 15초 시간 제한이 있습니다. \
    남은 위험: 샌드박스 안 세션이 저장소 파일의 지시를 받으면 `send` 로 같은 기기의 더 넓은 권한 세션에 사용자 턴을 넣을 수 있습니다. 받는 쪽 방어는 훅이 넣는 규칙(피어 본문은 데이터, 위험 동작은 그 세션 사용자 확인)과 피어 턴의 `send` 금지뿐입니다. 래퍼를 거치지 않은 `codex queue` 직접 호출로 머리말을 위조할 수 있는지는 재지 않았습니다. Codex 0.165.0 은 TUI 를 `/quit` 으로 닫아도 대화를 상주 서버에서 이어 가므로, 닫은 세션도 피어 목록에 남아 받은 요청을 화면 없이 처리합니다(목록에서 빠지는 것은 24시간 활동이 없을 때). \
    `banker uninstall --codex` 는 다른 banker 설치 길(사용자 범위 npm 스킬, Codex 플러그인)이 남아 있지 않을 때만 teamwork 도 지웁니다. 두 길이 모두 없어지면 훅은 멈추고 정리 명령을 한 번 안내합니다.
  - `lineage`: Python 3.7+ (표준 라이브러리만 사용). RHEL8/Rocky8은 기본 `python3` 가 3.6이라 `setup-python` 등으로 3.11을 설치해 지정해야 합니다.

## 업데이트 / 제거

**Claude Code:**

```bash
claude plugin update banker                       # 플러그인 최신화 (재시작 후 적용)
claude plugin marketplace update banker-plugins   # 마켓플레이스 메타 갱신
claude plugin uninstall banker                    # 제거
```

**npm · Codex:**

```bash
npm i -g @kaydash9999/banker-plugins   # 최신 버전 설치
banker setup                            # 재설치 (기존 banker-* 정리 후 클린 설치)
banker uninstall                        # 제거
```

Codex는 재설치할 때마다 기존 `banker-*` 를 먼저 정리하므로 옛 버전이 중복으로 남지 않습니다.

**Codex 플러그인:**

```bash
codex plugin marketplace upgrade banker-plugins   # 최신화 (Codex 가 세션 시작 때도 스스로 올림, 다시 열면 적용)
codex plugin remove banker@banker-plugins         # 제거
```

> Codex 플러그인 설치에서 `obsidizer --enable` 을 했다면, 제거 전에 obsidizer 의 Codex 절차대로 `hooks disable obsidize` 를 실행하세요.\
> 이 훅은 사용자 범위(`~/.codex/hooks.json`, `~/.codex/hooks-custom/banker/`)에 따로 있어서 `codex plugin remove` 로 지워지지 않고, 셸 호출마다 node 를 계속 띄웁니다.\
> 이미 지웠다면 `~/.codex/hooks.json` 에서 명령에 `hooks-custom/banker/hooks/obsidize-hook.mjs` 가 든 묶음을 지우고 `~/.codex/hooks-custom/banker/` 폴더를 지우면 됩니다.

> `payload-mon` 을 켰다면 제거 전에 `/banker:payload-mon off`(Codex는 `banker-payload-mon` 에 `off`)를 실행하세요.\
> 표시 블록과 모듈 사본은 플러그인 밖(`~/.claude/hud/`)에 있어서, 플러그인을 지워도 남아 계속 표시됩니다.\
> 이미 지웠다면 HUD를 재설치하거나, `omc-hud-custom.mjs` 에서 `// >>> payload-mon >>>` 부터 `// <<< payload-mon <<<` 까지 지우면 됩니다.

> `setup-omc-hud` 가 설치한 상태표시줄 래퍼와 설정도 플러그인 밖(`~/.claude/hud/`, `~/.claude/.omc/`)에 있어서, 플러그인을 지워도 남습니다.\
> 0.19.5 이하의 `setup-omc-hud` 가 옛 래퍼에 넣은 Claude 갱신 안내 블록은 제거 전에 `/banker:setup-omc-hud off` 로 뺄 수 있습니다.\
> 이미 지웠다면 HUD를 재설치하거나, `// >>> claude-update-last >>>` 부터 `// <<< claude-update-last <<<` 까지 지우면 됩니다. 블록을 남겨 두어도 상태표시줄은 깨지지 않습니다.

> `setup-bypass-permissions` 로 바꾼 권한 모드는 `settings.json`(Codex 대상은 `~/.codex/config.toml`)에 남아, 플러그인을 지워도 모든 세션에서 확인 없이 도구가 실행됩니다. 제거 전에 `/banker:setup-bypass-permissions off` 를 실행하세요(Codex 는 `$banker-setup-bypass-permissions off codex`).\
> 이미 지웠다면 설정 폴더(`$CLAUDE_CONFIG_DIR`, 없으면 `~/.claude`)의 `settings.json` 에서 `permissions.defaultMode` 를 지우거나 원래 값으로 되돌리면 됩니다. 옆의 `settings.json.bypass-permissions.bak` 과 `settings.json.bypass-permissions.json` 도 지우세요. 백업에는 설정의 비밀 값이 들어 있을 수 있습니다.\
> root 계정에서 이 모드 때문에 Claude Code 가 시작되지 않으면 `claude --permission-mode default` 로 시작한 뒤 `off` 를 실행하세요.

> `tone-compact` 를 켰다면 제거 전에 런타임마다 `off` 를 실행하세요(Claude Code `/banker:tone-compact off`, Codex `banker-tone-compact` 에 `off`).\
> 규칙 파일과 블록은 플러그인 밖(`~/.claude/rules/`, `~/.codex/AGENTS.md`)에 있어서, 플러그인을 지워도 남아 계속 적용됩니다.\
> 이미 지웠다면 `~/.claude/rules/banker-tone-compact.md` 를 지우고, AGENTS.md 에서 `<!-- banker:tone-compact:start -->` 부터 `<!-- banker:tone-compact:end -->` 까지와 그 바깥의 `USER:OMX:POLICY` 표시 두 줄을 지우면 됩니다.

> `anti-drm` 을 켰다면 제거 전에 런타임마다 `off` 를 실행하세요(Claude Code `/banker:anti-drm off`, Codex `banker-anti-drm` 에 `off`).\
> 규칙 파일과 블록은 플러그인 밖에 있어서, 플러그인을 지워도 남아 계속 적용됩니다.\
> 이미 지웠다면 `~/.claude/rules/banker-anti-drm.md` 를 지우고, AGENTS.md 에서 `<!-- banker:anti-drm:start -->` 부터 `<!-- banker:anti-drm:end -->` 까지와 그 바깥의 `USER:OMX:POLICY` 표시 두 줄을 지우면 됩니다. 설정 파일 `~/.config/banker/anti-drm.json` 과, 있으면 옆의 `anti-drm.json.bak` 도 지우세요.

> `omc-patch` 를 적용했다면 제거 전에 `/banker:omc-patch revert`(Codex는 `banker-omc-patch` 에 `revert`)를 실행하세요.\
> 훅 패치와 마켓플레이스 고정은 플러그인 밖(`~/.claude/plugins/`)에 있어서, 플러그인을 지워도 남고 OMC 도 계속 자동 업데이트되지 않습니다.\
> 이미 지웠다면 `~/.claude/plugins/marketplaces/omc` 의 origin 에서 `omc-pinned://` 를 뗀 주소로 `git remote set-url origin <주소>` 를 실행하고, 활성 버전 폴더의 `scripts/*.mjs.omcbak` 과 `hooks/hooks.json.omcbak` 을 원래 이름으로 되돌린 뒤 `~/.claude/omc-local-patches/PINNED` 를 지우면 됩니다.

> `remains` 의 테스트박스 등록 파일(`~/.config/banker/test-boxes.json`)은 플러그인 밖에 있어 제거해도 남습니다. 필요 없으면 직접 지우세요.

## 업데이트 확인 및 사용량 카운팅

banker는 기본값(default-on)으로 두 가지를 합니다.\
새 버전이 나오면 세션 시작 시 알려주는 **업데이트 알림**과, 유지보수자가 사용량을 파악하는 **익명 사용량 카운팅**입니다.\
이 때문에 `SessionStart`(알림 확인)·`PostToolUse`(모델이 자동 호출한 스킬 집계)·`UserPromptExpansion`(사용자가 직접 입력한 `/banker:*` 집계) 훅이 항상 등록되어 있고, 트리거될 때마다 짧게 node 프로세스를 하나씩 띄웁니다(수십 ms 수준).

업데이트 알림은 **개인화**됩니다.\
새 버전에서 바뀐 스킬 중 당신이 실제로 써 본 스킬이 있으면 그 이름을 알림에 넣어 보여줍니다("자주 쓰는 스킬이 이번 업데이트에서 바뀌었습니다: ...").\
이를 위해 써 본 스킬 이름만 로컬 파일(`used-skills.json`)에 모으며, 이 목록은 전송하지 않습니다(바뀐 스킬 목록만 공개 GitHub raw 에서 무페이로드 GET 으로 조회).\
개인화는 아래 두 opt-out 중 어느 쪽으로도 함께 꺼집니다.

끄기:

```bash
export BANKER_NO_UPDATE_CHECK=1   # 업데이트 알림 끄기(체크인 전송도 함께 멈춤)
export BANKER_NO_TELEMETRY=1      # 사용량 카운팅만 끄기
```

카운팅은 `banker telemetry off` 로도 끌 수 있습니다.\
플러그인은 기본 카운팅 엔드포인트(`banker.banker-plugins.workers.dev`)를 내장하므로 count-default-on 이라 설치 즉시 활성이며, `BANKER_TELEMETRY_ENDPOINT` 환경변수로 자가호스팅/override 할 수 있습니다.\
Codex CLI 에서는 `banker setup --codex` 가 같은 일을 Codex 훅 `SessionStart`(알림 확인)와 `Stop`(턴이 끝날 때 이번 턴에 쓴 banker 스킬 집계)으로 설치합니다. 도구 호출마다 돌지 않고 턴마다 한 번 돕니다. \
Codex 를 다시 열 때 Hooks need review 창이나 `/hooks` 에서 신뢰해야 돌고, 훅은 Codex 샌드박스 밖에서 돌므로 샌드박스가 네트워크를 막아도 동작합니다. 끄는 방법은 같습니다.

무엇을 수집하고 누가 수신하는지는 [PRIVACY.md](PRIVACY.md)에 정리했습니다.

### 공개 대시보드 · 엔드포인트

카운팅 워커(`banker.banker-plugins.workers.dev`)는 다음 공개 엔드포인트를 제공합니다.

| URL | 내용 |
|---|---|
| <https://banker.banker-plugins.workers.dev/> | 사용량 대시보드 (npm 다운로드 지표 + 스킬 사용 집계 차트) |
| <https://banker.banker-plugins.workers.dev/stats> | 집계 데이터 JSON |
| <https://banker.banker-plugins.workers.dev/health> | 헬스 체크 (`ok`) |

## 오프라인에서 쓰기

네트워크가 없는 곳에서도 banker 를 설치하고 쓸 수 있습니다.\
설치는 네트워크가 되는 곳에서 받은 묶음 하나로 끝납니다. banker 는 의존성이 없어 더 받을 것이 없습니다.

```bash
npm pack @kaydash9999/banker-plugins              # 네트워크가 되는 곳에서. kaydash9999-banker-plugins-<판>.tgz 가 생김
npm i -g ./kaydash9999-banker-plugins-<판>.tgz     # 옮긴 뒤
banker setup
```

- Codex 플러그인 설치(`codex plugin add`)는 GitHub 에서 저장소를 받으므로 네트워크가 필요합니다. 오프라인에서는 위의 npm 묶음으로 `banker setup --codex` 를 씁니다.
- 세션 시작 훅의 업데이트 조회와 체크인은 따로 돌아 세션을 기다리게 하지 않습니다. 실패하면 24시간 동안 다시 시도하지 않고, 아예 시도하지 않게 하려면 `BANKER_NO_UPDATE_CHECK=1` 을 둡니다.
- 훅은 `HTTPS_PROXY`, `HTTP_PROXY` 를 따르지 않습니다(Node 가 `NODE_USE_ENV_PROXY=1` 일 때만 따름). 프록시를 거쳐야만 밖에 닿는 망에서는 훅의 확인이 실패로 기록됩니다(`banker telemetry status` 의 "마지막 시도").
- 네트워크가 필요한 스킬과 네트워크 없이 끝나는 모습
  - 내려받는 설치 스킬(`setup-omc-hud`, `setup-bypass-permissions` 를 뺀 `setup-*`, `docs-setup`, `vertical-pptx-setup`, `motion-graphic-setup`, `3d-intro-setup`): 웹 원천(npm, PyPI, GitHub 등)은 먼저 닿는지 보고, 닿지 못하면 받지 않고 "오프라인이라 설치하지 않음" 으로 알립니다. OS 패키지 관리자(dnf, apt, brew, winget)의 단계는 그 관리자의 미러 설정을 따르므로 미리 판정하지 않고 시도합니다. 단 `setup-pwsh` 는 winget 이 유일한 원천이라 그 원천을 먼저 봅니다.
  - `update-banker`: 레지스트리에 닿지 못하면 어느 채널도 바꾸지 않고 멈춥니다.
  - `audit-security` 의 의존성 취약점 조회: 결과로 읽을 수 없는 도구는 0건이 아니라 "미커버" 로 적습니다.
  - `deep-research`, `lfm`, 이를 부르는 `ultra-chain` 1단계, `ultra-interview` 와 `rfp-author` 의 조사: 웹 도구가 모두 실패하면 조사하지 못했다고 알립니다. `lfm` 은 모델이 아는 관행으로 표를 채우지 않고 "웹 조사 불가" 로 끝납니다.
  - `npx` 로 부르는 도구(`motion-graphic-make` 의 hyperframes 등): 전역 설치가 없으면 패키지를 받으려 해, 네트워크가 없으면 약 70초 뒤 실패합니다. 오프라인에서는 전역 설치한 실행 파일을 부릅니다.
  - 유료 API 를 부르는 `3d-intro-build`(요청마다 시간 제한), `ralph-qa` 의 외부 좌석(codex, gemini, opencode, 좌석마다 600초)
  - `vertical-pptx`, `pdf-vision-extract` 가 빠진 도구를 설치하라고 안내할 때, `nothing-design` 의 글꼴(Google Fonts. 받지 못하면 대체 글꼴로 보임)
- 네트워크를 쓰지 않는 스킬(예: `lineage`, `setup-omc-hud`, `tone-compact`, `anti-drm`, `payload-mon`)은 네트워크 없이 그대로 씁니다.

## 라이선스 / 서드파티

banker 자체는 **MIT** ([LICENSE](LICENSE)). Owner: [smallOpenSource](https://github.com/smallOpenSource).

**번들된 코드와 데이터 (이 패키지가 재배포)**
- `skills/humanizer`: [blader/humanizer](https://github.com/blader/humanizer) 기반, **MIT License**(© 2025 Siqi Chen).\
  원본 라이선스 고지는 `skills/humanizer/LICENSE` 에 포함.\
  패턴 목록은 Wikipedia [*Signs of AI writing*](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing)(WikiProject AI Cleanup, **CC BY-SA**)에 기반합니다.
- `skills/3d-intro-build/references`: [oso95/scroll-world](https://github.com/oso95/scroll-world) 의 스크럽 엔진(`scrub-engine.js`·`index-template.html`)을 그대로 벤더링, **MIT License**(© 2026 cyw).\
  원본 라이선스 고지는 `skills/3d-intro-build/references/LICENSE` 와 `NOTICE.md` 에 포함.
- `skills/setup-omc-hud/assets`: 상태표시줄 래퍼와 설치 스크립트는 [smallOpenSource/omc_hud](https://github.com/smallOpenSource/omc_hud) d3cedd5 를 고친 것, **MIT License**(© 2026 smallOpenSource).\
  원본 라이선스 고지는 `skills/setup-omc-hud/assets/LICENSE-omc_hud` 에 포함.
- `skills/theme-selection/assets`: 번들 팔레트(`palettes.json`)는 [VoltAgent/awesome-design-md](https://github.com/VoltAgent/awesome-design-md) 의 DESIGN.md 에서 색 값을 읽어 만든 것, **MIT License**(© 2026 VoltAgent).\
  원본 라이선스 고지는 `skills/theme-selection/assets/LICENSE` 와 `NOTICE.md` 에 포함.\
  테마 이름의 상표는 각 소유자에게 있으며, banker 는 그 회사들과 관계가 없습니다.

코드로 포함(재배포)하는 서드파티는 `humanizer` 와 `scroll-world`(`3d-intro-build`) 둘이고, 데이터로 포함하는 것은 `awesome-design-md`(`theme-selection`) 하나입니다.\
아래는 스킬이 **런타임에 의존하거나 연동**하는 외부 요소로, banker 가 재배포하지 않으며 각 라이선스·상표는 소유자에게 있습니다.

**의존 라이브러리·도구 (사용 시 별도 설치, 라이선스는 각 프로젝트 소유)**

| 분류 | 도구 | 라이선스 | 사용 스킬 |
|---|---|---|---|
| Python | python-pptx | MIT | `arch-diagram` · `vertical-pptx` |
| Node | pptxgenjs | MIT | `vertical-pptx` |
| Node | Playwright | Apache-2.0 | `3d-intro-build`(독립 검증, `verify-intro.mjs`) |
| Python | python-docx | MIT | `rfp-author` |
| Python | Playwright | Apache-2.0 | `audit-web-page`·`play-qa`·`ultra-ui-qa` |
| Python | detect-secrets | Apache-2.0 | `lineage`(시크릿 스캔) |
| 브라우저·렌더링 | Chromium | BSD-3-Clause | `setup-playwright`·브라우저 QA |
| 브라우저·렌더링 | SwiftShader | Apache-2.0 | `setup-playwright`·브라우저 QA |
| 브라우저·렌더링 | Xvfb·X.Org | MIT | `setup-playwright`·브라우저 QA |
| 문서·다이어그램 | PlantUML | GPL 계열·다중 라이선스 | `arch-diagram` |
| 문서·다이어그램 | Poppler(`pdftoppm`) | GPL | `pdf-vision-extract` |
| 문서·다이어그램 | ImageMagick | ImageMagick License | `pdf-vision-extract` |
| 개발환경·LSP | Node.js·nvm | MIT | `setup-node` |
| 개발환경·LSP | uv | Apache-2.0/MIT | `setup-python` |
| 개발환경·LSP | OpenJDK·Temurin | GPL+CE | `setup-java` |
| 개발환경·LSP | jdtls | EPL-2.0 | `setup-lsp` |
| 개발환경·LSP | basedpyright·bash-language-server | MIT | `setup-lsp` |
| 개발환경·LSP | vtsls·vscode-langservers-extracted | 각 프로젝트 | `setup-lsp` |
| 개발환경·LSP | lsp-mcp([CesarPetrescu/lsp-mcp](https://github.com/CesarPetrescu/lsp-mcp)) | 각 프로젝트 | `setup-lsp` |
| 개발환경·LSP | tmux | ISC | `setup-tmux` |
| 개발환경·LSP | psmux | 각 프로젝트 | `setup-tmux` |
| 개발환경·LSP | bubblewrap | LGPL-2.0 | `setup-sandbox` |
| 개발환경·LSP | rustup | 각 프로젝트 | `setup-sandbox` |
| 미디어·영상 | hyperframes (HeyGen) | Apache-2.0 | `motion-graphic-setup`·`motion-graphic-make` |
| 미디어·영상 | ffmpeg | LGPL-2.1+/GPL | `motion-graphic-setup`·`motion-graphic-make`·`3d-intro-setup`·`3d-intro-build` |

**연동·참조 (외부 프레임워크·서비스·브랜드, banker 는 재배포하지 않음)**

| 분류 | 항목 | 라이선스 | 사용/설치 스킬 |
|---|---|---|---|
| 프레임워크 | oh-my-claudecode(OMC)·oh-my-codex(OMX), by [Yeachan-Heo](https://github.com/Yeachan-Heo) | MIT | `all-in-one`·`ultra-chain`·`ultra-init`·`/banker:front-qa`·`setup-omc`·`ultraqa`(OMX ultraqa 를 본뜸, `skills/ultraqa/NOTICE.md`) |
| 플러그인 | insane-search (© fivetaku, [fivetaku/gptaku_plugins](https://github.com/fivetaku/gptaku_plugins)) | MIT | `setup-insane-search` |
| 팀 아키텍처 팩토리 | revfactory/harness (© Minho Hwang, [revfactory/harness](https://github.com/revfactory/harness)) · Codex 포트 SaehwanPark/meta-harness | Apache-2.0 | `setup-harness-factory`(설치·구성만 안내) |
| 서비스(독점·상표) | Notion | 독점 | `make-notion-guide` |
| 서비스(독점·상표) | Google Stitch | 독점 | `setup-stitch` |
| 디자인(상표) | Nothing 디자인 언어 | 상표 | `nothing-design` |
| QA 엔진(예시) | Godot·Phaser 등 | MIT | `play-qa` |
| 서비스(독점·상표) | Microsoft Azure OpenAI (Sora-2·gpt-image-2·FLUX.2-pro) | 독점 | `3d-intro-setup`·`3d-intro-build` |
| 서비스(독점·상표) | Alibaba Cloud Model Studio (WAN 영상 모델) | 독점 | `3d-intro-setup`·`3d-intro-build` |
