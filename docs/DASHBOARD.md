# The dashboard

The dashboard is one HTML page that shows the state of a run at a glance.
It is made by a script, from the files the loop writes, and it changes
nothing.

```bash
./engine/render-dashboard.sh --root /path/to/project            # writes .loop/dashboard.html
./engine/render-dashboard.sh --root /path/to/project --output /tmp/run.html
./engine/render-dashboard.sh --root /path/to/project --output -  # prints the HTML
```

Open the file in any browser. Run the script again whenever you want a fresh
view; it is quick (well under a second) and safe to run while the loop is
working.

## Where the numbers come from

The page is built only from files in the project's `.loop/` folder:

| Section on the page | Source file |
|---|---|
| Header, phase strip, gates | `.loop/state.json` |
| Legal next steps | `.loop/workflow.json` (the fixed workflow) |
| Blockers | `.loop/blockers.md` |
| Evidence table | every `.loop/evidence/*.json` record |
| Work item | `.loop/work-items/<id>.md` |

Nothing is computed from the agent's output or from Git. If a file is
missing, the section says "not available" instead of guessing.

## Reading the page, top to bottom

**Header.** The work item id, a coloured status badge, the current phase,
`round/max_rounds`, `gate failures/max`, when the state was last updated,
and when the page was generated.

| Badge | Meaning | What to do |
|---|---|---|
| RUNNING (blue) | The loop is working or waiting for the next `run`/`loop` | Nothing, or keep looping |
| WAITING_FOR_HUMAN (amber) | HANDOVER reached; the run is finished | Read the handover, decide about merge/deploy |
| BLOCKED (red) | A decision is missing or a gate failed hard | Read Blockers, answer, `resume` |
| PAUSED (grey) | Configured but not started | `orchestrator.sh start` |
| COMPLETED / CANCELLED (grey) | Closed by a human | — |

**Phases.** Six pills, one per step. The colour is the gate status: green
passed, red failed, grey not run yet. The current phase has a black outline.
Because a rework can send the work backwards, you may see a red VALIDATE
next to a black-outlined EXECUTE: the validation failed and the work went
back to building.

**Legal next steps.** Which transitions the workflow allows from the current
phase: the normal ("green") next step and the possible rework targets with
their defect class. This is read from the workflow file, so it tells you what
*could* happen, not what will.

**Blockers.** Open questions first (`- [ ]`, red), resolved ones after
(`- [x]`, grey). Each line names the phase and the run id it came from.

**Evidence.** One row per evidence record, newest first:

- *ID* — for example `run-WI-001-2-execute-build-check`. Read it as
  `run-<work item>-<round>-<phase>-<command>`. `review-…` rows are review
  verdicts checked by the referee; `…-orchestrator` rows are the conductor
  confirming that a text-only phase (DEFINE, DESIGN, HANDOVER) produced its
  section.
- *Type* — `command` (a command ran), `behavior`, `acceptance`, `contract`,
  `artifact`, `installation` (what a command was declared to prove),
  `independent-review`, `contract`/`documentation` (the text phases).
- *Result* — PASSED, FAILED, or BLOCKED.
- *Producer* — `reference-engine` (the referee ran it) or `orchestrator`.
- *Command details* — command id, exit code, and duration for `command` rows.

A count per result closes the table. A run with a few FAILED rows is
normal: they are the rework loops. What matters is that the **gates** are
green at the end.

**Gates.** The six phases again, with the evidence ids that closed each
gate. Click nothing; copy an id and open
`.loop/evidence/<id>.json` to see the full record, or
`.loop/evidence/<run-id>/logs/` for the raw command output.

**Work item.** The whole work-item file, folded. Open it to read the
acceptance criteria the agent wrote, the slices, and the handover notes.

## Digging deeper than the page

The page is a summary. The truth lives next to it:

```text
.loop/evidence/
├── run-WI-001-2-execute-build-check.json        # one evidence record
├── review-run-WI-001-2-execute.json             # the referee's review record
└── run-WI-001-2-execute/
    ├── run-summary.json                          # what the referee did in that step
    ├── logs/build-check.stdout                   # raw output of your test command
    ├── logs/build-check.stderr
    ├── logs/provider.stdout                      # what the agent returned
    └── logs/provider.stderr                      # what the agent wrote to stderr
```

Every record carries the Git revision it was made at and a checksum of the
logs it refers to. If someone edits a log afterwards, the referee rejects the
record.

## Limits

- The page is static. Re-run the script to refresh; there is no live update.
- It shows one project (one `--root`). For several projects, render several
  pages.
- It never runs a project command and never touches the network; you can
  open it on any machine.
- Text from the work item and the logs is shown as-is but escaped, so a
  stray `<script>` in an agent's text cannot run in your browser.
