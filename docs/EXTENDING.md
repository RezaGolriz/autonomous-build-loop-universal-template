# Configuration and extension points

The workflow is fixed. Extend project profiles, target adapters, providers, or
evidence collectors without adding a second transition policy.

## Active project adapter

Once activated, the project adapter is configuration truth. It identifies the
target, artifacts, protected paths, allowed environment variable names, exact
verification commands, evidence requirements, and execution limits.

Treat changes to this file as control changes: prepare a new proposal, review
it, prove its positive and negative checks in a disposable copy, and activate
it through the same bound approval flow. Runtime discovery must not silently
rewrite an active adapter.

Generated state, jobs, locks, evidence, and logs are not adapter inputs.

## Add a project profile

A profile describes the smallest evidence set appropriate to one project shape.
It may distinguish behavior, contract, package, installation, artifact, or
documentation evidence. It must remain independent of language and framework.

A profile must not:

- add, remove, rename, reorder, or skip workflow phases;
- make REVIEW optional;
- treat worker prose as gate evidence;
- embed target commands, shell strings, or secrets;
- grant publication or another external action.

Do not call a profile conformant until an unchanged engine passes a positive
fixture and relevant fail-closed controls for it.

## Add a target recipe

A recipe may suggest manifest discovery, runtimes, commands, protected paths,
artifacts, and evidence collectors. Suggestions remain preparation input until
a human confirms them. A recipe can serve several profiles; for example, a Rust
recipe may support both a CLI and a library.

Use structured command declarations:

~~~json
{
  "id": "unit",
  "phase": "VALIDATE",
  "cwd": ".",
  "argv": ["cargo", "test", "--locked"],
  "timeout_seconds": 600,
  "evidence_types": ["command", "acceptance", "behavior"]
}
~~~

Never interpolate an untrusted shell command. Declare only environment variable
names; keep values in established local secret mechanisms.

## Add a provider

A provider starts one fresh worker or reviewer, applies the configured
permissions, passes only declared artifacts, and returns a normalized result. It
must not own state transitions, write prior evidence, silently retry an
ambiguous operation, or reinterpret a blocked gate.

Keep project configuration portable by storing executable paths, installed
versions and generated authentication status in signed provider machine
configuration.

## Add a client

A new chat UI, editor integration, or automation client should call
control/index.mjs through dispatch(root, operation, args). It must render
structured results and preserve job IDs, approval boundaries, blockers, and
evidence references.

A client must not:

- accept a project-root override after connecting to a bound project;
- replace the local confirmation view with a boolean tool argument;
- implement its own pass/fail logic;
- turn transport success into gate success;
- imply merge or delivery authority after handover.

## Add an executor or VCS adapter

Executors receive a structured argument vector, working directory, explicit
environment allowlist, and timeout. VCS adapters supply revision identity,
change enumeration, and clean-tree checks. Missing capabilities block; they do
not permit approximate evidence.

## Add an evidence kind

Change the evidence schema, project-adapter enumeration, validator, renderer,
and conformance vectors together. Define:

- producer and observable result;
- what failure means;
- artifact and revision binding;
- reproduction method;
- limits of the claim.

No evidence kind may bypass independent review.

## Schema compatibility

Schema changes require a new version, migration guidance, positive vectors,
negative vectors for unknown and unsafe input, and matrix tests across supported
profiles. Readers reject unsupported future versions instead of ignoring fields
they do not understand.

## Package compatibility

Runtime code and public examples must work from an installed package. Resolve
bundled workflow, schema, template, provider, and skill assets from the package
location. Do not assume source-only tests, a full repository checkout, Git
history, or a personal filesystem path exists.

Record actual compatibility evidence in [VALIDATION.md](VALIDATION.md).
