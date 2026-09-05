# Required initialization interview

Ask one question at a time. First run the bounded read-only recommendation
helper. Show its confidence and evidence, then let the human accept or replace
ordinary suggestions. An inferred command requires the literal
`USE-RECOMMENDED`; supported platforms and the negative control remain manual.
Record recommendation provenance next to the human-confirmed adapter.
Run this interview only from a clean template checkout so its Git `HEAD` binds
the initializer, recommendation helper, and reference engine used to create the
candidate. Modified or untracked template content blocks initialization.

1. What kind of project is this: CLI, API, library, documentation, desktop,
   service, automation, data/AI, generic other, or a new profile that must be
   defined first?
2. Which programming language or languages will be used? `none` is valid for a
   project with no programming language.
3. Which runtime, compiler or interpreter and version constraints apply?
4. Which dependency, build and packaging tools are authoritative?
5. Which exact argv-based commands prove EXECUTE and VALIDATE success, from
   which working directories, with which timeouts, and which evidence types
   does each command actually prove?
6. Which operating systems, architectures and environments are supported?
7. Which artifacts are produced, and how are they consumed?
8. Which toolchain, test, policy and configuration paths must be protected?
9. Which environment variable names may commands inherit? Never request or
   record secret values.
10. Which invariants, external integrations and irreversible delivery actions
    need explicit human control?

`bootstrap/init.sh` records these answers as candidates only. Human review,
strict validation, a known-failing negative control, conformance checks, an
immutable engine pin, and explicit activation authorization remain separate
required steps.

Repository discovery is evidence for a recommendation, not permission to make
the choice. Do not activate the adapter until the human has confirmed every
answer and the negative control has proved that its verifier can fail.
