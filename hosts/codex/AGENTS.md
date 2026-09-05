# Codex host adapter

Read the active workflow, state, node brief, project adapter and blockers.
Execute exactly one node in a fresh context. Change only `allowed_paths`; do not
change `frozen_paths`, protected paths, workflow, engine, schemas or prior
evidence. Propose artifacts, never a transition verdict. If a decision is
missing, record a blocker and stop.

For review, use a separate read-only context that receives the work-item
contract, exact durable delta and supervisor evidence, but not the executor's
reasoning transcript. Return a verdict matching `verdict.schema.json` and the
supervisor-issued nonce. Your own success statement is not evidence.
