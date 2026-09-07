# Example: a web shop (public website)

Goal: a small shop website with a product list, product pages, and a cart.
The site is generated at build time and published as static files; the
checkout talks to an external payment provider.

This illustrative recipe uses Node with Astro, Vitest, and Playwright. Confirm
current package APIs and commands in your repository; this page is not a
runnable fixture.

Choose [Chat variant](#chat-variant) or [Shell variant](#shell-variant).

## Chat variant

Use this route in Codex with the build-loop skill, or in Claude Desktop with
the project-bound MCP integration. Follow the [shared chat setup](README.md#chat-variant-common-setup)
first. These are prompts to send in separate turns, not a transcript of a tested
run. The assistant performs the control calls; you do not need to paste JSON or
shell commands. The numbered shell recipe below remains available separately.

### 1. Inspect the target

```text
Inspect this shop repository for the Universal Build Loop and check its
prerequisites. Discover the actual framework, package manager, scripts, browser
tests, and generated folders. Do not install packages, run project commands,
or initialize the loop yet. Report what is missing.
```

If starting from an empty folder, use the shared guide's **baseline setup**
prompt before proceeding. The loop needs passing baseline checks; inspection
and preparation do not scaffold an application or install its dependencies.

### 2. Prepare this scenario

```text
Prepare the first work item: product pages show the product name, a price such
as 12.90 EUR, stock state, and an Add to cart button. Sold-out products cannot
be added. The product list links to each page, and the header cart count updates
without reloading. Read prices from the existing product data source.

Use the service profile as a starting point. Propose checks for the build,
unit behavior, and a real browser interaction. Allow changes only in src/,
editable unit tests, and the actual generated output folders. Keep package
manifests, lockfiles, framework configuration, and existing browser acceptance
tests protected. Do not add dependencies, checkout, payment, or deployment.

Include concrete acceptance criteria, exact command arguments and timeouts,
artifact paths, environment variable names, and a meaningful negative probe.
Use the detected repository commands rather than assuming the commands below
exist. Prepare a paused candidate and show the approval summary. Do not activate.
```

Browser binaries and the preview server must be ready before activation. Ask
the agent to check how the test runner starts and stops its server; installing
the chat integration does not install Playwright or target dependencies.

### 3. Approve, activate, and start

Use the shared guide's [human approval and activation flow](README.md#human-approval-and-activation).
After activation is confirmed successful, send:

```text
Start the prepared work item with a budget of 12 nodes. Generate a new
project-unique request ID for this shop run and show the returned job ID.
Stop on a blocker or at handover; do not create a duplicate first work item.
```

Twelve nodes is a budget, not a promise that the task will finish. Use the
shared [status and continuation prompts](README.md#status-blockers-and-handover)
if the budget ends or the conversation reconnects.

### 4. Review the result

```text
Inspect the handover evidence for product pages, sold-out behavior, and the cart
count. Show which browser checks actually ran and any remaining limitations.
Do not publish the site or connect a payment provider.
```

Acknowledge handover only after reviewing the evidence, using the shared guide.

## Shell variant

The following commands and configuration tables are an alternative setup route
and technical reference. Do not also run the initializer after the chat flow
has already activated this target. Review version-specific commands for the
actual project; the tables do not override the approved chat proposal.

### 1. Project skeleton

```bash
mkdir shop && cd shop && git init
npm create astro@latest . -- --template minimal --yes
npm install --save-dev vitest @playwright/test
npx playwright install --with-deps chromium
```

Add these scripts to `package.json`:

```json
{
  "scripts": {
    "build": "astro build",
    "test": "vitest run",
    "e2e": "playwright test",
    "check": "astro check && npm run build && npm test"
  }
}
```

Create `tests/` with one unit test and `e2e/` with one Playwright test that
opens the built site (`npx astro preview`) and checks that the product list
renders. Run `npm run check` and `npm run e2e` by hand once. Both must pass
before you continue. Commit.

### 2. Initializer answers

Run `./bootstrap/init.sh /path/to/shop` from the template checkout and answer:

| Question | Answer |
|---|---|
| Adapter id | `shop` |
| Project shape | `service` (a continuously operated target) |
| Languages | `TypeScript` |
| Runtime | `Node.js >=20` |
| Tools | `npm, astro, vitest, playwright` |
| Platforms | `linux-x64, macos-arm64` |
| Artifact 1 | id `site`, kind `document-set`, paths `dist/**` |
| Protected paths | `.loop/state.json, .loop/workflow.json, .loop/project.adapter.json, .loop/evidence/**, package.json, package-lock.json, astro.config.mjs, playwright.config.ts, e2e/**` |
| Environment names | `PATH, HOME, LANG, LC_ALL, TMPDIR, CI` |
| EXECUTE verifier | id `check`, cwd `.`, argv `["npm","run","check"]`, timeout `600`, evidence `command,behavior,artifact` |
| VALIDATE verifier | id `e2e`, cwd `.`, argv `["npm","run","e2e"]`, timeout `900`, evidence `command,behavior,artifact` |
| Required VALIDATE evidence | `command,behavior,artifact` |
| Max wall-clock seconds | `7200` |
| Negative control | `["npm","run","test","--","--reporter=dot","tests/does-not-exist.test.ts"]` |

Why these choices:

- `e2e/**` is protected so the agent cannot weaken the browser checks that
  prove its own work. Tests it may add live under `tests/`.
- The `.loop` control files are protected one by one, not as `.loop/**`,
  because the agent must still edit the work item in `.loop/work-items/`
  during DEFINE, DESIGN, and HANDOVER.
- The build output `dist/**` is the artifact. The referee checks that it exists
  after EXECUTE and VALIDATE.
- `behavior` evidence comes from the Playwright run, which clicks through the
  real pages.

### 3. Prepare and activate

Follow the [common setup](README.md#common-setup). Review the generated-output
paths, browser command, and protected test files in the confirmation view.
Note that the referee requires the commands of **each** phase to declare every
required evidence type. That is why both `check` (unit tests prove behavior)
and `e2e` list `command,behavior,artifact`.

### 4. First work item

`.loop/work-items/WI-001.md`:

```markdown
# WI-001: Product page shows price, stock and an "Add to cart" button

Kind: feature

## Outcome

Every product page under `/products/<slug>` shows the product name, price
formatted as `12.90 EUR`, the stock state ("In stock" or "Sold out"), and an
"Add to cart" button that is disabled when sold out. The product list links
to every product page. The cart count in the header updates without a page
reload.

## Acceptance criteria

## Out of scope

## Constraints and invariants

- No new runtime dependencies.
- Prices come from `src/data/products.json`; do not hard-code prices in pages.
- Only `src/**`, `tests/**`, `dist/**`, `.astro/**`, `test-results/**`, and
  `playwright-report/**` may change during EXECUTE (the last four are tool
  output).
- Payment and checkout are out of scope for this item.

## Design

## Execution slices

| Slice | Allowed paths | Frozen paths | Verifier IDs | Proof |
|---|---|---|---|---|

## Independent review

## Validation

## Handover

Handover is not authorization to merge, publish, release or deploy.
```

### 5. Run

From Codex or Claude Desktop, ask the connected build-loop interface to create
the work item and start a bounded job. Node, Playwright, and the selected worker
CLI remain separate machine prerequisites.

The equivalent shell path is:

```bash
./engine/orchestrator.sh start --root /path/to/shop
./engine/orchestrator.sh loop --root /path/to/shop \
  --host codex --provider hosts/codex/provider.sh \
  --review-host claude --review-provider hosts/claude/provider.sh --max-nodes 12
./engine/render-dashboard.sh --root /path/to/shop
```

What you will see: the agent writes acceptance criteria (DEFINE), plans two or
three slices (DESIGN), builds them one by one while the referee runs
`npm run check` after each (EXECUTE), a second agent reviews the exact diff
(REVIEW), Playwright runs against the built site (VALIDATE), and the run stops
at HANDOVER with a summary in the work item.

### 6. After handover

You look at the dashboard, read the handover section, and decide. Publishing
the `dist/` folder to your host is your action, not the loop's. A good habit
is a separate `deploy` script that you run by hand after you merged the
change.

### Pitfalls specific to websites

- Playwright downloads browsers into the home directory. Keep `HOME` in the
  allowed environment names or the VALIDATE step cannot find them.
- The referee checksums every file in the project except `.git`, including
  `node_modules/`. With a few thousand dependency files a step takes some extra
  seconds; that is normal. Keep `node_modules/` out of every allowed and
  artifact path so an installed package can never count as the agent's work.
- If the site needs a running preview server for e2e tests, start it inside
  the `e2e` script (Playwright's `webServer` option), not as a separate step.
- The referee compares the whole project before and after a step. Folders
  that the build or the tests write to (`dist/`, `.astro/`, `test-results/`,
  `playwright-report/`) must be in the allowed paths of every slice, or the
  step fails although the agent did nothing wrong.
