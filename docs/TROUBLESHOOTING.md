# Troubleshooting

Universal Build Loop fails closed: an ambiguous or unavailable prerequisite
becomes a diagnostic or blocker, never a silent pass.

## Configuration is missing

Run `inspect`, then `prepare`. Preparation may propose a profile and project
adapter, but it does not run target commands. Review every command, path,
artifact, evidence kind, environment variable name, and provider before
approval.

If the project has no meaningful verifier, keep it in planning mode. Add a
real check and a known-failing negative control before activation.

## Configuration is invalid

Read the returned schema path and field name. Unknown fields, unsupported schema
versions, placeholders, empty required collections, and unknown enum values are
errors. Fix the project-owned candidate; do not edit the workflow, schema, or
generated state to make it pass.

Run `doctor` again after correction. A project profile is advisory input and
does not prove that its resulting adapter is valid.

## The workspace is dirty

First identify whether the changes are expected user work, generated tool
output, or an interrupted build-loop job. Do not discard them.

- Commit or otherwise preserve intended baseline work before activation.
- Put repeatable build and test output in declared allowed paths.
- Pause the active job before changing configuration.
- If another process owns the workspace lock, inspect its job status rather
  than deleting the lock.

A clean control repository may be required to bind bootstrap provenance. The
target repository's allowed-change policy is checked independently.

## A required executable is missing

Use `doctor` to check the control runtime and configured provider. Check the
target runtime against the commands declared by the project adapter:

- control runtime: Node.js 22+, or the shell engine's Bash/`jq`/Git/Perl set;
- target runtime: separately verify the compiler, interpreter, browser, device
  tool, or service declared by the project adapter;
- provider runtime: a selected worker CLI plus its existing authentication.

Installing Claude Desktop does not authenticate Claude Code or Codex. Installing
the control package does not install target dependencies.

## A provider is not authenticated

Run the selected provider's own account check outside the loop and authenticate
it through that provider's documented flow. Then run configure again. For an
unchanged bundled provider discovered automatically, configure records a fixed
built-in status command and doctor verifies it against the signed configuration
before execution. Custom providers and explicit CLI wrappers remain
authentication unknown and doctor reports ready=false; arbitrary auth commands
are never executed. Do not put tokens, cookies, passwords, or API keys into
project configuration or a work-item file.

## A command timed out

The timeout is a failed or blocked check, not partial evidence of success.
Inspect captured stderr/stdout and determine whether the command is:

- legitimately longer than the declared bound;
- waiting for interactive input;
- downloading an undeclared dependency;
- waiting for a server, device, port, or network resource;
- hung because a previous process is still running.

Prefer deterministic, non-interactive verification commands. Increase a timeout
only after establishing a realistic bound; do not remove it.

## The negative control passed

Activation must stop. A passing negative control means the probe does not prove
that the verification boundary can reject a failure. Choose a safe command that
is expected to fail for a specific reason, run it in the same disposable-copy
boundary, and review its output before approving a new proposal.

## The job looks stale

Request status by job ID. Durable jobs are designed to survive a disconnected
chat, so an old timestamp alone does not prove abandonment. Check the recorded
process state, last update, lock owner, and timeout. Use the control operation
for pausing or recovery; do not hand-edit job files or delete locks.

Status includes the current heartbeat and any requested stop state. A requested
pause or cancellation appears as observed_status STOPPING until the current node
reaches its boundary. If an active lock is orphaned, invalid, or cannot be
proven to belong to the current job, the controller leaves it in place and
returns JOB_ACTIVE or JOB_RECOVERY_REQUIRED. It does not infer ownership from a
process ID, delete the lock, or start another worker automatically. Preserve the
logs and reported identifiers for administrator-assisted recovery of the exact
job. There is no automatic crash-recovery command in this release. Do not delete
locks based only on an old PID or a quiet chat session.

## A request ID conflicts

Every intended start, run, or resume launch needs a project-unique request_id.
Reuse an ID only for an exact retry with the same operation and max_nodes. The
controller returns REQUEST_ID_CONFLICT if either differs; choose a new ID after
confirming the old job through status.

## Runner-owned metadata is quarantined

