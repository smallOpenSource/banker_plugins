# Changelog

## [0.4.0] - 2026-07-15

### Added
- **신규 스킬 6종** (전부 `target: both`, 런타임 인식 본문 — Claude=OMC / Codex=OMX):
  - `curation`: 의사결정을 {선택지·권고안·권고 근거·확신수준(0.00~1.00)·확신수준 근거} 형식으로 큐레이션. `--perf` 는 결과물 품질·완성도를 노력/토큰/시간 효율보다 우선하는 채택 기준을 추가. 외부 의존 0(양 런타임 동일 동작).
  - `deep-init`: 코드베이스 전체에 계층형 `AGENTS.md` 문서 생성/갱신(부모 역참조·`<!-- MANUAL -->` 보존·계층 검증). OMC `deepinit` 이식으로 banker `ultra-init`(자율 풀사이클 빌드)과는 별개. 서브에이전트 Claude=OMC explore/architect/writer, Codex=OMX worker/explore, 부재 시 직접 수행.
  - `visual-ralph`: 레퍼런스(생성/정적/라이브 URL) 기준 프론트 UI를 Visual Verdict(≥90)+픽셀 diff로 측정 빌드하고 재사용 디자인 시스템을 남긴다. OMX `visual-ralph` 이식. Claude=`ralph`+`visual-verdict`+Stitch(`setup-stitch-proxy`)/ccg imagegen, Codex=`$ralph`+`$imagegen`.
  - `deep-research`: 다중 소스 팬아웃 → 적대적 다표결 검증(2/3 반증 시 폐기) → 확신순 인용 합성. 번들 워크플로를 prose 로 재저작(구조적 병렬 fan-out 충실도 하락을 명시). Claude=번들 워크플로/`WebSearch`, Codex=OMX `autoresearch`.
  - `ralph-qa`: 작업 결과를 **다른 LLM·별도 세션**으로 `ralplan --deliberate`+`ralph --critic=critic` 로직으로 독립 검증/개선 반복(anti-self-approval). Claude=`omc ask codex`/`ccg`, Codex=OMX `$ask`(Claude/Gemini). 검증 모델은 파라미터화(`--model`·`--effort`; 예시 `gpt-5.6-sol` 은 하드코딩하지 않음).
  - `smart-compact`: 컨텍스트 사용률이 임계(기본 50%)를 넘으면 `append-wiki`→`ready-compact`→`compact-copy` 를 자동 실행하고 `/copy`·`/compact`·paste 를 유저에게 핸드오프하는 게이트. Claude statusLine `context_window.used_percentage` 로 감지(hook은 context% 미노출·슬래시명령 호출 불가 → TUI 3단은 유저 실행), 기존 statusLine 을 감싸는 compose-safe 설치. `--cancel` 해제.

