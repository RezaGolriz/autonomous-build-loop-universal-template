# The weekend loop: a queue and a timer, together

**Example project:** the [ESP32 firmware](../esp32-embedded.md) — host-testable
sensor logic plus a firmware build. The host tests are quick, the firmware build
is slow, and nobody wants to watch it on a Saturday.

**When to use this.** Use it when you have a few items written down, you are
happy for two of them to be worked on while you are not there, and you want to
be able to stop everything from your phone. This is the [backlog
loop](backlog.md) and the [cadence loop](cadence.md) running at the same time.

```text
Friday:  three items queued  →  two authorized, 48-hour expiry  →  timer every 30 min
Monday:  check → dashboard → history → next-steps
Any time: hold  →  everything stops
```

The important part is what you are actually granting. Two authorizations mean
two permissions to *start*, each inside its own paths, its own budget and its own
expiry. The timer is not a permission at all; it is only something that keeps
asking "is there anything you already allowed?".

## In chat

**1. Queue the work on Friday.**

```text
Add three backlog items in this order and start none of them:
1. "Rolling average for the temperature sensor" (feature) — outcome: the host
   test suite covers a rolling average over the last ten samples.
2. "Reject out-of-range readings" (defect) — outcome: readings outside the
   sensor's documented range are dropped and counted, with a host test.
3. "Document the sampling rules" (documentation) — outcome: one page describing
   the sampling interval, the averaging window and the rejection rule.
Then list the backlog with the authorization state of each item.
```

*(calls `loop_backlog_add` three times, then `loop_backlog_list`)*

**2. Authorize two of them, with a 48-hour expiry.**

```text
Authorize the rolling-average item and the out-of-range item to start when their
slot comes. For each: scope to the firmware source and the host test folder, 24
rounds, 3600 seconds, expiring in 48 hours, stopping at the first failed gate.
Leave the documentation item unauthorized. Do not start anything.
```

*(calls `loop_authorize` twice. Each call returns its own confirmation link. You
open each link, read the record it would write — the paths, the budget, the
expiry — type `AUTHORIZE` into the field and press the button. Two items means
two separate decisions; there is no way to confirm both at once.)*

**3. Ask the client to call `tick` every 30 minutes.**

```text
Every 30 minutes, call tick on this project and tell me only when the action is
not "nothing", or when the run status becomes BLOCKED or WAITING_FOR_HUMAN.
```

*(calls `loop_tick` on each repetition. If the client cannot repeat a prompt, use
`cron` or a scheduled task — see [the cadence walkthrough](cadence.md).)*

**4. On Monday, ask for the whole picture in one turn.**

```text
Show me the check, the backlog with authorization states, the last twenty lines
of the tick log, the archived runs in history, and the next-steps note. Change
nothing and accept nothing.
```

*(calls `loop_check`, `loop_backlog_list` and `loop_status`)*

**5. Stopping it from your phone.**

```text
Put this project on hold. Reason: I want to look at the sensor readings before
anything else runs.
```

*(calls `loop_hold`. Unlike accepting or authorizing, placing a hold needs no
confirmation page: stopping is never the dangerous direction, so any channel may
do it. Taking it off is the human decision — `loop_release` returns a
confirmation link where you type `RELEASE`.)*

## On the command line

```bash
ROOT=/absolute/path/to/target-project

# 1. Friday: write the queue down. This starts nothing.
build-loop backlog_add --root "$ROOT" \
  --input '{"id":"WI-050","title":"Rolling average for the temperature sensor","work_kind":"feature","outcome":"The host test suite covers a rolling average over the last ten samples."}'
build-loop backlog_add --root "$ROOT" \
  --input '{"id":"WI-051","title":"Reject out-of-range readings","work_kind":"defect","outcome":"Readings outside the documented sensor range are dropped and counted, covered by a host test."}'
build-loop backlog_add --root "$ROOT" \
  --input '{"id":"WI-052","title":"Document the sampling rules","work_kind":"documentation","outcome":"One page describing the sampling interval, the averaging window and the rejection rule."}'

# 2. Authorize two of them. 172800 seconds is 48 hours.
build-loop authorize --root "$ROOT" \
  --input '{"item_id":"WI-050","allowed_paths":["src","test"],"max_rounds":24,"max_wall_seconds":3600,"expires_in_seconds":172800,"stop_on_first_failure":true}'
# Type AUTHORIZE to confirm: AUTHORIZE
build-loop authorize --root "$ROOT" \
  --input '{"item_id":"WI-051","allowed_paths":["src","test"],"max_rounds":24,"max_wall_seconds":3600,"expires_in_seconds":172800,"stop_on_first_failure":true}'
# Type AUTHORIZE to confirm: AUTHORIZE

# 3. The timer. Give the scheduler its own log file.
# */30 * * * * cd /absolute/path/to/target-project && build-loop tick --root /absolute/path/to/target-project >> .loop/control/tick-cron.log 2>&1
```

