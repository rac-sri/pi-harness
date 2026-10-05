# Personal agent harness (pi)

Subagent-based orchestration: the **main session is the only orchestrator**;
every subagent is a fresh `pi --mode json -p --no-session` process with an
isolated context window, a restricted toolset, and zero memory of other runs.

## Layout

- `~/.pi/agent/extensions/subagent/` — the subagent tool (adapted from pi's
  example; adds `tools: none`, `noContext: true`, `scratch: true` support)
- `~/.pi/agent/agents/*.md` — agent definitions (frontmatter = capability policy)
- `~/.pi/agent/prompts/*.md` — workflow slash commands

## Agents

| agent     | tools                                        | delegates? | sees cwd/context? | notes |
|-----------|----------------------------------------------|------------|-------------------|-------|
| scout     | read, grep, find, ls, bash                   | no         | yes               | compressed findings for handoff |
| planner   | read, grep, find, ls, write                  | no         | yes               | writes plans; domain checklist: distributed/crypto/latency |
| executor  | read, bash, edit, write, grep, find, ls      | **no**     | yes               | implements plans verbatim; tests + benches |
| reviewer  | read, grep, find, ls, bash (read-only use)   | no         | yes               | adversarial: races, nonce reuse, hot-path costs |
| discuss   | **none**                                     | no         | **no** (noContext + scratch cwd) | pure reasoning; each call is amnesiac |

## The knobs you asked about

1. **Executor delegation** — controlled solely by its `tools:` frontmatter in
   `~/.pi/agent/agents/executor.md`. `subagent` is absent => the tool doesn't
   exist in its process (verified). To allow delegation: add `subagent` to the
   list. Recommendation: keep orchestration in the main session (chains), so
   fan-out stays visible and abortable.

2. **Discussion isolation** — `discuss.md` sets:
   - `tools: none` → spawned with `--tools ""` (empty allowlist excludes built-in AND extension tools)
   - `noContext: true` → spawned with `--no-context-files` (no AGENTS.md/CLAUDE.md)
   - `scratch: true` → spawned with cwd = throwaway `mktemp -d` under /tmp,
     removed after the run (ignores any `cwd` passed by the caller)
   - process isolation → no memory of the executor or of prior discuss calls;
     to hold a thread, re-send "conversation so far" in the task text.

## Agent definitions

- `~/.pi/agent/agents/<name>.md` — role + capability policy (frontmatter: `tools`, `noContext`, `scratch`)
- `~/.pi/agent/agents/models.json` — **single source of truth for provider/model per agent**

```json
{
  "default": "opencode-go/qwen3.8-flash",
  "scout":    "opencode-go/deepseek-v4.1-flash",
  "planner":  "opencode-go/glm-5.3",
  "executor": "opencode-go/kimi-k2.7-code",
  "reviewer": null,
  "discuss":  "opencode-go/kimi-k3"
}
```

`agents/models.json` is authoritative. Managed launches use `default`, unless `--model`, `--provider` or `--models` is explicitly supplied. Subagents use their role entry; null or omitted role entries use `default`. Frontmatter and the active session do not override JSON selection. Missing/invalid JSON fails visibly. Read fresh on each launch/dispatch; changes to the main launch default apply on the next launch. Keys starting with `_` are comments. `settings.json` contains Pi's compatibility defaults (`defaultProvider` + bare `defaultModel`); the managed launcher overrides them from JSON. `advisor.json` is separate configuration for the advisor plugin, not this harness's subagent roles.

Pi uses `~/.pi/agent/` as its standard global config directory (`getAgentDir()`), containing settings, credentials, sessions, extensions, prompts and personal agent definitions. The outer `~/.pi/` is the workspace here. Project-specific agents use `<repo>/.pi/agents/`. `PI_CODING_AGENT_DIR` can change the global directory, but the managed installation remains in this layout.

## Modes of the `subagent` tool

- Single: `{agent, task}`
- Parallel: `{tasks: [{agent, task}, ...]}` (max 8, 4 concurrent)
- Chain: `{chain: [{agent, task-with-{previous}}, ...]}` — stops at first failing step

## Slash commands

- `/discuss <topic>` — isolated reasoning (context must be pasted into the task)
- `/plan <request>` — scout → planner chain, no code changes
- `/implement <request>` — scout → planner chain, status update, then executor single dispatch
- `/build-and-review <request>` — scout → executor → reviewer → executor(fix)

## Adding a project-scoped agent

Drop a `.md` in `<repo>/.pi/agents/` and pass `agentScope: "both"` when calling
the tool (interactive confirmation prompts for project-local agents by default —
repo-controlled prompts can run bash).

## Plan persistence (Obsidian vault)

- Vault: `~/Library/CloudStorage/ProtonDrive-…/Obs` (ProtonDrive E2E-encrypted mount)
- Convention: `<vault>/Agents/<project>/plans/YYYY-MM-DD-<slug>.md` with frontmatter `project/date/repo/status/supersedes/tags:[agent-plan]`
- planner (now has `write`): lists Agents/<project>/ first (per-project history), writes plan, **reads it back** (remote-mount stale-write check), falls back to `<repo>/.pi/plans/` with a flagged warning if the mount fails
- executor: reads the `## Plan File` path as the authoritative plan; main session updates plan `status:` after approval/execution
- creds-guard: agents may only touch `<vault>/Agents/**`; the rest of the vault (personal notes) is unreadable to every agent; sessions whose cwd is inside the vault are exempt
- Date rule: planner never guesses today's date — orchestrator passes `Date:` (from `date +%F`)

