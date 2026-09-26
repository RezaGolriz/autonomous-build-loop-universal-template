# Operations, jobs, and state

All public clients call one shared control API. The Node CLI, project-bound MCP
server, Codex skill, and Claude Desktop extension adapt inputs and render
results; they do not decide gates.

The detailed [shell orchestrator guide](SHELL-ORCHESTRATOR.md) remains available.
See also [loop selection](LOOP-MODES.md) and [dashboard access](DASHBOARD.md).

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
| options | loop_options | List work kinds and run modes | Never |
| dashboard | loop_dashboard | Return a read-only local browser dashboard URL | Never |
| inspect | loop_inspect | Inventory bounded target facts and report adapter setup inputs | Never |
| doctor | loop_doctor | Check control and provider prerequisites and authentication status | No project commands; may run signed built-in CLI status checks |
| demo | loop_demo | Write a small docs or Python fixture with paused candidate configuration | Never |
| configure | loop_configure | Store machine-local builder and reviewer provider configuration | Never a substitute for approval |
| prepare | loop_prepare | Build a setup proposal and activation plan | Never |
| request-approval | loop_request_approval | Open the local bound confirmation view | Never |
| activate | loop_activate | Validate the approved proposal and run approved probes in a disposable copy | Approved probes only |
| task | loop_task | Create the next bounded work item after completion | Never by itself; refused with PROJECT_ON_HOLD while the project is on hold |
| start | loop_start | Create a durable bounded job from an activated state | May start authorized work; refused with AUTHORIZATION_REVOKED while the item's authorization is PAUSED |
| run | loop_run | Advance a bounded number of nodes | Declared project verifiers only; refused with AUTHORIZATION_REVOKED while the item's authorization is PAUSED |
| chat_next | loop_chat_next | Chat-hosted execution (host chat): start or continue the run for one node, through the same checks as run, and return the waiting node's brief; the same brief again while it waits | Declared project verifiers only, run by the engine after the node; refused wherever run is refused |
| chat_submit | loop_chat_submit | Hand the chat sub-agent's result or verdict for the waiting node to the engine, once; refused as CHAT_NODE_UNKNOWN, CHAT_NODE_ALREADY_SUBMITTED or CHAT_NODE_STALE otherwise; returns the gate result and whether another node waits | Declared project verifiers only, run by the engine |
| status | loop_status | Read project and job progress | Never |
| answer | loop_answer | Record one scoped response to a blocker | Never by itself |
| pause | loop_pause | Stop further job advancement while preserving state | No new commands |
| cancel | loop_cancel | Cancel continuation while preserving the audit record | No new commands |
| resume | loop_resume | Continue a resolved blocked or paused job within its existing authority | Declared project verifiers only; refused with AUTHORIZATION_REVOKED while the item's authorization is PAUSED |
| handover | loop_handover | Acknowledge a passed handover or cancellation and complete the local work item | Never grants delivery |
| check | loop_check | Report run status, phase, handover readiness, review verdict, gates, blockers, and backlog and inbox counts | Never; it changes nothing |
| tick | loop_tick | One cadence step: report, advance one node, or start an item a person already authorized as READY | May advance already authorized work; never grants approval, and stops when that authorization is revoked, expired or invalid |
| backlog_add | loop_backlog_add | Write a work item from the template and append it to the ordered backlog | Never; it starts nothing |
| backlog_list | loop_backlog_list | List the ordered backlog with the authorization state of each item | Never |
| backlog_remove | loop_backlog_remove | Remove one entry from the ordered backlog and keep its files | Never |
| accept | loop_accept | Human-only: archive an accepted run to local history and promote the next backlog item. From MCP it returns a confirmation link instead of completing | Never grants delivery |
| authorize | loop_authorize | Human-only: record scope, budget, and expiry so an item may start when its slot comes. From MCP it returns a confirmation link instead of completing | Never starts a run by itself |
| deauthorize | loop_deauthorize | Set the authorization of an item back to PAUSED and place a project-wide hold | Never |
| hold | loop_hold | Stop everything in this project now: while the hold is on, start, run, resume, tick, task and scout are refused with PROJECT_ON_HOLD for every caller that is not a person at an interactive terminal | Never; it takes authority away |
| release | loop_release | Human-only: take the project-wide hold off. From MCP it returns a confirmation link instead of completing | Never starts anything |
| scout | loop_scout | Look for work in a disposable copy of the project and write inert proposals into the inbox | Only a bundled read-only provider wrapper; never the project itself |
| inbox_list | loop_inbox_list | List the scout proposals waiting for a person | Never |
| promote | loop_promote | Human-only: move one inbox proposal into the backlog as a work item. From MCP it returns a confirmation link instead of completing | Never; it starts nothing |
| discard | loop_discard | Drop one proposal from the inbox and keep its file under discarded | Never |

