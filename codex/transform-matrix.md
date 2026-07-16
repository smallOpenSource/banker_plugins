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

신규 스킬(0.7.0)도 `both`·런타임 인식:
- `ultra-interview` → 리서치 선행 질문 최소화 + 모호성 3% 이하 종료. **자체 루브릭 소유**가 설계 요점이다: OMC deep-interview 는 3차원, OMX 는 5차원으로 산식이 달라 네이티브 채점을 물려받으면 같은 임계값이 런타임마다 다른 뜻이 된다. OMC/OMX 네이티브 `deep-interview` 를 번들하거나 대체하지 않는다. 규제 조회는 엔드포인트 하드코딩이 아니라 "해당 관할의 공식 1차 출처를 찾아라"는 일반 지시다.
- `interval-report` → 런타임 무관(순수 파일+`date`). 두 런타임 모두 컨텍스트에 시:분이 없어 `date` 실측이 필요하다. ultragoal 산출물은 Claude=`.omc/ultragoal/`, Codex=`.omx/ultragoal/` 로 경로만 다르고, 있으면 읽고 없어도 동작한다.
- `summary-wiki` → **위키 접근이 런타임마다 완전히 다르다.** Claude=`wiki_*` MCP on `.omc/wiki/`, Codex=`omx wiki <tool> --input <json> --json` CLI on **`omx_wiki/`**(repo 레벨). **Codex 에 `wiki_*` MCP 는 없다.** `append_wiki`·`compact-wiki` 의 기존 caveat 문구를 복붙하면 오정보다. OMX 에만 있는 `wiki_refresh` 로 stale-index 를 고칠 수 있다.
- `update-banker` → 축이 OS 가 아니라 **채널**이다. Claude 런타임 = `claude plugin update` 후 프로브로 전진 확인, 안 움직이면 `claude plugin marketplace update` 를 더한다("항상 2단계"인지는 **DISPUTED** 이므로 확정으로 쓰지 않는다). Codex 런타임 = claude 분기 스킵, npm 갱신 후 `banker setup --codex`. 공통 = npm-first 순서 게이트(구버전 CLI 로 setup 하면 sweep 후 그 구버전 매니페스트 수만큼만 복원된다)와 채널별 독립 프로브 검증. 채널 부재는 에러가 아니라 스킵이다.
- `refresh-readme` → 런타임 무관(파일 읽기·쓰기뿐, 의존성 0). 안티슬롭 마커는 `humanizer` 에 위임하고 재서술하지 않는다.
- `cleansing-memory` → **두 런타임의 메모리 모델이 거의 안 닮았다.** Claude = `CLAUDE.md`(문서화된 한도 없음) + `MEMORY.md`(200줄 OR 25KB 하드 게이트) + `@path` 4홉 import + AGENTS.md 미지원. Codex = `AGENTS.md` 프로젝트 스코프 32768B(`project_doc_max_bytes`) + 전역 `~/.codex/AGENTS.md` 무제한. Codex 는 raw 바이트를 자른 뒤 lossy UTF-8 디코드를 하므로 한글 경계 문자가 깨진다. Claude 의 코드베이스 유도분 트림은 `/doctor` 에 위임한다.