### Changed
- **Codex 이식 확대(claude-only → both)**: 이전 OMC/Claude 결합 표면(스킬 `all-in-one`·`ultra-init`·`omc-reference`·`compact-copy`·`setup-omc-hud`·`setup-stitch-proxy` + 커맨드 `front-qa`·`setup`)을 **런타임 인식 본문**으로 재작성해 `target: both` 로 승격했다(`setup-omc` 는 기존부터 dual). Codex에선 OMC 대신 oh-my-codex(OMX)의 동명 스킬(ralplan/ralph/ultraqa/hud 등)·`codex mcp`·내장 `/copy` 를 사용한다. `codex/manifest.json` 의 claude-only=0.
- **`omc-reference` dualize**: 본문에 실측 OMX(oh-my-codex 0.18.16) 카탈로그(Agent Prompts·Skills Registry·Interfaces + OMC↔OMX 대응)를 병기해 Codex에서도 정확한 레퍼런스가 되도록 격상(기존 disclaimer-only → dual).
- Codex 설치 스킬 수 **25 → 32**(+커맨드 2 유지). `README.md`·`codex/transform-matrix.md` 를 동기화하고, `scripts/smoke-test.js` 에 `copies===32` + 신규 6스킬 존재 + `deep-interview` 부재(이미 OMC·OMX 네이티브라 미번들) 회귀 단언을 추가했다.
- **스킬 설명(description) 정규화**: 전 스킬 + 2 커맨드의 `description` 을 `(banker)` 접두로 통일하고 em/en dash 등 AI slop 표현을 제거·간결화했다(트리거 키워드는 보존). Codex `codex debug prompt-input` 로 banker-* 가 "Available skills" 에 노출됨을 실측 확인.
- **setup 스킬 정비**: `setup-stitch-proxy` → `setup-stitch` 개명(RockyLinux8 `~/bin/stitch-proxy.sh` proxy-script 절차 그대로) + **`docs-setup` 신규**(arch-diagram·pdf-vision-extract 의존성 python-pptx·pymupdf·plantuml 설치, python-env 감지/선택·venv 우선). Codex 스킬 **31→32**, `/banker:setup` 오케스트레이터·`smoke-test` rename-guard 에 반영.

## [0.3.0] - 2026-07-02

### Changed
- **`game-qa` → `play-qa` 개명**: 웹 게임 전용 표기에서 Godot HTML5까지 포함한 웹 환경 직접 플레이 QA로 범위를 넓히고 스킬명을 `play-qa` 로 바꿨다. 스킬 디렉터리·프론트매터 `name:`·트리거·`codex/manifest.json`·README·문서 참조를 일괄 갱신했다. Codex에는 `banker-play-qa` 로 설치되며, 업데이트 시 옛 `banker-game-qa` 는 `banker setup --codex` 의 `banker-*` sweep 으로 자동 제거된다(`scripts/smoke-test.js` 에 회귀 단언 추가). `/banker:game-qa` 는 더 이상 해석되지 않으므로 minor 버전을 올린다.

## [0.2.0] - 2026-07-01

