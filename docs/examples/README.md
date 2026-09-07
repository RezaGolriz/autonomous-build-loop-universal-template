# Worked scenario recipes

These documents show how a project adapter and first work item could be shaped
for four different targets. They are illustrative recipes, not proof that every
listed stack, version, command, provider, or device was tested by this project.
The runnable repository fixtures are under tests/fixtures and are recorded
separately in [the validation matrix](../VALIDATION.md).

| Recipe | Target | Suggested stack | Profile |
|---|---|---|---|
| [Web shop](web-shop.md) | Static public shop with browser behavior | Astro, Vitest, Playwright | service |
| [JSON API](api.md) | HTTP API with an interface contract | Python, FastAPI, pytest, Schemathesis | api |
| [ESP32 firmware](esp32-embedded.md) | Firmware plus host-testable logic | PlatformIO, C++, Unity | other |
| [Web app](web-app.md) | Browser client with login and dashboard | React, TypeScript, Vite, Vitest, Playwright | desktop |

Choose commands that are authoritative for your actual repository. A similar
framework does not make a copied recipe correct.

## Common setup

1. Establish a working baseline in the target repository. Run its existing
   build and test commands by hand and preserve unrelated work.
2. Inspect, run doctor, and prepare a proposal with the first bounded work item.
   Preparation must not execute target commands.
3. Review the profile, exact argv commands, timeouts, artifacts, evidence kinds,
   protected paths, allowed environment names, providers, and probe plan.
4. Approve the displayed proposal through the local bound confirmation view.
5. Let activation run the positive and known-failing negative probes in a
   disposable copy. A missing verifier leaves the project in planning mode.
6. Start the prepared work item as a bounded job and follow status by job ID.
7. Answer blockers when needed, inspect the evidence-backed handover, and
   acknowledge it locally. Only then can task create another work item.

~~~mermaid
flowchart LR
    B[Working baseline] --> P[Prepared proposal]
    P --> A[Bound approval]
    A --> N[Positive and negative probes]
    N --> J[Prepared work item starts as bounded job]
    J --> H[Evidence-backed handover]
~~~

The Node entry point is:

~~~bash
node bin/build-loop.mjs OPERATION --root /absolute/project \
  --input /absolute/input.json --json
~~~

The shell entry point remains supported:

~~~bash
./bootstrap/init.sh /absolute/project
./engine/orchestrator.sh start --root /absolute/project
./engine/orchestrator.sh loop --root /absolute/project \
  --host codex --provider hosts/codex/provider.sh \
  --review-host claude --review-provider hosts/claude/provider.sh \
  --max-nodes 12
~~~

With the legacy initializer, follow its generated activation checklist instead
of treating this page as activation authority.

## Rules shared by every recipe

- Worker edits stay within the active execution slice's allowed paths.
- Frozen and protected paths cannot be changed to make the worker's own checks
  pass.
- Verification commands run with a minimal environment. Declare names, never
  secret values.
- Build and test output written inside the project needs an allowed output path.
- Reviewer diversity can help, but fresh independent context and challenge
  binding remain mandatory even when the provider names differ.
- Deployment, publication, payment, production-device flashing, migration, and
  other external effects happen only after a separate human decision.

Use each recipe's command and version values as a starting point to review, not
as defaults to accept automatically.
