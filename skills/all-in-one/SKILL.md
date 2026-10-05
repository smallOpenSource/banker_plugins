---
name: all-in-one
description: "코딩 작업을 한 명령으로 계획부터 QA 통과까지 엄격하게 진행. `ralplan` 으로 합의 계획, `ralph` 로 검증 구현을 하고 독립 QA 게이트(Claude Code 는 `verify` 순환, Codex 는 `ultraqa`)로 마무리. 'all-in-one'/'all in one' 시 사용. 한 줄 수정은 이 스킬 대신 `ralph`, 아이디어 확장은 `autopilot`."
argument-hint: "[--short] [--checkpoint] [--critic=critic|architect|codex] [--qa=tests|build|lint|typecheck] [--no-deslop] <task description>"
level: 4
---

# /all-in-one — Plan → Implement → QA, one command

[ALL-IN-ONE ACTIVATED — SEQUENTIAL 3-STAGE PIPELINE]

## 0. Prerequisite: OMC 5 with a matching `omc` CLI (check first)

This skill orchestrates OMC's `ralplan` → `ralph`, then a QA gate built on OMC's
`verify` workflow. **Check the dependency before Stage 1**; if it is missing or
stale, **guide installation first** rather than failing mid-pipeline. The `omc`
check below is for Claude Code; on Codex check OMX instead (`omx --version`), whose
`ralph` does not use the `omc` CLI.

- **The `omc` CLI must have `ralph verify` (Claude Code).** OMC 5's `ralph` runs
  `omc ralph verify` on its first iteration and stops when the command is
  missing, and a global `omc` CLI older than the plugin (4.x) does not have it.
  Judge by the output, not the exit code: given `--help`, a 4.x CLI prints its
  general help and still exits 0. Keep the `--help`: without it, an unknown
  command makes the CLI launch Claude Code.
  ```bash
  omc ralph verify --help 2>&1 | grep -q 'Usage: omc ralph verify' && echo "omc ok" || echo "omc CLI missing or too old"
  ```
  ```powershell
  if ((omc ralph verify --help 2>&1 | Out-String) -match 'Usage: omc ralph verify') { 'omc ok' } else { 'omc CLI missing or too old' }
  ```
- **If the check fails:** stop before Stage 1 and guide the fix (`/banker:setup`
  → oh-my-claudecode, the `setup-omc` skill, or
  `npm install -g oh-my-claude-sisyphus@latest`), then resume. Do not start a
  pipeline whose Stage 2 will stop.
- **`ultraqa` does not exist in OMC 5** (removed in 5.0.0, no alias), so a call
  to `oh-my-claudecode:ultraqa` fails. Stage 3 below runs in its place.
- On Codex the equivalent framework is OMX (`omx setup`).

**런타임 매핑 (Claude Code ↔ Codex).** Stage 1·2 의 `ralplan`·`ralph` 는 Claude Code에선 OMC 스킬이고 **Codex에선 oh-my-codex(OMX)가 제공하는 동명 스킬**이다. Stage 3 은 런타임마다 다르다: Claude Code(OMC 5)는 `ultraqa` 가 없어 아래 verify 순환을 직접 돌리고, **Codex는 OMX 가 아직 제공하는 `ultraqa`** 를 쓴다. 아래 `Skill("oh-my-claudecode:<name>")`·`Task(subagent_type="oh-my-claudecode:<name>")` 표기는 Claude Code 기준이다.

## Purpose

Run one substantial coding task through three independent quality gates in a
fixed order:

```
Stage 1  /ralplan --deliberate     consensus plan (Planner → Architect → Critic)
   │     → .omc/plans/ plan, "pending approval"
   ▼
Stage 2  /ralph --critic=critic    PRD-driven persistent build, critic-verified
   │     → implementation + deslop + regression, then ralph self-cancels
   ▼
Stage 3  QA gate (--qa=tests)      fresh verifier → diagnose → fix, bounded cycle
         → PASS, or honest STOPPED-with-diagnosis   (Codex: OMX /ultraqa)
```