The MCP server also exposes loop_request_approval as a special no-argument tool.
The CLI spelling contains a hyphen; MCP operation tool names use underscores
only where required by the client protocol.

accept, authorize, promote and release are human decisions, and only a person
may complete one. At an interactive terminal they ask for the literal word
ACCEPT, AUTHORIZE, PROMOTE or RELEASE, and the typed word completes the
decision; the record keeps the channel `interactive-tty`.

Placing a hold is the opposite direction and needs no confirmation at all: any
channel may call hold, and deauthorize places one by itself. While
`.loop/control/hold.json` exists, start, run, resume, tick, task and scout are
refused with PROJECT_ON_HOLD from every channel except a person at an
interactive terminal; cancel, handover and every read-only operation keep
working. The Bash orchestrator applies the same rule to start, run and loop, and
prints a warning line even for the person it lets through.

Every other transport — an input file on the command line, or an MCP tool call —
cannot complete such a decision, whatever word it passes. The call returns
`{"ok": true, "pending_confirmation": true, "confirmation_url": "http://127.0.0.1:…"}`
instead: a local page, bound to that one operation, that one item and the fully
resolved decision frozen at that moment — the exact authorization record that
would be written, the run and its HANDOVER evidence for an acceptance, the sha256
of the proposal text for a promotion. The page displays that frozen decision and
asks the person to type the word into a field, which the server checks together
with the single-use token. Nothing is written until then. The receipt is signed
by the local host over the request id and a digest of the frozen request, the
operation is carried out, and the record keeps the channel `local-http-user` with
the assurance `local-user-action`. A model must hand that link to the person and
never open it itself. The request expires after fifteen minutes, and repeating
the same call returns the same link rather than a second one.

Before the decision is carried out, the digest is recomputed from the frozen
request on disk, the request is claimed by an atomic rename so two settlements
cannot run it twice, and the runner re-checks the live item under the lock that
does the work. Anything that changed is refused with `CONFIRMATION_STALE` and the
request is discarded.

Assurance is `local-user-action` for both routes: a person with access to this
machine typed the word. The page is served on loopback, so an agent with shell
access on the same computer could in principle open it. A project that needs more
writes `.loop/control/policy.json` by hand with
`{"schema_version": 1, "human_confirmation": "tty-only"}`; accept, authorize and
promote from an input file or a tool call are then refused with
`CONFIRMATION_TTY_ONLY` and the exact terminal command, which carries every
argument through `--input` so nothing has to be retyped and nothing falls back
to the current item. Anything still pending on a page is discarded, and a policy
file that does not match its schema is refused with `INVALID_POLICY` rather than
defaulting; while it is broken only the terminal decides, and `status`, `check`
and both dashboards name the error. No operation writes that file.

If the confirmation page is closed before the operation ran, the receipt it left
is settled by the next accept, authorize, promote or tick call.

An authorization record that does not validate is invalid rather than absent:
status and check report its state as INVALID, nothing starts from it, and a
person has to write it again. A record in state PAUSED is a withdrawn decision
rather than an absent one: start, run and resume are refused with
AUTHORIZATION_REVOKED unless a person is doing it at their own terminal. That includes a record whose `item_id` is not the
item whose sidecar it is: a decision applies only to the item it names, so a
record copied into another item's sidecar authorizes nothing there. A scout runs only a bundled provider wrapper —
the one shipped for that host, or the one configure generated around it — and
there is no input field for naming another executable.

The CLI also has an interactive-only approve alternative. It displays the
project, request, scope, and setup digest in a real TTY and requires the human
to type the literal APPROVE. It does not ask the human to copy a digest. There
is no MCP approve tool, and an agent must never answer the TTY prompt.

## Input expectations

inspect, options, dashboard, doctor, activate, pause, cancel, check,
backlog_list, inbox_list, and request-approval use an empty object. The CLI can omit --input
for them. check exits with 0 when a handover is waiting or the run is finished,
3 while the run is not done, 4 when it is blocked, and 2 on an error.

tick takes an optional `max_nodes` between 1 and 500, default 1, and can be
called without input. It exits 0 whatever the loop turned out to be doing, and 2
only when the operation itself failed, so a scheduler treats a quiet project and
a busy one alike. Its result carries `action` (`ran-node`, `started`,
`reported`, or `nothing`), `reason`, and the full check output. `--input`
normally names a JSON file; a value that already starts with `{` is read as the
JSON object itself, which keeps a scheduled one-liner readable:

