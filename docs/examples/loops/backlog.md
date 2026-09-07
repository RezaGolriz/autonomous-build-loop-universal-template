# Backlog loop: a queue you work through

**Example project:** the [web app](../web-app.md) — a browser client with a
login form and a dashboard, checked with Vitest and Playwright.

A web app is rarely one change. After the login form there is the session
timeout, then the error states, then the empty dashboard. The backlog loop lets
you write those down in order, decide which one may run, and let acceptance of
the finished item promote the next one.

```text
backlog_add ×3 → authorize (one queued item) → finish the current run → accept
                                                                          ↓
                          the authorized item becomes the current one, PAUSED at DEFINE
                                                                          ↓
                                                          start it, or let a tick start it
```

Three things stay separate on purpose, and the order matters:

- **Adding** puts an item in the queue *behind* whatever is loaded right now. It
  does not become the current work item.
- **Promotion** happens on `accept`. Only then does the next queued item become
  the current one, in phase DEFINE, at round 0, **paused**. Until that moment,
  `start` still operates on the item that is loaded, not on the one you just
  authorized.
- **Starting** is still a decision. Either you start the promoted item yourself,
  or you authorized it as READY beforehand and a [tick](cadence.md) starts it
  inside that budget.

## In chat

**1. Write the queue down.**

```text
Add three backlog items to this project, in this order, and start none of them:
1. "Session timeout redirects to login" (defect) — outcome: an expired session
   sends the user to the login screen with a message, and the dashboard route
   is not rendered.
2. "Form error states" (feature) — outcome: wrong password, locked account and
   network failure each show their own message.
3. "Document the auth states" (documentation) — outcome: one page listing every
   auth state with the screen the user sees.
Then list the backlog with the authorization state of each item.
```

*(calls `loop_backlog_add` three times, then `loop_backlog_list`)*

**2. Let exactly one of them start later.**

```text
Authorize the session-timeout item to start when its slot comes. Scope it to
the source and test folders only, 20 rounds, 1800 seconds of wall-clock time,
expiring in 8 hours, stopping at the first failed gate. Do not start it.
```

*(calls `loop_authorize`. The tool call does **not** authorize anything by
itself: it comes back with a confirmation link. The assistant hands you that
link, you open it in your browser, and the page shows the exact record that would
be written — the paths, the 20 rounds, the 1800 seconds, the expiry. You type
`AUTHORIZE` into the field and press the button. Only then is that record
written, with the channel `local-http-user` and the assurance
`local-user-action`. The assistant must never open that link for you.)*

**3. Accept the run that is loaded now — that is what promotes the item.**

Authorizing the session-timeout item did not make it current. The item that is
loaded keeps running until you accept it, and acceptance is what promotes the
next queued item into a fresh, paused state.

```text
I have read the handover of the current work item and I accept it. Note:
reviewed locally; nothing deployed. Afterwards, show me the check and the
backlog so I can see which item is current now.
```

*(calls `loop_accept`, which again returns a confirmation link; the page names
the run and its handover evidence, and you type `ACCEPT` into the field. After you
confirm, `loop_check` and `loop_backlog_list` show the
session-timeout item as the current one, PAUSED at DEFINE, round 0)*

**4. Now start the promoted item — or let a tick start it.**

```text
Confirm from the check that the current work item is the session-timeout item,
then start it in bounded mode for at most 12 nodes and show me the check again.
```

*(calls `loop_check`, `loop_start`, then `loop_check`. Because the item is
already READY, a [tick](cadence.md) would start it too, inside the budget you
authorized.)*

**5. Change your mind about an item.**

```text
Take the authorization off the form-error-states item, and remove the
documentation item from the backlog entirely.
```

*(calls `loop_deauthorize` and `loop_backlog_remove`; the work item file and its
authorization sidecar stay on disk)*

### Stopping everything

Taking an authorization off does more than pause one item: `deauthorize` also
puts the whole project on hold, and you can put one on deliberately at any time
("Put this project on hold, the release is frozen until Monday"). While the hold
is on, nothing automated starts, runs, resumes, ticks, prepares a new work item
or scouts here — so nobody works around your decision by writing a fresh item
with a scope of its own. Reading, cancelling and acknowledging a handover keep
working. You take the hold off yourself with `release` and the typed word
`RELEASE`; a chat tool call can only hand you the link to the local page where
you type it.

## On the command line

```bash
ROOT=/absolute/path/to/target-project

# 1. Write the queue down. This starts nothing.
build-loop backlog_add --root "$ROOT" --input '{"id":"WI-010","title":"Session timeout redirects to login","work_kind":"defect","outcome":"An expired session sends the user to the login screen with a message and the dashboard route is not rendered."}'
build-loop backlog_add --root "$ROOT" --input '{"id":"WI-011","title":"Form error states","work_kind":"feature","outcome":"Wrong password, locked account and network failure each show their own message."}'
build-loop backlog_add --root "$ROOT" --input '{"id":"WI-012","title":"Document the auth states","work_kind":"documentation","outcome":"One page listing every auth state with the screen the user sees."}'

# 2. Read the queue back.
build-loop backlog_list --root "$ROOT" --json
```

