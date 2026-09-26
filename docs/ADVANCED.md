# Advanced operation

This guide covers direct API use, package bundles, multi-project setup, durable
job recovery, and controlled configuration changes.

## Call the shared API

The CLI and MCP server call the same dependency-free Node module:

~~~js
import { dispatch } from "./control/index.mjs";

const result = await dispatch(
  "/absolute/path/to/project",
  "status",
  {}
);
~~~

Use an absolute project root and one documented operation. Treat the returned
object as the source for client rendering; do not infer success from process
exit alone.

Applications embedding the API must preserve:

- strict operation input validation;
- project-root binding;
- approval binding to the prepared proposal;
- request IDs and maximum-node bounds;
- blocker and evidence references;
- legal state transitions;
- the separation between handover and external authority.

## Build package artifacts

From a source checkout:

~~~bash
npm test
npm run test:all
npm run bundle
~~~

The bundle step generates the Claude Desktop extension at
dist/build-loop.mcpb and the Codex skills plugin under dist/codex/. Record the
actual command result in docs/VALIDATION.md before claiming a bundle is ready
for installation.

The package has no third-party npm runtime dependencies. It still invokes the
shell reference controls, so Bash 3.2+, jq, Git, Perl, and standard Unix tools
must be available. Target runtimes and authenticated worker providers remain
separate prerequisites.

## Run several projects

Use one MCP server process and client entry for each target root:

~~~text
Project A → build-loop MCP --root /work/project-a
Project B → build-loop MCP --root /work/project-b
~~~

A tool call cannot redirect a bound server to another root. This makes project
selection visible in client configuration and prevents a stale chat argument
from changing targets.

In Claude Desktop, set user_config.project_root for the extension instance. In
Codex, pass the current project's absolute root to the bundled CLI. Do not
claim that the Codex skill discovers the intended root automatically.

## Change active configuration

Do not edit generated state to adopt new commands. Prepare a replacement
proposal that shows the delta from the active project adapter. The human
reviews the exact new commands, paths, evidence requirements, and probes, then
approves that proposal through the same local confirmation boundary.

Run the probes in a disposable copy and activate only after strict validation.
Changing a timeout, provider, protected path, or evidence requirement can alter
the trust boundary and deserves the same review as initial setup.

## Design a useful negative control

The negative probe should reach the intended verifier and fail for one clear,
safe reason. Examples include:

- asking a test runner for a deliberately absent fixture;
- checking a deliberately invalid local sample in the disposable copy;
- invoking a compiler on a controlled invalid input created for the probe.

Avoid a misspelled executable: it proves only that the shell can report command
not found. Avoid network, deployment, production devices, migrations, account
changes, and secret-dependent probes.

The disposable target copy protects the original tree from ordinary file
changes. It is not an operating-system sandbox and does not restrict what the
current user can access.

## Recover after a disconnected client

1. reconnect to the same project-bound server or reopen the same Codex project;
2. call inspect and status;
3. match the returned job ID and request ID;
4. inspect the last phase, process state, timeout, blocker, and evidence;
5. answer and resume only if the recorded state permits it.

Do not start another job merely because the prior chat transcript is missing.
If a job heartbeat stops or its lock cannot be proven current, preserve the
record and follow the reported JOB_ACTIVE or JOB_RECOVERY_REQUIRED condition.
The controller does not delete an ambiguous lock or recover automatically.

## Use provider diversity

A different reviewer provider can reduce shared assumptions, but diversity is
not the trust mechanism. Review still needs a fresh context, exact durable
change, contract, evidence references, and valid one-time challenge. Two labels
pointing to the same continuing conversation are not independent review.

## Backlog and authorization

A project can keep an ordered list of work items in `.loop/backlog.json`. Each
entry names a work item file under `.loop/work-items/`. `backlog_add` writes
that file from the shipped template and appends the entry. It starts nothing.

Every work item may have an authorization sidecar next to it, called
`.loop/work-items/<id>.authorization.json`. It has two states:

- **PAUSED** means the item is inert. Nothing may start it without a person.
- **READY** means a person already said "this one may run when its slot comes",
  and wrote down the limits under which that holds.

