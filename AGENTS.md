# Universal Build Loop instructions

The product truth is the active work-item specification. The process truth is
core/CONTRACT.md, core/WORKFLOW.md, and the strict schemas under spec/schemas/.

When a user starts from chat, inspect the bound target and run the control
doctor before proposing work. If active configuration is absent, prepare one
concrete setup proposal without executing target commands. Show the exact
profile, commands, protected paths, environment variable names, evidence
requirements, provider choices, and positive and negative probes. Use the local
approval flow for that bound proposal before conditional activation.

Do not ask for typed hashes and do not translate ordinary chat agreement into a
generic confirmed flag. Call the approval-request operation, present its local
URL to the human, and stop there. Never fetch that URL or submit its form.
Approval of a proposal does not authorize a later changed proposal. Copied
activation probes run with the current user's
privileges; inspect them for external effects because the disposable copy is not
an operating-system sandbox.

Before changing target-project artifacts:

1. Read the project adapter, active work item, durable state, and node brief.
2. Discover the actual target technology and repository conventions.
3. Change only declared allowed paths. Preserve frozen and protected paths.
4. Execute exactly one node or execution slice.
5. Record only checks actually performed and accept only runner-owned evidence.
6. Use the blocker mechanism when a required decision, capability, or authority
   is absent.

The fixed phases are DEFINE, DESIGN, EXECUTE, REVIEW, VALIDATE, and HANDOVER.
Review is fresh, independent, and mandatory. Validation uses the evidence
requirements declared by the selected profile and active project adapter.

Long operations use bounded durable jobs. Return the job ID, inspect existing
status after a reconnect, and do not start a duplicate merely because the prior
chat is unavailable. Time, retry, and round limits block rather than pass.

Beyond a single run: `check` answers "where does this stand" and changes
nothing; its `handover_ready` field means there is something to look at, not
success. `backlog_add`, `backlog_list`, and `backlog_remove` keep the queue.
`accept`, `authorize`, and `promote` are human decisions and complete in only two
ways: the literal word ACCEPT, AUTHORIZE, or PROMOTE typed at an interactive
terminal, or the same word the human types into the field on a local
confirmation page. From an input file or a tool call they complete nothing and
return a `confirmation_url` bound to that operation, that item, and the fully
resolved decision frozen at that moment; hand the link over and never open it
yourself. A decision that no longer matches what was frozen is refused as
`CONFIRMATION_STALE`. The record then keeps the channel `local-http-user` with
the assurance `local-user-action`, which means a person with access to that
machine did it and is not proof of who. A project set to `tty-only` in
`.loop/control/policy.json` refuses those calls with `CONFIRMATION_TTY_ONLY` and
the exact terminal command; report it and do not work around it. `deauthorize` completes directly and also places a
project-wide hold: while `.loop/control/hold.json` exists, `start`, `run`, `resume`, `tick`, `task` and `scout` are refused
with `PROJECT_ON_HOLD` for everything but a person at an interactive terminal, so a new work item is no way around it.
`cancel` and `handover` keep working. `hold` places one from any channel; only `release`, with the typed word `RELEASE`,
takes it off. Never work around a hold. `tick` is one cadence step:
it reports, advances one node, or starts an item a human already authorized as
READY, within its recorded scope, budget, and expiry; it never starts a paused,
expired, or invalid item, and it stops continuing a run whose authorization was
revoked, expired, or does not validate. An authorization also bounds paths: slice
paths and changed files stay inside its `scope.allowed_paths`. `scout` runs a
bundled provider wrapper read-only in a disposable copy and writes proposals into
the inbox, and no other executable can be named; read them with `inbox_list`, and
only a human confirms turning one into work with `promote` or drops it with
`discard`. A run reaching HANDOVER
leaves an advisory note in `.loop/notes/next-steps.md` that later briefs carry
along; it approves nothing and widens no scope. Acceptance, authorization, scope
expansion, protected-path exceptions, and external actions are never automatic.

Never edit or delete `.loop/quarantine.json` or runner-owned metadata to force
progress. Provider-time metadata changes block start, resume, and run until exact
restoration. Use answer recovery only when the controller confirms that every
changed path is an answer sidecar; pause and cancel remain available.

Never weaken a gate, treat worker prose as proof, expose secrets, discard
unrelated work, merge, publish, release, deploy, migrate, perform destructive
work, or otherwise change external state without authority required by the
contract.

The Node CLI, Codex skill, MCP server, and shell scripts are interfaces to one
control model. They do not redefine gates. The Codex skill may use the bundled
CLI directly; optional MCP setup must bind an explicit project root and must not
claim automatic root discovery.

Legacy bootstrap/init.sh writes only paused candidate configuration. Its manual
activation still requires human review, strict validation, a meaningful
known-failing negative control, and an immutable engine pin.
