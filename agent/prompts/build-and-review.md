---
description: executor works the plan checklist, reviewer audits checked boxes against real evidence, executor fixes - scout first if context is stale
---
Use the subagent tool with the `chain` parameter to execute this workflow. Determine <repo> = the absolute path of the current working directory's git root (or cwd), <project> = its directory name, and <date> = today's date via `date +%F`.

1. First, use the "scout" agent to gather context about: $@ (skip this step if recent scout context is already in this conversation)
2. Then, use the "executor" agent to carry out: $@ (include the scout context via {previous} if step 1 ran). If this step follows a planner run, prefix the task with `Project: <project>. Repo: <repo>.` and pass the planner's {previous} so the executor works the plan file's `## Checklist`: verify-gated steps, checkpoint commits, boxes flipped in the vault file, stop-don't-cross on failed gates.
3. Then, use the "reviewer" agent to adversarially review the changes: pass it the Plan File path (from the executor's `## Plan Status` output) plus the checkpoint commit hashes it reported, so it audits every `- [x]` against evidence - commits exist, verify commands pass, invariants hold. A checked box without evidence is a Critical finding.
4. Finally, use the "executor" agent to fix only the Critical and Warnings items raised by the reviewer ({previous} placeholder), resuming the same checklist so progress stays recorded in the vault file.

If the reviewer returns zero Critical/Warning items, skip step 4 and report the review summary. Keep `status: executing` until all checklist steps and gates pass and every Critical/Warning finding is resolved. Only then set `status: executed`. Re-review fixes before declaring completion. The executor output must include the absolute Plan File path for the reviewer.
