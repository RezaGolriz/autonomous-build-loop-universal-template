# Orchestrator

`engine/orchestrator.sh` drives one work item through the fixed workflow. It
sequences; it never decides. Every gate decision, evidence record, review
challenge, verdict check, and state transition is performed by
`engine/reference-engine.sh`. The orchestrator only prepares node briefs, calls
a provider, and hands the results to the engine.

## Modes

| Mode | What it does |
|---|---|
| `start --root DIR` | Activates a `PAUSED` state (`RUNNING`, start time). Refuses missing files, a non-paused state, or a locked workspace. |
| `status --root DIR` | Prints phase, status, gates, legal next transitions, open blockers, and the last evidence ids as JSON. |
| `next --root DIR --host ID` | Prints the node brief for the current phase (schema `node.schema.json` plus a `prompt`). Calls no agent. |
| `run --root DIR --host ID --provider EXE` | Executes exactly one node: brief → provider → engine verification → engine transition. |
| `loop … --max-nodes N` | Repeats `run` until `WAITING_FOR_HUMAN`, `BLOCKED`, or `N` nodes. |
| `resume --root DIR` | Returns a `BLOCKED` run to `RUNNING` once every blocker in `.loop/blockers.md` is ticked. |

Required files under `DIR/.loop/`: `state.json`, `project.adapter.json`,
`workflow.json`, and `work-items/<work_item_id>.md`. Evidence goes to
`DIR/.loop/evidence/`; provider stderr is kept under
`.loop/evidence/<run_id>/logs/provider.stderr`.

## What happens per phase

- `DEFINE`, `DESIGN`, `HANDOVER`: the provider edits the work-item file. The
  orchestrator checks that the required sections are non-empty and that only
  allowed paths changed, then writes a `contract` or `documentation` evidence
  record with producer `orchestrator`.
- `EXECUTE`, `VALIDATE`: the provider produces the artifact; the engine `verify`
  mode runs the adapter commands, captures command evidence, and enforces
  allowed, frozen, and protected paths.
- `REVIEW`: the engine issues a nonce-bound challenge; a fresh provider process
  receives the contract, the exact `git diff`, the referenced evidence, and the
  challenge fields, and returns a verdict. The engine validates the verdict.
  The reviewer never sees the executor's output.
- After every node the engine `transition` mode moves the state: green on
  `PASSED`; on `FAILED` in `REVIEW` or `VALIDATE` the rework target follows the
  defect class; a failed `DEFINE`, `DESIGN`, or `EXECUTE` gate has no rework
  transition in the workflow and becomes a blocker (`BLOCKED`).
- `HANDOVER` has no engine gate; the orchestrator records it and leaves the run
  in `WAITING_FOR_HUMAN`.

A provider returning `status: BLOCKED` adds a line to `.loop/blockers.md` and
stops the run; a human resolves it and calls `resume`.

## Providers

See `hosts/README.md` for the provider contract. Included providers:

- `hosts/mock/provider.sh` — deterministic, for tests (`MOCK_SCRIPT` selects
  the behaviour per phase).
- `hosts/claude/provider.sh` — Claude Code CLI (`claude -p`).
- `hosts/codex/provider.sh` — Codex CLI (`codex exec`).

Executor and reviewer may be different agents: run the `REVIEW` node with a
different `--provider`.

## Try it with the mock provider

```bash
./tests/run-orchestrator.sh
```

The suite builds a Python CLI fixture, runs the whole happy path
(`DEFINE` → `HANDOVER`), and proves the failure paths: a failed review routes
back to `EXECUTE`, a blocker stops and `resume` continues, a frozen-path change
fails the gate, a failing verifier blocks, and a locked workspace is refused.

## Try it with a real agent

```bash
./bootstrap/make-trial-project.sh /path/to/textkit-trial   # tiny, pre-activated Python project
./engine/orchestrator.sh start --root /path/to/textkit-trial
./engine/orchestrator.sh loop --root /path/to/textkit-trial --host claude --provider hosts/claude/provider.sh --max-nodes 10
# or: --host codex --provider hosts/codex/provider.sh   (set CODEX_BIN if codex is not on PATH)
./engine/render-dashboard.sh --root /path/to/textkit-trial
```

The trial project is activated by the generator for convenience; real projects
go through `bootstrap/init.sh` and the activation checklist.

## Not covered yet

- one work item per run; no queue of work items and no parallelism;
- `EXECUTE` allows the paths of every execution slice, not only the current
  one; per-slice tracking is a follow-up;
- no delivery: merge, release, and deployment stay outside the engine;
- the real providers are not exercised by tests (they need the installed CLIs).

## Dashboard
Run `engine/render-dashboard.sh --root DIR` to write `.loop/dashboard.html`.
The static, read-only page summarizes status, transitions, blockers, evidence, gates, and the work item.
Use `--output FILE` to choose another path or `--output -` for stdout.
The renderer executes no project commands and uses no network resources.
