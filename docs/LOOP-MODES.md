# Kinds of loops and how to run them

The six steps (DEFINE → DESIGN → EXECUTE → REVIEW → VALIDATE → HANDOVER)
never change. What you can change is **how** you drive them: one step at a
time or many, with one agent or two, with a real agent or a fake one for
testing. This page lists the ways and when to use each.

## 1. One step at a time (`run`)

```bash
./engine/orchestrator.sh run --root DIR --host codex --provider hosts/codex/provider.sh
```

Runs exactly one step and stops. Use it when you want to watch what the
agent does after every step, or when you are trying a new project
configuration and expect surprises. After each `run`, look at
`orchestrator.sh status` or the dashboard, then run again.

## 2. Many steps in a row (`loop`)

```bash
./engine/orchestrator.sh loop --root DIR --host codex --provider hosts/codex/provider.sh --max-nodes 12
```

Runs step after step until one of these happens:

- HANDOVER is reached: status `WAITING_FOR_HUMAN`. You take over.
- A blocker appears: status `BLOCKED`. You answer and `resume`.
- `--max-nodes` steps were run: the loop pauses in the middle. Just call
  `loop` again to continue; nothing is lost.
- A real error (missing tool, broken configuration): the loop stops with a
  non-zero exit code and does not change the state.

`--max-nodes` is a safety belt for your attention, not for the process; the
process has its own limits (`max_rounds`, `max_gate_failures`,
`max_wall_seconds` in `state.json`).

## 3. Same agent for everything

```bash
--host claude --provider hosts/claude/provider.sh
```

One agent writes the criteria, the plan, the code, and also reviews. The
review still happens in a **fresh process** that never sees the builder's
reasoning, only the change and the evidence, so it is not the agent grading
its own homework from memory. Simplest setup; good for small tasks.

## 4. One agent builds, another one reviews (cross-agent)

```bash
--host codex --provider hosts/codex/provider.sh \
--review-host claude --review-provider hosts/claude/provider.sh
```

Every REVIEW step uses the second agent; every other step uses the first.
Two different models have different blind spots, so this catches more. In
our trial runs this combination was also the fastest, because the two
agents did not argue with themselves. Recommended for anything beyond a toy.

The reverse pairing (Claude builds, Codex reviews) works the same way.

## 5. Fake agent for testing (`mock`)

```bash
--host mock --provider hosts/mock/provider.sh
```

A tiny script that plays the agent: it fills in the work item, writes a
known implementation, and returns a verdict. It never calls a model. Use it
to check that your project configuration, commands, and paths are right
before you spend real agent time. `MOCK_SCRIPT` lets you script failures
(a failing review, a blocker, a forbidden file change) to see how the loop
reacts. The test suite `tests/run-orchestrator.sh` is built on it.

## 6. Work in slices

In DESIGN the agent writes a table of execution slices, one row per step of
the change, each with its own allowed paths. EXECUTE then runs **once per
row**: build slice 1, referee checks, build slice 2, referee checks, and so
on. Small slices mean small diffs, precise path rules, and clearer evidence.
One row is fine for a small change; three or four rows for a feature that
touches code, tests, and docs.

If a later step (REVIEW or VALIDATE) sends the work back to EXECUTE, all
slices run again from slice 1.

## 7. Stop, decide, continue (blockers)

Whenever the agent needs a decision it does not have (a missing dependency,
an unclear requirement, a protected file it would have to change), it does
not guess. It writes a line into `.loop/blockers.md`, the run stops with
`BLOCKED`, and you decide:

```bash
cat .loop/blockers.md          # read the question
# edit the file: change "- [ ]" to "- [x]" and add your answer
./engine/orchestrator.sh resume --root DIR
./engine/orchestrator.sh loop   --root DIR ...
```

A failed EXECUTE gate (tests red, forbidden file changed) also becomes a
blocker, because the workflow has no automatic "try again" for it. Read the
evidence, fix the cause or adjust the work item, then `resume`.

## 8. Rework loops inside the loop

REVIEW and VALIDATE do have automatic rework: a failed review or a failed
validation sends the work back to the step that owns the defect (a wrong
requirement to DEFINE, a wrong design to DESIGN, a code bug to EXECUTE), and
the loop continues by itself. Each failure counts against
`max_gate_failures`; reaching the cap means `BLOCKED`, never a silent pass.

## 9. What you cannot do (yet)

- Run two work items at once, or a queue of them. One item per run; start the
  next by writing a new work item and a fresh `state.json`.
- Skip REVIEW or VALIDATE. The referee refuses illegal transitions.
- Let the loop merge, deploy, or publish. It stops at HANDOVER by design.

## Cheat sheet

| I want to… | Use |
|---|---|
| Try the process without any AI | `--host mock` |
| Watch every step | `run`, one call per step |
| Let it work while I do something else | `loop --max-nodes N` |
| Get the most reliable result | `--review-host`/`--review-provider` with a different agent |
| Check where a run is | `status --root DIR` or the dashboard |
| Answer a question the agent had | edit `.loop/blockers.md`, then `resume` |
| See what the agent would be asked next, without calling it | `next --root DIR --host ID` |
