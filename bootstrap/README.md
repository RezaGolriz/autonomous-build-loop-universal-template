# Project setup and activation

Project setup is supervised. Repository discovery may inform a proposal, but it
cannot decide which commands are authoritative or authorize those commands to
run.

## Recommended setup flow

Use the shared control API through chat or the Node CLI:

~~~bash
node bin/build-loop.mjs inspect --root /path/to/target --json
node bin/build-loop.mjs doctor --root /path/to/target --json
node bin/build-loop.mjs prepare --root /path/to/target \
  --input /path/to/prepare.json --json
~~~

inspect and prepare are read-only with respect to target execution. Preparation
may read bounded repository signals and active loop configuration; it must not
run a discovered project command.

The resulting confirmation view must show:

- selected project profile and detected target technologies;
- exact argv commands, working directories, and timeouts;
- artifacts and required evidence kinds;
- protected paths and allowed environment variable names;
- external-effect boundaries;
- builder and independent reviewer choices;
- a meaningful positive verifier and known-failing negative verifier.

Correct any proposal that does not match the target. Approval binds to this
displayed proposal and its probe plan. It is not a reusable approval for later
configurations.

~~~mermaid
flowchart LR
    I[Bounded inspection] --> P[Prepared proposal]
    P --> C[Local confirmation view]
    C -->|correct| P
    C -->|approve exact view| D[Disposable copy]
    D --> S[Strict schema checks]
    D --> POS[Positive probe]
    D --> NEG[Negative probe]
    S --> A{Activation gate}
    POS -->|pass| A
    NEG -->|expected failure| A
    A -->|all required checks| R[PAUSED active configuration]
    A -->|missing verifier| L[Planning only]
    A -->|other failure| B[Blocked]
~~~

Probe commands execute in a disposable copy, not the original target tree.
This is not an operating-system sandbox: commands retain the current user's
permissions. Approve only local, deterministic probes without deployment,
publication, migration, production-device, or other external effects.

A project with no meaningful verifier can still be inspected and planned. It
cannot be activated for execution until the verifier and negative control are
available.

Activation returns a durable job immediately. Poll status until job.operation is
activate, job.status is COMPLETED, initialized is true, state.run_status is
PAUSED, and activation.valid is true. Do not start the work item while the job
is QUEUED, RUNNING, or FAILED.

## Local approval view

The MCP server exposes a dedicated loop_request_approval tool with no arguments.
It opens a small local confirmation page for the prepared proposal. The page
binds the decision to the proposal and activation plan held by the control
engine; MCP callers do not pass confirmed=true and do not type or copy hashes.
The agent presents the returned local URL but must never fetch it or submit the
form. The human opens the page and presses Approve.

This protects against accidental or stale confirmation inside the normal tool
flow. It is not a tamper-proof boundary against another process running with the
same user's full privileges.

The resulting approval receipt is HMAC-signed with a private per-user key stored
outside the target project and bound to its canonical root. Do not copy the key
or a receipt into another project. See the
[configuration guide](../docs/CONFIGURATION.md#local-approval-and-host-trust) for
the default store and safe override.

## Legacy shell initializer

bootstrap/init.sh remains supported for existing shell workflows:

~~~bash
./bootstrap/check-prerequisites.sh
./bootstrap/init.sh /path/to/target
~~~

Before its interview, recommend.sh performs a bounded read-only scan of safe
file names and allowlisted manifest fields. It never executes a discovered
command. Ordinary suggestions may be accepted with Enter; inferred command
arrays require the literal USE-RECOMMENDED. Supported platforms and the
negative control remain manual.

The initializer writes only:

~~~text
.loop/candidate/
├── project.adapter.json
├── state.json
├── initialization.answers
├── initialization.provenance.json
└── ACTIVATION-CHECKLIST.md
~~~

State remains PAUSED. Existing candidates are not overwritten. The script
records environment variable names, never values, and does not copy candidates
to active names.

The template checkout must be clean because initialization binds the
initializer, recommendation helper, and shell engine to its Git revision.
Modified tracked files or untracked files stop this legacy setup.

## Manual activation for legacy candidates

Use ACTIVATION-CHECKLIST.md as the controlling document. At minimum:

1. confirm every interview answer and recommendation source;
2. validate the candidate against the strict schemas;
3. run the repository conformance suite;
4. copy the target to a disposable location;
5. prove the positive verifier passes in that copy;
6. prove the known-failing negative verifier fails through the same boundary;
7. smoke-test every enabled provider against the paused state;
8. pin the complete engine and protocol to an immutable revision;
9. materialize the candidate as active project configuration;
10. commit the baseline and start the first work item only after explicit human
    authorization.

Do not edit away a failed checklist item. Correct the candidate and repeat the
relevant checks.

## Required interview

The complete question set lives in
[template/INITIALIZATION.md](../template/INITIALIZATION.md). The human must
confirm project shape, target runtimes, tools, exact checks, supported
environments, artifacts, protected paths, environment variable names, and
external actions.

Never auto-detect and execute a command in the same step. A missing tool,
unknown schema version, placeholder, empty protected set, failed negative
control, provider mismatch, or ambiguous authority blocks activation.