~~~bash
build-loop tick --root /absolute/project --input '{"max_nodes":1}'
~~~

demo, configure, prepare, task, start, run, answer, resume, handover,
backlog_add, backlog_remove, accept, authorize, deauthorize, hold, release,
scout, promote, and discard take structured JSON input. Keep these files outside generated evidence and free of
secrets. The accepted operation inputs are:

| Operation | Required fields | Optional fields |
|---|---|---|
| demo | kind: docs or python | — |
| configure | host (codex, claude, mock or chat) | provider_path, cli_path, review_host, review_provider_path, review_cli_path |
| chat_next | — | — |
| chat_submit | node_id, result | — |
| prepare | request, acceptance_criteria, out_of_scope, allowed_paths, negative_control | frozen_paths, adapter, adapter_overrides, work_item_id, max_rounds, max_gate_failures, max_wall_seconds, autonomy, replace_candidate |
| task | request, acceptance_criteria, out_of_scope, allowed_paths | frozen_paths, work_item_id |
| start, run, resume | request_id and either run_mode or max_nodes | explicit max_nodes with bounded mode |
| answer | answer and exactly one of blocker_id or blocker_index | — |
| handover | note | — |
| backlog_add | title, outcome | id, work_kind |
| backlog_remove | id | — |
| accept | confirm: ACCEPT | note |
| authorize | confirm: AUTHORIZE, and allowed_paths the first time an item is authorized | item_id, max_rounds, max_wall_seconds, expires_in_seconds, stop_on_first_failure, note |
| deauthorize | — | item_id |
| hold | — | reason, item_id |
| release | confirm: RELEASE | — |
| tick | — | max_nodes |
| scout | — | provider, profile, work_kind |
| promote | proposal_id | id, work_kind |
| discard | proposal_id | — |

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

| File | Written by | Read by | Meaning |
|---|---|---|---|
| .loop/notes/next-steps.md | run mode, after the HANDOVER gate and its evidence are recorded | the next DEFINE brief, every scout brief | Advisory memory between cycles: summary, three priorities, suggested next item, evidence references. It approves nothing and widens no scope. `accept` copies it into history and leaves the live note in place. |

During DEFINE, DESIGN, and HANDOVER, the provider edits the work item. During
EXECUTE it edits one slice and the engine runs the declared checks.

When the current work item has a valid READY authorization sidecar, that
authorization is an outer boundary on paths and on the budget, in addition to
the slice table and the protected paths. `start`, `resume` and every `run` node
apply the smaller of the recorded caps and the authorized `budget` to
`max_rounds` and `max_wall_seconds` in `state.json` — the same rule the control
layer applies, so the caps only ever move down and rounds already used and time
already spent are never reset. After DESIGN, every path the slice table declares has to be
covered by `scope.allowed_paths`, or the DESIGN gate fails with "slice path
outside authorized scope". After an EXECUTE or VALIDATE node, every changed path
outside `.loop/` has to be covered as well, or the run is BLOCKED with orchestrator
evidence naming the path. A slice may narrow the authorized scope; it can never
reach outside it.

A sidecar in state PAUSED is a withdrawn decision, and the orchestrator treats it
the way the control layer does: `start`, `resume` and `run` are refused with
`AUTHORIZATION_REVOKED` and exit 77, and nothing about the run is changed. Only a
person may proceed — standard input has to be a terminal, or the invocation has
to be a managed job whose human entry the control layer recorded in
`.loop/control/current-job.json` for exactly this job and item. The record still
bounds that run: its `scope.allowed_paths` are enforced as usual and its budget
only narrows the caps. Where no pseudo-terminal can be provided,
`BUILD_LOOP_HUMAN_TTY=1` stands in for the terminal check; it is refused whenever
a managed job is in play, and the Node worker strips the name from the
environment it passes down. Every sidecar is validated in full whatever state it
claims, so a PAUSED record that does not validate is broken rather than inert and
blocks the run like any other broken record. A work item with no sidecar at all
is a manual item, unchanged in every respect. REVIEW uses
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

## Select work and execution mode

`prepare` and `task` accept optional `work_kind`: `feature` (default),
`defect`, `maintenance`, `documentation`, `research`, or `migration`.
The generated work item records the kind and its review focus.

`start`, `run`, and `resume` accept `run_mode: "step"` (one node) or
`run_mode: "bounded"` (12 nodes by default). Explicit `max_nodes` remains
supported; `step` rejects any value other than 1. A mode or `max_nodes`
is required. Both modes retain the original time, retry, and round limits.