`cron` starts with a minimal environment: use absolute paths for `build-loop`,
`node`, `git`, `jq` and the provider CLI, and make sure the PlatformIO toolchain
is on that `PATH` or the firmware build fails inside the tick.

Monday morning, four reads and nothing else:

```bash
# Where does it stand?
build-loop check --root "$ROOT" --json

# What is left in the queue, and what is still authorized?
build-loop backlog_list --root "$ROOT" --json

# What did the timer actually do? One line per tick.
tail -20 "$ROOT/.loop/scheduler/tick.log"

# What was finished and archived, and what did the last run want next?
ls "$ROOT/.loop/history/"
cat "$ROOT/.loop/notes/next-steps.md"
```

Stopping and restarting:

```bash
build-loop hold --root "$ROOT" \
  --input '{"reason":"I want to look at the sensor readings before anything else runs."}'
build-loop release --root "$ROOT"   # asks you to type RELEASE
```

## What you find on Monday

Four outcomes are normal. Read them in this order.

| What `check` says | What happened | What you do |
|---|---|---|
| `WAITING_FOR_HUMAN`, `handover_ready: true`, `judge_verdict: "PASS"` | An item ran to handover and passed. | Read the handover and the evidence, then accept — which also promotes the next queued item. |
| `WAITING_FOR_HUMAN` with `judge_verdict` not `PASS` | The run finished and did not succeed. | Read the review findings. This is a finished run, not a successful one. |
| `BLOCKED`, `open_blockers` above zero | A gate failed, or the item hit `stop_on_first_failure`. | Read the blocker, record your answer with `answer`, then `resume`. |
| `PAUSED` and every tick said `"nothing"` | Nothing was READY, or the 48 hours ran out. | Look at `backlog_list`: `authorization_expired` tells you which. Authorize again if you still want it. |

Reasons in the tick log worth reacting to: `authorization-expired` (the 48 hours
were up), `authorization-revoked` (somebody deauthorized an item) and
`authorization-invalid` (a record on disk no longer validates and has to be
written again).

## What you check as the human

- **The expiry did its job.** Two days is deliberately short. If the queue
  stopped on Sunday night because the permission ran out, that is the design
  working, not a fault.
- **Only two items moved.** The third was never authorized, so it should still
  be sitting in the backlog, PAUSED, untouched.
- **The changed files.** Firmware source and host tests, nothing else. Read the
  archived run under `.loop/history/` rather than trusting a summary.
- **The next-steps note is advisory.** It is what the last run thought should
  happen next. It approves nothing, and `accept` copies it into history rather
  than acting on it.
- **The dashboard for a quick look.** Ask chat to show the dashboard, or run
  `build-loop dashboard --root "$ROOT" --json` and open the link. It is
  read-only and its local server stops 30 minutes after the link is issued.

## What can never happen by itself

- **A weekend of ticks accepts nothing.** However often the timer fires, the run
  stops at HANDOVER and waits for you.
- **The timer never authorizes the third item.** An item with no READY
  authorization is never started, never promoted and never touched.
- **An expired permission is refused, not ignored.** The timer keeps firing and
  keeps doing nothing until a person authorizes the item again.
- **A hold closes every automated door.** While `.loop/control/hold.json` exists,
  `start`, `run`, `resume`, `tick`, `task` and `scout` are refused with
  `PROJECT_ON_HOLD` for everything that is not a person at their own terminal —
  so nobody works around your decision by writing a fresh item with a scope of
  its own. Only `release`, with the typed word `RELEASE`, takes it off.
- **Nothing is flashed to a device.** The firmware build is a build. Putting it
  on hardware is a separate action you take yourself.

Next: the whole cycle from discovery to acceptance — [the full cycle](full-cycle.md).
