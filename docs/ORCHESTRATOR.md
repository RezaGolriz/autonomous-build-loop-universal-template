# Operations, jobs, and state

All public clients call one shared control API. The Node CLI, project-bound MCP
server, Codex skill, and Claude Desktop extension adapt inputs and render
results; they do not decide gates.

## CLI form

~~~bash
node bin/build-loop.mjs OPERATION --root /absolute/project \
  --input /absolute/input.json --json
~~~

--root is always the target project. --input contains one JSON object and is
required by operations that need structured arguments. Results are JSON;
--json pretty prints them.

## Operations

| CLI operation | MCP tool | Purpose | Target commands |
|---|---|---|---|
| inspect | loop_inspect | Inventory bounded target facts and report adapter setup inputs | Never |
| doctor | loop_doctor | Check control and provider prerequisites and authentication status | No project commands; may run signed built-in CLI status checks |
| demo | loop_demo | Write a small docs or Python fixture with paused candidate configuration | Never |
| configure | loop_configure | Store machine-local builder and reviewer provider configuration | Never a substitute for approval |
| prepare | loop_prepare | Build a setup proposal and activation plan | Never |
| request-approval | loop_request_approval | Open the local bound confirmation view | Never |
| activate | loop_activate | Validate the approved proposal and run approved probes in a disposable copy | Approved probes only |
| task | loop_task | Create the next bounded work item after completion | Never by itself |
| start | loop_start | Create a durable bounded job from an activated state | May start authorized work |
| run | loop_run | Advance a bounded number of nodes | Declared project verifiers only |
| status | loop_status | Read project and job progress | Never |
| answer | loop_answer | Record one scoped response to a blocker | Never by itself |
| pause | loop_pause | Stop further job advancement while preserving state | No new commands |
| cancel | loop_cancel | Cancel continuation while preserving the audit record | No new commands |
| resume | loop_resume | Continue a resolved blocked or paused job within its existing authority | Declared project verifiers only |
| handover | loop_handover | Acknowledge a passed handover or cancellation and complete the local work item | Never grants delivery |

The MCP server also exposes loop_request_approval as a special no-argument tool.
The CLI spelling contains a hyphen; MCP operation tool names use underscores
only where required by the client protocol.

The CLI also has an interactive-only approve alternative. It displays the
project, request, scope, and setup digest in a real TTY and requires the human
to type the literal APPROVE. It does not ask the human to copy a digest. There
is no MCP approve tool, and an agent must never answer the TTY prompt.

## Input expectations

inspect, doctor, activate, pause, cancel, and request-approval use an empty
object. The CLI can omit --input for them.

demo, configure, prepare, task, start, run, answer, resume, and handover take
structured JSON input. Keep these files outside generated evidence and free of
secrets. The accepted operation inputs are:

| Operation | Required fields | Optional fields |
|---|---|---|
| demo | kind: docs or python | — |
| configure | host | provider_path, cli_path, review_host, review_provider_path, review_cli_path |
| prepare | request, acceptance_criteria, out_of_scope, allowed_paths, negative_control | frozen_paths, adapter, adapter_overrides, work_item_id, max_rounds, max_gate_failures, max_wall_seconds, autonomy, replace_candidate |
| task | request, acceptance_criteria, out_of_scope, allowed_paths | frozen_paths, work_item_id |
| start, run, resume | request_id, max_nodes | — |
| answer | answer and exactly one of blocker_id or blocker_index | — |
| handover | note | — |

configure accepts codex, claude, or mock as host values. With only host set, the
provider path uses the bundled wrapper for that host, the reviewer host defaults
to the builder host, the review provider uses its bundled wrapper, and the CLI
is resolved to an absolute path from the effective PATH and known local binary
directories. cli_path and review_cli_path select absolute executable paths when
automatic discovery is insufficient. Provider paths are machine-local
configuration. Use the operation's returned validation error rather than
guessing an unknown field: the public input boundary rejects unsupported fields.

