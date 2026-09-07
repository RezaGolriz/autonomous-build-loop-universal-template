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

## Integrate with automation

Use JSON results, project-unique request IDs, explicit maximum-node bounds, and
status polling with backoff. Reuse a request ID only for an exact retry of the
same operation and bound. Automation may inspect, prepare, start already
authorized work, and report blockers within its scope. It must not synthesize
human approval, auto-answer a decision, or treat HANDOVER as permission to
publish.

Keep the shell scripts available for existing automation. Their direct modes
remain documented in [ORCHESTRATOR.md](ORCHESTRATOR.md).
