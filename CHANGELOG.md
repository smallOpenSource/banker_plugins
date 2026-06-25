# Changelog

## [Unreleased]

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
