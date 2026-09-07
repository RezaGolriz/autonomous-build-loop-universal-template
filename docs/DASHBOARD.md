# HTML dashboard


## Open it from chat

> Show the build-loop dashboard for this project.

The agent calls `loop_dashboard` (MCP) or the `dashboard` CLI operation and
returns `dashboard_url`. Open that local link in your browser. It expires after
30 minutes; request a new link after expiry. Reload the page to read current
state. There is no automatic polling.

```bash
node bin/build-loop.mjs dashboard --root /absolute/target --json
```

This works before setup, for a paused candidate, and for an active loop. The
page shows the project, work kind, phase gates, current recorded job, the
authorization of the current item, the backlog, the scout inbox, the last tick
and scout, the next-steps note, blockers, evidence and work item. It
distinguishes a candidate from active configuration.
Job status is a recorded observation, not proof that the process is still alive
or the work item has passed all gates. This page does not verify the signed
activation binding; use `status` for that result.

The work-kind and run-mode selectors prepare text to use in chat. They do not
change an active work item or start a run. Continue in chat to prepare a concrete
work item, review its scope, and use the normal approval and activation flow.

The local server binds only to `127.0.0.1` and requires the capability embedded
in its URL. It reads project state and opens no target command or approval form.
Keep the URL private: it exposes the selected project's status and work-item
text to anyone on the same machine who has the link. It serves only this page,
not arbitrary project files.

The monitoring URL is separate from every `confirmation_url`: the setup approval
link from `request-approval`, and the decision links that `accept`, `authorize`
and `promote` return when they are called from anywhere other than an interactive
terminal. The dashboard cannot approve setup and cannot make any of those
decisions; it only shows what was recorded.

## Export a static HTML file with the shell renderer

The dashboard is one HTML page that shows the state of a run at a glance.
It is made by a script, from the files the loop writes, and it changes
nothing.

```bash
./engine/render-dashboard.sh --root /path/to/project            # writes .loop/dashboard.html
./engine/render-dashboard.sh --root /path/to/project --output /tmp/run.html
./engine/render-dashboard.sh --root /path/to/project --output -  # prints the HTML
```

Open the file in any browser. Run the script again whenever you want a fresh
view; it executes no target commands. A render during a running job is a point-in-time
view and may read records from adjacent updates.

## Where the numbers come from

The page is built only from files in the project's `.loop/` folder:

| Section on the page | Source file |
|---|---|
| Header, phase strip, gates | `.loop/state.json` |
| Legal next steps | `.loop/workflow.json` (the fixed workflow) |
| Blockers | `.loop/blockers.md` |
| Evidence table | every `.loop/evidence/*.json` record |
| Work item | `.loop/work-items/<id>.md` |
| Authorization of the current item | `.loop/work-items/<id>.authorization.json` |
| Backlog | `.loop/backlog.json`, plus one `.loop/work-items/<id>.authorization.json` per entry |
| Inbox | `.loop/inbox/index.json` |
| Last tick | the last line of `.loop/scheduler/tick.log` |
| Last scout | the last line of `.loop/scheduler/scout.log` |
| Next-steps memory | `.loop/notes/next-steps.md` |
| Human confirmation mode | `.loop/control/policy.json`, or the default when there is none |
| Project hold banner | `.loop/control/hold.json` |

Nothing is computed from the agent's output or from Git. If a file is
missing, the section says "not available" instead of guessing.

## Reading the page, top to bottom

**Project hold banner.** If `.loop/control/hold.json` exists, a red banner sits
above everything else and says PROJECT ON HOLD, with the recorded reason, when
the hold was placed, which channel placed it, and the work item it was placed
for. While it is there, `start`, `run`, `resume`, `tick`, `task` and `scout` are
refused for every caller that is not a person at an interactive terminal;
reading, `cancel` and `handover` keep working. A person takes the hold off with
`release`: the word RELEASE typed at a terminal or on the local confirmation
page. A hold record that cannot be read is still shown as a hold, because it
still holds. Both dashboards — the Node page and `engine/render-dashboard.sh` —
show the same banner.

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

**Authorization of the current item.** What a person decided about the item
that is loaded right now: the state (READY or PAUSED), the allowed paths, the
budget in rounds and wall-clock seconds, when the authorization expires, which
channel the decision came through, and whether the item stops at the first
failed gate. READY means "you may start when your slot comes", inside exactly
this scope, budget and expiry. It is never approval of a result and it never
widens the scope of a node.

Three things are called out on this tile:

- An expired authorization is shown as expired, not as READY. Nothing starts
  from it any more; a person has to authorize it again.
- A record that does not validate — a broken `expires_at`, a field the schema
  does not allow — is marked "invalid record · a person has to authorize again".
  It is never shown as READY. An invalid record is a broken decision, not an
  absent one, and nothing starts from it.
- The channel the decision came through is shown as recorded. `interactive-tty`
  is a word typed at a terminal and `local-http-user` is the same word typed on
  the local confirmation page; those are the two ways a person can decide.
  `cli-input` and `mcp-user` are older records from transports that today may
  only *ask* for a confirmation, and `mcp-user` is still marked "authorized
  through a chat tool call".
- The **assurance** is shown next to it. `local-user-action` means a person with
  access to this machine typed the word. It is not proof of who that person was:
  the confirmation page is served on loopback, so an agent with shell access on
  the same computer could in principle open it. The tile also names the
  project's confirmation mode — `tty-or-local-page` by default, or `tty-only`
  when `.loop/control/policy.json` says so and the local page is refused
  altogether.

If the item has no sidecar file, the tile says "not available": nobody has
authorized anything, and only a person can write that record.

**Backlog.** The queue behind the current item, with the count of READY and
PAUSED entries and one row per item: id, title, work kind, authorization state
and expiry. An entry whose authorization has run out is counted as PAUSED and
marked expired; an entry whose record does not validate is counted as PAUSED and
marked "invalid record". Nothing in this list starts on its own. A PAUSED item waits for
a person; a READY item waits for its slot, which a `tick` may give it inside its
recorded budget.

**Inbox.** Proposals a scout wrote, with id, title, when they were created and
which provider suggested them. A proposal is inert: it is a piece of text, not
queued work, and it becomes work only when a person promotes it into the
backlog. Without an inbox index the tile says "not available".

**Last tick and last scout.** The last line of the tick log, split into the
time, the action (`ran-node`, `started`, `reported`, `nothing`,
`replaced-stale-lock`), the reason, and the item, phase and run status at that
moment; then the last scout entry with its time, status, number of proposals,
provider and profile. Reasons worth reading are `authorization-revoked`,
`authorization-expired` and `authorization-invalid`, which all mean the cadence
stopped because the decision behind it no longer holds. These are log entries
about what a trigger did. They are not gate results, and a tick may only ever do
what a person authorized before.

**Next-steps memory.** The advisory note the last run wrote at HANDOVER
(`.loop/notes/next-steps.md`), folded away until you open it. It summarises the
run and suggests priorities, and the next DEFINE brief and every scout brief
carry it along. It approves nothing and widens no scope. Missing note, no
guessing: the tile says "not available".

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

## Static export limits

- The page is static. Re-run the script to refresh; there is no live update.
- It shows one project (one `--root`). For several projects, render several
  pages.
- It never runs a project command and never touches the network; you can
  open it on any machine.
- Text from the work item and the logs is shown as-is but escaped, so a
  stray `<script>` in an agent's text cannot run in your browser.
