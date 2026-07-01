# banker-plugins

> Claude Code와 Codex CLI를 위한 QA·감사·문서·아키텍처·위키 스킬 모음.

[![npm](https://img.shields.io/npm/v/@kaydash9999/banker-plugins)](https://www.npmjs.com/package/@kaydash9999/banker-plugins)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[빠른 시작](#빠른-시작) · [구성](#구성) · [설치 상세](#설치-상세-npm--codex) · [요구사항](#요구사항) · [업데이트 / 제거](#업데이트--제거) · [라이선스 / 서드파티](#라이선스--서드파티)

banker는 QA, 보안 감사, 문서, 아키텍처, 위키 작업을 위한 스킬 25개와 의존성 설치 스킬을 묶은 Claude Code 플러그인입니다. 설치하면 스킬과 커맨드가 `/banker:<이름>` 네임스페이스로 노출됩니다. 이 저장소 자체가 Claude Code 마켓플레이스(`.claude-plugin/marketplace.json`)이자 플러그인(`.claude-plugin/plugin.json`, name `banker`)이며, 도구에 무관한 스킬은 Codex CLI에도 설치됩니다.

> npm 패키지(`@kaydash9999/banker-plugins`)와 GitHub 저장소(`smallOpenSource/banker_plugins`)는 같은 메인테이너가 관리합니다.

## 빠른 시작

**Claude Code:** 마켓플레이스로 설치

```bash
claude plugin marketplace add smallOpenSource/banker_plugins
claude plugin install banker@banker-plugins
```

스킬과 커맨드를 `/banker:audit-security` 처럼 `/banker:` 로 호출합니다.

**Codex CLI:** npm 전역 설치 후 `banker setup`

```bash
npm i -g @kaydash9999/banker-plugins
banker setup --codex
```

스킬을 `banker-audit-security` 처럼 `banker-<name>` 으로 호출합니다.

playwright(브라우저 QA)나 oh-my-claudecode(OMC/OMX)처럼 별도 의존성이 필요한 스킬은 실행 전에 설치부터 안내합니다(Claude Code는 `/banker:setup`).

## 구성

### 커맨드

| 커맨드 | 설명 |
|---|---|
| `/banker:front-qa` | 스펙(note) 기반 프론트엔드 구현 + parity QA |
| `/banker:setup` | 구성요소·의존성 설치 오케스트레이터 (multi-select) |

### 스킬: QA · 감사

| 스킬 | 설명 |
|---|---|
| `audit-security` | 보안 취약점(CVE·SAST·시크릿) 진단 (read-only) |
| `audit-mock` | 하드코딩·mock/stub·열거형 정적 검출 (read-only) |
| `audit-web-page` | 라이브 웹 페이지 점검 (playwright·WebGL 캔버스) |
| `game-qa` | 웹 게임(Godot HTML5) 직접 플레이 QA |
| `ultra-ui-qa` | UI를 기준(디자인 PDF/스펙)과 1:1 대조 QA |

### 스킬: 문서 · 디자인 · 위키

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

### 스킬: 워크플로 · 유틸

| 스킬 | 설명 |
|---|---|
| `all-in-one` | 계획→구현→검증 end-to-end 오케스트레이터 |
| `ultra-init` | 아이디어→빌드→테스트 원샷 자동 실행 |
| `ready-compact` | 컨텍스트 compaction 직전 상태 저장/이어가기 |
| `compact-copy` | resume 프롬프트만 추출해 클립보드/파일로(compaction 이어가기) |
| `refresh-git-ignore` | `.gitignore` 비파괴·반복가능 갱신 |
| `omc-reference` | OMC 에이전트/툴/스킬 레퍼런스 |

### 스킬: 설치 (`/banker:setup` 가 호출)

| 스킬 | 설명 |
|---|---|
| `setup-omc` | oh-my-claudecode(OMC) 설치·갱신 (Codex는 OMX) |
| `setup-playwright` | Playwright + headless 브라우저 (RHEL8/Rocky8·non-root·no-conda 폴백) |
| `setup-omc-hud` | omc_hud 상태표시줄 (OS별) |
| `setup-insane-search` | insane-search 플러그인 설치 (Claude·Codex) |
| `setup-stitch-proxy` | Stitch 디자인 MCP 프록시 등록 |

## 설치 상세 (npm · Codex)

마켓플레이스 대신 npm으로 전역 설치할 수 있고, Codex CLI에도 스킬을 설치할 수 있습니다. Codex 설치는 npm 전역 설치가 선행되어야 합니다.

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
- Codex에는 도구에 무관한 스킬 18개가 설치됩니다(`codex/manifest.json`). 스킬은 `~/.codex/skills/banker-<name>/` 에 놓이고, 디렉터리명과 일치하도록 프론트매터 `name:` 이 `banker-<name>` 으로 재작성되어 Codex가 `banker-<name>` 으로 인식합니다.
- OMC나 `claude` 에 결합된 스킬(all-in-one, ultra-init, omc-reference, setup-omc, setup-omc-hud, setup-stitch-proxy)과 Claude Code 내장 `/copy` 에 의존하는 compact-copy, 그리고 `/banker:front-qa`·`/banker:setup` 커맨드는 Claude Code 전용입니다.
- `~/.codex/AGENTS.md` 는 건드리지 않습니다(omx가 재생성하므로 `~/.codex/skills/` 자동 검색에 의존).

## 요구사항

- Claude Code (마켓플레이스 경로): 스킬이 `/banker:*` 로 동작.
- 또는 Node.js ≥ 16.7 (npm 전역 설치 경로): `banker` CLI 제공.
- 일부 스킬은 별도 의존성이 필요하며 `/banker:setup` 으로 설치합니다. 의존성이 없으면 각 스킬이 실행 전에 설치부터 안내합니다.
  - `all-in-one`, `ultra-init`, `/banker:front-qa`: oh-my-claudecode(OMC). Codex에서는 OMX.
  - `audit-web-page`, `game-qa`, `ultra-ui-qa`: playwright.

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

## 라이선스 / 서드파티

banker 자체는 **MIT** ([LICENSE](LICENSE)). Owner: [smallOpenSource](https://github.com/smallOpenSource).

**번들된 코드 (이 패키지가 재배포)**
- `skills/humanizer`: [blader/humanizer](https://github.com/blader/humanizer) 기반, **MIT License**(© 2025 Siqi Chen). 원본 라이선스 고지는 `skills/humanizer/LICENSE` 에 포함. 패턴 목록은 Wikipedia [*Signs of AI writing*](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing)(WikiProject AI Cleanup, **CC BY-SA**)에 기반합니다.

코드로 포함(재배포)하는 서드파티는 `humanizer` 뿐입니다. 아래는 스킬이 **런타임에 의존하거나 연동**하는 외부 요소로, banker 가 재배포하지 않으며 각 라이선스·상표는 소유자에게 있습니다.

**의존 라이브러리·도구 (사용 시 별도 설치, 라이선스는 각 프로젝트 소유)**
- Python: python-pptx(MIT, `arch-diagram`), python-docx(MIT, `rfp-author`), Playwright(Apache-2.0, `audit-web-page`·`game-qa`·`ultra-ui-qa`), detect-secrets(Apache-2.0, `lineage` 시크릿 스캔).
- 브라우저·렌더링: Chromium(BSD-3-Clause), SwiftShader(Apache-2.0), Xvfb·X.Org(MIT). `setup-playwright` 및 브라우저 QA 스킬이 사용.
- 문서·다이어그램: PlantUML(GPL 계열·다중 라이선스, `arch-diagram`), Poppler(GPL, `pdftoppm`), ImageMagick(ImageMagick License, `pdf-vision-extract`).

**연동·참조 (외부 프레임워크·서비스·브랜드)**
- 프레임워크: oh-my-claudecode(OMC, **MIT**)·oh-my-codex(OMX, **MIT**), by [Yeachan-Heo](https://github.com/Yeachan-Heo). `all-in-one`·`ultra-init`·`/banker:front-qa`·`setup-omc` 가 사용.
- 플러그인: insane-search(**MIT**, © fivetaku, [fivetaku/gptaku_plugins](https://github.com/fivetaku/gptaku_plugins)). `setup-insane-search` 가 설치.
- 서비스·디자인(독점·상표): Notion(`make-notion-guide`), Google Stitch(`setup-stitch-proxy`), Nothing 디자인 언어(`nothing-design`).
- QA 대상 엔진(예시): Godot(MIT), Phaser(MIT) 등(`game-qa`).
