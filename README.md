# banker-plugins

> Claude Code와 Codex CLI를 위한 QA·감사·문서·아키텍처·위키·미디어 스킬 모음.

[![npm](https://img.shields.io/npm/v/@kaydash9999/banker-plugins)](https://www.npmjs.com/package/@kaydash9999/banker-plugins)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![npm downloads](https://img.shields.io/npm/dm/@kaydash9999/banker-plugins)](https://www.npmjs.com/package/@kaydash9999/banker-plugins) [![GitHub stars](https://img.shields.io/github/stars/smallOpenSource/banker_plugins)](https://github.com/smallOpenSource/banker_plugins)

[빠른 시작](#빠른-시작) · [워크플로 예시](#워크플로-사용-예시) · [구성](#구성) · [설치 상세](#설치-상세-npm--codex) · [설정 변경 지점](#설정-변경-지점-claude-code--codex) · [요구사항](#요구사항) · [업데이트 / 제거](#업데이트--제거) · [업데이트 확인](#업데이트-확인-및-사용량-카운팅) · [라이선스 / 서드파티](#라이선스--서드파티)

banker는 QA·보안 감사·문서·아키텍처·위키·미디어 작업과 의존성·개발환경(OS별) 설치를 아우르는 **스킬 60개 + 커맨드 2개**(총 62개 구성요소)와 Claude Code 즉시 명령 `/graceful-pause`, `/progress` 를 묶은 Claude Code 플러그인입니다.\
설치하면 스킬과 커맨드가 `/banker:<이름>` 네임스페이스로 노출됩니다.\
이 저장소 자체가 Claude Code 마켓플레이스(`.claude-plugin/marketplace.json`)이자 플러그인(`.claude-plugin/plugin.json`, name `banker`)이며, 도구에 무관한 스킬은 Codex CLI에도 설치됩니다.

> npm 패키지(`@kaydash9999/banker-plugins`)와 GitHub 저장소(`smallOpenSource/banker_plugins`)는 같은 메인테이너가 관리합니다.

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

**Codex CLI:** npm 전역 설치 후 `banker setup`

```bash
npm i -g @kaydash9999/banker-plugins
banker setup --codex
```

스킬을 `banker-audit-security` 처럼 `banker-<name>` 으로 호출합니다.

playwright(브라우저 QA)나 oh-my-claudecode(OMC/OMX)처럼 별도 의존성이 필요한 스킬은 실행 전에 설치부터 안내합니다(Claude Code는 `/banker:setup`).

## 워크플로 사용 예시

무엇부터 써야 할지 막막할 때, 상황별로 골라 쓰는 대표 워크플로입니다.\
Claude Code는 `/banker:<이름>`, Codex는 `banker-<이름>` 으로 호출합니다.

| 워크플로 | 언제 쓰나 | 하는 일 |
|---|---|---|
| `ultra-interview` | 처음 프로젝트 아이디어를 구체화할 때 | 최신 정보를 반영한 소크라테스식 인터뷰 |
| `ultra-init` | 프로젝트 기획이 충분히 구체적일 때 | 데모를 구현 |
| `curation` | 질문에 답하기 어렵거나 의사결정이 어려울 때 | 합리적 선택지 제공 (`--perf` = 품질 우선, `--deep` = 확신 0.80 초과까지 추가 조사) |
| `all-in-one` | 요건이 명확한 단계에서 | 계획 → 구현 → 검증 |
| `ralph-qa` | 검증이 충분하지 않을 때 | 세션 모델로 띄운 독립 검토 에이전트 3개 이상의 합의 루프 (+ 플래그로 고른 CLI 좌석) |
| `smart-compact` | 컨텍스트 임계 초과로 맥락 단절이 걱정될 때 | 맥락을 더 잘 이어서 진행 |
| `refresh-readme` | 프로젝트 배포 전 | README 최신화 |
| `summary-wiki` | Agent가 아는 정보를 확인하고 싶을 때 | 요약 리포트 |
| `cleansing-memory` | 프로젝트가 장기화될 때 | 메모리 최적화 |
| `ready-compact` | 컨텍스트를 compact 하거나 새 세션을 대비할 때 | 이어갈 프롬프트만 출력(`/copy` 한 번이면 복사), `--hand-off` = 새 세션에서 이어가기 |
| `/graceful-pause` | 작업 도중 방향을 바꾸거나 끼어들고 싶을 때 | 작업 중에 입력해도 바로 전달. 실행 중인 도구 호출이 끝나면 그 단계까지만 마무리하고 멈춘 뒤 지시를 기다림 (Claude Code) |
| `/progress` | 지금 작업이 어디까지 왔는지 보고 싶을 때 | 진행 단계 목록 패널을 켜고 끔. 단계를 누르면 설명, 화살표를 누르면 그 단계가 진행 중일 때 한 도구 호출이 펼쳐짐 (Claude Code) |
| `tone-compact` | 답변을 짧은 한글 개조식으로 받고 싶을 때 | 문체 규칙을 켜 두면 끌 때까지 모든 세션에 적용 |
| `omc-patch` | OMC 자동 업데이트 뒤 훅이 느려지거나 훅 프로세스가 쌓일 때 | 사라진 훅 패치를 다시 적용하고 OMC 자동 업데이트를 고정 |
| `remains` | 작업 뒤에 남은 버그, 하자, 미검증 항목을 한눈에 보고 싶을 때 | 남은 항목을 표로 정리하고, 등록한 테스트박스에서 시험까지 돌림 |
| `trouble-shooting` | 문제가 생겨 원인과 해결방법을 정리해야 할 때 | 현상, 문제점, 원인, 해결방법, 조치계획을 표로 간결히 보고(`--no-plan` 은 해결방법까지) |

## 구성

### 커맨드

| 커맨드 | 설명 |
|---|---|
| `/banker:front-qa` | 스펙(note) 기반 프론트엔드 구현 + parity QA |
| `/banker:setup` | 구성요소·의존성 설치 오케스트레이터 (multi-select) |
| `/graceful-pause` | 작업 중에도 바로 실행되는 정지 요청. 지금 단계만 끝내고 멈춘 뒤 보고하고 지시를 기다림 (Claude Code 2.1.289 이상, mod. Codex 미지원) |
| `/progress` | 진행 상황 패널을 켜고 끔(`show` 기본 토글, `on`, `off`). 단계는 Claude 의 작업 목록, 없으면 이 세션의 요청이고, 하위 목록은 그 단계가 진행 중일 때 한 도구 호출 한 단계까지. 작업 중에도 바로 실행됨(2.1.289 이상에서 확인) (mod. Codex 미지원) |

`/graceful-pause` 와 `/progress` 는 Claude Code 의 mod(Claude Mods, 얼리 액세스 이름 function hooks, `hooks/register.mjs`)로 등록되는 명령이라 구성요소 수에 넣지 않습니다. `commands/progress.md` 도 넣지 않습니다. 이 파일은 mod 가 없는 Claude Code 에서 `/progress` 를 받아 "mod 를 지원하지않는 claude code 버전입니다" 만 보여 주는 대체 명령이고, mod 가 있으면 mod 가 대신 처리합니다.

### 스킬: QA · 감사

| 스킬 | 설명 |
|---|---|
| `audit-security` | 보안 취약점(CVE·SAST·시크릿) 진단 (read-only) |
| `audit-mock` | 하드코딩·mock/stub·열거형 정적 검출 (read-only) |
| `audit-web-page` | 라이브 웹 페이지 점검 (playwright·WebGL 캔버스) |
| `play-qa` | Godot HTML5까지 포함한 웹 환경 직접 플레이 QA |
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
| `rfp-author` | 외주 제안요청서(RFP) 저작 (범용 프레임워크) |
| `humanizer` | AI 글 흔적 제거(자연스러운 문체로 윤문) |
| `lineage` | 세션 대화를 카카오톡 스타일 단일 HTML로 export. 세션 모델이 턴마다 1줄 요약을 쓰고 남길 턴을 고름(`--rulebase` 는 규칙만), 마크다운 렌더, 다중 세션 병합 |
| `append_wiki` | 프로젝트 위키 문서 추가/보강 |
| `compact-wiki` | 위키 중복 제거·supersede·병합 (무손실) |
| `obsidizer` | AI 위키를 의미보존 Obsidian 그래프로 정규화·상호링크·백링크 |
| `deep-init` | 코드베이스 전체에 계층형 AGENTS.md 문서 생성/갱신 |

> `obsidizer` 는 banker 최초의 플러그인 선언 hook(`hooks/hooks.json`)을 함께 설치합니다.\
> banker가 활성화되어 있으면 이 hook은 **항상 등록**되어 위키 쓰기(`wiki_ingest`/`wiki_add`)마다 node 프로세스를 띄웁니다(플래그 확인이 그 안에서 일어나므로 `--enable` 전에도 쓰기당 약 30ms).\
> `--enable` 전에는 아무것도 쓰지 않는 순수 no-op입니다.

### 스킬: 워크플로 · 유틸

| 스킬 | 설명 |
|---|---|
| `all-in-one` | 계획→구현→검증 end-to-end 오케스트레이터 |
| `ultra-init` | 아이디어→빌드→테스트 원샷 자동 실행 |
| `ready-compact` | 이어가기 상태 저장 + resume 프롬프트만 출력(`--hand-off` = 새 세션용 자급식 노트·프롬프트) |
| `compact-copy` | 설명·코드펜스가 섞인 resume 프롬프트 출력에서 본문만 추출(지금의 ready-compact 는 처음부터 프롬프트만 출력) |
| `refresh-git-ignore` | `.gitignore` 비파괴·반복가능 갱신 |
| `omc-reference` | OMC/OMX 에이전트·툴·스킬 레퍼런스(양 런타임 병기) |
| `curation` | 의사결정을 선택지·권고·확신수준으로 큐레이션(--perf=품질 우선, --deep=확신 0.80 이하는 추가 조사·검토 후 제시) |
| `ralph-qa` | 세션 모델로 띄운 독립 검토 에이전트 3개 이상이 합의할 때까지 검증 반복. `--codex`·`--gemini`·`--opencode` 를 주면 그 CLI 에서 가장 뛰어난 모델이 좌석으로 합류 |
| `smart-compact` | 컨텍스트 임계 초과 시 위키·resume 저장 게이트 자동 무장 |
| `deep-research` | 다중 소스 팬아웃 + 적대적 검증 인용 리서치 |
| `ultra-interview` | 리서치 선행으로 사람 질문 최소화, 모호성 3% 이하까지 인터뷰 |
| `interval-report` | 장기 수행 중간 보고를 `docs/intermission.md` 로 갱신(경과·잔여·단일 표) |
| `summary-wiki` | 위키를 `docs/` 단일 파일 개조식으로 요약(지식 동기화 검토용, 읽기 전용) |
| `update-banker` | 설치된 banker 를 3채널(Claude·npm·Codex) 순서 게이트로 최신화 |
| `refresh-readme` | 코드와 어긋난 README 를 현재 상태에 맞게 갱신(드리프트 해소) |
| `cleansing-memory` | 메모리 파일을 문서화된 threshold 내로 정리(중복 최신본화·무손실 압축) |
| `payload-mon` | 상태표시줄 ctx 옆에 요청 payload 추정치(32MB 한도 대비, 8MB부터) 표시 켜기·끄기 |
| `tone-compact` | 답변과 새 문서를 ASD-STE100 기반 한글 개조식(표·목록·원어 발음 표기·장식 기호 금지)으로 쓰는 문체 규칙 켜기·끄기(on 기본, 끌 때까지 유지) |
| `omc-patch` | OMC 자동 업데이트 뒤 사라진 훅 패치를 재적용하고 OMC 마켓플레이스 자동 업데이트를 고정(진단·확인·적용·검증·되돌리기) |
| `remains` | 남은 버그, 하자, 미검증 항목을 찾아 표로 보여 줌. 테스트박스(`~/.config/banker/test-boxes.json`)가 등록돼 있으면 각 OS 에서 시험을 돌려 확인(읽기와 시험만, 고치지 않음) |
| `trouble-shooting` | 문제를 조사해 현상, 문제점, 원인, 해결방법, 조치계획을 표 하나로 간결히 보고(문제마다 한 행, `--no-plan` 은 해결방법까지, 고치지 않고 보고만) |

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
| `setup-omc-hud` | omc_hud 상태표시줄 (OS별). Claude 갱신 안내는 줄 맨 끝 |
| `setup-insane-search` | insane-search 플러그인 설치 (Claude·Codex) |
| `setup-stitch` | Stitch 디자인 MCP 프록시 등록(RockyLinux8 proxy) |
| `docs-setup` | arch-diagram·pdf-vision-extract 의존성(pptx·pymupdf·plantuml) 설치 |
| `vertical-pptx-setup` | vertical-pptx 의존성(pptxgenjs·python-pptx) + 시각 검증용 LibreOffice (OS·권한 적응형) |
| `motion-graphic-setup` | hyperframes(무료 모션 그래픽 CLI) 전제조건 설치 (Node≥22 + ffmpeg) |
| `3d-intro-setup` | 3D 인트로용 Azure·WAN 크레덴셜·의존성 설치 + 무과금 프리플라이트 (Node/ffmpeg) |
| `setup-bypass-permissions` | Claude Code 기본 권한 모드를 `bypassPermissions` 로 바꿔 모든 세션에서 도구 실행 확인을 끔. 사용자가 직접 입력해야 실행(모델은 호출 불가), 위험 경고와 확인 뒤 적용, `off` 로 원복. `/banker:setup` 에서는 기본 미선택 |

## 설치 상세 (npm · Codex)

마켓플레이스 대신 npm으로 전역 설치할 수 있고, Codex CLI에도 스킬을 설치할 수 있습니다.\
Codex 설치는 npm 전역 설치가 선행되어야 합니다.

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
- Codex에는 스킬 60개가 `~/.codex/skills/banker-<name>/` 에, 커맨드 2개가 `~/.codex/prompts/banker-<name>.md` 에 설치됩니다(`codex/manifest.json`). \
  디렉터리명과 일치하도록 프론트매터 `name:` 이 `banker-<name>` 으로 재작성되어 Codex가 `banker-<name>` 으로 인식합니다.
- OMC/Claude 에 결합됐던 오케스트레이터·설치·유틸 표면(all-in-one·ultra-init·front-qa·setup·setup-omc·setup-omc-hud·setup-stitch·omc-reference·compact-copy)은 본문이 **런타임 인식**이라 Codex에서도 동작합니다.
- `payload-mon` 은 Codex에서 실행해도 같은 머신의 Claude Code HUD 래퍼만 켜고 끕니다. \
  32MB 요청 한도는 Claude Code 의 것이라 Codex 자신의 요청 크기는 재지 않습니다.
- `omc-patch` 도 Codex에서 실행하면 같은 머신의 Claude Code OMC 플러그인 캐시(`~/.claude/plugins/`)만 다룹니다. Codex 의 OMX 는 건드리지 않습니다.
- Codex에선 OMC 대신 **oh-my-codex(OMX)** 의 동명 스킬(ralplan·ralph·ultraqa·hud 등)과 `codex mcp`·내장 `/copy` 를 사용합니다(Codex는 `omx setup` 전제).
- OMC 5 는 `ultraqa` 를 삭제했습니다. 그래서 Claude Code 의 `all-in-one`·`ultra-init` QA 게이트는 `verify` 순환으로 돌고, Codex 는 OMX `ultraqa` 를 그대로 씁니다.
- 설치기는 `~/.codex/AGENTS.md` 를 건드리지 않습니다(omx가 재생성하므로 `~/.codex/skills/` 자동 검색에 의존). \
  예외는 사용자가 켠 `tone-compact` 하나입니다. 그 파일 끝에 `USER:OMX:POLICY` 로 감싼 블록 1개를 넣고, `off` 로 뺍니다. \
  `omx setup --merge-agents` 와 기본 `omx setup` 은 이 블록을 남깁니다. `--force` 나 team 모드를 끈 `omx setup` 처럼 AGENTS.md 를 새로 만들면 사라지므로, 그 뒤 `on` 을 다시 실행합니다.

## 설정 변경 지점 (Claude Code · Codex)

이 플러그인이 두 런타임의 설정·설치 상태를 건드리는 지점을 한눈에 정리했습니다.\
아래 파일 패치는 모두 기존 키를 병합·래핑·백업만 하며 덮어쓰지 않습니다.

**설치·제거 — `banker` CLI (결정론적)**

| 런타임 | 대상 | 동작 |
|---|---|---|
| Claude Code | 플러그인 레지스트리 | `claude plugin marketplace add` + 설치 → `/banker:*` (`settings.json` 직접수정 없음) |
| Codex CLI | `~/.codex/skills/banker-*/`, `~/.codex/prompts/banker-*.md` | 기존 `banker-*` 정리 후 복사(멱등). `AGENTS.md`·`config.toml` 미변경 |

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
| `setup-omc-hud` | `statusLine` + `hud/omc-hud-custom.mjs` 에 Claude 갱신 안내를 줄 맨 끝으로 옮기는 블록 1개(`.claude-update-last.bak` 백업·멱등·`node --check` 검증, `off` 로 원복) | — (Codex는 OMX `hud`) |
| `setup-pwsh` | `env.CLAUDE_CODE_GIT_BASH_PATH` (병합) | — (네이티브 셸, 배선 불필요) |
| `setup-harness-factory` | `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` (env 영속) | — |
| `smart-compact` | `statusLine.command` 래핑 + `UserPromptSubmit` 훅 추가 (백업·멱등) | `~/.codex/` 대응 |
| `payload-mon` | `hud/omc-hud-custom.mjs` 에 표시 블록 1개 삽입(`.payload-mon.bak` 백업·멱등·`node --check` 검증) + 래퍼 옆 `hud/payload-mon/` 에 모듈 사본 (`off` 로 원복) | — (Codex에서 실행해도 Claude Code HUD 만 다룸) |
| `tone-compact` | `rules/banker-tone-compact.md` 생성 (`off` 로 삭제) | `AGENTS.md`(내용이 있는 `AGENTS.override.md` 우선) 끝에 `USER:OMX:POLICY` 로 감싼 블록 1개(`.tone-compact.bak` 백업·멱등, `off` 로 원복) |
| `omc-patch` | 활성 OMC 버전의 `scripts/*.mjs` 와 `hooks/hooks.json` 수정(`.omcbak` 백업, `PostToolUse` 훅 제거) + OMC 마켓플레이스 `origin` 을 `omc-pinned://` 로 고정(기록 `~/.claude/omc-local-patches/PINNED`, `revert` 로 원복) | — (Codex에서 실행해도 Claude Code 의 OMC 캐시만 다룸) |
| `remains` | 설정 파일 미변경. `~/.config/banker/test-boxes.json` 은 읽기만 함(사용자가 만들거나, 사용자가 준 정보로 확인받고 만듦). 처음 접속하는 박스의 호스트 키가 `~/.ssh/known_hosts` 에 더해짐. 테스트박스에는 임시 폴더를 만들고 끝나면 지움(시간 초과나 중단 때는 시작한 프로세스를 먼저 끝냄, 못 지우면 결과에 표시) | 동일 |
| `motion-graphic-setup` | 설정 파일 미패치 (Node/ffmpeg 확보 + `npx hyperframes` 설치만) | 동일 (`config.toml` 미변경) |
| `3d-intro-setup` | `settings.json` 미패치 — 크레덴셜을 untracked env 파일에 기록(`.env.3d-intro.local` 또는 `~/.config/banker/3d-intro/env`) | 동일 (`config.toml` 미변경) |
| `setup-bypass-permissions` | `permissions.defaultMode` = `bypassPermissions` (켜기 전 내용은 `settings.json.bypass-permissions.bak`, 되돌리기 기록은 `settings.json.bypass-permissions.json`, `off` 로 원복. 관리 정책, 설정 파일의 금지 키, root 계정이면 거부) | Codex 에서 실행해도 같은 머신의 Claude Code 설정을 바꿈 (Codex 승인 정책은 미변경) |

`obsidizer` 는 `settings.json` 대신 `<위키디렉터리>/.obsidizer` 플래그 파일로만 켜고 끕니다.

## 요구사항

- Claude Code (마켓플레이스 경로): 스킬이 `/banker:*` 로 동작.
- 또는 Node.js ≥ 16.7 (npm 전역 설치 경로): `banker` CLI 제공.
- 일부 스킬은 별도 의존성이 필요하며 `/banker:setup` 으로 설치합니다. 의존성이 없으면 각 스킬이 실행 전에 설치부터 안내합니다.
  - `all-in-one`, `ultra-init`, `/banker:front-qa`: oh-my-claudecode(OMC) 5 와 같은 버전대의 `omc` CLI(`ralph` 가 `omc ralph verify` 를 부르므로 4.x CLI 로는 멈춤). Codex에서는 OMX.
  - `audit-web-page`, `play-qa`, `ultra-ui-qa`: playwright. `3d-intro-build` 의 독립 검증(`verify-intro.mjs`)도 Node 용 playwright 와 Chromium 을 씁니다.
  - `payload-mon`: OMC 커스텀 HUD 래퍼(`setup-omc-hud` 로 설치).
  - `omc-patch`: Node 18 이상과 `git`(OMC 마켓플레이스 고정과 확인에 사용).
  - `remains`: 테스트박스를 쓰려면 이 머신에 `ssh`, `scp`, `git`, 박스에 `tar` 와 시험에 필요한 런타임(예: Node)이 있어야 하고, SSH 키로 암호 없이 접속돼야 합니다.
  - `/graceful-pause`: Claude Code 2.1.289 이상(mod). 그보다 오래된 Claude Code 는 명령을 등록하지 않고 한 줄로 알리며, Codex 에는 이 명령이 없습니다.
  - `/progress`: mod 를 지원하는 Claude Code(2.1.286 과 2.1.296 에서 확인). 작업 중 즉시 실행은 2.1.289 이상에서 확인했습니다. mod 가 없는 Claude Code(2.1.250 에서 확인)에서는 "mod 를 지원하지않는 claude code 버전입니다" 만 보이고 모델은 호출되지 않습니다. Codex 에는 이 명령이 없습니다.
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

> `payload-mon` 을 켰다면 제거 전에 `/banker:payload-mon off`(Codex는 `banker-payload-mon` 에 `off`)를 실행하세요.\
> 표시 블록과 모듈 사본은 플러그인 밖(`~/.claude/hud/`)에 있어서, 플러그인을 지워도 남아 계속 표시됩니다.\
> 이미 지웠다면 HUD를 재설치하거나, `omc-hud-custom.mjs` 에서 `// >>> payload-mon >>>` 부터 `// <<< payload-mon <<<` 까지 지우면 됩니다.

> `setup-omc-hud` 가 넣은 Claude 갱신 안내 블록도 플러그인 밖(`~/.claude/hud/omc-hud-custom.mjs`)에 남습니다. 원래 순서로 되돌리려면 제거 전에 `/banker:setup-omc-hud off` 를 실행하세요.\
> 이미 지웠다면 HUD를 재설치하거나, `// >>> claude-update-last >>>` 부터 `// <<< claude-update-last <<<` 까지 지우면 됩니다. 블록을 남겨 두어도 상태표시줄은 깨지지 않습니다.

> `setup-bypass-permissions` 로 바꾼 권한 모드는 `settings.json` 에 남아, 플러그인을 지워도 모든 세션에서 확인 없이 도구가 실행됩니다. 제거 전에 `/banker:setup-bypass-permissions off` 를 실행하세요.\
> 이미 지웠다면 설정 폴더(`$CLAUDE_CONFIG_DIR`, 없으면 `~/.claude`)의 `settings.json` 에서 `permissions.defaultMode` 를 지우거나 원래 값으로 되돌리면 됩니다. 옆의 `settings.json.bypass-permissions.bak` 과 `settings.json.bypass-permissions.json` 도 지우세요. 백업에는 설정의 비밀 값이 들어 있을 수 있습니다.\
> root 계정에서 이 모드 때문에 Claude Code 가 시작되지 않으면 `claude --permission-mode default` 로 시작한 뒤 `off` 를 실행하세요.

> `tone-compact` 를 켰다면 제거 전에 런타임마다 `off` 를 실행하세요(Claude Code `/banker:tone-compact off`, Codex `banker-tone-compact` 에 `off`).\
> 규칙 파일과 블록은 플러그인 밖(`~/.claude/rules/`, `~/.codex/AGENTS.md`)에 있어서, 플러그인을 지워도 남아 계속 적용됩니다.\
> 이미 지웠다면 `~/.claude/rules/banker-tone-compact.md` 를 지우고, AGENTS.md 에서 `<!-- banker:tone-compact:start -->` 부터 `<!-- banker:tone-compact:end -->` 까지와 그 바깥의 `USER:OMX:POLICY` 표시 두 줄을 지우면 됩니다.

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
export BANKER_NO_UPDATE_CHECK=1   # 업데이트 알림만 끄기
export BANKER_NO_TELEMETRY=1      # 사용량 카운팅만 끄기
```

카운팅은 `banker telemetry off` 로도 끌 수 있습니다.\
플러그인은 기본 카운팅 엔드포인트(`banker.banker-plugins.workers.dev`)를 내장하므로 count-default-on 이라 설치 즉시 활성이며, `BANKER_TELEMETRY_ENDPOINT` 환경변수로 자가호스팅/override 할 수 있습니다.\
Codex CLI는 샌드박스가 네트워크를 차단하므로 알림·카운팅 둘 다 동작하지 않습니다.

무엇을 수집하고 누가 수신하는지는 [PRIVACY.md](PRIVACY.md)에 정리했습니다.

### 공개 대시보드 · 엔드포인트

카운팅 워커(`banker.banker-plugins.workers.dev`)는 다음 공개 엔드포인트를 제공합니다.

| URL | 내용 |
|---|---|
| <https://banker.banker-plugins.workers.dev/> | 사용량 대시보드 (npm 다운로드 지표 + 스킬 사용 집계 차트) |
| <https://banker.banker-plugins.workers.dev/stats> | 집계 데이터 JSON |
| <https://banker.banker-plugins.workers.dev/health> | 헬스 체크 (`ok`) |

## 라이선스 / 서드파티

banker 자체는 **MIT** ([LICENSE](LICENSE)). Owner: [smallOpenSource](https://github.com/smallOpenSource).

**번들된 코드 (이 패키지가 재배포)**
- `skills/humanizer`: [blader/humanizer](https://github.com/blader/humanizer) 기반, **MIT License**(© 2025 Siqi Chen).\
  원본 라이선스 고지는 `skills/humanizer/LICENSE` 에 포함.\
  패턴 목록은 Wikipedia [*Signs of AI writing*](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing)(WikiProject AI Cleanup, **CC BY-SA**)에 기반합니다.
- `skills/3d-intro-build/references`: [oso95/scroll-world](https://github.com/oso95/scroll-world) 의 스크럽 엔진(`scrub-engine.js`·`index-template.html`)을 그대로 벤더링, **MIT License**(© 2026 cyw).\
  원본 라이선스 고지는 `skills/3d-intro-build/references/LICENSE` 와 `NOTICE.md` 에 포함.

코드로 포함(재배포)하는 서드파티는 `humanizer` 와 `scroll-world`(`3d-intro-build`) 둘입니다.\
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
| 프레임워크 | oh-my-claudecode(OMC)·oh-my-codex(OMX), by [Yeachan-Heo](https://github.com/Yeachan-Heo) | MIT | `all-in-one`·`ultra-init`·`/banker:front-qa`·`setup-omc` |
| 플러그인 | insane-search (© fivetaku, [fivetaku/gptaku_plugins](https://github.com/fivetaku/gptaku_plugins)) | MIT | `setup-insane-search` |
| 팀 아키텍처 팩토리 | revfactory/harness (© Minho Hwang, [revfactory/harness](https://github.com/revfactory/harness)) · Codex 포트 SaehwanPark/meta-harness | Apache-2.0 | `setup-harness-factory`(설치·구성만 안내) |
| 서비스(독점·상표) | Notion | 독점 | `make-notion-guide` |
| 서비스(독점·상표) | Google Stitch | 독점 | `setup-stitch` |
| 디자인(상표) | Nothing 디자인 언어 | 상표 | `nothing-design` |
| QA 엔진(예시) | Godot·Phaser 등 | MIT | `play-qa` |
| 서비스(독점·상표) | Microsoft Azure OpenAI (Sora-2·gpt-image-2·FLUX.2-pro) | 독점 | `3d-intro-setup`·`3d-intro-build` |
| 서비스(독점·상표) | Alibaba Cloud Model Studio (WAN 영상 모델) | 독점 | `3d-intro-setup`·`3d-intro-build` |
