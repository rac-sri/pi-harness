---
description: One executor for a small, clear task, with recorded verification and live progress
---
For "$@", inspect enough context to identify the affected files, then dispatch one executor directly with the request and relevant context. Skip scout and planner when the task is already clear. The executor must define a correctness contract and required checks with harness_check, implement, verify, and complete; report the run/state path and actual verification results. Do not create checkpoint commits unless the user requested them.

If the task changes protocol semantics, cryptographic behavior, crash consistency, or concurrency guarantees, use the full planning and independent review workflow instead. Do not reduce verification to make a task faster.
