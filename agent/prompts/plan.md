---
description: Micro-managed planning. Interviews you (grill-me) about ONE goal of a mission, asks for your checkpoints, then the planner writes <plan dir>/<mission>/<NN>-<goal>.md. No code changes.
---
Request: $@

Determine <repo> = the absolute path of the current working directory's git root (or cwd), <project> = its directory name, and <date> = today's date via `date +%F`. Prefix every planner task with `Project: <project>. Repo: <repo>. Date: <date>.` The plan root is the planner's configured directory (`agents/planner.json`, `{project}` expanded). Missions live in `<plan root>/<mission-slug>/`.

Ask every question to the user with the `question` tool, never in prose: 2-5 options, the recommended one first with `(Recommended)` at the end of its label, each with a one-line description. Set `multiSelect: true` when several answers can apply at once (which failure cases to cover, which goals to defer, which checks to run); the user then ticks checkboxes. The tool appends a final "type your own answer" option, so do not add one. For free-form input (a goal list edit, checkpoint lines), offer your proposal as the first option and let the user type their own. If the tool reports no interactive UI, ask in plain text.

You plan exactly ONE goal per run. Do not plan tasks for other goals, and do not run the executor.

1. **Mission.** Work out which mission this is. Use the slug the user named; otherwise list the existing mission folders and ask. For an existing mission, read its `mission.md` and take the first goal that is `pending` or `planning`, unless the user named one. For a new mission, use the grill-me skill to agree the ordered goal list (features or modules) first. Keep this to the list and one line per goal; do not go deeper into any goal yet.
2. **Context.** If fresh context for this goal is not already in the conversation, run the "scout" agent on the goal and on the earlier goal files' `## Deferred` notes.
3. **Grill.** Use the grill-me skill (`~/.agents/skills/grill-me/SKILL.md`) on this goal only. Ask one question at a time with the `question` tool, and answer from the codebase yourself where you can. Cover scope boundaries, interfaces, data, failure behaviour, verification, and what to leave for later goals. Push back on anything that adds code this goal does not need. Stop when no decisions are left open, then show a numbered summary of the decisions and confirm it with the `question` tool (Confirm / Change a decision).
4. **Draft.** Dispatch the "planner" with `Kind: draft`, the mission slug, the goal list, the goal to plan, the scout context, and the confirmed decisions written out in full. Show the user the numbered task list it returns.
5. **Checkpoints.** With the `question` tool, offer two or three sensible checkpoint splits as options (e.g. "after T4, after T10"); the user can type their own. Then ask once per checkpoint for its review mode: `manual` (they review), `auto` (reviewer agent), or `both` (reviewer first, then them). Point out tasks that share a parallel group, since those can run as parallel subagents between checkpoints. Accept task edits here too.
6. **Finalize.** Dispatch the "planner" with `Kind: finalize`, the goal file path, the checkpoints with their review modes, and any task edits. Report the goal file and `mission.md` paths, plus the command to run it: `/implement <goal file path>`.

When this goal is executed and marked `done`, the next `/plan <mission>` moves on to the next goal.