A provider-time change under `.loop/control`, `.loop/evidence`,
`.loop/engine.lock`, or `.loop/orchestrator.lock` creates
`.loop/quarantine.json` and blocks start, resume, and run with exit 73. Inspect
changed_paths and expected without modifying the quarantine record. Restore
each existing path to the recorded kind, mode, and SHA-256 digest; remove a path
whose expected record is null. A following gated operation verifies the exact
restoration and removes quarantine automatically. A fresh orchestrator owner
record is verified against the current process and operation instead of an old
PID. Pause and cancel remain available when their lock ownership is intact.

If every changed path is an answer sidecar under `.loop/control/answers/`, use
the normal trusted answer operation for the selected blocker. It replaces the
unsafe sidecar with the bound answer and clears quarantine last. This exception
does not apply when any other runner-owned path changed. Do not delete
quarantine, locks, evidence, or control records to resume work.

## A cancelled run cannot create the next task

Cancellation preserves the work-item record and leaves canonical state as
CANCELLED. Call handover with a note acknowledging the cancellation. That local
acknowledgement changes state to COMPLETED without performing delivery, after
which task can create the next work item.

A run that is BLOCKED or PAUSED with no job in flight, for example one stuck at
its round cap, can be cancelled directly; cancel no longer requires a running
job. Pause still requires one.

## Restarting a cancelled work item under the same id

After a cancellation and its handover, task may create the work item again with
the same work_item_id. The old work item, the cancellation handover record and
any authorization are moved to `.loop/control/cancelled/<id>-<time>/`, never
deleted, so the new run needs a fresh authorization. Only a cancelled item can
be restarted this way; an item that ended with a completed handover keeps its
id, and task still answers WORK_ITEM_EXISTS.

## WALL_CAP_REACHED after a long wait

From version 0.5.0 on, time spent BLOCKED, PAUSED or waiting for a person is not
charged to max_wall_seconds. A run that was already waiting when the package
was updated has no `paused_epoch` yet, so its waiting time up to that moment
still counts; cancel it and start it again under the same id if its budget ran
out.

## Every start fails with DISTRIBUTION_CHANGED after a package update

The activation record binds the build-loop package files it was approved with.
After the package is updated, start, run, resume and task are refused with
DISTRIBUTION_CHANGED, and prepare is refused with ALREADY_INITIALIZED because
the project is already set up. Use rebind instead:

1. Make sure no run is RUNNING (pause or cancel it first).
2. Call rebind with a negative control that fails on the current project. It
   writes a re-activation candidate from the active adapter and workflow and
   lists the changed, added and removed package files.
3. Request approval. The local page shows the package change; the human
   approves it there.
4. Activate. The same disposable positive probes and the negative control run
   again. Only when they pass is the activation record rewritten; run state,
   work items, evidence, adapter and workflow stay as they were.

Rebind refuses when the package did not change (DISTRIBUTION_UNCHANGED), when
the active adapter or workflow no longer match the activation, and when the
bundled workflow itself changed (WORKFLOW_CHANGED); the last case needs a fresh
setup after the current work item ends.

## The chat disconnected

Reconnect the same project-bound MCP server or reopen the target in Codex. Ask
for project status and include the job ID. The new chat can inspect durable
state; it should not start a duplicate job just because it lacks the previous
conversation transcript.

## The project root is wrong

The MCP server is project-bound. Stop that connection and configure a separate
server for the intended absolute root. A tool call cannot change the bound root,
and relative paths are resolved within it.

## Claude Desktop can read files but cannot control the loop

A `CLAUDE.md` file supplies instructions only. Install or configure the local
MCP extension that starts `bin/build-loop-mcp.mjs --root /absolute/project`.
Then reconnect and verify that the build-loop tools are listed.

## Review is missing or not independent

Stop at `REVIEW`. A builder summary, test pass, same-context self-review, or
host attestation is not an independent verdict. Configure a fresh reviewer
context and pass it the exact contract, durable change, applicable evidence,
and review challenge. Never mark review not applicable.

## Validation passed but behavior is still uncertain

Check whether the configured evidence kinds and commands actually exercise the
acceptance criteria and target environment. A component test does not prove a
deployed service, a compilation does not prove device behavior, and a mock does
not prove a live integration. Record the limitation and add an appropriate
verifier in a newly reviewed configuration.

## Handover did not publish or deploy

That is expected. Handover reports the result and requests the next human
decision. Merge, publication, release, deployment, migration, destructive work,
secret access, and other external effects require separate scoped authority.
