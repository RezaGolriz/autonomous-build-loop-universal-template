# Example: a web app (browser application)

Goal: a single-page app with a login screen and a dashboard that shows data
from an API. The loop must prove that the app type-checks, that the
components behave as specified, and that a user can actually log in and see
the dashboard in a real browser.

This illustrative recipe uses React with TypeScript, Vite, Vitest, and
Playwright. Confirm current package APIs and commands in your repository; this
page is not a runnable fixture.

## 1. Project skeleton

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

## 2. Initializer answers

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

## 3. Prepare and activate

Follow the [common setup](README.md#common-setup). Review every browser command,
output folder, protected test, and timeout in the confirmation view.

## 4. First work item

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

## 5. Run

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

## 6. After handover

Uploading the bundle to your hosting, changing DNS, or rotating API keys are
human actions after handover.

## Pitfalls specific to web apps

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
