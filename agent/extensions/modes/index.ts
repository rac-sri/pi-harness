/**
 * modes: three-position harness mode switch for the main session.
 *
 *   /mode discuss   (DEFAULT)  pure reasoning; no repo access, only the "discuss" subagent
 *   /mode plan      read-only exploration; orchestrates scout/planner; vault plan files
 *   /mode execute   full tools; works plan checklists with verify gates + checkpoint commits
 *
 * Enforcement = tool activation (schema-level) + tool_call gates (defense-in-depth).
 * Ctrl+Alt+M cycles discuss -> plan -> execute -> discuss.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { isReadOnlyCommand } from "../lib/read-only.ts";

type Mode = "discuss" | "plan" | "execute";

const DEFAULT_MODE: Mode = "discuss";
const CONTEXT_TAG: Record<Mode, string> = {
	discuss: "[MODE: DISCUSS]",
	plan: "[MODE: PLAN]",
	execute: "[MODE: EXECUTE]",
};

const DISCUSS_MODE_INSTRUCTIONS = `${CONTEXT_TAG.discuss}
You are in DISCUSS mode (the default). You have no file tools and cannot inspect this repository.
- Reason about architecture, protocols, cryptography, concurrency, latency, tradeoffs.
- You may dispatch the "discuss" subagent (isolated, tool-less) for deeper brainstorming, and use web tools for research.
- NEVER claim knowledge of files, code, or session history you were not given. Ask for excerpts or request the user switch modes: /mode plan (read-only analysis) or /mode execute (code work).
- When the user clearly wants code changes, stop and tell them to run /mode plan or /mode execute. Do not apologize for the boundary; reasoning first is a feature.`;

const PLAN_MODE_INSTRUCTIONS = `${CONTEXT_TAG.plan}
You are in PLAN mode: read-only against the working tree.
- edit/write are disabled; bash is limited to read-only commands (no builds, no installs, no git state changes).
- Orchestrate the planning fleet: scout and planner subagents (single/chain/parallel). The executor subagent is BLOCKED in this mode - execution belongs to /mode execute.
- Plans live in the Obsidian vault (Agents/<project>/plans/) via the planner; you relay context and the Plan File path.
- Determine <repo>, <project>, and today's Date (bash: date +%F) and prefix planner/executor tasks with "Project: ... Repo: ... Date: ...".
- When the plan is approved by the user, tell them to run /mode execute, then chain executor on the plan file checklist.`;

const EXECUTE_MODE_INSTRUCTIONS = `${CONTEXT_TAG.execute}
You are in EXECUTE mode: full tool access.
- Work plan checklists with the executor doctrine: resume at the first unchecked box, a step's verify: command must pass before flipping - [ ] to - [x], checkpoint gates (Cn) require git add -A && git commit -m "plan(<project>)/<Cn>: ...", never cross a failed gate.
- Prefer dispatching the executor subagent for well-specified plans (isolated context); do hands-on work yourself for small edits or when iterating with the user.
- After chains: report the Plan File path, checklist state, and checkpoint commit hashes; update frontmatter status: proposed -> executing -> executed.
- Reviewer passes and advisor gates remain available. If the plan turns out wrong, say so - switch /mode plan, don't freelance.`;

// ---------------------------------------------------------------------------
// bash read-only allowlist (plan mode)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// mode state
// ---------------------------------------------------------------------------

let mode: Mode = DEFAULT_MODE;
let saved: string[] | undefined; // full active set captured when restricting

const PLAN_DISABLED = new Set(["edit", "write", "lens_diagnostic_mark", "ast_grep_replace", "pi_lens_activate_tools"]);
const DISCUSS_DISABLED = new Set(["read", "grep", "find", "ls", "edit", "write", "bash", "lens_diagnostics", "symbol_search", "module_report", "project_report", "read_symbol", "read_enclosing", "effective_config", "pi_lens_activate_tools"]);

export default function (pi: ExtensionAPI) {
	// Subagent children run under their agent .md capability policy, not session
	// modes. The subagent tool marks children with PI_SUBAGENT_CHILD=1; the
	// child's OWN children (if an agent is granted the subagent tool) inherit it.
	if (process.env.PI_SUBAGENT_CHILD === "1") {
		return;
	}

	const apply = (active: string[]): void => {
		if (mode === "execute") {
			pi.setActiveTools(saved ?? active);
			saved = undefined;
			return;
		}
		saved ??= active;
		const base = saved;
		if (mode === "discuss") pi.setActiveTools(base.filter((t) => !DISCUSS_DISABLED.has(t)));
		else pi.setActiveTools(base.filter((t) => !PLAN_DISABLED.has(t)));
	};

	const setMode = (next: Mode, ctx: ExtensionContext) => {
		if (next === mode) {
			ctx.ui.notify(`Already in ${next} mode.`, "info");
			return;
		}
		mode = next;
		apply(pi.getActiveTools());
		ctx.ui.notify(`${CONTEXT_TAG[next]} active. ${next === "discuss" ? "No repo access; only the discuss subagent." : next === "plan" ? "Read-only; scout/planner only." : "Full access; checklists + checkpoint commits."}`, "info");
	};

	// Re-assert activation on every run so ordering vs other extensions can't drift.
	pi.on("before_agent_start", async (event) => {
		apply(pi.getActiveTools());
		const content = mode === "discuss" ? DISCUSS_MODE_INSTRUCTIONS : mode === "plan" ? PLAN_MODE_INSTRUCTIONS : EXECUTE_MODE_INSTRUCTIONS;
		return { message: { customType: "harness-modes", content, details: { mode } } };
	});

	// Drop injected instructions for modes no longer active.
	pi.on("context", async (event) => {
		const latest = event.messages.findLastIndex(m => (m as { customType?: string }).customType === "harness-modes");
		return { messages: event.messages.filter((m, i) => (m as { customType?: string }).customType !== "harness-modes" || i === latest) };
	});

	// Defense-in-depth: gate tools that survived activation race.
	pi.on("tool_call", async (event) => {
		if (mode === "execute") return undefined;

		if (mode === "discuss" && DISCUSS_DISABLED.has(event.toolName)) {
			return { block: true, reason: `DISCUSS mode: ${event.toolName} is disabled. Switch with /mode plan or /mode execute.` };
		}

		if (mode === "plan") {
			if (PLAN_DISABLED.has(event.toolName)) {
				return { block: true, reason: `PLAN mode: ${event.toolName} is disabled. Use /mode execute to change files.` };
			}
			if (event.toolName === "bash" && !isReadOnlyCommand(String(event.input.command ?? ""))) {
				return { block: true, reason: `PLAN mode: only read-only commands allowed. Blocked: ${String(event.input.command ?? "").slice(0, 80)}` };
			}
		}

		if (event.toolName === "subagent") {
			const wanted = new Set<string>();
			const input = event.input as Record<string, unknown>;
			if (input.agentScope && input.agentScope !== "user") return { block: true, reason: "Restricted modes only dispatch personal agents; project definitions can override their capability policies." };
			if (typeof input.agent === "string") wanted.add(input.agent);
			for (const arr of [input.tasks, input.chain]) {
				if (Array.isArray(arr)) for (const item of arr) {
					if (item && typeof item === "object" && typeof (item as Record<string, unknown>).agent === "string") wanted.add((item as Record<string, unknown>).agent as string);
				}
			}
			const allowed = mode === "discuss" ? new Set(["discuss"]) : mode === "plan" ? new Set(["scout", "planner", "reviewer", "discuss"]) : undefined;
			if (allowed) {
				const offender = [...wanted].find((a) => !allowed.has(a));
				if (offender) return { block: true, reason: `${CONTEXT_TAG[mode]} mode does not dispatch "${offender}". Allowed here: ${[...allowed].join(", ")}. ${mode === "plan" ? "Plans are executed after switching: /mode execute" : ""}` };
			}
		}
		return undefined;
	});

	pi.registerCommand("mode", {
		description: "Harness mode: discuss (default, no repo) | plan (read-only) | execute (full)",
		getArgumentCompletions: (prefix) => ["discuss", "plan", "execute"]
			.filter((m) => m.startsWith(prefix.toLowerCase()))
			.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const arg = String(args ?? "").trim().toLowerCase();
			if (!arg) {
				ctx.ui.notify(`Current mode: ${mode}\n/mode discuss | /mode plan | /mode execute (Ctrl+Alt+M cycles)`, "info");
				return;
			}
			if (arg === "discuss" || arg === "plan" || arg === "execute") setMode(arg, ctx);
			else ctx.ui.notify(`Unknown mode "${arg}". Use discuss|plan|execute.`, "error");
		},
	});

	pi.registerShortcut(Key.ctrlAlt("m"), {
		description: "Cycle harness mode discuss -> plan -> execute",
		handler: async (ctx) => setMode(mode === "discuss" ? "plan" : mode === "plan" ? "execute" : "discuss", ctx),
	});
}
