# Architecture

## Design rule

The workflow is invariant; target technology is data. The engine consumes the
canonical workflow and strict durable artifacts. Profiles contribute artifact
and validation requirements. Host, executor, and version-control adapters
provide capabilities without changing process semantics.

```text
                 core contract + workflow
                           |
                    strict schemas
                           |
                         engine
              /            |             \
        host adapter   executor/VCS   evidence store
                           |
              project profile + target config
```

Dependencies point inward: adapters may depend on the kernel contract; the
kernel never depends on an adapter, profile, language, framework, or project
layout.

## Kernel invariants

- The exact phase order is `DEFINE`, `DESIGN`, `EXECUTE`, `REVIEW`, `VALIDATE`,
  `HANDOVER`.
- Review is independent, fresh-context, and mandatory.
- Validation is mandatory and profile-appropriate.
- One round executes one bounded node.
- State advances only from runner-owned evidence.
- Allowed, frozen, and protected paths are mechanically enforced.
- Unknown fields and unknown enum values fail schema validation.
- Missing evidence, capability, or authority blocks rather than degrades.

## Configuration boundaries

The profile answers “what kind of artifact and evidence does this project
need?” The target answers “which languages, runtimes, and platforms implement
it?” Commands answer “how does this repository produce the evidence?” Keeping
those questions separate prevents a CLI profile from becoming a Python profile
or an API profile from becoming a web-framework profile.

Command declarations use `cwd`, `argv`, and `timeout_seconds`. They are data for
an executor adapter, not interpolated shell programs. Secrets never belong in a
profile or command declaration.

## Recommendation boundary

`bootstrap/recommend.sh` is an advisory layer outside the workflow kernel. It
performs a bounded read-only scan, ignores symlink targets, and uses file names
plus a small allowlist of manifest fields. Its output is labeled as a
recommendation and is preserved in initialization provenance.

Recommendations never become authority. A human may accept or replace ordinary
defaults, while inferred command arrays require the explicit token
`USE-RECOMMENDED`. Supported platforms, unknown artifact paths, and the
known-failing negative control remain manual. Discovery never executes project
content and never changes the `PAUSED` activation boundary.

Initialization also requires a completely clean template checkout. Its own
script, the recommendation helper, and the reference engine are tracked and
bound to template Git `HEAD`; modified or untracked template content blocks the
pin instead of producing ambiguous provenance.

## Durable artifacts

JSON is canonical for machine state, workflow, initialized project adapters,
node briefs, verdicts, and evidence. Profiles remain advisory initialization
inputs. Human-readable Markdown may be generated from canonical records, but it
must not become a competing writable source of truth. Every schema is versioned
and recursively rejects unknown fields.

## Profiles in v1

- `cli`: behavior and installation evidence in addition to commands.
- `api`: behavior and interface-contract evidence; no transport or framework is
  prescribed.
- `library`: package and consumer-installation evidence.
- `docs`: documentation and link/reference evidence; no executable target is
  assumed.
- `desktop`: behavior and installation evidence for an installed client.
- `service`: behavior and artifact evidence for a continuously operated target.
- `automation`: behavior evidence for triggered or scheduled work.
- `data-ai`: artifact and behavior evidence appropriate to data or model output.
- `other`: a conservative starting point for a new project shape.

These differences affect only validation inputs. All profiles traverse
the same workflow and mandatory review gate.

## Reference implementation boundary

The current reference engine is a Bash+jq+Git implementation for Unix-like
control hosts. Its control-plane dependencies are checked by
`bootstrap/check-prerequisites.sh`; they do not constrain target technology.
Version `0.1.0` must be consumed through an immutable repository revision or
release so schemas, engine, tests, and protocol documentation remain aligned.

Current conformance covers the Python-CLI and docs-only fixtures plus selected
fail-closed command, path-policy, timeout, schema, and nonce-bound review cases.
It is not evidence for full operating-system, host-adapter, project-profile, or
delivery coverage. Delivery starts after handover and is deliberately outside
the engine's authority.