For unchanged bundled providers found automatically, configure records one
fixed status check: `codex login status` or `claude auth status`, with the
resolved executable path, a 15-second timeout, and expected exit code zero. The
signed host configuration binds that exact check. doctor verifies the signature
and exact built-in command before executing it and never returns its output.
Custom providers and explicit CLI wrappers remain authentication unknown, so
doctor reports ready=false. configure does not accept an arbitrary auth command.

negative_control contains argv, cwd, timeout_seconds, expected_exit_code, and
expected_output. expected_output declares stream (stdout, stderr, or combined),
match (equals, includes, or regex), and value.

Start, run, and resume use a request ID and an explicit maximum-node bound. Use
a new project-unique request ID for every intended launch. Reuse an ID only to
retry the same operation with the same max_nodes; a different operation or bound
returns REQUEST_ID_CONFLICT instead of silently selecting the old job.

Example bounded request:

~~~json
{
  "request_id": "request-001",
  "max_nodes": 8
}
~~~

## Preparation and activation

Preparation is a plan, not execution. It assembles the current repository
observations, existing adapter if present, proposed changes, provider choices,
and activation probes. It may report that a project is suitable only for
planning when no meaningful verifier exists.

request-approval opens the local confirmation page for the currently prepared
proposal. The user reviews that concrete view. The operation does not accept a
confirmation boolean or typed hash. Its result contains confirmation_url,
setup_digest, and expires_at so a client can display the URL and expiry while
keeping the digest out of the user's manual workflow.

activate checks the bound approval and returns immediately with a durable job.
That asynchronous job validates configuration, creates a disposable target
copy, and runs the approved positive and negative probes. Poll status until
job.operation is activate, job.status is COMPLETED, initialized is true,
state.run_status is PAUSED, and activation.valid is true. A failed job may
include activation_result and last_error. The positive probe must pass and the
known-failing negative probe must fail through the same verification boundary.

The disposable copy is not an OS sandbox. Probe commands retain the current
user's privileges, so the approval view must make every command visible.

## Bounded asynchronous jobs

~~~mermaid
stateDiagram-v2
    [*] --> QUEUED: start, run, or resume creates a job
    QUEUED --> RUNNING: worker begins
    RUNNING --> STOPPING: durable pause or cancel intent observed
    STOPPING --> PAUSED: pause takes effect at node boundary
    STOPPING --> CANCELLED: cancel takes effect at node boundary
    RUNNING --> COMPLETED: bounded process stops normally
    RUNNING --> FAILED: control process fails
    PAUSED --> [*]
    COMPLETED --> [*]
    FAILED --> [*]
    CANCELLED --> [*]
~~~

A start, run, or resume request returns idempotent and a durable job object. Job
fields include job_id, request_id, operation, status, desired_status, max_nodes,
nodes_completed, timestamps, process ID, exit code, and last error. Job status
is one of QUEUED, RUNNING, PAUSED, CANCELLED, COMPLETED, or FAILED. While a
durable stop intent waits for the current node boundary, status overlays
requested_status, observed_status as STOPPING, and heartbeat_at. The persisted
job then becomes PAUSED or CANCELLED at the boundary.

Status returns initialized, the canonical .loop/state.json value, the current
job, open blockers with stable blocker IDs and one-based indexes, and activation
state. It can be inspected after the originating process or chat disconnects. A
reconnect should read existing state before starting new work.

The job record and workflow state serve different purposes. Job status describes
the bounded control process. Workflow state records the work item's phase,
gates, evidence, and legal transitions. A COMPLETED job may have stopped because
the workflow became BLOCKED or WAITING_FOR_HUMAN; inspect canonical state. A
completed process is not by itself proof that a gate passed.

## Blockers

A blocker identifies the missing decision, capability, evidence, or authority
and the phase to resume. Answer records one scoped human response. Resume checks
that all blockers are resolved, creates a new job with the supplied max_nodes,
and preserves the work item's original wall-clock, round, and retry caps.

