# Documentation loop: the same six phases, for text

**Example project:** the [JSON API](../api.md) — an orders API that publishes an
OpenAPI description clients rely on.

**When to use this.** Use it when the thing that needs to change is a document,
not code: a getting-started page, an endpoint reference, a migration note. The
loop treats text exactly like code. It defines what "good" means, designs the
shape, writes it, has it reviewed by an independent session, validates it against
real checks, and hands it over for you to accept.

Two settings make it a documentation loop:

- **`work_kind` is `documentation`.** The worker is told to name the reader and
  to verify the examples, links and documented behaviour rather than to invent
  prose.
- **`allowed_paths` is `docs/**` and nothing else.** The run may write text. It
  may not "fix" the source to match what it wrote.

```text
backlog_add (documentation, docs/** only) → authorize → run → REVIEW
                                          → VALIDATE → HANDOVER → accept
```

**What is validated?** Whatever your project adapter runs for the DESIGN and
VALIDATE phases. For a docs item that is usually a link checker, a
markdown linter, or a script that extracts the code samples from the page and
runs them. If a project has no such check, the loop still runs all six phases,
but the VALIDATE evidence is only as strong as the command behind it. Set that
command up before you rely on this loop.

## In chat

**1. Write the docs item down.**

```text
Add one backlog item, work kind documentation, and start nothing:
"Document the orders endpoints" — outcome: docs/api/orders.md lists every route
in the OpenAPI description with its parameters, its status codes and one worked
request and response per route, and every code sample in it runs.
```

*(calls `loop_backlog_add`)*

**2. Authorize it for the docs folder only.**

```text
Authorize that item: scope it to docs only, 12 rounds, 1200 seconds, expiring in
8 hours, stopping at the first failed gate. Do not start it.
```

*(calls `loop_authorize`, which returns a confirmation link. You open it, check
that the only allowed path is `docs`, type `AUTHORIZE` into the field and press
the button.)*

**3. Run it like any other item.**

```text
Start the authorized item in bounded mode for at most 12 nodes, then show me the
check with the run status, the phase and the judge verdict.
```

*(calls `loop_start`, then `loop_check`)*

**4. Read what the reviewer said about the text.**

```text
Show me the REVIEW evidence and the VALIDATE evidence for this run: the verdict,
the findings, and which check actually ran over the documentation. Do not accept
yet.
```

*(calls `loop_status` and reads the evidence records)*

**5. Accept it.**

```text
I have read the page and the evidence, and I accept it. Note: reviewed locally;
not published.
```

*(calls `loop_accept`, which returns a confirmation link you confirm with the
word `ACCEPT`.)*

## On the command line

```bash
ROOT=/absolute/path/to/target-project

# 1. One documentation item.
build-loop backlog_add --root "$ROOT" \
  --input '{"id":"WI-040","title":"Document the orders endpoints","work_kind":"documentation","outcome":"docs/api/orders.md lists every route in the OpenAPI description with parameters, status codes and one worked request and response per route, and every code sample in it runs."}'

# 2. Text only. Nothing under src, nothing under tests.
build-loop authorize --root "$ROOT" \
  --input '{"item_id":"WI-040","allowed_paths":["docs"],"max_rounds":12,"max_wall_seconds":1200,"expires_in_seconds":28800,"stop_on_first_failure":true}'
# Type AUTHORIZE to confirm: AUTHORIZE

# 3. Run it.
build-loop start --root "$ROOT" \
  --input '{"request_id":"api-docs-01","run_mode":"bounded","max_nodes":12}'
build-loop check --root "$ROOT" --json

# 4. Read the handover, then accept.
build-loop status --root "$ROOT" --json
build-loop accept --root "$ROOT"
# Type ACCEPT to confirm: ACCEPT
```

A run that tried to change the implementation instead of the page does not
quietly succeed. The EXECUTE gate fails with evidence naming the path outside
`docs`, and the run is left BLOCKED. That is the whole point of the narrow scope.

The repository ships a docs-only adapter you can read as a starting point:
[examples/adapters/docs-only.json](../../../examples/adapters/docs-only.json).

## What you check as the human

- **Who is the reader?** A documentation item that does not say who it is for
  produces prose that helps nobody. Put the reader in the outcome you write.
- **Do the examples run?** Read the VALIDATE evidence and find the command that
  checked the samples or the links. Prose that reviews well and does not run is
  the classic failure of a docs loop.
- **Did anything outside `docs` change?** The gate should catch it, but read the
  changed-file list yourself. It takes ten seconds.
- **Is it true today?** A page can be well written, well reviewed and describe
  behaviour the code no longer has. The independent review checks the recorded
  change against the recorded evidence; it is not a substitute for you knowing
  the product.
- **Publishing is separate.** A passed handover means the file in your working
  tree is ready to look at. It is not published, committed or deployed.

## What can never happen by itself

- **Documentation gets no fast lane.** The same six phases, the same gates and
  the same mandatory independent review as a feature or a bug fix.
- The run cannot edit the source to make the page true. `allowed_paths` is an
  outer boundary that a slice may narrow and can never reach outside of.
- The run cannot change protected paths to make its own checks pass.
- Nothing is published. Committing, pushing and building the documentation site
  are separate human actions after the handover.

Next: leaving a queue running while you are away — [the weekend loop](weekend.md).
