# Loop walkthroughs

Ten short walkthroughs. Each one runs on one of the [worked example
projects](../README.md) and comes in two variants: **In chat**, with prompts you
can copy into Claude Desktop or the Codex app, and **On the command line**, with
the exact `build-loop` calls.

## Which walkthrough do I want?

| Your situation | Read this |
|---|---|
| I want to try the whole thing first, with no AI and no cost | [dry-run.md](dry-run.md) |
| I know what I want next and I will check the result myself | [goal.md](goal.md) |
| Something is broken and I want it fixed and nothing else | [defect.md](defect.md) |
| I have several things written down and want them worked through in order | [backlog.md](backlog.md) |
| A document needs writing, not code | [documentation.md](documentation.md) |
| I want one agent to build and a different one to review | [two-agents.md](two-agents.md) |
| I want work to move along while I do something else | [cadence.md](cadence.md) |
| I am away for two days and want to find progress on Monday | [weekend.md](weekend.md) |
| I do not know what is worth doing here at all | [scout.md](scout.md) |
| I want to see how all of it fits together, end to end | [full-cycle.md](full-cycle.md) |

## The same list, by kind of loop

| Walkthrough | Kind of loop | Example project it uses |
|---|---|---|
| [goal.md](goal.md) | Goal loop — one item until HANDOVER | [Web shop](../web-shop.md) |
| [defect.md](defect.md) | Goal loop, bug fix — narrow scope, stop at the first failure | [Web shop](../web-shop.md) |
| [documentation.md](documentation.md) | Goal loop, text only — `docs` and nothing else | [JSON API](../api.md) |
| [two-agents.md](two-agents.md) | Goal loop — one provider builds, another reviews | [Web app](../web-app.md) |
| [backlog.md](backlog.md) | Backlog loop — a queue you work through | [Web app](../web-app.md) |
| [cadence.md](cadence.md) | Cadence / schedule loop — a timer calls `tick` | [ESP32 firmware](../esp32-embedded.md) |
| [weekend.md](weekend.md) | Backlog and cadence together, over two days | [ESP32 firmware](../esp32-embedded.md) |
| [scout.md](scout.md) | Scout loop — discovery into an inbox | [JSON API](../api.md) |
| [full-cycle.md](full-cycle.md) | All four, end to end: scout, promote, authorize, cadence, accept | [JSON API](../api.md) |
| [dry-run.md](dry-run.md) | Every kind, with the mock provider — no AI, no cost | throwaway trial project |

The concepts behind them are in [LOOP-MODES.md](../../LOOP-MODES.md); the
operational detail, including every scheduler incantation, is in
[ADVANCED.md](../../ADVANCED.md). Where the ideas come from, and what this
template does differently, is in [SOURCES.md](../../SOURCES.md).

## Before you start any of them

These walkthroughs assume the project is already **activated**: a person
approved the setup plan and the activation probes passed. ([dry-run.md](dry-run.md)
is the exception: it generates a throwaway project that is already activated.)
Getting there is the same for every loop and is described in
[the shared setup section](../README.md#chat-variant-common-setup). Until then,
`check` reports that nothing is configured.

Below, `/absolute/path/to/target-project` stands for the full path to your own
repository. Replace it; do not guess it.

## The one command every walkthrough uses

`check` is read-only. It never changes a file, and it answers "where does this
stand" in one call:

```bash
build-loop check --root /absolute/path/to/target-project --json
```

A finished, successful run looks like this (the `gates` entries also carry the
evidence ids that closed them):

```json
{
  "ok": true,
  "run_status": "WAITING_FOR_HUMAN",
  "phase": "HANDOVER",
  "work_item_id": "WI-001",
  "handover_ready": true,
  "judge_verdict": "PASS",
  "gates": {
    "DEFINE": { "status": "PASSED" },
    "DESIGN": { "status": "PASSED" },
    "EXECUTE": { "status": "PASSED" },
    "REVIEW": { "status": "PASSED" },
    "VALIDATE": { "status": "PASSED" },
    "HANDOVER": { "status": "PASSED" }
  },
  "open_blockers": 0,
  "backlog": { "ready": 1, "paused": 2 },
  "inbox": 2,
  "authorization": null,
  "next_action": "Read the handover and the evidence, then accept or send the item back.",
  "verified_success_requires": "a REVIEW verdict of PASS together with a passed VALIDATE gate; handover_ready alone only means there is something to look at"
}
```

Read it in this order:

1. `run_status` and `phase` — where the run is.
2. `handover_ready` — **only** "there is something for you to look at".
3. `judge_verdict` and the VALIDATE gate — together, these are verified success.
4. `open_blockers` — a number above zero means the loop is waiting for a decision.
5. `backlog` and `inbox` — what is queued behind this, and what a scout found.

On the command line `check` also sets an exit code: `0` when a handover is
waiting or the run is finished, `3` while it is not done, `4` when it is
blocked, `2` on an error. A script can branch on that without parsing JSON.

## What is never automatic, in any of them

- **Accepting** a result (`accept`, confirmation word `ACCEPT`).
- **Authorizing** an item to start later (`authorize`, confirmation word
  `AUTHORIZE`) — a permission to start, never approval of a result.
- **Promoting** a scout proposal into the backlog (`promote`, confirmation word
  `PROMOTE`).
- **Changing scope**, allowed paths, or anything under protected paths.
- **Merging, pushing, deploying, releasing, flashing a device or running a
  migration.** A passed handover is a report, not permission.

Those three decisions complete in exactly two ways: the word typed at an
interactive terminal, or the same word typed into the field on a local
confirmation page. Everything else — a JSON input file, a chat tool call — gets
back
`{"ok": true, "pending_confirmation": true, "confirmation_url": "http://127.0.0.1:…"}`
and writes nothing until somebody confirms. The page shows the fully resolved
decision, frozen when the link was made; if the run, the proposal or the decision
changes in the meantime, the confirmation is refused rather than applied to
something else. An assistant hands that link to you; it never opens it itself.

Both routes are recorded with the assurance `local-user-action` — a person with
access to that machine typed the word, which is not proof of who. A project that
needs more writes `{"schema_version": 1, "human_confirmation": "tty-only"}` into
`.loop/control/policy.json` by hand; chat tool calls and input files are then
refused outright with `CONFIRMATION_TTY_ONLY` and the command to run.
