---
description: scout -> planner only; planner persists the plan to the Obsidian vault, no code changes
---
Use the subagent tool with the `chain` parameter to execute this workflow. Determine <repo> = the absolute path of the current working directory's git root (or cwd), <project> = its directory name, and <date> = today's date via `date +%F`. Prefix the planner task with: `Project: <project>. Repo: <repo>. Date: <date>.`

1. First, use the "scout" agent to find all code relevant to: $@
2. Then, use the "planner" agent to create an implementation plan for "$@" using the context from the previous step (use {previous} placeholder). Prefix its task with: `Project: <project>. Repo: <repo>.` — the planner checks prior plans in the Obsidian vault (Agents/<project>/plans/), writes the new plan there, and ends its output with a `## Plan File` path.

Do NOT run the executor - just return the plan plus the Plan File vault path. If the user approves it afterwards, run the "executor" agent as a single subagent call with task: `Project: <project>. Repo: <repo>.` followed by the {previous} planner output - the executor reads the authoritative plan from the vault file itself.
