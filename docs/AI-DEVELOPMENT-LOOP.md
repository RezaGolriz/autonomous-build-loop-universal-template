# The AI development loop

## Purpose

This repository defines a shared development process for AI coding agents. The
same process can be applied to a Python CLI, Java service, Rust library, desktop
application, data project, documentation, or another project shape.

The repository exists because generating code is not the same as proving that
the result is correct, complete, safe, or authorized. It separates those
responsibilities.

## The three control roles

### 1. AI worker

Codex, Claude, or another compatible agent receives one bounded node. The node
declares its inputs, expected output, allowed paths, frozen paths, success
condition, retry cap, and escalation target. The agent produces an artifact and
stops. Its own statement that the work is complete is advisory.

### 2. Runner

The runner is outside the AI worker. It validates configuration, executes only
commands declared in the project adapter, captures output and hashes as
evidence, checks selected mutation boundaries, and validates independent review
verdicts. Only runner-owned evidence may advance state.

The included runner is a Bash, `jq`, Git, and Perl reference implementation for
Unix-like control hosts. These tools implement the control plane; they do not
dictate the target project's technology.

### 3. Human authority

A human activates candidate configuration, resolves decisions that the contract
cannot settle, and authorizes external effects. Autonomy changes how far
execution may continue between human checkpoints. It never grants permission to
merge, publish, release, deploy, access secrets, migrate data, or perform a
destructive action.

## One work item, step by step

```text
Human request
    |
    v
DEFINE -> DESIGN -> EXECUTE -> REVIEW -> VALIDATE -> HANDOVER
```

Findings from `REVIEW` or `VALIDATE` route by defect class: a requirement defect
returns to `DEFINE`, a design defect to `DESIGN`, and an artifact defect to
`EXECUTE`. Missing authority or an exhausted cap produces `BLOCKED`.

### DEFINE

The request becomes a testable work-item contract. Ambiguity, missing authority,
and decisions that materially change the result are surfaced before building.

### DESIGN

The agent defines boundaries, interfaces, risks, and independently provable
slices. A slice without deterministic proof does not pass the design gate.

### EXECUTE

The agent creates the current slice. The runner checks declared commands and
selected mutation boundaries. `EXECUTE` may repeat for additional declared
slices.

### REVIEW

The workflow requires an independent semantic verdict. The reviewer receives
the contract, exact durable change, applicable evidence, and project invariants.
The reference engine can issue a nonce-bound review challenge and reject stale,
replayed, malformed, or evidence-mismatched verdicts.

### VALIDATE

The runner requires the evidence types selected for the project. A CLI may need
behavior and installation evidence; an API may need contract evidence; a library
may need package and consumer-installation evidence; documentation may need link
and reference evidence.

### HANDOVER

The loop returns the revision, evidence index, limitations, and next authority
request to a human. Delivery begins only after handover and remains outside the
reference engine.

## Why review and validation are separate

Review asks whether the solution is sensible, scoped correctly, and consistent
with the contract. Validation asks whether declared, reproducible evidence
proves the acceptance criteria. A passing test command cannot replace semantic
review, and a confident review cannot replace executable evidence.

The worker that created an artifact never becomes the source of gate truth.
This is why evidence is captured by the runner and review is defined as an
independent context.

## Why the loop is technology neutral

The fixed core contains phase names, state transitions, evidence rules, and
authorization boundaries. It contains no Python-, Java-, Rust-, Node.js-, web-,
CLI-, or framework-specific behavior.

Technology-specific information is supplied as data:

- a profile describes the project shape and required evidence;
- a project adapter names languages, runtimes, commands, artifacts, and paths;
- a host adapter describes how an AI host can execute one bounded node;
- executor and version-control adapters provide replaceable capabilities.

Changing the programming language changes the adapter, not the development
process.

## Current implementation boundary

The reference implementation provides supervised initialization, strict schemas, test vectors,
command evidence capture, snapshots, selected path-policy enforcement, timeouts,
review challenges, and review-verdict validation. Its conformance fixtures cover
a Python CLI and a documentation-only project plus selected fail-closed cases.

`engine/orchestrator.sh` runs one work item through every phase: it starts a
fresh provider process for each node (and a separate one, optionally a
different agent, for review), hands every result to the reference engine, and
only the engine decides whether a gate passed. Providers for the Claude Code
CLI and the Codex CLI are included and have been exercised in real end-to-end
runs; see [ORCHESTRATOR.md](ORCHESTRATOR.md). Multiple work items and parallel
runs are not implemented yet.

## What a successful adoption provides

- one development vocabulary across projects and agent hosts;
- explicit, versioned, machine-readable state;
- bounded work instead of open-ended agent sessions;
- visible evidence instead of self-reported completion;
- mandatory review and validation;
- defect routing to the phase that owns the problem;
- clear human authority for external and irreversible actions.

It does not guarantee that software is good. It makes the path to that judgment
visible, repeatable, and auditable.
