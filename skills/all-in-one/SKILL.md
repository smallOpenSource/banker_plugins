---
name: all-in-one
description: >-
  One-command composite pipeline that chains consensus planning → persistent
  verified implementation → an independent test gate by running
  /ralplan --deliberate, then /ralph --critic=critic on the resulting plan,
  then /ultraqa --tests as a final acceptance gate. Use this whenever the user
  says "all-in-one" / "all in one", or wants a substantial coding task taken
  end-to-end from plan → implementation → passing tests in a single command —
  especially when they want maximum front-loaded rigor (a consensus plan, a
  critic-verified build, and an independent QA gate) instead of running ralplan,
  ralph, and ultraqa by hand. Prefer this over invoking the three sub-skills
  manually. NOT for one-line fixes (use ralph or an executor) or vague
  idea-to-product expansion (use autopilot).
argument-hint: "[--short] [--checkpoint] [--critic=critic|architect|codex] [--qa=tests|build|lint|typecheck] [--no-deslop] <task description>"
level: 4
---

# /all-in-one — Plan → Implement → QA, one command

[ALL-IN-ONE ACTIVATED — SEQUENTIAL 3-STAGE PIPELINE]

## 0. Prerequisite: OMC (install first if missing)

This skill orchestrates OMC's `ralplan` → `ralph` → `ultraqa`. **Check the dependency before running**; if it is missing, **guide installation first** rather than failing mid-pipeline:
- Check: `command -v omc` and whether `/oh-my-claudecode:*` skills are available.
- If missing: install via `/banker:setup` → oh-my-claudecode (or the `setup-omc` skill / `omc update`), then resume. On Codex the equivalent is OMX (`omx setup`).

## Purpose

Run one substantial coding task through three independent quality gates in a
fixed order, each delegated to an existing OMC skill:

```
Stage 1  /ralplan --deliberate     consensus plan (Planner → Architect → Critic)
   │     → .omc/plans/ plan, "pending approval"
   ▼
Stage 2  /ralph --critic=critic    PRD-driven persistent build, critic-verified
   │     → implementation + deslop + regression, then ralph self-cancels
   ▼
Stage 3  /ultraqa --tests          independent test-cycling acceptance gate
         → PASS, or honest STOPPED-with-diagnosis
```

This skill is a **thin sequential orchestrator**. It does not implement, plan,
or test directly, and it does **not** create its own persistence loop or state
file — every loop, retry, and verification belongs to the sub-skill it
delegates to. Its only job is to invoke the three skills in order, bridge their
handoffs, gate each stage on the previous one's success, and report honestly.

## Why three stages (and not just ralph)

The three stages exist because they defend against three *distinct* failure
modes, and each stage's reviewer is independent of the previous stage's author
(the core anti-self-approval principle):

1. **Building the wrong or under-thought thing** → Stage 1's consensus +
   pre-mortem + expanded test plan catch this before any code is written.
2. **A partial or unverified build declared "done"** → Stage 2's PRD
   story-by-story persistence + critic verification catch this.
3. **Integration / regression breakage slipping past the builder's own checks**
   → Stage 3's fresh, test-focused, fix-cycling loop catches this.

**On the apparent redundancy of Stage 3:** ralph (Stage 2) already runs its own
Step-7 critic verification and Step-7.6 regression re-run on the changed-file
set. ultraqa (Stage 3) is still worth running because it is *independent* (fresh
agents, not the ones that built it), *test-suite-focused*, and *actively fixes*
in a cycle. If ralph's regression already ran the full suite green, ultraqa
usually confirms in cycle 1 (cheap); its value rises when the suite is broad,
when changes touched many files, or when integration/flaky issues hide behind
unit-level checks. Keeping it explicit gives a clean, separate PASS signal.

## When to use

- A substantial, mostly-specified coding task you want carried from plan →
  verified implementation → green test gate in one step, with the most
  front-loaded rigor OMC offers.
