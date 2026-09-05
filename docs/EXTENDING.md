# Extending the template

## Add a project-type profile

Create one advisory JSON document following the existing profile shape. Choose
artifact kinds and the smallest set of validation evidence that proves the
target usable. Initialization combines the selected profile with
project-specific target, path, protection, and command data into a strict
document conforming to `spec/schemas/project-adapter.schema.json`.

A profile must not:

- add, remove, rename, reorder, or skip workflow phases;
- make `REVIEW` optional;
- treat worker prose as evidence;
- embed shell snippets or secrets;
- grant publication or external-state authority.

## Add a technology pack

A technology pack may suggest target values, manifest discovery, commands,
protected paths, and evidence collectors. It must compose with multiple project
profiles and must not define transitions. For example, a Rust pack can support
both CLI and library profiles; neither profile should contain Rust assumptions.

## Add a host adapter

A host adapter starts one fresh worker or reviewer, applies least-privilege
permissions, passes only declared artifacts, and returns a normalized result.
It must not write runner-owned verdicts, reinterpret transitions, or silently
retry a failed or ambiguous operation.

## Additional node schema

`spec/schemas/node.schema.json` is intentionally additional to the five
canonical interchange schemas. It is the machine-enforced node brief and owns
`allowed_paths` and `frozen_paths`; the project adapter owns repository-wide
`protected_paths`.

## Add an executor or VCS adapter

Executors receive structured argument vectors, working directories, explicit
environment allowlists, and timeouts. VCS adapters provide revision identity,
change enumeration, and clean-tree checks. Their absence is a blocked
capability, not permission to approximate evidence.

## Add an evidence kind

Extend the evidence schema, project-adapter evidence enumeration, validator, renderer,
and conformance vectors together. Define producer, observable result, failure
meaning, and replay or reproduction method. Do not use a new evidence kind to
bypass independent review.

## Compatibility discipline

Schema changes require a new schema version, migration, positive vectors,
negative vectors for unknown or unsafe input, and matrix tests across every v1
profile. Readers must reject unsupported future versions instead of ignoring
fields they do not understand.

Do not describe a new profile as conformant until the unchanged reference engine
has a passing positive fixture and relevant negative controls for it. A profile
file alone is advisory metadata, not conformance evidence.
