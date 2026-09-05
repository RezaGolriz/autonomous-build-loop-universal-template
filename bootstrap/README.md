# Bootstrap protocol

Bootstrap is outside the work-item loop and remains supervised.

Run `./bootstrap/init.sh /path/to/target` to conduct the interview and write
`.loop/candidate/project.adapter.json`, `.loop/candidate/state.json`, recorded
answers, and an activation checklist. Existing candidates are not overwritten.
The script requests exact argv arrays and records environment variable names,
never values. It does not run project commands, copy candidates to active names,
or change state from `PAUSED`.

1. Run the initialization interview in `template/INITIALIZATION.md`. Explicitly
   ask the human for project shape, programming language or `none`, runtime and
   version, build/package tools, authoritative checks, supported platforms and
   artifact/delivery form. Never silently select these from repository files.
2. Inventory the repository, invariants and available agent hosts without
   running guessed commands or reading secrets. Discovery may propose answers
   to the interview, but the human must confirm or replace them.
3. Select one project-shape profile and generate a candidate project adapter
   from the confirmed technology choices. Technology recipes, if any, are
   proposal helpers only.
4. Have a human confirm commands, protected paths, environment variable names,
   evidence requirements and external-effect boundaries.
5. Validate every candidate against the strict schemas and run the conformance
   suite.
6. Run a safe negative control proving a failing command cannot pass.
7. Smoke-test every enabled host against the same paused state and compare the
   proposed next node.
8. Pin the engine/protocol repository by immutable revision. Materialize only
   target-owned `.loop/` configuration and work items from `template/`, remove
   `.example` suffixes only after replacing all placeholders, take the baseline
   snapshot, and activate the first work item in `supervised` mode. An offline
   engine snapshot must record `VERSION`, source revision and an upgrade check.

Never auto-detect and execute a command in the same step. A missing tool,
unknown schema version, placeholder, empty protected set, failed negative
control or host mismatch blocks activation.

The v1 reference control plane is version `0.1.0` and uses Bash 3+, jq, Git,
shasum, find, awk, grep, and Perl on a Unix-like host. Pin the complete protocol and
engine repository to an immutable release or Git revision; pinning only this
initializer is insufficient.
