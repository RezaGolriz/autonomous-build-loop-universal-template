# Universal Build Loop host instructions

Use the Universal Build Loop as a bounded worker or independent reviewer. The
active work item is product truth. The contract, canonical workflow, schemas,
active project adapter, durable state, and current node brief define process
truth.

In Claude Desktop, repository files and this CLAUDE.md provide instructions but
not an executable bridge. Use the project-bound local MCP extension for control
operations. Its project root is fixed by user configuration. Do not infer that
the root was discovered automatically and do not attempt to override it in a
tool call.

For a new project connection:

1. inspect the project and run the control doctor;
2. prepare a setup proposal without executing target commands;
3. show profile, commands, paths, evidence, provider choices, and activation
   probes in one local confirmation view;
4. use the dedicated no-argument approval tool, show its local URL, and wait
   while the human opens and approves it; never fetch or submit that URL;
5. activate only when strict validation, the positive probe, and the
   known-failing negative probe succeed in a disposable copy.

The disposable copy is not an operating-system sandbox. Probe commands retain
the current user's permissions. Do not approve or run a probe with publication,
deployment, migration, production-device, secret, or destructive effects.

During a work item, execute exactly one node or execution slice. Change only
allowed paths and preserve frozen, protected, workflow, engine, schema, and
prior-evidence paths. If a required decision or capability is absent, return a
blocker.

The fixed phases are:

~~~text
DEFINE → DESIGN → EXECUTE → REVIEW → VALIDATE → HANDOVER
~~~

Review must use a fresh independent context. It receives the work-item
contract, exact durable change, applicable runner evidence, and review
challenge; it must not use the builder's private reasoning as proof. Validation
must satisfy the selected profile. Missing tools, evidence, environments, or
authority are blockers.

Use durable job IDs for bounded asynchronous work. After a reconnect, inspect
the existing job before starting anything new.

Beyond a single run: `loop_check` is a read-only situation report, and its
`handover_ready` field means there is something for the human to look at, not
success. Queue work with `loop_backlog_add`, `loop_backlog_list`, and
`loop_backlog_remove`. `loop_accept`, `loop_authorize`, and `loop_promote` are
human decisions and none of them completes here: each returns
`pending_confirmation` with a `confirmation_url` for a local page bound to that
operation, that item, and the fully resolved decision frozen at that moment. The
human types ACCEPT, AUTHORIZE or PROMOTE into a field on that page. Hand the link
to the human, say what confirming it would do, and wait; never open, follow, or
submit it yourself. A decision that no longer matches what was frozen is refused
as `CONFIRMATION_STALE`. The record then keeps the channel `local-http-user` with
the assurance `local-user-action`, which means a person with access to that
machine did it and is not proof of who. A project set to `tty-only` in
`.loop/control/policy.json` returns `CONFIRMATION_TTY_ONLY` with the exact
terminal command instead; report it and do not work around it. `loop_deauthorize`
completes directly and also places a project-wide hold: while
`.loop/control/hold.json` exists, `loop_start`, `loop_run`, `loop_resume`,
`loop_tick`, `loop_task` and `loop_scout` are refused with `PROJECT_ON_HOLD` for
everything but a person at an interactive terminal, so writing a new work item is
no way around it. `loop_cancel` and `loop_handover` keep working. `loop_hold`
places one from any channel; only `loop_release`, with the typed word `RELEASE`,
takes it off. Never work around a hold. `loop_tick` is one cadence step: it reports, advances one
node, or starts an item the human already authorized as READY within its recorded
scope, budget, and expiry; it never starts a paused, expired, or invalid item,
and it stops continuing a run whose authorization was revoked, expired, or does
not validate. An authorization also bounds paths: slice paths and changed files
stay inside its `scope.allowed_paths`. `loop_scout` runs a bundled provider
wrapper read-only in a disposable copy and writes proposals into the inbox, and
no other executable can be named; read them with `loop_inbox_list`, and never
promote or discard one on your own initiative.
A run reaching HANDOVER leaves an advisory note in `.loop/notes/next-steps.md`
that later briefs carry along; it approves nothing and widens no scope.
Acceptance, authorization, scope expansion, protected-path exceptions, and
external actions are never automatic.

Never edit or delete `.loop/quarantine.json` or runner-owned metadata to force
progress. Provider-time metadata changes block start, resume, and run until exact
restoration. The trusted answer operation may recover only an
answer-sidecar-only quarantine; pause and cancel remain available.

Handover never authorizes merge, publication, release, deployment, migration,
destructive work, secret access, or another external action. Request the
necessary scoped human authority separately.
