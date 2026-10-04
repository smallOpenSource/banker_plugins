# Transform matrix: Claude Code surfaces → Codex CLI

Source of truth: this repo's `skills/<name>/` + `commands/<name>.md`. `codex/manifest.json` tags each surface.
The generator (`banker setup --codex`) applies the rules below for `target: both` surfaces ONLY (`claude-only` surfaces are never written to Codex — currently there are none; every surface is `both`).

| Source (Claude) | Codex destination | Transform |
|---|---|---|
| `skills/<name>/SKILL.md` (+ subtree) | `~/.codex/skills/banker-<name>/` (whole dir) | **COPY subtree** (Windows: no symlink), then **rewrite the frontmatter `name:` to `banker-<name>`**. Codex discovers skills by directory and requires `name:` == directory name, so the prefix must be applied to both (leaving `name: <name>` while the dir is `banker-<name>` makes Codex skip the skill). `description` is left as-is. |
| `commands/<name>.md` | `~/.codex/prompts/banker-<name>.md` | Near-identical (frontmatter `description`+`argument-hint`). Codex prompts are flat → the `banker-` prefix lives in the filename; invoked as `/banker-<name>`. |
| (none) | `~/.codex/AGENTS.md` | **NOT TOUCHED by setup.** omx regenerates it (clobber risk, `:7`/`:253`); `omx setup --merge-agents` keeps only `<!-- USER:OMX:POLICY:START -->`…`END` blocks on a rewrite; `--force`, a confirmed overwrite, and a plain `omx setup` with team mode off replace the file whole; a plain `omx setup` with team mode on only refreshes the model table. Rely on `~/.codex/skills/` auto-discovery. The one runtime writer is the `tone-compact` skill, at the user's request, inside such a block. |

## Naming
- Codex skill dir **and** frontmatter `name:`: `banker-<name>` (avoids collision with omx/system skills; kept in sync so Codex discovers it).
- Codex prompt file: `banker-<name>.md` → invoked `/banker-<name>`.

## Scope
- `--scope user` (default) → `~/.codex/…`. `--scope project` → `./.codex/…`.

## Runtime-aware surfaces (both) — Codex uses OMX / Codex equivalents
현재 `claude-only` 표면은 **없다**(전부 `both`). OMC/Claude 에 결합됐던 표면은 본문이 런타임 인식으로 작성돼 Codex에서도 동작한다 — Codex에선 OMC 대신 oh-my-codex(OMX)의 동명 스킬을 쓴다:
- 오케스트레이터 `all-in-one`·`ultra-init`·커맨드 `front-qa` → OMX `ralplan`/`ralph`/`ultraqa`. `ultra-init` 은 0.14.0 부터 ultragoal 원장을 쓰지 않는다(OMC 5.6.1 checkpoint 가 `/goal` 스냅샷을 요구해 ralph 와 Stop 훅 루프가 겹친다). Claude 쪽은 OMC 5 기준: `ultraqa` 가 5.0.0 에서 삭제돼 QA 게이트를 `verify` 순환(독립 verifier → architect 진단 → executor 수정, 최대 5회)으로 직접 돌리고, `ralph` 가 부르는 `omc ralph verify` 때문에 전역 `omc` CLI 가 플러그인과 같은 5.x 여야 한다(사전 점검은 종료 코드가 아니라 출력 문구로).
- `setup-omc` → `omx setup`(본문에 이미 존재). `setup-omc-hud` → OMX `hud`. `setup-stitch` → `codex mcp add`.
- `compact-copy` → Codex 내장 `/copy`(경로는 Codex 규약). `omc-reference` → Codex는 OMX 카탈로그 기준. `setup` 커맨드 → Codex는 프롬프트 선택 UX.
`setup-insane-search` 도 `both`: Codex에선 `codex plugin add insane-research-codex@gptaku-codex`.

신규 스킬(0.4.0)도 `both`·런타임 인식:
- `visual-ralph` → OMX `$ralph`·`$imagegen`(+`omx imagegen continuation`)·Visual Verdict; Claude은 `ralph`+`visual-verdict`+Stitch/ccg imagegen.
- `deep-init` → 서브에이전트 Claude=OMC explore/architect/writer, Codex=OMX worker/explore(부재 시 직접 수행). 순수 fs+doc.
- `deep-research` → Claude 번들 워크플로/`WebSearch`, Codex OMX `autoresearch`/`best-practice-research`.
- `ralph-qa` → 백본은 런타임 서브에이전트(Claude=Agent/Task `model: opus`, Codex=OMX 서브에이전트)로 양쪽 동일. 외부 좌석만 런타임별로 갈린다: Claude=`codex exec`/`omc ask codex`, Codex=`omx $ask claude`(Codex 런타임에서 `codex exec` 는 자기 자신이라 부적격).
- `smart-compact` → Claude statusLine `context_window.used_percentage`+hook; Codex 신호 미확인 시 휴리스틱 폴백. TUI 3단(`/copy`·`/compact`·paste)은 유저.
- `curation` → 런타임 무관(외부 의존 0, 양쪽 동일).

