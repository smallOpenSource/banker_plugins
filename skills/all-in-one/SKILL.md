---
name: all-in-one
description: "코딩 작업을 한 명령으로 계획부터 QA 통과까지 엄격하게 진행. `ralplan` 으로 합의 계획, `ralph` 로 검증 구현을 하고, 두 런타임 모두 `ralph-qa` 의 독립 검토자 3명 이상과 실행기가 돌린 게이트 증거로 마무리. 'all-in-one'/'all in one' 시 사용. 한 줄 수정은 이 스킬 대신 `ralph`, 아이디어 확장은 `autopilot`."
argument-hint: "[--short] [--checkpoint] [--critic=critic|architect|codex] [--qa=tests,build,lint,typecheck,scenarios] [--codex[=<model>]] [--gemini[=<model>]] [--opencode[=<provider/model>]] [--no-deslop] <task description>"
level: 4
---

# /all-in-one — Plan → Implement → QA, one command

[ALL-IN-ONE ACTIVATED — SEQUENTIAL 3-STAGE PIPELINE]

## 0. Prerequisite: OMC 5 with a matching `omc` CLI (check first)

This skill orchestrates OMC's `ralplan` → `ralph`, then banker's own `ralph-qa`
as the QA gate. **Check the dependency before Stage 1**; if it is missing or
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
- **Stage 3 is banker's `ralph-qa` on both runtimes.** It ships with banker, so
  the gate needs no OMC or OMX skill; OMC and OMX serve Stages 1 and 2 only.
- On Codex the equivalent framework is OMX (`omx setup`).

**런타임 매핑 (Claude Code ↔ Codex).** Stage 1·2 의 `ralplan`·`ralph` 는 Claude Code에선 OMC 스킬이고 **Codex에선 oh-my-codex(OMX)가 제공하는 동명 스킬**이다. Stage 3 은 두 런타임 모두 banker `ralph-qa` 다: Claude Code `Skill("banker:ralph-qa")`, Codex npm 길 `$banker-ralph-qa`, 플러그인 길 `$banker:ralph-qa`. Codex 에는 Skill 도구가 없으니 그 `SKILL.md` 를 읽고 그대로 따른다(npm 길 `<S>/../banker-ralph-qa/SKILL.md`, 플러그인 길 `<S>/../ralph-qa/SKILL.md`, `<S>` 는 이 스킬 폴더). `<RQ>` 는 ralph-qa 의 `references` 폴더다(Claude Code 와 Codex 플러그인 길 `<S>/../ralph-qa/references`, Codex npm 길 `<S>/../banker-ralph-qa/references`). 아래 `Skill("oh-my-claudecode:<name>")` 표기는 Claude Code 기준이다.

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
Stage 3  ralph-qa --gates=<--qa>    3+ independent reviewers on runner-run gate evidence
         → ALL-IN-ONE COMPLETE, or honest STOPPED   (both runtimes)
