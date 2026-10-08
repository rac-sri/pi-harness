import * as path from "node:path";
import { existsSync } from "node:fs";
import { Type } from "typebox";
import { createBashTool, type BashOperations, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { canonicalPath, pathDenied } from "../creds-guard.ts";

const shellQuote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
const lldbQuote = (value: string) => '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';

export interface DebugInput {
	program: string;
	args?: string[];
	breakpoints?: string[];
	commands?: string[];
	timeoutSeconds?: number;
}

export function debugCommand(input: DebugInput, cwd: string): string {
	const program = canonicalPath(input.program, cwd);
	const root = canonicalPath(cwd, cwd);
	if (!program.startsWith(root + path.sep) || pathDenied(program, cwd)) throw new Error("Debug program must be an unprotected file inside the current workspace.");
	if (!existsSync(program)) throw new Error(`Debug program does not exist: ${program}. Build it with debug symbols first.`);
	const values = [program, ...(input.args ?? []), ...(input.breakpoints ?? []), ...(input.commands ?? [])];
	if (values.some(value => /[\r\n\0]/.test(value))) throw new Error("Debugger inputs cannot contain newlines or NUL bytes.");
	const commands = ["settings set target.disable-aslr false",
		...(input.breakpoints ?? []).map(location => `breakpoint set --file ${lldbQuote(location.slice(0, location.lastIndexOf(":")))} --line ${Number(location.slice(location.lastIndexOf(":") + 1))}`),
		...(input.commands ?? ["run", "thread backtrace all", "frame variable"])];
	for (const location of input.breakpoints ?? []) {
		if (!/^.+:[1-9][0-9]*$/.test(location)) throw new Error("Breakpoints must use file:line with a positive line number.");
		const file = location.slice(0, location.lastIndexOf(":"));
		if (pathDenied(file, cwd)) throw new Error("Protected breakpoint path.");
	}
	// No init scripts; a batch owns its launched process and is cleaned up on exit.
	return [...(process.platform === "darwin" ? ["/usr/bin/xcrun", "lldb"] : ["lldb"]), "--batch", "--no-lldbinit", ...commands.flatMap(command => ["-o", command]), "--", program, ...(input.args ?? [])].map(shellQuote).join(" ");
}

export function registerDebugger(pi: ExtensionAPI, operations: () => BashOperations) {
	pi.registerTool({
		name: "debug",
		label: "LLDB",
		description: "Launch a workspace binary under LLDB in a fresh batch. On macOS, restart Pi with --debug-unsandboxed to opt into process control outside Seatbelt; ordinary bash remains sandboxed. Build with debug symbols first. Set file:line breakpoints; commands run in order (e.g. run, frame variable, next, thread backtrace all). Commands replace the default run/backtrace/variables sequence. A batch has no persistent session: do all required stepping/inspection in one call. Debugger commands and expressions can execute code or mutate state; use only for a requested debugging task. Does not establish harness_check verification. Existing-process attach is not supported; debug a local reproduction.",
		parameters: Type.Object({
			program: Type.String({ description: "Workspace binary, e.g. target/debug/my-app" }),
			args: Type.Optional(Type.Array(Type.String())),
			breakpoints: Type.Optional(Type.Array(Type.String(), { description: "Source locations: src/main.rs:42" })),
			commands: Type.Optional(Type.Array(Type.String(), { minItems: 1, description: "LLDB commands executed in order" })),
			timeoutSeconds: Type.Optional(Type.Number({ minimum: 1, maximum: 300 })),
		}),
		async execute(id, input, signal, onUpdate, ctx) {
			if (process.env.PI_SUBAGENT_READ_ONLY === "1") throw new Error("Debugger is unavailable to read-only subagents.");
			const command = debugCommand(input, ctx.cwd);
			return createBashTool(ctx.cwd, { operations: operations() }).execute(id, { command, timeout: input.timeoutSeconds ?? 60 }, signal, onUpdate);
		},
	});
}
