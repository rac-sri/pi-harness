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
  - **discuss**: read-only repo inspection (`read`/`grep`/`find`/`ls` + read-only code intelligence); `bash`/`edit`/`write`/`pi_lens_activate_tools` blocked; web tools, advisor, and subagent dispatch restricted to the `discuss` agent
  - **plan**: read-only; edit/write off; bash allowlisted to read-only commands (`find -delete`/`-exec`, redirects, rm/mv/npm/git-writes all rejected); subagent dispatch restricted to scout/planner/reviewer/discuss (executor blocked)
  - **execute**: everything restored; checklist/checkpoint doctrine in the injected prompt
- Subagent children are exempt from the main mode switch (`PI_SUBAGENT_CHILD=1`), but scout/reviewer bash calls use the shared read-only policy (`PI_SUBAGENT_READ_ONLY=1`, inherited by descendants). Restricted main modes only dispatch personal agents, preventing project definitions from overriding allowed roles.
- Regression suite: `node agent/tests/harness.test.mjs` from `~/.pi` using Node >=22.19.0 (Pi 1.0.1's runtime requirement). Tests cover command policy, canonical paths, mode injection/gates, zero-tool dispatch, cancellation escalation, sandbox policy, and extension loading. Restart Pi sessions after changing extensions.
  - The full suite aborts inside a sandboxed Pi shell (`EPERM` lstat on `agent/auth.json` during the creds-guard symlink check). These slices run safely from any shell: `agent/tests/modes-check.mjs` (mode activation/gates/injection), `agent/tests/advisor-config-check.mjs` (advisor config), `agent/tests/advisor-session-header.mjs` (Advisor session-id patch), `agent/tests/advisor-patch-guard.mjs` (patch self-healing guard).

## Advisor model (pi-advisor-flow)

`advisor.json` pairs a fast Executor with a stronger Advisor; the same-model guard skips calls when both match, so the two must differ.

```json
{ "executor": "opencode-go/qwen3.8-flash", "advisor": "opencode-go/kimi-k3" }
```

Executor = the session default (cheap, high request allowance); Advisor = `kimi-k3`, the strongest reasoning model on the OpenCode Go catalog (490 requests/month allowance — the Advisor only sees the conversation, so it is rarely the bottleneck). Edit the file or use `/advisor-models` (pick Executor, Advisor, optional fallback) and `/advisor-settings` (plan/failure/completion gates, git context, effort, whitelist). Unknown keys are preserved but warned about; only keys from the plugin's schema are valid (e.g. `advisor`, `advisorFallbackModel`, `advisorEffort`, `alwaysOn`). Requires `packages: ["npm:pi-advisor-flow"]` in `settings.json` and a session restart. Validate an edit with `node agent/tests/advisor-config-check.mjs` (schema-validates `advisor.json` and asserts advisor ≠ executor).

- **Local patch (required for OpenCode advisors).** pi-advisor-flow 0.11.1 builds Advisor stream options as `{reasoning, signal}` and never passes a session id, but pi-ai derives `x-opencode-session` only from `options.sessionId` (`pi-ai/dist/providers/opencode-headers.js`). OpenCode Go now rejects requests without it (`400 {"type":"MissingSessionID"}`), so **every consultation against an `opencode-go/*` Advisor failed** while the Executor was fine — Pi's agent loop supplies `sessionId` (`core/agent-session.js`) and the Advisor runs outside that loop. Three layers keep the fix in place:
  1. `agent/patches/advisor-session-header.mjs` threads `ctx.sessionManager.getSessionId()` through `ResolvedConfiguredModel` into both stream paths. Literal anchors from 0.11.1, idempotent, exits non-zero with `UPSTREAM CHANGED` if an anchor stops matching exactly once, and accepts a package dir so tests can run it against a pristine tarball.
  2. `npm/package.json` `postinstall` re-applies it, because `pi update` replaces the package (`package.json` → `pi.extensions: ["./dist/index.js"]`, so `dist/index.js` is the file that actually runs; `src/model-stream.ts` is patched in step for parity).
  3. `extensions/advisor-patch-guard.ts` re-checks the loaded bundle at extension load and, if it reverted, re-applies and notifies on `session_start`. Extensions are imported at startup, so `/reload` can still be needed for the live process; the guard only guarantees the on-disk fix.
  Proven by `node agent/tests/advisor-session-header.mjs` (8 checks: the id reaches `streamSimple` *and* `stream`, `withOpenCodeSessionHeader` yields the header only when it is present, the patched bundle loads with zero extension-loader errors, script output is byte-identical to the installed files) and `node agent/tests/advisor-patch-guard.mjs` (7 checks on a pristine `pi-advisor-flow@0.11.1` fixture: re-applies when unpatched, byte-identical when already patched, silent no-op when the plugin is absent). Upstream report still owed: https://github.com/philipbrembeck/pi-advisor
- No `advisorFallbackModel` on purpose: a fallback would mask header/auth/config failures instead of surfacing them.

## Known env issue

`amazon-bedrock` env credentials (STS) are currently invalid
(`UnrecognizedClientException`). `opencode-go` and `google` providers are ready.
Refresh the AWS creds or select a working model before interactive use.
