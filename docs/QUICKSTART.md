# Step-by-step quickstart

This guide prepares a project safely. It does not activate an autonomous run.

## 1. Get and verify the template

```bash
git clone <repository-url>
cd autonomous-build-loop-universal-template
./bootstrap/check-prerequisites.sh
./tests/run-conformance.sh
```

Replace `<repository-url>` with the HTTPS or SSH URL shown by your Git host.
Both checks must pass before you initialize a target project.

## 2. Prepare a separate target project

The target directory must already exist. This example creates it next to the
template checkout:

```bash
cd ..
mkdir my-project
./autonomous-build-loop-universal-template/bootstrap/init.sh "$(pwd)/my-project"
```

The initializer validates every answer and stops when an answer is invalid.
Correct the input and run it again. Do not enter secrets in any answer: free-form
answers are stored verbatim. For environment variables, enter names such as
`PATH`, never their values.

## 3. Choose the technology explicitly

These are human decisions, not automatic guesses:

- project kind, such as `cli`, `api`, `library`, `docs`, or `data-ai`;
- programming language, such as `Python`, `Rust`, or `none`;
- runtime, compiler, or interpreter and its version constraint;
- build, package, and test tools;
- supported platforms;
- produced artifacts;
- exact verification commands as JSON argument arrays;
- the evidence those commands actually prove.

A command is not stored as a shell expression. For example,
`python3 -m pytest -q` becomes:

```json
["python3", "-m", "pytest", "-q"]
```

## 4. Review the candidate files

After the final `YES`, the initializer writes four files:

```text
my-project/.loop/candidate/
├── project.adapter.json
├── state.json
├── initialization.answers
└── ACTIVATION-CHECKLIST.md
```

Open `ACTIVATION-CHECKLIST.md` first. In particular, confirm:

- Do the declared commands run the correct checks?
- Are configuration, policy, and test files protected?
- Is a known-failing negative control recorded?
- Are external actions clearly separated from the engine?

The state remains `PAUSED`. Version 0.1 deliberately provides no command that
bypasses this human review or activates a loop automatically.

## 5. What happens after activation?

After a separately verified and explicitly approved activation, every task uses
the same six phases:

```text
DEFINE → DESIGN → EXECUTE → REVIEW → VALIDATE → HANDOVER
```

Technology changes the concrete commands and evidence, but never the phase
order or the requirement for independent review.

For technical details, read [Architecture](ARCHITECTURE.md) and
[Extensions](EXTENDING.md).
