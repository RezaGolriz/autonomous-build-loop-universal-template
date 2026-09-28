# Working with an agent team

A **work package** is one clearly scoped task, such as adding login or improving
an export. An **agent session** is one worker doing one step of that task. A
**supervisor** keeps track of these tasks and applies the same rules to all of
them. It is not another model that can approve its own work.

![How the team loop works](assets/team-workflow.svg)

## Start with one package

You do not need parallel work or several model providers to use Build Loop.
The default is one package at a time. Existing shell workflows still work.

In Codex or Claude, you can ask:

> Inspect this project and help me set up a team loop. Work on one package at
> a time. Ask which builder and independent reviewer I want. Show the setup
> proposal before starting anything.

The chat should report missing tools, capabilities and access. A name in a
configuration file does not mean an agent is ready to work.

## Choose parallel work when the tasks are independent

For example, a login change and an export change may run in parallel if they
use separate files and do not depend on each other. Two changes to the same
shared file should wait for each other.

> Prepare two packages: improve the login flow, and add export filters. Allow
> at most two active packages. Use separate workspaces. If their paths overlap,
> do them one at a time. Show the scopes, reviewers and budgets before starting.

Every package keeps its own six phases:

**DEFINE → DESIGN → EXECUTE → REVIEW → VALIDATE → HANDOVER**

Parallel work does not remove review or validation. It does not merge the
results into your main branch automatically.

## Choose who may help

You choose the allowed participants during setup, including their role and
exact model. You can use different providers for implementation and review.

> Use my current chat for coordination. Let the selected OpenAI model build
> and the selected Anthropic model independently review. Do not add another
> provider or switch models without asking me. Show which project files each
> provider may receive.

The chat should turn this into a concrete proposal, not guess models or obtain
keys from unrelated applications. API credentials stay outside project files.
Cloud API usage is billed separately from a Desktop or CLI subscription.

| Execution choice | What it means for you |
|---|---|
| Native host subagent | Your host creates the helper agent. The necessary host capability must be available and verified. |
| Managed API agent | Build Loop maintains a separate session with limited file tools. No agent CLI process is needed. API access is required. |
| CLI provider | The existing authenticated Codex or Claude Code worker runs as a separate command-line process. |

In Claude Desktop **chat over MCP**, separate API sessions are visible in the
Build Loop dashboard. MCP does not guarantee a native subagent panel inside
Desktop chat. Claude Code and Codex native delegation are separate host
capabilities; installing an MCP extension cannot create a missing capability.

## Read the dashboard

![Dashboard reading guide](assets/team-dashboard.svg)

The image above uses example numbers. It is a reading guide, not a live result.

- **Overall progress** covers all packages, regardless of the selected filter.
  The label says what was measured: verified criteria or passed workflow gates.
  Gates are not estimates of remaining effort.
- **Package progress** shows recorded results for that package. Missing data
  appears as unavailable, not as success.
- **Agent team** shows who is allowed to work, which execution type they use,
  and whether readiness is verified. An allowed profile is not a running session.
- **Details** show the current step, workspace, recorded API-node identity, model evidence, time limit,
  checkpoint and next action.
- **Acceptance and integration** are separate. A full progress bar does not
  mean the result was accepted by you or merged into your project.

If some packages have no verified progress yet, the overall percentage is
labelled partial. Adding work or changing a revision may reduce it. There is no
percentage guessed from an agent saying it is almost finished.

## If a task takes longer or stops

A setup proposal can include an initial time allowance and a limited reserve.
The supervisor may use only the reserve you already allowed. It cannot remove
a hard limit or extend an expired authorization.

A technical interruption is different from a failed review:

- **Interrupted worker:** inspect the existing job and checkpoint. Resume only
  after the old worker has ended or lost its fenced ownership, inside the
  remaining limits.
- **Failed check or review:** correct the defect through the workflow. Retrying
  a process is not evidence that the defect was fixed.
- **Missing decision or expired permission:** stop and ask the person. No
  automatic retry grants permission.

> Check the existing jobs. Do not start duplicates. Explain which package
> stopped, what checkpoint is available, and whether its remaining budget and
> authorization allow a safe resume.

Closing the chat does not mean a durable job stopped. Reconnect by reading its
job ID and current status.

For example, say **“Recover the existing team job, then resume it if allowed.”**
The assistant uses `supervisor_recover` and `supervisor_resume` with that job's
ID. It waits for stopping children rather than replacing them. Completed steps,
spent time and retry counts remain attached to the original job.

**Cancel is final.** A later pause or resume cannot undo it. If a supervisor
was interrupted while a child was working, cancellation still requests that
child to stop. Status stays `STOPPING` until its stop can be verified. Recovery
may finish stopping a cancelled job; it cannot restart it.

The private signed record is the latest trusted checkpoint. A missing or older
signed workspace copy is restored from it, preserving consumed budgets. An
invalid signature or missing private record blocks. Recovery of short scheduler
locks requires a known dead owner; live or unknown owners are never displaced.
This does not remove locks belonging to the child engine.

## Keep the decisions simple

