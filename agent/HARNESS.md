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
| planner   | read, grep, find, ls, write                  | no         | yes               | writes one goal file per mission goal (draft → finalize); domain checklist |
| executor  | read, bash, edit, write, grep, find, ls, harness_check | **no**     | yes               | implements plans verbatim; tests + benches |
| reviewer  | read, grep, find, ls, bash, harness_check (status only) | no         | yes               | adversarial: races, nonce reuse, hot-path costs |
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

## Skills

Global settings exclude `~/.pi/agent/skills/ethskills/**` and the security pack under `~/.agents/skills/better-auth-best-practices/*/` (46 skills, ~20 KB of system prompt every session). To re-enable one globally, add an exact force-include after the exclusions in `settings.json`, e.g. `"+/Users/rachitsrivastava/.pi/agent/skills/ethskills/gas"`; to re-enable a whole set, delete its `!` line.

Subagent failures caused by 429/402/401/403/quota errors are annotated `PROVIDER UNAVAILABLE` so the main session stops instead of re-dispatching.

## Agent definitions

- `~/.pi/agent/agents/<name>.md` — role + capability policy (frontmatter: `tools`, `noContext`, `scratch`)
- `~/.pi/agent/agents/models.json` — **single source of truth for provider/model per agent**

```json
{
  "default": "openai/gpt-6.1-sol",
  "scout":    "openai/gpt-6-luna",
  "planner":  null,
  "executor": null,
  "reviewer": null,
  "discuss":  null
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
- `/plan <mission or request>` — plans ONE goal: grill-me interview → planner draft → user picks checkpoints + review modes → planner finalize; no code changes
- `/implement <request>` — direct executor for clear small tasks; scout/planner for complex or sensitive tasks, then executor
- `/build-and-review <request>` — optional scout → executor → reviewer → executor only when fixes are needed

## Adding a project-scoped agent

Drop a `.md` in `<repo>/.pi/agents/` and pass `agentScope: "both"` when calling
the tool (interactive confirmation prompts for project-local agents by default —
repo-controlled prompts can run bash).

## Plan persistence

- Vault: `~/Library/CloudStorage/ProtonDrive-…/Obs` (ProtonDrive E2E-encrypted mount)
- Configure `~/.pi/agent/agents/planner.json`: `{"directory": "~/plans/{project}"}`. Absolute paths, `~`, and paths relative to the dispatched working directory are supported; `{project}` expands to the kebab-case task project. Configuration reloads on every planner dispatch; missing config preserves the original vault default and invalid config fails visibly. Restart or `/reload` after installing the extension change.
- Layout: `<vault>/Agents/<project>/<mission>/mission.md` (ordered goal list with `pending → planning → planned → executing → done`) and `<vault>/Agents/<project>/<mission>/<NN>-<goal>.md` (one feature/module: micro tasks T1..Tn with verify commands and parallel groups, user-chosen checkpoints C1..Cn each with review `manual|auto|both`). Goals are planned one at a time; later goals may revisit earlier ones (recorded under `## Deferred`) rather than adding speculative generality.
- `/implement <goal file>` runs it checkpoint by checkpoint: parallel-group tasks run as parallel executors in separate git worktrees (the writer lock is per repository root) and are cherry-picked back in task order; each checkpoint then gets its review (`manual` stops for you, `auto` runs the reviewer, `both` does reviewer then you) before the next segment starts.
- planner (now has `write`): reads the mission index and earlier goal files first, writes the goal file and mission index, **reads it back** (remote-mount stale-write check), falls back to `<repo>/.pi/plans/` with a flagged warning if storage fails
- executor: reads the `## Plan File` path as the authoritative plan; main session updates plan `status:` after approval/execution
- creds-guard: agents may only touch `<vault>/Agents/**`; the rest of the vault (personal notes) is unreadable to every agent; sessions whose cwd is inside the vault are exempt
- Date rule: planner never guesses today's date — orchestrator passes `Date:` (from `date +%F`)

## Live progress and dispatch speed

