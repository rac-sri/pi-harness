---
description: Implement a request - one executor for small/clear tasks; scout → planner → executor only for complex or sensitive ones
---
Request: $@

Determine <repo> = the absolute path of the current working directory's git root (or cwd), <project> = its directory name, and <date> = today's date via `date +%F`.

If the request is a goal file path (from `/plan`, with `tags: [agent-plan, goal]`), use Path G. Otherwise choose Path A or B, defaulting to Path A.

**Path G: goal file.** Starting or resuming this goal authorizes investigation and recovery within its agreed scope. Pass this authorization to every executor. A failed attempt does not require fresh permission to continue the same task. Keep task/checkpoint boxes unchecked until their evidence passes.

Work through the goal one checkpoint segment at a time. Executors tick the goal file's checklist themselves, so re-read the lines you are about to change right before each goal-file edit; never edit it from an earlier read. If an edit fails because the text was not found, re-read and retry the edit; do not re-dispatch the task. Set the goal file to `status: executing` and its row in the sibling `mission.md` to `executing`. For each segment (the tasks a checkpoint covers), in order:

1. Plan the segment's parallelism, then run its tasks. From each task's `Depends` and `Files`, group the segment into batches: tasks in one batch have no dependency on each other (direct or transitive) and disjoint files; each batch depends only on earlier ones. The planner's parallel letters are a starting point, not a limit. If any batch has two or more tasks, ask with `question` before running in parallel, with the batches in context (e.g. `[T2, T3] → T4 → [T5, T6, T7]`) and the trade-off: parallel cuts wall time but runs several executors at once (each with its own context, worktree and cold build), plus a merge step, so token cost is higher. Options: "Parallel as proposed (Recommended)", "Parallel for this and all later segments", "Sequential". If the user picked "all later segments", don't ask again this goal.
   - **Parallel batch:** create one git worktree per task under `/tmp` (`git worktree add /tmp/pi-worktrees/<project>/<goal>-T<n> -b wt/<goal>/T<n>`; the sandbox lets you write there but not next to <repo>) and dispatch those executors in one parallel-mode call (at most 8 tasks, 4 run at once), each with its `cwd` set to its worktree. Tell them not to edit the goal file: you tick their boxes after merging, so parallel executors don't race on it. Each executor checkpoints its own task. Then cherry-pick their commits into <repo> in task order, tick the merged tasks' boxes, and remove the worktrees (`git worktree remove` each, then `git branch -D wt/<goal>/T<n>`). A conflicting cherry-pick means the files weren't disjoint: abort it and run that task sequentially on <repo>.
   - **Sequential:** dispatch the remaining tasks to a single executor with `Project: <project>. Repo: <repo>. Date: <date>.`, the `## Plan File` path, and the task ids to do.
2. Dispatch one executor for checkpoint `Cn`: run the checkpoint's regression checks on <repo> and record a harness `checkpoint` commit (if the tasks already committed everything, `complete` is enough). It flips the segment's boxes.
3. Apply the checkpoint's review mode:
   - `auto`: dispatch an independent "reviewer" with the goal's correctness contract, the segment's commits and evidence paths, but not the executor's conclusions. Resolve Critical and Warning findings with an executor fix run, then review again.
   - `manual`: stop for the user's review. Run `node ~/.pi/agent/scripts/review-diff.mjs --repo <repo> <range>` over the segment's commits (`<first>^..<last>`), or with `--worktree -- <the segment's files>` when its work is uncommitted (name the files: untracked ones are included only under the given paths), and show its output verbatim in a code block: one line per file with `+added −removed` and the changed line ranges (`L12-30, L88`) in the current checkout. Under it, list the commits (short hash and subject) and each check's verification result. Then ask with `question`: "Approve C<n>", "Request changes", "Review the diff in pi", "Show the diff as HTML". For "in pi", call `review_diff` with the same range (or `worktree: true` and the paths) and ask again when the user closes it. For HTML, rerun the script with `--html`, run `open <printed path>` (if that fails, give the user the path), and ask again. Feedback becomes an executor fix run.
   - `both`: do `auto`, then `manual`.
   Only start the next segment once this review has passed.
4. A failed gate blocks advancing to dependent tasks or approving the checkpoint; investigate and fix it within the current task, then rerun the required verification. A public-document HTTP 401/403/429, timeout, or unavailable URL is a source-access failure, not an AI-provider failure: use available search/fetch tools, alternate official URLs, official repository docs/source, or existing local evidence. Avoid repeatedly fetching the same denied URL; do not bypass access controls. If an executor returns early without completion evidence, inspect its output and resume the same task with a concrete recovery approach; missing evidence alone does not revoke authorization. Stop only for a genuine AI-provider failure, user-requested pause/review, required permission or design decision, or an evidence gap that remains after reasonable independent recovery attempts. Report attempted sources and the precise missing evidence when blocked; never infer that the design is impossible from a failed fetch.
When every checkpoint has passed, set the goal file to `status: done` and its `mission.md` row to `done`, then tell the user that `/plan <mission>` will plan the next goal.

**Path A or B.**

**Path A: direct (default).** Use when the change touches a few files, the fix or feature is clear from the request, and it does not alter protocol, cryptographic, persistence, or concurrency semantics. A bug fix with an obvious cause is Path A.
1. Dispatch the "executor" agent once, in single mode, with: `Project: <project>. Repo: <repo>. Date: <date>.` followed by the request and any context you already have. Do NOT run scout or planner, and do NOT write a plan file.
2. Report the files changed, the verification result, and the commit hash if one was made.

**Path B: planned.** Use only for multi-component changes, unclear designs, or protocol, cryptographic, persistence, or concurrency changes.
1. Use the "scout" agent to find relevant code (skip if fresh context is already present).
2. Use the "planner" agent with the scout output ({previous}), prefixed with `Project: <project>. Repo: <repo>. Date: <date>.`. It writes a plan file and ends with `## Plan File`.
3. Set the plan's `status: executing`, then dispatch the "executor" in single mode with the complete planner output and the same prefix.
4. Dispatch an independent "reviewer" with the original request, the correctness contract, the changed-code scope and the evidence paths, but not the executor's conclusions. Resolve Critical/Warning findings with a new executor run.
5. Report the plan path, checklist state and checkpoint commit hashes. Set `status: executed` only when all steps and gates are verified.

In both paths the executor must record verification with harness_check. If a subagent fails with PROVIDER UNAVAILABLE, stop and report it.
