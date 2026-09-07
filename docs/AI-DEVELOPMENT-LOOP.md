# The AI development loop

Generating a change and establishing that the change is acceptable are separate
jobs. Universal Build Loop keeps them separate with three control roles.

## Worker, control engine, and human

The worker receives one bounded node. Its inputs name the expected artifact,
allowed and frozen paths, success condition, retry cap, and escalation target.
The worker can edit the target only within that scope. Its statement that the
work is complete is useful context, but it is not gate evidence.

The control engine validates configuration, runs only declared commands,
captures their results, checks repository changes, owns durable state
transitions, and validates review verdicts. The Node API, CLI, MCP server, and
shell scripts are interfaces around this role. An MCP tool does not become a
second policy engine.

The human owns activation, missing decisions, and authority for external
effects. Autonomy determines how many already authorized steps may continue
without interruption. It does not grant publication, deployment, migration,
destructive operations, or secret access.

## One work item

### DEFINE

The request becomes a testable contract. The work item records outcomes,
acceptance criteria, exclusions, and invariants. A material ambiguity becomes a
blocker before implementation begins.

### DESIGN

The solution is split into slices with explicit path boundaries and deterministic
proof. A proposed slice that cannot be verified is incomplete design.

### EXECUTE

One slice is implemented. The engine checks the configured commands and file
policy. Additional slices repeat EXECUTE; they do not skip directly to
validation.

### REVIEW

A fresh independent context receives the exact contract, durable change,
applicable evidence, and review challenge. It does not receive the builder's
private reasoning as proof. The engine rejects a stale, replayed, malformed, or
evidence-mismatched verdict.

### VALIDATE

The engine requires the evidence kinds selected for the project. A library may
need package and consumer-install evidence; an API may need interface-contract
and behavior evidence; documentation may need reference and link checks. The
profile describes evidence needs without prescribing a language or framework.

### HANDOVER

The loop reports the revision, evidence index, limitations, and next decision.
It then waits for a human. A successful handover is not an instruction to merge
or ship.

## Why review is always present

Executable checks can prove observable facts but can still encode the wrong
requirement, miss a risk, or validate only a narrow environment. Semantic review
can find those problems but cannot substitute for repeatable command evidence.
Keeping both gates prevents the builder from turning its own implementation,
tests, and explanation into a circular proof.

When review finds a defect, the verdict routes it to the phase that owns it:

~~~mermaid
flowchart TD
    R[Review finding] --> K{Defect class}
    K -->|requirement| D[DEFINE]
    K -->|design| G[DESIGN]
    K -->|artifact| E[EXECUTE]
    K -->|missing authority or capability| B[BLOCKED]
~~~

## Why preparation is supervised

Repository discovery can identify manifests and suggest commands, but it cannot
know whether a command is authoritative, safe, or complete. Preparation
therefore separates observation from authority:

1. inspect bounded repository signals;
2. propose configuration without running target commands;
3. show one concrete confirmation view;
4. bind approval to that proposal;
5. run positive and known-failing negative probes in a disposable copy;
6. activate only when strict checks pass.

Without a meaningful verifier, planning remains available while execution stays
disabled.

## Why jobs survive chats

A conversation is not a reliable process boundary. Desktop apps close, network
connections drop, and a user may continue in a fresh chat. Bounded work
therefore receives a durable job ID. The engine records status independently of
the chat, enforces time and retry limits, and allows a later client to inspect
the same job instead of creating a duplicate.

Durability is not permission to run forever. A cap, stale process, missing
decision, or invalid state blocks the job.

## Technology neutrality

The kernel contains workflow order, evidence rules, transition rules, and
authority boundaries. Technology stays in adapters:

- the profile describes the project shape and evidence requirements;
- the project adapter names languages, runtimes, commands, artifacts, and
  repository paths;
- provider machine configuration identifies local worker executables;
- host adapters normalize one worker or reviewer invocation.

Changing Python to Rust, or Claude Code to Codex, does not change the phase
graph. It changes the data supplied to the same gates.

## What the loop can establish

The strength of a conclusion is bounded by the recorded evidence. A passing
fixture proves that fixture. A browser mock does not prove a live integration.
A firmware build does not prove behavior on production hardware. A successful
provider smoke test does not prove every provider version or platform.

[VALIDATION.md](VALIDATION.md) provides a matrix for stating those boundaries
without turning design requirements into untested product claims.
