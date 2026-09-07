# Loop Modes

Two independent settings shape a run: `work_kind` (what kind of work item this is) and `run_mode` (how much of the loop one call executes).

## work_kind

| Choice | Value | Focus |
|---|---|---|
| Feature | `feature` | New behavior and regression coverage |
| Bug fix | `defect` | Reproduce the failure and verify the fix |
| Refactoring / maintenance | `maintenance` | Preserve behavior and compatibility |
| Documentation | `documentation` | Reader needs, examples and links |
| Research | `research` | Evidence, alternatives and limitations |
| Migration preparation | `migration` | Compatibility, rollback and disposable rehearsal |

Pass this field to `prepare` for the first item or `task` after a completed
handover. To choose visually, ask chat to show [the dashboard](DASHBOARD.md).
The selector generates a request to use in chat and never changes a running item.

Supported values: `feature` (default), `defect`, `maintenance`, `documentation`, `research`, `migration`.

`work_kind` sets the kind recorded on the work item and selects the guidance the worker receives for that kind. It does **not** write acceptance criteria for you, and it does **not** unlock shortcuts past verifiers or review. Every kind runs the same six phases and the same mandatory independent review.

- `research` produces a report. The report is reviewed and validated like any other output — it is not exempt.
- `migration` covers **preparation only**. A migration run has no authority over live systems: it plans, writes, and verifies migration material; it does not execute against them.

## run_mode

| `run_mode` | Nodes executed |
| --- | --- |
| `step` | at most 1 node |
| `bounded` | at most `max_nodes` nodes, default 12 |

`max_nodes` may be set explicitly in the range 1..500. Combining `run_mode: "step"` with `max_nodes` greater than 1 is a conflict and is rejected.

Neither mode is unlimited, and neither starts an independent new workflow — both advance the current work item only. Completing the nodes in a job means **that job** finished; it does not mean the task was handed over. Handover is a separate, explicit event.

### Where run_mode applies

The Node/MCP tools `start`, `run`, and `resume` all accept `run_mode`.

```json
{
  "request_id": "2026-09-07-wi1042-01",
  "run_mode": "bounded",
  "max_nodes": 12
}
```

```json
{
  "request_id": "2026-09-07-wi1042-02",
  "run_mode": "step"
}
```

**`request_id` rules.** Each distinct request needs its own unique `request_id`. Re-sending the same `request_id` with the same arguments is an exact retry and returns the original result instead of starting new work. After a dropped connection, call `status` with the returned `job_id` (or no argument for the current job) rather than issuing a fresh one — that is what prevents duplicate runs.

## Shell orchestrator

- `orchestrator.sh run` executes one node.
- `orchestrator.sh loop --max-nodes 12` executes up to 12 nodes of the same work item.

See [the shell guide](SHELL-ORCHESTRATOR.md) for full commands. These names differ
from the Node/MCP operations, where the bounds come from `run_mode` or `max_nodes`.

For review you can use the same provider in a fresh, independent review session, or a different provider entirely. Both satisfy the independent-review requirement; neither lets a run review itself in place.

Mock mode replays **known fixtures only**. It does not implement arbitrary projects, so a passing mock run is not evidence that a real project works.

## Sequencing and state

- Start a new task only after the previous task's handover has been acknowledged.
- Do not overwrite loop state, and do not instruct users to. If state looks wrong, stop and inspect it.
- Do not edit run metadata directly; change it through the tools.

## Interrupting and resuming

`pause` requests a pause; `cancel` requests cancellation at the next node boundary. Activation jobs cannot be paused or cancelled through these operations. When the loop raises a blocker question, record the human’s actual response using `answer` / `loop_answer` (which writes the structured sidecar), then use `resume` — the same `run_mode` rules apply to the resumed run.

## autonomy vs run_mode

An `autonomy` field exists, but it does not reliably select the operational run mode. Always set `run_mode` explicitly.

## Prompts

Keep user-facing prompts in ordinary language. Describe the work plainly; the mode fields carry the control settings.
