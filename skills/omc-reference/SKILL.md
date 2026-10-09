---
name: omc-reference
description: "OMC 와 OMX 의 에이전트, 도구, 팀, 커밋, 스킬 레지스트리를 함께 정리한 참고 자료. 에이전트에게 맡기거나, 팀을 꾸리거나, 커밋하거나, OMC 나 OMX 의 도구와 스킬을 쓸 때 자동 로드."
user-invocable: false
---

# OMC Reference

Use this built-in reference when you need detailed agent/tool/skill catalog information that does not need to live in every `CLAUDE.md` / `AGENTS.md` session.

**런타임 — 이 문서는 양 런타임 카탈로그를 병기한다.** Claude Code는 **OMC(oh-my-claudecode)**, Codex CLI는 대응 프레임워크 **OMX(oh-my-codex)** 를 쓴다. 아래 §Agent Catalog ~ §Commit Protocol 은 **OMC(Claude) 5.6.1** 기준이고, 말미의 **§OMX (Codex) Catalog** 에 OMX 대응 카탈로그를 실측 정리했다. 이름이 대체로 대응하나 1:1은 아닐 수 있으니 설치 환경(`~/.claude` ↔ `~/.codex`) 기준으로 확인하라. **OMC 5.0.0 은 워크플로 17개를 별칭 없이 삭제했다**(§Retired in OMC 5). 삭제된 이름을 부르면 실패한다.

## Agent Catalog

Prefix: `oh-my-claudecode:`. See `agents/*.md` for full prompts.

- `explore` (haiku) — fast codebase search and mapping
- `analyst` (opus) — requirements clarity and hidden constraints
- `planner` (opus) — sequencing and execution plans
- `architect` (opus) — system design, boundaries, and long-horizon tradeoffs
- `debugger` (sonnet) — root-cause analysis and failure diagnosis
- `executor` (sonnet) — implementation and refactoring
- `verifier` (sonnet) — completion evidence and validation
- `tracer` (sonnet) — trace gathering and evidence capture
- `security-reviewer` (opus) — trust boundaries and vulnerabilities
- `code-reviewer` (opus) — comprehensive code review
- `test-engineer` (sonnet) — testing strategy and regression coverage
- `designer` (sonnet) — UX and interaction design
- `writer` (haiku) — documentation and concise content work
- `qa-tester` (sonnet) — runtime/manual validation
- `scientist` (sonnet) — data analysis and statistical reasoning
- `document-specialist` (sonnet) — SDK/API/framework documentation lookup
- `git-master` (sonnet) — commit strategy and history hygiene
- `code-simplifier` (opus) — behavior-preserving simplification
- `critic` (opus) — plan/design challenge and review

## Model Routing

- `haiku` — quick lookups, lightweight inspection, narrow docs work
- `sonnet` — standard implementation, debugging, and review
- `opus` — architecture, deep analysis, consensus planning, and high-risk review
- `fable` — Claude Fable 5, above Opus, when passed explicitly

The session model chosen with `/model` drives only the main loop; delegated agents run on their pinned tier unless `model` is passed or `agents.<name>.model` overrides it.

## Tools Reference

### External AI / orchestration
- `/team N:executor "task"` (`team-exec` worker type: executor, debugger, designer, codex, gemini, antigravity)
- `omc team N:codex|gemini "..."`
- `omc ask <claude|codex|gemini|antigravity|grok|cursor>` (skill: `/oh-my-claudecode:ask`)
- Multi-model synthesis (formerly `/ccg`, removed in 5.0.0): `/oh-my-claudecode:ask codex` + `/oh-my-claudecode:ask antigravity`, then synthesize, or `/team`

### OMC CLI (OMC 5)
- `omc ralph verify [--write-baseline] [--session <id>]` — feedback baseline and gate that `ralph` runs itself; the global CLI must match the plugin (a 4.x CLI lacks it, and `ralph` then stops)
- `omc ultragoal create-goals|complete-goals|checkpoint|record-review-blockers|status` — durable multi-goal ledger under `.omc/ultragoal/`

### OMC state
- `state_read`, `state_write`, `state_clear`, `state_list_active`, `state_get_status`, `state_migrate_non_git`

### Wiki, shared memory, traces
- `wiki_ingest`, `wiki_query`, `wiki_list`, `wiki_read`, `wiki_lint`, `wiki_add`, `wiki_delete`
- `shared_memory_read`, `shared_memory_write`, `shared_memory_list`, `shared_memory_delete`, `shared_memory_cleanup`
- `trace_timeline`, `trace_summary`, `session_search`

### Team runtime
- Claude Code 2.1.178+ removed native `TeamCreate`/`TeamDelete`. With `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` each session has one implicit team: spawn teammates directly with the Agent/Task tool (`name="worker-N"`) and coordinate through `SendMessage` and the shared task list (`TaskCreate`, `TaskList`, `TaskGet`, `TaskUpdate`)

