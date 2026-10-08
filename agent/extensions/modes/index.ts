/**
 * modes: three-position harness mode switch for the main session.
 *
 *   /mode discuss   (DEFAULT)  reasoning + read-only repo inspection; no bash, no edits, only the "discuss" subagent
 *   /mode plan      read-only exploration; inline plans (scout/planner on request)
 *   /mode execute   full tools; direct edits (subagent workflows via slash commands)
 *
 * Enforcement = tool activation (schema-level) + tool_call gates (defense-in-depth).
 * Tab cycles discuss -> plan -> execute -> discuss (Ctrl+Alt+M also works).
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { isReadOnlyCommand, READ_ONLY_HINT } from "../lib/read-only.ts";
import { TokenSpeed } from "../lib/token-speed.ts";

type Mode = "discuss" | "plan" | "execute";

const DEFAULT_MODE: Mode = "discuss";
const CONTEXT_TAG: Record<Mode, string> = {
	discuss: "[MODE: DISCUSS]",
	plan: "[MODE: PLAN]",
	execute: "[MODE: EXECUTE]",
};

// Shared by every mode: the user's request is the goal; process serves it.
const SCOPE_RULES = `- Do exactly what the user asked, at the size they asked for. A question gets an answer; a diagram gets a diagram shown inline; "revert" means restore the files with git.
- Prefer the smallest change that works. Do not add files, migrations, tables, plan documents, scripts, or abstractions the user did not ask for. When a bigger change seems needed, say so in one line and ask first.
- Re-read the user's latest message before each action and check that the action serves it.
- If a subagent or advisor call fails (429/402/quota/timeout), do not retry or route around it: do the work directly if small, otherwise tell the user what failed and stop.`;

// Implementation plans always go through the mission/goal planner, whether or not the user typed /plan.
const PLANNING_RULE = `- When the user asks for an implementation plan ("make the plan", "write the steps"), follow the mission/goal workflow in ~/.pi/agent/prompts/plan.md instead of writing a full plan inline: propose a mission slug and its ordered goal list (one line per goal), get it confirmed, then interview the user on the first unplanned goal only with the grill-me skill, asking every question through the question tool (select list, recommended option first), then dispatch the planner as that file describes. Never write detailed steps for more than one goal at a time.`;

const DISCUSS_MODE_INSTRUCTIONS = `${CONTEXT_TAG.discuss}
You are in DISCUSS mode: read the working tree and reason about it; you cannot run commands or change files.
- Ground claims about this repo in files you read and cite path:line.
- When the user wants changes or command execution, tell them to switch with /mode plan or /mode execute.
${SCOPE_RULES}`;

const PLAN_MODE_INSTRUCTIONS = `${CONTEXT_TAG.plan}
You are in PLAN mode: read-only (edit/write disabled; bash limited to read-only commands; executor subagent blocked).
- Answer questions and analysis inline in the chat. A request to build something that takes more than one step is a request for an implementation plan.
${PLANNING_RULE}
- Never say you will start work this mode cannot do. When the user wants changes made, tell them to switch with /mode execute and stop.
${SCOPE_RULES}`;

const EXECUTE_MODE_INSTRUCTIONS = `${CONTEXT_TAG.execute}
You are in EXECUTE mode: full tool access.
- Do the work directly with read/edit/write/bash, then run the relevant build or tests and report the results.
- Use subagents, harness_check contracts, plan files, and the advisor only when the user invokes /implement, /build-and-review, or /plan, or asks for them explicitly.
${PLANNING_RULE}
${SCOPE_RULES}`;

// ---------------------------------------------------------------------------
// mode state
// ---------------------------------------------------------------------------

let mode: Mode = DEFAULT_MODE;
let saved: string[] | undefined; // full active set captured when restricting

// Read-only tools stay available in DISCUSS: inspect the working tree, never run or change it.
const READ_ONLY_TOOLS = new Set(["question", "read", "grep", "find", "ls", "subagent", "ask_advisor", "web_search", "fetch_content", "get_search_content", "lens_diagnostics", "symbol_search", "ast_grep_search", "ast_grep_outline", "module_report", "read_symbol", "read_enclosing", "project_report", "effective_config", "lsp_navigation"]);
const READ_ONLY_LSP_OPERATIONS = new Set(["definition", "typeDefinition", "declaration", "references", "hover", "signatureHelp", "documentSymbol", "findSymbol", "workspaceSymbol", "implementation", "prepareCallHierarchy", "incomingCalls", "outgoingCalls", "workspaceDiagnostics", "capabilities"]);

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
		pi.setActiveTools(base.filter(t => READ_ONLY_TOOLS.has(t) || mode === "plan" && t === "bash"));
	};
	const updateStatus = (ctx?: ExtensionContext) => {
		if (!ctx?.hasUI) return;
		const color = mode === "discuss" ? "accent" : mode === "plan" ? "warning" : "success";
		ctx.ui.setStatus("harness-mode", ctx.ui.theme.fg(color, `MODE: ${mode.toUpperCase()}`) + ctx.ui.theme.fg("dim", " · Tab"));
	};
	const speed = new TokenSpeed();
	const updateSpeed = (ctx: ExtensionContext, streaming = false) => {
		if (!ctx.hasUI) return;
		const ttft = speed.ttft === undefined ? streaming ? "TTFT …" : undefined : `TTFT ${speed.ttft.toFixed(1)}s`;
		const rate = speed.rate === undefined ? streaming && speed.ttft !== undefined ? "streaming…" : "— tok/s" : `${speed.rate.toFixed(1)} tok/s`;
		ctx.ui.setStatus("harness-speed", ctx.ui.theme.fg("dim", `Speed: ${ttft ? `${ttft} · ` : ""}${rate}`));
	};
	pi.on("session_start", async (_event, ctx) => {
		apply(pi.getActiveTools());
		updateStatus(ctx);
		speed.reset();
		updateSpeed(ctx);
	});
	// The clock starts when the request is sent: message_start only fires once
	// response headers arrive, which can precede prompt processing.
	pi.on("before_provider_request", async (_event, ctx) => {
		speed.start();
		updateSpeed(ctx, true);
		return undefined;
	});
	pi.on("message_update", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		if (event.assistantMessageEvent?.type?.endsWith("_delta")) speed.firstToken();
		speed.update(event.message.usage?.output);
		updateSpeed(ctx, true);
	});
	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		speed.update(event.message.usage?.output);
		updateSpeed(ctx);
	});

	const setMode = (next: Mode, ctx: ExtensionContext) => {
		if (next === mode) {
			updateStatus(ctx);
			ctx.ui.notify(`Already in ${next} mode.`, "info");
			return;
		}
		mode = next;
		apply(pi.getActiveTools());
		updateStatus(ctx);
		ctx.ui.notify(`${CONTEXT_TAG[next]} active. ${next === "discuss" ? "Read-only repo access; no bash, no edits." : next === "plan" ? "Read-only; scout/planner only." : "Full access; direct edits."}`, "info");
	};

	// Re-assert activation on every run so ordering vs other extensions can't drift.
	// Mode instructions are a system-prompt section: it stays byte-identical while the
	// mode is unchanged, so the provider prompt cache survives across turns.
	pi.on("before_agent_start", async (event, ctx) => {
		apply(pi.getActiveTools());
		updateStatus(ctx);
		const options = event?.systemPromptOptions;
		if (options) options.sections = { ...options.sections, harness_mode: mode === "discuss" ? DISCUSS_MODE_INSTRUCTIONS : mode === "plan" ? PLAN_MODE_INSTRUCTIONS : EXECUTE_MODE_INSTRUCTIONS };
		return undefined;
	});

	// Defense-in-depth: gate tools that survived the activation race.
	// Read-only tools (read/grep/find/ls + code intelligence) are NOT gated in
	// discuss mode — inspecting the working tree is allowed; running and editing are not.
	pi.on("tool_call", async (event) => {
		if (mode === "execute") return undefined;
		if (!READ_ONLY_TOOLS.has(event.toolName) && !(mode === "plan" && event.toolName === "bash")) return { block: true, reason: `${CONTEXT_TAG[mode]}: tool is not in the read-only allowlist. Use /mode execute for writes or verification.` };
		if (event.toolName === "lsp_navigation" && !READ_ONLY_LSP_OPERATIONS.has(String(event.input.operation ?? ""))) return { block: true, reason: `${CONTEXT_TAG[mode]}: this LSP operation can modify files or execute commands.` };

		if (mode === "plan") {
			if (event.toolName === "bash" && !isReadOnlyCommand(String(event.input.command ?? ""))) {
				return { block: true, reason: `PLAN mode: only read-only commands allowed. Blocked: ${String(event.input.command ?? "").slice(0, 80)}. ${READ_ONLY_HINT}` };
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
		description: "Harness mode: discuss (default, read-only repo) | plan (read-only) | execute (full)",
		getArgumentCompletions: (prefix) => ["discuss", "plan", "execute"]
			.filter((m) => m.startsWith(prefix.toLowerCase()))
			.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const arg = String(args ?? "").trim().toLowerCase();
			if (!arg) {
				ctx.ui.notify(`Current mode: ${mode}\n/mode discuss | /mode plan | /mode execute (Tab cycles; Ctrl+Space autocompletes)`, "info");
				return;
			}
			if (arg === "discuss" || arg === "plan" || arg === "execute") setMode(arg, ctx);
			else ctx.ui.notify(`Unknown mode "${arg}". Use discuss|plan|execute.`, "error");
		},
	});

	const cycleMode = async (ctx: ExtensionContext) => setMode(mode === "discuss" ? "plan" : mode === "plan" ? "execute" : "discuss", ctx);
	pi.registerShortcut(Key.tab, {
		description: "Cycle harness mode discuss -> plan -> execute",
		handler: cycleMode,
	});
	pi.registerShortcut(Key.ctrlAlt("m"), {
		description: "Cycle harness mode discuss -> plan -> execute",
		handler: cycleMode,
	});
}
