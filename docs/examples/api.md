# Example: a JSON HTTP API

Goal: a small API that manages "orders": create an order, read it, list
orders. The API publishes an OpenAPI description that clients rely on, so the
loop must prove that the description and the real behavior match.

This illustrative recipe uses Python with FastAPI, pytest, and Schemathesis.
Confirm current package APIs and commands in your own repository; this page is
not a runnable fixture.

## 1. Project skeleton

```bash
mkdir orders-api && cd orders-api && git init
python3 -m venv .venv && . .venv/bin/activate
pip install fastapi uvicorn httpx pytest schemathesis
pip freeze > requirements.txt
mkdir -p src/orders tests contract
```

Create `src/orders/app.py` with a FastAPI app that has one health route, and
`tests/test_health.py` that calls it with `httpx`. Add
`contract/test_contract.py`:

```python
import schemathesis
from orders.app import app

schema = schemathesis.from_asgi("/openapi.json", app)

@schema.parametrize()
def test_api_matches_openapi(case):
    case.call_and_validate()
```

Add `conftest.py` at the project root so the tests can import the package
without installing it:

```python
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "src"))
```

Add a tiny `Makefile` so the commands are stable even when tools change:

```make
test:      ; python3 -B -m pytest -q -p no:cacheprovider tests
contract:  ; python3 -B -m pytest -q -p no:cacheprovider contract
```

Run `make test` and `make contract` by hand once. Commit everything except
`.venv/` (put it in `.gitignore`).

## 2. Initializer answers

| Question | Answer |
|---|---|
| Adapter id | `orders-api` |
| Project shape | `api` |
| Languages | `Python` |
| Runtime | `CPython >=3.12` |
| Tools | `pip, pytest, schemathesis` |
| Platforms | `linux-x64, macos-arm64` |
| Artifact 1 | id `service`, kind `service`, paths `src/orders/**` |
| Protected paths | `.loop/state.json, .loop/workflow.json, .loop/project.adapter.json, .loop/evidence/**, requirements.txt, Makefile, contract/**` |
| Environment names | `PATH, HOME, LANG, LC_ALL, TMPDIR, VIRTUAL_ENV` |
| EXECUTE verifier | id `test`, cwd `.`, argv `["make","test"]`, timeout `300`, evidence `command,acceptance,behavior` |
| VALIDATE verifier | id `contract`, cwd `.`, argv `["make","contract"]`, timeout `600`, evidence `command,acceptance,behavior,contract` |
| Required VALIDATE evidence | `acceptance,command,behavior,contract` |
| Max wall-clock seconds | `7200` |
| Negative control | `["python3","-m","pytest","-q","tests/this_file_does_not_exist.py"]` |

Why these choices:

- The `api` profile asks for `contract` evidence. Schemathesis generates
  requests from the OpenAPI file and checks every response against it; that
  is exactly the proof the profile wants.
- `contract/**` is protected. The agent must make the API match the contract
  test, not the other way round.
- `requirements.txt` is protected so the agent cannot add dependencies without
  a human decision. If a work item needs a new package, that is a blocker to
  resolve first.

After the initializer, edit `.loop/candidate/project.adapter.json` and add the
contract check to EXECUTE as well, so every slice is checked against the
contract, not only the final validation. The referee requires the commands of
each phase to cover every required evidence type together; here `test` and
`contract-fast` do that for EXECUTE:

```json
{
  "commands": [
  {"id":"test","phase":"EXECUTE","cwd":".","argv":["make","test"],"timeout_seconds":300,"evidence_types":["command","acceptance","behavior"]},
  {"id":"contract-fast","phase":"EXECUTE","cwd":".","argv":["make","contract"],"timeout_seconds":600,"evidence_types":["command","contract"]},
  {"id":"contract","phase":"VALIDATE","cwd":".","argv":["make","contract"],"timeout_seconds":600,"evidence_types":["command","acceptance","behavior","contract"]}
  ]
}
```

## 3. Prepare and activate

Follow the [common setup](README.md#common-setup). Review the active Python
environment, commands, paths, and contract evidence in the confirmation view.
Activation runs the approved checks in a disposable copy.
Make sure the virtual environment is activated in the shell that runs the
loop, because the referee passes `PATH` and `VIRTUAL_ENV` through to the
commands.

## 4. First work item

```markdown
# WI-001: Create and read orders

Kind: feature

## Outcome

`POST /orders` accepts `{"customer": "<string>", "items": [{"sku": "<string>",
"qty": <int>}]}`, stores the order in memory, and returns `201` with the order
including a generated `id` and `status: "new"`. `GET /orders/{id}` returns the
order or `404`. `GET /orders` lists all orders. All three routes are described
in the OpenAPI document with request and response models, and the contract
test passes.

## Acceptance criteria

## Out of scope

## Constraints and invariants

- Standard library plus the packages already in `requirements.txt` only.
- Validation errors return `422` with FastAPI's default body.
- Only `src/**`, `tests/**`, and `.hypothesis/**` (Schemathesis output) may change during EXECUTE.
- Persistence beyond process memory is out of scope.

## Design

## Execution slices

| Slice | Allowed paths | Frozen paths | Verifier IDs | Proof |
|---|---|---|---|---|

## Independent review

## Validation

## Handover

Handover is not authorization to merge, publish, release or deploy.
```

## 5. Run

From Codex or Claude Desktop, ask the connected build-loop interface to create
this work item, start a bounded job, and show its status. The worker provider
still needs its own installed and authenticated CLI.

The equivalent shell path is:

```bash
./engine/orchestrator.sh start --root /path/to/orders-api
./engine/orchestrator.sh loop --root /path/to/orders-api \
  --host claude --provider hosts/claude/provider.sh \
  --review-host codex --review-provider hosts/codex/provider.sh --max-nodes 12
./engine/render-dashboard.sh --root /path/to/orders-api
```

## 6. After handover

Deploying the service, rotating keys, or running database migrations are
human actions after handover. The evidence folder tells you exactly which
commands ran, with which exit codes, against which Git revision.

## Pitfalls specific to APIs

- Contract tests that start a real server need a free port. Prefer the ASGI
  in-process mode shown above; it needs no port and no network.
- If the API talks to a database, use an in-memory or throwaway instance in
  the tests. The referee runs commands with a minimal environment, so any
  connection string must come from a file inside the project or from an
  allowed environment variable name.
- Do not let the agent edit the contract tests to make them pass. Keeping
  `contract/**` protected is the whole point.
- `python3 -B` and `-p no:cacheprovider` stop Python and pytest from writing
  `__pycache__/` and `.pytest_cache/`. The referee compares every file before
  and after a step, so tool output must either not exist or be inside the
  allowed paths.
