# Validation record

This record describes the local implementation check on 2026-09-07. The release
commit contains this file; runtime checks use fresh temporary target projects.
A fixture pass does not prove a production target or a Desktop installation.

Final runtime-distribution fingerprint (the control layer's canonical hash):
`3f285a38949d625c235201b7f808b962a82002cdd92035a07014d77b835949db`.
Full shell suites passed before the last control-only fix; all Node suites,
including MCP end-to-end execution, then passed again against the final runtime.

## Automated checks

| Area | Check | Result |
| --- | --- | --- |
| Control, CLI, approval, MCP, packaging, docs and audit | `npm test` | 43 tests passed on macOS and clean Linux after the final review fix |
| Existing shell interface and engine safety | `npm run test:all` on macOS, Node 24.19.0, Bash 3.2 | Passed; 106 shell assertions across six suites |
| Fresh Linux environment | Pinned Node 22 Bookworm image, non-root user, `--network none`, no host mounts | Passed: full suite, then all 43 Node tests rerun after the final control fix |
| Documentation | Local links and JSON blocks | Passed |
| Source hygiene | `git diff --check` and Bash/Node syntax checks | Passed |

Shell counts: conformance 32, orchestrator 16, hardening 22, provider adapters 10,
bootstrap recommendations 21, dashboard 5. Shellcheck was not installed.

The MCP end-to-end test uses real stdio server processes. It prepares the docs
demo, records a test-only simulated human approval through the internal helper,
activates it, disconnects and reconnects, runs all six phases, acknowledges
handover, and creates the next work item. Production approval remains a human
browser or interactive-terminal action; the MCP API has no approval boolean.

## Packaging and live checks

- Official MCPB validator 2.1.2: package manifest passed.
- Codex Plugin Creator validator: bundled plugin passed.
- npm archive: installed offline in a fresh prefix; packaged CLI inspection from
  another working directory passed without changing the inspected target.
- Real Codex Sol and Claude Fable provider calls each completed one bounded
  VALIDATE scenario against a neutral local fixture. This is live adapter proof,
  not a full live autonomous project or review-cycle proof.
- Claude Desktop UI installation was not verified. App automation did not
  provide a usable installation flow. Protocol and package tests do not replace
  that evidence. No user app configuration or visibility setting was changed.
- Native Windows is unsupported and untested. It fails fast with
  `PLATFORM_UNSUPPORTED`. Windows via WSL2 has not yet been run on a real WSL2
  machine; the platform guard and the Windows-drive check are covered by
  `tests/platform.test.mjs` with simulated inputs only.

## Independent review

GPT-5.6 Sol agents implemented control, engine tests, and documentation in
isolated checkouts. The controller inspected and integrated their changes.
Claude Fable independently reviewed setup trust, MCP/packaging/onboarding,
engine hardening, and job coordination. Relevant findings were fixed and
follow-up reviews obtained. The final launch-failure fix passed its regression and Claude follow-up review;
no reviewed release blocker remains.

Findings included planted approval receipts, unsafe copy links, incomplete
candidate validation, activation publication races, retained child-process
pipes, unfenced job recovery, lost stop requests, and failed-launch cleanup.

## Earlier failures and limits

The first real Codex smoke rejected an output schema missing explicit types.
The adapter now emits the supported native schema subset; a later corrected
smoke passed. Another smoke was blocked because its prompt prohibited all tools
while requiring a file read; allowing the single required read resolved that
fixture error.

The first Linux run used root, which bypassed an unreadable-file test. The test
image now runs as its existing non-root user. A later Linux run exposed a jq 1.6
incompatibility in multiline parsing; the parser now uses inline regex flags.
These earlier runs were failures, not passes.

The web shop, API, browser app, and ESP32 examples are explained integration
recipes, not claims of live validation on those target stacks. The executable
repository demos cover documentation and a Python CLI.

## Publication

The current tree and all locally reachable history were scanned. Historical
personal attribution still needs an owner decision, and an open-source license
has not been selected. See [Public readiness](PUBLIC_READINESS.md). A push to the
existing private repository is not a public-release approval.
