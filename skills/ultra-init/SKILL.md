---
name: ultra-init
description: Use this for one hands-off run that takes a feature idea, rough brief, or greenfield project from careful planning, through building, to a passing quality gate — planned, built, and verified in one autonomous pass with no step-by-step approval. 한 번의 명령으로 브리프를 신중한 계획→구현→검증까지 멈춤 없이 끝내는 자율 풀사이클. Trigger on the COMBINATION of (a) deliberate up-front planning, (b) hands-off building ("no babysitting", "don't approve each step", "처음부터 끝까지 자동", "멈추지 말고"), and (c) verify-until-green ("keep fixing until tests/typecheck/lint/build pass", "brief to merged-quality code"). Covers existing-codebase features and greenfield builds. Also trigger on "ultra init"/"ultra-init"/"풀사이클", or on requests to chain ralplan/ultragoal/ralph/ultrawork/ultraqa end-to-end. Prefer over autopilot, ralph, ralplan, or ultraqa used alone when the ask bundles planning AND building AND a QA gate. Skip for plan-only, review-only, a single bug fix, or a quick one-off edit.
argument-hint: "[--short|--deliberate] [--gated] [--qa tests,build,lint,typecheck] [--critic=architect|critic|codex] [--plan-id <id>] <브리프 / 만들 것>"
level: 4
---

# ultra-init — 자율 풀사이클 오케스트레이터 (Autonomous Full-Cycle Orchestrator)

## 한 줄 요약
거친 브리프 하나를 받아 **계획 → 목표 등록 → 영속 실행 → QA**까지 멈추지 않고 끝내는, 5개 OMC 스킬을 묶은 단일 진입점.

<Purpose>
ultra-init is a **THIN ORCHESTRATOR**. It does NOT re-implement the five skills it bundles — it INVOKES each one in dependency-correct order and supplies only the connective tissue: hand-offs, durable tracking, conflict/precedence rules, and a single completion gate. Because it always calls the real skills, its behavior stays in sync as each skill evolves. Do not copy any sub-skill's internals into this file.

Bundled pipeline (effective execution order):

```
ralplan --deliberate  →  ultragoal  →  ralph ( └ ultrawork inside )  →  ultraqa  →  complete
계획(합의)               목표 원장      영속 실행 (병렬 포함)            QA 순환      완료/정리
```