- You have been running `ralplan → ralph → ultraqa` by hand and want it as one
  command.
- The task is moderately under-specified — that's fine: Stage 1's consensus
  planning absorbs scoping, so all-in-one tolerates vaguer input than raw ralph.

## When NOT to use

- **One-line fix or tiny change** → use `/ralph` or delegate to an executor;
  three heavy multi-agent loops is overkill.
- **Pure exploration / brainstorming** → use `/oh-my-claudecode:plan` or the
  brainstorming skill; nothing should be implemented yet.
- **A 2-3 line product idea needing requirements expansion** → use
  `/autopilot` (it expands the idea first) or `/deep-interview`.
- **Frontend spec / reference-parity work** → use the specialized `/front-qa`.

## Flags

| Flag | Effect | Default |
|---|---|---|
| `--short` | Stage 1 runs ralplan **without** `--deliberate` (skips pre-mortem + expanded test plan) for lower-risk work | off → deliberate |
| `--checkpoint` | Insert an `AskUserQuestion` approval gate between Stage 1 (plan) and Stage 2 (implement) | off → auto-proceed |
| `--critic=critic\|architect\|codex` | Reviewer passed to ralph's verification | `critic` |
| `--qa=tests\|build\|lint\|typecheck` | Goal passed to ultraqa in Stage 3 | `tests` |
| `--no-deslop` | Passed through to ralph (skip the post-review deslop pass) | off |

Everything before the flags / after them that isn't a recognized flag is the
`<task description>`.

## Execution

### Stage 1 — Plan: `/ralplan`

Invoke `Skill(oh-my-claudecode:ralplan)` with args `--deliberate <task description>`
(omit `--deliberate` if `--short` was passed). Do **not** pass `--interactive` —
all-in-one supplies its own checkpoint via `--checkpoint`.

ralplan runs the Planner → Architect → Critic consensus loop and, on Critic
approval, writes the final plan to `.omc/plans/` and marks it `pending approval`,
then **stops**.

> **This "stop" is the end of the PLANNING stage, not the end of all-in-one.**
> The user invoking `/all-in-one` is their standing, explicit opt-in to execute
> the whole chain in this turn — which satisfies ralplan's planning/execution
> boundary. Capture the plan file path and proceed to Stage 2.

- **If `--checkpoint`:** before proceeding, use `AskUserQuestion` to present the
  plan and offer *Approve & implement / Request changes / Stop*. Only continue
  on approval.
- **If consensus is NOT reached** (ralplan hits its 5-iteration cap with no
  `APPROVE`): do not auto-proceed. Surface the best plan and ask the user how to
  proceed. Never build on an unapproved plan.

### Stage 2 — Implement: `/ralph`

Precondition: a consensus plan exists and is approved (auto via the invocation,
or via `--checkpoint`).

Invoke `Skill(oh-my-claudecode:ralph)` with args
`--critic=<critic flag> <plan-path + brief task restatement>` (add `--no-deslop`
if passed). Hand ralph the **plan file path from Stage 1** as the task
definition and tell it the plan is already Planner/Architect/Critic-validated —
its job is to turn the plan's stages into PRD stories and implement + verify
them, not to re-plan. (This mirrors how autopilot consumes a ralplan plan and
skips its own planning phase.)

ralph runs its full loop on its own: PRD refinement → implement per story →
verify acceptance criteria → Step-7 critic verification → Step-7.5 deslop →
Step-7.6 regression → Step-8 `/oh-my-claudecode:cancel`.

> ralph's Step-8 cancel clears **ralph/ultrawork** session state — it ends the
> IMPLEMENTATION stage, not all-in-one. all-in-one is not a registered OMC mode,
> so the cancel does not affect it. Let ralph fully finish (reviewer APPROVE +
> deslop + regression + cancel) **before** Stage 3 — ralph and ultraqa share
> mutually-exclusive session state, so they must not overlap.

