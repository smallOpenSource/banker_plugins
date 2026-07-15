# Transform matrix: Claude Code surfaces → Codex CLI

Source of truth: this repo's `skills/<name>/` + `commands/<name>.md`. `codex/manifest.json` tags each surface.
The generator (`banker setup --codex`) applies the rules below for `target: both` surfaces ONLY (`claude-only` surfaces are never written to Codex — currently there are none; every surface is `both`).

| Source (Claude) | Codex destination | Transform |
|---|---|---|
| `skills/<name>/SKILL.md` (+ subtree) | `~/.codex/skills/banker-<name>/` (whole dir) | **COPY subtree** (Windows: no symlink), then **rewrite the frontmatter `name:` to `banker-<name>`**. Codex discovers skills by directory and requires `name:` == directory name, so the prefix must be applied to both (leaving `name: <name>` while the dir is `banker-<name>` makes Codex skip the skill). `description` is left as-is. |
| `commands/<name>.md` | `~/.codex/prompts/banker-<name>.md` | Near-identical (frontmatter `description`+`argument-hint`). Codex prompts are flat → the `banker-` prefix lives in the filename; invoked as `/banker-<name>`. |
| (none) | `~/.codex/AGENTS.md` | **NOT TOUCHED.** omx regenerates it (clobber risk, `:7`/`:253`). Rely on `~/.codex/skills/` auto-discovery; if a listing is wanted, write ONLY inside the sanctioned `<!-- user-custom -->` region, idempotently. |

## Naming
- Codex skill dir **and** frontmatter `name:`: `banker-<name>` (avoids collision with omx/system skills; kept in sync so Codex discovers it).
- Codex prompt file: `banker-<name>.md` → invoked `/banker-<name>`.

## Scope
- `--scope user` (default) → `~/.codex/…`. `--scope project` → `./.codex/…`.

## Runtime-aware surfaces (both) — Codex uses OMX / Codex equivalents
현재 `claude-only` 표면은 **없다**(전부 `both`). OMC/Claude 에 결합됐던 표면은 본문이 런타임 인식으로 작성돼 Codex에서도 동작한다 — Codex에선 OMC 대신 oh-my-codex(OMX)의 동명 스킬을 쓴다:
- 오케스트레이터 `all-in-one`·`ultra-init`·커맨드 `front-qa` → OMX `ralplan`/`ralph`/`ultraqa`/`ultragoal`.
- `setup-omc` → `omx setup`(본문에 이미 존재). `setup-omc-hud` → OMX `hud`. `setup-stitch` → `codex mcp add`.
- `compact-copy` → Codex 내장 `/copy`(경로는 Codex 규약). `omc-reference` → Codex는 OMX 카탈로그 기준. `setup` 커맨드 → Codex는 프롬프트 선택 UX.
`setup-insane-search` 도 `both`: Codex에선 `codex plugin add insane-research-codex@gptaku-codex`.

신규 스킬(0.4.0)도 `both`·런타임 인식:
- `visual-ralph` → OMX `$ralph`·`$imagegen`(+`omx imagegen continuation`)·Visual Verdict; Claude은 `ralph`+`visual-verdict`+Stitch/ccg imagegen.
- `deep-init` → 서브에이전트 Claude=OMC explore/architect/writer, Codex=OMX worker/explore(부재 시 직접 수행). 순수 fs+doc.
- `deep-research` → Claude 번들 워크플로/`WebSearch`, Codex OMX `autoresearch`/`best-practice-research`.
- `ralph-qa` → 다른-LLM: Claude `omc ask codex`/`ccg`, Codex OMX `$ask`(Claude/Gemini).
- `smart-compact` → Claude statusLine `context_window.used_percentage`+hook; Codex 신호 미확인 시 휴리스틱 폴백. TUI 3단(`/copy`·`/compact`·paste)은 유저.
- `curation` → 런타임 무관(외부 의존 0, 양쪽 동일).

## Caveats (documented; not blockers)
- `append_wiki`, `compact-wiki` — use `wiki_*` MCP at runtime → copy fine, need a wiki MCP available in Codex.
- `audit-web-page`, `play-qa`, `ultra-ui-qa` — need playwright (install via `setup-playwright`).
- `setup-playwright` — genericize the `/banker:setup` trigger phrasing for the Codex copy.
- `visual-ralph` — needs an imagegen path (Stitch via `setup-stitch`, or `/ccg`/Gemini) + a frontend repo; static/live-URL reference works without imagegen.
- `ralph-qa` — needs a *different* LLM provider auth (`omc ask codex` / OMX `$ask`); falls back to same-runtime `critic` if unavailable.
- `deep-research` — needs web search/fetch (Claude WebSearch/WebFetch or bundled workflow; Codex OMX autoresearch).
- `smart-compact` — Claude statusLine exposes context%; Codex signal unconfirmed → heuristic fallback; `/copy`·`/compact`·paste stay user-driven (TUI).
- `obsidizer` — OMC-managed trees respect the 9-field frontmatter whitelist + reserved files + no-rename + bare `[[slug]]` links only; `aliases` are written in generic vaults only; Canvas sidecars and body-inline `::` are durable in-place; no `wiki_*` write dependency, `wiki_lint` read-only for verification. `--enable` is Claude-only (plugin-declared PostToolUse hook); Codex has no MCP tool hooks → honest no-op.
