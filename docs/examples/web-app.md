# Example: a web app (browser application)

Goal: a single-page app with a login screen and a dashboard that shows data
from an API. The loop must prove that the app type-checks, that the
components behave as specified, and that a user can actually log in and see
the dashboard in a real browser.

This illustrative recipe uses React with TypeScript, Vite, Vitest, and
Playwright. Confirm current package APIs and commands in your repository; this
page is not a runnable fixture.

Choose [Chat variant](#chat-variant) or [Shell variant](#shell-variant).

## Chat variant

Use this route in Codex with the build-loop skill, or in Claude Desktop with
the project-bound MCP integration. Follow the [shared chat setup](README.md#chat-variant-common-setup)
first. These are prompts to send in separate turns, not a transcript of a tested
run. The assistant performs the control calls; you do not need to paste JSON or
shell commands. The numbered shell recipe below remains available separately.

### 1. Inspect the target

```text
Inspect this browser application for the Universal Build Loop and check its
prerequisites. Identify the framework, type checks, component tests, browser
tests, existing API mocks, and output/cache folders. Do not install packages,
run project commands, or initialize the loop yet.
```

If starting from an empty folder, use the shared guide's **baseline setup**
prompt before proceeding. The loop needs passing baseline checks; inspection
and preparation do not scaffold an application or install its dependencies.

### 2. Prepare this scenario

```text
Prepare the first work item: a login form has labeled email and password fields.
Sign in stays disabled until the email is valid and the password has at least
eight characters. Submitting uses a mocked POST /api/login, keeps the returned
token in memory, and opens a dashboard showing the signed-in email. Reloading
returns to login. Announce validation errors accessibly. Test the validation
and success paths and prove the browser can reach the dashboard.

Use the desktop profile as a starting point and explain installation evidence
as the built browser bundle loading successfully. Allow src/ and the actual
build, test, and cache output folders. Protect manifests, lockfiles, build/test
configuration, and existing browser acceptance tests. Use existing mocking
tools; raise a blocker if a dependency is missing. Password reset, persistent
sessions, real accounts, and deployment are out of scope.

Include exact commands, timeouts, evidence requirements, environment names,
and a meaningful negative behavior probe. Prepare a paused candidate with
explicit acceptance criteria and show the approval summary. Do not activate.
```

If MSW is absent, the agent must not silently add it to a protected manifest.
For example, an actual user decision can be: “Use the existing Playwright route
mocks; do not add MSW.” Record that decision through the blocker flow described
in the shared chat guide. New acceptance tests must be provisioned in the
baseline or placed in explicitly editable test paths before approval.

### 3. Approve, activate, and start

Use the shared guide's [human approval and activation flow](README.md#human-approval-and-activation).
After activation is confirmed successful, send:

```text
Start the prepared work item with a budget of 12 nodes. Generate a new
project-unique request ID for this dash run and show the returned job ID.
Stop on a blocker or at handover; do not create a duplicate first work item.
```

Twelve nodes is a budget, not a promise that the task will finish. Use the
shared [status and continuation prompts](README.md#status-blockers-and-handover)
if the budget ends or the conversation reconnects.

### 4. Review the result

```text
Inspect the handover evidence for form validation, mocked login, dashboard
navigation, reload behavior, and accessibility checks. State what was actually
exercised in a browser. Do not upload the bundle or use production accounts.
```

Acknowledge handover only after reviewing the evidence, using the shared guide.

## Shell variant

The following commands and configuration tables are an alternative setup route
and technical reference. Do not also run the initializer after the chat flow
has already activated this target. Review version-specific commands for the
actual project; the tables do not override the approved chat proposal.

### 1. Project skeleton

```bash
npm create vite@latest dash -- --template react-ts
cd dash && git init
npm install
npm install --save-dev vitest @testing-library/react @testing-library/jest-dom jsdom @playwright/test
npx playwright install --with-deps chromium
```

Add these scripts to `package.json`:

```json
{
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "build": "vite build",
    "e2e": "playwright test",
    "check": "npm run typecheck && npm test && npm run build"
  }
}
```

Configure Playwright with a `webServer` that runs `vite preview` on the
built app, so `npm run e2e` is self-contained. Create one component test in
`src/` and one browser test in `e2e/` (open the app, expect the login form).
Run `npm run check` and `npm run e2e` by hand once. Commit; `node_modules/`
and `dist/` go into `.gitignore`.

### 2. Initializer answers

| Question | Answer |
|---|---|
| Adapter id | `dash` |
| Project shape | `desktop` (an installed client, here: a browser client) |
| Languages | `TypeScript` |
| Runtime | `Node.js >=20 for build and tests; evergreen browsers at runtime` |
| Tools | `npm, vite, vitest, playwright` |
| Platforms | `browser-chromium, linux-x64, macos-arm64` |
| Artifact 1 | id `bundle`, kind `package`, paths `dist/index.html` |
| Protected paths | `.loop/state.json, .loop/workflow.json, .loop/project.adapter.json, .loop/evidence/**, package.json, package-lock.json, vite.config.ts, tsconfig.json, playwright.config.ts, e2e/**` |
| Environment names | `PATH, HOME, LANG, LC_ALL, TMPDIR, CI` |
| EXECUTE verifier | id `check`, cwd `.`, argv `["npm","run","check"]`, timeout `600`, evidence `command,acceptance,behavior,installation` |
| VALIDATE verifier | id `e2e`, cwd `.`, argv `["npm","run","e2e"]`, timeout `900`, evidence `command,acceptance,behavior,installation` |
| Required VALIDATE evidence | `acceptance,command,behavior,installation` |
| Max wall-clock seconds | `7200` |
| Negative control | `["npx","tsc","--noEmit","-p","tsconfig.does-not-exist.json"]` |

Why these choices:

- The `desktop` profile asks for `installation` evidence. For a browser app
  that is the built bundle loading in a real browser, which the Playwright
  run proves.
- `e2e/**` and all config files are protected so the agent cannot relax the
  type checker or the browser tests to pass its own work.
- `dist/index.html` is the artifact; the referee checks that the build
  produced it.

### 3. Prepare and activate

Follow the [common setup](README.md#common-setup). Review every browser command,
output folder, protected test, and timeout in the confirmation view.

### 4. First work item

```markdown
# WI-001: Login form with validation and session state

Kind: feature

## Outcome

The app shows a login form (e-mail, password, "Sign in"). The button is
disabled until the e-mail is valid and the password has at least 8
characters. Submitting calls `POST /api/login` (mocked in tests with MSW),
stores the returned token in memory, and navigates to `/dashboard`, which
shows "Signed in as <e-mail>". Reloading the page returns to the login form
(no persistence in this item). Component tests cover validation and the
success path; one browser test signs in against the mocked API and sees the
dashboard.

## Acceptance criteria

## Out of scope

## Constraints and invariants

- No new runtime dependencies; MSW may be added as a dev dependency only
  through a blocker (package.json is protected).
- Only `src/**`, `dist/**`, `test-results/**`, and `playwright-report/**`
  may change during EXECUTE (the last three are tool output).
- Accessibility: form fields have labels; errors are announced via
  `aria-live`.
- Password reset and "remember me" are out of scope.

## Design

## Execution slices

| Slice | Allowed paths | Frozen paths | Verifier IDs | Proof |
|---|---|---|---|---|

## Independent review

## Validation

## Handover

Handover is not authorization to merge, publish, release or deploy.
```

Note the tool-output folders in the constraints. The referee compares the
whole project before and after a step, so folders that the build or the
tests write to must be inside the allowed paths, otherwise the step fails
even though the agent did nothing wrong. Tell the agent to list them in every
slice.

### 5. Run

From Codex or Claude Desktop, ask the connected build-loop interface to create
the work item and start a bounded job. Playwright and the selected worker CLI
remain separate machine prerequisites.

The equivalent shell path is:

```bash
./engine/orchestrator.sh start --root /path/to/dash
./engine/orchestrator.sh loop --root /path/to/dash \
  --host codex --provider hosts/codex/provider.sh \
  --review-host claude --review-provider hosts/claude/provider.sh --max-nodes 12
./engine/render-dashboard.sh --root /path/to/dash
```

The work item above needs a new dev dependency (MSW) while `package.json` is
protected. Expect the agent to stop in DESIGN or EXECUTE with a blocker such
as "MSW is not installed". That is correct behavior: install it yourself,
commit, tick the blocker, and `resume`. If you prefer, install it before you
start the loop.

### 6. After handover

Uploading the bundle to your hosting, changing DNS, or rotating API keys are
human actions after handover.

### Pitfalls specific to web apps

- Browser tests are slow and sometimes flaky. Keep the VALIDATE timeout
  generous and make the tests deterministic (mock the network with MSW or
  Playwright's route mocking).
- Anything the tools write inside the project must be in the allowed paths of
  every slice (`dist/**`, `test-results/**`, `playwright-report/**`). Vite's
  dev cache lives in `node_modules/.vite`; point it elsewhere with
  `cacheDir: ".cache/vite"` in `vite.config.ts` and allow `.cache/**`, so
  `node_modules/**` never has to be an allowed path.
- The referee checksums every file except `.git`; a large `node_modules/`
  makes each step a few seconds slower. That is expected.
