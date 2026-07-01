# Changelog

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