Authorizing is a human decision, so at an interactive terminal it asks you to
type the word:

```bash
build-loop authorize --root "$ROOT" \
  --input '{"item_id":"WI-010","allowed_paths":["src","tests"],"max_rounds":20,"max_wall_seconds":1800,"expires_in_seconds":28800,"stop_on_first_failure":true}'
# Type AUTHORIZE to confirm: AUTHORIZE
```

The same call without a terminal — in a script, or over MCP — cannot complete
the decision, whatever word it passes. It writes nothing and returns a pending
request with a link to a local confirmation page instead:

```bash
build-loop authorize --root "$ROOT" \
  --input '{"confirm":"AUTHORIZE","item_id":"WI-010","allowed_paths":["src","tests"],"max_rounds":20,"max_wall_seconds":1800,"expires_in_seconds":28800}'
# {"ok":true,"pending_confirmation":true,"request_id":"confirm-…",
#  "request_digest":"…","confirmation_word":"AUTHORIZE",
#  "confirmation_url":"http://127.0.0.1:…/confirm?token=…"}
```

A person opens that link. The page shows the exact record that would be written,
defaults and expiry included, frozen when the link was made. They type
`AUTHORIZE` into the field and press the button. Only then is that record
written, `authorized_by` says `local-http-user` and `assurance` says
`local-user-action`. Repeating the same call hands out the same link rather than
a second one, and the link expires after fifteen minutes. If the project's
`.loop/control/policy.json` says `"human_confirmation": "tty-only"`, this call
returns `CONFIRMATION_TTY_ONLY` instead, with the exact terminal command.

**WI-010 is now READY, but it is not the current work item.** `start` operates on
whatever `state.json` has loaded, so authorizing a queued item does not move the
queue. Finish the run that is loaded and accept it — that is what promotes
WI-010:

```bash
# The run that is loaded reaches HANDOVER.
build-loop check --root "$ROOT" --json

# Accepting archives it and promotes the next queued item, WI-010.
build-loop accept --root "$ROOT"
# Type ACCEPT to confirm: ACCEPT
```

Now WI-010 is the current one, PAUSED at DEFINE, round 0. Read that back before
starting anything:

```bash
build-loop check --root "$ROOT" --json    # work_item_id is now "WI-010"
build-loop backlog_list --root "$ROOT" --json

# Either start it yourself…
build-loop start --root "$ROOT" \
  --input '{"request_id":"web-app-01","run_mode":"bounded","max_nodes":12}'

# …or let a tick start it, because you already authorized it as READY.
build-loop tick --root "$ROOT" --json
# {"action":"started","reason":"started-authorized-item", …}
```

Undoing decisions:

```bash
build-loop deauthorize   --root "$ROOT" --input '{"item_id":"WI-011"}'
build-loop backlog_remove --root "$ROOT" --input '{"id":"WI-012"}'

# Stopping everything, and letting it continue again.
build-loop hold    --root "$ROOT" --input '{"reason":"The release is frozen until Monday."}'
build-loop release --root "$ROOT"   # asks you to type RELEASE
```

## What you check as the human

- **Before authorizing:** the allowed paths really are the smallest set the item
  needs. For the session-timeout defect that is the auth module and its tests —
  not the build configuration and not the end-to-end fixtures for other screens.
- **The expiry.** Eight hours means the permission is gone tomorrow morning.
  Nothing starts from an expired record; you authorize it again if you still
  want it.
- **After accepting:** the check shows the *next* item as current and PAUSED.
  Read `work_item_id` back before you start anything, so you are certain you are
  starting the item you authorized and not the one that was loaded before. If it
  shows RUNNING, something started it — look at `.loop/scheduler/tick.log` and at
  the authorization record.
- **What the confirmation page says.** It names the operation, the item and every
  value of the payload. If any of that is not what you asked for, close the page
  instead of pressing the button; nothing is written until you press it.
- **An invalid record.** If `check`, `status` or the dashboard shows the
  authorization as INVALID, the sidecar on disk does not validate — a broken
  expiry, for example. It is not a weaker permission: nothing starts from it, and
  a person has to authorize the item again.
- The archived run under `.loop/history/<item>-<timestamp>/` holds the state,
  the work item, the authorization, the evidence list and the next-steps note.
  That is your record of what was accepted and why.

## What can never happen by itself

- `backlog_add` and `promote` never start anything. They write files.
- `accept` promotes the next item but never starts it.
- **A tool call is not a person.** `accept`, `authorize` and `promote` complete
  directly only when the word was typed at an interactive terminal. From an input
  file or a chat tool call they return a confirmation link and write nothing
  until somebody presses the button on that local page.
- **Authorizing does not reorder the queue.** It records a permission for one
  item; the item becomes current only through `accept`.
- An authorization is a permission to **start**, inside its paths, its budget
  and its expiry. It is never approval of a result, and it never widens the
  scope of a node.
- Removing an item from the backlog does not delete its work item file, so a
  removal is not a way to hide a record.

Next: letting a timer move the authorized item — [the cadence loop](cadence.md).
