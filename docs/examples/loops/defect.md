# Bug fix: one small item, stopped at the first failure

**Example project:** the [web shop](../web-shop.md) — a public product page that
has to show price, stock and an "Add to cart" button, with browser checks.

**When to use this.** Use it when something is broken and you want it fixed and
nothing else. A bug fix is the loop at its smallest: one item, a narrow scope,
one authorization, and a hard stop at the first failed gate so you find out
early instead of after twenty rounds of guessing.

The reported bug: the product page shows "In stock" even when the stock count is
zero.

```text
backlog_add (defect) → authorize (narrow scope, stop_on_first_failure)
                     → tick or start → HANDOVER → check → accept
```

Two settings do the work here:

- **`work_kind` is `defect`.** That tells the worker what a good result looks
  like for this kind of item: reproduce the failure first, fix its cause, prove
  the regression is covered. It unlocks nothing and skips nothing.
- **`stop_on_first_failure` is `true`.** A failed gate puts the item into BLOCKED
  instead of sending it round again. For a bug you have not diagnosed yourself,
  that is what you want: a first failure usually means the diagnosis was wrong,
  and more rounds only bury it.

## In chat

**1. Write the bug down as one item.**

```text
Add one backlog item, work kind defect, and start nothing:
"Out-of-stock product page still says In stock" — outcome: when the stock count
is zero the product page shows the out-of-stock label and the Add to cart button
is disabled, and a browser test covers exactly that case.
```

*(calls `loop_backlog_add`)*

**2. Authorize it narrowly.**

```text
Authorize that item to start: scope it to the product page component and its
tests only, 12 rounds, 900 seconds, expiring in 4 hours, stopping at the first
failed gate. Do not start it now.
```

*(calls `loop_authorize`, which returns a confirmation link rather than
authorizing anything. You open the link, read the record it would write — the
paths, the 12 rounds, the 900 seconds, the expiry — type `AUTHORIZE` into the
field and press the button. The assistant hands the link over and never opens
it.)*

**3. Run it, or let a tick run it.**

```text
Start the authorized item in bounded mode for at most 12 nodes, then show me the
check with the run status, the phase and the open blockers.
```

*(calls `loop_start`, then `loop_check`. A single `loop_tick` would start it too,
because it is READY.)*

**4. If it stops early, read why.**

```text
The run is BLOCKED. Show me the blocker question, the failed gate and the
evidence rows behind it. Do not raise the round budget and do not resume yet.
```

*(calls `loop_check` and `loop_status`)*

**5. Accept when the fix and its test are both there.**

```text
I have read the handover: the reproduction test, the fix and the browser
evidence. I accept it. Note: reviewed locally, nothing deployed.
```

*(calls `loop_accept`, which returns a confirmation link you open and confirm
with the word `ACCEPT`.)*

## On the command line

```bash
ROOT=/absolute/path/to/target-project

# 1. One defect item. This starts nothing.
build-loop backlog_add --root "$ROOT" \
  --input '{"id":"WI-030","title":"Out-of-stock product page still says In stock","work_kind":"defect","outcome":"When the stock count is zero the product page shows the out-of-stock label and the Add to cart button is disabled, covered by a browser test."}'

# 2. Narrow scope, small budget, hard stop at the first failure.
build-loop authorize --root "$ROOT" \
  --input '{"item_id":"WI-030","allowed_paths":["src/components","tests"],"max_rounds":12,"max_wall_seconds":900,"expires_in_seconds":14400,"stop_on_first_failure":true}'
# Type AUTHORIZE to confirm: AUTHORIZE

# 3a. Run it by hand.
build-loop start --root "$ROOT" \
  --input '{"request_id":"web-shop-fix-01","run_mode":"bounded","max_nodes":12}'

# 3b. Or let one tick start it, inside the same budget.
build-loop tick --root "$ROOT" --json

# 4. Where does it stand?
build-loop check --root "$ROOT" --json

# 5. Read the handover, then accept.
build-loop status --root "$ROOT" --json
build-loop accept --root "$ROOT"
# Type ACCEPT to confirm: ACCEPT
```

A run that stopped on its first failed gate looks like this in `check`:

```json
{
  "ok": true,
  "run_status": "BLOCKED",
  "phase": "EXECUTE",
  "work_item_id": "WI-030",
  "handover_ready": false,
  "judge_verdict": null,
  "open_blockers": 1,
  "next_action": "Answer the open blockers, then resume."
}
```

The blocker line reads "stopped on first failure (authorization)". Answer the
question, then resume with a new request id:

```bash
build-loop answer --root "$ROOT" \
  --input '{"blocker_index":1,"answer":"The stock count arrives as the string \"0\"; treat any falsy or zero value as out of stock and assert both in the test."}'
build-loop resume --root "$ROOT" \
  --input '{"request_id":"web-shop-fix-02","run_mode":"bounded","max_nodes":6}'
```

## What you check as the human

- **Is the bug actually reproduced?** For a defect item, the first thing worth
  looking for in the evidence is a test that failed before the change and passes
  after it. A fix with no failing test first is a guess that happened to work.
- **Is the scope still narrow?** The changed files should be the component and
  its tests. A fix that also touched the cart, the build configuration or a
  shared utility is a different item wearing this item's name.
- **Did it stop early, and why?** With `stop_on_first_failure` a BLOCKED run is
  the normal, useful outcome of a wrong diagnosis. Read the blocker; do not raise
  the round budget to push past it.
- **The browser evidence ran.** A skipped Playwright run is not a passed one.
- **The expiry.** Four hours is short on purpose. If you come back tomorrow the
  permission is gone and you authorize it again — that is the intended cost of
  leaving a bug fix half-started.

## What can never happen by itself

- The loop cannot decide that a bug is fixed. `accept` needs the word `ACCEPT`
  typed at a terminal, or typed into the field on the local confirmation page.
- `stop_on_first_failure` cannot be turned off by the run. It is part of the
  authorization record a person confirmed, and the job re-reads that record
  before every node.
- The run cannot widen `allowed_paths` to reach the file it now believes is at
  fault. That needs a new authorization from you.
- A fix is not a release. Merging, pushing and deploying the corrected page are
  separate actions you take afterwards.

Next: the same six phases applied to text — [a documentation loop](documentation.md).
