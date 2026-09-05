# Canonical workflow

The phase order is universal and immutable:

| Phase | Required output | Gate | Failure routing |
|---|---|---|---|
| `DEFINE` | Testable work-item contract, exclusions, constraints | Criteria are unambiguous and independently verifiable; no blocking decision remains | `DEFINE` or `BLOCKED` |
| `DESIGN` | Boundaries, interfaces, risks, and independently provable slices | Design satisfies the contract and every slice names a deterministic proof | `DESIGN`, `DEFINE`, or `BLOCKED` |
| `EXECUTE` | The current target artifact and focused checks | Runner-owned configured checks pass; frozen and protected artifacts are unchanged | `EXECUTE` or `BLOCKED` |
| `REVIEW` | Independent semantic verdict and findings | Exact independent verdict passes with no blocking finding | `EXECUTE`, `DESIGN`, `DEFINE`, or `BLOCKED` |
| `VALIDATE` | Profile-appropriate acceptance and regression evidence | Every criterion and profile evidence requirement passes | `EXECUTE`, `DESIGN`, `DEFINE`, or `BLOCKED` |
| `HANDOVER` | Revision, evidence index, limitations, and next-authority request | State is `WAITING_FOR_HUMAN`; no external action is inferred | terminal pending human action |

No profile may remove or reorder a phase. A phase with little target-specific
work still emits its required artifact and receives its gate. `REVIEW` can never
be skipped or marked not applicable.

## Status is separate from phase

`PAUSED`, `RUNNING`, `BLOCKED`, `WAITING_FOR_HUMAN`, `COMPLETED`, and
`CANCELLED` describe execution status. They do not change the workflow graph.

## Green transitions

```text
DEFINE -> DESIGN -> EXECUTE -> REVIEW -> VALIDATE -> HANDOVER
```

`EXECUTE -> EXECUTE` advances another declared slice. Review and validation
findings route to the phase that owns the defect; they do not default blindly to
execution. A human may resume a resolved blocker at its recorded phase.