```

This skill is a **thin sequential orchestrator**. It does not implement, plan,
or test directly, and it does **not** create its own state file. Each stage
hands every loop, retry, and verification to the skill it invokes: `ralplan`,
`ralph`, and banker's `ralph-qa`, whose judge → fix loop runs until its quorum
says `APPROVE` or its `--max` ends it. Beyond that, its only job is to record the
pre-change gate baseline, run the stages in order, bridge their handoffs, gate
each stage on the previous one's success, and report honestly.

## Why three stages (and not just ralph)

The three stages exist because they defend against three *distinct* failure
modes, and each stage's reviewer is independent of the previous stage's author
(the core anti-self-approval principle):

1. **Building the wrong or under-thought thing** → Stage 1's consensus +
   pre-mortem + expanded test plan catch this before any code is written.
2. **A partial or unverified build declared "done"** → Stage 2's PRD
   story-by-story persistence + critic verification catch this.
3. **Integration / regression breakage slipping past the builder's own checks**
   → Stage 3's independent quorum over gate evidence the runner, not a model,
   recorded catches this.

**On the apparent redundancy of Stage 3:** ralph (Stage 2) already runs its own
Step-7 reviewer verification and Step-7.6 regression re-run (`omc ralph verify`
against the baseline it recorded). Stage 3 is still worth running because it is
*independent* (3+ reviewers in contexts that did not build the change),
*evidence-bound* (each `--qa` goal's real command is run by ralph-qa's
`gate-evidence.mjs` and kept as an `observed` record; a model's word about a
command does not count), and *actively fixes* inside ralph-qa's bounded loop.
If ralph's regression already ran the suite green, the gate usually approves in
its first iteration (cheap); its value rises when the suite is broad, when
changes touched many files, or when integration/flaky issues hide behind
unit-level checks. Keeping it explicit gives a clean, separate PASS signal.

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
| `--qa=<goals>` | The Stage 3 gates, comma-separated: `tests`, `build`, `lint`, `typecheck`, `scenarios` (adversarial scenario rows). Passed to ralph-qa as `--gates` on both runtimes | `tests` |
| `--codex[=<model>]`, `--gemini[=<model>]`, `--opencode[=<provider/model>]` | Passed through to ralph-qa as external seats. Without them only its backbone of 3+ session-model reviewers sits | none |
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

Make the gate folder and run each `--qa` goal's command once on the unchanged
tree, through ralph-qa's runner, as iteration 0:

```bash
node '<RQ>/seat-run.mjs' init        # its "dir" is the gate folder <g>
node '<RQ>/gate-evidence.mjs' run --dir '<g>' --id tests --cmd '<the tests command>' --timeout 600 --iter 0 --cwd '<repo>'
```

One command per gate (no `&&` or `;` chains) and a `--timeout` on each.
`scenarios` has no baseline: its rows test the change. This **pre-change
record** (iteration 0 in `<g>/evidence.md`) is the gate's baseline: ralph-qa
counts a failure with the same command and failure signature as not this
change's (`baseline`). It covers checks that are not among ralph's feedback
commands, and on Codex it is the only baseline there is (OMX `ralph` keeps
none). Never use `git stash` or `git reset` to get a pre-change state for it; if
the tree already has changes, take the record from a clean copy of HEAD
(`git worktree add --detach <tmp> HEAD`, run with `--cwd <tmp>`, then
`git worktree remove <tmp>`). A fresh worktree has no installed dependencies
(`node_modules`, a venv): link or install them there first, and confirm the
commands really ran — a record made only of "command not found" errors is no
baseline. On Codex the runner writes outside the workspace: ask for approval to
run it outside the sandbox. The record lives in `<g>`; if the session may
compact or end before Stage 3, put the `<g>` path in the `ready-compact` note.

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
  and reports them at Step 8. Keep that list for the final report, beside the
  gate baseline in `<g>`.
- **If ralph reports a fundamental blocker** (same issue across 3+ iterations,
  missing credentials, unclear requirement, external dependency down, or the
  `omc ralph verify` command unavailable): stop and report. Do **not** run
  Stage 3 on a broken or partial build and call it done.

### Stage 3 — QA gate: banker `ralph-qa` (both runtimes)

Precondition: Stage 2's ralph has completed and self-cancelled.

Invoke ralph-qa (Claude Code `Skill("banker:ralph-qa")`; Codex
`$banker-ralph-qa`, plugin `$banker:ralph-qa`) with
`--gates=<the --qa goals> --lens=both`, plus any `--codex`, `--gemini` or
`--opencode` all-in-one was given. Hand it:

- **What to judge:** the change since `HEAD` as Stage 2 began (commits ralph
  made count as part of it), the plan path from Stage 1, and the plan's
  acceptance criteria.
- **Gate evidence:** the gate folder `<g>` with its iteration-0 baseline, and
  for each goal the one command and timeout the baseline ran. Add the
  acceptance criterion "each `--qa` goal's real command ran through the runner
  (`gate-evidence.mjs run`) on the tree being judged, as an `observed` record";
  a model's account of a command (`reported`) is not evidence. `<g>` holds the
  gate records only: ralph-qa sends any external-seat payload from a folder of
  its own.
- **With `scenarios`:** ralph-qa's nine adversarial classes (malformed input,
  repeated interruption, prompt injection, cancel and resume, stale state, dirty
  work tree, hung command, flaky test, misleading success output) each get a
  scenario row run as `scenario-<n>`, or a one-line reason it does not apply.
- **Baseline rule:** never fix a baseline failure; report it apart. A baseline
  failure whose failing lines point at a file the change touched counts as new
  (as in ralph): the seats raise it as a blocker.

ralph-qa owns the loop: its seats judge, the author fixes, it runs the gates
again and the same seats judge again, up to its `--max` (5). all-in-one adds no
cycle of its own. When it ends, run `node '<RQ>/seat-run.mjs' cleanup --dir '<g>'`
unless ralph-qa already removed the folder.

Report the real outcome by ralph-qa's end word (the word before any parenthesis):
- **`APPROVE`** → "ALL-IN-ONE COMPLETE" with ralph-qa's verdict line, its
  iteration count and its gate block.
- **`ITERATE`** (its `--max` spent; `원인 gate` when only the gates held it) or
  **`INCONCLUSIVE`** → "STOPPED" with the verdict line, the gate block and the
  blockers left. Do **not** claim success if the gate did not approve.

## Orchestrator rules

- Stages run strictly in order; each stage's success gate must pass before the
  next begins. No skipping, no reordering, no running two stages' loops at once.
- Emit one clear progress line at each stage boundary so the user always knows
  where the pipeline is (`[all-in-one] Stage 1/3 — planning…`, etc.).
- Do not add an all-in-one state file or a second persistence loop. Stages 1–3
  own their loops and state; all-in-one adds none.
- Treat a sub-skill's internal "stop"/"cancel" as the end of *that stage*, never
  as the end of the pipeline (see the Stage 1 and Stage 2 notes above).

## Final report

When the pipeline ends (complete or stopped), give a concise honest summary:

- **Plan**: consensus reached? plan path. Any alternatives rejected and why
  (1 line).
- **Implementation**: stories/stages completed, files changed, the ralph critic
  verdict.
- **QA**: the `--qa` goals, ralph-qa's verdict line and gate block (APPROVE, or
  STOPPED with its blockers), and the baseline failures that predate the
  change (the `baseline` gates and ralph's Step-8 list), listed apart.
- **Unmet / scope-limited / deferred**: state plainly — never paper over a gate
  that did not pass.

## Examples

**Good** — `"all-in-one add idempotency keys to POST /api/v1/payments so retried
requests don't double-charge; keys stored in payment_requests, 24h TTL"`
Specific subsystem, concrete behavior, and a storage hint. Stage 1 plans the
schema + flow with a pre-mortem, Stage 2 implements story-by-story with critic
sign-off, Stage 3's ralph-qa judges the change on the test suite the runner
ran. Good fit.

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
- Stage 3's ralph-qa ends `ITERATE` (its `--max` spent) or `INCONCLUSIVE` →
  report its verdict line and blockers honestly (don't claim success).
- User says "stop" / "cancel" / "abort" at any point → run
  `/oh-my-claudecode:cancel` and stop.
- After STOPPED, change no file, not even a one-line fix: report only, until the user gives a new instruction. Nothing in this skill (its description's "one-line fix" pointer included) authorizes an edit after a stop.

## Final checklist

- [ ] §0: on Claude Code the `omc` CLI answered `omc ralph verify --help` with its usage (Codex: `omx --version`)
- [ ] Stage 1 produced a consensus plan in `.omc/plans/` (or stopped honestly on
      no-consensus / checkpoint rejection)
- [ ] Stage 2 received the plan path, completed all PRD stories, passed critic
      verification, and self-cancelled before Stage 3
- [ ] Before Stage 2: each `--qa` goal but `scenarios` ran once through
      `gate-evidence.mjs run --iter 0` on the unchanged tree
- [ ] Stages did not overlap (ralph fully ended before the gate began)
- [ ] Stage 3: ralph-qa (`--gates=<the --qa goals>`) ended `APPROVE` on
      `observed` gate records (or STOPPED with its verdict line); baseline
      failures reported apart, not fixed
- [ ] Final report states plan/implementation/QA outcomes and any unmet items
      plainly