- `extensions/compact-read.ts` keeps native read execution and replaces its display with a muted `READ` path/range and a short line-count summary. Text contents stay hidden even in expanded results; the agent still receives the native content. Read errors remain visible. Subagent read activity uses the same neutral labels. Native image previews still follow Pi's image-display setting.
- Subagents stream provider thinking (when exposed), response text, tool activity, and elapsed time while running. The collapsed view shows a short tail; Ctrl+O expands it. Expanded completed results retain a bounded provider-thinking excerpt, separate from final output. UI updates are throttled and a heartbeat keeps elapsed time visible during quiet waits. The footer shows main-response speed; child panels show the latest child-response speed. Rates use provider-reported output tokens divided by message-start-to-end time, including provider wait and reasoning time but excluding tool execution. Most providers report usage only at completion, so streaming shows a placeholder until counts arrive.
- `agents/runtime.json` reloads on each dispatch. It configures role thinking levels, deadline seconds, maximum completed turns, total reported output tokens, and the update interval. Explicit thinking suffixes in models.json take precedence. Output/turn limits are evaluated at completed assistant messages, so they are soft bounds; deadlines terminate the process group, escalating after five seconds.
- Small tasks skip unnecessary scout/planner launches; sensitive changes retain planning and independent review. Built-in-only children load only the credential guard plus the sandbox when shell/verification tools are needed; children with custom extension tools retain normal extension discovery. Children skip slash-prompt discovery, and the tool-less discuss role skips skill discovery. Model/provider latency remains outside the harness's control; end-to-end model latency remains unmeasured. In a local three-run extension-loading comparison, median initialization fell from 562 ms (all existing extensions/plugins) to 452 ms (guard + sandbox); this excludes provider calls, full process startup, and session-start hooks.

## Verification and checkpoint protocol

- `harness_check` is registered by the sandbox extension and uses the same sandbox operations as bash. Every executor task defines an immutable correctness contract and required `{id, command, property}` checks before implementation. Use one unique run id per checkpoint.
- State transitions: `pending → implemented → verified → committed`. `verify` records the registered command, root cwd, optional HARNESS_SEED, exit status, timestamps, HEAD/tree ids, source fingerprints, full output log, and its SHA-256. Failed commands and commands that change source produce failure evidence. `complete` requires every check's latest evidence to match the current checkout and unchanged output logs.
- Evidence/state lives under `~/.pi/agent/harness/runs/<repo-hash>/<run>/`. Direct file edits and sandboxed shell writes to the harness directory are blocked. Markdown checklists summarize this state; they do not replace it. Status reports evidence freshness for independent review.
- `checkpoint` requires explicit files and a commit message, rejects preexisting staged work or other changed files, verifies evidence, then stages and commits that scope. Hook edits and a dirty checkout after commit prevent recording a committed checkpoint. It does not discard changes or reset the repository.
- The dispatcher rejects executor success without a successful complete/checkpoint event, and invalidates that completion on subsequent writes/edits/bash calls. All checkpoints observed in that dispatch must complete. Later checkpoints must include regression gates covering the combined result.
- A cross-process writer lock prevents simultaneous mutating subagent dispatches in the same checkout. Read-only scout/reviewer calls can run concurrently. It does not prevent user edits, direct main-session edits, or writers in other checkouts; fingerprints detect changes between verification boundaries. Crashed locks fail visibly and require inspection before manual removal.
- Fingerprints cover tracked/nonignored untracked files, deletion, permissions, in-repository file symlinks and their contents, and initialized submodule checkouts. Ignored files, installed dependencies, external services, and toolchain state are outside this coverage; pin and describe them in the contract. Uninitialized submodules and unsupported/external symlinks fail closed. Keep plan metadata outside the checkout or ignored if checkpoint commits are required.
- Distributed plans declare consistency/failure/recovery assumptions and safety/liveness properties. Crypto plans declare the threat model, established primitive/library, nonce/key lifecycle, and authentication/encoding boundaries. Verification is selected from applicable failure injection, consistency checking, model checking, vectors, rejection tests, and interoperability checks. New cryptographic constructions require specialist human review.
- Lifecycle: plan frontmatter remains `proposed → executing → executed`; final acceptance requires recorded evidence and resolution of reviewer findings.

## Regression checks and domain evaluations