## Checklist & checkpoint protocol (omp-derived, file-based, zero new tools)

- Plans end with `## Checklist`: `- [ ] Sn: <instruction> | verify: <cmd>` lines + `Cn` checkpoint lines (gates: full suite, bench target, rollback-safe commit). Ids S1../C1.. are stable; the vault file IS the todo state.
- Doctrine (from omp, trimmed): execution spec, ZERO design decisions left to executor; unverified claims marked `unverified - confirm first`; load-bearing assumptions carry pre-decided `if X fails, do Y` fallbacks; banned filler sections (Non-Goals/Alternatives/Risks-prose); every step has concrete verify, not just "tests pass".
- Executor: resumes at first unchecked box; flips `- [ ]`→`- [x]` with edit only after verify passes; at each passing checkpoint runs the gate, commits `plan(<project>)/<Cn>`, records the hash; NEVER crosses a failed checkpoint; keeps the file truthful on interruption.
- Reviewer: audits `- [x]` lines against evidence (commit exists, verify passes, invariant holds); box-without-evidence = Critical.
- Undo = `git reset` to last checkpoint commit (omp's checkpoint/rewind tool, replaced by plain git discipline).
- Lifecycle: frontmatter `status: proposed -> executing -> executed` (main session flips after chains).

## Sandbox / isolation layers (installed)

1. **Capability scoping** (frontmatter `tools`, CLI `--tools` allowlist including an empty list, `noContext`, `scratch`) — tool-existence boundaries for all subagents. Invalid explicit tool lists grant zero tools; omitted lists inherit defaults.
2. **OS sandbox for bash**: `~/.pi/agent/extensions/sandbox/` (@anthropic-ai/sandbox-runtime → macOS Seatbelt). Config: `~/.pi/agent/extensions/sandbox.json`. Credential paths and the whole Obsidian vault are denied to bash; vault operations use file tools. Initialization failures block bash. Project settings can add denials or select subsets of global allowlists, but cannot weaken global isolation. Explicit `--no-sandbox` or trusted global `enabled: false` remains the escape hatch.
3. **creds-guard extension**: `~/.pi/agent/extensions/creds-guard.ts` — `tool_call` hook blocking read/write/edit/grep/find/ls/bash on the same paths (covers the non-bash built-in tools the OS sandbox can't reach).
4. Verified live: obfuscated `~/.ssh` read denied by Seatbelt ("Operation not permitted"); guard blocks .ssh + auth.json strings at tool level; `.env` blocked via read tool AND bash; `.env.example` allowed; vault out-of-subtree reads blocked; guard self-edit possible (path-scoped).
5. `.env` scope: creds-guard blocks ANY depth (path substring). OS denyRead `".env"` is **session-cwd-relative** — covers the repo-root .env of the process whose cwd is the repo (all subagents: dispatched with cwd=repo). Nested `apps/x/.env` = guard-layer only. `~/.env` denied globally.
6. Guard resolves file targets against cwd, normalizes traversal, and resolves existing symlinks/parents before matching credentials or the vault boundary. Recursive grep/find cannot start above protected credential paths. Bash vault access is blocked; use read/write/edit on `Agents/`.
7. Escape hatch: `pi --no-sandbox`; guard edits require touching creds-guard.ts (itself in denyWrite-protected ~/.pi/agent/extensions).

## Modes (plan / execute / discuss)

- Extension: `~/.pi/agent/extensions/modes/index.ts` — three-position mode switch for the MAIN session; `/mode discuss|plan|execute`, bare `/mode` = status, Ctrl+Alt+M cycles. **Default on new sessions: DISCUSS.**
- Each mode = tool-activation filtering + `tool_call` gates (defense-in-depth) + a `[MODE: ...]` instruction injected every run:
  - **discuss**: no read/edit/write/bash/lens; only web tools, advisor, and subagent dispatch restricted to the `discuss` agent
  - **plan**: read-only; edit/write off; bash allowlisted to read-only commands (`find -delete`/`-exec`, redirects, rm/mv/npm/git-writes all rejected); subagent dispatch restricted to scout/planner/reviewer/discuss (executor blocked)
  - **execute**: everything restored; checklist/checkpoint doctrine in the injected prompt
- Subagent children are exempt from the main mode switch (`PI_SUBAGENT_CHILD=1`), but scout/reviewer bash calls use the shared read-only policy (`PI_SUBAGENT_READ_ONLY=1`, inherited by descendants). Restricted main modes only dispatch personal agents, preventing project definitions from overriding allowed roles.
- Regression suite: `node agent/tests/harness.test.mjs` from `~/.pi` using Node >=22.19.0 (Pi 1.0.1's runtime requirement). Tests cover command policy, canonical paths, mode injection/gates, zero-tool dispatch, cancellation escalation, sandbox policy, and extension loading. Restart Pi sessions after changing extensions.

## Known env issue

`amazon-bedrock` env credentials (STS) are currently invalid
(`UnrecognizedClientException`). `opencode-go` and `google` providers are ready.
Refresh the AWS creds or select a working model before interactive use.
