---
name: build-loop
description: Use the Universal Build Loop to inspect, configure, run, resume, and hand over bounded AI-assisted work in the current project.
---

# Universal Build Loop

Use the bundled dependency-free Node CLI as the default control interface.
Resolve the absolute location of this SKILL.md, then walk upward to the nearest
directory containing bin/build-loop.mjs. Invoke that file by its absolute path;
do not assume the target repository contains the control package. This works
from the source path .agents/skills/build-loop and from the packaged
skills/build-loop copy.

Pass the target project as an explicit absolute --root. Node.js 22 or newer plus
Bash 3.2+, jq, Git, Perl, and standard Unix tools are control prerequisites.

Do not claim that the skill automatically discovers the user's intended project
root. Resolve it from the current Codex project and state it when ambiguous.
Optional MCP setup is a separate explicit local configuration.

## Start from chat

For a new or unfamiliar target:

1. call inspect and doctor;
2. if no active adapter exists, call prepare;
3. present the exact proposal, commands, protected paths, allowed environment
   variable names, evidence requirements, providers, and probes;
4. request approval through the dedicated local flow;
5. activate only when the approved positive and negative probes and strict
   checks succeed.

inspect and prepare must not execute target commands. Do not accept a typed hash
or invent a confirmed flag. Request the approval URL and give it to the human.
Never fetch the URL or submit its form; the human performs that browser action.
Approval is bound to the displayed proposal.

Copied probes run in a disposable target copy, not an operating-system sandbox.
They retain the current user's privileges. Reject or block probes with external
effects, secret access, deployment, migration, production-device operations, or
destructive behavior.

## Execute work

Read core/CONTRACT.md and core/WORKFLOW.md from the resolved package root. Read
the active project adapter, work item, state, and node brief from the target
root before editing. Execute one bounded node or slice. Change only allowed
paths and preserve frozen and protected paths.

The fixed phases are DEFINE, DESIGN, EXECUTE, REVIEW, VALIDATE, and HANDOVER.
Review is mandatory and must use a fresh independent context. The runner owns
checks, evidence, and transitions. A worker's success statement is advisory.

Use durable bounded jobs for long work. Return job IDs and inspect the existing
job after reconnect. Use answer and resume for recorded blockers; never edit
state, locks, jobs, or evidence to force progress.

If `.loop/quarantine.json` exists, inspect its changed_paths and expected
records. Do not edit or delete quarantine or runner metadata. Start, resume, and
run remain blocked until exact restoration. The answer operation may recover
only when every changed path is an answer sidecar; mixed or other damage requires
exact restoration. Pause and cancel remain available.

Use a project-unique request ID for each intended start, run, or resume launch;
reuse it only for an exact retry. Pause and cancel take effect at a build-node
boundary. Activation jobs reject pause and cancel. After cancellation, use
handover to acknowledge the cancellation before creating the next work item.

Handover reports evidence and the next decision. It does not authorize merge,
publication, release, deployment, migration, destructive actions, or secrets.
Worker and reviewer calls may send their bounded inputs to the configured model
provider; keep secrets and undeclared project content out of those inputs.

## CLI shape

~~~bash
node /absolute/package-root/bin/build-loop.mjs OPERATION --root /absolute/project --input /absolute/input.json --json
~~~

Omit --input only for operations that take no structured input. Preserve exact
JSON results when evidence or job identifiers are needed in later calls.

## Fail closed

Missing configuration, verifier, provider authentication, target runtime,
evidence, authority, or valid state blocks execution. Time, retry, and round
caps never become success. Planning may continue without a verifier; execution
may not.