This skill is a **thin sequential orchestrator**. It does not implement, plan,
or test directly, and it does **not** create its own state file. Stages 1 and 2
hand every loop, retry, and verification to the sub-skill they invoke. The one
loop all-in-one owns is Stage 3's bounded verify → fix cycle: OMC 5 removed
`ultraqa`, which used to own it, and its replacement `verify` gathers evidence
but does not fix. Beyond that, its only job is to run the stages in order,
bridge their handoffs, gate each stage on the previous one's success, and
report honestly.

## Why three stages (and not just ralph)

The three stages exist because they defend against three *distinct* failure
modes, and each stage's reviewer is independent of the previous stage's author
(the core anti-self-approval principle):

1. **Building the wrong or under-thought thing** → Stage 1's consensus +
   pre-mortem + expanded test plan catch this before any code is written.
2. **A partial or unverified build declared "done"** → Stage 2's PRD
   story-by-story persistence + critic verification catch this.
3. **Integration / regression breakage slipping past the builder's own checks**
   → Stage 3's fresh, test-focused, fix-cycling gate catches this.

**On the apparent redundancy of Stage 3:** ralph (Stage 2) already runs its own
Step-7 reviewer verification and Step-7.6 regression re-run (`omc ralph verify`
against the baseline it recorded). Stage 3 is still worth running because it is
*independent* (a fresh verifier agent, not the context that built the change),
*test-suite-focused*, and *actively fixes* in a bounded cycle. If ralph's
regression already ran the suite green, the gate usually passes in cycle 1
(cheap); its value rises when the suite is broad, when changes touched many
files, or when integration/flaky issues hide behind unit-level checks. Keeping
it explicit gives a clean, separate PASS signal.

## When to use

- A substantial, mostly-specified coding task you want carried from plan →
  verified implementation → green test gate in one step, with the most
  front-loaded rigor OMC offers.
- You have been running `ralplan → ralph →` a QA pass by hand and want it as one
  command.
- The task is moderately under-specified — that's fine: Stage 1's consensus
  planning absorbs scoping, so all-in-one tolerates vaguer input than raw ralph.

## When NOT to use

- **One-line fix or tiny change** → use `/ralph` or delegate to an executor;
  three heavy multi-agent loops is overkill.
- **Pure exploration / brainstorming** → use `/oh-my-claudecode:ralplan` on its
  own (it stops at a `pending approval` plan) or the brainstorming skill;
  nothing should be implemented yet.
- **A 2-3 line product idea needing requirements expansion** → use
  `/autopilot` (it expands the idea first) or `/deep-interview`.
- **Frontend spec / reference-parity work** → use the specialized `/front-qa`.

## Flags

| Flag | Effect | Default |
|---|---|---|
| `--short` | Stage 1 runs ralplan **without** `--deliberate` (skips pre-mortem + expanded test plan) for lower-risk work | off → deliberate |
| `--checkpoint` | Insert an `AskUserQuestion` approval gate between Stage 1 (plan) and Stage 2 (implement) | off → auto-proceed |
| `--critic=critic\|architect\|codex` | Reviewer passed to ralph's verification | `critic` |
| `--qa=tests\|build\|lint\|typecheck` | What the Stage 3 gate checks (Codex: the goal passed to ultraqa) | `tests` |
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

### Before Stage 2 — record what already fails

Run the command(s) of the `--qa` goal once on the unchanged tree and keep the
failing items (test names, error lines) in this conversation. This
**pre-change record** is the gate's baseline: it covers checks that are not
among ralph's feedback commands, and on Codex it is the only baseline there is
(OMX `ralph` keeps none). Never use `git stash` or `git reset` to get a
pre-change state for it; if the tree already has changes, take the record from
a clean copy of HEAD (`git worktree add --detach <tmp> HEAD`, run there, then
`git worktree remove <tmp>`). A fresh worktree has no installed dependencies
(`node_modules`, a venv): link or install them there first, and confirm the
commands really ran — a record made only of "command not found" errors is no
baseline. The record lives only in this conversation; if the session may
compact or end before Stage 3, put it in the `ready-compact` note.

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

