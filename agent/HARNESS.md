# Harness reference

The rules the harness enforces and why. For the overview, install steps, commands, agents and config files, see the [README](../README.md).

The main session is the only orchestrator. Every subagent is a fresh `pi --mode json -p --no-session` process with its own context window, a restricted toolset and no memory of other runs.

## Agents and delegation

- An agent's `tools:` frontmatter is its whole capability policy. No agent lists `subagent`, so none can delegate. Adding it would allow delegation, but keeping fan-out in the main session keeps it visible and abortable.
- `discuss` is isolated three ways. `tools: none` spawns it with `--tools ""`, which excludes built-in and extension tools. `noContext: true` adds `--no-context-files`, so no AGENTS.md or CLAUDE.md. `scratch: true` runs it in a throwaway `mktemp -d` directory that is removed afterwards, ignoring any `cwd` the caller passes. To continue a discussion, resend the conversation so far in the task.
- Project agents in `<repo>/.pi/agents/` need `agentScope: "both"`. Pi asks before running them because repository prompts can run bash. Discuss and plan modes only dispatch personal agents, so a project definition can't replace an allowed role.
- Failures with 429, 402, 401, 403 or a quota error are labelled `PROVIDER UNAVAILABLE`, and the main session stops instead of re-dispatching.

## Models

`agents/models.json` is the only source of model choice. Launches use `default` unless `--model`, `--provider` or `--models` is given. Subagents use their role entry, and `null` or a missing entry means `default`. Frontmatter and the active session never override it. The file is read on every launch and dispatch, invalid JSON fails visibly, and keys starting with `_` are comments.

`settings.json` keeps Pi's own `defaultProvider` and `defaultModel` for compatibility, and the launcher overrides them. `advisor.json` configures the advisor plugin only.

Pi's global config directory is `~/.pi/agent/` (`getAgentDir()`). `PI_CODING_AGENT_DIR` can move it, but the managed install assumes this layout.

## Skills

`settings.json` excludes `skills/ethskills/**` and the security pack under `~/.agents/skills/better-auth-best-practices/*/`: 46 skills that would add about 20 KB to every system prompt. To re-enable one, add a force-include after the exclusions, e.g. `"+/Users/rachitsrivastava/.pi/agent/skills/ethskills/gas"`. To re-enable a set, delete its `!` line.

## Planning

- `agents/planner.json` sets the plan root, e.g. `{"directory": "~/plans/{project}"}`. Absolute, `~` and cwd-relative paths work; `{project}` becomes the kebab-case project name. It reloads on every dispatch. A missing file falls back to `<vault>/Agents/{project}`, and an invalid one fails visibly.
- The planner reads `mission.md` and earlier goal files before writing, then reads its own output back, because the vault is a ProtonDrive mount and writes can be stale. If storage fails it writes to `<repo>/.pi/plans/` and says so.
- The orchestrator passes `Date:` from `date +%F`. The planner never guesses the date.
- Plan files live outside the checkout. A tracked plan file would make checkpoint commits stale as soon as the executor ticks a box.
- Any request for an implementation plan goes through the `/plan` flow, in plan or execute mode, whether or not the user typed `/plan`. Other multi-step requests in execute mode are just done.
- Path G (`/implement <goal file>`) runs parallel-group tasks in separate git worktrees, because the writer lock is per repository root, then cherry-picks them back in task order. It has not been exercised end to end yet.

### The `question` tool

`extensions/question.ts` asks one question as a keyboard list: radio rows by default, checkboxes with `multiSelect`. The last row is always "type your own answer", and it can be combined with ticked rows. An empty multi-select submit is refused. `context` is drawn above the question and stays in the chat after the answer, so summaries can't scroll away. Outside the TUI the tool tells the model to ask in plain text. Subagents can't use it.

Interviews pass a `ledger` (e.g. `reshield/01`) and a `decides` id per question. A decided id is refused before the picker opens unless `revisit: true` is set, in which case the decision is replaced and marked `changed`. Every picker shows the decisions so far, every answer returns them to the model, and after 10 decisions the model is told to wrap up. Ledgers live in process memory; the goal file's `## Decisions` is the lasting record.

## Verification and checkpoints