### Notepad
- `notepad_read`, `notepad_write_priority`, `notepad_write_working`, `notepad_write_manual`

### Project memory
- `project_memory_read`, `project_memory_write`, `project_memory_add_note`, `project_memory_add_directive`

### Code intelligence
- LSP: `lsp_hover`, `lsp_goto_definition`, `lsp_find_references`, `lsp_diagnostics`, and related helpers
- AST: `ast_grep_search`, `ast_grep_replace`
- Utility: `python_repl`

## Skills Registry

Invoke built-in workflows via `/oh-my-claudecode:<name>` (OMC 5.6.1).

### Canonical workflows (Tier-0)
- `plan` → `execute` → `review` → `verify` — plan, build, review, verify. As plugin skills they are `/oh-my-claudecode:plan` and `/oh-my-claudecode:review`; a standalone install (`omc setup` copying skills into `~/.claude/skills/`) names them `omc-plan` and `omc-review`, because the bare names collide with Claude Code's own `/plan` and `/review`
- `ralplan` — consensus planning (Planner → Architect → Critic); stops at a `pending approval` plan
- `deep-interview` — Socratic ambiguity-gated requirements workflow

### Directly invocable workflows
- `autopilot` — full autonomous execution from idea to working code
- `ralph` — PRD-driven persistence loop with a configurable reviewer; needs the `omc` CLI (`omc ralph verify`)
- `ultragoal` — durable multi-goal plan and ledger with Claude Code `/goal` handoff
- `autoresearch` — stateful single-mission improvement loop

### Lanes and quality
- `team` — N coordinated agents on a shared task list (`team-plan` → `team-prd` → `team-exec` → `team-verify` → `team-fix`)
- `research` — grounded, sourced investigation; `external-context` — parallel external doc lookup
- `trace` — competing-hypothesis tracing; `debug` — diagnose OMC session or repo state
- `verify` — evidence before a completion claim (gathers evidence, does not fix)
- `visual-verdict` — screenshot-to-reference QA verdict
- `tdd` — test-first at agreed seams
- `ai-slop-cleaner` — regression-safe cleanup, an opt-in lane of `review`
- `minimal-code-discipline`, `minimal-prose-discipline`, `agent-doc-discipline` — writing-time disciplines for code, replies, and agent-facing docs