The record carries `item_id`, `state`, `scope.allowed_paths`, `budget` with
`max_rounds` and `max_wall_seconds`, `expires_at`, `stop_on_first_failure`,
`authorized_by`, `authorized_at`, `assurance`, and an optional `note`.
`authorize` writes it with an expiry 24 hours ahead and `stop_on_first_failure`
set to true unless you choose otherwise; `deauthorize` sets the state back to
PAUSED. `authorized_by` records the channel the decision came through:
`interactive-tty` for a word typed at a terminal and `local-http-user` for a word
typed on the local confirmation page. `assurance` is `local-user-action` for
both: a person with access to this machine did it, which is not proof of who.
`item_id` has to be the item whose sidecar the file is: the record in
`.loop/work-items/WI-007.authorization.json` says `"item_id": "WI-007"` and
nothing else. A decision is about the item it names, so copying one item's
record into another item's sidecar authorizes nothing there — it leaves an
invalid record behind, in the control layer and in the shell orchestrator alike.
A record that does not validate — an expiry that is not a real RFC 3339
timestamp or a calendar date that does not exist, such as `2099-02-30`, a field
the schema does not describe, a budget outside its documented range — is not a
weaker authorization but an invalid one: it is never READY, `status` and the
dashboard show it as invalid, and a person has to write it again. Its schema is
[spec/schemas/authorization.schema.json](../spec/schemas/authorization.schema.json).

Starting a run from a READY item copies its budget into `state.json` and records
the authorization in `.loop/control/current-job.json`. That happens wherever the
item is actually started — `start`, and `run` or `resume` on a paused item — and
it never resets rounds already used or time already elapsed. Continuing a run
that is already going — `run` on a RUNNING item, `resume` on a BLOCKED one —
takes the smaller of the current cap and the authorized cap, so a new decision
can narrow a run in flight but never widen it. An expired authorization grants
nothing: the start is refused and a person has to authorize the item again. A
sidecar that cannot be read or does not validate refuses `start`, `run`,
`resume`, `tick` and every job with `AUTHORIZATION_INVALID`, naming the file to
repair or delete. Every record is validated in full whatever state it claims, so
a PAUSED record with a field the schema does not describe is broken, not inert.
Starting a PAUSED item stays a human action.

**A withdrawn decision stops execution, not only the cadence.** A sidecar in
state PAUSED — deauthorized, or written as PAUSED in the first place — is not
"no decision": it means a person has to act. `start`, `run` and `resume` are
refused on it with `AUTHORIZATION_REVOKED`, and the message says what can be
done: authorize the item again, or start it from an interactive terminal. The
one exception is that terminal. In the control layer the decision channel has to
be `interactive-tty`, which is what the command line uses when standard input
and standard output are both a real terminal; a chat tool call (`mcp-user`), an
input file (`cli-input`), a cadence tick and a scheduler are all refused. In the
Bash orchestrator standard input has to be a terminal (`[ -t 0 ]`), or the run
has to be a managed job whose human entry the control layer recorded in
`.loop/control/current-job.json`. Even then the record still bounds the run: its
`scope.allowed_paths` remain the outer boundary and its budget still narrows the
caps, never widens them, and a run started this way records `human_entry` rather
than an `authorization_ref`, because nothing authorized it. A work item with no
sidecar at all is a manual item and is unaffected by any of this.

**Deauthorize places a project-wide hold.** Withdrawing a decision stops one
item, and that is not enough on its own: whoever can call the control layer could
cancel the run, acknowledge the handover, write a new work item with a scope of
its own choosing, and start that instead under a new item id no withdrawn
decision mentions. So `deauthorize` also writes `.loop/control/hold.json`:
`{"schema_version": 1, "held_at": …, "held_by": <channel>, "reason": …,
"item_id": …}`, atomically, right after the sidecar. Its schema is
[spec/schemas/hold.schema.json](../spec/schemas/hold.schema.json).

While that file exists, `start`, `run`, `resume`, `tick`, `task` and `scout` are
refused with `PROJECT_ON_HOLD` for every caller that is not a person at an
interactive terminal — a chat tool call, an input file, a cadence tick, a
scheduler, and a managed job alike — and the Bash orchestrator refuses `start`,
`run` and `loop` the same way, under the same rule it uses for a withdrawn
decision: a terminal, or a managed job whose human entry was recorded. Even then
it prints a warning line, because a person should know that the project they are
working in is stopped. Reading stays available, and so do `cancel` and
`handover`: they only stop work or write down what happened, and a person needs
them to wind a held project down. `check`, `status` and both dashboards show the
hold prominently. A hold record that cannot be read is still a hold.

