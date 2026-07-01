# Transform matrix: Claude Code surfaces → Codex CLI

Source of truth: this repo's `skills/<name>/` + `commands/<name>.md`. `codex/manifest.json` tags each surface.
The generator (`banker setup --codex`) applies the rules below for `target: both` surfaces ONLY; `claude-only` surfaces are NEVER written to Codex.

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

## Excluded (claude-only) — never generated for Codex
Skills: all-in-one, compact-copy, ultra-init, omc-reference, setup-omc, setup-omc-hud, setup-stitch-proxy.
Commands: front-qa, setup. (Reasons in `manifest.json`.)
`setup-insane-search` is `both`: on Codex it drives `codex plugin add insane-research-codex@gptaku-codex`.

## Caveats (documented; not blockers)
- `append_wiki`, `compact-wiki` — use `wiki_*` MCP at runtime → copy fine, need a wiki MCP available in Codex.
- `audit-web-page`, `game-qa`, `ultra-ui-qa` — need playwright (install via `setup-playwright`).
- `setup-playwright` — genericize the `/banker:setup` trigger phrasing for the Codex copy.
