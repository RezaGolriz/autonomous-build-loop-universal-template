# Cadence / schedule loop: a timer calls `tick`

**Example project:** the [ESP32 firmware](../esp32-embedded.md) — host-testable
sensor logic plus a firmware build. The host tests are quick, the firmware build
is not, and nobody wants to sit and watch it.

A cadence loop is a timer that calls one operation, `tick`, over and over. Each
tick looks at the recorded situation and does **at most one thing**:

1. a job is already running — it only reports;
2. the run is RUNNING — it advances one node (or `max_nodes` of them);
3. the run is BLOCKED, or waiting for a human with a **passed** HANDOVER gate —
   it only reports. A run that is waiting for a human while the HANDOVER gate is
   still PENDING has not written its handover yet: that is work, not a wait, so
   the tick runs that node like any other, with reason
   `ran-the-pending-handover-node`;
4. the run is PAUSED or COMPLETED **and** a person authorized an item as READY
   **and** that authorization has not expired — it starts that item and runs one
   node;
5. otherwise — nothing.

Continuing is bound to the same decision as starting. If the current item has an
authorization sidecar, it has to be READY and unexpired at the moment of the
launch; otherwise the tick reports `authorization-revoked`,
`authorization-expired` or `authorization-invalid` and starts nothing. A run a
person started by hand has no sidecar at all, and a tick may continue it.

The result is `{"action": "ran-node" | "started" | "reported" | "nothing",
"reason": "..."}` followed by the whole `check` output.

**Set up the authorization first.** Without a READY item, a cadence loop can
only ever advance a run that is already going. That is deliberate.

## In chat

**1. Authorize the item you want moved.**

```text
Authorize the rolling-average item to start when its slot comes: scope it to
the firmware source and the host test folder, 24 rounds, 3600 seconds, expiring
in 12 hours, stopping at the first failed gate. Do not start it now.
```

*(calls `loop_authorize`, which returns a confirmation link rather than
authorizing anything. Open the link yourself; the page shows the exact record
that would be written, defaults, budget and expiry included. Type `AUTHORIZE`
into the field and press the button; the record is then written with the channel
`local-http-user` and the assurance `local-user-action`. The assistant must hand
the link over and never open it.)*

**2. One tick, by hand, to see what it does.**

```text
Call tick once and tell me the action, the reason, the run status and the
phase. Do not accept or authorize anything else.
```

*(calls `loop_tick`)*

**3. Ask the client to repeat it.**

Some clients can repeat a prompt themselves. Ask in plain words:

```text
Every 30 minutes, call tick on this project and tell me only when the action is
not "nothing", or when the run status becomes BLOCKED or WAITING_FOR_HUMAN.
```

*(calls `loop_tick` on each repetition)*

If the client cannot repeat a prompt, use a scheduler from the next section.

## On the command line

One tick:

```bash
ROOT=/absolute/path/to/target-project
build-loop tick --root "$ROOT" --json
```

Two nodes per tick instead of one:

```bash
build-loop tick --root "$ROOT" --input '{"max_nodes":2}'
```

`tick` exits `0` for every one of its four actions. Exit `2` means the call
itself failed.

### Claude Code — `/loop`

Repeat a prompt on a timer while the session is open:

```text
/loop 30m
Run `build-loop tick --root /absolute/path/to/target-project` and report the
action, the reason, the run status and the phase from its JSON. Do not start,
accept or authorize anything else.
```

The natural-language form works too — "every 30 minutes, run build-loop tick on
this project and tell me the action and the run status". The loop lives only as
long as that session is open; closing it stops the cadence and schedules
nothing on the machine.

### Claude Code — `/schedule`

`/schedule` creates a routine that runs whether or not a session is open:

```text
/schedule every day at 09:00
Run `build-loop tick --root /absolute/path/to/target-project` and report the
action and the run status from its JSON.
```

Scheduled routines have a minimum interval, typically one hour. Use `cron` for
anything more frequent.

### Codex Automations

Create an automation whose prompt runs the CLI:

```text
Run the shell command:
build-loop tick --root /absolute/path/to/target-project --input '{"max_nodes":1}'
Report the action, the reason and the run status from the JSON it prints. Do
not authorize or accept anything.
```

