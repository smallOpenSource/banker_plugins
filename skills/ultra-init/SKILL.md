---
name: ultra-init
description: "아이디어나 대략적인 요구, 새 프로젝트를 한 번의 지시로 받아 계획, 구현, QA 통과까지 자율 실행. `ralplan`, `ralph`, 독립 QA 게이트(Claude Code 는 `verify` 순환, Codex 는 `ultraqa`)를 차례로 씀. 'ultra-init'/'알아서 만들어'/'핸즈오프 빌드'/'idea to passing' 시 사용."
argument-hint: "[--short|--deliberate] [--gated] [--qa tests,build,lint,typecheck] [--critic=architect|critic|codex] <브리프 / 만들 것>"
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
- **No ultraqa.** OMC 5.0.0 retired it; Phase 3 runs its replacement gate.
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
2. **The QA gate runs only in Phase 3, AFTER ralph has finished**, as the terminal QA sub-gate — never concurrently with ralph. On Claude Code its bounded verify → fix cycle is the one loop ultra-init owns (OMC 5 removed `ultraqa`, which used to own it); on Codex OMX's `ultraqa` owns it.
3. **There is no ultrawork phase.** OMC 5.0.0 retired `ultrawork`; ralph's own parallel delegation covers it inside Phase 2.
</Loop_Authority_Rules>

## Phases

