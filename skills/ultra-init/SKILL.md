---
name: ultra-init
description: "아이디어나 대략적인 요구, 새 프로젝트를 한 번의 지시로 받아 계획, 구현, QA 통과까지 자율 실행. `ralplan`, `ralph`, 두 런타임 모두 `ralph-qa` 의 독립 QA 게이트를 차례로 씀. 'ultra-init'/'알아서 만들어'/'핸즈오프 빌드'/'idea to passing' 시 사용."
argument-hint: "[--short|--deliberate] [--gated] [--qa tests,build,lint,typecheck,scenarios] [--critic=architect|critic|codex] <브리프 / 만들 것>"
level: 4
---

# ultra-init — 자율 풀사이클 오케스트레이터 (Autonomous Full-Cycle Orchestrator)

## 한 줄 요약
거친 브리프 하나를 받아 **계획 → 영속 실행 → QA**까지 멈추지 않고 끝내는, OMC 스킬을 묶은 단일 진입점.

<Purpose>
ultra-init is a **THIN ORCHESTRATOR**. It does NOT re-implement the skills it bundles — it INVOKES each one in dependency-correct order and supplies only the connective tissue: hand-offs, conflict/precedence rules, and a single completion gate. Because it always calls the real skills, its behavior stays in sync as each skill evolves. Do not copy any sub-skill's internals into this file.

Bundled pipeline (effective execution order):

```
ralplan --deliberate  →  ralph  →  QA gate  →  complete
계획(합의)               영속 실행   QA 순환    완료/정리
```

**Order note:** the literal request listed `ralplan --deliberate → ralph → ultragoal → ultrawork → ultraqa`. On OMC 5 three of those changed:
- **No ultrawork step.** OMC 5.0.0 retired `ultrawork` (replacement: `execute` / `team`); ralph delegates its stories to parallel agents itself.
- **No ultraqa.** OMC 5.0.0 retired it; Phase 3 runs banker's `ralph-qa` on both runtimes instead (on Codex too, where OMX still ships its own).
- **No ultragoal ledger.** OMC 5.6.1's `omc ultragoal checkpoint` records progress only for a goal started with `complete-goals`, and only with a snapshot of the Claude Code `/goal` that goal arms. Arming `/goal` would put a second Stop-hook loop beside ralph's, so ultra-init does not use the ledger. The run stays resumable through the plan file and ralph's PRD (Phase 4). If a durable multi-goal ledger is what the user wants, that is the separate `/oh-my-claudecode:ultragoal` workflow.

So the effective order is `ralplan → ralph → QA gate`. This is intentional, not a mistake.
</Purpose>

<Autonomy_Contract>
- **기본값 = 완전 자율 (default = fully autonomous).** Invoking `/ultra-init` *is itself* explicit execution approval for the current turn. This satisfies ralplan's planning/execution boundary, so the pipeline proceeds **past ralplan's "pending approval" gate without pausing**.
- Run all phases end-to-end with **no approval prompts between them**.
- The only legitimate stops are in `<Stop_Conditions>` below.
- Overrides (opt out of autonomy when needed): `--gated` = pause for user approval right after Phase 1 (planning), then continue automatically. The baked-in default with no flag is fully autonomous.
</Autonomy_Contract>

<Loop_Authority_Rules>
Several bundled skills are loop/persistence engines. To prevent competing loops, **only ONE loop authority is active at a time, and the phases run strictly sequentially** (a phase fully completes before the next begins):

1. In **Phase 2, ralph is the sole loop authority** ("the boulder never stops"). Let its loop run to completion. Do **NOT** arm a Claude Code `/goal` Stop-hook loop beside it.
2. **The QA gate runs only in Phase 3, AFTER ralph has finished**, as the terminal QA sub-gate — never concurrently with ralph. banker's `ralph-qa` owns that judge → fix loop on both runtimes; ultra-init owns no loop.
3. **There is no ultrawork phase.** OMC 5.0.0 retired `ultrawork`; ralph's own parallel delegation covers it inside Phase 2.
</Loop_Authority_Rules>

## Phases

