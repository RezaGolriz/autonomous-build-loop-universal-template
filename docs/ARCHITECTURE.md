# Architecture

Universal Build Loop has one policy kernel and several replaceable interfaces.
The dependency direction is inward: adapters may call the control API, while
the contract and state machine do not depend on a host, language, framework, or
project layout.

~~~mermaid
flowchart TB
    subgraph Clients
        CX[Codex skill]
        CD[Claude Desktop extension]
        CLI[Node CLI]
        SH[Shell commands]
    end

    CX --> API
    CD --> MCP[Project-bound stdio MCP]
    MCP --> API[Dependency-free Node control API]
    CLI --> API
    SH --> SE[Shell orchestrator and reference engine]
    API --> SE

    CORE[Contract, workflow, schemas] --> API
    CFG[Profile and project adapter] --> API
    PM[Provider machine configuration] --> API
    TK[Per-user trust key<br/>outside project] --> API

    API --> JOB[Durable state and bounded jobs]
    SE --> EV[Evidence and review challenges]
    API --> HP[Host provider process]
    HP --> EV
    EV --> API
~~~

## Public control API

The module at control/index.mjs exports a shared dispatch function:

~~~js
await dispatch(root, operation, args)
~~~

The Node implementation has no third-party npm dependencies and requires
Node.js 22 or newer. The CLI and MCP server translate their input into this API;
they must not implement alternate gate logic. A caller supplies a bound project
root, an operation, and structured arguments. Results are structured and can be
rendered for people or returned as JSON.

The shell engine remains an equal supported path. The Node API delegates gate
mechanics to it while presenting stable chat, MCP, and CLI operations. Bash
3.2+, jq, Git, Perl, and standard Unix tools remain package runtime
dependencies. They are control-plane dependencies, not target-project
requirements.

## Project-bound MCP

The stdio server starts with one absolute root:

~~~bash
node bin/build-loop-mcp.mjs --root /absolute/path/to/project
~~~

LOOP_PROJECT_ROOT may supply the same fixed root. Every tool call is resolved
inside that root. Tool inputs do not accept a root override. This reduces
accidental cross-project actions and makes a reconnect recoverable from project
state.

The MCP transport exposes tools named `loop_<operation>`, plus the local
`loop_request_approval` confirmation flow. It does not own the workflow, decide a
gate, or accept a generic confirmation flag. Client display and tool naming may
differ, but all state-changing requests pass through the shared dispatch
boundary.

## Configuration boundaries

~~~mermaid
flowchart LR
    PR[Project profile<br/>evidence shape] --> PA[Project adapter<br/>target truth]
    RC[Repository conventions] --> PA
    PA --> RUN[Control run]
    MC[Machine provider config<br/>local executable and auth] --> RUN
    RUN --> RS[Generated runtime state<br/>jobs, locks, evidence]
~~~

The existing project adapter is configuration truth once activated. Discovery
may recommend a change, but it does not silently replace active configuration.
Provider machine configuration is separate because executable locations and
authentication are local facts. Generated runtime state is neither source
configuration nor an approval channel.

The configure operation signs provider machine configuration with a private
per-user HMAC key outside the target. Human approval receipts use the same local
trust store and are bound to the canonical project root and exact setup digest.
Copying a receipt or host configuration to another project root does not make it
trusted there. This binding detects project-local planting or editing; it does
not protect against another process that already has the same user's privileges.

Command declarations are structured argument vectors with a working directory,
timeout, evidence kinds, and environment-name allowlist. They are not shell
strings. Secret values never belong in an adapter or work item.

## Setup and activation

~~~mermaid
stateDiagram-v2
    [*] --> Inspected: inspect
    Inspected --> Proposed: prepare
    Proposed --> AwaitingApproval: request approval
    AwaitingApproval --> Proposed: correct proposal
    AwaitingApproval --> Probing: human approves bound view
    Probing --> Paused: positive passes and negative fails
    Probing --> PlanningOnly: verifier unavailable
    Probing --> Proposed: probe or schema fails
    Paused --> Running: start bounded work