### cron

```text
*/30 * * * * cd /absolute/path/to/target-project && build-loop tick --root /absolute/path/to/target-project >> .loop/control/tick-cron.log 2>&1
```

Give the scheduler its **own** log file, as above. `tick` writes its structured
line into `.loop/scheduler/tick.log` by itself; redirecting the JSON it prints on
stdout into that same file would append a second, differently shaped record after
it, and everything that reads the last line of the tick log — `status`, `check`
and the dashboard tile — would then show that JSON as the last tick.

`cron` starts with a minimal environment. Use absolute paths for `build-loop`,
`node`, `git`, `jq` and the provider CLI, or set `PATH` in the crontab. For the
ESP32 recipe the PlatformIO toolchain also has to be on that `PATH`, or the
firmware build step fails inside the tick rather than outside it.

**The slash-command syntax of these clients changes between releases.** If one
of the forms above is not recognised, check that client's own documentation for
its current scheduling command; the `build-loop tick` call inside it does not
change.

## What you check as the human

- **The tick log.** `.loop/scheduler/tick.log` gets one line per tick with the UTC
  time, the action, the reason, the item, the phase and the run status. Reading
  it back is how you find out what a timer did while you were away.
- **`action` over time.** A long run of `"nothing"` usually means no item is
  READY, or the authorization expired. A run of `"reported"` means the loop is
  waiting for you — read `reason`. The reasons worth reacting to are
  `authorization-revoked` (somebody deauthorized the item under a run),
  `authorization-expired` (the permission ran out) and `authorization-invalid`
  (the sidecar on disk does not validate and has to be written again).
- **Stopping everything.** A cadence is the loop that keeps going while you are
  away, so it is the one you most often want to stop. `hold` puts the project on
  hold from any channel, and `deauthorize` places one as well: every following
  tick is refused with `PROJECT_ON_HOLD` and the timer keeps hitting a closed
  door instead of finding a new item to start. Nothing but your own `release` —
  the typed word `RELEASE` — takes it off again, and `check`, `status` and the
  dashboards all say the project is on hold while it is there.
- **The scheduler's own log.** If you redirected `cron` output, that file
  (`.loop/control/tick-cron.log` above) holds the raw JSON and any error from the
  scheduler. It is separate from `.loop/scheduler/tick.log`, which is the record
  every reader parses.
- **`stopped-on-first-failure`.** With that flag set, a failed gate puts the
  item into BLOCKED instead of retrying it. That is a signal to look, not a
  reason to raise the round budget.
- **The firmware evidence.** For the ESP32 recipe, check that the host unit
  tests ran and that the firmware build step is the one you agreed to. Nothing
  in a cadence loop flashes a device.
- **The budget.** The caps in `state.json` come from the authorization. The
  cadence adds no second counter and grants no extra rounds.

## What can never happen by itself

- **A tick never grants approval.** It can only start an item a person already
  authorized as READY, only inside the recorded scope, budget and expiry.
- An **expired** authorization is refused, not ignored. The timer keeps firing
  and keeps doing nothing until a person authorizes the item again.
- A **PAUSED** item is never promoted and never started by a tick.
- **A revoked or expired authorization stops the cadence** for a run it started,
  not only for a new one. The item is re-read before every node of the job, and
  the job stops at the next node boundary.
- **Two ticks cannot overlap.** The first writes `.loop/scheduler/tick.lock` with
  a fenced id; a second one reports `tick-in-progress`. The lock is written to a
  private name and linked into place, so no tick ever sees a half-written one. A
  lock is reclaimed only when it is provably not protecting anything: its
  recorded owner process is gone, or nothing readable was ever written and the
  file is older than the run's own `max_wall_seconds`.
- **Acceptance is never a tool call.** `accept`, `authorize` and `promote`
  complete only from a word typed at a terminal, or from the same word typed by a
  person into the field on the local confirmation page. A timer can reach
  neither, and a project set to `tty-only` in `.loop/control/policy.json` leaves
  only the terminal.
- Scope changes and every external action — including flashing hardware — stay
  human-only however often the timer fires.

Next: finding work in the first place — [the scout loop](scout.md).
