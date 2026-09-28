# Example: two documentation packages

Imagine maintaining two guides: **getting started** and **troubleshooting**.
They are independent tasks, so they can be worked on together. Each uses a
separate folder and keeps its own review and validation.

![Two isolated packages share one supervisor](../../docs/assets/team-workflow.svg)

## Try it through chat

Use a separate, disposable parent folder and ask:

> Prepare a Build Loop team demonstration with two documentation packages,
> getting-started and troubleshooting. Use separate empty demo workspaces and
> the mock worker. Allow two active packages. Show every proposal, scope and
> budget. Give me the approval links and wait for me to complete them. Do not
> publish or modify my real project.

The assistant uses `team_configure` and `team_authorize`, then `package_add`
with `prepare: true` for each package. For each registered package it calls
`package_control` with operation `demo` and input `{"kind":"docs"}`.
This produces the existing paused documentation demonstration: it does not
start an agent. The mock team uses the fixture configuration in
[the supervisor test](../../tests/supervisor.test.mjs).

You approve the team, each setup and each work authorization personally. The
assistant activates approved setups, then starts the supervisor with at most
12 nodes per package. A full progress bar means the workflow gates passed;
it is not approval of the documents or proof that a real model wrote them.

At the end, ask:

> Show the two package handovers, evidence and overall dashboard progress.
> Explain what was tested. Do not accept, merge or publish anything for me.

## What the automated example checks

A maintainer can run the same bounded demonstration with test-only human
fixtures:

```bash
node --test tests/supervisor.test.mjs
```

The test creates fresh temporary folders and a separate temporary trust store.
It does not open or submit a human confirmation URL. Fixture approvals are
internal test data, never an approval route available through MCP.

The two-package test checks actual concurrent child jobs, idempotent reconnect,
separate state and evidence for all six gates, mandatory handover waiting and
unverified acceptance/integration. It uses the bundled mock provider and the
existing documentation verifier. It checks orchestration, not AI editing quality.

## Then try real agents

Choose API models and their data scopes explicitly, enter credentials only in
local sensitive settings, and prepare new approvals for that changed team and
each child. Run one package first, review the actual changed guide and its
checks, then increase concurrency to two. API fixture tests do not replace
this live quality check. Native Desktop agent UI behavior is a separate check.

For a concrete code task, use [the Notes and CSV practice project](../team-project/README.md).
It has a passing baseline, a deliberately failing check, and two independent
changes that your selected builder and reviewer can work on in separate copies.

## CLI alternative

The shared Node CLI exposes the same operations:

```bash
node /absolute/package-root/bin/build-loop.mjs package_list --root /absolute/demo-parent --json
node /absolute/package-root/bin/build-loop.mjs supervisor_status --root /absolute/demo-parent --json
```

For operations with input, ask the assistant to prepare a JSON file and use
`--input /absolute/input.json`. The original single-root shell demonstration
also remains available: [five-minute dry run](../../docs/examples/loops/dry-run.md).
