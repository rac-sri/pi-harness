---
description: Implement a request - one executor for small/clear tasks; scout → planner → executor only for complex or sensitive ones
---
Request: $@

Determine <repo> = the absolute path of the current working directory's git root (or cwd), <project> = its directory name, and <date> = today's date via `date +%F`.

If the request is a goal file path (from `/plan`, with `tags: [agent-plan, goal]`), use Path G. Otherwise choose Path A or B, defaulting to Path A.

**Path G: goal file.** Work through the goal one checkpoint segment at a time. Set the goal file to `status: executing` and its row in the sibling `mission.md` to `executing`. For each segment (the tasks a checkpoint covers), in order:
1. Run the segment's tasks in order. If a parallel group has two or more tasks, create one git worktree per task (`git worktree add <repo>/../.wt-<goal>-T<n> -b wt/<goal>/T<n>`) and dispatch those executors in parallel mode, each with its `cwd` set to its worktree. Each executor checkpoints its own task. Then cherry-pick their commits into <repo> in task order and remove the worktrees. Dispatch all other tasks to a single executor with `Project: <project>. Repo: <repo>. Date: <date>.`, the `## Plan File` path, and the task ids to do.
2. Dispatch one executor for checkpoint `Cn`: run the checkpoint's regression checks on <repo> and record a harness `checkpoint` commit (if the tasks already committed everything, `complete` is enough). It flips the segment's boxes.
3. Apply the checkpoint's review mode:
   - `auto`: dispatch an independent "reviewer" with the goal's correctness contract, the segment's commits and evidence paths, but not the executor's conclusions. Resolve Critical and Warning findings with an executor fix run, then review again.
   - `manual`: stop. Show the user the segment's commits, a short diff summary, and the verification results, and wait for them to approve or give feedback. Feedback becomes an executor fix run.
   - `both`: do `auto`, then `manual`.
   Only start the next segment once this review has passed.
4. Stop on any failed gate or PROVIDER UNAVAILABLE and report where you stopped.
When every checkpoint has passed, set the goal file to `status: done` and its `mission.md` row to `done`, then tell the user that `/plan <mission>` will plan the next goal.

**Path A or B.**

**Path A — direct (default).** Use when the change touches a few files, the fix or feature is clear from the request, and it does not alter protocol, cryptographic, persistence, or concurrency semantics. A bug fix with an obvious cause is Path A.
1. Dispatch the "executor" agent once, in single mode, with: `Project: <project>. Repo: <repo>. Date: <date>.` followed by the request and any context you already have. Do NOT run scout or planner, and do NOT write a plan file.
2. Report the files changed, the verification result, and the commit hash if one was made.

**Path B — planned.** Use only for multi-component changes, unclear designs, or protocol, cryptographic, persistence, or concurrency changes.
1. Use the "scout" agent to find relevant code (skip if fresh context is already present).
2. Use the "planner" agent with the scout output ({previous}), prefixed with `Project: <project>. Repo: <repo>. Date: <date>.`. It writes a plan file and ends with `## Plan File`.
3. Set the plan's `status: executing`, then dispatch the "executor" in single mode with the complete planner output and the same prefix.
4. Dispatch an independent "reviewer" with the original request, the correctness contract, the changed-code scope and the evidence paths, but not the executor's conclusions. Resolve Critical/Warning findings with a new executor run.
5. Report the plan path, checklist state and checkpoint commit hashes. Set `status: executed` only when all steps and gates are verified.

In both paths the executor must record verification with harness_check. If a subagent fails with PROVIDER UNAVAILABLE, stop and report it.