### Phase 0 — Preflight (준비)
- Resolve the brief from the skill arguments. If it is empty, ask once for the brief, then proceed.
- Parse flags: planning depth (`--deliberate` = default, `--short` = lighter ralplan), `--gated`, `--qa <dims>`, `--critic=...`. An old `--plan-id <id>` (the retired ledger's id) is ignored; say so.
- **OMC prerequisite (Claude Code: OMC 5 with a matching `omc` CLI)**: this skill orchestrates OMC's `ralplan`/`ralph`, then banker's `ralph-qa` as the QA gate. OMC 5's `ralph` runs `omc ralph verify` on its first iteration and stops when the command is missing, and a global `omc` CLI older than the plugin (4.x) lacks it. Judge by the output, not the exit code (given `--help`, a 4.x CLI prints its general help and exits 0; without `--help` an unknown command makes the CLI launch Claude Code, so keep it):
  ```bash
  omc ralph verify --help 2>&1 | grep -q 'Usage: omc ralph verify' && echo "omc ok" || echo "omc CLI missing or too old"
  ```
  If the check fails, **guide installation or update first** via `/banker:setup` → oh-my-claudecode (or the `setup-omc` skill / `npm install -g oh-my-claude-sisyphus@latest`), then resume once it passes. There is no way around a missing or stale CLI: ralph itself stops without `omc ralph verify`, so do not start Phase 1.
- **런타임 매핑 (Claude Code ↔ Codex).** `ralplan`·`ralph`·`cancel` 은 Claude Code에선 OMC, **Codex에선 oh-my-codex(OMX)가 제공하는 동명 스킬**이다(Codex는 `omx setup` 전제, 점검은 `omx --version`). OMX 의 `ralph` 는 `omc` CLI 를 쓰지 않으므로 위 `omc` 점검은 Claude Code 에만 해당한다. Phase 3 QA 게이트는 두 런타임 모두 banker `ralph-qa` 다: Claude Code `Skill("banker:ralph-qa")`, Codex npm 길 `$banker-ralph-qa`, 플러그인 길 `$banker:ralph-qa`. Codex 에는 Skill 도구가 없으니 그 `SKILL.md` 를 읽고 그대로 따른다(npm 길 `<S>/../banker-ralph-qa/SKILL.md`, 플러그인 길 `<S>/../ralph-qa/SKILL.md`, `<S>` 는 이 스킬 폴더). `<RQ>` 는 ralph-qa 의 `references` 폴더다(Claude Code 와 Codex 플러그인 길 `<S>/../ralph-qa/references`, Codex npm 길 `<S>/../banker-ralph-qa/references`). 아래 Phase들의 `Skill("oh-my-claudecode:<name>")` 표기는 Claude Code 기준 — **Codex 런타임에선 OMX의 해당 스킬을 적용**한다.
- **Codex 의 tmux 밖 실행.** OMX 의 런타임 워크플로(`ralph`, `team` 등)는 OMX tmux 런타임을 요구한다. OMX 의 `AGENTS.md` 는 tmux 밖(Codex App, 일반 `codex`, `codex exec`)이면 그 사실을 알리고 가장 가까운 대체 경로로 계속하라고 정한다(oh-my-codex 0.20.2 `templates/AGENTS.md`). 그래서 tmux 밖이라는 사실만으로는 멈추지 않는다. 그 단계는 이 세션이 그 스킬의 `SKILL.md` 절차를 네이티브 하위 에이전트로 그대로 따르고, 보고에 `<단계>: tmux 밖 대체 실행(OMX 런타임 없음)` 한 줄을 적는다. 종결 낱말은 다른 멈춤 조건과 마지막 ralph-qa 판정으로만 정한다. 대체 실행도 할 수 없으면(하위 에이전트 기능이 꺼짐 등) `STOPPED(omx-runtime-unavailable)` 로 멈추고 tmux 안의 OMX 에서 다시 실행하라고 안내한다.
- **Codex 의 계획과 상태 경로.** 이 문서의 `.omc/plans/`, `.omc/state/sessions/<id>/prd.json` 은 Claude Code(OMC) 경로다. Codex 에서는 OMX 경로를 쓴다: 계획은 `.omx/plans/`(ralplan 이 쓰는 `prd-*.md`, `test-spec-*.md`), ralph 의 진행 기록은 `.omx/state/<scope>/ralph-progress.json`. Codex 에서 `.omc/` 아래에 계획을 쓰지 않는다.

### Phase 1 — PLAN: ralplan --deliberate (합의 계획)
- Invoke `Skill("oh-my-claudecode:ralplan")` with `--deliberate <brief>` in **non-interactive** mode (so it produces the consensus-approved plan, marks it `pending approval`, and **stops without launching team/ralph itself** — ultra-init controls the hand-off).
- ralplan runs **Planner → Architect → Critic** to consensus (max 5 iterations), and in deliberate mode adds a **pre-mortem (3 scenarios) + expanded test plan (unit/integration/e2e/observability)**.
- Capture the final plan and its path in `.omc/plans/`: **ADR + ordered user stories + per-story testable acceptance criteria + the test plan**. This is the seed for Phases 2–3 and the durable record of the run.
- Autonomy: treat the consensus-approved plan as approved-for-execution and continue. (`--gated` → pause here for user approval, then continue.)

### Before Phase 2 — record what already fails
- Make the gate folder with `node '<RQ>/gate-evidence.mjs' init --cwd '<repo>'` (its `dir` is the gate folder `<g>`) and run each targeted QA dimension's command once on the unchanged tree, through ralph-qa's runner, as iteration 0: `node '<RQ>/gate-evidence.mjs' run --dir '<g>' --id <dimension> --cmd '<command>' --timeout <seconds> --iter 0 --cwd '<repo>'`. One command per dimension (no `&&` or `;` chains), a `--timeout` on each; `scenarios` has no baseline (its rows test the change).
- This **pre-change record** (iteration 0 in `<g>/evidence.md`) is the QA gate's baseline: ralph-qa counts a failure with the same command and failure signature as not this change's (`baseline`). It covers checks outside ralph's feedback commands, and on Codex it is the only baseline (OMX `ralph` keeps none). On Codex the runner writes outside the workspace: ask for approval to run it outside the sandbox.
- Never use `git stash` or `git reset` for this; if the tree already has changes, take the record from a clean copy of HEAD (`git worktree add --detach <tmp> HEAD`, run with `--cwd <tmp>`, then `git worktree remove <tmp>`). A fresh worktree has no installed dependencies (`node_modules`, a venv): link or install them there first, and confirm the commands really ran — a record made only of "command not found" errors is no baseline. The runner writes the folder a command ran in as `<repo>` in the failure signature, so a failure in the copy and the same failure in the repo match.
- The record lives in `<g>`; if the session may compact or end before Phase 3, put the `<g>` path in the `ready-compact` note. The gate folder lives until Phase 3 has its end word: no cleanup's day rule takes it (ralph-qa's gate folder rule).
- **Not a git repo** (common for a new project): if `init` (or `run`) stops with `not-a-git-tree` (exit 3, nothing made or run), first check that the folder the stop names (`checked` in its JSON, an absolute path) is the target repo; if not, call it again with `--cwd '<repo>'`. Only when the target really is no git repo: the gates cannot have evidence (the work tree fingerprint sees no change). Take no baseline, and in Phase 3 hand ralph-qa no `--gates`; it then writes `게이트: 선언 없음(git 저장소 아님)` in its report and seat instructions. Never run `git init` yourself: tell the user that `git init` and a first commit make the gates work next time. The same on both runtimes (Claude Code, and Codex on the npm and the plugin route).

