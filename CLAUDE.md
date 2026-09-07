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

Never edit or delete `.loop/quarantine.json` or runner-owned metadata to force
progress. Provider-time metadata changes block start, resume, and run until exact
restoration. The trusted answer operation may recover only an
answer-sidecar-only quarantine; pause and cancel remain available.

Handover never authorizes merge, publication, release, deployment, migration,
destructive work, secret access, or another external action. Request the
necessary scoped human authority separately.
