---
name: build-loop
description: Operate Universal Build Loop from Claude Desktop through its project-bound local MCP server.
---

# Universal Build Loop for Claude Desktop

Use the build-loop MCP tools supplied by the local extension. The server is
bound to user_config.project_root and must not accept a root override. Opening
project files or reading CLAUDE.md alone is not an executable control bridge.

For first use, call loop_inspect and loop_doctor, then loop_prepare when active
configuration is absent. Preparation must not run target commands. Present the
complete proposal before requesting approval.

Call loop_request_approval with no arguments. It opens the small local
confirmation view. Do not ask the user to type a hash and do not invent or pass
confirmed=true. Show the returned local URL to the human, then wait. Never fetch
the URL or submit its approval form. Approval applies only to the displayed
proposal and approved activation probes.

Activation runs copied probes in a disposable target copy. That copy is not an
operating-system sandbox; commands retain the current user's permissions.
External-effect probes are not acceptable.

Run work through bounded MCP operations. Keep and report returned job IDs. After
a disconnect, inspect project and job status before starting a new job. Answer
recorded blockers through loop_answer and continue through loop_resume.

If `.loop/quarantine.json` exists, do not edit or delete it or other runner
metadata. loop_start, loop_resume, and loop_run remain blocked until exact
restoration. loop_answer can recover only an answer-sidecar-only quarantine;
mixed or other damage requires exact restoration. Pause and cancel remain
available.

Use a project-unique request ID for each intended loop_start, loop_run, or
loop_resume launch; reuse it only for an exact retry. Pause and cancellation take
effect at a build-node boundary. Activation jobs reject both operations. After a
cancellation, call loop_handover with the human's acknowledgement before calling
loop_task for the next work item.

The fixed phases are DEFINE, DESIGN, EXECUTE, REVIEW, VALIDATE, and HANDOVER.
Review is always fresh, independent, and mandatory. The control engine owns
checks, evidence, path enforcement, and transitions; MCP transport and this
skill do not own gates.

Missing configuration, target tools, authenticated provider, verifier,
evidence, decision, or authority blocks execution. Planning may remain
available. Handover is not authority to merge, publish, release, deploy,
migrate, perform destructive work, or access secrets.

Worker and reviewer processes may send bounded project inputs to their selected
model provider. Keep secrets and unrelated project content outside that scope.
