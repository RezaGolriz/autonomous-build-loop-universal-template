# Contributing

Start by reading the README and `core/CONTRACT.md`. The six phases, independent
review, captured verification, path policy, and human delivery boundary are the
project's central behavior. Convenience features must preserve them.

Use Node.js 22 or newer and the Unix tools checked by
`bootstrap/check-prerequisites.sh`. No npm runtime dependencies are required.
Run `npm run test:all` before proposing changes. Run `npm run bundle` when changing
host integrations, and test the resulting package outside the source checkout.

Keep project configuration, machine-specific settings, and generated run state
separate. Put shared behavior in the control layer or engine, not in a skill or
transport. Existing shell commands must remain compatible.

Add positive and negative tests for new behavior. Use fake providers in automated
tests, and label real-model and Desktop UI checks separately. Do not claim those
checks passed merely because protocol tests passed.

Write public documentation and examples in simple English. Use neutral example
data. Run `npm run audit:public` and privately review every match before sharing a
patch. Do not commit local reports, credentials, probe copies, or execution logs.

Explain the problem, the resulting behavior, and the checks you actually ran in
each pull request. A passing run does not authorize publication or deployment.
