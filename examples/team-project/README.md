# A small real project: notes and CSV export

This is a deliberately small **starting project**. It uses Node.js 22+ and no
external packages. It already adds notes and exports simple rows. Two useful
improvements are left for an agent team to make:

| Work package | User-visible result | Allowed changes |
|---|---|---|
| A: Note titles | Blank titles are rejected and surrounding spaces are removed | `src/notes.mjs`, `test/notes.test.mjs` |
| B: CSV export | Commas, quotes and line breaks are escaped correctly | `src/export.mjs`, `test/export.test.mjs` |

The tasks touch separate files. Each should run in its own project copy and
receive an independent review. Acceptance and combining both changes remain
your decisions.

## Ask your agent

> Use the bundled notes example for a real team trial. Prepare two isolated
> copies, one for title validation and one for CSV escaping. Let me choose the
> exact builder and reviewer models. Show their file access, commands, time
> limits and every approval page before starting. Do not merge or publish.

Your agent should inspect the copied project, prepare its adapter and work-item
scope, and wait for your human approvals. Do not activate this example inside
the Build Loop source checkout itself.

The positive check is `npm test`. The meaningful known-failing control is
`node scripts/negative-control.mjs`: it expects a deliberately wrong output,
prints the `NEGATIVE_CONTROL` message and exits 42. Preserve that file and
`package.json` as frozen verifier infrastructure during both tasks.

## What the finished features should do

- Adding `"  Shopping  "` creates a title of `"Shopping"`.
- Adding `"   "` fails clearly; existing notes are not modified.
- Exporting a title of `Milk, bread` puts that title in double quotes.
- Exporting a title containing a double quote doubles that quote inside the
  quoted CSV field. A line break also requires a quoted field.
- Simple titles, row order, IDs and the trailing newline keep working.

Ask the agent to add regression tests for those cases. A passed baseline alone
does not prove these new features work: they are intentionally unfinished here.

## For someone comfortable with the terminal

From this example folder:

```bash
npm test
node scripts/negative-control.mjs
```

The second command is supposed to fail with exit 42. Build Loop checks that
exact failure during the approved activation probe.

After both package handovers, inspect each diff, accept deliberately, combine
the changes yourself and run the combined tests. The supervisor does not infer
that integration happened merely because both progress bars reached 100%.

See [the team guide](../../docs/TEAMS.md) for setup, or
[the automatic mock demonstration](../team-demo/README.md) for the orchestration
test that does not call real AI providers.
