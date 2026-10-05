---
description: Full workflow - scout gathers context, planner plans, executor implements (orchestrated chain, no agent delegates on its own)
---
Run scout → planner as a subagent chain, then dispatch the executor separately after setting the persisted plan's status to `executing`. Determine <repo> = the absolute path of the current working directory's git root (or cwd), <project> = its directory name, and <date> = today's date via `date +%F`.

1. First, use the "scout" agent to find all code relevant to: $@
2. Then, use the "planner" agent to create an implementation plan for "$@" using the context from the previous step (use {previous} placeholder). Prefix its task with: `Project: <project>. Repo: <repo>. Date: <date>.` — the planner checks prior plans in the Obsidian vault (Agents/<project>/plans/), writes the new plan there, and ends its output with a `## Plan File` path.
3. Read the planner's Plan File, set `status: executing`, then use the "executor" agent in single mode with the planner's complete output and `Project: <project>. Repo: <repo>. Date: <date>.` — the executor reads the authoritative plan and works its checklist. Verification must pass before boxes flip; failed gates stop execution.

Pass scout output to planner via {previous}; pass the complete planner output to the executor yourself. All delegation happens in the main session. After execution, report the vault path, final checklist state and checkpoint commit hashes. Set `status: executed` only when all steps and gates are verified; interrupted or failed execution stays `executing`. Resume with a single executor call: `Project: <project>. Repo: <repo>. Resume from <Plan File path>`.
