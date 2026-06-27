# banker-plugins

> *Claude Code에 QA·감사·문서·아키텍처 초능력을 한 벌로.*

[![npm](https://img.shields.io/npm/v/@kaydash9999/banker-plugins)](https://www.npmjs.com/package/@kaydash9999/banker-plugins)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**[빠른 시작](#빠른-시작)** · [왜 banker인가](#왜-banker인가) · [구성](#구성) · [설치 상세](#설치-상세-npm--codex) · [요구사항](#요구사항) · [라이선스](#라이선스--서드파티)

banker는 QA·보안 감사·문서·아키텍처·위키 작업을 위한 **스킬 24개**와 OS 의존성 설치기를 묶은 Claude Code 플러그인입니다. 설치하면 모든 스킬·커맨드가 **`/banker:<이름>`** 네임스페이스로 노출됩니다. 이 repo 자체가 **Claude Code 마켓플레이스**(`.claude-plugin/marketplace.json`)이자 **플러그인**(`.claude-plugin/plugin.json`, name `banker`)입니다.

> npm 패키지(`@kaydash9999/banker-plugins`)와 GitHub repo(`smallOpenSource/banker_plugins`)는 같은 메인테이너가 관리합니다.

## 빠른 시작

```bash
# 1) 마켓플레이스 추가 + 플러그인 설치
claude plugin marketplace add smallOpenSource/banker_plugins
claude plugin install banker@banker-plugins
```

```text
# 2) 첫 사용 — 예: 보안 취약점 진단
/banker:audit-security
```

설치 후 스킬·커맨드는 `/banker:rfp-author`, `/banker:arch-diagram` 처럼 `/banker:` 로 호출합니다. playwright(브라우저 QA) 같은 OS 의존성이 필요한 항목은 **`/banker:setup`** 으로 골라 설치합니다.

## 왜 banker인가?

- **스킬 24개를 한 벌로** — QA·감사·문서·아키텍처·위키를 매번 새로 만들지 않고 바로 씁니다.
- **설치 즉시 `/banker:*`** — 마켓플레이스 한 줄, 또는 npm 전역 설치 한 줄.
- **Claude Code + Codex 양립** — 도구-무관 스킬 17개는 Codex CLI에도 그대로 설치됩니다.
- **OS 의존성까지** — `/banker:setup` 이 playwright·omc_hud 등을 OS에 맞춰 설치·폴백합니다.

## 구성

### 커맨드

| 커맨드 | 설명 |
|---|---|
| `/banker:front-qa` | 스펙(note) 기반 프론트엔드 구현 + 엄격 parity QA |
| `/banker:setup` | 구성요소·OS 의존성 multi-select 설치 오케스트레이터 |

### 스킬 — QA · 감사

| 스킬 | 설명 |
|---|---|
| `audit-security` | 보안 취약점(CVE·SAST·시크릿) 진단 (read-only) |
| `audit-mock` | 하드코딩·mock/stub·열거형 정적 검출 (read-only) |
| `audit-web-page` | 라이브 웹 페이지 점검 (playwright·WebGL 캔버스) |
| `game-qa` | 웹 게임(Godot HTML5) 직접 플레이 QA |
| `ultra-ui-qa` | UI를 기준(디자인 PDF/스펙)과 1:1 대조 QA |

### 스킬 — 문서 · 디자인 · 위키

| 스킬 | 설명 |
|---|---|
| `arch-diagram` | 시스템 아키텍처 구성도 (PlantUML + 편집가능 PPTX) |
| `make-notion-guide` | API 호출 가이드를 노션 양식 문서로 작성 |
| `pdf-vision-extract` | 비주얼 PDF를 고해상도 PNG로 변환(비전 입력) |
| `nothing-design` | Nothing 스타일 UI 디자인 적용 |
| `rfp-author` | 외주 제안요청서(RFP) 저작 (범용 프레임워크) |
| `humanizer` | AI 글 흔적 제거(자연스러운 문체로 윤문) |
| `lineage` | 세션 대화를 카카오톡 스타일 단일 HTML로 export |
| `append_wiki` | 프로젝트 위키 문서 추가/보강 |
| `compact-wiki` | 위키 중복 제거·supersede·병합 (무손실) |

### 스킬 — 워크플로 · 유틸

| 스킬 | 설명 |
|---|---|
| `all-in-one` | 계획→구현→검증 end-to-end 오케스트레이터 |
| `ultra-init` | 아이디어→빌드→테스트 원샷 자동 실행 |
| `ready-compact` | 컨텍스트 compaction 직전 상태 저장/이어가기 |
| `compact-copy` | resume 프롬프트만 추출 → 클립보드/파일(compaction 이어가기) |
| `refresh-git-ignore` | `.gitignore` 비파괴·반복가능 갱신 |
| `omc-reference` | OMC 에이전트/툴/스킬 레퍼런스 |

### 스킬 — 설치 (`/banker:setup` 가 호출)

| 스킬 | 설명 |
|---|---|
| `setup-playwright` | Playwright + headless 브라우저 (RHEL8/Rocky8·non-root·no-conda 폴백) |
| `setup-omc-hud` | omc_hud 상태표시줄 (OS별) |
| `setup-insane-search` | insane-search 플러그인 설치 |
| `setup-stitch-proxy` | Stitch 디자인 MCP 프록시 등록 |

## 설치 상세 (npm + Codex)

마켓플레이스 대신 **npm**으로 전역 설치할 수 있고, **Codex CLI**에도 스킬을 설치할 수 있습니다.

```bash
npm i -g @kaydash9999/banker-plugins
banker setup            # Claude Code + Codex 둘 다 (대상 플래그 없으면 둘 다)
banker setup --claude   # Claude Code만 (마켓플레이스 등록 → /banker:*)
banker setup --codex    # Codex CLI만 (~/.codex/skills/banker-*)
banker doctor           # 설치 상태 점검
banker uninstall        # 제거
```

- `--scope project` 로 프로젝트-로컬(`./.codex`)에 설치, `--dry-run` 으로 미리보기.
- **non-root 전용**(전역 sudo 설치 시 root 소유 파일 방지). **postinstall 없음** — `banker setup` 을 직접 실행합니다.
- Codex에는 **도구-무관 스킬 17개만** 설치됩니다(`codex/manifest.json`). OMC/`claude`-결합 스킬(all-in-one·ultra-init·omc-reference·setup-omc-hud/insane-search/stitch-proxy·`/banker:front-qa`)과 Claude Code 내장 `/copy` 에 의존하는 `compact-copy` 는 Claude Code 전용입니다.
- Codex 스킬 → `~/.codex/skills/banker-<name>/` (17개). 현재 커맨드(`front-qa`·`setup`)는 둘 다 Claude 전용이라 Codex prompts는 0개입니다 — 향후 도구-무관 커맨드가 생기면 `~/.codex/prompts/banker-<name>.md`(`/banker-<name>`)로 설치됩니다. `~/.codex/AGENTS.md`는 건드리지 않습니다(omx가 재생성하므로).

## 요구사항

- **Claude Code** (마켓플레이스 설치 경로) — 스킬은 `/banker:*` 로 동작.
- 또는 **Node.js ≥ 16.7** (npm 전역 설치 경로) — `banker` CLI 제공.
- 일부 스킬은 OS 의존성이 필요합니다(`/banker:setup` 으로 설치): playwright(브라우저 QA)·omc_hud 등.

## 업데이트 / 제거

```bash
claude plugin update banker                       # 플러그인 최신화 (재시작 후 적용)
claude plugin marketplace update banker-plugins   # 마켓플레이스 메타 갱신
claude plugin uninstall banker                    # 제거
```

## 라이선스 / 서드파티

- **MIT** ([LICENSE](LICENSE)). Owner: [smallOpenSource](https://github.com/smallOpenSource).
- `skills/humanizer` — [blader/humanizer](https://github.com/blader/humanizer) 기반, **MIT License** (© 2025 Siqi Chen). 원본 라이선스 고지는 `skills/humanizer/LICENSE`에 포함되어 있습니다.
