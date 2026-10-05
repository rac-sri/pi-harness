---
description: Brainstorm/reason about an idea with the discuss agent (no tools, no project context, no memory of prior runs)
---
Use the subagent tool in SINGLE mode to invoke the "discuss" agent with this topic:

$@

Rules for how you (the main agent) drive this:
- DISCUSS mode can read the working tree (`read`/`grep`/`find`/`ls`) but not run commands. Gather any code facts you need yourself before dispatching.
- The discuss agent sees nothing but the text you send it. Include ALL relevant context (design sketch, constraints, file excerpts, the actual question) inside the task string. Do NOT rely on it knowing the repo, this session, or anything the discuss agent "earlier" did - each invocation starts fresh with zero history.
- Do not ask it to look at files; it cannot. If the discussion needs code facts, gather them yourself (or via scout) and paste the relevant excerpts into the task.
- If the user wants a back-and-forth, run multiple single invocations, each carrying the accumulated thread in the task text ("Here is the conversation so far: ... User's reply: ..."). Never chain discuss with executor/planner steps.
- Return the discuss agent's output to the user essentially verbatim, plus your own brief take.
