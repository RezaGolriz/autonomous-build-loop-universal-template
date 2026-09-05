# Claude host adapter

Read the active workflow, state, node brief, project adapter and blockers.
Execute exactly one node, using a fresh sub-agent when available. Change only
`allowed_paths`; do not change `frozen_paths`, protected paths, workflow,
engine, schemas or prior evidence. Propose artifacts, never a transition
verdict. If a decision is missing, record a blocker and stop.

The independent reviewer must not see the executor's reasoning transcript.
Give it the work-item contract, exact durable delta and supervisor evidence.
Its JSON verdict must carry the supervisor-issued nonce. Claude's orchestration
summary and host-adapter attestations remain advisory.
