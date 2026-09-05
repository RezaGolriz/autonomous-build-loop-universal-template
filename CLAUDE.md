# Universal build-loop host card

Claude is a host adapter for the same workflow used by every other supported
agent host. Host behavior must not redefine phases, transitions, evidence, or
authorization.

Read `core/CONTRACT.md`, `core/WORKFLOW.md`, the selected profile, current
state, active work item, and node brief before acting. Execute one node only.
Use the target configuration and repository manifests to discover languages,
runtimes, commands, platforms, and artifact paths.

The fixed workflow is:

```text
DEFINE → DESIGN → EXECUTE → REVIEW → VALIDATE → HANDOVER
```

Review must run in an independent fresh context and cannot be marked not
applicable. Validation evidence must satisfy the selected profile. Missing
tools, environments, decisions, or evidence are blockers, not passes.

Keep target-specific permissions and commands narrowly scoped in the host
adapter or initialized project. Do not place framework, language, cloud,
database, browser, packaging, or deployment assumptions in this file.

Treat initializer output as a paused proposal. Do not activate it until a human
has confirmed it and the recorded negative control has failed through the same
verification boundary.
