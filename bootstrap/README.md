# Bootstrap protocol

Bootstrap is outside the work-item loop and remains supervised. Before the
interview, `recommend.sh` performs a bounded read-only scan of safe file names
and allowlisted manifest fields. It prints labeled suggestions but never runs a
discovered project command. Ordinary suggestions can be accepted with Enter;
inferred command arrays require the literal `USE-RECOMMENDED`. Platforms and
the negative control remain manual.

Run `./bootstrap/init.sh /path/to/target` to conduct the interview and write
`.loop/candidate/project.adapter.json`, `.loop/candidate/state.json`, recorded
answers, structured recommendation provenance, and an activation checklist.
Existing candidates are not overwritten.
The script requests exact argv arrays and records environment variable names,
never values. It does not run project commands, copy candidates to active names,
or change state from `PAUSED`.

The template checkout must be completely clean. The initializer binds itself,
the recommendation helper, and the reference engine to the current Git `HEAD`;
modified tracked files or any untracked files make initialization stop.

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

The version `0.1.0` reference control plane uses Bash 3+, jq, Git,
Perl, and standard Unix command-line utilities. Pin the complete protocol and
engine repository to an immutable release or Git revision; pinning only this
initializer is insufficient.
