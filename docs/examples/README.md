# Examples: setting up the loop for different kinds of projects

Each example walks through one project type from an empty folder to a
finished first work item. They all follow the same seven steps; only the
answers change.

| Example | Project type | Stack used in the example | Profile |
|---|---|---|---|
| [Web shop](web-shop.md) | A public website with product pages and a cart | Static site built with Node (Astro) plus Playwright checks | `service` |
| [API](api.md) | A JSON HTTP API | Python, FastAPI, pytest, OpenAPI contract check | `api` |
| [ESP32 firmware](esp32-embedded.md) | A small embedded device (sensor + Wi-Fi) | PlatformIO, C++, host-side unit tests | `other` |
| [Web app](web-app.md) | A browser app with login and a dashboard | React, TypeScript, Vite, Vitest, Playwright | `desktop` |

You do not have to use these exact tools. Swap the commands and the loop stays
the same.

## The seven steps every example follows

1. **Create the project skeleton** with the tools of your stack, and make sure
   one build command and one test command already work by hand.
2. **Run the initializer** from a clean template checkout:
   `./bootstrap/init.sh /path/to/project`. It asks a short list of questions
   (project kind, language, commands, paths, evidence). Each example shows the
   answers to give.
3. **Review the candidate** in `.loop/candidate/`. Open
   `ACTIVATION-CHECKLIST.md` and go through it. If you want more than one check
   per phase (for example build **and** lint), edit `project.adapter.json` now
   and add commands; every command must list `command` in its `evidence_types`.
4. **Prove the checks can fail** by running the negative control you recorded
   (a command that is known to fail). If it passes, your verifier is wrong.
5. **Activate** by copying the files to their active names and adding the
   workflow, a blockers file, and a `.gitignore` entry for evidence:

   ```bash
   cd /path/to/project
   cp .loop/candidate/project.adapter.json .loop/project.adapter.json
   cp .loop/candidate/state.json          .loop/state.json
   cp /path/to/template/core/workflow.json .loop/workflow.json
   printf '# Blockers\n\n' > .loop/blockers.md
   mkdir -p .loop/work-items .loop/evidence
   printf '.loop/evidence/\n.loop/*.lock/\n.loop/dashboard.html\n' >> .gitignore
   git add -A && git commit -m "Activate the build loop"
   ```

6. **Write the first work item** as `.loop/work-items/WI-001.md` (start from
   `template/work-items/WI-001-template.md`). Fill in the title, the outcome,
   and the constraints. Leave acceptance criteria, design, and slices empty;
   the agent writes them in DEFINE and DESIGN. Make sure `state.json` names the
   same id (`"work_item_id": "WI-001"`). Commit it.
7. **Run the loop** from the template checkout and look at the dashboard:

   ```bash
   ./engine/orchestrator.sh start --root /path/to/project
   ./engine/orchestrator.sh loop  --root /path/to/project \
     --host codex --provider hosts/codex/provider.sh \
     --review-host claude --review-provider hosts/claude/provider.sh --max-nodes 12
   ./engine/render-dashboard.sh --root /path/to/project
   ```

   Any agent pair works; using a different agent for review is recommended.
   If the run stops with `BLOCKED`, read `.loop/blockers.md`, decide, tick the
   box, and run `resume` followed by `loop` again.

## Things that are the same for every project type

- The agent may change only the paths listed in the work item's execution
  slices. Everything else is frozen for that step.
- The referee runs your commands with a minimal environment. Put every
  environment variable name a command needs into `environment.allow_names`
  (never values, only names).
- Anything that touches the outside world, such as deploying, flashing a
  device in production, publishing a package, or paying a provider, is not a
  loop step. It happens after HANDOVER, by a human.
- Keep secrets out of the project adapter, the work item, and the commands.