### Phase 0 — Preflight (준비)
- Resolve the brief from the skill arguments. If it is empty, ask once for the brief, then proceed.
- Parse flags: planning depth (`--deliberate` = default, `--short` = lighter ralplan), `--gated`, `--qa <dims>`, `--critic=...`. An old `--plan-id <id>` (the retired ledger's id) is ignored; say so.
- **OMC prerequisite (Claude Code: OMC 5 with a matching `omc` CLI)**: this skill orchestrates OMC's `ralplan`/`ralph` and a QA gate on OMC's `verify` workflow. OMC 5's `ralph` runs `omc ralph verify` on its first iteration and stops when the command is missing, and a global `omc` CLI older than the plugin (4.x) lacks it. Judge by the output, not the exit code (given `--help`, a 4.x CLI prints its general help and exits 0; without `--help` an unknown command makes the CLI launch Claude Code, so keep it):
  ```bash
  omc ralph verify --help 2>&1 | grep -q 'Usage: omc ralph verify' && echo "omc ok" || echo "omc CLI missing or too old"
  ```
  If the check fails, **guide installation or update first** via `/banker:setup` → oh-my-claudecode (or the `setup-omc` skill / `npm install -g oh-my-claude-sisyphus@latest`), then resume once it passes. There is no way around a missing or stale CLI: ralph itself stops without `omc ralph verify`, so do not start Phase 1.
- **런타임 매핑 (Claude Code ↔ Codex).** `ralplan`·`ralph`·`cancel` 은 Claude Code에선 OMC, **Codex에선 oh-my-codex(OMX)가 제공하는 동명 스킬**이다(Codex는 `omx setup` 전제, 점검은 `omx --version`). OMX 의 `ralph` 는 `omc` CLI 를 쓰지 않으므로 위 `omc` 점검은 Claude Code 에만 해당한다. Phase 3 QA 게이트는 Claude Code(OMC 5)에선 아래 verify 순환이고, **Codex에선 OMX 가 아직 제공하는 `ultraqa`** 다. 아래 Phase들의 `Skill("oh-my-claudecode:<name>")` 표기는 Claude Code 기준 — **Codex 런타임에선 OMX의 해당 스킬을 적용**한다.

### Phase 1 — PLAN: ralplan --deliberate (합의 계획)
- Invoke `Skill("oh-my-claudecode:ralplan")` with `--deliberate <brief>` in **non-interactive** mode (so it produces the consensus-approved plan, marks it `pending approval`, and **stops without launching team/ralph itself** — ultra-init controls the hand-off).
- ralplan runs **Planner → Architect → Critic** to consensus (max 5 iterations), and in deliberate mode adds a **pre-mortem (3 scenarios) + expanded test plan (unit/integration/e2e/observability)**.
- Capture the final plan and its path in `.omc/plans/`: **ADR + ordered user stories + per-story testable acceptance criteria + the test plan**. This is the seed for Phases 2–3 and the durable record of the run.
- Autonomy: treat the consensus-approved plan as approved-for-execution and continue. (`--gated` → pause here for user approval, then continue.)

### Before Phase 2 — record what already fails
- Run each targeted QA dimension's command once on the unchanged tree and keep the failing items (test names, error lines). This **pre-change record** is the QA gate's baseline: it covers checks outside ralph's feedback commands, and on Codex it is the only baseline (OMX `ralph` keeps none).
- Never use `git stash` or `git reset` for this; if the tree already has changes, take the record from a clean copy of HEAD (`git worktree add --detach <tmp> HEAD`, run there, then `git worktree remove <tmp>`). A fresh worktree has no installed dependencies (`node_modules`, a venv): link or install them there first, and confirm the commands really ran — a record made only of "command not found" errors is no baseline.
- The record lives only in this conversation; if the session may compact or end before Phase 3, put it in the `ready-compact` note.

### Phase 2 — EXECUTE: ralph (영속 실행)
- Invoke `Skill("oh-my-claudecode:ralph")` and pass **the plan path plus its stories and acceptance criteria** as ralph's input, so ralph's `prd.json` refinement (its Step 1c) adopts the high-quality, task-specific criteria already produced in Phase 1 — skipping generic "Implementation is complete" PRD theater. Thread `--critic=...` through if specified.
- **No questions mid-run:** ralph 5.6.1 asks the user once for the PRD's `repoQualityClass` (`prototype`, `production` or `library`) when the task does not say. Infer it from repo signals (CI config, test depth, published package metadata) and put it in the handoff; let ralph ask only when the signals genuinely conflict.
- ralph first records the feedback baseline (`omc ralph verify --write-baseline`: the failures that already existed), then iterates **story-by-story**, delegating to parallel agents where stories allow, until all stories `passes: true`, followed by **reviewer verification → mandatory ai-slop-cleaner deslop → post-deslop regression re-verify**. ralph is the loop authority for this phase. Note its session id (the `<id>` in its PRD path `.omc/state/sessions/<id>/prd.json`) and the baseline failures it reports at its closeout; Phase 3 uses both.
- **Feedback commands must print only failures.** OMC 5.6.1's `omc ralph verify` fingerprints every output line and normalizes only `<number><unit>` durations, timestamps, `/tmp` paths and hex ids, so a summary line that changes between runs or when tests are added reads as a NEW failure (node:test's default reporter: `ℹ duration_ms 151.4`, `ℹ tests 8` — red on every run with no change). Have ralph set the PRD `feedbackCommands` before it records the baseline to forms that are constant on success and name each failure (node:test: `FORCE_COLOR=0 NODE_NO_WARNINGS=1 node --test --test-reporter=dot 2>&1 | grep -Ev '^[.X]+$'` — the variables keep color codes from slipping past the filter and process-id warnings out of the output; adapt the form on Windows). If the gate still flags only such lines, fix the commands and re-record ralph's baseline on the current tree (`omc ralph verify --write-baseline`); the pre-change record still tells old failures from new ones. Never edit the baseline file by hand; never stash or reset.
- Do not interrupt on "The boulder never stops" continuations — that signal means ralph's iteration continues. Let it run to completion.