ralph runs its full loop on its own: feedback baseline (`omc ralph verify
--write-baseline`) → PRD refinement → implement per story → verify acceptance
criteria → Step-7 reviewer verification → Step-7.5 deslop → Step-7.6 regression
→ Step-8 closeout and `/oh-my-claudecode:cancel`.

> ralph's Step-8 cancel clears **ralph's own** session state — it ends the
> IMPLEMENTATION stage, not all-in-one. all-in-one is not a registered OMC mode,
> so the cancel does not affect it. Let ralph fully finish (reviewer APPROVE +
> deslop + regression + cancel) **before** Stage 3, so the gate checks the final
> tree and no ralph continuation is still steering the session.

- **Settle ralph's questions up front.** ralph 5.6.1 asks the user once for the
  PRD's `repoQualityClass` (`prototype`, `production` or `library`) when the task
  does not say. Infer it from repo signals (CI config, test depth, published
  package metadata) and put it in the handoff; let ralph ask only when the
  signals conflict.
- **Give ralph feedback commands that print only failures.** OMC 5.6.1's
  `omc ralph verify` fingerprints *every* output line of each feedback command,
  and normalizes only durations written as `<number><unit>`, timestamps, `/tmp`
  paths and hex ids. A line that changes between runs or when a story adds
  tests therefore reads as a NEW failure: node:test's default reporter prints
  `ℹ duration_ms 151.4` and `ℹ tests 8`, so its gate fails on every run with no
  change at all. In the handoff, tell ralph to set the PRD's `feedbackCommands`
  **before it records the baseline** to forms whose output is constant on
  success and names each failure — for node:test,
  `FORCE_COLOR=0 NODE_NO_WARNINGS=1 node --test --test-reporter=dot 2>&1 | grep -Ev '^[.X]+$'`
  (the two variables keep color codes from slipping past the filter and
  warnings with a process id out of the output; adapt the form on Windows);
  keep build/lint commands that are silent on success. If the gate still flags
  only such lines, fix the commands and re-record ralph's baseline on the
  current tree (`omc ralph verify --write-baseline`) — the pre-change record
  still tells old failures from new ones. Never edit the baseline file by
  hand; never stash or reset.
- **Carry the baseline forward.** ralph's own baseline (first iteration) also
  lists failures that existed before the change; ralph treats them as noise
  and reports them at Step 8. Note its session id (the `<id>` in its PRD path
  `.omc/state/sessions/<id>/`) for Stage 3.
- **If ralph reports a fundamental blocker** (same issue across 3+ iterations,
  missing credentials, unclear requirement, external dependency down, or the
  `omc ralph verify` command unavailable): stop and report. Do **not** run
  Stage 3 on a broken or partial build and call it done.

### Stage 3 — QA gate

Precondition: Stage 2's ralph has completed and self-cancelled.

**Claude Code (OMC 5):** run the bounded cycle that `ultraqa` used to own —
the same shape as OMC 5's autopilot QA phase. No state file: the cycle count
lives in this conversation.

1. **Verify, independently.** `Task(subagent_type="oh-my-claudecode:verifier", ...)`
   — a fresh context that did not build the change. Brief it to follow the
   `oh-my-claudecode:verify` workflow for the `--qa` goal (`tests` by default;
   `build`, `lint` or `typecheck` select that check), run the project's real
   commands, and return **PASS** or **FAIL** with the commands, their output and
   each failing item.
   Whether a failure predates the change is not judged by eye. A failure is
   **pre-existing only** when the pre-change record lists it, or — Claude
   Code — when `omc ralph verify --session <ralph's session id> --json` leaves
   it out of `newFailures` (cancel leaves the baseline in place; check that the
   JSON reports `baselinePresent: true` — without a baseline it reports every
   current failure as new). **Everything else is new**, and so is a
   pre-existing failure that points at a file the change touched (as in ralph).
   If ralph was run again in this session (a resumed run), its first iteration
   rewrote that baseline on the half-changed tree; then judge by the
   pre-change record alone.
