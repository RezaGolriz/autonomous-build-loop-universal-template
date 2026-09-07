# Dry run: try every kind of loop in five minutes, with no AI

**Example project:** none of the four recipes. This one uses the throwaway
`textkit` project the repository generates for you, plus the bundled **mock
provider** — a small script that answers like an agent without calling one.

**When to use this.** Use it before you point the loop at anything you care
about. It costs nothing, needs no API key and no signed-in CLI, and it lets you
watch all six phases, the gates, the evidence and the human decisions go past in
a couple of minutes. It is also the fastest way to find out that `jq` or `node`
is missing on your machine.

**What the mock is not.** The mock provider replays fixed answers. A passing mock
run is proof that *the loop* works on your machine. It is not proof that the
loop can build anything. Never use `mock` on a real project.

Everything below runs from the package root — the checkout you installed Build
Loop from — so nothing has to be installed globally first.

## 1. Make a throwaway project

```bash
cd /absolute/path/to/package-root
./bootstrap/check-prerequisites.sh
./bootstrap/make-trial-project.sh /tmp/textkit-trial
```

The generator prints the absolute path it created. The project is a tiny Python
package with one work item, WI-001, already activated for trial use. Real
projects go through `bootstrap/init.sh` and the activation checklist instead.

## 2. The goal loop: one item to HANDOVER

```bash
./engine/orchestrator.sh start --root /tmp/textkit-trial
./engine/orchestrator.sh loop --root /tmp/textkit-trial \
  --host mock --provider hosts/mock/provider.sh \
  --max-nodes 12
```

That is the whole goal loop: DEFINE, DESIGN, EXECUTE, REVIEW, VALIDATE,
HANDOVER. Read where it ended up:

```bash
node bin/build-loop.mjs check --root /tmp/textkit-trial --json
```

A finished mock run reports `"run_status": "WAITING_FOR_HUMAN"`, `"phase":
"HANDOVER"`, `"handover_ready": true` and `"judge_verdict": "PASS"`, with all
six gates `PASSED`. Look at the evidence ids in the gates — those are real
records under `.loop/evidence/`, written by the runner and not by the provider.

## 3. Two agents: a separate reviewer

The same run, with the reviewer named separately:

```bash
./engine/orchestrator.sh loop --root /tmp/textkit-trial \
  --host mock --provider hosts/mock/provider.sh \
  --review-host mock --review-provider hosts/mock/provider.sh \
  --max-nodes 12
```

With real providers those four arguments are how Codex builds and Claude
reviews, or the other way round — see [the two-agent
walkthrough](two-agents.md).

## 4. The backlog loop: a queue

```bash
node bin/build-loop.mjs backlog_add --root /tmp/textkit-trial \
  --input '{"id":"WI-010","title":"Document the slug rules","work_kind":"documentation","outcome":"One page describing what slugify does to punctuation, spacing and case."}'
node bin/build-loop.mjs backlog_list --root /tmp/textkit-trial --json
```

```json
{
  "ok": true,
  "backlog": {
    "ready": 0,
    "paused": 1,
    "items": [
      {
        "id": "WI-010",
        "title": "Document the slug rules",
        "work_kind": "documentation",
        "added_at": "2026-09-07T16:33:14Z",
        "authorization_state": "PAUSED",
        "authorization_expired": false,
        "authorization_invalid": false
      }
    ]
  }
}
```

`ready: 0` is the point: adding an item grants nothing.

## 5. The cadence loop: what a timer sees

```bash
node bin/build-loop.mjs tick --root /tmp/textkit-trial --json
```

With nothing authorized, every tick answers the same way, and then repeats the
whole `check` output:

```json
{
  "action": "nothing",
  "reason": "no-ready-authorization"
}
```

Authorize the queued item and the answer changes. Authorizing is a human
decision, so run it at a real terminal and type the word:

```bash
node bin/build-loop.mjs authorize --root /tmp/textkit-trial \
  --input '{"item_id":"WI-010","allowed_paths":["src","tests"],"max_rounds":12,"max_wall_seconds":900,"expires_in_seconds":3600}'
# Type AUTHORIZE to confirm: AUTHORIZE
```

The same call from a script or a chat tool call writes nothing. It returns a
pending request with a `confirmation_url` on a local page instead — try it and
see:

```bash
node bin/build-loop.mjs authorize --root /tmp/textkit-trial \
  --input '{"confirm":"AUTHORIZE","item_id":"WI-010","allowed_paths":["src","tests"]}' </dev/null
```

## 6. The scout loop: proposals with no agent

The mock provider answers the SCOUT phase with two fixed proposals, so you can
see the whole triage path without a model:

```bash
node bin/build-loop.mjs configure --root /tmp/textkit-trial \
  --input '{"host":"mock","review_host":"mock"}' --json
node bin/build-loop.mjs scout --root /tmp/textkit-trial \
  --input '{"provider":"mock"}' --json
node bin/build-loop.mjs inbox_list --root /tmp/textkit-trial --json
```

The two proposals are always "Cover the greeting helper with a regression test"
and "Resolve the open TODO markers in the source tree". Discard one and try to
promote the other:

```bash
node bin/build-loop.mjs discard --root /tmp/textkit-trial \
  --input '{"proposal_id":"P-…-2"}'
node bin/build-loop.mjs promote --root /tmp/textkit-trial \
  --input '{"proposal_id":"P-…-1","id":"WI-020","work_kind":"defect"}'
# Type PROMOTE to confirm: PROMOTE
```

Use the real proposal ids that `inbox_list` printed. `discard` completes
directly; `promote` asks for the word.

## 7. Stopping everything, and the dashboard

```bash
node bin/build-loop.mjs hold --root /tmp/textkit-trial \
  --input '{"reason":"Trying the hold out."}'
node bin/build-loop.mjs tick --root /tmp/textkit-trial --json   # refused: PROJECT_ON_HOLD
node bin/build-loop.mjs release --root /tmp/textkit-trial       # asks you to type RELEASE

./engine/render-dashboard.sh --root /tmp/textkit-trial
# writes /tmp/textkit-trial/.loop/dashboard.html — open it in a browser
```

## 8. Throw it away

```bash
rm -rf /tmp/textkit-trial
```

## What you check as the human

- **Every phase produced evidence.** Open `.loop/evidence/` and read a record.
  The gates are decided from those files, not from what the provider said about
  itself.
- **The mock never decided a gate.** It produces node output; the runner records
  the results and the reference engine decides. That separation is the thing
  worth seeing in a dry run.
- **The human decisions really did stop.** `authorize`, `promote`, `accept` and
  `release` all refuse to complete from a script. Watch one return a
  `confirmation_url` and write nothing.
- **Your machine has what it needs.** If a step fails here, it is a missing
  `jq`, `git`, `node`, `python3` or `shasum` — not a problem with your real
  project.

## What can never happen by itself

- **A mock pass is not a real pass.** The mock replays fixtures. It does not
  implement projects, and a green dry run says nothing about whether the loop
  can build your product.
- The human decisions are not relaxed for the mock. The same four words are
  required, through the same two routes.
- The trial project is generated pre-activated for convenience. That shortcut
  exists only here; a real project goes through prepare, a human approval link,
  and activation probes.

Back to the list: [all the walkthroughs](README.md).