**Order note:** the literal request listed `ralplan --deliberate → ralph → ultragoal → ultrawork → ultraqa`. ultra-init runs the *dependency-correct* order instead: **ultragoal seeds goals BEFORE ralph executes**, and **ultrawork is subsumed by ralph** (ralph already runs ultrawork's parallel engine internally). So the effective order is `ralplan → ultragoal → ralph(+ultrawork) → ultraqa`. This is intentional, not a mistake.
</Purpose>

<Autonomy_Contract>
- **기본값 = 완전 자율 (default = fully autonomous).** Invoking `/ultra-init` *is itself* explicit execution approval for the current turn. This satisfies ralplan's planning/execution boundary, so the pipeline proceeds **past ralplan's "pending approval" gate without pausing**.
- Run all phases end-to-end with **no approval prompts between them**.
- The only legitimate stops are in `<Stop_Conditions>` below.
- Overrides (opt out of autonomy when needed): `--gated` = pause for user approval right after Phase 1 (planning), then continue automatically. The baked-in default with no flag is fully autonomous.
</Autonomy_Contract>

<Loop_Authority_Rules>
Several bundled skills are loop/persistence engines. To prevent competing loops, **only ONE loop authority is active at a time, and the phases run strictly sequentially** (a phase fully completes before the next begins):

1. In **Phase 3, ralph is the sole loop authority** ("the boulder never stops"). Let its loop run to completion.
2. **ultragoal runs in `artifact_only` mode** — durable plan + ledger + evidence only. Do **NOT** arm a competing Claude Code `/goal` Stop-hook loop while ralph is running. (Deterministic conflict policy: `artifact_only`, not ad-hoc warnings.)
3. **ultraqa runs only in Phase 4, AFTER ralph has finished**, as the terminal QA sub-gate — never concurrently with ralph.
4. **ultrawork is not a separate phase.** It is the parallel-execution engine ralph already runs internally; ultra-init surfaces it as ralph's engine, not a standalone step. (Standalone ultrawork remains available outside this pipeline if ever needed.)
</Loop_Authority_Rules>

## Phases

### Phase 0 — Preflight (준비)
- Resolve the brief from the skill arguments. If it is empty, ask once for the brief, then proceed.
- Parse flags: planning depth (`--deliberate` = default, `--short` = lighter ralplan), `--gated`, `--qa <dims>`, `--critic=...`, `--plan-id <id>`.
- Confirm the `omc` CLI is available (needed for ultragoal). If it is missing, run ultragoal in **degraded mode**: skip the durable ledger and instead write the approved plan to `plan.md` + rely on ralph's session-scoped `prd.json`. Say so explicitly when degrading.

### Phase 1 — PLAN: ralplan --deliberate (합의 계획)
- Invoke `Skill("oh-my-claudecode:ralplan")` with `--deliberate <brief>` in **non-interactive** mode (so it produces the consensus-approved plan, marks it `pending approval`, and **stops without launching team/ralph itself** — ultra-init controls the hand-off).
- ralplan runs **Planner → Architect → Critic** to consensus (max 5 iterations), and in deliberate mode adds a **pre-mortem (3 scenarios) + expanded test plan (unit/integration/e2e/observability)**.
- Capture the final plan: **ADR + ordered user stories + per-story testable acceptance criteria + the test plan**. This is the seed for Phases 2–4.
- Autonomy: treat the consensus-approved plan as approved-for-execution and continue. (`--gated` → pause here for user approval, then continue.)

### Phase 2 — SEED GOALS: ultragoal (영속 목표 원장)
- Turn the approved stories into a durable ledger:
  `omc ultragoal create-goals --brief-file <plan.md>` — or pass stories explicitly with repeated `--goal "Title::Objective"`. Use `--auto-plan-id` (or `--plan-id <id>` if the user provided one) so parallel sessions don't clobber each other under `.omc/ultragoal/plans/{planId}/`.
- Record the start event. Keep it **`artifact_only`** (durable plan + ledger + evidence) per `<Loop_Authority_Rules>` — do not arm a `/goal` loop that would compete with ralph.
- Benefit: cross-session resumability. If the session dies mid-run, the ledger + ralph's `prd.json` allow a clean resume.

### Phase 3 — EXECUTE: ralph (영속 실행, 내부 ultrawork 병렬)
- Invoke `Skill("oh-my-claudecode:ralph")` and pass **the brief plus the approved plan's stories and acceptance criteria** as ralph's input, so ralph's `prd.json` refinement (its Step 1c) adopts the high-quality, task-specific criteria already produced in Phase 1 — skipping generic "Implementation is complete" PRD theater. Thread `--critic=...` through if specified.
- ralph then iterates **story-by-story** (using ultrawork's parallel agent delegation internally) until all stories `passes: true`, followed by **reviewer verification → mandatory ai-slop-cleaner deslop → post-deslop regression re-verify**. ralph is the loop authority for this phase.
- Do not interrupt on "The boulder never stops" continuations — that signal means ralph's iteration continues. Let it run to completion.

### Phase 4 — QA GATE: ultraqa (QA 순환)
- After ralph completes, run the terminal cross-dimension QA gate. For each relevant dimension the project supports (default order `typecheck → lint → build → tests`, or the `--qa` list), invoke `Skill("oh-my-claudecode:ultraqa")` with the matching flag (`--typecheck` / `--lint` / `--build` / `--tests`).
- Each ultraqa run cycles up to 5 times: **RUN QA → architect diagnose → executor fix → repeat** until green (early-exits if the same failure recurs 3×).
- This is a belt-and-suspenders gate over ralph's own regression: a final all-green check under ultra-init's authority (ralph has already finished, so there is no competing loop).

### Phase 5 — COMPLETE (완료 / 정리)
- Final ultragoal checkpoint with quality-gate evidence:
  `omc ultragoal checkpoint --goal-id <final> --status complete --evidence "tests/files/PR evidence" --quality-gate-json '{ aiSlopCleaner, verification, codeReview — all clean }'`.
  If any gate is **not** clean, do NOT mark complete — instead `omc ultragoal record-review-blockers --goal-id <id> ...` and loop back to Phase 3 for those blockers.
- `omc ultragoal status` → confirm all goals are complete.
- `Skill("oh-my-claudecode:cancel")` → clear ralph / ultraqa / mode state cleanly (don't leave stale state files).
- Emit a **concise, evidence-backed summary**: what was planned, stories delivered, files touched, reviewer verdict, deslop result, per-dimension QA results, and the ledger location.

<Stop_Conditions>
Even in autonomous mode, STOP and report when:
- A hard blocker needs user input (missing credentials, external service down, a genuinely ambiguous requirement that scoping cannot resolve).
- The user says stop / cancel / abort → run `Skill("oh-my-claudecode:cancel")`.
- The same failure recurs **3×** across iterations — surface it as a potential fundamental problem (mirrors ralph & ultraqa early-exit).
- ralplan cannot reach consensus within 5 iterations → present the best plan and ask whether to proceed.

Otherwise: do not stop, and do not ask for permission between phases.
</Stop_Conditions>

<Final_Checklist>
- [ ] Phase 1: consensus-approved plan with ADR, ordered stories, testable acceptance criteria, and an expanded test plan (deliberate)
- [ ] Phase 2: ultragoal ledger seeded (or degraded-mode `plan.md` written if `omc` is unavailable)
- [ ] Phase 3: every ralph story `passes: true`; reviewer verification passed; ai-slop-cleaner deslop done; post-deslop regression green
- [ ] Phase 4: ultraqa green for every targeted dimension (typecheck / lint / build / tests)
- [ ] Phase 5: ultragoal final checkpoint with clean quality-gate evidence; status all-complete; mode state cancelled & cleaned
- [ ] Final summary emitted with fresh evidence (no "should" / "looks good" claims — show actual command output)
</Final_Checklist>

## Notes
- **Thin-orchestrator rule:** always invoke the real skills/CLI; never duplicate their internals here. Identifier reference: `ralplan`, `ralph`, `ultraqa`, `cancel` are **skills** → `Skill("oh-my-claudecode:<name>")`; `architect`, `critic`, `executor`, `qa-tester` are **agents** → `Task(subagent_type="oh-my-claudecode:<name>", ...)`; `ultragoal` is the **`omc` CLI**. If an `oh-my-claudecode:<name>` Skill call ever errors with "Agent type not found", you used `Task` for a skill — retry via the `Skill` tool (do not substitute a similarly-named agent).
- **Overrides recap:** `--short` (lighter ralplan), `--gated` (approval pause after planning), `--qa tests,build` (limit QA dims), `--critic=architect|critic|codex` (ralph reviewer), `--plan-id <id>` (stable ledger id for parallel runs).
- **Relationship to autopilot:** ultra-init is autopilot-shaped, but adds explicit **deliberate** consensus planning up front, **durable ultragoal tracking** across sessions, and an explicit **terminal ultraqa gate**. If the user wants the stock autonomous pipeline instead, that's `autopilot`.
