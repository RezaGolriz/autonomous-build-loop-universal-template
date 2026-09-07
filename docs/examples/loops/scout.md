# Scout loop: discovery into an inbox

**Example project:** the [JSON API](../api.md) — an orders API that publishes an
OpenAPI description clients rely on. The interesting question there is not "how
far is this item" but "has the implementation drifted away from the contract
while nobody was looking".

A scout answers exactly that kind of question. `scout` sends the configured
provider once through the project and asks it for proposals. It writes them into
`.loop/inbox/` and stops. Nothing else happens.

```text
scout → inbox (inert proposals) → you read them → promote / discard → backlog
```

**Containment.** Only a bundled provider wrapper is ever executed: the wrapper
shipped for that host, or the one `configure` generated around it. That matters,
because a program started with your own privileges can write to any absolute path
whatever its working directory is — a disposable copy on its own contains
nothing. Containment rests on those bundled wrappers selecting read-only tooling:
Claude gets `Read`, `Glob` and `Grep` with an explicit deny list, Codex runs in
its read-only sandbox.

On top of that the provider never sees the real project. It runs in a disposable
copy without the repository history and without the loop's control directory,
with a clean environment limited to the adapter's allowed names, and with a home
and temporary directory inside that copy. The copy is removed afterwards whatever
happened.

**What it looks for.** The same things in every project — tests that fail, are
skipped or are missing, TODO and FIXME markers that stand for real unfinished
work, and dependency or manifest drift — plus what fits the profile. For the
`api` profile that is **drift between the declared contract and the
implementation**: a route in the code that the OpenAPI description does not
mention, a status code the description promises and the handler never returns, a
schema field that changed shape. The brief also carries the titles already in
the backlog, so the scout does not propose them again, and the content of
`.loop/notes/next-steps.md` when a previous run left that note.

## In chat

**1. Run the scout and read what came back.**

```text
Scout this API project and show me the proposals that came back: title, outcome
and the evidence each one points at. Do not promote anything and do not start
anything.
```

*(calls `loop_scout`, then `loop_inbox_list`)*

**2. Read one proposal properly before deciding.**

```text
Show me the full text of the proposal about the contract drift on GET /orders,
including its constraints and evidence pointers. Then tell me what you would
need to check to be sure it is real.
```

**3. Promote the ones worth doing.**

```text
Promote the contract-drift proposal into the backlog as a defect, and discard
the one about renaming the internal helper. Then list the backlog.
```

*(calls `loop_promote`, which returns a confirmation link instead of promoting
anything: you open it, check that it names the right proposal and the digest of
its exact text, type `PROMOTE` into the field and press the button. `loop_discard` completes directly, then `loop_backlog_list` shows the
result.)*

**4. A promoted proposal is still unauthorized and unstarted.**

```text
Show me the check and the backlog. Confirm that the promoted item is PAUSED and
that nothing started.
```

*(calls `loop_check` and `loop_backlog_list`)*

## On the command line

```bash
ROOT=/absolute/path/to/target-project

# 1. One read-only discovery run. Use the project's configured provider…
build-loop scout --root "$ROOT" --json

# …or name one explicitly.
build-loop scout --root "$ROOT" --input '{"provider":"claude"}'

# Force a profile instead of taking it from the adapter's project_kind.
build-loop scout --root "$ROOT" --input '{"provider":"codex","profile":"api"}'

# 2. What is waiting?
build-loop inbox_list --root "$ROOT" --json

# 3. Triage. Promoting is a human decision: at a terminal it asks for the word.
build-loop promote --root "$ROOT" \
  --input '{"proposal_id":"P-20260907T101530Z-1","id":"WI-020","work_kind":"defect"}'
# Type PROMOTE to confirm: PROMOTE

# Discarding is a deliberate call and completes directly.
build-loop discard --root "$ROOT" \
  --input '{"proposal_id":"P-20260907T101530Z-2"}'

# 4. Nothing started.
build-loop check --root "$ROOT" --json
build-loop backlog_list --root "$ROOT" --json
```

Run the same `promote` without a terminal — in a script, or over MCP — and it
completes nothing. It returns a pending request with a `confirmation_url` on a
local page instead; a person opens it, reads which proposal would become which
work item, types `PROMOTE` into the field and presses the button. Only then is
the item written, and the record keeps the channel `local-http-user`. The page is
bound to the sha256 of the proposal text the person read, so a proposal rewritten
in between is refused as `CONFIRMATION_STALE` rather than promoted.

Without `provider`, the scout takes only the host *name* from the project's
signed machine-local host configuration and runs the wrapper bundled with this
distribution for that name. A `provider_path` in that configuration is ignored,
and a `provider` argument that is not exactly `claude`, `codex` or `mock` falls
back to the bundled wrapper. There is no way to hand a scout another executable.

Where things land:

| Path | What is in it |
|---|---|
| `.loop/inbox/<proposal-id>.md` | One proposal, written from the work-item template |
| `.loop/inbox/index.json` | The list `check` and `status` count as the inbox |
| `.loop/inbox/promoted/` | Proposals a person promoted |
| `.loop/inbox/discarded/` | Proposals a person discarded |
| `.loop/scheduler/scout.log` | One JSON line per scout run |

A scout refuses to run while a managed job is running.

## What you check as the human

- **Is the drift real?** A scout reads code and text; it does not run your
  contract tests. Before promoting a contract-drift proposal, look at the
  evidence pointers it gives and at the OpenAPI file yourself.
- **Is it in scope?** A proposal to restructure the whole persistence layer is
  not a bounded work item, however true it is. Promote the version you would be
  willing to authorize.
- **Duplicates.** The brief carries the backlog titles, but a proposal can still
  overlap an item you already have. Check `backlog_list` before promoting.
- **The provider that wrote it.** The inbox lists which provider proposed what
  and when. A proposal is an opinion from a model, not a finding from a check.
- **Discard freely.** An unpromoted proposal costs nothing. Leaving noise in the
  inbox makes the next scout run less useful, because you read it less carefully.

## What can never happen by itself

- **A scout runs only a bundled wrapper.** There is no argument for pointing it
  at another program, and a signed host configuration naming something else falls
  back to the bundled wrapper.
- **A scout changes nothing.** It runs against a disposable copy and never
  touches the backlog, `state.json`, or a run.
- **A proposal is inert text.** It becomes work only when a person calls
  `promote`, which writes the work item through the same path as `backlog_add`
  and appends it to the ordered backlog — still unauthorized, still not started.
- `promote` is a human decision: a word typed at a terminal, or the same word
  typed into the field on the local confirmation page. `discard` is a deliberate
  call. Both record which boundary the decision came through.
- A promoted item still needs a human `authorize` before any
  [cadence loop](cadence.md) may start it, and a human `accept` at the end.

Next: two agents instead of one — [one builds, the other reviews](two-agents.md).
Back to the list: [all the walkthroughs](README.md).