- `harness_check` belongs to the sandbox extension and runs through the same sandbox as bash. Before implementing, every executor task defines an immutable contract and its `{id, command, property}` checks. Each checkpoint gets its own run id.
- A run moves `pending → implemented → verified → committed`. `verify` records the command, cwd, optional `HARNESS_SEED`, exit status, timestamps, HEAD and tree ids, source fingerprints, the full output log and its SHA-256. A failing command, or one that changes source, records failure evidence. `complete` requires every check's latest evidence to match the current checkout and unchanged logs.
- State lives in `~/.pi/agent/harness/runs/<repo-hash>/<run>/`. File tools and sandboxed bash can't write there. Markdown checkboxes summarise this state and never replace it.
- `checkpoint` takes explicit files and a message. It refuses existing staged work or other changed files, re-verifies, then stages and commits that scope. A hook that edits files, or a dirty tree after the commit, prevents a committed record. It never discards changes or resets.
- The dispatcher rejects an executor's success without a successful `complete` or `checkpoint`, and any later write, edit, bash call, `debug`, AST replacement or LSP operation (even read-only ones) invalidates it. Every checkpoint seen in a dispatch must complete, and later checkpoints must include regression checks for the combined result.
- A cross-process writer lock allows one mutating subagent per checkout. Scouts and reviewers run concurrently. It doesn't stop your own edits or writers in other checkouts; fingerprints catch those between verification points. A crashed lock fails visibly and must be inspected before removal.
- Fingerprints cover tracked and non-ignored untracked files, deletions, permissions, in-repo file symlinks and their targets, and initialised submodules. Ignored files, installed dependencies, external services and toolchains are not covered, so pin them and name them in the contract. Uninitialised submodules and symlinks that leave the repo fail closed.
- Distributed plans state consistency, failure and recovery assumptions plus safety and liveness properties. Crypto plans state the threat model, the established library, the nonce and key lifecycle, and authentication and encoding boundaries. New cryptographic constructions need specialist human review.
- Plan status goes `proposed → executing → executed` (goal files use `draft → proposed → executing → done`). Acceptance needs recorded evidence and resolved reviewer findings.

## Sandbox and credential isolation

1. **Capability scoping.** Each subagent gets an explicit `--tools` list. An invalid explicit list grants zero tools; an omitted one inherits Pi's defaults.
2. **OS sandbox for bash.** `extensions/sandbox/` uses `@anthropic-ai/sandbox-runtime` (Seatbelt on macOS), configured in `extensions/sandbox.json`. Credential paths and the whole vault are denied to bash; agents reach `Agents/` through file tools. If the sandbox can't start, bash is blocked. Project settings can add denials or narrow allowlists but can't loosen the global policy.
3. **Credentials guard.** `extensions/creds-guard.ts` blocks read, write, edit, hashline_edit, grep, find, ls and bash on the same paths, covering the file tools Seatbelt can't see. It applies pi's own path normalisation first (one leading `@` stripped, Unicode spaces mapped), resolves targets against cwd, normalises `..`, and resolves existing symlinks and parents before matching. Recursive grep and find can't start above a protected path. Agents may only touch `<vault>/Agents/**`, except in sessions whose cwd is inside the vault.
4. **`.env` coverage.** The guard blocks `.env*` at any depth (examples allowed). Seatbelt's `.env` rule is relative to the process cwd, which covers the repo root because subagents start there. A nested `apps/x/.env` is protected by the guard only. `~/.env` is denied globally.
5. **Escape hatches.** `pi --no-sandbox`, or `enabled: false` in the trusted global config. Editing the guard means editing `extensions/creds-guard.ts`, which Seatbelt write-protects.

## Modes

`extensions/modes/index.ts` switches the main session between discuss (the default), plan and execute: `/mode <name>`, Tab or Ctrl+Alt+M. Autocomplete moves to Ctrl+Space (`keybindings.json`). Each mode is a tool allowlist, a `tool_call` gate that blocks anything outside it, and a `harness_mode` system-prompt section.

- **discuss:** read-only file tools. Bash, edit, write and `pi_lens_activate_tools` are blocked, and only `discuss` can be dispatched.
- **plan:** read-only, plus bash limited to the read-only subset in `extensions/lib/read-only.ts`. A blocked command's reason lists the rules (no globs, redirects including `2>/dev/null`, `$`, backticks or brackets) so the model can retry correctly. Executor is blocked, and the model won't promise work the mode can't do.
- **execute:** all tools. Subagents, `harness_check`, plan files and the advisor are used only through `/implement`, `/build-and-review`, `/plan` or an explicit request.

The mode section stays byte-identical while the mode is unchanged, so the provider's prompt cache survives across turns. Don't add per-turn messages or `context` hooks that rewrite history.

Subagents ignore the mode switch (`PI_SUBAGENT_CHILD=1`). Scout and reviewer bash still goes through the read-only policy (`PI_SUBAGENT_READ_ONLY=1`, inherited by their children).

## Dispatch and live progress

- Children that only use built-in tools load just the guard, plus the sandbox when they need bash or verification. The executor also loads Lens and `extensions/hashline/tool.ts`; web and advisor plugins stay out. Children skip slash-prompt discovery, and `discuss` skips skill discovery.
- `agents/runtime.json` reloads on every dispatch and sets per-role thinking, a deadline, max turns, max output tokens and the UI update interval. A thinking suffix in `models.json` wins. Turn and token limits are checked at the end of each assistant message, so they are soft. A deadline kills the process group, escalating after five seconds.
- Subagent panels stream thinking (when the provider exposes it), text, tool calls and elapsed time. Ctrl+O expands them. Completed results keep a bounded thinking excerpt.
- Speed is generation speed: output tokens after the first, divided by the time from the first streamed delta to the latest usage report. Queueing and tool time are excluded. Most providers report usage only at the end, so a placeholder shows until then.
- `extensions/compact-read.ts` shows reads as a muted `READ` path, range and line count. The model still gets the full content, and errors stay visible.

## Executor tools: Lens and `debug`