- **If ralph reports a fundamental blocker** (same issue across 3+ iterations,
  missing credentials, unclear requirement, external dependency down): stop and
  report. Do **not** run Stage 3 on a broken or partial build and call it done.

### Stage 3 — QA gate: `/ultraqa`

Precondition: Stage 2's ralph has completed and self-cancelled (no session-state
overlap).

Invoke `Skill(oh-my-claudecode:ultraqa)` with args `--<qa goal>` (default
`--tests`). ultraqa cycles run-QA → architect-diagnose → executor-fix → repeat
(max 5; early-exit if the same failure appears 3×).

Report the real outcome:
- **Goal met** → "ALL-IN-ONE COMPLETE" with the cycle count.
- **Max cycles / same failure 3×** → "STOPPED" with ultraqa's diagnosis. Do
  **not** claim success if the gate did not reach goal-met.

## Orchestrator rules

- Stages run strictly in order; each stage's success gate must pass before the
  next begins. No skipping, no reordering, no running two stages' loops at once.
- Emit one clear progress line at each stage boundary so the user always knows
  where the pipeline is (`[all-in-one] Stage 1/3 — planning…`, etc.).
- Do not add a competing persistence loop or all-in-one-specific state file; the
  sub-skills own all looping and state.
- Treat a sub-skill's internal "stop"/"cancel" as the end of *that stage*, never
  as the end of the pipeline (see the Stage 1 and Stage 2 notes above).

## Final report

When the pipeline ends (complete or stopped), give a concise honest summary:

- **Plan**: consensus reached? plan path. Any alternatives rejected and why
  (1 line).
- **Implementation**: stories/stages completed, files changed, the ralph critic
  verdict.
- **QA**: ultraqa goal, PASS after N cycles or STOPPED-with-diagnosis.
- **Unmet / scope-limited / deferred**: state plainly — never paper over a gate
  that did not pass.

## Examples

**Good** — `"all-in-one add idempotency keys to POST /api/v1/payments so retried
requests don't double-charge; keys stored in payment_requests, 24h TTL"`
Specific subsystem, concrete behavior, and a storage hint. Stage 1 plans the
schema + flow with a pre-mortem, Stage 2 implements story-by-story with critic
sign-off, Stage 3 runs the test suite as an independent gate. Good fit.

**Good** — `"/all-in-one --short --qa=typecheck refactor user_context to drop the
unused Session import and split the god-object into mixins"`
Lower-risk refactor → `--short` skips the heavy pre-mortem; the final gate is a
typecheck rather than the full suite.

**Bad** — `"all-in-one fix the typo in the README header"`
A one-line change does not need three multi-agent loops. Edit it directly or use
ralph.

**Bad** — `"all-in-one build me something cool for productivity"`
A vague idea with no concrete target — use `/autopilot` or `/deep-interview`
first to expand it into a spec.

## Stop conditions

- Stage 1 cannot reach consensus → surface best plan, ask the user (don't build).
- Stage 2 ralph hits a fundamental blocker → stop and report (don't run QA).
- Stage 3 ultraqa exhausts cycles / repeats a failure 3× → report the diagnosis
  honestly (don't claim success).
- User says "stop" / "cancel" / "abort" at any point → run
  `/oh-my-claudecode:cancel` and stop.

## Final checklist

- [ ] Stage 1 produced a consensus plan in `.omc/plans/` (or stopped honestly on
      no-consensus / checkpoint rejection)
- [ ] Stage 2 received the plan path, completed all PRD stories, passed critic
      verification, and self-cancelled before Stage 3
- [ ] Stages did not overlap (ralph fully ended before ultraqa began)
- [ ] Stage 3 ran the chosen QA goal and reached goal-met (or reported STOPPED
      with diagnosis)
- [ ] Final report states plan/implementation/QA outcomes and any unmet items
      plainly
