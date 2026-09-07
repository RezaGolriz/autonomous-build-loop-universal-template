# Sources and further reading

This template did not invent the idea of running an AI coding agent in a loop.
The pages below are the ones the design leans on, grouped by what they are for.
Each line says in one sentence what you get from it.

Links were checked on **2026-09-07**. Web pages move, and the slash-command
syntax of chat clients changes between releases, so treat the tool documentation
as a pointer to the current page rather than as a fixed recipe.

## Loop engineering — the idea

- ["Loop Engineering" on unfairer-vorteil.net](https://unfairer-vorteil.net/loop-engineering)
  — the page this template started from. It is written in German and describes a
  cycle of four agents: a **Builder** that writes, a **Scout** that looks for
  what is worth doing, a **Growth** agent, and an **Orchestrator** that keeps
  them in order, all sharing one small "next steps" memory between runs.
  - [Video 1 embedded on that page](https://www.youtube.com/watch?v=NeyVq965bOM)
    — a walkthrough of the agent cycle.
  - [Video 2 embedded on that page](https://www.youtube.com/watch?v=uEdSEF3XCmk)
    — a second walkthrough of the same idea.
- [Addy Osmani, "Loop Engineering"](https://addyo.substack.com/p/loop-engineering)
  — the general argument: you get more out of an agent by designing the loop it
  runs in than by writing a better single prompt.
- [Addy Osmani, "Practical Loop Engineering"](https://medium.com/@addyosmani/practical-loop-engineering-ef207454e523)
  — the same idea with concrete loop shapes and worked patterns.
- [Sonar, "Loop engineering without verification is just automation"](https://www.sonarsource.com/blog/loop-engineering-without-verification-is-just-automation/)
  — the counterweight: a loop that repeats itself without an independent check
  only produces unchecked output faster.
- [ADTmag, "Loop Engineering Emerges as Developers Put AI Coding Agents on Repeat"](https://adtmag.com/articles/2026/07/01/loop-engineering-emerges-as-developers-put-ai-coding-agents-on-repeat.aspx)
  — a short overview of where the term came from and who is using it.

## Tool documentation for the cadence loop

The [cadence walkthrough](examples/loops/cadence.md) needs something that calls
`build-loop tick` again and again. These are the schedulers it names.

- [Claude Code — "Run prompts on a schedule"](https://code.claude.com/docs/en/scheduled-tasks)
  — the official page for scheduled tasks, including their minimum interval.
- [Developers Digest, "Claude Code Loops"](https://www.developersdigest.tech/blog/claude-code-loops)
  — a plain description of repeating a prompt inside an open session.
- [Developers Digest, the `/loop` command guide](https://www.developersdigest.tech/guides/loop-command)
  — the syntax of the in-session repeat command, with examples.
- [OpenAI Codex app — Automations](https://developers.openai.com/codex/app/automations)
  — the official page for recurring prompts in the Codex app.
- [Developers Digest, "Codex Automations"](https://www.developersdigest.tech/blog/codex-automations-recurring-engineering-work)
  — the same feature described as recurring engineering work.

## How this template relates to those ideas

We took two things from the loop-engineering discussion: the **four kinds of
loop** and the **shared next-steps memory**. The Builder becomes the goal and
backlog loops, the Scout becomes `scout` and the inbox, the Orchestrator becomes
`tick` and the schedule that calls it, and the shared memory becomes
`.loop/notes/next-steps.md`, which the next DEFINE brief and every scout brief
carry along.

Three things are different here.

1. **Every loop runs the same six phases.** DEFINE, DESIGN, EXECUTE, REVIEW,
   VALIDATE, HANDOVER. There is no fast lane. A documentation item and a bug fix
   go through the same gates.
2. **The referee is independent.** The worker never grades its own work. A
   separate review session records the verdict, and a runner outside the agent
   records the gate evidence. This is the point Sonar makes: *loop engineering
   without verification is just automation*. A loop that only repeats itself
   produces unchecked work faster, which is worse than doing less.
3. **Acceptance and authorization stay human.** A timer may move a run along
   inside limits a person wrote down; it can never accept a result, authorize a
   new item, promote a proposal, widen a scope, or merge, push, deploy or
   release anything. The next-steps memory is advisory: it is an input, never an
   approval.

Where to go next: [the four kinds of loop](LOOP-MODES.md) for the concepts, and
[the walkthroughs](examples/loops/README.md) for step-by-step runs on real
example projects.
