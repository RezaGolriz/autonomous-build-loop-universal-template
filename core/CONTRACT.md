# Universal build-loop contract

## Scope

This document is the normative contract for a conforming engine, not a claim
that every requirement is implemented by the version 0.1.0 reference shell.
The kernel advances one bounded work item through a fixed workflow. It is
independent of target language, runtime, framework, artifact type, user
interface, operating environment, version-control provider, and agent host.

## Node contract

Every node declares and validates:

- trigger and bounded task;
- actor capability, never a stack-specific role name;
- input and output artifacts;
- allowed, frozen, and protected paths;
- binary success condition and verifier;
- retry cap and escalation target.

Undeclared writes, missing outputs, invalid state, unknown configuration fields,
or unavailable mandatory verifiers fail closed.

## Evidence

Workers produce artifacts; they do not certify their own work. The runner owns
command capture and state transitions. Semantic review runs in a separate fresh
context and receives the work-item contract, exact durable change, applicable
evidence, and project invariants.

Evidence records identify their producer, revision, environment, time, type,
result, and artifacts. A claim without a valid evidence record is advisory.

`REVIEW` is mandatory for every work item. `VALIDATE` is also mandatory, but its
required evidence kinds come from the selected project profile. Evidence marked
not applicable is accepted only where both the schema and profile explicitly
allow it; review never allows it.

## Immutability and authorization

Acceptance criteria and out-of-scope clauses are frozen from `EXECUTE` through
`VALIDATE`. Gate configuration, workflow definitions, policies, prior evidence,
and runner code are protected from product workers. A requirement defect routes
to `DEFINE`; a design defect routes to `DESIGN`; an artifact defect routes to
`EXECUTE`.

Merge, publication, release, deployment, migration, destructive operations,
secret access, and other external-state changes require explicit scoped human
authority. Autonomy changes continuation boundaries only; it never grants new
actions or weakens gates.

The version 0.1.0 reference engine owns local verification, evidence capture, write-policy
checks, and review-verdict binding. It does not execute delivery actions.

## Brakes

A conforming workflow runner enforces configured round, retry, and wall-clock caps; exclusive
workspace mutation; one node per fresh context; and blockers for missing or
unsafe decisions. Reaching a cap is `BLOCKED`, never success.

The version 0.1.0 Bash reference engine currently implements command evidence,
selected path-policy checks, snapshots, review challenges, verdict validation,
and evidence-backed validation of legal state transitions. It does not yet
orchestrate this complete state machine or fresh agent contexts.
