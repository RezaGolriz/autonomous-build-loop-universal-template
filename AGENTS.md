# Universal build-loop instructions

The product truth is the active work-item specification. The process truth is
`core/CONTRACT.md`, `core/WORKFLOW.md`, and the schemas under `spec/schemas/`.

Before changing target-project artifacts:

1. Read the project profile, active work item, durable state, and node brief.
2. Discover the actual target technology and repository conventions; never
   infer them from the template or project-type profile.
3. Change only declared allowed paths. Preserve frozen and protected paths.
4. Execute exactly one node and record only checks actually performed.
5. Ask through the blocker mechanism when a required decision is absent.

The canonical phases are `DEFINE`, `DESIGN`, `EXECUTE`, `REVIEW`, `VALIDATE`,
and `HANDOVER`. They are fixed for every project. `REVIEW` is never optional.
`VALIDATE` uses the evidence requirements declared by the selected profile.

Never weaken a gate, treat a worker statement as proof, expose secrets, discard
unrelated work, merge, publish, release, deploy, or otherwise change external
state without the authority required by the contract.

Project initialization is supervised. `bootstrap/init.sh` may write only paused
candidate configuration; activation still requires human confirmation, strict
validation, and a known-failing negative control.