### Phase 2 — EXECUTE: ralph (영속 실행)
- Invoke `Skill("oh-my-claudecode:ralph")` and pass **the plan path plus its stories and acceptance criteria** as ralph's input, so ralph's `prd.json` refinement (its Step 1c) adopts the high-quality, task-specific criteria already produced in Phase 1 — skipping generic "Implementation is complete" PRD theater. Thread `--critic=...` through if specified.
- **No questions mid-run:** ralph 5.6.1 asks the user once for the PRD's `repoQualityClass` (`prototype`, `production` or `library`) when the task does not say. Infer it from repo signals (CI config, test depth, published package metadata) and put it in the handoff; let ralph ask only when the signals genuinely conflict.
- ralph first records the feedback baseline (`omc ralph verify --write-baseline`: the failures that already existed), then iterates **story-by-story**, delegating to parallel agents where stories allow, until all stories `passes: true`, followed by **reviewer verification → mandatory ai-slop-cleaner deslop → post-deslop regression re-verify**. ralph is the loop authority for this phase. Note its session id (the `<id>` in its PRD path `.omc/state/sessions/<id>/prd.json`) for a resume, and the baseline failures it reports at its closeout for the Phase 4 summary.
- **Feedback commands must print only failures.** OMC 5.6.1's `omc ralph verify` fingerprints every output line and normalizes only `<number><unit>` durations, timestamps, `/tmp` paths and hex ids, so a summary line that changes between runs or when tests are added reads as a NEW failure (node:test's default reporter: `ℹ duration_ms 151.4`, `ℹ tests 8` — red on every run with no change). Have ralph set the PRD `feedbackCommands` before it records the baseline to forms that are constant on success and name each failure (node:test: `FORCE_COLOR=0 NODE_NO_WARNINGS=1 node --test --test-reporter=dot 2>&1 | grep -Ev '^[.X]+$'` — the variables keep color codes from slipping past the filter and process-id warnings out of the output; adapt the form on Windows). If the gate still flags only such lines, fix the commands and re-record ralph's baseline on the current tree (`omc ralph verify --write-baseline`); the pre-change record still tells old failures from new ones. Never edit the baseline file by hand; never stash or reset.
- Do not interrupt on "The boulder never stops" continuations — that signal means ralph's iteration continues. Let it run to completion.