### Phase 3 — QA GATE (QA 순환)
- After ralph completes, run the terminal cross-dimension QA gate, one dimension at a time, for each dimension the project supports (default order `typecheck → lint → build → tests`, or the `--qa` list).
- **Claude Code (OMC 5)** — per dimension, a bounded cycle (no state file; the count lives in this conversation):
  1. `Task(subagent_type="oh-my-claudecode:verifier", ...)` — a fresh context that did not build the change — follows the `oh-my-claudecode:verify` workflow for that dimension, runs the project's real command, and returns PASS or FAIL with the command, its output and each failing item. Whether a failure predates the change is not judged by eye. A failure is **pre-existing only** when the pre-change record lists it, or when `omc ralph verify --session <ralph's session id> --json` leaves it out of `newFailures` (cancel leaves the baseline in place; check that `baselinePresent` is `true` — without a baseline it reports every current failure as new). **Everything else is new**, and so is a pre-existing failure that points at a file the change touched, as in ralph.
  2. PASS → next dimension. FAIL → `Task(subagent_type="oh-my-claudecode:architect", ...)` diagnoses (read-only), `Task(subagent_type="oh-my-claudecode:executor", ...)` makes the smallest fix in scope, and a **fresh** verifier checks again.
  3. At most 5 verifications per dimension; when the 5th still fails, stop without another fix. Stop early when the same failure recurs 3×. Never fix a baseline failure here; report it.
- **Codex (OMX)** — invoke OMX `$ultraqa` with the matching goal (`--typecheck` / `--lint` / `--build` / `--tests`); OMX still ships it and owns that cycle. OMX keeps no feedback baseline, so hand it the pre-change record, tell it not to fix those failures, and report them apart.
- This is a belt-and-suspenders gate over ralph's own regression: a final all-green check under ultra-init's authority (ralph has already finished, so there is no competing loop).

### Phase 4 — COMPLETE (완료 / 정리)
- `Skill("oh-my-claudecode:cancel")` → clear ralph / mode state cleanly (don't leave stale state files).
- Emit a **concise, evidence-backed summary**: what was planned (plan path), stories delivered, files touched, reviewer verdict, deslop result, per-dimension QA results, and the baseline failures that predate the change, listed apart.
- **Resuming an interrupted run:** the plan file in `.omc/plans/` and ralph's PRD (`.omc/state/sessions/<id>/prd.json`, with its stories' `passes` flags) are the durable record. Hand both to a new `ralph` run; for a new session, prepare it with `ready-compact --hand-off`, which must also carry the pre-change record and the first ralph session id. On resume, judge Phase 3 against those, not against the baseline a new ralph records on the half-changed tree: that baseline would excuse regressions made before the interruption. The same goes for a resume in the same session: a new ralph's first iteration rewrites the baseline at the same path, so judge by the pre-change record alone.

<Stop_Conditions>
Even in autonomous mode, STOP and report when:
- A hard blocker needs user input (missing credentials, external service down, a genuinely ambiguous requirement that scoping cannot resolve).
- The user says stop / cancel / abort → run `Skill("oh-my-claudecode:cancel")`.
- The `omc` CLI check in Phase 0 fails and the user does not update it — ralph cannot run.
- The same failure recurs **3×** across iterations — surface it as a potential fundamental problem (mirrors the early exit of ralph and the QA gate).
- ralplan cannot reach consensus within 5 iterations → present the best plan and ask whether to proceed.

Otherwise: do not stop, and do not ask for permission between phases.
</Stop_Conditions>

<Final_Checklist>
- [ ] Phase 0: on Claude Code the `omc` CLI answered `omc ralph verify --help` with its usage (Codex: `omx --version`)
- [ ] Phase 1: consensus-approved plan in `.omc/plans/` with ADR, ordered stories, testable acceptance criteria, and an expanded test plan (deliberate)
- [ ] Phase 2: every ralph story `passes: true`; reviewer verification passed; ai-slop-cleaner deslop done; post-deslop regression green
- [ ] Phase 3: QA gate green for every targeted dimension (typecheck / lint / build / tests) by a fresh verifier backed by `omc ralph verify --json` (Codex: ultraqa); baseline failures reported apart, not fixed
- [ ] Phase 4: mode state cancelled & cleaned; summary names the plan path
- [ ] Final summary emitted with fresh evidence (no "should" / "looks good" claims — show actual command output)
</Final_Checklist>

## Notes
- **Thin-orchestrator rule:** always invoke the real skills/CLI; never duplicate their internals here (Phase 3's bounded cycle is the one exception, because OMC 5 no longer ships `ultraqa`). Identifier reference: `ralplan`, `ralph`, `verify`, `cancel` are **skills** → `Skill("oh-my-claudecode:<name>")`; `architect`, `critic`, `executor`, `verifier`, `qa-tester` are **agents** → `Task(subagent_type="oh-my-claudecode:<name>", ...)`. If an `oh-my-claudecode:<name>` Skill call ever errors with "Agent type not found", you used `Task` for a skill — retry via the `Skill` tool (do not substitute a similarly-named agent).
- **Overrides recap:** `--short` (lighter ralplan), `--gated` (approval pause after planning), `--qa tests,build` (limit QA dims), `--critic=architect|critic|codex` (ralph reviewer). `--plan-id` went away with the ledger step.
- **Relationship to autopilot:** ultra-init is autopilot-shaped, but adds explicit **deliberate** consensus planning up front and an explicit **terminal QA gate**. If the user wants the stock autonomous pipeline instead, that's `autopilot`; for a durable multi-goal ledger across sessions, `ultragoal`.