### Fixed
- **Codex 스킬 미표시(#5)**: `banker setup --codex` 가 스킬을 `~/.codex/skills/banker-<name>/` 로 복사할 때 SKILL.md 프론트매터 `name:` 을 `banker-<name>` 로 재작성한다. Codex는 스킬 디렉터리명과 `name:` 일치를 요구하는데, 기존에는 `name: <name>` 그대로라 Codex가 스킬을 인식하지 못했다. `banker doctor` 에 dir==name 검증·경고와 "codex 있는데 banker 스킬 0개" 경고 추가.

### Changed
- **업데이트 시 중복 제거(#6)**: `banker setup --codex` 가 설치 전 기존 `banker-*` 스킬·프롬프트를 먼저 정리(sweep)한 뒤 클린 재설치한다. 매니페스트에서 제거·개명된 스킬의 옛 버전이 잔존하지 않는다.
- **의존성 사전 안내(#2·#4)**: `all-in-one`·`ultra-init`·`front-qa` 에 OMC(Claude)/OMX(Codex) 전제조건 프리플라이트, 브라우저 스킬(`audit-web-page`·`game-qa`·`ultra-ui-qa`)에 playwright 전제조건 프리플라이트를 추가했다. 의존성이 없으면 "설치부터" 안내한 뒤 진행한다.
- **README 재작성(#1)**: 과장·AI 흔적 표현을 덜어내고(과장 태그라인·불필요한 em dash 정리) 간결하고 정중한 문체로 정리했다. 빠른 시작에 Claude Code·Codex 양쪽 설치 경로를 명시하고, 라이선스/서드파티 섹션을 번들 코드(humanizer)·의존 라이브러리·연동 대상 3범주로 확장했다.
- `sync-version` 이 `.claude-plugin/marketplace.json` 의 `metadata.version` 까지 동기화한다(과거 수동 갱신 제거).

### Added
- **`setup-omc` 스킬**: `all-in-one`·`ultra-init`·`front-qa` 가 의존하는 oh-my-claudecode(OMC)를 설치·갱신한다(Codex는 OMX `omx setup`). `/banker:setup` 멀티셀렉트에 옵션으로 추가.
- **`setup-insane-search` Codex 지원(#7)**: `target: both` 로 승격했다. Claude는 `insane-search@gptaku-plugins`, Codex는 `codex plugin add insane-research-codex@gptaku-codex` 경로를 도구 자동 감지로 안내한다.
- `scripts/smoke-test.js` 에 실제 설치 기반 회귀 단언 추가: 스킬 18개, `banker-*` dir==frontmatter `name`, 재설치 시 stale sweep.

## [0.1.3] - 2026-06-29

### Security
- `lineage` 스킬 문서의 `LINEAGE_REDACT_EXTRA` / `--redact-extra` 예시에서 실제 프로젝트 비밀 키워드 예시를 중립 플레이스홀더(`acme-corp,db-pass`)로 교체 — npm tarball·GitHub 노출 제거. 기능·내장 정규식 패턴은 불변.

## [0.1.2] - 2026-06-28

### Added
- `compact-copy` 스킬(개인 `~/.claude/skills/` + banker): `/ready-compact` resume 프롬프트에서 코드펜스 본문만 추출해 `/tmp/claude-<uid>/response.md` + (이어지는 `/copy`) 클립보드에 "프롬프트-only" 로 담는다. `/copy`·response.md 내장 의존이라 Claude Code 전용.

### Changed
- `all-in-one` 스킬을 playwright 3단계 → **ralplan→ralph→ultraqa** 3단계(독립 테스트 게이트)로 재작성(`--short`/`--checkpoint`/`--critic`/`--qa`/`--no-deslop` 플래그 추가). `codex/manifest.json` 의 reason 문자열도 ultraqa로 동기화.

## [0.1.1] - 2026-06-26

### Changed — README + license
- README 전면 재구성: hero(태그라인 + npm·MIT 배지 + 내비) · 빠른 시작(2스텝) · "왜 banker인가" · 요구사항 섹션 추가(스킬 표 보존).
- 루트 `LICENSE`(MIT) 파일 추가 + `package.json` `files[]`에 포함(MIT 배지가 실제 라이선스를 가리키도록).

## [0.1.0] - 2026-06-25

### Added — npm distribution + Codex CLI support
- npm global install: `npm i -g @kaydash9999/banker-plugins` ships a `banker` CLI (`bin/banker.js`, no runtime deps).
- `banker setup [--claude] [--codex] [--scope user|project] [--dry-run]`, `banker doctor`, `banker uninstall`.
- **Codex CLI support**: `banker setup --codex` installs the 17 tool-agnostic skills into `~/.codex/skills/banker-<name>/` (subtree copy) and commands into `~/.codex/prompts/banker-<name>.md` (`/banker-<name>`), per `codex/manifest.json`. It never writes the omx-generated `~/.codex/AGENTS.md` (relies on `~/.codex/skills/` auto-discovery).
- `codex/manifest.json` (per-surface `claude-only | both` target + supporting files) and `codex/transform-matrix.md`.
- Version-sync guard: `.claude-plugin/plugin.json` is the single source of truth; `npm run sync-version` syncs `package.json`, and `prepublishOnly` fails publish on mismatch.

### Unchanged
- The Claude Code marketplace install (`claude plugin install banker@banker-plugins`, skills as `/banker:*`) is byte-for-byte unchanged.

### Notes
- No `postinstall`; `banker setup` is explicit and refuses to run as root (avoids root-owned files in user homes).
- OMC/`claude`-coupled skills (all-in-one, ultra-init, omc-reference, setup-omc-hud, setup-insane-search, setup-stitch-proxy) and the `front-qa`/`setup` commands are Claude-Code-only.