### Phase 3 — QA GATE: banker ralph-qa (QA 순환)
- After ralph completes, invoke ralph-qa once with `--gates=<dimensions> --lens=both`: every dimension the project supports (default `typecheck,lint,build,tests`, or the `--qa` list; `scenarios` adds adversarial scenario rows). One run covers every dimension: its gate conjunct holds only when each one does.
- Hand it the plan path with its stories and acceptance criteria, the change since `HEAD` as Phase 2 began, the gate folder `<g>` with its iteration-0 baseline (ralph-qa uses it, runs no iteration 0 of its own and does not remove it), and each dimension's one command and timeout. Add the acceptance criterion "each dimension's real command ran through the runner (`gate-evidence.mjs run`) on the tree being judged, as an `observed` record"; a model's account of a command (`reported`) is not evidence. `<g>` holds the gate records only: ralph-qa sends any external-seat payload from a folder of its own.
- With `scenarios`: ralph-qa's nine adversarial classes (malformed input, repeated interruption, prompt injection, cancel and resume, stale state, dirty work tree, hung command, flaky test, misleading success output) each get a scenario row run as `scenario-<n>`, or a one-line reason it does not apply.
- Never fix a baseline failure here; report it apart. A baseline failure whose failing lines point at a file the change touched counts as new, as in ralph: the seats raise it as a blocker.
- If `<g>` is gone (the runner stops with `not-a-run-folder`: a logout or reboot emptied `$XDG_RUNTIME_DIR`, or it was removed): make a new one with `gate-evidence.mjs init` and hand that, with no iteration 0. Never run iteration 0 on the changed tree. Failures that were there before then count as this change's: put the line `gate baseline: none (<g> was gone)` in the summary, with ralph's closeout baseline list beside it.
- ralph-qa owns the loop: its seats judge, the author fixes, it runs the gates again and the same seats judge again, up to its `--max` (5). ultra-init adds no cycle. Read its end word (the word before any parenthesis): `APPROVE` is green; `ITERATE` (its `--max` spent; `원인 gate` when only the gates held it) or `INCONCLUSIVE` is a stop: report its verdict line, gate block and blockers left. Afterwards run `node '<RQ>/gate-evidence.mjs' cleanup --dir '<g>'` (a `<g>` named `ralph-qa.*`, made before this version, goes with `node '<RQ>/seat-run.mjs' cleanup --dir '<g>'`).
- This is a belt-and-suspenders gate over ralph's own regression: a final all-green check under ultra-init's authority (ralph has already finished, so there is no competing loop).

