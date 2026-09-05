# Schema test vectors

Validate `valid-*.json` against the schema named in its `_schema` companion
entry below. Validate `invalid-*.json` expecting failure.

| Vector | Schema | Expected reason |
|---|---|---|
| `valid-state.json` | `state.schema.json` | valid canonical state |
| `invalid-state-skipped-review.json` | `state.schema.json` | review cannot be `NOT_APPLICABLE` |
| `invalid-profile-unknown-field.json` | `project-adapter.schema.json` | unknown fields are rejected |
| `invalid-workflow-phase.json` | `workflow.schema.json` | phase list is immutable |

The `_schema` metadata is documented here rather than embedded in instances,
because strict schemas deliberately reject undeclared metadata fields.