~~~

prepare does not run target commands. Approval binds to the proposal and its
probes. Activation is a durable asynchronous job: callers poll until
job.operation is activate, job.status is COMPLETED, initialized is true,
state.run_status is PAUSED, and activation.valid is true. The job validates
strict configuration, then runs copied probes in a disposable target copy. The
negative probe must fail through the same
verification boundary. This demonstrates that the harness can observe a
failure; it does not prove the future implementation correct.

The disposable copy is isolation from the original target tree, not an
operating-system sandbox. Probe commands run with the current user's privileges
and can still access resources that user can access. Review commands before
approval and keep probes local, deterministic, and free of external effects.

The legacy bootstrap/init.sh follows the same safety intent but leaves
activation as a documented manual process. It writes paused candidate files and
never runs discovered project commands.

## Work execution

Each worker process receives one phase or execution slice. The engine owns
repository snapshots, command capture, path enforcement, evidence records, and
state transitions. A provider returns a normalized result; its success prose is
not evidence.

Review uses a fresh context. The reviewer receives the work-item contract, exact
durable delta, referenced evidence, and a one-time challenge. The engine checks
that the verdict matches the run, work item, revision, nonce, and evidence
references.

## Harness trust boundary

~~~mermaid
flowchart LR
    I[Approved project adapter] --> D[Disposable target copy]
    D --> P[Positive verifier]
    D --> N[Known-failing negative verifier]
    P -->|must pass| A{Activation gate}
    N -->|must fail| A
    S[Strict schema and path checks] --> A
    A -->|all conditions met| OK[Activated PAUSED state]
    A -->|missing or ambiguous| STOP[Blocked or planning only]
~~~

The negative control must be meaningful and safe. A command that fails before
reaching the intended verification boundary is weak evidence; a command that
can modify a real service or production device is unsafe. Project initialization
must select an appropriate disposable context.

## Durable state and jobs

Runtime state records phase, status, work item, gates, evidence references, and
limits. Long operations, including activation, receive a job ID and update
their durable status so a new chat can continue observing them.

Before and after every provider call, the runner snapshots its own control,
evidence, and lock metadata. A provider-time delta creates
`.loop/quarantine.json` with the affected paths and their exact prior records.
The engine blocks start, resume, and run while any recorded mismatch remains.
Exact restoration clears the quarantine under the orchestrator lock. Its fresh
owner record is checked against the current process and operation rather than
an old PID. Pause and cancel remain available when lock ownership is intact.

Legal execution statuses are PAUSED, RUNNING, BLOCKED, WAITING_FOR_HUMAN,
COMPLETED, and CANCELLED. Status does not change the canonical phase order.
Hand-editing state, job, lock, or evidence files does not create a valid
transition.

## Fail-closed invariants

- The phase order is DEFINE → DESIGN → EXECUTE → REVIEW → VALIDATE → HANDOVER.
- Review is fresh, independent, and mandatory.
- Validation uses profile-appropriate evidence.
- One worker invocation executes one bounded node.
- Unknown schema fields and unsupported versions fail validation.
- Undeclared writes and changes to frozen or protected paths fail the gate.
- Missing tools, evidence, capabilities, or authority block execution.
- Time, retry, and round caps cannot turn into success.
- Handover never grants delivery authority.

## Package boundary

Public entry-point documentation works from an installed package as well as a
source checkout. Source-only test suites, example fixtures, and Git history may
be absent from a package. Runtime code resolves bundled contract, workflow,
schema, host, and template assets relative to its own installation, while
--root always identifies the target project.

The distribution bundle includes a Claude Desktop .mcpb extension and a
self-contained Codex skills plugin. The Codex plugin can use its bundled CLI
without an MCP server; MCP is an explicit optional local configuration and does
not discover a project root automatically.

Implementation claims and tested environments are recorded separately in
[VALIDATION.md](VALIDATION.md).
