# Team loop design and implementation boundary

This page describes the approved direction and the current implementation.
It does not certify a live provider or a native host interface.

- [Interactive dashboard example](team-dashboard.html): example data only.
- [Team workflow](../assets/team-workflow.svg).
- [User guide](../TEAMS.md).
- [Two-package demonstration](../../examples/team-demo/README.md).

## Chosen approach

Keep one shared control model for the shell, Node CLI, Codex skill and MCP.
Add a signed team roster, registered isolated package roots and a durable
supervisor. Keep each package's existing single-root engine rather than putting
several writers inside one state machine. Add API agents with separate contexts
and limited file tools. Treat native host delegation as a separate capability.

## Why this approach

A minimal interface-only change would simplify setup but retain one active task.
A completely new multiwriter engine would add conflict handling and weaken the
clarity of existing evidence. Isolated package roots allow useful concurrency
while preserving the engine's locks, six phases and evidence gates.

The tradeoff is setup overhead: every package still needs its own approval and
authorization. `package_control` lets one bound MCP connection prepare those
steps by package ID. It never turns a team approval into blanket execution
permission. Empty prepared roots are suitable for demonstrations; repository
worktrees still need explicit preparation.

## Critical review questions

- **Is setup easier?** Chat prepares inputs and the dashboard explains progress;
  the human still reviews concrete scopes. Multiple child approvals remain.
- **Does it work in Codex and Desktop?** Both can address the shared CLI/MCP
  model. API workers avoid agent CLI processes. MCP cannot create a missing
  native Desktop subagent interface.
- **What internal complexity is added?** Signed roster/store/job records,
  resource scheduling, budget accounting and recovery ownership. It is kept
  outside the existing single-root engine.
- **What stays?** Shell entry points, independent review, approved verifiers,
  frozen scope, human decisions, holds and handover.
- **What is still a limitation?** Automatic native-only teams, automatic
  technical retries, dead child descendant recovery, live provider quality and
  acceptance/integration reporting, automatic dependent launch and extending an already frozen package set require further qualification or adapters.

## Recovery and progress

Read the existing durable job after reconnect. Resume preserves elapsed budget
and node caps. A verified checkpoint may justify the already approved reserve;
no retry or resume widens permission. Uncertain child ownership blocks rather
than deleting locks. Stops are at bounded node boundaries.

Current progress measures evidence-backed workflow gates. An illustration may
show example criterion counts, but the live status does not invent criterion
proof. Unknown coverage, acceptance, integration and model evidence remain
explicitly unavailable.
