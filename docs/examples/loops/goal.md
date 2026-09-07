# Goal loop: one item, carried to handover

**Example project:** the [web shop](../web-shop.md) — a public product page that
has to show price, stock and an "Add to cart" button, with browser checks.

The goal loop is the simplest kind. There is one work item. You start it, it
runs to HANDOVER, and then you read what it produced and decide. Nothing is
queued behind it and no timer touches it.

Use it when you know exactly what you want next and you intend to look at the
result yourself before anything else happens.

```text
prepare → approve → activate → run … run → HANDOVER → check → accept
```

## In chat

Prompts for Claude Desktop or the Codex app, one per turn. The names in
brackets are the tools the assistant calls; you never type them.

**1. Where does this stand?**

```text
Run a build-loop check on this project and tell me the run status, the phase,
the judge verdict, the open blockers and the next action. Change nothing.
```

*(calls `loop_check`)*

**2. Move the run forward.**

```text
Continue the current work item in bounded mode for at most 12 nodes. Stop
earlier at any blocker or at handover, then show me the check again.
```

*(calls `loop_run`, then `loop_check`)*

**3. If a blocker appears, decide it yourself.**

```text
For the blocker about the out-of-stock label: my decision is to keep the
existing wording and add a browser assertion for it. Record that exact answer
against that blocker, then resume for at most 6 nodes with a new request id.
```

*(calls `loop_answer`, then `loop_resume`)*

**4. At handover, read before you accept.**

```text
Summarize the handover: the changed files, the review verdict, the validation
evidence and the remaining risks. Do not merge, push, deploy or publish
anything, and do not accept yet.
```

*(calls `loop_status` and reads the evidence records)*

**5. Accept when you are satisfied.**

```text
I have read the handover and I accept it. Note: reviewed locally, product page
checks pass, no deployment authorized.
```

*(calls `loop_accept`. The tool call accepts nothing: it returns a confirmation
link to a local page that names the operation, the work item, the round and the
exact HANDOVER evidence the acceptance is bound to. You open it, read it, type
`ACCEPT` into the field and press the button; only then is the run archived, and
the record keeps the channel `local-http-user` with the assurance
`local-user-action`. The assistant hands the link over and must never open it
itself.)*

## On the command line

```bash
ROOT=/absolute/path/to/target-project

# 1. Where does this stand? Read-only.
build-loop check --root "$ROOT" --json

# 2. Twelve nodes at most, then stop.
build-loop run --root "$ROOT" \
  --input '{"request_id":"web-shop-01","run_mode":"bounded","max_nodes":12}'

# 3. One node only, when you want to watch each step.
build-loop run --root "$ROOT" \
  --input '{"request_id":"web-shop-02","run_mode":"step"}'

# 4. Answer a blocker, then resume.
build-loop answer --root "$ROOT" \
  --input '{"blocker_index":1,"answer":"Keep the existing out-of-stock wording and assert it in the browser test."}'
build-loop resume --root "$ROOT" \
  --input '{"request_id":"web-shop-03","run_mode":"bounded","max_nodes":6}'

# 5. Read the handover before deciding.
build-loop status --root "$ROOT" --json
```

Accepting is a human decision, so it asks you to type the word:

```bash
build-loop accept --root "$ROOT"
# Project root: /absolute/path/to/target-project
# Operation: accept
# This is a human decision. It is recorded with the local time and the channel you used.
# Type ACCEPT to confirm: ACCEPT
```

A script is not a person, however well it spells the word. The same call without
a terminal accepts nothing: it returns a pending request and a link to a local
confirmation page.

```bash
build-loop accept --root "$ROOT" \
  --input '{"confirm":"ACCEPT","note":"reviewed locally; no deployment authorized"}'
# {"ok":true,"pending_confirmation":true,"request_id":"confirm-…",
#  "request_digest":"…","confirmation_word":"ACCEPT",
#  "confirmation_url":"http://127.0.0.1:…/confirm?token=…"}
```

Somebody opens that link, reads the operation, the work item and the note it
would record, types `ACCEPT` into the field and presses the button. The run is
archived at that moment, and `accepted_by` in the archived `acceptance.json` says
`local-http-user`. The link is bound to that one operation, that one item and the
decision frozen when the link was made — including the exact handover evidence,
so a run that moved on in the meantime is refused as `CONFIRMATION_STALE` rather
than accepted by mistake. It expires after fifteen minutes, and repeating the
call returns the same link rather than a second one.
Without the `confirm` field the call is refused outright with
`CONFIRMATION_REQUIRED`. That is the point: nothing accepts on your behalf.

If the page is closed after the button was pressed but before the operation ran,
the receipt it left behind is settled by the next `accept`, `authorize`,
`promote` or `tick` call.

## What you check as the human

- `judge_verdict` is `PASS` **and** the VALIDATE gate passed. `handover_ready`
  on its own only means there is something to look at.
- The changed files are inside the allowed paths you agreed to. For the web
  shop that means the product page and its tests, not the checkout or the
  payment configuration.
- The browser evidence actually ran. Read the evidence rows: a skipped
  Playwright run is not a passed one.
- The handover note names its remaining risks and open questions instead of
  claiming everything is finished.

## What can never happen by itself

- The run cannot accept itself. `accept` needs the word `ACCEPT` typed at a
  terminal, or typed by a person into the field on the local confirmation page. A
  chat tool call and an input file can only ask for that page — and a project
  whose `.loop/control/policy.json` says `"human_confirmation": "tty-only"`
  refuses even that, so only the terminal decides.
- The run cannot widen its own scope or edit protected paths to make its checks
  pass.
- A passed handover publishes nothing. Building the site, pushing the branch and
  deploying it are separate actions you take afterwards.
- The worker never grades its own work: the referee records the gates and an
  independent review session records the verdict.

Next: several items in a row — [the backlog loop](backlog.md).
