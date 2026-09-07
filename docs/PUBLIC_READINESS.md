# Release readiness

This page records the scope of the release checks. It is not a guarantee that a
repository, a model, or a generated project is free of every defect.

## Publication gates

| Gate | Current result |
| --- | --- |
| Shared control implementation and shell compatibility | Passed; existing shell entrypoints retained |
| Unit, integration, and clean Linux environment tests | Passed: 43 Node tests and 106 shell assertions; final control fix rechecked on macOS and Linux |
| Packaged Codex and Claude Desktop entrypoints | Package validators, offline npm install, CLI and real MCP protocol tests passed; Desktop UI install unverified |
| Independent Claude code review | Scoped setup, transport, packaging, engine and job reviews passed after corrections |
| Current tracked content and reachable history review | Current text has no heuristic matches; historical author metadata requires an owner decision |
| Open-source license | Owner selection pending; no open-source license granted yet |
| Public release | Blocked by license and historical attribution decisions |
| Existing private remote | Owner explicitly requested the current implementation be committed and pushed; visibility stays private |

## Privacy review method

`node tools/audit-public.mjs --history` checks working-tree publication inputs,
all locally reachable commit metadata and messages, and reachable Git blob
contents. It reports categories and locations without printing matched secret
values. Its patterns cover common credential formats, personal home paths,
private network addresses, private hostnames, contact addresses, and sensitive
filenames. Optional private literal patterns can be supplied from a file outside
the repository using `--patterns /path/to/private-patterns.json`.

The audit also lists binary files that were not text-scanned. A clean pattern
result still requires human review of configuration, examples, logs, attribution,
and the files selected for publication. The audit does not inspect remote
forks, cached pages, unreachable objects, or external Git LFS storage.

Generated state, local host configuration, private audit details, dependency
folders, packages, and debug output must stay outside the publication set.
Package assembly uses an explicit input list instead of archiving a checkout.

## Historical attribution

Personal author metadata was found in eight of the 22 historical commits reviewed. The private details
and proposed cleanup procedure are kept outside this repository. The owner must
either explicitly accept public attribution or authorize a scoped history
cleanup. Such a cleanup needs a private backup, tree-content verification, and
an exact remote lease. A normal code-update request does not authorize a blind
force push. Public tool co-author attribution is retained.

## Evidence boundaries

A protocol test exercises the MCP server, not the Claude Desktop application.
A manifest check validates package structure, not host permissions or user
experience. Fake-provider tests prove deterministic engine behavior, not a live
model's output. Disposable setup probes separate project files and process
environment; they are not an operating-system or network sandbox.

See [Validation](VALIDATION.md) for the final commands and measured results.