The operation `hold` places one deliberately, with a reason. Any channel may do
that: stopping is never the dangerous direction, and a hold that is already there
keeps the first reason recorded. Taking one off is human-only: `release` needs
the literal word RELEASE typed at an interactive terminal, or typed on the local
confirmation page after a chat tool call, exactly like `accept` and `authorize`.
Nothing else removes the file, and no timer ever does.

For a terminal that cannot be given a pseudo-terminal — a test harness, some CI
shells — the orchestrator accepts `BUILD_LOOP_HUMAN_TTY=1` in place of the
terminal check. It is refused whenever a managed job is in play, and the Node
worker removes the name from the environment it passes down, so it can never
turn an automated run into a human one.

The authorization is also an outer boundary on paths and on time. Every path the
slice table declares has to be covered by `scope.allowed_paths` after DESIGN, and
every file a node actually changes has to be covered after EXECUTE and VALIDATE;
anything else fails the gate and leaves the run BLOCKED with evidence. A job
started under an authorization re-reads it before every node: an authorization
withdrawn or expired in the meantime stops the job at the next node boundary, and
with `stop_on_first_failure` a failed gate stops it as well, leaving the run
BLOCKED with the blocker line "stopped on first failure (authorization)".

**Deciding is human-only.** `accept`, `authorize`, `promote` and `release`
complete directly only when the word was typed at an interactive terminal. From an input file or a
chat tool call they do not complete at all: they return a pending request with a
`confirmation_url` on a local page. When that request is made the whole decision
is frozen — the operation, the item, every argument including the defaults, and a
fingerprint of what is being decided about: the exact authorization record that
would be written, the run and its HANDOVER evidence for an acceptance, the
sha256 of the proposal file for a promotion. The page displays that frozen
decision and asks the person to type the word into a field; the server checks the
typed word together with the single-use token. Only then is a signed receipt
written, and it signs the request id together with a digest of the frozen
request. Carrying the decision out recomputes that digest from the frozen request
on disk, claims the request with an atomic rename so two settlements cannot run
it twice, and re-checks the live item under the lock that does the work; anything
that moved in the meantime is refused with `CONFIRMATION_STALE` and the request
is discarded. Give that link to the person; never open it yourself.

