# Worked scenario recipes

These documents show how a project adapter and first work item could be shaped
for four different targets. They are illustrative recipes, not proof that every
listed stack, version, command, provider, or device was tested by this project.
The runnable repository fixtures are under tests/fixtures and are recorded
separately in [the validation matrix](../VALIDATION.md).

| Recipe | Target | Suggested stack | Profile |
|---|---|---|---|
| [Web shop](web-shop.md) | Static public shop with browser behavior | Astro, Vitest, Playwright | service |
| [JSON API](api.md) | HTTP API with an interface contract | Python, FastAPI, pytest, Schemathesis | api |
| [ESP32 firmware](esp32-embedded.md) | Firmware plus host-testable logic | PlatformIO, C++, Unity | other |
| [Web app](web-app.md) | Browser client with login and dashboard | React, TypeScript, Vite, Vitest, Playwright | desktop |

Choose commands that are authoritative for your actual repository. A similar
framework does not make a copied recipe correct.

Every recipe now has a **Chat variant** with copyable prompts and a **Shell
variant** with commands and configuration details. Choose one setup route;
both use the same engine and gates. The documentation remains in English so
the prompts can be shared directly with either client.

## Loop walkthroughs

The recipes above show how to *shape* a project. The walkthroughs below show how
to *run* one, in each of the four kinds of loop, again with a chat variant and a
command-line variant. Each uses one of the recipes.

| Walkthrough | Kind of loop | Recipe it uses |
|---|---|---|
| [Goal loop](loops/goal.md) | One item, carried to HANDOVER, then `check` and `accept` | [Web shop](web-shop.md) |
| [Backlog loop](loops/backlog.md) | A queue: `backlog_add`, `authorize`, `accept` | [Web app](web-app.md) |
| [Cadence loop](loops/cadence.md) | A timer calls `tick` | [ESP32 firmware](esp32-embedded.md) |
| [Scout loop](loops/scout.md) | `scout` writes proposals you `promote` | [JSON API](api.md) |

Start at [loops/README.md](loops/README.md), which explains the shared `check`
output and what is never automatic in any of them. The concepts behind the four
kinds are in [LOOP-MODES.md](../LOOP-MODES.md).

## Chat variant: common setup

First install the [Codex plugin or Claude Desktop integration](../../hosts/README.md).
In Codex, open the intended target repository in a task with the build-loop
skill loaded. In Claude Desktop, select that target folder in the MCP extension
configuration. Opening this documentation alone does not connect the tools.
Ask the assistant to confirm the target before any write.

The chat route avoids typing terminal commands yourself. The runner still needs
Node 22+, Bash, jq, Git, Perl, shasum, and target-specific dependencies. Builder
and reviewer CLIs need their own authentication; the chat subscription or MCP
connection does not establish worker authentication automatically.

### Inspect and establish a baseline

Start with the inspection prompt in the chosen recipe. The assistant should
report existing tests, artifacts, provider readiness, and missing setup inputs.
Inspection and preparation must not run project commands.

For a new project, or one without working checks, send this separate prompt:

```text
Plan the smallest working baseline for this recipe in the selected folder.
Show the files, dependencies, downloads, and checks needed before doing the
setup work. Preserve existing files and ask for any missing product decisions.
After I agree to the concrete plan, carry out the local setup with the tools
available in this client and report the actual check results. Do not activate
the build loop, commit, push, or deploy as part of baseline setup.
```

Baseline creation is ordinary project setup, outside the uninitialized loop.
The build-loop MCP tools are not general scaffolding or dependency-installation
tools. If Claude Desktop has only this MCP server, it can inspect and prepare
existing files but cannot perform that baseline work: use an agent with suitable
file/execution tools, or the shell recipe, then reconnect to the ready target.

Select the providers, for example:

```text
Configure Codex as builder and Claude as independent reviewer for this target.
Check both providers with doctor and explain any missing prerequisites or
unverified authentication. Do not install or sign in automatically.
```

Use two providers only if both are available. One provider may fill both roles
with a fresh independent review context. The client hosting the conversation
does not have to match the builder. Next send the recipe's preparation prompt;
the first work item is included in that proposal, not created later with task.

### Human approval and activation

Before approval, expect a concrete proposal: target root, request and acceptance
criteria, exclusions, providers, allowed/frozen/protected paths, commands,
timeouts, artifacts, evidence requirements, environment names, and probes.
The negative probe needs an exact nonzero exit code and expected output; a
missing-file example alone is not enough. Prefer a deliberate failing fixture
that exercises the same verifier boundary. Do not invent its observed result.

```text
Show the complete prepared proposal and request its local approval link.
Give me the link. Do not open it or approve on my behalf, and do not activate yet.
```

Open the link yourself and approve the displayed plan. Then send:

```text
I completed the approval in the local review page. Activate the prepared setup
using its stored receipt. Show the activation job ID and check its status.
Do not start implementation until the activation job is COMPLETED, the target
is initialized, activation.valid is true, and canonical state is PAUSED.
```

The chat message does not replace the signed receipt. Activation runs approved
positive and negative probes in a disposable copy, which is not an OS or network
sandbox. If the plan or source changed, prepare and review it again. If a probe
fails, diagnose that result instead of forcing activation or marking it passed.
Once activation succeeds, send the start prompt from the chosen recipe.

### Status, blockers, and handover

After reconnecting, or whenever progress is unclear:

```text
Show the current job ID, canonical phase and state, passed and failed gates,
open blockers, and the last recorded result. Reconnect to the existing job;
do not launch a second worker just because this is a new conversation.
```

If a node budget ended normally, the job may be COMPLETED while the work item
is still RUNNING. Ask for another bounded run after inspecting that state:

```text
If the prior job finished normally and the work item is still RUNNING, continue
with run for at most 6 more nodes and a new project-unique request ID. Preserve
the original wall-clock, round, and retry caps. Otherwise explain the state
and the next permitted action.
```

For a blocker, first read its question and make the actual decision. For example:

```text
For the blocker asking whether to add MSW, my decision is: use the existing
Playwright route mocks and do not add a dependency. Record this exact answer
against that blocker. If all blockers are resolved, resume for at most 6 nodes
with a new request ID; otherwise show the remaining questions.
```

This is a sample decision for the web-app recipe, not a default answer to every
blocker. Never let the assistant invent a human answer or hand-edit the state.
To pause, ask it to finish the current node and pause, then confirm PAUSED.
Activation probes cannot be paused or cancelled through this interface.

At HANDOVER, use the recipe's review prompt. If satisfied, send:

```text
Acknowledge the passed handover with the note: reviewed locally; no deployment
or publication authorized. Confirm that the work item is COMPLETED.
```

Only then ask to create the next bounded work item with task. A job's COMPLETED
status alone does not mean the work item passed handover. Commits, pushes,
deployment, migrations, payments, and device flashing need separate authority.

### What the assistant calls

These names help you recognize the actions; you do not have to type them.
Codex uses the skill's bundled control CLI. Claude Desktop uses the corresponding
project-bound MCP tools; the semantics and state are the same.

| Conversation step | Control operation | Claude Desktop tool |
| --- | --- | --- |
| Inspect and check readiness | inspect, doctor | loop_inspect, loop_doctor |
| Choose builder/reviewer | configure | loop_configure |
| Prepare the first work item | prepare | loop_prepare |
| Obtain a human approval link | request-approval | loop_request_approval |
| Validate and activate setup | activate | loop_activate |
| Start or continue a bounded job | start, run, resume | loop_start, loop_run, loop_resume |
| Reconnect and inspect progress | status | loop_status |
| Record a human decision | answer | loop_answer |
| Pause or cancel execution | pause, cancel | loop_pause, loop_cancel |
| Acknowledge local handover | handover | loop_handover |
| Prepare a later work item | task | loop_task |
| Read where the project stands | check | loop_check |
| Queue and inspect work items | backlog_add, backlog_list, backlog_remove | loop_backlog_add, loop_backlog_list, loop_backlog_remove |
| Let an item start later, or take that back | authorize, deauthorize | loop_authorize, loop_deauthorize |
| Stop everything now, or let it continue | hold, release | loop_hold, loop_release |
| Accept a finished run | accept | loop_accept |
| Take one cadence step | tick | loop_tick |
| Look for work and triage it | scout, inbox_list, promote, discard | loop_scout, loop_inbox_list, loop_promote, loop_discard |

`accept`, `authorize` and `promote` are the three human decisions. They complete
only from the word typed at an interactive terminal, or from a button a person
presses on a local confirmation page; from an input file or a chat tool call they
return a `confirmation_url` and write nothing until somebody confirms it.

## Common setup

The following checklist and commands describe the equivalent shell route.

1. Establish a working baseline in the target repository. Run its existing
   build and test commands by hand and preserve unrelated work.
2. Inspect, run doctor, and prepare a proposal with the first bounded work item.
   Preparation must not execute target commands.
3. Review the profile, exact argv commands, timeouts, artifacts, evidence kinds,
   protected paths, allowed environment names, providers, and probe plan.
4. Approve the displayed proposal through the local bound confirmation view.
5. Let activation run the positive and known-failing negative probes in a
   disposable copy. A missing verifier leaves the project in planning mode.
6. Start the prepared work item as a bounded job and follow status by job ID.
7. Answer blockers when needed, inspect the evidence-backed handover, and
   acknowledge it locally. Only then can task create another work item.

~~~mermaid
flowchart LR
    B[Working baseline] --> P[Prepared proposal]
    P --> A[Bound approval]
    A --> N[Positive and negative probes]
    N --> J[Prepared work item starts as bounded job]
    J --> H[Evidence-backed handover]
~~~

The Node entry point is:

~~~bash
node bin/build-loop.mjs OPERATION --root /absolute/project \
  --input /absolute/input.json --json
~~~

The shell entry point remains supported:

~~~bash
./bootstrap/init.sh /absolute/project
./engine/orchestrator.sh start --root /absolute/project
./engine/orchestrator.sh loop --root /absolute/project \
  --host codex --provider hosts/codex/provider.sh \
  --review-host claude --review-provider hosts/claude/provider.sh \
  --max-nodes 12
~~~

With the legacy initializer, follow its generated activation checklist instead
of treating this page as activation authority.

## Rules shared by every recipe

- Worker edits stay within the active execution slice's allowed paths.
- Frozen and protected paths cannot be changed to make the worker's own checks
  pass.
- Verification commands run with a minimal environment. Declare names, never
  secret values.
- Build and test output written inside the project needs an allowed output path.
- Reviewer diversity can help, but fresh independent context and challenge
  binding remain mandatory even when the provider names differ.
- Deployment, publication, payment, production-device flashing, migration, and
  other external effects happen only after a separate human decision.

Use each recipe's command and version values as a starting point to review, not
as defaults to accept automatically.