You still review the exact proposal and type the required word on the local
confirmation page or at your terminal. The agent hands you the link; it never
opens the confirmation page or submits it for you. A hold on the supervisor
stops subsequent package nodes scheduled through it. Each isolated workspace
also has its own hold. If you use a workspace independently through another
connection or terminal, use that workspace's hold as well.

For installation, see [Installation](INSTALLATION.md). For one-package modes,
see [Loop modes](LOOP-MODES.md). For the underlying rules, see
[the workflow contract](../core/CONTRACT.md).

Start with [the two-guide demonstration](../examples/team-demo/README.md).
Then try [the Notes and CSV practice project](../examples/team-project/README.md)
with your selected real builder and reviewer. Its instructions separate the
tested starting app from changes that agents still need to make.


## Supported today

| Path | Current behavior |
|---|---|
| Existing one-root shell loop | Unchanged |
| Automatic API or permitted CLI packages | Isolated scheduling, durable jobs and all six gates |
| Several native-only host subagents | Configuration is accepted as a proposal, but automatic launch is blocked until a verified host adapter exists |
| Explicit chat steps | Available through the existing chat controls; the host supplies helpers |
| Resume after supervisor interruption | Recover the existing supervisor and wait for any live children to stop before resuming |
| Dead child with uncertain descendant ownership | Blocked for inspection; locks are never deleted automatically |
| Automatic technical retry | Not enabled in this release; configured retry limits are retained for recovery policy, not a promise of automatic retry |
| API quality or native Desktop UI | Requires separate live qualification; local tests use controlled fixture responses |

Stopping happens at a bounded node boundary. The scheduler checks whether the
next provider-and-verifier timeout allowance fits before admitting a node.
It may reserve time after a recorded checkpoint; it cannot buy more time past
the original ceiling. This is not a guarantee of an instantaneous process kill.
A resume keeps the original node cap. If that cap was consumed, changing the
request ID does not reset it. A new work cycle must be set up deliberately.

## Concrete setup from chat

The assistant should make these steps visible in plain language:

1. Inspect the chosen project and run the control doctor.
2. Ask **one at a time or parallel**, which exact builders and reviewers may
   participate, and whether CLI processes are permitted. Default to one package.
3. Start the main dashboard with `serve` on the team controller. Write a
   paused team proposal with `team_configure`; request its decision with
   `team_authorize`. It appears in the main Decisions panel.
4. Register isolated workspaces with `package_add`. `prepare: true` makes an
   empty folder, not a copy of your repository. For real code, use separately
   prepared checkouts or worktrees. Shared paths and resources are explicit.
5. Use `package_control` to inspect, configure and prepare each registered
   workspace. It selects a package ID, never an arbitrary replacement root.
6. Request each setup approval through `package_control`. With the main page
   running, its Decisions panel collects those requests from registered roots.
   You type `APPROVE` on each setup card. After approval, run its activation
   probes. Obtain separate work authorization through `package_control` with
   `authorize`; that decision also appears on the main page and needs your
   typed `AUTHORIZE`. Team approval grants none of these permissions.
7. For API workers, use `team_verify` explicitly for the selected members. A
   probe sends a small request and can incur API usage; status checks do not.
   API child workspaces use the same team config and their own team approval.
8. Start with `supervisor_start`, keep its job ID, and open the dashboard.

You can do the same through the Node CLI using operation names above and JSON
input files. This keeps the shell route available; you do not need to paste
technical input files yourself when a chat assistant prepares them for review.

## Where configuration lives

- Team proposal: `.loop/control/team.json`; this is signed local state.
- Team receipt: `.loop/control/team.approval.json`; only the human flow writes it.
- Registered workspaces: `.loop/scheduler/packages/packages.json` (host-signed).
- Supervisor jobs: `.loop/scheduler/supervisor/jobs/`; these retain budgets,
  child identities, checkpoints and the original node cap.
- Each workspace: its own adapter, work item, signed provider configuration,
  setup activation, work authorization and evidence.

Do not edit signed records by hand. Change a team through `team_configure` with
`replace: true`, then get a new approval. An existing job refuses a changed
team, package set, work item, activation or provider binding.

The API runtime has only `list_files`, `read_file` and `write_file` tools;
reviewers cannot write. It cannot run shell commands. The engine runs the
approved project checks separately. Token usage is checked after every API
response: a single response can exceed the remaining total, at which point the
node blocks. This is a usage stop threshold, not a guaranteed billing cap.


The registered package set is frozen after the first supervisor job. Register
all packages before starting. Automatic dependent launch is currently blocked
until an explicit integration receipt exists; handover text is not integration.
For another cycle, deliberately prepare a fresh supervisor setup rather than
changing the old job's inputs or request ID to reset its limits. The existing
single-root backlog workflow remains available for ongoing ordered work.


API node observations also record the selected member, provider-reported model,
local node-session ID, timestamps and reported usage. This is runtime reporting,
not a native host session or gate evidence. An unavailable model remains unknown.
The sidebar labels which phase produced the response, so a previous node's model
is not mistaken for proof about a new one.