The executor can use Lens diagnostics, symbol reads, LSP navigation, AST search and structural replacement. Lens results don't count as test evidence.

`debug` runs one LLDB batch against a binary inside the workspace, with optional `args`, `file:line` breakpoints, `commands` and `timeoutSeconds` (default 60, max 300). Custom commands replace the default sequence, init files are disabled, and nothing persists between batches. There is no attach to running processes.

On macOS, Seatbelt stops LLDB from controlling processes, so `debug` needs `pi --debug-unsandboxed`. That lets only debugger calls leave the sandbox, the flag is inherited by executor children, and bash stays sandboxed. Unsandboxed LLDB and its target get your full filesystem and network access, and the credential guard doesn't apply to them. Without the flag, `debug` fails with instructions. Linux stays sandboxed unless you opt out. `debug` is blocked in discuss, plan and read-only subagents.

## Executor edits: `hashline_edit`

The executor has no native `edit`. `extensions/hashline/tool.ts` replaces its `read` with one that prints `N:content` lines under a `[path#TAG]` header, where TAG names the exact file content, and adds `hashline_edit` (replace, delete or insert by line number, citing the tag). The design follows oh-my-pi's hashline v2; the logic lives in `extensions/lib/hashline.ts`.

- An edit applies directly only when the file's full SHA-256 still matches the tagged snapshot. Each result returns the new tag, so edits chain without re-reading.
- If the file changed, the edit is shifted only when the edited lines plus 2 lines of context each side occur exactly once, unchanged, and every edit in the batch shifts by the same amount. The result then carries a warning. Anything else fails with `E_STALE`.
- Edits must target lines served in full under that tag (`E_UNSERVED`); truncated long lines can't be edited this way. Overlaps, out-of-range lines and payloads copied with `N:` prefixes are rejected before writing. BOM, CRLF and a missing final newline are preserved.
- Tags live in memory for one executor process. The file has no `index.ts`, so the main session never loads it; the dispatcher adds it with `-e` when the executor's tools include `hashline_edit`. Lens doesn't see `hashline_edit` as an edit, so its read-guard and deferred formatting don't act on these writes. `hashline_edit` invalidates completion like other mutating tools.

## Advisor (pi-advisor-flow)

`advisor.json` pairs the session model with a stronger advisor. The plugin skips calls when both are the same model, so they must differ. Plan and completion gates are off because each added 50-80 s per answer. Only repeated failures call the advisor, at most 4 times per session. There is deliberately no `advisorFallbackModel`: a fallback would hide header, auth and config failures. Change settings with `/advisor-models` and `/advisor-settings`, and check edits with `node agent/tests/advisor-config-check.mjs`.

**Local patch.** pi-advisor-flow 0.11.1 never passes a session id to the advisor's stream calls. pi-ai only sets `x-opencode-session` from `options.sessionId`, and OpenCode Go rejects requests without it (`400 MissingSessionID`). The main loop sets the id itself, so only advisor calls failed. Three pieces keep the fix applied:

1. `patches/advisor-session-header.mjs` passes `ctx.sessionManager.getSessionId()` into both stream paths. It matches exact anchors from 0.11.1, is idempotent, and exits with `UPSTREAM CHANGED` if an anchor stops matching exactly once.
2. `npm/package.json` re-runs it on `postinstall`, because `pi update` replaces the package. `dist/index.js` is the file that runs; `src/model-stream.ts` is patched to match.
3. `extensions/advisor-patch-guard.ts` re-checks the bundle at load, re-applies the patch if it was reverted, and notifies at session start. A `/reload` may still be needed for the running process.

`tests/advisor-session-header.mjs` and `tests/advisor-patch-guard.mjs` cover it. The upstream report is still to be filed at https://github.com/philipbrembeck/pi-advisor.

## Tests and evals

See the README for the test list. Run them from `~/.pi` in a normal shell with Node 22.19 or newer. Inside a sandboxed Pi shell, `harness.test.mjs` fails with `EPERM` on `auth.json`; the other checks run anywhere. Restart Pi after changing extensions.

`tests/domain-eval.mjs` has broken and reference versions of four bugs: lost-ack retry, duplicate apply, nonce reuse after restart, and malformed-signature rejection. `--agent` runs the executor live, `--baseline` adds a plain agent on the same model, `--hidden-tests` withholds the tests from the agents, and `--case <id>` picks one. Reports go to `agent/harness/evals/`. The first full run (2026-10-08, hidden tests) had both arms solve 8/8 with no edits to correct code, and the harness cost about 1.5× in time and money. The cases are too easy to tell the arms apart. Since then the harness arm edits with `hashline_edit` while the baseline keeps native `edit`, so arm differences now include the edit format.

## Known environment issues

- `opencode-go`: quota exhausted on 2026-10-06 (`429 GoUsageLimitError`, `402`). All roles moved to `openai`, and `discuss` to LM Studio. Move them back once the quota resets.
- `amazon-bedrock`: STS credentials were last seen invalid (`UnrecognizedClientException`).
- `lmstudio`: the local endpoint (`192.168.1.15:1234`, in `models.json`) must be running, or `discuss` fails.