### Phase 4 — COMPLETE (완료 / 정리)
- `Skill("oh-my-claudecode:cancel")` → clear ralph / mode state cleanly (don't leave stale state files).
- Emit a **concise, evidence-backed summary**: what was planned (plan path), stories delivered, files touched, reviewer verdict, deslop result, ralph-qa's verdict line with its gate block (per dimension), and the baseline failures that predate the change (the `baseline` gates and ralph's closeout list), listed apart.
- **Resuming an interrupted run:** the plan file in `.omc/plans/` and ralph's PRD (`.omc/state/sessions/<id>/prd.json`, with its stories' `passes` flags) are the durable record. Hand both to a new `ralph` run; for a new session, prepare it with `ready-compact --hand-off`, which must also carry the `<g>` path (the pre-change record) and the first ralph session id. On resume, Phase 3 judges against the iteration-0 records in `<g>`; never run iteration 0 again on the half-changed tree, and do not judge by the baseline a new ralph records there: either would excuse regressions made before the interruption. The same goes for a resume in the same session.

<Stop_Conditions>
Even in autonomous mode, STOP and report when:
- A hard blocker needs user input (missing credentials, external service down, a genuinely ambiguous requirement that scoping cannot resolve).
- The user says stop / cancel / abort → run `Skill("oh-my-claudecode:cancel")`.
- The `omc` CLI check in Phase 0 fails and the user does not update it — ralph cannot run.
- The same failure recurs **3×** across iterations — surface it as a potential fundamental problem (mirrors the early exit of ralph and the QA gate).
- ralplan cannot reach consensus within 5 iterations → present the best plan and ask whether to proceed.
- Phase 3's ralph-qa ends `ITERATE` (its `--max` spent) or `INCONCLUSIVE` → report its verdict line and blockers; do not claim the gate passed.

After STOPPED, change no file, not even a one-line fix: report only, until the user gives a new instruction. Nothing in this skill (its description's "one-line fix" pointer included) authorizes an edit after a stop.

Otherwise: do not stop, and do not ask for permission between phases.
</Stop_Conditions>

<Final_Checklist>
- [ ] Phase 0: on Claude Code the `omc` CLI answered `omc ralph verify --help` with its usage (Codex: `omx --version`)
- [ ] Phase 1: consensus-approved plan in `.omc/plans/` with ADR, ordered stories, testable acceptance criteria, and an expanded test plan (deliberate)
- [ ] Phase 2: every ralph story `passes: true`; reviewer verification passed; ai-slop-cleaner deslop done; post-deslop regression green
- [ ] Before Phase 2: each targeted dimension but `scenarios` ran once through `gate-evidence.mjs run --iter 0` on the unchanged tree
- [ ] Phase 3: ralph-qa (`--gates=<dimensions>`) ended `APPROVE` on `observed` gate records for every targeted dimension (typecheck / lint / build / tests, and scenarios when asked); baseline failures reported apart, not fixed
- [ ] Phase 4: mode state cancelled & cleaned; summary names the plan path
- [ ] Final summary emitted with fresh evidence (no "should" / "looks good" claims — show actual command output)
</Final_Checklist>

## Notes
- **Thin-orchestrator rule:** always invoke the real skills/CLI; never duplicate their internals here. Identifier reference: `ralplan`, `ralph`, `cancel` are **skills** → `Skill("oh-my-claudecode:<name>")`, and banker's `ralph-qa` → `Skill("banker:ralph-qa")`; `architect`, `critic`, `executor`, `verifier`, `qa-tester` are **agents** → `Task(subagent_type="oh-my-claudecode:<name>", ...)`. If an `oh-my-claudecode:<name>` Skill call ever errors with "Agent type not found", you used `Task` for a skill — retry via the `Skill` tool (do not substitute a similarly-named agent).
- **Overrides recap:** `--short` (lighter ralplan), `--gated` (approval pause after planning), `--qa tests,build` (the ralph-qa `--gates` list; add `scenarios` for adversarial rows), `--critic=architect|critic|codex` (ralph reviewer). `--plan-id` went away with the ledger step.
- **Relationship to autopilot:** ultra-init is autopilot-shaped, but adds explicit **deliberate** consensus planning up front and an explicit **terminal QA gate**. If the user wants the stock autonomous pipeline instead, that's `autopilot`; for a durable multi-goal ledger across sessions, `ultragoal`.