## Caveats (documented; not blockers)
- `append_wiki`, `compact-wiki` — use `wiki_*` MCP at runtime → copy fine, need a wiki MCP available in Codex.
- `audit-web-page`, `play-qa`, `ultra-ui-qa` — need playwright (install via `setup-playwright`).
- `setup-playwright` — genericize the `/banker:setup` trigger phrasing for the Codex copy.
- `visual-ralph` — needs an imagegen path (Stitch via `setup-stitch`, or `/ccg`/Gemini) + a frontend repo; static/live-URL reference works without imagegen.
- `ralph-qa` — runs with no external dependency: the multi-agent backbone always runs, and external LLM seats join only when a 0-token probe observes them valid. Their absence is a coverage fact (model axis uncovered), not a degraded mode. A same-runtime `critic` is never substituted for an external seat — on Codex that would be GPT approving GPT, i.e. self-approval.
- `deep-research` — needs web search/fetch (Claude WebSearch/WebFetch or bundled workflow; Codex OMX autoresearch).
- `smart-compact` — Claude statusLine exposes context%; Codex signal unconfirmed → heuristic fallback; `/copy`·`/compact`·paste stay user-driven (TUI).
- `obsidizer` — OMC-managed trees respect the 9-field frontmatter whitelist + reserved files + no-rename + bare `[[slug]]` links only; `aliases` are written in generic vaults only; Canvas sidecars and body-inline `::` are durable in-place; no `wiki_*` write dependency, `wiki_lint` read-only for verification. `--enable` is Claude-only (plugin-declared PostToolUse hook); Codex has no MCP tool hooks → honest no-op.
- `payload-mon` — needs the OMC custom HUD wrapper (`setup-omc-hud`). It measures Claude Code sessions only; from Codex it manages the same machine's Claude Code HUD wrapper and never measures Codex's own requests.
- `tone-compact` — per runtime: Claude Code loads `<config>/rules/banker-tone-compact.md`; Codex reads one marked block at the end of `$CODEX_HOME/AGENTS.override.md` (when it has content of its own) or `AGENTS.md`, wrapped in `USER:OMX:POLICY` so `omx setup --merge-agents` keeps it (`--force` or team mode off replaces the file; run `on` again). Turning it on in one runtime leaves the other as it is.
- `/graceful-pause` (not a manifest surface) — a Claude Code function-hooks command (`hooks/register.mjs`, 2.1.289+) registered `immediate`, so it runs mid-turn; it appends one hidden user row the running turn reads at its next model request. Codex has no equivalent (no function hooks), and the earlier `graceful_pause` skill was removed because a typed skill waits until the turn ends.

