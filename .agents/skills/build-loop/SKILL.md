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

1. call inspect and doctor; use options when choosing a work kind or run mode;
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

Use check for a read-only "where does this stand" answer; its handover_ready
field means there is something to look at, not success. Keep queued work with
backlog_add, backlog_list, and backlog_remove. accept, authorize, and promote are
human decisions and complete in only two ways: the literal word ACCEPT,
AUTHORIZE, or PROMOTE typed at an interactive terminal, or the same word typed
into the field on a local confirmation page. Called any other way — an input
file, a tool call — they complete nothing and return ok with
pending_confirmation and a confirmation_url. The page shows the fully resolved
decision frozen when the link was made: defaults, budget, expiry and a
fingerprint of the run or the proposal. Give that link to the person, say what it
would do, and wait; never open or submit it yourself. The record then keeps the
channel local-http-user with the assurance local-user-action, which means a
person with access to that machine did it and is not proof of who. A decision
that no longer matches what was frozen is refused as CONFIRMATION_STALE. A
project may be set to tty-only in .loop/control/policy.json; the operations then
return CONFIRMATION_TTY_ONLY with the exact command for the person to run at
their own terminal. Report that command; do not run it and do not work around
it. deauthorize sets an authorization back to PAUSED and completes
directly, and it also places a project-wide hold: while .loop/control/hold.json
exists, start, run, resume, tick, task and scout are refused with
PROJECT_ON_HOLD for every caller that is not a person at an interactive
terminal, so a new work item is no way around the withdrawn decision. cancel and
handover keep working. hold places such a hold deliberately, with a reason, from
any channel; stopping is always allowed. release takes it off and is human-only:
it needs the typed word RELEASE, so from a tool call it returns a confirmation
link like accept and authorize. Never work around a hold; report it and ask the
person to release it. tick is one cadence step for a timer or a schedule: it reports,
advances one node, or starts an item that is already authorized as READY within
its recorded budget and expiry. It never grants approval and never starts a
paused, expired, or invalid item, and it stops continuing a run whose
authorization was revoked, expired, or does not validate.

An authorization also bounds paths: every slice path and every changed file has
to stay inside its scope.allowed_paths. A record that does not validate is
reported as INVALID rather than treated as absent, and a person has to write it
again.

scout looks for work: it runs a bundled provider wrapper read-only in a
disposable copy of the project and writes proposals into the inbox, touching
neither the backlog nor a run. The provider is named, never pathed: only claude,
codex or mock, and only the wrapper bundled with this distribution runs. Read the
proposals with inbox_list, turn one into a backlog item with promote, and drop
one with discard. A proposal is inert until a person confirms promote.

Acceptance, authorization, scope expansion, protected-path exceptions, and
external actions are never automatic. No timer, note, or judge verdict is any of
them, and handover_ready is not success.

Every run that reaches HANDOVER leaves an advisory note in
`.loop/notes/next-steps.md` that the next DEFINE brief and every scout brief
carry along; it summarizes the run and suggests priorities, and it never approves
anything or widens the scope of a node.

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

## Loop selection and dashboard

Use options to list supported work kinds and run modes. Translate the user's
intent into work_kind for prepare or task: feature, defect, maintenance,
documentation, research, or migration. Present the appropriate acceptance
criteria and verification; changing kind never removes a gate.

For start, run, or resume, use run_mode="step" for one node or
run_mode="bounded" for up to 12 nodes. Explicit max_nodes remains available;
step rejects values other than 1. A completed job is not a completed work item.

When asked to show the dashboard, call dashboard and return dashboard_url as a
clickable link. It is a read-only local browser view, valid for 30 minutes.
Reload it for current data. The selector prepares a chat request only; it does
not change configuration or execute work. The shell HTML renderer remains
available for static exports.