**The control page is the recommended place to decide.** Run
`build-loop serve --root <project>` once (or let a chat call `loop_serve`). While
it runs, every `confirmation_url` points to it and the waiting request shows up
in its Decisions panel. It uses exactly the frozen request, the typed word and
the signed receipt described here. Without it, each request gets its own
short-lived page. See [The control page](DASHBOARD.md#the-control-page).

**The assurance, honestly.** Both routes record `local-user-action`: somebody
with access to this machine typed the word. The confirmation page is served on
loopback, so an agent that already has shell access on the same computer could in
principle open the link itself. If that matters to you, write
`.loop/control/policy.json` by hand with
`{"schema_version": 1, "human_confirmation": "tty-only"}`. Nothing in the loop
writes or edits that file, and no MCP tool call can. With `tty-only` an input
file or a chat tool call is refused with `CONFIRMATION_TTY_ONLY` and the exact
command to run, and only the terminal decides. That command carries the whole
decision, shell-quoted, so nothing has to be reconstructed and nothing falls
back to the current item:
`build-loop authorize --root '<project>' --input '{"item_id":"WI-007","allowed_paths":["docs/guide.md"]}'`
— the terminal still asks the person to type `AUTHORIZE`. A page request that
was still waiting when the file was written is thrown away instead of carried
out. A policy file that does not match its schema — an unknown key, a null
value, an unknown mode, a wrong version — is refused with `INVALID_POLICY`; it
never falls back to the permissive default. Until a person repairs it the project
behaves as `tty-only`: an input file or a chat tool call is refused, and only the
terminal decides, so the file can be repaired without anybody widening the rule
first. `status` and `check` report it as
`policy: {"mode": "tty-only", "source": "invalid-policy", "error": {"code": "INVALID_POLICY", ...}}`
and both dashboards show the same error. The default is
`tty-or-local-page`. `status`, `check` and both dashboards show which mode is in
force. Its schema is
[spec/schemas/confirmation-policy.schema.json](../spec/schemas/confirmation-policy.schema.json).

### Confirming from your phone

Set `confirmation_page` in `.loop/control/policy.json` (the fields are explained
once, in [the policy file](CONFIGURATION.md#the-policy-file-who-may-decide-and-from-where)),
start the control page, and open its link on your phone inside your home network
or VPN (see [The control page](DASHBOARD.md#the-control-page)). One bookmark then
covers every decision. The one-request pages use the same setting, so their
links, for example `http://192.0.2.10:8765/confirm?token=…` and the setup
approval page's `…/review?token=…`, open on the phone too.

The server answers only requests whose `Host` is the advertised address or
`127.0.0.1`, and records a decision only when the form's `Origin` is that same
address. **Security is exactly what it was:** a secret in the link, a word the
person types, and the frozen decision. What changes is who can reach the page:
anyone who can reach that address and has the link can act on it. The page is
plain HTTP, so keep it inside a private network or a VPN, never on a public
interface or behind port forwarding. If that is too much, leave
`confirmation_page` out or use `tty-only`.

`accept` is the other end of that lifecycle. It requires a run that is waiting
for a human with a passed HANDOVER gate, and it refuses while a job is still
running. It copies the finished run into `.loop/history/<item>-<timestamp>/` —
state, work item, authorization, the list of evidence records, a next-steps note
and an acceptance record — and then promotes the next backlog item into a fresh
`state.json`. That new state is PAUSED in phase DEFINE at round 0 with all gates
pending, keeping the round, retry, wall-clock and autonomy caps of the previous
run. Acceptance never starts the next item; a person still does that. If the
backlog is empty, the accepted item is left with run status COMPLETED.

`check` reads all of this in one call and changes nothing. Its `handover_ready`
field only means "there is something for a person to look at". It is not a claim
of success. Verified success is a recorded REVIEW verdict of PASS together with
a passed VALIDATE gate, and `check` reports the verdict separately as
`judge_verdict` so the two are never confused. On the command line `check` exits
0 when a handover is waiting or the run is finished, 3 while the run is not
done, 4 when it is blocked, and 2 on an error, so a script can branch on it.

The Bash orchestrator reads the same files, so `engine/orchestrator.sh status`
reports the same backlog counts and the same authorization record.

## Running on a cadence

A cadence loop is a timer that calls one operation, `tick`, again and again.
Each tick looks at the recorded situation and does at most one thing:

1. a managed job is already running or queued — it only reports;
2. the run is RUNNING — it advances one node, or `max_nodes` of them;
3. the run is BLOCKED, or waiting for a human with a passed HANDOVER gate — it
   only reports. A run that is WAITING_FOR_HUMAN while the HANDOVER gate is still
   PENDING has not written its handover yet; that is work, not a wait, so the
   tick runs that node under the same authorization checks as any other;
4. the run is PAUSED or COMPLETED and a person authorized the item as READY and
   that authorization has not expired — it starts the item through the same path
   as `start`, which copies the authorized budget into `state.json` and records
   the authorization in `.loop/control/current-job.json`, and runs one node.
   When the current item is COMPLETED, the first READY item of the backlog takes
   its place first; a paused item is never promoted and never started;
5. otherwise it does nothing.

The result is `{"action": "ran-node" or "started" or "reported" or "nothing",
"reason": "..."}` followed by the whole `check` output, and the command line
exits 0 in every one of those cases. Exit 2 means the call itself failed.

**A tick never grants approval.** Only an item a person authorized as READY can
ever start, only within its recorded scope, budget and expiry, and an expired
authorization is refused rather than ignored. Continuing is bound to the same
decision: if the current item has an authorization sidecar, it must still be
READY and unexpired at the moment of the launch, otherwise the tick reports
`authorization-revoked`, `authorization-expired` or `authorization-invalid` and
starts nothing. A run a person started by hand, with no sidecar at all, may
continue. Acceptance, scope changes and external actions stay human-only however
often the timer fires.

Two ticks cannot overlap: the first writes `.loop/scheduler/tick.lock` with a
fenced id, its process id and a timestamp, and a second one reports
`{"action": "reported", "reason": "tick-in-progress"}`. The lock is written to a
private name and then linked into place, so no tick ever sees a half-written one.
A lock is reclaimed only when it is provably not protecting anything: its
recorded owner process is gone, or nothing readable was ever written and the file
is older than the run's own `max_wall_seconds`. Elapsed time alone never removes
a live owner, and the file is deleted only while it is still byte-for-byte the
one that was examined. The whole inspect-remove-acquire sequence runs under an
exclusive recovery guard directory, `.loop/scheduler/tick.reclaim.lock.d`, so two
reclaimers can never examine the same old lock and unlink each other's
replacement; a guard older than a minute belonged to a process that died holding
it and is itself treated as stale.

**Scheduler state lives outside the protected set.** `tick.lock`, `tick.log`,
`scout.log`, `inbox.log`, the pending confirmation requests, receipts, results
and their runtime files are all under `.loop/scheduler/`, never under
`.loop/control/`. The supervisor snapshots every file under `.loop/control` and
`.loop/evidence` before a provider node and compares them afterwards; a change
there is treated as the provider tampering with runner-owned metadata and
quarantines the run. A reporting tick during a running node writes its log line
and must not do that, which is why the scheduler has a directory of its own. Every tick appends one line to `.loop/scheduler/tick.log`
with the UTC time, the action, the reason, the item, the phase and the run
status. If the authorization says `stop_on_first_failure` and a gate has failed,
the tick puts the run into BLOCKED and reports `stopped-on-first-failure`
instead of retrying it. Budgets are the engine caps already copied into
`state.json`; the cadence adds no second counter.

The incantations below are examples for today's clients. **The slash-command
syntax of a client can change; check that client's own documentation** if one of
them is not recognised.

### Claude Code — `/loop`

Repeat a prompt on a timer while the session is open:

~~~text
/loop 30m
Run `build-loop tick --root /absolute/project` and report the action, the
reason, the run status and the phase from its JSON. Do not start, accept, or
authorize anything else.
~~~

The loop lives only as long as that session is open. Closing the session stops
the cadence; nothing is scheduled on the machine.

### Claude Code — `/schedule`

`/schedule` creates a cloud routine that runs whether or not a session is open:

~~~text
/schedule every day at 09:00
Run `build-loop tick --root /absolute/project` and report the action and the run
status from its JSON.
~~~

Scheduled routines have a minimum interval, typically one hour, so use `cron`
for anything more frequent. A routine also only reaches a project it can
actually open.

### Codex Automations

Create an automation whose prompt runs the CLI:

~~~text
Run the shell command:
build-loop tick --root /absolute/project --input '{"max_nodes":1}'
Report the action, the reason and the run status from the JSON it prints. Do not
authorize or accept anything.
~~~

### cron

~~~text
*/30 * * * * cd /absolute/project && build-loop tick --root /absolute/project >> .loop/control/tick-cron.log 2>&1
~~~

Send the scheduler's own output to a **separate** file, as above. `tick` already
appends its own structured line to `.loop/scheduler/tick.log`; redirecting the
JSON printed on stdout into that same file would append a second, differently
shaped record after it, and everything that reads the last line of the tick log —
`status`, `check` and the dashboard tile — would then read that JSON as the last
tick. `.loop/control/tick-cron.log` is scheduler noise you can rotate or delete;
`.loop/scheduler/tick.log` is the record.

`cron` starts with a minimal environment: use absolute paths for `build-loop`,
`node`, `git`, `jq` and the provider CLI, or set `PATH` in the crontab.

### Claude Desktop

With the project-bound MCP server installed, call the tool from the chat:

~~~text
Call loop_tick and tell me the action and the run status.
~~~

Some clients can repeat that themselves; ask for it in plain words, for example
"call loop_tick every 30 minutes and tell me when the action is not nothing".
If the client cannot, use `cron` or a scheduled routine instead.

## Scouting for work

A scout answers a different question from the other loops: not "how far is this
item", but "is there anything here worth doing at all". `scout` sends the
configured provider through the project once and asks it for proposals.

It looks for the same things in every project — tests that fail, are skipped or
are missing, TODO and FIXME markers that stand for real unfinished work, and
dependency or manifest drift — plus what fits the project profile: drift between
a declared contract and its implementation for an `api` profile, documentation
gaps for a `docs` profile. The profile comes from `project_kind` in the project
adapter unless you pass one. The brief also carries the titles already in the
backlog, so the scout does not propose them again, and the content of
`.loop/notes/next-steps.md` when a previous run left that note.

**Containment.** Only a bundled provider wrapper is executed: the wrapper shipped
for that host, or the one `configure` generated around it and recorded in the
signed machine-local host configuration. That matters, because a program started
with your own privileges can write to any absolute path whatever its working
directory is — a disposable copy alone contains nothing. Containment rests on
those bundled wrappers selecting read-only tooling: Claude gets `Read`, `Glob`
and `Grep` with an explicit deny list, Codex runs in its read-only sandbox.

On top of that the provider never sees the real project. It runs in a disposable
copy without the repository history and without the loop's own control
directory, with a clean environment limited to the adapter's allowed names, and
with a home and temporary directory inside that copy. The copy is removed
afterwards whatever happened. A scout refuses while a
managed job is running, and it never touches the backlog, `state.json`, or a
run. One JSON line per run is appended to `.loop/scheduler/scout.log`.

**Proposals are inert.** Each proposal is written to
`.loop/inbox/<proposal-id>.md` from the shipped work-item template, with the
outcome, the constraints the scout saw a reason for, and its evidence pointers,
under a header saying which provider proposed it and when.
`.loop/inbox/index.json` lists what is waiting, and that list is what `check`
and `status` count as the inbox. Nothing acts on a proposal by itself: it
becomes work only when a person calls `promote`, which writes the work item
through the same path as `backlog_add` and appends it to the ordered backlog —
still unauthorized, still not started. `discard` takes it out of the index and
moves the file to `.loop/inbox/discarded/`; a promoted file is kept under
`.loop/inbox/promoted/`. Both record the channel the decision came through.

On the command line:

~~~bash
build-loop scout --root /absolute/project --input '{"provider":"claude"}'
build-loop inbox_list --root /absolute/project
build-loop promote --root /absolute/project --input '{"proposal_id":"P-20260907T101530Z-1"}'  # asks for confirmation
build-loop discard --root /absolute/project --input '{"proposal_id":"P-20260907T101530Z-2"}'
~~~

Without `provider` the scout uses the provider configured for the project in its
signed machine-local host configuration, as long as that is the bundled wrapper
for the host or the wrapper `configure` generated around it; anything else falls
back to the bundled wrapper. A scout runs no other executable, and there is no
way to pass one.

Over MCP the same four operations are `loop_scout`, `loop_inbox_list`,
`loop_promote` and `loop_discard`. In a chat client, "scout this project and
show me what came back, do not promote anything" is enough; read the proposals,
then promote the ones you want and discard the rest.

## Memory between cycles

Each cycle ends with one small note, `.loop/notes/next-steps.md`. The loop writes
it when a run reaches HANDOVER: the Bash orchestrator writes it after the gate
and its evidence are recorded, and the control layer writes the same note when a
managed job comes to rest at a passed handover or when `handover` acknowledges
one. Both read the same files, so both leave the same note.

It holds what the next cycle would otherwise have to reconstruct: the work item
and the run ids, a summary (rounds used, the result of every gate, the review
verdict, how many gates had to be reworked, how many blockers are open), three
priorities read out of that evidence, the first item waiting in the backlog, and
the evidence ids of the last round. Nothing else: no secrets, no machine paths.

**The note is advisory.** It is not an approval, it does not widen the scope of
any node, and nothing in the loop reads a decision out of it. Acceptance,
authorization and every external action stay human decisions, exactly as before.

The next DEFINE brief carries it under the heading "Previous cycle notes
(advisory)", and every scout brief carries it too, so the next cycle starts from
what the last one saw. `accept` copies the note as it stands into
`.loop/history/<item>-<timestamp>/next-steps.md` and leaves the live note where
it is: it belongs to the project, and the next DEFINE reads it there. A run that
never wrote a note leaves a short record of the acceptance in history instead.

## Integrate with automation

Use JSON results, project-unique request IDs, explicit maximum-node bounds, and
status polling with backoff. Reuse a request ID only for an exact retry of the
same operation and bound. Automation may inspect, prepare, start already
authorized work, and report blockers within its scope. It must not synthesize
human approval, auto-answer a decision, or treat HANDOVER as permission to
publish.

Keep the shell scripts available for existing automation. Their direct modes
remain documented in [ORCHESTRATOR.md](ORCHESTRATOR.md).
