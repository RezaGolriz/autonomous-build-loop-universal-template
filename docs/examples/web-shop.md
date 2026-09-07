# Example: a web shop (public website)

Goal: a small shop website with a product list, product pages, and a cart.
The site is generated at build time and published as static files; the
checkout talks to an external payment provider.

This illustrative recipe uses Node with Astro, Vitest, and Playwright. Confirm
current package APIs and commands in your repository; this page is not a
runnable fixture.

## 1. Project skeleton

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

## 2. Initializer answers

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

## 3. Prepare and activate

Follow the [common setup](README.md#common-setup). Review the generated-output
paths, browser command, and protected test files in the confirmation view.
Note that the referee requires the commands of **each** phase to declare every
required evidence type. That is why both `check` (unit tests prove behavior)
and `e2e` list `command,behavior,artifact`.

## 4. First work item

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

## 5. Run

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

## 6. After handover

You look at the dashboard, read the handover section, and decide. Publishing
the `dist/` folder to your host is your action, not the loop's. A good habit
is a separate `deploy` script that you run by hand after you merged the
change.

## Pitfalls specific to websites

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
