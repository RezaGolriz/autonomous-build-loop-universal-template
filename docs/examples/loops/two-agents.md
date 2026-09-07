# Two agents: one builds, the other reviews

**Example project:** the [web app](../web-app.md) — a browser client with a
login form and a dashboard, checked with Vitest and Playwright.

**When to use this.** Use it when you want a second opinion on the work. One
provider writes the code, a different one reviews it. Two models rarely make the
exact same mistake, so a blind spot in one has a chance of being caught by the
other.

This is a plain [goal loop](goal.md). Only one thing changes: who reviews.

```text
Codex builds  →  Claude reviews  →  gates  →  HANDOVER  →  you accept
```

**A warning up front.** Two different names do not by themselves make a review
independent. What makes it independent is that the review starts in a fresh
context and has to answer the exact recorded change against the exact recorded
evidence. That is enforced whether you use one provider or two. Using two is a
bonus, not the safety mechanism.

## In chat

**1. Say who builds and who reviews.**

```text
Configure Codex as the builder and Claude as the independent reviewer for this
project. Then run doctor and tell me if either one is missing or not signed in.
Do not install anything and do not sign in for me.
```

*(calls `loop_configure` with `host` set to `codex` and `review_host` set to
`claude`, then `loop_doctor`)*

You can swap them — `host` `claude` and `review_host` `codex` — and it works the
same way. If only one provider is available, leave the reviewer out: the same
provider reviews in a fresh session, which still satisfies the requirement.

**2. Run the item normally.**

```text
Continue the current work item in bounded mode for at most 12 nodes, then show
me the check with the run status, the phase and the judge verdict.
```

*(calls `loop_run`, then `loop_check`)*

**3. Read the verdict and who wrote it.**

```text
Show me the REVIEW evidence for this run: the verdict, the reviewer that
recorded it, and every finding it raised. Do not accept anything yet.
```

*(calls `loop_status` and reads the evidence records)*

**4. Accept when you are satisfied.**

```text
I have read the handover and the review findings, and I accept it. Note:
reviewed locally, two providers, nothing deployed.
```

*(calls `loop_accept`, which returns a confirmation link. You open it, type
`ACCEPT` into the field and press the button.)*

## On the command line

With the Node control layer, `configure` stores both roles at once:

```bash
ROOT=/absolute/path/to/target-project

# Codex builds, Claude reviews.
build-loop configure --root "$ROOT" \
  --input '{"host":"codex","review_host":"claude"}' --json

# The other way round.
build-loop configure --root "$ROOT" \
  --input '{"host":"claude","review_host":"codex"}' --json

# Check that both are installed and authenticated.
build-loop doctor --root "$ROOT" --json
```

The reply names both roles:

```json
{
  "ok": true,
  "configured": true,
  "host": "codex",
  "provider_path": "/absolute/path/to/package-root/hosts/codex/provider.sh",
  "cli_path": "/usr/local/bin/codex",
  "review_host": "claude",
  "review_provider_path": "/absolute/path/to/package-root/hosts/claude/provider.sh",
  "review_cli_path": "/usr/local/bin/claude",
  "auth_check_configured": true,
  "review_auth_check_configured": true
}
```

`configure` also accepts `provider_path`, `cli_path`, `review_provider_path` and
`review_cli_path` when a CLI is not on your `PATH`. Everything after that is the
ordinary goal loop:

```bash
build-loop run --root "$ROOT" \
  --input '{"request_id":"web-app-2a-01","run_mode":"bounded","max_nodes":12}'
build-loop check --root "$ROOT" --json
build-loop accept --root "$ROOT"   # asks you to type ACCEPT
```

The Bash orchestrator takes the two roles as four arguments instead:

```bash
./engine/orchestrator.sh loop --root "$ROOT" \
  --host codex --provider hosts/codex/provider.sh \
  --review-host claude --review-provider hosts/claude/provider.sh \
  --max-nodes 12
```

## What you check as the human

- **The reviewer really is the other one.** Read the REVIEW evidence and look at
  the reviewer recorded in it. A configuration that silently fell back to one
  provider is easy to miss.
- **Both CLIs are signed in.** `doctor` reports each role separately. A reviewer
  that cannot start does not produce a softer verdict; it produces a failure.
- **The verdict, not the name.** `judge_verdict` has to be `PASS` and the
  VALIDATE gate has to have passed. A well-known reviewer name is not evidence.
- **Cost and time.** Two providers means two sets of calls per round. If a run
  is slow or expensive, this is where it comes from.
- **Findings that were waved away.** If the reviewer raised a blocking finding
  and a later round records it as resolved, read what actually changed.

## What can never happen by itself

- **The builder never reviews its own work in place.** Whether the reviewer is
  the same program in a fresh session or a different program entirely, the review
  gets a fresh context and a one-time challenge it has to answer.
- **Choosing a reviewer is not a shortcut.** Both providers run through the same
  six phases and the same gates. No combination unlocks a faster path.
- `configure` writes a machine-local, signed configuration. It installs nothing,
  signs in to nothing, and starts no run.
- Acceptance is still yours: the word `ACCEPT` typed at a terminal, or typed into
  the field on the local confirmation page.

Next: the smallest useful loop of all — [a bug fix](defect.md).