### Shipyard and repo workflows
- `drydock` (harness seed), `launch` (governed delivery pipeline), `harbor` (intake of issues and PRs), `intent` (requirements intake), `ask-navigator` (decision map), `map` (which skill owns which job), `loft` (throwaway design artifact), `refit` (environment retrospective), `architecture-survey`
- `graph` (declarative DAG runtime), `diagram`, `pr` (PR body from OMC's paper trail), `release`, `deepinit`, `self-improve`

### Utility skills
- `ask`, `cancel`, `remember`, `skillify`, `skill`, `wiki`, `omc-setup`, `omc-doctor`, `hud`, `project-session-manager` (alias `psm`), `configure-notifications`

### Retired in OMC 5 (removed, no alias)

| Removed | Use instead |
|---|---|
| `ultrawork`, `pipeline` | `execute` (or `team` for coordinated parallel workers) |
| `ultraqa` | `verify` |
| `ultrapilot`, `swarm`, `omc-teams` | `team` (or `omc team`) |
| `merge-readiness`, `understanding-gate` | `review` |
| `deep-dive`, `sciomc` | `research` |
| `ccg` | `ask` + `team` |
| `setup` | `omc-setup` |
| `mcp-setup` | `claude mcp add <name> ...` |
| `omc-reference` | `wiki` |
| `learner`, `writer-memory` | `remember` |
| `local-build-reminder` | none |

### Keyword triggers kept compact in CLAUDE.md
- `"autopilot"→autopilot`
- `"ralplan"→ralplan`
- `"deep interview"→deep-interview`
- `"deslop" / "anti-slop"→ai-slop-cleaner` (opt-in lane of review)
- `"deep-analyze"→analysis mode`
- `"tdd"→TDD mode`
- `"deepsearch"→codebase search`
- `"ultrathink"→deep reasoning`
- `"cancelomc"→cancel`
- Team orchestration is explicit via `/team`.

## Team Pipeline

Stages: `team-plan` → `team-prd` → `team-exec` → `team-verify` → `team-fix` (loop).

- Use `team-fix` for bounded remediation loops.
- `team ralph` links the team pipeline with Ralph-style sequential verification.
- Prefer team mode when independent parallel lanes justify the coordination overhead.

## Commit Protocol

Use git trailers to preserve decision context in every commit message.

### Format
- Intent line first: why the change was made
- Optional body with context and rationale
- Structured trailers when applicable

### Common trailers
- `Constraint:` active constraint shaping the decision
- `Rejected:` alternative considered | reason for rejection
- `Directive:` forward-looking warning or instruction
- `Confidence:` `high` | `medium` | `low`
- `Scope-risk:` `narrow` | `moderate` | `broad`
- `Not-tested:` known verification gap

### Example
```text
feat(docs): reduce always-loaded OMC instruction footprint

Move reference-only orchestration content into a native Claude skill so
session-start guidance stays small while detailed OMC reference remains available.

Constraint: Preserve CLAUDE.md marker-based installation flow
Rejected: Sync all built-in skills in legacy install | broader behavior change than issue requires
Confidence: high
Scope-risk: narrow
Not-tested: End-to-end plugin marketplace install in a fresh Claude profile
```

## OMX (Codex) Catalog

**런타임:** oh-my-codex(OMX), Codex CLI. 설치/점검 `omx setup` · `omx doctor`. 스킬은
`~/.codex/skills/<name>/SKILL.md`(**dir == frontmatter name**)를 자동탐색. 실측 기준 oh-my-codex
0.20.2 패키지 — `omx setup` 이 까는 묶음은 그 일부일 수 있고 버전에 따라 목록이 바뀌니 설치 환경에서 확인.
OMX 는 OMC 5 와 달리 `ultraqa`·`ultrawork`·`swarm`·`pipeline` 을 아직 제공한다.

### OMX Agent Prompts
`~/.codex/prompts/*.md` (OMX 오케스트레이션이 사용). OMC 에이전트에 대응 + Codex 확장:
- 대응: `analyst` · `architect` · `critic` · `debugger` · `executor` · `verifier` · `explore` · `planner` · `git-master` · `designer` · `qa-tester` · `security-reviewer` · `test-engineer` · `writer` · `code-reviewer` · `code-simplifier`
- 확장: `vision` · `researcher` · `ux-researcher` · `product-manager` · `product-analyst` · `information-architect` · `dependency-expert` · `api-reviewer` · `performance-reviewer` · `quality-reviewer` · `quality-strategist` · `style-reviewer` · `scholastic` · `team-orchestrator` · `team-executor` · `build-fixer` · `explore-harness` · `sisyphus-lite` · `prometheus-strict-{metis,momus,oracle}`

### OMX Skills Registry
`$<name>` 로 호출:
- **오케스트레이션**: `ralph` · `ralplan` · `plan` · `ultraqa` · `ultrawork` · `ultragoal` · `autopilot` · `team` · `swarm` · `pipeline` · `tdd` · `ai-slop-cleaner` · `visual-ralph` · `visual-verdict` · `ralph-init` · `cancel`
- **리서치/분석**: `autoresearch` · `autoresearch-goal` · `best-practice-research` · `deepsearch` · `analyze` · `trace`
- **자문/리뷰**: `ask`(로컬 Claude/Gemini 자문 통합 진입점; 구 `ask-claude`·`ask-gemini` 스킬도 병존) · `review` · `code-review` · `security-review`
- **셋업/유틸**: `omx-setup` · `doctor` · `hud` · `wiki` · `note` · `skill` · `help` · `configure-notifications` · `ecomode` · `design` · `frontend-ui-ux` · `web-clone` · `build-fix` · `git-master` · `performance-goal` · `prometheus-strict` · `deep-interview` · `worker`

### OMX Interfaces
- **스킬**: `~/.codex/skills/<name>/`(dir==name). **커맨드/프롬프트**: `~/.codex/prompts/<name>.md`(스킬 목록과 별개 표면).
- **외부 LLM**: `$ask`(로컬 Claude/Gemini CLI 자문).
- **MCP**: `codex mcp add <NAME> (--url <URL> | -- <COMMAND>...)`.
- **`/copy` 등 슬래시 명령은 Codex TUI 내장**(컴파일 바이너리 — `~/.codex/skills`·`prompts`·`--help` 목록엔 안 뜸).
- ⚠️ `~/.codex/AGENTS.md` 본문은 `omx setup/doctor` 가 재생성 → **직접 쓰지 말 것**(조각 소실). `omx setup --merge-agents` 로 다시 만들 때 남는 것은 `<!-- USER:OMX:POLICY:START -->` … `<!-- USER:OMX:POLICY:END -->` 로 감싼 블록뿐이고(banker `tone-compact` 가 이 방식), `--force` 나 덮어쓰기 확인으로 새로 쓰면 그 블록도 사라진다(백업은 `~/.omx/backups/setup/`). 비대화형 `omx setup` 은 기존 AGENTS.md 덮어쓰기를 건너뛴다.

### OMC ↔ OMX 대응
OMC(Claude) ↔ OMX(Codex) 는 대체로 대칭이다: `claude mcp`↔`codex mcp`, `~/.claude`↔`~/.codex`,
`/copy`(양쪽 내장), 에이전트/스킬 이름 대응(1:1은 아님). banker/join-us 스킬은 양 런타임에 동일
본문으로 배포되며(Codex 복사 시 frontmatter `name:`만 `<plugin>-<name>` 으로 재작성) 본문이
**런타임 인식**으로 두 형태를 병기한다.