2. **PASS** → the gate is met; go to the final report.
3. **FAIL** → `Task(subagent_type="oh-my-claudecode:architect", ...)` diagnoses
   the root cause (read-only), then `Task(subagent_type="oh-my-claudecode:executor", ...)`
   makes the smallest fix inside the change's scope. The next cycle verifies
   again with a **fresh** verifier, never the one that saw the failure.

Limits: at most 5 verifications. When the 5th still fails, stop without
another fix (a fix nobody verified is not a result). Stop early when the same
failure (same test, same error signature) comes back 3 times — that is a
fundamental problem for the user, not for another cycle. Never fix a baseline
failure inside this gate; report it.

**Codex (OMX):** run OMX `$ultraqa` with the goal (OMX still ships it). OMX
keeps no feedback baseline, so hand it the pre-change record, tell it not to
fix those failures, and report them apart; treat its outcome the same way.

Report the real outcome:
- **Goal met** → "ALL-IN-ONE COMPLETE" with the cycle count.
- **5 failed verifications / same failure 3×** → "STOPPED" with the verifier's
  evidence and the architect's diagnosis. Do **not** claim success if the gate did not reach
  goal-met.

## Orchestrator rules

- Stages run strictly in order; each stage's success gate must pass before the
  next begins. No skipping, no reordering, no running two stages' loops at once.
- Emit one clear progress line at each stage boundary so the user always knows
  where the pipeline is (`[all-in-one] Stage 1/3 — planning…`, etc.).
- Do not add an all-in-one state file or a second persistence loop. Stages 1–2
  own their loops and state; Stage 3's bounded cycle is the only loop here.
- Treat a sub-skill's internal "stop"/"cancel" as the end of *that stage*, never
  as the end of the pipeline (see the Stage 1 and Stage 2 notes above).

## Final report

When the pipeline ends (complete or stopped), give a concise honest summary:

- **Plan**: consensus reached? plan path. Any alternatives rejected and why
  (1 line).
- **Implementation**: stories/stages completed, files changed, the ralph critic
  verdict.
- **QA**: the gate's goal, PASS after N cycles or STOPPED-with-diagnosis, and
  the baseline failures that predate the change, listed apart.
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

- The `omc` CLI check in §0 fails → guide the install/update; do not start.
- Stage 1 cannot reach consensus → surface best plan, ask the user (don't build).
- Stage 2 ralph hits a fundamental blocker → stop and report (don't run QA).
- Stage 3 fails its 5th verification / sees the same failure 3× → report the
  diagnosis honestly (don't claim success).
- User says "stop" / "cancel" / "abort" at any point → run
  `/oh-my-claudecode:cancel` and stop.

## Final checklist

- [ ] §0: on Claude Code the `omc` CLI answered `omc ralph verify --help` with its usage (Codex: `omx --version`)
- [ ] Stage 1 produced a consensus plan in `.omc/plans/` (or stopped honestly on
      no-consensus / checkpoint rejection)
- [ ] Stage 2 received the plan path, completed all PRD stories, passed critic
      verification, and self-cancelled before Stage 3
- [ ] Stages did not overlap (ralph fully ended before the gate began)
- [ ] Stage 3: a fresh verifier reported the chosen goal met (or STOPPED with
      diagnosis); baseline failures reported apart, not fixed
- [ ] Final report states plan/implementation/QA outcomes and any unmet items
      plainly