Run `node agent/tests/typecheck.mjs` (requires the installed TypeScript compiler), `node agent/tests/harness.test.mjs`, `node agent/tests/verification-check.mjs`, `node agent/tests/subagent-progress-check.mjs`, and `node agent/tests/domain-eval.mjs`. The additional checks exercise source freshness, failure evidence, scoped staging, output integrity, live rendering, dispatch limits, and executor completion rejection.

`domain-eval.mjs` distinguishes deliberately broken and reference implementations of lost acknowledgement recovery, duplicate application, nonce reuse after restart, and malformed-signature rejection. `--agent` runs the configured executor against broken/clean pairs and records independent test results, unnecessary clean-code edits, evidence completion, elapsed time, output tokens, and reported cost under `agent/harness/evals/`; `--case <id>` selects a pair. Live evaluation incurs provider usage and was not run as part of offline validation. These bounded fixtures measure a few engineering behaviors, not protocol security or full distributed correctness.

## Sandbox / isolation layers (installed)

1. **Capability scoping** (frontmatter `tools`, CLI `--tools` allowlist including an empty list, `noContext`, `scratch`) — tool-existence boundaries for all subagents. Invalid explicit tool lists grant zero tools; omitted lists inherit defaults.
2. **OS sandbox for bash**: `~/.pi/agent/extensions/sandbox/` (@anthropic-ai/sandbox-runtime → macOS Seatbelt). Config: `~/.pi/agent/extensions/sandbox.json`. Credential paths and the whole Obsidian vault are denied to bash; vault operations use file tools. Initialization failures block bash. Project settings can add denials or select subsets of global allowlists, but cannot weaken global isolation. Explicit `--no-sandbox` or trusted global `enabled: false` remains the escape hatch.
3. **creds-guard extension**: `~/.pi/agent/extensions/creds-guard.ts` — `tool_call` hook blocking read/write/edit/grep/find/ls/bash on the same paths (covers the non-bash built-in tools the OS sandbox can't reach).
4. Verified live: obfuscated `~/.ssh` read denied by Seatbelt ("Operation not permitted"); guard blocks .ssh + auth.json strings at tool level; `.env` blocked via read tool AND bash; `.env.example` allowed; vault out-of-subtree reads blocked; guard self-edit possible (path-scoped).
5. `.env` scope: creds-guard blocks ANY depth (path substring). OS denyRead `".env"` is **session-cwd-relative** — covers the repo-root .env of the process whose cwd is the repo (all subagents: dispatched with cwd=repo). Nested `apps/x/.env` = guard-layer only. `~/.env` denied globally.
6. Guard resolves file targets against cwd, normalizes traversal, and resolves existing symlinks/parents before matching credentials or the vault boundary. Recursive grep/find cannot start above protected credential paths. Bash vault access is blocked; use read/write/edit on `Agents/`.
7. Escape hatch: `pi --no-sandbox`; guard edits require touching creds-guard.ts (itself in denyWrite-protected ~/.pi/agent/extensions).

## Modes (plan / execute / discuss)

- Extension: `~/.pi/agent/extensions/modes/index.ts` — three-position mode switch for the MAIN session; `/mode discuss|plan|execute`, bare `/mode` = status, Tab cycles (Ctrl+Alt+M also works). The bottom status bar shows `MODE: DISCUSS`, `MODE: PLAN`, or `MODE: EXECUTE` from startup and updates immediately on switches. Autocomplete uses Ctrl+Space, configured in `agent/keybindings.json`. **Default on new sessions: DISCUSS.**
- Each mode = tool allowlists + `tool_call` gates (defense-in-depth) + a `harness_mode` system-prompt section. The section is byte-stable while the mode is unchanged, so the provider prompt cache survives across turns (do not reintroduce per-turn messages or `context` hooks that rewrite history). Every mode carries the same scope rules: do exactly what was asked, smallest change, no unrequested files/migrations/plan docs, stop on provider failures.
  - **discuss**: read-only repo inspection; `bash`/`edit`/`write`/`pi_lens_activate_tools` blocked; subagent dispatch restricted to `discuss`
  - **plan**: read-only; bash allowlisted to read-only commands; executor blocked; plans are inline unless the user asks for a persisted one or runs `/plan`
  - **execute**: full tools; work is done directly. Subagents, `harness_check` contracts, plan files and the advisor are used only via `/implement`, `/build-and-review`, `/plan` or an explicit request.
- Subagent children are exempt from the main mode switch (`PI_SUBAGENT_CHILD=1`), but scout/reviewer bash calls use the shared read-only policy (`PI_SUBAGENT_READ_ONLY=1`, inherited by descendants). Restricted main modes only dispatch personal agents, preventing project definitions from overriding allowed roles.
- Regression suite: `node agent/tests/harness.test.mjs` from `~/.pi` using Node >=22.19.0 (Pi 1.0.1's runtime requirement). Tests cover command policy, canonical paths, mode injection/gates, zero-tool dispatch, cancellation escalation, sandbox policy, and extension loading. Restart Pi sessions after changing extensions.
  - The full suite aborts inside a sandboxed Pi shell (`EPERM` lstat on `agent/auth.json` during the creds-guard symlink check). These slices run safely from any shell: `agent/tests/modes-check.mjs` (mode activation/gates/injection), `agent/tests/advisor-config-check.mjs` (advisor config), `agent/tests/advisor-session-header.mjs` (Advisor session-id patch), `agent/tests/advisor-patch-guard.mjs` (patch self-healing guard).

## Advisor model (pi-advisor-flow)

`advisor.json` pairs a fast Executor with a stronger Advisor; the same-model guard skips calls when both match, so the two must differ.

```json
{ "executor": "openai/gpt-6.1-sol", "advisor": "openai/gpt-6-astra",
  "advisorPlanGate": false, "advisorCompletionGate": false, "advisorFailureGate": true, "advisorMaxCallsPerSession": 4 }
```

Executor = the session default; Advisor = `gpt-6-astra`. Plan and completion gates are off (they added 50-80 s per answer); only repeated failures trigger an automatic review, capped at 4 calls per session. All roles moved off `opencode-go` on 2026-10-06 after its quota was exhausted (429/402 failed most subagent and advisor calls). Edit the file or use `/advisor-models` (pick Executor, Advisor, optional fallback) and `/advisor-settings` (plan/failure/completion gates, git context, effort, whitelist). Unknown keys are preserved but warned about; only keys from the plugin's schema are valid (e.g. `advisor`, `advisorFallbackModel`, `advisorEffort`, `alwaysOn`). Requires `packages: ["npm:pi-advisor-flow"]` in `settings.json` and a session restart. Validate an edit with `node agent/tests/advisor-config-check.mjs` (schema-validates `advisor.json` and asserts advisor ≠ executor).

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

## Executor Lens and debugger support

Executor dispatches now load Lens and allow its diagnostics, symbol/body reads, LSP navigation, AST queries, and structural replacement tools. Other roles keep their existing toolsets. Executor launches load only the guard, sandbox/debugger, and Lens; web and advisor plugins remain excluded. Lens adds startup work compared with the former guard-only launch.

The sandbox extension registers `debug`: a fresh LLDB batch launching a binary inside the workspace, with optional `args`, `breakpoints` (`file:line`), `commands`, and `timeoutSeconds` (default 60, maximum 300). Build with debug symbols; use commands such as `run`, `frame variable`, `next`, and `thread backtrace all`. Custom commands replace the default command sequence. LLDB init files are disabled. Batches have no persistent session and no supported existing-process attach workflow. Cancellation and deadlines use the existing bash operations. macOS Seatbelt prevents LLDB process control: launch `pi --debug-unsandboxed` to explicitly allow only debugger calls outside the OS sandbox. The opt-in is inherited by executor children; ordinary bash remains sandboxed. Without this flag, macOS debug calls fail with an actionable message. Unsandboxed LLDB and its target have the user’s filesystem and network access; the file-tool credential guard is not an OS boundary for these processes. Linux uses sandboxed operations unless explicitly opted out. macOS may also require Developer Tools permission.

Debug is blocked in discuss/plan modes and read-only subagents. Executor debug, AST replacement, and all LSP navigation calls invalidate completion, conservatively including read-only LSP operations. Run verification and complete again afterwards. Debug output and Lens diagnostics do not count as registered test evidence.