Pause and cancel requests write a fenced control intent outside the target and
take effect after the current bounded build node finishes; they do not interrupt
a verifier in the middle of its evidence capture. The lock token and control
record are not sent to providers. Activation probes cannot be paused or
cancelled through these operations; the API returns ACTIVATION_NOT_STOPPABLE.

Do not edit blockers, state, jobs, locks, or evidence files directly. A free-form
chat message is context until it is recorded through the blocker operation.

## Runner metadata quarantine

The engine snapshots runner-owned `.loop/control`, `.loop/evidence`,
`.loop/engine.lock`, and `.loop/orchestrator.lock` paths across every provider
call. If any exact path or descendant changes, the run becomes BLOCKED and the
engine writes `.loop/quarantine.json`. Its strict record identifies the work
item, phase, run, detection time, sorted changed paths, and each path's prior
file or symbolic-link record. A null prior record means the path did not exist.

While any recorded path differs, shell start, resume, and run exit 73 under the
orchestrator lock; loop inherits the refusal from run. Restore every path to its
recorded kind, mode, and digest, or remove an unexpected path whose prior record
is null. The next gated operation verifies the restoration and removes the
quarantine. Do not edit or delete the quarantine file to force progress. Pause
and cancel remain available when the corresponding lock ownership is intact.

The transient orchestrator owner record is the one exception to restoring old
bytes: a later operation creates a fresh lock. The engine accepts that record
only after verifying its exact schema, current process, operation, and timestamp.
It never revives an old PID. All other quarantined records remain bound to their
prior kind, mode, and digest.

There is one narrow recovery through the trusted answer operation. If every
changed path is a safe `.loop/control/answers/<answer-id>.json` sidecar, answer
can remove or replace those paths, write the normal UTF-8 answer with its SHA-256
binding, and remove the quarantine last under the same lock. Mixed changes or
damage anywhere else require exact restoration; an answer cannot bypass them.

## What the shell orchestrator does

engine/orchestrator.sh remains the direct Unix interface for the canonical
workflow:

| Mode | Behavior |
|---|---|
| start --root DIR | Moves a valid PAUSED project to RUNNING |
| status --root DIR | Prints phase, status, gates, transitions, blockers, and recent evidence |
| next --root DIR --host ID | Builds the current node brief without calling a provider |
| run --root DIR --host ID --provider EXE | Runs exactly one node and submits its result to the reference engine |
| loop ... --max-nodes N | Repeats bounded nodes until handover, blocker, failure, or the node cap |
| resume --root DIR | Continues after every recorded blocker is resolved |

Required target files live under .loop/: state.json, project.adapter.json,
workflow.json, and `work-items/<work-item-id>.md`. Evidence and provider logs are
runner-owned.

During DEFINE, DESIGN, and HANDOVER, the provider edits the work item. During
EXECUTE it edits one slice and the engine runs the declared checks. REVIEW uses
a fresh provider process and nonce-bound verdict. VALIDATE reruns the required
acceptance and regression evidence. The engine alone performs legal
transitions.

## Provider failures

Provider invocation errors, malformed JSON, authentication failures, unknown
results, stale verdicts, evidence mismatch, or nonzero transport exits are
failures. A provider may return BLOCKED with a concrete reason; it cannot turn
an unavailable check into DONE.

## Handover

Handover includes the final revision, evidence references, review verdict,
limitations, and requested next decision. It leaves the project waiting for a
human. Delivery actions remain separate and require their own authority.

Cancellation also requires a local handover acknowledgement. Wait until the job
and canonical state are CANCELLED, then call handover with a note describing the
cancellation decision. Handover records a cancellation acknowledgement and
moves the work item to COMPLETED without performing delivery. Only then can task
create the next work item.

See [Troubleshooting](TROUBLESHOOTING.md) for dirty workspaces, missing tools,
timeouts, stale jobs, and reconnect behavior.