신규 스킬(0.7.0)도 `both`·런타임 인식:
- `ultra-interview` → 리서치 선행 질문 최소화 + 모호성 3% 이하 종료. **자체 루브릭 소유**가 설계 요점이다: OMC deep-interview 는 3차원, OMX 는 5차원으로 산식이 달라 네이티브 채점을 물려받으면 같은 임계값이 런타임마다 다른 뜻이 된다. OMC/OMX 네이티브 `deep-interview` 를 번들하거나 대체하지 않는다. 규제 조회는 엔드포인트 하드코딩이 아니라 "해당 관할의 공식 1차 출처를 찾아라"는 일반 지시다.
- `interval-report` → 런타임 무관(순수 파일+`date`). 두 런타임 모두 컨텍스트에 시:분이 없어 `date` 실측이 필요하다. ultragoal 산출물은 Claude=`.omc/ultragoal/`, Codex=`.omx/ultragoal/` 로 경로만 다르고, 있으면 읽고 없어도 동작한다.
- `summary-wiki` → **위키 접근이 런타임마다 완전히 다르다.** Claude=`wiki_*` MCP on `.omc/wiki/`, Codex=`omx wiki <tool> --input <json> --json` CLI on **`omx_wiki/`**(repo 레벨). **Codex 에 `wiki_*` MCP 는 없다.** `append_wiki`·`compact-wiki` 의 기존 caveat 문구를 복붙하면 오정보다. OMX 에만 있는 `wiki_refresh` 로 stale-index 를 고칠 수 있다.
- `update-banker` → 축이 OS 가 아니라 **채널**이다. Claude 런타임 = `claude plugin update` 후 프로브로 전진 확인, 안 움직이면 `claude plugin marketplace update` 를 더한다("항상 2단계"인지는 **DISPUTED** 이므로 확정으로 쓰지 않는다). Codex 런타임 = claude 분기 스킵, npm 갱신 후 `banker setup --codex`. 공통 = npm-first 순서 게이트(구버전 CLI 로 setup 하면 sweep 후 그 구버전 매니페스트 수만큼만 복원된다)와 채널별 독립 프로브 검증. 채널 부재는 에러가 아니라 스킵이다.
- `refresh-readme` → 런타임 무관(파일 읽기·쓰기뿐, 의존성 0). 안티슬롭 마커는 `humanizer` 에 위임하고 재서술하지 않는다.
- `cleansing-memory` → **두 런타임의 메모리 모델이 거의 안 닮았다.** Claude = `CLAUDE.md`(문서화된 한도 없음) + `MEMORY.md`(200줄 OR 25KB 하드 게이트) + `@path` 4홉 import + AGENTS.md 미지원. Codex = `AGENTS.md` 프로젝트 스코프 32768B(`project_doc_max_bytes`) + 전역 `~/.codex/AGENTS.md` 무제한. Codex 는 raw 바이트를 자른 뒤 lossy UTF-8 디코드를 하므로 한글 경계 문자가 깨진다. Claude 의 코드베이스 유도분 트림은 `/doctor` 에 위임한다.

추가 스킬 `payload-mon` 도 `both`·런타임 인식:
- `payload-mon` → 다루는 신호가 Claude Code 의 것이다. 32MB 요청 한도와 세션 파일 형식이 Claude Code 기준이라 **Codex 자신의 요청 크기는 재지 않는다.** Codex 에서 실행하면 같은 머신의 Claude Code HUD 래퍼(`omc-hud-custom.mjs`)를 켜고 끄는 것만 하고, `status` 의 현재 세션 추정치는 Claude Code 세션에서만 나온다. OMX `hud` 는 건드리지 않는다.
- HUD 래퍼가 불러오는 추정 모듈은 스킬 폴더가 아니라 래퍼 옆에 둔 사본이다. Claude Code 플러그인 설치 경로(`plugins/cache/<마켓>/<플러그인>/<버전>/`)는 업데이트 때 옛 버전 폴더가 정리되므로, 그 경로를 래퍼에 박으면 다음 업데이트 뒤 표시가 소리 없이 사라진다. Codex 설치 경로에는 버전이 없지만 같은 사본 방식을 쓴다.

추가 스킬 `tone-compact` 도 `both`·런타임 인식:
- `tone-compact` → 켜짐 상태를 두는 곳이 런타임마다 다르다. Claude Code 는 사용자 규칙 폴더(`<설정 폴더>/rules/`)의 banker 전용 파일 하나를 쓰고 지운다. 세션 시작과 compaction 뒤에 다시 읽히는 곳이다. Codex 는 전역 지침 파일 끝에 블록 하나를 넣고 뺀다. 파일은 `AGENTS.override.md` 에 내용이 있으면 그쪽, 없으면 `AGENTS.md` 다. `omx setup --merge-agents` 가 생성형 AGENTS.md 를 다시 쓸 때 `USER:OMX:POLICY` 블록만 남기므로 그 표시로 감싼다(`--force` 나 team 모드를 끈 `omx setup` 은 파일을 통째로 바꾸므로 그 뒤 `on` 을 다시 실행). 전역 파일은 32KiB 한도에 잘리지 않는다(35.6KB 로 실측).
- `ready-compact` → 노트 위치만 런타임마다 다르다. Claude Code 는 자동 메모리 폴더(`MEMORY.md` 포인터가 새 세션에도 로드됨), Codex 는 자동 메모리가 없어 작업 폴더의 `.omx/handoffs/`(OMX 의 handoff 관례). 출력은 양쪽 모두 프롬프트 본문만이라 내장 `/copy` 한 번으로 복사된다. `--hand-off` 는 새 세션에 이 대화가 없다는 전제로 결정과 이유, 작업 위치, 진행 중인 모드와 백그라운드 작업까지 노트에 옮긴다.
