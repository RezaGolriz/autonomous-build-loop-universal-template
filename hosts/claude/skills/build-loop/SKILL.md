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

Call loop_check for a read-only situation report; handover_ready means there is
something for the human to look at, not that the work succeeded. Queue work with
loop_backlog_add, loop_backlog_list, and loop_backlog_remove. loop_accept,
loop_authorize, and loop_promote are human decisions and none of them completes
here. Each returns ok with pending_confirmation and a confirmation_url: a local
page bound to that one operation, that one item, and the fully resolved decision
frozen at that moment, defaults, budget, expiry and a fingerprint of the run or
proposal included. Hand the link to the human, state plainly what confirming it
would do, and wait for them; never open, follow, or submit it yourself. The human
types the word ACCEPT, AUTHORIZE or PROMOTE into the field on that page, the
operation runs, and the record keeps the channel local-http-user with the
assurance local-user-action. If the run, the proposal or the decision changed in
the meantime, the confirmation is refused as CONFIRMATION_STALE rather than
applied to something else. Repeating the same call returns the same link, not a
second one, and a request expires after fifteen minutes. A project may be set to
tty-only in .loop/control/policy.json; these tools then return
CONFIRMATION_TTY_ONLY with the exact command for the human to run at their own
terminal. Report that command; do not run it and do not work around it. loop_deauthorize sets an authorization back to
PAUSED and completes directly, and it also places a project-wide hold: while
.loop/control/hold.json exists, loop_start, loop_run, loop_resume, loop_tick,
loop_task and loop_scout are refused with PROJECT_ON_HOLD for every caller that
is not a person at an interactive terminal, so writing a new work item is no way
around the withdrawn decision. loop_cancel and loop_handover keep working.
loop_hold places such a hold deliberately, with a reason, from any channel:
stopping is always allowed. loop_release takes it off and is human-only — the
typed word RELEASE, so from a tool call it returns a confirmation link like
loop_accept and loop_authorize. Never work around a hold; report it and ask the
human to release it. loop_tick is one cadence step for a timer or a
schedule: it reports, advances one node, or starts an item the human already
authorized as READY within its recorded budget and expiry. It never grants
approval and never starts a paused, expired, or invalid item, and it stops
continuing a run whose authorization was revoked, expired, or does not validate.

An authorization also bounds paths: every slice path and every changed file has
to stay inside its scope.allowed_paths. A record that does not validate is
reported as INVALID rather than treated as absent, and only the human can write
it again.

loop_scout looks for work: it runs a bundled provider wrapper read-only in a
disposable copy of the project and writes proposals into the inbox, touching
neither the backlog nor a run. No other executable can be named. Read the
proposals with loop_inbox_list, ask about turning one into a backlog item with
loop_promote, and drop one with loop_discard. A proposal is inert until the human
confirms the promotion; never promote one on your own initiative.

Acceptance, authorization, scope expansion, protected-path exceptions, and
external actions are never automatic. No timer, note, or judge verdict is any of
them, and handover_ready is not success.

Every run that reaches HANDOVER leaves an advisory note in
`.loop/notes/next-steps.md` that the next DEFINE brief and every scout brief
carry along; it summarizes the run and suggests priorities, and it never approves
anything or widens the scope of a node.

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
