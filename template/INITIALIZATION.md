# Required initialization interview

Use these questions to turn repository observations into human-confirmed
project configuration. Ask one focused question at a time. Show recommendation
evidence and confidence, and let the human accept or replace each suggestion.

1. What project shape fits the artifact: CLI, API, library, documentation,
   desktop, service, automation, data/AI, generic other, or a new profile that
   must be defined first?
2. Which programming languages are used? none is valid for a project without a
   programming language.
3. Which target runtimes, compilers, interpreters, browsers, devices, and
   version constraints apply?
4. Which dependency, build, and packaging tools are authoritative?
5. Which exact argv commands prove EXECUTE and VALIDATE success? For each one,
   record its working directory, timeout, and the evidence kinds it actually
   produces.
6. Which operating systems, architectures, devices, and other environments are
   supported?
7. Which artifacts are produced, and how are they consumed?
8. Which policy, configuration, test, toolchain, and contract paths must be
   protected?
9. Which environment variable names may verification commands inherit? Never
   request or record secret values.
10. Which invariants and external integrations apply?
11. Which actions require separate authority, including merge, publication,
    release, deployment, migration, destructive work, production-device access,
    and secrets?
12. Which local positive probe demonstrates the intended verifier, and which
    safe known-failing negative probe proves the same boundary rejects failure?
13. Which installed and authenticated provider will build, and which fresh
    independent context will review?

Repository discovery is evidence for a recommendation, not permission to make a
choice. An inferred command requires explicit review. Preparation must not
execute target commands.

Activation requires one bound human confirmation, strict configuration
validation, conformance checks, and positive and negative probes in a disposable
copy. The copy protects the original project tree but is not an operating-system
sandbox; its commands retain the current user's permissions.

If a verifier, provider, decision, or safe negative control is missing, record a
blocker. Planning may continue when safe, but execution must remain disabled.

The legacy bootstrap/init.sh records paused candidates under .loop/candidate/.
Its manual checklist remains required when the shared approval and activation
operations are not used.
