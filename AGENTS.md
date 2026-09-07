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
