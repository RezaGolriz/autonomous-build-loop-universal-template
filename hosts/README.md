# Host adapters

Host adapters translate one bounded node into a Codex or Claude invocation.
They never select lifecycle transitions, run project verification, or certify
their own result. The reference engine's process capture, repository delta and
nonce-bound verdict validation are the trust anchor.

The JSON files here describe required capabilities, not executable command
lines. Bootstrap must discover and confirm the locally installed CLI flags;
hard-coding fast-moving host flags into the workflow kernel is forbidden.
