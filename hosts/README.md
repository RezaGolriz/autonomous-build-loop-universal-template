# Host adapters

Host adapters translate one bounded node into a Codex or Claude invocation.
They never select lifecycle transitions, run project verification, or certify
their own result. The reference engine's process capture, repository delta and
nonce-bound verdict validation are the trust anchor.

The JSON files here describe required capabilities, not executable command
lines. Bootstrap must discover and confirm the locally installed CLI flags;
hard-coding fast-moving host flags into the workflow kernel is forbidden.

## Provider contract

A provider is any executable started by `engine/orchestrator.sh` with the project
root as its working directory, a JSON brief on stdin, and a minimal environment:
the adapter's `allow_names` plus `LOOP_ROOT`, `LOOP_PHASE`, `LOOP_RUN_ID`, and
`LOOP_WORK_ITEM`. The brief contains the node fields from
`spec/schemas/node.schema.json` and a `prompt` string with the full instructions.
For REVIEW it also contains the engine review challenge's `run_id`,
`work_item_id`, `nonce`, `revision`, and `evidence_refs`.

Provider stdout must be exactly one JSON document. For DEFINE, DESIGN, EXECUTE,
VALIDATE, and HANDOVER it is
`{"schema_version":1,"status":"DONE"|"BLOCKED","defect_class":null|"requirement"|"design"|"artifact","blocker":null|"<text>","notes":"<text>"}`.
For REVIEW it is a verdict conforming to `spec/schemas/verdict.schema.json`,
with `independent=true`, echoing the challenge's `run_id`, `work_item_id`,
`nonce`, `revision`, and `evidence_refs`. Anything else on stdout is a failure.
Stderr is captured in logs and never parsed. Providers exit non-zero on every
error. REVIEW always starts a fresh process, and its brief never contains prior
agent output.

## Choosing the host

Use `--host claude --provider hosts/claude/provider.sh` or
`--host codex --provider hosts/codex/provider.sh`. The mock provider
`hosts/mock/provider.sh` is for tests. Cross-agent review: add --review-host
codex --review-provider hosts/codex/provider.sh (or the claude pair) to run or
loop; every REVIEW node then uses that provider while all other phases use
--provider.
